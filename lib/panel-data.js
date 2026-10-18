// dsh-handoff-review — M2 panel/diff payload builders.
//
// Pure, bounded JSON builders for the right-sidebar panel, the diff drawer and
// the round-history view. Diff data reuses the M1 handoff builder so the panel
// shows exactly what was/will be handed off (same LCS diff, redaction and
// per-file cap). Every preview is bounded; nothing here throws on missing
// input.
//
// Plain ESM, no build step; only the relative handoff-builder import is used.

import { collectChangedFiles, renderFileDiff } from './handoff-builder.js';

/** Default maximum number of rounds returned by the panel history. */
const ROUND_HISTORY_LIMIT = 20;

/** Maximum characters of one round preview (report/handoff teaser). */
const ROUND_PREVIEW_CHARS = 400;

/** Maximum characters of the expanded handoff/report snapshot in a panel payload. */
const PANEL_TEXT_LIMIT = 4000;

/** Ellipsis appended to a shortened round preview. */
const PREVIEW_ELLIPSIS = '…';

/** Truncation note appended to a bounded panel snapshot. */
const PANEL_TRUNCATION_NOTE = '\n\n…（已截斷）';

/**
 * Build the panel round-history list, newest first (input order, which is the
 * `listRounds()` order). Each item carries the full report for expansion plus
 * bounded report/handoff previews.
 *
 * @param {Array<object>} rounds round records from the history store.
 * @param {{ limit?: number }} [options] maximum items (default 20; `0` yields none).
 * @returns {Array<{
 *   round: number,
 *   status: 'handoff' | 'feedback',
 *   createdAt: number,
 *   updatedAt: number,
 *   report: string | null,
 *   reportPreview: string,
 *   handoffPreview: string,
 *   hasReport: boolean,
 *   hasHandoff: boolean,
 * }>} plain-JSON history items.
 */
export function buildRoundHistory(rounds, options = {}) {
  const list = Array.isArray(rounds) ? rounds : [];
  const settings = options && typeof options === 'object' ? options : {};
  const limit = Number.isFinite(settings.limit) && settings.limit >= 0
    ? Math.floor(settings.limit)
    : ROUND_HISTORY_LIMIT;
  const items = [];
  for (const record of list) {
    if (items.length >= limit) break;
    const item = toRoundHistoryItem(record);
    if (item !== null) items.push(item);
  }
  return items;
}

/**
 * Summarize changed files for the panel: `{ path, added, removed }` per path,
 * reusing the handoff builder's merge/count rules and `sinceSeq` watermark.
 *
 * @param {Array<object>} entries diff-projection entries.
 * @param {{ sinceSeq?: number }} [options] watermark selector.
 * @returns {Array<{ path: string, added: number, removed: number }>} file summaries.
 */
export function buildChangedFileSummaries(entries, options = {}) {
  const settings = options && typeof options === 'object' ? options : {};
  return collectChangedFiles(entries, { sinceSeq: settings.sinceSeq })
    .map((file) => ({ path: file.path, added: file.added, removed: file.removed }));
}

/**
 * Build the diff drawer files: every changed file plus its rendered fenced
 * unified diff (per-file capped, secrets redacted, created-file hydration
 * markers preserved).
 *
 * @param {Array<object>} entries diff-projection entries.
 * @param {{ sinceSeq?: number, perFileChars?: number }} [options] watermark and per-file cap.
 * @returns {Array<{ path: string, added: number, removed: number, diff: string }>} diff files.
 */
export function buildDiffFiles(entries, options = {}) {
  const settings = options && typeof options === 'object' ? options : {};
  const perFileChars = positiveInteger(settings.perFileChars, 6000);
  return collectChangedFiles(entries, { sinceSeq: settings.sinceSeq }).map((file) => ({
    path: file.path,
    added: file.added,
    removed: file.removed,
    diff: renderFileDiff(file, { perFileChars }),
  }));
}

/**
 * Build the sidebar panel payload. Shapes match the M2 HTTP panel contract;
 * the route adds `ok: true`. The expanded `handoff` and `report` snapshots are
 * bounded to 4000 characters (the `report` in each round item stays full for
 * expansion).
 *
 * @param {{
 *   link?: object | null,
 *   links?: Array<object>,
 *   role?: 'impl' | 'review' | null,
 *   rounds?: Array<object>,
 *   handoff?: string,
 *   report?: string,
 *   changedFiles?: Array<object>,
 *   reviewer?: { provider?: string, model?: string, preset?: string },
 *   maxRounds?: number,
 * }} [options] panel inputs.
 * @returns {{
 *   link: object | null,
 *   links: Array<object>,
 *   role: 'impl' | 'review' | null,
 *   rounds: Array<object>,
 *   handoff: string,
 *   report: string,
 *   changedFiles: Array<object>,
 *   reviewer: { provider: string, model: string, preset: string },
 *   maxRounds: number,
 * }} plain-JSON panel payload (without `ok`).
 */
export function buildPanelPayload(options = {}) {
  const input = options && typeof options === 'object' ? options : {};
  return {
    link: isPlainObject(input.link) ? input.link : null,
    links: arrayOfObjects(input.links),
    role: input.role === 'impl' || input.role === 'review' ? input.role : null,
    rounds: arrayOfObjects(input.rounds),
    handoff: boundedText(input.handoff, PANEL_TEXT_LIMIT),
    report: boundedText(input.report, PANEL_TEXT_LIMIT),
    changedFiles: arrayOfObjects(input.changedFiles),
    reviewer: normalizeReviewer(input.reviewer),
    maxRounds: positiveInteger(input.maxRounds, 3),
  };
}

/**
 * Build the diff-drawer payload. Shapes match the M2 HTTP diff contract; the
 * route adds `ok: true`.
 *
 * @param {{ round?: number, files?: Array<object> }} [options] diff inputs.
 * @returns {{ round: number, files: Array<{ path: string, added: number, removed: number, diff: string }> }} plain-JSON diff payload (without `ok`).
 */
export function buildDiffPayload(options = {}) {
  const input = options && typeof options === 'object' ? options : {};
  const round = Number.isFinite(input.round) && input.round > 0 ? Math.floor(input.round) : 1;
  const files = Array.isArray(input.files) ? input.files : [];
  return {
    round,
    files: files.filter((file) => isPlainObject(file)).map((file) => ({
      path: typeof file.path === 'string' ? file.path : '',
      added: Number.isFinite(file.added) ? file.added : 0,
      removed: Number.isFinite(file.removed) ? file.removed : 0,
      diff: typeof file.diff === 'string' ? file.diff : '',
    })),
  };
}

/**
 * Normalize one history round record into a panel item.
 * @param {unknown} record stored round record.
 * @returns {object | null} the item, or null for a malformed record.
 */
function toRoundHistoryItem(record) {
  if (!isPlainObject(record)) return null;
  const report = typeof record.report === 'string' && record.report !== '' ? record.report : null;
  const handoff = typeof record.handoff === 'string' ? record.handoff : '';
  return {
    round: Number.isFinite(record.round) && record.round >= 1 ? Math.floor(record.round) : 1,
    status: record.status === 'feedback' ? 'feedback' : 'handoff',
    createdAt: numeric(record.createdAt),
    updatedAt: numeric(record.updatedAt),
    report,
    reportPreview: preview(report ?? ''),
    handoffPreview: preview(handoff),
    hasReport: report !== null && report.trim() !== '',
    hasHandoff: handoff.trim() !== '',
  };
}

/**
 * Shorten one text to a bounded round preview.
 * @param {string} text source text.
 * @returns {string} at most 400 characters.
 */
function preview(text) {
  if (typeof text !== 'string' || text.length === 0) return '';
  if (text.length <= ROUND_PREVIEW_CHARS) return text;
  const room = ROUND_PREVIEW_CHARS - PREVIEW_ELLIPSIS.length;
  return `${cutAtLine(text, room)}${PREVIEW_ELLIPSIS}`;
}

/**
 * Coerce a value into a bounded string snapshot.
 * @param {unknown} value candidate text.
 * @param {number} limit character limit.
 * @returns {string} bounded text.
 */
function boundedText(value, limit) {
  const text = typeof value === 'string' ? value : value === undefined || value === null ? '' : String(value);
  if (text.length <= limit) return text;
  const room = Math.max(0, limit - PANEL_TRUNCATION_NOTE.length);
  return `${cutAtLine(text, room)}${PANEL_TRUNCATION_NOTE}`;
}

/**
 * Cut text to at most `limit` characters at a line boundary.
 * @param {string} text source text.
 * @param {number} limit character limit.
 * @returns {string} cut text.
 */
function cutAtLine(text, limit) {
  if (!(limit > 0)) return '';
  if (text.length <= limit) return text;
  const cut = text.slice(0, limit);
  const newline = cut.lastIndexOf('\n');
  if (newline > 0) return cut.slice(0, newline);
  return cut;
}

/**
 * Normalize the reviewer route descriptor.
 * @param {unknown} reviewer candidate reviewer input.
 * @returns {{ provider: string, model: string, preset: string }} the normalized descriptor.
 */
function normalizeReviewer(reviewer) {
  const source = isPlainObject(reviewer) ? reviewer : {};
  return {
    provider: textValue(source.provider, source.reviewerProvider),
    model: textValue(source.model, source.reviewerModel),
    preset: textValue(source.preset, source.reviewerPreset),
  };
}

/**
 * Return the first non-empty string candidate, else an empty string.
 * @param {...unknown} values candidate values.
 * @returns {string} normalized text.
 */
function textValue(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
  }
  return '';
}

/**
 * Filter an array down to plain objects.
 * @param {unknown} value candidate array.
 * @returns {object[]} the filtered copy.
 */
function arrayOfObjects(value) {
  return Array.isArray(value) ? value.filter((item) => isPlainObject(item)) : [];
}

/**
 * Object guard that excludes arrays and null.
 * @param {unknown} value candidate.
 * @returns {boolean} whether the value is a plain object.
 */
function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Read a finite number, defaulting to 0.
 * @param {unknown} value candidate.
 * @returns {number} the numeric value.
 */
function numeric(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/**
 * Read a positive integer, falling back to a default.
 * @param {unknown} value candidate.
 * @param {number} fallback default value.
 * @returns {number} the positive integer.
 */
function positiveInteger(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}
