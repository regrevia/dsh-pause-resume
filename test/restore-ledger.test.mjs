import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createEngine } from '../lib/engine.js'

/**
 * The 2026-11-03 crash plan was restored three times and never closed. Its journal carried 39
 * `restored` lines for 24 rows (one boot recorded the same session four times, another two lines
 * 970 ms apart), the plan listed a session as both restored and held back, and a bare
 * `crashed: 3 session(s) need a look` row sat on the page with an empty id, so no live state could
 * ever clear it. These tests pin the ledger rules that make the three files agree.
 */

function fakeStore({ plan = null } = {}) {
  const state = { plan, writes: [], result: null, lines: [], pending: null }
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
    readJournal: () => {
      const rows = new Map()
      for (const line of state.lines) rows.set(line.key, line)
      return rows
    },
    appendJournal: (planId, key, status, boot, extra = null) => {
      state.lines.push({ planId, key, status, boot, epoch: extra?.epoch, turn: extra?.turn })
      return true
    },
    clearJournal: () => { state.cleared = true },
    consume: (next, summary, status = 'restored') => {
      state.result = { planId: next.planId, status, summary }
      state.plan = null
      state.pending = null
      state.lines = []
      return { ok: true, archivePath: '/tmp/restores/x.json', published: true }
    },
  }
}

function probeFor({ weights = {}, restored = () => true } = {}) {
  const calls = []
  return {
    calls,
    live: () => ({ sessions: [], goals: [], jobs: [], readable: true }),
    stop: async () => ({ canceled: [], unknown: [], pausedGoals: [], goalErrors: [], killedJobs: [], jobErrors: [], stillRunning: [] }),
    sessionWeight: async (sessionId) => (weights[sessionId] === undefined ? null : { bytes: weights[sessionId], file: `/tmp/${sessionId}.zstd` }),
    assessSession: async () => ({ action: 'continue', end: 'open', turn: 1 }),
    restoreSession: async (session) => {
      calls.push(['session', session.sessionId])
      return restored(session)
        ? { status: 'restored', detail: 'continued', continued: true, turn: 1, requestId: `r-${session.sessionId}` }
        : { status: 'deferred', detail: 'no room' }
    },
    prepareGoal: async () => ({ status: 'ready', revision: 0 }),
    restoreGoal: async () => ({ status: 'restored', detail: 'armed' }),
  }
}

function planOf(rows, extra = {}) {
  return {
    version: 3, planId: 'ledger-1', source: 'crash', status: 'paused',
    sessions: rows.map((row) => ({ running: false, lastTurn: 1, epoch: 1, intent: 'continue', ...row })),
    goals: [], jobs: [], attention: [],
    ...extra,
  }
}

const MB = 1048576
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

test('a restored proof already in this boot is not journaled twice', async () => {
  const probe = probeFor({ weights: { a: 1 * MB } })
  const store = fakeStore({ plan: planOf([{ sessionId: 'a' }]) })
  // This is the 11-03 shape: the same session already carries a `restored` line for this very boot,
  // because the row was proven and then looked at again by a later round of the same restore.
  store.state.lines.push({ planId: 'ledger-1', key: 's:a', status: 'restored', boot: 'b1', epoch: 1, turn: 1 })
  const engine = createEngine({
    store, probe, bootId: 'b1', now: () => 1, log: () => {},
    heapStats: () => ({ usedMB: 100, limitMB: 4000 }),
    restoreSettleMs: 20,
  })
  const outcome = await engine.resume()
  const restored = store.state.lines.filter((line) => line.key === 's:a' && line.status === 'restored')
  assert.equal(restored.length, 1, `a proof this boot already holds is not written again, got ${restored.length} lines`)
  assert.deepEqual(outcome.summary.restored, ['session a'], 'the plan still counts the row as restored')
})

test('a row held back for memory says deferred, not restored', async () => {
  const probe = probeFor({ weights: { big: 400 * MB } })
  const store = fakeStore({ plan: planOf([{ sessionId: 'big' }, { sessionId: 'small' }]) })
  const engine = createEngine({
    store, probe, bootId: 'b1', now: () => 1, log: () => {},
    heapStats: () => ({ usedMB: 2500, limitMB: 4000 }),
    restoreConcurrency: 1,
    restoreSettleMs: 20,
  })
  await engine.resume()
  const held = store.state.plan.restore?.deferred ?? []
  assert.ok(held.length > 0, 'a tight heap holds a row')
  for (const row of held) {
    const lines = store.state.lines.filter((line) => line.key === `s:${row.sessionId}`)
    assert.equal(lines.some((line) => line.status === 'restored'), false, `${row.sessionId} is held, so the journal must not claim it was restored`)
    assert.equal(lines.some((line) => line.status === 'deferred'), true, `${row.sessionId} carries a deferred line`)
  }
  const restoredKeys = new Set(store.state.lines.filter((line) => line.status === 'restored').map((line) => line.key))
  const heldKeys = new Set(held.map((row) => `s:${row.sessionId}`))
  for (const key of heldKeys) assert.equal(restoredKeys.has(key), false, `${key} cannot be both restored and held`)
})

test('the plan lists each held row once', async () => {
  const probe = probeFor({ weights: { a: 1 * MB, b: 400 * MB, c: 400 * MB } })
  const store = fakeStore({ plan: planOf([{ sessionId: 'a' }, { sessionId: 'b' }, { sessionId: 'c' }]) })
  const engine = createEngine({
    store, probe, bootId: 'b1', now: () => 1, log: () => {},
    heapStats: () => ({ usedMB: 2500, limitMB: 4000 }),
    restoreConcurrency: 2,
    restoreSettleMs: 20,
  })
  await engine.resume()
  const held = store.state.plan.restore?.deferred ?? []
  assert.ok(held.length >= 2, 'the two transcripts that do not fit are held')
  const seen = new Set()
  for (const row of held) {
    assert.equal(seen.has(row.sessionId), false, `${row.sessionId} appears twice in the hold list`)
    seen.add(row.sessionId)
  }
})

test('a boot with room retries what the last process held back', async () => {
  const probe = probeFor({ weights: { a: 1 * MB } })
  const plan = planOf([{ sessionId: 'a' }], {
    restore: {
      at: '2026-11-04T16:07:43.364Z', attempts: 0, rounds: 2, freeMB: 1335,
      reason: 'host heap is near its limit (7049 MB of 8384 MB)',
      deferred: [{ sessionId: 'a', kind: 'session', reason: 'host heap is near its limit', needMB: 1 }],
    },
  })
  const store = fakeStore({ plan })
  const engine = createEngine({
    store, probe, bootId: 'b2', now: () => 1, log: () => {},
    heapStats: () => ({ usedMB: 200, limitMB: 8000 }),
    restoreSettleMs: 20,
  })
  await engine.hydrate({ residue: { sessions: [{ sessionId: 'a' }], goals: [], jobs: [] } })
  await sleep(150)
  const mounted = probe.calls.filter(([kind]) => kind === 'session').map(([, id]) => id)
  assert.deepEqual(mounted, ['a'], 'a boot that finds room does not leave the held row for another restart')
})

test('a restore row that names no session is not shown', async () => {
  const store = fakeStore({
    plan: planOf([{ sessionId: 'a' }], {
      attention: [{ kind: 'session', id: '', detail: 'crashed: 3 session(s) need a look before continuing', restore: true }],
    }),
  })
  const engine = createEngine({ store, probe: probeFor(), bootId: 'b1', now: () => 1, log: () => {}, heapStats: () => ({ usedMB: 100, limitMB: 4000 }) })
  const state = engine.describe()
  assert.equal(state.attention, 0, 'a row with an empty id can never be cleared, so it is not a duty on the page')
  assert.equal(state.focus, null)
})

test('a press the heap refuses to admit says so instead of reporting a partial restore', async () => {
  const probe = probeFor({ weights: { a: 300 * MB, b: 300 * MB } })
  const store = fakeStore({ plan: planOf([{ sessionId: 'a' }, { sessionId: 'b' }]) })
  const engine = createEngine({
    store, probe, bootId: 'b1', now: () => 1, log: () => {},
    // 100 MB free, and the reserve for a 4000 MB host is larger than that: every row is held.
    heapStats: () => ({ usedMB: 3900, limitMB: 4000 }),
    restoreSettleMs: 20,
  })
  const outcome = await engine.resume()
  assert.equal(outcome.status, 'blocked', 'a press that mounted nothing is not a partial restore')
  assert.equal(outcome.reason, 'heap')
  assert.deepEqual(probe.calls.filter((call) => call[0] === 'session'), [], 'no row is mounted under the hard gate')
  assert.equal(store.state.plan.status, 'partial')
  assert.equal(store.state.plan.restore.deferred.length, 2, 'the hold is still durable')
  assert.equal(engine.describe().error, 'restore-blocked-heap')
})
