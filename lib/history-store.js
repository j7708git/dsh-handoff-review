// dsh-handoff-review — durable M2 state: round history and settings overrides.
//
// Two plugin-owned storage domains live here (profile YAML is never edited):
// - `handoff_review_history` / table `rounds`: one snapshot record per
//   `<linkId>:<round>` carrying the delivered handoff and the reviewer report.
// - `handoff_review_settings` / table `settings`: one `settings` record holding
//   a *partial* config override merged over the composition config at apply.
//
// The two pure helpers of `@deepseek-ai/dsh-storage-domain` are reused from
// `./link-store.js` (the plugin cannot rely on resolving dsh internals from a
// profile bundle). Writes go through the domain's serialized `table.put`, and
// every stored record is plain JSON with bounded text (`HISTORY_TEXT_LIMIT`).
//
// Plain ESM, no build step. Only `zod` and relative imports are used.

import { z } from 'zod';
import { defineDomain, domainTable } from './link-store.js';

/** Storage domain name that owns round history. */
export const HISTORY_DOMAIN = 'handoff_review_history';

/** Table name holding one record per link round, keyed by `<linkId>:<round>`. */
export const ROUNDS_TABLE = 'rounds';

/** Storage domain name that owns the persisted settings override. */
export const SETTINGS_DOMAIN = 'handoff_review_settings';

/** Table name holding the single `settings` record. */
export const SETTINGS_TABLE = 'settings';

/** Maximum characters kept for one handoff or report snapshot. */
export const HISTORY_TEXT_LIMIT = 20000;

/** Single record key of the settings table. */
const SETTINGS_KEY = 'settings';

/** Marker appended when a text snapshot is capped. */
const TRUNCATION_NOTE = '\n…（已截斷）';

/** Settings-table keys accepted in the partial config override. */
const SETTINGS_KEYS = [
  'reviewerProvider',
  'reviewerModel',
  'reviewerReasoningEffort',
  'reviewerPreset',
  'maxRounds',
  'maxHandoffChars',
  'diffPerFileChars',
  'autoSummarize',
  'readOnlyReviewer',
  'autoContinue',
  'maxDeliveriesPerMinute',
];

/**
 * Error raised by the history/settings store.
 *
 * `code` is the stable discriminant callers switch on: `storage-unavailable`
 * for a missing service or a failed domain operation, `invalid-record` for a
 * record that does not satisfy its schema.
 */
export class HistoryStoreError extends Error {
  /**
   * @param {string} code stable error code.
   * @param {string} message human-readable diagnostic detail.
   * @param {ErrorOptions} [options] standard `cause` carrier.
   */
  constructor(code, message, options) {
    super(message, options);
    this.name = 'HistoryStoreError';
    /** @type {string} */
    this.code = code;
  }
}

/**
 * One durable round snapshot (DEVELOPMENT.md §5.3 round history).
 * Text fields are capped at `HISTORY_TEXT_LIMIT` before storage.
 */
export const roundRecordSchema = z.object({
  version: z.literal(1),
  linkId: z.string().min(1),
  round: z.number().int().min(1),
  implSessionId: z.string().min(1),
  reviewSessionId: z.string().nullable(),
  handoff: z.string(),
  report: z.string().nullable(),
  status: z.enum(['handoff', 'feedback']),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
});

/** Partial config override accepted by the settings record (the eleven config fields). */
const partialConfigSchema = z.object({
  reviewerProvider: z.string().max(200).optional(),
  reviewerModel: z.string().max(200).optional(),
  reviewerReasoningEffort: z.string().max(50).optional(),
  reviewerPreset: z.string().max(200).optional(),
  maxRounds: z.number().int().min(1).max(20).optional(),
  maxHandoffChars: z.number().int().min(1000).max(200000).optional(),
  diffPerFileChars: z.number().int().min(100).max(50000).optional(),
  autoSummarize: z.boolean().optional(),
  readOnlyReviewer: z.boolean().optional(),
  autoContinue: z.boolean().optional(),
  maxDeliveriesPerMinute: z.number().int().min(1).max(60).optional(),
});

/**
 * The single durable settings record: a partial config override plus its
 * update stamp.
 */
export const settingsRecordSchema = z.object({
  version: z.literal(1),
  updatedAt: z.number().int().nonnegative(),
  config: partialConfigSchema,
});

/**
 * Compose the storage key of one round snapshot.
 *
 * @param {string} linkId link id.
 * @param {number} round 1-based round number.
 * @returns {string} the `<linkId>:<round>` key.
 */
export function roundKey(linkId, round) {
  return `${String(linkId)}:${String(round)}`;
}

/**
 * Build one round snapshot (pure). `handoff` and `report` are capped at
 * `HISTORY_TEXT_LIMIT` (cut at a line boundary with a `（已截斷）` marker), and
 * `status` is `feedback` exactly when a report is present.
 *
 * @param {{
 *   linkId?: string,
 *   round?: number,
 *   implSessionId?: string,
 *   reviewSessionId?: string | null,
 *   handoff?: string,
 *   report?: string | null,
 *   createdAt?: number,
 *   now?: number,
 * }} [options] snapshot fields.
 * @returns {object} the round record (not yet validated by the store).
 */
export function createRoundRecord(options = {}) {
  const input = options && typeof options === 'object' ? options : {};
  const now = Number.isFinite(input.now) ? input.now : Date.now();
  const handoff = capHistoryText(input.handoff === undefined || input.handoff === null ? '' : input.handoff);
  const report = input.report === undefined || input.report === null || input.report === ''
    ? null
    : capHistoryText(input.report);
  return {
    version: 1,
    linkId: String(input.linkId ?? ''),
    round: normalizeRound(input.round),
    implSessionId: String(input.implSessionId ?? ''),
    reviewSessionId: input.reviewSessionId === undefined || input.reviewSessionId === null
      ? null
      : String(input.reviewSessionId),
    handoff,
    report,
    status: report === null ? 'handoff' : 'feedback',
    createdAt: Number.isFinite(input.createdAt) ? Math.floor(input.createdAt) : now,
    updatedAt: now,
  };
}

/**
 * Attach a reviewer report to a round snapshot (pure). The report is capped at
 * `HISTORY_TEXT_LIMIT`, the status becomes `feedback`, and `updatedAt` is the
 * supplied stamp (default `Date.now()`).
 *
 * @param {object} record existing round snapshot.
 * @param {string | null | undefined} report reviewer report text.
 * @param {number} [now] epoch milliseconds to stamp.
 * @returns {object} the updated record; the input is never mutated.
 */
export function applyRoundFeedback(record, report, now = Date.now()) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    throw new HistoryStoreError('invalid-record', 'Cannot attach feedback to an empty round record');
  }
  const stamp = Number.isFinite(now) ? Math.floor(now) : Date.now();
  const reportText = capHistoryText(report === undefined || report === null ? '' : report);
  return {
    ...record,
    report: reportText,
    status: 'feedback',
    updatedAt: stamp,
  };
}

/**
 * Open both plugin-owned domains and return the history/settings store.
 *
 * Store methods: `putRound(record)` / `getRound(linkId, round)` (sync read) /
 * `listRounds(linkId)` (newest first) / `getSettings()` (partial override,
 * `{}` when unset) / `putSettings(config)` / `close()`. A missing storage
 * service or a failed domain operation rejects with `HistoryStoreError`
 * `code: 'storage-unavailable'`.
 *
 * @param {{ open: (spec: object) => Promise<object> } | undefined} storageDomain the `ctx.storageDomain` service.
 * @returns {Promise<{
 *   putRound: (record: object) => Promise<object>,
 *   getRound: (linkId: string, round: number) => object | undefined,
 *   listRounds: (linkId: string) => object[],
 *   getSettings: () => object,
 *   putSettings: (config: object) => Promise<object>,
 *   close: () => Promise<void>,
 * }>} the store facade.
 */
export async function openHistoryStore(storageDomain) {
  if (!storageDomain || typeof storageDomain.open !== 'function') {
    throw new HistoryStoreError(
      'storage-unavailable',
      'storageDomain service is unavailable; mount the storage-domain plugin in this profile',
    );
  }

  let roundDomain;
  try {
    roundDomain = await storageDomain.open(historyDomainSpec());
  } catch (error) {
    throw toHistoryStoreError(error, 'Failed to open the round-history domain');
  }

  let settingsDomain;
  try {
    settingsDomain = await storageDomain.open(settingsDomainSpec());
  } catch (error) {
    await closeQuietly(roundDomain);
    throw toHistoryStoreError(error, 'Failed to open the settings domain');
  }

  let roundsTable;
  let settingsTable;
  try {
    roundsTable = requireTable(roundDomain, ROUNDS_TABLE);
    settingsTable = requireTable(settingsDomain, SETTINGS_TABLE);
  } catch (error) {
    await closeQuietly(roundDomain);
    await closeQuietly(settingsDomain);
    throw toHistoryStoreError(error);
  }

  return createHistoryStore({
    roundDomain,
    settingsDomain,
    roundsTable,
    settingsTable,
  });
}

/**
 * Build the round-history storage domain spec.
 * @returns {{ name: string, version: number, tables: Record<string, { valueSchema: object }> }} the domain spec.
 */
function historyDomainSpec() {
  return defineDomain({
    name: HISTORY_DOMAIN,
    version: 1,
    tables: {
      [ROUNDS_TABLE]: domainTable(roundRecordSchema),
    },
  });
}

/**
 * Build the settings storage domain spec.
 * @returns {{ name: string, version: number, tables: Record<string, { valueSchema: object }> }} the domain spec.
 */
function settingsDomainSpec() {
  return defineDomain({
    name: SETTINGS_DOMAIN,
    version: 1,
    tables: {
      [SETTINGS_TABLE]: domainTable(settingsRecordSchema),
    },
  });
}

/**
 * Build the store facade around the two opened domains.
 *
 * @param {{
 *   roundDomain: { close: () => Promise<void> },
 *   settingsDomain: { close: () => Promise<void> },
 *   roundsTable: object,
 *   settingsTable: object,
 * }} parts opened domain/table handles.
 * @returns {object} the store facade.
 */
function createHistoryStore(parts) {
  const { roundDomain, settingsDomain, roundsTable, settingsTable } = parts;
  let closed = false;

  /** @returns {void} */
  function assertOpen() {
    if (closed) throw new HistoryStoreError('storage-unavailable', 'history store is already closed');
  }

  return {
    /**
     * Validate and store one round snapshot. A malformed record rejects with
     * `code: 'invalid-record'`; a storage failure rejects with
     * `code: 'storage-unavailable'`.
     * @param {object} record the round record.
     * @returns {Promise<object>} the validated stored record.
     */
    async putRound(record) {
      assertOpen();
      const parsed = parseRoundRecord(record);
      try {
        await roundsTable.put(roundKey(parsed.linkId, parsed.round), parsed);
      } catch (error) {
        throw toHistoryStoreError(error);
      }
      return parsed;
    },

    /**
     * Read one round snapshot synchronously.
     * @param {string} linkId link id.
     * @param {number} round 1-based round number.
     * @returns {object | undefined} the stored record, when present.
     */
    getRound(linkId, round) {
      assertOpen();
      try {
        return roundsTable.get(roundKey(linkId, round));
      } catch (error) {
        throw toHistoryStoreError(error);
      }
    },

    /**
     * List one link's round snapshots, newest round first (ties by
     * `updatedAt` descending).
     * @param {string} linkId link id.
     * @returns {object[]} round records of this link.
     */
    listRounds(linkId) {
      assertOpen();
      const id = String(linkId ?? '');
      let entries;
      try {
        entries = [...roundsTable.entries()];
      } catch (error) {
        throw toHistoryStoreError(error);
      }
      return entries
        .map(([, record]) => record)
        .filter((record) => record && typeof record === 'object' && record.linkId === id)
        .sort((left, right) => (
          numeric(right.round) - numeric(left.round)
          || numeric(right.updatedAt) - numeric(left.updatedAt)
        ));
    },

    /**
     * Read the persisted settings record (its `config` field is the partial
     * override). Returns `undefined` when nothing was saved or the stored
     * record is unusable, so the caller falls back to the composition config.
     * @returns {{ version: number, updatedAt: number, config: object } | undefined} the settings record.
     */
    getSettings() {
      assertOpen();
      let record;
      try {
        record = settingsTable.get(SETTINGS_KEY);
      } catch (error) {
        throw toHistoryStoreError(error);
      }
      if (!record || typeof record !== 'object' || !record.config || typeof record.config !== 'object') {
        return undefined;
      }
      return {
        version: 1,
        updatedAt: numeric(record.updatedAt),
        config: { ...record.config },
      };
    },

    /**
     * Persist a partial config override. Only the eleven documented config keys
     * are kept; the record is validated before the serialized write.
     * @param {object} config partial config override.
     * @returns {Promise<object>} the stored settings record.
     */
    async putSettings(config) {
      assertOpen();
      const record = {
        version: 1,
        updatedAt: Date.now(),
        config: normalizePartialConfig(config),
      };
      const parsed = parseSettingsRecord(record);
      try {
        await settingsTable.put(SETTINGS_KEY, parsed);
      } catch (error) {
        throw toHistoryStoreError(error);
      }
      return parsed;
    },

    /**
     * Close both domains. Idempotent; later reads and writes reject with
     * `code: 'storage-unavailable'`.
     * @returns {Promise<void>} resolution after both domains are released.
     */
    async close() {
      if (closed) return;
      closed = true;
      const results = await Promise.allSettled([roundDomain.close(), settingsDomain.close()]);
      const failure = results.find((result) => result.status === 'rejected');
      if (failure) throw toHistoryStoreError(failure.reason);
    },
  };
}

/**
 * Resolve one declared table of an opened domain.
 * @param {object} domain opened domain handle.
 * @param {string} tableName declared table name.
 * @returns {object} the table handle.
 */
function requireTable(domain, tableName) {
  if (!domain || typeof domain.table !== 'function') {
    throw new HistoryStoreError('storage-unavailable', 'storage domain did not expose a table handle');
  }
  const table = domain.table(tableName);
  if (
    !table
    || typeof table.get !== 'function'
    || typeof table.put !== 'function'
    || typeof table.entries !== 'function'
  ) {
    throw new HistoryStoreError('storage-unavailable', `table "${tableName}" is not a usable domain table`);
  }
  return table;
}

/**
 * Cap a text snapshot at `HISTORY_TEXT_LIMIT`, cutting at a line boundary and
 * marking the truncation. Values are coerced to strings (never throws).
 * @param {unknown} value candidate text.
 * @returns {string} bounded text.
 */
function capHistoryText(value) {
  const text = typeof value === 'string' ? value : value === undefined || value === null ? '' : String(value);
  if (text.length <= HISTORY_TEXT_LIMIT) return text;
  const room = Math.max(0, HISTORY_TEXT_LIMIT - TRUNCATION_NOTE.length);
  return `${cutAtLine(text, room)}${TRUNCATION_NOTE}`;
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
 * Normalize a round number to a positive integer (fallback 1).
 * @param {unknown} value candidate.
 * @returns {number} the round number.
 */
function normalizeRound(value) {
  const round = Number(value);
  return Number.isInteger(round) && round >= 1 ? round : 1;
}

/**
 * Keep only the eleven known config keys with defined values.
 * @param {unknown} config candidate partial config.
 * @returns {object} the filtered override.
 */
function normalizePartialConfig(config) {
  const source = config && typeof config === 'object' && !Array.isArray(config) ? config : {};
  const partial = {};
  for (const key of SETTINGS_KEYS) {
    if (Object.prototype.hasOwnProperty.call(source, key) && source[key] !== undefined && source[key] !== null) {
      partial[key] = source[key];
    }
  }
  return partial;
}

/**
 * Validate one round record with `HistoryStoreError('invalid-record')` on
 * schema violations.
 * @param {unknown} value candidate record.
 * @returns {object} the validated record.
 */
function parseRoundRecord(value) {
  const result = roundRecordSchema.safeParse(value);
  if (!result.success) throw invalidRecordError('round', result.error);
  return result.data;
}

/**
 * Validate one settings record with `HistoryStoreError('invalid-record')` on
 * schema violations.
 * @param {unknown} value candidate record.
 * @returns {object} the validated record.
 */
function parseSettingsRecord(value) {
  const result = settingsRecordSchema.safeParse(value);
  if (!result.success) throw invalidRecordError('settings', result.error);
  return result.data;
}

/**
 * Build the schema-failure error for one record family.
 * @param {string} family record family name.
 * @param {{ issues: Array<{ path: Array<string | number>, message: string }> }} error zod failure.
 * @returns {HistoryStoreError} the error.
 */
function invalidRecordError(family, error) {
  const issue = error && Array.isArray(error.issues) ? error.issues[0] : undefined;
  const path = issue && Array.isArray(issue.path) && issue.path.length > 0 ? ` at ${issue.path.join('.')}` : '';
  return new HistoryStoreError(
    'invalid-record',
    `Invalid ${family} record${path}: ${issue ? issue.message : 'schema validation failed'}`,
  );
}

/**
 * Close a domain without masking an earlier failure.
 * @param {object | undefined} domain opened domain handle.
 * @returns {Promise<void>} resolution after the best-effort close.
 */
async function closeQuietly(domain) {
  if (!domain || typeof domain.close !== 'function') return;
  try {
    await domain.close();
  } catch {
    // The original open failure is the error worth reporting.
  }
}

/**
 * Translate a thrown value into a `HistoryStoreError` (passing store errors
 * through unchanged).
 * @param {unknown} error thrown value.
 * @param {string} [context] optional operation description.
 * @returns {HistoryStoreError} the store error.
 */
function toHistoryStoreError(error, context) {
  if (error instanceof HistoryStoreError) return error;
  const message = error instanceof Error ? error.message : String(error);
  const prefix = context ? `${context}: ` : '';
  return new HistoryStoreError('storage-unavailable', `${prefix}${message}`, { cause: error });
}

/**
 * Read a finite number, defaulting to 0.
 * @param {unknown} value candidate.
 * @returns {number} the numeric value.
 */
function numeric(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}
