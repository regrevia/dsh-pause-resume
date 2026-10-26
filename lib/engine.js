/**
 * The only place the button's shape comes from.
 *
 * One phase value, written before any work starts and after it ends, plus a durable plan. The two
 * transient phases are exclusive by construction: `pause()` and `resume()` refuse while either is
 * set, so two windows, a double press and a tool call can never overlap. The client is not allowed
 * to infer a phase: it asks, and renders the answer.
 *
 * `action` is state-derived, never phase-derived. Live work asks for a pause; a plan with no live
 * work asks for a resume; neither is `none`. That single rule is what makes a second press useful
 * after a failed pause, a partial stop, or a restart: the button does what the Harness still needs,
 * not what the last operation intended.
 *
 * A plan is kept until every item in it has a terminal outcome or a retryable failure. Attention
 * outcomes (a continuation that was admitted but never opened a turn, a job that cannot be
 * replayed) are terminal: they are carried into the last-restore record and shown as a dot, but
 * they never cause the same message to be delivered twice. The crash plan is written to disk
 * before the heartbeat overwrites the previous process's record, so a second or third restart
 * still sees the same pending work.
 */

const TRANSIENT = new Set(['pausing', 'resuming'])
const TERMINAL = new Set(['restored', 'skipped', 'attention'])

function emptyLive() {
  return { sessions: [], goals: [], jobs: [], readable: false, source: 'none' }
}

export function createEngine({ store, probe, heartbeat = null, bootId = 'boot', now = () => Date.now(), graceMs = 2000, log = () => {} }) {
  let phase = 'idle'
  let lastError = null
  let result = null
  /** Set while a press runs, so a second caller joins the answer instead of starting work again. */
  let inflight = null
  /** Crash plan kept in memory only when its durable write failed; a reload loses it, the file does not. */
  let crashFallback = null
  let counter = 0

  function newPlanId(kind) {
    counter += 1
    return `${kind}-${now().toString(36)}-${counter.toString(36)}`
  }

  function pausedPlan() {
    return store.read()
  }

  function crashPlan() {
    const stored = typeof store.readPending === 'function' ? store.readPending() : null
    return stored ?? crashFallback
  }

  /** Exactly one plan is pending, and a finished pause outranks a leftover crash record. */
  function currentPlan() {
    return pausedPlan() ?? crashPlan()
  }

  function isCrashPlan(plan) {
    return plan !== null && plan !== undefined && plan.source === 'crash'
  }

  function itemKeys(plan) {
    if (plan === null || plan === undefined) return []
    const keys = []
    for (const session of plan.sessions ?? []) if (typeof session?.sessionId === 'string') keys.push(`s:${session.sessionId}`)
    for (const goal of plan.goals ?? []) keys.push(`g:${goal.sessionId}:${goal.goalId ?? ''}`)
    return keys
  }

  /**
   * Rows written by an earlier process are evidence, not permission to skip: a new process must
   * check the live Harness again. Only this boot's rows reduce what is still outstanding.
   */
  function outstandingOf(plan) {
    if (plan === null || plan === undefined) return 0
    const rows = store.readJournal(plan.planId)
    return itemKeys(plan).filter((key) => {
      const row = rows.get(key)
      return row === undefined || (row.boot !== null && row.boot !== bootId)
    }).length
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
      return probe.live() ?? emptyLive()
    } catch (error) {
      log(`cannot read live work: ${error?.message ?? error}`)
      return emptyLive()
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

  function liveWorkCount(work) {
    return work.sessions.length + work.goals.length + work.jobs.length
  }

  /**
   * What the button shows. `action` is the one decision the client may not make itself:
   * `none` (nothing to do), `pause`, `resume`, or `busy` (an operation is running).
   */
  function describe() {
    const plan = currentPlan()
    const current = liveNow()
    const work = workOf(current)
    const busy = TRANSIENT.has(phase)
    const workCount = liveWorkCount(work)
    let action = 'none'
    if (busy) action = 'busy'
    else if (current.readable === true && workCount > 0) action = 'pause'
    else if (plan !== null) action = 'resume'
    const attention = plan !== null
      ? (Array.isArray(plan.attention) ? plan.attention.length : 0)
      : (Array.isArray(result?.attention) ? result.attention.length : 0)
    return {
      phase,
      action,
      source: plan === null ? null : plan.source ?? 'pause',
      // `complete` means the stop finished and nothing is still turning. A partial stop is not.
      complete: plan === null ? null : plan.status !== 'partial' && plan.status !== 'pausing' && lastError !== 'store',
      outstanding: outstandingOf(plan), // ui-copy-ignore
      counts: countsOf(plan), // ui-copy-ignore
      live: { // ui-copy-ignore
        sessions: work.sessions.filter((session) => session.running === true).length,
        goals: current.goals.length,
        jobs: current.jobs.length,
      },
      attention,
      error: lastError ?? (plan?.status === 'pausing' ? 'pause-interrupted' : plan?.status === 'partial' ? 'pause-partial' : null), // ui-copy-ignore
      result,
    }
  }

  function freshSession(session) {
    return {
      sessionId: session.sessionId,
      running: session.running === true,
      lastTurn: Number.isSafeInteger(session.lastTurn) ? session.lastTurn : null,
    }
  }

  function freshGoal(goal) {
    return { sessionId: goal.sessionId, goalId: goal.goalId, revision: goal.revision }
  }

  function freshJob(job) {
    return { id: job.id, owner: job.owner ?? null, status: job.status ?? null }
  }

  function unionSessions(base, additions) {
    const out = []
    const index = new Map()
    for (const row of [...base, ...additions]) {
      if (typeof row?.sessionId !== 'string') continue
      const existing = index.get(row.sessionId)
      if (existing !== undefined) {
        // Stopping again refreshes the baseline; a plain union would keep a stale turn number.
        if (Number.isSafeInteger(row.lastTurn)) existing.lastTurn = row.lastTurn
        if (row.running === false) existing.running = false
        continue
      }
      const copy = { ...row }
      index.set(copy.sessionId, copy)
      out.push(copy)
    }
    return out
  }

  function unionById(base, additions, idOf) {
    const out = []
    const seen = new Set()
    for (const row of [...base, ...additions]) {
      const id = idOf(row)
      if (typeof id !== 'string' || id === '' || seen.has(id)) continue
      seen.add(id)
      out.push(row)
    }
    return out
  }

  function persist(plan) {
    if (isCrashPlan(plan) === true) {
      const stored = store.writePending(plan)
      if (stored !== null) crashFallback = null
      return stored
    }
    return store.write(plan)
  }

  /**
   * Pause, including the second attempt after a partial stop. Capture happens before anything is
   * stopped, and the plan is durable before the first cancellation, so a crash in between is
   * visible as an interrupted pause instead of a clean one.
   */
  async function runPause(basePlan) {
    const current = liveNow()
    const work = workOf(current)
    if (current.readable !== true) {
      phase = basePlan === null ? 'idle' : 'paused'
      lastError = 'registry'
      return { status: 'failed', reason: 'registry' }
    }
    if (liveWorkCount(work) === 0) {
      phase = basePlan === null ? 'idle' : 'paused'
      return basePlan === null ? { status: 'idle', action: 'none' } : { status: 'already', phase }
    }
    lastError = null
    const plan = basePlan === null
      ? {
        version: 3, // ui-copy-ignore
        planId: newPlanId('pause'),
        status: 'pausing', // ui-copy-ignore
        source: 'pause', // ui-copy-ignore
        createdAt: new Date(now()).toISOString(),
        sessions: [], // ui-copy-ignore
        goals: [], // ui-copy-ignore
        jobs: [], // ui-copy-ignore
        attention: [], // ui-copy-ignore
      }
      : { ...basePlan, status: 'pausing', attention: Array.isArray(basePlan.attention) ? basePlan.attention : [] }
    plan.sessions = unionSessions(plan.sessions ?? [], work.sessions.map(freshSession))
    plan.goals = unionById(plan.goals ?? [], work.goals.map(freshGoal), (goal) => `${goal?.sessionId}:${goal?.goalId}`)
    plan.jobs = unionById(plan.jobs ?? [], work.jobs.map(freshJob), (job) => job?.id)
    if (persist(plan) === null) {
      // Nothing was stopped: the state is exactly what it was before the press.
      phase = basePlan === null ? 'idle' : 'paused'
      lastError = 'store'
      return { status: 'failed', reason: 'store' }
    }

    let stopped = null
    try {
      stopped = await probe.stop(current, { graceMs })
    } catch (error) {
      log(`stopping work failed: ${error?.message ?? error}`)
      stopped = { canceled: [], unknown: [], pausedGoals: [], goalErrors: [], killedJobs: [], jobErrors: [], stillRunning: [], sessions: [] }
    }

    // A cancelled turn bumps the agent's turn counter, so the baseline is read after the stop.
    // Without this a restore would mistake its own cancelled turn for work the person continued.
    const baseline = new Map((stopped.sessions ?? []).map((session) => [session.sessionId, session.lastTurn]))
    plan.sessions = plan.sessions.map((session) => baseline.has(session.sessionId)
      ? { ...session, lastTurn: Number.isSafeInteger(baseline.get(session.sessionId)) ? baseline.get(session.sessionId) : session.lastTurn }
      : session)
    // A goal that could not be paused is not in the plan: resuming it would bump a revision for no
    // reason. It is reported instead, and the person can pause again after fixing whatever blocked it.
    const pausedGoals = (stopped.pausedGoals ?? []).map((goal) => ({
      sessionId: goal.sessionId,
      goalId: goal.goalId,
      revision: goal.pausedRevision,
    }))
    const keptGoals = (plan.goals ?? []).filter((goal) => !(stopped.pausedGoals ?? []).some((row) => row.sessionId === goal.sessionId && row.goalId === goal.goalId))
    plan.goals = [...keptGoals, ...pausedGoals]
    const stillRunning = stopped.stillRunning ?? []
    plan.status = stillRunning.length > 0 ? 'partial' : 'paused'
    plan.stoppedAt = new Date(now()).toISOString()
    plan.stopped = {
      canceled: stopped.canceled ?? [],
      unknown: stopped.unknown ?? [],
      stillRunning,
      goalErrors: stopped.goalErrors ?? [],
      killedJobs: stopped.killedJobs ?? [],
      jobErrors: stopped.jobErrors ?? [],
    }
    plan.attention = [
      ...(Array.isArray(basePlan?.attention) ? basePlan.attention : []),
      ...stillRunning.map((id) => ({ kind: 'session', id, detail: 'still running' })),
      ...(stopped.goalErrors ?? []).map((detail) => ({ kind: 'goal', id: '', detail })),
      ...(stopped.jobErrors ?? []).map((detail) => ({ kind: 'job', id: '', detail })),
    ]
    if (isCrashPlan(basePlan) === true) {
      // The crash record described work that was not paused. This press did pause it, so the plan
      // becomes a normal pause plan and the crash evidence is no longer a separate obligation.
      plan.source = 'pause' // ui-copy-ignore
      if (store.write(plan) === null) {
        const kept = store.writePending(plan)
        if (kept === null) {
          crashFallback = plan
          lastError = 'store'
        }
      } else if (typeof store.clearPending === 'function') {
        if (store.clearPending() === false) lastError = 'store'
      }
      crashFallback = null
    } else if (store.write(plan) === null) {
      // The durable copy still says `pausing` or `paused`: the next boot reports it instead of
      // claiming a stop that was never written.
      lastError = 'store'
    }
    phase = 'paused'
    return { status: plan.status === 'partial' ? 'partial' : 'paused', counts: countsOf(plan), outstanding: outstandingOf(plan) }
  }

  function summaryOf(plan) {
    return { planId: plan.planId, source: plan.source ?? 'pause', restored: [], skipped: [], failed: [], attention: [], jobs: 0, at: new Date(now()).toISOString() }
  }

  /**
   * One restore pass. Items are not skipped from the journal: the live Harness decides whether a
   * session is already back, which is the only answer that survives a second process, a manual
   * resume, or a reload. A retryable failure keeps the plan; attention outcomes are terminal.
   */
  async function runResume(plan) {
    lastError = null
    // A crash in the middle of a pause left a plan that never finished stopping. Mounting is safe;
    // continuing is not, because the person asked for silence and the turn may have died mid-way.
    if (plan.status === 'pausing') {
      plan.source = plan.source === 'crash' ? 'crash' : 'interrupted'
      plan.attention = [...(plan.attention ?? []), { kind: 'pause', id: '', detail: 'pause interrupted' }]
      plan.sessions = (plan.sessions ?? []).map((session) => ({ ...session, running: false, lastTurn: null }))
      plan.status = 'paused'
      if (persist(plan) === null) {
        phase = 'paused'
        lastError = 'store'
        return { status: 'partial', summary: null, outstanding: outstandingOf(plan) }
      }
    }
    const summary = summaryOf(plan)
    summary.jobs = countsOf(plan).jobs
    const record = (key, status) => {
      if (store.appendJournal(plan.planId, key, status, bootId) === false) {
        // Reporting only: the restore already happened, so this never blocks the plan. It does mean
        // a later boot counts the item as outstanding and checks it again, which is safe.
        log(`cannot journal ${key}`)
      }
    }
    const step = async (key, label, run) => {
      let outcome
      try {
        outcome = await run()
      } catch (error) {
        outcome = { status: 'failed', detail: String(error?.message ?? error).slice(0, 120) }
      }
      const status = typeof outcome?.status === 'string' ? outcome.status : 'failed'
      if (TERMINAL.has(status) === false) {
        summary.failed.push(`${label}: ${outcome?.detail ?? 'unknown'}`)
        return
      }
      record(key, status)
      if (status === 'restored') summary.restored.push(label)
      else if (status === 'skipped') summary.skipped.push(label)
      else summary.attention.push(`${label}: ${outcome?.detail ?? 'needs a look'}`)
    }

    for (const session of plan.sessions ?? []) {
      await step(`s:${session.sessionId}`, `session ${session.sessionId}`, () => probe.restoreSession(session, { plan }))
    }
    for (const goal of plan.goals ?? []) {
      await step(`g:${goal.sessionId}:${goal.goalId ?? ''}`, `goal ${goal.goalId ?? goal.sessionId}`, () => probe.restoreGoal(goal, { plan }))
    }
    // A killed job cannot be replayed: the same command may have had an unknown effect, so it is
    // reported once and left to the person. It never blocks the plan and is never restarted.
    for (const job of plan.jobs ?? []) summary.attention.push(`job ${job.id}: stopped, not restarted`)

    result = summary
    if (summary.failed.length > 0) {
      plan.restore = { at: summary.at, attempts: (plan.restore?.attempts ?? 0) + 1, failed: summary.failed } // ui-copy-ignore
      if (persist(plan) === null) lastError = 'store'
      else lastError = 'restore-partial'
      phase = 'paused'
      return { status: 'partial', summary, outstanding: outstandingOf(plan) }
    }

    if (isCrashPlan(plan) === true) {
      if (typeof store.writeResult === 'function' && store.writeResult({ ...plan, status: 'restored', restoredAt: summary.at, summary }) === false) {
        lastError = 'store'
        phase = 'paused'
        return { status: 'partial', summary, outstanding: 0 }
      }
      if (typeof store.clearPending !== 'function' || store.clearPending() === false) {
        lastError = 'store'
        phase = 'paused'
        return { status: 'partial', summary, outstanding: 0 }
      }
      crashFallback = null
      if (typeof store.clearJournal === 'function') store.clearJournal(plan.planId)
      try {
        heartbeat?.release?.()
      } catch (error) {
        log(`cannot release crash record: ${error?.message ?? error}`)
      }
    } else {
      const consumed = store.consume(plan, summary)
      if (!consumed?.ok) {
        lastError = 'store'
        phase = 'paused'
        return { status: 'partial', summary, outstanding: 0 }
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
        phase = currentPlan() === null ? 'idle' : 'paused'
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
    const plan = currentPlan()
    if (plan !== null) {
      const work = workOf(liveNow())
      if (liveWorkCount(work) === 0) return { status: 'already', phase }
    }
    // Set synchronously, before the first await: two windows pressing at once are then exclusive
    // in the same tick they were dispatched, not one microtask later.
    phase = 'pausing'
    return once('pause', () => runPause(plan))
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

  /**
   * A reload or restart must not invent a phase: the disk and the running Harness decide it. The
   * crash residue is handed in by the caller, because it has to be read before the heartbeat
   * overwrites the previous process's file; it is persisted here so a second restart still sees it.
   */
  async function hydrate(options = {}) {
    crashFallback = null
    const residue = options?.residue ?? heartbeat?.residue ?? null
    if (residue !== null && residue !== undefined && pausedPlan() === null && crashPlan() === null) {
      let plan = null
      try {
        plan = probe.crashPlan(residue, { planId: `crash-${Number.isFinite(residue.at) ? residue.at : 0}-${Array.isArray(residue.sessions) ? residue.sessions.length : 0}` })
      } catch (error) {
        log(`cannot derive crash plan: ${error?.message ?? error}`)
      }
      if (plan !== null) {
        const stored = typeof store.writePending === 'function' ? store.writePending(plan) : null
        // A failed write keeps the plan in memory so this process can still restore it; only the
        // next restart loses it.
        crashFallback = stored ?? plan
        log('crash plan recorded')
      }
    }
    const restored = typeof store.lastRestore === 'function' ? store.lastRestore() : null
    result = restored !== null && typeof restored === 'object' ? (restored.summary ?? null) : null
    phase = pausedPlan() !== null ? 'paused' : 'idle'
    lastError = null
    return phase
  }

  return {
    describe,
    pause,
    resume,
    hydrate,
    get phase() { return phase },
    get pendingPlan() { return currentPlan },
    get crashPlan() { return crashPlan },
  }
}
