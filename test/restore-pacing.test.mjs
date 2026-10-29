import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createEngine } from '../lib/engine.js'

/**
 * Restore pacing is memory safety, not a preference. Each test below pins one of the rules the
 * 2026-10-29 host crashes proved: light rows land first, a large transcript gets the process to
 * itself, and a row is held back instead of mounted once the V8 heap has no room left.
 */

function fakeStore({ plan = null } = {}) {
  const state = { plan, writes: [], result: null, journal: new Map() }
  return {
    state,
    read: () => state.plan,
    write: (next) => {
      state.writes.push(structuredClone(next))
      state.plan = structuredClone(next)
      return state.plan
    },
    readPending: () => null,
    writePending: () => null,
    clearPending: () => true,
    writeResult: (record) => {
      state.result = record
      return true
    },
    clearResult: () => true,
    lastRestore: () => state.result,
    readJournal: () => new Map([...state.journal.entries()]),
    appendJournal: (planId, key, status, boot, extra = null) => {
      state.journal.set(key, { status, boot, epoch: extra?.epoch, turn: extra?.turn })
      return true
    },
    clearJournal: () => state.journal.clear(),
    consume: (next, summary, status = 'restored') => {
      state.result = { planId: next.planId, status, summary }
      state.plan = null
      state.journal.clear()
      return { ok: true, archivePath: '/tmp/restores/x.json', published: true }
    },
  }
}

/**
 * A probe whose sessions can be given a weight, and whose turns can be declared open or closed.
 * `assessSession` is what the pacing gate asks before it admits another large row.
 */
function pacingProbe({ weights = {}, settled = () => true } = {}) {
  const calls = []
  const turnOpen = new Map()
  return {
    calls,
    weights,
    turnOpen,
    live: () => ({ sessions: [], goals: [], jobs: [], readable: true }),
    stop: async () => ({ canceled: [], unknown: [], pausedGoals: [], goalErrors: [], killedJobs: [], jobErrors: [], stillRunning: [] }),
    sessionWeight: async (sessionId) => (weights[sessionId] === undefined ? null : { bytes: weights[sessionId], file: `/tmp/${sessionId}.zstd` }),
    assessSession: async (session) => {
      calls.push(['assess', session.sessionId])
      if (turnOpen.get(session.sessionId) === true) return { action: 'continue', end: 'open', turn: 1 }
      if (settled() === false) return { action: 'continue', end: 'open', turn: 1 }
      return { action: 'skip', end: 'completed', turn: 1 }
    },
    restoreSession: async (session) => {
      calls.push(['session', session.sessionId])
      turnOpen.set(session.sessionId, true)
      return { status: 'restored', detail: 'continued', continued: true, turn: 1, requestId: `r-${session.sessionId}` }
    },
    prepareGoal: async (goal) => ({ status: 'ready', revision: 0 }),
    restoreGoal: async (goal) => ({ status: 'restored', detail: 'armed' }),
    crashPlan: (residue, options) => (residue === null ? null : {
      version: 2,
      planId: options.planId,
      status: 'paused',
      source: 'crash',
      sessions: residue.sessions.map((row) => ({ sessionId: row.sessionId, running: false, lastTurn: null, crash: true, intent: 'continue' })),
      goals: [],
      jobs: [],
    }),
  }
}

function planOf(sessions) {
  return {
    version: 3, planId: 'pacing-1', source: 'crash', status: 'paused',
    sessions: sessions.map((row) => ({ running: false, lastTurn: 1, epoch: 1, intent: 'continue', ...row })),
    goals: [], jobs: [], attention: [],
  }
}

test('the light transcript is restored before the large one, whatever the plan order says', async () => {
  const MB = 1048576
  const probe = pacingProbe({ weights: { heavy: 40 * MB, light: 1 * MB } })
  const engine = createEngine({
    store: fakeStore({ plan: planOf([{ sessionId: 'heavy' }, { sessionId: 'light' }]) }),
    probe, bootId: 'b1', now: () => 1, log: () => {},
  })
  const outcome = await engine.resume()
  assert.equal(outcome.status, 'resumed')
  const order = probe.calls.filter(([kind]) => kind === 'session').map(([, id]) => id)
  assert.deepEqual(order, ['light', 'heavy'], 'cheap rows must land while the heap is still roomy')
})

test('a second large transcript is not mounted while the first one is still working', async () => {
  const MB = 1048576
  let working = true
  const probe = pacingProbe({ weights: { h1: 40 * MB, h2: 40 * MB } })
  // h1 stays open until the test closes it; h2 is admitted only after that.
  probe.assessSession = async (session) => {
    probe.calls.push(['assess', session.sessionId])
    if (session.sessionId === 'h1' && working === true) return { action: 'continue', end: 'open', turn: 1 }
    return { action: 'skip', end: 'completed', turn: 1 }
  }
  const engine = createEngine({
    store: fakeStore({ plan: planOf([{ sessionId: 'h1' }, { sessionId: 'h2' }]) }),
    probe, bootId: 'b1', now: () => 1, restoreSettleMs: 2000, log: () => {},
  })
  const running = engine.resume()
  // h1 is restored, then the second heavy row waits on it. Close the turn and the wait ends.
  while (probe.calls.some(([kind, id]) => kind === 'session' && id === 'h1') === false) {
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  await new Promise((resolve) => setTimeout(resolve, 60))
  assert.equal(probe.calls.some(([kind, id]) => kind === 'session' && id === 'h2'), false, 'one large session at a time')
  working = false
  const outcome = await running
  assert.equal(outcome.status, 'resumed')
  const order = probe.calls.filter(([kind]) => kind === 'session').map(([, id]) => id)
  assert.deepEqual(order, ['h1', 'h2'])
  assert.ok(probe.calls.some(([kind, id]) => kind === 'assess' && id === 'h1'), 'admission waits on the official projection, never on a guess')
})

test('a large row is deferred instead of mounted when the host heap has no room left', async () => {
  const MB = 1048576
  const probe = pacingProbe({ weights: { big: 40 * MB, small: 40 * MB } })
  const store = fakeStore({ plan: planOf([{ sessionId: 'big' }, { sessionId: 'small' }]) })
  const engine = createEngine({
    store, probe, bootId: 'b1', now: () => 1,
    // 3.5 GB used against a 4 GB cap leaves 500 MB, less than the 700 MB reserve.
    heapStats: () => ({ usedMB: 3500, limitMB: 4000 }),
    restoreHeapReserveMB: 700,
    log: () => {},
  })
  const outcome = await engine.resume()
  assert.equal(outcome.status, 'resumed')
  assert.equal(probe.calls.some(([kind]) => kind === 'session'), false, 'nothing is mounted into a heap that is already full')
  const state = engine.describe()
  assert.equal(state.scheduling.deferred.length, 2)
  assert.equal(state.scheduling.deferred[0].reason.includes('heap'), true)
  assert.ok(state.scheduling.restartRecommended !== null, 'the page has to be able to say why the rest was held back')
  assert.equal(state.counts.sessions, 2, 'a deferred row is still owed work, not a failure')
  // The hold is durable: the row is mount-only and names the reason, so the next press finds it.
  for (const row of store.state.plan.sessions) {
    assert.equal(row.intent, 'mount')
    assert.equal(row.running, false)
    assert.equal(typeof row.deferred.at, 'string')
  }
})

test('a row already held back is not promoted back to continue by the next boot', async () => {
  const plan = planOf([{ sessionId: 's1' }, { sessionId: 's2' }])
  plan.sessions[0].deferred = { at: '2026-10-29T02:00:00.000Z', reason: 'host heap is near its limit (3500 MB of 4000 MB)' }
  plan.sessions[0].intent = 'mount'
  plan.sessions[1].deferred = { at: '2026-10-29T02:00:00.000Z', reason: 'an earlier restored session is still working' }
  plan.sessions[1].intent = 'mount'
  const store = fakeStore({ plan })
  const engine = createEngine({ store, probe: pacingProbe(), bootId: 'b2', now: () => 2, log: () => {} })
  await engine.hydrate({ residue: { at: 1, sessions: [{ sessionId: 's1' }, { sessionId: 's2' }] } })
  for (const row of store.state.plan.sessions) {
    assert.equal(row.intent, 'mount', 're-derived residue must not replay a row the plugin already held back')
    assert.equal(row.deferred.reason.length > 0, true)
  }
})

test('a healthy heap does not hold anything back and reports no restart advice', async () => {
  const probe = pacingProbe({ weights: {} })
  const engine = createEngine({
    store: fakeStore({ plan: planOf([{ sessionId: 's1' }, { sessionId: 's2' }]) }),
    probe, bootId: 'b1', now: () => 1,
    heapStats: () => ({ usedMB: 400, limitMB: 4000 }),
    log: () => {},
  })
  const outcome = await engine.resume()
  assert.equal(outcome.status, 'resumed')
  assert.equal(engine.describe().scheduling.deferred.length, 0)
  assert.equal(engine.describe().scheduling.restartRecommended, null)
})

test('the thresholds come from the heap this process has, not from one machine', async () => {
  const run = async (limitMB, overrides = {}) => {
    const engine = createEngine({
      store: fakeStore({ plan: planOf([{ sessionId: 's1' }]) }),
      probe: pacingProbe(), bootId: 'b1', now: () => 1,
      heapStats: () => ({ usedMB: 100, limitMB }),
      ...overrides,
      log: () => {},
    })
    await engine.resume()
    return engine.describe().scheduling
  }
  const large = await run(8192)
  assert.equal(large.heavyMB, 24, 'an 8 GB cap can carry a bigger transcript before it needs the process alone')
  assert.equal(large.reserveMB, 1536)
  assert.equal(large.concurrency, 2)
  assert.deepEqual(large.derived, { heavyMB: true, reserveMB: true, concurrency: true })
  const small = await run(2048)
  assert.equal(small.heavyMB, 8)
  assert.equal(small.reserveMB, 451)
  assert.equal(small.concurrency, 1, 'a 2 GB cap restores one session at a time')
  // An explicit config value is a person's decision and beats the derivation.
  const pinned = await run(2048, { restoreHeavyMB: 5, restoreHeapReserveMB: 900, restoreConcurrency: 3 })
  assert.equal(pinned.heavyMB, 5)
  assert.equal(pinned.reserveMB, 900)
  assert.equal(pinned.concurrency, 3)
  assert.deepEqual(pinned.derived, { heavyMB: false, reserveMB: false, concurrency: false })
})
