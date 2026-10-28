import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createStore } from './lib/snapshot.js'
import { createEngine } from './lib/engine.js'
import { nextEpoch, currentEpoch, dropEpoch } from './lib/epoch.js'
import { createHeartbeat } from './lib/heartbeat.js'
import { createProbe, listResidue } from './lib/probe.js'
import { createGate, streamOutcome } from './lib/gate.js'
import { createLedger } from './lib/ledger.js'

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

function serve(ctx, engine, heartbeat, ledger, options, ready) {
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
  /**
   * What a state answer shows: the engine's own state, plus the reminder of work that stopped on its
   * own. `action` keeps one meaning for the button — there is at most one press it can make now.
   */
  const stateOf = () => {
    const pending = ledger.describe()
    const state = { ...engine.describe(), version: VERSION }
    if (pending.count > 0 || pending.busy === true) state.pendingContinue = pending
    if (state.action === 'none' && pending.busy === true) state.action = 'busy'
    else if (state.action === 'none' && pending.count > 0) state.action = 'continue'
    return state
  }
  const handlers = [
    [
      `${BASE_PATH}/state`,
      route(async (req, res) => {
        sendJson(res, 200, stateOf())
      }, true),
    ],
    [
      `${BASE_PATH}/continue`,
      route(async (req, res) => {
        // A press is only a continue press when the state that offered it was a continue press. A
        // pause or resume in flight owns the button, and a second batch is refused by the ledger.
        const now = stateOf()
        if (now.action !== 'continue') {
          return sendJson(res, 409, { ...now, outcome: { status: now.action === 'busy' ? 'busy' : 'empty' } })
        }
        // A continue press is a restore batch like any other: the same gate bounds its provider
        // requests, so six rows cannot open six streams while the resume path may open only two.
        if (options.progressive === true) options.gate.guard()
        let outcome = null
        try {
          outcome = await ledger.continueAll()
        } finally {
          if (options.progressive === true) options.gate.unguard()
        }
        log(`continue: ${outcome.status} (${outcome.continued}/${outcome.attempted})`)
        sendJson(res, 200, { ...stateOf(), outcome })
      }, false),
    ],
    [
      `${BASE_PATH}/pause`,
      route(async (req, res) => {
        // A continue batch is work too. Cancel it before the pause reports success, and wait for it
        // to unwind so no queued row can start after the person was told everything stopped.
        const continues = { cancelled: false, drained: true, started: [] }
        if (ledger.inFlight() === true) {
          continues.cancelled = ledger.cancel() === true
          try {
            options.gate.abort()
          } catch {
            /* the gate may already be disposed */
          }
          continues.drained = await ledger.drain(8000)
        }
        const outcome = await engine.pause()
        if (continues.cancelled) {
          try {
            continues.started = ledger.startedIds()
          } catch {
            continues.started = []
          }
        }
        log(`pause: ${outcome.status}${outcome.status === 'busy' ? ` (${outcome.phase})` : ''}${continues.cancelled ? `, continue cancelled (${continues.started.length} started)` : ''}`)
        if (outcome.status === 'paused' || outcome.status === 'partial') heartbeat.release()
        sendJson(res, 200, { ...engine.describe(), outcome: { ...outcome, continues }, version: VERSION })
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
    listRunning: () => listResidue(ctx),
    log,
  })
  let engineRef = null
  let ledgerRef = null
  const probe = createProbe(ctx, {
    isCurrent: () => currentEpoch() === epoch,
    // Reached only for rows discovered after the capture: the plan must hold them before the probe
    // cancels them, and the engine owns the plan.
    beforeCancel: (rows) => engineRef?.noteDiscovered(rows),
    // Turn boundaries are published for every session on one dispatch. The probe filters by id and
    // drops the listener when its bounded watch ends, so listeners never accumulate across presses.
    watchTurn: (sessionId, onEvent) => ctx.on('session/event', (session, event) => {
      if (session?.id === sessionId) onEvent(event)
    }),
    // Persisted before the admitted continuation is waited on: a crash in that gap must not resend
    // the message, and must not lose it either.
    onAdmitted: (sessionId, requestId) => {
      // From here on this session's turn belongs to the restore batch: its later model calls must
      // stay inside the slot budget even if the first stream already ended. Idempotent, because the
      // admission path can observe the same session on more than one edge.
      try {
        gate.admitted(sessionId)
      } catch {
        /* the gate may already be disposed */
      }
      // The synthetic continue plan has no engine row, so the ledger owns its admission. The engine
      // still owns every real restore row: falling back on its behalf would hide a persist failure.
      if (engineRef?.ownsAdmission?.(sessionId) === true) {
        return engineRef.recordAdmission(sessionId, requestId) !== false
      }
      return ledgerRef?.noteAdmitted?.(sessionId, requestId) === true
    },
    onStarted: (sessionId) => {
      ledgerRef?.noteStarted?.(sessionId)
    },
    // The shipped controller emits `turn/start` synchronously inside `prompt()`, before the caller
    // learns the request was admitted. Reserving the pending start immediately before the prompt is
    // the only point at which that event can be counted instead of dropped.
    onReserve: (sessionId) => {
      try {
        gate.reserve(sessionId)
      } catch {
        /* the gate may already be disposed */
      }
    },
    onAbandon: (sessionId) => {
      try {
        gate.abandon(sessionId)
      } catch {
        /* the gate may already be disposed */
      }
    },
    graceMs: Number.isFinite(config?.graceMs) ? config.graceMs : 2000,
    continueText: typeof config?.continueText === 'string' ? config.continueText : undefined,
  })
  /**
   * The reminder of turns that stopped on their own. It reads every event but persists at most one
   * small row per session; a title cache names a row without loading the session. Child sessions are
   * left to their parent's own turn: continuing one on its own would answer into a conversation no
   * person is looking at.
   */
  const ledger = createLedger({ dir, probe, log })
  ledgerRef = ledger
  let disposeLedger = () => {}
  if (typeof ctx.on === 'function') {
    try {
      const off = ctx.on('session/event', (session, event) => {
        try {
          const header = session?.header
          const parent = typeof header?.parentSession === 'string' && header.parentSession !== '' ? header.parentSession : null
          const origin = header?.origin === 'subagent' ? 'subagent' : null
          ledger.observe(session?.id, event, { parent, origin })
        } catch (error) {
          log(`cannot record a stopped turn: ${error?.message ?? error}`)
        }
      })
      if (typeof off === 'function') disposeLedger = off
    } catch (error) {
      log(`cannot follow stopped turns: ${error?.message ?? error}`)
    }
  }
  const epoch = nextEpoch()
  /** Progressive restore is an opt-in capacity measure, not part of the pause guarantee. */
  const progressive = config?.restoreProgressive === true
  /**
   * Progressive restore: the gate is what actually limits provider requests. The restore loop can
   * only limit dispatch, and a session counts as started as soon as its turn opens — the upstream
   * stream may begin seconds later, and compaction and retries add requests the loop never sees.
   */
  const gate = createGate({
    capacity: Number.isFinite(config?.restoreCapacity) ? config.restoreCapacity : 1,
    maxCapacity: Number.isFinite(config?.restoreMaxCapacity) ? config.restoreMaxCapacity : 2,
    cooldownMs: Number.isFinite(config?.restoreCooldownMs) ? config.restoreCooldownMs : 40000,
    log,
  })
  const engine = createEngine({
    store,
    probe,
    heartbeat,
    epoch,
    bootId: bootId(),
    graceMs: Number.isFinite(config?.graceMs) ? config.graceMs : 2000,
    gate,
    progressive,
    startGapMs: progressive && Number.isFinite(config?.restoreStartGapMs) ? config.restoreStartGapMs : 3000,
    maxRestoreAttempts: Number.isSafeInteger(config?.restoreMaxAttempts) && config.restoreMaxAttempts > 0 ? config.restoreMaxAttempts : 3,
    log,
  })
  engineRef = engine

  let disposed = false
  let disposeRoutes = () => {}
  let disposeStream = () => {}
  let disposeTurns = () => {}
  const cleanup = () => {
    disposed = true
    try {
      disposeStream()
    } catch {
      /* the listener may already be gone */
    }
    try {
      disposeTurns()
    } catch {
      /* the listener may already be gone */
    }
    try {
      disposeLedger()
    } catch {
      /* the listener may already be gone */
    }
    // The in-flight press, if any, checks this and refuses to write its stale result.
    dropEpoch(epoch)
    // A pending restore must not keep waiting on a permit nobody will release: the instance is gone,
    // so its queued rows are abandoned here instead of pinning the new instance's button as busy.
    try {
      gate.abort()
    } catch {
      /* the gate may already be disposed */
    }
    try {
      disposeRoutes()
    } catch {}
    // A reload is not a crash: keep the heartbeat's last write as evidence, but let go of timers.
    heartbeat.stop()
  }

  /**
   * The permit is held for the whole stream, not for admission: releasing at "accepted" or at the
   * first token would let six sessions pile six upstream requests onto the gateway while each is
   * still waiting for its answer. A terminal finish chunk is the only proof a request is over.
   */
  // Off is the default: no listener, no queue and no timer is installed, so a plain restore keeps
  // exactly the request path it had before this feature existed.
  if (progressive === true && typeof ctx.on === 'function') {
    try {
      const off = ctx.on('llm/stream', (options, next) => {
        if (gate.enabled() === false) return next()
        if (typeof options?.sessionId !== 'string') return next()
        // Only the restore batch is limited. A person typing in another session while a restore
        // runs keeps the ordinary request path: queuing it behind restored sessions would turn a
        // capacity measure into a stall of the whole harness.
        if (gate.scopes(options.sessionId) === false) return next()
        return (async function* limited() {
          const ticket = await gate.acquire({
            sessionId: options.sessionId,
            purpose: options.purpose,
            provider: options.provider,
            model: options.model,
          }, options.signal ?? null)
          let ended = false
          let kind = null
          try {
            for await (const chunk of next()) {
              if (chunk?.type === 'finish') kind = chunk?.reason?.kind ?? null
              yield chunk
            }
            ended = true
          } finally {
            // A consumer that walks away mid-stream (pause, abort, a cancelled turn) is not an
            // upstream failure: release without a strike, or the gate would cool down because the
            // person pressed pause. The same holds for a full-consumption `aborted` that our own
            // pause signal caused; only an upstream abort/error earns a strike.
            gate.release(ticket, streamOutcome({
              ended,
              kind,
              aborted: options.signal?.aborted === true,
            }))
          }
        })()
      })
      if (typeof off === 'function') disposeStream = off
      // The gate must outlive the streams of one restored turn. A turn makes one model call per
      // step with tool calls in between, so "nothing is streaming" is not "the batch is done"; the
      // turn edges are. Without this, a stream whose model call started a moment after the previous
      // one ended walked straight past the limit.
      if (typeof ctx.on === 'function') {
        try {
          const offTurn = ctx.on('session/event', (session, event) => {
            if (typeof session?.id !== 'string') return
            // Scope is decided inside the gate, not by `enabled()`: a `turn/start` that arrives after
            // an early drain closed still belongs to the batch for its bounded window, and only the
            // gate knows which sessions that batch reserved or tracked. Any other session's turn is
            // ignored there, so an unrelated conversation never reaches the queue.
            try {
              if (event?.type === 'turn/start') gate.turnOpen(session.id)
              else if (event?.type === 'turn/end') gate.turnEnd(session.id)
            } catch (error) {
              log(`cannot record a restore turn edge: ${error?.message ?? error}`)
            }
          })
          if (typeof offTurn === 'function') disposeTurns = offTurn
        } catch (error) {
          log(`cannot watch restore turns: ${error?.message ?? error}`)
        }
      }
    } catch (error) {
      log(`cannot install the restore gate: ${error?.message ?? error}`)
    }
  }

  if (typeof ctx.effect === 'function') ctx.effect(() => cleanup)
  else if (typeof ctx.on === 'function') ctx.on('dispose', cleanup)

  // Turn edges are what a crash loses first, so the heartbeat follows them instead of waiting for its
  // own interval. The interval stays as the fallback for a registry that changes shape silently.
  let liveness = null
  const noteRunning = () => {
    if (disposed) return
    try {
      heartbeat.note(listResidue(ctx))
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
    routeDispose = serve(scope, engine, heartbeat, ledger, { allowRemote, progressive, gate }, ready)
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

  return { store, engine, heartbeat, gate, ledger }
}
