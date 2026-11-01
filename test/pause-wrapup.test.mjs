import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { createEngine } from '../lib/engine.js'

/**
 * A pause is two stages now. The press first asks every running turn to say what it has and what is
 * left, and only whatever is still running when the window closes is cancelled. A turn that reached
 * an ordinary `completed` inside that window looks like a finished task to every later reader, so
 * the plan has to carry the marker that says a continuation is still owed.
 *
 * The cases below pin that contract on both faces the UI reads: the durable plan (`wrapUp` on the
 * snapshot, `owedContinue` on each row) and the answer to the press (`pause()` and `describe()`).
 */

function fakeStore({ plan = null } = {}) {
  const state = { plan, writes: [], result: null, journal: new Map(), pending: null, failAfter: null, attempts: 0 }
  // `failAfter` makes every write after the first N behave like a disk that said no: the engine must
  // tell the difference between "nothing was stopped" and "the stop happened but is not durable".
  const write = (next) => {
    state.attempts += 1
    state.writes.push(structuredClone(next))
    if (state.failAfter !== null && state.attempts > state.failAfter) return null
    state.plan = structuredClone(next)
    return state.plan
  }
  return {
    state,
    read: () => state.plan,
    write,
    readPending: () => state.pending,
    writePending: (next) => { state.pending = write(next); return state.pending },
    clearPending: () => { state.pending = null; return true },
    writeResult: (record) => { state.result = record; return true },
    clearResult: () => true,
    lastRestore: () => state.result,
    readJournal: () => new Map([...state.journal.entries()]),
    appendJournal: () => true,
    clearJournal: () => state.journal.clear(),
    consume: () => ({ ok: true, archivePath: '/tmp/restores/x.json', published: true }),
  }
}

function emptyStopped() {
  return {
    canceled: [], unknown: [], pausedGoals: [], goalErrors: [], killedJobs: [], jobErrors: [],
    stillRunning: [], sessions: [], discovered: [],
  }
}

/**
 * A probe whose live set and stop answer are set by the test, and which records exactly how the
 * engine asked for the stop. `hold` lets a test keep the stop in flight and press pause again.
 */
function pauseProbe() {
  const probe = {
    stops: [],
    liveSessions: [{ sessionId: 'a', running: true, lastTurn: 1 }],
    response: emptyStopped(),
    hold: null,
    live() {
      return { sessions: probe.liveSessions, goals: [], jobs: [], readable: true }
    },
  }
  probe.stop = async (current, options) => {
    probe.stops.push({ sessions: (current?.sessions ?? []).map((row) => row.sessionId), options })
    if (probe.hold !== null) await probe.hold
    return probe.response
  }
  return probe
}

function wrapUpReport(overrides = {}) {
  return { windowMs: 3000, steered: [], completed: [], timedOut: [], unavailable: null, ...overrides }
}

function engineOf({ store = fakeStore(), probe = pauseProbe(), ...options } = {}) {
  return createEngine({
    store, probe, bootId: 'wrap-1', now: () => 1700000000000, graceMs: 700,
    restoreSettleMs: 400, log: () => {}, ...options,
  })
}

function rowOf(plan, sessionId) {
  return (plan?.sessions ?? []).find((row) => row.sessionId === sessionId) ?? null
}

async function until(check) {
  for (let i = 0; i < 400; i += 1) {
    if (check() === true) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error('condition never held')
}

/** The steer text is a person-facing instruction; it must be there and it must be Chinese. */
function assertSteerText(text) {
  assert.equal(typeof text, 'string')
  assert.ok(text.length > 20, 'the wrap-up instruction is a full sentence, not a label')
  assert.match(text, /\p{Script=Han}/u)
}

test('the stop is told the grace, the window, the steer text, and the plan it belongs to', async () => {
  const store = fakeStore()
  const probe = pauseProbe()
  const engine = engineOf({ store, probe })
  const outcome = await engine.pause()
  assert.equal(outcome.status, 'paused')
  assert.equal(probe.stops.length, 1)
  const { options } = probe.stops[0]
  assert.equal(options.graceMs, 700)
  assert.equal(options.wrapUpMs, 3000, 'the default window is three seconds')
  assertSteerText(options.wrapUpText)
  assert.equal(typeof options.onDiscover, 'function')
  assert.equal(options.planId, store.state.plan.planId, 'the stop names the plan that is about to exist')
})

test('a caller can shorten the window and replace the steer text', async () => {
  const probe = pauseProbe()
  const engine = engineOf({ probe, wrapUpMs: 250, wrapUpText: 'stop now and say what is left' })
  await engine.pause()
  assert.equal(probe.stops[0].options.wrapUpMs, 250)
  assert.equal(probe.stops[0].options.wrapUpText, 'stop now and say what is left')
})

test('a caller asking for zero gets the old immediate cancel, not a tiny window', async () => {
  const probe = pauseProbe()
  const engine = engineOf({ probe, wrapUpMs: 0 })
  await engine.pause()
  assert.equal(probe.stops[0].options.wrapUpMs, 0)
})

test('a turn that finished inside the window keeps a continuation marker, a cancelled one does not', async () => {
  const store = fakeStore()
  const probe = pauseProbe()
  probe.liveSessions = ['a', 'b', 'c', 'd'].map((sessionId) => ({ sessionId, running: true, lastTurn: 2 }))
  probe.response = {
    ...emptyStopped(),
    wrapUp: wrapUpReport({ steered: ['a', 'b', 'c'], completed: ['a'], timedOut: ['b', 'c'], unavailable: 'no-session' }),
  }
  const engine = engineOf({ store, probe })
  const outcome = await engine.pause()
  assert.equal(outcome.status, 'paused')

  // The durable copy is what a later boot reads, so the marker has to be on the snapshot, not only
  // in the answer to this press.
  const persisted = store.state.plan
  assert.equal(rowOf(persisted, 'a').owedContinue, true)
  assert.equal(rowOf(persisted, 'a').wrapUp, 'completed')
  assert.equal(rowOf(persisted, 'b').owedContinue, true)
  assert.equal(rowOf(persisted, 'b').wrapUp, 'cancelled')
  // Steered but neither finished nor timed out is unproven, and unproven is not "finished".
  assert.equal(rowOf(persisted, 'c').owedContinue, true)
  assert.equal(rowOf(persisted, 'c').wrapUp, 'cancelled')
  // A row the stop never steered keeps the legacy shape exactly.
  assert.equal(Object.hasOwn(rowOf(persisted, 'd'), 'owedContinue'), false)
  assert.equal(Object.hasOwn(rowOf(persisted, 'd'), 'wrapUp'), false)

  assert.deepEqual(persisted.wrapUp, {
    windowMs: 3000,
    steered: ['a', 'b', 'c'],
    completed: ['a'],
    timedOut: ['b', 'c'],
    unavailable: 'no-session',
  })
  assert.deepEqual(outcome.wrapUp, persisted.wrapUp, 'the press answers with the report it wrote')
  assert.deepEqual(outcome.counts, { sessions: 4, goals: 0, jobs: 0 })
  assert.equal(typeof outcome.outstanding, 'number')
})

test('the report survives a restart while the press answer does not', async () => {
  const store = fakeStore()
  const probe = pauseProbe()
  probe.liveSessions = [{ sessionId: 'a', running: true, lastTurn: 3 }, { sessionId: 'b', running: true, lastTurn: 3 }]
  probe.response = { ...emptyStopped(), wrapUp: wrapUpReport({ steered: ['a'], completed: ['a'], timedOut: [] }) }
  const engine = engineOf({ store, probe })
  const outcome = await engine.pause()

  const state = engine.describe()
  assert.deepEqual(state.wrapUp, store.state.plan.wrapUp, 'the top face is the durable report')
  assert.equal(state.outcome.status, 'paused')
  assert.deepEqual(state.outcome.wrapUp, outcome.wrapUp, 'the outcome face is this press answer')

  // A restart has no memory of the press, only the snapshot: the top face is still there, the
  // outcome face is honestly empty.
  const restarted = engineOf({ store: fakeStore({ plan: store.state.plan }), probe: pauseProbe() })
  const afterRestart = restarted.describe()
  assert.deepEqual(afterRestart.wrapUp, store.state.plan.wrapUp)
  assert.equal(afterRestart.outcome, null)
  assert.equal(afterRestart.counts.sessions, 2)
})

test('a press that is refused keeps the previous report instead of erasing it', async () => {
  const probe = pauseProbe()
  const engine = engineOf({ probe })
  probe.response = { ...emptyStopped(), wrapUp: wrapUpReport({ steered: ['a'], completed: ['a'] }) }
  const first = await engine.pause()
  const report = structuredClone(engine.describe().wrapUp)

  probe.liveSessions = []
  const already = await engine.pause()
  assert.equal(already.status, 'already')
  assert.equal(Object.hasOwn(already, 'wrapUp'), false, 'a refused press says nothing about a window it did not open')
  assert.deepEqual(engine.describe().outcome.wrapUp, report)
  assert.deepEqual(engine.describe().wrapUp, report)
  assert.deepEqual(first.wrapUp, report)
})

test('a press made while the first one is still stopping is busy and writes nothing', async () => {
  const probe = pauseProbe()
  probe.response = { ...emptyStopped(), wrapUp: wrapUpReport({ steered: ['a'], timedOut: ['a'] }) }
  let release = null
  probe.hold = new Promise((resolve) => { release = resolve })
  const engine = engineOf({ probe })
  const running = engine.pause()
  await until(() => probe.stops.length === 1)
  const busy = await engine.pause()
  assert.equal(busy.status, 'busy')
  assert.equal(busy.phase, 'pausing')
  assert.equal(Object.hasOwn(busy, 'wrapUp'), false)
  assert.equal(engine.describe().outcome, null, 'nothing wrote an outcome while the stop was in flight')
  release()
  const outcome = await running
  assert.equal(outcome.status, 'paused')
  assert.deepEqual(engine.describe().wrapUp, outcome.wrapUp)
  assert.deepEqual(engine.describe().outcome.wrapUp, outcome.wrapUp)
})

test('without a report the pause behaves exactly as 0.8.4 did', async () => {
  const store = fakeStore()
  const probe = pauseProbe()
  probe.liveSessions = [{ sessionId: 'a', running: true, lastTurn: 1 }, { sessionId: 'b', running: true, lastTurn: 1 }]
  probe.response = { ...emptyStopped(), wrapUp: null }
  const engine = engineOf({ store, probe })
  const outcome = await engine.pause()
  assert.equal(outcome.status, 'paused')
  assert.equal(outcome.wrapUp, null)
  for (const sessionId of ['a', 'b']) {
    assert.equal(Object.hasOwn(rowOf(store.state.plan, sessionId), 'owedContinue'), false)
    assert.equal(Object.hasOwn(rowOf(store.state.plan, sessionId), 'wrapUp'), false)
  }
  assert.equal(Object.hasOwn(store.state.plan, 'wrapUp'), false)
  const state = engine.describe()
  assert.equal(state.wrapUp, null)
  assert.equal(state.outcome.wrapUp, null)
})

test('a store that refuses the pre-stop write fails the press and opens no window', async () => {
  const store = fakeStore()
  store.state.failAfter = 0
  const probe = pauseProbe()
  const engine = engineOf({ store, probe })
  const outcome = await engine.pause()
  assert.equal(outcome.status, 'failed')
  assert.equal(outcome.reason, 'store')
  assert.equal(probe.stops.length, 0, 'nothing is cancelled for a plan that was never written')
  const state = engine.describe()
  assert.equal(state.phase, 'idle')
  assert.notEqual(state.phase, 'paused')
  assert.equal(state.outcome, null)
  assert.equal(state.wrapUp, null)
})

test('a store that refuses the final write still reports the window it won but not a durable pause', async () => {
  const store = fakeStore()
  store.state.failAfter = 1
  const probe = pauseProbe()
  probe.response = { ...emptyStopped(), wrapUp: wrapUpReport({ steered: ['a'], completed: ['a'] }) }
  const engine = engineOf({ store, probe })
  const outcome = await engine.pause()
  assert.equal(outcome.status, 'paused')
  assert.deepEqual(outcome.wrapUp, wrapUpReport({ steered: ['a'], completed: ['a'] }))
  const state = engine.describe()
  assert.equal(state.phase, 'paused')
  assert.equal(state.complete, false, 'the durable copy still says pausing, so the stop is not complete')
  assert.equal(state.error, 'store')
  assert.deepEqual(state.wrapUp, outcome.wrapUp, 'the report this process holds is still the truth it earned')
})

test('the engine reads its own snapshot from disk-shaped storage without a real filesystem', async () => {
  // The other tests use an in-memory store; this one pins the same contract through the real store
  // factory so the shape written by a pause is one the snapshot reader accepts.
  const { createStore } = await import('../lib/snapshot.js')
  const dir = mkdtempSync(join(tmpdir(), 'dsh-wrapup-'))
  try {
    const store = createStore(dir)
    const probe = pauseProbe()
    probe.response = { ...emptyStopped(), wrapUp: wrapUpReport({ steered: ['a'], completed: ['a'] }) }
    const engine = engineOf({ store, probe })
    const outcome = await engine.pause()
    const reread = createStore(dir)
    const plan = reread.read()
    assert.equal(plan.wrapUp.windowMs, 3000)
    assert.equal(rowOf(plan, 'a').owedContinue, true)
    assert.equal(rowOf(plan, 'a').wrapUp, 'completed')
    assert.deepEqual(outcome.wrapUp, plan.wrapUp)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
