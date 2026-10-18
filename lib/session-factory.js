// handoff-review — review-session creation and reviewer lockdown.
//
// A review session is an ordinary workspace session (not a subagent): it is
// created through the Host session controller, attached to the impl session's
// workspace so it shows up in the sidebar, and locked down before the first
// review brief is delivered (DEVELOPMENT.md §7.1, §9.3, §9.7).
//
// The same module also creates continuation sessions: an ordinary *writable*
// session in the source session's workspace whose first user message is the
// continuation handoff (no reviewer lockdown, no storage record).

import { buildUserMessage, CONTINUATION_SOURCE } from './delivery.js'

/** Global write-capable tools denied to the reviewer. */
export const WRITE_TOOL_NAMES = ['edit', 'write', 'str_replace_editor', 'apply_patch', 'multi_edit']

/** Stable failure codes for session creation. */
export const SESSION_FACTORY_CODES = {
  CREATE_FAILED: 'CREATE_FAILED',
  NO_REVIEW_AGENT: 'NO_REVIEW_AGENT',
  NO_IMPL_AGENT: 'NO_IMPL_AGENT',
  NO_CONTINUATION_AGENT: 'NO_CONTINUATION_AGENT',
}

/** Raised when review-session creation cannot complete; may carry the created session id. */
export class SessionFactoryError extends Error {
  /**
   * @param {string} code stable failure code
   * @param {string} message human-readable diagnostic
   * @param {{ sessionId?: string }} [details]
   */
  constructor(code, message, details = {}) {
    super(message)
    this.name = 'SessionFactoryError'
    this.code = code
    if (details.sessionId !== undefined) this.sessionId = details.sessionId
  }
}

/**
 * Resolve the working directory for the review session from the impl session
 * header, falling back to `process.cwd()` with a recorded warning.
 * @param {object} implAgent live impl Agent
 * @param {string} [fallback] fallback directory
 * @returns {{ cwd: string, warnings: string[] }}
 */
export function resolveCwd(implAgent, fallback = process.cwd()) {
  const cwd = implAgent && implAgent.session && implAgent.session.header ? implAgent.session.header.cwd : undefined
  if (typeof cwd === 'string' && cwd !== '') return { cwd, warnings: [] }
  return { cwd: fallback, warnings: [`impl session 缺少 cwd，已回退為 ${fallback}。`] }
}

/**
 * Wait for the review agent to become live after `sessionController.create()`.
 * Agent creation is asynchronous, so `create()` returning a session id does not
 * imply a live agent (DEVELOPMENT.md §9.3).
 * @param {object} ctx Host plugin context
 * @param {string} sessionId review session id
 * @param {{ attempts?: number, delayMs?: number, agents?: object }} [options] polling budget
 * @returns {Promise<object | undefined>} live Agent, or undefined on timeout
 */
export async function waitForAgent(ctx, sessionId, options = {}) {
  const agents = options.agents ?? ctx.agents
  const attempts = Math.max(1, Math.trunc(options.attempts ?? 400))
  const delayMs = Math.max(1, Math.trunc(options.delayMs ?? 25))
  for (let index = 0; index < attempts; index += 1) {
    const agent = agents.get(sessionId)
    if (agent !== undefined && agent !== null) return agent
    await new Promise((resolve) => setTimeout(resolve, delayMs))
  }
  return undefined
}

/**
 * Look up a live agent through `ctx.agents.get`.
 * @param {object} ctx Host plugin context
 * @param {string} sessionId session id
 * @returns {object | undefined} live Agent when present
 */
export function findLiveAgent(ctx, sessionId) {
  try {
    return ctx.agents.get(sessionId)
  } catch {
    return undefined
  }
}

/**
 * Check that a session still exists (live or persisted) for stale-link detection.
 * @param {object} ctx Host plugin context
 * @param {string} sessionId session id
 * @returns {Promise<boolean>} whether the session is known
 */
export async function sessionExists(ctx, sessionId) {
  try {
    if (ctx.sessions.get(sessionId) !== undefined) return true
  } catch {
    // fall through to the persisted inspection
  }
  try {
    await ctx.sessionController.inspect(sessionId)
    return true
  } catch {
    return false
  }
}

/**
 * Read the registry-global archived-session set. Sessions stay in
 * `sessionController.list()` after archiving, so the workspace registry's
 * archive set is the only reliable archive signal (DEVELOPMENT.md §7.4).
 * `undefined` means the registry state is not readable and archive-ness cannot
 * be judged.
 * @param {object} ctx Host plugin context
 * @returns {Set<string> | undefined} archived session ids
 */
export function listArchivedSessionIds(ctx) {
  try {
    const ids = ctx.workspaceRegistry.archivedSessionIds
    if (!Array.isArray(ids)) return undefined
    return new Set(ids.filter((sessionId) => typeof sessionId === 'string'))
  } catch {
    return undefined
  }
}

/** Files larger than this are not read into a handoff as newly created content. */
export const MAX_CREATED_FILE_BYTES = 256 * 1024

/**
 * Whether a filesystem failure means the path does not exist (the file was
 * created and later deleted), so the create entry should be dropped rather than
 * rendered as an unavailable file.
 * @param {unknown} error thrown value
 * @returns {boolean} true for ENOENT-like failures
 */
function isMissingFileError(error) {
  if (error === null || error === undefined) return false
  const code = typeof error === 'object' && typeof error.code === 'string' ? error.code : ''
  if (code === 'ENOENT' || code === 'FS_NOT_FOUND' || code === 'not-found') return true
  const message = error && error.message ? String(error.message) : String(error)
  return /ENOENT|no such file|not found/i.test(message)
}

/**
 * Hydrate `write`-created files: the tool's result meta carries the path but an
 * empty diff list, so the new file content is read from the workspace for the
 * handoff (DEVELOPMENT.md §9.6 changed files).
 *
 * A path that also has a LATER edit hunk keeps only those hunks: hydrating the
 * current file would otherwise double-represent the file (full new content plus
 * the edit diff). An older hunk does not supersede a newer create (delete then
 * recreate). Unreadable/oversized files keep
 * `newText: ''` plus `unavailable: true` so the builder can say the content was
 * not loaded instead of inventing diff lines.
 *
 * @param {object} ctx Host plugin context
 * @param {Array<object>} entries diff-projection entries
 * @param {number} [maxChars] per-file character cap
 * @returns {Promise<Array<object>>} entries with hydrated `newText`
 */
export async function hydrateCreatedEntries(ctx, entries, maxChars = 6000) {
  const list = Array.isArray(entries) ? entries : []
  const finiteSeq = (entry) => entry !== null && typeof entry === 'object' && Number.isFinite(entry.seq)
  /**
   * Whether a later non-create hunk for the same path supersedes the create
   * entry (the file was created and then edited afterwards). An older hunk must
   * NOT drop it: edit→delete→recreate is the same path with a newer create.
   */
  const supersededByLaterHunk = (entry) =>
    list.some(
      (other) =>
        other !== null
        && typeof other === 'object'
        && other !== entry
        && other.operation !== 'create'
        && other.path === entry.path
        && (!finiteSeq(entry) || !finiteSeq(other) || other.seq > entry.seq),
    )
  let fs
  try {
    fs = ctx.get('fs')
  } catch {
    fs = undefined
  }
  if (fs === undefined || typeof fs.readText !== 'function' || typeof fs.resolve !== 'function') {
    return list.filter((entry) => !(entry && entry.operation === 'create' && supersededByLaterHunk(entry)))
  }
  const hydrated = await Promise.all(
    list.map(async (entry) => {
      if (entry === null || typeof entry !== 'object') return entry
      if (entry.operation !== 'create' || entry.newText !== null) return entry
      if (supersededByLaterHunk(entry)) return null
      const cap = Number.isFinite(maxChars) && maxChars > 0 ? Math.trunc(maxChars) : 6000
      try {
        const target = await fs.resolve(entry.path)
        if (typeof fs.stat === 'function') {
          const info = await fs.stat(target)
          // The file was created earlier in the session and no longer exists:
          // the net change is a deletion, so do not list a create entry.
          if (info === undefined || info === null) return null
          const size = info !== null && typeof info === 'object' ? Number(info.size) : Number.NaN
          if (Number.isFinite(size) && size > MAX_CREATED_FILE_BYTES) {
            return { ...entry, newText: '', unavailable: true }
          }
        }
        const text = await fs.readText(target)
        if (typeof text !== 'string') return { ...entry, newText: '', unavailable: true }
        if (text.length > cap) return { ...entry, newText: `${text.slice(0, cap)}\n（新檔內容已截斷）` }
        return { ...entry, newText: text }
      } catch (error) {
        if (isMissingFileError(error)) return null
        return { ...entry, newText: '', unavailable: true }
      }
    }),
  )
  return hydrated.filter((entry) => entry !== null)
}

/**
 * Collect the impl session's derived messages for goal/open-question extraction.
 * @param {object} implAgent live impl Agent
 * @returns {Array<object>} derived messages (empty when unavailable)
 */
export function collectSessionMessages(implAgent) {
  try {
    const messages = implAgent.session.deriveMessages()
    return Array.isArray(messages) ? messages : []
  } catch {
    return []
  }
}

/**
 * Enforce the reviewer read-only policy with three independent layers:
 * a session `sandbox/mode: read-only` event, removal/denial of write tools on the
 * agent's scoped tool runtime, and an approval policy of `never`.
 * @param {object} ctx Host plugin context
 * @param {object} agent live review Agent
 * @param {{ readOnlyReviewer?: boolean }} config resolved plugin config
 * @returns {string[]} non-fatal warnings
 */
export function applyReviewerPolicy(ctx, agent, config) {
  const warnings = []
  if (config.readOnlyReviewer === false) return warnings

  // Layer 1 — durable sandbox override. `sandbox/mode` is an official log-only
  // event; appending it is the documented switch (there is no setter method).
  try {
    agent.session.append('sandbox/mode', { mode: 'read-only' })
  } catch (error) {
    warnings.push(`無法設定 reviewer sandbox 為 read-only：${error && error.message ? error.message : String(error)}`)
  }

  // Layer 2 — hide write tools and hard-deny them even if another layer misses.
  try {
    const tools = agent.ctx.tools
    const available = typeof tools.schemas === 'function' ? tools.schemas().map((schema) => schema.name) : []
    const deny = WRITE_TOOL_NAMES.filter((name) => available.includes(name))
    if (deny.length > 0) tools.restrict({ deny })
    if (typeof tools.guard === 'function') {
      tools.guard((execution) =>
        WRITE_TOOL_NAMES.includes(execution.name) ? 'handoff-review: reviewer is read-only' : undefined,
      )
    }
  } catch (error) {
    warnings.push(`無法限制 reviewer 的寫入工具：${error && error.message ? error.message : String(error)}`)
  }

  // Layer 3 — reviewer must not block on approval prompts.
  try {
    const approval = ctx.get('approval')
    if (approval !== undefined && typeof approval.setPolicy === 'function') approval.setPolicy(agent, 'never')
  } catch (error) {
    warnings.push(`無法設定 reviewer approval policy：${error && error.message ? error.message : String(error)}`)
  }

  return warnings
}

/**
 * Apply the configured reviewer model, when both provider and model are set.
 * An explicit `reviewerReasoningEffort` selects the model's thinking level; if
 * that effort is rejected (adapter/model does not support it) the selection is
 * retried with the model default and reported as a warning. Other failures are
 * warnings too: the review still runs on the session's route.
 * @param {object} ctx Host plugin context
 * @param {string} sessionId review session id
 * @param {{ reviewerProvider?: string, reviewerModel?: string, reviewerReasoningEffort?: string }} config resolved plugin config
 * @returns {Promise<string[]>} non-fatal warnings
 */
export async function selectReviewerModel(ctx, sessionId, config) {
  const provider = typeof config.reviewerProvider === 'string' ? config.reviewerProvider.trim() : ''
  const model = typeof config.reviewerModel === 'string' ? config.reviewerModel.trim() : ''
  if (provider === '' || model === '') return []
  const effort = typeof config.reviewerReasoningEffort === 'string' ? config.reviewerReasoningEffort.trim() : ''
  const route = { sessionId, provider, model }
  const failureText = (error) => (error && error.message ? error.message : String(error))
  try {
    await ctx.sessionController.selectModel(effort === '' ? route : { ...route, reasoningEffort: effort })
    return []
  } catch (error) {
    if (effort === '') {
      return [`無法切換 reviewer 模型 ${provider}/${model}：${failureText(error)}`]
    }
    // The effort may simply not exist on this model/route; fall back to the
    // model default so the review still uses the requested model.
    try {
      await ctx.sessionController.selectModel(route)
      return [`reviewer 思考能力「${effort}」無法套用，已改用模型預設：${failureText(error)}`]
    } catch (fallbackError) {
      return [`無法切換 reviewer 模型 ${provider}/${model}：${failureText(fallbackError)}`]
    }
  }
}

export async function createReviewSession(ctx, config, input) {
  const warnings = []
  const { cwd, warnings: cwdWarnings } = resolveCwd(input.implAgent)
  warnings.push(...cwdWarnings)

  let workspace
  try {
    workspace = await ctx.workspaceRegistry.resolveByPath(cwd)
  } catch (error) {
    warnings.push(`workspace 解析失敗：${error && error.message ? error.message : String(error)}`)
  }
  if (workspace === undefined) warnings.push('找不到對應 workspace；review session 不會出現在側欄，請手動開啟。')

  let reviewSessionId
  try {
    const created = await ctx.sessionController.create({
      cwd,
      ...(typeof config.reviewerPreset === 'string' && config.reviewerPreset !== ''
        ? { agentPreset: config.reviewerPreset }
        : {}),
    })
    reviewSessionId = created.sessionId
  } catch (error) {
    throw new SessionFactoryError(
      SESSION_FACTORY_CODES.CREATE_FAILED,
      `無法建立 review session：${error && error.message ? error.message : String(error)}`,
    )
  }

  if (workspace !== undefined) {
    try {
      await workspace.attachSession(reviewSessionId)
    } catch (error) {
      warnings.push(`review session 無法掛進 workspace：${error && error.message ? error.message : String(error)}`)
    }
  }

  const reviewAgent = await waitForAgent(ctx, reviewSessionId)
  if (reviewAgent === undefined) {
    throw new SessionFactoryError(
      SESSION_FACTORY_CODES.NO_REVIEW_AGENT,
      `review session ${reviewSessionId} 已建立，但 agent 未在時限內上線；請手動開啟後使用 /handoff-review feedback。`,
      { sessionId: reviewSessionId },
    )
  }

  warnings.push(...(await selectReviewerModel(ctx, reviewSessionId, config)))
  warnings.push(...applyReviewerPolicy(ctx, reviewAgent, config))

  try {
    reviewAgent.followup(buildUserMessage(input.messageText))
  } catch (error) {
    throw new SessionFactoryError(
      SESSION_FACTORY_CODES.CREATE_FAILED,
      `review brief 投遞失敗：${error && error.message ? error.message : String(error)}`,
      { sessionId: reviewSessionId },
    )
  }

  return {
    reviewSessionId,
    workspaceId: workspace !== undefined ? workspace.id : (input.workspaceId ?? null),
    warnings,
  }
}

/**
 * Optionally produce an LLM summary of the handoff (`config.autoSummarize`).
 * Any failure falls back to the deterministic handoff with a warning — this
 * must never fail the creation flow (DEVELOPMENT.md §9.6).
 * @param {object} ctx Host plugin context
 * @param {object} implAgent live impl Agent (for the route)
 * @param {string} handoffText deterministic handoff
 * @param {{ autoSummarize?: boolean }} config resolved plugin config
 * @returns {Promise<{ text: string, warnings: string[] }>} handoff, optionally with a Summary section
 */
export async function summarizeHandoff(ctx, implAgent, handoffText, config) {
  if (config.autoSummarize !== true) return { text: handoffText, warnings: [] }
  const llm = ctx.get('llm')
  if (llm === undefined || typeof llm.stream !== 'function') {
    return { text: handoffText, warnings: ['autoSummarize 已啟用，但 llm 服務不可用；已改用 deterministic handoff。'] }
  }
  const route = implAgent && implAgent.options ? implAgent.options : {}
  if (typeof route.provider !== 'string' || typeof route.model !== 'string') {
    return { text: handoffText, warnings: ['autoSummarize 已啟用，但無法判定 impl session 的模型；已改用 deterministic handoff。'] }
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 15_000)
  try {
    let summary = ''
    const stream = llm.stream({
      provider: route.provider,
      model: route.model,
      system:
        'You summarize code-review handoffs. Reply with 3-6 short bullet points covering the goal, the riskiest changes, and what the reviewer should verify. Do not invent files or behavior.',
      messages: [
        {
          role: 'user',
          content: [{ type: 'text', text: `Summarize this handoff for a reviewer:\n\n${handoffText}` }],
        },
      ],
      maxTokens: 800,
      temperature: 0.2,
      signal: controller.signal,
    })
    for await (const chunk of stream) {
      if (chunk.type === 'text-delta' && typeof chunk.text === 'string') summary += chunk.text
      if (chunk.type === 'finish' && chunk.reason && chunk.reason.kind === 'error') {
        throw new Error(chunk.reason.failure && chunk.reason.failure.message ? chunk.reason.failure.message : 'LLM error')
      }
    }
    const trimmed = summary.trim()
    if (trimmed === '') {
      return { text: handoffText, warnings: ['autoSummarize 回傳空摘要；已改用 deterministic handoff。'] }
    }
    const withSummary = handoffText.replace(
      /^(# Handoff for review \(round \d+\)\n)/,
      `$1\n## Summary\n${trimmed}\n`,
    )
    return { text: withSummary, warnings: [] }
  } catch (error) {
    return {
      text: handoffText,
      warnings: [`autoSummarize 失敗（${error && error.message ? error.message : String(error)}）；已改用 deterministic handoff。`],
    }
  } finally {
    clearTimeout(timer)
  }
}

// ---------------------------------------------------------------------------
// Continuation sessions (handoff to a new ordinary writable session)
// ---------------------------------------------------------------------------

/** System prompt for the single optional continuation-summary LLM call. */
const CONTINUATION_SUMMARY_SYSTEM =
  "You summarize a software-development session so a new session can continue the work. Output markdown only, with exactly these three level-3 sections, ~200 words each max: '### Progress so far', '### Key knowledge and decisions', '### Next steps'. Be concrete, cite file paths when known, never invent facts."

/** Timeout for the single continuation-summary LLM call. */
const CONTINUATION_SUMMARY_TIMEOUT_MS = 15_000

/** Character cap for the deterministic fallback's last-assistant excerpt. */
const CONTINUATION_FALLBACK_EXCERPT_CHARS = 1500

/**
 * Read the source agent's effective route.
 *
 * `agent.options` holds the creation options and is stale after a later
 * `selectModel` (api.md pitfall #9), so a live request header is authoritative
 * whenever the installed session exposes one: provider/model fall back to
 * `agent.options` only when the header value is empty, while `reasoningEffort`
 * comes from the header only (an absent header effort means the model default,
 * never the stale creation value). With no header config at all the options
 * fallback is kept for compatibility.
 * @param {object} agent live source Agent
 * @returns {{ provider: string, model: string, reasoningEffort: string }} the route
 */
function sourceRouteOf(agent) {
  let headerConfig
  try {
    const header = agent && agent.session && typeof agent.session.requestHeader === 'function'
      ? agent.session.requestHeader()
      : undefined
    if (header !== null && typeof header === 'object' && header.config !== null && typeof header.config === 'object') {
      headerConfig = header.config
    }
  } catch {
    headerConfig = undefined
  }
  const options = agent && agent.options && typeof agent.options === 'object' ? agent.options : {}
  const text = (value) => (typeof value === 'string' ? value.trim() : '')
  const headerProvider = text(headerConfig ? headerConfig.provider : undefined)
  const headerModel = text(headerConfig ? headerConfig.model : undefined)
  return {
    provider: headerProvider || text(options.provider),
    model: headerModel || text(options.model),
    reasoningEffort: headerConfig === undefined
      ? text(options.reasoningEffort)
      : text(headerConfig.reasoningEffort),
  }
}

/**
 * Build one stable key for a provider/model route, or '' when either half is
 * blank. The start path uses it to check a model override against the catalog
 * snapshot that the matching preview returned.
 * @param {unknown} provider provider id
 * @param {unknown} model model id
 * @returns {string} `provider\u0000model`, or '' for an incomplete pair
 */
export function continuationRouteKey(provider, model) {
  const providerText = typeof provider === 'string' ? provider.trim() : ''
  const modelText = typeof model === 'string' ? model.trim() : ''
  return providerText === '' || modelText === '' ? '' : providerText + '\u0000' + modelText
}

/**
 * Sanitize `sessionController.modelCatalog()` for the browser: only the
 * provider/model identity plus the reasoning-effort metadata the continuation
 * dialog needs, with malformed entries skipped. Best effort only.
 * @param {unknown} catalog raw model catalog
 * @returns {{ groups: Array<{ id: string, name: string, models: Array<{ id: string, name: string, reasoningEfforts: Array<{ id: string, name: string }>, defaultReasoningEffort: string }> }>, failures: Array<{ id: string, name: string }> }} catalog view
 */
export function sanitizeContinuationCatalog(catalog) {
  const source = catalog !== null && typeof catalog === 'object' ? catalog : {}
  const groups = []
  for (const group of Array.isArray(source.groups) ? source.groups : []) {
    if (group === null || typeof group !== 'object') continue
    const groupId = typeof group.id === 'string' ? group.id.trim() : ''
    if (groupId === '') continue
    const models = []
    for (const model of Array.isArray(group.models) ? group.models : []) {
      if (model === null || typeof model !== 'object') continue
      const modelId = typeof model.id === 'string' ? model.id.trim() : ''
      if (modelId === '') continue
      const reasoning = model.reasoning !== null && typeof model.reasoning === 'object' ? model.reasoning : {}
      const efforts = []
      for (const effort of Array.isArray(reasoning.efforts) ? reasoning.efforts : []) {
        if (effort === null || typeof effort !== 'object') continue
        const effortId = typeof effort.id === 'string' ? effort.id.trim() : ''
        if (effortId === '') continue
        const effortName = typeof effort.name === 'string' && effort.name.trim() !== ''
          ? effort.name.trim()
          : effortId
        efforts.push({ id: effortId, name: effortName })
      }
      models.push({
        id: modelId,
        name: typeof model.name === 'string' && model.name.trim() !== '' ? model.name.trim() : modelId,
        reasoningEfforts: efforts,
        defaultReasoningEffort: typeof reasoning.defaultEffort === 'string'
          ? reasoning.defaultEffort.trim()
          : '',
      })
    }
    if (models.length === 0) continue
    groups.push({
      id: groupId,
      name: typeof group.name === 'string' && group.name.trim() !== '' ? group.name.trim() : groupId,
      models,
    })
  }
  const failures = []
  for (const failure of Array.isArray(source.failures) ? source.failures : []) {
    if (failure === null || typeof failure !== 'object') continue
    const failureId = typeof failure.id === 'string' ? failure.id.trim() : ''
    if (failureId === '') continue
    failures.push({
      id: failureId,
      name: typeof failure.name === 'string' && failure.name.trim() !== '' ? failure.name.trim() : failureId,
    })
  }
  return { groups, failures }
}

/**
 * List every provider/model pair advertised by a sanitized continuation catalog.
 * @param {{ groups?: Array<object> } | undefined} catalog sanitized catalog
 * @returns {string[]} route keys (see {@link continuationRouteKey})
 */
export function continuationCatalogRouteKeys(catalog) {
  const source = catalog !== null && typeof catalog === 'object' ? catalog : {}
  const keys = []
  for (const group of Array.isArray(source.groups) ? source.groups : []) {
    if (group === null || typeof group !== 'object' || !Array.isArray(group.models)) continue
    for (const model of group.models) {
      if (model === null || typeof model !== 'object') continue
      const key = continuationRouteKey(group.id, model.id)
      if (key !== '') keys.push(key)
    }
  }
  return keys
}

/**
 * Find one model entry in a sanitized continuation catalog.
 * @param {{ groups?: Array<object> } | undefined} catalog sanitized catalog
 * @param {string} provider provider id
 * @param {string} model model id
 * @returns {object | undefined} matching model entry
 */
function findContinuationCatalogModel(catalog, provider, model) {
  const source = catalog !== null && typeof catalog === 'object' ? catalog : {}
  for (const group of Array.isArray(source.groups) ? source.groups : []) {
    if (group === null || typeof group !== 'object' || group.id !== provider) continue
    for (const candidate of Array.isArray(group.models) ? group.models : []) {
      if (candidate !== null && typeof candidate === 'object' && candidate.id === model) return candidate
    }
  }
  return undefined
}

/**
 * Resolve the source route, its reasoning-effort options and the provider/model
 * catalog for the continuation dialog from `sessionController.modelCatalog()`.
 * Best effort only: a missing/falling catalog degrades to empty options instead
 * of failing the preview.
 * @param {object} ctx Host plugin context
 * @param {object} sourceAgent live source Agent
 * `catalogKnown` is true only when `modelCatalog()` actually returned a
 * catalog (an empty one included); a missing service or a failed read leaves it
 * false so the start path knows there is no previewed snapshot to validate
 * against.
 * @returns {Promise<{ provider: string, model: string, efforts: Array<{ id: string, name: string }>, defaultReasoningEffort: string, currentReasoningEffort: string, catalog: { groups: Array<object>, failures: Array<object> }, catalogKnown: boolean, warnings: string[] }>} route info
 */
export async function resolveContinuationRoute(ctx, sourceAgent) {
  const route = sourceRouteOf(sourceAgent)
  const result = {
    provider: route.provider,
    model: route.model,
    efforts: [],
    defaultReasoningEffort: '',
    currentReasoningEffort: route.reasoningEffort,
    catalog: { groups: [], failures: [] },
    catalogKnown: false,
    warnings: [],
  }
  let catalog
  try {
    const controller = ctx && typeof ctx === 'object' ? ctx.sessionController : undefined
    if (controller !== undefined && typeof controller.modelCatalog === 'function') {
      catalog = await controller.modelCatalog()
    }
  } catch (error) {
    result.warnings.push(`無法讀取模型目錄，模型與思考強度選項不可用：${continuationErrorText(error)}`)
    return result
  }
  if (catalog === undefined) return result
  result.catalogKnown = true
  result.catalog = sanitizeContinuationCatalog(catalog)
  const matched = findContinuationCatalogModel(result.catalog, route.provider, route.model)
  if (matched === undefined) {
    if (route.provider !== '' && route.model !== '') {
      result.warnings.push(`模型目錄中找不到 ${route.provider}/${route.model}，思考強度選項不可用。`)
    }
    return result
  }
  result.efforts = matched.reasoningEfforts.map((effort) => ({ ...effort }))
  result.defaultReasoningEffort = matched.defaultReasoningEffort
  if (result.currentReasoningEffort === '') result.currentReasoningEffort = result.defaultReasoningEffort
  return result
}

/**
 * Apply the requested source route to a fresh continuation session, falling
 * back to the model default when the explicit reasoning effort is rejected.
 * @param {object} ctx Host plugin context
 * @param {string} sessionId continuation session id
 * @param {{ provider?: string, model?: string, reasoningEffort?: string }} route requested route
 * @returns {Promise<string[]>} non-fatal warnings
 */
export async function selectContinuationModel(ctx, sessionId, route) {
  const selected = route !== null && typeof route === 'object' ? route : {}
  const provider = typeof selected.provider === 'string' ? selected.provider.trim() : ''
  const model = typeof selected.model === 'string' ? selected.model.trim() : ''
  if (provider === '' || model === '') return []
  const effort = typeof selected.reasoningEffort === 'string' ? selected.reasoningEffort.trim() : ''
  const controller = ctx && typeof ctx === 'object' ? ctx.sessionController : undefined
  if (controller === undefined || typeof controller.selectModel !== 'function') {
    return [`無法套用 ${provider}/${model}：sessionController 未提供 selectModel。`]
  }
  const base = { sessionId, provider, model }
  try {
    await controller.selectModel(effort === '' ? base : { ...base, reasoningEffort: effort })
    return []
  } catch (error) {
    if (effort === '') {
      return [`無法套用 ${provider}/${model}：${continuationErrorText(error)}`]
    }
    try {
      await controller.selectModel(base)
      return [`思考強度「${effort}」無法套用，已改用模型預設：${continuationErrorText(error)}`]
    } catch (fallbackError) {
      return [`無法套用 ${provider}/${model}：${continuationErrorText(fallbackError)}`]
    }
  }
}

/**
 * Optionally summarize the source session for the continuation prompt with one
 * LLM call on the source agent's route. Any failure (missing service, missing
 * route, timeout, error, empty output) falls back to a deterministic summary
 * plus a warning — this must never fail the preview flow.
 * @param {object} ctx Host plugin context
 * @param {object} sourceAgent live source Agent (for the LLM route)
 * @param {{ goal?: string, changes?: Array<object>, verification?: string | object | Array<object>, openQuestions?: string, transcript?: string, lastAssistantText?: string }} input assembled context
 * @param {object} config resolved plugin config (reserved; unused for now)
 * @returns {Promise<{ text: string, source: 'llm' | 'deterministic', warnings: string[] }>} summary text and provenance
 */
export async function summarizeContinuation(ctx, sourceAgent, input, config) {
  const source = input !== null && typeof input === 'object' ? input : {}
  const route = sourceRouteOf(sourceAgent)
  const fallback = buildDeterministicContinuationSummary(source)
  const fallbackWarning = (reason) => `無法取得模型摘要，已改用基本整理：${reason}`
  let llm
  try {
    llm = ctx && typeof ctx === 'object' && typeof ctx.get === 'function' ? ctx.get('llm') : undefined
  } catch {
    llm = undefined
  }
  if (llm === undefined || llm === null || typeof llm.stream !== 'function') {
    return { text: fallback, source: 'deterministic', warnings: [fallbackWarning('llm 服務不可用')] }
  }
  if (route.provider === '' || route.model === '') {
    return { text: fallback, source: 'deterministic', warnings: [fallbackWarning('無法判定來源 session 的模型')] }
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), CONTINUATION_SUMMARY_TIMEOUT_MS)
  try {
    let summary = ''
    const stream = llm.stream({
      provider: route.provider,
      model: route.model,
      system: CONTINUATION_SUMMARY_SYSTEM,
      messages: [
        {
          role: 'user',
          content: [{ type: 'text', text: buildContinuationSummaryUserText(source) }],
        },
      ],
      maxTokens: 1200,
      temperature: 0.2,
      signal: controller.signal,
    })
    for await (const chunk of stream) {
      if (chunk === null || typeof chunk !== 'object') continue
      if (chunk.type === 'text-delta' && typeof chunk.text === 'string') summary += chunk.text
      if (chunk.type === 'finish' && chunk.reason && (chunk.reason.kind === 'error' || chunk.reason.kind === 'aborted')) {
        throw new Error(
          chunk.reason.failure && chunk.reason.failure.message ? chunk.reason.failure.message : 'LLM error',
        )
      }
    }
    const trimmed = summary.trim()
    if (trimmed === '') {
      return { text: fallback, source: 'deterministic', warnings: [fallbackWarning('模型回傳空摘要')] }
    }
    return { text: trimmed, source: 'llm', warnings: [] }
  } catch (error) {
    return { text: fallback, source: 'deterministic', warnings: [fallbackWarning(continuationErrorText(error))] }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Create the continuation session and deliver the handoff as its first user
 * message. Mirrors {@link createReviewSession} except that the session stays
 * writable (no reviewer policy) and the new title / model / effort are applied
 * to the fresh session instead of reviewer config.
 *
 * Order: create → workspace attach → wait for the live agent → select model
 * (no-effort fallback) → title (pins it before the first prompt) → followup.
 * @param {object} ctx Host plugin context
 * @param {{ sourceAgent: object, messageText: string, title?: string, route?: { provider?: string, model?: string }, reasoningEffort?: string, agentPreset?: string }} input continuation inputs
 * @returns {Promise<{ sessionId: string, workspaceId: string | null, warnings: string[], title: string }>} the created session
 * @throws {SessionFactoryError} `CREATE_FAILED` / `NO_CONTINUATION_AGENT` with `sessionId` when known
 */
export async function createContinuationSession(ctx, input) {
  const source = input !== null && typeof input === 'object' ? input : {}
  const warnings = []
  const { cwd, warnings: cwdWarnings } = resolveCwd(source.sourceAgent)
  warnings.push(...cwdWarnings)

  let workspace
  try {
    workspace = await ctx.workspaceRegistry.resolveByPath(cwd)
  } catch (error) {
    warnings.push(`workspace 解析失敗：${continuationErrorText(error)}`)
  }
  if (workspace === undefined) warnings.push('找不到對應 workspace；continuation session 不會出現在側欄，請手動開啟。')

  const agentPreset = continuationAgentPreset(source)
  let sessionId
  try {
    const created = await ctx.sessionController.create({
      cwd,
      ...(agentPreset !== '' ? { agentPreset } : {}),
    })
    sessionId = created && typeof created.sessionId === 'string' ? created.sessionId : ''
  } catch (error) {
    throw new SessionFactoryError(
      SESSION_FACTORY_CODES.CREATE_FAILED,
      `無法建立 continuation session：${continuationErrorText(error)}`,
    )
  }
  if (sessionId === '') {
    throw new SessionFactoryError(
      SESSION_FACTORY_CODES.CREATE_FAILED,
      '無法建立 continuation session：sessionController.create 未回傳 sessionId。',
    )
  }

  if (workspace !== undefined) {
    try {
      await workspace.attachSession(sessionId)
    } catch (error) {
      warnings.push(`continuation session 無法掛進 workspace：${continuationErrorText(error)}`)
    }
  }

  let agent
  try {
    agent = await waitForAgent(ctx, sessionId)
  } catch (error) {
    // The session already exists: keep its id on the error so the one-shot
    // draft is spent and a retry cannot create a duplicate session.
    throw new SessionFactoryError(
      SESSION_FACTORY_CODES.CREATE_FAILED,
      `continuation session ${sessionId} 已建立，但等待 agent 上線時失敗：${continuationErrorText(error)}`,
      { sessionId },
    )
  }
  if (agent === undefined) {
    throw new SessionFactoryError(
      SESSION_FACTORY_CODES.NO_CONTINUATION_AGENT,
      `continuation session ${sessionId} 已建立，但 agent 未在時限內上線；請手動開啟該 session。`,
      { sessionId },
    )
  }

  const route = source.route !== null && typeof source.route === 'object' ? source.route : {}
  warnings.push(...(await selectContinuationModel(ctx, sessionId, {
    provider: route.provider,
    model: route.model,
    reasoningEffort: source.reasoningEffort,
  })))

  applyContinuationTitle(ctx, agent, source.title, warnings)

  const messageText = typeof source.messageText === 'string' ? source.messageText : ''
  try {
    agent.followup(buildUserMessage(messageText, { kind: CONTINUATION_SOURCE }))
  } catch (error) {
    throw new SessionFactoryError(
      SESSION_FACTORY_CODES.CREATE_FAILED,
      `交接續作訊息投遞失敗：${continuationErrorText(error)}`,
      { sessionId },
    )
  }

  return {
    sessionId,
    workspaceId: workspace !== undefined && typeof workspace.id === 'string' ? workspace.id : null,
    warnings,
    title: typeof source.title === 'string' ? source.title.trim() : '',
  }
}

/**
 * Inherit the agent preset: an explicit input wins, otherwise the source
 * session's header preset (when present).
 * @param {{ agentPreset?: string, sourceAgent?: object }} source continuation inputs
 * @returns {string} the agent preset id, or an empty string
 */
function continuationAgentPreset(source) {
  const explicit = typeof source.agentPreset === 'string' ? source.agentPreset.trim() : ''
  if (explicit !== '') return explicit
  const header = source.sourceAgent && source.sourceAgent.session ? source.sourceAgent.session.header : undefined
  if (header !== null && typeof header === 'object' && typeof header.agentPreset === 'string') {
    return header.agentPreset.trim()
  }
  return ''
}

/**
 * Set the new session title through the optional `sessionTitle` service.
 * Missing service or a rename failure downgrades to a warning.
 * @param {object} ctx Host plugin context
 * @param {object} agent live continuation Agent
 * @param {string} title proposed title
 * @param {string[]} warnings warning sink
 * @returns {void}
 */
function applyContinuationTitle(ctx, agent, title, warnings) {
  const normalized = typeof title === 'string' ? title.trim() : ''
  if (normalized === '') return
  let service
  try {
    service = ctx && typeof ctx.get === 'function' ? ctx.get('sessionTitle') : undefined
  } catch {
    service = undefined
  }
  if (service === undefined || service === null || typeof service.rename !== 'function') {
    warnings.push('sessionTitle 服務不可用，未設定 continuation session 標題。')
    return
  }
  try {
    service.rename(agent.session, normalized)
  } catch (error) {
    warnings.push(`無法設定 continuation session 標題：${continuationErrorText(error)}`)
  }
}

/**
 * Build the deterministic fallback summary body (three level-3 sections).
 * @param {{ transcript?: string, lastAssistantText?: string }} input assembled context
 * @returns {string} the fallback summary
 */
function buildDeterministicContinuationSummary(input) {
  const lastAssistantText = continuationLastAssistantText(input)
  const excerpt = lastAssistantText !== ''
    ? lastAssistantText.slice(0, CONTINUATION_FALLBACK_EXCERPT_CHARS)
    : '（沒有可用的對話摘要）'
  return [
    '### Progress so far',
    '（無法取得模型摘要；以下為最近一則回覆節錄）',
    '',
    excerpt,
    '',
    '### Next steps',
    '- 依上列變更、待辦與使用者補充事項繼續。',
  ].join('\n')
}

/**
 * Read the last assistant reply text: the explicit input wins, otherwise it is
 * recovered from the tail of the transcript excerpt.
 * @param {{ transcript?: string, lastAssistantText?: string }} input assembled context
 * @returns {string} the last assistant text (possibly empty)
 */
function continuationLastAssistantText(input) {
  const provided = typeof input.lastAssistantText === 'string' ? input.lastAssistantText.trim() : ''
  if (provided !== '') return provided
  const transcript = typeof input.transcript === 'string' ? input.transcript : ''
  const marker = '[assistant] '
  const index = transcript.lastIndexOf(marker)
  if (index === -1) return ''
  return transcript.slice(index + marker.length).trim()
}

/**
 * Compose the user message sent to the continuation-summary LLM.
 * @param {{ goal?: string, changes?: Array<object>, changedFilesText?: string, verification?: unknown, verificationText?: string, openQuestions?: string, transcript?: string }} input assembled context
 * @returns {string} the user prompt
 */
function buildContinuationSummaryUserText(input) {
  const goal = typeof input.goal === 'string' && input.goal.trim() !== '' ? input.goal.trim() : '未提供'
  const changedFilesText = typeof input.changedFilesText === 'string'
    ? input.changedFilesText.trim()
    : formatChangedFilesForSummary(input.changes)
  const verificationText = typeof input.verificationText === 'string'
    ? input.verificationText.trim()
    : formatVerificationForSummary(input.verification)
  const openQuestions = typeof input.openQuestions === 'string' && input.openQuestions.trim() !== ''
    ? input.openQuestions.trim()
    : '（無）'
  const transcript = typeof input.transcript === 'string' && input.transcript.trim() !== ''
    ? input.transcript.trim()
    : '（無）'
  return [
    `Goal:\n${goal}`,
    `Changed files:\n${changedFilesText}`,
    `Verification:\n${verificationText}`,
    `Open questions:\n${openQuestions}`,
    `Session excerpt:\n${transcript}`,
  ].join('\n\n')
}

/**
 * Render changed-file lines for the summary LLM prompt.
 * @param {unknown} changes collected per-file changes
 * @returns {string} the changed-file lines (or the empty-change note)
 */
function formatChangedFilesForSummary(changes) {
  const files = Array.isArray(changes) ? changes : []
  const lines = []
  for (const file of files) {
    if (file === null || typeof file !== 'object') continue
    const path = typeof file.path === 'string' && file.path !== '' ? file.path : '(unknown)'
    const added = Number.isFinite(file.added) ? file.added : 0
    const removed = Number.isFinite(file.removed) ? file.removed : 0
    lines.push(`- ${path} (+${added} \u2212${removed})`)
  }
  return lines.length > 0 ? lines.join('\n') : '本次 session 尚無變更'
}

/**
 * Render the verification snapshot for the summary LLM prompt.
 * @param {unknown} verification verification input (string, snapshot, or snapshot list)
 * @returns {string} the verification text (or the no-observation note)
 */
function formatVerificationForSummary(verification) {
  const entries = Array.isArray(verification) ? verification : verification ? [verification] : []
  const parts = []
  for (const entry of entries) {
    if (typeof entry === 'string') {
      if (entry.trim() !== '') parts.push(entry.trim())
      continue
    }
    if (entry === null || typeof entry !== 'object') continue
    const tool = typeof entry.tool === 'string' && entry.tool !== '' ? entry.tool : 'command'
    const text = typeof entry.text === 'string' ? entry.text.trim() : ''
    const head = entry.isError === true ? `- ${tool} (failed)` : `- ${tool}`
    parts.push(text === '' ? head : `${head}\n${text}`)
  }
  return parts.length > 0 ? parts.join('\n') : '未觀察到'
}

/**
 * Describe an unknown failure for a warning / diagnostic message.
 * @param {unknown} error thrown value
 * @returns {string} message text
 */
function continuationErrorText(error) {
  return error && error.message ? error.message : String(error)
}
