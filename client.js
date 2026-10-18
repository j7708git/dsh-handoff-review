/**
 * dsh-handoff-review — browser half (static profile plugin, hand-written in the
 * web module-loader bundle format; no build step, no relative or npm imports).
 *
 * M2 surface (DEVELOPMENT.md §5.3 Parity):
 * - one compact composer row (`conversation.input.dock`) with create/status/actions,
 *   a multi-link selector, real session navigation, and Panel/Diff entry points;
 * - a right-sidebar panel tab (`sidebar.right.pane.tab`) with link details, session
 *   navigation, round history, handoff/report previews, changed files and actions;
 * - a settings page (`settings.section`) for reviewer routing and handoff limits;
 * - a diff drawer in `conversation.input.overlay` with per-file unified diffs.
 *
 * All registrations live inside `ctx.effect`; copy goes through the client locale
 * service; every color is a `--dsw-alias-*` theme token, so light/dark follows the
 * host automatically.
 */
window.__ModuleLoader__.load({
  id: 'dsh-handoff-review',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    const React = require('react')

    /** Poll cadence for dock/panel state (DEVELOPMENT.md §10.2 asks for 2–4s). */
    const POLL_MS = 3000
    /** Lifetime of a success/notice message. */
    const NOTICE_MS = 4000
    /** Lifetime of an inline saved/reset confirmation. */
    const SHORT_NOTICE_MS = 3500
    /** Upper bound on one HTTP round trip so no surface can spin forever. */
    const REQUEST_TIMEOUT_MS = 12000
    /** Locale namespace owned by this plugin (dictionaries live in locale/*.json too). */
    const LOCALE_NS = 'handoff-review'
    /** Dock slot id and single-row order (DEVELOPMENT.md §10.1). */
    const SLOT_ID = 'handoff-review'
    const SLOT_ORDER = 18
    /** Right-sidebar tab type id/kind. */
    const TAB_ID = 'dsh-handoff-review/panel'
    const TAB_KIND = 'handoff-review'
    /** Diff drawer and settings registrations. */
    const DIFF_DRAWER_ID = 'handoff-review-diff'
    const DIFF_DRAWER_ORDER = 20
    const SETTINGS_ID = 'handoff-review'
    const SETTINGS_ORDER = 40
    /** Per-session selected-link storage. */
    const LINK_STORAGE_PREFIX = 'dsh:handoff-review:link:'
    /** Guard against rendering an unbounded unified diff. */
    const DRAWER_LINE_LIMIT = 400
    /** Status keys reused by the panel/drawer chips. */
    const STATUS_KEYS = {
      creating: 'status.creating',
      open: 'status.open',
      reviewing: 'status.reviewing',
      feedback_ready: 'status.feedback_ready',
      feedback_sent: 'status.feedback_sent',
      closed: 'status.closed',
      failed: 'status.failed',
      stale: 'status.stale',
    }
    /** Embedded fallback of the Host CONFIG_DEFAULTS (lib/config-admin.js). */
    const CONFIG_DEFAULTS = {
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
    }
    /** Numeric config fields with the Host-validated ranges. */
    const CONFIG_NUMERIC_FIELDS = [
      { key: 'maxRounds', min: 1, max: 20 },
      { key: 'maxHandoffChars', min: 1000, max: 200000 },
      { key: 'diffPerFileChars', min: 100, max: 50000 },
      { key: 'maxDeliveriesPerMinute', min: 1, max: 60 },
    ]
    const CONFIG_STRING_FIELDS = ['reviewerProvider', 'reviewerModel', 'reviewerReasoningEffort', 'reviewerPreset']
    const CONFIG_BOOLEAN_FIELDS = ['autoSummarize', 'readOnlyReviewer', 'autoContinue']

    const CSS =
      // Align this dock entry with the composer card: mirrors the shipped dock
      // width contract (side clearance + card max width) instead of spanning the
      // whole conversation column.
      '.hr-row{box-sizing:border-box;display:flex;flex-wrap:wrap;align-items:center;gap:6px;row-gap:4px;width:calc(100% - var(--dsh-composer-side-clearance) - var(--dsh-composer-side-clearance));max-width:var(--dsh-composer-card-max-width);margin:0 auto;padding:0 2px;min-height:26px;min-width:0;flex:none;font-size:12px;line-height:1.35;color:var(--dsw-alias-label-secondary)}' +
      '.hr-label{display:inline-flex;align-items:center;gap:6px;flex:none;white-space:nowrap;min-width:0}' +
      '.hr-title{font-weight:600;color:var(--dsw-alias-label-primary)}' +
      '.hr-sep{opacity:.6}' +
      '.hr-round{white-space:nowrap}' +
      '.hr-status{display:inline-flex;align-items:center;height:18px;padding:0 6px;border:1px solid var(--dsw-alias-border-l1);border-radius:6px;font-size:11.5px;line-height:1;color:var(--dsw-alias-label-secondary);white-space:nowrap}' +
      '.hr-status.hr-status-success{color:var(--dsw-alias-state-success-primary);border-color:var(--dsw-alias-state-success-primary)}' +
      '.hr-status.hr-status-error{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary)}' +
      '.hr-actions{display:inline-flex;align-items:center;flex-wrap:wrap;gap:4px;flex:none}' +
      '.hr-btn{display:inline-flex;align-items:center;justify-content:center;height:26px;padding:0 9px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:transparent;color:var(--dsw-alias-label-primary);font-family:inherit;font-size:12px;line-height:1;white-space:nowrap;cursor:pointer;transition:background .15s ease,color .15s ease,border-color .15s ease,opacity .15s ease}' +
      '.hr-btn:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2)}' +
      '.hr-btn:active:not(:disabled){background:var(--dsw-alias-bg-layer-1)}' +
      '.hr-btn:focus-visible{outline:none;border-color:var(--dsw-alias-label-secondary)}' +
      '.hr-btn:disabled{opacity:.55;cursor:default}' +
      '.hr-btn.hr-primary{background:var(--dsw-alias-bg-layer-2);font-weight:600}' +
      '.hr-btn.hr-primary:hover:not(:disabled){background:var(--dsw-alias-bg-layer-1)}' +
      '.hr-select{height:26px;max-width:132px;min-width:0;padding:0 6px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font-family:inherit;font-size:11.5px;line-height:1;cursor:pointer;flex:none}' +
      '.hr-select:disabled{opacity:.55;cursor:default}' +
      '.hr-select:focus-visible{outline:none;border-color:var(--dsw-alias-label-secondary)}' +
      '.hr-spacer{flex:1 1 auto;min-width:8px}' +
      '.hr-msg{flex:0 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11.5px}' +
      '.hr-msg.hr-error{color:var(--dsw-alias-state-error-primary)}' +
      '.hr-msg.hr-notice{color:var(--dsw-alias-state-success-primary)}' +
      '.hr-msg.hr-notice.hr-info{color:var(--dsw-alias-label-secondary)}' +
      '.hr-busy{display:inline-flex;align-items:center;gap:4px;flex:none;font-size:11.5px;white-space:nowrap;color:var(--dsw-alias-label-secondary)}' +
      '.hr-spin{display:block;animation:hr-spin .9s linear infinite}' +
      '@keyframes hr-spin{to{transform:rotate(360deg)}}' +
      // ---- right-sidebar panel ----
      '.hrp-root{display:flex;flex-direction:column;gap:10px;height:100%;min-width:0;box-sizing:border-box;padding:12px;overflow-y:auto;font-size:12.5px;line-height:1.45;color:var(--dsw-alias-label-primary)}' +
      '.hrp-head{display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap}' +
      '.hrp-head-title{font-size:13px;font-weight:600}' +
      '.hrp-head-meta{display:inline-flex;align-items:center;gap:6px;flex-wrap:wrap;color:var(--dsw-alias-label-secondary);font-size:11.5px}' +
      '.hrp-card{display:flex;flex-direction:column;gap:8px;min-width:0;padding:10px 12px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1)}' +
      '.hrp-card-title{font-size:11.5px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:var(--dsw-alias-label-secondary)}' +
      '.hrp-row{display:flex;align-items:flex-start;gap:8px;min-width:0}' +
      '.hrp-label{flex:none;width:92px;color:var(--dsw-alias-label-secondary);font-size:11.5px}' +
      '.hrp-value{flex:1 1 auto;min-width:0;overflow-wrap:anywhere;color:var(--dsw-alias-label-primary)}' +
      '.hrp-mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px}' +
      '.hrp-chip{display:inline-flex;align-items:center;height:18px;padding:0 6px;border:1px solid var(--dsw-alias-border-l1);border-radius:6px;font-size:11px;line-height:1;color:var(--dsw-alias-label-secondary);white-space:nowrap}' +
      '.hrp-chip.hrp-success{color:var(--dsw-alias-state-success-primary);border-color:var(--dsw-alias-state-success-primary)}' +
      '.hrp-chip.hrp-error{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary)}' +
      '.hrp-actions{display:flex;align-items:center;flex-wrap:wrap;gap:6px}' +
      '.hrp-pre{margin:0;width:100%;max-height:220px;overflow:auto;box-sizing:border-box;padding:8px 10px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;line-height:1.45;white-space:pre-wrap;word-break:break-word}' +
      '.hrp-round{border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-overlay);overflow:hidden}' +
      '.hrp-round-head{display:flex;align-items:center;gap:8px;width:100%;padding:7px 9px;border:none;background:transparent;color:var(--dsw-alias-label-primary);font-family:inherit;font-size:12px;line-height:1.35;text-align:left;cursor:pointer}' +
      '.hrp-round-head:hover{background:var(--dsw-alias-bg-layer-2)}' +
      '.hrp-round-head:focus-visible{outline:none;background:var(--dsw-alias-bg-layer-2)}' +
      '.hrp-round-title{flex:none;font-weight:600}' +
      '.hrp-round-meta{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-secondary);font-size:11px}' +
      '.hrp-round-chevron{flex:none;color:var(--dsw-alias-label-secondary);font-size:11px}' +
      '.hrp-round-body{display:flex;flex-direction:column;gap:6px;padding:0 9px 9px}' +
      '.hrp-files{display:flex;flex-direction:column;gap:4px;margin:0;padding:0;list-style:none}' +
      '.hrp-file{display:flex;align-items:center;gap:8px;min-width:0;font-size:11.5px}' +
      '.hrp-file-path{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--dsw-alias-label-primary)}' +
      '.hrp-diffstat{flex:none;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;color:var(--dsw-alias-label-secondary)}' +
      '.hrp-empty{color:var(--dsw-alias-label-secondary);font-size:11.5px}' +
      '.hrp-error{color:var(--dsw-alias-state-error-primary);font-size:11.5px;overflow-wrap:anywhere}' +
      '.hrp-notice{color:var(--dsw-alias-state-success-primary);font-size:11.5px;overflow-wrap:anywhere}' +
      '.hrp-loading{display:flex;align-items:center;gap:6px;color:var(--dsw-alias-label-secondary);font-size:12px}' +
      // ---- settings page ----
      '.hrs-root{display:flex;flex-direction:column;gap:16px;max-width:720px;padding:4px 2px 24px;font-size:12.5px;line-height:1.45;color:var(--dsw-alias-label-primary)}' +
      '.hrs-head{display:flex;flex-direction:column;gap:4px}' +
      '.hrs-title{font-size:15px;font-weight:600}' +
      '.hrs-desc{font-size:12px;color:var(--dsw-alias-label-secondary)}' +
      '.hrs-card{display:flex;flex-direction:column;gap:10px;padding:12px 14px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1)}' +
      '.hrs-card-title{font-size:11.5px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:var(--dsw-alias-label-secondary)}' +
      '.hrs-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:10px}' +
      '.hrs-field{display:flex;flex-direction:column;gap:4px;min-width:0}' +
      '.hrs-label{font-size:11.5px;color:var(--dsw-alias-label-secondary)}' +
      '.hrs-input,.hrs-select{width:100%;min-width:0;height:30px;box-sizing:border-box;padding:0 8px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font-family:inherit;font-size:12.5px}' +
      '.hrs-input:focus,.hrs-select:focus{outline:none;border-color:var(--dsw-alias-label-secondary)}' +
      '.hrs-input:disabled,.hrs-select:disabled{opacity:.55}' +
      '.hrs-check{display:flex;align-items:center;gap:8px;font-size:12.5px;color:var(--dsw-alias-label-primary)}' +
      '.hrs-check input{width:15px;height:15px;accent-color:var(--dsw-alias-state-success-primary)}' +
      '.hrs-actions{display:flex;align-items:center;flex-wrap:wrap;gap:8px}' +
      '.hrs-spacer{flex:1 1 auto}' +
      '.hrs-status{font-size:11.5px;overflow-wrap:anywhere}' +
      '.hrs-status.hrs-success{color:var(--dsw-alias-state-success-primary)}' +
      '.hrs-status.hrs-error{color:var(--dsw-alias-state-error-primary)}' +
      '.hrs-hint{font-size:11.5px;color:var(--dsw-alias-label-secondary)}' +
      // ---- diff drawer ----
      '.hrd-panel{position:absolute;bottom:calc(100% + 10px);left:50%;transform:translateX(-50%);width:min(780px,calc(100% - 24px));max-height:min(62vh,560px);display:flex;flex-direction:column;background:var(--dsw-alias-bg-overlay);border:1px solid var(--dsw-alias-border-l1);border-radius:12px;overflow:hidden;z-index:70;font-size:12px;color:var(--dsw-alias-label-primary)}' +
      '.hrd-head{display:flex;align-items:center;gap:8px;flex:none;padding:9px 12px;border-bottom:1px solid var(--dsw-alias-border-l1)}' +
      '.hrd-title{flex:none;font-size:12.5px;font-weight:600}' +
      '.hrd-meta{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-secondary);font-size:11.5px}' +
      '.hrd-body{flex:1 1 auto;min-height:0;display:flex;flex-direction:column;gap:10px;overflow-y:auto;padding:10px 12px}' +
      '.hrd-file{flex:none;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;overflow:hidden}' +
      '.hrd-file-head{display:flex;align-items:center;gap:8px;padding:6px 9px;background:var(--dsw-alias-bg-layer-1);border-bottom:1px solid var(--dsw-alias-border-l1);font-size:11.5px}' +
      '.hrd-file-path{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--dsw-alias-label-primary)}' +
      '.hrd-file-stat{flex:none;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;color:var(--dsw-alias-label-secondary)}' +
      '.hrd-diff{margin:0;max-height:300px;overflow:auto;padding:8px 10px;background:var(--dsw-alias-bg-layer-2);font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;line-height:1.45;white-space:pre}' +
      '.hrd-line{display:block;white-space:pre-wrap;word-break:break-word}' +
      '.hrd-line.hrd-add{color:var(--dsw-alias-state-success-primary)}' +
      '.hrd-line.hrd-del{color:var(--dsw-alias-state-error-primary)}' +
      '.hrd-line.hrd-hunk{color:var(--dsw-alias-label-secondary)}' +
      '.hrd-empty{padding:6px 0;color:var(--dsw-alias-label-secondary)}' +
      '.hrd-error{color:var(--dsw-alias-state-error-primary);overflow-wrap:anywhere}' +
      '.hrd-truncated{padding:4px 9px;border-top:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary);font-size:11px}' +
      '.hrd-foot{display:flex;align-items:center;justify-content:flex-end;gap:8px;flex:none;padding:9px 12px;border-top:1px solid var(--dsw-alias-border-l1)}'

    // The locale service consumes flat dotted-key dictionaries. locale/*.json keeps the
    // same translations nested (the plugin manager reads `meta` from there); the
    // verification script flattens the JSON and asserts these two objects match it exactly.
    /** English dictionary (fallback when the locale service is unavailable). */
    const EN = {
      "meta.title": "Handoff Review",
      "meta.description": "Hand off current session changes to a linked read-only review session.",
      "dock.title": "Handoff Review",
      "dock.aria": "Handoff review status",
      "dock.create": "Handoff review",
      "dock.openReview": "Open review",
      "dock.newReview": "New review",
      "dock.openImpl": "Open impl",
      "dock.sendFeedback": "Send feedback",
      "dock.sendRevision": "Send revision",
      "dock.sendRevisionForce": "Send revision (force)",
      "dock.close": "Close",
      "dock.retry": "Retry",
      "dock.round": "Round {round}",
      "dock.busy": "Working…",
      "dock.copied": "Copied session {id}",
      "dock.copyUnavailable": "Session: {id}",
      "dock.noReviewId": "Review session is not ready yet",
      "dock.sessionMissing": "Session is not ready yet",
      "dock.created": "Review session {id} opened",
      "dock.createSubmitted": "Handoff review started",
      "dock.feedbackSent": "Feedback sent to implementation",
      "dock.revisionSent": "Revision sent to review",
      "dock.closed": "Handoff review closed",
      "dock.networkError": "Network error; please retry.",
      "dock.httpError": "Request failed (HTTP {status}).",
      "dock.panel": "Panel",
      "dock.diff": "Diff",
      "dock.linkSelect": "Select handoff review",
      "dock.panelUnavailable": "Right sidebar is not available.",
      "dock.openFailed": "Could not open the session.",
      "status.creating": "Creating",
      "status.open": "Open",
      "status.reviewing": "Reviewing",
      "status.feedback_ready": "Feedback ready",
      "status.feedback_sent": "Feedback sent",
      "status.closed": "Closed",
      "status.failed": "Failed",
      "status.stale": "Stale",
      "panel.title": "Handoff Review",
      "panel.guideTitle": "Handoff review",
      "panel.guideDesc": "Status, rounds, and the current handoff diff",
      "panel.empty": "No handoff review link for this session.",
      "panel.link": "Link",
      "panel.round": "Round",
      "panel.roundHandoff": "Handoff",
      "panel.roundFeedback": "Feedback",
      "panel.status": "Status",
      "panel.implSession": "Implementation session",
      "panel.reviewSession": "Review session",
      "panel.reviewer": "Reviewer",
      "panel.reviewerDefault": "(default)",
      "panel.preset": "Preset",
      "panel.focus": "Review focus",
      "panel.updatedAt": "Updated",
      "panel.history": "Round history",
      "panel.historyEmpty": "No rounds recorded yet.",
      "panel.noReport": "No report for this round yet.",
      "panel.report": "Review report",
      "panel.handoff": "Current handoff",
      "panel.handoffEmpty": "No handoff preview available.",
      "panel.changedFiles": "Changed files",
      "panel.changedFilesEmpty": "No changed files.",
      "panel.loading": "Loading…",
      "panel.loadError": "Failed to load panel: {message}",
      "panel.openImpl": "Open implementation",
      "panel.openReview": "Open review",
      "panel.actions": "Actions",
      "panel.maxRounds": "Max rounds",
      "panel.openFailed": "Could not open the session.",
      "settings.label": "Handoff Review",
      "settings.title": "Handoff Review",
      "settings.description": "Reviewer routing, handoff limits, and review behavior.",
      "settings.reviewer": "Reviewer",
      "settings.provider": "Provider",
      "settings.providerDefault": "(Default provider)",
      "settings.model": "Model",
      "settings.modelDefault": "(Default model)",
      "settings.reasoning": "Thinking effort",
      "settings.reasoningDefault": "(Model default)",
      "settings.reasoningPlaceholder": "e.g. high",
      "settings.preset": "Agent preset",
      "settings.presetDefault": "(Default preset)",
      "settings.limits": "Handoff limits",
      "settings.maxRounds": "Max rounds",
      "settings.maxHandoffChars": "Max handoff characters",
      "settings.diffPerFileChars": "Max diff characters per file",
      "settings.maxDeliveriesPerMinute": "Max deliveries per minute",
      "settings.behavior": "Behavior",
      "settings.autoSummarize": "Summarize handoff automatically",
      "settings.readOnlyReviewer": "Force read-only reviewer",
      "settings.autoContinue": "Continue the review loop automatically",
      "settings.save": "Save",
      "settings.saving": "Saving…",
      "settings.saved": "Saved",
      "settings.reset": "Reset to defaults",
      "settings.resetting": "Resetting…",
      "settings.resetDone": "Reset to defaults",
      "settings.close": "Close",
      "settings.loading": "Loading…",
      "settings.loadError": "Failed to load settings: {message}",
      "settings.saveError": "Failed to save: {message}",
      "settings.retry": "Retry",
      "settings.catalogsEmpty": "No catalog entries are available; defaults are used.",
      "drawer.title": "Diff",
      "drawer.loading": "Loading diff…",
      "drawer.empty": "No changes to show for this round.",
      "drawer.error": "Failed to load diff: {message}",
      "drawer.close": "Close",
      "drawer.fileCount": "{count} files",
      "drawer.truncated": "… diff truncated",
    }

    /** Traditional Chinese dictionary (the user's locale). */
    const ZH = {
      "meta.title": "交接審查",
      "meta.description": "把目前 session 的變更交給一個連結的唯讀審查 session。",
      "dock.title": "交接審查",
      "dock.aria": "交接審查狀態",
      "dock.create": "交接審查",
      "dock.openReview": "開啟審查",
      "dock.newReview": "重新審查",
      "dock.openImpl": "開啟實作",
      "dock.sendFeedback": "送出回饋",
      "dock.sendRevision": "送出修訂",
      "dock.sendRevisionForce": "強制送出修訂",
      "dock.close": "結束",
      "dock.retry": "重試",
      "dock.round": "第 {round} 輪",
      "dock.busy": "處理中…",
      "dock.copied": "已複製 session {id}",
      "dock.copyUnavailable": "session：{id}",
      "dock.noReviewId": "審查 session 尚未就緒",
      "dock.sessionMissing": "session 尚未就緒",
      "dock.created": "已開啟審查 session {id}",
      "dock.createSubmitted": "已開始交接審查",
      "dock.feedbackSent": "回饋已送到實作 session",
      "dock.revisionSent": "修訂已送到審查 session",
      "dock.closed": "交接審查已結束",
      "dock.networkError": "網路錯誤，請重試。",
      "dock.httpError": "請求失敗（HTTP {status}）。",
      "dock.panel": "面板",
      "dock.diff": "差異",
      "dock.linkSelect": "選擇交接審查",
      "dock.panelUnavailable": "右側欄無法使用。",
      "dock.openFailed": "無法開啟 session。",
      "status.creating": "建立中",
      "status.open": "已開啟",
      "status.reviewing": "審查中",
      "status.feedback_ready": "回饋待送",
      "status.feedback_sent": "回饋已送",
      "status.closed": "已結束",
      "status.failed": "失敗",
      "status.stale": "已失效",
      "panel.title": "交接審查",
      "panel.guideTitle": "交接審查",
      "panel.guideDesc": "狀態、輪次與目前交接差異",
      "panel.empty": "此 session 尚無交接審查連結。",
      "panel.link": "連結",
      "panel.round": "輪次",
      "panel.roundHandoff": "交接",
      "panel.roundFeedback": "回饋",
      "panel.status": "狀態",
      "panel.implSession": "實作 session",
      "panel.reviewSession": "審查 session",
      "panel.reviewer": "審查者",
      "panel.reviewerDefault": "（預設）",
      "panel.preset": "預設組合",
      "panel.focus": "審查重點",
      "panel.updatedAt": "更新時間",
      "panel.history": "輪次歷史",
      "panel.historyEmpty": "尚無輪次紀錄。",
      "panel.noReport": "此輪尚無報告。",
      "panel.report": "審查報告",
      "panel.handoff": "目前交接內容",
      "panel.handoffEmpty": "尚無交接內容預覽。",
      "panel.changedFiles": "變更檔案",
      "panel.changedFilesEmpty": "尚無變更檔案。",
      "panel.loading": "載入中…",
      "panel.loadError": "無法載入面板：{message}",
      "panel.openImpl": "開啟實作",
      "panel.openReview": "開啟審查",
      "panel.actions": "動作",
      "panel.maxRounds": "最大輪次",
      "panel.openFailed": "無法開啟 session。",
      "settings.label": "交接審查",
      "settings.title": "交接審查",
      "settings.description": "審查者路由、交接限制與審查行為。",
      "settings.reviewer": "審查者",
      "settings.provider": "提供者",
      "settings.providerDefault": "（預設提供者）",
      "settings.model": "模型",
      "settings.modelDefault": "（預設模型）",
      "settings.reasoning": "思考能力",
      "settings.reasoningDefault": "（模型預設）",
      "settings.reasoningPlaceholder": "例如 high",
      "settings.preset": "代理預設組合",
      "settings.presetDefault": "（預設組合）",
      "settings.limits": "交接限制",
      "settings.maxRounds": "最大輪次",
      "settings.maxHandoffChars": "交接內容字元上限",
      "settings.diffPerFileChars": "每檔差異字元上限",
      "settings.maxDeliveriesPerMinute": "每分鐘最大投遞次數",
      "settings.behavior": "行為",
      "settings.autoSummarize": "自動摘要交接內容",
      "settings.readOnlyReviewer": "強制唯讀審查者",
      "settings.autoContinue": "自動接續審查流程",
      "settings.save": "儲存",
      "settings.saving": "儲存中…",
      "settings.saved": "已儲存",
      "settings.reset": "重設為預設值",
      "settings.resetting": "重設中…",
      "settings.resetDone": "已重設為預設值",
      "settings.close": "關閉",
      "settings.loading": "載入中…",
      "settings.loadError": "無法載入設定：{message}",
      "settings.saveError": "無法儲存：{message}",
      "settings.retry": "重試",
      "settings.catalogsEmpty": "尚無可用清單項目，將使用預設值。",
      "drawer.title": "差異",
      "drawer.loading": "載入差異中…",
      "drawer.empty": "此輪尚無可顯示的變更。",
      "drawer.error": "無法載入差異：{message}",
      "drawer.close": "關閉",
      "drawer.fileCount": "{count} 個檔案",
      "drawer.truncated": "… 差異已截斷",
    }

    /**
     * Interpolate `{name}` placeholders like the locale service does.
     * @param {string} template Message template.
     * @param {Record<string, unknown>} [params] Replacement values.
     * @returns {string} Interpolated text.
     */
    const interpolate = (template, params) => {
      if (typeof template !== 'string') return ''
      if (!params) return template
      return template.replace(/\{(\w+)\}/g, (match, name) =>
        Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match)
    }

    /**
     * Build the embedded-English translate function used when the client locale
     * service is missing or still unavailable at mount.
     * @returns {(key: string, params?: Record<string, unknown>) => string} translate
     */
    const makeFallbackT = () => (key, params) =>
      interpolate(Object.prototype.hasOwnProperty.call(EN, key) ? EN[key] : key, params)

    /** Translate function used before/without the locale service. */
    const fallbackT = makeFallbackT()

    /**
     * Resolve the client locale service defensively (a plain property on ctx in
     * this runtime; `ctx.get('locale')` is the generic fallback).
     * @param {object} ctx Client plugin context.
     * @returns {object|null} Locale service or null.
     */
    const resolveLocale = (ctx) => {
      try {
        if (ctx && ctx.locale) return ctx.locale
        if (ctx && typeof ctx.get === 'function') return ctx.get('locale') || null
      } catch (error) {
        return null
      }
      return null
    }

    /**
     * Resolve an optional client service without throwing when it is absent.
     * @param {object} ctx Client plugin context.
     * @param {string} name Injected service name.
     * @returns {object|null} Service or null.
     */
    const serviceOf = (ctx, name) => {
      try {
        if (ctx && ctx[name]) return ctx[name]
        if (ctx && typeof ctx.get === 'function') return ctx.get(name) || null
      } catch (error) {
        return null
      }
      return null
    }

    /**
     * Localized status label; unknown statuses fall through to their wire value.
     * @param {(key: string, params?: Record<string, unknown>) => string} t translate
     * @param {string|null|undefined} status Link status from the Host.
     * @returns {string} Localized status text.
     */
    const statusLabel = (t, status) => {
      const key = typeof status === 'string' ? STATUS_KEYS[status] : undefined
      if (key) return t(key)
      return typeof status === 'string' ? status : ''
    }

    /**
     * Localized label for a *round* record status (`handoff` | `feedback`), which
     * is a different domain from the link status machine.
     * @param {(key: string, params?: Record<string, unknown>) => string} t translate
     * @param {string|null|undefined} status Round record status from the Host.
     * @returns {string} Localized status text.
     */
    const roundStatusLabel = (t, status) => {
      if (status === 'handoff') return t('panel.roundHandoff')
      if (status === 'feedback') return t('panel.roundFeedback')
      return statusLabel(t, status)
    }

    /**
     * Host-facing error text: prefer the Host `message`, then the error `code`,
     * then a localized generic network error.
     * @param {object|null} body Parsed Host response body.
     * @param {(key: string, params?: Record<string, unknown>) => string} t translate
     * @returns {string} Display text.
     */
    const messageOf = (body, t) => {
      if (body && typeof body.message === 'string' && body.message.trim()) return body.message
      if (body && typeof body.code === 'string' && body.code) return body.code
      return t('dock.networkError')
    }

    /**
     * Fetch + parse one JSON response with a hard timeout. HTTP failures are
     * rethrown preserving the Host message; transport failures/timeouts become a
     * localized network error, so callers always get a user-visible string.
     * @param {string} url Request path.
     * @param {RequestInit} options Fetch options (method/headers/body).
     * @param {(key: string, params?: Record<string, unknown>) => string} t translate
     * @returns {Promise<object>} Parsed JSON body.
     */
    const requestJson = async (url, options, t) => {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
      try {
        const response = await fetch(url, {
          credentials: 'same-origin',
          ...options,
          signal: controller.signal,
        })
        let body = null
        try {
          body = await response.json()
        } catch (error) {
          body = null
        }
        if (!response.ok) {
          const message = body && typeof body.message === 'string' && body.message.trim()
            ? body.message
            : t('dock.httpError', { status: response.status })
          const httpError = new Error(message)
          httpError.hrHttp = true
          httpError.code = body && typeof body.code === 'string' ? body.code : undefined
          throw httpError
        }
        if (!body || typeof body !== 'object') {
          const shapeError = new Error(t('dock.networkError'))
          shapeError.hrHttp = true
          throw shapeError
        }
        return body
      } catch (error) {
        if (error && error.hrHttp) throw error
        throw new Error(t('dock.networkError'))
      } finally {
        clearTimeout(timer)
      }
    }

    /**
     * Build a Host route URL from optional string parameters.
     * @param {string} path Route path.
     * @param {{sessionId?: string, linkId?: string|null}} params Query parameters.
     * @returns {string} URL with the non-empty parameters encoded.
     */
    const routeUrl = (path, params) => {
      const query = []
      if (params && params.sessionId) query.push('sessionId=' + encodeURIComponent(params.sessionId))
      if (params && params.linkId) query.push('linkId=' + encodeURIComponent(params.linkId))
      return path + (query.length > 0 ? '?' + query.join('&') : '')
    }
    const stateUrl = (sessionId, linkId) => routeUrl('/handoff-review/api/state', { sessionId, linkId })
    const panelUrl = (sessionId, linkId) => routeUrl('/handoff-review/api/panel', { sessionId, linkId })
    const diffUrl = (sessionId, linkId) => routeUrl('/handoff-review/api/diff', { sessionId, linkId })

    /**
     * One small inline spinner (text-equivalent busy affordance).
     * @param {number} size Pixel size.
     * @returns {object} React element.
     */
    const spinnerElement = (size) => React.createElement('svg', {
      className: 'hr-spin',
      viewBox: '0 0 16 16',
      width: String(size),
      height: String(size),
      'aria-hidden': true,
    }, React.createElement('path', {
      d: 'M8 1.5a6.5 6.5 0 1 0 6.5 6.5H13A5 5 0 1 1 8 3V1.5z',
      fill: 'currentColor',
    }))

    /**
     * Build the compact dock row shell.
     * @param {string} ariaLabel Localized row aria-label.
     * @param {Array<object|null>} children Row children.
     * @returns {object} React element.
     */
    const rowElement = (ariaLabel, children) => React.createElement('div', {
      className: 'hr-row',
      role: 'group',
      'aria-label': ariaLabel,
    }, children.filter(Boolean))

    /**
     * Build one compact button (dock/panel/drawer/settings share the style).
     * @param {object} spec Button spec: key, label, onClick, disabled, primary, title.
     * @returns {object} React element.
     */
    const buttonElement = (spec) => React.createElement('button', {
      key: spec.key,
      type: 'button',
      className: 'hr-btn' + (spec.primary ? ' hr-primary' : ''),
      disabled: !!spec.disabled,
      title: spec.title || spec.label,
      'aria-label': spec.title || spec.label,
      onClick: spec.onClick,
    }, spec.label)

    /**
     * Map a link status to the status chip tone class.
     * @param {string|null|undefined} status Link status.
     * @returns {string} Extra class name (possibly empty).
     */
    const statusToneClass = (status) => {
      if (status === 'failed' || status === 'stale') return ' hr-status-error'
      if (status === 'open' || status === 'feedback_ready') return ' hr-status-success'
      return ' hr-status-plain'
    }

    /**
     * Render a timestamp (epoch ms) through the browser's locale formatting.
     * @param {unknown} value Host timestamp.
     * @returns {string} Localized date/time, or '' when unavailable.
     */
    const formatTime = (value) => {
      const numeric = typeof value === 'number' ? value : Number(value)
      if (!Number.isFinite(numeric) || numeric <= 0) return ''
      try {
        return new Date(numeric).toLocaleString()
      } catch (error) {
        return ''
      }
    }

    /**
     * Human-readable reviewer route for the panel.
     * @param {(key: string, params?: Record<string, unknown>) => string} t translate
     * @param {object|null|undefined} reviewer Host reviewer descriptor.
     * @returns {string} provider/model, preset, or the localized default label.
     */
    const reviewerRoute = (t, reviewer) => {
      const route = reviewer && typeof reviewer === 'object' ? reviewer : {}
      const provider = typeof route.provider === 'string' ? route.provider.trim() : ''
      const model = typeof route.model === 'string' ? route.model.trim() : ''
      const preset = typeof route.preset === 'string' ? route.preset.trim() : ''
      if (provider && model) return provider + '/' + model
      if (provider) return provider
      if (model) return model
      if (preset) return preset
      return t('panel.reviewerDefault')
    }

    /**
     * Merge the Host `can` flags with locally derived capabilities. Host flags win
     * when present so a future Host stays authoritative without a client change.
     * @param {object|null|undefined} link Selected link.
     * @param {string|null|undefined} role 'impl' | 'review' | null.
     * @param {object|null|undefined} can Host capability flags.
     * @returns {{feedback: boolean, revision: boolean, close: boolean}} capabilities.
     */
    const deriveCapabilities = (link, role, can) => {
      const flags = can && typeof can === 'object' ? can : {}
      const status = link && typeof link.status === 'string' ? link.status : ''
      const active = status !== '' && status !== 'closed'
      const derived = {
        feedback: active && status === 'feedback_ready',
        // Host `can.revision` follows a sent reviewer report (§8.3), i.e. only
        // `open` (after reopen) and `feedback_sent`.
        revision: active && role === 'impl'
          && (status === 'open' || status === 'feedback_sent'),
        close: active,
      }
      return {
        feedback: typeof flags.feedback === 'boolean' ? flags.feedback : derived.feedback,
        revision: typeof flags.revision === 'boolean' ? flags.revision : derived.revision,
        close: typeof flags.close === 'boolean' ? flags.close : derived.close,
      }
    }

    /**
     * Strip the markdown diff fence that `renderFileDiff` adds, for plain rendering.
     * @param {unknown} value Raw diff text.
     * @returns {string} Unfenced diff body.
     */
    const stripDiffFence = (value) => {
      if (typeof value !== 'string' || value === '') return ''
      const lines = value.split('\n')
      if (lines.length > 0 && /^```(?:diff)?\s*$/i.test(lines[0].trim())) lines.shift()
      while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop()
      if (lines.length > 0 && lines[lines.length - 1].trim() === '```') lines.pop()
      return lines.join('\n')
    }

    /**
     * Tone class for one unified-diff line.
     * @param {string} line One diff line.
     * @returns {string} Extra class name (possibly empty).
     */
    const diffLineClass = (line) => {
      if (typeof line !== 'string' || line === '') return ''
      if (line.startsWith('@@')) return ' hrd-hunk'
      if (line.startsWith('+++') || line.startsWith('---')) return ''
      if (line.startsWith('+')) return ' hrd-add'
      if (line.startsWith('-')) return ' hrd-del'
      return ''
    }

    /** @type {Set<Function>} Per-session selected-link subscriptions. */
    const linkChangeListeners = new Set()

    /**
     * Subscribe to selected-link changes/refresh requests.
     * @param {Function} listener Receives `{ sessionId, linkId }`.
     * @returns {Function} unsubscribe
     */
    const subscribeLinkChanges = (listener) => {
      linkChangeListeners.add(listener)
      return () => { linkChangeListeners.delete(listener) }
    }

    /**
     * Broadcast a link selection/refresh for one session.
     * @param {string} sessionId Session whose link context changed.
     * @param {string|null|undefined} linkId Newly selected link id.
     * @returns {void}
     */
    const emitLinkChange = (sessionId, linkId) => {
      for (const listener of [...linkChangeListeners]) {
        try {
          listener({ sessionId, linkId: typeof linkId === 'string' && linkId ? linkId : null })
        } catch (error) {
          console.error('handoff-review: link listener failed', error)
        }
      }
    }

    /**
     * localStorage key for a session's selected link.
     * @param {string} sessionId Session id.
     * @returns {string} Storage key.
     */
    const linkStorageKey = (sessionId) => LINK_STORAGE_PREFIX + sessionId

    /**
     * Read the persisted selected link id for one session.
     * @param {string|undefined} sessionId Session id.
     * @returns {string|null} Selected link id or null.
     */
    const readLinkSelection = (sessionId) => {
      if (!sessionId) return null
      try {
        const value = localStorage.getItem(linkStorageKey(sessionId))
        return typeof value === 'string' && value !== '' ? value : null
      } catch (error) {
        return null
      }
    }

    /**
     * Persist (or clear) the selected link id for one session.
     * @param {string|undefined} sessionId Session id.
     * @param {string|null} linkId Selected link id, or null to clear.
     * @returns {void}
     */
    const writeLinkSelection = (sessionId, linkId) => {
      if (!sessionId) return
      try {
        if (typeof linkId === 'string' && linkId !== '') localStorage.setItem(linkStorageKey(sessionId), linkId)
        else localStorage.removeItem(linkStorageKey(sessionId))
      } catch (error) {
        /* storage unavailable: selection stays in memory for this mount */
      }
    }

    /** @type {Map<string, {open: boolean, linkId: string|null, round: number|null}>} */
    const drawerStates = new Map()
    /** @type {Set<Function>} Drawer state subscriptions. */
    const drawerListeners = new Set()

    /**
     * Read one session's diff-drawer state.
     * @param {string|undefined} sessionId Session id.
     * @returns {{open: boolean, linkId: string|null, round: number|null}} drawer state
     */
    const drawerOf = (sessionId) => {
      const state = sessionId ? drawerStates.get(sessionId) : undefined
      return state || { open: false, linkId: null, round: null }
    }

    /**
     * Subscribe to diff-drawer state changes.
     * @param {Function} listener Change callback.
     * @returns {Function} unsubscribe
     */
    const subscribeDrawer = (listener) => {
      drawerListeners.add(listener)
      return () => { drawerListeners.delete(listener) }
    }

    /**
     * Patch one session's drawer state and notify subscribers.
     * @param {string} sessionId Session id.
     * @param {object} patch Partial drawer state.
     * @returns {void}
     */
    const patchDrawer = (sessionId, patch) => {
      if (!sessionId) return
      if (!drawerStates.has(sessionId) && drawerStates.size >= 64) {
        const oldest = drawerStates.keys().next().value
        if (oldest !== undefined) drawerStates.delete(oldest)
      }
      const next = { ...drawerOf(sessionId), ...patch }
      drawerStates.set(sessionId, next)
      for (const listener of [...drawerListeners]) {
        try { listener(next) } catch (error) { console.error('handoff-review: drawer listener failed', error) }
      }
    }

    /**
     * Open the diff drawer for one session/link/round.
     * @param {string} sessionId Session id.
     * @param {string|null|undefined} linkId Link id.
     * @param {number|null|undefined} round Round number.
     * @returns {void}
     */
    const openDiffDrawer = (sessionId, linkId, round) => {
      patchDrawer(sessionId, {
        open: true,
        linkId: typeof linkId === 'string' && linkId ? linkId : null,
        round: Number.isFinite(round) ? round : null,
      })
    }

    /**
     * Close the diff drawer for one session.
     * @param {string} sessionId Session id.
     * @returns {void}
     */
    const closeDiffDrawer = (sessionId) => {
      patchDrawer(sessionId, { open: false })
    }

    /**
     * Copy text to the clipboard when the browser allows it.
     * @param {string} text Text to copy.
     * @returns {Promise<boolean>} true when the clipboard write succeeded.
     */
    const copyText = async (text) => {
      if (typeof navigator === 'undefined' || !navigator.clipboard
        || typeof navigator.clipboard.writeText !== 'function') return false
      try {
        await navigator.clipboard.writeText(text)
        return true
      } catch (error) {
        return false
      }
    }

    /**
     * Navigate to a session through `ctx.uiWorkspace.openSession`, falling back to
     * a clipboard copy + notice when navigation is unavailable (M2).
     * @param {object} runtime Client runtime surface.
     * @param {string} targetId Session id to open.
     * @param {(key: string, params?: Record<string, unknown>) => string} t translate
     * @param {Function} onNotice Notice setter.
     * @param {Function} onError Error setter.
     * @param {string} [missingKey] Locale key used when the id is empty.
     * @returns {Promise<void>}
     */
    const openSessionWithFallback = async (runtime, targetId, t, onNotice, onError, missingKey) => {
      if (typeof targetId !== 'string' || targetId === '') {
        if (typeof onError === 'function') onError({ message: t(missingKey || 'dock.sessionMissing') })
        return
      }
      let opened = false
      if (runtime && typeof runtime.openSession === 'function') {
        const result = await runtime.openSession(targetId)
        opened = !!(result && result.ok)
        if (!opened && result && result.message) {
          console.error('handoff-review: openSession failed', result.message)
        }
      }
      if (opened) {
        if (typeof onError === 'function') onError(null)
        return
      }
      const copied = await copyText(targetId)
      if (typeof onError === 'function') onError(null)
      if (typeof onNotice === 'function') {
        onNotice({
          key: Date.now() + ':open:' + targetId,
          text: copied
            ? t('dock.copied', { id: targetId })
            : t('dock.copyUnavailable', { id: targetId }),
          tone: copied ? 'success' : 'info',
        })
      }
    }

    /**
     * Re-render a header component when the active locale or dictionaries change.
     * @param {Function|undefined} subscribeLocale Locale subscription helper.
     * @returns {void}
     */
    const useLocaleTick = (subscribeLocale) => {
      const [, setTick] = React.useState(0)
      React.useEffect(() => {
        if (typeof subscribeLocale !== 'function') return undefined
        return subscribeLocale(() => setTick((value) => value + 1))
      }, [subscribeLocale])
    }

    /**
     * The composer-dock handoff-review row.
     *
     * M1 presentations remain: create-only without a link, the status line plus
     * role/`can`-gated actions with a link, and host error + retry. M2 adds the
     * Panel/Diff entry points, real session navigation, and a multi-link selector
     * persisted per session.
     * @param {object} props Slot props plus the plugin runtime surface.
     * @returns {object|null} React element or null.
     */
    function HandoffReviewRow(props) {
      const sessionId = props.sessionId || (props.session && props.session.id) || undefined
      const runtime = props.runtime || {}
      const t = typeof props.t === 'function'
        ? props.t
        : (typeof runtime.t === 'function' ? runtime.t : fallbackT)
      const subscribeLocale = typeof props.subscribeLocale === 'function'
        ? props.subscribeLocale
        : runtime.subscribeLocale

      const [data, setData] = React.useState(null)
      const [loaded, setLoaded] = React.useState(false)
      const [loadError, setLoadError] = React.useState(null)
      const [pending, setPending] = React.useState(null)
      const [actionError, setActionError] = React.useState(null)
      const [notice, setNotice] = React.useState(null)
      const [linkId, setLinkId] = React.useState(() => readLinkSelection(sessionId))
      const [, bumpLocale] = React.useState(0)

      const mountedRef = React.useRef(true)
      const pendingRef = React.useRef(false)
      const sessionRef = React.useRef(sessionId)
      const dataRef = React.useRef(null)
      const refreshRef = React.useRef(() => {})
      const lastActionRef = React.useRef(null)
      sessionRef.current = sessionId

      React.useEffect(() => {
        mountedRef.current = true
        return () => {
          mountedRef.current = false
          pendingRef.current = false
        }
      }, [])

      // Locale switches must re-render the row; the bound translator itself reads
      // the live locale on every call.
      React.useEffect(() => {
        if (typeof subscribeLocale !== 'function') return undefined
        return subscribeLocale(() => {
          if (mountedRef.current) bumpLocale((value) => value + 1)
        })
      }, [subscribeLocale])

      // Session switches reload the persisted selection for the new session.
      React.useEffect(() => {
        setLinkId(readLinkSelection(sessionId))
      }, [sessionId])

      // Selection changes made elsewhere (or a refresh request after an action)
      // keep this row in sync.
      React.useEffect(() => subscribeLinkChanges((event) => {
        if (!mountedRef.current || event.sessionId !== sessionRef.current) return
        setLinkId(event.linkId || null)
      }), [])

      // State acquisition: initial load, session/link switch, and a 3s poll. A
      // failed poll keeps the last good state; a failed first load surfaces an
      // error row. The selection is read from storage on every run so a poll
      // never races a just-written selection.
      React.useEffect(() => {
        if (!sessionId) {
          setData(null)
          setLoaded(true)
          return undefined
        }
        let cancelled = false
        let running = false
        let gotState = false
        let clearedSelection = false
        const sid = sessionId
        setData(null)
        setLoaded(false)
        setLoadError(null)
        setActionError(null)
        setNotice(null)
        setPending(null)
        pendingRef.current = false

        const run = async () => {
          if (cancelled || running || pendingRef.current) return
          running = true
          let failure = null
          try {
            const selection = readLinkSelection(sid)
            const body = await requestJson(stateUrl(sid, selection), {}, t)
            if (cancelled || sessionRef.current !== sid) return
            if (body && body.ok) {
              gotState = true
              const links = Array.isArray(body.links) ? body.links : []
              if (selection && !links.some((item) => item && item.id === selection)) {
                writeLinkSelection(sid, null)
                setLinkId(null)
                clearedSelection = true
              }
              setData(body)
              setLoadError(null)
            } else {
              failure = { message: messageOf(body, t), code: body && body.code }
            }
          } catch (error) {
            failure = {
              message: (error && error.message) || t('dock.networkError'),
              code: error && error.code,
            }
          } finally {
            running = false
            if (!cancelled && sessionRef.current === sid) {
              if (failure && !gotState) setLoadError(failure)
              setLoaded(true)
              if (clearedSelection) {
                clearedSelection = false
                refreshRef.current()
              }
            }
          }
        }

        refreshRef.current = run
        run()
        const interval = setInterval(() => { run() }, POLL_MS)
        return () => {
          cancelled = true
          clearInterval(interval)
          refreshRef.current = () => {}
        }
      }, [sessionId, t])

      // Success/notice auto-hide (~4s), with cleanup on unmount or replacement.
      React.useEffect(() => {
        if (!notice) return undefined
        const timer = setTimeout(() => {
          if (mountedRef.current) setNotice(null)
        }, NOTICE_MS)
        return () => clearTimeout(timer)
      }, [notice])

      dataRef.current = data && (data.sessionId === undefined || data.sessionId === sessionId)
        ? data
        : null

      // An open diff drawer follows the selected link's round: a new round (or a
      // link switch) refetches /api/diff instead of showing stale hunks.
      React.useEffect(() => {
        const current = dataRef.current
        const liveRound = current && current.link && Number.isFinite(current.link.round)
          ? current.link.round
          : null
        if (!sessionId || liveRound === null) return
        const state = drawerOf(sessionId)
        if (state.open && state.round !== liveRound) patchDrawer(sessionId, { round: liveRound })
      }, [sessionId, data])

      /**
       * Selected link id for a request: the visible link first, then the
       * persisted per-session selection.
       * @returns {string|undefined} Link id.
       */
      const currentLinkId = () => {
        const current = dataRef.current
        if (current && current.link && typeof current.link.id === 'string') return current.link.id
        return readLinkSelection(sessionRef.current) || undefined
      }

      /**
       * POST one link action, then refresh state immediately. Failures become the
       * inline host error; successes become a short-lived notice.
       * @param {'create'|'feedback'|'revision'|'close'} kind Action endpoint.
       * @param {string} [focus] Review focus reused when retrying a create.
       * @param {boolean} [force] Force a revision past maxRounds (DEVELOPMENT.md §7.3).
       * @param {string} [retryLinkId] Link targeted when retrying a failed/stale link.
       * @returns {Promise<void>}
       */
      const runAction = async (kind, focus, force, retryLinkId) => {
        if (pendingRef.current) return
        const sid = sessionRef.current
        if (!sid) return
        pendingRef.current = true
        setPending(kind)
        setActionError(null)

        let result = null
        let failure = null
        try {
          const payload = { sessionId: sid }
          if (kind === 'create') {
            if (typeof focus === 'string' && focus) payload.focus = focus
            if (typeof retryLinkId === 'string' && retryLinkId) payload.linkId = retryLinkId
          } else {
            const selectedId = currentLinkId()
            if (selectedId) payload.linkId = selectedId
          }
          if (kind === 'revision' && force === true) payload.force = true
          result = await requestJson('/handoff-review/api/' + kind, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(payload),
          }, t)
          if (!result || result.ok !== true) {
            failure = { message: messageOf(result || {}, t), code: result && result.code }
          }
        } catch (error) {
          failure = {
            message: (error && error.message) || t('dock.networkError'),
            code: error && error.code,
          }
        }

        pendingRef.current = false
        lastActionRef.current = failure ? { kind, focus, force, retryLinkId } : null
        if (!mountedRef.current) return
        setPending(null)
        if (failure) {
          setActionError(failure)
        } else if (result) {
          const resultLink = result.link && typeof result.link === 'object' ? result.link : null
          if (resultLink) {
            setData((previous) => (previous ? { ...previous, link: resultLink } : previous))
          }
          const createdId = kind === 'create' && resultLink && typeof resultLink.id === 'string'
            ? resultLink.id
            : ''
          if (createdId) {
            writeLinkSelection(sid, createdId)
            setLinkId(createdId)
          }
          const reviewId = result.reviewSessionId
            || (resultLink && resultLink.reviewSessionId)
            || ''
          let text = ''
          if (kind === 'create') {
            text = reviewId ? t('dock.created', { id: reviewId }) : t('dock.createSubmitted')
          } else if (kind === 'feedback') {
            text = t('dock.feedbackSent')
          } else if (kind === 'revision') {
            text = t('dock.revisionSent')
          } else if (kind === 'close') {
            text = t('dock.closed')
          }
          if (text) {
            setNotice({ key: Date.now() + ':' + kind, text, tone: 'success' })
          }
          emitLinkChange(sid, createdId || currentLinkId())
        }
        refreshRef.current()
      }

      /**
       * Retry: failed/stale links recreate from the preserved focus; a failed
       * action is replayed; otherwise the state is merely re-pulled.
       * @returns {void}
       */
      const onRetry = () => {
        const currentLink = dataRef.current && dataRef.current.link
        if (currentLink && (currentLink.status === 'failed' || currentLink.status === 'stale')) {
          runAction('create', typeof currentLink.focus === 'string' ? currentLink.focus : undefined,
            false, typeof currentLink.id === 'string' ? currentLink.id : undefined)
          return
        }
        const last = lastActionRef.current
        // Replaying a create while a link now exists would only reproduce
        // ALREADY_LINKED; the refreshed state is the useful outcome there.
        if (last && !(last.kind === 'create' && currentLink)) {
          runAction(last.kind, last.focus, last.force, last.retryLinkId)
          return
        }
        setActionError(null)
        refreshRef.current()
      }

      /**
       * Open the review session through the workspace service, falling back to
       * the clipboard (M2 replaces the M1 copy-only behaviour).
       * @returns {Promise<void>}
       */
      const onOpenReview = async () => {
        const currentLink = dataRef.current && dataRef.current.link
        const reviewId = currentLink && typeof currentLink.reviewSessionId === 'string'
          ? currentLink.reviewSessionId
          : ''
        if (!reviewId) {
          setActionError({ message: t('dock.noReviewId') })
          return
        }
        await openSessionWithFallback(runtime, reviewId, t, setNotice, setActionError, 'dock.noReviewId')
      }

      /**
       * Open the implementation session from a review-side row.
       * @returns {Promise<void>}
       */
      const onOpenImpl = async () => {
        const currentLink = dataRef.current && dataRef.current.link
        const implId = currentLink && typeof currentLink.implSessionId === 'string'
          ? currentLink.implSessionId
          : ''
        if (!implId) {
          setActionError({ message: t('dock.sessionMissing') })
          return
        }
        await openSessionWithFallback(runtime, implId, t, setNotice, setActionError)
      }

      /**
       * Expand the right sidebar and focus the handoff-review panel tab.
       * @returns {void}
       */
      const onOpenPanel = () => {
        const result = runtime && typeof runtime.openPanel === 'function'
          ? runtime.openPanel()
          : { ok: false }
        if (result && result.ok) return
        if (result && result.message) console.error('handoff-review: could not open panel', result.message)
        setNotice({ key: Date.now() + ':panel', text: t('dock.panelUnavailable'), tone: 'info' })
      }

      /**
       * Open the diff drawer for the selected link.
       * @returns {void}
       */
      const onOpenDiff = () => {
        const currentLink = dataRef.current && dataRef.current.link
        if (!currentLink) {
          setActionError({ message: t('dock.noReviewId') })
          return
        }
        openDiffDrawer(sessionId, currentLink.id || readLinkSelection(sessionId), currentLink.round)
      }

      /**
       * Persist and broadcast the multi-link selection.
       * @param {object} event Change event from the <select>.
       * @returns {void}
       */
      const onSelectLink = (event) => {
        const next = event && event.target && typeof event.target.value === 'string' && event.target.value !== ''
          ? event.target.value
          : null
        writeLinkSelection(sessionId, next)
        setLinkId(next)
        emitLinkChange(sessionId, next)
        if (drawerOf(sessionId).open) patchDrawer(sessionId, { linkId: next, round: null })
        refreshRef.current()
      }

      if (!sessionId) return null

      const current = dataRef.current
      const role = current ? current.role : null
      const link = current ? current.link : null
      const links = current && Array.isArray(current.links)
        ? current.links.filter((item) => item && typeof item.id === 'string')
        : []
      const can = (current && current.can) || {}
      const busy = pending !== null || (!!link && link.status === 'creating')
      const errorMsg = actionError && actionError.message
        ? actionError.message
        : (link && link.lastError
          ? link.lastError
          : (loadError && loadError.message ? loadError.message : ''))
      const retryVisible = !!errorMsg
        || (!!link && (link.status === 'failed' || link.status === 'stale'))

      /** @returns {object} Right-aligned error or notice text node. */
      const messageElement = () => {
        if (errorMsg) {
          return React.createElement('span', {
            key: 'msg',
            className: 'hr-msg hr-error',
            role: 'alert',
            title: errorMsg,
          }, errorMsg)
        }
        if (notice) {
          return React.createElement('span', {
            key: 'msg',
            className: 'hr-msg hr-notice' + (notice.tone === 'info' ? ' hr-info' : ''),
            role: 'status',
            title: notice.text,
          }, notice.text)
        }
        return null
      }

      const panelButton = () => buttonElement({
        key: 'panel',
        label: t('dock.panel'),
        onClick: onOpenPanel,
        disabled: busy,
        title: t('dock.panel'),
      })

      // Mode 1 (loading): transient text-equivalent spinner until the first state
      // response or its timeout lands; `loaded` always flips in the effect.
      if (!current && !loaded) {
        return rowElement(t('dock.aria'), [
          React.createElement('span', { key: 'label', className: 'hr-label' },
            React.createElement('span', { className: 'hr-title' }, t('dock.title'))),
          React.createElement('span', { key: 'busy', className: 'hr-busy' },
            spinnerElement(12),
            t('dock.busy')),
        ])
      }

      // Mode 1b (no link): the create button plus the panel entry point on
      // implementation/unknown sessions; review sessions hide the row. Errors
      // switch to error+retry mode.
      if (!link) {
        if (role === 'review') return null
        if (errorMsg) {
          return rowElement(t('dock.aria'), [
            React.createElement('span', { key: 'label', className: 'hr-label' },
              React.createElement('span', { className: 'hr-title' }, t('dock.title'))),
            React.createElement('span', {
              key: 'msg',
              className: 'hr-msg hr-error',
              role: 'alert',
              title: errorMsg,
            }, errorMsg),
            React.createElement('span', { key: 'spacer', className: 'hr-spacer' }),
            buttonElement({
              key: 'retry',
              label: t('dock.retry'),
              onClick: onRetry,
              disabled: busy,
            }),
            panelButton(),
          ])
        }
        return rowElement(t('dock.aria'), [
          buttonElement({
            key: 'create',
            label: t('dock.create'),
            onClick: () => { runAction('create') },
            disabled: busy || can.create === false,
            primary: true,
          }),
          panelButton(),
        ])
      }

      // Mode 2/3 (linked): status line, multi-link selector, and role-aware,
      // `can`-gated actions. M1's force-revision rule is preserved.
      const status = link.status
      const closed = status === 'closed'
      const isReview = role === 'review'
      const round = Number.isFinite(link.round) ? link.round : 0
      const actions = []
      const hasReviewId = typeof link.reviewSessionId === 'string' && link.reviewSessionId !== ''
      const hasImplId = typeof link.implSessionId === 'string' && link.implSessionId !== ''

      actions.push(buttonElement({
        key: 'openReview',
        label: t('dock.openReview'),
        onClick: onOpenReview,
        disabled: busy || !hasReviewId,
        title: hasReviewId ? t('dock.openReview') : t('dock.noReviewId'),
      }))
      if (isReview) {
        actions.push(buttonElement({
          key: 'openImpl',
          label: t('dock.openImpl'),
          onClick: onOpenImpl,
          disabled: busy || !hasImplId,
          title: hasImplId ? t('dock.openImpl') : t('dock.sessionMissing'),
        }))
      }

      if (!closed) {
        const showFeedback = isReview
          ? (status === 'feedback_ready' || (status === 'reviewing' && can.feedback === true))
          : status === 'feedback_ready'
        const maxRounds = current && Number.isFinite(current.maxRounds) ? current.maxRounds : 3
        const forceRevision = can.revision === true && round >= maxRounds
        const showRevision = !isReview && can.revision === true

        if (showFeedback) {
          actions.push(buttonElement({
            key: 'feedback',
            label: t('dock.sendFeedback'),
            onClick: () => { runAction('feedback') },
            disabled: busy || can.feedback === false,
          }))
        }
        if (showRevision) {
          actions.push(buttonElement({
            key: 'revision',
            label: forceRevision ? t('dock.sendRevisionForce') : t('dock.sendRevision'),
            onClick: () => { runAction('revision', undefined, forceRevision) },
            disabled: busy || can.revision === false,
          }))
        }
        actions.push(buttonElement({
          key: 'close',
          label: t('dock.close'),
          onClick: () => { runAction('close') },
          disabled: busy || can.close === false,
        }))
        if (retryVisible) {
          actions.push(buttonElement({
            key: 'retry',
            label: t('dock.retry'),
            onClick: onRetry,
            disabled: busy,
          }))
        }
      } else if (retryVisible) {
        actions.push(buttonElement({
          key: 'retry',
          label: t('dock.retry'),
          onClick: onRetry,
          disabled: busy,
        }))
      }

      // A closed link keeps its history but must offer a way to start a new
      // review; this reuses the existing create action (new link + session).
      if (closed) {
        actions.push(buttonElement({
          key: 'newReview',
          label: t('dock.newReview'),
          onClick: () => { runAction('create', typeof link.focus === 'string' ? link.focus : undefined) },
          disabled: busy || can.create === false,
          title: t('dock.newReview'),
        }))
      }

      actions.push(panelButton())
      actions.push(buttonElement({
        key: 'diff',
        label: t('dock.diff'),
        onClick: onOpenDiff,
        disabled: busy,
      }))

      const selectValue = linkId || (link && typeof link.id === 'string' ? link.id : '')
      const children = [
        React.createElement('span', { key: 'label', className: 'hr-label' },
          React.createElement('span', { className: 'hr-title' }, t('dock.title')),
          React.createElement('span', { className: 'hr-sep' }, '·'),
          React.createElement('span', { className: 'hr-round' }, t('dock.round', { round })),
          React.createElement('span', { className: 'hr-sep' }, '·'),
          React.createElement('span', {
            className: 'hr-status' + statusToneClass(status),
          }, statusLabel(t, status))),
      ]
      if (links.length > 1) {
        children.push(React.createElement('select', {
          key: 'linkSelect',
          className: 'hr-select',
          value: selectValue,
          'aria-label': t('dock.linkSelect'),
          title: t('dock.linkSelect'),
          disabled: busy,
          onChange: onSelectLink,
        }, links.map((item) => React.createElement('option', {
          key: item.id,
          value: item.id,
        }, '#' + (Number.isFinite(item.round) ? item.round : 0) + ' · ' + statusLabel(t, item.status)))))
      }
      children.push(React.createElement('span', { key: 'actions', className: 'hr-actions' }, actions))
      children.push(React.createElement('span', { key: 'spacer', className: 'hr-spacer' }))
      if (busy) {
        children.push(React.createElement('span', { key: 'busy', className: 'hr-busy' },
          spinnerElement(12),
          t('dock.busy')))
      }
      children.push(messageElement())

      return rowElement(t('dock.aria'), children)
    }

    /**
     * Right-sidebar tab chip title.
     * @param {object} props Slot props plus the plugin runtime surface.
     * @returns {object} React element.
     */
    function PanelTitle(props) {
      const runtime = props.runtime || {}
      const t = typeof props.t === 'function'
        ? props.t
        : (typeof runtime.t === 'function' ? runtime.t : fallbackT)
      useLocaleTick(runtime.subscribeLocale)
      return React.createElement('span', null, t('panel.title'))
    }

    /**
     * Right-sidebar panel body (M2). Polls the panel payload, renders link/session
     * details, round history, handoff/report previews, changed files, and the
     * role/`can`-gated actions.
     * @param {object} props Slot props plus the plugin runtime surface.
     * @returns {object|null} React element or null.
     */
    function PanelBody(props) {
      const sessionId = props.sessionId || (props.session && props.session.id) || undefined
      const runtime = props.runtime || {}
      const t = typeof props.t === 'function'
        ? props.t
        : (typeof runtime.t === 'function' ? runtime.t : fallbackT)
      useLocaleTick(runtime.subscribeLocale)

      const [data, setData] = React.useState(null)
      const [loaded, setLoaded] = React.useState(false)
      const [loadError, setLoadError] = React.useState(null)
      const [pending, setPending] = React.useState(null)
      const [actionError, setActionError] = React.useState(null)
      const [notice, setNotice] = React.useState(null)
      const [expanded, setExpanded] = React.useState({})
      const [linkId, setLinkId] = React.useState(() => readLinkSelection(sessionId))

      const mountedRef = React.useRef(true)
      const pendingRef = React.useRef(false)
      const sessionRef = React.useRef(sessionId)
      const dataRef = React.useRef(null)
      const refreshRef = React.useRef(() => {})
      sessionRef.current = sessionId

      React.useEffect(() => {
        mountedRef.current = true
        return () => { mountedRef.current = false }
      }, [])

      React.useEffect(() => {
        setLinkId(readLinkSelection(sessionId))
      }, [sessionId])

      React.useEffect(() => subscribeLinkChanges((event) => {
        if (!mountedRef.current || event.sessionId !== sessionRef.current) return
        setLinkId(event.linkId || null)
        refreshRef.current()
      }), [])

      // Panel acquisition: mount/session/link changes plus a 3s poll. A failed
      // poll keeps the last good payload; a failed first load renders an error.
      React.useEffect(() => {
        if (!sessionId) {
          setData(null)
          setLoaded(true)
          return undefined
        }
        let cancelled = false
        let running = false
        let gotState = false
        let clearedSelection = false
        const sid = sessionId
        setData(null)
        setLoaded(false)
        setLoadError(null)
        setActionError(null)
        setNotice(null)
        setPending(null)
        pendingRef.current = false

        const run = async () => {
          if (cancelled || running || pendingRef.current) return
          running = true
          let failure = null
          try {
            const selection = readLinkSelection(sid)
            const body = await requestJson(panelUrl(sid, selection), {}, t)
            if (cancelled || sessionRef.current !== sid) return
            if (body && body.ok) {
              gotState = true
              const links = Array.isArray(body.links) ? body.links : []
              if (selection && !links.some((item) => item && item.id === selection)) {
                writeLinkSelection(sid, null)
                setLinkId(null)
                clearedSelection = true
              }
              setData(body)
              setLoadError(null)
            } else {
              const code = body && typeof body.code === 'string' ? body.code : undefined
              failure = { message: messageOf(body, t), code }
              // A stale persisted linkId makes the Host report NO_LINK; drop it
              // and retry once with the Host's default link.
              if (code === 'NO_LINK' && selection) {
                writeLinkSelection(sid, null)
                setLinkId(null)
                clearedSelection = true
              }
            }
          } catch (error) {
            failure = { message: (error && error.message) || t('dock.networkError'), code: error && error.code }
          } finally {
            running = false
            if (!cancelled && sessionRef.current === sid) {
              if (failure && !gotState) setLoadError(failure)
              setLoaded(true)
              if (clearedSelection) {
                clearedSelection = false
                refreshRef.current()
              }
            }
          }
        }

        refreshRef.current = run
        run()
        const interval = setInterval(() => { run() }, POLL_MS)
        return () => {
          cancelled = true
          clearInterval(interval)
          refreshRef.current = () => {}
        }
      }, [sessionId, t])

      React.useEffect(() => {
        if (!notice) return undefined
        const timer = setTimeout(() => {
          if (mountedRef.current) setNotice(null)
        }, NOTICE_MS)
        return () => clearTimeout(timer)
      }, [notice])

      dataRef.current = data && (data.sessionId === undefined || data.sessionId === sessionId)
        ? data
        : null

      // Keep an open diff drawer aligned with the panel's selected round.
      React.useEffect(() => {
        const current = dataRef.current
        const liveRound = current && current.link && Number.isFinite(current.link.round)
          ? current.link.round
          : null
        if (!sessionId || liveRound === null) return
        const state = drawerOf(sessionId)
        if (state.open && state.round !== liveRound) patchDrawer(sessionId, { round: liveRound })
      }, [sessionId, data])

      /**
       * POST one panel action for the selected link, then refresh the payload.
       * @param {'feedback'|'revision'|'close'} kind Action endpoint.
       * @param {boolean} [force] Force a revision past maxRounds.
       * @returns {Promise<void>}
       */
      const runAction = async (kind, force) => {
        if (pendingRef.current) return
        const sid = sessionRef.current
        const current = dataRef.current
        const link = current && current.link
        if (!sid || !link) return
        pendingRef.current = true
        setPending(kind)
        setActionError(null)

        let result = null
        let failure = null
        try {
          const payload = { sessionId: sid }
          if (typeof link.id === 'string' && link.id) payload.linkId = link.id
          if (kind === 'revision' && force === true) payload.force = true
          result = await requestJson('/handoff-review/api/' + kind, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(payload),
          }, t)
          if (!result || result.ok !== true) {
            failure = { message: messageOf(result || {}, t) }
          }
        } catch (error) {
          failure = { message: (error && error.message) || t('dock.networkError') }
        }

        pendingRef.current = false
        if (!mountedRef.current) return
        setPending(null)
        if (failure) {
          setActionError(failure)
        } else if (result) {
          if (result.link && typeof result.link === 'object') {
            setData((previous) => (previous ? { ...previous, link: result.link } : previous))
          }
          const text = kind === 'feedback'
            ? t('dock.feedbackSent')
            : (kind === 'revision' ? t('dock.revisionSent') : t('dock.closed'))
          setNotice({ key: Date.now() + ':' + kind, text, tone: 'success' })
          emitLinkChange(sid, typeof link.id === 'string' ? link.id : null)
        }
        refreshRef.current()
      }

      /**
       * Open the implementation/review session with the shared fallback.
       * @param {string} targetId Session id.
       * @param {string} [missingKey] Locale key used when the id is empty.
       * @returns {Promise<void>}
       */
      const onOpenSession = async (targetId, missingKey) => {
        await openSessionWithFallback(runtime, targetId, t, setNotice, setActionError, missingKey)
      }

      /**
       * Open the diff drawer for the panel's selected link.
       * @param {object} link Selected link.
       * @returns {void}
       */
      const onOpenDiff = (link) => {
        openDiffDrawer(sessionId, link.id || readLinkSelection(sessionId), link.round)
      }

      if (!sessionId) return null

      const current = dataRef.current
      const link = current ? current.link : null
      const tr = t
      const loading = !current && !loaded
      const fatalError = !current && loadError

      /**
       * @param {string} key React key.
       * @param {string} title Localized card title.
       * @param {Array<object|null>} items Card content.
       * @returns {object} Card element.
       */
      const card = (key, title, items) => React.createElement('section', { key, className: 'hrp-card' },
        React.createElement('div', { className: 'hrp-card-title' }, title),
        items.filter(Boolean))

      /**
       * @param {string} key React key.
       * @param {string} label Localized row label.
       * @param {object|string} value Row value node or text.
       * @param {object|null} [extra] Trailing node (e.g. an Open button).
       * @returns {object} Row element.
       */
      const row = (key, label, value, extra) => React.createElement('div', { key, className: 'hrp-row' },
        React.createElement('span', { className: 'hrp-label' }, label),
        React.createElement('span', { className: 'hrp-value' }, value),
        extra || null)

      /**
       * @param {string} status Link status.
       * @returns {object} Status chip element.
       */
      const chip = (status) => React.createElement('span', {
        className: 'hrp-chip' + (status === 'failed' || status === 'stale'
          ? ' hrp-error'
          : (status === 'open' || status === 'feedback_ready' ? ' hrp-success' : '')),
      }, statusLabel(tr, status))

      const head = React.createElement('div', { key: 'head', className: 'hrp-head' },
        React.createElement('span', { className: 'hrp-head-title' }, tr('panel.title')),
        link
          ? React.createElement('span', { className: 'hrp-head-meta' },
            chip(link.status),
            Number.isFinite(link.round) ? tr('dock.round', { round: link.round }) : null)
          : null)

      const statusLine = actionError && actionError.message
        ? React.createElement('div', { key: 'actionError', className: 'hrp-error', role: 'alert' }, actionError.message)
        : (notice
          ? React.createElement('div', { key: 'notice', className: 'hrp-notice', role: 'status' }, notice.text)
          : null)

      if (loading) {
        return React.createElement('div', { className: 'hrp-root' },
          head,
          React.createElement('div', { className: 'hrp-loading' }, spinnerElement(12), tr('panel.loading')))
      }

      if (fatalError) {
        if (loadError.code === 'NO_LINK') {
          return React.createElement('div', { className: 'hrp-root' },
            head,
            React.createElement('div', { key: 'empty', className: 'hrp-empty' }, tr('panel.empty')))
        }
        return React.createElement('div', { className: 'hrp-root' },
          head,
          card('error', tr('panel.title'), [
            React.createElement('div', { key: 'err', className: 'hrp-error', role: 'alert' },
              tr('panel.loadError', { message: loadError.message })),
            buttonElement({
              key: 'retry',
              label: tr('dock.retry'),
              onClick: () => { refreshRef.current() },
            }),
          ]))
      }

      if (!link) {
        return React.createElement('div', { className: 'hrp-root' },
          head,
          statusLine,
          React.createElement('div', { className: 'hrp-empty' }, tr('panel.empty')),
          React.createElement('div', { className: 'hrp-actions' }, buttonElement({
            key: 'refresh',
            label: tr('dock.retry'),
            onClick: () => { refreshRef.current() },
            primary: true,
          })))
      }

      const role = current ? current.role : null
      const caps = deriveCapabilities(link, role, current ? current.can : null)
      const busy = pending !== null
      const status = link.status
      const closed = status === 'closed'
      const rounds = Array.isArray(current.rounds) ? current.rounds : []
      const changedFiles = Array.isArray(current.changedFiles) ? current.changedFiles : []
      const reviewer = current.reviewer && typeof current.reviewer === 'object' ? current.reviewer : {}
      const roundHistory = rounds.length === 0
        ? React.createElement('div', { key: 'historyEmpty', className: 'hrp-empty' }, tr('panel.historyEmpty'))
        : React.createElement('div', { key: 'history', className: 'hrp-rounds' }, rounds.map((roundItem) => {
          const key = String(roundItem && Number.isFinite(roundItem.round) ? roundItem.round : '?')
          const isOpen = expanded[key] === true
          const report = typeof roundItem.report === 'string' && roundItem.report
            ? roundItem.report
            : (typeof roundItem.reportPreview === 'string' ? roundItem.reportPreview : '')
          const handoffPreview = typeof roundItem.handoffPreview === 'string' ? roundItem.handoffPreview : ''
          const time = formatTime(roundItem.updatedAt || roundItem.createdAt)
          return React.createElement('div', { key, className: 'hrp-round' },
            React.createElement('button', {
              type: 'button',
              className: 'hrp-round-head',
              'aria-expanded': isOpen,
              onClick: () => setExpanded((previous) => ({ ...previous, [key]: !isOpen })),
            },
            React.createElement('span', { className: 'hrp-round-title' },
              tr('panel.round') + ' ' + (Number.isFinite(roundItem.round) ? roundItem.round : '?')),
            React.createElement('span', { className: 'hrp-round-meta' },
              [roundStatusLabel(tr, roundItem.status), time].filter(Boolean).join(' · ')),
            React.createElement('span', { className: 'hrp-round-chevron' }, isOpen ? '▾' : '▸')),
            isOpen
              ? React.createElement('div', { className: 'hrp-round-body' },
                report
                  ? React.createElement('pre', { key: 'report', className: 'hrp-pre' }, report)
                  : React.createElement('div', { key: 'noReport', className: 'hrp-empty' }, tr('panel.noReport')),
                handoffPreview
                  ? React.createElement('pre', { key: 'handoff', className: 'hrp-pre' }, handoffPreview)
                  : null)
              : null)
        }))

      const fileList = changedFiles.length === 0
        ? React.createElement('div', { key: 'filesEmpty', className: 'hrp-empty' }, tr('panel.changedFilesEmpty'))
        : React.createElement('ul', { key: 'files', className: 'hrp-files' }, changedFiles.map((file, index) => {
          const path = file && typeof file.path === 'string' ? file.path : ''
          const added = file && Number.isFinite(file.added) ? file.added : 0
          const removed = file && Number.isFinite(file.removed) ? file.removed : 0
          return React.createElement('li', { key: path + ':' + index, className: 'hrp-file' },
            React.createElement('span', { className: 'hrp-file-path', title: path }, path),
            React.createElement('span', { className: 'hrp-diffstat' }, '+' + added + ' −' + removed))
        }))

      const actions = []
      actions.push(buttonElement({
        key: 'diff',
        label: tr('dock.diff'),
        onClick: () => { onOpenDiff(link) },
        disabled: busy,
      }))
      if (!closed) {
        const showFeedback = caps.feedback === true
        const maxRounds = Number.isFinite(current.maxRounds) ? current.maxRounds : 3
        const round = Number.isFinite(link.round) ? link.round : 0
        const forceRevision = caps.revision === true && round >= maxRounds
        const showRevision = caps.revision === true
        if (showFeedback) {
          actions.push(buttonElement({
            key: 'feedback',
            label: tr('dock.sendFeedback'),
            onClick: () => { runAction('feedback') },
            disabled: busy || !caps.feedback,
          }))
        }
        if (showRevision) {
          actions.push(buttonElement({
            key: 'revision',
            label: forceRevision ? tr('dock.sendRevisionForce') : tr('dock.sendRevision'),
            onClick: () => { runAction('revision', forceRevision) },
            disabled: busy || !caps.revision,
          }))
        }
        actions.push(buttonElement({
          key: 'close',
          label: tr('dock.close'),
          onClick: () => { runAction('close') },
          disabled: busy || !caps.close,
        }))
      }

      const reviewerValue = reviewerRoute(tr, reviewer)
      const reviewerItems = [
        row('route', tr('panel.reviewer'), React.createElement('span', { className: 'hrp-mono' }, reviewerValue)),
      ]
      if (typeof reviewer.preset === 'string' && reviewer.preset.trim()) {
        reviewerItems.push(row('preset', tr('panel.preset'),
          React.createElement('span', { className: 'hrp-mono' }, reviewer.preset.trim())))
      }

      const linkItems = [
        row('id', tr('panel.link'), React.createElement('span', { className: 'hrp-mono' },
          typeof link.id === 'string' ? link.id : '—')),
        row('status', tr('panel.status'), chip(status)),
        row('round', tr('panel.round'), Number.isFinite(link.round) ? String(link.round) : '—'),
      ]
      if (Number.isFinite(current.maxRounds)) {
        linkItems.push(row('maxRounds', tr('panel.maxRounds'), String(current.maxRounds)))
      }
      const updated = formatTime(link.updatedAt)
      if (updated) linkItems.push(row('updatedAt', tr('panel.updatedAt'), updated))
      if (typeof link.focus === 'string' && link.focus.trim()) {
        linkItems.push(row('focus', tr('panel.focus'), link.focus.trim()))
      }

      const implId = typeof link.implSessionId === 'string' ? link.implSessionId : ''
      const reviewId = typeof link.reviewSessionId === 'string' ? link.reviewSessionId : ''
      const sessionItems = [
        React.createElement('div', { key: 'impl', className: 'hrp-row' },
          React.createElement('span', { className: 'hrp-label' }, tr('panel.implSession')),
          React.createElement('span', { className: 'hrp-value hrp-mono' }, implId || '—'),
          implId
            ? buttonElement({
              key: 'openImpl',
              label: tr('panel.openImpl'),
              onClick: () => { onOpenSession(implId, 'dock.sessionMissing') },
            })
            : null),
        React.createElement('div', { key: 'review', className: 'hrp-row' },
          React.createElement('span', { className: 'hrp-label' }, tr('panel.reviewSession')),
          React.createElement('span', { className: 'hrp-value hrp-mono' }, reviewId || '—'),
          reviewId
            ? buttonElement({
              key: 'openReview',
              label: tr('panel.openReview'),
              onClick: () => { onOpenSession(reviewId, 'dock.noReviewId') },
            })
            : null),
      ]

      const handoffText = typeof current.handoff === 'string' ? current.handoff : ''
      const reportText = typeof current.report === 'string' ? current.report : ''

      const sections = [
        head,
        statusLine,
        card('link', tr('panel.link'), linkItems),
        card('sessions', tr('panel.implSession') + ' / ' + tr('panel.reviewSession'), sessionItems),
        card('reviewer', tr('panel.reviewer'), reviewerItems),
        card('actions', tr('panel.actions'), [React.createElement('div', { key: 'actions', className: 'hrp-actions' }, actions)]),
        card('history', tr('panel.history'), [roundHistory]),
        card('handoff', tr('panel.handoff'), [
          handoffText
            ? React.createElement('pre', { key: 'handoff', className: 'hrp-pre' }, handoffText)
            : React.createElement('div', { key: 'handoffEmpty', className: 'hrp-empty' }, tr('panel.handoffEmpty')),
        ]),
        card('report', tr('panel.report'), [
          reportText
            ? React.createElement('pre', { key: 'report', className: 'hrp-pre' }, reportText)
            : React.createElement('div', { key: 'noReport', className: 'hrp-empty' }, tr('panel.noReport')),
        ]),
        card('files', tr('panel.changedFiles'), [fileList]),
      ]

      return React.createElement('div', { className: 'hrp-root' }, sections.filter(Boolean))
    }

    /**
     * Settings page (M2): reviewer routing plus handoff limits/behavior, backed by
     * the Host `/handoff-review/api/config` route. Never crashes without catalogs.
     * @param {object} props Slot props (owner `close` plus the plugin runtime).
     * @returns {object|null} React element or null.
     */
    function SettingsPage(props) {
      const runtime = props.runtime || {}
      const t = typeof props.t === 'function'
        ? props.t
        : (typeof runtime.t === 'function' ? runtime.t : fallbackT)
      useLocaleTick(runtime.subscribeLocale)

      const [draft, setDraft] = React.useState(null)
      const loadedConfigRef = React.useRef(null)
      const [catalog, setCatalog] = React.useState({ defaults: null, providers: [], models: [], presets: [] })
      const [loaded, setLoaded] = React.useState(false)
      const [loadError, setLoadError] = React.useState(null)
      const [saving, setSaving] = React.useState(null)
      const [status, setStatus] = React.useState(null)

      const mountedRef = React.useRef(true)
      const savingRef = React.useRef(false)
      const close = typeof props.close === 'function' ? props.close : null

      React.useEffect(() => {
        mountedRef.current = true
        return () => { mountedRef.current = false }
      }, [])

      /** Map a Host config object into editable string/boolean form values. */
      const toDraft = (config) => {
        const source = config && typeof config === 'object' ? config : {}
        const next = {}
        for (const key of CONFIG_STRING_FIELDS) {
          next[key] = typeof source[key] === 'string' ? source[key] : String(CONFIG_DEFAULTS[key] || '')
        }
        for (const field of CONFIG_NUMERIC_FIELDS) {
          const numeric = Number(source[field.key])
          next[field.key] = String(Number.isFinite(numeric) ? numeric : CONFIG_DEFAULTS[field.key])
        }
        for (const key of CONFIG_BOOLEAN_FIELDS) {
          next[key] = typeof source[key] === 'boolean' ? source[key] : CONFIG_DEFAULTS[key]
        }
        return next
      }

      /** Clamp one numeric draft field into the Host-validated range. */
      const clampNumber = (value, field) => {
        const numeric = Number(String(value === undefined || value === null ? '' : value).trim())
        if (!Number.isFinite(numeric)) return CONFIG_DEFAULTS[field.key]
        return Math.min(field.max, Math.max(field.min, Math.trunc(numeric)))
      }

      /** Build the full Host config payload from the current draft. */
      const draftToConfig = (current) => {
        const payload = {}
        for (const key of CONFIG_STRING_FIELDS) {
          payload[key] = typeof current[key] === 'string' ? current[key].trim() : ''
        }
        const loaded = loadedConfigRef.current
        for (const field of CONFIG_NUMERIC_FIELDS) {
          const numeric = Number(String(current[field.key] === undefined ? '' : current[field.key]).trim())
          const loadedNumeric = loaded ? Number(loaded[field.key]) : Number.NaN
          // Never re-clamp a value the user did not edit: the composition config
          // may legally hold M1 values outside the Settings ranges, and echoing
          // them unchanged lets the Host preserve them.
          payload[field.key] = Number.isFinite(numeric) && Number.isFinite(loadedNumeric) && numeric === loadedNumeric
            ? loadedNumeric
            : clampNumber(current[field.key], field)
        }
        for (const key of CONFIG_BOOLEAN_FIELDS) {
          payload[key] = current[key] === true
        }
        return payload
      }

      /** Normalize the Host-provided defaults into a full config payload. */
      const normalizedDefaults = (defaults) => {
        const source = defaults && typeof defaults === 'object' ? defaults : null
        return draftToConfig(toDraft(source || CONFIG_DEFAULTS))
      }

      /** Reload the config + catalogs from the Host. */
      const loadConfig = async () => {
        setLoadError(null)
        try {
          const body = await requestJson('/handoff-review/api/config', {}, t)
          if (!mountedRef.current) return
          if (body && body.ok) {
            setCatalog({
              defaults: body.defaults || null,
              providers: Array.isArray(body.providers) ? body.providers.filter(Boolean) : [],
              models: Array.isArray(body.models) ? body.models.filter(Boolean) : [],
              presets: Array.isArray(body.presets) ? body.presets.filter(Boolean) : [],
            })
            loadedConfigRef.current = body.config && typeof body.config === 'object' ? { ...body.config } : null
            setDraft(toDraft(body.config))
            setLoadError(null)
          } else {
            setLoadError({ message: messageOf(body || {}, t) })
            setDraft((previous) => previous || toDraft(CONFIG_DEFAULTS))
          }
        } catch (error) {
          if (!mountedRef.current) return
          setLoadError({ message: (error && error.message) || t('dock.networkError') })
          setDraft((previous) => previous || toDraft(CONFIG_DEFAULTS))
        } finally {
          if (mountedRef.current) setLoaded(true)
        }
      }

      React.useEffect(() => {
        loadConfig()
      }, [t])

      React.useEffect(() => {
        if (!status || status.kind !== 'success') return undefined
        const timer = setTimeout(() => {
          if (mountedRef.current) setStatus(null)
        }, SHORT_NOTICE_MS)
        return () => clearTimeout(timer)
      }, [status])

      /** Patch one draft field. */
      const update = (key, value) => {
        setDraft((previous) => (previous ? { ...previous, [key]: value } : previous))
      }

      /**
       * Save the full config, or reset to the Host defaults.
       * @param {'save'|'reset'} mode Submit mode.
       * @returns {Promise<void>}
       */
      const submit = async (mode) => {
        if (savingRef.current || !draft) return
        savingRef.current = true
        setSaving(mode)
        setStatus(null)
        try {
          const payload = mode === 'reset' ? normalizedDefaults(catalog.defaults) : draftToConfig(draft)
          const body = await requestJson('/handoff-review/api/config', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ config: payload }),
          }, t)
          if (!mountedRef.current) return
          if (body && body.ok) {
            const next = body.config && typeof body.config === 'object' ? body.config : payload
            loadedConfigRef.current = { ...next }
            setDraft(toDraft(next))
            setStatus({
              kind: 'success',
              text: mode === 'reset' ? t('settings.resetDone') : t('settings.saved'),
            })
          } else {
            setStatus({ kind: 'error', text: t('settings.saveError', { message: messageOf(body || {}, t) }) })
          }
        } catch (error) {
          if (mountedRef.current) {
            setStatus({
              kind: 'error',
              text: t('settings.saveError', { message: (error && error.message) || t('dock.networkError') }),
            })
          }
        } finally {
          savingRef.current = false
          if (mountedRef.current) setSaving(null)
        }
      }

      if (!loaded && !draft) {
        return React.createElement('div', { className: 'hrs-root' },
          React.createElement('div', { className: 'hrp-loading' }, spinnerElement(12), t('settings.loading')))
      }

      const tr = t
      const busy = saving !== null
      const current = draft || toDraft(CONFIG_DEFAULTS)

      const option = (value, label) => React.createElement('option', {
        key: value === '' ? '__default' : value + '\u0000' + label,
        value,
      }, label)
      /** Remove duplicate option values (model ids may repeat across providers). */
      const dedupeOptions = (options) => {
        const seen = new Set()
        const unique = []
        for (const entry of options) {
          if (seen.has(entry.value)) continue
          seen.add(entry.value)
          unique.push(entry)
        }
        return unique
      }

      const providerOptions = [{ value: '', label: tr('settings.providerDefault') }]
      for (const provider of catalog.providers) {
        const id = provider && typeof provider.id === 'string' ? provider.id : ''
        if (!id) continue
        providerOptions.push({ value: id, label: typeof provider.name === 'string' && provider.name ? provider.name : id })
      }
      if (current.reviewerProvider && !providerOptions.some((entry) => entry.value === current.reviewerProvider)) {
        providerOptions.push({ value: current.reviewerProvider, label: current.reviewerProvider })
      }

      const modelOptions = [{ value: '', label: tr('settings.modelDefault') }]
      for (const model of catalog.models) {
        const id = model && typeof model.model === 'string' ? model.model : ''
        if (!id) continue
        if (current.reviewerProvider && model.provider !== current.reviewerProvider) continue
        const suffix = current.reviewerProvider || !model.provider ? '' : ' · ' + model.provider
        modelOptions.push({ value: id, label: (typeof model.name === 'string' && model.name ? model.name : id) + suffix })
      }
      if (current.reviewerModel && !modelOptions.some((entry) => entry.value === current.reviewerModel)) {
        modelOptions.push({ value: current.reviewerModel, label: current.reviewerModel })
      }

      // Reasoning-effort options follow the selected model; a model that reports
      // none (or an unknown custom route) only offers the model default.
      const selectedModel = catalog.models.find((model) => model
        && typeof model.model === 'string'
        && model.model === current.reviewerModel
        && (!current.reviewerProvider || model.provider === current.reviewerProvider))
      const reasoningOptions = [{ value: '', label: tr('settings.reasoningDefault') }]
      const reportedEfforts = selectedModel && Array.isArray(selectedModel.reasoningEfforts)
        ? selectedModel.reasoningEfforts
        : []
      for (const effort of reportedEfforts) {
        const id = effort && typeof effort.id === 'string' ? effort.id : ''
        if (!id) continue
        reasoningOptions.push({ value: id, label: typeof effort.name === 'string' && effort.name ? effort.name : id })
      }
      if (current.reviewerReasoningEffort && !reasoningOptions.some((entry) => entry.value === current.reviewerReasoningEffort)) {
        reasoningOptions.push({ value: current.reviewerReasoningEffort, label: current.reviewerReasoningEffort })
      }

      const presetOptions = [{ value: '', label: tr('settings.presetDefault') }]
      for (const preset of catalog.presets) {
        const id = preset && typeof preset.id === 'string' ? preset.id : ''
        if (!id) continue
        presetOptions.push({ value: id, label: typeof preset.name === 'string' && preset.name ? preset.name : id })
      }
      if (current.reviewerPreset && !presetOptions.some((entry) => entry.value === current.reviewerPreset)) {
        presetOptions.push({ value: current.reviewerPreset, label: current.reviewerPreset })
      }

      /**
       * @param {string} key Field key.
       * @param {string} label Localized label.
       * @param {object} control Input/select element.
       * @returns {object} Field element.
       */
      const field = (key, label, control) => React.createElement('label', { key, className: 'hrs-field' },
        React.createElement('span', { className: 'hrs-label' }, label),
        control)

      const select = (key, value, options, onChange) => React.createElement('select', {
        className: 'hrs-select',
        value,
        disabled: busy,
        onChange: (event) => onChange(event.target.value),
      }, options.map((entry) => option(entry.value, entry.label)))

      const numberInput = (fieldSpec) => React.createElement('input', {
        type: 'number',
        className: 'hrs-input',
        min: String(fieldSpec.min),
        max: String(fieldSpec.max),
        step: '1',
        value: current[fieldSpec.key],
        disabled: busy,
        onChange: (event) => update(fieldSpec.key, event.target.value),
      })

      const checkbox = (key, label) => React.createElement('label', { key, className: 'hrs-check' },
        React.createElement('input', {
          type: 'checkbox',
          checked: current[key] === true,
          disabled: busy,
          onChange: (event) => update(key, event.target.checked),
        }),
        label)

      // Models that report reasoning efforts get a select; custom/unknown routes
      // can still name an effort id in a text field (unsupported values fall back
      // to the model default with a warning on the Host).
      const reasoningControl = reportedEfforts.length > 0
        ? select('reviewerReasoningEffort', current.reviewerReasoningEffort, dedupeOptions(reasoningOptions), (value) => update('reviewerReasoningEffort', value))
        : React.createElement('input', {
          type: 'text',
          className: 'hrs-input',
          maxLength: 50,
          placeholder: tr('settings.reasoningPlaceholder'),
          value: current.reviewerReasoningEffort || '',
          disabled: busy,
          onChange: (event) => update('reviewerReasoningEffort', event.target.value),
        })

      const catalogEmpty = catalog.providers.length === 0 && catalog.models.length === 0 && catalog.presets.length === 0

      const reviewerCard = React.createElement('section', { key: 'reviewer', className: 'hrs-card' },
        React.createElement('div', { className: 'hrs-card-title' }, tr('settings.reviewer')),
        React.createElement('div', { className: 'hrs-grid' },
          field('reviewerProvider', tr('settings.provider'),
            select('reviewerProvider', current.reviewerProvider, dedupeOptions(providerOptions), (value) => {
              update('reviewerProvider', value)
              update('reviewerModel', '')
              update('reviewerReasoningEffort', '')
            })),
          field('reviewerModel', tr('settings.model'),
            select('reviewerModel', current.reviewerModel, dedupeOptions(modelOptions), (value) => {
              update('reviewerModel', value)
              update('reviewerReasoningEffort', '')
            })),
          field('reviewerReasoning', tr('settings.reasoning'), reasoningControl),
          field('reviewerPreset', tr('settings.preset'),
            select('reviewerPreset', current.reviewerPreset, dedupeOptions(presetOptions), (value) => update('reviewerPreset', value)))),
        catalogEmpty
          ? React.createElement('div', { className: 'hrs-hint' }, tr('settings.catalogsEmpty'))
          : null)

      const limitsCard = React.createElement('section', { key: 'limits', className: 'hrs-card' },
        React.createElement('div', { className: 'hrs-card-title' }, tr('settings.limits')),
        React.createElement('div', { className: 'hrs-grid' },
          CONFIG_NUMERIC_FIELDS.map((fieldSpec) => field(
            fieldSpec.key,
            tr('settings.' + fieldSpec.key),
            numberInput(fieldSpec)))))

      const behaviorCard = React.createElement('section', { key: 'behavior', className: 'hrs-card' },
        React.createElement('div', { className: 'hrs-card-title' }, tr('settings.behavior')),
        CONFIG_BOOLEAN_FIELDS.map((key) => checkbox(key, tr('settings.' + key))))

      const actions = React.createElement('div', { key: 'actions', className: 'hrs-actions' },
        buttonElement({
          key: 'save',
          label: saving === 'save' ? tr('settings.saving') : tr('settings.save'),
          onClick: () => { submit('save') },
          disabled: busy,
          primary: true,
        }),
        buttonElement({
          key: 'reset',
          label: saving === 'reset' ? tr('settings.resetting') : tr('settings.reset'),
          onClick: () => { submit('reset') },
          disabled: busy,
        }),
        status
          ? React.createElement('span', {
            key: 'status',
            className: 'hrs-status ' + (status.kind === 'error' ? 'hrs-error' : 'hrs-success'),
            role: status.kind === 'error' ? 'alert' : 'status',
          }, status.text)
          : null,
        React.createElement('span', { key: 'spacer', className: 'hrs-spacer' }),
        close
          ? buttonElement({ key: 'close', label: tr('settings.close'), onClick: close })
          : null)

      return React.createElement('div', { className: 'hrs-root' },
        React.createElement('div', { className: 'hrs-head' },
          React.createElement('div', { className: 'hrs-title' }, tr('settings.title')),
          React.createElement('div', { className: 'hrs-desc' }, tr('settings.description'))),
        loadError
          ? React.createElement('div', { key: 'loadError', className: 'hrs-card' },
            React.createElement('div', { className: 'hrp-error', role: 'alert' },
              tr('settings.loadError', { message: loadError.message })),
            React.createElement('div', { className: 'hrp-actions' },
              buttonElement({
                key: 'retry',
                label: tr('settings.retry'),
                onClick: () => { loadConfig() },
              })))
          : null,
        reviewerCard,
        limitsCard,
        behaviorCard,
        actions)
    }

    /**
     * Diff drawer (M2): a scrollable overlay above the composer showing per-file
     * unified diffs for the selected link/round. Escape or Close dismisses it.
     * @param {object} props Slot props plus the plugin runtime surface.
     * @returns {object|null} React element or null.
     */
    function DiffDrawer(props) {
      const sessionId = props.sessionId || (props.session && props.session.id) || undefined
      const runtime = props.runtime || {}
      const t = typeof props.t === 'function'
        ? props.t
        : (typeof runtime.t === 'function' ? runtime.t : fallbackT)
      useLocaleTick(runtime.subscribeLocale)

      const [drawer, setDrawer] = React.useState(() => drawerOf(sessionId))
      const [data, setData] = React.useState(null)
      const [loading, setLoading] = React.useState(false)
      const [loadError, setLoadError] = React.useState(null)
      const mountedRef = React.useRef(true)

      React.useEffect(() => {
        mountedRef.current = true
        return () => {
          mountedRef.current = false
          if (sessionId) closeDiffDrawer(sessionId)
        }
      }, [sessionId])

      React.useEffect(() => {
        setDrawer(drawerOf(sessionId))
        return subscribeDrawer(() => {
          if (mountedRef.current) setDrawer(drawerOf(sessionId))
        })
      }, [sessionId])

      const open = drawer.open === true
      const drawerLinkId = drawer.linkId
      const drawerRound = drawer.round

      React.useEffect(() => {
        if (!open || !sessionId) {
          setData(null)
          setLoading(false)
          setLoadError(null)
          return undefined
        }
        let cancelled = false
        setLoading(true)
        setLoadError(null)
        setData(null)
        const run = async () => {
          try {
            const body = await requestJson(diffUrl(sessionId, drawerLinkId), {}, t)
            if (cancelled) return
            if (body && body.ok) {
              setData(body)
              setLoadError(null)
            } else {
              setLoadError({ message: messageOf(body || {}, t) })
            }
          } catch (error) {
            if (!cancelled) setLoadError({ message: (error && error.message) || t('dock.networkError') })
          } finally {
            if (!cancelled) setLoading(false)
          }
        }
        run()
        return () => { cancelled = true }
      }, [open, sessionId, drawerLinkId, drawerRound, t])

      React.useEffect(() => {
        if (!open || !sessionId) return undefined
        const onKey = (event) => {
          if (event.key !== 'Escape' || event.defaultPrevented) return
          event.preventDefault()
          closeDiffDrawer(sessionId)
        }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
      }, [open, sessionId])

      if (!open || !sessionId) return null

      const tr = t
      const files = data && Array.isArray(data.files) ? data.files.filter(Boolean) : []
      const round = data && Number.isFinite(data.round) ? data.round : drawerRound
      const metaParts = []
      if (Number.isFinite(round)) metaParts.push(tr('dock.round', { round }))
      if (files.length > 0) metaParts.push(tr('drawer.fileCount', { count: files.length }))

      const head = React.createElement('div', { key: 'head', className: 'hrd-head' },
        React.createElement('span', { className: 'hrd-title' }, tr('drawer.title')),
        React.createElement('span', { className: 'hrd-meta' }, metaParts.join(' · ')),
        buttonElement({ key: 'close', label: tr('drawer.close'), onClick: () => { closeDiffDrawer(sessionId) } }))

      let bodyElement = null
      if (loading) {
        bodyElement = React.createElement('div', { key: 'loading', className: 'hrd-empty' },
          spinnerElement(12), ' ', tr('drawer.loading'))
      } else if (loadError) {
        bodyElement = React.createElement('div', { key: 'error', className: 'hrd-error', role: 'alert' },
          tr('drawer.error', { message: loadError.message }))
      } else if (files.length === 0) {
        bodyElement = React.createElement('div', { key: 'empty', className: 'hrd-empty' }, tr('drawer.empty'))
      } else {
        bodyElement = React.createElement('div', { key: 'files' }, files.map((file, index) => {
          const path = file && typeof file.path === 'string' ? file.path : ''
          const added = file && Number.isFinite(file.added) ? file.added : 0
          const removed = file && Number.isFinite(file.removed) ? file.removed : 0
          const diffText = stripDiffFence(file && file.diff)
          const lines = diffText === '' ? [] : diffText.split('\n')
          const shown = lines.slice(0, DRAWER_LINE_LIMIT)
          const truncated = lines.length > DRAWER_LINE_LIMIT
          return React.createElement('div', { key: path + ':' + index, className: 'hrd-file' },
            React.createElement('div', { className: 'hrd-file-head' },
              React.createElement('span', { className: 'hrd-file-path', title: path }, path),
              React.createElement('span', { className: 'hrd-file-stat' }, '+' + added + ' −' + removed)),
            React.createElement('pre', { className: 'hrd-diff' }, shown.map((line, lineIndex) =>
              React.createElement('span', {
                key: lineIndex,
                className: 'hrd-line' + diffLineClass(line),
              }, line === '' ? ' ' : line))),
            truncated
              ? React.createElement('div', { className: 'hrd-truncated' }, tr('drawer.truncated'))
              : null)
        }))
      }

      return React.createElement('div', {
        className: 'hrd-panel',
        role: 'dialog',
        'aria-label': tr('drawer.title'),
      },
      head,
      React.createElement('div', { className: 'hrd-body' }, bodyElement),
      React.createElement('div', { className: 'hrd-foot' },
        buttonElement({ key: 'closeFoot', label: tr('drawer.close'), onClick: () => { closeDiffDrawer(sessionId) } })))
    }

    const inject = ['slots', 'locale', 'sidebarRightTabs', 'sidebarRight', 'uiWorkspace']

    /**
     * Client plugin body: inject the shared style sheet, register the en/zh
     * dictionaries and live translator, then register the dock row, the
     * right-sidebar panel tab, the settings page and the diff drawer. Every
     * registration goes through `ctx.effect` so unload/HMR removes it.
     * @param {object} ctx Client plugin context (slots/locale/sidebar/ui injected).
     * @returns {void}
     */
    function apply(ctx) {
      if (typeof document !== 'undefined') {
        ctx.effect(() => {
          const style = document.createElement('style')
          style.setAttribute('data-plugin', SLOT_ID)
          style.textContent = CSS
          document.head.appendChild(style)
          return () => {
            if (style.parentNode) style.parentNode.removeChild(style)
          }
        }, 'handoff-review: styles')
      }

      const locale = resolveLocale(ctx)
      let t = fallbackT
      if (locale && typeof locale.register === 'function') {
        ctx.effect(() => {
          const disposers = []
          const register = (language, dictionary) => {
            try {
              disposers.push(locale.register(LOCALE_NS, language, dictionary))
            } catch (error) {
              // A duplicate registration (HMR without full teardown) must not break the
              // surfaces: previously registered dictionaries and the embedded fallback remain.
              console.error('handoff-review: locale registration failed', error)
            }
          }
          register('en', EN)
          register('zh', ZH)
          return () => {
            for (const dispose of disposers) {
              try { dispose() } catch (error) { /* already disposed */ }
            }
          }
        }, 'handoff-review: locale dictionaries')
        if (typeof locale.bind === 'function') {
          try {
            t = locale.bind(LOCALE_NS)
          } catch (error) {
            t = fallbackT
          }
        }
      }

      /**
       * Subscribe a surface render to locale/dictionary changes; no-op without the service.
       * @param {Function} listener Re-render callback.
       * @returns {Function} unsubscribe
       */
      const subscribeLocale = (listener) => {
        if (!locale || typeof locale.subscribe !== 'function') return () => {}
        try {
          return locale.subscribe(listener)
        } catch (error) {
          return () => {}
        }
      }

      const sidebarRightTabs = serviceOf(ctx, 'sidebarRightTabs')
      const sidebarRight = serviceOf(ctx, 'sidebarRight')
      const uiWorkspace = serviceOf(ctx, 'uiWorkspace')

      /** Surface handed to every registered component. */
      const runtime = {
        t,
        subscribeLocale,
        openSession: async (targetId) => {
          if (!uiWorkspace || typeof uiWorkspace.openSession !== 'function') {
            return { ok: false, reason: 'unavailable' }
          }
          try {
            await uiWorkspace.openSession(targetId)
            return { ok: true }
          } catch (error) {
            return { ok: false, message: error && error.message ? error.message : String(error) }
          }
        },
        openPanel: () => {
          if (!sidebarRight || typeof sidebarRight.openTab !== 'function') {
            return { ok: false, reason: 'unavailable' }
          }
          try {
            sidebarRight.openTab(TAB_KIND)
            return { ok: true }
          } catch (error) {
            return { ok: false, message: error && error.message ? error.message : String(error) }
          }
        },
      }

      // ---- right-sidebar tab type (two stages, both effect-owned) ----
      if (sidebarRightTabs && typeof sidebarRightTabs.register === 'function') {
        ctx.effect(() => {
          try {
            return sidebarRightTabs.register({
              id: TAB_ID,
              kind: TAB_KIND,
              title: () => t('panel.title'),
              guide: [{
                id: 'handoff-review',
                order: 50,
                title: () => t('panel.guideTitle'),
                description: () => t('panel.guideDesc'),
              }],
            })
          } catch (error) {
            console.error('handoff-review: tab type registration failed', error)
            return () => {}
          }
        }, 'handoff-review: tab type')
      }

      if (!ctx || !ctx.slots || typeof ctx.slots.inject !== 'function'
        || typeof ctx.slots.register !== 'function') {
        return
      }

      ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
        name: 'sidebar.right.pane.tab',
        key: TAB_ID,
        locale: LOCALE_NS,
      }, (slotProps) => React.createElement(PanelBody, { ...slotProps, runtime }))),
      'handoff-review: panel body')

      ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab.title', () => ctx.slots.register({
        name: 'sidebar.right.pane.tab.title',
        key: TAB_ID,
      }, (slotProps) => React.createElement(PanelTitle, { ...slotProps, runtime }))),
      'handoff-review: panel title')

      ctx.effect(() => ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: SETTINGS_ID,
        order: SETTINGS_ORDER,
        label: () => t('settings.label'),
      }, (slotProps) => React.createElement(SettingsPage, { ...slotProps, runtime }))),
      'handoff-review: settings section')

      ctx.effect(() => ctx.slots.inject('conversation.input.overlay', () => ctx.slots.register({
        name: 'conversation.input.overlay',
        id: DIFF_DRAWER_ID,
        order: DIFF_DRAWER_ORDER,
        label: () => t('drawer.title'),
      }, (slotProps) => React.createElement(DiffDrawer, { ...slotProps, runtime }))),
      'handoff-review: diff drawer')

      ctx.effect(() => ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
        name: 'conversation.input.dock',
        id: SLOT_ID,
        order: SLOT_ORDER,
        label: () => t('dock.title'),
      }, (slotProps) => React.createElement(HandoffReviewRow, {
        sessionId: slotProps.sessionId,
        session: slotProps.session,
        runtime,
      }))), 'handoff-review: input dock')
    }

    exports.apply = apply
    exports.inject = inject
    // Pure helpers exported for tests/verification; they do not affect the plugin contract.
    exports.dictionaries = Object.freeze({ en: EN, zh: ZH })
    exports.statusLabel = statusLabel
    exports.deriveCapabilities = deriveCapabilities
    exports.reviewerRoute = reviewerRoute
    exports.stripDiffFence = stripDiffFence
    exports.configDefaults = CONFIG_DEFAULTS
    exports.tabId = TAB_ID
    exports.tabKind = TAB_KIND
    exports.HandoffReviewRow = HandoffReviewRow
    exports.PanelBody = PanelBody
    exports.PanelTitle = PanelTitle
    exports.SettingsPage = SettingsPage
    exports.DiffDrawer = DiffDrawer
    return module.exports
  },
})
