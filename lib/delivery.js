// handoff-review — cross-session delivery and loop protection.
//
// Every cross-session message is a complete UserMessage (the runtime does not
// mint ids) whose source kind marks it as plugin traffic. Deliveries only ever
// happen on an explicit user command or dock action (DEVELOPMENT.md D4), and
// the loop breaker additionally dedupes one (link, round, kind, content) and
// rate-limits deliveries per link (DEVELOPMENT.md §9.8).

import { createHash, randomUUID } from 'node:crypto'

/** Source-kind recorded on every message this plugin delivers across sessions. */
export const DELIVERY_SOURCE = 'handoff-review'

/** Source-kind recorded on the continuation handoff delivered into a new session. */
export const CONTINUATION_SOURCE = 'handoff-continuation'

/** Stable failure codes surfaced by delivery and the loop breaker. */
export const DELIVERY_CODES = {
  NO_AGENT: 'NO_AGENT',
  RATE_LIMIT: 'RATE_LIMIT',
  DUPLICATE: 'DUPLICATE',
  MAX_ROUNDS: 'MAX_ROUNDS',
}

/** Raised for expected delivery failures; `code` is the stable discriminant. */
export class DeliveryError extends Error {
  /**
   * @param {string} code stable failure code from {@link DELIVERY_CODES}
   * @param {string} message human-readable diagnostic
   */
  constructor(code, message) {
    super(message)
    this.name = 'DeliveryError'
    this.code = code
  }
}

/**
 * Build the complete `UserMessage` the runtime accepts for `agent.followup()`.
 *
 * `options.kind` overrides the message source kind (the continuation handoff
 * uses its own kind so a later review in the new session still treats the
 * handoff as that session's goal); the default stays `handoff-review`, so every
 * existing call site keeps producing byte-identical messages.
 * @param {string} text model-facing text
 * @param {{ now?: () => number, kind?: string }} [options] injectable clock (tests) and source-kind override
 * @returns {{ id: string, role: 'user', content: Array<{ type: 'text', text: string }>, source: { kind: string } }}
 */
export function buildUserMessage(text, options = {}) {
  const config = options !== null && typeof options === 'object' ? options : {}
  const kind = typeof config.kind === 'string' && config.kind.trim() !== ''
    ? config.kind.trim()
    : DELIVERY_SOURCE
  return {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind },
  }
}

/**
 * Deliver one message into a live agent inbox without waking it (inject) or as
 * an ordinary follow-up turn.
 * @param {object} agent live Agent from `ctx.agents.get()`
 * @param {string} text message body
 * @param {{ mode?: 'followup' | 'inject' }} [options] delivery mode; default followup
 * @returns {void}
 * @throws {DeliveryError} `NO_AGENT` when the agent is not live
 */
export function deliverToAgent(agent, text, options = {}) {
  if (agent === undefined || agent === null || typeof agent.followup !== 'function') {
    throw new DeliveryError(DELIVERY_CODES.NO_AGENT, '目標 session 目前沒有 live agent，請先開啟該 session。')
  }
  const message = buildUserMessage(text)
  if (options.mode === 'inject' && typeof agent.inject === 'function') {
    agent.inject(message)
    return
  }
  agent.followup(message)
}

/**
 * Deterministic short content hash used for duplicate detection.
 * @param {string} text delivered text
 * @returns {string} 16 hex characters
 */
export function hashContent(text) {
  return createHash('sha256').update(String(text), 'utf8').digest('hex').slice(0, 16)
}

/**
 * Create the per-plugin loop breaker.
 *
 * - one delivery per `(linkId, round, kind, contentHash)` (repeat is a DUPLICATE);
 * - at most `maxDeliveriesPerMinute` deliveries per link in any 60s window;
 * - `round > maxRounds` is refused unless `force` (DEVELOPMENT.md §7.3).
 *
 * @param {{ maxDeliveriesPerMinute?: number, maxRounds?: number, now?: () => number }} [config]
 * @returns {{ guard: (input: { linkId: string, round: number, kind: string, content: string, force?: boolean }) => void, reset: (linkId: string) => void, stats: (linkId: string) => { deliveries: number, duplicates: number } }}
 */
export function createLoopBreaker(config = {}) {
  let maxDeliveriesPerMinute = Math.max(1, Math.trunc(config.maxDeliveriesPerMinute ?? 6))
  let maxRounds = Math.max(1, Math.trunc(config.maxRounds ?? 3))
  const now = typeof config.now === 'function' ? config.now : () => Date.now()
  /** @type {Map<string, number[]>} linkId -> delivery timestamps within the window */
  const windows = new Map()
  /** @type {Map<string, string>} dedupeKey -> ISO-ish last seen marker */
  const seen = new Map()

  /**
   * Check one delivery without recording it. Throws on refusal; the caller
   * records only after the delivery actually happened, so a failed inbox write
   * cannot poison the dedupe table.
   * @param {{ linkId: string, round: number, kind: string, content: string, force?: boolean }} input
   * @returns {void}
   * @throws {DeliveryError} `MAX_ROUNDS`, `DUPLICATE`, or `RATE_LIMIT`
   */
  function check(input) {
    const round = Math.trunc(Number(input.round) || 1)
    if (round > maxRounds && input.force !== true) {
      throw new DeliveryError(
        DELIVERY_CODES.MAX_ROUNDS,
        `已達 maxRounds（${maxRounds}）；請先 close，或使用 --force 送出新一輪 revision。`,
      )
    }
    const dedupeKey = [input.linkId, round, input.kind, hashContent(input.content)].join('|')
    if (seen.has(dedupeKey)) {
      throw new DeliveryError(DELIVERY_CODES.DUPLICATE, '這一輪的同一份內容已送出過，未重複投遞。')
    }
    const timestamp = now()
    const cutoff = timestamp - 60_000
    const window = (windows.get(input.linkId) ?? []).filter((value) => value > cutoff)
    if (window.length >= maxDeliveriesPerMinute) {
      throw new DeliveryError(
        DELIVERY_CODES.RATE_LIMIT,
        `每個 link 每分鐘最多 ${maxDeliveriesPerMinute} 次跨 session 投遞，請稍後再試。`,
      )
    }
  }

  /**
   * Record one delivery after it succeeded.
   * @param {{ linkId: string, round: number, kind: string, content: string }} input
   * @returns {void}
   */
  function record(input) {
    const round = Math.trunc(Number(input.round) || 1)
    const dedupeKey = [input.linkId, round, input.kind, hashContent(input.content)].join('|')
    const timestamp = now()
    const cutoff = timestamp - 60_000
    const window = (windows.get(input.linkId) ?? []).filter((value) => value > cutoff)
    window.push(timestamp)
    windows.set(input.linkId, window)
    seen.set(dedupeKey, String(timestamp))
    // Bound the dedupe table; entries older than the rate window are irrelevant.
    if (seen.size > 512) {
      const oldest = seen.keys().next().value
      if (oldest !== undefined) seen.delete(oldest)
    }
  }

  /**
   * Check and record one delivery atomically (the API used by tests and by
   * callers that do their own send).
   * @param {{ linkId: string, round: number, kind: string, content: string, force?: boolean }} input
   * @returns {void}
   * @throws {DeliveryError} `MAX_ROUNDS`, `DUPLICATE`, or `RATE_LIMIT`
   */
  function guard(input) {
    check(input)
    record(input)
  }

  /** Forget one link's windows (link reopened or closed). */
  function reset(linkId) {
    windows.delete(linkId)
    for (const key of [...seen.keys()]) {
      if (key.startsWith(String(linkId) + '|')) seen.delete(key)
    }
  }

  /** Diagnostic counters for one link. */
  function stats(linkId) {
    const timestamps = windows.get(linkId) ?? []
    const prefix = String(linkId) + '|'
    let duplicates = 0
    for (const key of seen.keys()) {
      if (key.startsWith(prefix)) duplicates += 1
    }
    return { deliveries: timestamps.length, duplicates }
  }

  /**
   * Update the limits in place without dropping the active dedupe/rate state
   * (a Settings save must change limits, not reopen old deliveries).
   * @param {{ maxRounds?: number, maxDeliveriesPerMinute?: number }} limits new limits.
   * @returns {void}
   */
  function configure(limits = {}) {
    if (Number.isFinite(limits.maxRounds)) maxRounds = Math.max(1, Math.trunc(limits.maxRounds))
    if (Number.isFinite(limits.maxDeliveriesPerMinute)) {
      maxDeliveriesPerMinute = Math.max(1, Math.trunc(limits.maxDeliveriesPerMinute))
    }
  }

  return { guard, check, record, reset, stats, configure }
}

/**
 * Composition root for delivery: the loop breaker plus the actual inbox write.
 * @param {{ maxRounds?: number, maxDeliveriesPerMinute?: number, now?: () => number }} [config]
 * @returns {{ deliver: (agent: object, text: string, meta: { linkId: string, round: number, kind: string, force?: boolean, mode?: 'followup' | 'inject' }) => void, reset: (linkId: string) => void, guard: (input: { linkId: string, round: number, kind: string, content: string, force?: boolean }) => void, stats: (linkId: string) => { deliveries: number, duplicates: number } }}
 */
export function createDelivery(config = {}) {
  const breaker = createLoopBreaker(config)
  return {
    guard: breaker.guard,
    check: breaker.check,
    record: breaker.record,
    reset: breaker.reset,
    stats: breaker.stats,
    configure: breaker.configure,
    /**
     * Check, deliver, then record. Throws {@link DeliveryError} without
     * delivering when the check refuses; a failed inbox write leaves the dedupe
     * table untouched so the user can retry immediately.
     * @param {object} agent live target Agent
     * @param {string} text message body
     * @param {{ linkId: string, round: number, kind: string, force?: boolean, mode?: 'followup' | 'inject' }} meta delivery metadata
     * @returns {void}
     */
    deliver(agent, text, meta) {
      const input = { linkId: meta.linkId, round: meta.round, kind: meta.kind, content: text, force: meta.force }
      breaker.check(input)
      deliverToAgent(agent, text, { mode: meta.mode })
      breaker.record(input)
    },
  }
}
