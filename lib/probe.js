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
    if (agent.status === 'running') sessions.push({ sessionId: agent.id, lastTurn: lastTurnOf(agent) })
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
  const value = agent?.phase?.lastTurn
  return Number.isSafeInteger(value) ? value : null
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

  /** Everything this press can stop, read from the live registry only. */
  function live() {
    const agents = agentsOf(services)
    const sessions = []
    const goals = []
    const jobs = []
    if (agents === undefined) {
      // The registry is unreadable: report no work rather than claiming a state the button cannot see.
      return { sessions, goals, jobs, readable: false, source: 'none' }
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
      sessions.push({
        sessionId: agent.id,
        running: agent.status === 'running',
        lastTurn: lastTurnOf(agent),
        parent: lineage,
        origin: header?.origin === 'subagent' || lineage !== null ? 'subagent' : 'root',
      })
      // A disarmed goal is not work: it will not start a round, and pausing it would throw. Only an
      // active, armed goal is something this press can stop and this restore can re-arm.
      if (goal !== undefined && goal !== null && goal.unreadable !== true && goal.phase === 'active' && goal.activation === 'armed') {
        goals.push({ sessionId: agent.id, goalId: goal.id, revision: goal.revision })
      }
      for (const job of owned) if (RUNNING_JOB.has(job.status)) jobs.push({ id: job.id, owner: agent.id, status: job.status })
    }
    const unique = new Map()
    for (const job of jobs) if (!unique.has(job.id)) unique.set(job.id, job)
    return { sessions, goals, jobs: [...unique.values()], readable: true, source: 'live' }
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
      if (canKill === false) {
        jobErrors.push(`job ${job.id}: job service unavailable`)
        continue
      }
      try {
        if (job.owner === null || job.owner === undefined) jobs.kill(job.id)
        else jobs.kill(job.id, job.owner)
      } catch (error) {
        jobErrors.push(`job ${job.id}: ${String(error?.message ?? error).slice(0, 80)}`)
        continue
      }
      // `kill` only requests the stop: the process is still alive until the job settles. Reporting
      // the request as a kill would let a plan claim a clean pause while a shell kept writing.
      const settled = await waitJobExit(services, job, Math.min(grace ?? graceMs, jobExitMs))
      if (settled === 'terminal') killedJobs.push({ id: job.id, owner: job.owner ?? null })
      else if (settled === 'foreign') jobErrors.push(`job ${job.id}: owned by another session`)
      else jobErrors.push(`job ${job.id}: stop requested, still ${settled}`)
    }

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
          await admit(freshRows)
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
      return { canceled: [], unknown: [], pausedGoals: [], goalErrors: [], killedJobs: [], jobErrors: [], stillRunning: [], sessions: [], discovered: [], reloaded: true }
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

    return { canceled, unknown, pausedGoals, goalErrors, killedJobs, jobErrors, stillRunning, sessions, discovered, reloaded: stale }
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
    return {
      sessionId,
      requestId,
      content: [{ type: 'text', text: continueText }],
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
  async function restoreChild(session, { plan } = {}) {
    const { sessionId } = session
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
    if (reloaded()) return { status: 'reloaded' }
    const request = continuation(plan, sessionId, session.epoch, session.retry)
    try {
      await bounded(() => subagents.prompt({
        parentSessionId: parent,
        childSessionId: sessionId,
        mode: 'continuable',
        delivery: 'queue',
        requestId: request.requestId,
        content: request.content,
      }, new AbortController().signal), callMs, 'subagent prompt')
    } catch (error) {
      return { status: 'failed', detail: String(error?.message ?? error).slice(0, 120), continued: false }
    }
    const started = await waitForTurn(sessionId, Number.isSafeInteger(session.lastTurn) ? session.lastTurn : null, options.settleMs)
    if (started === true) return { status: 'restored', detail: 'child continued', continued: true }
    return { status: 'attention', detail: 'child continuation admitted, no turn started', continued: false }
  }

  /**
   * Put one session back. A session whose turn was stopped by the press gets its continuation
   * admitted; a session that only carried a goal is mounted and left to the goal driver.
   */
  async function restoreSession(session, { plan, budgetMs } = {}) {
    if (session === null || typeof session?.sessionId !== 'string') return { status: 'skipped', detail: 'no session' }
    const { sessionId } = session
    if (session.origin === 'subagent' || (typeof session.parent === 'string' && session.parent !== '')) {
      return restoreChild(session, { plan })
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

    // Version 2 plans carry only `running`; a normalized version 3 plan carries `intent`. Reading
    // the old field here keeps a plan written by 0.3.0 working across the upgrade.
    const intent = session.intent === undefined && session.running === true ? 'continue' : session.intent
    if (intent !== 'continue') {
      return { status: 'restored', detail: mounted ? 'mounted' : 'attached', continued: false }
    }

    // A turn that is already open is not evidence the continuation arrived, but it is work in
    // progress: starting a second one would be a duplicate. A turn that advanced and then ended is
    // different: it may have been the continuation, or it may have been interrupted after the
    // request was admitted. Neither case allows resending, and neither may be reported as a clean
    // `skipped` with no attention.
    const capturedTurn = Number.isSafeInteger(session.lastTurn) ? session.lastTurn : null
    const turnBefore = lastTurnOf(agent)
    // A plan captured mid-turn carries no turn number. The turn the session shows now is then the
    // only honest baseline: an advance past it can only be work this restore started.
    const baseline = capturedTurn ?? turnBefore
    if (agent.status === 'running') return { status: 'skipped', detail: 'already running', continued: false }
    if (capturedTurn !== null && turnBefore !== null && turnBefore > capturedTurn) {
      return { status: 'attention', detail: 'turn advanced after the pause; not sent again', continued: false }
    }

    const controller = service(services, 'sessionController')
    if (controller === undefined || controller === null || typeof controller.prompt !== 'function') {
      return { status: 'failed', detail: 'prompt unavailable', continued: false }
    }
    if (reloaded()) return { status: 'reloaded' }
    const request = continuation(plan, sessionId, session.epoch, session.retry)
    try {
      // Two arguments: the shipped service takes the caller's AbortSignal. Passing source metadata
      // here made every restore fail on a live Harness while the fake in the tests accepted it.
      await bounded(() => controller.prompt(request, new AbortController().signal), callMs, 'prompt')
    } catch (error) {
      const detail = String(error?.message ?? error).slice(0, 120)
      // A prompt that only overran its budget may still have been admitted: a turn that starts in the
      // grace window is proof it was. Without one the row stays retryable, on a fresh request id.
      if (/timed out/i.test(detail)) {
        const late = await waitForTurn(sessionId, baseline, Math.max(Number.isFinite(options.settleMs) ? options.settleMs : 1200, 4000))
        if (late === true) return { status: 'restored', detail: 'continued after admission timeout', continued: true }
      }
      return { status: 'failed', detail, continued: false }
    }

    // Admission is not execution. The shipped prompt answers `{ accepted: true }` without waking a
    // queue when the same request id was already admitted, so the press waits for the visible sign
    // of a turn (running, or a newer lastTurn) before it calls this item restored.
    const started = await waitForTurn(sessionId, baseline, options.settleMs)
    if (started === true) return { status: 'restored', detail: mounted ? 'continued' : 'resumed and continued', continued: true }
    return { status: 'attention', detail: 'continuation admitted, no turn started', continued: false }
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

  /** Bounded poll for the visible sign that an admitted continuation actually opened a turn. */
  async function waitForTurn(sessionId, baseline, settle) {
    if (settle === 0) return false
    const deadline = Date.now() + (Number.isFinite(settle) ? settle : 1200)
    for (;;) {
      const agent = agentOf(services, sessionId)
      if (agent !== undefined) {
        if (agent.status === 'running') return true
        const turn = lastTurnOf(agent)
        if (baseline !== null && turn !== null && turn > baseline) return true
      }
      if (Date.now() >= deadline) return false
      await new Promise((resolve) => setTimeout(resolve, 60))
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
  async function restoreGoal(goal, { plan } = {}) {
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
    for (const row of rows) {
      if (typeof row?.sessionId !== 'string' || row.sessionId === '' || seen.has(row.sessionId)) continue
      seen.add(row.sessionId)
      const agent = agentOf(services, row.sessionId)
      const parent = agent === undefined ? null : sessionParent(services, row.sessionId)
      const live = agent === undefined ? null : lastTurnOf(agent)
      const saved = Number.isSafeInteger(row.lastTurn) ? row.lastTurn : null
      // Only exact equality proves the saved turn is still the open one. A missing counter or a
      // counter that moved leaves the session with a mount: unknown evidence never invents a turn.
      const resume = saved !== null && live !== null && saved === live && agent?.status !== 'running'
      if (resume) continued += 1
      else mountedOnly += 1
      sessions.push({
        sessionId: row.sessionId,
        intent: resume ? 'continue' : 'mount',
        epoch: 0,
        running: resume,
        lastTurn: saved,
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
        ...(mountedOnly === 0 ? [] : [{ kind: 'session', id: '', detail: `crashed before it could be paused: ${mountedOnly} session(s) left alone` }]),
        ...(continued === 0 ? [] : [{ kind: 'session', id: '', detail: `crashed mid-turn: ${continued} session(s) will continue the turn the dead process left open` }]),
      ],
      crashes: sessions.length, // ui-copy-ignore
    }
  }

  return {
    live,
    stop,
    restoreSession,
    prepareGoal,
    restoreGoal,
    restoreSchedule: async () => ({ status: 'skipped', detail: 'no schedules' }),
    crashPlan,
  }
}
