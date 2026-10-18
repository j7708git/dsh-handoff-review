// handoff-review — slash-command surface.
//
// The command handler never talks to the model: it dispatches one of the
// documented sub-commands to the Host service and renders the outcome as the
// command receipt text (DEVELOPMENT.md §5.2, §9.2).

/** Registered command name (without the leading slash). */
export const COMMAND_NAME = 'handoff-review'

/** Discovery description, verbatim from DEVELOPMENT.md §9.2. */
export const COMMAND_DESCRIPTION = 'Hand off the current session changes to a linked review session'

/** Input hint, verbatim from DEVELOPMENT.md §9.2 (M2 adds `--new` / `--` escape). */
export const COMMAND_INPUT_HINT = '[focus] | status | feedback | revision [--force] | close | reopen  (create supports --new; prefix -- to use a literal focus)'

/** Sub-command names accepted after `/handoff-review`. */
export const COMMAND_ACTIONS = ['status', 'feedback', 'revision', 'close', 'reopen']

/**
 * Parse the raw text following `/handoff-review`.
 *
 * Grammar: an omitted input means `create` with no focus; a leading `--`
 * (followed by whitespace) escapes the rest as a literal focus, so a focus that
 * begins with a reserved sub-command name (`-- status bar refactor`) still
 * creates a review; otherwise an exact leading sub-command token selects that
 * action, `revision` additionally accepts `--force`, `create` accepts `--new`
 * (a second link for the same impl session, DEVELOPMENT.md D8/§7.1 M2), and
 * everything else is free-text focus.
 *
 * @param {string} rawInput text following the command name (leading whitespace included)
 * @returns {{ action: 'create' | 'status' | 'feedback' | 'revision' | 'close' | 'reopen', focus: string | null, force: boolean, newLink: boolean }}
 */
export function parseCommandInput(rawInput) {
  const text = String(rawInput ?? '').trim()
  const takeFlag = (value, flag) => {
    const tokens = value.split(/\s+/).filter((token) => token !== '')
    const found = tokens.includes(flag)
    return { found, rest: tokens.filter((token) => token !== flag).join(' ').trim() }
  }
  if (text === '') return { action: 'create', focus: null, force: false, newLink: false }
  // `-- <focus>` escapes a focus that would otherwise look like a sub-command.
  if (text === '--' || text.startsWith('-- ')) {
    const escaped = text.slice(2).trim()
    return { action: 'create', focus: escaped === '' ? null : escaped, force: false, newLink: false }
  }
  const [token, ...rest] = text.split(/\s+/)
  const action = token.toLowerCase()
  if (COMMAND_ACTIONS.includes(action)) {
    const force = action === 'revision' && rest.includes('--force')
    return { action, focus: null, force, newLink: false }
  }
  const restText = action === 'create' ? rest.join(' ').trim() : text
  const withoutNew = takeFlag(restText, '--new')
  const focus = withoutNew.rest === '' ? null : withoutNew.rest
  return { action: 'create', focus, force: false, newLink: withoutNew.found }
}

/**
 * Tokens after the sub-command that the action does not accept. `create` owns
 * its free-text focus; `revision` accepts `--force`; every other sub-command
 * takes no arguments, so a silent typo (`close now`) is reported instead of
 * ignored. Commands address the link selected in the dock; use the dock
 * selector (or close/reopen that link) when several links exist.
 * @param {string} action parsed action
 * @param {string} rawInput raw text after the command name
 * @returns {string[]} unexpected tokens
 */
function unexpectedArguments(action, rawInput) {
  if (action === 'create') return []
  const tokens = String(rawInput ?? '').trim().split(/\s+/).filter((token) => token !== '')
  const rest = tokens.slice(1)
  if (action === 'revision') return rest.filter((token) => token !== '--force')
  return rest
}

/**
 * Wrap one Host-service invocation as the command receipt.
 * @param {object} service HandoffService from index.js
 * @param {{ agent: object, rawInput: string }} invocation command invocation
 * @returns {Promise<{ kind: 'success', text: string } | { kind: 'error', text: string }>}
 */
export async function handleInvocation(service, invocation) {
  const sessionId = invocation.agent.session.id
  const parsed = parseCommandInput(invocation.rawInput)
  const extras = unexpectedArguments(parsed.action, invocation.rawInput)
  if (extras.length > 0) {
    return {
      kind: 'error',
      text: `/${COMMAND_NAME} ${parsed.action} 不接受額外參數：${extras.join(' ')}。多個 link 請用 dock 的「選擇交接審查」選取。`,
    }
  }
  try {
    switch (parsed.action) {
      case 'create': {
        const result = await service.create({ sessionId, focus: parsed.focus, newLink: parsed.newLink })
        return { kind: 'success', text: result.message }
      }
      case 'status': {
        const result = await service.status({ sessionId })
        return { kind: 'success', text: result.text }
      }
      case 'feedback': {
        const result = await service.feedback({ sessionId })
        return { kind: 'success', text: result.message }
      }
      case 'revision': {
        const result = await service.revision({ sessionId, force: parsed.force })
        return { kind: 'success', text: result.message }
      }
      case 'close': {
        const result = await service.close({ sessionId })
        return { kind: 'success', text: result.message }
      }
      case 'reopen': {
        const result = await service.reopen({ sessionId })
        return { kind: 'success', text: result.message }
      }
      default:
        return { kind: 'error', text: `未知的 handoff-review 子指令：${parsed.action}` }
    }
  } catch (error) {
    const message = error && error.message ? error.message : String(error)
    return { kind: 'error', text: message }
  }
}

/**
 * Register the `/handoff-review` command. The registration is an effect on the
 * calling fiber (Cordis disposes it on unload).
 * @param {object} ctx Host plugin context
 * @param {object} service HandoffService from index.js
 * @returns {() => void} disposer
 */
export function registerCommands(ctx, service) {
  return ctx.commands.register({
    name: COMMAND_NAME,
    description: COMMAND_DESCRIPTION,
    input: { hint: COMMAND_INPUT_HINT },
    handler: (invocation) => handleInvocation(service, invocation),
  })
}
