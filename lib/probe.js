/**
 * What the Harness is doing right now, and how to stop one piece of it without losing the pieces
 * behind it.
 *
 * Every fact below is one of the official service contracts, checked against the shipped Harness:
 * - `agents.get(id)` returns the live Agent object itself, and every goal call takes that object
 *   (the goal service rejects `{ id }` stand-ins). Enumerating `agents.list()` is therefore both the
 *   cheapest and the only correct view of "who can run". A session with no live agent cannot be
 *   running and cannot have an armed goal.
 * - `sessionController.cancel({ sessionId })` stops one turn and keeps the pending inbox.
 * - `sessionController.resolveAgent(sessionId)` is the public resume path: it mounts the recorded
 *   preset and model selection, unlike a raw `agents.resume`.
 * - `sessionController.prompt(request, signal)` admits one real user message after resuming the
 *   session itself. The shipped service validates the AbortSignal before it does anything, so the
 *   second argument is that signal, never the source metadata (the service builds the source).
 *   That is the only supported way to make a resumed session continue work, so a restore that must
 *   continue says so with a visible message instead of pretending the turn came back by itself.
 * - `sessionController.resolveAgent(sessionId)` answers an already live Agent directly and wraps a
 *   cold one as `{ agent }`, or `{ error }`; both shapes are handled here.
 * - `goals.pause` / `goals.resume` require the exact current revision, and every transition bumps
 *   it. The revision captured after pausing is the one a later resume must present.
 */

import { open, readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import * as zlib from 'node:zlib'

/** A zstd frame starts with this little-endian magic; a session log is a run of such frames. */
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
const LOG_TAIL_BYTES = 256 * 1024
const LOG_TAIL_ROUNDS = 4
const LOG_READ_MS = 1200
/** The reasons a `turn/end` can carry in the shipped runtime. Anything else is not evidence. */
const END_KINDS = new Set(['completed', 'interrupted', 'aborted', 'error', 'blocked'])

/** One durable turn end out of a log event, or null when the record cannot be read as one. */
function endOfEvent(event) {
  if (event === null || typeof event !== 'object' || event.type !== 'turn/end') return null
  const turn = Number.isSafeInteger(event?.data?.turn) ? event.data.turn : null
  const kind = typeof event?.data?.reason?.kind === 'string' ? event.data.reason.kind : null
  if (turn === null || kind === null || END_KINDS.has(kind) === false) return null
  return { turn, kind }
}

/** Decompress every complete frame in one chunk; a torn frame at the tail is dropped, not guessed. */
function decodeFrames(chunk) {
  const offsets = []
  let from = 0
  for (;;) {
    const at = chunk.indexOf(ZSTD_MAGIC, from)
    if (at === -1) break
    offsets.push(at)
    from = at + ZSTD_MAGIC.length
  }
  if (offsets.length === 0) return null
  const ends = []
  for (const offset of offsets) {
    let text
    try {
      text = zlib.zstdDecompressSync(chunk.subarray(offset)).toString('utf8')
    } catch {
      continue
    }
    for (const line of text.split('\n')) {
      if (line.trim() === '') continue
      try {
        const end = endOfEvent(JSON.parse(line))
        if (end !== null) ends.push(end)
      } catch {
        /* a torn line is not evidence */
      }
    }
  }
  return ends.length === 0 ? null : ends
}

/**
 * The tail of one session log, parsed into turn ends. The log appends a compressed frame per flush,
 * so a bounded tail is enough: reading a whole long session is not worth a press. Returns null when
 * there is no log, no zstd decoder, or nothing readable — never an empty answer that reads as proof.
 */
async function readLogTail(file) {
  if (typeof zlib.zstdDecompressSync !== 'function') return null
  const deadline = Date.now() + LOG_READ_MS
  let handle
  try {
    handle = await open(file, 'r')
  } catch {
    return null
  }
  try {
    const { size } = await handle.stat()
    let end = size
    for (let round = 0; round < LOG_TAIL_ROUNDS && end > 0; round += 1) {
      if (Date.now() > deadline) return null
      const start = Math.max(0, end - LOG_TAIL_BYTES)
      const buffer = Buffer.alloc(end - start)
      const read = await handle.read(buffer, 0, buffer.length, start)
      const ends = decodeFrames(buffer.subarray(0, read.bytesRead))
      if (ends !== null) return ends
      end = start
    }
    return null
  } catch {
    return null
  } finally {
    await handle.close().catch(() => {})
  }
}

/** The directory a session log lives in, if this home has one for that session. */
async function findSessionLog(home, sessionId) {
  if (typeof home !== 'string' || home === '') return null
  const raw = sessionId.startsWith('session-') ? sessionId.slice('session-'.length) : sessionId
  const root = join(home, 'sessions')
  let buckets
  try {
    buckets = await readdir(root)
  } catch {
    return null
  }
  const deadline = Date.now() + LOG_READ_MS
  for (const bucket of buckets) {
    if (Date.now() > deadline) return null
    const dir = join(root, bucket, `session-${raw}`)
    for (const name of ['session.v4.jsonl.zstd', 'session.jsonl.zstd']) {
      const file = join(dir, name)
      try {
        const info = await stat(file)
        if (info.size > 0) return file
      } catch {
        /* not this name */
      }
    }
  }
  return null
}

function service(services, key) {
  try {
    return services.get(key)
  } catch {
    return undefined
  }
}

/** The live Agent for one session, or undefined. Never a `{ id }` stand-in. */
function agentOf(services, sessionId) {
  const agents = service(services, 'agents')
  if (agents === undefined || agents === null || typeof agents.get !== 'function') return undefined
  try {
    const found = agents.get(sessionId)
    if (found === undefined || found === null) return undefined
    if (typeof found.id === 'string' && typeof found.status === 'string') return found
    return typeof found.agent?.id === 'string' ? found.agent : undefined
  } catch {
    return undefined
  }
}

/**
 * Live agents are the cheap truth for "who is attached right now": a couple of dozen handles in
 * memory, against a listing that walks every session ever recorded on disk. It answers `undefined`
 * when the registry cannot be read, so the caller can tell "nothing live" from "cannot tell".
 */
function agentsOf(services) {
  const agents = service(services, 'agents')
  if (agents === undefined || agents === null || typeof agents.list !== 'function') return undefined
  try {
    const handles = agents.list()
    if (!Array.isArray(handles)) return undefined
    return handles
      // The row wrapper carries its own `status`; only the agent inside it knows whether a turn is open.
      .map((handle) => (handle?.agent !== null && typeof handle?.agent === 'object' ? handle.agent : handle))
      .filter((agent) => agent !== null && agent !== undefined && typeof agent?.id === 'string')
  } catch {
    return undefined
  }
}

/** The session ids whose turn is open right now: the heartbeat's first question. */
export function listRunning(services) {
  const agents = agentsOf(services)
  if (agents === undefined) return []
  return agents.filter((agent) => agent.status === 'running').map((agent) => agent.id)
}

/**
 * What a crash would lose: the sessions with an open turn, and the armed goals entitled to start
 * one. A goal is recorded even when its session has no open turn, because between rounds the next
 * round is still owed to the person.
 */
export function listResidue(services) {
  const agents = agentsOf(services)
  // `readable: false` is the difference between "nothing was running" and "I could not look": the
  // heartbeat keeps its last known-good rows instead of overwriting the crash record with silence.
  if (agents === undefined) return { sessions: [], goals: [], readable: false }
  const sessions = []
  const goals = []
  let readable = true
  for (const agent of agents) {
    if (typeof agent?.id !== 'string' || agent.id === '') continue
    // The turn counter is the evidence a crash restore uses to prove the interrupted turn did not
    // run again behind its back. A running phase reports the open turn, which is the baseline.
    if (agent.status === 'running') {
      const parent = parentOf(services, agents, agent)
      sessions.push(parent === null ? { sessionId: agent.id, lastTurn: lastTurnOf(agent) } : { sessionId: agent.id, lastTurn: lastTurnOf(agent), parent })
    }
    const goal = goalView(services, agent)
    if (goal !== undefined && goal !== null && goal.unreadable === true) {
      readable = false
      continue
    }
    if (goal === undefined || goal === null) continue
    if (goal.phase === 'active' && goal.activation === 'armed' && typeof goal.id === 'string' && goal.id !== '' && Number.isSafeInteger(goal.revision)) {
      goals.push({ sessionId: agent.id, goalId: goal.id, revision: goal.revision })
    }
  }
  return { sessions, goals, readable }
}

/**
 * The parent session of a live child, taken from the durable lineage first and from runtime
 * ownership second. `null` means this row is not a child.
 */
function parentOf(services, agents, child) {
  const header = child?.session?.header
  if (typeof header?.parentSession === 'string' && header.parentSession !== '') return header.parentSession
  const registry = service(services, 'agents')
  for (const candidate of agents) {
    if (candidate === child || typeof candidate?.id !== 'string') continue
    try {
      if (registry?.isOwnedBy?.(child.id, candidate) === true) return candidate.id
    } catch {
      // Ownership is a hint here; a throw means this candidate cannot prove it.
    }
  }
  return null
}

/** The goal view for one exact live agent, or undefined. The goal service throws for a dead agent. */
function goalView(services, agent) {
  const goals = service(services, 'goals')
  if (goals === undefined || goals === null || typeof goals.get !== 'function') return undefined
  try {
    const view = goals.get(agent)
    // `null` is the service's answer for "no goal"; a throw is "cannot tell right now". Collapsing
    // both into `undefined` made a transient read error look like the goal had been deleted, which
    // the restore then recorded as a terminal skip and never retried.
    return view === undefined || view === null ? null : view
  } catch (error) {
    return { unreadable: true, detail: String(error?.message ?? error).slice(0, 120) }
  }
}

/**
 * Owned jobs are invisible to a caller-less `list`, so every live session is asked for its own
 * bucket as well. One job can only be owned by one session, and the id map keeps the union exact.
 */
function listJobs(services, owners = []) {
  const jobs = service(services, 'jobs')
  if (jobs === undefined || jobs === null || typeof jobs.list !== 'function') return []
  const seen = new Map()
  const collect = (rows) => {
    if (!Array.isArray(rows)) return
    for (const row of rows) if (row !== null && typeof row?.id === 'string' && !seen.has(row.id)) seen.set(row.id, row)
  }
  try {
    collect(jobs.list())
  } catch {
    // An unusable registry contributes nothing; the state shows no jobs.
  }
  for (const owner of owners) {
    try {
      collect(jobs.list(owner))
    } catch {
      // A bucket that cannot be read is not work this press can stop.
    }
  }
  return [...seen.values()]
}

const RUNNING_JOB = new Set(['running'])

/** The last turn number this agent has opened, when the loop exposes one. */
function lastTurnOf(agent) {
  // The shipped loop keeps two shapes: an idle phase reports `lastTurn`, a running phase reports
  // the open turn as `turn` and has no `lastTurn` at all. Reading only the idle field recorded
  // `null` for every session that was actually mid-turn, so a crash record could never prove
  // which turn was open and its continuation was dropped.
  const phase = agent?.phase
  const value = phase?.kind === 'running' ? phase.turn : phase.lastTurn
  if (Number.isSafeInteger(value)) return value
  return null
}

/**
 * What this runtime can prove about one session's turn boundary.
 *
 * The shipped loop keeps a durable `turnBoundary` projection: `turn/start` sets `openTurnStartSeq`
 * and `lastTurn`, and only `turn/end` clears the open sequence. `lastTurn` therefore does NOT move
 * when a turn finishes normally, which is exactly why comparing counters alone called a finished
 * continuation unfinished after a restart. An idle agent whose projection still has an open turn is
 * a turn the dead process never closed; a closed one is work that ended.
 */
function turnFactsOf(services, sessionId) {
  const agent = agentOf(services, sessionId)
  if (agent === undefined || agent === null) return null
  const running = agent.status === 'running'
  const projections = service(services, 'sessionProjections')
  const session = agent.session
  if (projections !== undefined && projections !== null && typeof projections.stateOf === 'function'
    && session !== undefined && session !== null) {
    try {
      const state = projections.stateOf(session, 'turnBoundary')
      if (state !== null && typeof state === 'object' && Number.isSafeInteger(state.lastTurn)) {
        return {
          lastTurn: state.lastTurn,
          open: state.openTurnStartSeq !== null && state.openTurnStartSeq !== undefined,
          running,
          source: 'projection',
        }
      }
    } catch {
      // A projection this build cannot read proves nothing; fall back to the live phase below.
    }
  }
  return { lastTurn: lastTurnOf(agent), open: running, running, source: 'phase' }
}

/** The reason a turn ended, normalized; `null` when no end was observed. */
function turnEndKind(reason) {
  if (reason === null || typeof reason !== 'object') return null
  return typeof reason.kind === 'string' ? reason.kind : null
}

/**
 * The Harness half of the plugin: what is running now, how to stop it, how to put it back.
 *
 * Restore outcomes are explicit:
 * - `restored`: mounted, and for an interrupted turn a visible continuation message was admitted
 * - `skipped`: nothing to do, or the person already moved on; not a failure and not retried
 * - `attention`: restored as far as allowed, but something cannot be put back (a killed job)
 * - `failed`: this item may work on the next press, so it stays unmarked for retry
 * Nothing here throws for one broken item: the press reports it and the rest proceeds.
 */
export function createProbe(services, options = {}) {
  const graceMs = Number.isFinite(options.graceMs) ? options.graceMs : 1500
  const continueText = typeof options.continueText === 'string' && options.continueText.trim() !== ''
    ? options.continueText
    : '继续'
  // A reload replaces the probe while an old restore is still awaiting a mount. The old probe must
  // stop before its side effects, not after: a sent message cannot be taken back.
  const isCurrent = typeof options.isCurrent === 'function' ? options.isCurrent : () => true
  const reloaded = () => isCurrent() === false
  // A host service that never answers must not pin the press in `pausing`/`resuming` forever:
  // every call that can wait on the Harness is bounded, and the timeout is reported as a real
  // failure so the plan stays retryable instead of silently claiming success.
  const callMs = Number.isFinite(options.callMs) && options.callMs > 0 ? options.callMs : 12000
  const cancelMs = Number.isFinite(options.cancelMs) && options.cancelMs > 0 ? options.cancelMs : 3000
  const maxDiscover = Number.isSafeInteger(options.maxDiscover) && options.maxDiscover >= 0 ? options.maxDiscover : 8
  // A killed process still has to exit. This bound is how long the press is willing to wait for the
  // real terminal status before it reports the job as merely requested.
  const jobExitMs = Number.isFinite(options.jobExitMs) && options.jobExitMs > 0 ? options.jobExitMs : callMs
  // Called with the newly discovered rows before they are stopped, so the engine can persist them
  // first: a session discovered mid-pause must survive this process, not be cancelled and lost.
  const beforeCancel = typeof options.beforeCancel === 'function' ? options.beforeCancel : null
  // The shipped runtime publishes every session event on one dispatch. Turn boundaries are the only
  // honest proof of what a continuation became: `turn/start` says a turn was parsed out of the
  // admitted message, `turn/end` carries the reason it finished. The durable counter alone cannot
  // tell those two apart, which is how a completed turn came back as "still running".
  const watchTurn = typeof options.watchTurn === 'function' ? options.watchTurn : null
  // Called with the admitted request id after the Harness accepted the continuation. The engine
  // persists it before the turn is waited on, so a crash in that gap cannot resend the message and
  // cannot silently drop it either: the row keeps the obligation and says so.
  const onAdmitted = typeof options.onAdmitted === 'function' ? options.onAdmitted : null
  // The durable log is the second source of an end reason. It is only asked when this build ships a
  // reader for it; `false` turns the disk fallback off (a test can then prove the unknown path).
  const sessionLogEnabled = options.sessionLog !== false
  const dshHome = typeof options.dshHome === 'string' && options.dshHome !== ''
    ? options.dshHome
    : typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME !== ''
      ? process.env.DSH_HOME
      : join(homedir(), '.dsh')
  // End reasons this process watched happen. A restore that admitted a message and watched its turn
  // end has the reason in hand; a later restore in the same process must not fall back to `unknown`.
  const watchedTurns = new Map()
  const WATCHED_LIMIT = 64

  /** The ends this process watched for one session, or null when nothing was subscribed yet. */
  function watchedEnds(sessionId) {
    const row = watchedTurns.get(sessionId)
    return row === undefined ? null : row.ends
  }

  /** Subscribe once per session: assessSession is called repeatedly and listeners must not pile up. */
  function observeTurns(sessionId) {
    if (watchTurn === null) return null
    const existing = watchedTurns.get(sessionId)
    if (existing !== undefined) return existing
    const ends = new Map()
    let stop = null
    try {
      stop = watchTurn(sessionId, (event) => {
        const end = endOfEvent(event)
        if (end !== null) ends.set(end.turn, end.kind)
      })
    } catch {
      return null
    }
    const row = { ends, stop: typeof stop === 'function' ? stop : null }
    watchedTurns.set(sessionId, row)
    if (watchedTurns.size > WATCHED_LIMIT) {
      const oldest = watchedTurns.keys().next().value
      if (oldest !== undefined && oldest !== sessionId) {
        const dropped = watchedTurns.get(oldest)
        if (typeof dropped?.stop === 'function') {
          try {
            dropped.stop()
          } catch {
            /* the runtime already dropped it */
          }
        }
        watchedTurns.delete(oldest)
      }
    }
    return row
  }

  /**
   * Does this session still owe a continuation, and can that be proven?
   *
   * Only the official end reason decides. A turn number that grew proves a turn ran, never that the
   * owed work came back; a projection that closed proves a boundary, not its reason. So the evidence
   * order is: an end this process watched, then the official log reader, then the disk tail of the
   * persisted JSONL log. Anything that cannot produce a reason answers `unknown` — no evidence is
   * never allowed to become `skip`.
   */
  async function assessSession(session, { plan } = {}) {
    const sessionId = typeof session?.sessionId === 'string' && session.sessionId !== '' ? session.sessionId : null
    const agent = sessionId === null ? undefined : agentOf(services, sessionId)
    const mounted = agent !== undefined && agent !== null
    if (sessionId === null) {
      return { action: 'unknown', turn: null, end: null, admitted: false, mounted, detail: 'no session to assess' }
    }
    observeTurns(sessionId)
    const epoch = Number.isSafeInteger(session?.epoch) && session.epoch >= 0 ? session.epoch : Number.isSafeInteger(plan?.epoch) ? plan.epoch : 0
    const admittedEpoch = Number.isSafeInteger(session?.admittedEpoch) ? session.admittedEpoch : null
    const admittedRequest = typeof session?.admittedRequest === 'string' && session.admittedRequest !== '' ? session.admittedRequest : null
    // An admission from an older cycle was consumed by the turn it started; only this cycle's record
    // means the queue may still hold the message.
    const admitted = admittedRequest !== null && (admittedEpoch === null ? epoch === 0 : admittedEpoch === epoch)
    // The projection, not the counter: an open turn is the only honest reading of work in flight.
    const facts = turnFactsOf(services, sessionId)
    const open = facts !== null && facts.open === true
    const running = agent?.status === 'running'

    let observed = null
    const watched = watchedEnds(sessionId)
    if (watched !== null && watched.size > 0) {
      for (const [turn, kind] of watched) if (observed === null || turn > observed.turn) observed = { turn, kind }
    }
    if (observed === null && sessionLogEnabled) {
      const reader = service(services, 'sessionLog')
      if (reader !== null && reader !== undefined && typeof reader.readTurnEnds === 'function') {
        try {
          const rows = await reader.readTurnEnds(sessionId)
          if (Array.isArray(rows)) {
            for (const row of rows) {
              const turn = Number.isSafeInteger(row?.turn) ? row.turn : null
              const kind = typeof row?.kind === 'string' ? row.kind : null
              if (turn !== null && kind !== null && END_KINDS.has(kind) && (observed === null || turn > observed.turn)) {
                observed = { turn, kind }
              }
            }
          }
        } catch {
          /* the reader failed; the disk tail is still a source */
        }
      }
    }
    if (observed === null) {
      // Only a real persisted session id can name a log directory; a short synthetic id from a test
      // (or an older plan) must not turn into a scan of the machine's whole sessions tree.
      const durableId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}/i.test(sessionId.replace(/^session-/, ''))
      if (durableId) {
        try {
          const file = await findSessionLog(dshHome, sessionId)
          const ends = file === null ? null : await readLogTail(file)
          if (Array.isArray(ends)) {
            for (const end of ends) {
              if (end !== null && END_KINDS.has(end.kind) && (observed === null || end.turn > observed.turn)) observed = end
            }
          }
        } catch {
          /* no readable log */
        }
      }
    }

    const turn = observed !== null ? observed.turn : facts !== null ? facts.lastTurn : null
    // Queue evidence, when this build exposes it. A plan record is durable and the queue is live;
    // their disagreement is reported instead of silently trusting either one.
    let queued = null
    if (admitted && admittedRequest !== null) {
      const queue = service(services, 'sessionQueue')
      if (queue !== null && queue !== undefined && typeof queue.has === 'function') {
        try {
          const has = queue.has(sessionId, admittedRequest)
          if (has === true || has === false) queued = has
        } catch {
          /* this build has no queue evidence */
        }
      }
    }
    const queueNote = queued === null ? '' : queued === true ? '; message still queued' : '; message no longer queued'
    if (observed !== null && observed.kind === 'completed') {
      return { action: 'skip', turn, end: 'completed', admitted, mounted, detail: 'the turn completed before this restore' }
    }
    if (admitted && (open || running)) {
      return { action: 'continue', turn, end: 'open', admitted: true, mounted, detail: `already admitted in this cycle; its turn is open${queueNote}` }
    }
    if (admitted) {
      return { action: 'continue', turn, end: observed?.kind ?? null, admitted: true, mounted, detail: `already admitted in this cycle${queueNote}` }
    }
    if (observed === null) {
      if (open || running) {
        return { action: 'continue', turn, end: 'open', admitted: false, mounted, detail: 'a turn is open; the press did not end it' }
      }
      return { action: 'unknown', turn: null, end: null, admitted: false, mounted, detail: 'no turn end record; refusing to guess' }
    }
    if (observed.kind === 'interrupted') {
      // A crash-backfilled `interrupted` is not a completion: the obligation to continue survives.
      return { action: 'continue', turn, end: 'interrupted', admitted: false, mounted, detail: 'the turn was interrupted; a continuation is owed' }
    }
    return { action: 'unknown', turn, end: observed.kind, admitted: false, mounted, detail: `the turn ended as ${observed.kind}; needs a look` }
  }

  /** Poll the job record for a real terminal status; `wait()` also resolves on a timeout. */
  async function waitJobExit(services_, job, budget) {
    const jobs = service(services_, 'jobs')
    if (jobs === undefined || jobs === null) return 'unreadable'
    const read = () => {
      try {
        if (typeof jobs.get === 'function') {
          const view = job.owner === null || job.owner === undefined ? jobs.get(job.id) : jobs.get(job.id, job.owner)
          if (view !== undefined && view !== null && typeof view.status === 'string') return view.status
        }
        const listed = listJobs(services_, job.owner === null || job.owner === undefined ? [] : [job.owner])
        const found = listed.find((row) => row.id === job.id)
        return typeof found?.status === 'string' ? found.status : null
      } catch (error) {
        if (/belongs to another session/i.test(String(error?.message ?? error))) return 'foreign'
        return null
      }
    }
    const deadline = Date.now() + budget
    for (;;) {
      const status = read()
      if (status === 'foreign') return 'foreign'
      if (status !== null && (status === 'completed' || status === 'killed' || status === 'failed')) return 'terminal'
      if (Date.now() >= deadline) return status ?? 'unreadable'
      await new Promise((resolve) => setTimeout(resolve, 80))
    }
  }

  /** The parent of a live child, from its header or from runtime ownership. */
  function sessionParent(services_, sessionId) {
    const agent = agentOf(services_, sessionId)
    if (agent !== undefined) {
      const header = agent?.session?.header
      if (typeof header?.parentSession === 'string' && header.parentSession !== '') return header.parentSession
    }
    const agents = agentsOf(services_)
    if (agents === undefined) return null
    const child = agent ?? { id: sessionId }
    return parentOf(services_, agents, child)
  }

  /**
   * Bound a Harness call without losing the answer. A call that overruns any fixed budget is
   * reported as a timeout, but the original work keeps running and stays observed, so the caller can
   * reconcile: a cold attach of a large session set legitimately outlives the budget and would
   * otherwise be recorded as a failure that never happened.
   */
  function boundedWork(work, ms, label) {
    let state = null
    const started = Promise.resolve().then(work)
    started.then(
      (value) => { state = { ok: true, value } },
      (error) => { state = { ok: false, error } },
    )
    let timer = null
    const timeout = new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out`)), ms)
      if (typeof timer?.unref === 'function') timer.unref()
    })
    const race = Promise.race([started, timeout]).finally(() => {
      if (timer !== null) clearTimeout(timer)
    })
    return {
      race,
      /** The settled outcome, or null when the call is still running. */
      outcome: () => state,
      /** Wait up to `waitMs` for the original call; null when it is still running. */
      async late(waitMs) {
        const deadline = Date.now() + waitMs
        while (state === null && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 40))
        return state
      },
    }
  }

  function bounded(work, ms, label) {
    return boundedWork(work, ms, label).race
  }

  // What this press already asked to stop, keyed by job id. A job that was still `stopping` when the
  // budget ran out, or whose kill was refused, must not vanish from the evidence the next boot reads:
  // the outcome is a handoff obligation, not a detail to drop.
  const jobEvidence = new Map()
  // A maintenance compaction is not a turn and must not become a resume row. It stays in its own
  // list so a press can cancel it without pretending a turn was interrupted.
  const MAINTENANCE = 'maintenance'

  /** The official record for one job, or null when the service no longer lists it. */
  function jobRecord(id) {
    const rows = [listJobs(services)]
    for (const agent of agentsOf(services) ?? []) rows.push(listJobs(services, [agent.id]))
    for (const list of rows) {
      for (const job of list) if (job?.id === id) return job
    }
    return null
  }

  /** Everything this press can stop, read from the live registry only. */
  function live() {
    const agents = agentsOf(services)
    const sessions = []
    const goals = []
    const jobs = []
    const maintenance = []
    if (agents === undefined) {
      // The registry is unreadable: report no work rather than claiming a state the button cannot see.
      return { sessions, goals, jobs, maintenance, readable: false, source: 'none' }
    }
    const unowned = listJobs(services)
    for (const job of unowned) if (RUNNING_JOB.has(job.status)) jobs.push({ id: job.id, owner: null, status: job.status })
    for (const agent of agents) {
      const goal = goalView(services, agent)
      const owned = listJobs(services, [agent.id])
      // A subagent child is not reachable through the Session API (the header says its routing
      // owns it), so the capture has to remember which parent can address it later. The header is
      // the durable lineage; runtime ownership is only a fallback for a row without one.
      const header = agent?.session?.header
      const lineage = typeof header?.parentSession === 'string' && header.parentSession !== '' ? header.parentSession : parentOf(services, agents, agent)
      const maintaining = agent?.phase?.kind === 'maintenance'
      if (maintaining) {
        // Never captured as a session: cancelling the compaction must not write a row that a resume
        // later tries to continue. The phase kind is the only proof, not the public status.
        maintenance.push({ sessionId: agent.id })
      } else {
        sessions.push({
          sessionId: agent.id,
          running: agent.status === 'running',
          lastTurn: lastTurnOf(agent),
          parent: lineage,
          origin: header?.origin === 'subagent' || lineage !== null ? 'subagent' : 'root',
        })
      }
      // A disarmed goal is not work: it will not start a round, and pausing it would throw. Only an
      // active, armed goal is something this press can stop and this restore can re-arm.
      if (goal !== undefined && goal !== null && goal.unreadable !== true && goal.phase === 'active' && goal.activation === 'armed') {
        goals.push({ sessionId: agent.id, goalId: goal.id, revision: goal.revision })
      }
      for (const job of owned) if (RUNNING_JOB.has(job.status)) jobs.push({ id: job.id, owner: agent.id, status: job.status })
    }
    // A settlement after the pause is recorded here, never delivered as a message: waking the owner
    // would restart the work the press just stopped. The row stays for the resume handoff.
    for (const row of jobEvidence.values()) {
      if (row.status === 'stopping') {
        const known = jobRecord(row.id)
        const status = known === null ? null : String(known.status ?? '')
        if (status === null || status === 'settled' || status === 'stopped' || status === 'removed') {
          row.status = 'stopped'
          row.detail = status === null ? 'settled after the pause' : `settled after the pause (${status})`
        } else {
          row.detail = `still ${status}`
        }
      }
      jobs.push({ ...row })
    }
    // Evidence recorded by the press is the later, more specific row for the same job id: it must
    // replace the live snapshot instead of being shadowed by it.
    const unique = new Map()
    for (const job of jobs) unique.set(job.id, job)
    return { sessions, goals, jobs: [...unique.values()], maintenance, readable: true, source: 'live' }
  }

  /**
   * Stop the captured work: disarm goals first so no round is queued behind the press, then end
   * the open turns, then kill the jobs. The returned goal entries carry the revision produced by
   * `pause`, which is what a later `resume` must prove.
   */
  async function stop(current, { graceMs: grace, onDiscover = null } = {}) {
    const controller = service(services, 'sessionController')
    const goals = service(services, 'goals')
    const jobs = service(services, 'jobs')
    const canceled = []
    const unknown = []
    const pausedGoals = []
    const goalErrors = []
    const killedJobs = []
    const jobErrors = []
    // One row per job this press tried to stop. The list is the evidence a plan keeps: `stopping`
    // means the stop was requested and the process had not settled inside the budget, while
    // `stop-failed` and `unknown` say the press never got as far as a request it could trust.
    const jobStates = []
    // A maintenance compaction is stopped through the same official cancel entry, but it is reported
    // apart: it is not a turn, so cancelling it must not write a resume row.
    const maintenanceCanceled = []
    const maintenanceErrors = []
    const canCancel = controller !== undefined && controller !== null && typeof controller.cancel === 'function'
    const canKill = jobs !== undefined && jobs !== null && typeof jobs.kill === 'function'
    // A reload hands this plan to a new instance. Cancelling here afterwards would stop work that
    // instance captured in the meantime, so the stop ends at the first sign of reload and reports
    // it instead of pretending to be a clean pause.
    let stale = reloaded()

    for (const goal of (stale ? [] : current.goals ?? [])) {
      const agent = agentOf(services, goal.sessionId)
      if (agent === undefined) continue
      if (goals === undefined || goals === null || typeof goals.pause !== 'function') {
        goalErrors.push(`goal ${goal.goalId}: goal service unavailable`)
        continue
      }
      try {
        const view = goals.pause(agent, { id: goal.goalId, revision: goal.revision })
        pausedGoals.push({ sessionId: goal.sessionId, goalId: view?.id ?? goal.goalId, pausedRevision: view?.revision ?? goal.revision + 1 })
      } catch (error) {
        goalErrors.push(`goal ${goal.goalId}: ${String(error?.message ?? error).slice(0, 80)}`)
      }
    }

    // A maintenance compaction keeps the agent `idle` while it writes; the public status cannot see
    // it. `phase.kind` can, so it is cancelled here, and an unavailable entry is reported as unknown
    // instead of leaving a write running behind a clean-looking pause.
    if (stale === false) {
      for (const agent of agentsOf(services) ?? []) {
        if (agent?.phase?.kind !== MAINTENANCE) continue
        if (typeof canCancel === 'boolean' && canCancel === false) {
          maintenanceErrors.push({ sessionId: agent.id, detail: 'cancel unavailable' })
          continue
        }
        try {
          await bounded(() => controller.cancel({ sessionId: agent.id }), cancelMs, 'maintenance cancel')
          maintenanceCanceled.push(agent.id)
        } catch (error) {
          maintenanceErrors.push({ sessionId: agent.id, detail: String(error?.message ?? error).slice(0, 80) })
        }
      }
    }

    // Every open turn is asked to stop in parallel, so the grace period measures one round trip.
    // A missing service is a real failure, not a quiet success: claiming `canceled` without an
    // API to cancel with would make a partial pause look clean.
    const subagents = service(services, 'subagents')
    const canInterrupt = subagents !== undefined && subagents !== null && typeof subagents.interrupt === 'function'
    /**
     * Stop one turn. A child session is refused by the Session API by design ("owned by subagent
     * routing"), so it is stopped through the parent-scoped `interrupt`, which for a local child is
     * a clean pause: the Agent, session and Activation stay, and a later delivery wakes it.
     */
    const cancelOne = async (sessionId, parent) => {
      if (reloaded()) {
        stale = true
        return
      }
      if (typeof parent === 'string' && parent !== '') {
        if (canInterrupt === false) {
          unknown.push(`session ${sessionId}: subagent interrupt unavailable`)
          return
        }
        try {
          await bounded(() => subagents.interrupt(sessionId, { kind: 'user', parentSessionId: parent }), cancelMs, 'interrupt')
          if (canceled.includes(sessionId) === false) canceled.push(sessionId)
        } catch (error) {
          unknown.push(`session ${sessionId}: ${String(error?.message ?? error).slice(0, 80)}`)
        }
        return
      }
      if (canCancel === false) {
        unknown.push(`session ${sessionId}: cancel unavailable`)
        return
      }
      try {
        await bounded(() => controller.cancel({ sessionId }), cancelMs, 'cancel')
        if (canceled.includes(sessionId) === false) canceled.push(sessionId)
      } catch (error) {
        const detail = String(error?.message ?? error)
        // The header may not have been readable during capture. Retry the child's own route rather
        // than reporting a permanent failure for work a pause can still stop.
        if (/owned by subagent routing/i.test(detail) && canInterrupt === true) {
          const owner = sessionParent(services, sessionId)
          if (owner !== null) {
            try {
              await bounded(() => subagents.interrupt(sessionId, { kind: 'user', parentSessionId: owner }), cancelMs, 'interrupt')
              if (canceled.includes(sessionId) === false) canceled.push(sessionId)
              return
            } catch (retry) {
              unknown.push(`session ${sessionId}: ${String(retry?.message ?? retry).slice(0, 80)}`)
              return
            }
          }
        }
        unknown.push(`session ${sessionId}: ${detail.slice(0, 80)}`)
      }
    }

    const stopping = (current.sessions ?? []).filter((session) => session.running === true)
    const asked = new Set(stopping.map((session) => session.sessionId))
    const parents = new Map()
    for (const session of current.sessions ?? []) {
      if (typeof session?.sessionId === 'string') parents.set(session.sessionId, typeof session.parent === 'string' ? session.parent : null)
    }
    const discovered = []
    if (stale === false) await Promise.all(stopping.map((session) => cancelOne(session.sessionId, session.parent)))
    if (reloaded()) stale = true

    for (const job of (stale ? [] : current.jobs ?? [])) {
      const owner = job.owner ?? null
      if (canKill === false) {
        jobErrors.push(`job ${job.id}: job service unavailable`)
        jobStates.push({ id: job.id, owner, status: 'unknown', detail: 'job service unavailable' })
        continue
      }
      try {
        if (owner === null) jobs.kill(job.id)
        else jobs.kill(job.id, owner)
      } catch (error) {
        const detail = String(error?.message ?? error).slice(0, 80)
        jobErrors.push(`job ${job.id}: ${detail}`)
        jobStates.push({ id: job.id, owner, status: 'stop-failed', detail })
        continue
      }
      // `kill` only requests the stop: the process is still alive until the job settles. Reporting
      // the request as a kill would let a plan claim a clean pause while a shell kept writing.
      const settled = await waitJobExit(services, job, Math.min(grace ?? graceMs, jobExitMs))
      if (settled === 'terminal') {
        killedJobs.push({ id: job.id, owner })
        jobStates.push({ id: job.id, owner, status: 'stopped' })
      } else if (settled === 'foreign') {
        jobErrors.push(`job ${job.id}: owned by another session`)
        jobStates.push({ id: job.id, owner, status: 'stop-failed', detail: 'owned by another session' })
      } else {
        jobErrors.push(`job ${job.id}: stop requested, still ${settled}`)
        jobStates.push({ id: job.id, owner, status: 'stopping', detail: `still ${settled}` })
      }
    }

    // Keep the rows after the press ends. A `stopping` or `stop-failed` job is an obligation the
    // resume handoff must carry; `live()` reads the official record again and records a settlement
    // without waking the owner.
    for (const row of jobStates) jobEvidence.set(row.id, { ...row })

    // A turn ends when its tools return: the press waits a bounded moment for that instead of
    // claiming a stop that has not happened yet. A turn that starts after the capture is new work:
    // it is stopped too (bounded), because a pause that leaves it running is not a pause. Whatever
    // still starts after the discovery budget is reported, never hidden behind `paused`.
    const deadline = Date.now() + (grace ?? graceMs)
    let pending = stopping.map((session) => session.sessionId)
    let discoveredCount = 0
    let recancelAt = Date.now() + 150
    while (stale === false && reloaded() === false && Date.now() < deadline) {
      const stillRunning = new Set(listRunning(services))
      pending = pending.filter((id) => stillRunning.has(id))
      const fresh = [...stillRunning].filter((id) => asked.has(id) === false)
      if (fresh.length === 0) {
        if (pending.length === 0) break
        // A turn parked behind a tool can shrug off one cancel. Retrying the same ids on a slow beat
        // is what stops a pause from reporting four sessions that are plainly still running.
        if (Date.now() >= recancelAt) {
          recancelAt = Date.now() + 250
          await Promise.all(pending.map((id) => cancelOne(id, parents.get(id) ?? null)))
        }
        await new Promise((resolve) => setTimeout(resolve, 60))
        continue
      }
      if (discoveredCount + fresh.length > maxDiscover) break
      discoveredCount += fresh.length
      const freshRows = []
      for (const id of fresh) {
        asked.add(id)
        const agent = agentOf(services, id)
        const parent = sessionParent(services, id)
        parents.set(id, parent)
        freshRows.push({ sessionId: id, lastTurn: agent === undefined ? null : lastTurnOf(agent), parent, origin: parent === null ? 'root' : 'subagent' })
      }
      // Persist before stopping: the person must not lose a session because it appeared between the
      // capture and the stop. The engine merges these rows into the plan (or fails the pause here,
      // leaving the new session untouched).
      const admit = typeof onDiscover === 'function' ? onDiscover : beforeCancel
      if (admit !== null) {
        try {
          const admitted = await admit(freshRows)
          if (admitted === false) {
            // The plan could not be written, so these sessions are left running rather than cancelled
            // and forgotten: the pause reports that it could not cover them.
            unknown.push('discovered: cannot hold newly found sessions in the plan')
            break
          }
        } catch (error) {
          unknown.push(`discovered: ${String(error?.message ?? error).slice(0, 80)}`)
          break
        }
      }
      discovered.push(...freshRows)
      await Promise.all(freshRows.map((row) => cancelOne(row.sessionId, row.parent)))
      pending = [...new Set([...pending, ...fresh])]
      await new Promise((resolve) => setTimeout(resolve, 60))
    }

    if (reloaded()) {
      // Reading the harness from here would report facts the next instance already owns, and its
      // own capture decides what that plan contains. This process ends its stop with no rows.
      return { canceled: [], unknown: [], pausedGoals: [], goalErrors: [], killedJobs: [], jobErrors: [], jobStates: [], maintenanceCanceled: [], maintenanceErrors: [], jobHandoff: [], stillRunning: [], sessions: [], discovered: [], reloaded: true }
    }

    const runningAtEnd = new Set(listRunning(services))
    const stillRunning = [...asked].filter((id) => runningAtEnd.has(id))
    for (const id of runningAtEnd) {
      if (asked.has(id) === true) continue
      stillRunning.push(id)
      unknown.push(`session ${id}: started while pausing`)
    }
    for (const id of stillRunning) {
      if (unknown.some((line) => line.startsWith(`session ${id}: still running`)) === false) unknown.push(`session ${id}: still running`)
    }

    // The turn counter is only readable once the turn is over: a running phase carries the turn it
    // is in, not the last finished one. Recording it now is what lets a restore tell "the press
    // stopped turn 4" from "the person ran turn 5 while paused".
    if (reloaded()) stale = true
    const rows = [...stopping, ...discovered]
    const sessions = []
    const seen = new Set()
    for (const session of rows) {
      if (seen.has(session.sessionId)) continue
      seen.add(session.sessionId)
      const agent = agentOf(services, session.sessionId)
      const parent = parents.get(session.sessionId) ?? (typeof session.parent === 'string' ? session.parent : null)
      sessions.push({
        sessionId: session.sessionId,
        lastTurn: agent === undefined ? null : lastTurnOf(agent),
        parent,
        origin: parent === null ? 'root' : 'subagent',
      })

    }

    // What the next boot still owes: jobs the press could not finish stopping. A plan made only of
    // jobs has no turn to continue, so the handoff obligation is the whole restore result.
    const jobHandoff = jobStates.filter((row) => row.status !== 'stopped')
    return { canceled, unknown, pausedGoals, goalErrors, killedJobs, jobErrors, jobStates, maintenanceCanceled, maintenanceErrors, jobHandoff, stillRunning, sessions, discovered, reloaded: stale }
  }

  /** The continuation message: a real user message, so the session history shows why it moved. */
  function continuation(plan, sessionId, epoch, retry) {
    // The epoch is the pause cycle. A retry of the same pause reuses the id (official dedupe keeps
    // admission idempotent), while a new pause after a partial restore gets a fresh one, so the
    // earlier admitted message cannot swallow this cycle's continuation.
    const cycle = Number.isSafeInteger(epoch) && epoch >= 0 ? epoch : 1
    // Cycle 0 is a pre-epoch plan: keep the exact id that may already sit in the official queue,
    // so upgrading the plugin cannot duplicate a continuation the old version admitted.
    // A retry after a failed attempt gets its own id: the official prompt dedupe answers
    // `{ accepted: true }` for an id it already holds without ever waking the session, so reusing it
    // would turn a retry into a silent no-op that looks like "admitted, no turn started".
    const attempt = Number.isSafeInteger(retry) && retry > 0 ? retry : 0
    const base = cycle === 0
      ? `${plan.planId}:continue:${sessionId}`
      : `${plan.planId}:continue:${sessionId}:${cycle}`
    const requestId = attempt === 0 ? base : `${base}.r${attempt}`
    // A pause kills background jobs, and a job can only be started from the closure that produced
    // it, so a restart cannot re-launch one. Saying which jobs this pause stopped is what lets the
    // continued turn put the work back on its own feet instead of assuming it is still running.
    // Only a job the press recorded as `stopped` is gone. A `stopping` job is still winding down,
    // and `stop-failed`/`unknown` (or a row with no status yet) may still be running: telling the
    // continued turn the work was stopped would make it assume a silence that never happened.
    const owned = (Array.isArray(plan?.jobs) ? plan.jobs : [])
      .filter((job) => job !== null && typeof job === 'object' && job.owner === sessionId)
    const idsOf = (rows) => rows.map((job) => String(job.id)).join('、')
    // A plan written before this round carries no per-job status. Such rows only ever listed the
    // jobs the pause killed, so they keep the old wording; once a status exists it is the only say.
    const intact = (job) => job.status === undefined || job.status === null
    const stopped = owned.filter((job) => job.status === 'stopped' || intact(job))
    const stopping = owned.filter((job) => job.status === 'stopping')
    const running = owned.filter((job) => job.status !== 'stopped' && job.status !== 'stopping' && !intact(job))
    const clauses = []
    if (stopped.length > 0) clauses.push(`暂停时停止了后台任务 ${idsOf(stopped)}；还需要的话请重新启动`)
    if (stopping.length > 0) clauses.push(`后台任务 ${idsOf(stopping)} 正在停止，继续前请先检查`)
    if (running.length > 0) clauses.push(`后台任务 ${idsOf(running)} 仍可能运行，请先检查`)
    const text = clauses.length === 0 ? continueText : `${continueText}（${clauses.join('；')}）`
    return {
      sessionId,
      requestId,
      content: [{ type: 'text', text }],
      // `queue` is the shipped public mode: deliver after the current turn, start one when idle.
      mode: 'queue',
    }
  }

  /** The official resume shape: an Agent, `{ agent }`, or `{ error }`. */
  function unwrapResolved(resolved) {
    if (resolved !== null && typeof resolved === 'object' && 'error' in resolved) throw resolved.error
    return resolved !== null && typeof resolved === 'object' && 'agent' in resolved ? resolved.agent : resolved
  }

  /**
   * Mount one session through the public resume path, which restores preset and model selection.
   * A budget overrun is treated as an unproven outcome, never as a failed resume: the late settle and
   * the live registry both get a grace window, because a cold attach of a large session set can
   * outlive any fixed budget while still succeeding.
   */
  async function mount(sessionId, budgetMs) {
    const budget = Number.isFinite(budgetMs) && budgetMs > callMs ? budgetMs : callMs
    const controller = service(services, 'sessionController')
    if (controller !== undefined && controller !== null && typeof controller.resolveAgent === 'function') {
      const attempt = boundedWork(() => controller.resolveAgent(sessionId), budget, 'resume')
      let resolved
      try {
        resolved = await attempt.race
      } catch (error) {
        const late = await attempt.late(Math.max(graceMs * 2, Math.min(budget, 20000)))
        if (late !== null && late.ok === false) throw late.error
        const raw = late !== null && late.ok === true ? late.value : undefined
        let agent = null
        try {
          agent = raw === undefined ? agentOf(services, sessionId) : unwrapResolved(raw)
        } catch (lateError) {
          if (/timed out/i.test(String(error?.message ?? error)) === false) throw lateError
          agent = agentOf(services, sessionId)
        }
        if (agent !== undefined && agent !== null && typeof agent.id === 'string') return agent
        // Still attaching after the grace window: report the timeout so the row stays retryable.
        throw error
      }
      const agent = unwrapResolved(resolved)
      if (agent === undefined || agent === null || typeof agent.id !== 'string') throw new Error('resume returned no agent')
      return agent
    }
    const agents = service(services, 'agents')
    if (agents === undefined || agents === null || typeof agents.resume !== 'function') throw new Error('agents unavailable')
    await bounded(() => agents.resume({ resumeSessionId: sessionId }), budget, 'resume')
    const mounted = agentOf(services, sessionId)
    if (mounted === undefined) throw new Error('session did not attach')
    return mounted
  }

  /**
   * Wake a stopped child through its parent. The Session API refuses a subagent-owned session by
   * design, so the only lossless route is `subagents.prompt`: the same durable child id resumes,
   * and the parent must already be live because the delivery is scoped to its Activation.
   */
  /**
   * A restore that worked, with the turn it observed only when there is one. The turn is the proof a
   * later boot compares against, and an absent turn must stay absent instead of becoming a `null`
   * field that reads like evidence.
   */
  function outcomeOf(detail, continued, turn, turnEnd = null) {
    const row = { status: 'restored', detail, continued }
    if (Number.isSafeInteger(turn)) row.turn = turn
    // What the runtime said when this turn ended. A later boot can then tell a finished
    // continuation from one whose end was never observed.
    if (typeof turnEnd === 'string' && turnEnd !== '') row.turnEnd = turnEnd
    return row
  }

  async function restoreChild(session, { plan, signal = null, isCancelled = null } = {}) {
    const { sessionId } = session
    const cancelled = () => signal?.aborted === true || (typeof isCancelled === 'function' && isCancelled() === true)
    if (cancelled()) return { status: 'interrupted', detail: 'restore stopped', continued: false }
    const parent = typeof session.parent === 'string' && session.parent !== '' ? session.parent : sessionParent(services, sessionId)
    if (parent === null) return { status: 'failed', detail: 'subagent has no known parent', continued: false }
    const subagents = service(services, 'subagents')
    if (subagents === undefined || subagents === null || typeof subagents.prompt !== 'function') {
      return { status: 'failed', detail: 'subagents unavailable', continued: false }
    }
    if (agentOf(services, parent) === undefined) {
      // The parent's turn owns the routing. Its row restores first in the same wave order, so a short
      // wait covers a parent still attaching; failing that the row stays retryable instead of
      // closing as `attention`, which is how a child was dropped after one early attempt.
      await waitForAgent(parent, Math.max(Number.isFinite(options.settleMs) ? options.settleMs : 1200, 3000))
      if (cancelled()) return { status: 'interrupted', detail: 'restore stopped', continued: false }
      if (agentOf(services, parent) === undefined) {
        return { status: 'failed', detail: 'parent is not live yet', continued: false }
      }
    }
    const mode = session.mode === 'one-shot' ? 'one-shot' : 'continuable'
    if (mode === 'one-shot') {
      // A one-shot child has no cold resume. Reporting it as blocked is honest: the parent's next
      // delegation creates a fresh child, and this row must not claim the old one came back.
      return { status: 'attention', detail: 'one-shot child cannot resume', continued: false }
    }
    // Before a child queue message is sent, the official end reason decides whether one is owed. The
    // subagent service has no request-id dedupe of its own: re-sending an admitted continuation is a
    // real duplicate, so a completed turn or this cycle's admission is answered without a prompt.
    const assessment = await assessSession(session, { plan })
    if (assessment.action === 'skip') {
      return { status: 'skipped', detail: 'turn completed before this restart', continued: false }
    }
    if (assessment.admitted === true) {
      return { status: 'restored', detail: 'already admitted (admitted before this restart)', continued: true, turn: assessment.turn ?? undefined }
    }
    if (reloaded()) return { status: 'reloaded' }
    const request = continuation(plan, sessionId, session.epoch, session.retry)
    if (cancelled()) return { status: 'interrupted', detail: 'restore stopped', continued: false }
    try {
      await bounded(() => subagents.prompt({
        parentSessionId: parent,
        childSessionId: sessionId,
        mode: 'continuable',
        delivery: 'queue',
        requestId: request.requestId,
        content: request.content,
      }, signal ?? new AbortController().signal), callMs, 'subagent prompt')
    } catch (error) {
      return { status: 'failed', detail: String(error?.message ?? error).slice(0, 120), continued: false }
    }
    if (cancelled()) return { status: 'interrupted', detail: 'restore stopped after admission', continued: false }
    if (onAdmitted !== null && onAdmitted(sessionId, request.requestId) === false) {
      return { status: 'unknown', detail: 'child continuation admitted but its record could not be saved', continued: false }
    }
    const started = await waitForTurn(sessionId, Number.isSafeInteger(session.lastTurn) ? session.lastTurn : null, options.settleMs)
    if (started.started) {
      const kind = started.ended ? turnEndKind(started.reason) : null
      if (kind === 'aborted') return { status: 'interrupted', detail: 'child continuation was aborted', continued: false }
      if (kind === 'error' || kind === 'blocked') {
        return { status: 'attention', detail: `child continuation ended: ${kind}`, continued: true, turn: started.turn }
      }
      return { status: 'restored', detail: 'child continued', continued: true, turn: started.turn, turnEnd: started.ended ? kind ?? 'unobserved' : 'running' }
    }
    // Admitted but never parsed into a turn: the obligation is still owed, so this row stays in the
    // plan instead of being closed as a terminal attention item.
    return { status: 'unknown', detail: 'child continuation admitted, no turn started', continued: false }
  }

  /**
   * Put one session back. A session whose turn was stopped by the press gets its continuation
   * admitted; a session that only carried a goal is mounted and left to the goal driver.
   */
  async function restoreSession(session, { plan, budgetMs, signal = null, isCancelled = null } = {}) {
    if (session === null || typeof session?.sessionId !== 'string') return { status: 'skipped', detail: 'no session' }
    const { sessionId } = session
    const cancelled = () => signal?.aborted === true || (typeof isCancelled === 'function' && isCancelled() === true)
    const call = signal ?? new AbortController().signal
    if (session.origin === 'subagent' || (typeof session.parent === 'string' && session.parent !== '')) {
      return restoreChild(session, { plan, signal: call, isCancelled })
    }
    if (cancelled()) return { status: 'interrupted', detail: 'restore stopped', continued: false }
    // Version 2 plans carry only `running`; a normalized version 3 plan carries `intent`. Reading
    // the old field here keeps a plan written by 0.3.0 working across the upgrade.
    const intent = session.intent === undefined && session.running === true ? 'continue' : session.intent
    // A turn the dead process provably finished owes nothing. Attaching it anyway would be an
    // execution the plan never asked for, so this verdict is returned before any mount happens.
    if (intent === 'skip') {
      return { status: 'skipped', detail: 'turn ended before the restart', continued: false }
    }
    let agent = agentOf(services, sessionId)
    const mounted = agent !== undefined
    if (agent === undefined) {
      try {
        agent = await mount(sessionId, budgetMs)
      } catch (error) {
        const detail = String(error?.message ?? error).slice(0, 120)
        // A child whose header was unreadable during capture lands here. It is retryable through its
        // parent, so it must stay in the plan and keep its entry instead of being dropped as done.
        if (/owned by subagent routing/i.test(detail)) {
          return { status: 'attention', detail: 'subagent session; parent route unavailable', continued: false }
        }
        return { status: 'failed', detail }
      }
    }
    if (reloaded()) return { status: 'reloaded' }
    if (cancelled()) return { status: 'interrupted', detail: 'restore stopped', continued: false }

    if (intent === 'unknown') {
      // The crash record could not prove which turn was open, and this process cannot prove it
      // either. The attach above is how a person inspects it; no continuation is sent and the row
      // stays in the plan, because no evidence is not the same as nothing to do.
      return { status: 'unknown', detail: 'turn state unknown; open the session to decide', continued: false }
    }
    if (intent !== 'continue') {
      return outcomeOf(mounted ? 'mounted' : 'attached', false, lastTurnOf(agent))
    }

    // Ask the official end reason before admitting a continuation. A turn that completed is skipped
    // without a prompt — the counter and the projection boundary are not allowed to decide that on
    // their own. Everything else falls through to the structural checks below, which can still prove
    // closure from an admission record the project itself wrote.
    const assessment = await assessSession(session, { plan })
    if (assessment.action === 'skip') {
      return { status: 'skipped', detail: 'turn completed before this restart', continued: false }
    }

    // A turn that is already open is not evidence the continuation arrived, but it is work in
    // progress: starting a second one would be a duplicate. A turn that advanced and then ended is
    // different: it may have been the continuation, or it may have been interrupted after the
    // request was admitted. Neither case allows resending, and neither may be reported as a clean
    // `skipped` with no attention.
    const capturedTurn = Number.isSafeInteger(session.lastTurn) ? session.lastTurn : null
    // What this plan itself already admitted. After a crash in the middle of a restore, the turn the
    // restore started is the new baseline: comparing against the pre-pause turn reported a restore
    // that had actually run as "turn advanced after the pause".
    const admittedTurn = Number.isSafeInteger(session.continuedTurn) ? session.continuedTurn : null
    // What the runtime records about the boundary, not just how far the counter got: `lastTurn` stops
    // moving when a turn ends, so only the projection can say the turn is closed.
    const facts = turnFactsOf(services, sessionId)
    const turnBefore = facts === null ? lastTurnOf(agent) : facts.lastTurn
    // Only the durable projection can prove a turn ended; the live phase of an idle agent says
    // nothing about the turn before it, and treating that silence as closure would skip owed work.
    const closed = facts !== null && facts.source === 'projection' && facts.open === false && facts.running === false
    // A plan captured mid-turn carries no turn number. The turn the session shows now is then the
    // only honest baseline: an advance past it can only be work this restore started.
    const baseline = admittedTurn ?? capturedTurn ?? turnBefore
    if (agent.status === 'running') {
      // A turn is open right now in this process: the work this plan owes is running, so it is
      // restored, not skipped and not a reason to send the same continuation twice. An open
      // projection is not that proof: after a crash it is residue of a dead process, and treating
      // it as live work is what left a whole crashed set "already running" and never continued.
      return outcomeOf('already running', true, turnBefore, 'running')
    }
    if (admittedTurn !== null && turnBefore !== null && turnBefore === admittedTurn) {
      if (closed) {
        // The continuation this plan admitted ran to its end. `lastTurn` does not move again after
        // `turn/end`, so equality plus a closed projection is proof the work came back: resending it
        // here is exactly the duplicate restart that a counter-only comparison produced.
        return { status: 'skipped', detail: 'continued turn ended before this restart', continued: true, turn: turnBefore }
      }
      // No projection to read: equality cannot prove the turn ended, and resending may duplicate it.
      return { status: 'unknown', detail: 'continued turn state unreadable', continued: false, turn: turnBefore }
    }
    if (admittedTurn !== null && turnBefore !== null && turnBefore > admittedTurn) {
      return outcomeOf('continued turn ended', true, turnBefore, closed ? 'unobserved' : null)
    }
    if (capturedTurn !== null && turnBefore !== null && turnBefore > capturedTurn) {
      // A turn ran and ended, but this plan has no record of having admitted it. That is neither
      // proof the work came back (it may have been an unrelated round) nor proof it did not, so the
      // row is kept and the person decides instead of it being closed as terminal attention.
      return { status: 'unknown', detail: 'a turn advanced while this plan was stopped', continued: false, turn: turnBefore }
    }

    const request = continuation(plan, sessionId, session.epoch, session.retry)
    // An earlier attempt already got this message admitted. Sending it again would queue a second
    // continuation for one obligation, so the row waits for the turn that admission owes instead.
    const admittedCycle = Number.isSafeInteger(session.admittedEpoch) === false || session.admittedEpoch === (Number.isSafeInteger(session.epoch) ? session.epoch : 0)
    if (typeof session.admittedRequest === 'string' && session.admittedRequest !== '' && admittedCycle) {
      const admitted = await waitForTurn(sessionId, baseline, options.settleMs)
      if (admitted.started) {
        const admittedKind = admitted.ended ? turnEndKind(admitted.reason) : null
        if (admittedKind === 'aborted') return { status: 'interrupted', detail: 'admitted continuation was aborted', continued: false }
        return outcomeOf(admitted.ended ? 'admitted continuation ended' : 'admitted continuation is running', true, admitted.turn, admitted.ended ? admittedKind ?? 'unobserved' : 'running')
      }
      // Nothing proves the admitted message became a turn. Held, not closed and not resent.
      return { status: 'unknown', detail: 'a continuation was admitted before this restart and no turn is visible', continued: false }
    }
    const controller = service(services, 'sessionController')
    if (controller === undefined || controller === null || typeof controller.prompt !== 'function') {
      return { status: 'failed', detail: 'prompt unavailable', continued: false }
    }
    if (reloaded()) return { status: 'reloaded' }
    if (cancelled()) return { status: 'interrupted', detail: 'restore stopped', continued: false }
    // The listener is registered before the message is submitted. A turn that opens and closes
    // inside the submit window is otherwise invisible, and an invisible turn is reported as "not
    // executed", which is how the same continuation got sent twice.
    const turnWatch = openTurnWatch(sessionId, baseline)
    try {
      // Two arguments: the shipped service takes the caller's AbortSignal. Passing source metadata
      // here made every restore fail on a live Harness while the fake in the tests accepted it.
      await bounded(() => controller.prompt(request, call), callMs, 'prompt')
      if (onAdmitted !== null && onAdmitted(sessionId, request.requestId) === false) {
        return { status: 'unknown', detail: 'continuation admitted but its record could not be saved', continued: false }
      }
    } catch (error) {
      const detail = String(error?.message ?? error).slice(0, 120)
      // A prompt that only overran its budget may still have been admitted: a turn that starts in the
      // grace window is proof it was. Without one the row stays retryable, on a fresh request id.
      if (/timed out/i.test(detail)) {
        const late = await waitForTurn(sessionId, baseline, Math.max(Number.isFinite(options.settleMs) ? options.settleMs : 1200, 4000), turnWatch)
        if (late.started) {
          if (turnEndKind(late.reason) === 'aborted') return { status: 'interrupted', detail: 'continuation turn was aborted', continued: false }
          return { status: 'restored', detail: 'continued after admission timeout', continued: true, turn: late.turn, turnEnd: late.ended ? turnEndKind(late.reason) ?? 'unobserved' : 'running' }
        }
      }
      return { status: 'failed', detail, continued: false }
    }
    if (cancelled()) return { status: 'interrupted', detail: 'restore stopped after admission', continued: false }

    // Backfill from the durable record: a turn that already ended before this submit returned is
    // evidence the message was consumed, not that it never ran. Without this the row would be held
    // as "admitted, no turn started" and the next press would send the same continuation again.
    const backfill = await assessSession(session, { plan })
    if (backfill.turn !== null && baseline !== null && backfill.turn > baseline
      && backfill.end !== null && backfill.end !== 'open') {
      if (backfill.end === 'aborted' || backfill.end === 'interrupted') {
        return { status: 'interrupted', detail: `continuation turn ended as ${backfill.end}`, continued: false, turn: backfill.turn }
      }
      if (backfill.end === 'error' || backfill.end === 'blocked') {
        return { status: 'attention', detail: `continuation turn ended: ${backfill.end}`, continued: true, turn: backfill.turn }
      }
      return outcomeOf(mounted ? 'continued' : 'resumed and continued', true, backfill.turn, backfill.end)
    }

    // Admission is not execution. The shipped prompt answers `{ accepted: true }` without waking a
    // queue when the same request id was already admitted, so the press waits for the visible sign
    // of a turn (running, or a newer lastTurn) before it calls this item restored.
    if (cancelled()) return { status: 'interrupted', detail: 'restore stopped before the turn opened', continued: false }
    const started = await waitForTurn(sessionId, baseline, options.settleMs, turnWatch)
    if (started.started) {
      const kind = started.ended ? turnEndKind(started.reason) : null
      // A turn that was parsed and then aborted is not proof the work came back: it is a turn that
      // began and was stopped. Keeping the row non-terminal is what lets the next press retry it.
      if (kind === 'aborted') return { status: 'interrupted', detail: 'continuation turn was aborted', continued: false }
      if (kind === 'error' || kind === 'blocked') {
        return { status: 'attention', detail: `continuation turn ended: ${kind}`, continued: true, turn: started.turn }
      }
      return outcomeOf(mounted ? 'continued' : 'resumed and continued', true, started.turn, started.ended ? kind ?? 'unobserved' : 'running')
    }
    // `accepted: true` without a turn means the message was admitted, not executed. The obligation is
    // still owed, so the row stays in the plan as `unknown` instead of closing as terminal attention.
    return { status: 'unknown', detail: 'continuation admitted, no turn started', continued: false }
  }

  /** Bounded poll for a parent Activation, which is what a child's delivery is routed through. */
  async function waitForAgent(sessionId, settle) {
    const deadline = Date.now() + (Number.isFinite(settle) ? settle : 1200)
    for (;;) {
      if (agentOf(services, sessionId) !== undefined) return true
      if (Date.now() >= deadline) return false
      await new Promise((resolve) => setTimeout(resolve, 60))
    }
  }

  /**
   * Register the turn listener before a message is submitted. A turn that opens and closes inside the
   * submit window is then still visible; without it the end is read as "never executed" and the same
   * continuation is sent again. The watcher is passed to `waitForTurn` so one subscription covers
   * both the submit and the wait.
   */
  function openTurnWatch(sessionId, baseline) {
    const watcher = { opened: null, ended: null, stop: null }
    if (watchTurn === null) return watcher
    try {
      watcher.stop = watchTurn(sessionId, (event) => {
        const type = typeof event?.type === 'string' ? event.type : null
        const turn = Number.isSafeInteger(event?.data?.turn) ? event.data.turn : null
        if (turn === null) return
        if (type === 'turn/start') {
          if (baseline !== null && turn <= baseline) return
          if (watcher.opened === null || turn > watcher.opened) {
            watcher.opened = turn
            watcher.ended = null
          }
          return
        }
        if (type === 'turn/end' && watcher.opened !== null && turn === watcher.opened) {
          watcher.ended = event.data.reason ?? { kind: 'unknown' }
          const end = endOfEvent(event)
          if (end !== null) {
            const row = watchedTurns.get(sessionId)
            if (row !== undefined) row.ends.set(end.turn, end.kind)
          }
        }
      })
    } catch {
      /* no event stream: the projection poll inside waitForTurn is the fallback */
    }
    return watcher
  }

  /**
   * Bounded watch for what an admitted continuation actually became, without mistaking a counter
   * that merely moved for a finished turn.
   *
   * - `turn/start` with a number above the baseline proves the message was parsed into a turn.
   * - `turn/end` for that same turn gives the reason it finished; that is the completion evidence a
   *   later boot compares against.
   * - A projection with no open turn and a counter at or past the baseline proves the turn ended
   *   even when the event itself was missed; the reason is then honestly reported as unobserved.
   *
   * An open turn is returned as started but not ended, so a restore can call it running rather than
   * waiting out the whole settle window for an end that will not come.
   */
  async function waitForTurn(sessionId, baseline, settle, pre = null) {
    const none = { started: false, ended: false, turn: null, reason: null }
    if (settle === 0) return none
    const deadline = Date.now() + (Number.isFinite(settle) ? settle : 1200)
    const watcher = pre ?? openTurnWatch(sessionId, baseline)
    let opened = watcher.opened
    let ended = watcher.ended
    try {
      for (;;) {
        // The watcher's own state, in case the listener fired since the last poll.
        if (watcher.opened !== null && (opened === null || watcher.opened > opened)) opened = watcher.opened
        if (watcher.ended !== null) ended = watcher.ended
        const facts = turnFactsOf(services, sessionId)
        if (facts !== null && facts.lastTurn !== null) {
          if (opened === null && baseline !== null && facts.lastTurn > baseline) opened = facts.lastTurn
          // A session already running with no recorded baseline is an open turn this probe can see
          // but not date; calling it started is honest because a second continuation would duplicate.
          if (opened === null && baseline === null && facts.running === true) opened = facts.lastTurn
          if (opened !== null && ended === null && facts.open === false && facts.running === false) {
            // The projection records the end of the turn but not its reason. Reporting `unobserved`
            // keeps the difference visible instead of inventing "completed".
            ended = { kind: 'unobserved' }
          }
        }
        if (opened !== null) return { started: true, ended: ended !== null, turn: opened, reason: ended }
        if (Date.now() >= deadline) return none
        await new Promise((resolve) => setTimeout(resolve, 60))
      }
    } finally {
      // A watcher handed in by the caller also covers the submit that follows it.
      if (pre === null && typeof watcher.stop === 'function') watcher.stop()
    }
  }

  /**
   * Read a goal and prove it is still exactly the paused state the plan captured. The engine calls
   * this before writing any restore intent, so the revision it records is one this process actually
   * observed, not a revision guessed from the plan.
   */
  async function prepareGoal(goal, { plan } = {}) {
    if (goal === null || typeof goal?.sessionId !== 'string') return { status: 'skipped', detail: 'no goal' }
    let agent = agentOf(services, goal.sessionId)
    if (agent === undefined) {
      try {
        agent = await mount(goal.sessionId)
      } catch (error) {
        return { status: 'failed', detail: String(error?.message ?? error).slice(0, 120) }
      }
    }
    if (reloaded()) return { status: 'reloaded' }
    const services_goals = service(services, 'goals')
    if (services_goals === undefined || services_goals === null || typeof services_goals.resume !== 'function') {
      return { status: 'failed', detail: 'goals unavailable' }
    }
    const view = goalView(services, agent)
    if (view !== undefined && view !== null && view.unreadable === true) {
      return { status: 'failed', detail: `goal unreadable: ${view.detail}` }
    }
    if (view === undefined || view === null || (typeof goal.goalId === 'string' && view.id !== goal.goalId)) {
      return { status: 'skipped', detail: 'goal is gone' }
    }
    if (view.phase === 'active') {
      if (view.activation === 'armed') return { status: 'skipped', detail: 'already active' }
      return { status: 'attention', detail: 'goal active but not armed' }
    }
    if (view.phase !== 'paused') return { status: 'skipped', detail: `goal is ${view.phase}` }
    const expected = Number.isSafeInteger(goal.revision) ? goal.revision : goal.pausedRevision
    if (Number.isSafeInteger(expected) === false) return { status: 'attention', detail: 'goal has no saved revision' }
    if (view.revision !== expected) return { status: 'skipped', detail: 'goal changed' }
    return { status: 'ready', revision: view.revision }
  }

  /** Re-arm one paused goal. The saved revision is the person's veto: a changed goal is not ours. */
  async function restoreGoal(goal, { plan, signal = null } = {}) {
    const cancelled = () => signal?.aborted === true
    if (cancelled()) return { status: 'interrupted', detail: 'cancelled before arming' }
    if (goal === null || typeof goal?.sessionId !== 'string') return { status: 'skipped', detail: 'no goal' }
    let agent = agentOf(services, goal.sessionId)
    if (agent === undefined) {
      try {
        agent = await mount(goal.sessionId)
      } catch (error) {
        return { status: 'failed', detail: String(error?.message ?? error).slice(0, 120) }
      }
    }
    if (reloaded()) return { status: 'reloaded' }
    const services_goals = service(services, 'goals')
    if (services_goals === undefined || services_goals === null || typeof services_goals.resume !== 'function') {
      return { status: 'failed', detail: 'goals unavailable' }
    }
    const view = goalView(services, agent)
    if (view !== undefined && view !== null && view.unreadable === true) {
      return { status: 'failed', detail: `goal unreadable: ${view.detail}` }
    }
    if (view === undefined || view === null || (typeof goal.goalId === 'string' && view.id !== goal.goalId)) {
      return { status: 'skipped', detail: 'goal is gone' }
    }
    // An active goal is normally not ours to touch. The one exception is a goal this same plan
    // armed in an earlier process: activation is per-process, so a restart leaves it `disarmed` at
    // exactly the revision the plan recorded. Another person's goal has no such record.
    if (view.phase === 'active') {
      if (view.activation === 'armed') return { status: 'skipped', detail: 'already active' }
      const pending = goal.pendingRestore !== null && typeof goal.pendingRestore === 'object' ? goal.pendingRestore : null
      const pendingExpect = Number.isSafeInteger(pending?.expect) ? pending.expect : null
      // `pendingRestore.expect` is the exact revision this operation's resume produces. Equality is
      // the proof: a later revision is somebody else's edit, and an older one predates our intent.
      const ours = pendingExpect !== null && view.revision === pendingExpect
      if (ours || (Number.isSafeInteger(goal.armedRevision) && goal.armedRevision === view.revision)) {
        if (reloaded()) return { status: 'reloaded' }
        if (cancelled()) return { status: 'interrupted', detail: 'cancelled before arming' }
        try {
          services_goals.resume(agent, { id: view.id, revision: view.revision })
        } catch (error) {
          return { status: 'failed', detail: String(error?.message ?? error).slice(0, 120) }
        }
        const after = goalView(services, agent)
        if (after !== undefined && after !== null && after.unreadable === true) {
          return { status: 'failed', detail: 'goal unreadable after resume' }
        }
        return { status: 'restored', detail: 're-armed after restart', revision: after?.revision ?? null }
      }
      if (pending !== null) return { status: 'attention', detail: 'goal changed after restore' }
      return { status: 'skipped', detail: 'goal disarmed' }
    }
    if (view.phase !== 'paused') return { status: 'skipped', detail: `goal is ${view.phase}` }
    const pending = goal.pendingRestore !== null && typeof goal.pendingRestore === 'object' ? goal.pendingRestore : null
    const pendingRevision = Number.isSafeInteger(pending?.revision) ? pending.revision : null
    // A saved intent is the exact pre-side-effect state this operation observed. Without one, the
    // plan's post-pause revision is the veto.
    const expected = pendingRevision ?? (Number.isSafeInteger(goal.revision) ? goal.revision : goal.pausedRevision)
    if (Number.isSafeInteger(expected) === false) return { status: 'attention', detail: 'goal has no saved revision' }
    if (view.revision !== expected) {
      if (pending !== null) return { status: 'attention', detail: 'goal changed after restore' }
      return { status: 'skipped', detail: 'goal changed by hand' }
    }
    if (reloaded()) return { status: 'reloaded' }
    if (cancelled()) return { status: 'interrupted', detail: 'cancelled before arming' }
    try {
      services_goals.resume(agent, { id: view.id, revision: view.revision })
    } catch (error) {
      return { status: 'failed', detail: String(error?.message ?? error).slice(0, 120) }
    }
    const after = goalView(services, agent)
    if (after !== undefined && after !== null && after.unreadable === true) {
      return { status: 'failed', detail: 'goal unreadable after resume' }
    }
    return { status: 'restored', detail: 'armed', revision: after?.revision ?? null }
  }

  /**
   * What a previous process left behind. The heartbeat recorded the turn each session was inside
   * when that process ended. If the live session still reports that same turn, the turn never
   * finished, so the crash is recoverable as a continuation. If the counter moved, the turn ended
   * before the restart and re-sending it would be a duplicate nobody asked for, so it only mounts.
   */
  function crashPlan(residue, { planId } = {}) {
    if (residue === null || residue === undefined) return null
    // The heartbeat already dedupes, but this reader is also the gate for any residue handed in
    // directly: the same id twice must not become two mount rows in one plan.
    const rows = Array.isArray(residue.sessions) ? residue.sessions : []
    const seen = new Set()
    const sessions = []
    let continued = 0
    let mountedOnly = 0
    let unknown = 0
    for (const row of rows) {
      if (typeof row?.sessionId !== 'string' || row.sessionId === '' || seen.has(row.sessionId)) continue
      seen.add(row.sessionId)
      const agent = agentOf(services, row.sessionId)
      // Prefer the route the dead process recorded. The live runtime may have forgotten it, and a
      // crash row that loses its parent can only be mounted as a root — its child then waits forever.
      const savedParent = typeof row.parent === 'string' && row.parent !== '' ? row.parent : null
      const parent = agent === undefined ? savedParent : sessionParent(services, row.sessionId) ?? savedParent
      const facts = agent === undefined ? null : turnFactsOf(services, row.sessionId)
      const live = facts === null ? null : facts.lastTurn
      const saved = Number.isSafeInteger(row.lastTurn) ? row.lastTurn : null
      // An open turn at boot is the turn the dead process never closed: its continuation is owed.
      // A closed turn is finished work, even when the counter never moved again after it ended —
      // equality alone used to re-continue completed sessions, and a moved counter alone used to
      // skip turns that were still owed.
      const projected = facts !== null && facts.source === 'projection'
      const open = projected && (facts.open === true || facts.running === true)
      // Without the projection this build can only repeat the old phase reading, which cannot tell a
      // finished turn from an interrupted one. Such rows keep their previous, conservative verdict.
      const legacyResume = saved !== null && live !== null && saved === live && agent?.status !== 'running'
      const legacyAdvance = saved !== null && live !== null && live > saved
      const resume = projected ? live !== null && open : legacyResume
      const finished = projected
        ? live !== null && open === false && saved !== null && live >= saved
        : legacyAdvance
      const intent = resume ? 'continue' : finished || legacyAdvance ? 'skip' : 'unknown'
      const rowTurn = intent === 'continue' ? live ?? saved : saved
      if (intent === 'continue') continued += 1
      else if (intent === 'skip') mountedOnly += 1
      else unknown += 1
      sessions.push({
        sessionId: row.sessionId,
        intent,
        epoch: 0,
        running: intent === 'continue',
        lastTurn: rowTurn,
        parent,
        origin: parent === null ? 'root' : 'subagent',
        crash: true,
      })
    }
    // The goal rows carry the revision the dead process observed. `armedRevision` is the proof the
    // restore needs: activation is per-process, so an armed goal comes back `disarmed` at exactly
    // this revision unless a person edited it in between.
    const goalRows = Array.isArray(residue.goals) ? residue.goals : []
    const seenGoals = new Set()
    const goals = []
    for (const row of goalRows) {
      if (typeof row?.sessionId !== 'string' || row.sessionId === '' || typeof row?.goalId !== 'string' || row.goalId === '' || Number.isSafeInteger(row?.revision) === false) continue
      const key = `${row.sessionId}\u0000${row.goalId}`
      if (seenGoals.has(key)) continue
      seenGoals.add(key)
      goals.push({ sessionId: row.sessionId, goalId: row.goalId, revision: row.revision, armedRevision: row.revision, crash: true })
    }
    if (sessions.length === 0 && goals.length === 0) return null
    return {
      version: 3, // ui-copy-ignore
      planId: planId ?? `crash-${Date.now().toString(36)}`,
      status: 'paused', // ui-copy-ignore
      source: 'crash', // ui-copy-ignore
      createdAt: new Date(Number.isFinite(residue.at) ? residue.at : Date.now()).toISOString(),
      sessions,
      goals,
      jobs: [], // ui-copy-ignore
      attention: [
        ...(mountedOnly === 0 ? [] : [{ kind: 'session', id: '', detail: `crashed: ${mountedOnly} session(s) ended their turn before the restart` }]),
        ...(unknown === 0 ? [] : [{ kind: 'session', id: '', detail: `crashed: ${unknown} session(s) need a look before continuing` }]),
        ...(continued === 0 ? [] : [{ kind: 'session', id: '', detail: `crashed mid-turn: ${continued} session(s) will continue the turn the dead process left open` }]),
      ],
      crashes: sessions.length, // ui-copy-ignore
    }
  }

  return {
    assessSession,
    live,
    stop,
    restoreSession,
    prepareGoal,
    restoreGoal,
    restoreSchedule: async () => ({ status: 'skipped', detail: 'no schedules' }),
    crashPlan,
  }
}
