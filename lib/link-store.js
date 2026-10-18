// dsh-handoff-review — durable link records and the link state machine.
//
// LinkRecord rows live in the host storage domain (`handoff_review.links`).
// The transition function is pure so the state machine can be unit-tested
// without a backend; the store facade adds domain-backed reads and serialized
// writes (`table.update` / `table.put`, never a separate get + put for a
// transition).
//
// Plain ESM, no build step. Only `zod` and `node:crypto` are imported. The two
// trivial pure helpers of `@deepseek-ai/dsh-storage-domain` (`defineDomain`,
// `domainTable`) are replicated locally instead of importing the package:
// third-party bundles cannot rely on resolving dsh internals (see
// and the project's internal design notes).

import { randomBytes } from 'node:crypto';
import { z } from 'zod';

/** Storage domain name that owns this plugin's durable state. */
export const LINK_DOMAIN = 'handoff_review';

/** Table name holding one record per link, keyed by link id. */
export const LINKS_TABLE = 'links';

/** Every link lifecycle status, in state-machine order. */
export const LINK_STATUSES = [
  'creating',
  'open',
  'reviewing',
  'feedback_ready',
  'feedback_sent',
  'closed',
  'failed',
  'stale',
];

/** Statuses that count as "this implementation session already has a link". */
export const ACTIVE_STATUSES = [
  'creating',
  'open',
  'reviewing',
  'feedback_ready',
  'feedback_sent',
];

/** Crockford base32 alphabet (ULID layout: no I, L, O, U). */
const CROCKFORD_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** Fields a caller may never overwrite through `patch`/transition extras. */
const IMMUTABLE_FIELDS = new Set(['id', 'version', 'createdAt', 'implSessionId']);

/** Local approximation of the storage-domain unit/table name rule. */
const UNIT_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * Error raised by the link store and by the pure state machine.
 *
 * `code` is the stable discriminant callers switch on:
 * `invalid-transition`, `not-found`, `duplicate`, `storage-unavailable` or
 * `invalid-record`.
 */
export class LinkStoreError extends Error {
  /**
   * @param {string} code stable error code.
   * @param {string} message human-readable diagnostic detail.
   * @param {ErrorOptions} [options] standard `cause` carrier.
   */
  constructor(code, message, options) {
    super(message, options);
    this.name = 'LinkStoreError';
    /** @type {string} */
    this.code = code;
  }
}

/** Durable record for one implementation session <-> review session link (DEVELOPMENT.md §8.1). */
export const linkRecordSchema = z.object({
  version: z.literal(1),
  id: z.string().min(1),
  implSessionId: z.string().min(1),
  reviewSessionId: z.string().nullable(),
  workspaceId: z.string().nullable(),
  cwd: z.string(),
  status: z.enum(LINK_STATUSES),
  round: z.number().int().min(1),
  focus: z.string().nullable(),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
  lastHandoffSeq: z.number().int().min(-1),
  lastFeedbackSeq: z.number().int().min(-1).nullable(),
  reviewerProvider: z.string().nullable(),
  reviewerModel: z.string().nullable(),
  lastError: z.string().nullable(),
  closedAt: z.number().int().nonnegative().nullable(),
});

/**
 * Declare one domain table. Local replica of the pure
 * `@deepseek-ai/dsh-storage-domain` helper: it only carries the zod record
 * schema, which the opened domain uses to validate stored records.
 *
 * @param {object} valueSchema zod schema validating every stored record of the table.
 * @returns {{ valueSchema: object }} the table declaration.
 */
export function domainTable(valueSchema) {
  if (!valueSchema || typeof valueSchema !== 'object' || typeof valueSchema.parse !== 'function') {
    throw new TypeError('domainTable: valueSchema must be a zod schema');
  }
  return { valueSchema };
}

/**
 * Identity helper for a domain spec. Local replica of the pure
 * `@deepseek-ai/dsh-storage-domain` helper: misconfiguration fails loud at
 * module/factory load, before any medium is touched.
 *
 * @param {{ name: string, version: number, tables: Record<string, object> }} spec domain declaration.
 * @returns {{ name: string, version: number, tables: Record<string, object> }} the same spec.
 */
export function defineDomain(spec) {
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) {
    throw new TypeError('defineDomain: spec must be an object');
  }
  if (typeof spec.name !== 'string' || !UNIT_NAME_RE.test(spec.name)) {
    throw new TypeError(`defineDomain: invalid domain name "${String(spec.name)}"`);
  }
  if (!Number.isInteger(spec.version) || spec.version < 0) {
    throw new TypeError('defineDomain: version must be a non-negative integer');
  }
  if (!spec.tables || typeof spec.tables !== 'object' || Array.isArray(spec.tables)) {
    throw new TypeError('defineDomain: tables must be an object');
  }
  for (const [tableName, table] of Object.entries(spec.tables)) {
    if (!UNIT_NAME_RE.test(tableName)) {
      throw new TypeError(`defineDomain: invalid table name "${tableName}"`);
    }
    if (!table || typeof table !== 'object' || !table.valueSchema || typeof table.valueSchema.parse !== 'function') {
      throw new TypeError(`defineDomain: table "${tableName}" needs a zod valueSchema`);
    }
  }
  return spec;
}

/**
 * Build the storage domain spec that owns link records.
 *
 * @returns {{ name: string, version: number, tables: Record<string, { valueSchema: object }> }} the domain spec.
 */
export function linkDomainSpec() {
  return defineDomain({
    name: LINK_DOMAIN,
    version: 1,
    tables: {
      [LINKS_TABLE]: domainTable(linkRecordSchema),
    },
  });
}

/**
 * Generate a new link id: `hr_` plus a 26-character Crockford base32 ULID
 * (10 timestamp chars from a 48-bit epoch-ms value, 16 random chars from 80
 * random bits).
 *
 * @param {number} [now] epoch milliseconds to stamp; defaults to `Date.now()`.
 * @returns {string} the link id.
 */
export function newLinkId(now = Date.now()) {
  const stamp = Number.isFinite(now) ? Math.max(0, Math.floor(now)) : Date.now();
  const time = encodeCrockford(BigInt(stamp), 10);
  return `hr_${time}${encodeCrockford(randomBits(), 16)}`;
}

/**
 * Legal transitions of the link state machine (DEVELOPMENT.md §8.3 plus the
 * shared-contract extras): event -> from status -> target status.
 */
const LINK_TRANSITIONS = {
  delivered: { creating: 'reviewing' },
  open: { creating: 'open' },
  failure: {
    creating: 'failed',
    open: 'failed',
    reviewing: 'failed',
    feedback_ready: 'failed',
    feedback_sent: 'failed',
  },
  'feedback-ready': { reviewing: 'feedback_ready', open: 'feedback_ready' },
  'feedback-sent': { feedback_ready: 'feedback_sent' },
  revision: {
    feedback_ready: 'reviewing',
    feedback_sent: 'reviewing',
    open: 'reviewing',
    reviewing: 'reviewing',
  },
  close: {
    creating: 'closed',
    open: 'closed',
    reviewing: 'closed',
    feedback_ready: 'closed',
    feedback_sent: 'closed',
  },
  reopen: { closed: 'open' },
  stale: {
    creating: 'stale',
    open: 'stale',
    reviewing: 'stale',
    feedback_ready: 'stale',
    feedback_sent: 'stale',
  },
  retry: { failed: 'creating', stale: 'creating' },
};

/**
 * Apply one state-machine event to a link record. Pure: the input record is
 * never mutated and a new record is returned.
 *
 * Accepted `extra` fields:
 * - `now`: stamped into `updatedAt` (and `closedAt` for `close`); any finite
 *   number is accepted, otherwise `Date.now()`.
 * - `reviewSessionId` (`delivered` / `open`): stored when supplied.
 * - `lastError` or `error` (`failure`; `lastError` also for `stale`):
 *   failure text stored in `lastError`.
 * - `lastFeedbackSeq` (`feedback-sent`): review-side report watermark.
 * - `lastHandoffSeq` (`revision`): implementation-side diff watermark.
 *
 * `id`, `version`, `createdAt` and `implSessionId` in `extra` are ignored.
 * `lastHandoffSeq` is copied by `delivered`, `open` and `revision`; `lastFeedbackSeq`
 * by `feedback-sent` and `revision`.
 * Unknown events and illegal from-states throw
 * `LinkStoreError` with `code: 'invalid-transition'`.
 *
 * @param {object} record current link record.
 * @param {string} event transition name.
 * @param {object} [extra] transition payload.
 * @returns {object} the next link record.
 */
export function applyLinkTransition(record, event, extra = {}) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    throw new LinkStoreError('invalid-transition', `Cannot apply transition "${String(event)}" to an empty record`);
  }
  const eventName = typeof event === 'string' ? event : String(event);
  const allowed = Object.prototype.hasOwnProperty.call(LINK_TRANSITIONS, eventName)
    ? LINK_TRANSITIONS[eventName]
    : undefined;
  const from = record.status;
  const target = allowed && Object.prototype.hasOwnProperty.call(allowed, String(from)) ? allowed[String(from)] : undefined;
  if (typeof target !== 'string') {
    throw new LinkStoreError(
      'invalid-transition',
      `Transition "${eventName}" is not legal from status "${String(from)}"`,
    );
  }

  const extras = extra && typeof extra === 'object' && !Array.isArray(extra) ? extra : {};
  const now = Number.isFinite(extras.now) ? extras.now : Date.now();
  const next = { ...record, status: target, updatedAt: now };

  if (eventName === 'delivered' || eventName === 'open') {
    if (typeof extras.reviewSessionId === 'string' && extras.reviewSessionId !== '') {
      next.reviewSessionId = extras.reviewSessionId;
    }
    // The first handoff watermark must be persisted here: revision sends only
    // changes after this seq (DEVELOPMENT.md §7.3 step 2, G5).
    if (Number.isFinite(extras.lastHandoffSeq)) next.lastHandoffSeq = extras.lastHandoffSeq;
  }
  if (eventName === 'delivered') {
    next.lastError = null;
  }
  if (eventName === 'failure') {
    next.lastError = firstText(extras.lastError, extras.error) ?? 'unknown error';
  }
  if (eventName === 'feedback-ready') {
    next.lastError = null;
    // `lastFeedbackSeq` is the watermark of the last report DELIVERED to the
    // impl session; it is advanced only by `feedback-sent`, so a stale report
    // cannot be promoted or re-sent as a new round.
  }
  if (eventName === 'feedback-sent') {
    if (Number.isFinite(extras.lastFeedbackSeq)) next.lastFeedbackSeq = extras.lastFeedbackSeq;
  }
  if (eventName === 'revision') {
    next.round = Number.isFinite(record.round) ? record.round + 1 : 1;
    if (Number.isFinite(extras.lastHandoffSeq)) next.lastHandoffSeq = extras.lastHandoffSeq;
    // The revision consumes every reviewer reply up to delivery: anything the
    // reviewer emits before the new round starts must not be promoted later.
    if (Number.isFinite(extras.lastFeedbackSeq)) next.lastFeedbackSeq = extras.lastFeedbackSeq;
    next.lastError = null;
  }
  if (eventName === 'close') {
    next.closedAt = now;
  }
  if (eventName === 'reopen') {
    next.closedAt = null;
  }
  if (eventName === 'stale') {
    if (typeof extras.lastError === 'string' && extras.lastError !== '') next.lastError = extras.lastError;
  }
  return next;
}

/**
 * Open the link storage domain and return the store facade.
 *
 * The returned store exposes synchronous reads (`get`, `list`,
 * `getActiveForImpl`, `getByReviewSession`) and serialized async writes
 * (`create`, `patch`, `transition`, `close`). Missing storage service or a
 * failed domain open rejects with `LinkStoreError` `code:
 * 'storage-unavailable'`.
 *
 * @param {{ open: (spec: object) => Promise<object> } | undefined} storageDomain the `ctx.storageDomain` service.
 * @returns {Promise<{
 *   get: (id: string) => object | undefined,
 *   list: () => object[],
 *   getActiveForImpl: (implSessionId: string) => object | undefined,
 *   getByReviewSession: (reviewSessionId: string) => object | undefined,
 *   create: (record: object) => Promise<object>,
 *   patch: (id: string, fields: object) => Promise<object>,
 *   transition: (id: string, event: string, extra?: object) => Promise<object>,
 *   close: () => Promise<void>,
 * }>} the store facade.
 */
export async function openLinkStore(storageDomain) {
  if (!storageDomain || typeof storageDomain.open !== 'function') {
    throw new LinkStoreError(
      'storage-unavailable',
      'storageDomain service is unavailable; mount the storage-domain plugin in this profile',
    );
  }

  let domain;
  try {
    domain = await storageDomain.open(linkDomainSpec());
  } catch (error) {
    throw new LinkStoreError(
      'storage-unavailable',
      `Failed to open storage domain "${LINK_DOMAIN}": ${errorMessage(error)}`,
      { cause: error },
    );
  }

  if (!domain || typeof domain.table !== 'function') {
    throw new LinkStoreError('storage-unavailable', `Storage domain "${LINK_DOMAIN}" did not expose a table handle`);
  }

  let table;
  try {
    table = domain.table(LINKS_TABLE);
  } catch (error) {
    throw new LinkStoreError(
      'storage-unavailable',
      `Failed to resolve table "${LINKS_TABLE}": ${errorMessage(error)}`,
      { cause: error },
    );
  }
  if (
    !table
    || typeof table.get !== 'function'
    || typeof table.put !== 'function'
    || typeof table.update !== 'function'
    || typeof table.entries !== 'function'
  ) {
    throw new LinkStoreError('storage-unavailable', `Table "${LINKS_TABLE}" is not a usable domain table`);
  }

  return createLinkStore(domain, table);
}

/**
 * Build the store facade around one opened domain/table pair.
 *
 * @param {{ close: () => Promise<void> }} domain opened domain handle.
 * @param {object} table links table handle.
 * @returns {object} the store facade.
 */
function createLinkStore(domain, table) {
  let closed = false;

  /** @returns {void} */
  function assertOpen() {
    if (closed) throw new LinkStoreError('storage-unavailable', 'link store is already closed');
  }

  /** @returns {Array<[string, object]>} a stable snapshot of all records. */
  function readEntries() {
    assertOpen();
    try {
      return [...table.entries()];
    } catch (error) {
      throw toStoreError(error);
    }
  }

  /**
   * @param {(record: object) => boolean} predicate match test.
   * @returns {object | undefined} the most recently updated match.
   */
  function findRecord(predicate) {
    let match;
    for (const [, record] of readEntries()) {
      if (!record || typeof record !== 'object') continue;
      if (!predicate(record)) continue;
      if (match === undefined || numeric(record.updatedAt) >= numeric(match.updatedAt)) match = record;
    }
    return match;
  }

  /** @param {string} id link id. @returns {object | undefined} the stored record. */
  function get(id) {
    assertOpen();
    if (typeof id !== 'string' || id === '') return undefined;
    try {
      return table.get(id);
    } catch (error) {
      throw toStoreError(error);
    }
  }

  return {
    /**
     * Read one link record.
     * @param {string} id link id.
     * @returns {object | undefined} the record, when present.
     */
    get,

    /**
     * List every link record in storage order.
     * @returns {object[]} all records.
     */
    list() {
      return readEntries()
        .map(([, record]) => record)
        .filter((record) => record && typeof record === 'object');
    },

    /**
     * Find the active link of one implementation session (at most one by
     * design; the most recently updated record wins if storage disagrees).
     * @param {string} implSessionId implementation session id.
     * @returns {object | undefined} the active link record.
     */
    getActiveForImpl(implSessionId) {
      if (typeof implSessionId !== 'string' || implSessionId === '') return undefined;
      return findRecord(
        (record) => record.implSessionId === implSessionId && ACTIVE_STATUSES.includes(record.status),
      );
    },

    /**
     * Find the link that owns a review session (newest record wins).
     * @param {string} reviewSessionId review session id.
     * @returns {object | undefined} the owning link record.
     */
    getByReviewSession(reviewSessionId) {
      if (typeof reviewSessionId !== 'string' || reviewSessionId === '') return undefined;
      return findRecord((record) => record.reviewSessionId === reviewSessionId);
    },

    /**
     * Insert one link record. The record must satisfy `linkRecordSchema`; an
     * existing id rejects with `code: 'duplicate'`.
     * @param {object} record the full record to store.
     * @returns {Promise<object>} the validated stored record.
     */
    async create(record) {
      assertOpen();
      const parsed = parseLinkRecord(record);
      let existing;
      try {
        existing = table.get(parsed.id);
      } catch (error) {
        throw toStoreError(error);
      }
      if (existing !== undefined) {
        throw new LinkStoreError('duplicate', `Link "${parsed.id}" already exists`);
      }
      try {
        await table.put(parsed.id, parsed);
      } catch (error) {
        throw toStoreError(error);
      }
      return parsed;
    },

    /**
     * Merge mutable fields into a record and stamp `updatedAt` in one
     * serialized `table.update` call. Immutable identity fields (`id`,
     * `version`, `createdAt`, `implSessionId`) are ignored.
     * @param {string} id link id.
     * @param {object} fields partial mutable fields.
     * @returns {Promise<object>} the updated record.
     */
    async patch(id, fields) {
      assertOpen();
      const source = fields && typeof fields === 'object' && !Array.isArray(fields) ? fields : {};
      const updates = {};
      for (const [key, value] of Object.entries(source)) {
        if (IMMUTABLE_FIELDS.has(key) || key === 'updatedAt') continue;
        updates[key] = value;
      }
      try {
        return await table.update(id, (current) => parseLinkRecord({
          ...current,
          ...updates,
          updatedAt: Date.now(),
        }));
      } catch (error) {
        throw toStoreError(error);
      }
    },

    /**
     * Apply one state-machine event through a single serialized
     * `table.update` call, so concurrent writers never interleave.
     * @param {string} id link id.
     * @param {string} event transition name.
     * @param {object} [extra] transition payload (see `applyLinkTransition`).
     * @returns {Promise<object>} the updated record.
     */
    async transition(id, event, extra = {}) {
      assertOpen();
      try {
        return await table.update(id, (current) => applyLinkTransition(current, event, extra));
      } catch (error) {
        throw toStoreError(error);
      }
    },

    /**
     * Close the underlying domain. Idempotent; later reads and writes reject
     * with `code: 'storage-unavailable'`.
     * @returns {Promise<void>} resolution after the domain is released.
     */
    async close() {
      if (closed) return;
      closed = true;
      try {
        await domain.close();
      } catch (error) {
        throw toStoreError(error);
      }
    },
  };
}

/**
 * Generate 80 random bits as a BigInt for the ULID random component.
 * @returns {bigint} the random value.
 */
function randomBits() {
  let value = 0n;
  for (const byte of randomBytes(10)) value = (value << 8n) | BigInt(byte);
  return value;
}

/**
 * Encode a non-negative integer as fixed-length Crockford base32.
 * @param {bigint} value value to encode.
 * @param {number} length exact character count.
 * @returns {string} the encoded text.
 */
function encodeCrockford(value, length) {
  let out = '';
  let remaining = value;
  for (let index = 0; index < length; index += 1) {
    out = CROCKFORD_ALPHABET[Number(remaining & 31n)] + out;
    remaining >>= 5n;
  }
  return out;
}

/**
 * Return the first non-empty string (or Error message) among the arguments.
 * @param {...(string | Error | undefined)} values candidate values.
 * @returns {string | undefined} the first useful text.
 */
function firstText(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim() !== '') return value;
    if (value instanceof Error && typeof value.message === 'string' && value.message.trim() !== '') {
      return value.message;
    }
  }
  return undefined;
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
 * Describe an unknown error for diagnostics.
 * @param {unknown} error thrown value.
 * @returns {string} message text.
 */
function errorMessage(error) {
  if (error instanceof Error) return error.message;
  return String(error);
}

/**
 * Validate one link record, throwing `LinkStoreError('invalid-record')` on
 * schema violations.
 * @param {unknown} value candidate record.
 * @returns {object} the validated record.
 */
function parseLinkRecord(value) {
  const result = linkRecordSchema.safeParse(value);
  if (!result.success) {
    const issue = result.error.issues[0];
    const path = issue && Array.isArray(issue.path) && issue.path.length > 0 ? ` at ${issue.path.join('.')}` : '';
    throw new LinkStoreError(
      'invalid-record',
      `Invalid link record${path}: ${issue ? issue.message : 'schema validation failed'}`,
    );
  }
  return result.data;
}

/**
 * Translate a domain-layer failure into a `LinkStoreError` (passing link
 * errors through unchanged).
 * @param {unknown} error thrown value.
 * @returns {LinkStoreError} the store error.
 */
function toStoreError(error) {
  if (error instanceof LinkStoreError) return error;
  const message = errorMessage(error);
  const code = error && typeof error === 'object' ? error.code : undefined;
  // Real domains reject a missing record with `DomainError('missing-key')`;
  // lightweight test doubles throw a plain "missing key <id>" Error, so match
  // both the stable code and the message shape.
  if (code === 'missing-key' || code === 'not-found' || /missing[ -]?key/i.test(message)) {
    return new LinkStoreError('not-found', 'Link record does not exist', { cause: error });
  }
  return new LinkStoreError('storage-unavailable', message, { cause: error });
}
