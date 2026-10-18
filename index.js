// handoff-review — Host entry (profile bundle).
//
// Implements the OpenChamber-style handoff review flow on DSH seams that are
// already public: an ordinary linked review session, a durable link record in a
// storage domain, two session projections (session diffs and reviewer reply),
// explicit cross-session delivery with loop protection, a slash command, and a
// fenced HTTP surface for the composer dock (see DEVELOPMENT.md).
//
// Nothing here mutates DSH kernel state: no new session event type is written,
// no session log is rewritten, and the reviewer only ever receives an official
// `sandbox/mode` override plus scoped tool restrictions.

import Schema from '@deepseek-ai/schemastery'

import { openLinkStore, newLinkId, ACTIVE_STATUSES } from './lib/link-store.js'
import {
  registerHandoffProjections,
  DIFF_PROJECTION_KEY,
  REPLY_PROJECTION_KEY,
} from './lib/projections.js'
import {
  buildFeedbackMessage,
  buildHandoff,
  buildReviewBrief,
  buildRevisionMessage,
  collectChangedFiles,
  extractGoal,
  extractOpenQuestions,
} from './lib/handoff-builder.js'
import {
  applyReviewerPolicy,
  collectSessionMessages,
  createReviewSession,
  findLiveAgent,
  hydrateCreatedEntries,
  listArchivedSessionIds,
  sessionExists,
  summarizeHandoff,
  SessionFactoryError,
} from './lib/session-factory.js'
import { createDelivery, deliverToAgent, hashContent } from './lib/delivery.js'
import { registerCommands } from './lib/commands.js'
import { HandoffError, registerRoutes } from './lib/routes.js'
import {
  CONFIG_DEFAULTS,
  loadCatalog,
  validateConfigPatch,
} from './lib/config-admin.js'
import { applyRoundFeedback, createRoundRecord, openHistoryStore } from './lib/history-store.js'
import { buildChangedFileSummaries, buildDiffFiles, buildRoundHistory } from './lib/panel-data.js'

/** Cordis plugin name; also the composition row id. */
export const name = 'handoff-review'

/** Hard service dependencies, verbatim from DEVELOPMENT.md §9.1. */
export const inject = [
  'commands',
  'agents',
  'sessions',
  'workspaceRegistry',
  'sessionController',
  'sessionProjections',
  'storageDomain',
  'tools',
]

/** Config schema (schemastery) so the profile patch is validated (DEVELOPMENT.md §12). */
export const Config = Schema.object({
  reviewerProvider: Schema.string().default(''),
  reviewerModel: Schema.string().default(''),
  reviewerReasoningEffort: Schema.string().default(''),
  reviewerPreset: Schema.string().default(''),
  maxRounds: Schema.natural().default(3),
  maxHandoffChars: Schema.natural().default(30000),
  diffPerFileChars: Schema.natural().default(6000),
  autoSummarize: Schema.boolean().default(false),
  readOnlyReviewer: Schema.boolean().default(true),
  autoContinue: Schema.boolean().default(false),
  maxDeliveriesPerMinute: Schema.natural().default(6),
})

/**
 * Normalize the (already schema-validated) plugin config defensively.
 * @param {Record<string, unknown> | undefined} raw config from the composition row
 * @returns {{ reviewerProvider: string, reviewerModel: string, reviewerReasoningEffort: string, reviewerPreset: string, maxRounds: number, maxHandoffChars: number, diffPerFileChars: number, autoSummarize: boolean, readOnlyReviewer: boolean, autoContinue: boolean, maxDeliveriesPerMinute: number }}
 */
export function normalizeConfig(raw) {
  const config = raw !== null && typeof raw === 'object' ? raw : {}
  const natural = (value, fallback) => {
    const number = Number(value)
    return Number.isFinite(number) && number > 0 ? Math.trunc(number) : fallback
  }
  const text = (value) => (typeof value === 'string' ? value : '')
  return {
    reviewerProvider: text(config.reviewerProvider).trim(),
    reviewerModel: text(config.reviewerModel).trim(),
    reviewerReasoningEffort: text(config.reviewerReasoningEffort).trim(),
    reviewerPreset: text(config.reviewerPreset).trim(),
    maxRounds: natural(config.maxRounds, 3),
    maxHandoffChars: natural(config.maxHandoffChars, 30000),
    diffPerFileChars: natural(config.diffPerFileChars, 6000),
    autoSummarize: config.autoSummarize === true,
    readOnlyReviewer: config.readOnlyReviewer !== false,
    autoContinue: config.autoContinue === true,
    maxDeliveriesPerMinute: natural(config.maxDeliveriesPerMinute, 6),
  }
}

/**
 * Client-facing projection of one link record (no internal seq bookkeeping).
 * @param {object | null} link link record
 * @returns {object | null} public link view
 */
export function publicLink(link) {
  if (link === null || link === undefined) return null
  return {
    id: link.id,
    status: link.status,
    round: link.round,
    focus: link.focus,
    implSessionId: link.implSessionId,
    reviewSessionId: link.reviewSessionId,
    lastError: link.lastError,
    updatedAt: link.updatedAt,
    reviewerProvider: link.reviewerProvider,
    reviewerModel: link.reviewerModel,
  }
}

/**
 * Links a session participates in, newest activity first.
 * @param {object} store link store
 * @param {string} sessionId session id
 * @returns {Array<object>} participant links
 */
export function findParticipantLinks(store, sessionId) {
  return store
    .list()
    .filter((link) => link.implSessionId === sessionId || link.reviewSessionId === sessionId)
    .sort((left, right) => (right.updatedAt ?? 0) - (left.updatedAt ?? 0))
}

/**
 * Resolve the link an action addresses. An explicit `linkId` must name a link
 * the session participates in; otherwise review membership wins, then the
 * newest impl link (M1 behaviour).
 * @param {object} store link store
 * @param {string} sessionId session id
 * @param {string | null} [linkId] explicit selection
 * @returns {{ link: object | null, role: 'impl' | 'review' | null }} participant view
 */
export function resolveParticipantLink(store, sessionId, linkId = null) {
  if (typeof linkId === 'string' && linkId !== '') {
    const link = store.get(linkId)
    if (link === undefined) return { link: null, role: null }
    if (link.reviewSessionId === sessionId) return { link, role: 'review' }
    if (link.implSessionId === sessionId) return { link, role: 'impl' }
    return { link: null, role: null }
  }
  const links = findParticipantLinks(store, sessionId)
  const review = links.find((link) => link.reviewSessionId === sessionId)
  if (review !== undefined) return { link: review, role: 'review' }
  const impls = links.filter((link) => link.implSessionId === sessionId)
  if (impls.length > 0) return { link: impls[0], role: 'impl' }
  return { link: null, role: null }
}

/**
 * M1-compatible alias for the participant resolver (no explicit selection).
 * @param {object} store link store
 * @param {string} sessionId session id
 * @returns {{ link: object | null, role: 'impl' | 'review' | null }} participant view
 */
export function locateLink(store, sessionId) {
  return resolveParticipantLink(store, sessionId, null)
}

/** How many handoff entries a single session title may carry before truncation. */
const TITLE_SCOPE_CHARS = 60

/**
 * Host-side handoff-review orchestration shared by the slash command, the dock
 * routes, the right-sidebar panel and the settings page. Expected failures throw
 * {@link HandoffError}.
 */
export class HandoffService {
  /**
   * @param {object} ctx Host plugin context
   * @param {object} config resolved plugin config
   * @param {{ store: object, history: object, delivery: object }} deps opened stores + delivery
   */
  constructor(ctx, config, deps) {
    this.ctx = ctx
    this.config = config
    // Composition config (settings overrides are layered on top of this and
    // persisted as a partial diff, so later composition changes still apply).
    this.baseConfig = deps.baseConfig ?? config
    this.store = deps.store
    this.history = deps.history
    this.delivery = deps.delivery
    /** impl sessions with an in-flight create (check-then-act guard). */
    this.creatingSessions = new Set()
    /** In-flight automatic steps, keyed by link id (loop re-entrancy guard). */
    this.autoFeedbackInFlight = new Set()
    this.autoRevisionInFlight = new Set()
    /** One-shot automation-stop notices (keyed by link + round + content). */
    this.autoNoticeKeys = new Set()
  }

  /**
   * Replace the effective config (settings page save).
   * @param {object} config normalized config
   * @returns {void}
   */
  setConfig(config) {
    this.config = config
  }

  /**
   * Read the impl session's diff projection, returning a safe empty state when
   * the projection is not registered for this session yet.
   * @param {object} session live Session
   * @returns {{ entries: Array<object>, lastSeq: number, verification: object | null }}
   */
  readDiffState(session) {
    try {
      const state = this.ctx.sessionProjections.stateOf(session, DIFF_PROJECTION_KEY)
      if (state !== undefined && state !== null) return state
    } catch (error) {
      console.error(`handoff-review: 讀取 diff projection 失敗：${error && error.message ? error.message : String(error)}`)
    }
    return { entries: [], lastSeq: -1, verification: null }
  }

  /**
   * Read the reviewer reply projection from a live review session.
   * @param {string | null} reviewSessionId review session id
   * @returns {{ session: object, state: object } | null} live session + reply state
   */
  readReplyState(reviewSessionId) {
    if (reviewSessionId === null || reviewSessionId === undefined) return null
    const session = this.ctx.sessions.get(reviewSessionId)
    if (session === undefined) return null
    try {
      const state = this.ctx.sessionProjections.stateOf(session, REPLY_PROJECTION_KEY)
      return { session, state: state ?? { lastText: null, lastSeq: -1, turn: 0 } }
    } catch {
      return null
    }
  }

  /**
   * Require a live agent for one session id.
   * @param {string} sessionId session id
   * @param {string} code failure code when absent
   * @param {string} message failure message when absent
   * @returns {object} live Agent
   */
  requireAgent(sessionId, code, message) {
    const agent = findLiveAgent(this.ctx, sessionId)
    if (agent === undefined) throw new HandoffError(code, message)
    return agent
  }

  /**
   * Build the deterministic handoff text for one round.
   * @param {{ round: number, implAgent: object, focus: string | null, sinceSeq: number }} input
   * @returns {Promise<{ handoff: string, changes: Array<object>, warnings: string[], lastSeq: number }>}
   */
  async buildRoundHandoff(input) {
    const warnings = []
    const diffState = this.readDiffState(input.implAgent.session)
    const entries = await hydrateCreatedEntries(this.ctx, diffState.entries, this.config.diffPerFileChars)
    const changes = collectChangedFiles(entries, { sinceSeq: input.sinceSeq })
    if (changes.length === 0) {
      warnings.push(
        input.sinceSeq > -1
          ? '自上次 handoff 之後沒有觀察到新的 session 變更。'
          : '本次 session 尚無變更（手動改檔不會出現在 session diff 中）。',
      )
    }
    const messages = collectSessionMessages(input.implAgent)
    const handoff = buildHandoff({
      round: input.round,
      goal: extractGoal(messages),
      focus: input.focus,
      changes,
      verification: diffState.verification ?? null,
      openQuestions: extractOpenQuestions(messages),
      warnings,
      config: this.config,
    })
    const summarized = await summarizeHandoff(this.ctx, input.implAgent, handoff, this.config)
    warnings.push(...summarized.warnings)
    return { handoff: summarized.text, changes, warnings, lastSeq: diffState.lastSeq }
  }

  /**
   * Give the review session a fixed, human-readable title (M2 §9.9):
   * `Review: <impl title> (round N)`. Missing title service or rename
   * failures are non-fatal warnings.
   * @param {{ reviewSessionId: string, implAgent?: object, round: number, warnings?: string[] }} input
   * @returns {Promise<void>}
   */
  async applyReviewTitle(input) {
    const warnings = input.warnings ?? []
    const service = this.ctx.get('sessionTitle')
    if (service === undefined || typeof service.rename !== 'function') return
    const reviewAgent = findLiveAgent(this.ctx, input.reviewSessionId)
    if (reviewAgent === undefined) return
    let implTitle = ''
    try {
      const implSession = input.implAgent && input.implAgent.session
      if (implSession !== undefined) implTitle = (service.get(implSession) ?? {}).title ?? ''
    } catch {
      implTitle = ''
    }
    if (typeof implTitle !== 'string') implTitle = ''
    const scope = implTitle.trim() === '' ? '' : `: ${implTitle.trim().slice(0, TITLE_SCOPE_CHARS)}`
    const title = `Review${scope} (round ${input.round})`
    try {
      service.rename(reviewAgent.session, title)
    } catch (error) {
      const message = `無法設定 review session 標題：${error && error.message ? error.message : String(error)}`
      warnings.push(message)
      console.warn(`handoff-review: ${message}`)
    }
  }

  /**
   * Persist the handoff snapshot of one round for the panel history.
   * @param {{ link: object, round: number, handoff: string }} input
   * @returns {Promise<void>}
   */
  async recordRoundHandoff(input) {
    try {
      await this.history.putRound(
        createRoundRecord({
          linkId: input.link.id,
          round: input.round,
          implSessionId: input.link.implSessionId,
          reviewSessionId: input.link.reviewSessionId,
          handoff: input.handoff,
          report: null,
          status: 'handoff',
        }),
      )
    } catch (error) {
      console.warn(`handoff-review: 無法寫入 round history：${error && error.message ? error.message : String(error)}`)
    }
  }

  /**
   * `GET /handoff-review/api/state` payload.
   * @param {{ sessionId: string, linkId?: string | null }} input
   * @returns {Promise<object>} state payload
   */
  async state(input) {
    const links = findParticipantLinks(this.store, input.sessionId)
    const { link, role } = resolveParticipantLink(this.store, input.sessionId, input.linkId ?? null)
    const active = link !== null && ACTIVE_STATUSES.includes(link.status)
    return {
      sessionId: input.sessionId,
      role,
      link: publicLink(link),
      links: links.map(publicLink),
      can: {
        create:
          !links.some((candidate) => ACTIVE_STATUSES.includes(candidate.status))
          && findLiveAgent(this.ctx, input.sessionId) !== undefined,
        feedback: active && link.status === 'feedback_ready',
        // DEVELOPMENT.md §8.3: revision follows a sent reviewer report; after a
        // `reopen` the link is `open` and accepts a new revision cycle again.
        revision:
          active &&
          role === 'impl' &&
          ['open', 'feedback_sent'].includes(link.status),
        close: active,
        reopen: link !== null && link.status === 'closed',
        panel: link !== null,
      },
      maxRounds: this.config.maxRounds,
    }
  }

  /**
   * `status` sub-command payload.
   * @param {{ sessionId: string }} input
   * @returns {Promise<{ link: object | null, links: Array<object>, role: string | null, text: string }>}
   */
  async status(input) {
    const links = findParticipantLinks(this.store, input.sessionId)
    const { link, role } = resolveParticipantLink(this.store, input.sessionId, null)
    const text = formatStatusText({ link, links, role, maxRounds: this.config.maxRounds })
    return { link: publicLink(link), links: links.map(publicLink), role, maxRounds: this.config.maxRounds, text }
  }

  /**
   * Create a new handoff review link and its review session. With `newLink` a
   * second link may coexist for the same impl session (M2 D8/`--new`).
   * @param {{ sessionId: string, focus?: string | null, newLink?: boolean }} input
   * @returns {Promise<{ link: object, reviewSessionId: string, message: string, warnings: string[] }>}
   */
  async create(input) {
    // Serialize concurrent creates for one impl session: the active-link check is
    // synchronous, but session creation is awaited, so an API double-click could
    // otherwise create two links.
    if (this.creatingSessions.has(input.sessionId)) {
      throw new HandoffError('ALREADY_LINKED', '這個 session 正在建立 handoff review，請稍候。')
    }
    this.creatingSessions.add(input.sessionId)
    try {
      return await this.createImpl(input)
    } finally {
      this.creatingSessions.delete(input.sessionId)
    }
  }

  /**
   * Unlocked create body; call through {@link HandoffService#create}.
   * @param {{ sessionId: string, focus?: string | null, newLink?: boolean }} input
   * @returns {Promise<object>} creation result
   */
  async createImpl(input) {
    const implAgent = this.requireAgent(
      input.sessionId,
      'NO_IMPL_AGENT',
      'impl session 目前沒有 live agent，請先開啟該 session 再建立 handoff review。',
    )
    // A review session must not start a review of itself (review-of-review
    // chains): only implementation sessions create links.
    if (this.store.list().some((link) => link.reviewSessionId === input.sessionId)) {
      throw new HandoffError(
        'WRONG_SESSION',
        '這個 session 是某個交接審查的 review session；請在實作 session 發起新的審查。',
      )
    }
    const activeLinks = this.store
      .list()
      .filter((link) => link.implSessionId === input.sessionId && ACTIVE_STATUSES.includes(link.status))
      .sort((left, right) => (right.updatedAt ?? 0) - (left.updatedAt ?? 0))
    if (input.newLink !== true && activeLinks.length > 0) {
      throw new HandoffError(
        'ALREADY_LINKED',
        `這個 impl session 已有 ${activeLinks.length} 個 active link（最新：${activeLinks[0].id}）。請使用 /handoff-review status 選擇，或加 /handoff-review --new 建立第二個 link。`,
      )
    }

    const now = Date.now()
    const session = implAgent.session
    const cwd = session.header && typeof session.header.cwd === 'string' ? session.header.cwd : process.cwd()
    const record = {
      version: 1,
      id: newLinkId(now),
      implSessionId: input.sessionId,
      reviewSessionId: null,
      workspaceId: null,
      cwd,
      status: 'creating',
      round: 1,
      focus: typeof input.focus === 'string' && input.focus !== '' ? input.focus : null,
      createdAt: now,
      updatedAt: now,
      lastHandoffSeq: -1,
      lastFeedbackSeq: null,
      reviewerProvider: this.config.reviewerProvider !== '' ? this.config.reviewerProvider : null,
      reviewerModel: this.config.reviewerModel !== '' ? this.config.reviewerModel : null,
      lastError: null,
      closedAt: null,
    }
    await this.store.create(record)

    try {
      const round = await this.buildRoundHandoff({
        round: 1,
        implAgent,
        focus: record.focus,
        sinceSeq: -1,
      })
      const brief = `${buildReviewBrief({ config: this.config, focus: record.focus })}\n\n${round.handoff}`
      const created = await createReviewSession(this.ctx, this.config, { implAgent, messageText: brief })
      const delivered = await this.store.transition(record.id, 'delivered', {
        reviewSessionId: created.reviewSessionId,
        workspaceId: created.workspaceId,
        lastHandoffSeq: round.lastSeq,
        now: Date.now(),
      })
      const warnings = [...round.warnings, ...created.warnings]
      await this.recordRoundHandoff({ link: delivered, round: 1, handoff: round.handoff })
      await this.applyReviewTitle({
        reviewSessionId: created.reviewSessionId,
        implAgent,
        round: 1,
        warnings,
      })
      // A very fast reviewer may commit its first `turn/end` while the link is
      // still `creating`; re-check the reply projection after delivery.
      let deliveredLink = delivered
      const earlyReply = this.readReplyState(created.reviewSessionId)
      if (
        earlyReply !== null
        && delivered.status === 'reviewing'
        && typeof earlyReply.state.lastText === 'string'
        && earlyReply.state.lastText.trim() !== ''
      ) {
        deliveredLink = await this.store.transition(delivered.id, 'feedback-ready', {
          now: Date.now(),
        })
        await this.recordRoundReport({ link: deliveredLink, round: 1, report: earlyReply.state.lastText, seq: earlyReply.state.lastSeq })
      }
      const warningText = warnings.length > 0 ? `\nWarnings:\n- ${warnings.join('\n- ')}` : ''
      // Auto-continue starts from the reviewer's first turn/end; the create call
      // itself already delivered the brief and woke the reviewer.
      if (this.config.autoContinue === true && deliveredLink.status === 'feedback_ready') {
        this.scheduleAutoFeedback(deliveredLink.id)
      }
      return {
        link: publicLink(deliveredLink),
        reviewSessionId: created.reviewSessionId,
        warnings,
        message: `Review session ${created.reviewSessionId} opened (round 1, read-only reviewer).${warningText}`,
      }
    } catch (error) {
      const message = error && error.message ? error.message : String(error)
      let failed
      try {
        failed = await this.store.transition(record.id, 'failure', {
          lastError: message,
          now: Date.now(),
        })
      } catch (transitionError) {
        console.error(
          `handoff-review: 無法標記 link ${record.id} 為 failed：${transitionError && transitionError.message ? transitionError.message : String(transitionError)}`,
        )
      }
      if (error instanceof SessionFactoryError && error.sessionId !== undefined) {
        const enriched = new HandoffError(error.code, `${message}\n（review session id: ${error.sessionId}）`)
        enriched.reviewSessionId = error.sessionId
        throw enriched
      }
      if (failed !== undefined) console.error(`handoff-review: link ${record.id} 建立失敗：${message}`)
      throw new HandoffError('CREATE_FAILED', message)
    }
  }

  /**
   * Persist one reviewer report into its round record.
   * @param {{ link: object, round: number, report: string, seq: number }} input
   * @returns {Promise<void>}
   */
  async recordRoundReport(input) {
    try {
      const existing = await this.history.getRound(input.link.id, input.round)
      const record = existing === undefined || existing === null
        ? createRoundRecord({
          linkId: input.link.id,
          round: input.round,
          implSessionId: input.link.implSessionId,
          reviewSessionId: input.link.reviewSessionId,
          handoff: '',
          report: input.report,
          status: 'feedback',
        })
        : applyRoundFeedback(existing, input.report)
      await this.history.putRound(record)
    } catch (error) {
      console.warn(`handoff-review: 無法寫入 review report：${error && error.message ? error.message : String(error)}`)
    }
  }

  /**
   * Deliver the latest reviewer report to the impl session.
   * @param {{ sessionId: string, linkId?: string | null }} input session the user invoked from (impl or review)
   * @returns {Promise<{ link: object, message: string }>}
   */
  async feedback(input) {
    const { link } = resolveParticipantLink(this.store, input.sessionId, input.linkId ?? null)
    if (link === null) throw new HandoffError('NO_LINK', '這個 session 沒有 handoff review link。')
    if (link.status !== 'feedback_ready') {
      throw new HandoffError(
        'EMPTY_REPORT',
        `目前沒有可送回的 review 報告（link status: ${link.status}）。請等 reviewer 完成這一輪。`,
      )
    }
    const reply = this.readReplyState(link.reviewSessionId)
    if (reply === null) {
      throw new HandoffError('NO_REVIEW_AGENT', 'review session 目前不在線；請先開啟 review session 後再送 feedback。')
    }
    const report = typeof reply.state.lastText === 'string' ? reply.state.lastText.trim() : ''
    if (report === '') throw new HandoffError('EMPTY_REPORT', 'reviewer 這一輪沒有產出文字報告，無法送回。')
    const lastSentFeedbackSeq = Number.isFinite(link.lastFeedbackSeq) ? link.lastFeedbackSeq : -1
    if (!(Number.isFinite(reply.state.lastSeq) && reply.state.lastSeq > lastSentFeedbackSeq)) {
      throw new HandoffError('EMPTY_REPORT', 'reviewer 沒有比上次更新的報告，未重送舊回饋。')
    }

    const implAgent = this.requireAgent(
      link.implSessionId,
      'NO_IMPL_AGENT',
      'impl session 目前不在線；請先開啟 impl session 後再送 feedback。',
    )
    const text = buildFeedbackMessage({ round: link.round, reviewSessionId: link.reviewSessionId, report })
    this.delivery.deliver(implAgent, text, { linkId: link.id, round: link.round, kind: 'feedback' })
    const updated = await this.store.transition(link.id, 'feedback-sent', {
      lastFeedbackSeq: reply.state.lastSeq,
      now: Date.now(),
    })
    await this.recordRoundReport({ link: updated, round: link.round, report, seq: reply.state.lastSeq })
    return {
      link: publicLink(updated),
      message: `Round ${link.round} feedback delivered to impl session ${link.implSessionId}.`,
    }
  }

  /**
   * Collect changes after the last handoff watermark and deliver a revision to
   * the review session (round + 1).
   * @param {{ sessionId: string, linkId?: string | null, force?: boolean }} input
   * @returns {Promise<{ link: object, message: string }>}
   */
  async revision(input) {
    const { link, role } = resolveParticipantLink(this.store, input.sessionId, input.linkId ?? null)
    if (link === null) throw new HandoffError('NO_LINK', '這個 session 沒有 handoff review link。')
    if (role !== 'impl') throw new HandoffError('WRONG_SESSION', '/handoff-review revision 只能在 impl session 使用。')
    if (!ACTIVE_STATUSES.includes(link.status)) {
      throw new HandoffError('NO_LINK', `link 目前是 ${link.status}，不能再送 revision。`)
    }
    if (!['open', 'feedback_sent'].includes(link.status)) {
      throw new HandoffError(
        'WRONG_SESSION',
        `link 目前是 ${link.status}；請等 reviewer 回報（feedback_ready）或先送 feedback 後再送 revision。`,
      )
    }
    const nextRound = link.round + 1
    if (link.round >= this.config.maxRounds && input.force !== true) {
      throw new HandoffError(
        'MAX_ROUNDS',
        `已達 maxRounds（${this.config.maxRounds}）。請 close，或使用 /handoff-review revision --force 送出新一輪。`,
      )
    }
    const implAgent = this.requireAgent(
      link.implSessionId,
      'NO_IMPL_AGENT',
      'impl session 目前不在線；請先開啟 impl session 後再送 revision。',
    )
    const round = await this.buildRoundHandoff({
      round: nextRound,
      implAgent,
      focus: link.focus,
      sinceSeq: typeof link.lastHandoffSeq === 'number' ? link.lastHandoffSeq : -1,
    })
    if (round.changes.length === 0) {
      throw new HandoffError('NO_CHANGES', '自上次 handoff 之後沒有新的變更，未送出 revision。')
    }
    const reviewAgent = this.requireAgent(
      link.reviewSessionId,
      'NO_REVIEW_AGENT',
      'review session 目前不在線；請先開啟 review session 後再送 revision。',
    )
    const text = buildRevisionMessage({ round: nextRound, implSessionId: link.implSessionId, handoff: round.handoff })
    const reply = this.readReplyState(link.reviewSessionId)
    this.delivery.deliver(reviewAgent, text, {
      linkId: link.id,
      round: nextRound,
      kind: 'revision',
      force: input.force === true,
    })
    const updated = await this.store.transition(link.id, 'revision', {
      lastHandoffSeq: round.lastSeq,
      ...(reply !== null && Number.isFinite(reply.state.lastSeq) ? { lastFeedbackSeq: reply.state.lastSeq } : {}),
      now: Date.now(),
    })
    await this.recordRoundHandoff({ link: updated, round: nextRound, handoff: round.handoff })
    await this.applyReviewTitle({ reviewSessionId: link.reviewSessionId, implAgent, round: nextRound })
    return {
      link: publicLink(updated),
      message: `Revision for round ${nextRound} delivered to review session ${link.reviewSessionId}.`,
    }
  }

  /**
   * Close one link (idempotent); sessions are never deleted.
   * @param {{ sessionId: string, linkId?: string | null }} input
   * @returns {Promise<{ link: object, message: string }>}
   */
  async close(input) {
    const { link } = resolveParticipantLink(this.store, input.sessionId, input.linkId ?? null)
    if (link === null) throw new HandoffError('NO_LINK', '這個 session 沒有 handoff review link。')
    if (link.status === 'closed') {
      return { link: publicLink(link), message: `Link ${link.id} 已經是 closed。` }
    }
    if (!ACTIVE_STATUSES.includes(link.status)) {
      throw new HandoffError('WRONG_SESSION', `link 目前是 ${link.status}，無法 close（reopen 後再試）。`)
    }
    const updated = await this.store.transition(link.id, 'close', { now: Date.now() })
    this.delivery.reset(link.id)
    this.clearAutoNotice(link.id)
    return { link: publicLink(updated), message: `Link ${link.id} closed。Review session 保留，可隨時回去查看歷史。` }
  }

  /**
   * Reopen a closed link (DEVELOPMENT.md §5.2, §8.3).
   * @param {{ sessionId: string, linkId?: string | null }} input
   * @returns {Promise<{ link: object, message: string }>}
   */
  async reopen(input) {
    const { link } = resolveParticipantLink(this.store, input.sessionId, input.linkId ?? null)
    if (link === null) throw new HandoffError('NO_LINK', '這個 session 沒有 handoff review link。')
    if (link.status !== 'closed') {
      throw new HandoffError('WRONG_SESSION', `link 目前是 ${link.status}，只有 closed 的 link 可以 reopen。`)
    }
    const updated = await this.store.transition(link.id, 'reopen', { now: Date.now() })
    this.delivery.reset(link.id)
    this.clearAutoNotice(link.id)
    return { link: publicLink(updated), message: `Link ${link.id} reopened。` }
  }

  /**
   * `GET /handoff-review/api/config` payload: effective config + catalog.
   * @returns {Promise<{ config: object, defaults: object, providers: Array<object>, models: Array<object>, presets: Array<object> }>}
   */
  async getConfig() {
    const catalog = await loadCatalog(this.ctx)
    return { config: { ...this.config }, defaults: { ...CONFIG_DEFAULTS }, ...catalog }
  }

  /**
   * `POST /handoff-review/api/config`: validate a partial/full config, persist
   * it as the plugin's durable override, and use it for future sessions.
   * @param {{ config: object }} input submitted config
   * @returns {Promise<{ config: object, message: string }>}
   */
  async updateConfig(input) {
    if (input.config === null || typeof input.config !== 'object' || Array.isArray(input.config)) {
      throw new HandoffError('BAD_BODY', 'config 必須是物件。')
    }
    let validated
    try {
      validated = validateConfigPatch(this.config, input.config)
    } catch (error) {
      throw new HandoffError('BAD_BODY', error && error.message ? error.message : String(error))
    }
    const { config, warnings } = validated
    // Persist only the fields that differ from the composition base: later
    // composition changes stay effective for untouched fields (M2 contract:
    // the settings domain stores a partial override).
    const partial = {}
    for (const key of Object.keys(CONFIG_DEFAULTS)) {
      if (config[key] !== this.baseConfig[key]) partial[key] = config[key]
    }
    try {
      await this.history.putSettings(partial)
    } catch (error) {
      throw new HandoffError(
        'STORAGE_UNAVAILABLE',
        `無法保存設定：${error && error.message ? error.message : String(error)}`,
      )
    }
    this.setConfig(config)
    // Delivery limits live inside the loop breaker: update them in place so a
    // Settings save does not reset the active dedupe/rate windows.
    if (typeof this.delivery.configure === 'function') {
      this.delivery.configure({
        maxRounds: config.maxRounds,
        maxDeliveriesPerMinute: config.maxDeliveriesPerMinute,
      })
    } else {
      this.delivery = createDelivery({
        maxRounds: config.maxRounds,
        maxDeliveriesPerMinute: config.maxDeliveriesPerMinute,
      })
    }
    const warningText = warnings.length > 0 ? `（${warnings.join('；')}）` : ''
    // Turning autoContinue on re-arms links that are already waiting for a step.
    this.resumeAutoContinue()
    return { config: { ...config }, message: `設定已保存${warningText}。` }
  }

  /**
   * `GET /handoff-review/api/panel` payload for the right-sidebar panel.
   * @param {{ sessionId: string, linkId?: string | null }} input
   * @returns {Promise<object>} panel payload
   */
  async panel(input) {
    const links = findParticipantLinks(this.store, input.sessionId)
    const { link, role } = resolveParticipantLink(this.store, input.sessionId, input.linkId ?? null)
    if (link === null) throw new HandoffError('NO_LINK', '這個 session 沒有 handoff review link。')
    const reviewAgent = findLiveAgent(this.ctx, link.reviewSessionId)
    const implAgent = findLiveAgent(this.ctx, link.implSessionId)
    let rounds = []
    try {
      rounds = await this.history.listRounds(link.id)
    } catch (error) {
      console.warn(`handoff-review: 無法讀取 round history：${error && error.message ? error.message : String(error)}`)
    }
    const latest = rounds.length > 0 ? rounds[0] : undefined
    const latestReport = rounds.find((round) => typeof round.report === 'string' && round.report.trim() !== '')
    const session = implAgent !== undefined ? implAgent.session : (this.ctx.sessions.get(link.implSessionId) ?? null)
    const rawEntries = session !== null && session !== undefined ? this.readDiffState(session).entries : []
    const entries = await hydrateCreatedEntries(this.ctx, rawEntries, this.config.diffPerFileChars)
    // The panel shows the session's whole current change set (the handoff
    // itself stays watermark-based for revisions).
    const changedFiles = buildChangedFileSummaries(entries, { sinceSeq: -1 })
    return {
      link: publicLink(link),
      links: links.map(publicLink),
      role,
      rounds: buildRoundHistory(rounds),
      handoff: latest !== undefined ? latest.handoff : '',
      report: latestReport !== undefined ? latestReport.report : null,
      changedFiles,
      reviewer: {
        provider: link.reviewerProvider ?? this.config.reviewerProvider,
        model: link.reviewerModel ?? this.config.reviewerModel,
        preset: this.config.reviewerPreset,
      },
      sessions: {
        implLive: implAgent !== undefined,
        reviewLive: reviewAgent !== undefined,
      },
      maxRounds: this.config.maxRounds,
      lastHandoffSeq: link.lastHandoffSeq ?? -1,
    }
  }

  /**
   * `GET /handoff-review/api/diff` payload for the self-drawn diff drawer.
   * @param {{ sessionId: string, linkId?: string | null }} input
   * @returns {Promise<{ round: number, files: Array<object> }>}
   */
  async diff(input) {
    const { link } = resolveParticipantLink(this.store, input.sessionId, input.linkId ?? null)
    if (link === null) throw new HandoffError('NO_LINK', '這個 session 沒有 handoff review link。')
    const implAgent = findLiveAgent(this.ctx, link.implSessionId)
    const session = implAgent !== undefined ? implAgent.session : (this.ctx.sessions.get(link.implSessionId) ?? null)
    const rawEntries = session !== null && session !== undefined ? this.readDiffState(session).entries : []
    const entries = await hydrateCreatedEntries(this.ctx, rawEntries, this.config.diffPerFileChars)
    // The drawer is the self-drawn replacement for the missing diff-card slot:
    // show the session's whole change set, not only post-handoff changes.
    const files = buildDiffFiles(entries, {
      sinceSeq: -1,
      perFileChars: this.config.diffPerFileChars,
    })
    return { round: link.round, files, lastHandoffSeq: link.lastHandoffSeq ?? -1 }
  }

  /**
   * Fold one committed session event. Reviewer `turn/end` promotes the link to
   * `feedback_ready` and stores the report (DEVELOPMENT.md §7.2). When
   * `autoContinue` is enabled the same signal also drives the next automated
   * step: reviewer turn → auto feedback, implementation turn → auto revision.
   * @param {object} session live Session
   * @param {object} event committed session event
   * @returns {Promise<void>}
   */
  async onSessionEvent(session, event) {
    if (event.type !== 'turn/end') return
    const reviewLink = this.store.list().find((candidate) => candidate.reviewSessionId === session.id)
    if (reviewLink !== undefined) {
      if (reviewLink.status === 'reviewing' || reviewLink.status === 'open') {
        const reply = this.readReplyState(session.id)
        if (reply !== null) {
          const text = typeof reply.state.lastText === 'string' ? reply.state.lastText.trim() : ''
          const lastSentFeedbackSeq = Number.isFinite(reviewLink.lastFeedbackSeq) ? reviewLink.lastFeedbackSeq : -1
          if (
            text !== ''
            && Number.isFinite(reply.state.lastSeq)
            && reply.state.lastSeq > lastSentFeedbackSeq
          ) {
            const updated = await this.store.transition(reviewLink.id, 'feedback-ready', {
              now: Date.now(),
            })
            await this.recordRoundReport({ link: updated, round: reviewLink.round, report: text, seq: reply.state.lastSeq })
          }
        }
      }
      const current = this.store.get(reviewLink.id)
      if (this.config.autoContinue === true && current !== undefined && current.status === 'feedback_ready') {
        this.scheduleAutoFeedback(current.id)
      }
      return
    }

    if (this.config.autoContinue !== true) return
    for (const link of this.store.list()) {
      if (link.implSessionId === session.id && link.status === 'feedback_sent') {
        this.scheduleAutoRevision(link.id)
      }
    }
  }

  /**
   * Queue one automatic feedback delivery, de-duplicated per link while the
   * previous attempt is still running.
   * @param {string} linkId link id
   * @returns {void}
   */
  scheduleAutoFeedback(linkId) {
    if (this.config.autoContinue !== true) return
    if (this.autoFeedbackInFlight.has(linkId)) return
    this.autoFeedbackInFlight.add(linkId)
    void this.autoFeedback(linkId).finally(() => this.autoFeedbackInFlight.delete(linkId))
  }

  /**
   * Automatic step 1: deliver the ready reviewer report to the impl session.
   * Uses the same guarded `feedback()` path as the manual button.
   * @param {string} linkId link id
   * @returns {Promise<void>}
   */
  async autoFeedback(linkId) {
    const link = this.store.get(linkId)
    if (link === undefined || link.status !== 'feedback_ready') return
    try {
      await this.feedback({ sessionId: link.reviewSessionId, linkId })
      this.clearAutoNotice(link.id)
    } catch (error) {
      const message = error && error.message ? error.message : String(error)
      const code = error && typeof error.code === 'string' ? error.code : ''
      console.warn(`handoff-review: 自動送出回饋停止（${link.id}，${code || 'ERROR'}）：${message}`)
      // A cold peer session is not a failure the user must fix: agent/created
      // re-arms automation when that session is opened again.
      if (code === 'NO_REVIEW_AGENT' || code === 'NO_IMPL_AGENT') return
      if (code === 'DUPLICATE') {
        const report = this.readReplyState(link.reviewSessionId)?.state.lastText ?? ''
        this.autoNoticeOnce(
          `dup:${link.id}:${link.round}:${hashContent(report)}`,
          link,
          'reviewer 回覆與上次已送出的內容相同，自動接續停止。',
        )
        return
      }
      this.autoNotice(link, `自動回饋未送出：${message}`)
    }
  }

  /**
   * Queue one automatic revision delivery, de-duplicated per link.
   * @param {string} linkId link id
   * @returns {void}
   */
  scheduleAutoRevision(linkId) {
    if (this.config.autoContinue !== true) return
    if (this.autoRevisionInFlight.has(linkId)) return
    this.autoRevisionInFlight.add(linkId)
    void this.autoRevision(linkId).finally(() => this.autoRevisionInFlight.delete(linkId))
  }

  /**
   * Automatic step 2: after the implementation turn ended, send the collected
   * changes back to the review session. Stops on the ordinary guard conditions
   * (no changes, maxRounds, missing peer) instead of forcing a round.
   * @param {string} linkId link id
   * @returns {Promise<void>}
   */
  async autoRevision(linkId) {
    if (this.config.autoContinue !== true) return
    const link = this.store.get(linkId)
    if (link === undefined || link.status !== 'feedback_sent') return
    try {
      await this.revision({ sessionId: link.implSessionId, linkId })
      this.clearAutoNotice(link.id)
    } catch (error) {
      const message = error && error.message ? error.message : String(error)
      const code = error && typeof error.code === 'string' ? error.code : ''
      console.warn(`handoff-review: 自動送出修訂停止（${link.id}，${code || 'ERROR'}）：${message}`)
      if (code === 'MAX_ROUNDS') {
        this.autoNoticeOnce(
          `max:${link.id}:${link.round}`,
          link,
          `已達 maxRounds（${this.config.maxRounds}），自動接續停止；請手動 close 或強制送出修訂。`,
        )
      } else if (code === 'NO_CHANGES') {
        // Each unrelated impl turn re-arms automation; announce the stop once per
        // watermark/round instead of injecting the same notice on every turn.
        this.autoNoticeOnce(
          `nochange:${link.id}:${link.round}:${link.lastHandoffSeq ?? -1}`,
          link,
          '自上次 handoff 後沒有新的變更，自動接續停止。',
        )
      } else if (code !== 'NO_REVIEW_AGENT' && code !== 'NO_IMPL_AGENT') {
        this.autoNotice(link, `自動修訂未送出：${message}`)
      }
    }
  }

  /**
   * Send an automation-stop notice at most once for the given key.
   * @param {string} key once-key
   * @param {object} link link record
   * @param {string} text notice text
   * @returns {void}
   */
  autoNoticeOnce(key, link, text) {
    if (this.autoNoticeKeys.has(key)) return
    this.autoNoticeKeys.add(key)
    this.autoNotice(link, text)
  }

  /**
   * Forget one link's automation-stop notices (a successful step starts a new
   * phase, so the next stop deserves a fresh notice).
   * @param {string} linkId link id
   * @returns {void}
   */
  clearAutoNotice(linkId) {
    for (const key of [...this.autoNoticeKeys]) {
      if (key.includes(`:${linkId}:`)) this.autoNoticeKeys.delete(key)
    }
  }

  /**
   * Best-effort, non-waking notice to the impl agent (inject does not open a
   * turn), used when an automated step stops by design.
   * @param {object} link link record
   * @param {string} text notice text
   * @returns {void}
   */
  autoNotice(link, text) {
    const agent = findLiveAgent(this.ctx, link.implSessionId)
    if (agent === undefined) return
    try {
      deliverToAgent(agent, `[handoff-review] ${text}`, { mode: 'inject' })
    } catch (error) {
      console.warn(`handoff-review: 無法注入自動接續通知：${error && error.message ? error.message : String(error)}`)
    }
  }

  /**
   * Re-arm automation for one session that just became live (agent/created).
   * @param {string} sessionId session id
   * @returns {void}
   */
  resumeAutoForSession(sessionId) {
    if (this.config.autoContinue !== true) return
    for (const link of this.store.list()) {
      if (link.reviewSessionId === sessionId && link.status === 'feedback_ready') {
        this.scheduleAutoFeedback(link.id)
      }
      if (link.implSessionId === sessionId && link.status === 'feedback_sent') {
        this.scheduleAutoRevision(link.id)
      }
    }
  }

  /**
   * Re-arm automation for every persisted link at plugin activation or after a
   * settings save enables `autoContinue`.
   * @returns {void}
   */
  resumeAutoContinue() {
    if (this.config.autoContinue !== true) return
    for (const link of this.store.list()) {
      if (link.status === 'feedback_ready') this.scheduleAutoFeedback(link.id)
      else if (link.status === 'feedback_sent') this.scheduleAutoRevision(link.id)
    }
  }
}

/**
 * Multi-line status receipt used by `/handoff-review status`.
 * @param {{ link: object | null, links?: Array<object>, role: string | null, maxRounds: number }} input
 * @returns {string} status text
 */
export function formatStatusText({ link, links = [], role, maxRounds }) {
  if (link === null || link === undefined) {
    return 'Handoff review: 這個 session 尚未建立 link。在 impl session 輸入 /handoff-review 建立。'
  }
  const header = [
    `Handoff review ${link.id}`,
    `Status: ${link.status} · Round ${link.round}/${maxRounds} · Role: ${role ?? 'unknown'}`,
    `Impl session: ${link.implSessionId}`,
    `Review session: ${link.reviewSessionId ?? '(尚未建立)'}`,
    `Focus: ${link.focus ?? '整體變更'}`,
    `Reviewer: ${link.reviewerProvider ?? '(預設)'}${link.reviewerModel ? '/' + link.reviewerModel : ''}`,
    `Last error: ${link.lastError ?? 'none'}`,
  ]
  if (!Array.isArray(links) || links.length <= 1) return header.join('\n')
  const rows = links.map((item, index) => {
    const marker = item.id === link.id ? '*' : ' '
    return `${marker} ${index + 1}. ${item.id} · ${item.status} · Round ${item.round}/${maxRounds}`
  })
  return [
    `Handoff review: ${links.length} 個 link（新→舊，* 為目前選取）`,
    ...rows,
    '',
    ...header,
  ].join('\n')
}

/**
 * Reconcile durable links with live/persisted sessions after a restart
 * (DEVELOPMENT.md §7.4, §14).
 * @param {object} ctx Host plugin context
 * @param {object} store link store
 * @returns {Promise<void>}
 */
export async function reconcileLinks(ctx, store) {
  // An archived session is still readable through `sessionController.inspect`
  // and still listed by `sessionController.list()`, so archive state comes from
  // the workspace registry's archive set (DEVELOPMENT.md §7.4, §14).
  const archivedIds = listArchivedSessionIds(ctx)
  for (const link of store.list()) {
    try {
      if (link.status === 'creating') {
        await store.transition(link.id, 'failure', {
          lastError: 'plugin 重新啟動前未完成建立；review session id（若有）已保留。',
          now: Date.now(),
        })
        continue
      }
      if (!ACTIVE_STATUSES.includes(link.status)) continue
      const implAlive = await sessionExists(ctx, link.implSessionId)
      const reviewAlive =
        link.reviewSessionId === null ? true : await sessionExists(ctx, link.reviewSessionId)
      let reason = null
      if (!implAlive) reason = 'impl session 已不存在或已歸檔。'
      else if (!reviewAlive) reason = 'review session 已不存在或已歸檔。'
      else if (archivedIds !== undefined) {
        if (archivedIds.has(link.implSessionId)) reason = 'impl session 已歸檔。'
        else if (link.reviewSessionId !== null && archivedIds.has(link.reviewSessionId)) {
          reason = 'review session 已歸檔。'
        }
      }
      if (reason === null) continue
      await store.transition(link.id, 'stale', { lastError: reason, now: Date.now() })
    } catch (error) {
      console.error(
        `handoff-review: 無法對帳 link ${link.id}：${error && error.message ? error.message : String(error)}`,
      )
    }
  }
}

/**
 * Cordis plugin entry.
 * @param {object} ctx Host plugin context
 * @param {Record<string, unknown>} rawConfig validated composition-row config
 * @returns {Promise<void>}
 */
export async function apply(ctx, rawConfig) {
  let config = normalizeConfig(rawConfig)

  if (ctx.storageDomain === undefined) {
    throw new Error('handoff-review 需要 profile 掛載 storageDomain（@deepseek-ai/dsh-storage-domain）；請先補上 composition。')
  }

  let store
  let history
  try {
    store = await openLinkStore(ctx.storageDomain)
    history = await openHistoryStore(ctx.storageDomain)
  } catch (error) {
    throw new Error(
      `handoff-review 無法開啟 storage domain：${error && error.message ? error.message : String(error)}`,
    )
  }
  ctx.effect(() => () => {
    void Promise.resolve(store.close()).catch(() => {})
    void Promise.resolve(history.close()).catch(() => {})
  }, 'handoff-review: stores')

  let storedSettings
  try {
    storedSettings = await history.getSettings()
  } catch (error) {
    console.warn(
      `handoff-review: 無法讀取已保存的設定，使用 composition config：${error && error.message ? error.message : String(error)}`,
    )
  }
  // Composition config is the base (normalized with M1 semantics, not clamped by
  // the stricter Settings ranges); the settings page persists a partial override
  // in the plugin's own storage domain (no profile YAML edits).
  const baseConfig = normalizeConfig(rawConfig)
  let effectiveConfig = baseConfig
  const storedConfig = storedSettings !== undefined && storedSettings !== null ? storedSettings.config : undefined
  if (storedConfig !== undefined && storedConfig !== null && typeof storedConfig === 'object') {
    try {
      effectiveConfig = validateConfigPatch(baseConfig, storedConfig).config
    } catch (error) {
      console.warn(
        `handoff-review: 已保存的設定無效，改用 composition config：${error && error.message ? error.message : String(error)}`,
      )
    }
  }
  config = effectiveConfig

  const delivery = createDelivery({
    maxRounds: config.maxRounds,
    maxDeliveriesPerMinute: config.maxDeliveriesPerMinute,
  })
  const service = new HandoffService(ctx, config, { store, history, delivery, baseConfig })

  ctx.effect(() => registerHandoffProjections(ctx), 'handoff-review: projections')
  ctx.effect(() => registerCommands(ctx, service), 'handoff-review: command')

  // The web server may mount after this plugin; register the client API when it
  // becomes available instead of hard-injecting it (DEVELOPMENT.md §9.1).
  ctx.inject(['webServer'], (webCtx) => {
    registerRoutes(webCtx, service)
  })

  // Reviewer reply readiness: committed `turn/end` events are the durable
  // signal; the reply projection is materialized before the listener runs.
  ctx.on('session/event', (session, event) => {
    void service.onSessionEvent(session, event).catch((error) => {
      console.error(
        `handoff-review: turn/end 處理失敗：${error && error.message ? error.message : String(error)}`,
      )
    })
  })

  // Re-apply the reviewer lockdown whenever a known review agent is created
  // again (restart/resume path). Freshly created review agents have no link yet.
  ctx.on('agent/created', async ({ agent }) => {
    // A session becoming live may be exactly what an automated step was waiting
    // for (e.g. the impl session was reopened after a reboot).
    try {
      service.resumeAutoForSession(agent.session.id)
    } catch (error) {
      console.error(`handoff-review: 自動接續恢復失敗：${error && error.message ? error.message : String(error)}`)
    }
    // Read the live settings (a Settings save may have changed readOnlyReviewer).
    if (service.config.readOnlyReviewer !== true) return
    try {
      const link = store.list().find((candidate) => candidate.reviewSessionId === agent.session.id)
      if (link === undefined) return
      const warnings = applyReviewerPolicy(ctx, agent, service.config)
      for (const warning of warnings) console.warn(`handoff-review: ${warning}`)
    } catch (error) {
      console.error(
        `handoff-review: 重新套用 reviewer 唯讀失敗：${error && error.message ? error.message : String(error)}`,
      )
    }
  })

  // Startup reconciliation is background work: a slow persisted-session read
  // must not block plugin activation.
  void reconcileLinks(ctx, store).catch((error) => {
    console.error(`handoff-review: link 對帳失敗：${error && error.message ? error.message : String(error)}`)
  })
  // Resume an interrupted auto-continue chain (no-op when disabled or cold).
  try {
    service.resumeAutoContinue()
  } catch (error) {
    console.error(`handoff-review: 自動接續初始化失敗：${error && error.message ? error.message : String(error)}`)
  }
}

export { HandoffError }
