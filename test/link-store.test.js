// Unit tests for the durable link store: record schema, transition table,
// illegal-transition refusal, and serialized concurrent writes
// (DEVELOPMENT.md §8, §15.1).

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  ACTIVE_STATUSES,
  LINK_DOMAIN,
  LINK_STATUSES,
  LINKS_TABLE,
  LinkStoreError,
  applyLinkTransition,
  defineDomain,
  domainTable,
  linkDomainSpec,
  linkRecordSchema,
  newLinkId,
  openLinkStore,
} from '../lib/link-store.js'

const NOW = 1_700_000_000_000

/** Build a valid live link record. */
function makeRecord(overrides = {}) {
  return {
    version: 1,
    id: newLinkId(NOW),
    implSessionId: 'session-impl',
    reviewSessionId: null,
    workspaceId: null,
    cwd: '/tmp/workspace',
    status: 'creating',
    round: 1,
    focus: null,
    createdAt: NOW,
    updatedAt: NOW,
    lastHandoffSeq: -1,
    lastFeedbackSeq: null,
    reviewerProvider: null,
    reviewerModel: null,
    lastError: null,
    closedAt: null,
    ...overrides,
  }
}

/** In-memory storage domain double with a single serialized write chain. */
function createFakeStorageDomain() {
  let chain = Promise.resolve()
  const tables = new Map()
  const opened = []
  const enqueue = (job) => {
    const result = chain.then(job)
    chain = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }
  const tableFor = (name) => {
    if (!tables.has(name)) {
      const records = new Map()
      tables.set(name, {
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
      })
    }
    return tables.get(name)
  }
  const domain = {
    name: LINK_DOMAIN,
    table: (name) => tableFor(name).handle,
    close: async () => {
      domain.closed = true
    },
    closed: false,
  }
  const storageDomain = {
    open: async (spec) => {
      opened.push(spec)
      return domain
    },
  }
  return { storageDomain, domain, opened, tableFor }
}

test('record schema accepts the documented shape and rejects bad statuses', () => {
  assert.equal(linkRecordSchema.parse(makeRecord()).version, 1)
  assert.throws(() => linkRecordSchema.parse(makeRecord({ status: 'open_typo' })))
  assert.throws(() => linkRecordSchema.parse(makeRecord({ round: 0 })))
})

test('domain helpers and spec use the documented names', () => {
  const spec = linkDomainSpec()
  assert.equal(spec.name, 'handoff_review')
  assert.equal(spec.version, 1)
  assert.equal(LINK_DOMAIN, 'handoff_review')
  assert.equal(LINKS_TABLE, 'links')
  assert.ok(spec.tables.links.valueSchema !== undefined)
  assert.deepEqual(defineDomain({ name: 'handoff_review', version: 1, tables: {} }), {
    name: 'handoff_review',
    version: 1,
    tables: {},
  })
  assert.equal(typeof domainTable({ parse: (value) => value }), 'object')
  assert.deepEqual(LINK_STATUSES, [
    'creating',
    'open',
    'reviewing',
    'feedback_ready',
    'feedback_sent',
    'closed',
    'failed',
    'stale',
  ])
})

test('newLinkId creates sortable hr_<ulid> identities', () => {
  const first = newLinkId(NOW)
  const second = newLinkId(NOW + 1)
  assert.match(first, /^hr_[0-9A-HJKMNP-TV-Z]{26}$/)
  assert.equal(first.length, 3 + 26)
  assert.ok(second > first)
  assert.notEqual(newLinkId(NOW), newLinkId(NOW))
})

test('applyLinkTransition implements the documented state machine', () => {
  let record = makeRecord()
  record = applyLinkTransition(record, 'delivered', {
    reviewSessionId: 'session-review',
    lastHandoffSeq: 42,
    now: NOW + 1,
  })
  assert.equal(record.status, 'reviewing')
  assert.equal(record.reviewSessionId, 'session-review')
  // D1 regression: the first handoff watermark must be durable, otherwise the
  // first revision re-sends round-1 hunks.
  assert.equal(record.lastHandoffSeq, 42)

  record = applyLinkTransition(record, 'feedback-ready', { lastFeedbackSeq: 12, now: NOW + 2 })
  assert.equal(record.status, 'feedback_ready')
  // Only a delivered report advances the watermark (D3 invariant).
  assert.equal(record.lastFeedbackSeq, null)

  record = applyLinkTransition(record, 'feedback-sent', { lastFeedbackSeq: 13, now: NOW + 3 })
  assert.equal(record.status, 'feedback_sent')

  record = applyLinkTransition(record, 'revision', { lastHandoffSeq: 20, now: NOW + 4 })
  assert.equal(record.status, 'reviewing')
  assert.equal(record.round, 2)
  assert.equal(record.lastHandoffSeq, 20)

  record = applyLinkTransition(record, 'close', { now: NOW + 5 })
  assert.equal(record.status, 'closed')
  assert.equal(record.closedAt, NOW + 5)

  record = applyLinkTransition(record, 'reopen', { now: NOW + 6 })
  assert.equal(record.status, 'open')
  assert.equal(record.closedAt, null)

  const failed = applyLinkTransition(makeRecord(), 'failure', { lastError: 'boom', now: NOW + 7 })
  assert.equal(failed.status, 'failed')
  assert.equal(failed.lastError, 'boom')
  const retried = applyLinkTransition(failed, 'retry', { now: NOW + 8 })
  assert.equal(retried.status, 'creating')
  const stale = applyLinkTransition(makeRecord({ status: 'reviewing' }), 'stale', { lastError: 'gone', now: NOW + 9 })
  assert.equal(stale.status, 'stale')
})

test('applyLinkTransition refuses illegal transitions with a stable code', () => {
  const feedbackReady = makeRecord({ status: 'feedback_ready' })
  assert.throws(
    () => applyLinkTransition(feedbackReady, 'reopen'),
    (error) => error instanceof LinkStoreError && error.code === 'invalid-transition',
  )
  assert.throws(
    () => applyLinkTransition(makeRecord({ status: 'closed' }), 'feedback-ready'),
    (error) => error instanceof LinkStoreError && error.code === 'invalid-transition',
  )
})

test('applyLinkTransition ignores immutable fields in extras', () => {
  const record = applyLinkTransition(makeRecord(), 'delivered', {
    id: 'evil',
    version: 99,
    createdAt: 1,
    implSessionId: 'evil',
    reviewSessionId: 'session-review',
    now: NOW + 1,
  })
  assert.notEqual(record.id, 'evil')
  assert.equal(record.version, 1)
  assert.equal(record.createdAt, NOW)
  assert.equal(record.implSessionId, 'session-impl')
})

test('openLinkStore creates, reads, lists, and closes durable links', async () => {
  const fake = createFakeStorageDomain()
  const store = await openLinkStore(fake.storageDomain)
  assert.equal(fake.opened.length, 1)
  assert.equal(fake.opened[0].name, 'handoff_review')

  const record = makeRecord()
  await store.create(record)
  assert.equal(store.get(record.id).status, 'creating')
  assert.equal(store.list().length, 1)
  assert.equal(store.getActiveForImpl('session-impl').id, record.id)

  await assert.rejects(() => store.create(record), (error) => error.code === 'duplicate')

  const delivered = await store.transition(record.id, 'delivered', { reviewSessionId: 'session-review', now: NOW + 1 })
  assert.equal(delivered.status, 'reviewing')
  assert.equal(store.getByReviewSession('session-review').id, record.id)

  const closed = await store.transition(record.id, 'close', { now: NOW + 2 })
  assert.equal(closed.status, 'closed')
  assert.equal(store.getActiveForImpl('session-impl'), undefined)

  await assert.rejects(
    () => store.transition('hr_missing', 'close'),
    (error) => error.code === 'not-found',
  )

  await store.close()
  assert.equal(fake.domain.closed, true)
})

test('store transitions are serialized: concurrent duplicate transitions settle once', async () => {
  const fake = createFakeStorageDomain()
  const store = await openLinkStore(fake.storageDomain)
  const record = makeRecord({ status: 'feedback_ready' })
  await store.create(record)

  const results = await Promise.allSettled([
    store.transition(record.id, 'feedback-sent', { lastFeedbackSeq: 1 }),
    store.transition(record.id, 'feedback-sent', { lastFeedbackSeq: 2 }),
  ])
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1)
  assert.equal(results.filter((result) => result.status === 'rejected').length, 1)
  assert.equal(store.get(record.id).status, 'feedback_sent')
})

test('store patch touches updatedAt and rejects unknown ids', async () => {
  const fake = createFakeStorageDomain()
  const store = await openLinkStore(fake.storageDomain)
  const record = makeRecord()
  await store.create(record)
  const patched = await store.patch(record.id, { focus: 'retry logic' })
  assert.equal(patched.focus, 'retry logic')
  assert.ok(patched.updatedAt >= record.updatedAt)
  await assert.rejects(() => store.patch('hr_missing', { focus: 'x' }), (error) => error.code === 'not-found')
})

test('ACTIVE_STATUSES matches the one-active-link rule', () => {
  assert.deepEqual(ACTIVE_STATUSES, ['creating', 'open', 'reviewing', 'feedback_ready', 'feedback_sent'])
})
