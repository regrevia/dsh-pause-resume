/**
 * What the Harness is doing right now, and how to stop one piece of it without losing the pieces
 * behind it. Only service contracts are used here, and every service is reached through the
 * registry this module is given: one that is missing, or that answers nothing, is a smaller set of
 * work rather than a failed press.
 */

function service(services, key) {
  try {
    return services.get(key)
  } catch {
    return undefined
  }
}

function agentOf(services, sessionId) {
  const agents = service(services, 'agents')
  if (agents === undefined || agents === null || typeof agents.get !== 'function') return undefined
  try {
    const handle = agents.get(sessionId)
    if (handle === undefined || handle === null) return undefined
    return handle.agent ?? handle
  } catch {
    return undefined
  }
}

/**
 * Live agents are the cheap truth for "who is attached right now": a couple of dozen handles in
 * memory, against a listing that walks every session ever recorded on disk. It answers `undefined`
 * when the registry cannot be read, so the listing stays the fallback rather than a second opinion.
 */
function agentsOf(services) {
  const agents = service(services, 'agents')
  if (agents === undefined || agents === null || typeof agents.list !== 'function') return undefined
  try {
    const handles = agents.list()
    if (!Array.isArray(handles)) return undefined
    const live = handles.map((handle) => handle?.agent ?? handle).filter((agent) => agent !== null && typeof agent?.id === 'string')
    return live
  } catch {
    return undefined
  }
}

/** One row per attached agent: running says whether its turn is open, and every one is attached. */
async function attachedRows(services) {
  const agents = agentsOf(services)
  if (agents !== undefined) {
    return agents.map((agent) => ({ sessionId: agent.id, running: agent.status === 'running', agentAvailable: true }))
  }
  const rows = await listSessions(services)
  return rows.filter((row) => row.running === true || row.agentAvailable === true)
}

/** The session ids whose turn is open right now: the heartbeat's only question. */
export async function listRunning(services) {
  const agents = agentsOf(services)
  if (agents !== undefined) return agents.filter((agent) => agent.status === 'running').map((agent) => agent.id)
  const rows = await listSessions(services)
  return rows.filter((row) => row.running === true).map((row) => row.sessionId)
}

/**
 * The goal service addresses one live agent, and every agent it accepts names itself by session
 * id, so a session id is the whole handle. It throws for an agent that is not live: that is the
 * ordinary answer for a closed session, not an error worth surfacing.
 */
function goalAgent(sessionId) {
  return { id: sessionId }
}

async function goalOf(services, sessionId) {
  const goals = service(services, 'goals')
  if (goals === undefined || goals === null || typeof goals.get !== 'function') return undefined
  try {
    const view = await goals.get(goalAgent(sessionId))
    return view === undefined || view === null ? undefined : view
  } catch {
    return undefined
  }
}

/** The listing service answers `{ items }` through its remote facade and a bare array in tests. */
async function listSessions(services) {
  const controller = service(services, 'sessionController')
  if (controller === undefined || controller === null || typeof controller.list !== 'function') return []
  const value = await controller.list({})
  const rows = Array.isArray(value) ? value : value?.items ?? value?.sessions ?? []
  return rows.filter((row) => row !== null && typeof row?.sessionId === 'string')
}

/**
 * Owned jobs are invisible to a caller-less `list`, so every attached session is asked for its own
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

/**
 * The Harness half of the plugin: what is running now, how to stop it, how to put it back. Every
 * method answers `restored` / `skipped` rather than throwing, because one item that cannot be put
 * back must not stop the items behind it.
 */
export function createProbe(services, heartbeat) {
  const graceMs = 1500

  async function live() {
    const attached = await attachedRows(services)
    const views = await Promise.all(attached.map((row) => goalOf(services, row.sessionId)))
    const sessions = []
    const goals = []
    attached.forEach((row, index) => {
      const running = row.running === true
      const goal = views[index]
      const active = goal !== undefined && goal.phase === 'active'
      // A session is part of the work in two cases only: a turn is running, or a goal is armed and
      // can start one. A session the person merely has open is a tab, not work.
      if (running || active) sessions.push({ sessionId: row.sessionId, running })
      if (active) goals.push({ sessionId: row.sessionId, goalId: goal.id, revision: goal.revision })
    })
    const jobs = listJobs(services, attached.map((row) => row.sessionId))
      .filter((job) => job.status === 'running' || job.status === 'stopping')
      .map((job) => ({ id: job.id, label: job.label ?? job.kind ?? '', owner: job.owner }))
    return { sessions, goals, schedules: [], jobs, terminals: [] }
  }

  async function stop(current, { graceMs: grace } = {}) {
    const controller = service(services, 'sessionController')
    const goals = service(services, 'goals')
    const jobs = service(services, 'jobs')
    const canceled = []
    const unknown = []

    for (const session of current.sessions ?? []) {
      if (session.running !== true) continue
      try {
        controller?.cancel?.({ sessionId: session.sessionId })
        canceled.push(session.sessionId)
      } catch (error) {
        unknown.push(`session ${session.sessionId}: ${String(error?.message ?? error).slice(0, 80)}`)
      }
    }
    for (const goal of current.goals ?? []) {
      try {
        await goals?.pause?.(goalAgent(goal.sessionId), { id: goal.goalId, revision: goal.revision })
      } catch (error) {
        unknown.push(`goal ${goal.goalId}: ${String(error?.message ?? error).slice(0, 80)}`)
      }
    }
    for (const job of current.jobs ?? []) {
      try {
        jobs?.kill?.(job.id, job.owner)
      } catch {
        try {
          jobs?.kill?.(job.id)
        } catch (error) {
          unknown.push(`job ${job.id}: ${String(error?.message ?? error).slice(0, 80)}`)
        }
      }
    }

    // A turn ends when its tools return: the press waits a bounded moment for that instead of
    // claiming a stop that has not happened yet.
    const deadline = Date.now() + (grace ?? graceMs)
    let pending = current.sessions?.filter((session) => session.running === true).map((session) => session.sessionId) ?? []
    while (pending.length > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 80))
      const stillRunning = new Set(await listRunning(services).catch(() => []))
      pending = pending.filter((id) => stillRunning.has(id))
    }
    for (const id of pending) unknown.push(`session ${id}: still running`)
    return { canceled, unknown }
  }

  async function rearm(sessionId) {
    const goals = service(services, 'goals')
    const goal = await goalOf(services, sessionId)
    if (goal === undefined) return false
    if (goal.phase === 'active' && goal.activation !== 'armed') {
      goals?.resume?.(goalAgent(sessionId), { id: goal.id, revision: goal.revision })
      return true
    }
    return false
  }

  async function restoreSession(session) {
    const agents = service(services, 'agents')
    if (agents === undefined || agents === null || typeof agents.resume !== 'function') throw new Error('agents unavailable')
    if (agentOf(services, session.sessionId) !== undefined) return 'skipped'
    await agents.resume({ resumeSessionId: session.sessionId })
    await rearm(session.sessionId)
    return 'restored'
  }

  async function restoreGoal(goal) {
    const goals = service(services, 'goals')
    const view = await goalOf(services, goal.sessionId)
    if (view === undefined || view.id !== goal.goalId) return 'skipped'
    if (view.phase === 'active') return (await rearm(goal.sessionId)) ? 'restored' : 'skipped'
    // The revision is the person's veto: a goal they changed by hand is not resurrected.
    if (view.phase !== 'paused' || view.revision !== goal.revision) return 'skipped'
    goals?.resume?.(goalAgent(goal.sessionId), { id: view.id, revision: view.revision })
    return 'restored'
  }

  async function crashPlan() {
    const captured = heartbeat.residue
    if (captured === null) return null
    const rows = await listSessions(services)
    const existing = new Set(rows.map((row) => row.sessionId))
    const sessions = captured.sessions.filter((row) => existing.has(row.sessionId)).map((row) => ({ sessionId: row.sessionId, running: true }))
    if (sessions.length === 0) return null
    return { version: 1, status: 'paused', source: 'crash', sessions, goals: [], schedules: [], jobs: [], terminals: [] }
  }

  return { live, stop, restoreSession, restoreGoal, restoreSchedule: async () => 'skipped', crashPlan }
}
