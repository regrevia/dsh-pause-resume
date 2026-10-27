import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createStore } from './lib/snapshot.js'
import { createEngine } from './lib/engine.js'
import { nextEpoch, currentEpoch, dropEpoch } from './lib/epoch.js'
import { createHeartbeat } from './lib/heartbeat.js'
import { createProbe, listRunning } from './lib/probe.js'

export const name = 'dsh-pause-resume'

/**
 * The version every response carries. It is read from the manifest instead of being a second
 * literal, because the literal was forgotten for three releases while the package moved on: an
 * answer that names the wrong build is worse than no answer when someone is diagnosing a restart.
 */
export const VERSION = (() => {
  try {
    const manifest = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'))
    return typeof manifest?.version === 'string' && manifest.version !== '' ? manifest.version : 'unknown'
  } catch {
    return 'unknown'
  }
})()

const BASE_PATH = '/dsh-pause-resume'
const BUTTON_HEADER = 'x-dsh-pause-resume'
const BOOT_KEY = Symbol.for('dsh-pause-resume.boot')
const LIVENESS_MS = 400

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
    if (res?.headersSent === true) return res.end()
    const body = JSON.stringify(value ?? { status: 'error' })
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

/**
 * Whether one request may act for the button: a header a cross-site form cannot set, and the same
 * origin that served this page. `allowRemote` widens the address check, never the header or origin
 * check, so a hostile page cannot press the button even on a trusted network.
 */
function buttonAllowed(req, allowRemote) {
  try {
    const header = req?.headers?.[BUTTON_HEADER]
    if (typeof header !== 'string' || header === '') return false
    const site = typeof req?.headers?.host === 'string' ? req.headers.host.trim().toLowerCase() : '' // ui-copy-ignore
    if (site === '') return false
    if (allowRemote !== true && LOCAL_ADDRESS.test(site) === false) return false
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

function serve(ctx, engine, heartbeat, options, ready) {
  const server = service(ctx, 'webServer')
  if (server === undefined || server === null || typeof server.register !== 'function') {
    log('no web server: the header button cannot ask for a pause')
    return () => {}
  }
  const allowRemote = options.allowRemote === true
  let disposed = false
  const route = (handler, read) => guard(async (req, res) => {
    const method = String(req?.method ?? 'GET').toUpperCase()
    if (read === true ? method !== 'GET' && method !== 'HEAD' : method !== 'POST') {
      return sendJson(res, 405, { status: 'method' })
    }
    // A read still refuses another origin, but it does not need the button header.
    if (read === true ? sameOrigin(req, allowRemote) === false : buttonAllowed(req, allowRemote) === false) {
      return sendJson(res, 403, { status: 'forbidden' })
    }
    // Routes are registered synchronously so no press can arrive before the table has them.
    // Hydration may still be reading crash residue, so every press waits for it instead of acting blind.
    if (ready !== undefined) await ready
    if (disposed === true) return sendJson(res, 503, { status: 'starting' })
    return handler(req, res)
  })
  const handlers = [
    [
      `${BASE_PATH}/state`,
      route(async (req, res) => {
        sendJson(res, 200, { ...engine.describe(), version: VERSION })
      }, true),
    ],
    [
      `${BASE_PATH}/pause`,
      route(async (req, res) => {
        const outcome = await engine.pause()
        log(`pause: ${outcome.status}${outcome.status === 'busy' ? ` (${outcome.phase})` : ''}`)
        if (outcome.status === 'paused' || outcome.status === 'partial') heartbeat.release()
        sendJson(res, 200, { ...engine.describe(), outcome, version: VERSION })
      }, false),
    ],
    [
      `${BASE_PATH}/resume`,
      route(async (req, res) => {
        const outcome = await engine.resume()
        log(`resume: ${outcome.status}`)
        sendJson(res, 200, { ...engine.describe(), outcome, version: VERSION })
      }, false),
    ],
  ]
  const disposers = []
  for (const [path, handler] of handlers) {
    try {
      const dispose = server.register({ kind: 'exact', path, handler })
      if (typeof dispose === 'function') disposers.push(dispose)
    } catch (error) {
      log(`cannot answer ${path}: ${error?.message ?? error}`)
    }
  }
  return () => {
    disposed = true
    for (const dispose of disposers) {
      try {
        dispose()
      } catch {}
    }
  }
}

/** Same-origin read: a page on another host may not learn what is running here. */ // ui-copy-ignore
function sameOrigin(req, allowRemote) {
  try {
    const site = typeof req?.headers?.host === 'string' ? req.headers.host.trim().toLowerCase() : '' // ui-copy-ignore
    if (site === '') return false
    if (allowRemote !== true && LOCAL_ADDRESS.test(site) === false) return false
    const origin = typeof req?.headers?.origin === 'string' ? req.headers.origin.trim().toLowerCase() : ''
    if (origin === 'null') return false
    if (origin === '') return true
    try {
      return new URL(origin).host.toLowerCase() === site // ui-copy-ignore
    } catch {
      return false
    }
  } catch {
    return false
  }
}

export function apply(ctx, config = {}) {
  const dir = dataDir()
  const allowRemote = config?.allowRemote === true
  const store = createStore(dir, { log })
  const heartbeat = createHeartbeat({
    dir,
    bootId: bootId(),
    intervalMs: Number.isFinite(config?.intervalMs) ? config.intervalMs : 5000,
    listRunning: () => listRunning(ctx),
    log,
  })
  const probe = createProbe(ctx, {
    isCurrent: () => currentEpoch() === epoch,
    graceMs: Number.isFinite(config?.graceMs) ? config.graceMs : 2000,
    continueText: typeof config?.continueText === 'string' ? config.continueText : undefined,
  })
  const epoch = nextEpoch()
  const engine = createEngine({
    store,
    probe,
    heartbeat,
    epoch,
    bootId: bootId(),
    graceMs: Number.isFinite(config?.graceMs) ? config.graceMs : 2000,
    log,
  })

  let disposed = false
  let disposeRoutes = () => {}
  const cleanup = () => {
    disposed = true
    // The in-flight press, if any, checks this and refuses to write its stale result.
    dropEpoch(epoch)
    try {
      disposeRoutes()
    } catch {}
    // A reload is not a crash: keep the heartbeat's last write as evidence, but let go of timers.
    heartbeat.stop()
  }

  if (typeof ctx.effect === 'function') ctx.effect(() => cleanup)
  else if (typeof ctx.on === 'function') ctx.on('dispose', cleanup)

  // Turn edges are what a crash loses first, so the heartbeat follows them instead of waiting for its
  // own interval. The interval stays as the fallback for a registry that changes shape silently.
  let liveness = null
  const noteRunning = () => {
    if (disposed) return
    try {
      heartbeat.note(listRunning(ctx))
    } catch (error) {
      log(`cannot note running work: ${error?.message ?? error}`)
    }
  }
  const watchStatus = () => {
    if (liveness !== null) clearTimeout(liveness)
    liveness = setTimeout(() => {
      liveness = null
      noteRunning()
    }, LIVENESS_MS)
    if (typeof liveness?.unref === 'function') liveness.unref()
  }
  try {
    if (typeof ctx.on === 'function') {
      ctx.on('agent/status', watchStatus)
      ctx.on('agent/dispose', watchStatus)
      ctx.on('agent/register', watchStatus)
    }
  } catch (error) {
    log(`cannot follow agent events: ${error?.message ?? error}`)
  }

  // Routes must be registered while `apply` is still synchronous, so a press can never arrive
  // before the table has an entry. Hydration is asynchronous; the handlers wait on this promise.
  let releaseReady = () => {}
  const ready = new Promise((resolve) => {
    releaseReady = resolve
  })
  // The web server is not always there when a plugin is applied — after a crash the desktop host
  // can mount plugins before it exists. Asking once and giving up left the button permanently
  // disabled with no route behind it, which reads exactly like "the pause button does not work".
  // Wait for the service instead; on a boot where it already exists this mounts synchronously.
  let routeDispose = () => {}
  let injectDispose = () => {}
  const mount = (scope) => {
    routeDispose = serve(scope, engine, heartbeat, { allowRemote }, ready)
    if (disposed) {
      routeDispose()
      routeDispose = () => {}
    }
  }
  if (typeof ctx.inject === 'function') {
    const unmount = ctx.inject(['webServer'], mount)
    if (typeof unmount === 'function') injectDispose = unmount
  } else {
    mount(ctx)
  }
  disposeRoutes = () => {
    injectDispose()
    routeDispose()
  }

  void (async () => {
    try {
      // Read the previous process's record before `start()` overwrites it, and persist the crash
      // plan before the heartbeat goes away: a second restart then still sees the same work.
      const residue = heartbeat.peek()
      const hydrated = await engine.hydrate({ residue })
      if (disposed) return
      // Only overwrite the previous process's record after the residue is durable. Otherwise the
      // next boot would read this process's nearly-empty heartbeat and lose the work entirely.
      if (hydrated?.durable === false) {
        log('crash residue is not durable; heartbeat not started')
        return
      }
      heartbeat.start()
      log(`ready (${engine.phase})`)
    } catch (error) {
      log(`cannot start: ${error?.message ?? error}`)
    } finally {
      releaseReady()
    }
  })()

  return { store, engine, heartbeat }
}
