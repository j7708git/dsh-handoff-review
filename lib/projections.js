// dsh-handoff-review — host-only session projections.
//
// Two pure folds over the committed session log:
// - `handoffReviewDiff` (DIFF_PROJECTION_KEY): successful `tool/result` diff
//   hunks (the source of a handoff) plus a tiny registry of `tool/call` names
//   and the latest verification command result.
// - `handoffReviewReply` (REPLY_PROJECTION_KEY): the last non-empty assistant
//   reply text, used to shuttle the reviewer report back to the implementation
//   session.
//
// Both units hold plain JSON state, declare `stateVersion: 1`, and never read
// the log directly (`snapshotEvents()` is deliberately unused). All `apply`
// functions are synchronous and return the same state reference when the
// event is not theirs, as the projection registry requires.
//
// Plain ESM, no build step. Only `zod` is imported.

import { z } from 'zod';

/** Projection key folding this session's applied file diffs. */
export const DIFF_PROJECTION_KEY = 'handoffReviewDiff';

/** Projection key folding the last assistant reply text. */
export const REPLY_PROJECTION_KEY = 'handoffReviewReply';

/** Persisted-cache invalidation version of the diff unit. */
export const DIFF_STATE_VERSION = 1;

/** Persisted-cache invalidation version of the reply unit (2: multi-step concat). */
export const REPLY_STATE_VERSION = 2;

/** Hard caps keeping the diff projection state bounded on long sessions. */
export const MAX_DIFF_ENTRIES = 2000;
export const MAX_DIFF_CHARS = 1_500_000;
export const MAX_PENDING_CALLS = 200;

/** Tool names whose result is kept as the handoff's verification summary. */
const VERIFICATION_TOOLS = new Set(['bash', 'pwsh', 'run_code']);

/** Character cap for the stored verification text. */
const VERIFICATION_TEXT_LIMIT = 1000;

/** One applied hunk recorded from a successful `tool/result`. */
const diffEntrySchema = z.object({
  seq: z.number().int().nonnegative(),
  turn: z.number().int().nonnegative(),
  step: z.number().int().nonnegative(),
  path: z.string(),
  oldText: z.string().nullable(),
  // `null` marks a file created by `write`, whose result meta carries an empty
  // diff list; the handoff builder hydrates its content from the workspace.
  newText: z.string().nullable(),
  operation: z.enum(['create', 'update']).optional(),
});

/** Latest verification command result kept for the handoff. */
const verificationSchema = z.object({
  seq: z.number().int().nonnegative(),
  tool: z.string(),
  text: z.string(),
  isError: z.boolean(),
});

/** Host state of the diff projection (DEVELOPMENT.md §9.4). Plain JSON. */
export const diffStateSchema = z.object({
  entries: z.array(diffEntrySchema),
  lastSeq: z.number().int().min(-1),
  calls: z.record(z.string(), z.string()),
  verification: verificationSchema.nullable(),
});

/** Host state of the reply projection (DEVELOPMENT.md §9.5). Plain JSON. */
export const replyStateSchema = z.object({
  lastText: z.string().nullable(),
  lastSeq: z.number().int().min(-1),
  turn: z.number().int().nonnegative(),
});

/**
 * Object guard that excludes arrays and null.
 * @param {unknown} value candidate.
 * @returns {boolean} whether the value is a plain object.
 */
function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Defensively read applied file hunks from one session event.
 *
 * Only a successful `tool/result` event with a valid `data.meta.diffs` array
 * qualifies: `data.error` must be absent and `data.message.isError` must not
 * be `true`. A `write` that creates a file records an empty diff list plus
 * `meta.operation: 'create'` and `meta.path`; that is surfaced as one entry
 * with `newText: null` so the handoff builder can hydrate the new file content.
 * Absent or malformed metadata yields `undefined` and never throws, so replay of
 * an old or damaged log cannot break the projection.
 *
 * @param {object} event one committed session event.
 * @returns {Array<{ path: string, oldText: string | null, newText: string | null, operation?: 'create' | 'update' }> | undefined} validated hunks.
 */
export function readDiffs(event) {
  if (!isRecord(event) || event.type !== 'tool/result' || !isRecord(event.data)) return undefined;
  const data = event.data;
  if (data.error !== undefined && data.error !== null) return undefined;
  if (isRecord(data.message) && data.message.isError === true) return undefined;
  if (!isRecord(data.meta)) return undefined;
  const rawDiffs = data.meta.diffs;
  if (!Array.isArray(rawDiffs)) return undefined;

  if (rawDiffs.length === 0) {
    // `write` creating a new file: before === null, so the tool reports no
    // hunks. Keep the path and mark it for content hydration.
    const operation = data.meta.operation;
    const path = data.meta.path;
    if (operation === 'create' && typeof path === 'string' && path !== '') {
      return [{ path, oldText: null, newText: null, operation: 'create' }];
    }
    return [];
  }

  const diffs = [];
  for (const item of rawDiffs) {
    if (!isRecord(item)) return undefined;
    const path = typeof item.path === 'string' && item.path !== '' ? item.path : undefined;
    const oldText = item.oldText === null
      ? null
      : typeof item.oldText === 'string'
        ? item.oldText
        : undefined;
    const newText = typeof item.newText === 'string' ? item.newText : undefined;
    if (path === undefined || oldText === undefined || newText === undefined) return undefined;
    diffs.push({ path, oldText, newText });
  }
  return diffs;
}

/**
 * Read every non-empty text block of an `assistant/message` event, joined with
 * a blank line. Reasoning and other blocks are ignored; keeping all text blocks
 * matters for reviewers whose report spans several content blocks.
 *
 * @param {object} event one committed session event.
 * @returns {string | undefined} the reply text, when present.
 */
export function extractReplyText(event) {
  if (!isRecord(event) || event.type !== 'assistant/message' || !isRecord(event.data)) return undefined;
  const message = event.data.message;
  if (!isRecord(message) || !Array.isArray(message.content)) return undefined;
  const texts = [];
  for (const block of message.content) {
    if (!isRecord(block) || block.type !== 'text' || typeof block.text !== 'string') continue;
    if (block.text.trim() === '') continue;
    texts.push(block.text);
  }
  return texts.length > 0 ? texts.join('\n\n') : undefined;
}

/**
 * Bound the diff-entry list by count and total text size, dropping the oldest
 * hunks first. Revision watermarks still work for recent rounds; very old
 * hunks beyond the cap are intentionally not retained (the handoff caps would
 * truncate them anyway).
 * @param {Array<object>} entries diff entries, oldest first.
 * @returns {Array<object>} bounded copy.
 */
function boundEntries(entries) {
  if (!Array.isArray(entries)) return [];
  let total = 0;
  for (const entry of entries) {
    if (entry === null || typeof entry !== 'object') continue;
    total += (typeof entry.oldText === 'string' ? entry.oldText.length : 0)
      + (typeof entry.newText === 'string' ? entry.newText.length : 0)
      + (typeof entry.path === 'string' ? entry.path.length : 0);
  }
  let start = 0;
  while (start < entries.length && (entries.length - start > MAX_DIFF_ENTRIES || total > MAX_DIFF_CHARS)) {
    const entry = entries[start];
    if (entry !== null && typeof entry === 'object') {
      total -= (typeof entry.oldText === 'string' ? entry.oldText.length : 0)
        + (typeof entry.newText === 'string' ? entry.newText.length : 0)
        + (typeof entry.path === 'string' ? entry.path.length : 0);
    }
    start += 1;
  }
  return start === 0 ? entries : entries.slice(start);
}

/**
 * Build the host-only diff projection unit.
 *
 * The fold records one entry per applied hunk from successful `tool/result`
 * events, remembers `tool/call` names by call id, and keeps the latest
 * `bash` / `pwsh` / `run_code` result (text capped at 1000 chars) as the
 * handoff verification summary.
 *
 * @returns {{
 *   key: string,
 *   stateVersion: number,
 *   stateSchema: object,
 *   init: (header?: object, inheritedEventCount?: number) => object,
 *   apply: (state: object, event: object) => object,
 * }} the projection definition.
 */
export function createDiffProjection() {
  return {
    key: DIFF_PROJECTION_KEY,
    stateVersion: DIFF_STATE_VERSION,
    stateSchema: diffStateSchema,
    init: () => ({ entries: [], lastSeq: -1, calls: {}, verification: null }),
    apply: (state, event) => {
      if (!isRecord(state) || !isRecord(event)) return state;

      if (event.type === 'tool/call') {
        const data = event.data;
        if (!isRecord(data) || typeof data.callId !== 'string' || typeof data.name !== 'string') return state;
        const nextCalls = { ...(isRecord(state.calls) ? state.calls : {}), [data.callId]: data.name };
        const callKeys = Object.keys(nextCalls);
        while (callKeys.length > MAX_PENDING_CALLS) delete nextCalls[callKeys.shift()];
        return { ...state, calls: nextCalls };
      }

      if (event.type !== 'tool/result' || !isRecord(event.data)) return state;
      const data = event.data;
      const message = isRecord(data.message) ? data.message : {};
      const callId = typeof message.toolCallId === 'string'
        ? message.toolCallId
        : isRecord(message.source) && typeof message.source.callId === 'string'
          ? message.source.callId
          : undefined;
      const calls = isRecord(state.calls) ? state.calls : {};
      const tool = callId !== undefined ? calls[callId] : undefined;

      const diffs = readDiffs(event);
      const hasDiffs = Array.isArray(diffs) && diffs.length > 0;
      const verification = tool !== undefined && VERIFICATION_TOOLS.has(tool)
        ? buildVerification(event, tool)
        : undefined;
      if (!hasDiffs && verification === undefined) return state;

      const nextEntries = hasDiffs
        ? [
          ...(Array.isArray(state.entries) ? state.entries : []),
          ...diffs.map((diff) => ({
            seq: Math.max(0, Math.floor(numeric(event.seq, 0))),
            turn: Math.max(0, Math.floor(numeric(data.turn, 0))),
            step: Math.max(0, Math.floor(numeric(data.step, 0))),
            path: diff.path,
            oldText: diff.oldText,
            newText: diff.newText,
            ...(diff.operation !== undefined ? { operation: diff.operation } : {}),
          })),
        ]
        : state.entries;
      const boundedEntries = boundEntries(nextEntries);
      // A settled tool call is no longer pending: drop its name so the map
      // cannot grow for the whole session lifetime.
      const nextCalls = { ...(isRecord(state.calls) ? state.calls : {}) };
      if (callId !== undefined) delete nextCalls[callId];

      return {
        ...state,
        entries: boundedEntries,
        calls: nextCalls,
        lastSeq: hasDiffs ? Math.max(0, Math.floor(numeric(event.seq, 0))) : state.lastSeq,
        verification: verification !== undefined ? verification : state.verification,
      };
    },
  };
}

/**
 * Build the host-only reply projection unit: fold the last non-empty
 * `assistant/message` text of the session.
 *
 * @returns {{
 *   key: string,
 *   stateVersion: number,
 *   stateSchema: object,
 *   init: (header?: object, inheritedEventCount?: number) => object,
 *   apply: (state: object, event: object) => object,
 * }} the projection definition.
 */
export function createReplyProjection() {
  return {
    key: REPLY_PROJECTION_KEY,
    stateVersion: REPLY_STATE_VERSION,
    stateSchema: replyStateSchema,
    init: () => ({ lastText: null, lastSeq: -1, turn: 0 }),
    apply: (state, event) => {
      if (!isRecord(state) || !isRecord(event) || event.type !== 'assistant/message') return state;
      const text = extractReplyText(event);
      if (text === undefined) return state;
      const data = isRecord(event.data) ? event.data : {};
      const turn = Number.isFinite(data.turn) ? data.turn : state.turn;
      const sameTurn = Number.isFinite(state.turn) && turn === state.turn;
      const previous = typeof state.lastText === 'string' ? state.lastText.trim() : '';
      // Multi-step reviewer turns commit one assistant message per step; keep
      // the whole report instead of only the last step.
      const merged = sameTurn && previous !== '' ? `${previous}\n\n${text}` : text;
      return {
        lastText: merged,
        lastSeq: Number.isFinite(event.seq) ? event.seq : state.lastSeq,
        turn,
      };
    },
  };
}

/**
 * Register both projection units on `ctx.sessionProjections` and return one
 * shared, idempotent disposer. If the second registration fails, the first is
 * rolled back before the error is rethrown.
 *
 * @param {{ sessionProjections?: { register: (definition: object) => () => void } }} ctx plugin context.
 * @returns {() => void} disposer unregistering both units.
 */
export function registerHandoffProjections(ctx) {
  const registry = ctx && typeof ctx === 'object' ? ctx.sessionProjections : undefined;
  if (!registry || typeof registry.register !== 'function') {
    throw new Error('sessionProjections service is unavailable; mount the session-projection plugin');
  }

  const disposers = [];
  try {
    disposers.push(registry.register(createDiffProjection()));
    disposers.push(registry.register(createReplyProjection()));
  } catch (error) {
    disposeAll(disposers);
    throw error;
  }

  return () => disposeAll(disposers);
}

/**
 * Keep the latest verification command result from one successful or failed
 * `tool/result` event. Text is capped at 1000 characters.
 *
 * @param {object} event the `tool/result` event.
 * @param {string} tool resolved tool name.
 * @returns {{ seq: number, tool: string, text: string, isError: boolean }} the verification snapshot.
 */
function buildVerification(event, tool) {
  const data = isRecord(event.data) ? event.data : {};
  const message = isRecord(data.message) ? data.message : {};
  const chunks = [];
  if (Array.isArray(message.content)) {
    for (const block of message.content) {
      if (isRecord(block) && block.type === 'text' && typeof block.text === 'string') {
        chunks.push(block.text);
      }
    }
  }
  let text = chunks.join('\n');
  if (text.length > VERIFICATION_TEXT_LIMIT) text = text.slice(0, VERIFICATION_TEXT_LIMIT);
  return {
    seq: Math.max(0, Math.floor(numeric(event.seq, 0))),
    tool,
    text,
    isError: message.isError === true || (data.error !== undefined && data.error !== null),
  };
}

/**
 * Dispose every collected unit disposer, ignoring individual failures.
 * @param {Array<() => void>} disposers collected disposers.
 * @returns {void}
 */
function disposeAll(disposers) {
  while (disposers.length > 0) {
    const dispose = disposers.pop();
    if (typeof dispose !== 'function') continue;
    try {
      dispose();
    } catch {
      // Registration teardown must not mask the original failure.
    }
  }
}

/**
 * Coerce a candidate to a finite number.
 * @param {unknown} value candidate.
 * @param {number} fallback value used when the candidate is not finite.
 * @returns {number} the numeric value.
 */
function numeric(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}
