import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createEngine } from '../lib/engine.js'

/**
 * A person restarting the Host by hand and then continuing a paused session themselves leaves a plan
 * nobody will ever press again: the header keeps offering a restore for work already done. The engine
 * has to notice that on the state read path, without a press and without ever mistaking "I cannot
 * tell" for "done".
 *
 * Every case below drives `describe()`, because that is the one path every reader of the plan takes.
 */

const NOW = 1700000000000
const recent = () => new Date(NOW).toISOString()
const continued = 'continued by hand after the pause'

function pausePlan(rows) {
  return {
    version: 4,
    planId: 'plan-1',
    status: 'paused',
    source: 'pause',
    createdAt: recent(),
    sessions: rows,
    goals: [],
    jobs: [],
    attention: [],
    wrapUp: {
      windowMs: 3000, steered: rows.map((row) => row.sessionId), completed: [], timedOut: [],
      unavailable: null, retracted: [], retractUnavailable: [],
    },
  }
}

/** A row the pause left owing a continuation, as `mergeStopResult` writes it. */
function owedRow(sessionId, extra = {}) {
  return { sessionId, intent: 'continue', epoch: 1, running: true, lastTurn: 3, owedContinue: true, ...extra }
}

function fakeStore({ plan = null, journal = new Map() } = {}) {
  const state = { plan, writes: [], appends: [], consumed: null, journal: new Map(journal), pending: null, result: null }
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
      state.appends.push({ planId, key, status, boot, extra })
      state.journal.set(key, { status, boot, epoch: extra?.epoch ?? null, turn: extra?.turn ?? null })
      return true
    },
    clearJournal: () => state.journal.clear(),
    consume: (plan, summary) => {
      state.consumed = { planId: plan.planId, status: 'restored', summary }
      state.plan = null
      state.journal.clear()
      return { ok: true, archivePath: '/tmp/restores/plan-1.json', published: false }
    },
  }
}

function probeFor({ liveSessions = [], restoreHold = null } = {}) {
  return {
    live: () => ({ sessions: liveSessions, goals: [], jobs: [], readable: true }),
    sessionWeight: async () => ({ bytes: 1024, file: null }),
    stop: async () => ({
      canceled: [], unknown: [], pausedGoals: [], goalErrors: [], killedJobs: [], jobErrors: [],
      stillRunning: [], sessions: [], discovered: [],
    }),
    assessSession: async () => ({ action: 'continue', mounted: true, admitted: false, detail: 'restored' }),
    latestTurnEnd: async () => null,
    statusOf: async () => 'idle',
    restoreSession: async () => {
      if (restoreHold !== null) await restoreHold.promise
      return { status: 'restored', mounted: true, turn: 4, detail: 'restored' }
    },
    prepareGoal: async () => ({ status: 'ready' }),
    restoreGoal: async () => ({ status: 'restored' }),
    restoreSchedule: async () => ({ status: 'restored' }),
    crashPlan: () => null,
  }
}

function engineFor({ store, probe = probeFor(), services = null, handContinuedFn, clock = { t: NOW }, ...options } = {}) {
  return createEngine({
    store, probe, heartbeat: null, bootId: 'boot-1', services,
    now: () => clock.t, log: () => {}, restoreSettleMs: 50, ...options,
    ...(handContinuedFn === undefined ? {} : { handContinuedFn }),
  })
}

test('a session continued by hand closes the plan and the button offers the pause', () => {
  const store = fakeStore({ plan: pausePlan([owedRow('s1')]) })
  const probe = probeFor({ liveSessions: [{ sessionId: 's1', running: true, lastTurn: 4 }] })
  const seen = []
  const engine = engineFor({
    store, probe, services: { sessions: {} },
    handContinuedFn: (services, rows) => {
      seen.push({ services, rows })
      return new Map([['s1', { present: true, moved: true, running: false, lastTurn: 4 }]])
    },
  })

  const view = engine.describe()

  assert.equal(view.action, 'pause', 'the restore is gone, so live work asks for the pause again')
  assert.equal(engine.phase, 'idle')
  assert.equal(store.state.plan, null, 'the plan is closed on disk')
  assert.deepEqual(seen.map((call) => call.rows.map((row) => row.sessionId)), [['s1']])
  assert.deepEqual(seen[0].services, { sessions: {} }, 'the helper is handed the services it needs')
  assert.deepEqual(
    store.state.appends.map((entry) => [entry.planId, entry.key, entry.status, entry.boot]),
    [['plan-1', 's:s1', 'satisfied', 'boot-1']],
  )
  assert.equal(store.state.appends[0].extra.detail, continued)
  assert.equal(store.state.consumed.planId, 'plan-1')
  assert.equal(store.state.consumed.status, 'restored')
  assert.ok(
    store.state.consumed.summary.skipped.includes(`session s1: ${continued}`),
    'the last-restore record explains why the row was skipped',
  )
  assert.equal(store.state.consumed.summary.rows[0].key, 's:s1')
})

test('a session still running by hand keeps the plan and is never touched', () => {
  const store = fakeStore({ plan: pausePlan([owedRow('s1')]) })
  const engine = engineFor({
    store, probe: probeFor(),
    handContinuedFn: () => new Map([['s1', { present: true, moved: true, running: true }]]),
  })

  const view = engine.describe()

  assert.equal(view.action, 'resume')
  assert.equal(engine.phase, 'idle')
  assert.ok(store.state.plan !== null, 'the plan stays on disk')
  assert.equal(store.state.appends.length, 0)
  assert.equal(store.state.writes.length, 0, 'nothing is persisted for a session that is still working')
})

test('without a helper to ask, the plan is left exactly as it was', () => {
  const store = fakeStore({ plan: pausePlan([owedRow('s1')]) })
  const engine = engineFor({ store, probe: probeFor(), handContinuedFn: null })

  assert.equal(engine.describe().action, 'resume')
  assert.ok(store.state.plan !== null, 'the plan stays on disk')
  assert.equal(store.state.appends.length, 0)

  // The production default is the probe export with no services wired yet: an answer of "unknown"
  // is not a move, so it must keep the plan open too.
  const unwired = fakeStore({ plan: pausePlan([owedRow('s1')]) })
  const defaulted = engineFor({ store: unwired, probe: probeFor(), services: null })
  assert.equal(defaulted.describe().action, 'resume')
  assert.ok(unwired.state.plan !== null)
  assert.equal(unwired.state.appends.length, 0)
})

test('one moved row is journaled while another row still owed keeps the plan open', () => {
  const store = fakeStore({ plan: pausePlan([owedRow('s1'), owedRow('s2')]) })
  const engine = engineFor({
    store, probe: probeFor(),
    handContinuedFn: () => new Map([
      ['s1', { present: true, moved: true, running: false }],
      ['s2', { present: true, moved: false, running: false }],
    ]),
  })

  const view = engine.describe()

  assert.equal(view.action, 'resume', 'work is still owed, so the restore stays on offer')
  assert.ok(store.state.plan !== null)
  assert.deepEqual(store.state.appends.map((entry) => entry.key), ['s:s1'])
  assert.equal(store.state.writes.length, 1)
  const persisted = store.state.plan
  assert.equal(persisted.sessions.find((row) => row.sessionId === 's1').owedContinue, false)
  assert.equal(persisted.sessions.find((row) => row.sessionId === 's2').owedContinue, true)
  assert.deepEqual([...store.state.journal.keys()], ['s:s1'])
})

test('a pause that never steered still closes when its turn was continued by hand', () => {
  // A Host that cannot steer leaves no wrap-up marker, but the row still describes a turn the press
  // cancelled: the person continuing that session is the same evidence, and the button must clear.
  const plainRow = { sessionId: 's1', intent: 'continue', epoch: 1, running: true, lastTurn: 3 }
  const store = fakeStore({ plan: pausePlan([plainRow]) })
  const engine = engineFor({
    store, probe: probeFor(),
    handContinuedFn: () => new Map([['s1', { present: true, moved: true, running: false }]]),
  })

  assert.equal(engine.describe().action, 'none', 'nothing is running and nothing is owed anymore')
  assert.equal(store.state.plan, null)
  assert.deepEqual(store.state.appends.map((entry) => entry.key), ['s:s1'])
})

test('nothing is settled while a restore is in flight', async () => {
  let release = () => {}
  const restoreHold = { promise: new Promise((resolve) => { release = resolve }) }
  const store = fakeStore({ plan: pausePlan([owedRow('s1')]) })
  const probe = probeFor({ restoreHold })
  const calls = []
  const engine = engineFor({
    store, probe,
    handContinuedFn: () => {
      calls.push(1)
      return new Map([['s1', { present: true, moved: true, running: false }]])
    },
  })

  const press = engine.resume()
  assert.equal(engine.phase, 'resuming')
  const view = engine.describe()
  assert.equal(view.action, 'pause', 'a restore in flight is stopped by pressing, not by a hand check')
  assert.equal(calls.length, 0)
  assert.equal(store.state.appends.length, 0)

  release()
  const outcome = await Promise.race([
    press,
    new Promise((resolve) => { const timer = setTimeout(() => resolve({ status: 'timed out' }), 5000); timer.unref?.() }),
  ])
  assert.notEqual(outcome.status, 'timed out')
  assert.notEqual(engine.phase, 'resuming')
})

test('a later state read looks again instead of latching the first answer', () => {
  const store = fakeStore({ plan: pausePlan([owedRow('s1')]) })
  const probe = probeFor({ liveSessions: [{ sessionId: 's1', running: true, lastTurn: 4 }] })
  const clock = { t: NOW }
  let moved = false
  let calls = 0
  const engine = engineFor({
    store, probe, clock,
    handContinuedFn: () => {
      calls += 1
      return new Map([['s1', { present: true, moved, running: false }]])
    },
  })

  assert.equal(engine.describe().action, 'resume')
  assert.equal(calls, 1, 'the first read asks')
  assert.equal(engine.describe().action, 'resume')
  assert.equal(calls, 1, 'a second read inside the interval does not ask again')

  clock.t += 1000
  assert.equal(engine.describe().action, 'resume')
  assert.equal(calls, 1)

  clock.t += 8000
  assert.equal(engine.describe().action, 'resume')
  assert.equal(calls, 1, 'still inside the interval')
  assert.ok(store.state.plan !== null)

  // The interval elapsed: ask again, and this time the person has continued.
  moved = true
  clock.t += 1001
  assert.equal(engine.describe().action, 'pause')
  assert.equal(calls, 2)
  assert.equal(store.state.plan, null)
  assert.equal(engine.phase, 'idle')
})

test('a mount-only row is never settled as a hand continuation', () => {
  const mountRow = { sessionId: 's2', intent: 'mount', epoch: 0, running: false, lastTurn: null }
  const store = fakeStore({ plan: pausePlan([owedRow('s1'), mountRow]) })
  const asked = []
  const engine = engineFor({
    store, probe: probeFor(),
    handContinuedFn: (services, rows) => {
      asked.push(rows.map((row) => row.sessionId))
      return new Map([
        ['s1', { present: true, moved: true, running: false }],
        ['s2', { present: true, moved: true, running: false }],
      ])
    },
  })

  assert.equal(engine.describe().action, 'resume')

  assert.deepEqual(asked, [['s1']], 'only the row the pause left owing is asked about')
  assert.deepEqual(store.state.appends.map((entry) => entry.key), ['s:s1'])
  assert.ok(store.state.plan !== null, 'the mount this plan still owes keeps it open')
  const persisted = store.state.plan
  assert.equal(persisted.sessions.find((row) => row.sessionId === 's2').owedContinue, undefined)
  assert.deepEqual([...store.state.journal.keys()], ['s:s1'])
})

test('a row parked by the memory gate settles when the person continues it by hand', () => {
  const parked = owedRow('big', {
    running: false,
    lastTurn: 69,
    deferred: { at: recent(), reason: 'transcript is too large to restore here', park: 'continue', manual: true, needMB: 1214, freeMB: null },
  })
  const plan = pausePlan([parked])
  plan.status = 'partial'
  plan.restore = {
    at: recent(), attempts: 0, rounds: 1,
    deferred: [{ sessionId: 'big', kind: 'session', reason: 'transcript is too large to restore here', needMB: 1214 }],
  }
  const store = fakeStore({
    plan,
    journal: new Map([['s:big', { status: 'deferred', boot: 'boot-0', epoch: 1, turn: null }]]),
  })
  const engine = engineFor({
    store, services: { sessions: {} },
    probe: probeFor({ liveSessions: [{ sessionId: 'big', running: true, lastTurn: 70 }] }),
    handContinuedFn: () => new Map([['big', { present: true, moved: true, running: false, lastTurn: 70 }]]),
  })

  const view = engine.describe()

  assert.equal(engine.phase, 'idle', 'a park is not a verdict, so a hand continuation can end the plan')
  assert.equal(view.action, 'pause')
  assert.equal(store.state.plan, null, 'the hold is gone, so the plan closes on disk')
  assert.equal(store.state.consumed.summary.rows[0].status, 'satisfied')
  assert.deepEqual(store.state.appends.map((entry) => [entry.key, entry.status]), [['s:big', 'satisfied']])
})

test('settling a parked row drops the hold without closing a plan that still owes work', () => {
  const parked = owedRow('big', {
    running: false,
    lastTurn: 69,
    deferred: { at: recent(), reason: 'transcript is too large to restore here', park: 'continue', manual: true, needMB: 1214, freeMB: null },
  })
  const plan = pausePlan([owedRow('s1'), parked])
  plan.status = 'partial'
  plan.restore = {
    at: recent(), attempts: 0, rounds: 1,
    deferred: [{ sessionId: 'big', kind: 'session', reason: 'transcript is too large to restore here', needMB: 1214 }],
  }
  const store = fakeStore({
    plan,
    journal: new Map([['s:big', { status: 'deferred', boot: 'boot-0', epoch: 1, turn: null }]]),
  })
  const engine = engineFor({
    store, services: { sessions: {} },
    handContinuedFn: () => new Map([
      ['s1', { present: true, moved: false, running: false, lastTurn: 3 }],
      ['big', { present: true, moved: true, running: false, lastTurn: 70 }],
    ]),
  })

  assert.equal(engine.describe().action, 'resume')

  const persisted = store.state.plan
  assert.ok(persisted !== null, 'the row that still owes a continuation keeps the plan open')
  const reopened = persisted.sessions.find((row) => row.sessionId === 'big')
  assert.equal(reopened.owedContinue, false, 'the person did that work')
  assert.equal(reopened.deferred, undefined, 'no hold is left on a row that no longer needs one')
  assert.deepEqual(persisted.restore.deferred, [], 'the state endpoint must stop reporting a hold that is over')
  assert.equal(persisted.sessions.find((row) => row.sessionId === 's1').owedContinue, true)
  assert.deepEqual(store.state.appends.map((entry) => [entry.key, entry.status]), [['s:big', 'satisfied']])
})
