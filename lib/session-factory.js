// handoff-review — review-session creation and reviewer lockdown.
//
// A review session is an ordinary workspace session (not a subagent): it is
// created through the Host session controller, attached to the impl session's
// workspace so it shows up in the sidebar, and locked down before the first
// review brief is delivered (DEVELOPMENT.md §7.1, §9.3, §9.7).

import { buildUserMessage } from './delivery.js'

/** Global write-capable tools denied to the reviewer. */
export const WRITE_TOOL_NAMES = ['edit', 'write', 'str_replace_editor', 'apply_patch', 'multi_edit']

/** Stable failure codes for session creation. */
export const SESSION_FACTORY_CODES = {
  CREATE_FAILED: 'CREATE_FAILED',
  NO_REVIEW_AGENT: 'NO_REVIEW_AGENT',
  NO_IMPL_AGENT: 'NO_IMPL_AGENT',
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
