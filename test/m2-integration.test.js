// M2 integration tests with a fake Cordis context: multi-link (`--new`),
// right-panel history/diff payloads, settings persistence/catalog and the fixed
// review-session title (DEVELOPMENT.md §5.2/§7.1/§9.9/§10, M2).

import test from 'node:test'
import assert from 'node:assert/strict'

import { apply } from '../index.js'
import { DIFF_PROJECTION_KEY, REPLY_PROJECTION_KEY } from '../lib/projections.js'

/** In-memory storage-domain double with one serialized write chain per domain. */
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

function createSession(id, cwd, messages = []) {
  const events = []
  return {
    id,
    header: { cwd },
    events,
    append(type, data) {
      events.push({ type, data })
      return { type, data }
    },
    deriveMessages: () => messages,
  }
}

function createAgent(session, context) {
  const received = []
  return {
    session,
    options: { provider: 'fake-provider', model: 'fake-model' },
    received,
    followup(message) {
      received.push(message)
    },
    inject(message) {
      received.push(message)
    },
    ctx: {
      tools: {
        schemas: () => ['bash'].map((name) => ({ name })),
        restrict: () => () => {},
        guard: () => () => {},
      },
    },
    context,
  }
}

function createHost() {
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
  const fsFiles = new Map([['/tmp/ws/new.js', 'export const created = true\n']])
  let next = 0

  const ctx = {
    storageDomain: storage.storageDomain,
    commands: {
      register(definition) {
        commandDefinitions.push(definition)
        return () => {}
      },
    },
    agents: { get: (id) => agents.get(id) },
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
        attachSession: async (sessionId) => attached.push(sessionId),
      }),
    },
    sessionController: {
      async create(request) {
        next += 1
        const sessionId = `session-review-${next}`
        const session = createSession(sessionId, request.cwd)
        const agent = createAgent(session, ctx)
        sessions.set(sessionId, session)
        agents.set(sessionId, agent)
        return { sessionId }
      },
      async inspect(sessionId) {
        if (!sessions.has(sessionId)) throw new Error('session not found')
        return { meta: { id: sessionId }, events: [] }
      },
      async list() {
        return { items: [...sessions.keys()].map((sessionId) => ({ sessionId })) }
      },
      async selectModel() {
        return {}
      },
      async modelCatalog() {
        return {
          default: { provider: 'p', model: 'm' },
          routableProviders: ['p'],
          groups: [{ id: 'p', name: 'P', models: [{ id: 'm', name: 'M' }] }],
          failures: [],
        }
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
          readText: async (path) => fsFiles.get(path),
        }
      }
      if (service === 'approval') return { setPolicy: () => {} }
      if (service === 'sessionTitle') {
        return {
          get: (session) => ({ title: session.id === 'session-impl' ? 'impl title' : 'review' }),
          rename: (session, title) => {
            renames.push({ sessionId: session.id, title })
            return { title }
          },
        }
      }
      if (service === 'llm') {
        return {
          listProviders: () => [{ id: 'deepseek-account', name: 'DeepSeek' }],
          listModels: async (provider) => [{ provider, id: 'deepseek-flash', name: 'Flash' }],
        }
      }
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
  return { ctx, storage, sessions, agents, projectionState, routes, listeners, commandDefinitions, effects, attached, renames, fsFiles }
}

function runCommand(host, agent, rawInput) {
  const definition = host.commandDefinitions.find((candidate) => candidate.name === 'handoff-review')
  assert.ok(definition !== undefined)
  return definition.handler({ commandId: 'c1', agent, rawInput, attachments: [], signal: new AbortController().signal })
}

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

async function callRoute(host, path, { method = 'GET', query = '', body = null, headers = {} } = {}) {
  const route = host.routes.find((candidate) => candidate.path === path)
  assert.ok(route !== undefined, `route ${path} not registered`)
  const res = makeResponse()
  const req = { method, url: path + query, headers: { host: '127.0.0.1:52674', ...headers }, on: () => {} }
  if (body !== null) {
    const { Readable } = await import('node:stream')
    const stream = Readable.from([Buffer.from(JSON.stringify(body))])
    stream.headers = req.headers
    stream.method = method
    stream.url = req.url
    await route.handler(stream, res)
  } else {
    await route.handler(req, res)
  }
  return JSON.parse(res.body)
}

async function setupHost() {
  const host = createHost()
  const implSession = createSession('session-impl', '/tmp/ws', [
    { role: 'user', content: [{ type: 'text', text: '把 retry 加上 backoff' }] },
  ])
  const implAgent = createAgent(implSession, host.ctx)
  host.sessions.set('session-impl', implSession)
  host.agents.set('session-impl', implAgent)
  host.projectionState.set('session-impl|' + DIFF_PROJECTION_KEY, {
    entries: [
      { seq: 2, path: '/tmp/ws/new.js', oldText: null, newText: null, operation: 'create' },
      { seq: 3, path: 'src/retry.js', oldText: 'return n;', newText: 'return retry(n - 1, max);' },
    ],
    lastSeq: 3,
    verification: null,
  })
  await apply(host.ctx, {
    maxRounds: 3,
    maxHandoffChars: 30000,
    diffPerFileChars: 6000,
    autoSummarize: false,
    readOnlyReviewer: true,
    maxDeliveriesPerMinute: 6,
  })
  return { host, implSession, implAgent }
}

test('M2: --new creates a second link and linkId selects a participant link', async () => {
  const { host, implAgent } = await setupHost()
  const first = await runCommand(host, implAgent, ' first focus')
  assert.equal(first.kind, 'success')
  const second = await runCommand(host, implAgent, ' --new second focus')
  assert.equal(second.kind, 'success')
  assert.equal(host.storage.links.size, 2)

  const state = await callRoute(host, '/handoff-review/api/state', { query: '?sessionId=session-impl' })
  assert.equal(state.ok, true)
  assert.equal(state.links.length, 2)
  assert.equal(state.can.create, false)

  const ids = [...host.storage.links.keys()]
  const selected = await callRoute(host, '/handoff-review/api/state', {
    query: `?sessionId=session-impl&linkId=${encodeURIComponent(ids[0])}`,
  })
  assert.equal(selected.link.id, ids[0])

  const closed = await runCommand(host, implAgent, ' close')
  assert.equal(closed.kind, 'success')
  // Only the selected (newest) link closes.
  assert.equal(host.storage.links.get(ids[1]).status, 'closed')
  assert.notEqual(host.storage.links.get(ids[0]).status, 'closed')
})

test('M2: panel payload carries round history, reports, changed files and reviewer', async () => {
  const { host, implAgent } = await setupHost()
  const created = await runCommand(host, implAgent, '')
  assert.equal(created.kind, 'success')
  const link = [...host.storage.links.values()][0]
  const reviewSession = host.sessions.get(link.reviewSessionId)

  host.projectionState.set(`${link.reviewSessionId}|${REPLY_PROJECTION_KEY}`, {
    lastText: 'REVIEW-REPORT:\n請補測試。',
    lastSeq: 41,
    turn: 1,
  })
  await host.listeners.get('session/event')[0](reviewSession, {
    type: 'turn/end',
    seq: 42,
    data: { turn: 1, reason: { kind: 'completed' } },
  })
  // The listener is fire-and-forget; wait for its async promotion AND report write.
  const ready = () => {
    const linkId = [...host.storage.links.keys()][0]
    const link = host.storage.links.get(linkId)
    const round = link !== undefined ? host.storage.rounds.get(`${linkId}:1`) : undefined
    return link !== undefined && link.status === 'feedback_ready' && round !== undefined && round.report !== null
  }
  for (let index = 0; index < 200 && !ready(); index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1))
  }

  const panel = await callRoute(host, '/handoff-review/api/panel', { query: '?sessionId=session-impl' })
  assert.equal(panel.ok, true)
  assert.equal(panel.rounds.length, 1)
  assert.equal(panel.rounds[0].round, 1)
  assert.equal(panel.rounds[0].hasReport, true)
  assert.equal(panel.rounds[0].hasHandoff, true)
  assert.match(panel.handoff, /# Handoff for review \(round 1\)/)
  assert.match(panel.report, /請補測試/)
  assert.ok(panel.changedFiles.some((file) => file.path.endsWith('new.js')))
  assert.equal(panel.reviewer.provider, '')
  assert.equal(panel.reviewer.model, '')

  const diff = await callRoute(host, '/handoff-review/api/diff', { query: '?sessionId=session-impl' })
  assert.equal(diff.ok, true)
  assert.equal(diff.round, 1)
  assert.equal(diff.files.length, 2)
  assert.ok(diff.files.some((file) => file.path.endsWith('new.js') && /export const created = true/.test(file.diff)))

  host.projectionState.set('session-impl|' + DIFF_PROJECTION_KEY, {
    entries: [
      { seq: 3, path: 'src/retry.js', oldText: 'return n;', newText: 'return retry(n - 1, max);' },
      { seq: 9, path: 'src/backoff.js', oldText: null, newText: 'export const cap = 5;' },
    ],
    lastSeq: 9,
    verification: null,
  })
  const changed = await callRoute(host, '/handoff-review/api/diff', { query: '?sessionId=session-impl' })
  assert.equal(changed.files.length, 2)
  const backoff = changed.files.find((file) => file.path === 'src/backoff.js')
  assert.ok(backoff !== undefined)
  assert.match(backoff.diff, /export const cap = 5/)

  // Revision round 2 adds another history row.
  host.storage.links.get(link.id).status = 'feedback_sent'
  host.storage.links.get(link.id).updatedAt = Date.now()
  const revision = await runCommand(host, implAgent, ' revision')
  assert.equal(revision.kind, 'success')
  const panel2 = await callRoute(host, '/handoff-review/api/panel', { query: '?sessionId=session-impl' })
  assert.equal(panel2.rounds[0].round, 2)
  assert.equal(panel2.rounds.length, 2)
})

test('M2: settings config route validates, persists and merges over composition config', async () => {
  const { host } = await setupHost()
  const before = await callRoute(host, '/handoff-review/api/config')
  assert.equal(before.ok, true)
  assert.equal(before.config.maxRounds, 3)
  assert.deepEqual(before.defaults.maxRounds, 3)
  assert.equal(before.providers[0].id, 'deepseek-account')
  assert.equal(before.models[0].model, 'deepseek-flash')
  assert.equal(before.presets[0].id, 'default')

  const saved = await callRoute(host, '/handoff-review/api/config', {
    method: 'POST',
    body: {
      config: {
        reviewerProvider: 'deepseek-account',
        reviewerModel: 'deepseek-flash',
        reviewerReasoningEffort: 'high',
        maxRounds: 5,
        autoSummarize: true,
      },
    },
  })
  assert.equal(saved.ok, true)
  assert.equal(saved.config.maxRounds, 5)
  assert.equal(saved.config.autoSummarize, true)
  assert.equal(saved.config.reviewerReasoningEffort, 'high')
  assert.equal(host.storage.settings.size, 1)
  // R-2: only the fields that differ from the composition base are persisted.
  const stored = [...host.storage.settings.values()][0]
  assert.deepEqual(stored.config, {
    reviewerProvider: 'deepseek-account',
    reviewerModel: 'deepseek-flash',
    reviewerReasoningEffort: 'high',
    maxRounds: 5,
    autoSummarize: true,
  })

  const invalid = await callRoute(host, '/handoff-review/api/config', {
    method: 'POST',
    body: { config: { maxRounds: 0 } },
  })
  assert.equal(invalid.ok, false)
  assert.equal(invalid.code, 'BAD_BODY')

  // A fresh activation reads the persisted override (restart durability).
  const reloaded = createHost()
  reloaded.ctx.storageDomain = host.ctx.storageDomain
  await apply(reloaded.ctx, {})
  assert.equal(reloaded.ctx.commands !== undefined, true)
  const after = await callRoute(reloaded, '/handoff-review/api/config')
  assert.equal(after.config.maxRounds, 5)
  assert.equal(after.config.autoSummarize, true)
})

test('M2: review session title is fixed and updated per round', async () => {
  const { host, implAgent } = await setupHost()
  const created = await runCommand(host, implAgent, '')
  assert.equal(created.kind, 'success')
  assert.ok(host.renames.length >= 1)
  assert.match(host.renames[0].title, /^Review: impl title \(round 1\)$/)

  const link = [...host.storage.links.values()][0]
  host.storage.links.get(link.id).status = 'feedback_sent'
  host.projectionState.set('session-impl|' + DIFF_PROJECTION_KEY, {
    entries: [
      { seq: 3, path: 'src/retry.js', oldText: 'return n;', newText: 'return retry(n - 1, max);' },
      { seq: 12, path: 'src/backoff.js', oldText: null, newText: 'export const cap = 5;' },
    ],
    lastSeq: 12,
    verification: null,
  })
  const revision = await runCommand(host, implAgent, ' revision')
  assert.equal(revision.kind, 'success')
  assert.ok(host.renames.some((entry) => /\(round 2\)$/.test(entry.title)))
})

test('M2/MF-1: saving maxRounds in Settings refreshes the delivery loop breaker', async () => {
  const { host, implAgent } = await setupHost()
  const created = await runCommand(host, implAgent, '')
  assert.equal(created.kind, 'success')
  const link = [...host.storage.links.values()][0]
  // Put the link at the old limit and give it a new change to send.
  host.storage.links.get(link.id).round = 3
  host.storage.links.get(link.id).status = 'feedback_sent'
  host.storage.links.get(link.id).updatedAt = Date.now()
  host.projectionState.set('session-impl|' + DIFF_PROJECTION_KEY, {
    entries: [
      { seq: 3, path: 'src/retry.js', oldText: 'return n;', newText: 'return retry(n - 1, max);' },
      { seq: 20, path: 'src/backoff.js', oldText: null, newText: 'export const cap = 5;' },
    ],
    lastSeq: 20,
    verification: null,
  })
  const saved = await callRoute(host, '/handoff-review/api/config', {
    method: 'POST',
    body: { config: { maxRounds: 10 } },
  })
  assert.equal(saved.ok, true)
  assert.equal(saved.config.maxRounds, 10)
  const revision = await runCommand(host, implAgent, ' revision')
  assert.equal(revision.kind, 'success')
  assert.equal(host.storage.links.get(link.id).round, 4)
})

test('M2/MF-1: disabling readOnlyReviewer is honored for re-created review agents', async () => {
  const { host, implAgent } = await setupHost()
  const created = await runCommand(host, implAgent, '')
  assert.equal(created.kind, 'success')
  const link = [...host.storage.links.values()][0]
  const reviewAgent = host.agents.get(link.reviewSessionId)
  const reviewSession = host.sessions.get(link.reviewSessionId)
  const lockEvents = () => reviewSession.events.filter((event) => event.type === 'sandbox/mode').length
  const before = lockEvents()
  reviewSession.events.length = 0

  const disabled = await callRoute(host, '/handoff-review/api/config', {
    method: 'POST',
    body: { config: { readOnlyReviewer: false } },
  })
  assert.equal(disabled.ok, true)
  await host.listeners.get('agent/created')[0]({ agent: reviewAgent })
  assert.equal(lockEvents(), 0)

  const enabled = await callRoute(host, '/handoff-review/api/config', {
    method: 'POST',
    body: { config: { readOnlyReviewer: true } },
  })
  assert.equal(enabled.ok, true)
  await host.listeners.get('agent/created')[0]({ agent: reviewAgent })
  assert.equal(lockEvents(), 1)
  assert.ok(before > 0)
})

test('M2/R-1: composition config keeps M1 semantics (not clamped by Settings ranges)', async () => {
  const host = createHost()
  const implSession = createSession('session-impl', '/tmp/ws', [
    { role: 'user', content: [{ type: 'text', text: 'goal' }] },
  ])
  host.sessions.set('session-impl', implSession)
  host.agents.set('session-impl', createAgent(implSession, host.ctx))
  await apply(host.ctx, { maxRounds: 50, maxHandoffChars: 500, diffPerFileChars: 50 })
  const state = await callRoute(host, '/handoff-review/api/state', { query: '?sessionId=session-impl' })
  assert.equal(state.maxRounds, 50)
  const config = await callRoute(host, '/handoff-review/api/config')
  assert.equal(config.config.maxRounds, 50)
  assert.equal(config.config.maxHandoffChars, 500)
  assert.equal(config.config.diffPerFileChars, 50)

  // R-1b/R-2b: an unrelated Settings save (or a full-config save echoing the
  // out-of-range base) must neither clamp nor persist the composition values.
  const saved = await callRoute(host, '/handoff-review/api/config', {
    method: 'POST',
    body: { config: { autoSummarize: true, maxRounds: 50, maxHandoffChars: 500, diffPerFileChars: 50 } },
  })
  assert.equal(saved.ok, true)
  assert.equal(saved.config.maxRounds, 50)
  assert.equal(saved.config.maxHandoffChars, 500)
  assert.equal(saved.config.diffPerFileChars, 50)
  const stored = [...host.storage.settings.values()][0]
  assert.deepEqual(stored.config, { autoSummarize: true })

  const reloaded = createHost()
  reloaded.ctx.storageDomain = host.ctx.storageDomain
  await apply(reloaded.ctx, { maxRounds: 50, maxHandoffChars: 500, diffPerFileChars: 50 })
  const afterRestart = await callRoute(reloaded, '/handoff-review/api/config')
  assert.equal(afterRestart.config.maxRounds, 50)
  assert.equal(afterRestart.config.maxHandoffChars, 500)
  assert.equal(afterRestart.config.diffPerFileChars, 50)
  assert.equal(afterRestart.config.autoSummarize, true)
})

test('review finding 8: concurrent creates for one impl session are serialized', async () => {
  const { host, implAgent } = await setupHost()
  const results = await Promise.all([
    runCommand(host, implAgent, ' first'),
    runCommand(host, implAgent, ' second'),
  ])
  assert.equal(results.filter((result) => result.kind === 'success').length, 1)
  const failed = results.find((result) => result.kind === 'error')
  assert.ok(failed !== undefined)
  assert.match(failed.text, /正在建立|active link/)
  assert.equal(host.storage.links.size, 1)
})

test('review finding 7: a review session cannot start a review-of-review chain', async () => {
  const { host, implAgent } = await setupHost()
  const created = await runCommand(host, implAgent, '')
  assert.equal(created.kind, 'success')
  const link = [...host.storage.links.values()][0]
  const reviewAgent = host.agents.get(link.reviewSessionId)
  assert.ok(reviewAgent !== undefined)
  const result = await runCommand(host, reviewAgent, ' review the reviewer')
  assert.equal(result.kind, 'error')
  assert.match(result.text, /review session/)
  assert.equal(host.storage.links.size, 1)
})

/** Poll until `predicate` is true (auto-continue steps run asynchronously). */
async function waitFor(predicate, label) {
  for (let index = 0; index < 500; index += 1) {
    if (await predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 2))
  }
  throw new Error(`timed out waiting for ${label}`)
}

test('autoContinue automatically sends feedback and the next revision', async () => {
  const { host, implAgent } = await setupHost()
  const saved = await callRoute(host, '/handoff-review/api/config', {
    method: 'POST',
    body: { config: { autoContinue: true } },
  })
  assert.equal(saved.ok, true)
  const created = await runCommand(host, implAgent, '')
  assert.equal(created.kind, 'success')
  const link = [...host.storage.links.values()][0]
  const reviewAgent = host.agents.get(link.reviewSessionId)
  const reviewSession = host.sessions.get(link.reviewSessionId)

  // Reviewer finishes; no manual "send feedback" call happens in this test.
  host.projectionState.set(`${link.reviewSessionId}|${REPLY_PROJECTION_KEY}`, {
    lastText: 'REVIEW-REPORT: 請補上 autoContinue 測試。',
    lastSeq: 50,
    turn: 1,
  })
  await host.listeners.get('session/event')[0](reviewSession, {
    type: 'turn/end',
    seq: 51,
    data: { turn: 1, reason: { kind: 'completed' } },
  })
  await waitFor(() => host.storage.links.get(link.id).status === 'feedback_sent', 'auto feedback')
  assert.ok(
    implAgent.received.some((message) => message.content[0].text.includes('Review round 1 from session')),
    'impl session should receive the reviewer report automatically',
  )

  // Implementation turn ends after adding a change; auto revision goes back.
  host.projectionState.set('session-impl|' + DIFF_PROJECTION_KEY, {
    entries: [
      { seq: 3, path: 'src/retry.js', oldText: 'return n;', newText: 'return retry(n - 1, max);' },
      { seq: 60, path: 'src/auto.js', oldText: null, newText: 'export const auto = true;' },
    ],
    lastSeq: 60,
    verification: null,
  })
  await host.listeners.get('session/event')[0](host.sessions.get('session-impl'), {
    type: 'turn/end',
    seq: 61,
    data: { turn: 2, reason: { kind: 'completed' } },
  })
  await waitFor(() => {
    const current = host.storage.links.get(link.id)
    return current.status === 'reviewing' && current.round === 2
  }, 'auto revision')
  assert.ok(
    reviewAgent.received.some((message) => message.content[0].text.includes('Revision for round 2')),
    'review session should receive the revision automatically',
  )

  // Round 2 reviewer report automatically returns to the impl session...
  host.projectionState.set(`${link.reviewSessionId}|${REPLY_PROJECTION_KEY}`, {
    lastText: 'REVIEW-REPORT round 2: 看起來正確。',
    lastSeq: 100,
    turn: 2,
  })
  await host.listeners.get('session/event')[0](reviewSession, {
    type: 'turn/end',
    seq: 101,
    data: { turn: 2, reason: { kind: 'completed' } },
  })
  await waitFor(() => {
    const current = host.storage.links.get(link.id)
    return current.status === 'feedback_sent' && current.round === 2
  }, 'second auto feedback')
  assert.ok(
    implAgent.received.some((message) => message.content[0].text.includes('Review round 2 from session')),
    'round 2 feedback should be delivered automatically',
  )

  // ...and the next implementation change automatically becomes round 3.
  host.projectionState.set('session-impl|' + DIFF_PROJECTION_KEY, {
    entries: [
      { seq: 3, path: 'src/retry.js', oldText: 'return n;', newText: 'return retry(n - 1, max);' },
      { seq: 120, path: 'src/auto2.js', oldText: null, newText: 'export const auto2 = true;' },
    ],
    lastSeq: 120,
    verification: null,
  })
  await host.listeners.get('session/event')[0](host.sessions.get('session-impl'), {
    type: 'turn/end',
    seq: 121,
    data: { turn: 3, reason: { kind: 'completed' } },
  })
  await waitFor(() => {
    const current = host.storage.links.get(link.id)
    return current.status === 'reviewing' && current.round === 3
  }, 'round 3 auto revision')
  assert.ok(
    reviewAgent.received.some((message) => message.content[0].text.includes('Revision for round 3')),
    'round 3 revision should be delivered automatically',
  )
})

test('autoContinue off keeps the manual feedback gate', async () => {
  const { host, implAgent } = await setupHost()
  const created = await runCommand(host, implAgent, '')
  assert.equal(created.kind, 'success')
  const link = [...host.storage.links.values()][0]
  const reviewSession = host.sessions.get(link.reviewSessionId)
  host.projectionState.set(`${link.reviewSessionId}|${REPLY_PROJECTION_KEY}`, {
    lastText: 'REVIEW-REPORT: manual only.',
    lastSeq: 70,
    turn: 1,
  })
  await host.listeners.get('session/event')[0](reviewSession, {
    type: 'turn/end',
    seq: 71,
    data: { turn: 1, reason: { kind: 'completed' } },
  })
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(host.storage.links.get(link.id).status, 'feedback_ready')
  assert.equal(implAgent.received.length, 0)
})

test('autoContinue stops at maxRounds and injects a notice instead of forcing', async () => {
  const { host, implAgent } = await setupHost()
  const saved = await callRoute(host, '/handoff-review/api/config', {
    method: 'POST',
    body: { config: { autoContinue: true, maxRounds: 1 } },
  })
  assert.equal(saved.ok, true)
  const created = await runCommand(host, implAgent, '')
  assert.equal(created.kind, 'success')
  const link = [...host.storage.links.values()][0]
  const reviewSession = host.sessions.get(link.reviewSessionId)
  host.projectionState.set(`${link.reviewSessionId}|${REPLY_PROJECTION_KEY}`, {
    lastText: 'REVIEW-REPORT: final report.',
    lastSeq: 80,
    turn: 1,
  })
  await host.listeners.get('session/event')[0](reviewSession, {
    type: 'turn/end',
    seq: 81,
    data: { turn: 1, reason: { kind: 'completed' } },
  })
  await waitFor(() => host.storage.links.get(link.id).status === 'feedback_sent', 'auto feedback at maxRounds')

  host.projectionState.set('session-impl|' + DIFF_PROJECTION_KEY, {
    entries: [
      { seq: 3, path: 'src/retry.js', oldText: 'return n;', newText: 'return retry(n - 1, max);' },
      { seq: 90, path: 'src/limit.js', oldText: null, newText: 'export const limited = true;' },
    ],
    lastSeq: 90,
    verification: null,
  })
  await host.listeners.get('session/event')[0](host.sessions.get('session-impl'), {
    type: 'turn/end',
    seq: 91,
    data: { turn: 2, reason: { kind: 'completed' } },
  })
  await waitFor(
    () => implAgent.received.some((message) => message.content[0].text.includes('已達 maxRounds')),
    'maxRounds notice',
  )
  assert.equal(host.storage.links.get(link.id).status, 'feedback_sent')
  assert.equal(host.storage.links.get(link.id).round, 1)
})

test('autoContinue announces NO_CHANGES only once per watermark', async () => {
  const { host, implAgent } = await setupHost()
  const saved = await callRoute(host, '/handoff-review/api/config', {
    method: 'POST',
    body: { config: { autoContinue: true } },
  })
  assert.equal(saved.ok, true)
  const created = await runCommand(host, implAgent, '')
  assert.equal(created.kind, 'success')
  const link = [...host.storage.links.values()][0]
  const reviewSession = host.sessions.get(link.reviewSessionId)
  host.projectionState.set(`${link.reviewSessionId}|${REPLY_PROJECTION_KEY}`, {
    lastText: 'REVIEW-REPORT: no changes expected.',
    lastSeq: 110,
    turn: 1,
  })
  await host.listeners.get('session/event')[0](reviewSession, {
    type: 'turn/end',
    seq: 111,
    data: { turn: 1, reason: { kind: 'completed' } },
  })
  await waitFor(() => host.storage.links.get(link.id).status === 'feedback_sent', 'auto feedback')

  const noticeCount = () => implAgent.received
    .filter((message) => message.content[0].text.includes('沒有新的變更'))
    .length
  // Two unrelated implementation turns without new diffs: only one notice.
  await host.listeners.get('session/event')[0](host.sessions.get('session-impl'), {
    type: 'turn/end',
    seq: 112,
    data: { turn: 2, reason: { kind: 'completed' } },
  })
  await waitFor(() => noticeCount() === 1, 'first NO_CHANGES notice')
  await host.listeners.get('session/event')[0](host.sessions.get('session-impl'), {
    type: 'turn/end',
    seq: 113,
    data: { turn: 3, reason: { kind: 'completed' } },
  })
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(noticeCount(), 1)
  assert.equal(host.storage.links.get(link.id).status, 'feedback_sent')
})
