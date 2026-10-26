import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createEngine } from '../lib/engine.js'

/** A store with the same surface as the durable one, small enough to inspect after each press. */
function fakeStore({ plan = null, journal = [], failWrite = false, failConsume = false, failJournal = false, failPending = false } = {}) {
  const state = { plan, pending: null, writes: [], consumed: null, result: null, journal: new Map(), failWrite, failConsume, failJournal, failPending }
  for (const key of journal) state.journal.set(key, { status: 'restored', boot: 'boot-0' })
  return {
    state,
    read: () => state.plan,
    write: (next) => {
      state.writes.push(structuredClone(next))
      if (state.failWrite === true) return null
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
    lastRestore: () => state.result,
    readJournal: () => new Map([...state.journal.entries()]),
    appendJournal: (planId, key, status, boot) => {
      if (state.failJournal === true) return false
      state.journal.set(key, { status, boot })
      return true
    },
    clearJournal: () => {
      state.journal.clear()
    },
    consume: (next, summary) => {
      if (state.failConsume === true) return { ok: false, archivePath: null, published: false }
      state.consumed = { plan: next, summary }
      state.plan = null
      state.journal.clear()
      state.result = { planId: next.planId, status: 'restored', summary }
      return { ok: true, archivePath: '/tmp/restores/x.json', published: true }
    },
  }
}

function fakeProbe(live = { sessions: [], goals: [], jobs: [], readable: true }, stopOutcome = {}) {
  const calls = []
  return {
    calls,
    live: () => live,
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

function engineFor({ store, probe, heartbeat = null, now = () => 1700000000000 } = {}) {
  const s = store ?? fakeStore()
  const p = probe ?? fakeProbe()
  return { store: s, probe: p, engine: createEngine({ store: s, probe: p, heartbeat, now, bootId: 'boot-1', log: () => {} }) }
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
  assert.deepEqual(probe.calls.map((call) => call[0]), ['session', 'goal'])
  assert.equal(engine.phase, 'idle')
  assert.equal(engine.describe().action, 'none')
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
  // The live Harness decides what still needs work, not an old journal: every item is checked
  // again, and the already-restored ones answer "skipped" from their own state.
  assert.deepEqual(probe.calls.slice(probeCallsBefore).map((call) => call[0]), ['session', 'session', 'goal'])
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
  assert.equal(store.state.result.summary.restored.length, 2)
  assert.equal(store.state.result.status, 'restored')
  assert.equal(heartbeat.released, 1)
  assert.equal(second.describe().action, 'none')
})

test('a crash in the middle of a restore keeps the plan and checks every item again', async () => {
  const pending = {
    version: 3, planId: 'crash-9-2', source: 'crash', status: 'paused', sessions: [
      { sessionId: 's1', running: false, lastTurn: null, crash: true },
      { sessionId: 's2', running: false, lastTurn: null, crash: true },
    ], goals: [], jobs: [], attention: [],
  }
  const store = fakeStore({ plan: null })
  store.state.pending = pending
  // The previous process journaled s1 before it died: that row must not silence it now, because a
  // journal is evidence of an attempt, not of a live session.
  store.state.journal.set('s:s1', { status: 'restored', boot: 'b1' })
  let fail = true
  const probe = fakeProbe()
  probe.restoreSession = async (session) => {
    probe.calls.push(['session', session.sessionId, session.running])
    if (session.sessionId === 's1' && fail === true) return { status: 'failed', detail: 'session not ready' }
    return { status: 'restored', detail: 'attached' }
  }
  const { engine } = engineFor({ store, probe })
  await engine.hydrate({ residue: null })
  const partial = await engine.resume()
  assert.equal(partial.status, 'partial')
  assert.equal(store.state.pending.planId, 'crash-9-2')
  assert.equal(engine.describe().error, 'restore-partial')
  fail = false
  const retry = await engine.resume()
  assert.equal(retry.status, 'resumed')
  assert.deepEqual(probe.calls.filter((call) => call[0] === 'session').slice(-2).map((call) => call[1]), ['s1', 's2'])
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
  assert.deepEqual(store.state.plan.attention, [{ kind: 'session', id: 's2', detail: 'crashed: mounted only' }])
})

test('a crash residue that cannot be stored keeps the old heartbeat and is retried on the next boot', async () => {
  const store = fakeStore({ failPending: true })
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
  assert.deepEqual(outcome.summary.restored, ['session old-s1', 'session new-s2'])
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
  assert.match(outcome.summary.failed.join(' '), /checkpoint not saved/u)
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
