// Continuation handoff tests (DESIGN-continuation.md §6): builder unit cases,
// preview/start route contracts, session creation order, effort fallback,
// one-shot drafts, stable failure codes, trust fence, and the guarantee that
// the continuation path writes no review state and applies no reviewer policy.
//
// The harness mirrors test/m2-integration.test.js: in-memory storage domain,
// fake Sessions/Agents, fake sessionController/modelCatalog/llm, and route
// handlers invoked directly from the registered exact routes.

import test from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'

import {
  apply,
  CONTINUATION_DRAFT_TTL_MS,
  MAX_CONTINUATION_SUPPLEMENT_CHARS,
} from '../index.js'
import { DIFF_PROJECTION_KEY } from '../lib/projections.js'
import {
  appendContinuationSupplement,
  buildContinuationPrompt,
  buildContinuationTitle,
  buildContinuationTranscript,
  normalizeContinuationSummary,
} from '../lib/handoff-builder.js'
import { buildUserMessage, CONTINUATION_SOURCE, DELIVERY_SOURCE } from '../lib/delivery.js'
import { ROUTE_PATHS } from '../lib/routes.js'

/** Provider/model used by the fake catalog and the seeded source session. */
const PROVIDER = 'fake-provider'
const MODEL = 'fake-model'
/** Reasoning efforts advertised by the fake model catalog. */
const EFFORTS = [
  { id: 'low', name: 'Low' },
  { id: 'high', name: 'High' },
  { id: 'medium', name: 'Medium' },
]
/** Default diff projection for the seeded source session. */
const DEFAULT_PROJECTION = {
  entries: [
    { seq: 2, path: 'src/retry.js', oldText: 'return n;', newText: 'return retry(n - 1, max);' },
    { seq: 3, path: 'src/backoff.js', oldText: null, newText: 'export const cap = 5;\nexport const base = 100;' },
  ],
  lastSeq: 3,
  verification: { tool: 'bash', text: 'npm test — 12 passed' },
}
/** Derived messages for the seeded source session. */
const DEFAULT_MESSAGES = [
  { role: 'user', content: [{ type: 'text', text: '把 retry 加上 backoff，先寫測試。' }] },
  {
    role: 'assistant',
    content: [{ type: 'text', text: '已完成 retry.js 的 backoff。TODO：確認 timeout 行為。' }],
  },
]

/**
 * In-memory storage-domain double with one serialized write chain per domain.
 * @returns {object} storage double plus per-domain record getters
 */
function createStorageDomain() {
  let chain = Promise.resolve()
  const domains = new Map()
  const enqueue = (job) => {
    const result = chain.then(job)
    chain = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }
  const makeTable = () => {
    const records = new Map()
    return {
      records,
      handle: {
        get: (key) => records.get(key),
        entries: () => new Map(records).entries(),
        keys: () => [...records.keys()][Symbol.iterator](),
        get size() {
          return records.size
        },
        put: (key, value) => enqueue(async () => records.set(key, value)),
        delete: (key) => enqueue(async () => records.delete(key)),
        update: (key, fn) =>
          enqueue(async () => {
            if (!records.has(key)) throw new Error(`missing key ${key}`)
            const next = fn(records.get(key))
            records.set(key, next)
            return next
          }),
      },
    }
  }
  const ensure = (name) => {
    if (!domains.has(name)) {
      const tables = new Map()
      const tableFor = (table) => {
        if (!tables.has(table)) tables.set(table, makeTable())
        return tables.get(table)
      }
      domains.set(name, {
        tables,
        tableFor,
        domain: { name, table: (table) => tableFor(table).handle, close: async () => {} },
      })
    }
    return domains.get(name)
  }
  return {
    storageDomain: { open: async (spec) => ensure(spec.name).domain },
    ensure,
    get links() {
      return ensure('handoff_review').tableFor('links').records
    },
    get rounds() {
      return ensure('handoff_review_history').tableFor('rounds').records
    },
    get settings() {
      return ensure('handoff_review_settings').tableFor('settings').records
    },
  }
}

/**
 * Build one fake Session; an explicit `route` installs `requestHeader()` (the
 * continuation preview reads the effective route from it).
 * @param {string} id session id
 * @param {string} cwd session working directory
 * @param {{ messages?: Array<object>, header?: object, route?: object }} [options] session input
 * @returns {object} fake Session
 */
function createSession(id, cwd, options = {}) {
  const events = []
  const session = {
    id,
    header: { cwd, ...(options.header ?? {}) },
    events,
    append(type, data) {
      events.push({ type, data })
      return { type, data }
    },
    deriveMessages: () => options.messages ?? [],
  }
  if (options.route !== undefined) session.requestHeader = () => ({ config: { ...options.route } })
  return session
}

/**
 * Build one fake Agent with a followup recorder and a tool runtime spy.
 * @param {object} session owning fake Session
 * @param {object} context fake Host context
 * @param {{ agentOptions?: object, order?: string[], followupThrows?: boolean }} [options] agent options
 * @returns {object} fake Agent
 */
function createAgent(session, context, options = {}) {
  const received = []
  const tools = {
    restricted: false,
    guarded: false,
    schemas: () => [{ name: 'bash' }, { name: 'edit' }],
    restrict: () => {
      tools.restricted = true
      return () => {}
    },
    guard: () => {
      tools.guarded = true
      return () => {}
    },
  }
  return {
    session,
    options: options.agentOptions ?? { provider: PROVIDER, model: MODEL },
    received,
    tools,
    followup(message) {
      if (Array.isArray(options.order)) options.order.push('followup')
      if (options.followupThrows === true) throw new Error('inbox boom')
      received.push(message)
    },
    inject(message) {
      received.push(message)
    },
    ctx: { tools },
    context,
  }
}

/**
 * Build the fake Cordis Host context. Options select failure/edge modes:
 * `createMode` ('ok' | 'throw' | 'no-agent' | 'hold'), `selectModelMode`
 * ('ok' | 'reject-effort' | 'reject-all'), `catalogMode` ('ok' | 'throws'),
 * `followupMode` ('ok' | 'throw'), `sessionTitleMode` ('ok' | 'missing' | 'throw'),
 * `llm` (fake llm service or undefined).
 * @param {object} [options] host behaviour overrides
 * @returns {object} fake host
 */
function createHost(options = {}) {
  const storage = createStorageDomain()
  const sessions = new Map()
  const agents = new Map()
  const projectionState = new Map()
  const routes = []
  const listeners = new Map()
  const commandDefinitions = []
  const effects = []
  const attached = []
  const renames = []
  const calls = { create: [], selectModel: [] }
  const createdSessions = []
  const approvalCalls = []
  /** Design-critical call order: create → attach → selectModel → rename → followup. */
  const order = []
  const createMode = options.createMode ?? 'ok'
  const selectModelMode = options.selectModelMode ?? 'ok'
  const catalogMode = options.catalogMode ?? 'ok'
  const followupMode = options.followupMode ?? 'ok'
  const sessionTitleMode = options.sessionTitleMode ?? 'ok'
  const agentsGetMode = options.agentsGetMode ?? 'ok'
  let next = 0
  let releaseCreate
  const createGate = createMode === 'hold'
    ? new Promise((resolve) => {
      releaseCreate = resolve
    })
    : null
  const modelCatalog = options.modelCatalog ?? {
    default: { provider: PROVIDER, model: MODEL },
    routableProviders: [PROVIDER],
    groups: [
      {
        id: PROVIDER,
        name: 'Fake Provider',
        models: [
          {
            id: MODEL,
            name: 'Fake Model',
            reasoning: { efforts: EFFORTS.map((effort) => ({ ...effort })), defaultEffort: 'medium' },
          },
        ],
      },
    ],
    failures: [],
  }

  const ctx = {
    storageDomain: storage.storageDomain,
    commands: {
      register(definition) {
        commandDefinitions.push(definition)
        return () => {}
      },
    },
    agents: {
      get: (id) => {
        // Simulate a registry read failure after the session was already created.
        if (agentsGetMode === 'throw-after-create'
          && typeof id === 'string' && id.startsWith('session-cont-')) {
          throw new Error('agents registry boom')
        }
        return agents.get(id)
      },
    },
    sessions: { get: (id) => sessions.get(id) },
    sessionProjections: {
      register: () => () => {},
      stateOf: (session, key) => projectionState.get(`${session.id}|${key}`),
    },
    workspaceRegistry: {
      archivedSessionIds: [],
      resolveByPath: async (path) => ({
        id: 'workspace-1',
        path,
        attachSession: async (sessionId) => {
          attached.push(sessionId)
          order.push('attach')
        },
      }),
    },
    sessionController: {
      async create(request) {
        order.push('create')
        calls.create.push({ ...request })
        if (createMode === 'throw') throw new Error('create boom')
        if (createGate !== null) await createGate
        next += 1
        const sessionId = `session-cont-${next}`
        const session = createSession(sessionId, request.cwd, {})
        const agent = createAgent(session, ctx, {
          order,
          followupThrows: followupMode === 'throw',
        })
        sessions.set(sessionId, session)
        if (createMode !== 'no-agent') agents.set(sessionId, agent)
        createdSessions.push({ sessionId, session, agent, request: { ...request } })
        return {
          sessionId,
          ...(request.agentPreset === undefined ? {} : { agentPreset: request.agentPreset }),
        }
      },
      async selectModel(request) {
        order.push('selectModel')
        calls.selectModel.push({ ...request })
        if (selectModelMode === 'reject-effort' && request.reasoningEffort !== undefined) {
          throw new Error('reasoning effort not supported')
        }
        if (selectModelMode === 'reject-all') throw new Error('model unavailable')
        return {
          selected: {
            provider: request.provider,
            model: request.model,
            ...(request.reasoningEffort === undefined ? {} : { reasoningEffort: request.reasoningEffort }),
          },
        }
      },
      async modelCatalog() {
        if (catalogMode === 'throws') throw new Error('catalog down')
        return modelCatalog
      },
      async inspect(sessionId) {
        if (!sessions.has(sessionId)) throw new Error('session not found')
        return { meta: { id: sessionId }, events: [] }
      },
      async list() {
        return { items: [...sessions.keys()].map((sessionId) => ({ sessionId })) }
      },
    },
    effect(fn) {
      const dispose = fn()
      effects.push(dispose)
      return dispose
    },
    on(event, handler) {
      listeners.set(event, [...(listeners.get(event) ?? []), handler])
      return () => {}
    },
    inject(_deps, callback) {
      callback(ctx)
      return () => {}
    },
    get(service) {
      if (service === 'webServer') return ctx.webServer
      if (service === 'fs') {
        return {
          resolve: async (path) => path,
          stat: async () => ({ size: 25 }),
          readText: async () => '',
        }
      }
      if (service === 'approval') {
        return {
          setPolicy: (agent, policy) => {
            approvalCalls.push({ agent, policy })
          },
        }
      }
      if (service === 'sessionTitle') {
        if (sessionTitleMode === 'missing') return undefined
        return {
          get: (session) => ({ title: session.id === 'session-impl' ? 'impl title' : 'created title' }),
          rename: (session, title) => {
            order.push('rename')
            if (sessionTitleMode === 'throw') throw new Error('rename boom')
            renames.push({ sessionId: session.id, title })
            return { title }
          },
        }
      }
      if (service === 'llm') return options.llm ?? undefined
      if (service === 'agentPresets') {
        return { list: async () => [{ id: 'default', name: 'Default' }] }
      }
      return undefined
    },
    webServer: {
      register(definition) {
        routes.push(definition)
        return () => {}
      },
    },
  }
  return {
    ctx,
    storage,
    sessions,
    agents,
    projectionState,
    routes,
    listeners,
    commandDefinitions,
    effects,
    attached,
    renames,
    calls,
    createdSessions,
    approvalCalls,
    modelCatalog,
    order,
    releaseCreate: () => {
      if (releaseCreate !== undefined) releaseCreate()
    },
  }
}

/**
 * Seed one live source session with a diff projection and derived messages.
 * @param {object} host fake host
 * @param {{ sessionId?: string, cwd?: string, messages?: Array<object>, header?: object, route?: object, projection?: object, agentOptions?: object }} [options] seed input
 * @returns {{ session: object, agent: object }} seeded session and agent
 */
function seedSource(host, options = {}) {
  const sessionId = options.sessionId ?? 'session-impl'
  const session = createSession(sessionId, options.cwd ?? '/tmp/ws', {
    messages: options.messages ?? DEFAULT_MESSAGES,
    header: options.header ?? { agentPreset: 'default' },
    route: options.route ?? { provider: PROVIDER, model: MODEL, reasoningEffort: 'high' },
  })
  const agent = createAgent(session, host.ctx, { agentOptions: options.agentOptions })
  host.sessions.set(sessionId, session)
  host.agents.set(sessionId, agent)
  host.projectionState.set(
    `${sessionId}|${DIFF_PROJECTION_KEY}`,
    options.projection ?? DEFAULT_PROJECTION,
  )
  return { session, agent }
}

/**
 * Build one fake llm service whose stream yields one summary text then finish.
 * @param {string} [summaryText] summary markdown returned by the fake stream
 * @returns {object} fake llm service with a `calls` recorder
 */
function createLlm(summaryText = [
  '### Progress so far',
  'LLM-SUMMARY-MARKER retry backoff is implemented.',
  '### Key knowledge and decisions',
  '- retry.js caps at 5.',
  '### Next steps',
  '- verify the timeout path.',
].join('\n')) {
  const calls = []
  const llm = {
    calls,
    stream(options) {
      calls.push(options)
      return (async function* fakeStream() {
        yield { type: 'text-delta', index: 0, text: summaryText }
        yield { type: 'finish', reason: { kind: 'stop' } }
      })()
    },
  }
  return llm
}

/** Fake llm whose `stream()` throws synchronously. */
function createThrowingLlm() {
  return {
    stream() {
      throw new Error('llm boom')
    },
  }
}

/**
 * Fake llm whose stream only yields a terminal error finish chunk.
 * @param {string} [message] failure message carried by the finish chunk
 */
function createErrorFinishLlm(message = 'model exploded') {
  return {
    stream() {
      return (async function* errorFinish() {
        yield { type: 'finish', reason: { kind: 'error', failure: { message } } }
      })()
    },
  }
}

/** Fake llm whose stream yields no text-delta (only a clean finish). */
function createEmptyLlm() {
  return {
    stream() {
      return (async function* emptyFinish() {
        yield { type: 'finish', reason: { kind: 'stop' } }
      })()
    },
  }
}

/** Build one fake HTTP response. */
function makeResponse() {
  return {
    writableEnded: false,
    statusCode: 0,
    body: '',
    writeHead(status) {
      this.statusCode = status
    },
    end(body) {
      this.writableEnded = true
      this.body = body
    },
  }
}

/**
 * Invoke one registered exact route directly and parse its JSON response.
 * @param {object} host fake host
 * @param {string} path exact route path
 * @param {{ method?: string, query?: string, body?: object | null, headers?: object }} [options] request input
 * @returns {Promise<{ status: number, body: object | null }>} status and parsed payload
 */
async function callRoute(host, path, options = {}) {
  const { method = 'POST', query = '', body = null, headers = {} } = options
  const route = host.routes.find((candidate) => candidate.path === path)
  assert.ok(route !== undefined, `route ${path} not registered`)
  const res = makeResponse()
  const requestHeaders = { host: '127.0.0.1:52674', ...headers }
  let req
  if (body !== null) {
    const stream = Readable.from([Buffer.from(JSON.stringify(body))])
    stream.headers = requestHeaders
    stream.method = method
    stream.url = path + query
    req = stream
  } else {
    req = { method, url: path + query, headers: requestHeaders, on: () => {} }
  }
  await route.handler(req, res)
  return { status: res.statusCode, body: res.body === '' ? null : JSON.parse(res.body) }
}

/** Call the continuation preview route for one source session. */
async function callPreview(host, sessionId = 'session-impl', options = {}) {
  return callRoute(host, ROUTE_PATHS.continuationPreview, { body: { sessionId }, ...options })
}

/** Call the continuation start route with one request body. */
async function callStart(host, body, options = {}) {
  return callRoute(host, ROUTE_PATHS.continuationStart, { body, ...options })
}

/**
 * Run one callback while `setTimeout` fires immediately. The production
 * `waitForAgent` poll budget is 400 × 25 ms; this keeps the timeout test fast
 * without changing the code under test (the callback only awaits the poll).
 * @template T
 * @param {() => Promise<T>} callback operation to run
 * @returns {Promise<T>} callback result
 */
async function withImmediateTimers(callback) {
  const original = globalThis.setTimeout
  globalThis.setTimeout = (handler, _delay, ...args) => {
    queueMicrotask(() => handler(...args))
    return 0
  }
  try {
    return await callback()
  } finally {
    globalThis.setTimeout = original
  }
}

/**
 * Build one fake host with a seeded live source session and activate the plugin.
 * @param {object} [options] host behaviour overrides
 * @returns {Promise<{ host: object, session: object, agent: object }>} activated fixture
 */
async function setupHost(options = {}) {
  const host = createHost(options)
  const source = seedSource(host, options.source)
  await apply(host.ctx, {
    maxRounds: 3,
    maxHandoffChars: options.maxHandoffChars ?? 30000,
    diffPerFileChars: 6000,
    autoSummarize: false,
    readOnlyReviewer: true,
    maxDeliveriesPerMinute: 6,
  })
  return { host, ...source }
}

// ---------------------------------------------------------------------------
// 1. Builder contract (deterministic prompt format, §4)
// ---------------------------------------------------------------------------

test('continuation builder: fixed sections, changed files, verification, warnings and supplement block', () => {
  const prompt = buildContinuationPrompt({
    sourceSessionId: 'session-impl',
    sourceTitle: 'impl title',
    cwd: '/tmp/ws',
    goal: '把 retry 加上 backoff',
    summary: '### Progress so far\n- done\n### Key knowledge and decisions\n- k\n### Next steps\n- n',
    summarySource: 'llm',
    changes: [
      { path: 'src/retry.js', added: 1, removed: 1, seq: 1 },
      { path: 'src/backoff.js', added: 2, removed: 0, seq: 2 },
    ],
    verification: { tool: 'bash', text: 'npm test — 12 passed' },
    openQuestions: 'TODO：確認 timeout',
    warnings: ['warn-one'],
    config: { maxHandoffChars: 30000 },
  })
  // Headings in the exact documented order.
  const headings = [
    '# Handoff continuation: impl title',
    '[handoff-continuation] This is a handoff from an earlier session in the same project.',
    'Continue the work below in this new session.',
    '## How to continue',
    '## Project',
    '## Goal',
    '## Summary from the previous session',
    '## Changed files',
    '## Verification',
    '## Open questions',
  ]
  let cursor = -1
  for (const heading of headings) {
    const index = prompt.indexOf(heading)
    assert.ok(index > cursor, `missing or out-of-order section: ${heading}`)
    cursor = index
  }
  assert.match(prompt, /- Working directory: \/tmp\/ws/)
  assert.match(prompt, /- Source session: session-impl/)
  assert.match(prompt, /- Source title: impl title/)
  assert.match(prompt, /把 retry 加上 backoff/)
  assert.match(prompt, /### Progress so far/)
  assert.match(prompt, /- src\/retry\.js \(\+1 \u22121\)/)
  assert.match(prompt, /- src\/backoff\.js \(\+2 \u22120\)/)
  assert.match(prompt, /npm test — 12 passed/)
  assert.match(prompt, /- ⚠ warn-one/)
  assert.match(prompt, /TODO：確認 timeout/)
  assert.ok(!prompt.includes('## User supplement'), 'builder must not append the supplement')
  // Exact supplement block appended by the start path.
  assert.equal(
    appendContinuationSupplement(prompt, '  先跑測試  '),
    `${prompt}\n\n## User supplement\n先跑測試`,
  )
  assert.equal(appendContinuationSupplement(prompt, '   '), prompt)
  assert.equal(appendContinuationSupplement(prompt, null), prompt)
  // The title and heading scope are capped at 60 source-title characters.
  const longTitle = 'x'.repeat(100)
  assert.equal(buildContinuationTitle(longTitle), `Continuation: ${'x'.repeat(60)}`)
  assert.equal(buildContinuationTitle('  a \n b  '), 'Continuation: a b')
  assert.equal(buildContinuationTitle(''), 'Continuation')
  assert.equal(buildContinuationTitle(undefined), 'Continuation')
})

test('continuation builder: redacts secret-looking lines from goal, summary and warnings', () => {
  // Deliberately non-secret placeholders: the redaction triggers on the key
  // names, while secret scanners must not mistake the fixture for a real key.
  const prompt = buildContinuationPrompt({
    sourceSessionId: 's',
    cwd: '/tmp/ws',
    goal: '設定環境\nOPENAI_API_KEY=<fixture-key>\npassword: <fixture-password>',
    summary: '### Progress so far\nDB_PASSWORD=<fixture-db-password>',
    changes: [],
    verification: null,
    openQuestions: '',
    warnings: ['api_key=<fixture-warning>'],
    config: {},
  })
  assert.ok(!prompt.includes('<fixture-key>'), 'API key value must be redacted')
  assert.ok(!prompt.includes('<fixture-password>'), 'password value must be redacted')
  assert.ok(!prompt.includes('<fixture-db-password>'), 'summary secret must be redacted')
  assert.ok(!prompt.includes('<fixture-warning>'), 'warning secret must be redacted')
  assert.match(prompt, /OPENAI_API_KEY= \[REDACTED\]/)
  assert.match(prompt, /password: \[REDACTED\]/)
  assert.match(prompt, /DB_PASSWORD= \[REDACTED\]/)
  assert.match(prompt, /本次 session 尚無變更/)
})

test('continuation builder: transcript keeps newest messages, skips prior handoffs and empty text', () => {
  const messages = []
  for (let index = 0; index < 40; index += 1) {
    messages.push({
      role: index % 2 === 0 ? 'user' : 'assistant',
      content: [{ type: 'text', text: `message-${String(index).padStart(2, '0')}-${'x'.repeat(40)}` }],
    })
  }
  messages.push({ role: 'user', content: [{ type: 'text', text: '' }] })
  messages.push({
    role: 'user',
    content: [{ type: 'text', text: 'PREVIOUS-HANDOFF-TEXT' }],
    source: { kind: 'handoff-continuation' },
  })
  messages.push({ role: 'user', content: [{ type: 'text', text: 'NEWEST-MESSAGE' }] })
  const transcript = buildContinuationTranscript(messages, 300)
  assert.ok(transcript.startsWith('（較早的對話已省略）\n'), 'truncated transcript gets the leading note')
  assert.ok(transcript.includes('NEWEST-MESSAGE'), 'newest message survives truncation')
  assert.ok(!transcript.includes('message-00-'), 'oldest messages are dropped')
  assert.ok(!transcript.includes('PREVIOUS-HANDOFF-TEXT'), 'prior continuation handoff is skipped')
  assert.ok(transcript.length <= 300)
  const short = buildContinuationTranscript([{ role: 'system', content: [] }], 100)
  assert.equal(short, '')
})

test('continuation builder: caps the base prompt and normalizes the LLM summary', () => {
  const prompt = buildContinuationPrompt({
    sourceSessionId: 'session-impl',
    sourceTitle: 'impl',
    cwd: '/tmp/ws',
    goal: 'g\n'.repeat(2000),
    summary: 'summary',
    changes: [],
    verification: null,
    openQuestions: '',
    config: { maxHandoffChars: 400 },
  })
  assert.ok(prompt.length <= 400, `prompt length ${prompt.length} exceeds maxHandoffChars`)
  assert.ok(prompt.endsWith('（交接內容已截斷）'), 'over-budget prompt ends with the truncation marker')
  const longSummary = 'line\n'.repeat(4000)
  const normalized = normalizeContinuationSummary(longSummary)
  assert.ok(normalized.length <= 8000, 'LLM summary is capped at 8000 characters')
  // Supplement cap is exported and used by the start path.
  const capped = appendContinuationSupplement('BASE', 'z'.repeat(MAX_CONTINUATION_SUPPLEMENT_CHARS + 500))
  assert.ok(capped.startsWith('BASE\n\n## User supplement\n'))
  assert.ok(capped.length <= 'BASE\n\n## User supplement\n'.length + MAX_CONTINUATION_SUPPLEMENT_CHARS)
})

test('buildUserMessage honors the continuation source kind without changing the default', () => {
  const continuation = buildUserMessage('handoff', { kind: CONTINUATION_SOURCE })
  assert.equal(continuation.source.kind, 'handoff-continuation')
  assert.equal(continuation.role, 'user')
  assert.equal(continuation.content[0].text, 'handoff')
  assert.equal(buildUserMessage('review').source.kind, DELIVERY_SOURCE)
})

// ---------------------------------------------------------------------------
// 2-3. Preview route: payload, effort mapping, LLM summary / deterministic fallback
// ---------------------------------------------------------------------------

test('continuation preview: returns the draft, prompt, source route and reasoning efforts', async () => {
  const { host } = await setupHost()
  const { status, body } = await callPreview(host)
  assert.equal(status, 200)
  assert.equal(body.ok, true)
  assert.deepEqual(body.route, { provider: PROVIDER, model: MODEL })
  assert.deepEqual(body.efforts, EFFORTS)
  assert.equal(body.defaultReasoningEffort, 'medium')
  assert.equal(body.currentReasoningEffort, 'high')
  // The dialog's provider/model picker comes from the same catalog snapshot.
  assert.deepEqual(body.catalog.groups, [
    {
      id: PROVIDER,
      name: 'Fake Provider',
      models: [{
        id: MODEL,
        name: 'Fake Model',
        reasoningEfforts: EFFORTS,
        defaultReasoningEffort: 'medium',
      }],
    },
  ])
  assert.deepEqual(body.catalog.failures, [])
  assert.equal(body.sourceTitle, 'impl title')
  assert.equal(body.cwd, '/tmp/ws')
  assert.equal(body.chars, body.prompt.length)
  assert.match(body.draftId, /^[0-9a-f-]{36}$/)
  assert.equal(body.summarySource, 'deterministic')
  assert.equal(body.warnings.length, 1)
  assert.match(body.warnings[0], /無法取得模型摘要，已改用基本整理：llm 服務不可用/)
  // Prompt comes from the live source session (goal, changes, verification, fallback summary).
  assert.match(body.prompt, /^# Handoff continuation: impl title/)
  assert.match(body.prompt, /把 retry 加上 backoff/)
  assert.match(body.prompt, /- src\/retry\.js \(\+1 \u22121\)/)
  assert.match(body.prompt, /npm test — 12 passed/)
  assert.match(body.prompt, /（無法取得模型摘要；以下為最近一則回覆節錄）/)
  assert.match(body.prompt, /- ⚠ 無法取得模型摘要/)
  // The continuation entry is offered only for a live source agent.
  const state = await callRoute(host, ROUTE_PATHS.state, { method: 'GET', query: '?sessionId=session-impl' })
  assert.equal(state.body.ok, true)
  assert.equal(state.body.can.continue, true)
  // The preview alone writes nothing durable.
  assert.equal(host.storage.links.size, 0)
  assert.equal(host.storage.rounds.size, 0)
})

test('continuation preview: one LLM summary call on the source route marks summarySource llm', async () => {
  const llm = createLlm()
  const { host } = await setupHost({ llm })
  const { body } = await callPreview(host)
  assert.equal(body.ok, true)
  assert.equal(body.summarySource, 'llm')
  assert.deepEqual(body.warnings, [])
  assert.match(body.prompt, /LLM-SUMMARY-MARKER/)
  assert.equal(llm.calls.length, 1)
  const call = llm.calls[0]
  assert.equal(call.provider, PROVIDER)
  assert.equal(call.model, MODEL)
  assert.match(call.system, /exactly these three level-3 sections/)
  assert.equal(call.maxTokens, 1200)
  assert.equal(call.temperature, 0.2)
  assert.ok(call.signal instanceof AbortSignal)
  assert.equal(call.messages.length, 1)
  const userText = call.messages[0].content[0].text
  assert.match(userText, /Goal:\n把 retry 加上 backoff/)
  assert.match(userText, /Changed files:\n- src\/retry\.js/)
  assert.match(userText, /Session excerpt:/)
})

test('continuation preview: a failing model catalog degrades to no effort options', async () => {
  const llm = createLlm()
  const { host } = await setupHost({ llm, catalogMode: 'throws' })
  const { body } = await callPreview(host)
  assert.equal(body.ok, true)
  assert.deepEqual(body.efforts, [])
  assert.equal(body.defaultReasoningEffort, '')
  assert.equal(body.currentReasoningEffort, 'high')
  assert.equal(body.summarySource, 'llm')
  assert.ok(body.warnings.some((warning) => /無法讀取模型目錄/.test(warning)))
  // No catalog means no provider/model choices; the dialog keeps the source route.
  assert.deepEqual(body.catalog, { groups: [], failures: [] })
})

test('continuation preview: sanitizes the provider-grouped catalog for the dialog', async () => {
  const catalog = {
    groups: [
      {
        id: 'alpha',
        name: 'Alpha',
        models: [
          {
            id: 'a1',
            name: 'A1',
            description: 'not forwarded',
            reasoning: {
              efforts: [
                { id: 'low', name: 'Low', description: 'not forwarded' },
                { id: '', name: 'broken' },
                null,
              ],
              defaultEffort: 'low',
            },
          },
          { id: 'a2', name: '', reasoning: { efforts: [] } },
          null,
        ],
      },
      { id: '', name: 'no id', models: [] },
      { id: 'beta', name: 'Beta', models: [] },
      null,
    ],
    failures: [{ id: 'gamma', name: 'Gamma', message: 'boom' }],
  }
  const { host } = await setupHost({ modelCatalog: catalog })
  const { body } = await callPreview(host)
  assert.equal(body.ok, true)
  assert.deepEqual(body.catalog.groups, [
    {
      id: 'alpha',
      name: 'Alpha',
      models: [
        {
          id: 'a1',
          name: 'A1',
          reasoningEfforts: [{ id: 'low', name: 'Low' }],
          defaultReasoningEffort: 'low',
        },
        { id: 'a2', name: 'a2', reasoningEfforts: [], defaultReasoningEffort: '' },
      ],
    },
  ])
  assert.deepEqual(body.catalog.failures, [{ id: 'gamma', name: 'Gamma' }])
  // The source route (fake-provider/fake-model) is absent from this catalog:
  // effort options stay empty and the dialog keeps the retained source route.
  assert.deepEqual(body.efforts, [])
  assert.ok(body.warnings.some((warning) => /模型目錄中找不到 fake-provider\/fake-model/.test(warning)))
})

// ---------------------------------------------------------------------------
// 4. Start route: ordinary writable session, same cwd, title, model+effort, first message
// ---------------------------------------------------------------------------

test('continuation start: creates a writable same-cwd session, attaches, titles, selects model and delivers the prompt', async () => {
  const { host } = await setupHost()
  const preview = await callPreview(host)
  assert.equal(preview.body.ok, true)
  const previewPrompt = preview.body.prompt

  const { status, body } = await callStart(host, {
    sessionId: 'session-impl',
    draftId: preview.body.draftId,
    reasoningEffort: 'high',
    supplement: '  先跑 npm test  ',
  })
  assert.equal(status, 200)
  assert.equal(body.ok, true)
  assert.equal(body.title, 'Continuation: impl title')
  assert.equal(body.workspaceId, 'workspace-1')
  assert.deepEqual(body.warnings, [])
  assert.match(body.message, /已建立交接續作 session session-cont-1/)
  const newSessionId = body.sessionId
  assert.equal(newSessionId, 'session-cont-1')

  // Created through the session controller in the source cwd, inheriting its preset.
  assert.equal(host.calls.create.length, 1)
  assert.equal(host.calls.create[0].cwd, '/tmp/ws')
  assert.equal(host.calls.create[0].agentPreset, 'default')
  // Attached to the resolved workspace so it appears in the sidebar.
  assert.deepEqual(host.attached, [newSessionId])
  // Model + effort applied to the new session before delivery.
  assert.deepEqual(host.calls.selectModel, [
    { sessionId: newSessionId, provider: PROVIDER, model: MODEL, reasoningEffort: 'high' },
  ])
  // Title set through sessionTitle.rename (pinning it before the first prompt).
  assert.deepEqual(host.renames, [{ sessionId: newSessionId, title: 'Continuation: impl title' }])

  const created = host.createdSessions[0]
  // Exactly the previewed prompt plus the trimmed supplement is the first user message.
  assert.equal(created.agent.received.length, 1)
  const message = created.agent.received[0]
  assert.equal(message.role, 'user')
  assert.equal(message.source.kind, 'handoff-continuation')
  assert.equal(message.content.length, 1)
  assert.equal(message.content[0].type, 'text')
  assert.equal(message.content[0].text, `${previewPrompt}\n\n## User supplement\n先跑 npm test`)
  assert.match(message.id, /^[0-9a-f-]{36}$/)
  // Design-critical order: create the session, attach it to the workspace, install
  // the model/effort, pin the title, and only then deliver the first prompt.
  assert.deepEqual(host.order, ['create', 'attach', 'selectModel', 'rename', 'followup'])

  // Ordinary writable session: no reviewer lockdown, no approval policy, no writes to the source.
  assert.equal(created.session.events.filter((event) => event.type === 'sandbox/mode').length, 0)
  assert.equal(created.agent.tools.restricted, false)
  assert.equal(created.agent.tools.guarded, false)
  assert.equal(host.approvalCalls.length, 0)
  assert.equal(host.agents.get('session-impl').received.length, 0)
  // No review link / round records and no settings writes are created by continuation.
  assert.equal(host.storage.links.size, 0)
  assert.equal(host.storage.rounds.size, 0)
  assert.equal(host.storage.settings.size, 0)

  // The draft is one-shot: a second start for the same draft is refused and creates nothing.
  const replay = await callStart(host, {
    sessionId: 'session-impl',
    draftId: preview.body.draftId,
  })
  assert.equal(replay.body.ok, false)
  assert.equal(replay.body.code, 'DRAFT_EXPIRED')
  assert.equal(host.calls.create.length, 1)
})

test('continuation start: without a supplement the delivered message is the preview prompt unchanged', async () => {
  const { host } = await setupHost()
  const preview = await callPreview(host)
  const { body } = await callStart(host, {
    sessionId: 'session-impl',
    draftId: preview.body.draftId,
  })
  assert.equal(body.ok, true)
  const created = host.createdSessions[0]
  assert.equal(created.agent.received[0].content[0].text, preview.body.prompt)
})

// ---------------------------------------------------------------------------
// 4b. Provider/model override chosen in the dialog (M3.1)
// ---------------------------------------------------------------------------

test('continuation start: applies the provider/model override chosen from the previewed catalog', async () => {
  const catalog = {
    groups: [
      {
        id: PROVIDER,
        name: 'Fake Provider',
        models: [{ id: MODEL, name: 'Fake Model', reasoning: { efforts: EFFORTS, defaultEffort: 'medium' } }],
      },
      {
        id: 'alt-provider',
        name: 'Alt Provider',
        models: [{
          id: 'alt-model',
          name: 'Alt Model',
          reasoning: { efforts: [{ id: 'max', name: 'Max' }], defaultEffort: 'max' },
        }],
      },
    ],
  }
  const { host } = await setupHost({ modelCatalog: catalog })
  const preview = await callPreview(host)
  assert.equal(preview.body.ok, true)
  assert.ok(preview.body.catalog.groups.some((group) => group.id === 'alt-provider'))

  const { body } = await callStart(host, {
    sessionId: 'session-impl',
    draftId: preview.body.draftId,
    provider: 'alt-provider',
    model: 'alt-model',
    reasoningEffort: 'max',
  })
  assert.equal(body.ok, true)
  // The continuation session is created normally and receives the chosen route.
  assert.equal(host.calls.create.length, 1)
  assert.deepEqual(host.calls.selectModel, [{
    sessionId: 'session-cont-1',
    provider: 'alt-provider',
    model: 'alt-model',
    reasoningEffort: 'max',
  }])
  assert.equal(host.createdSessions[0].agent.received.length, 1)
  // The draft is one-shot after a successful start.
  const replay = await callStart(host, {
    sessionId: 'session-impl',
    draftId: preview.body.draftId,
    provider: 'alt-provider',
    model: 'alt-model',
  })
  assert.equal(replay.body.code, 'DRAFT_EXPIRED')
})

test('continuation start: rejects a provider/model override outside the previewed catalog and keeps the draft', async () => {
  const { host } = await setupHost()
  const preview = await callPreview(host)
  const rejected = await callStart(host, {
    sessionId: 'session-impl',
    draftId: preview.body.draftId,
    provider: 'ghost-provider',
    model: 'ghost-model',
  })
  assert.equal(rejected.body.ok, false)
  assert.equal(rejected.body.code, 'BAD_BODY')
  assert.match(rejected.body.message, /不在本次預覽的模型目錄中/)
  assert.equal(host.calls.create.length, 0)
  // The pre-create failure keeps the draft: a valid start with the same draft succeeds.
  const retry = await callStart(host, {
    sessionId: 'session-impl',
    draftId: preview.body.draftId,
  })
  assert.equal(retry.body.ok, true)
  assert.deepEqual(host.calls.selectModel, [{
    sessionId: 'session-cont-1',
    provider: PROVIDER,
    model: MODEL,
  }])
})

test('continuation start: a half or malformed provider/model override fails with BAD_BODY', async () => {
  const { host } = await setupHost()
  const preview = await callPreview(host)
  const base = { sessionId: 'session-impl', draftId: preview.body.draftId }
  const bodies = [
    { provider: PROVIDER },
    { model: MODEL },
    { provider: '', model: MODEL },
    { provider: 'bad provider!', model: MODEL },
    { provider: 'bad\u0000provider', model: MODEL },
    { provider: 'bad\u0085provider', model: MODEL },
    { provider: PROVIDER, model: 'x'.repeat(201) },
    { provider: 42, model: MODEL },
  ]
  for (const extra of bodies) {
    const { body } = await callStart(host, { ...base, ...extra })
    assert.equal(body.ok, false, `expected failure for ${JSON.stringify(extra)}`)
    assert.equal(body.code, 'BAD_BODY')
  }
  assert.equal(host.calls.create.length, 0)
  // None of the rejected attempts consumed the draft.
  const ok = await callStart(host, base)
  assert.equal(ok.body.ok, true)
})

test('continuation start: an unavailable catalog keeps the override accepted (adapter without catalog)', async () => {
  const { host } = await setupHost({ catalogMode: 'throws' })
  const preview = await callPreview(host)
  assert.deepEqual(preview.body.catalog, { groups: [], failures: [] })
  const { body } = await callStart(host, {
    sessionId: 'session-impl',
    draftId: preview.body.draftId,
    provider: 'custom-provider',
    model: 'custom-model',
  })
  assert.equal(body.ok, true)
  assert.deepEqual(host.calls.selectModel, [{
    sessionId: 'session-cont-1',
    provider: 'custom-provider',
    model: 'custom-model',
  }])
})

test('continuation start: accepts previewed routes whose ids use adapter-specific characters', async () => {
  const routeProvider = '@cf'
  const routeModel = '@cf/llama-3.1-8b'
  const altModel = '@cf/qwen-3'
  const catalog = {
    groups: [{
      id: routeProvider,
      name: 'Cloudflare',
      models: [
        {
          id: routeModel,
          name: 'Llama 3.1 8B',
          reasoning: { efforts: [{ id: 'low', name: 'Low' }], defaultEffort: 'low' },
        },
        { id: altModel, name: 'Qwen 3' },
      ],
    }],
  }
  const { host } = await setupHost({
    modelCatalog: catalog,
    source: { route: { provider: routeProvider, model: routeModel, reasoningEffort: 'low' } },
  })
  const preview = await callPreview(host)
  assert.equal(preview.body.ok, true)
  assert.deepEqual(preview.body.route, { provider: routeProvider, model: routeModel })
  // The dialog sends its default selection (the source pair): the @-prefixed ids
  // must pass the start validation even though they are adapter-specific.
  const defaultStart = await callStart(host, {
    sessionId: 'session-impl',
    draftId: preview.body.draftId,
    provider: routeProvider,
    model: routeModel,
    reasoningEffort: 'low',
  })
  assert.equal(defaultStart.body.ok, true)
  assert.deepEqual(host.calls.selectModel, [{
    sessionId: 'session-cont-1',
    provider: routeProvider,
    model: routeModel,
    reasoningEffort: 'low',
  }])

  // A catalog override using the same characters is accepted too.
  const second = await setupHost({
    modelCatalog: catalog,
    source: { route: { provider: routeProvider, model: routeModel } },
  })
  const secondPreview = await callPreview(second.host)
  const override = await callStart(second.host, {
    sessionId: 'session-impl',
    draftId: secondPreview.body.draftId,
    provider: routeProvider,
    model: altModel,
  })
  assert.equal(override.body.ok, true)
  assert.deepEqual(second.host.calls.selectModel, [{
    sessionId: 'session-cont-1',
    provider: routeProvider,
    model: altModel,
  }])
})

test('continuation start: an empty but readable catalog still rejects an unpreviewed override', async () => {
  const { host } = await setupHost({ modelCatalog: {} })
  const preview = await callPreview(host)
  assert.equal(preview.body.ok, true)
  assert.deepEqual(preview.body.catalog, { groups: [], failures: [] })
  const rejected = await callStart(host, {
    sessionId: 'session-impl',
    draftId: preview.body.draftId,
    provider: 'ghost-provider',
    model: 'ghost-model',
  })
  assert.equal(rejected.body.ok, false)
  assert.equal(rejected.body.code, 'BAD_BODY')
  assert.match(rejected.body.message, /不在本次預覽的模型目錄中/)
  // The source pair is still "same as source" and remains acceptable.
  const source = await callStart(host, {
    sessionId: 'session-impl',
    draftId: preview.body.draftId,
    provider: PROVIDER,
    model: MODEL,
  })
  assert.equal(source.body.ok, true)
})

test('continuation start: a post-create agent wait failure keeps the session id and spends the draft', async () => {
  const { host } = await setupHost({ agentsGetMode: 'throw-after-create' })
  const preview = await callPreview(host)
  const { body } = await callStart(host, {
    sessionId: 'session-impl',
    draftId: preview.body.draftId,
  })
  assert.equal(body.ok, false)
  assert.equal(body.code, 'CREATE_FAILED')
  assert.match(body.message, /等待 agent 上線時失敗：agents registry boom/)
  assert.match(body.message, /session-cont-1/)
  // The structured id lets the client offer the created session instead of Retry.
  assert.equal(body.sessionId, 'session-cont-1')
  // The session exists from here on: the one-shot draft is spent, so a retry
  // cannot create a duplicate session.
  const retry = await callStart(host, {
    sessionId: 'session-impl',
    draftId: preview.body.draftId,
  })
  assert.equal(retry.body.code, 'DRAFT_EXPIRED')
  assert.equal(host.calls.create.length, 1)
})

test('continuation start: an explicit source-route override is accepted even when the catalog omits it', async () => {
  const catalog = {
    groups: [{
      id: 'only-provider',
      name: 'Only Provider',
      models: [{ id: 'only-model', name: 'Only Model' }],
    }],
  }
  const { host } = await setupHost({ modelCatalog: catalog })
  const preview = await callPreview(host)
  assert.equal(preview.body.ok, true)
  // The dialog always sends its selection (the retained source route by default).
  const { body } = await callStart(host, {
    sessionId: 'session-impl',
    draftId: preview.body.draftId,
    provider: PROVIDER,
    model: MODEL,
  })
  assert.equal(body.ok, true)
  assert.deepEqual(host.calls.selectModel, [{
    sessionId: 'session-cont-1',
    provider: PROVIDER,
    model: MODEL,
  }])
})

// ---------------------------------------------------------------------------
// 5. Effort rejection falls back to the model default
// ---------------------------------------------------------------------------

test('continuation start: a rejected reasoning effort retries without it and warns', async () => {
  const { host } = await setupHost({ selectModelMode: 'reject-effort' })
  const preview = await callPreview(host)
  const { body } = await callStart(host, {
    sessionId: 'session-impl',
    draftId: preview.body.draftId,
    reasoningEffort: 'high',
  })
  assert.equal(body.ok, true)
  assert.ok(body.warnings.some((warning) => /思考強度「high」無法套用，已改用模型預設/.test(warning)))
  assert.equal(host.calls.selectModel.length, 2)
  assert.equal(host.calls.selectModel[0].reasoningEffort, 'high')
  assert.equal('reasoningEffort' in host.calls.selectModel[1], false)
  assert.equal(host.createdSessions[0].agent.received.length, 1)

  // A fully unavailable route is a warning too: delivery still succeeds on the default route.
  const unavailable = await setupHost({ selectModelMode: 'reject-all' })
  const secondPreview = await callPreview(unavailable.host)
  const second = await callStart(unavailable.host, {
    sessionId: 'session-impl',
    draftId: secondPreview.body.draftId,
    reasoningEffort: 'high',
  })
  assert.equal(second.body.ok, true)
  assert.ok(second.body.warnings.some((warning) => /無法套用 fake-provider\/fake-model/.test(warning)))
  assert.equal(unavailable.host.createdSessions[0].agent.received.length, 1)
})

// ---------------------------------------------------------------------------
// 6. One-shot draft validation: unknown, mismatched, expired, consumed
// ---------------------------------------------------------------------------

test('continuation start: unknown and mismatched drafts fail with DRAFT_EXPIRED', async () => {
  const { host } = await setupHost()
  const unknown = await callStart(host, { sessionId: 'session-impl', draftId: 'missing-draft' })
  assert.equal(unknown.body.ok, false)
  assert.equal(unknown.body.code, 'DRAFT_EXPIRED')

  const second = seedSource(host, { sessionId: 'session-other', cwd: '/tmp/ws2' })
  assert.ok(second.agent !== undefined)
  const preview = await callPreview(host)
  const mismatched = await callStart(host, {
    sessionId: 'session-other',
    draftId: preview.body.draftId,
  })
  assert.equal(mismatched.body.ok, false)
  assert.equal(mismatched.body.code, 'DRAFT_EXPIRED')
  assert.equal(host.calls.create.length, 0)
})

test('continuation start: a draft older than the TTL fails with DRAFT_EXPIRED', async () => {
  const { host } = await setupHost()
  const preview = await callPreview(host)
  const realNow = Date.now
  Date.now = () => realNow() + CONTINUATION_DRAFT_TTL_MS + 1000
  try {
    const expired = await callStart(host, {
      sessionId: 'session-impl',
      draftId: preview.body.draftId,
    })
    assert.equal(expired.body.ok, false)
    assert.equal(expired.body.code, 'DRAFT_EXPIRED')
    assert.equal(host.calls.create.length, 0)
  } finally {
    Date.now = realNow
  }
})

// ---------------------------------------------------------------------------
// 7. Failure codes: NO_IMPL_AGENT, BAD_BODY, trust fence, NO_CONTINUATION_AGENT, CREATE_FAILED
// ---------------------------------------------------------------------------

test('continuation routes: a cold source session fails with NO_IMPL_AGENT', async () => {
  const { host } = await setupHost()
  host.sessions.set('session-cold', createSession('session-cold', '/tmp/ws', {}))
  const preview = await callPreview(host, 'session-cold')
  assert.equal(preview.body.ok, false)
  assert.equal(preview.body.code, 'NO_IMPL_AGENT')
  const started = await callStart(host, { sessionId: 'session-cold', draftId: 'any' })
  assert.equal(started.body.ok, false)
  assert.equal(started.body.code, 'NO_IMPL_AGENT')

  const state = await callRoute(host, ROUTE_PATHS.state, { method: 'GET', query: '?sessionId=session-cold' })
  assert.equal(state.body.can.continue, false)
})

test('continuation routes: malformed bodies fail with BAD_BODY and create nothing', async () => {
  const { host } = await setupHost()
  const preview = await callPreview(host)
  const draftId = preview.body.draftId
  const attempts = [
    callPreview(host, undefined, { body: {} }),
    callPreview(host, undefined, { body: { sessionId: 42 } }),
    callStart(host, { sessionId: 'session-impl' }),
    callStart(host, { sessionId: 'session-impl', draftId, reasoningEffort: 5 }),
    callStart(host, { sessionId: 'session-impl', draftId, reasoningEffort: 'bad effort!' }),
    callStart(host, { sessionId: 'session-impl', draftId, supplement: 5 }),
  ]
  for (const attempt of attempts) {
    const { body } = await attempt
    assert.equal(body.ok, false)
    assert.equal(body.code, 'BAD_BODY')
  }
  assert.equal(host.calls.create.length, 0)
  // A valid effort string still works after the malformed attempts (draft not consumed).
  const accepted = await callStart(host, { sessionId: 'session-impl', draftId, reasoningEffort: 'low' })
  assert.equal(accepted.body.ok, true)
})

test('continuation preview: the exact route inherits the browser-trust fence', async () => {
  const { host } = await setupHost()
  const { status, body } = await callPreview(host, undefined, {
    method: 'POST',
    body: { sessionId: 'session-impl' },
    headers: { host: 'evil.example.com:52674' },
  })
  assert.equal(status, 403)
  assert.equal(body.ok, false)
  assert.equal(body.code, 'FORBIDDEN')
})

test('continuation start: a created session whose agent never becomes live reports NO_CONTINUATION_AGENT with its id', async () => {
  const { host } = await setupHost({ createMode: 'no-agent' })
  const preview = await callPreview(host)
  const result = await withImmediateTimers(() => callStart(host, {
    sessionId: 'session-impl',
    draftId: preview.body.draftId,
  }))
  assert.equal(result.body.ok, false)
  assert.equal(result.body.code, 'NO_CONTINUATION_AGENT')
  assert.match(result.body.message, /session-cont-1/)
  assert.deepEqual(host.attached, ['session-cont-1'])
})

test('continuation start: session creation failure maps to CREATE_FAILED', async () => {
  const { host } = await setupHost({ createMode: 'throw' })
  const preview = await callPreview(host)
  const { body } = await callStart(host, {
    sessionId: 'session-impl',
    draftId: preview.body.draftId,
  })
  assert.equal(body.ok, false)
  assert.equal(body.code, 'CREATE_FAILED')
  assert.match(body.message, /無法建立 continuation session/)
})

test('continuation start: concurrent starts for one source session report ALREADY_RUNNING', async () => {
  const { host } = await setupHost({ createMode: 'hold' })
  const preview = await callPreview(host)
  const request = {
    sessionId: 'session-impl',
    draftId: preview.body.draftId,
    reasoningEffort: 'high',
  }
  const first = callStart(host, request)
  for (let index = 0; index < 200 && host.calls.create.length === 0; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
  assert.equal(host.calls.create.length, 1)
  const second = await callStart(host, request)
  assert.equal(second.body.ok, false)
  assert.equal(second.body.code, 'ALREADY_RUNNING')
  host.releaseCreate()
  const finished = await first
  assert.equal(finished.body.ok, true)
  assert.equal(host.calls.create.length, 1)
})

// ---------------------------------------------------------------------------
// 9. Reviewer-gap hardening: LLM failures, followup failure, title service,
//    start-route fence, route-level caps, draft replacement
// ---------------------------------------------------------------------------

test('continuation preview: throwing, errored and empty LLM streams fall back to the deterministic summary', async () => {
  const cases = [
    { label: 'throwing stream', llm: createThrowingLlm(), warning: /llm boom/ },
    { label: 'error finish', llm: createErrorFinishLlm('model exploded'), warning: /model exploded/ },
    { label: 'no text delta', llm: createEmptyLlm(), warning: /模型回傳空摘要/ },
  ]
  for (const item of cases) {
    const { host } = await setupHost({ llm: item.llm })
    const { body } = await callPreview(host)
    assert.equal(body.ok, true, item.label)
    assert.equal(body.summarySource, 'deterministic', item.label)
    assert.equal(body.warnings.length, 1, item.label)
    assert.match(body.warnings[0], item.warning, item.label)
    assert.match(body.prompt, /### Progress so far/, item.label)
    assert.match(body.prompt, /（無法取得模型摘要；以下為最近一則回覆節錄）/, item.label)
    assert.equal(host.calls.create.length, 0, item.label)
  }
})

test('continuation start: a followup failure maps to CREATE_FAILED with the created session id and consumes the draft', async () => {
  const { host } = await setupHost({ followupMode: 'throw' })
  const preview = await callPreview(host)
  const first = await callStart(host, { sessionId: 'session-impl', draftId: preview.body.draftId })
  assert.equal(first.body.ok, false)
  assert.equal(first.body.code, 'CREATE_FAILED')
  assert.match(first.body.message, /交接續作訊息投遞失敗/)
  // The error carries the already-created session id (message + structured field)
  // so the client can offer that session instead of a Retry that would re-preview.
  assert.match(first.body.message, /session-cont-1/)
  assert.equal(first.body.sessionId, 'session-cont-1')
  // The session did exist: it was created and attached before the delivery failure.
  assert.deepEqual(host.attached, ['session-cont-1'])
  // m4: a failure that already created a session spends the one-shot draft; a retry
  // with the SAME draft is refused (the client offers the created session instead).
  const retry = await callStart(host, { sessionId: 'session-impl', draftId: preview.body.draftId })
  assert.equal(retry.body.ok, false)
  assert.equal(retry.body.code, 'DRAFT_EXPIRED')
  assert.equal(host.calls.create.length, 1)
})

test('continuation start: a missing or failing sessionTitle is a warning and the prompt is still delivered', async () => {
  const missing = await setupHost({ sessionTitleMode: 'missing' })
  const missingPreview = await callPreview(missing.host)
  assert.equal(missingPreview.body.ok, true)
  assert.equal(missingPreview.body.sourceTitle, '')
  const missingStart = await callStart(missing.host, {
    sessionId: 'session-impl',
    draftId: missingPreview.body.draftId,
  })
  assert.equal(missingStart.body.ok, true)
  assert.equal(missingStart.body.title, 'Continuation')
  assert.ok(missingStart.body.warnings.some((warning) => /sessionTitle 服務不可用/.test(warning)))
  assert.equal(missing.host.createdSessions[0].agent.received.length, 1)
  assert.equal(
    missing.host.createdSessions[0].agent.received[0].content[0].text,
    missingPreview.body.prompt,
  )

  const failing = await setupHost({ sessionTitleMode: 'throw' })
  const failingPreview = await callPreview(failing.host)
  const failingStart = await callStart(failing.host, {
    sessionId: 'session-impl',
    draftId: failingPreview.body.draftId,
  })
  assert.equal(failingStart.body.ok, true)
  assert.equal(failingStart.body.title, 'Continuation: impl title')
  assert.ok(
    failingStart.body.warnings.some((warning) => /無法設定 continuation session 標題：rename boom/.test(warning)),
  )
  assert.equal(failing.host.renames.length, 0)
  assert.equal(failing.host.createdSessions[0].agent.received.length, 1)
})

test('continuation start: the exact route inherits the browser-trust fence and creates nothing', async () => {
  const { host } = await setupHost()
  const { status, body } = await callStart(
    host,
    { sessionId: 'session-impl', draftId: 'any-draft' },
    { headers: { host: 'evil.example.com:52674' } },
  )
  assert.equal(status, 403)
  assert.equal(body.ok, false)
  assert.equal(body.code, 'FORBIDDEN')
  assert.equal(host.calls.create.length, 0)
})

test('continuation routes: maxHandoffChars caps the prompt and the supplement cap applies on delivery', async () => {
  const { host } = await setupHost({ maxHandoffChars: 300 })
  const preview = await callPreview(host)
  assert.equal(preview.body.ok, true)
  assert.ok(preview.body.prompt.length <= 300, `prompt length ${preview.body.prompt.length} > 300`)
  assert.ok(preview.body.prompt.endsWith('（交接內容已截斷）'))
  assert.equal(preview.body.chars, preview.body.prompt.length)

  const supplement = 'z'.repeat(MAX_CONTINUATION_SUPPLEMENT_CHARS + 500)
  const { body } = await callStart(host, {
    sessionId: 'session-impl',
    draftId: preview.body.draftId,
    supplement,
  })
  assert.equal(body.ok, true)
  const text = host.createdSessions[0].agent.received[0].content[0].text
  const marker = '\n\n## User supplement\n'
  assert.ok(text.startsWith(`${preview.body.prompt}${marker}`))
  const delivered = text.slice(text.indexOf(marker) + marker.length)
  assert.equal(delivered.length, MAX_CONTINUATION_SUPPLEMENT_CHARS)
  assert.equal(delivered, 'z'.repeat(MAX_CONTINUATION_SUPPLEMENT_CHARS))
})

test('continuation preview: a second preview for the same source session replaces the previous draft', async () => {
  const { host } = await setupHost()
  const first = await callPreview(host)
  const second = await callPreview(host)
  assert.equal(first.body.ok, true)
  assert.equal(second.body.ok, true)
  assert.notEqual(first.body.draftId, second.body.draftId)
  const stale = await callStart(host, { sessionId: 'session-impl', draftId: first.body.draftId })
  assert.equal(stale.body.ok, false)
  assert.equal(stale.body.code, 'DRAFT_EXPIRED')
  assert.equal(host.calls.create.length, 0)
  const fresh = await callStart(host, { sessionId: 'session-impl', draftId: second.body.draftId })
  assert.equal(fresh.body.ok, true)
  assert.equal(host.calls.create.length, 1)
})

test('continuation preview: the request-header effort is authoritative over stale agent.options (m3)', async () => {
  const { host, agent } = await setupHost({
    source: {
      // Live request header exists but records no explicit effort.
      route: { provider: PROVIDER, model: MODEL },
      // Stale creation-time options: must NOT leak into currentReasoningEffort.
      agentOptions: { provider: PROVIDER, model: MODEL, reasoningEffort: 'low' },
    },
  })
  const preview = await callPreview(host)
  assert.equal(preview.body.ok, true)
  assert.deepEqual(preview.body.route, { provider: PROVIDER, model: MODEL })
  assert.equal(preview.body.defaultReasoningEffort, 'medium')
  // The header wins over the stale 'low' creation value; the empty header effort
  // resolves to the model default, never to agent.options.
  assert.equal(preview.body.currentReasoningEffort, 'medium')
  // An omitted start effort therefore sends no reasoningEffort at all.
  const start = await callStart(host, { sessionId: 'session-impl', draftId: preview.body.draftId })
  assert.equal(start.body.ok, true)
  assert.equal(host.calls.selectModel.length, 1)
  assert.equal('reasoningEffort' in host.calls.selectModel[0], false)
  assert.equal(agent.received.length, 0)
})
