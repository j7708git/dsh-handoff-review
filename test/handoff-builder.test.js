// Unit tests for the handoff builder: fixed sections, diff rendering,
// truncation, redaction, and the cross-session message envelopes
// (DEVELOPMENT.md §15.1).

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildFeedbackMessage,
  buildHandoff,
  buildReviewBrief,
  buildRevisionMessage,
  collectChangedFiles,
  extractGoal,
  extractOpenQuestions,
  redactSecrets,
  renderFileDiff,
} from '../lib/handoff-builder.js'

const config = { maxHandoffChars: 30000, diffPerFileChars: 6000 }

/** One sample hunk entry, matching the `tool/result.meta.diffs` projection shape. */
function entry(seq, path, oldText, newText) {
  return { seq, path, oldText, newText }
}

test('collectChangedFiles merges hunks per path and counts lines', () => {
  const files = collectChangedFiles([
    entry(1, 'src/a.js', 'const a = 1', 'const a = 2'),
    entry(2, 'src/a.js', 'x', 'x\ny'),
    entry(3, 'src/b.js', null, 'brand new'),
  ])
  assert.equal(files.length, 2)
  assert.equal(files[0].path, 'src/a.js')
  assert.equal(files[0].hunks.length, 2)
  // a.js: hunk 1 replaces one line (1 added, 1 removed), hunk 2 adds one line.
  assert.equal(files[0].added, 2)
  assert.equal(files[0].removed, 1)
  assert.equal(files[1].path, 'src/b.js')
  assert.equal(files[1].added, 1)
  assert.equal(files[1].removed, 0)
})

test('collectChangedFiles honours the sinceSeq watermark', () => {
  const files = collectChangedFiles([entry(4, 'a.js', 'a', 'b'), entry(8, 'b.js', 'c', 'd')], { sinceSeq: 4 })
  assert.deepEqual(files.map((file) => file.path), ['b.js'])
})

test('renderFileDiff emits a unified diff with a/b headers and hunk header', () => {
  const files = collectChangedFiles([entry(1, 'src/a.js', 'line one\nline two', 'line one\nline 2')])
  const text = renderFileDiff(files[0], { perFileChars: 6000 })
  assert.match(text, /```diff/)
  assert.match(text, /--- a\/src\/a\.js/)
  assert.match(text, /\+\+\+ b\/src\/a\.js/)
  assert.match(text, /@@ -\d+,\d+ \+\d+,\d+ @@/)
  assert.match(text, /-line two/)
  assert.match(text, /\+line 2/)
  assert.match(text, /```\s*$/)
})

test('buildHandoff emits every fixed section from DEVELOPMENT.md §9.6', () => {
  const changes = collectChangedFiles([entry(1, 'src/a.js', 'old', 'new')])
  const text = buildHandoff({
    round: 2,
    goal: 'Add retry logic',
    focus: 'retry logic',
    changes,
    verification: { seq: 9, tool: 'bash', text: 'tests passed', isError: false },
    openQuestions: '是否要 backoff？',
    warnings: [],
    config,
  })
  for (const heading of [
    '# Handoff for review (round 2)',
    '## Goal',
    '## Review focus',
    '## Changed files',
    '## Diff',
    '## Verification',
    '## Open questions',
  ]) {
    assert.ok(text.includes(heading), `missing heading: ${heading}`)
  }
  assert.match(text, /- src\/a\.js \(\+\d+ −\d+\)/)
  assert.match(text, /### src\/a\.js/)
  assert.match(text, /retry logic/)
  assert.match(text, /tests passed/)
  assert.match(text, /是否要 backoff/)
})

test('buildHandoff handles an empty change set and missing goal/focus', () => {
  const text = buildHandoff({
    round: 1,
    goal: '未提供',
    focus: null,
    changes: [],
    verification: null,
    openQuestions: '',
    warnings: [],
    config,
  })
  assert.match(text, /# Handoff for review \(round 1\)/)
  assert.match(text, /本次 session 尚無變更|未觀察到/)
  assert.match(text, /## Verification[\s\S]*未觀察到/)
})

test('buildHandoff enforces maxHandoffChars and marks truncation', () => {
  const changes = collectChangedFiles([
    entry(1, 'src/huge.js', 'a'.repeat(500), 'b'.repeat(500)),
    entry(2, 'src/huge2.js', 'c'.repeat(500), 'd'.repeat(500)),
  ])
  const text = buildHandoff({ round: 1, goal: 'g', focus: null, changes, verification: null, openQuestions: '', warnings: [], config: { maxHandoffChars: 500, diffPerFileChars: 5000 } })
  assert.ok(text.length <= 500, `handoff exceeds cap: ${text.length}`)
  assert.match(text, /已截斷/)
})

test('buildHandoff never exceeds a tiny cap (N3)', () => {
  const changes = collectChangedFiles([entry(1, 'a.js', 'a'.repeat(80), 'b'.repeat(80))])
  for (const cap of [5, 10, 12, 50]) {
    const text = buildHandoff({ round: 1, goal: 'goal', focus: null, changes, verification: null, openQuestions: '', warnings: [], config: { maxHandoffChars: cap, diffPerFileChars: 6000 } })
    assert.ok(text.length <= cap, `cap ${cap} produced ${text.length}`)
  }
})

test('buildHandoff marks an unavailable created file without fake diff lines', () => {
  const changes = collectChangedFiles([
    { seq: 1, path: 'src/new.js', oldText: null, newText: '', operation: 'create', unavailable: true },
  ])
  const text = buildHandoff({ round: 1, goal: 'g', focus: null, changes, verification: null, openQuestions: '', warnings: [], config })
  assert.match(text, /src\/new\.js \(\+0 −0\)（新檔內容未載入）/)
  // NEW-3: no empty fake hunk block for an unavailable created file.
  assert.ok(!text.includes('@@ -0,0 +0,0 @@'))
  assert.match(text, /### src\/new\.js\n（新檔內容未載入）/)
})

test('redactSecrets removes credential-looking values', () => {
  // Deliberately non-secret placeholders: the rule keys on the credential names
  // (`API_TOKEN`, `password`), not on the value shape.
  const redacted = redactSecrets('+API_TOKEN=<fixture-token>\n+password: <fixture-password>\n+DATABASE_URL=keep-me')
  assert.ok(!redacted.includes('<fixture-token>'))
  assert.ok(!redacted.includes('<fixture-password>'))
})

test('buildReviewBrief starts with the source marker and states read-only rules', () => {
  const brief = buildReviewBrief({ config, focus: 'retry logic' })
  assert.ok(brief.startsWith('[handoff-review]'))
  assert.match(brief, /reviewer/i)
  assert.match(brief, /read-only|唯讀/i)
  assert.match(brief, /REVIEW-REPORT/)
})

test('buildFeedbackMessage uses the exact source header and untrusted-data notice', () => {
  const text = buildFeedbackMessage({ round: 2, reviewSessionId: 'session-review-1', report: 'fix the retry loop' })
  assert.ok(text.startsWith('[handoff-review] Review round 2 from session session-review-1'))
  assert.match(text, /資料而非指令|data, not instructions/i)
  assert.match(text, /fix the retry loop/)
})

test('buildRevisionMessage uses the exact source header and untrusted-data notice', () => {
  const text = buildRevisionMessage({ round: 2, implSessionId: 'session-impl-1', handoff: '# Handoff for review (round 2)' })
  assert.ok(text.startsWith('[handoff-review] Revision for round 2 from session session-impl-1'))
  assert.match(text, /資料而非指令|data, not instructions/i)
  assert.match(text, /Handoff for review/)
})

test('extractGoal picks the newest user text; extractOpenQuestions finds flagged lines', () => {
  const messages = [
    { role: 'user', content: [{ type: 'text', text: 'first goal' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'working' }] },
    { role: 'user', content: [{ type: 'text', text: 'second goal' }] },
    { role: 'assistant', content: [{ type: 'text', text: '- TODO: 補測試\n- 待確認：命名\n' }] },
  ]
  assert.equal(extractGoal(messages), 'second goal')
  const questions = extractOpenQuestions(messages)
  assert.match(questions, /TODO: 補測試/)
  assert.match(questions, /待確認：命名/)
})

test('extractGoal ignores harness-injected user turns (review finding 1)', () => {
  const messages = [
    { role: 'user', content: [{ type: 'text', text: '把 panel 對齊修好' }] },
    { role: 'user', content: [{ type: 'text', text: 'Time sampled while preparing turn 1, step 42: 2026-10-18T14:35:26+08:00' }] },
    { role: 'user', content: [{ type: 'text', text: 'Elapsed since the preceding model-visible message: unavailable.' }] },
  ]
  assert.equal(extractGoal(messages), '把 panel 對齊修好')
  const mixed = [
    { role: 'user', content: [{ type: 'text', text: '真正的需求\nTime sampled while preparing turn 2, step 1: now' }] },
  ]
  assert.equal(extractGoal(mixed), '真正的需求')
})

test('extractGoal tolerates non-text content and empty history', () => {
  assert.equal(extractGoal([]), '未提供')
  assert.equal(extractGoal([{ role: 'user', content: [{ type: 'image' }] }]), '未提供')
})
