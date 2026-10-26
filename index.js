import { homedir } from 'node:os'
import { join } from 'node:path'
import { createStore } from './lib/snapshot.js'
import { createEngine } from './lib/engine.js'
import { createHeartbeat } from './lib/heartbeat.js'
import { createProbe, listRunning } from './lib/probe.js'

export const name = 'dsh-pause-resume'
export const VERSION = '0.1.0'

const BASE_PATH = '/dsh-pause-resume'
const BUTTON_HEADER = 'x-dsh-pause-resume'
const BOOT_KEY = Symbol.for('dsh-pause-resume.boot')

/** A page this machine may have opened. A public name that resolves here is the rebinding case. */
const LOCAL_ADDRESS =
  /^(127\.\d+\.\d+\.\d+|localhost|\[::1\]|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|169\.254\.\d+\.\d+|[a-z0-9-]+\.local)(:\d+)?$/u

function log(message) {
  try {
    console.log(`[dsh-pause-resume] ${message}`)
  } catch {
    /* a closed stdout is not worth a throw */
  }
}

function dataDir() {
  const home = typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME !== '' ? process.env.DSH_HOME : join(homedir(), '.dsh')
  return join(home, 'pause-resume')
}

/** One id per process: a reload of this plugin is the same process and the same boot. */
function bootId() {
  const existing = globalThis[BOOT_KEY]
  if (typeof existing === 'string') return existing
  const created = `${process.pid}-${Date.now().toString(36)}`
  globalThis[BOOT_KEY] = created
  return created
}


function service(ctx, key) {
  try {
    return ctx.get(key)
  } catch {
    return undefined
  }
}

function sendJson(res, status, value) {
  try {
    const body = JSON.stringify(value ?? { status: 'error' })
    if (res?.headersSent === true) return res.end()
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'content-length': Buffer.byteLength(body),
    })
    res.end(body)
  } catch {
    try {
      if (res?.writableEnded !== true && res?.destroyed !== true) res.end()
    } catch {
      /* the socket is already gone */
    }
  }
}

/** Whether one request may act for the button: a header a cross-site form cannot set, same origin. */
function buttonAllowed(req) {
  try {
    const header = req?.headers?.[BUTTON_HEADER]
    if (typeof header !== 'string' || header === '') return false
    const site = typeof req?.headers?.host === 'string' ? req.headers.host.trim().toLowerCase() : '' // ui-copy-ignore
    if (site !== '' && LOCAL_ADDRESS.test(site) === false) return false
    const origin = typeof req?.headers?.origin === 'string' ? req.headers.origin.trim().toLowerCase() : ''
    if (origin === 'null') return false
    if (origin !== '') {
      let originSite = ''
      try {
        originSite = new URL(origin).host.toLowerCase() // ui-copy-ignore
      } catch {
        return false
      }
      if (originSite !== site) return false
    }
    return true
  } catch {
    return false
  }
}

function guard(handler) {
  return (req, res) => {
    const fallback = (error) => {
      log(`route failed: ${error?.message ?? error}`)
      try {
        if (res?.headersSent !== true) sendJson(res, 503, { status: 'error' })
        else if (res?.writableEnded !== true && res?.destroyed !== true) res.end()
      } catch {
        /* already answered */
      }
    }
    try {
      const answer = handler(req, res)
      if (answer !== null && typeof answer === 'object' && typeof answer.then === 'function') answer.then(undefined, fallback)
      return answer
    } catch (error) {
      fallback(error)
      return undefined
    }
  }
}

function serve(ctx, engine, heartbeat) {
  const server = service(ctx, 'webServer')
  if (server === undefined || server === null || typeof server.register !== 'function') {
    log('no web server: the header button cannot ask for a pause')
    return () => {}
  }
  const handlers = [
    [
      `${BASE_PATH}/state`,
      async (req, res) => {
        const method = String(req?.method ?? 'GET').toUpperCase()
        if (method !== 'GET' && method !== 'HEAD') return sendJson(res, 405, { status: 'method' })
        sendJson(res, 200, await engine.describe())
      },
    ],
    [
      `${BASE_PATH}/pause`,
      async (req, res) => {
        const method = String(req?.method ?? 'GET').toUpperCase()
        if (method !== 'POST') return sendJson(res, 405, { status: 'method' })
        if (buttonAllowed(req) === false) return sendJson(res, 403, { status: 'forbidden' })
        const outcome = await engine.pause()
        log(`pause: ${outcome.status}${outcome.status === 'busy' ? ` (${outcome.phase})` : ''}`)
        if (outcome.status === 'paused') heartbeat.release()
        sendJson(res, 200, { ...(await engine.describe()), outcome })
      },
    ],
    [
      `${BASE_PATH}/resume`,
      async (req, res) => {
        const method = String(req?.method ?? 'GET').toUpperCase()
        if (method !== 'POST') return sendJson(res, 405, { status: 'method' })
        if (buttonAllowed(req) === false) return sendJson(res, 403, { status: 'forbidden' })
        const outcome = await engine.resume()
        log(`resume: ${outcome.status}`)
        if (outcome.status === 'resumed') heartbeat.release()
        sendJson(res, 200, { ...(await engine.describe()), outcome })
      },
    ],
  ]
  const disposers = []
  for (const [path, handler] of handlers) {
    try {
      const dispose = server.register({ kind: 'exact', path, handler: guard(handler) })
      if (typeof dispose === 'function') disposers.push(dispose)
    } catch (error) {
      log(`cannot answer ${path}: ${error?.message ?? error}`)
    }
  }
  return () => {
    for (const dispose of disposers) {
      try {
        dispose()
      } catch {}
    }
  }
}

export function apply(ctx, config = {}) {
  const dir = dataDir()
  const store = createStore(dir)
  const heartbeat = createHeartbeat({
    dir,
    bootId: bootId(),
    listRunning: () => listRunning(ctx),
    log,
  })
  const engine = createEngine({
    store,
    probe: createProbe(ctx, heartbeat),
    graceMs: Number.isFinite(config?.graceMs) ? config.graceMs : 2000,
    gapMs: Number.isFinite(config?.gapMs) ? config.gapMs : 150,
    log,
  })

  let disposeRoutes = () => {}
  const cleanup = () => {
    try {
      disposeRoutes()
    } catch {}
    heartbeat.stop()
  }

  if (typeof ctx.effect === 'function') ctx.effect(() => cleanup)
  else if (typeof ctx.on === 'function') ctx.on('dispose', cleanup)

  void (async () => {
    try {
      await engine.hydrate()
      heartbeat.start()
      disposeRoutes = serve(ctx, engine, heartbeat)
      log(`ready (${engine.phase})`)
    } catch (error) {
      log(`cannot start: ${error?.message ?? error}`)
    }
  })()

  return { store, engine, heartbeat }
}
