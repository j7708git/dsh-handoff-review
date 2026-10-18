// handoff-review — Host HTTP routes for the client half.
//
// Exact routes bypass the host's `/api` prefix fence, so each route applies the
// same browser-trust fence itself: `connection.requestRejection` when the host
// exposes it, otherwise the loopback/Host/Origin fallback that mirrors
// `isTrustedApiRequest` (DEVELOPMENT.md §10.2, §13.4).

import { DeliveryError } from './delivery.js'

/** Stable route paths, verbatim from DEVELOPMENT.md §10.2. */
export const ROUTE_PATHS = {
  state: '/handoff-review/api/state',
  create: '/handoff-review/api/create',
  feedback: '/handoff-review/api/feedback',
  revision: '/handoff-review/api/revision',
  close: '/handoff-review/api/close',
  config: '/handoff-review/api/config',
  panel: '/handoff-review/api/panel',
  diff: '/handoff-review/api/diff',
}

/** Expected service-failure error carrying a stable client-facing code. */
export class HandoffError extends Error {
  /**
   * @param {string} code stable failure code (see DEVELOPMENT.md §10.2 / README)
   * @param {string} message user-facing diagnostic
   */
  constructor(code, message) {
    super(message)
    this.name = 'HandoffError'
    this.code = code
  }
}

/**
 * Read and JSON-parse a request body with a hard size cap.
 * @param {import('node:http').IncomingMessage} req request
 * @param {{ maxBytes?: number }} [options] size cap (default 256 KiB)
 * @returns {Promise<Record<string, unknown>>} parsed object body (empty object for an empty body)
 */
export function readBody(req, options = {}) {
  const maxBytes = Math.max(1, Math.trunc(options.maxBytes ?? 256 * 1024))
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    let done = false
    req.on('data', (chunk) => {
      if (done) return
      size += chunk.length
      if (size > maxBytes) {
        done = true
        try {
          req.pause()
        } catch {
          // socket already gone
        }
        // Do not leave the upload half-read: the response is already settled as
        // an error, so tear the request stream down instead of draining it.
        try {
          if (typeof req.destroy === 'function') req.destroy()
        } catch {
          // socket already gone
        }
        const error = new Error('body too large')
        error.code = 'BODY_TOO_LARGE'
        reject(error)
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (done) return
      done = true
      const text = Buffer.concat(chunks).toString('utf8')
      if (text.trim() === '') return resolve({})
      try {
        const parsed = JSON.parse(text)
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
          return reject(new Error('request body must be a JSON object'))
        }
        resolve(parsed)
      } catch (error) {
        reject(new Error(`request body is not valid JSON: ${error && error.message ? error.message : String(error)}`))
      }
    })
    req.on('error', (error) => {
      if (done) return
      done = true
      reject(error)
    })
  })
}

/**
 * Write one JSON response, ignoring a response whose client already disconnected.
 * @param {import('node:http').ServerResponse} res response
 * @param {Record<string, unknown>} payload JSON body
 * @param {number} [status] HTTP status (default 200)
 * @returns {void}
 */
export function sendJson(res, payload, status = 200) {
  try {
    if (res.writableEnded) return
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    })
    res.end(JSON.stringify(payload))
  } catch {
    // The client disconnected (navigation, cancel); nothing left to do.
  }
}

/**
 * Whether a `host[:port]` authority names this machine.
 * @param {string} authority Host header value
 * @returns {boolean} true for loopback authorities
 */
export function isLoopbackAuthority(authority) {
  const lower = String(authority ?? '').toLowerCase()
  const name = lower.startsWith('[') ? lower.slice(0, lower.indexOf(']') + 1) : lower.split(':')[0]
  return name === '127.0.0.1' || name === 'localhost' || name === '[::1]'
}

/**
 * Split a Host header into hostname and optional port (IPv6 literals keep their
 * brackets in the name).
 * @param {string} authority Host header value.
 * @returns {{ name: string, port: string }} lowercase hostname and port.
 */
function parseHostHeader(authority) {
  const lower = String(authority ?? '').toLowerCase()
  if (lower.startsWith('[')) {
    const end = lower.indexOf(']')
    if (end === -1) return { name: lower, port: '' }
    const rest = lower.slice(end + 1)
    return { name: lower.slice(0, end + 1), port: rest.startsWith(':') ? rest.slice(1) : '' }
  }
  const colon = lower.lastIndexOf(':')
  if (colon > 0 && /^[0-9]+$/.test(lower.slice(colon + 1))) {
    return { name: lower.slice(0, colon), port: lower.slice(colon + 1) }
  }
  return { name: lower, port: '' }
}

/**
 * Whether a browser `Origin` header names the same authority as the request's
 * `Host` header. Default ports are normalized so `Origin: http://localhost`
 * matches `Host: localhost:80`; a Host without a port names the same host.
 * @param {string} origin Origin header value.
 * @param {string} host Host header value.
 * @returns {boolean} true when same-origin.
 */
function sameOriginAuthority(origin, host) {
  if (typeof host !== 'string' || host === '') return false
  let url
  try {
    url = new URL(origin)
  } catch {
    return false
  }
  const parsed = parseHostHeader(host)
  if (parsed.name !== url.hostname.toLowerCase()) return false
  if (parsed.port === '') return true
  const defaultPort = url.protocol === 'https:' ? '443' : '80'
  return parsed.port === (url.port === '' ? defaultPort : url.port)
}

/**
 * Fallback fence used when the host exposes no `connection` service.
 *
 * Desktop forwarding may strip `Host`; an absent Host with no Origin is allowed
 * (nothing to compare), but an Origin without a Host, a non-loopback Host, a
 * cross-site fetch, or a mismatched Origin authority is rejected (fail closed).
 * @param {import('node:http').IncomingMessage} req request
 * @returns {number | undefined} rejection status, or undefined when allowed
 */
export function fallbackRejection(req) {
  const headers = req.headers ?? {}
  const host = headers.host
  if (host !== undefined && !isLoopbackAuthority(host)) return 403
  if (headers['sec-fetch-site'] === 'cross-site') return 403
  const origin = headers.origin
  if (typeof origin === 'string' && origin !== '') {
    if (origin === 'null') return 403
    // Without Host there is no authority to compare against: fail closed.
    if (typeof host !== 'string' || host === '') return 403
    if (!sameOriginAuthority(origin, host)) return 403
  }
  return undefined
}

/**
 * Apply the host's browser-trust fence to one request.
 * @param {object} ctx Host plugin context
 * @param {import('node:http').IncomingMessage} req request
 * @returns {number | undefined} rejection status, or undefined when allowed
 */
export function requestRejection(ctx, req) {
  let connection
  try {
    connection = ctx.get('connection')
  } catch {
    connection = undefined
  }
  const gate = connection !== undefined && typeof connection.requestRejection === 'function' ? connection.requestRejection : undefined
  if (typeof gate === 'function') {
    try {
      const status = gate.call(connection, req)
      if (status === undefined || status === null || status === false) return undefined
      const code = Number(status)
      return Number.isFinite(code) && code >= 400 ? code : 403
    } catch {
      // A throwing gate allowed nothing; fail closed.
      return 403
    }
  }
  return fallbackRejection(req)
}

/**
 * Fence + content-type guard. Returns true when the request was already answered.
 * @param {object} ctx Host plugin context
 * @param {import('node:http').IncomingMessage} req request
 * @param {import('node:http').ServerResponse} res response
 * @returns {boolean} true when the request must stop here
 */
export function refuseRequest(ctx, req, res) {
  const rejection = requestRejection(ctx, req)
  if (rejection !== undefined) {
    sendJson(
      res,
      {
        ok: false,
        code: 'FORBIDDEN',
        message: rejection === 401 ? '需要先登入 DSH 後重試。' : '請求來自不受信任的來源，已拒絕。',
      },
      rejection,
    )
    return true
  }
  if (req.method === 'POST') {
    const contentType = String((req.headers && req.headers['content-type']) || '').toLowerCase()
    if (contentType !== '' && !contentType.startsWith('application/json')) {
      sendJson(res, { ok: false, code: 'BAD_BODY', message: '請求體必須是 JSON。' }, 415)
      return true
    }
  }
  return false
}

/**
 * Map one service failure to the JSON error contract.
 * @param {unknown} error thrown value
 * @returns {{ status: number, body: Record<string, unknown> }}
 */
export function errorResponse(error) {
  if (error instanceof HandoffError) {
    return { status: 200, body: { ok: false, code: error.code, message: error.message } }
  }
  // Delivery refusals are ordinary user-facing outcomes (duplicate report, rate
  // limit, no live peer, round cap), not internal errors: keep their stable code
  // and message instead of masking them as INTERNAL. Match the class, never a
  // duck-typed code string, so unrelated failures cannot impersonate one.
  if (error instanceof DeliveryError) {
    return {
      status: 200,
      body: {
        ok: false,
        code: error.code,
        message: typeof error.message === 'string' && error.message !== ''
          ? error.message
          : '交接審查投遞被拒絕。',
      },
    }
  }
  // Keep unexpected details in the host log; the client gets a stable message.
  console.error(
    `handoff-review: internal route error: ${error && error.stack ? error.stack : String(error)}`,
  )
  return {
    status: 200,
    body: { ok: false, code: 'INTERNAL', message: 'handoff-review 內部錯誤，請稍後重試。' },
  }
}

/**
 * Run one async handler with unified error mapping and always-finished responses.
 * @param {(req: import('node:http').IncomingMessage) => Promise<Record<string, unknown>>} handler body
 * @returns {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => Promise<void>}
 */
function wrap(handler) {
  return async (req, res) => {
    try {
      const payload = await handler(req)
      sendJson(res, { ok: true, ...payload })
    } catch (error) {
      const { status, body } = errorResponse(error)
      sendJson(res, body, status)
    }
  }
}

/**
 * Extract a required string field from a parsed body.
 * @param {Record<string, unknown>} body parsed body
 * @param {string} name field name
 * @returns {string} trimmed value
 * @throws {HandoffError} `BAD_BODY` when absent/empty
 */
function requireString(body, name) {
  const value = body[name]
  if (typeof value !== 'string' || value.trim() === '') {
    throw new HandoffError('BAD_BODY', `缺少必要欄位 ${name}。`)
  }
  return value.trim()
}

/**
 * Build the five exact route definitions bound to one service.
 * @param {object} service HandoffService from index.js
 * @param {object} ctx Host plugin context (fence)
 * @returns {Array<{ kind: 'exact', path: string, handler: Function }>} route definitions
 */
export function createRouteDefinitions(ctx, service) {
  const getRoute = (path, run) => ({
    kind: 'exact',
    path,
    handler: wrap(async (req) => {
      if (req.method !== 'GET') throw new HandoffError('BAD_BODY', `${path} 只接受 GET。`)
      const url = new URL(String(req.url ?? path), 'http://127.0.0.1')
      return run(url)
    }),
  })

  const postRoute = (path, run) => ({
    kind: 'exact',
    path,
    handler: wrap(async (req) => {
      if (req.method !== 'POST') throw new HandoffError('BAD_BODY', `${path} 只接受 POST。`)
      let body
      try {
        body = await readBody(req)
      } catch (error) {
        if (error && error.code === 'BODY_TOO_LARGE') throw new HandoffError('BAD_BODY', '請求體過大（上限 256 KiB）。')
        throw new HandoffError('BAD_BODY', error && error.message ? error.message : String(error))
      }
      return run(body)
    }),
  })

  const querySessionId = (url) => {
    const sessionId = url.searchParams.get('sessionId')
    if (sessionId === null || sessionId === '') throw new HandoffError('BAD_BODY', '缺少必要參數 sessionId。')
    return sessionId
  }
  const queryLinkId = (url) => {
    const linkId = url.searchParams.get('linkId')
    return linkId !== null && linkId !== '' ? linkId : null
  }
  const optionalString = (body, name) => {
    const value = body[name]
    return typeof value === 'string' && value.trim() !== '' ? value.trim() : null
  }

  const stateRoute = getRoute(ROUTE_PATHS.state, (url) =>
    service.state({ sessionId: querySessionId(url), linkId: queryLinkId(url) }),
  )
  const createRoute = postRoute(ROUTE_PATHS.create, async (body) => {
    const sessionId = requireString(body, 'sessionId')
    const focus = optionalString(body, 'focus')
    return service.create({
      sessionId,
      focus,
      newLink: body.newLink === true,
    })
  })
  const feedbackRoute = postRoute(ROUTE_PATHS.feedback, async (body) =>
    service.feedback({ sessionId: requireString(body, 'sessionId'), linkId: optionalString(body, 'linkId') }),
  )
  const revisionRoute = postRoute(ROUTE_PATHS.revision, async (body) =>
    service.revision({
      sessionId: requireString(body, 'sessionId'),
      linkId: optionalString(body, 'linkId'),
      force: body.force === true,
    }),
  )
  const closeRoute = postRoute(ROUTE_PATHS.close, async (body) =>
    service.close({ sessionId: requireString(body, 'sessionId'), linkId: optionalString(body, 'linkId') }),
  )
  // One exact route per path: the host web server keys exact routes by path,
  // so GET/POST share a method-dispatching handler.
  const configRoute = {
    kind: 'exact',
    path: ROUTE_PATHS.config,
    handler: wrap(async (req) => {
      if (req.method === 'GET') return service.getConfig()
      if (req.method !== 'POST') throw new HandoffError('BAD_BODY', 'config 只接受 GET 或 POST。')
      let body
      try {
        body = await readBody(req)
      } catch (error) {
        throw new HandoffError('BAD_BODY', error && error.message ? error.message : String(error))
      }
      const config = body !== null && typeof body === 'object' && body.config !== undefined ? body.config : body
      return service.updateConfig({ config })
    }),
  }
  const panelRoute = getRoute(ROUTE_PATHS.panel, (url) =>
    service.panel({ sessionId: querySessionId(url), linkId: queryLinkId(url) }),
  )
  const diffRoute = getRoute(ROUTE_PATHS.diff, (url) =>
    service.diff({ sessionId: querySessionId(url), linkId: queryLinkId(url) }),
  )

  const routes = [
    stateRoute,
    createRoute,
    feedbackRoute,
    revisionRoute,
    closeRoute,
    configRoute,
    panelRoute,
    diffRoute,
  ]
  for (const route of routes) {
    const inner = route.handler
    route.handler = async (req, res) => {
      if (refuseRequest(ctx, req, res)) return
      return inner(req, res)
    }
  }
  return routes
}

/**
 * Register the client API routes when the composition mounts a web server.
 * @param {object} ctx Host plugin context
 * @param {object} service HandoffService from index.js
 * @returns {() => void} disposer (no-op without a web server)
 */
export function registerRoutes(ctx, service) {
  const webServer = ctx.get('webServer')
  if (webServer === undefined || typeof webServer.register !== 'function') {
    return () => {}
  }
  return ctx.effect(() => {
    const disposers = []
    for (const route of createRouteDefinitions(ctx, service)) {
      try {
        disposers.push(webServer.register(route))
      } catch (error) {
        console.error(
          `handoff-review: 路由註冊失敗，已跳過 ${route.path}：${error && error.message ? error.message : String(error)}`,
        )
      }
    }
    return () => {
      for (const dispose of disposers.splice(0)) {
        try {
          dispose()
        } catch {
          // already disposed
        }
      }
    }
  }, 'handoff-review: routes')
}
