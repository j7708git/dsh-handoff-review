// Unit tests for the two session projections (DEVELOPMENT.md §9.4, §9.5, §15.1).

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  DIFF_PROJECTION_KEY,
  REPLY_PROJECTION_KEY,
  DIFF_STATE_VERSION,
  REPLY_STATE_VERSION,
  MAX_DIFF_ENTRIES,
  MAX_PENDING_CALLS,
  createDiffProjection,
  createReplyProjection,
  extractReplyText,
  readDiffs,
  registerHandoffProjections,
} from '../lib/projections.js'

/** Build one committed `tool/result` event carrying file diffs. */
function toolResult(seq, diffs, options = {}) {
  return {
    type: 'tool/result',
    seq,
    time: seq,
    data: {
      turn: 1,
      step: 1,
      message: {
        role: 'tool',
        id: `m-${seq}`,
        content: [{ type: 'text', text: options.text ?? 'ok' }],
        source: { kind: 'tool', callId: options.callId ?? `c-${seq}` },
        toolCallId: options.callId ?? `c-${seq}`,
        isError: options.isError ?? false,
      },
      ...(options.error ? { error: { name: 'Error', code: 'E' } } : {}),
      ...(diffs === undefined ? {} : { meta: { diffs } }),
    },
  }
}

test('readDiffs accepts valid successful diffs and rejects everything else', () => {
  const valid = [{ path: 'a.js', oldText: 'a', newText: 'b' }]
  assert.deepEqual(readDiffs(toolResult(3, valid)), valid)
  assert.equal(readDiffs(toolResult(3, valid, { isError: true })), undefined)
  assert.equal(readDiffs(toolResult(3, valid, { error: { name: 'E' } })), undefined)
  assert.equal(readDiffs(toolResult(3, undefined)), undefined)
  assert.equal(readDiffs(toolResult(3, [{ path: 1, oldText: null, newText: 'b' }])), undefined)
  assert.equal(readDiffs({ type: 'assistant/message', seq: 4, data: {} }), undefined)
})

test('readDiffs surfaces a write-created file with no hunks (D2)', () => {
  const event = {
    type: 'tool/result',
    seq: 4,
    time: 4,
    data: {
      turn: 1,
      step: 1,
      message: { role: 'tool', id: 'm-4', content: [{ type: 'text', text: 'wrote file' }], source: { kind: 'tool', callId: 'c-4' }, toolCallId: 'c-4' },
      meta: { operation: 'create', path: '/tmp/workspace/src/new.js', diffs: [] },
    },
  }
  assert.deepEqual(readDiffs(event), [
    { path: '/tmp/workspace/src/new.js', oldText: null, newText: null, operation: 'create' },
  ])
  const definition = createDiffProjection()
  const state = definition.apply(definition.init({}, 0), event)
  assert.equal(state.entries.length, 1)
  assert.equal(state.entries[0].operation, 'create')
  assert.equal(state.entries[0].newText, null)
  assert.equal(state.lastSeq, 4)
})

test('diff projection folds entries and advances its watermark', () => {
  const definition = createDiffProjection()
  assert.equal(definition.key, DIFF_PROJECTION_KEY)
  assert.equal(definition.stateVersion, DIFF_STATE_VERSION)
  let state = definition.init({}, 0)
  assert.equal(state.lastSeq, -1)
  state = definition.apply(state, toolResult(5, [{ path: 'a.js', oldText: null, newText: 'x' }]))
  assert.equal(state.entries.length, 1)
  assert.equal(state.lastSeq, 5)
  // A second, unrelated event must not move the diff watermark.
  state = definition.apply(state, { type: 'assistant/message', seq: 9, data: {} })
  assert.equal(state.lastSeq, 5)
  state = definition.apply(state, toolResult(11, [{ path: 'b.js', oldText: 'c', newText: 'd' }]))
  assert.equal(state.entries.length, 2)
  assert.equal(state.lastSeq, 11)
})

test('diff projection records tool-call names and the latest verification result', () => {
  const definition = createDiffProjection()
  let state = definition.init({}, 0)
  state = definition.apply(state, {
    type: 'tool/call',
    seq: 1,
    data: { turn: 1, step: 1, callId: 'call-1', name: 'bash', arguments: '{}' },
  })
  state = definition.apply(state, toolResult(2, [{ path: 'a.js', oldText: 'a', newText: 'b' }], { callId: 'call-1', text: 'wrote a.js' }))
  assert.equal(state.verification.tool, 'bash')
  assert.equal(state.verification.text, 'wrote a.js')
  assert.equal(state.verification.isError, false)
})

test('reply projection keeps only the last assistant text and its watermark', () => {
  const definition = createReplyProjection()
  assert.equal(definition.key, REPLY_PROJECTION_KEY)
  assert.equal(definition.stateVersion, REPLY_STATE_VERSION)
  let state = definition.init({}, 0)
  const event = {
    type: 'assistant/message',
    seq: 7,
    data: { turn: 1, step: 1, stream: [], message: { role: 'assistant', content: [{ type: 'text', text: 'report body' }] } },
  }
  state = definition.apply(state, event)
  assert.equal(state.lastText, 'report body')
  assert.equal(state.lastSeq, 7)
  state = definition.apply(state, { type: 'turn/end', seq: 8, data: { turn: 1, reason: { kind: 'completed' } } })
  assert.equal(state.lastSeq, 7)
})

test('extractReplyText joins every text block of the message', () => {
  const event = {
    type: 'assistant/message',
    seq: 1,
    data: { message: { role: 'assistant', content: [{ type: 'text', text: 'one' }, { type: 'reasoning', text: 'r' }, { type: 'text', text: 'two' }] } },
  }
  assert.equal(extractReplyText(event), 'one\n\ntwo')
  assert.equal(extractReplyText({ type: 'user/message', seq: 2, data: { message: { content: [{ type: 'text', text: 'x' }] } } }), undefined)
})

test('reply projection concatenates multi-step text within one turn and resets per turn', () => {
  const definition = createReplyProjection()
  let state = definition.init({}, 0)
  const assistant = (seq, turn, text) => ({
    type: 'assistant/message',
    seq,
    data: { turn, step: 1, stream: [], message: { role: 'assistant', content: [{ type: 'text', text }] } },
  })
  state = definition.apply(state, assistant(1, 1, 'part one'))
  state = definition.apply(state, assistant(2, 1, 'part two'))
  assert.equal(state.lastText, 'part one\n\npart two')
  assert.equal(state.lastSeq, 2)
  state = definition.apply(state, assistant(3, 2, 'next turn'))
  assert.equal(state.lastText, 'next turn')
})

test('diff projection drops a settled call name and bounds pending calls', () => {
  const definition = createDiffProjection()
  let state = definition.init({}, 0)
  state = definition.apply(state, {
    type: 'tool/call',
    seq: 1,
    data: { turn: 1, step: 1, callId: 'call-1', name: 'bash', arguments: '{}' },
  })
  state = definition.apply(state, toolResult(2, [{ path: 'a.js', oldText: 'a', newText: 'b' }], { callId: 'call-1' }))
  assert.deepEqual(state.calls, {})
  for (let index = 0; index < MAX_PENDING_CALLS + 5; index += 1) {
    state = definition.apply(state, {
      type: 'tool/call',
      seq: 10 + index,
      data: { turn: 1, step: 1, callId: `c-${index}`, name: 'bash', arguments: '{}' },
    })
  }
  assert.ok(Object.keys(state.calls).length <= MAX_PENDING_CALLS)
})

test('diff projection bounds its entry list on long sessions', () => {
  const definition = createDiffProjection()
  let state = definition.init({}, 0)
  for (let index = 0; index < MAX_DIFF_ENTRIES + 20; index += 1) {
    state = definition.apply(state, toolResult(index + 1, [{ path: `f-${index}.js`, oldText: 'a', newText: 'b' }]))
  }
  assert.equal(state.entries.length, MAX_DIFF_ENTRIES)
  assert.equal(state.entries[state.entries.length - 1].path, `f-${MAX_DIFF_ENTRIES + 19}.js`)
})

test('registerHandoffProjections registers both units and returns one disposer', () => {
  const registered = []
  const ctx = {
    sessionProjections: {
      register(definition) {
        registered.push(definition.key)
        return () => registered.splice(registered.indexOf(definition.key), 1)
      },
    },
  }
  const dispose = registerHandoffProjections(ctx)
  assert.deepEqual(registered.sort(), [DIFF_PROJECTION_KEY, REPLY_PROJECTION_KEY].sort())
  dispose()
  assert.equal(registered.length, 0)
})
