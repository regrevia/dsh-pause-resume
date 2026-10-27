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

import { currentEpoch } from './epoch.js'

const TRANSIENT = new Set(['pausing', 'resuming'])
const TERMINAL = new Set(['restored', 'skipped', 'attention'])

function emptyLive() {
  return { sessions: [], goals: [], jobs: [], readable: false, source: 'none' }
}

/** One id for the hint: a restore attention row is either a label or a plan row. */
function labelFocus(text) {
  const match = /^(?:session|goal|job) ([^:]+):/.exec(String(text))
  return match !== null ? match[1] : null
}

function attentionFocus(row) {
  if (row === null || row === undefined) return null
  if (typeof row === 'string') return labelFocus(row) ?? row.slice(0, 60) // ui-copy-ignore
  return row.id || row.detail || null
}

/**
 * Restore records written before 0.4.3 put stopped jobs in `attention`, which made a clean idle
 * page keep a permanent dot for work that can never restart. Keep old records readable without
 * re-raising that light; modern records already list those jobs in `jobsStopped`.
 */
function restoreAttention(rows) {
  return (Array.isArray(rows) ? rows : []).filter((row) => typeof row !== 'string' || row.endsWith(': stopped, not restarted') === false)
}

/** One row per item: a retried stop must not multiply the same unfinished job in the dot. */
function dedupeRows(rows) {
  const seen = new Set()
  return rows.filter((row) => {
    if (row === null || row === undefined) return false
    const key = typeof row === 'string' ? row : `${row.kind ?? ''}|${row.id ?? ''}|${row.detail ?? ''}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

export function createEngine({ store, probe, heartbeat = null, bootId = 'boot', epoch = null, now = () => Date.now(), graceMs = 2000, gate = null, startGapMs = 0, log = () => {} }) {
  /**
   * A reload creates a new instance and bumps the shared epoch. An old instance's press may still
   * be awaiting a cancelled turn; it must not write its stale plan over the new instance's one.
   */
  const isCurrent = () => epoch === null || currentEpoch() === epoch
  let phase = 'idle'
  let lastError = null
  let result = null
  /** Set while a press runs, so a second caller joins the answer instead of starting work again. */
  let inflight = null
  let inflightKind = null
  /**
   * A resume that the person interrupts. Dispatch stops at the next boundary, the gate refuses
   * anything still queued, and the work that did start is stopped and left in the plan. This is
   * deliberately not `stale`: a reload owns the plan, a person pressing pause owns the pause.
   */
  let resumeAbort = false
  let lastDispatch = 0
  /**
   * The complete plan kept in memory when its durable write failed. It can be a crash plan or a
   * normal pause plan whose crash residue could not be merged; in both cases the file on disk is
   * only an older subset and must not decide what this press restores.
   */
  let planFallback = null
  let counter = 0

  function newPlanId(kind) {
    counter += 1
    return `${kind}-${now().toString(36)}-${counter.toString(36)}`
  }

  function pausedPlan() {
    return store.read()
  }

  function crashPlan() {
    return typeof store.readPending === 'function' ? store.readPending() : null
  }

  /**
   * Exactly one plan is pending, and a finished pause outranks a leftover crash record. The
   * in-memory fallback outranks both files: when a write failed it holds the complete work, while
   * the older file would hide the half that was never saved.
   */
  function currentPlan() {
    return planFallback ?? pausedPlan() ?? crashPlan()
  }

  /** Identity and content of one plan, used to find which store actually holds it. */
  function samePlan(left, right) {
    return left !== null && right !== null && left.planId === right.planId && planKey(left) === planKey(right)
  }

  /**
   * Whether a pending copy is an older, smaller copy of this plan rather than a separate job.
   * Same planId plus every pending obligation present in the snapshot is the migration relation;
   * a pending row the snapshot does not contain is later work and must survive.
   */
  function pendingAbsorbed(plan) {
    const pending = crashPlan()
    if (pending === null || pending === undefined) return false
    if (pending.planId !== plan.planId) return false
    const marker = plan.migration !== null && typeof plan.migration === 'object' ? plan.migration : null
    if (marker !== null && marker.fromPending !== pending.planId) return false
    // Plans written before the marker existed: a pause plan whose pending copy is still a crash
    // plan is the same migration. Content is still checked, so additions are never discarded.
    if (marker === null && plan.source !== 'pause') return false
    const covered = new Set(itemKeys(plan))
    return itemKeys(pending).every((key) => covered.has(key))
  }

  /** The work a plan asks for, without timestamps or reporting fields. */
  function planKey(plan) {
    const row = (item) => [item?.sessionId ?? '', item?.intent ?? (item?.running === true ? 'continue' : 'mount'), item?.goalId ?? '']
    return JSON.stringify({
      sessions: (plan?.sessions ?? []).map(row),
      goals: (plan?.goals ?? []).map((goal) => [goal?.sessionId ?? '', goal?.goalId ?? '']),
      jobs: (plan?.jobs ?? []).map((job) => job?.id ?? ''),
    })
  }

  /**
   * A plan is only ours to spend if the durable copy still asks for exactly the same work. A
   * merged plan keeps the planId, so an id comparison alone would delete another press's additions.
   */
  function stillMine(plan) {
    if (isCurrent() === false) return false
    // When the merge could not be written, this in-memory plan is the complete set and the file
    // is only its older subset. The epoch check above already proved no newer instance wrote.
    if (planFallback === plan) return true
    // A plan can live in either file: a crash plan converted to a pause plan may have fallen back
    // to pending.json when snapshot.json could not be written. Find it by content, not by source.
    return samePlan(pausedPlan(), plan) || samePlan(crashPlan(), plan)
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

  /** The item a partial restore could not finish, so the tooltip can name it. */
  function failureFocus(summary) {
    for (const line of Array.isArray(summary?.failed) ? summary.failed : []) {
      const match = /^(?:session|goal) ([^:]+):/.exec(String(line))
      if (match !== null) return match[1]
      if (typeof line === 'string' && line !== '') return line.slice(0, 60) // ui-copy-ignore
    }
    return null
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
    // A plan is an unfinished stop: the only way forward is to resume it, even when the stop left
    // work behind. Preferring `pause` there used to trap a partial stop forever: every press
    // re-ran the same stop, the residue could never be cancelled, and the button never offered the
    // resume that would have released the plan.
    let action = 'none'
    if (busy) action = 'busy'
    else if (plan !== null) action = 'resume'
    else if (current.readable === true && workCount > 0) action = 'pause'
    // The dot means "something still needs you". Stopped jobs are reported separately and must not
    // turn a clean idle page into a permanent dot, but restore attention also covers "the message
    // was admitted and no turn started" and "the turn cannot be proven finished": those are open
    // obligations even when no plan is left, so they are always shown.
    const attentionRows = dedupeRows([
      ...(Array.isArray(plan?.attention) ? plan.attention : []),
      ...restoreAttention(result?.attention),
    ])
    const attention = attentionRows.length
    const first = attention > 0 ? attentionRows[0] : null
    const focus = first !== null ? attentionFocus(first) : failureFocus(result)
    return {
      phase,
      action,
      source: plan === null ? null : plan.source ?? 'pause',
      // `complete` means the stop finished and nothing is still turning. A partial stop is not, and
      // neither is a crash record: nothing was stopped there, so claiming a finished stop would tell
      // an API consumer that a press had succeeded when the process had simply died.
      complete: plan === null || isCrashPlan(plan) === true
        ? null
        : plan.status !== 'partial' && plan.status !== 'pausing' && lastError !== 'store',
      outstanding: outstandingOf(plan), // ui-copy-ignore
      counts: countsOf(plan), // ui-copy-ignore
      live: { // ui-copy-ignore
        sessions: work.sessions.filter((session) => session.running === true).length,
        goals: current.goals.length,
        jobs: current.jobs.length,
      },
      attention,
      focus, // ui-copy-ignore
      error: lastError ?? (plan?.status === 'pausing' ? 'pause-interrupted' : plan?.status === 'partial' ? 'pause-partial' : null), // ui-copy-ignore
      result,
      restore: plan === null || typeof gate?.stats !== 'function' ? null : gate.stats(), // ui-copy-ignore
    }
  }

  /**
   * Persist rows the probe discovered before it cancels them. A turn that opened while the press was
   * already stopping is work this pause owns; cancelling it without a durable row would lose the only
   * evidence that it needs a continuation.
   */
  function noteDiscovered(rows) {
    if (!Array.isArray(rows) || rows.length === 0) return
    const plan = currentPlan()
    if (plan === null) return
    const known = new Set((plan.sessions ?? []).map((row) => row.sessionId))
    const fresh = rows.filter((row) => typeof row?.sessionId === 'string' && !known.has(row.sessionId))
    if (fresh.length === 0) return
    plan.sessions = unionSessions(plan.sessions ?? [], fresh.map((row) => {
      const copy = freshSession({ sessionId: row.sessionId, running: true, lastTurn: row.lastTurn, parent: row.parent })
      return copy.intent === 'continue' && !(copy.epoch > 0) ? { ...copy, epoch: 1 } : copy
    }))
    if (persist(plan) === null) log('cannot persist a session discovered mid-pause')
  }

  function freshSession(session) {
    // A session in the captured live set had its turn open, so the press owns a continuation for it.
    // A crash row is different: it is evidence that a turn was open, not permission to send text.
    const running = session.running === true
    const parent = typeof session.parent === 'string' && session.parent !== '' ? session.parent : null
    return {
      sessionId: session.sessionId,
      running,
      intent: running && session.intent !== 'mount' ? 'continue' : 'mount',
      epoch: running && Number.isSafeInteger(session.epoch) ? session.epoch : 0,
      lastTurn: Number.isSafeInteger(session.lastTurn) ? session.lastTurn : null,
      // A root row keeps the shape earlier versions wrote. Only a child needs the route fields,
      // and only those rows may be restored through their parent.
      ...(parent === null ? {} : { parent, origin: 'subagent' }),
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
        // A new capture of an actually-running session upgrades a crash-only row: the person then
        // pressed pause while it was running, which is an explicit request to continue it later.
        if (row.intent === 'continue' || row.running === true) {
          existing.intent = 'continue'
          existing.running = true
        }
        if (Number.isSafeInteger(row.epoch) && row.epoch > 0) existing.epoch = row.epoch
        continue
      }
      const copy = { ...row }
      index.set(copy.sessionId, copy)
      out.push(copy)
    }
    return out
  }

  /**
   * One pause cycle owns one continuation request id per session. A turn captured by this press
   * needs a fresh cycle; a session that carries a goal alone is mounted, not continued, because
   * bumping its epoch would change an id already admitted in the official queue and dedupe would
   * then swallow the second message.
   */
  function assignEpochs(plan, before, restoredBefore, captured) {
    plan.sessions = plan.sessions.map((row) => {
      if (row.intent !== 'continue' || captured.has(row.sessionId) === false) return row
      const prior = before.get(row.sessionId)
      const priorEpoch = Number.isSafeInteger(prior?.epoch) ? prior.epoch : 0
      if (Number.isSafeInteger(row.epoch) && row.epoch > priorEpoch) return row
      // A new pause cycle after a restore attempt needs a new request id: the previous one was
      // already admitted, and the official prompt dedupe would silently swallow the new message.
      // Retrying the same pause (no restore attempt yet) keeps the id, so admission stays idempotent.
      return { ...row, epoch: restoredBefore && priorEpoch >= 1 ? priorEpoch + 1 : Math.max(priorEpoch, 1) }
    })
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

  /** Which durable file currently holds this plan; a converted pause plan may still live in pending. */
  function usesPending(plan) {
    if (isCrashPlan(plan) === true) return true
    return samePlan(crashPlan(), plan) && !samePlan(pausedPlan(), plan)
  }

  function persist(plan) {
    if (isCurrent() === false) {
      log('stale instance: refusing to write over a newer plan')
      return null
    }
    const held = planFallback !== null
    const stored = usesPending(plan) ? store.writePending(plan) : store.write(plan)
    if (stored !== null) {
      planFallback = null
      // The complete plan is durable now, including every row the merge had kept only in memory.
      // Holding the heartbeat longer would hide turns started after this write from the next boot.
      if (held) {
        try {
          heartbeat?.release?.()
        } catch (error) {
          log(`cannot release heartbeat: ${error?.message ?? error}`)
        }
      }
    }
    return stored
  }

  /**
   * A successful pause is a new cycle: the previous restore report no longer describes the state,
   * so its attention dot must not survive into the paused phase.
   */
  function clearRestoreReport() {
    result = null
    if (typeof store.clearResult === 'function' && store.clearResult() === false) log('cannot clear the restore report')
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
    const before = new Map((basePlan?.sessions ?? []).filter((row) => typeof row?.sessionId === 'string').map((row) => [row.sessionId, row]))
    const restoredBefore = Number.isSafeInteger(basePlan?.restore?.attempts) && basePlan.restore.attempts > 0
    plan.sessions = unionSessions(plan.sessions ?? [], work.sessions.map(freshSession))
    const captured = new Set(work.sessions.filter((session) => session.running === true).map((session) => session.sessionId))
    assignEpochs(plan, before, restoredBefore, captured)
    // The probe discovers a turn that starts between the capture and the stop. It asks this first so
    // the row is on disk before anything is cancelled: a failed write leaves that work untouched
    // instead of stopping a session the plan has no entry for.
    const admitDiscovered = async (rows) => {
      const fresh = rows.filter((row) => typeof row?.sessionId === 'string' && (plan.sessions ?? []).some((row2) => row2.sessionId === row.sessionId) === false)
      if (fresh.length === 0) return
      plan.sessions = unionSessions(plan.sessions ?? [], fresh.map((row) => freshSession({ sessionId: row.sessionId, running: true, lastTurn: row.lastTurn, parent: row.parent })))
      assignEpochs(plan, before, restoredBefore, new Set([...captured, ...fresh.map((row) => row.sessionId)]))
      if (persist(plan) === null) throw new Error('store')
    }
    plan.goals = unionById(plan.goals ?? [], work.goals.map(freshGoal), (goal) => `${goal?.sessionId}:${goal?.goalId}`)
    plan.jobs = unionById(plan.jobs ?? [], work.jobs.map(freshJob), (job) => job?.id)
    if (persist(plan) === null) {
      // Nothing was stopped: the state is exactly what it was before the press.
      phase = basePlan === null ? 'idle' : 'paused'
      lastError = 'store'
      return { status: 'failed', reason: 'store' }
    }

    let stopFailure = null
    let stopped = null
    try {
      stopped = await probe.stop(current, { graceMs, onDiscover: admitDiscovered })
    } catch (error) {
      // The probe bounds its own host calls, so a throw here is unexpected. It still may not become
      // a clean pause: nothing proved the work stopped, and the plan must stay visibly partial.
      stopFailure = String(error?.message ?? error).slice(0, 120)
      log(`stopping work failed: ${stopFailure}`)
      stopped = { canceled: [], unknown: [], pausedGoals: [], goalErrors: [], killedJobs: [], jobErrors: [], stillRunning: [], sessions: [] }
    }
    if (stopped?.reloaded === true || isCurrent() === false) {
      // A reload happened while this press was awaiting the stop. The new instance owns the plan
      // now; writing here would erase whatever it captured in the meantime.
      log('stale instance: pause result discarded')
      return { status: 'failed', reason: 'reloaded' }
    }

    // A turn that started after the capture is work the press did not know about. The probe stops it
    // within a bounded budget and returns it here, so it gets the same continuation and baseline as
    // a captured turn instead of being left live behind a `paused` label.
    const discovered = (Array.isArray(stopped.discovered) ? stopped.discovered : [])
      .filter((row) => typeof row?.sessionId === 'string' && (plan.sessions ?? []).some((session) => session.sessionId === row.sessionId) === false)
    if (discovered.length > 0) {
      plan.sessions = unionSessions(plan.sessions ?? [], discovered.map((row) => freshSession({ sessionId: row.sessionId, running: true, lastTurn: row.lastTurn })))
      assignEpochs(plan, before, restoredBefore, new Set([...captured, ...discovered.map((row) => row.sessionId)]))
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
    // A session poll alone is not proof the stop was clean: a goal whose pause threw and a job whose
    // kill threw are still live work, and reporting `paused` there hid exactly what needs a person.
    const incomplete = stillRunning.length + (stopped.goalErrors ?? []).length + (stopped.jobErrors ?? []).length + (stopFailure === null ? 0 : 1)
    plan.status = incomplete > 0 ? 'partial' : 'paused'
    plan.stoppedAt = new Date(now()).toISOString()
    plan.stopped = {
      canceled: stopped.canceled ?? [],
      unknown: stopped.unknown ?? [],
      stillRunning,
      goalErrors: stopped.goalErrors ?? [],
      killedJobs: stopped.killedJobs ?? [],
      jobErrors: stopped.jobErrors ?? [],
      discovered: discovered.map((row) => row.sessionId),
      failure: stopFailure,
    } // ui-copy-ignore
    const errorId = (kind, detail) => {
      const match = new RegExp(`^${kind} ([^:]+):`).exec(String(detail))
      return match === null ? '' : match[1].trim()
    }
    plan.attention = dedupeRows([
      ...(Array.isArray(basePlan?.attention) ? basePlan.attention : []),
      ...stillRunning.map((id) => ({ kind: 'session', id, detail: 'still running' })),
      ...(stopped.killedJobs ?? []).map((job) => ({ kind: 'job', id: job.id, detail: 'stopped, not restarted' })),
      ...(stopped.goalErrors ?? []).map((detail) => {
        const goalId = errorId('goal', detail)
        const owner = [...(basePlan?.goals ?? []), ...(current.goals ?? [])].find((row) => row.goalId === goalId)
        return { kind: 'goal', id: owner?.sessionId ?? goalId, detail }
      }),
      ...(stopped.jobErrors ?? []).map((detail) => ({ kind: 'job', id: errorId('job', detail), detail })),
      ...(stopFailure === null ? [] : [{ kind: 'session', id: '', detail: `stop failed: ${stopFailure}` }]),
    ])
    if (isCrashPlan(basePlan) === true) {
      // The crash record described work that was not paused. This press did pause it, so the plan
      // becomes a normal pause plan and the crash evidence is no longer a separate obligation.
      plan.source = 'pause' // ui-copy-ignore
      // Remember which pending copy this snapshot replaces. Completion may need to clear that copy
      // after its content has grown, and planId alone is not proof that the copy belongs to it.
      plan.migration = { fromPending: basePlan.planId, at: now() } // ui-copy-ignore
      // The two files are a migration, not a plain write: if snapshot.json cannot be written, the
      // pending fallback is the only durable copy. Removing it after a failed snapshot write would
      // discard the plan, and reading only snapshot.json would then call this plan a stranger.
      if (store.write(plan) !== null) {
        planFallback = null
        if (typeof store.clearPending === 'function' && store.clearPending() === false) lastError = 'store'
        clearRestoreReport()
      } else {
        const kept = typeof store.writePending === 'function' ? store.writePending(plan) : null
        if (kept === null) {
          planFallback = plan
          lastError = 'store'
        } else {
          planFallback = null
        }
      }
    } else if (store.write(plan) === null) {
      // The durable copy still says `pausing`: the next boot reports it instead of claiming a stop
      // that was never written. In this process the complete plan stays in memory, so a resume now
      // still continues the turns the press actually stopped instead of falling back to mount-only.
      planFallback = plan
      lastError = 'store'
    } else {
      clearRestoreReport()
    }
    phase = 'paused'
    return { status: plan.status === 'partial' ? 'partial' : 'paused', counts: countsOf(plan), outstanding: outstandingOf(plan) }
  }

  function summaryOf(plan) {
    return { planId: plan.planId, source: plan.source ?? 'pause', restored: [], skipped: [], failed: [], attention: [], jobs: 0, jobsStopped: [], at: new Date(now()).toISOString() }
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
      // `intent` outranks `running` in the probe, so an interrupted pause must reset the whole
      // policy: mount only, no admission, and no earlier cycle's request identity.
      plan.sessions = (plan.sessions ?? []).map((session) => ({
        ...session, intent: 'mount', running: false, epoch: 0, lastTurn: null,
      }))
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
    const stale = () => isCurrent() === false
    const interrupted = () => resumeAbort === true
    /** Space out dispatches when a restore has several sessions; jitter keeps them from syncing. */
    const paceDispatch = async () => {
      if (!(startGapMs > 0)) return
      if ((plan.sessions ?? []).length < 2) return
      const wait = lastDispatch === 0 ? 0 : startGapMs - (now() - lastDispatch)
      if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait + Math.floor(Math.random() * 400)))
      lastDispatch = now()
    }
    const step = async (key, label, run) => {
      if (interrupted()) return { status: 'interrupted', detail: 'paused by user' }
      if (stale()) return { status: 'failed', detail: 'reloaded' }
      let outcome
      try {
        outcome = await run()
      } catch (error) {
        outcome = { status: 'failed', detail: String(error?.message ?? error).slice(0, 120) }
      }
      const status = typeof outcome?.status === 'string' ? outcome.status : 'failed'
      if (status === 'reloaded') return outcome
      if (TERMINAL.has(status) === false) {
        summary.failed.push(`${label}: ${outcome?.detail ?? 'unknown'}`)
        return outcome
      }
      record(key, status)
      if (status === 'restored') summary.restored.push(label)
      else if (status === 'skipped') summary.skipped.push(label)
      else summary.attention.push(`${label}: ${outcome?.detail ?? 'needs a look'}`)
      return outcome
    }

    const sessionRows = plan.sessions ?? []
    const sessionDone = new Array(sessionRows.length)
    // A child's route lives inside its parent's Activation, so the parent must finish restoring
    // before the child is asked to continue. Rows are restored in lineage waves: depth 0 first,
    // then every child one level down, and so on. A row whose parent is not in this plan is a root
    // here; the probe reports it as waiting instead of dropping it.
    const rowById = new Map()
    for (const row of sessionRows) if (typeof row?.sessionId === 'string') rowById.set(row.sessionId, row)
    const depthOf = (row) => {
      let depth = 0
      let cursor = row
      const seen = new Set([row?.sessionId])
      while (typeof cursor?.parent === 'string' && rowById.has(cursor.parent) && seen.has(cursor.parent) === false) {
        seen.add(cursor.parent)
        cursor = rowById.get(cursor.parent)
        depth += 1
      }
      return depth
    }
    const waves = new Map()
    sessionRows.forEach((row, index) => {
      const depth = depthOf(row)
      if (waves.has(depth) === false) waves.set(depth, [])
      waves.get(depth).push(index)
    })
    for (const depth of [...waves.keys()].sort((a, b) => a - b)) {
      let cursor = 0
      const indexes = waves.get(depth)
      const worker = async () => {
        while (cursor < indexes.length) {
          const index = indexes[cursor]
          cursor += 1
          if (stale() || interrupted()) return
          await paceDispatch()
          if (stale() || interrupted()) return
          const session = sessionRows[index]
          sessionDone[index] = await step(`s:${session.sessionId}`, `session ${session.sessionId}`, () => probe.restoreSession(session, { plan }))
        }
      }
      // Bounded fan-out within one level: peers share no route, so they can mount together.
      await Promise.all(Array.from({ length: Math.min(4, indexes.length) }, worker))
    }
    for (const goal of plan.goals ?? []) {
      if (stale() || interrupted()) break
      const key = `g:${goal.sessionId}:${goal.goalId ?? ''}`
      const label = `goal ${goal.goalId ?? goal.sessionId}`
      const setGoal = (change) => {
        plan.goals = (plan.goals ?? []).map((row) => (row.sessionId === goal.sessionId && row.goalId === goal.goalId
          ? { ...row, ...change }
          : row))
      }
      // Read and verify the goal before recording any intent. The saved revision must describe the
      // exact state this operation observed, never a guess such as `plan revision + 1`: the person
      // may have edited the goal between the pause and the restore.
      let activeGoal = goal
      const hasPending = goal.pendingRestore !== undefined && goal.pendingRestore !== null
      // An exact armed revision is already proof this plan disarmed the goal; no new intent is
      // needed and a fresh read would see an active goal and stop before that proof is used.
      if (hasPending === false && Number.isSafeInteger(goal.armedRevision) === false) {
        const prepared = await probe.prepareGoal(goal, { plan })
        if (prepared?.status === 'reloaded') break
        if (prepared?.status !== 'ready') {
          const outcome = await step(key, label, async () => prepared)
          if (outcome?.status === 'reloaded') break
          continue
        }
        // `expect` is the revision the official resume produces from the verified revision. A
        // restart accepts only that exact state; any later edit is not this plan's work.
        const intent = { revision: prepared.revision, expect: prepared.revision + 1, at: now() } // ui-copy-ignore
        setGoal({ pendingRestore: intent })
        activeGoal = { ...goal, pendingRestore: intent }
        if (persist(plan) === null) {
          summary.failed.push(`${label}: restore intent not saved`)
          result = summary
          lastError = 'store'
          phase = 'paused'
          return { status: 'partial', summary, outstanding: outstandingOf(plan) }
        }
      } else {
        activeGoal = { ...goal, pendingRestore: goal.pendingRestore ?? null }
      }
      const outcome = await step(key, label, () => probe.restoreGoal(activeGoal, { plan }))
      if (outcome?.status === 'reloaded') break
      if (outcome?.status === 'restored' && Number.isSafeInteger(outcome.revision)) {
        // Remember what this plan armed. A restarted process sees `active + disarmed`, and that
        // exact revision is the only proof the goal is ours to arm again rather than someone else's.
        const row = (plan.goals ?? []).find((item) => item.sessionId === goal.sessionId && item.goalId === goal.goalId)
        setGoal({ armedRevision: outcome.revision, pendingRestore: null })
        if (persist(plan) === null) {
          // Keep the intent on disk so the next boot can still re-arm the goal; returning partial
          // without it was exactly how a successful resume became a silent skip after a restart.
          setGoal({ armedRevision: row?.armedRevision ?? null, pendingRestore: goal.pendingRestore ?? { revision: Number.isSafeInteger(goal.revision) ? goal.revision : null, at: now() } })
          summary.failed.push(`${label}: checkpoint not saved`)
          result = summary
          lastError = 'store'
          phase = 'paused'
          return { status: 'partial', summary, outstanding: outstandingOf(plan) }
        }
      } else if (outcome?.status === 'restored' || TERMINAL.has(outcome?.status)) {
        // Restored without a revision, or terminal for another reason: the intent is spent.
        setGoal({ pendingRestore: null })
        if (persist(plan) === null) {
          summary.failed.push(`${label}: checkpoint not saved`)
          result = summary
          lastError = 'store'
          phase = 'paused'
          return { status: 'partial', summary, outstanding: outstandingOf(plan) }
        }
      }
    }
    // A killed job cannot be replayed: the same command may have had an unknown effect, so it is
    // reported once and left to the person. It never blocks the plan and is never restarted.
    for (const job of plan.jobs ?? []) summary.jobsStopped.push(`job ${job.id}: stopped, not restarted`)

    if (interrupted()) {
      // The person pressed pause mid-restore. The plan stays on disk exactly as it is: every row
      // that was not delivered is still outstanding, and the work that did start was stopped by
      // interruptResume(). Consuming or publishing a summary here would turn a requested pause into
      // a finished restore.
      log('restore interrupted by pause')
      phase = 'paused'
      return { status: 'interrupted', summary, outstanding: outstandingOf(plan) }
    }

    if (stale()) {
      // A reload owns the plan now. Publishing a summary or consuming anything here would erase
      // work the new instance captured while these mounts were in flight.
      log('stale instance: restore result discarded')
      return { status: 'partial', summary, outstanding: outstandingOf(plan) }
    }

    result = summary
    if (summary.failed.length > 0) {
      plan.restore = { at: summary.at, attempts: (plan.restore?.attempts ?? 0) + 1, failed: summary.failed } // ui-copy-ignore
      if (persist(plan) === null) lastError = 'store'
      else lastError = 'restore-partial'
      phase = 'paused'
      return { status: 'partial', summary, outstanding: outstandingOf(plan) }
    }

    // A pending copy of the same plan means the migration's cleanup failed after snapshot.json was
    // written. Finish that cleanup before consuming, or the next boot would offer the same restore
    // again from a plan that is already complete.
    if (usesPending(plan) === false && pendingAbsorbed(plan) && typeof store.clearPending === 'function') {
      if (store.clearPending() === false) {
        lastError = 'store'
        phase = 'paused'
        return { status: 'partial', summary, outstanding: outstandingOf(plan) }
      }
    }
    // A plan may live in pending.json even after it became a normal pause plan (the snapshot
    // write failed during the crash-to-pause migration). Completion follows the file that holds it.
    if (usesPending(plan)) {
      if (stillMine(plan) === false) {
        log('stale instance: crash record left alone')
        phase = 'paused'
        return { status: 'partial', summary, outstanding: 0 }
      }
      if (typeof store.writeResult === 'function' && store.writeResult({ ...plan, status: 'restored', restoredAt: summary.at, summary }) === false) {
        lastError = 'store'
        phase = 'paused'
        return { status: 'partial', summary, outstanding: 0 }
      }
      if (stillMine(plan) === false) {
        log('stale instance: crash record left alone')
        phase = 'paused'
        return { status: 'partial', summary, outstanding: 0 }
      }
      if (typeof store.clearPending !== 'function' || store.clearPending() === false) {
        lastError = 'store'
        phase = 'paused'
        return { status: 'partial', summary, outstanding: 0 }
      }
      planFallback = null
      if (typeof store.clearJournal === 'function') store.clearJournal(plan.planId)
    } else {
      if (stillMine(plan) === false) {
        log('stale instance: pause plan left alone')
        phase = 'paused'
        return { status: 'partial', summary, outstanding: 0 }
      }
      const consumed = store.consume(plan, summary)
      if (!consumed?.ok) {
        lastError = 'store'
        phase = 'paused'
        return { status: 'partial', summary, outstanding: 0 }
      }
      planFallback = null
    }
    // The plan is complete, including every crash row that was merged into it. Only now may the
    // heartbeat stop protecting the previous process's record: releasing earlier would overwrite
    // the only evidence of a session the merge had not yet brought into this plan.
    try {
      heartbeat?.release?.()
    } catch (error) {
      log(`cannot release heartbeat: ${error?.message ?? error}`)
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
        if (inflight === running) {
          inflight = null
          inflightKind = null
        }
      }
    })()
    inflight = running
    inflightKind = kind
    return running
  }

  async function pause() {
    if (phase === 'resuming' && inflight !== null && inflightKind === 'resume') return interruptResume()
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

  /**
   * Stop a restore the person no longer wants. Queued model requests are refused before they reach
   * the provider, delivery stops at the next step boundary, and whatever did start is stopped the
   * same way a pause stops it. The plan stays, unconsumed, so the next resume continues it.
   */
  async function interruptResume() {
    resumeAbort = true
    try {
      gate?.abort?.()
    } catch {
      /* a gate that cannot abort still leaves the dispatch loop interruptible */
    }
    phase = 'pausing'
    const plan = currentPlan()
    let stopped = null
    try {
      stopped = await probe.stop(liveNow(), { graceMs })
    } catch (error) {
      log(`stopping an interrupted restore failed: ${error?.message ?? error}`)
    }
    if (plan !== null) {
      const discovered = (Array.isArray(stopped?.discovered) ? stopped.discovered : [])
        .filter((row) => typeof row?.sessionId === 'string' && (plan.sessions ?? []).some((session) => session.sessionId === row.sessionId) === false)
      if (discovered.length > 0) {
        plan.sessions = unionSessions(plan.sessions ?? [], discovered.map((row) => {
          const copy = freshSession({ sessionId: row.sessionId, running: true, lastTurn: row.lastTurn, parent: row.parent })
          return copy.intent === 'continue' && !(copy.epoch > 0) ? { ...copy, epoch: 1 } : copy
        }))
      }
      const baseline = new Map((stopped?.sessions ?? []).map((row) => [row.sessionId, row.lastTurn]))
      plan.sessions = (plan.sessions ?? []).map((row) => (baseline.has(row.sessionId)
        ? { ...row, running: true, intent: 'continue', lastTurn: Number.isSafeInteger(baseline.get(row.sessionId)) ? baseline.get(row.sessionId) : row.lastTurn }
        : row))
      if (Array.isArray(stopped?.jobs) && stopped.jobs.length > 0) {
        plan.jobs = unionById(plan.jobs ?? [], stopped.jobs.map(freshJob), (job) => job?.id)
      }
      plan.status = 'paused'
      if (persist(plan) === null) lastError = 'store'
    }
    phase = 'paused'
    return { status: 'paused', interrupted: true }
  }

  async function resume() {
    if (TRANSIENT.has(phase) || inflight !== null) return { status: 'busy', phase }
    resumeAbort = false
    phase = 'resuming'
    return once('resume', async () => {
      const plan = currentPlan()
      if (plan === null) {
        phase = 'idle'
        return { status: 'empty' }
      }
      // The gate limits real provider requests, not just restore calls: one slot to begin with,
      // two only after the upstream has answered twice in a row. A plan with one session is still
      // guarded, because compaction and retries of that one session are requests too.
      gate?.guard?.()
      try {
        return await runResume(plan)
      } finally {
        gate?.unguard?.()
      }
    })
  }

  /**
   * A reload or restart must not invent a phase: the disk and the running Harness decide it. The
   * crash residue is handed in by the caller, because it has to be read before the heartbeat
   * overwrites the previous process's file; it is persisted here so a second restart still sees it.
   */
  async function hydrate(options = {}) {
    planFallback = null
    lastError = null
    const residue = options?.residue ?? heartbeat?.residue ?? null
    const restored = typeof store.lastRestore === 'function' ? store.lastRestore() : null
    result = restored !== null && typeof restored === 'object' ? (restored.summary ?? null) : null
    let durable = true

    if (residue !== null && residue !== undefined) {
      let crash = null
      try {
        crash = probe.crashPlan(residue, {
          planId: `crash-${Number.isFinite(residue.at) ? residue.at : 0}-${Array.isArray(residue.sessions) ? residue.sessions.length : 0}`,
        })
      } catch (error) {
        log(`cannot derive crash plan: ${error?.message ?? error}`)
      }
      if (crash !== null) {
        const existing = pausedPlan() ?? crashPlan()
        if (existing === null) {
          const stored = typeof store.writePending === 'function' ? store.writePending(crash) : null
          // A failed write stays in memory for this process, but the caller must not let the
          // heartbeat overwrite the file the next process would have read the same residue from.
          if (stored === null) {
            planFallback = crash
            durable = false
            lastError = 'store'
            heartbeat?.hold?.()
            log('cannot record the crash plan; keeping the previous heartbeat')
          } else {
            log('crash plan recorded')
          }
        } else {
          // A plan from an earlier pause outranks the crash record, but it must not hide it: every
          // session the crash residue names is merged in as mount-only work. Otherwise a crash that
          // happened after a partial restore would silently drop sessions the next press captured.
          const known = new Set((existing.sessions ?? []).map((row) => row?.sessionId))
          const added = crash.sessions
            .filter((row) => known.has(row.sessionId) === false)
            .map((row) => ({ sessionId: row.sessionId, intent: 'mount', epoch: 0, running: false, lastTurn: null, crash: true }))
          // A goal the pause plan already carries is authoritative: that row proves the person
          // pressed pause and what revision it left behind. A crashed goal fills only the gap.
          const knownGoals = new Set((existing.goals ?? []).map((row) => `${row?.sessionId}\u0000${row?.goalId ?? ''}`))
          const addedGoals = (Array.isArray(crash.goals) ? crash.goals : [])
            .filter((row) => knownGoals.has(`${row.sessionId}\u0000${row.goalId}`) === false)
            .map((row) => ({ sessionId: row.sessionId, goalId: row.goalId, revision: row.revision, armedRevision: row.armedRevision }))
          if (added.length > 0 || addedGoals.length > 0) {
            const plan = {
              ...existing,
              sessions: [...(existing.sessions ?? []), ...added],
              goals: [...(existing.goals ?? []), ...addedGoals],
              crashes: (Number.isSafeInteger(existing.crashes) ? existing.crashes : 0) + added.length,
              attention: [
                ...(Array.isArray(existing.attention) ? existing.attention : []),
                ...added.map((row) => ({ kind: 'session', id: row.sessionId, detail: 'crashed: mounted only' })),
                ...addedGoals.map((row) => ({ kind: 'goal', id: row.sessionId, detail: 'crashed: goal re-armed on restore' })),
              ],
            }
            const isCrash = isCrashPlan(plan)
            const stored = isCrash
              ? (typeof store.writePending === 'function' ? store.writePending(plan) : null)
              : store.write(plan)
            if (stored === null) {
              durable = false
              lastError = 'store'
              // Whatever the source, the in-memory plan now holds the complete set. Resume must
              // use it, or the sessions that only exist here would be skipped forever.
              planFallback = plan
              heartbeat?.hold?.()
              log('cannot merge the crash plan; keeping the previous heartbeat')
            } else {
              planFallback = null
              log(`crash work merged (${added.length} sessions, ${addedGoals.length} goals)`)
            }
          }
        }
      }
    }

    const hydrated = currentPlan()
    // A crash record is not a pause: the button offers restore, but the page is not paused.
    phase = hydrated !== null && isCrashPlan(hydrated) === false ? 'paused' : 'idle'
    return { phase, durable }
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
