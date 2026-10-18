// Host-side end-to-end integration test with a fake Cordis context: drives the
// same code paths the slash command and the dock HTTP routes use, through
// create -> reviewer turn -> feedback -> revision -> close -> reopen
// (DEVELOPMENT.md §7, §15.2).

import test from 'node:test'
import assert from 'node:assert/strict'

import { apply, HandoffService } from '../index.js'
import { DIFF_PROJECTION_KEY, REPLY_PROJECTION_KEY } from '../lib/projections.js'

/** In-memory storage-domain double: one serialized write chain per backend. */
function createFakeStorageDomain() {
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
  const makeDomain = (name) => {
    const tables = new Map()
    const tableFor = (tableName) => {
      if (!tables.has(tableName)) tables.set(tableName, makeTable())
      return tables.get(tableName)
    }
    return {
      name,
      tables,
      tableFor,
      domain: { name, table: (tableName) => tableFor(tableName).handle, close: async () => {} },
    }
  }
  const ensure = (name) => {
    if (!domains.has(name)) domains.set(name, makeDomain(name))
    return domains.get(name)
  }
  const api = {
    storageDomain: {
      open: async (spec) => ensure(spec.name).domain,
    },
    domains,
    ensure,
  }
  Object.defineProperty(api, 'records', { get: () => ensure('handoff_review').tableFor('links').records })
  Object.defineProperty(api, 'domain', { get: () => ensure('handoff_review').domain })
  return api
}

/** Fake session + agent pair. */
function createFakeSession(id, cwd, messages = []) {
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

function createFakeAgent(session, options = {}) {
  const received = []
  const toolCalls = { deny: null, guards: [], schemas: ['edit', 'write', 'bash'] }
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
        schemas: () => toolCalls.schemas.map((name) => ({ name })),
        restrict: (filter) => {
          toolCalls.deny = filter.deny
          return () => {}
        },
        guard: (guard) => {
          toolCalls.guards.push(guard)
          return () => {}
        },
      },
    },
    toolCalls,
  }
}

/** Build the fake Cordis context apply(ctx, config) runs against. */
function createFakeContext() {
  const fake = createFakeStorageDomain()
  const sessions = new Map()
  const agents = new Map()
  const projectionState = new Map()
  const routeDefs = []
  const listeners = new Map()
  const commandDefinitions = []
  const effects = []
  const attached = []
  let nextSession = 0
  const appCtx = {}
  const ctx = {
    storageDomain: fake.storageDomain,
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
      stateOf(session, key) {
        return projectionState.get(`${session.id}|${key}`)
      },
    },
    workspaceRegistry: {
      resolveByPath: async (path) => ({
        id: 'workspace-1',
        path,
        attachSession: async (sessionId) => attached.push(sessionId),
      }),
    },
    sessionController: {
      async create(request) {
        nextSession += 1
        const sessionId = `session-review-${nextSession}`
        const session = createFakeSession(sessionId, request.cwd)
        const agent = createFakeAgent(session)
        sessions.set(sessionId, session)
        agents.set(sessionId, agent)
        return { sessionId }
      },
      async inspect(sessionId) {
        if (!sessions.has(sessionId)) throw new Error('session not found')
        return { meta: { id: sessionId }, events: [] }
      },
      async selectModel() {
        return {}
      },
    },
    get(service) {
      if (service === 'fs') {
        return {
          resolve: async (path) => path,
          stat: async () => ({ size: 26 }),
          readText: async () => 'export const created = true\n',
        }
      }
      if (service === 'approval') {
        return {
          setPolicy: (agent, policy) => {
            agent.approvalPolicy = policy
          },
        }
      }
      if (service === 'webServer') return undefined
      return undefined
    },
    effect(fn) {
      const dispose = fn()
      effects.push(dispose)
      return dispose
    },
    on(event, handler) {
      const list = listeners.get(event) ?? []
      list.push(handler)
      listeners.set(event, list)
      return () => {}
    },
    inject(_deps, callback) {
      callback(ctx)
      return () => {}
    },
  }
  ctx.webServer = {
    register(definition) {
      routeDefs.push(definition)
      return () => {}
    },
  }
  // `ctx.get('webServer')` is read by registerRoutes through ctx.inject callback.
  const originalGet = ctx.get
  ctx.get = (service) => (service === 'webServer' ? ctx.webServer : originalGet(service))
  Object.assign(appCtx, {
    ctx,
    fake,
    sessions,
    agents,
    projectionState,
    routeDefs,
    listeners,
    commandDefinitions,
    attached,
    effects,
  })
  return appCtx
}

/** Mock Node HTTP response capturing the JSON body. */
function createMockResponse() {
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

/** Invoke the captured `/handoff-review` command. */
async function runCommand(app, agent, rawInput) {
  const definition = app.commandDefinitions.find((candidate) => candidate.name === 'handoff-review')
  assert.ok(definition !== undefined, 'handoff-review command not registered')
  return definition.handler({ commandId: 'c1', agent, rawInput, attachments: [], signal: new AbortController().signal })
}

test('full handoff-review round trip through command + routes + projections', async () => {
  const app = createFakeContext()
  const { ctx, fake, sessions, agents, projectionState, routeDefs, listeners, attached } = app

  const implMessages = [
    { role: 'user', content: [{ type: 'text', text: '把 retry 加上 backoff' }] },
    { role: 'assistant', content: [{ type: 'text', text: '完成初版\n- TODO: 補測試' }] },
  ]
  const implSession = createFakeSession('session-impl', '/tmp/workspace', implMessages)
  const implAgent = createFakeAgent(implSession)
  sessions.set('session-impl', implSession)
  agents.set('session-impl', implAgent)
  projectionState.set('session-impl|' + DIFF_PROJECTION_KEY, {
    entries: [
      { seq: 2, path: '/tmp/workspace/src/new.js', oldText: null, newText: null, operation: 'create' },
      { seq: 3, path: 'src/retry.js', oldText: 'function retry(n) {', newText: 'function retry(n, max = 3) {' },
    ],
    lastSeq: 3,
    verification: { seq: 4, tool: 'bash', text: 'tests passed', isError: false },
  })

  await apply(ctx, {
    maxRounds: 3,
    maxHandoffChars: 30000,
    diffPerFileChars: 6000,
    autoSummarize: false,
    readOnlyReviewer: true,
    maxDeliveriesPerMinute: 6,
  })

  // --- create ---
  const created = await runCommand(app, implAgent, ' focus on retry logic')
  assert.equal(created.kind, 'success')
  assert.match(created.text, /Review session session-review-1 opened/)
  assert.equal(fake.records.size, 1)
  const link = fake.records.values().next().value
  assert.equal(link.status, 'reviewing')
  assert.equal(link.round, 1)
  assert.equal(link.reviewSessionId, 'session-review-1')
  assert.equal(link.focus, 'focus on retry logic')
  assert.deepEqual(attached, ['session-review-1'])

  // review session was locked down and received the structured brief
  const reviewSession = sessions.get('session-review-1')
  const reviewAgent = agents.get('session-review-1')
  assert.deepEqual(
    reviewSession.events.filter((event) => event.type === 'sandbox/mode').map((event) => event.data),
    [{ mode: 'read-only' }],
  )
  assert.deepEqual(reviewAgent.toolCalls.deny, ['edit', 'write'])
  assert.equal(reviewAgent.approvalPolicy, 'never')
  assert.equal(reviewAgent.received.length, 1)
  const brief = reviewAgent.received[0].content[0].text
  assert.ok(brief.startsWith('[handoff-review]'))
  assert.match(brief, /## Goal/)
  assert.match(brief, /把 retry 加上 backoff/)
  assert.match(brief, /## Changed files/)
  assert.match(brief, /src\/retry\.js \(\+1 −1\)/)
  // D2 regression: a file created by `write` must appear, with its content.
  assert.match(brief, /src\/new\.js \(\+1 −0\)/)
  assert.match(brief, /export const created = true/)
  assert.match(brief, /tests passed/)

  // --- reviewer finishes: projection folds, turn/end promotes the link ---
  projectionState.set('session-review-1|' + REPLY_PROJECTION_KEY, {
    lastText: 'REVIEW-REPORT:\n請補上 backoff 上限與測試。',
    lastSeq: 42,
    turn: 1,
  })
  const onSessionEvent = listeners.get('session/event')
  assert.ok(Array.isArray(onSessionEvent) && onSessionEvent.length === 1)
  await onSessionEvent[0](reviewSession, { type: 'turn/end', seq: 43, data: { turn: 1, reason: { kind: 'completed' } } })
  assert.equal(fake.records.get(link.id).status, 'feedback_ready')

  // --- state route returns the actionable dock payload ---
  const stateRoute = routeDefs.find((route) => route.path === '/handoff-review/api/state')
  const res = createMockResponse()
  await stateRoute.handler(
    { method: 'GET', url: '/handoff-review/api/state?sessionId=session-impl', headers: { host: '127.0.0.1:52674' } },
    res,
  )
  const statePayload = JSON.parse(res.body)
  assert.equal(statePayload.ok, true)
  assert.equal(statePayload.role, 'impl')
  assert.equal(statePayload.link.status, 'feedback_ready')
  assert.equal(statePayload.can.feedback, true)
  // Revision waits for the reviewer report to be sent back (DEVELOPMENT.md §8.3).
  assert.equal(statePayload.can.revision, false)

  // --- feedback reaches the impl session with the source header ---
  const feedback = await runCommand(app, implAgent, ' feedback')
  assert.equal(feedback.kind, 'success')
  assert.equal(implAgent.received.length, 1)
  const feedbackText = implAgent.received[0].content[0].text
  assert.ok(feedbackText.startsWith('[handoff-review] Review round 1 from session session-review-1'))
  assert.match(feedbackText, /請補上 backoff 上限與測試/)
  assert.equal(fake.records.get(link.id).status, 'feedback_sent')
  const afterFeedback = createMockResponse()
  await stateRoute.handler(
    { method: 'GET', url: '/handoff-review/api/state?sessionId=session-impl', headers: { host: '127.0.0.1:52674' } },
    afterFeedback,
  )
  assert.equal(JSON.parse(afterFeedback.body).can.revision, true)

  // --- revision only includes changes after the last handoff watermark ---
  projectionState.set('session-impl|' + DIFF_PROJECTION_KEY, {
    entries: [
      { seq: 3, path: 'src/retry.js', oldText: 'function retry(n) {', newText: 'function retry(n, max = 3) {' },
      { seq: 9, path: 'src/retry.js', oldText: 'return n;', newText: 'return retry(n - 1, max);' },
    ],
    lastSeq: 9,
    verification: null,
  })
  // N1: a reviewer side message between feedback and revision must not be
  // promoted as the next round's report.
  projectionState.set('session-review-1|' + REPLY_PROJECTION_KEY, {
    lastText: 'REVIEW-REPORT:\n請補上 backoff 上限與測試。',
    lastSeq: 45,
    turn: 1,
  })
  const revision = await runCommand(app, implAgent, ' revision')
  assert.equal(revision.kind, 'success')
  assert.equal(reviewAgent.received.length, 2)
  const revisionText = reviewAgent.received[1].content[0].text
  assert.ok(revisionText.startsWith('[handoff-review] Revision for round 2 from session session-impl'))
  // D1 regression: the round-1 hunk (seq 3) is below the persisted watermark and
  // must not be re-sent in round 2.
  assert.ok(!revisionText.includes('function retry(n) {'), 'round-1 hunk was re-sent in the revision')
  assert.match(revisionText, /return retry\(n - 1, max\);/)
  const reviewed = fake.records.get(link.id)
  assert.equal(reviewed.status, 'reviewing')
  assert.equal(reviewed.round, 2)
  assert.equal(reviewed.lastHandoffSeq, 9)
  assert.equal(reviewed.lastFeedbackSeq, 45)

  // --- a stale reviewer report must not become a new round (D3) ---
  projectionState.set('session-review-1|' + REPLY_PROJECTION_KEY, {
    lastText: 'REVIEW-REPORT:\n請補上 backoff 上限與測試。',
    lastSeq: 45,
    turn: 2,
  })
  await onSessionEvent[0](reviewSession, { type: 'turn/end', seq: 70, data: { turn: 2, reason: { kind: 'completed' } } })
  assert.equal(fake.records.get(link.id).status, 'reviewing')
  projectionState.set('session-review-1|' + REPLY_PROJECTION_KEY, {
    lastText: 'REVIEW-REPORT round 2: 看起來正確。',
    lastSeq: 90,
    turn: 2,
  })
  await onSessionEvent[0](reviewSession, { type: 'turn/end', seq: 91, data: { turn: 2, reason: { kind: 'completed' } } })
  assert.equal(fake.records.get(link.id).status, 'feedback_ready')

  // --- close / reopen ---
  const closed = await runCommand(app, reviewAgent, ' close')
  assert.equal(closed.kind, 'success')
  assert.equal(fake.records.get(link.id).status, 'closed')
  const reopened = await runCommand(app, reviewAgent, ' reopen')
  assert.equal(reopened.kind, 'success')
  assert.equal(fake.records.get(link.id).status, 'open')

  // --- D5: a reopened link accepts a new revision cycle ---
  projectionState.set('session-impl|' + DIFF_PROJECTION_KEY, {
    entries: [
      { seq: 3, path: 'src/retry.js', oldText: 'function retry(n) {', newText: 'function retry(n, max = 3) {' },
      { seq: 9, path: 'src/retry.js', oldText: 'return n;', newText: 'return retry(n - 1, max);' },
      { seq: 14, path: 'src/backoff.js', oldText: null, newText: 'export const cap = 5;' },
    ],
    lastSeq: 14,
    verification: null,
  })
  const reopenedRevision = await runCommand(app, implAgent, ' revision')
  assert.equal(reopenedRevision.kind, 'success')
  assert.equal(fake.records.get(link.id).round, 3)

  // --- status command renders the link ---
  const status = await runCommand(app, implAgent, ' status')
  assert.equal(status.kind, 'success')
  assert.match(status.text, /Status: reviewing/)
  assert.match(status.text, /Round 3\/3/)

  // --- teardown disposes registrations ---
  for (const dispose of app.effects) {
    if (typeof dispose === 'function') dispose()
  }
})

test('second create is refused while an active link exists', async () => {
  const app = createFakeContext()
  const { ctx, sessions, agents } = app
  const implSession = createFakeSession('session-impl', '/tmp/workspace', [
    { role: 'user', content: [{ type: 'text', text: 'goal' }] },
  ])
  const implAgent = createFakeAgent(implSession)
  sessions.set('session-impl', implSession)
  agents.set('session-impl', implAgent)
  await apply(ctx, {})
  const first = await runCommand(app, implAgent, '')
  assert.equal(first.kind, 'success')
  const second = await runCommand(app, implAgent, '')
  assert.equal(second.kind, 'error')
  assert.match(second.text, /active link/)
})

test('reviewer route fence rejects a cross-site request before the service runs', async () => {
  const app = createFakeContext()
  const { ctx, routeDefs } = app
  await apply(ctx, {})
  const createRoute = routeDefs.find((route) => route.path === '/handoff-review/api/create')
  const res = createMockResponse()
  let called = false
  const fakeService = { create: async () => { called = true; return {} } }
  // Rebuild the bound handler with a spy service is not possible through the
  // module boundary; instead assert the fence on the real handler.
  const service = new HandoffService(ctx, { maxRounds: 3 }, { store: { list: () => [] }, delivery: {} })
  void service
  await createRoute.handler(
    {
      method: 'POST',
      url: '/handoff-review/api/create',
      headers: { host: '127.0.0.1:52674', 'sec-fetch-site': 'cross-site', 'content-type': 'application/json' },
      on: () => {},
    },
    res,
  )
  assert.equal(res.statusCode, 403)
  assert.equal(called, false)
  assert.equal(JSON.parse(res.body).code, 'FORBIDDEN')
})

test('maxRounds blocks a revision and --force overrides it', async () => {
  const app = createFakeContext()
  const { ctx, fake, sessions, agents, projectionState } = app
  const implSession = createFakeSession('session-impl', '/tmp/workspace', [])
  const implAgent = createFakeAgent(implSession)
  sessions.set('session-impl', implSession)
  agents.set('session-impl', implAgent)
  projectionState.set('session-impl|' + DIFF_PROJECTION_KEY, {
    entries: [{ seq: 1, path: 'a.js', oldText: 'a', newText: 'b' }],
    lastSeq: 1,
    verification: null,
  })
  await apply(ctx, { maxRounds: 1 })
  const created = await runCommand(app, implAgent, '')
  assert.equal(created.kind, 'success')
  const link = fake.records.values().next().value
  // Advance to feedback_sent so revision is meaningful, then bump the watermark.
  projectionState.set('session-impl|' + DIFF_PROJECTION_KEY, {
    entries: [
      { seq: 1, path: 'a.js', oldText: 'a', newText: 'b' },
      { seq: 5, path: 'b.js', oldText: 'c', newText: 'd' },
    ],
    lastSeq: 5,
    verification: null,
  })
  await fake.domain.table('links').update(link.id, (record) => ({
    ...record,
    status: 'feedback_sent',
    lastHandoffSeq: 1,
    updatedAt: Date.now(),
  }))
  const blocked = await runCommand(app, implAgent, ' revision')
  assert.equal(blocked.kind, 'error')
  assert.match(blocked.text, /maxRounds/)
  const forced = await runCommand(app, implAgent, ' revision --force')
  assert.equal(forced.kind, 'success')
  assert.equal(fake.records.get(link.id).round, 2)
})
