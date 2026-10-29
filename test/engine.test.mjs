import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createEngine } from '../lib/engine.js'

/** A store with the same surface as the durable one, small enough to inspect after each press. */
function fakeStore({ plan = null, journal = [], failWrite = false, failWriteAfter = null, failConsume = false, failJournal = false, failPending = false } = {}) {
  const state = { plan, pending: null, writes: [], consumed: null, result: null, journal: new Map(), failWrite, failWriteAfter, failConsume, failJournal, failPending }
  for (const key of journal) state.journal.set(key, { status: 'restored', boot: 'boot-0' })
  return {
    state,
    read: () => state.plan,
    write: (next) => {
      state.writes.push(structuredClone(next))
      if (state.failWrite === true) return null
      if (state.failWriteAfter !== null && state.writes.length > state.failWriteAfter) return null
      state.plan = { ...next }
      return state.plan
    },
    readPending: () => state.pending,
    writePending: (next) => {
      state.writes.push(structuredClone(next))
      if (state.failPending === true || state.failWrite === true) return null
      state.pending = { ...next }
      return state.pending
    },
    clearPending: () => {
      state.pending = null
      return true
    },
    writeResult: (record) => {
      state.result = record
      return true
    },
    clearResult: () => {
      state.result = null
      return true
    },
    lastRestore: () => state.result,
    readJournal: () => new Map([...state.journal.entries()]),
    appendJournal: (planId, key, status, boot, extra = null) => {
      if (state.failJournal === true) return false
      state.journal.set(key, {
        status,
        boot,
        epoch: Number.isSafeInteger(extra?.epoch) ? extra.epoch : undefined,
        turn: Number.isSafeInteger(extra?.turn) ? extra.turn : undefined,
      })
      return true
    },
    clearJournal: () => {
      state.journal.clear()
    },
    consume: (next, summary, status = 'restored') => {
      if (state.failConsume === true) return { ok: false, archivePath: null, published: false }
      state.consumed = { plan: next, summary, status }
      state.plan = null
      state.journal.clear()
      state.result = { planId: next.planId, status, summary }
      return { ok: true, archivePath: '/tmp/restores/x.json', published: true }
    },
  }
}

function fakeProbe(live = { sessions: [], goals: [], jobs: [], readable: true }, stopOutcome = {}) {
  const calls = []
  return {
    calls,
    live: () => live,
    // A measured, small transcript: only the pacing tests mean to exercise the unknown-weight path,
    // and an unmeasurable row is deliberately treated as heavy, which would stall every resume here.
    sessionWeight: async () => ({ bytes: 1024 * 1024, file: null }),
    stop: async (current) => {
      calls.push(['stop', current.sessions.length])
      return {
        canceled: [], unknown: [], pausedGoals: [], goalErrors: [], killedJobs: [], jobErrors: [], stillRunning: [],
        ...stopOutcome,
      }
    },
    restoreSession: async (session) => {
      calls.push(['session', session.sessionId, session.running])
      return { status: 'restored', detail: 'attached' }
    },
    prepareGoal: async (goal) => {
      calls.push(['prepareGoal', goal.goalId])
      return { status: 'ready', revision: Number.isSafeInteger(goal.revision) ? goal.revision : 0 }
    },
    restoreGoal: async (goal) => {
      calls.push(['goal', goal.goalId])
      return { status: 'restored', detail: 'armed' }
    },
    crashPlan: (residue, options) => {
      calls.push(['crashPlan', residue, options])
      if (residue === null) return null
      return {
        version: 2,
        planId: options.planId,
        status: 'paused',
        source: 'crash',
        createdAt: '1970-01-01T00:00:00.000Z',
        sessions: residue.sessions.map((row) => ({ sessionId: row.sessionId, running: false, lastTurn: null, crash: true })),
        goals: [],
        jobs: [],
      }
    },
  }
}

function engineFor({ store, probe, heartbeat = null, now = () => 1700000000000, bootId = 'boot-1', maxRestoreAttempts } = {}) {
  const s = store ?? fakeStore()
  const p = probe ?? fakeProbe()
  return { store: s, probe: p, engine: createEngine({ store: s, probe: p, heartbeat, now, bootId, maxRestoreAttempts, log: () => {} }) }
}

test('describe() is idle and offers nothing when there is no work and no plan', () => {
  const { engine } = engineFor({})
  const state = engine.describe()
  assert.equal(state.phase, 'idle')
  assert.equal(state.action, 'none')
  assert.equal(state.complete, null)
  assert.equal(state.error, null)
})

test('describe() offers a pause for running jobs even with no session turn open', () => {
  const probe = fakeProbe({ sessions: [], goals: [], jobs: [{ id: 'j1', status: 'running' }], readable: true })
  const { engine } = engineFor({ probe })
  const state = engine.describe()
  assert.equal(state.action, 'pause')
  assert.equal(state.live.jobs, 1)
})

test('pause() writes the plan before stopping, then records only the goals that really paused', async () => {
  const live = {
    readable: true,
    sessions: [{ sessionId: 's1', running: true, lastTurn: 3 }],
    goals: [{ sessionId: 's1', goalId: 'g1', revision: 4 }],
    jobs: [{ id: 'j1', owner: 's1', status: 'running' }],
  }
  const probe = fakeProbe(live, {
    canceled: ['s1'],
    pausedGoals: [{ sessionId: 's1', goalId: 'g1', pausedRevision: 5 }],
    // The cancelled turn moves the agent's counter: the plan keeps the post-stop value as baseline.
    sessions: [{ sessionId: 's1', lastTurn: 4 }],
  })
  const { store, engine } = engineFor({ probe })
  const outcome = await engine.pause()
  assert.equal(outcome.status, 'paused')
  assert.equal(store.state.writes.length, 2)
  assert.equal(store.state.writes[0].status, 'pausing')
  assert.equal(store.state.writes[0].goals[0].revision, 4)
  assert.deepEqual(store.state.writes[1].goals, [{ sessionId: 's1', goalId: 'g1', revision: 5 }])
  assert.deepEqual(store.state.writes[1].sessions, [{ sessionId: 's1', running: true, intent: 'continue', epoch: 1, lastTurn: 4 }])
  assert.equal(store.state.plan.status, 'paused')
  // The stub Harness still reports the turn as running; the plan wins, so the button offers the
  // resume that releases the stop instead of re-running it.
  assert.equal(engine.describe().action, 'resume')
  live.sessions = []
  live.goals = []
  live.jobs = []
  assert.equal(engine.describe().action, 'resume')
  assert.equal(engine.describe().complete, true)
  assert.equal(engine.describe().error, null)
})

test('a session that ended normally is not recorded and alone offers no pause', async () => {
  const live = {
    readable: true,
    sessions: [{ sessionId: 'done', running: false, lastTurn: 9 }],
    goals: [],
    jobs: [],
  }
  const probe = fakeProbe(live)
  const { store, engine } = engineFor({ probe })
  assert.equal(engine.describe().action, 'none')
  const outcome = await engine.pause()
  assert.equal(outcome.status, 'idle')
  assert.equal(store.state.writes.length, 0)
  assert.equal(probe.calls.some((call) => call[0] === 'stop'), false)
})

test('a session that only carries an armed goal is recorded so the goal can be re-armed', async () => {
  const live = {
    readable: true,
    sessions: [{ sessionId: 's1', running: false, lastTurn: 4 }, { sessionId: 'done', running: false, lastTurn: 9 }],
    goals: [{ sessionId: 's1', goalId: 'g1', revision: 2 }],
    jobs: [],
  }
  const probe = fakeProbe(live, { pausedGoals: [{ sessionId: 's1', goalId: 'g1', pausedRevision: 3 }] })
  const { store, engine } = engineFor({ probe })
  await engine.pause()
  assert.deepEqual(store.state.plan.sessions, [{ sessionId: 's1', running: false, intent: 'mount', epoch: 0, lastTurn: null }])
  assert.deepEqual(store.state.plan.goals, [{ sessionId: 's1', goalId: 'g1', revision: 3 }])
})

test('pause() is exclusive in the same tick a second window presses', async () => {
  const live = { readable: true, sessions: [{ sessionId: 's1', running: true }], goals: [], jobs: [] }
  const probe = fakeProbe(live)
  const { engine } = engineFor({ probe })
  const first = engine.pause()
  const second = await engine.pause()
  assert.equal(second.status, 'busy')
  assert.equal(second.phase, 'pausing')
  assert.equal((await first).status, 'paused')
  assert.equal(probe.calls.filter((call) => call[0] === 'stop').length, 1)
})

test('pause() merges work started while a plan was pending instead of losing it', async () => {
  const store = fakeStore({ plan: { version: 3, planId: 'p1', source: 'pause', status: 'paused', sessions: [{ sessionId: 'old', running: true, lastTurn: 1 }], goals: [], jobs: [], attention: [] } })
  const probe = fakeProbe({ readable: true, sessions: [{ sessionId: 's1', running: true }], goals: [], jobs: [] })
  const { engine } = engineFor({ store, probe })
  assert.equal((await engine.pause()).status, 'paused')
  assert.equal(probe.calls.filter((call) => call[0] === 'stop').length, 1)
  assert.equal(store.state.plan.planId, 'p1')
  assert.deepEqual(store.state.plan.sessions.map((row) => row.sessionId), ['old', 's1'])
})

test('pause() fails loudly when the registry cannot be read instead of pausing nothing', async () => {
  const probe = fakeProbe({ readable: false, sessions: [], goals: [], jobs: [] })
  const { store, engine } = engineFor({ probe })
  const outcome = await engine.pause()
  assert.equal(outcome.status, 'failed')
  assert.equal(outcome.reason, 'registry')
  assert.equal(engine.describe().error, 'registry')
  assert.equal(store.state.writes.length, 0)
})

test('pause() stops nothing when the plan cannot be made durable first', async () => {
  const probe = fakeProbe({ readable: true, sessions: [{ sessionId: 's1', running: true }], goals: [], jobs: [] })
  const store = fakeStore({ failWrite: true })
  const { engine } = engineFor({ store, probe })
  const outcome = await engine.pause()
  assert.equal(outcome.status, 'failed')
  assert.equal(outcome.reason, 'store')
  assert.equal(probe.calls.length, 0)
  assert.equal(store.state.plan, null)
})

test('pause() keeps a turn that would not stop as reported attention, not as a clean pause', async () => {
  const live = { readable: true, sessions: [{ sessionId: 's1', running: true }], goals: [], jobs: [] }
  const probe = fakeProbe(live, { stillRunning: ['s1'] })
  const { store, engine } = engineFor({ probe })
  const outcome = await engine.pause()
  assert.equal(outcome.status, 'partial')
  assert.equal(engine.describe().complete, false)
  assert.equal(engine.describe().error, 'pause-partial')
  assert.deepEqual(store.state.plan.attention, [{ kind: 'session', id: 's1', detail: 'still running' }])
  assert.equal(engine.describe().attention, 1)
  // The still-running turn cannot be cancelled directly; the plan is the only way out of here.
  assert.equal(engine.describe().action, 'resume')
})

test('a partial stop offers resume, never another pause over its own residue', async () => {
  const live = { readable: true, sessions: [{ sessionId: 's1', running: true }], goals: [], jobs: [] }
  const probe = fakeProbe(live, { stillRunning: ['s1'] })
  const { store, engine } = engineFor({ probe })
  await engine.pause()
  assert.equal(engine.describe().action, 'resume')
  const first = await engine.resume()
  assert.equal(first.status, 'resumed')
  assert.equal(store.state.plan, null)
  // Resuming skipped the live residue instead of stopping it again, and consumed the plan.
  assert.equal(probe.calls.filter((call) => call[0] === 'stop').length, 1)
  assert.equal(engine.describe().phase, 'idle')
})

test('work started while a plan is waiting does not turn the button back into pause', async () => {
  const plan = { version: 3, planId: 'p1', source: 'pause', status: 'paused', sessions: [{ sessionId: 's1', running: true, lastTurn: 1 }], goals: [], jobs: [], attention: [] }
  const probe = fakeProbe({ readable: true, sessions: [{ sessionId: 's2', running: true }], goals: [], jobs: [] })
  const { engine } = engineFor({ store: fakeStore({ plan }), probe })
  assert.equal(engine.describe().action, 'resume')
})

test('resume() journals each restored item and consumes the plan only when every item settled', async () => {
  const plan = {
    version: 2, planId: 'p1', status: 'paused', source: 'pause', sessions: [{ sessionId: 's1', running: true, lastTurn: 2 }],
    goals: [{ sessionId: 's1', goalId: 'g1', revision: 3 }], jobs: [],
  }
  const store = fakeStore({ plan })
  const { probe, engine } = engineFor({ store })
  const outcome = await engine.resume()
  assert.equal(outcome.status, 'resumed')
  assert.equal(store.state.consumed.plan.planId, 'p1')
  assert.equal(store.state.journal.size, 0)
  assert.deepEqual(outcome.summary.restored.sort(), ['goal g1', 'session s1'])
  assert.deepEqual(probe.calls.map((call) => call[0]), ['session', 'prepareGoal', 'goal'])
  assert.equal(engine.phase, 'idle')
  assert.equal(engine.describe().action, 'none')
})

test('a restored row is journaled with its pause cycle and the turn it actually opened', async () => {
  const plan = {
    version: 3, planId: 'p13', status: 'paused', source: 'pause',
    sessions: [
      { sessionId: 's1', running: true, lastTurn: 5, epoch: 3 },
      { sessionId: 's2', running: true, lastTurn: 2, epoch: 1 },
    ],
    goals: [], jobs: [],
  }
  const store = fakeStore({ plan })
  const probe = fakeProbe()
  probe.restoreSession = async (session) => {
    probe.calls.push(['session', session.sessionId])
    if (session.sessionId === 's1') return { status: 'restored', detail: 'continued', turn: 7 }
    return { status: 'failed', detail: 'REMOTE_CONFLICT' }
  }
  const { engine } = engineFor({ store, probe })
  const outcome = await engine.resume()
  assert.equal(outcome.status, 'partial')
  // The cycle and the turn are what let a later boot tell "this process admitted a turn" from
  // "a crashed process never did"; a restored row without them was trusted across a restart and
  // reported work complete that never ran.
  assert.deepEqual(store.state.journal.get('s:s1'), { status: 'restored', boot: 'boot-1', epoch: 3, turn: 7 })
  assert.equal(store.state.journal.has('s:s2'), false)
})

test('resume() keeps the plan and retries only the item that failed', async () => {
  const plan = {
    version: 2, planId: 'p1', status: 'paused', source: 'pause',
    sessions: [{ sessionId: 's1', running: true }, { sessionId: 's2', running: false }],
    goals: [{ sessionId: 's1', goalId: 'g1', revision: 3 }], jobs: [],
  }
  const store = fakeStore({ plan })
  const probe = fakeProbe()
  let attempts = 0
  probe.restoreSession = async (session) => {
    attempts += 1
    probe.calls.push(['session', session.sessionId])
    if (session.sessionId === 's1' && attempts === 1) return { status: 'failed', detail: 'REMOTE_CONFLICT' }
    return { status: 'restored', detail: 'attached' }
  }
  const { engine } = engineFor({ store, probe })
  const first = await engine.resume()
  assert.equal(first.status, 'partial')
  assert.equal(first.outstanding, 1)
  assert.equal(engine.describe().error, 'restore-partial')
  assert.equal(engine.phase, 'paused')
  assert.match(store.state.plan.restore.failed[0], /REMOTE_CONFLICT/u)
  assert.equal(store.state.consumed, null)

  const probeCallsBefore = probe.calls.length
  const second = await engine.resume()
  assert.equal(second.status, 'resumed')
  // A session this plan already restored is not probed again: a restarted Harness can advance its
  // turn on its own, and rechecking that is what used to relabel finished work as attention.
  // Only the row that failed is checked again; the one already restored keeps its result.
  assert.deepEqual(probe.calls.slice(probeCallsBefore).map((call) => [call[0], call[1]]), [['session', 's1'], ['prepareGoal', 'g1'], ['goal', 'g1']])
  assert.equal(store.state.consumed.plan.planId, 'p1')
})

test('resume() treats skipped and attention as settled and reports what needs a person', async () => {
  const plan = {
    version: 2, planId: 'p1', status: 'paused', source: 'pause',
    sessions: [{ sessionId: 's1', running: false }, { sessionId: 's2', running: false }], goals: [], jobs: [],
  }
  const store = fakeStore({ plan })
  const probe = fakeProbe()
  probe.restoreSession = async (session) => (session.sessionId === 's1'
    ? { status: 'skipped', detail: 'already continued' }
    : { status: 'attention', detail: 'goal finished' })
  const { engine } = engineFor({ store, probe })
  const outcome = await engine.resume()
  assert.equal(outcome.status, 'resumed')
  assert.deepEqual(outcome.summary.skipped, ['session s1'])
  assert.equal(outcome.summary.attention.length, 1)
  assert.equal(store.state.journal.size, 0)
})

test('resume() records killed jobs as gone and never claims to restart them', async () => {
  const plan = {
    version: 2, planId: 'p1', status: 'paused', source: 'pause',
    sessions: [], goals: [], jobs: [{ id: 'j1', owner: 's1', status: 'running' }],
  }
  const probe = fakeProbe()
  const { engine } = engineFor({ store: fakeStore({ plan }), probe })
  const outcome = await engine.resume()
  assert.equal(outcome.status, 'resumed')
  assert.equal(outcome.summary.jobs, 1)
  assert.match(outcome.summary.jobsStopped[0], /not restarted/u)
  assert.equal(outcome.summary.attention.length, 0)
  assert.equal(probe.calls.some((call) => call[0] === 'job'), false)
})

test('resume() keeps the plan when the archive cannot be written', async () => {
  const plan = { version: 2, planId: 'p1', status: 'paused', source: 'pause', sessions: [{ sessionId: 's1', running: false }], goals: [], jobs: [] }
  const store = fakeStore({ plan, failConsume: true })
  const { engine } = engineFor({ store })
  const outcome = await engine.resume()
  assert.equal(outcome.status, 'partial')
  assert.equal(engine.describe().error, 'store')
  assert.notEqual(store.state.plan, null)
  assert.equal(engine.phase, 'paused')
})

test('a crash residue is offered for restore after boot and released only once it is restored', async () => {
  const released = []
  const heartbeat = {
    residue: { sessions: [{ sessionId: 's1' }], at: 1700000000000 },
    release: () => released.push(true),
    note: () => {},
    stop: () => {},
    flush: async () => true,
  }
  const plan = {
    version: 2, planId: 'crash-1700000000000-1', status: 'paused', source: 'crash', createdAt: '1970-01-01T00:00:00.000Z',
    sessions: [{ sessionId: 's1', running: false, lastTurn: null, crash: true }], goals: [], jobs: [],
  }
  const store = fakeStore()
  const probe = fakeProbe()
  probe.crashPlan = (residue, options) => {
    probe.calls.push(['crashPlan', residue, options])
    if (residue === null) return null
    return { ...plan, planId: options.planId }
  }
  const { engine } = engineFor({ store, probe, heartbeat })
  await engine.hydrate()
  assert.equal(engine.phase, 'idle')
  assert.equal(engine.describe().action, 'resume')
  const outcome = await engine.resume()
  assert.equal(outcome.status, 'resumed')
  assert.deepEqual(released, [true])
  assert.equal(engine.describe().action, 'none')
})

test('an interrupted pause is mounted but never continued', async () => {
  const plan = {
    version: 2, planId: 'pause-x', status: 'pausing', source: 'pause',
    sessions: [{ sessionId: 's1', running: true, lastTurn: 7 }], goals: [], jobs: [],
  }
  const store = fakeStore({ plan })
  const probe = fakeProbe()
  const { engine } = engineFor({ store, probe })
  await engine.hydrate()
  assert.equal(engine.describe().error, 'pause-interrupted')
  const outcome = await engine.resume()
  assert.equal(outcome.status, 'resumed')
  assert.deepEqual(probe.calls.find((call) => call[0] === 'session'), ['session', 's1', false])
  assert.equal(store.state.consumed.plan.source, 'interrupted')
})

test('hydrate() re-derives crash rows a build without live turns wrote as mount-only', async () => {
  // What the shipped 0.5.3 build left behind: every row mount-only, no turn, although the residue
  // still proves the turn was open. Spending a press on those mounts would attach sessions and
  // consume the plan without continuing any work.
  const legacy = {
    version: 2,
    planId: 'crash-1700-1',
    status: 'paused',
    source: 'crash',
    createdAt: '1970-01-01T00:00:00.000Z',
    sessions: [
      { sessionId: 's1', intent: 'mount', epoch: 0, running: false, lastTurn: null, crash: true, retry: 2 },
      { sessionId: 's2', intent: 'mount', epoch: 0, running: false, lastTurn: null, crash: true },
    ],
    goals: [{ sessionId: 's1', goalId: 'g1', revision: 4, armedRevision: 4, crash: true }],
    jobs: [],
  }
  const store = fakeStore()
  store.state.pending = legacy
  const probe = fakeProbe()
  probe.crashPlan = (residue, options) => ({
    version: 3,
    planId: options.planId,
    status: 'paused',
    source: 'crash',
    createdAt: '1970-01-01T00:00:00.000Z',
    sessions: [{ sessionId: 's1', intent: 'continue', epoch: 0, running: true, lastTurn: 7, crash: true }],
    goals: [{ sessionId: 's1', goalId: 'g1', revision: 4, armedRevision: 4, crash: true }],
    jobs: [],
    attention: [],
    crashes: 1,
  })
  const engine = createEngine({ store, probe, bootId: 'b1', now: () => 2, log: () => {} })
  await engine.hydrate({ residue: { at: 1700, sessions: [{ sessionId: 's1', lastTurn: 7 }] } })
  assert.equal(store.state.pending.planId, 'crash-1700-1')
  assert.equal(store.state.pending.sessions[0].intent, 'continue')
  assert.equal(store.state.pending.sessions[0].lastTurn, 7)
  assert.equal(store.state.pending.sessions[0].retry, 2)
  // A session the residue no longer names keeps its mount-only row instead of vanishing.
  assert.deepEqual(store.state.pending.sessions.map((row) => [row.sessionId, row.intent]), [['s1', 'continue'], ['s2', 'mount']])
  assert.equal(store.state.pending.goals[0].armedRevision, 4)
})

test('hydrate() takes the phase from the disk, not from a fresh boot', async () => {
  const empty = engineFor({}).engine
  await empty.hydrate()
  assert.equal(empty.phase, 'idle')
  const plan = { version: 2, planId: 'p1', status: 'paused', sessions: [], goals: [], jobs: [] }
  const paused = engineFor({ store: fakeStore({ plan }) }).engine
  await paused.hydrate()
  assert.equal(paused.phase, 'paused')
  assert.equal(paused.describe().action, 'resume')
})

test('a crash plan survives a second restart and is released only once it is restored', async () => {
  const store = fakeStore()
  const heartbeat = { released: 0, release() { this.released += 1 } }
  const first = createEngine({ store, probe: fakeProbe(), heartbeat, bootId: 'b1', now: () => 1, log: () => {} })
  await first.hydrate({ residue: { at: 1700, sessions: [{ sessionId: 's1' }, { sessionId: 's2' }] } })
  assert.equal(store.state.pending.planId, 'crash-1700-2')
  assert.equal(first.describe().action, 'resume')
  assert.equal(first.describe().counts.sessions, 2)
  // The next process inherits nothing from memory: only the file on disk says what was running.
  const second = createEngine({ store, probe: fakeProbe(), heartbeat, bootId: 'b2', now: () => 2, log: () => {} })
  await second.hydrate({ residue: null })
  assert.equal(second.describe().action, 'resume')
  assert.equal(second.describe().counts.sessions, 2)
  const outcome = await second.resume()
  assert.equal(outcome.status, 'resumed')
  assert.equal(store.state.pending, null)
  // A crash row proves the session existed when the process died. The restart attaches it and lets
  // the probe read the live turn: the shipped build skipped these rows and consumed the plan with
  // nothing started, which is the "icon flipped, no session came back" report.
  assert.deepEqual(store.state.result.summary.restored, ['session s1', 'session s2'])
  assert.equal(store.state.result.status, 'restored')
  assert.equal(heartbeat.released, 1)
  assert.equal(second.describe().action, 'none')
})

test('a crash in the middle of a restore keeps the plan and checks every item again', async () => {
  const pending = {
    version: 3, planId: 'crash-9-2', source: 'crash', status: 'paused', sessions: [
      { sessionId: 's1', running: false, lastTurn: null, intent: 'continue', crash: true },
      { sessionId: 's2', running: false, lastTurn: null, intent: 'continue', crash: true },
    ], goals: [], jobs: [], attention: [],
  }
  const store = fakeStore({ plan: null })
  store.state.pending = pending
  // The previous process restored s1 and then died. That row is finished work: it must not be
  // probed again (a second continuation would duplicate it), while s2 has no evidence and is.
  store.state.journal.set('s:s1', { status: 'restored', boot: 'b1' })
  let fail = true
  const probe = fakeProbe()
  probe.restoreSession = async (session) => {
    probe.calls.push(['session', session.sessionId, session.running])
    if (session.sessionId === 's2' && fail === true) return { status: 'failed', detail: 'session not ready' }
    return { status: 'restored', detail: 'attached' }
  }
  const { engine } = engineFor({ store, probe })
  await engine.hydrate({ residue: null })
  const partial = await engine.resume()
  assert.equal(partial.status, 'partial')
  assert.equal(store.state.pending.planId, 'crash-9-2')
  assert.equal(engine.describe().error, 'restore-partial')
  // `s1` was journaled `restored` by a boot that no longer exists. That is not proof a turn is
  // running now, so it is checked again under a fresh cycle instead of being trusted.
  assert.deepEqual(probe.calls.filter((call) => call[0] === 'session').map((call) => call[1]).sort(), ['s1', 's2'])
  assert.equal(store.state.journal.get('s:s1').status, 'restored')
  fail = false
  const retry = await engine.resume()
  assert.equal(retry.status, 'resumed')
  // Only the failure is retried; `s1` finished in this boot and gets no second continuation.
  assert.deepEqual(probe.calls.filter((call) => call[0] === 'session').map((call) => call[1]), ['s1', 's2', 's2'])
  assert.equal(store.state.pending, null)
})

test('a partial pause retries the same plan instead of starting a second one', async () => {
  const live = { readable: true, sessions: [{ sessionId: 's1', running: true }], goals: [], jobs: [] }
  const probe = fakeProbe(live, { stillRunning: ['s1'] })
  const store = fakeStore()
  const { engine } = engineFor({ store, probe })
  const first = await engine.pause()
  assert.equal(first.status, 'partial')
  const planId = store.state.plan.planId
  assert.deepEqual(store.state.plan.attention, [{ kind: 'session', id: 's1', detail: 'still running' }])
  // The stubborn turn is still there on the next press, and this time it accepts the cancel.
  probe.stop = async () => ({
    canceled: ['s1'], unknown: [], pausedGoals: [], goalErrors: [], killedJobs: [], jobErrors: [], stillRunning: [],
    sessions: [{ sessionId: 's1', lastTurn: 2 }],
  })
  const second = await engine.pause()
  assert.equal(second.status, 'paused')
  assert.equal(store.state.plan.planId, planId)
  assert.equal(store.state.plan.status, 'paused')
})

test('a job a resume could not restart is recorded once, but never becomes a permanent dot', async () => {
  const plan = {
    version: 3, planId: 'p1', status: 'paused', source: 'pause', sessions: [],
    goals: [], jobs: [{ id: 'j1', owner: 's1', status: 'running' }], attention: [],
  }
  const store = fakeStore({ plan })
  const first = engineFor({ store, probe: fakeProbe() }).engine
  await first.hydrate()
  const outcome = await first.resume()
  // The killed command is evidence in the restore record, not an open obligation for the dot.
  assert.equal(outcome.summary.attention.length, 0)
  assert.deepEqual(outcome.summary.jobsStopped, ['job j1: stopped, not restarted'])
  assert.equal(store.state.result.summary.attention.length, 0)
  const second = engineFor({ store, probe: fakeProbe() }).engine
  await second.hydrate()
  assert.equal(second.describe().phase, 'idle')
  // A clean idle page shows no dot: nothing is waiting on the person.
  assert.equal(second.describe().attention, 0)
})

// v0.4.0 regressions, one per failure that was reproduced against 0.3.0.
import { nextEpoch } from '../lib/epoch.js'

test('a crash residue is merged into the pending plan instead of being hidden by it', async () => {
  const plan = {
    version: 3, planId: 'pause-1', source: 'pause', status: 'paused',
    sessions: [{ sessionId: 's1', running: true, intent: 'continue', epoch: 1, lastTurn: 2 }],
    goals: [], jobs: [], attention: [],
  }
  const store = fakeStore({ plan })
  const probe = fakeProbe()
  probe.crashPlan = (residue, options) => ({
    version: 3, planId: options.planId, source: 'crash', status: 'paused',
    sessions: residue.sessions.map((row) => ({ sessionId: row.sessionId, intent: 'mount', epoch: 0, running: false, lastTurn: null, crash: true })),
    goals: [], jobs: [], attention: [],
  })
  const { engine } = engineFor({ store, probe })
  const result = await engine.hydrate({ residue: { sessions: [{ sessionId: 's1' }, { sessionId: 's2' }], at: 5 } })
  assert.deepEqual(result, { phase: 'paused', durable: true })
  assert.deepEqual(store.state.plan.sessions.map((row) => [row.sessionId, row.intent]), [['s1', 'continue'], ['s2', 'mount']])
  assert.equal(store.state.plan.crashes, 1)
  assert.deepEqual(store.state.plan.attention, [{ kind: 'session', id: 's2', detail: 'crashed: turn ended before restart' }])
})

test('armed goals from a crash residue are merged into the pending plan as re-arm rows', async () => {
  const plan = {
    version: 3, planId: 'pause-1', source: 'pause', status: 'paused',
    sessions: [{ sessionId: 's1', running: true, intent: 'continue', epoch: 1, lastTurn: 2 }],
    goals: [], jobs: [], attention: [],
  }
  const store = fakeStore({ plan })
  const probe = fakeProbe()
  probe.crashPlan = (residue, options) => ({
    version: 3, planId: options.planId, source: 'crash', status: 'paused',
    sessions: (residue.sessions ?? []).map((row) => ({ sessionId: row.sessionId, intent: 'mount', epoch: 0, running: false, lastTurn: null, crash: true })),
    goals: (residue.goals ?? []).map((row) => ({ ...row, armedRevision: row.revision })),
    jobs: [], attention: [],
  })
  const { engine } = engineFor({ store, probe })
  await engine.hydrate({
    residue: {
      sessions: [{ sessionId: 's1' }, { sessionId: 's2' }],
      goals: [{ sessionId: 's2', goalId: 'g2', revision: 4 }],
      at: 5,
    },
  })
  // The pause plan's own goal rows stay authoritative; the crash fills the gap.
  assert.deepEqual(store.state.plan.goals, [{ sessionId: 's2', goalId: 'g2', revision: 4, armedRevision: 4, crash: true }])
  assert.deepEqual(store.state.plan.attention, [
    { kind: 'session', id: 's2', detail: 'crashed: turn ended before restart' },
    { kind: 'goal', id: 's2', detail: 'crashed: goal not armed' },
  ])
  assert.deepEqual(store.state.plan.sessions.map((row) => [row.sessionId, row.intent]), [['s1', 'continue'], ['s2', 'mount']])
})

test('a crash plan that holds only goals still resumes them and never fakes a session', async () => {
  const probe = fakeProbe()
  probe.crashPlan = (residue, options) => (residue === null ? null : {
    version: 3, planId: options.planId, source: 'crash', status: 'paused',
    sessions: (residue.sessions ?? []).map((row) => ({ sessionId: row.sessionId, intent: 'mount', epoch: 0, running: false, lastTurn: null, crash: true })),
    goals: (residue.goals ?? []).map((row) => ({ sessionId: row.sessionId, goalId: row.goalId, revision: row.revision, armedRevision: row.revision })),
    jobs: [], attention: [],
  })
  const store = fakeStore()
  const { engine } = engineFor({ store, probe })
  await engine.hydrate({ residue: { sessions: [], goals: [{ sessionId: 's1', goalId: 'g1', revision: 3 }], at: 7 } })
  assert.equal(store.state.pending !== null, true)
  assert.deepEqual(store.state.pending.sessions, [])
  assert.deepEqual(store.state.pending.goals, [{ sessionId: 's1', goalId: 'g1', revision: 3, armedRevision: 3 }])

  const outcome = await engine.resume()
  assert.equal(outcome.status, 'resumed')
  assert.deepEqual(probe.calls.filter((call) => call[0] === 'goal'), [['goal', 'g1']])
  assert.equal(store.state.pending, null)
  assert.equal(store.state.result.planId !== undefined, true)
})

test('a crash residue that cannot be stored keeps the old heartbeat and is retried on the next boot', async () => {  const store = fakeStore({ failPending: true })
  const held = { count: 0, hold() { this.count += 1 } }
  const probe = fakeProbe()
  probe.crashPlan = (residue, options) => ({
    version: 3, planId: options.planId, source: 'crash', status: 'paused',
    sessions: residue.sessions.map((row) => ({ sessionId: row.sessionId, intent: 'mount', epoch: 0, running: false, lastTurn: null, crash: true })),
    goals: [], jobs: [], attention: [],
  })
  const { engine } = engineFor({ store, probe, heartbeat: held })
  const first = await engine.hydrate({ residue: { sessions: [{ sessionId: 's1' }], at: 1 } })
  assert.deepEqual(first, { phase: 'idle', durable: false })
  assert.equal(held.count, 1)
  assert.equal(store.state.pending, null)

  // Next start: the same old heartbeat is still on disk, and the store works again.
  store.state.failPending = false
  const { engine: second } = engineFor({ store, probe, heartbeat: held })
  const again = await second.hydrate({ residue: { sessions: [{ sessionId: 's1' }], at: 1 } })
  assert.deepEqual(again, { phase: 'idle', durable: true })
  assert.deepEqual(store.state.pending.sessions.map((row) => row.sessionId), ['s1'])
})

test('a pause after a restore attempt starts a new continuation cycle', async () => {
  const plan = {
    version: 3, planId: 'p1', source: 'pause', status: 'paused',
    sessions: [{ sessionId: 's1', running: true, intent: 'continue', epoch: 1, lastTurn: 4 }],
    goals: [], jobs: [], attention: [], restore: { attempts: 1, restored: [], skipped: [], failed: [], attention: [] },
  }
  const store = fakeStore({ plan })
  const probe = fakeProbe({ readable: true, sessions: [{ sessionId: 's1', running: true, lastTurn: 5 }], goals: [], jobs: [] }, { canceled: ['s1'] })
  const { engine } = engineFor({ store, probe })
  assert.equal((await engine.pause()).status, 'paused')
  assert.equal(store.state.plan.sessions[0].epoch, 2)
})

test('an old instance cannot write its pause result after a reload', async () => {
  const store = fakeStore()
  const probe = fakeProbe({ readable: true, sessions: [{ sessionId: 's1', running: true }], goals: [], jobs: [] })
  let release = null
  probe.stop = () => new Promise((resolve) => {
    release = () => resolve({ canceled: ['s1'], unknown: [], pausedGoals: [], goalErrors: [], killedJobs: [], jobErrors: [], stillRunning: [], sessions: [] })
  })
  const epoch = nextEpoch()
  const { engine } = engineFor({ store, probe })
  // The engine reads the module-level epoch at creation time; rebuild it with the captured one.
  const { createEngine } = await import('../lib/engine.js')
  const old = createEngine({ store, probe, epoch, now: () => 1700000000000, bootId: 'boot-1', log: () => {} })
  const pressing = old.pause()
  await new Promise((resolve) => setImmediate(resolve))
  nextEpoch() // a new instance is now the owner
  release()
  const outcome = await pressing
  assert.equal(outcome.status, 'failed')
  assert.equal(outcome.reason, 'reloaded')
  assert.equal(store.state.writes.length, 1)
  assert.equal(store.state.plan.status, 'pausing')
  assert.equal(engine.describe().action, 'resume')
})

test('a failed goal pause or job kill makes the stop partial and names the item', async () => {
  const live = { readable: true, sessions: [], goals: [{ sessionId: 's1', goalId: 'g1', revision: 2 }], jobs: [{ id: 'j1', owner: 's1', status: 'running' }] }
  const probe = fakeProbe(live, { goalErrors: ['goal g1: boom'], jobErrors: ['job j1: boom'] })
  const { store, engine } = engineFor({ probe })
  const outcome = await engine.pause()
  assert.equal(outcome.status, 'partial')
  assert.equal(engine.describe().complete, false)
  assert.equal(engine.describe().error, 'pause-partial')
  assert.deepEqual(store.state.plan.attention.map((row) => row.id), ['s1', 'j1'])
})

// v0.4.4: handover constraints between the engine, the durable store and the heartbeat.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createStore } from '../lib/snapshot.js'
import { createHeartbeat } from '../lib/heartbeat.js'

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'dsh-pause-resume-'))
}

test('an interrupted pause resets the whole restore policy, not only the legacy fields', async () => {
  const plan = {
    version: 3, planId: 'pause-x', status: 'pausing', source: 'pause', interrupted: true,
    sessions: [{ sessionId: 's1', running: true, intent: 'continue', epoch: 1, lastTurn: 7 }],
    goals: [], jobs: [], attention: [],
  }
  const store = fakeStore({ plan })
  const seen = []
  const probe = fakeProbe()
  probe.restoreSession = async (session) => {
    seen.push(session)
    return { status: 'restored', detail: 'attached' }
  }
  const { engine } = engineFor({ store, probe })
  await engine.hydrate()
  const outcome = await engine.resume()
  assert.equal(outcome.status, 'resumed')
  assert.deepEqual(seen.map((row) => [row.intent, row.epoch, row.running]), [['mount', 0, false]])
})

test('a merged crash plan is the one resumed after its write failed, so no new session is lost', async () => {
  const pending = {
    version: 3, planId: 'crash-1', source: 'crash', status: 'paused',
    sessions: [{ sessionId: 'old-s1', intent: 'mount', epoch: 0, running: false, crash: true }],
    goals: [], jobs: [], attention: [],
  }
  const store = fakeStore({ failPending: true })
  store.state.pending = pending
  const probe = fakeProbe()
  probe.crashPlan = (residue, options) => ({
    version: 3, planId: options.planId, source: 'crash', status: 'paused',
    sessions: residue.sessions.map((row) => ({ sessionId: row.sessionId, intent: 'mount', epoch: 0, running: false, crash: true })),
    goals: [], jobs: [], attention: [],
  })
  const { engine } = engineFor({ store, probe })
  await engine.hydrate({ residue: { sessions: [{ sessionId: 'old-s1' }, { sessionId: 'new-s2' }], at: 9 } })
  assert.equal(store.state.pending.planId, 'crash-1')
  assert.equal(engine.describe().action, 'resume')

  store.state.failPending = false
  const outcome = await engine.resume()
  assert.equal(outcome.status, 'resumed')
  // Every row here is a mount-only crash row: the merged plan is what had to be resumed, and both
  // sessions are attached rather than reported as skipped.
  assert.deepEqual(outcome.summary.restored, ['session old-s1', 'session new-s2'])
  assert.deepEqual(probe.calls.filter((call) => call[0] === 'session').map((call) => call[1]), ['old-s1', 'new-s2'])
  assert.equal(store.state.pending, null)
})

test('release() restores the heartbeat lifecycle: timer and state events write again', async () => {
  const dir = tempDir()
  try {
    let running = ['s0']
    // A long interval keeps the periodic tick out of the way, so the state-event path is the one
    // that has to write after the release; the next case covers the periodic tick itself.
    const beat = createHeartbeat({ dir, bootId: 'boot-1', intervalMs: 10000, listRunning: () => running, log: () => {} })
    beat.start()
    beat.hold()
    await new Promise((resolve) => setTimeout(resolve, 80))
    running = ['s1']
    beat.release()
    await new Promise((resolve) => setTimeout(resolve, 60))
    const sampled = JSON.parse(readFileSync(join(dir, 'running.json'), 'utf8'))
    // The forced sample landed, so the heartbeat describes this process again.
    assert.deepEqual(sampled.sessions.map((row) => row.sessionId), ['s1'])
    running = ['s2']
    beat.note(['s2'])
    await new Promise((resolve) => setTimeout(resolve, 260))
    const noted = JSON.parse(readFileSync(join(dir, 'running.json'), 'utf8'))
    // State events can persist too; `stopped` no longer swallows them.
    assert.deepEqual(noted.sessions.map((row) => row.sessionId), ['s2'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a restore that lost its instance cannot consume a plan another press merged', async () => {
  const plan = {
    version: 3, planId: 'p1', source: 'pause', status: 'paused',
    sessions: [{ sessionId: 's1', intent: 'mount', epoch: 0, running: false, lastTurn: null }],
    goals: [], jobs: [], attention: [],
  }
  const store = fakeStore({ plan })
  const probe = fakeProbe()
  let releaseMount = null
  probe.restoreSession = () => new Promise((resolve) => {
    releaseMount = () => resolve({ status: 'restored', detail: 'attached' })
  })
  const { createEngine } = await import('../lib/engine.js')
  const old = createEngine({ store, probe, epoch: nextEpoch(), now: () => 1700000000000, bootId: 'boot-1', log: () => {} })
  const resuming = old.resume()
  await new Promise((resolve) => setImmediate(resolve))
  nextEpoch()
  store.state.plan = {
    ...plan,
    sessions: [...plan.sessions, { sessionId: 's2', intent: 'mount', epoch: 0, running: false, lastTurn: null }],
    goals: [{ sessionId: 's2', goalId: 'g2', revision: 3 }],
  }
  releaseMount()
  const outcome = await resuming
  assert.equal(outcome.status, 'partial')
  assert.equal(store.state.consumed, null)
  assert.deepEqual(store.state.plan.sessions.map((row) => row.sessionId), ['s1', 's2'])
})

test('a goal whose checkpoint cannot be written keeps the plan instead of skipping it', async () => {
  const plan = {
    version: 3, planId: 'p2', source: 'pause', status: 'paused',
    sessions: [], goals: [{ sessionId: 's1', goalId: 'g1', revision: 3 }], jobs: [], attention: [],
  }
  const store = fakeStore({ plan })
  const probe = fakeProbe()
  probe.restoreGoal = async () => ({ status: 'restored', detail: 'armed', revision: 4 })
  const { engine } = engineFor({ store, probe })
  store.state.failWrite = true
  const outcome = await engine.resume()
  assert.equal(outcome.status, 'partial')
  assert.equal(store.state.consumed, null)
  assert.equal(engine.describe().phase, 'paused')
  assert.match(outcome.summary.failed.join(' '), /(restore intent|checkpoint) not saved/u)
})

test('release() re-arms the periodic sample, not only the state-event path', async () => {
  const dir = tempDir()
  try {
    let running = ['s1']
    const beat = createHeartbeat({ dir, bootId: 'boot-1', intervalMs: 40, listRunning: () => running, log: () => {} })
    beat.start()
    beat.hold()
    running = ['s2']
    beat.release()
    running = ['s3']
    await new Promise((resolve) => setTimeout(resolve, 220))
    const rows = JSON.parse(readFileSync(join(dir, 'running.json'), 'utf8'))
    assert.deepEqual(rows.sessions.map((row) => row.sessionId), ['s3'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a crash record merged into a pause plan survives a failed merge write', async () => {
  const plan = {
    version: 3, planId: 'pause-1', status: 'paused', source: 'pause',
    sessions: [{ sessionId: 's1', intent: 'continue', epoch: 0, running: true, lastTurn: 1 }],
    goals: [], jobs: [], attention: [],
  }
  const store = fakeStore({ plan, failWrite: true })
  const held = { count: 0, hold() { this.count += 1 }, release() { held.released = (held.released ?? 0) + 1 } }
  const probe = fakeProbe()
  probe.crashPlan = (residue, options) => ({
    version: 3, planId: options.planId, source: 'crash', status: 'paused',
    sessions: residue.sessions.map((row) => ({ sessionId: row.sessionId, intent: 'mount', epoch: 0, running: false, lastTurn: null, crash: true })),
    goals: [], jobs: [], attention: [],
  })
  const { engine } = engineFor({ store, probe, heartbeat: held })
  const hydrated = await engine.hydrate({ residue: { sessions: [{ sessionId: 's2' }], at: 2 } })
  assert.equal(hydrated.durable, false)
  assert.equal(held.count, 1)

  const outcome = await engine.resume()
  assert.equal(outcome.status, 'resumed')
  // `s1` was paused mid-turn and is continued; `s2` was only present when the process died, so it is
  // attached and probed instead of being dropped from the restore.
  assert.deepEqual(probe.calls.filter((call) => call[0] === 'session').map((call) => call[1]), ['s1', 's2'])
  assert.equal(held.released, 1)
  assert.equal(store.state.plan, null)
})

test('a pause that repairs a failed merge hands the heartbeat back once its plan is durable', async () => {
  // A failed merge holds the heartbeat so the old residue file is not overwritten. If the next
  // press makes the complete plan durable, nothing may keep that hold: a heartbeat frozen for the
  // rest of the process would describe work from before the restart on the next boot.
  const plan = {
    version: 3, planId: 'pause-hold-1', status: 'paused', source: 'pause',
    sessions: [{ sessionId: 's1', intent: 'continue', epoch: 1, running: true, lastTurn: 1 }],
    goals: [], jobs: [], attention: [],
  }
  const store = fakeStore({ plan, failWrite: true })
  const held = { count: 0, released: 0, hold() { this.count += 1 }, release() { this.released += 1 } }
  const live = { readable: true, sessions: [{ sessionId: 's1', running: true, lastTurn: 2 }], goals: [], jobs: [] }
  const probe = fakeProbe(live)
  probe.crashPlan = (residue, options) => ({
    version: 3, planId: options.planId, source: 'crash', status: 'paused',
    sessions: residue.sessions.map((row) => ({ sessionId: row.sessionId, intent: 'mount', epoch: 0, running: false, lastTurn: null, crash: true })),
    goals: [], jobs: [], attention: [],
  })
  const { engine } = engineFor({ store, probe, heartbeat: held })
  const hydrated = await engine.hydrate({ residue: { sessions: [{ sessionId: 's2' }], at: 2 } })
  assert.equal(hydrated.durable, false)
  assert.equal(held.count, 1)

  store.state.failWrite = false
  const outcome = await engine.pause()
  assert.equal(outcome.status, 'paused')
  assert.equal(held.released, 1)
  // The repaired plan is on disk, so a later process restores the merged sessions, not just s1.
  assert.deepEqual(store.state.plan.sessions.map((row) => row.sessionId).sort(), ['s1', 's2'])
})

test('a resume that could not checkpoint a goal keeps the restore intent for the next boot', async () => {
  const plan = {
    version: 3, planId: 'pause-2', status: 'paused', source: 'pause',
    sessions: [], goals: [{ sessionId: 's1', goalId: 'g1', revision: 3, armedRevision: null }], jobs: [], attention: [],
  }
  const store = fakeStore({ plan })
  const baseWrite = store.write
  let writes = 0
  store.write = (next) => {
    writes += 1
    if (writes === 2) return null
    return baseWrite(next)
  }
  const probe = fakeProbe()
  probe.restoreGoal = async (goal) => {
    probe.calls.push(['goal', goal.goalId])
    return { status: 'restored', detail: 'armed', revision: 4 }
  }
  const first = engineFor({ store, probe }).engine
  const outcome = await first.resume()
  assert.equal(outcome.status, 'partial')
  assert.equal(store.state.consumed, null)
  assert.match(outcome.summary.failed.join(' '), /checkpoint not saved/u)
  assert.match(first.describe().result.failed.join(' '), /checkpoint not saved/u)
  const saved = store.state.plan.goals.find((row) => row.goalId === 'g1')
  assert.equal(saved.armedRevision, null)
  assert.equal(saved.pendingRestore.revision, 3)
  assert.equal(saved.pendingRestore.expect, 4)

  // Next boot: the intent on disk is what proves this goal is ours to arm again.
  const second = fakeProbe()
  second.restoreGoal = async (goal) => {
    second.calls.push(['goal', goal.goalId])
    return { status: 'restored', detail: 'armed', revision: 5 }
  }
  const nextEngine = engineFor({ store, probe: second }).engine
  await nextEngine.hydrate()
  assert.equal(nextEngine.phase, 'paused')
  const secondOutcome = await nextEngine.resume()
  assert.equal(secondOutcome.status, 'resumed')
  assert.equal(second.calls.filter((call) => call[0] === 'goal').length, 1)
  assert.equal(store.state.consumed.plan.planId, 'pause-2')
})

test('restore attention stays visible after the plan is consumed and nothing is live', async () => {
  const plan = {
    version: 3, planId: 'pause-3', status: 'paused', source: 'pause',
    sessions: [{ sessionId: 's1', intent: 'continue', epoch: 0, running: true, lastTurn: 2 }], goals: [], jobs: [], attention: [],
  }
  const probe = fakeProbe()
  probe.restoreSession = async () => ({ status: 'attention', detail: 'continuation admitted, no turn started' })
  const { engine } = engineFor({ store: fakeStore({ plan }), probe })
  const outcome = await engine.resume()
  assert.equal(outcome.status, 'resumed')
  assert.equal(engine.phase, 'idle')
  const state = engine.describe()
  assert.equal(state.action, 'none')
  assert.equal(state.attention, 1)
  assert.equal(state.focus, 's1')
})

test('a killed job is explained once and never becomes a permanent restore attention', async () => {
  const plan = {
    version: 3, planId: 'pause-4', status: 'paused', source: 'pause',
    sessions: [], goals: [], jobs: [{ id: 'j1', owner: 's1', status: 'running' }], attention: [],
  }
  const { engine } = engineFor({ store: fakeStore({ plan }) })
  const outcome = await engine.resume()
  assert.equal(outcome.status, 'resumed')
  assert.equal(outcome.summary.jobsStopped.length, 1)
  assert.equal(engine.describe().attention, 0)
  assert.equal(engine.describe().action, 'none')
})

test('a pause plan left in the crash slot can finish its restore instead of staying busy', async () => {
  const plan = {
    version: 3, planId: 'pause-crash-slot', status: 'paused', source: 'pause',
    sessions: [{ sessionId: 's1', intent: 'mount', epoch: 0, running: false, lastTurn: null }],
    goals: [], jobs: [], attention: [],
  }
  const store = fakeStore({ plan })
  store.state.pending = plan
  store.state.plan = null
  const held = { count: 0, hold() { this.count += 1 }, release() { held.released = (held.released ?? 0) + 1 } }
  const { engine } = engineFor({ store, heartbeat: held })
  await engine.hydrate()
  const outcome = await engine.resume()
  assert.equal(outcome.status, 'resumed')
  assert.equal(engine.phase, 'idle')
  assert.notEqual(engine.describe().action, 'busy')
  assert.equal(store.state.pending, null)
  assert.equal(held.released, 1)
})

test('a new pause bumps only the sessions it captured, never another plan own continuation', async () => {
  const plan = {
    version: 3, planId: 'pause-old', status: 'paused', source: 'pause',
    sessions: [{ sessionId: 's1', intent: 'continue', epoch: 1, running: true, lastTurn: 2 }],
    goals: [], jobs: [], attention: [],
  }
  const store = fakeStore({ plan })
  const probe = fakeProbe({ readable: true, sessions: [{ sessionId: 's3', running: true, lastTurn: 0 }], goals: [], jobs: [] }, { canceled: ['s3'] })
  const { engine } = engineFor({ store, probe })
  assert.equal((await engine.pause()).status, 'paused')
  const rows = new Map(store.state.plan.sessions.map((row) => [row.sessionId, row]))
  assert.equal(rows.get('s1').epoch, 1)
  assert.equal(rows.get('s3').epoch, 1)
})

test('a pending duplicate left by a failed migration cleanup is cleared before the plan is consumed', async () => {
  const plan = {
    version: 3, planId: 'pause-migrated', status: 'paused', source: 'pause',
    sessions: [{ sessionId: 's1', intent: 'mount', epoch: 0, running: false, lastTurn: null }],
    goals: [], jobs: [], attention: [],
  }
  const store = fakeStore({ plan })
  store.state.pending = plan
  const held = { hold() {}, release() { held.released = true } }
  const { engine } = engineFor({ store, heartbeat: held })
  await engine.hydrate()
  const outcome = await engine.resume()
  assert.equal(outcome.status, 'resumed')
  assert.equal(store.state.pending, null)
  assert.equal(store.state.consumed.plan.planId, 'pause-migrated')
})

test('distinct restore attention strings are counted separately and old job noise is ignored', async () => {
  const store = fakeStore()
  store.state.result = {
    summary: {
      attention: [
        'job bash-1: stopped, not restarted',
        'session s1: continuation admitted, no turn started',
        'session s2: turn cannot be proven finished',
      ],
    },
  }
  const { engine } = engineFor({ store })
  await engine.hydrate()
  const state = engine.describe()
  assert.equal(state.attention, 2)
  assert.equal(state.focus, 's1')
})

test('a successful pause clears the previous restore report so its dot does not outlive the cycle', async () => {
  const store = fakeStore()
  store.state.result = {
    summary: {
      attention: ['session s1: continuation admitted, no turn started'],
    },
  }
  // A different session is running: a restore row about s1 still needs a look, so the dot stays
  // until the pause clears the report. A row about a session that is itself running is resolved by
  // live state instead (covered by the manual-continue test below).
  const probe = fakeProbe({ readable: true, sessions: [{ sessionId: 's9', running: true, lastTurn: 2 }], goals: [], jobs: [] }, { canceled: ['s9'] })
  const { engine } = engineFor({ store, probe })
  await engine.hydrate()
  assert.equal(engine.describe().attention, 1)

  const outcome = await engine.pause()
  assert.equal(outcome.status, 'paused')
  assert.equal(store.state.result, null)
  assert.equal(engine.describe().attention, 0)
})

test('a partial restore releases the heartbeat once the merged plan is durable', async () => {
  const plan = {
    version: 3, planId: 'pause-held', status: 'paused', source: 'pause',
    sessions: [{ sessionId: 's1', intent: 'continue', epoch: 0, running: true, lastTurn: 1 }],
    goals: [], jobs: [], attention: [],
  }
  const store = fakeStore({ plan, failWrite: true })
  const held = { count: 0, hold() { this.count += 1 }, release() { held.released = (held.released ?? 0) + 1 } }
  const probe = fakeProbe()
  const { engine } = engineFor({ store, probe, heartbeat: held })
  const hydrated = await engine.hydrate({ residue: { sessions: [{ sessionId: 's2' }], at: 2 } })
  assert.equal(hydrated.durable, false)
  assert.equal(held.count, 1)

  store.state.failWrite = false
  probe.restoreSession = async (session) => {
    probe.calls.push(['session', session.sessionId])
    if (session.sessionId === 's1') return { status: 'failed', detail: 'MOUNT_FAILED' }
    return { status: 'restored', detail: 'attached' }
  }
  const outcome = await engine.resume()
  assert.equal(outcome.status, 'partial')
  assert.equal(held.released, 1)
  assert.deepEqual(store.state.plan.sessions.map((row) => row.sessionId), ['s1', 's2'])

  const next = engineFor({ store, heartbeat: held, bootId: 'b2' })
  await next.engine.hydrate({ residue: { sessions: [{ sessionId: 's3' }], at: 3 } })
  assert.deepEqual(store.state.plan.sessions.map((row) => row.sessionId), ['s1', 's2', 's3'])
  assert.equal(store.state.plan.sessions.find((row) => row.sessionId === 's2').intent, 'mount')
})

test('a goal-only session keeps its continuation cycle when another turn is captured', async () => {
  const plan = {
    version: 3, planId: 'pause-goal-only', status: 'paused', source: 'pause',
    sessions: [{ sessionId: 's1', intent: 'continue', epoch: 1, running: true, lastTurn: 2 }],
    goals: [{ sessionId: 's1', goalId: 'g1', revision: 2 }], jobs: [], attention: [],
  }
  const live = {
    readable: true,
    sessions: [{ sessionId: 's1', running: false, lastTurn: 2 }, { sessionId: 's3', running: true, lastTurn: 0 }],
    goals: [{ sessionId: 's1', goalId: 'g1', revision: 2 }],
    jobs: [],
  }
  const probe = fakeProbe(live, {
    canceled: ['s3'],
    pausedGoals: [{ sessionId: 's1', goalId: 'g1', pausedRevision: 3 }],
  })
  const { store, engine } = engineFor({ store: fakeStore({ plan }), probe })
  assert.equal((await engine.pause()).status, 'paused')
  const rows = new Map(store.state.plan.sessions.map((row) => [row.sessionId, row]))
  assert.equal(rows.get('s1').epoch, 1)
  assert.equal(rows.get('s3').epoch, 1)
})

test('a smaller pending copy is cleared as covered, not resurrected as another restore', async () => {
  const plan = {
    version: 3, planId: 'pause-grown', status: 'paused', source: 'pause',
    sessions: [
      { sessionId: 's1', intent: 'mount', epoch: 0, running: false, lastTurn: null },
      { sessionId: 's2', intent: 'mount', epoch: 0, running: false, lastTurn: null },
    ],
    goals: [], jobs: [], attention: [],
  }
  const pending = {
    version: 3, planId: 'pause-grown', status: 'paused', source: 'crash',
    sessions: [{ sessionId: 's1', intent: 'mount', epoch: 0, running: false, lastTurn: null, crash: true }],
    goals: [], jobs: [], attention: [],
  }
  const store = fakeStore({ plan })
  store.state.pending = pending
  const { engine } = engineFor({ store })
  const outcome = await engine.resume()
  assert.equal(outcome.status, 'resumed')
  assert.equal(store.state.pending, null)
  assert.equal(store.state.consumed.plan.planId, 'pause-grown')
  assert.deepEqual(store.state.consumed.plan.sessions.map((row) => row.sessionId), ['s1', 's2'])
})

test('a pending copy with work the snapshot does not cover is not deleted', async () => {
  const plan = {
    version: 3, planId: 'pause-grown', status: 'paused', source: 'pause',
    sessions: [{ sessionId: 's1', intent: 'mount', epoch: 0, running: false, lastTurn: null }],
    goals: [], jobs: [], attention: [],
  }
  const pending = {
    version: 3, planId: 'pause-grown', status: 'paused', source: 'crash',
    sessions: [
      { sessionId: 's1', intent: 'mount', epoch: 0, running: false, lastTurn: null, crash: true },
      { sessionId: 's2', intent: 'mount', epoch: 0, running: false, lastTurn: null, crash: true },
    ],
    goals: [], jobs: [], attention: [],
  }
  const store = fakeStore({ plan })
  store.state.pending = pending
  const { engine } = engineFor({ store })
  const outcome = await engine.resume()
  assert.equal(outcome.status, 'resumed')
  assert.notEqual(store.state.pending, null)
})

test('a goal already proven by its exact armed revision still writes a pre-arm checkpoint', async () => {
  const plan = {
    version: 3, planId: 'pause-armed', status: 'paused', source: 'pause', sessions: [],
    goals: [{ sessionId: 's1', goalId: 'g1', revision: 3, armedRevision: 4, pendingRestore: null }], jobs: [], attention: [],
  }
  const { probe, engine } = engineFor({ store: fakeStore({ plan }) })
  const outcome = await engine.resume()
  assert.equal(outcome.status, 'resumed')
  assert.deepEqual(probe.calls.map((call) => call[0]), ['prepareGoal', 'goal'])
})

test('a post-stop write failure keeps the complete plan in memory for a resume', async () => {
  const probe = fakeProbe({
    sessions: [{ sessionId: 's1', running: true, lastTurn: 2 }],
    goals: [],
    jobs: [],
    readable: true,
  })
  const store = fakeStore({ failWriteAfter: 1 })
  const { engine } = engineFor({ store, probe })
  const paused = await engine.pause()
  assert.equal(paused.status, 'paused')
  assert.equal(engine.describe().error, 'store')
  // The durable file still says `pausing`; the in-memory fallback must still offer a real resume
  // instead of degrading this process to mount-only.
  assert.equal(engine.describe().action, 'resume')
  store.state.failWriteAfter = null
  const resumed = await engine.resume()
  assert.equal(resumed.status, 'resumed')
  const consumed = store.state.consumed?.plan
  assert.equal(consumed.sessions[0].intent, 'continue')
})

test('a stop that throws is reported as partial instead of a clean pause', async () => {
  const probe = fakeProbe({
    sessions: [{ sessionId: 's1', running: true, lastTurn: 2 }],
    goals: [],
    jobs: [],
    readable: true,
  })
  probe.stop = async () => { throw new Error('boom') }
  const store = fakeStore()
  const { engine } = engineFor({ store, probe })
  const paused = await engine.pause()
  assert.equal(paused.status, 'partial')
  const state = engine.describe()
  assert.equal(state.action, 'resume')
  assert.equal(state.complete, false)
  assert.ok(state.attention > 0)
  assert.equal(store.state.plan.attention.some((row) => /stop failed: boom/u.test(row.detail)), true)
  assert.equal(store.state.plan.status, 'partial')
})

test('a session that starts during the pause is continued with the captured turns', async () => {
  const probe = fakeProbe({
    sessions: [{ sessionId: 's1', running: true, lastTurn: 2 }],
    goals: [],
    jobs: [],
    readable: true,
  })
  probe.stop = async () => ({
    canceled: ['s1', 's2'], unknown: [], pausedGoals: [], goalErrors: [], killedJobs: [], jobErrors: [],
    stillRunning: [], sessions: [
      { sessionId: 's1', lastTurn: 3 },
      { sessionId: 's2', lastTurn: 1 },
    ],
    discovered: [{ sessionId: 's2', lastTurn: 0 }],
  })
  const store = fakeStore()
  const { engine } = engineFor({ store, probe })
  await engine.pause()
  const plan = store.state.plan
  assert.deepEqual(plan.sessions.map((row) => row.sessionId), ['s1', 's2'])
  assert.deepEqual(plan.sessions.map((row) => row.intent), ['continue', 'continue'])
  assert.deepEqual(plan.sessions.map((row) => row.lastTurn), [3, 1])
  assert.deepEqual(plan.stopped.discovered, ['s2'])
  assert.ok(plan.sessions.every((row) => row.epoch === 1))
})

test('pause() interrupts a running restore, keeps the plan and stops only what started', async () => {
  const plan = {
    version: 3, planId: 'p9', source: 'pause', status: 'paused',
    sessions: [{ sessionId: 's1', running: true, lastTurn: 1 }, { sessionId: 's2', running: true, lastTurn: 1, parent: 's1' }],
    goals: [], jobs: [], attention: [],
  }
  const store = fakeStore({ plan })
  const probe = fakeProbe()
  const gate = {
    guarded: 0, unguarded: 0, aborted: 0,
    guard() { this.guarded += 1 },
    unguard() { this.unguarded += 1 },
    abort() { this.aborted += 1 },
  }
  let release = null
  probe.restoreSession = async (session) => {
    probe.calls.push(['session', session.sessionId])
    if (session.sessionId === 's1') await new Promise((resolve) => { release = resolve })
    return { status: 'restored', detail: 'attached' }
  }
  const engine = createEngine({ store, probe, now: () => 1700000000000, bootId: 'boot-1', gate, progressive: true, log: () => {} })
  const running = engine.resume()
  while (release === null) await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(engine.phase, 'resuming')

  const outcome = await engine.pause()
  assert.equal(outcome.status, 'paused')
  assert.equal(outcome.interrupted, true)
  assert.equal(gate.aborted, 1, 'queued model requests are refused before pause returns')
  assert.equal(gate.guarded, 1)
  assert.equal(engine.phase, 'paused')
  assert.equal(store.state.plan?.status, 'paused')
  assert.equal(store.state.plan?.sessions.length, 2, 'the undelivered session stays outstanding')
  assert.equal(probe.calls.some((call) => call[0] === 'stop'), true, 'what did start is stopped')
  assert.equal(engine.describe().action, 'resume')

  release()
  const settled = await running
  assert.equal(settled.status, 'interrupted')
  assert.equal(store.state.consumed, null, 'an interrupted restore never consumes the plan')
  assert.equal(probe.calls.filter((call) => call[0] === 'session' && call[1] === 's2').length, 0, 'no dispatch after the interrupt')
  assert.equal(gate.unguarded, 1)
})

test('a non-progressive restore leaves the gate closed and ignores the start gap', async () => {
  const plan = {
    version: 3, planId: 'p10', source: 'pause', status: 'paused',
    sessions: [{ sessionId: 's1', running: true, lastTurn: 1 }, { sessionId: 's2', running: true, lastTurn: 1 }],
    goals: [], jobs: [], attention: [],
  }
  const store = fakeStore({ plan })
  const probe = fakeProbe()
  const gate = {
    guarded: 0, unguarded: 0, aborted: 0,
    guard() { this.guarded += 1 },
    unguard() { this.unguarded += 1 },
    abort() { this.aborted += 1 },
    stats() { return { capacity: 1, running: 0, queued: 0 } },
  }
  const engine = createEngine({
    store, probe, bootId: 'boot-1', gate, progressive: false, startGapMs: 5000, log: () => {},
  })
  assert.equal(engine.describe().restore.progressive, false)
  assert.equal(engine.describe().restore.active, false, 'no batch is running yet')
  const startedAt = Date.now()
  const outcome = await engine.resume()
  const elapsed = Date.now() - startedAt
  assert.equal(outcome.status, 'resumed')
  assert.equal(gate.guarded, 0, 'the optional capacity feature must not touch the request path')
  assert.equal(gate.unguarded, 0)
  assert.ok(elapsed < 1000, 'no batch spacing is applied when the feature is off')
})

test('a progressive restore reports itself as active while the batch runs', async () => {
  const plan = {
    version: 3, planId: 'p11', source: 'crash', status: 'paused',
    sessions: [{ sessionId: 's1', running: false, lastTurn: 1 }],
    goals: [], jobs: [], attention: [],
  }
  const store = fakeStore({ plan })
  const probe = fakeProbe()
  const gate = {
    guarded: 0, unguarded: 0, aborted: 0,
    guard() { this.guarded += 1 },
    unguard() { this.unguarded += 1 },
    abort() { this.aborted += 1 },
    stats() { return { capacity: 1, running: 0, queued: 0 } },
  }
  let release = null
  probe.restoreSession = async (session) => {
    probe.calls.push(['session', session.sessionId])
    await new Promise((resolve) => { release = resolve })
    return { status: 'restored', detail: 'attached' }
  }
  const engine = createEngine({ store, probe, bootId: 'boot-1', gate, progressive: true, log: () => {} })
  const running = engine.resume()
  while (release === null) await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(engine.describe().restore.progressive, true)
  assert.equal(engine.describe().restore.active, true, 'the batch keeps the setting it started with')
  release()
  await running
  assert.equal(gate.guarded, 1)
  assert.equal(gate.unguarded, 1)
})

test('a session an earlier boot restored is checked again instead of trusted', async () => {
  // The journal outlives the process that wrote it. A `restored` row from boot 0 says that boot
  // finished the work; it says nothing about whether a turn is running now, so the row has to be
  // checked again under a fresh continuation cycle.
  const plan = {
    version: 3, planId: 'pause-9', source: 'pause', status: 'paused',
    sessions: [{ sessionId: 's1', intent: 'continue', epoch: 1, running: true, lastTurn: 2 }], goals: [], jobs: [], attention: [],
  }
  const store = fakeStore({ plan })
  store.state.journal.set('s:s1', { status: 'restored', boot: 'boot-0' })
  const probe = fakeProbe()
  const seen = []
  probe.restoreSession = async (session) => {
    seen.push({ sessionId: session.sessionId, epoch: session.epoch })
    return { status: 'restored', detail: 'continued' }
  }
  // consume() clears the journal, so keep what it held before the plan closes.
  let bootAtClose = null
  const baseConsume = store.consume
  store.consume = (next, summary) => {
    bootAtClose = store.state.journal.get('s:s1')?.boot ?? null
    return baseConsume(next, summary)
  }
  const { engine } = engineFor({ store, probe })
  const outcome = await engine.resume()
  assert.equal(outcome.status, 'resumed')
  // Checked again, under a new cycle, so a lost continuation is not mistaken for a finished one.
  assert.deepEqual(seen, [{ sessionId: 's1', epoch: 2 }])
  assert.deepEqual(outcome.summary.restored, ['session s1'])
  assert.deepEqual(outcome.summary.attention, [])
  // Journaled for this boot as well, so the journal and the live answer agree.
  assert.equal(bootAtClose, 'boot-1')
  assert.equal(engine.describe().phase, 'idle')
})

test('a plan that never comes back stays open instead of closing as attention', async () => {
  const plan = {
    version: 3, planId: 'pause-10', source: 'pause', status: 'paused',
    sessions: [{ sessionId: 's1', intent: 'continue', epoch: 0, running: true, lastTurn: 1 }], goals: [], jobs: [], attention: [],
  }
  const store = fakeStore({ plan })
  const probe = fakeProbe()
  probe.restoreSession = async () => {
    probe.calls.push(['session', 's1'])
    return { status: 'failed', detail: 'resume timed out' }
  }
  const { engine } = engineFor({ store, probe, maxRestoreAttempts: 3 })
  assert.equal((await engine.resume()).status, 'partial')
  assert.equal((await engine.resume()).status, 'partial')
  const last = await engine.resume()
  // Out of attempts is not permission to give up: the plan stays on disk, the row stays outstanding
  // and the button keeps offering the same restore. Closing it as attention is how unfinished work
  // disappeared while the page claimed everything was back.
  assert.equal(last.status, 'partial')
  assert.equal(store.state.plan?.planId, 'pause-10')
  assert.equal(store.state.consumed, null)
  assert.equal(last.outstanding, 1)
  assert.deepEqual(store.state.plan.restore.failed, ['session s1: resume timed out'])
  assert.equal(engine.describe().action, 'resume')
  assert.equal(engine.describe().outstanding, 1)
})

test('the glyph flips to pause while a restore is still running, so the press can stop it', async () => {
  const plan = {
    version: 3, planId: 'pause-icon', source: 'pause', status: 'paused',
    sessions: [{ sessionId: 's1', intent: 'continue', epoch: 1, running: true, lastTurn: 1 }],
    goals: [], jobs: [], attention: [],
  }
  const store = fakeStore({ plan })
  const probe = fakeProbe()
  let release = null
  const restored = new Promise((resolve) => { release = resolve })
  probe.restoreSession = async () => {
    await restored
    return { status: 'restored', detail: 'continued' }
  }
  const { engine } = engineFor({ store, probe })
  const running = engine.resume()
  // Wait for the restore to actually be in flight before asking what the button shows.
  for (let i = 0; i < 100 && engine.describe().phase !== 'resuming'; i += 1) await new Promise((r) => setTimeout(r, 5))
  assert.equal(engine.describe().phase, 'resuming')
  assert.equal(engine.describe().action, 'pause')
  release()
  await running
  assert.equal(engine.describe().phase, 'idle')
})

test('a crash session and its goal are attached and re-armed by a resume', async () => {
  // The shape from the field: a pause plan plus a crash residue. One paused turn must continue; the
  // session and the goal that only existed when the process died must not start work again.
  const plan = {
    version: 3, planId: 'pause-mixed', status: 'paused', source: 'pause',
    sessions: [{ sessionId: 's1', intent: 'continue', epoch: 1, running: true, lastTurn: 2 }],
    goals: [], jobs: [], attention: [],
  }
  const store = fakeStore({ plan })
  const probe = fakeProbe()
  probe.crashPlan = (residue, options) => ({
    version: 3, planId: options.planId, source: 'crash', status: 'paused',
    sessions: (residue.sessions ?? []).map((row) => ({ sessionId: row.sessionId, intent: 'mount', epoch: 0, running: false, lastTurn: null, crash: true })),
    goals: (residue.goals ?? []).map((row) => ({ ...row, armedRevision: row.revision, crash: true })),
    jobs: [], attention: [],
  })
  probe.restoreSession = async (session) => {
    probe.calls.push(['session', session.sessionId])
    return { status: 'restored', detail: 'continued' }
  }
  const { engine } = engineFor({ store, probe })
  await engine.hydrate({
    residue: { sessions: [{ sessionId: 's2' }], goals: [{ sessionId: 's2', goalId: 'g2', revision: 3 }], at: 7 },
  })
  const outcome = await engine.resume()
  assert.equal(outcome.status, 'resumed')
  // Both sessions are probed: the paused one continues and the crash one is attached. The crash
  // goal is restored too — the gate that dropped it whenever the predecessor turn was unprovable is
  // what turned a whole crashed set into attention with zero goals resumed.
  assert.deepEqual(probe.calls.filter((call) => call[0] === 'session'), [['session', 's1'], ['session', 's2']])
  assert.deepEqual(probe.calls.filter((call) => call[0] === 'goal'), [['goal', 'g2']])
  assert.ok(outcome.summary.restored.some((row) => /g2/u.test(row)))
  assert.equal(store.state.plan, null)
})

test('a continuation is written to its row before anything waits for its turn', async () => {
  const store = fakeStore({
    plan: {
      version: 3, planId: 'p1', status: 'paused', source: 'pause',
      sessions: [{ sessionId: 's1', intent: 'continue', epoch: 1, lastTurn: 3, running: true }],
      goals: [], jobs: [],
    },
  })
  const { engine } = engineFor({ store })
  await engine.hydrate({ residue: null })
  assert.equal(engine.ownsAdmission('s1'), true, 'the plan row is the engine-owned admission')
  assert.equal(engine.ownsAdmission('s9'), false)
  assert.equal(engine.recordAdmission('s1', 'continue:p1:s1:1:0'), true)
  assert.equal(store.state.plan.sessions[0].admittedRequest, 'continue:p1:s1:1:0')
  // A row this plan does not name cannot be acknowledged, and saying otherwise would let the probe
  // press a continuation it can never account for.
  assert.equal(engine.recordAdmission('s9', 'continue:p1:s9:1:0'), false)
  store.state.failWrite = true
  assert.equal(engine.recordAdmission('s1', 'continue:p1:s1:1:1'), false)
})

test('sessions found during a pause are in the plan before anything stops them', async () => {
  const store = fakeStore({
    plan: {
      version: 3, planId: 'p1', status: 'pausing', source: 'pause',
      sessions: [{ sessionId: 's1', intent: 'continue', epoch: 1, lastTurn: 3, running: true }],
      goals: [], jobs: [],
    },
  })
  const { engine } = engineFor({ store })
  await engine.hydrate({ residue: null })
  assert.equal(engine.noteDiscovered([{ sessionId: 's2', lastTurn: 4 }, { sessionId: 's1', lastTurn: 3 }, { bogus: true }]), true)
  const rows = store.state.plan.sessions
  assert.deepEqual(rows.map((row) => [row.sessionId, row.intent, row.lastTurn]), [['s1', 'continue', 3], ['s2', 'continue', 4]])
  assert.equal(store.state.plan.sessions[1].running, true)
  // Nothing may be stopped on a plan that could not hold it.
  store.state.failWrite = true
  assert.equal(engine.noteDiscovered([{ sessionId: 's3', lastTurn: 1 }]), false)
  assert.equal(store.state.plan.sessions.some((row) => row.sessionId === 's3'), false)
})


test('a pause during a restore gives a restored session a new cycle only while its turn still runs', async () => {
  const plan = {
    version: 3, planId: 'p12', source: 'pause', status: 'paused',
    sessions: [
      { sessionId: 's1', running: true, lastTurn: 5, epoch: 2, admittedRequest: 'req-a', admittedEpoch: 2 },
      { sessionId: 's2', running: true, lastTurn: 4, epoch: 2, admittedRequest: 'req-b', admittedEpoch: 2 },
      { sessionId: 's3', running: true, lastTurn: 5, epoch: 2, admittedRequest: 'req-c', admittedEpoch: 2 },
    ],
    goals: [], jobs: [], attention: [],
  }
  const store = fakeStore({ plan })
  // s1 was restored by this boot and its turn was still running when the pause was pressed.
  store.state.journal.set('s:s1', { status: 'restored', boot: 'boot-1', epoch: 2, turn: 5 })
  // s3 was restored by this boot and its turn had already ended: nothing is owed any more.
  store.state.journal.set('s:s3', { status: 'restored', boot: 'boot-1', epoch: 2, turn: 5 })
  const probe = fakeProbe(
    { sessions: [{ sessionId: 's1', running: true, lastTurn: 5 }], goals: [], jobs: [], readable: true },
    { sessions: [{ sessionId: 's1', lastTurn: 5 }, { sessionId: 's2', lastTurn: 5 }, { sessionId: 's3', lastTurn: 5 }] },
  )
  let release = null
  probe.restoreSession = async (session) => {
    probe.calls.push(['session', session.sessionId])
    if (session.sessionId === 's2') await new Promise((resolve) => { release = resolve })
    return { status: 'restored', detail: 'attached', turn: 6 }
  }
  const engine = createEngine({ store, probe, now: () => 1700000000000, bootId: 'boot-1', log: () => {} })
  const running = engine.resume()
  while (release === null) await new Promise((resolve) => setTimeout(resolve, 0))

  const outcome = await engine.pause()
  assert.equal(outcome.interrupted, true)
  const rows = new Map(store.state.plan.sessions.map((row) => [row.sessionId, row]))
  assert.equal(rows.get('s1').intent, 'continue', 'a turn cut short still owes its continuation')
  assert.equal(rows.get('s1').epoch, 3, 'the next cycle cannot reuse the request id the old turn consumed')
  assert.equal(rows.get('s1').admittedRequest, undefined, 'an admission consumed by a turn is not waited for again')
  assert.equal(rows.get('s2').intent, 'continue', 'the row that never started stays owed')
  assert.equal(rows.get('s2').epoch, 3, 'its turn advanced while the restore ran, so this is a new cycle')
  assert.equal(rows.get('s3').intent, 'mount', 'a restore whose turn already ended is not started twice')
  assert.equal(rows.get('s3').running, false)
  assert.equal(rows.get('s3').epoch, 0)

  release()
  const settled = await running
  assert.equal(settled.status, 'interrupted')
  assert.equal(store.state.consumed, null)
  const after = new Map(store.state.plan.sessions.map((row) => [row.sessionId, row]))
  assert.deepEqual([...after.values()].map((row) => [row.intent, row.epoch]), [['continue', 3], ['continue', 3], ['mount', 0]], 'a result that lands after the pause does not revive the old cycle')
  assert.equal(after.get('s2').continuedTurn, undefined, "the stale turn is not recorded as this cycle's continuation")
})

test('a pause during a restore keeps an unstarted admission in the same cycle', async () => {
  const plan = {
    version: 3, planId: 'p13', source: 'pause', status: 'paused',
    sessions: [{ sessionId: 's1', running: true, lastTurn: 4, epoch: 1, admittedRequest: 'req-1', admittedEpoch: 1 }],
    goals: [], jobs: [], attention: [],
  }
  const store = fakeStore({ plan })
  const probe = fakeProbe(
    { sessions: [{ sessionId: 's1', running: true, lastTurn: 4 }], goals: [], jobs: [], readable: true },
    { sessions: [{ sessionId: 's1', lastTurn: 4 }] },
  )
  let release = null
  probe.restoreSession = async (session) => {
    probe.calls.push(['session', session.sessionId])
    await new Promise((resolve) => { release = resolve })
    return { status: 'restored', detail: 'attached', turn: 5 }
  }
  const engine = createEngine({ store, probe, now: () => 1700000000000, bootId: 'boot-1', log: () => {} })
  const running = engine.resume()
  while (release === null) await new Promise((resolve) => setTimeout(resolve, 0))

  await engine.pause()
  const row = store.state.plan.sessions[0]
  assert.equal(row.intent, 'continue')
  assert.equal(row.epoch, 1, 'no turn opened, so the cycle is unchanged')
  assert.equal(row.admittedRequest, 'req-1', 'the admitted message must be waited for, not sent again')
  assert.equal(row.admittedEpoch, 1)

  release()
  await running
})


test('a crash residue merged into a pause plan keeps every operation field the plan already had', async () => {
  const plan = {
    version: 3, planId: 'p1', source: 'pause', status: 'paused',
    sessions: [{
      sessionId: 's1', intent: 'continue', epoch: 4, running: true, lastTurn: 5, continuedTurn: 5,
      admittedRequest: 'req-9', admittedEpoch: 4, retry: 2,
    }],
    goals: [{ sessionId: 's1', goalId: 'g1', revision: 9, armedRevision: 7, pendingRestore: { expect: 9 } }],
    jobs: [], attention: [], restore: { attempts: 1 },
  }
  const store = fakeStore({ plan })
  const probe = fakeProbe()
  probe.crashPlan = (residue, options) => ({
    version: 3, planId: options.planId, source: 'crash', status: 'paused',
    sessions: residue.sessions.map((row) => ({ sessionId: row.sessionId, intent: 'continue', epoch: 0, running: true, lastTurn: row.lastTurn, crash: true })),
    goals: residue.goals.map((row) => ({ sessionId: row.sessionId, goalId: row.goalId, revision: row.revision + 1, armedRevision: row.revision + 1, crash: true })),
    jobs: [], attention: [],
  })
  const { engine } = engineFor({ store, probe })
  const first = await engine.hydrate({ residue: { sessions: [{ sessionId: 's1', lastTurn: 9 }, { sessionId: 's2' }], goals: [{ sessionId: 's1', goalId: 'g1', revision: 11 }], at: 1 } })
  assert.equal(first.phase, 'paused')
  const session = store.state.plan.sessions.find((row) => row.sessionId === 's1')
  // The pause plan captured by hand is authoritative: a newer crash record may add work but must
  // not reset the cycle, the admission, or the retry count of a row it already describes.
  assert.equal(session.epoch, 4)
  assert.equal(session.admittedRequest, 'req-9')
  assert.equal(session.admittedEpoch, 4)
  assert.equal(session.continuedTurn, 5)
  assert.equal(session.retry, 2)
  const added = store.state.plan.sessions.find((row) => row.sessionId === 's2')
  assert.equal(added.intent, 'mount')
  assert.equal(added.running, false)
  assert.equal(store.state.plan.goals[0].revision, 9)
  assert.equal(store.state.plan.goals[0].armedRevision, 7)
  assert.deepEqual(store.state.plan.goals[0].pendingRestore, { expect: 9 })
  // Reading the same residue again on the next boot must be a no-op, not a second merge.
  const writes = store.state.writes.length
  const { engine: next } = engineFor({ store, probe })
  await next.hydrate({ residue: { sessions: [{ sessionId: 's1', lastTurn: 9 }, { sessionId: 's2' }], goals: [{ sessionId: 's1', goalId: 'g1', revision: 11 }], at: 1 } })
  assert.equal(store.state.writes.length, writes)
  assert.equal(store.state.plan.sessions.filter((row) => row.sessionId === 's2').length, 1)
})

test('pause() writes what each job stop actually achieved onto the job row', async () => {
  const live = { readable: true, sessions: [], goals: [], jobs: [{ id: 'j1', owner: 's1', status: 'running' }, { id: 'j2', owner: null, status: 'running' }] }
  const probe = fakeProbe(live, {
    killedJobs: [{ id: 'j1', owner: 's1' }],
    jobErrors: ['job j2: stop requested, still running'],
    jobStates: [{ id: 'j1', owner: 's1', status: 'stopped' }, { id: 'j2', owner: null, status: 'stopping', detail: 'still running' }],
    stillRunning: [],
  })
  const store = fakeStore()
  const { engine } = engineFor({ store, probe })
  const outcome = await engine.pause()
  assert.equal(outcome.status, 'partial')
  const written = store.state.writes.at(-1)
  assert.deepEqual(written.jobs, [
    { id: 'j1', owner: 's1', status: 'running', stop: 'stopped' },
    { id: 'j2', owner: null, status: 'running', stop: 'stopping', stopDetail: 'still running' },
  ])
  const state = engine.describe()
  assert.equal(state.action, 'resume')
  assert.equal(state.counts.jobs, 2)
})

test('a plan that only owes a job report resumes without starting anything and is spent once', async () => {
  const plan = {
    version: 3, planId: 'p1', source: 'pause', status: 'partial',
    sessions: [], goals: [],
    jobs: [{ id: 'j1', owner: null, status: 'running', stop: 'stopped' }],
    attention: [{ kind: 'job', id: 'j1', detail: 'stopped, not restarted' }],
  }
  const store = fakeStore({ plan })
  const probe = fakeProbe()
  const { engine } = engineFor({ store, probe })
  // Stopped jobs are reported separately: a clean page does not keep a dot forever.
  assert.equal(engine.describe().attention, 1)
  const outcome = await engine.resume()
  assert.equal(outcome.status, 'resumed')
  assert.equal(outcome.summary.jobs, 1)
  assert.deepEqual(outcome.summary.jobsStopped, ['job j1: stopped, not restarted'])
  assert.equal(probe.calls.some((call) => call[0] === 'session' || call[0] === 'goal'), false)
  assert.equal(store.state.consumed?.plan.planId, 'p1')
})

test('a job settling after the pause does not change the plan or wake the restore', async () => {
  const live = { readable: true, sessions: [], goals: [], jobs: [{ id: 'j1', owner: null, status: 'running' }] }
  const probe = fakeProbe(live, {
    jobErrors: ['job j1: stop requested, still running'],
    jobStates: [{ id: 'j1', owner: null, status: 'stopping', detail: 'still running' }],
  })
  const store = fakeStore()
  const { engine } = engineFor({ store, probe })
  assert.equal((await engine.pause()).status, 'partial')
  const writesAfterPause = store.state.writes.length
  const journalAfterPause = store.state.journal.size
  // The process exits later. Nothing in a paused engine listens for that, so the record must not
  // move: the plan is still the pause's evidence, not a guess at what the job did afterwards.
  live.jobs[0].status = 'completed'
  const state = engine.describe()
  assert.equal(state.action, 'resume')
  assert.equal(store.state.writes.length, writesAfterPause)
  assert.equal(store.state.journal.size, journalAfterPause)
  assert.deepEqual(store.state.plan.jobs, [{ id: 'j1', owner: null, status: 'running', stop: 'stopping', stopDetail: 'still running' }])
})

test('a three-level subagent chain restores in parent-first order', async () => {
  const plan = {
    version: 3, planId: 'p1', source: 'pause', status: 'paused',
    sessions: [
      { sessionId: 's3', running: true, intent: 'continue', epoch: 1, lastTurn: 2, parent: 's2', origin: 'subagent' },
      { sessionId: 's1', running: true, intent: 'continue', epoch: 1, lastTurn: 2 },
      { sessionId: 's2', running: true, intent: 'continue', epoch: 1, lastTurn: 2, parent: 's1', origin: 'subagent' },
    ],
    goals: [], jobs: [], attention: [],
  }
  const probe = fakeProbe()
  const { engine } = engineFor({ store: fakeStore({ plan }), probe })
  const outcome = await engine.resume()
  assert.equal(outcome.status, 'resumed')
  assert.deepEqual(probe.calls.filter((call) => call[0] === 'session').map((call) => call[1]), ['s1', 's2', 's3'])
})

test('a child whose parent is missing gets a mount-only parent row, then restores', async () => {
  const plan = {
    version: 3, planId: 'p1', source: 'pause', status: 'paused',
    sessions: [{ sessionId: 's2', running: true, intent: 'continue', epoch: 0, lastTurn: 1, parent: 's1', origin: 'subagent' }],
    goals: [], jobs: [], attention: [],
  }
  const store = fakeStore({ plan })
  const probe = fakeProbe()
  const { engine } = engineFor({ store, probe })
  const outcome = await engine.resume()
  assert.equal(outcome.status, 'resumed')
  const synthesized = store.state.consumed.plan.sessions.find((row) => row.sessionId === 's1')
  assert.deepEqual(synthesized, { sessionId: 's1', intent: 'mount', epoch: 0, running: false, lastTurn: null, parent: null, origin: 'root', crash: false })
  assert.deepEqual(probe.calls.filter((call) => call[0] === 'session').map((call) => [call[1], call[2]]), [['s1', false], ['s2', true]])
})

test('a cyclic parent map finishes instead of hanging or looping', async () => {
  const plan = {
    version: 3, planId: 'p1', source: 'pause', status: 'paused',
    sessions: [
      { sessionId: 'a', running: true, intent: 'continue', epoch: 1, lastTurn: 1, parent: 'b', origin: 'subagent' },
      { sessionId: 'b', running: true, intent: 'continue', epoch: 1, lastTurn: 1, parent: 'a', origin: 'subagent' },
    ],
    goals: [], jobs: [], attention: [],
  }
  const probe = fakeProbe()
  const { engine } = engineFor({ store: fakeStore({ plan }), probe })
  const outcome = await engine.resume()
  assert.equal(outcome.status, 'resumed')
  const restored = probe.calls.filter((call) => call[0] === 'session').map((call) => call[1]).sort()
  assert.deepEqual(restored, ['a', 'b'])
})

test('a crash record merged into a pause plan keeps the job rows and their stop state', async () => {
  const plan = {
    version: 3, planId: 'p1', source: 'pause', status: 'paused',
    sessions: [{ sessionId: 's1', intent: 'mount', epoch: 0, running: false, lastTurn: 2 }],
    goals: [], attention: [],
    jobs: [{ id: 'j1', owner: 's1', status: 'running', stop: 'stopping', stopDetail: 'still running' }],
  }
  const store = fakeStore({ plan })
  const probe = fakeProbe()
  const engine = createEngine({ store, probe, now: () => 1700000000000, bootId: 'boot-1', log: () => {} })
  await engine.hydrate({ residue: { at: 1699999999999, sessions: [{ sessionId: 's2', lastTurn: 4 }], goals: [] } })
  const merged = store.state.plan
  assert.equal(merged.jobs.length, 1)
  assert.deepEqual(merged.jobs[0], { id: 'j1', owner: 's1', status: 'running', stop: 'stopping', stopDetail: 'still running' })
  assert.deepEqual(merged.sessions.map((row) => row.sessionId).sort(), ['s1', 's2'])
})

test('a pause during a restore writes what the job stop achieved, not just what was requested', async () => {
  const plan = {
    version: 3, planId: 'p1', source: 'pause', status: 'paused',
    sessions: [{ sessionId: 's1', running: true, lastTurn: 5, epoch: 2, intent: 'continue' }],
    goals: [], attention: [],
    jobs: [{ id: 'j1', owner: 's1', status: 'running' }],
  }
  const store = fakeStore({ plan })
  const probe = fakeProbe(
    { sessions: [{ sessionId: 's1', running: true, lastTurn: 5 }], goals: [], jobs: [{ id: 'j1', owner: 's1', status: 'running' }], readable: true },
    { jobStates: [{ id: 'j1', status: 'stopped' }] },
  )
  let release = null
  probe.restoreSession = async (session) => {
    probe.calls.push(['session', session.sessionId])
    await new Promise((resolve) => { release = resolve })
    return { status: 'restored', detail: 'attached', turn: 6 }
  }
  const engine = createEngine({ store, probe, now: () => 1700000000000, bootId: 'boot-1', log: () => {} })
  const running = engine.resume()
  while (release === null) await new Promise((resolve) => setTimeout(resolve, 0))
  const outcome = await engine.pause()
  assert.equal(outcome.interrupted, true)
  assert.equal(store.state.plan.jobs[0].stop, 'stopped')
  release()
  await running
})

test('the progressive restore stays off unless the setting is explicitly enabled', async () => {
  const plan = {
    version: 3, planId: 'p1', source: 'pause', status: 'paused',
    sessions: [{ sessionId: 's1', running: true, lastTurn: 1 }],
    goals: [], jobs: [], attention: [],
  }
  const store = fakeStore({ plan })
  const probe = fakeProbe()
  const gate = { guarded: 0, unguarded: 0, aborted: 0, guard() { this.guarded += 1 }, unguard() { this.unguarded += 1 }, abort() { this.aborted += 1 }, stats() { return { capacity: 1, running: 0, queued: 0 } } }
  const engine = createEngine({ store, probe, bootId: 'boot-1', gate, log: () => {} })
  assert.equal(engine.describe().restore.progressive, false, 'an install that never opted in reports the plain path')
  const outcome = await engine.resume()
  assert.equal(outcome.status, 'resumed')
  assert.equal(gate.guarded, 0)
  assert.equal(gate.unguarded, 0)
  assert.equal(gate.aborted, 0)
})

test('a restore whose rows stay unreadable retires as partial instead of pressing forever', async () => {
  const live = { readable: true, sessions: [], goals: [], jobs: [] }
  const probe = fakeProbe(live)
  probe.restoreSession = async () => ({ status: 'unknown', detail: 'turn state unknown; open the session to decide' })
  const plan = {
    version: 3,
    planId: 'crash-unknown-1',
    status: 'paused',
    source: 'crash',
    createdAt: '1970-01-01T00:00:00.000Z',
    sessions: [{ sessionId: 's1', running: false, lastTurn: 3, intent: 'unknown', epoch: 0, crash: true }],
    goals: [],
    jobs: [],
    attention: [],
  }
  const store = fakeStore()
  store.state.pending = plan
  const { engine } = engineFor({ store, probe })
  const first = await engine.resume()
  assert.equal(first.status, 'partial')
  assert.equal(store.state.pending.status, 'paused')
  assert.equal(store.state.pending.restore.unknownAttempts, 1)
  assert.equal(engine.describe().action, 'resume')
  const second = await engine.resume()
  assert.equal(second.status, 'partial')
  assert.equal(second.summary.attention.length, 1)
  // No progress twice stops auto-retry, but it does not delete the only entry point left: the plan
  // and its row stay readable so the person can still continue or inspect that session.
  assert.notEqual(store.state.pending, null)
  assert.equal(store.state.pending.status, 'partial')
  assert.equal(store.state.pending.restore.unknownAttempts, 2)
  const state = engine.describe()
  assert.equal(state.action, 'resume')
  assert.equal(state.phase, 'paused')
  assert.equal(state.attention, 1)
})

test('a late readable row is still restored once, so retirement waits for real progress', async () => {
  const live = { readable: true, sessions: [], goals: [], jobs: [] }
  const probe = fakeProbe(live)
  let call = 0
  probe.restoreSession = async () => {
    call += 1
    if (call === 1) return { status: 'unknown', detail: 'turn state unknown' }
    return { status: 'skipped', detail: 'turn completed before this restart', continued: false }
  }
  const plan = {
    version: 3,
    planId: 'crash-unknown-2',
    status: 'paused',
    source: 'crash',
    createdAt: '1970-01-01T00:00:00.000Z',
    sessions: [{ sessionId: 's1', running: false, lastTurn: 3, intent: 'unknown', epoch: 0, crash: true }],
    goals: [],
    jobs: [],
    attention: [],
  }
  const store = fakeStore()
  store.state.pending = plan
  const { engine } = engineFor({ store, probe })
  assert.equal((await engine.resume()).status, 'partial')
  const second = await engine.resume()
  assert.equal(second.status, 'resumed')
  assert.equal(store.state.pending, null)
  assert.equal(store.state.result.status, 'restored')
})

test('a manual continue during the press is progress, not a duplicate, and clears its own dot', async () => {
  const live = { readable: true, sessions: [], goals: [], jobs: [] }
  const probe = fakeProbe(live)
  const running = new Set()
  probe.restoreSession = async (session) => {
    probe.calls.push(['session', session.sessionId])
    if (running.has(session.sessionId)) return { status: 'restored', detail: 'already running', continued: true, turn: 8 }
    return { status: 'unknown', detail: 'turn state unknown; open the session to decide' }
  }
  const plan = {
    version: 3,
    planId: 'crash-manual-1',
    status: 'paused',
    source: 'crash',
    createdAt: '1970-01-01T00:00:00.000Z',
    sessions: [
      { sessionId: 's1', running: false, lastTurn: 3, intent: 'unknown', epoch: 0, crash: true },
      { sessionId: 's2', running: false, lastTurn: 3, intent: 'unknown', epoch: 0, crash: true },
      { sessionId: 's3', running: false, lastTurn: 3, intent: 'unknown', epoch: 0, crash: true },
    ],
    goals: [],
    jobs: [],
    attention: [],
  }
  const store = fakeStore()
  store.state.pending = plan
  const { engine } = engineFor({ store, probe })
  // The person continued s2 by hand before this press. The press sends nothing for it, and the
  // reduced unreadable set means real progress, so the plan stays open instead of retiring.
  running.add('s2')
  const first = await engine.resume()
  assert.equal(first.status, 'partial')
  assert.equal(store.state.pending.status, 'paused', 'a manual continue keeps the plan open')
  assert.deepEqual(store.state.pending.restore.unknown.map((line) => /^session ([^:]+):/.exec(line)?.[1]), ['s1', 's3'])
  // Now s3 is continued by hand as well; again one restored row, one unreadable row.
  running.add('s3')
  assert.equal((await engine.resume()).status, 'partial')
  assert.equal(store.state.pending.restore.unknown.length, 1)
  // Nothing changed since the last press: this is where auto-retry stops. The plan is not consumed,
  // so the row that still needs a look keeps its manual entry point.
  const pressed = await engine.resume()
  assert.equal(pressed.status, 'partial')
  assert.notEqual(store.state.pending, null)
  assert.equal(store.state.pending.status, 'partial')
  const state = engine.describe()
  assert.equal(state.action, 'resume')
  assert.equal(state.phase, 'paused')
  assert.equal(state.attention, 1)
  assert.equal(state.focus, 's1', 'only the row still needing a look keeps the dot')
  // s1 is continued by hand after the plan retired: its row stops needing a look.
  running.add('s1')
  live.sessions.push({ sessionId: 's1', running: true })
  assert.equal(engine.describe().attention, 0)
})

test('a partial press replaces the captured crash count with only the rows still unresolved', async () => {
  const live = { readable: true, sessions: [{ sessionId: 's2', running: true }], goals: [], jobs: [] }
  const probe = fakeProbe(live)
  probe.restoreSession = async (session) => {
    probe.calls.push(['session', session.sessionId])
    if (session.sessionId === 's2') return { status: 'restored', detail: 'already running', continued: true, turn: 8 }
    return { status: 'unknown', detail: 'turn state unknown; open the session to decide' }
  }
  const plan = {
    version: 3,
    planId: 'crash-stale-1',
    status: 'paused',
    source: 'crash',
    createdAt: '1970-01-01T00:00:00.000Z',
    sessions: [
      { sessionId: 's1', running: false, lastTurn: 3, intent: 'unknown', epoch: 0, crash: true },
      { sessionId: 's2', running: false, lastTurn: 3, intent: 'unknown', epoch: 0, crash: true },
      { sessionId: 's3', running: false, lastTurn: 3, intent: 'unknown', epoch: 0, crash: true },
    ],
    goals: [],
    jobs: [],
    attention: [{ kind: 'session', id: '', detail: 'crashed: 3 session(s) need a look before continuing' }],
  }
  const store = fakeStore()
  store.state.pending = plan
  const { engine } = engineFor({ store, probe })
  assert.equal((await engine.resume()).status, 'partial')
  const pending = store.state.pending
  // The count cannot survive one of the rows being continued: it would keep claiming three.
  assert.equal(pending.attention.some((row) => /^crashed: /.test(String(row.detail ?? ''))), false)
  assert.deepEqual(pending.attention.map((row) => row.id), ['s1', 's3'])
  assert.equal(engine.describe().attention, 2, 'the two rows the press could not settle need a look; the restored row does not')
  assert.equal(engine.describe().focus, 's1')
  // The person continues s1 by hand: its row clears without another press.
  live.sessions.push({ sessionId: 's1', running: true })
  assert.equal(engine.describe().attention, 1)
  assert.equal(engine.describe().focus, 's3')
  // describe() counts deduped rows, so s2's restored row never returns as attention.
  assert.equal(probe.calls.filter((call) => call[0] === 'prompt').length, 0)
})
