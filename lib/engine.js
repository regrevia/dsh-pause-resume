/**
 * The only place the button's shape comes from.
 *
 * One phase value, written before any work starts and after it ends, plus a durable snapshot. The
 * two transient phases are exclusive by construction: `pause()` and `resume()` refuse while either
 * is set, so two windows, a double press and a tool call can never overlap. The client is not
 * allowed to infer a phase: it asks, and renders the answer.
 *
 * The engine performs no I/O of its own. `store` persists, `probe` reads and acts on the running
 * Harness, so every transition here is testable without a Harness.
 */

const TRANSIENT = new Set(['pausing', 'resuming'])

export function createEngine({ store, probe, now = () => Date.now(), graceMs = 2000, gapMs = 150, log = () => {} }) {
  let phase = 'idle'
  let lastError = null
  let result = null
  /** Set while a press runs, so a second caller joins the answer instead of starting work again. */
  let inflight = null

  const emptyLive = { sessions: [], goals: [], schedules: [], jobs: [], terminals: [] }

  function pendingSnapshot() {
    const snapshot = store.read()
    // `pausing` is included on purpose: it means the last press stopped halfway, so the work in it
    // still has to be restored. Reporting it as nothing to restore would hide a half-done pause.
    return snapshot
  }

  async function live() {
    try {
      const value = await probe.live()
      return { ...emptyLive, ...(value ?? {}) }
    } catch (error) {
      log(`cannot read live work: ${error?.message ?? error}`)
      return emptyLive
    }
  }

  async function crashPlan() {
    try {
      const plan = await probe.crashPlan()
      return plan ?? null
    } catch (error) {
      log(`cannot read crash residue: ${error?.message ?? error}`)
      return null
    }
  }

  function countsOf(plan) {
    if (plan === null || plan === undefined) return { sessions: 0, goals: 0, schedules: 0, jobs: 0 }
    return {
      sessions: Array.isArray(plan.sessions) ? plan.sessions.length : 0,
      goals: Array.isArray(plan.goals) ? plan.goals.length : 0,
      schedules: Array.isArray(plan.schedules) ? plan.schedules.length : 0,
      jobs: Array.isArray(plan.jobs) ? plan.jobs.length : 0,
    }
  }

  /**
   * What the button shows. `action` is the one decision the client may not make itself:
   * `none` (nothing to do), `pause`, `resume`, or `busy` (an operation is running).
   */
  async function describe() {
    const snapshot = pendingSnapshot()
    const current = await live()
    const plan = snapshot ?? (await crashPlan())
    const busy = TRANSIENT.has(phase)
    const canPause = !busy && current.sessions.length + current.goals.length > 0
    const action = busy ? 'busy' : plan !== null ? 'resume' : canPause ? 'pause' : 'none'
    return {
      phase,
      action,
      source: plan === null ? null : plan.status === 'pausing' ? 'crash' : snapshot !== null ? 'pause' : plan.source ?? 'crash',
      complete: plan === null ? null : plan.status === 'paused',
      counts: countsOf(plan), // ui-copy-ignore
      live: { // ui-copy-ignore
        sessions: current.sessions.length,
        goals: current.goals.length,
        jobs: current.jobs.length,
      },
      error: lastError, // ui-copy-ignore
      result,
    }
  }

  function snapshotOf(current) {
    return {
      version: 1, // ui-copy-ignore
      status: 'pausing', // ui-copy-ignore
      createdAt: new Date(now()).toISOString(),
      sessions: current.sessions, // ui-copy-ignore
      goals: current.goals, // ui-copy-ignore
      schedules: current.schedules,
      jobs: current.jobs, // ui-copy-ignore
      terminals: current.terminals,
    }
  }

  async function runPause() {
    const current = await live()
    if (current.sessions.length === 0 && current.goals.length === 0) {
      phase = 'idle'
      return { status: 'idle', action: 'none' }
    }
    lastError = null
    // The snapshot exists before anything is stopped: a crash between the two is then visible as
    // `pausing` on the next boot instead of being reported as a clean pause.
    const draft = snapshotOf(current)
    if (store.write(draft) === null) {
      phase = 'idle'
      lastError = 'store'
      return { status: 'failed', reason: 'store' }
    }
    let stopped = null
    try {
      stopped = await probe.stop(current, { graceMs })
    } catch (error) {
      log(`stopping work failed: ${error?.message ?? error}`)
      stopped = { canceled: [], unknown: [] }
    }
    draft.status = 'paused'
    draft.stoppedAt = new Date(now()).toISOString()
    draft.stopped = stopped
    if (store.write(draft) === null) {
      // The durable copy still says `pausing`, which is the truth: the next boot reports it.
      lastError = 'store'
    }
    phase = 'paused'
    const counts = countsOf(draft)
    return { status: 'paused', counts }
  }

  async function runResume(plan) {
    lastError = null
    const done = store.readJournal()
    const summary = { restored: [], skipped: [], failed: [], jobs: countsOf(plan).jobs }
    const mark = (key) => {
      store.appendJournal(key)
      done.add(key)
    }
    const step = async (key, label, run) => {
      if (done.has(key)) return
      try {
        const outcome = await run()
        if (outcome === 'restored') summary.restored.push(label)
        else summary.skipped.push(label)
      } catch (error) {
        summary.failed.push(`${label}: ${String(error?.message ?? error).slice(0, 120)}`)
      }
      mark(key)
    }

    for (const session of plan.sessions ?? []) {
      await step(`s:${session.sessionId}`, `session ${session.sessionId}`, () => probe.restoreSession(session, { plan }))
    }
    for (const goal of plan.goals ?? []) {
      await step(`g:${goal.goalId ?? goal.sessionId}`, `goal ${goal.goalId ?? goal.sessionId}`, () => probe.restoreGoal(goal, { plan }))
    }
    for (const schedule of plan.schedules ?? []) {
      await step(`c:${schedule.id}`, `schedule ${schedule.id}`, () => probe.restoreSchedule(schedule, { plan }))
    }
    store.consume(summary)
    store.clearJournal()
    result = summary
    phase = 'idle'
    return { status: 'resumed', summary }
  }

  /** Join a press already running: the second caller is told it is busy and never starts work again. */
  function once(kind, run) {
    if (inflight !== null) return Promise.resolve({ status: 'busy', phase })
    const running = (async () => {
      try {
        return await run()
      } catch (error) {
        log(`${kind} failed: ${error?.message ?? error}`)
        lastError = 'internal'
        phase = 'idle'
        return { status: 'failed', reason: 'internal' }
      } finally {
        inflight = null
      }
    })()
    inflight = running
    return running
  }

  async function pause() {
    if (TRANSIENT.has(phase) || inflight !== null) return { status: 'busy', phase }
    if (phase === 'paused') return { status: 'already' }
    // Set synchronously, before the first await: two windows pressing at once are then exclusive
    // in the same tick they were dispatched, not one microtask later.
    phase = 'pausing'
    return once('pause', runPause)
  }

  async function resume() {
    if (TRANSIENT.has(phase) || inflight !== null) return { status: 'busy', phase }
    phase = 'resuming'
    return once('resume', async () => {
      const plan = pendingSnapshot() ?? (await crashPlan())
      if (plan === null) {
        phase = 'idle'
        return { status: 'empty' }
      }
      return runResume(plan)
    })
  }

  /** A reload of this plugin must not invent a phase: the disk and the running Harness decide it. */
  async function hydrate() {
    // A reloaded plugin must not invent a phase: the disk decides whether work is still stopped.
    phase = pendingSnapshot() !== null ? 'paused' : 'idle'
  }

  return { describe, pause, resume, hydrate, get phase() { return phase }, pendingSnapshot, gapMs }
}
