/**
 * The only place the button's shape comes from.
 *
 * One phase value, written before any work starts and after it ends, plus a durable plan. The two
 * transient phases are exclusive by construction: `pause()` and `resume()` refuse while either is
 * set, so two windows, a double press and a tool call can never overlap. The client is not allowed
 * to infer a phase: it asks, and renders the answer.
 *
 * A plan is kept until every item in it has a terminal outcome. A restore that could not put one
 * session back keeps the plan and the journal, so the next press retries exactly the missing item
 * instead of replaying the whole pause.
 *
 * The engine performs no I/O of its own. `store` persists, `probe` reads and acts on the running
 * Harness, so every transition here is testable without a Harness.
 */

const TRANSIENT = new Set(['pausing', 'resuming'])
const TERMINAL = new Set(['restored', 'skipped', 'attention'])

export function createEngine({ store, probe, heartbeat = null, now = () => Date.now(), graceMs = 2000, log = () => {} }) {
  let phase = 'idle'
  let lastError = null
  let result = null
  /** Set while a press runs, so a second caller joins the answer instead of starting work again. */
  let inflight = null
  /** The crash plan is derived once per boot: its id must not move between two polls. */
  let crash = null
  let crashRead = false
  let counter = 0

  function newPlanId(kind) {
    counter += 1
    return `${kind}-${now().toString(36)}-${counter.toString(36)}`
  }

  function pendingPlan() {
    return store.read()
  }

  function readCrash() {
    if (crashRead) return crash
    crashRead = true
    try {
      const residue = heartbeat?.residue ?? null
      // The id is derived from the residue itself: two polls of the same crash share one journal,
      // and a different crash gets its own.
      const at = Number.isFinite(residue?.at) ? residue.at : 0
      const count = Array.isArray(residue?.sessions) ? residue.sessions.length : 0
      crash = probe.crashPlan(residue, { planId: `crash-${at}-${count}` })
    } catch (error) {
      log(`cannot read crash residue: ${error?.message ?? error}`)
      crash = null
    }
    return crash
  }

  function currentPlan() {
    return pendingPlan() ?? readCrash()
  }

  function itemKeys(plan) {
    if (plan === null || plan === undefined) return []
    const keys = []
    for (const session of plan.sessions ?? []) if (typeof session?.sessionId === 'string') keys.push(`s:${session.sessionId}`)
    for (const goal of plan.goals ?? []) keys.push(`g:${goal.sessionId}:${goal.goalId ?? ''}`)
    return keys
  }

  function outstandingOf(plan) {
    if (plan === null || plan === undefined) return 0
    const done = store.readJournal(plan.planId)
    return itemKeys(plan).filter((key) => !done.has(key)).length
  }

  function countsOf(plan) {
    if (plan === null || plan === undefined) return { sessions: 0, goals: 0, jobs: 0 }
    return {
      sessions: Array.isArray(plan.sessions) ? plan.sessions.length : 0,
      goals: Array.isArray(plan.goals) ? plan.goals.length : 0,
      jobs: Array.isArray(plan.jobs) ? plan.jobs.length : 0,
    }
  }

  function liveNow() {
    try {
      const value = probe.live()
      return value ?? { sessions: [], goals: [], jobs: [], readable: false, source: 'none' }
    } catch (error) {
      log(`cannot read live work: ${error?.message ?? error}`)
      return { sessions: [], goals: [], jobs: [], readable: false, source: 'none' }
    }
  }

  /**
   * What the button shows. `action` is the one decision the client may not make itself:
   * `none` (nothing to do), `pause`, `resume`, or `busy` (an operation is running).
   */
  function describe() {
    const plan = currentPlan()
    const current = liveNow()
    const busy = TRANSIENT.has(phase)
    const work = workOf(current)
    const canPause = current.readable === true && work.sessions.length + work.goals.length + work.jobs.length > 0
    const action = busy ? 'busy' : plan !== null ? 'resume' : canPause ? 'pause' : 'none'
    const outstanding = outstandingOf(plan)
    return {
      phase,
      action,
      source: plan === null ? null : plan.source ?? 'pause',
      // A finished pause is complete even though every item still has to be restored later.
      complete: plan === null ? null : plan.status === 'paused' && lastError === null,
      outstanding: outstanding, // ui-copy-ignore
      counts: countsOf(plan), // ui-copy-ignore
      live: { // ui-copy-ignore
        sessions: work.sessions.filter((session) => session.running === true).length,
        goals: current.goals.length,
        jobs: current.jobs.length,
      },
      attention: Array.isArray(plan?.attention) ? plan.attention.length : 0, // ui-copy-ignore
      error: lastError ?? (plan?.status === 'pausing' ? 'pause-interrupted' : null), // ui-copy-ignore
      result,
    }
  }

  /**
   * Only work that was actually stopped goes into the plan: a session whose turn was open, or a
   * session that carries an armed goal. A session that ended normally is left alone, however it
   * happens to look in the session list.
   */
  function workOf(current) {
    const sessions = new Map()
    for (const session of current.sessions ?? []) {
      if (session.running === true) sessions.set(session.sessionId, session)
    }
    for (const goal of current.goals ?? []) {
      if (!sessions.has(goal.sessionId)) sessions.set(goal.sessionId, { sessionId: goal.sessionId, running: false, lastTurn: null })
    }
    return {
      sessions: [...sessions.values()],
      goals: current.goals ?? [],
      jobs: current.jobs ?? [], // ui-copy-ignore
    }
  }

  function planOf(current, { planId, status }) {
    return {
      version: 2, // ui-copy-ignore
      planId,
      status,
      source: 'pause', // ui-copy-ignore
      createdAt: new Date(now()).toISOString(),
      sessions: workOf(current).sessions.map((session) => ({
        sessionId: session.sessionId,
        running: session.running === true,
        lastTurn: Number.isSafeInteger(session.lastTurn) ? session.lastTurn : null,
      })),
      goals: workOf(current).goals.map((goal) => ({
        sessionId: goal.sessionId,
        goalId: goal.goalId,
        revision: goal.revision,
      })),
      jobs: workOf(current).jobs.map((job) => ({ id: job.id, owner: job.owner ?? null, status: job.status ?? null })),
    }
  }

  async function runPause() {
    const current = liveNow()
    if (current.readable !== true) {
      phase = 'idle'
      lastError = 'registry'
      return { status: 'failed', reason: 'registry' }
    }
    const work = workOf(current)
    if (work.sessions.length + work.goals.length + work.jobs.length === 0) {
      phase = 'idle'
      return { status: 'idle', action: 'none' }
    }
    lastError = null
    // The plan exists before anything is stopped: a crash between the two is then visible as
    // `pausing` on the next boot instead of being reported as a clean pause.
    const draft = planOf(current, { planId: newPlanId('pause'), status: 'pausing' })
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
      stopped = { canceled: [], unknown: [], pausedGoals: [], goalErrors: [], killedJobs: [], jobErrors: [], stillRunning: [] }
    }

    // Only goals that really stopped are part of the plan. Resuming a goal nobody paused would bump
    // its revision for no reason and could override the person's own pause; a goal that failed to
    // pause is reported instead and left alone.
    // A cancelled turn bumps the agent's turn counter, so the baseline has to be read after the
    // stop, not before it. Without this a restore would mistake its own cancelled turn for work
    // the person continued by hand and skip the continuation it was asked to send.
    const baseline = new Map((stopped.sessions ?? []).map((session) => [session.sessionId, session.lastTurn]))
    draft.sessions = draft.sessions.map((session) => baseline.has(session.sessionId)
      ? { ...session, lastTurn: Number.isSafeInteger(baseline.get(session.sessionId)) ? baseline.get(session.sessionId) : null }
      : session)
    draft.goals = (stopped.pausedGoals ?? []).map((goal) => ({
      sessionId: goal.sessionId,
      goalId: goal.goalId,
      revision: goal.pausedRevision,
    }))
    draft.status = 'paused'
    draft.stoppedAt = new Date(now()).toISOString()
    draft.stopped = {
      canceled: stopped.canceled ?? [],
      unknown: stopped.unknown ?? [],
      stillRunning: stopped.stillRunning ?? [],
      goalErrors: stopped.goalErrors ?? [],
      killedJobs: stopped.killedJobs ?? [],
      jobErrors: stopped.jobErrors ?? [],
    }
    draft.attention = [
      ...(stopped.stillRunning ?? []).map((id) => ({ kind: 'session', id, detail: 'still running' })),
      ...(stopped.goalErrors ?? []).map((detail) => ({ kind: 'goal', id: '', detail })),
      ...(stopped.jobErrors ?? []).map((detail) => ({ kind: 'job', id: '', detail })),
    ]
    if (store.write(draft) === null) {
      // The durable copy still says `pausing`, which is the truth: the next boot reports it.
      lastError = 'store'
    }
    phase = 'paused'
    return { status: 'paused', counts: countsOf(draft), outstanding: outstandingOf(draft) }
  }

  function summaryOf() {
    return { restored: [], skipped: [], failed: [], attention: [], jobs: 0, at: new Date(now()).toISOString() }
  }

  /**
   * One restore pass. Every item that ends in a terminal outcome is journaled, so a later press
   * only walks what is left. A retryable failure keeps the plan; a durable write failure keeps it
   * too, because the archive is the record that the work came back.
   */
  async function runResume(plan) {
    lastError = null
    // A crash in the middle of a pause left a plan that never finished stopping. Its sessions were
    // still turning when the process died, so mounting them is safe but continuing them is not: the
    // person asked for silence, not another round.
    if (plan.status === 'pausing') {
      plan.source = 'interrupted'
      plan.attention = [...(plan.attention ?? []), { kind: 'pause', id: '', detail: 'pause interrupted' }]
      plan.sessions = (plan.sessions ?? []).map((session) => ({ ...session, running: false, lastTurn: null }))
      plan.status = 'paused'
    }
    const summary = summaryOf()
    summary.jobs = countsOf(plan).jobs
    const done = store.readJournal(plan.planId)
    const record = (key) => {
      done.add(key)
      store.appendJournal(plan.planId, key)
    }
    const step = async (key, label, run) => {
      if (done.has(key)) return
      let outcome
      try {
        outcome = await run()
      } catch (error) {
        outcome = { status: 'failed', detail: String(error?.message ?? error).slice(0, 120) }
      }
      const status = typeof outcome?.status === 'string' ? outcome.status : 'failed'
      if (TERMINAL.has(status)) {
        record(key)
        if (status === 'restored') summary.restored.push(label)
        else if (status === 'skipped') summary.skipped.push(label)
        else {
          summary.attention.push(`${label}: ${outcome?.detail ?? 'needs a look'}`)
          plan.attention = [...(plan.attention ?? []), { kind: 'session', id: label, detail: String(outcome?.detail ?? '') }]
        }
      } else {
        summary.failed.push(`${label}: ${outcome?.detail ?? 'unknown'}`)
      }
    }

    for (const session of plan.sessions ?? []) {
      await step(`s:${session.sessionId}`, `session ${session.sessionId}`, () => probe.restoreSession(session, { plan }))
    }
    for (const goal of plan.goals ?? []) {
      const key = `g:${goal.sessionId}:${goal.goalId ?? ''}`
      await step(key, `goal ${goal.goalId ?? goal.sessionId}`, () => probe.restoreGoal(goal, { plan }))
    }
    // A killed job cannot be replayed: the same command may have had an unknown effect, so it is
    // reported once and left to the person. It is not a retryable item and never blocks the plan.
    for (const job of plan.jobs ?? []) summary.attention.push(`job ${job.id}: stopped, not restarted`)

    result = summary
    const failed = summary.failed.length > 0
    const pending = itemKeys(plan).filter((key) => !done.has(key))
    if (failed || pending.length > 0) {
      plan.restore = { at: summary.at, attempts: (plan.restore?.attempts ?? 0) + 1, failed: summary.failed } // ui-copy-ignore
      if (store.write(plan) === null) lastError = 'store'
      else lastError = 'restore-partial'
      phase = 'paused'
      return { status: 'partial', summary, outstanding: pending.length }
    }

    const consumed = store.consume(plan, summary)
    if (!consumed?.ok) {
      lastError = 'store'
      phase = 'paused'
      return { status: 'partial', summary, outstanding: 0 }
    }
    store.clearJournal(plan.planId)
    if (plan.source === 'crash') {
      crash = null
      try {
        heartbeat?.release?.()
      } catch (error) {
        log(`cannot release crash record: ${error?.message ?? error}`)
      }
    }
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
        phase = pendingPlan() === null ? 'idle' : 'paused'
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
    if (pendingPlan() !== null) return { status: 'already', phase }
    // Set synchronously, before the first await: two windows pressing at once are then exclusive
    // in the same tick they were dispatched, not one microtask later.
    phase = 'pausing'
    return once('pause', runPause)
  }

  async function resume() {
    if (TRANSIENT.has(phase) || inflight !== null) return { status: 'busy', phase }
    phase = 'resuming'
    return once('resume', async () => {
      const plan = currentPlan()
      if (plan === null) {
        phase = 'idle'
        return { status: 'empty' }
      }
      return runResume(plan)
    })
  }

  /** A reload of this plugin must not invent a phase: the disk and the running Harness decide it. */
  async function hydrate() {
    crashRead = false
    crash = null
    readCrash()
    phase = pendingPlan() !== null ? 'paused' : 'idle'
    return phase
  }

  return {
    describe,
    pause,
    resume,
    hydrate,
    get phase() { return phase },
    get pendingPlan() { return pendingPlan },
    get crashPlan() { return readCrash },
  }
}
