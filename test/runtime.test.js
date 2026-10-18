// Unit tests for delivery/loop protection, command grammar, route fencing,
// reviewer lockdown, config normalization, and locale parity
// (DEVELOPMENT.md §9.7, §9.8, §10.2, §15.1).

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { Readable } from 'node:stream'

import { buildUserMessage, createDelivery, createLoopBreaker, DeliveryError, DELIVERY_SOURCE } from '../lib/delivery.js'
import { COMMAND_NAME, handleInvocation, parseCommandInput } from '../lib/commands.js'
import {
  HandoffError,
  createRouteDefinitions,
  errorResponse,
  fallbackRejection,
  isLoopbackAuthority,
  readBody,
} from '../lib/routes.js'
import {
  applyReviewerPolicy,
  hydrateCreatedEntries,
  listArchivedSessionIds,
  selectReviewerModel,
  WRITE_TOOL_NAMES,
} from '../lib/session-factory.js'
import { HandoffService, formatStatusText, locateLink, normalizeConfig, publicLink, reconcileLinks } from '../index.js'

test('buildUserMessage creates the complete UserMessage the runtime requires', () => {
  const message = buildUserMessage('hello')
  assert.equal(message.role, 'user')
  assert.match(message.id, /[0-9a-f-]{36}/)
  assert.deepEqual(message.content, [{ type: 'text', text: 'hello' }])
  assert.deepEqual(message.source, { kind: DELIVERY_SOURCE })
})

test('loop breaker enforces maxRounds, duplicate dedupe, and per-minute rate limit', () => {
  let clock = 0
  const breaker = createLoopBreaker({ maxRounds: 2, maxDeliveriesPerMinute: 3, now: () => clock })
  assert.throws(() => breaker.guard({ linkId: 'l1', round: 3, kind: 'revision', content: 'x' }), (error) => error.code === 'MAX_ROUNDS')
  breaker.guard({ linkId: 'l1', round: 1, kind: 'feedback', content: 'one' })
  assert.throws(
    () => breaker.guard({ linkId: 'l1', round: 1, kind: 'feedback', content: 'one' }),
    (error) => error.code === 'DUPLICATE',
  )
  breaker.guard({ linkId: 'l1', round: 1, kind: 'feedback', content: 'two' })
  breaker.guard({ linkId: 'l1', round: 1, kind: 'feedback', content: 'three' })
  assert.throws(
    () => breaker.guard({ linkId: 'l1', round: 1, kind: 'feedback', content: 'four' }),
    (error) => error.code === 'RATE_LIMIT',
  )
  clock += 61_000
  breaker.guard({ linkId: 'l1', round: 2, kind: 'feedback', content: 'five' })
  breaker.reset('l1')
  breaker.guard({ linkId: 'l1', round: 1, kind: 'feedback', content: 'one' })
})

test('loop breaker reports duplicates per link (review finding 6)', () => {
  const breaker = createLoopBreaker({ maxRounds: 5, maxDeliveriesPerMinute: 10, now: () => 0 })
  breaker.guard({ linkId: 'a', round: 1, kind: 'feedback', content: 'x' })
  breaker.guard({ linkId: 'b', round: 1, kind: 'feedback', content: 'y' })
  assert.equal(breaker.stats('a').duplicates, 1)
  assert.equal(breaker.stats('b').duplicates, 1)
  assert.equal(breaker.stats('missing').duplicates, 0)
})

test('createDelivery guards then delivers one follow-up message', () => {
  const delivered = []
  const agent = { followup: (message) => delivered.push(message), inject: () => {} }
  const delivery = createDelivery({ maxRounds: 3, maxDeliveriesPerMinute: 6 })
  delivery.deliver(agent, 'report', { linkId: 'l1', round: 1, kind: 'feedback' })
  assert.equal(delivered.length, 1)
  assert.equal(delivered[0].content[0].text, 'report')
  assert.throws(
    () => delivery.deliver(agent, 'report', { linkId: 'l1', round: 1, kind: 'feedback' }),
    (error) => error.code === 'DUPLICATE',
  )
  assert.throws(
    () => delivery.deliver(undefined, 'report', { linkId: 'l1', round: 2, kind: 'revision' }),
    (error) => error.code === 'NO_AGENT',
  )
})

test('command grammar parses every documented form', () => {
  assert.equal(COMMAND_NAME, 'handoff-review')
  const base = { force: false, newLink: false }
  assert.deepEqual(parseCommandInput(''), { action: 'create', focus: null, ...base })
  assert.deepEqual(parseCommandInput('  status '), { action: 'status', focus: null, ...base })
  assert.deepEqual(parseCommandInput('focus on retry logic'), { action: 'create', focus: 'focus on retry logic', ...base })
  assert.deepEqual(parseCommandInput(' revision --force'), { action: 'revision', focus: null, ...base, force: true })
  assert.deepEqual(parseCommandInput('feedback'), { action: 'feedback', focus: null, ...base })
  assert.deepEqual(parseCommandInput('close'), { action: 'close', focus: null, ...base })
  assert.deepEqual(parseCommandInput('reopen'), { action: 'reopen', focus: null, ...base })
  // M2 / D8: --new creates a second link for the same impl session.
  assert.deepEqual(parseCommandInput('--new focus on retry logic'), { action: 'create', focus: 'focus on retry logic', force: false, newLink: true })
  assert.deepEqual(parseCommandInput('focus --new'), { action: 'create', focus: 'focus', force: false, newLink: true })
  // `--` escapes a literal focus that starts with a reserved sub-command name.
  assert.deepEqual(parseCommandInput('-- status bar refactor'), { action: 'create', focus: 'status bar refactor', force: false, newLink: false })
  assert.deepEqual(parseCommandInput('--'), { action: 'create', focus: null, force: false, newLink: false })
})

test('handleInvocation maps service outcomes to command receipts', async () => {
  const service = {
    create: async () => ({ message: 'opened' }),
    status: async () => ({ text: 'status text' }),
    feedback: async () => ({ message: 'feedback sent' }),
    revision: async () => {
      throw new HandoffError('NO_CHANGES', '沒有新變更')
    },
    close: async () => ({ message: 'closed' }),
    reopen: async () => ({ message: 'reopened' }),
  }
  const agent = { session: { id: 'session-1' } }
  assert.deepEqual(await handleInvocation(service, { agent, rawInput: '' }), { kind: 'success', text: 'opened' })
  assert.deepEqual(await handleInvocation(service, { agent, rawInput: 'status' }), { kind: 'success', text: 'status text' })
  assert.deepEqual(await handleInvocation(service, { agent, rawInput: 'revision' }), { kind: 'error', text: '沒有新變更' })
  const extra = await handleInvocation(service, { agent, rawInput: 'close now' })
  assert.equal(extra.kind, 'error')
  assert.match(extra.text, /不接受額外參數/)
  assert.deepEqual(await handleInvocation(service, { agent, rawInput: 'revision --force' }), { kind: 'error', text: '沒有新變更' })
})

test('trust fence rejects non-loopback hosts, cross-site fetches, and bad origins', () => {
  assert.equal(isLoopbackAuthority('127.0.0.1:5000'), true)
  assert.equal(isLoopbackAuthority('localhost:5000'), true)
  assert.equal(isLoopbackAuthority('[::1]:5000'), true)
  assert.equal(isLoopbackAuthority('evil.example:5000'), false)
  assert.equal(fallbackRejection({ headers: { host: '127.0.0.1:5000' } }), undefined)
  assert.equal(fallbackRejection({ headers: { host: 'evil.example:5000' } }), 403)
  assert.equal(fallbackRejection({ headers: { host: '127.0.0.1:5000', 'sec-fetch-site': 'cross-site' } }), 403)
  assert.equal(fallbackRejection({ headers: { host: '127.0.0.1:5000', origin: 'https://evil.example' } }), 403)
  assert.equal(fallbackRejection({ headers: { host: '127.0.0.1:5000', origin: 'http://127.0.0.1:5000' } }), undefined)
  // Default ports are normalized (review finding 2).
  assert.equal(fallbackRejection({ headers: { host: 'localhost:80', origin: 'http://localhost' } }), undefined)
  assert.equal(fallbackRejection({ headers: { host: 'localhost', origin: 'http://localhost' } }), undefined)
  assert.equal(fallbackRejection({ headers: { host: 'localhost:443', origin: 'https://localhost' } }), undefined)
  assert.equal(fallbackRejection({ headers: { host: 'localhost:5000', origin: 'http://localhost:5001' } }), 403)
  // Origin without Host has nothing to compare against: fail closed.
  assert.equal(fallbackRejection({ headers: { origin: 'http://localhost:5000' } }), 403)
  // Desktop forwarding may strip Host; absence is allowed but not a trust grant.
  assert.equal(fallbackRejection({ headers: {} }), undefined)
})

test('delivery configure updates limits without resetting dedupe/rate state', () => {
  const breaker = createLoopBreaker({ maxRounds: 3, maxDeliveriesPerMinute: 6, now: () => 0 })
  breaker.guard({ linkId: 'l1', round: 1, kind: 'feedback', content: 'same' })
  assert.throws(
    () => breaker.guard({ linkId: 'l1', round: 1, kind: 'feedback', content: 'same' }),
    (error) => error.code === 'DUPLICATE',
  )
  breaker.configure({ maxRounds: 10, maxDeliveriesPerMinute: 12 })
  // The successful delivery is still remembered after a settings save.
  assert.throws(
    () => breaker.guard({ linkId: 'l1', round: 1, kind: 'feedback', content: 'same' }),
    (error) => error.code === 'DUPLICATE',
  )
  breaker.guard({ linkId: 'l1', round: 4, kind: 'revision', content: 'new' })
})

test('readBody parses JSON and enforces the size cap', async () => {
  const request = Readable.from([Buffer.from('{"sessionId":"s1"}')])
  request.headers = { 'content-type': 'application/json' }
  assert.deepEqual(await readBody(request), { sessionId: 's1' })
  const tooLarge = Readable.from([Buffer.alloc(2048, 97)])
  await assert.rejects(() => readBody(tooLarge, { maxBytes: 1024 }), (error) => error.code === 'BODY_TOO_LARGE')
  const badJson = Readable.from([Buffer.from('{oops')])
  await assert.rejects(() => readBody(badJson), /not valid JSON/)
})

test('errorResponse maps expected and unexpected failures', () => {
  assert.deepEqual(errorResponse(new HandoffError('NO_LINK', 'missing')), {
    status: 200,
    body: { ok: false, code: 'NO_LINK', message: 'missing' },
  })
  const internal = errorResponse(new Error('crash at /srv/secret/path'))
  assert.equal(internal.body.ok, false)
  assert.equal(internal.body.code, 'INTERNAL')
  // Review finding 3: unexpected detail stays in the host log, never the client.
  assert.equal(internal.body.message, 'handoff-review 內部錯誤，請稍後重試。')
  assert.ok(!internal.body.message.includes('/srv/secret/path'))
  // Delivery refusals are user-facing outcomes, not INTERNAL errors.
  assert.deepEqual(errorResponse(new DeliveryError('DUPLICATE', '已送出過')), {
    status: 200,
    body: { ok: false, code: 'DUPLICATE', message: '已送出過' },
  })
  assert.equal(errorResponse(new DeliveryError('RATE_LIMIT', '太快')).body.code, 'RATE_LIMIT')
  // Only the DeliveryError class is user-facing; a spoofed code string must stay
  // an internal error and must not leak its message.
  const spoofed = new Error('boom at /secret/path')
  spoofed.code = 'DUPLICATE'
  const spoofedResponse = errorResponse(spoofed)
  assert.equal(spoofedResponse.body.code, 'INTERNAL')
  assert.ok(!spoofedResponse.body.message.includes('boom'))
})

test('createRouteDefinitions mounts the exact M1+M2 paths', () => {
  const service = {
    state: async ({ sessionId }) => ({ sessionId, role: null, link: null, can: {}, maxRounds: 3 }),
    create: async () => ({ link: {}, reviewSessionId: 'r', message: 'opened' }),
    feedback: async () => ({ message: 'sent' }),
    revision: async () => ({ message: 'revised' }),
    close: async () => ({ message: 'closed' }),
    getConfig: async () => ({ config: {}, defaults: {}, providers: [], models: [], presets: [] }),
    updateConfig: async () => ({ config: {}, message: 'saved' }),
    panel: async () => ({ role: null, rounds: [] }),
    diff: async () => ({ round: 1, files: [] }),
  }
  const ctx = { get: () => undefined }
  const routes = createRouteDefinitions(ctx, service)
  assert.deepEqual(
    routes.map((route) => route.path),
    [
      '/handoff-review/api/state',
      '/handoff-review/api/create',
      '/handoff-review/api/feedback',
      '/handoff-review/api/revision',
      '/handoff-review/api/close',
      '/handoff-review/api/config',
      '/handoff-review/api/panel',
      '/handoff-review/api/diff',
    ],
  )
  assert.ok(routes.every((route) => route.kind === 'exact'))
})

test('STATE route returns the service payload through the JSON contract', async () => {
  const service = {
    state: async ({ sessionId }) => ({ sessionId, role: 'impl', link: null, can: { create: true }, maxRounds: 3 }),
    create: async () => ({}),
    feedback: async () => ({}),
    revision: async () => ({}),
    close: async () => ({}),
    getConfig: async () => ({}),
    updateConfig: async () => ({}),
    panel: async () => ({}),
    diff: async () => ({}),
  }
  const routes = createRouteDefinitions({ get: () => undefined }, service)
  const stateRoute = routes.find((route) => route.path === '/handoff-review/api/state')
  const req = { method: 'GET', url: '/handoff-review/api/state?sessionId=session-1', headers: { host: '127.0.0.1:5000' } }
  const res = {
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
  await stateRoute.handler(req, res)
  assert.equal(res.statusCode, 200)
  const payload = JSON.parse(res.body)
  assert.equal(payload.ok, true)
  assert.equal(payload.sessionId, 'session-1')
})

test('reviewer policy appends sandbox mode, restricts known write tools, denies writes, and sets approval', () => {
  const appended = []
  const calls = {}
  const agent = {
    session: { append: (type, data) => appended.push({ type, data }) },
    ctx: {
      tools: {
        schemas: () => [{ name: 'edit' }, { name: 'write' }, { name: 'bash' }],
        restrict: (filter) => {
          calls.deny = filter.deny
          return () => {}
        },
        guard: (guard) => {
          calls.guard = guard
          return () => {}
        },
      },
    },
  }
  const ctx = {
    get: (key) => (key === 'approval' ? { setPolicy: (_agent, policy) => (calls.policy = policy) } : undefined),
  }
  const warnings = applyReviewerPolicy(ctx, agent, { readOnlyReviewer: true })
  assert.deepEqual(warnings, [])
  assert.deepEqual(appended, [{ type: 'sandbox/mode', data: { mode: 'read-only' } }])
  assert.deepEqual(calls.deny, ['edit', 'write'])
  assert.equal(calls.guard({ name: 'edit' }), 'handoff-review: reviewer is read-only')
  assert.equal(calls.guard({ name: 'bash' }), undefined)
  assert.equal(calls.policy, 'never')
  assert.ok(WRITE_TOOL_NAMES.includes('edit'))
})

test('reviewer policy is skipped when readOnlyReviewer is false', () => {
  const appended = []
  const agent = { session: { append: (type, data) => appended.push({ type, data }) }, ctx: { tools: {} } }
  assert.deepEqual(applyReviewerPolicy({ get: () => undefined }, agent, { readOnlyReviewer: false }), [])
  assert.equal(appended.length, 0)
})

test('reviewer model selection applies reasoning effort with a default fallback', async () => {
  const calls = []
  const okCtx = {
    sessionController: {
      selectModel: async (request) => {
        calls.push(request)
        return {}
      },
    },
  }
  assert.deepEqual(await selectReviewerModel(okCtx, 's', { reviewerProvider: 'p', reviewerModel: 'm' }), [])
  assert.deepEqual(await selectReviewerModel(okCtx, 's', { reviewerProvider: '', reviewerModel: '' }), [])
  assert.deepEqual(
    await selectReviewerModel(okCtx, 's', { reviewerProvider: 'p', reviewerModel: 'm', reviewerReasoningEffort: 'high' }),
    [],
  )
  assert.equal(calls.length, 2)
  assert.deepEqual(calls[0], { sessionId: 's', provider: 'p', model: 'm' })
  assert.deepEqual(calls[1], { sessionId: 's', provider: 'p', model: 'm', reasoningEffort: 'high' })

  // An unsupported effort retries with the model default and warns.
  const fallbackCalls = []
  const fallbackCtx = {
    sessionController: {
      selectModel: async (request) => {
        fallbackCalls.push(request)
        if (request.reasoningEffort !== undefined) throw new Error('unsupported effort')
        return {}
      },
    },
  }
  const fallbackWarnings = await selectReviewerModel(fallbackCtx, 's', {
    reviewerProvider: 'p',
    reviewerModel: 'm',
    reviewerReasoningEffort: 'max',
  })
  assert.equal(fallbackCalls.length, 2)
  assert.equal(fallbackWarnings.length, 1)
  assert.match(fallbackWarnings[0], /思考能力/)
  assert.match(fallbackWarnings[0], /模型預設/)

  const failing = {
    sessionController: {
      selectModel: async () => {
        throw new Error('no route')
      },
    },
  }
  const warnings = await selectReviewerModel(failing, 's', { reviewerProvider: 'p', reviewerModel: 'm' })
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /無法切換 reviewer 模型/)
})

test('normalizeConfig clamps invalid values to documented defaults', () => {
  assert.deepEqual(normalizeConfig(undefined), {
    reviewerProvider: '',
    reviewerModel: '',
    reviewerReasoningEffort: '',
    reviewerPreset: '',
    maxRounds: 3,
    maxHandoffChars: 30000,
    diffPerFileChars: 6000,
    autoSummarize: false,
    readOnlyReviewer: true,
    autoContinue: false,
    maxDeliveriesPerMinute: 6,
  })
  const custom = normalizeConfig({
    reviewerProvider: ' deepseek-account ',
    maxRounds: 5,
    maxHandoffChars: -1,
    autoSummarize: true,
    readOnlyReviewer: false,
    maxDeliveriesPerMinute: 2.9,
  })
  assert.equal(custom.reviewerProvider, 'deepseek-account')
  assert.equal(custom.maxRounds, 5)
  assert.equal(custom.maxHandoffChars, 30000)
  assert.equal(custom.autoSummarize, true)
  assert.equal(custom.readOnlyReviewer, false)
  assert.equal(custom.maxDeliveriesPerMinute, 2)
})

test('publicLink/locateLink/formatStatusText work on a fake store', () => {
  const now = Date.now()
  const store = {
    list: () => [
      { id: 'hr_1', status: 'reviewing', round: 1, implSessionId: 'i1', reviewSessionId: 'r1', focus: 'f', lastError: null, updatedAt: now, reviewerProvider: null, reviewerModel: null },
    ],
  }
  assert.equal(locateLink(store, 'r1').role, 'review')
  assert.equal(locateLink(store, 'i1').role, 'impl')
  assert.equal(locateLink(store, 'other').link, null)
  assert.equal(publicLink(null), null)
  const text = formatStatusText({ link: store.list()[0], role: 'review', maxRounds: 3 })
  assert.match(text, /hr_1/)
  assert.match(text, /reviewing/)
})

test('locale files are valid JSON with identical en/zh key sets and required keys', () => {
  const en = JSON.parse(fs.readFileSync(new URL('../locale/en.json', import.meta.url), 'utf8'))
  const zh = JSON.parse(fs.readFileSync(new URL('../locale/zh.json', import.meta.url), 'utf8'))
  const flatten = (value, prefix = '') =>
    Object.entries(value).flatMap(([key, child]) =>
      child !== null && typeof child === 'object'
        ? flatten(child, prefix ? `${prefix}.${key}` : key)
        : [prefix ? `${prefix}.${key}` : key],
    )
  assert.deepEqual(flatten(en).sort(), flatten(zh).sort())
  for (const key of ['meta.title', 'meta.description', 'dock.create', 'dock.openReview', 'dock.sendFeedback', 'dock.sendRevision', 'dock.close']) {
    assert.ok(flatten(en).includes(key), `missing locale key ${key}`)
  }
  // The in-bundle dictionaries must stay byte-for-byte value-identical with the
  // nested JSON files (review finding 5): extract `const EN/ZH = {...}` from the
  // client bundle and compare flattened values.
  const clientSource = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  const extractDictionary = (name) => {
    const marker = `const ${name} = `
    const start = clientSource.indexOf(marker)
    assert.ok(start >= 0, `missing ${name} dictionary`)
    let index = clientSource.indexOf('{', start)
    let depth = 0
    let quote = ''
    let escaped = false
    for (; index < clientSource.length; index += 1) {
      const char = clientSource[index]
      if (quote !== '') {
        if (escaped) escaped = false
        else if (char === '\\') escaped = true
        else if (char === quote) quote = ''
        continue
      }
      if (char === '"' || char === "'") {
        quote = char
        continue
      }
      if (char === '{') depth += 1
      else if (char === '}') {
        depth -= 1
        if (depth === 0) return Function(`"use strict"; return (${clientSource.slice(clientSource.indexOf('{', start), index + 1)})`)()
      }
    }
    throw new Error(`unterminated ${name} dictionary`)
  }
  const flatObject = (value, prefix = '') =>
    Object.entries(value).flatMap(([key, child]) =>
      child !== null && typeof child === 'object'
        ? flatObject(child, prefix ? `${prefix}.${key}` : key)
        : [`${prefix ? prefix + '.' : ''}${key}=${String(child)}`],
    ).sort()
  assert.deepEqual(flatObject(extractDictionary('EN')), flatObject(en))
  assert.deepEqual(flatObject(extractDictionary('ZH')), flatObject(zh))
})

test('a failed inbox write does not poison dedupe (D4)', () => {
  let failing = true
  const delivered = []
  const agent = {
    followup(message) {
      if (failing) throw new Error('inbox down')
      delivered.push(message)
    },
    inject() {},
  }
  const delivery = createDelivery({ maxRounds: 3, maxDeliveriesPerMinute: 6 })
  assert.throws(
    () => delivery.deliver(agent, 'report', { linkId: 'l1', round: 1, kind: 'feedback' }),
    /inbox down/,
  )
  failing = false
  delivery.deliver(agent, 'report', { linkId: 'l1', round: 1, kind: 'feedback' })
  assert.equal(delivered.length, 1)
})

test('hydrateCreatedEntries reads write-created files and degrades safely (D2)', async () => {
  const files = new Map([['/tmp/w/a.js', 'line1\nline2\n']])
  const readable = {
    get: (key) =>
      key === 'fs'
        ? {
            resolve: async (path) => path,
            stat: async () => ({ size: 12 }),
            readText: async (path) => files.get(path),
          }
        : undefined,
  }
  const hydrated = await hydrateCreatedEntries(
    readable,
    [{ seq: 1, path: '/tmp/w/a.js', oldText: null, newText: null, operation: 'create' }],
    6000,
  )
  assert.equal(hydrated[0].newText, 'line1\nline2\n')

  const oversized = await hydrateCreatedEntries(
    { get: () => ({ resolve: async (path) => path, stat: async () => ({ size: 999_999 }), readText: async () => 'x' }) },
    [{ path: '/tmp/w/big.js', oldText: null, newText: null, operation: 'create' }],
    6000,
  )
  assert.equal(oversized[0].newText, '')
  assert.equal(oversized[0].unavailable, true)

  const missing = await hydrateCreatedEntries(
    { get: () => ({ resolve: async (path) => path, stat: async () => undefined, readText: async () => 'x' }) },
    [{ path: '/tmp/w/deleted.js', oldText: null, newText: null, operation: 'create' }],
    6000,
  )
  assert.equal(missing.length, 0)

  const enoent = await hydrateCreatedEntries(
    {
      get: () => ({
        resolve: async (path) => path,
        stat: async () => ({ size: 1 }),
        readText: async () => {
          const error = new Error('no such file or directory')
          error.code = 'ENOENT'
          throw error
        },
      }),
    },
    [{ path: '/tmp/w/deleted2.js', oldText: null, newText: null, operation: 'create' }],
    6000,
  )
  assert.equal(enoent.length, 0)

  const unreadable = await hydrateCreatedEntries(
    {
      get: () => ({
        resolve: async (path) => path,
        stat: async () => ({ size: 1 }),
        readText: async () => {
          throw new Error('nope')
        },
      }),
    },
    [{ path: '/tmp/w/missing.js', oldText: null, newText: null, operation: 'create' }],
    6000,
  )
  assert.equal(unreadable[0].newText, '')
  assert.equal(unreadable[0].unavailable, true)

  // N2: a path created and then edited in the same window keeps only the edit
  // hunks; hydrating the current file would double-represent it.
  const createdAndEdited = await hydrateCreatedEntries(
    readable,
    [
      { seq: 1, path: '/tmp/w/f.txt', oldText: null, newText: null, operation: 'create' },
      { seq: 2, path: '/tmp/w/f.txt', oldText: 'Y', newText: 'Z' },
    ],
    6000,
  )
  assert.equal(createdAndEdited.length, 1)
  assert.equal(createdAndEdited[0].seq, 2)

  // NEW-1: an OLDER hunk must not drop a newer create (edit -> delete -> recreate).
  const recreated = await hydrateCreatedEntries(
    readable,
    [
      { seq: 1, path: '/tmp/w/a.js', oldText: 'old', newText: 'older' },
      { seq: 5, path: '/tmp/w/a.js', oldText: null, newText: null, operation: 'create' },
    ],
    6000,
  )
  assert.equal(recreated.length, 2)
  assert.equal(recreated[1].newText, 'line1\nline2\n')
})

test('listArchivedSessionIds reads the workspace registry archive set (D10)', () => {
  const ok = { workspaceRegistry: { archivedSessionIds: ['s2', 's3'] } }
  const ids = listArchivedSessionIds(ok)
  assert.equal(ids.has('s2'), true)
  assert.equal(ids.has('s1'), false)
  const uninitialized = {
    workspaceRegistry: {
      get archivedSessionIds() {
        throw new Error('not initialized')
      },
    },
  }
  assert.equal(listArchivedSessionIds(uninitialized), undefined)
})

test('reconcileLinks marks an archived session stale via the registry (D10)', async () => {
  const calls = []
  const link = {
    id: 'hr_1',
    status: 'reviewing',
    implSessionId: 'impl-archived',
    reviewSessionId: 'review-live',
    round: 1,
  }
  const store = {
    list: () => [link],
    transition: async (id, event, extra) => {
      calls.push({ id, event, extra })
      return { ...link, status: 'stale' }
    },
  }
  const ctx = {
    sessions: { get: () => undefined },
    sessionController: { inspect: async () => ({}) },
    workspaceRegistry: { archivedSessionIds: ['impl-archived'] },
  }
  await reconcileLinks(ctx, store)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].event, 'stale')
  assert.match(calls[0].extra.lastError, /impl session 已歸檔/)

  calls.length = 0
  const healthy = { ...ctx, workspaceRegistry: { archivedSessionIds: [] } }
  await reconcileLinks(healthy, store)
  assert.equal(calls.length, 0)
})

test('state exposes no close/revision action for failed or stale links (D6)', async () => {
  const service = new HandoffService(
    {
      agents: { get: () => undefined },
      sessions: { get: () => undefined },
      sessionProjections: { stateOf: () => undefined },
    },
    { maxRounds: 3 },
    {
      store: {
        list: () => [
          {
            id: 'hr_1',
            status: 'stale',
            round: 2,
            implSessionId: 'i',
            reviewSessionId: 'r',
            focus: null,
            lastError: 'gone',
            updatedAt: 1,
            reviewerProvider: null,
            reviewerModel: null,
          },
        ],
      },
      delivery: {},
    },
  )
  const view = await service.state({ sessionId: 'i' })
  assert.equal(view.can.close, false)
  assert.equal(view.can.revision, false)
  assert.equal(view.can.feedback, false)
})
