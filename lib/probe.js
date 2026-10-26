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

/** The session ids whose turn is open right now: the heartbeat's only question. */
export function listRunning(services) {
  const agents = agentsOf(services)
  if (agents === undefined) return []
  return agents.filter((agent) => agent.status === 'running').map((agent) => agent.id)
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

const RUNNING_JOB = new Set(['running', 'stopping'])

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
      sessions.push({ sessionId: agent.id, running: agent.status === 'running', lastTurn: lastTurnOf(agent) })
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
  async function stop(current, { graceMs: grace } = {}) {
    const controller = service(services, 'sessionController')
    const goals = service(services, 'goals')
    const jobs = service(services, 'jobs')
    const canceled = []
    const unknown = []
    const pausedGoals = []
    const goalErrors = []
    const killedJobs = []
    const jobErrors = []

    for (const goal of current.goals ?? []) {
      const agent = agentOf(services, goal.sessionId)
      if (agent === undefined) continue
      try {
        const view = goals.pause(agent, { id: goal.goalId, revision: goal.revision })
        pausedGoals.push({ sessionId: goal.sessionId, goalId: view?.id ?? goal.goalId, pausedRevision: view?.revision ?? goal.revision + 1 })
      } catch (error) {
        goalErrors.push(`goal ${goal.goalId}: ${String(error?.message ?? error).slice(0, 80)}`)
      }
    }

    // Every open turn is asked to stop before the wait, so the grace period measures one round trip.
    const stopping = (current.sessions ?? []).filter((session) => session.running === true)
    for (const session of stopping) {
      try {
        await controller?.cancel?.({ sessionId: session.sessionId })
        canceled.push(session.sessionId)
      } catch (error) {
        unknown.push(`session ${session.sessionId}: ${String(error?.message ?? error).slice(0, 80)}`)
      }
    }

    for (const job of current.jobs ?? []) {
      try {
        if (job.owner === null || job.owner === undefined) jobs?.kill?.(job.id)
        else jobs?.kill?.(job.id, job.owner)
        killedJobs.push({ id: job.id, owner: job.owner ?? null })
      } catch (error) {
        jobErrors.push(`job ${job.id}: ${String(error?.message ?? error).slice(0, 80)}`)
      }
    }

    // A turn ends when its tools return: the press waits a bounded moment for that instead of
    // claiming a stop that has not happened yet.
    const deadline = Date.now() + (grace ?? graceMs)
    let pending = stopping.map((session) => session.sessionId)
    while (pending.length > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 60))
      const stillRunning = new Set(listRunning(services))
      pending = pending.filter((id) => stillRunning.has(id))
    }
    for (const id of pending) unknown.push(`session ${id}: still running`)

    // The turn counter is only readable once the turn is over: a running phase carries the turn it
    // is in, not the last finished one. Recording it now is what lets a restore tell "the press
    // stopped turn 4" from "the person ran turn 5 while paused".
    const sessions = stopping.map((session) => {
      const agent = agentOf(services, session.sessionId)
      return { sessionId: session.sessionId, lastTurn: agent === undefined ? null : lastTurnOf(agent) }
    })

    return { canceled, unknown, pausedGoals, goalErrors, killedJobs, jobErrors, stillRunning: pending, sessions }
  }

  /** The continuation message: a real user message, so the session history shows why it moved. */
  function continuation(plan, sessionId, epoch) {
    // The epoch is the pause cycle. A retry of the same pause reuses the id (official dedupe keeps
    // admission idempotent), while a new pause after a partial restore gets a fresh one, so the
    // earlier admitted message cannot swallow this cycle's continuation.
    const cycle = Number.isSafeInteger(epoch) && epoch >= 0 ? epoch : 1
    // Cycle 0 is a pre-epoch plan: keep the exact id that may already sit in the official queue,
    // so upgrading the plugin cannot duplicate a continuation the old version admitted.
    const requestId = cycle === 0
      ? `${plan.planId}:continue:${sessionId}`
      : `${plan.planId}:continue:${sessionId}:${cycle}`
    return {
      sessionId,
      requestId,
      content: [{ type: 'text', text: continueText }],
      // `queue` is the shipped public mode: deliver after the current turn, start one when idle.
      mode: 'queue',
    }
  }

  /** Mount one session through the public resume path, which restores preset and model selection. */
  async function mount(sessionId) {
    const controller = service(services, 'sessionController')
    if (controller !== undefined && controller !== null && typeof controller.resolveAgent === 'function') {
      const resolved = await controller.resolveAgent(sessionId)
      // The shipped service returns the Agent itself when it is already live, `{ agent }` after a
      // cold resume, and `{ error }` when the resume failed. All three are official shapes.
      if (resolved !== null && typeof resolved === 'object' && 'error' in resolved) throw resolved.error
      const agent = resolved !== null && typeof resolved === 'object' && 'agent' in resolved ? resolved.agent : resolved
      if (agent === undefined || agent === null || typeof agent.id !== 'string') throw new Error('resume returned no agent')
      return agent
    }
    const agents = service(services, 'agents')
    if (agents === undefined || agents === null || typeof agents.resume !== 'function') throw new Error('agents unavailable')
    await agents.resume({ resumeSessionId: sessionId })
    const mounted = agentOf(services, sessionId)
    if (mounted === undefined) throw new Error('session did not attach')
    return mounted
  }

  /**
   * Put one session back. A session whose turn was stopped by the press gets its continuation
   * admitted; a session that only carried a goal is mounted and left to the goal driver.
   */
  async function restoreSession(session, { plan } = {}) {
    if (session === null || typeof session?.sessionId !== 'string') return { status: 'skipped', detail: 'no session' }
    const { sessionId } = session
    let agent = agentOf(services, sessionId)
    const mounted = agent !== undefined
    if (agent === undefined) {
      try {
        agent = await mount(sessionId)
      } catch (error) {
        const detail = String(error?.message ?? error).slice(0, 120)
        // A subagent row belongs to the parent chat that owns its routing; this process may not
        // claim it directly, and a retry would fail the same way forever. The parent restores it.
        if (/owned by subagent routing/i.test(detail)) {
          return { status: 'attention', detail: 'subagent session; its parent restores it' }
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
    const baseline = Number.isSafeInteger(session.lastTurn) ? session.lastTurn : null
    const turnBefore = lastTurnOf(agent)
    if (agent.status === 'running') return { status: 'skipped', detail: 'already running', continued: false }
    if (baseline !== null && turnBefore !== null && turnBefore > baseline) {
      return { status: 'attention', detail: 'turn advanced after the pause; not sent again', continued: false }
    }

    const controller = service(services, 'sessionController')
    if (controller === undefined || controller === null || typeof controller.prompt !== 'function') {
      return { status: 'failed', detail: 'prompt unavailable', continued: false }
    }
    if (reloaded()) return { status: 'reloaded' }
    const request = continuation(plan, sessionId, session.epoch)
    try {
      // Two arguments: the shipped service takes the caller's AbortSignal. Passing source metadata
      // here made every restore fail on a live Harness while the fake in the tests accepted it.
      await controller.prompt(request, new AbortController().signal)
    } catch (error) {
      return { status: 'failed', detail: String(error?.message ?? error).slice(0, 120), continued: false }
    }

    // Admission is not execution. The shipped prompt answers `{ accepted: true }` without waking a
    // queue when the same request id was already admitted, so the press waits for the visible sign
    // of a turn (running, or a newer lastTurn) before it calls this item restored.
    const started = await waitForTurn(sessionId, baseline, options.settleMs)
    if (started === true) return { status: 'restored', detail: mounted ? 'continued' : 'resumed and continued', continued: true }
    return { status: 'attention', detail: 'continuation admitted, no turn started', continued: false }
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
      const pendingRevision = Number.isSafeInteger(pending?.revision) ? pending.revision : null
      // `pendingRestore` was written before the side effect. If the process died after resume but
      // before the checkpoint, the goal is active and disarmed at the revision our resume produced.
      const ours = pending !== null && (pendingRevision === null || view.revision >= pendingRevision)
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
      return { status: 'skipped', detail: 'goal disarmed' }
    }
    if (view.phase !== 'paused') return { status: 'skipped', detail: `goal is ${view.phase}` }
    // The saved revision is the person's veto: a goal edited after the pause is not ours to resume.
    if (Number.isSafeInteger(goal.revision) && view.revision !== goal.revision) {
      return { status: 'skipped', detail: 'goal changed' }
    }
    // The plan stores the revision observed after `pause`; 0.3 plans keep it in `revision`, 0.2
    // plans called it `pausedRevision`.
    const expected = Number.isSafeInteger(goal.revision) ? goal.revision : goal.pausedRevision
    if (Number.isSafeInteger(expected) === false) return { status: 'attention', detail: 'goal has no saved revision' }
    if (view.revision !== expected) return { status: 'skipped', detail: 'goal changed by hand' }
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
   * What a previous process left behind: sessions whose turn was open when that process ended.
   * This process cannot know whether those turns finished, so it mounts them and says so. Only a
   * press's own plan is allowed to continue a turn.
   */
  function crashPlan(residue, { planId } = {}) {
    if (residue === null || residue === undefined) return null
    const rows = Array.isArray(residue.sessions) ? residue.sessions : []
    const sessions = rows
      .filter((row) => typeof row?.sessionId === 'string')
      .map((row) => ({ sessionId: row.sessionId, intent: 'mount', epoch: 0, running: false, lastTurn: null, crash: true }))
    if (sessions.length === 0) return null
    return {
      version: 3, // ui-copy-ignore
      planId: planId ?? `crash-${Date.now().toString(36)}`,
      status: 'paused', // ui-copy-ignore
      source: 'crash', // ui-copy-ignore
      createdAt: new Date(Number.isFinite(residue.at) ? residue.at : Date.now()).toISOString(),
      sessions,
      goals: [], // ui-copy-ignore
      jobs: [], // ui-copy-ignore
      attention: [], // ui-copy-ignore
      crashes: sessions.length, // ui-copy-ignore
    }
  }

  return {
    live,
    stop,
    restoreSession,
    restoreGoal,
    restoreSchedule: async () => ({ status: 'skipped', detail: 'no schedules' }),
    crashPlan,
  }
}
