import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createEngine } from '../lib/engine.js'

/**
 * The 2026-11-03 host died twice while restoring the same crash plan. The gate refused rows for
 * memory, nothing ever came back for them, and the rows it did admit opened five turns inside a
 * second. These tests pin the two rules that close that hole: a wave never opens more turns than the
 * process can carry, and a row held back for memory is retried once the heap has the room it asked
 * for instead of waiting for a restart that measures the same heap.
 */

function fakeStore({ plan = null } = {}) {
  const state = { plan, writes: [], result: null, journal: new Map(), pending: null }
  const write = (next) => {
    state.writes.push(structuredClone(next))
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
    appendJournal: (planId, key, status, boot, extra = null) => {
      state.journal.set(key, { status, boot, epoch: extra?.epoch, turn: extra?.turn })
      return true
    },
    clearJournal: () => state.journal.clear(),
    consume: (next, summary, status = 'restored') => {
      state.result = { planId: next.planId, status, summary }
      state.plan = null
      state.pending = null
      state.journal.clear()
      return { ok: true, archivePath: '/tmp/restores/x.json', published: true }
    },
  }
}

function probeFor({ weights = {}, live = [], settle = () => false } = {}) {
  const calls = []
  const started = new Map()
  return {
    calls,
    started,
    live: () => ({ sessions: live().map((sessionId) => ({ sessionId })), goals: [], jobs: [], readable: true }),
    stop: async () => ({ canceled: [], unknown: [], pausedGoals: [], goalErrors: [], killedJobs: [], jobErrors: [], stillRunning: [] }),
    sessionWeight: async (sessionId) => (weights[sessionId] === undefined ? null : { bytes: weights[sessionId], file: `/tmp/${sessionId}.zstd` }),
    assessSession: async (session) => {
      calls.push(['assess', session.sessionId])
      if (started.get(session.sessionId) === true) return { action: 'continue', end: 'open', turn: 1 }
      if (settle() === false) return { action: 'continue', end: 'open', turn: 1 }
      return { action: 'skip', end: 'completed', turn: 1 }
    },
    restoreSession: async (session) => {
      calls.push(['session', session.sessionId])
      started.set(session.sessionId, true)
      return { status: 'restored', detail: 'continued', continued: true, turn: 1, requestId: `r-${session.sessionId}` }
    },
    prepareGoal: async () => ({ status: 'ready', revision: 0 }),
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

function planOf(rows) {
  return {
    version: 3, planId: 'wave-1', source: 'crash', status: 'paused',
    sessions: rows.map((row) => ({ running: false, lastTurn: 1, epoch: 1, intent: 'continue', ...row })),
    goals: [], jobs: [], attention: [],
  }
}

const MB = 1048576

test('five small transcripts do not open five turns in one press', async () => {
  const ids = ['a', 'b', 'c', 'd', 'e']
  const weights = Object.fromEntries(ids.map((id) => [id, 1 * MB]))
  const probe = probeFor({ weights })
  const store = fakeStore({ plan: planOf(ids.map((sessionId) => ({ sessionId }))) })
  const engine = createEngine({
    store, probe, bootId: 'b1', now: () => 1, log: () => {},
    heapStats: () => ({ usedMB: 100, limitMB: 4000 }),
    restoreConcurrency: 2,
    restoreSettleMs: 80,
  })
  const outcome = await engine.resume()
  const mounted = probe.calls.filter(([kind]) => kind === 'session').map(([, id]) => id)
  assert.equal(mounted.length, 2, `at most two turns may start together, started ${mounted.join(',')}`)
  assert.equal(outcome.status, 'partial')
  const held = store.state.plan.restore.deferred
  assert.equal(held.length, 3, 'the other three rows are held, not dropped')
  for (const row of held) assert.equal(row.reason, 'an earlier restored session is still working')
  assert.equal(store.state.plan.sessions.filter((row) => row.deferred !== undefined).length, 3)
  for (const row of store.state.plan.sessions) assert.equal(row.intent, 'continue', 'a hold keeps the intention the row was parked with')
})

test('a row held for memory records what it needs and comes back when the heap has it', async () => {
  const probe = probeFor({ weights: { big: 40 * MB } })
  const store = fakeStore({ plan: planOf([{ sessionId: 'big' }]) })
  const engine = createEngine({
    store, probe, bootId: 'b1', now: () => 1, log: () => {},
    heapStats: () => ({ usedMB: 3500, limitMB: 4000 }),
    restoreHeapReserveMB: 500,
    restoreSettleMs: 30000,
  })
  const first = await engine.resume()
  assert.equal(first.status, 'partial')
  assert.deepEqual(probe.calls.filter(([kind]) => kind === 'session'), [], 'nothing is mounted while the room is short')
  const held = store.state.plan.restore.deferred[0]
  assert.equal(held.sessionId, 'big')
  assert.equal(held.needMB, 240, 'the hold carries the estimate it was refused on')
  assert.equal(store.state.plan.restore.rounds, 1, 'the refused round is recorded, so the plan does not look untouched')
  assert.equal(store.state.plan.restore.attempts, 0, 'a hold is not a failure')

  // The next process has the new heap: the same row is mounted without another press.
  const roomy = createEngine({
    store, probe, bootId: 'b2', now: () => 10, log: () => {},
    heapStats: () => ({ usedMB: 120, limitMB: 4000 }),
    restoreHeapReserveMB: 500,
    restoreSettleMs: 30000,
  })
  const second = await roomy.resume()
  assert.equal(second.status, 'resumed')
  assert.deepEqual(probe.calls.filter(([kind]) => kind === 'session').map(([, id]) => id), ['big'])
})

test('a turn that is still running from an earlier round keeps its slot', async () => {
  const probe = probeFor({ weights: { a: 1 * MB, b: 1 * MB, c: 1 * MB }, live: () => ['a', 'b'] })
  const store = fakeStore({ plan: planOf([{ sessionId: 'a' }, { sessionId: 'b' }, { sessionId: 'c' }]) })
  const engine = createEngine({
    store, probe, bootId: 'b1', now: () => 1, log: () => {},
    heapStats: () => ({ usedMB: 100, limitMB: 4000 }),
    restoreConcurrency: 2,
    restoreSettleMs: 80,
  })
  const outcome = await engine.resume()
  assert.equal(outcome.status, 'partial')
  assert.deepEqual(probe.calls.filter(([kind]) => kind === 'session'), [], 'a second press must not stack turns on top of two that are still running')
  for (const row of store.state.plan.restore.deferred) assert.equal(row.reason, 'an earlier restored session is still working')
})

test('the engine comes back for a row held for memory once the heap drains', async () => {
  const probe = probeFor({ weights: { big: 40 * MB } })
  const store = fakeStore({ plan: planOf([{ sessionId: 'big' }]) })
  const heap = { usedMB: 3500, limitMB: 4000 }
  const engine = createEngine({
    store, probe, bootId: 'b1', now: () => Date.now(), log: () => {},
    heapStats: () => ({ ...heap }),
    restoreHeapReserveMB: 500,
    restoreSettleMs: 80,
  })
  const first = await engine.resume()
  assert.equal(first.status, 'partial')
  assert.deepEqual(probe.calls.filter(([kind]) => kind === 'session'), [], 'the row waits while the room is short')
  heap.usedMB = 200
  const mounted = []
  for (let wait = 0; wait < 30 && mounted.length === 0; wait += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50))
    mounted.push(...probe.calls.filter(([kind]) => kind === 'session').map(([, id]) => id))
  }
  assert.deepEqual(mounted, ['big'], 'the drain must not leave the row waiting for a restart')
})
