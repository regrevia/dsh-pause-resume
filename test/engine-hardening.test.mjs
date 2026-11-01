import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createEngine } from '../lib/engine.js'
import { createStore } from '../lib/snapshot.js'

/**
 * Two narrow invariants that only show up across a boot:
 *  - a row the journal already landed must not come back held, and
 *  - a plan with nothing outstanding must not be rewritten over its own good record on disk.
 * Both tests care about what a second process would read back, so the observations are the state a
 * new engine would see, not internal variables.
 */

function recent() {
  return new Date(1700000000000).toISOString()
}

function fakeStore({ plan = null, journal = [] } = {}) {
  const state = { plan, writes: [], journal: new Map(), consumed: null }
  for (const key of journal) state.journal.set(key, { status: 'restored', boot: 'boot-0' })
  const write = (next) => {
    state.writes.push(structuredClone(next))
    state.plan = { ...next }
    return state.plan
  }
  return {
    state,
    read: () => state.plan,
    write,
    readPending: () => null,
    writePending: write,
    clearPending: () => true,
    writeResult: (record) => { state.consumed = record; return true },
    clearResult: () => true,
    lastRestore: () => null,
    readJournal: () => new Map([...state.journal.entries()]),
    appendJournal: (planId, key, status, boot, extra = null) => {
      state.journal.set(key, { status, boot, epoch: extra?.epoch, turn: extra?.turn })
      return true
    },
    clearJournal: () => state.journal.clear(),
    consume: () => ({ ok: true, archivePath: null, published: false }),
  }
}

function probeFor({ crashPlan = null } = {}) {
  return {
    live: () => ({ sessions: [], goals: [], jobs: [], readable: true }),
    sessionWeight: async () => ({ bytes: 1024, file: null }),
    stop: async () => ({ canceled: [], unknown: [], pausedGoals: [], goalErrors: [], killedJobs: [], jobErrors: [], stillRunning: [] }),
    restoreSession: async () => ({ status: 'restored', detail: 'attached' }),
    assessSession: async () => ({ action: 'unknown', turn: null, mounted: true, admitted: false, detail: 'no verdict' }),
    prepareGoal: async (goal) => ({ status: 'ready', revision: Number.isSafeInteger(goal.revision) ? goal.revision : 0 }),
    restoreGoal: async () => ({ status: 'restored', detail: 'armed' }),
    crashPlan: (residue, options) => {
      if (crashPlan !== null) return crashPlan(residue, options)
      return null
    },
  }
}

function engineFor({ store, probe = probeFor(), bootId = 'boot-1' } = {}) {
  const engine = createEngine({ store, probe, heartbeat: null, now: () => 1700000000000, bootId, log: () => {} })
  return engine
}

const crashedRow = {
  sessionId: 's1',
  intent: 'continue',
  epoch: 2,
  running: true,
  lastTurn: 1,
  deferred: { at: recent(), park: 'continue', reason: 'an earlier restored session is still working' },
}

function crashPlanRow() {
  return {
    version: 3,
    planId: 'plan-1',
    status: 'paused',
    source: 'crash',
    createdAt: recent(),
    sessions: [crashedRow],
    goals: [],
    jobs: [],
    attention: [],
    crashes: 1,
  }
}

const residue = { at: 1700000000000, sessions: [{ sessionId: 's1', lastTurn: 2 }, { sessionId: 's2', lastTurn: 2 }] }

// The journal is the durable proof that a row landed. A crash between that append and the write that
// deletes the marker leaves `deferred` on disk for a row that owes nothing: hydration must not
// revive the hold, or the row is parked again on every boot.
test('hydrate does not revive deferred on a row the journal already landed', async () => {
  const store = fakeStore({ plan: crashPlanRow(), journal: ['s:s1'] })
  const probe = probeFor({
    crashPlan: () => ({ version: 3, planId: 'crash-plan', status: 'paused', source: 'crash', createdAt: recent(), sessions: [{ sessionId: 's1', lastTurn: 2 }, { sessionId: 's2', lastTurn: 2 }], goals: [], jobs: [], crashes: 2 }),
  })
  const engine = engineFor({ store, probe })
  await engine.hydrate({ residue })

  const row = store.state.plan.sessions.find((session) => session.sessionId === 's1')
  assert.ok(row, 'the landed row is still part of the plan')
  assert.equal('deferred' in row, false, 'a landed row keeps no hold')
  assert.equal(row.deferred, undefined)
})

// The same merge without journal evidence must still revive the hold: the guard is about landed
// rows, not about dropping the feature.
test('hydrate still revives deferred when the journal has not landed the row', async () => {
  const store = fakeStore({ plan: crashPlanRow() })
  const probe = probeFor({
    crashPlan: () => ({ version: 3, planId: 'crash-plan', status: 'paused', source: 'crash', createdAt: recent(), sessions: [{ sessionId: 's1', lastTurn: 2 }, { sessionId: 's2', lastTurn: 2 }], goals: [], jobs: [], crashes: 2 }),
  })
  const engine = engineFor({ store, probe })
  await engine.hydrate({ residue })

  const row = store.state.plan.sessions.find((session) => session.sessionId === 's1')
  assert.deepEqual(row.deferred, crashedRow.deferred)
  assert.equal(row.intent, 'continue')
  assert.equal(row.running, false)
})

function pausePlan() {
  return {
    version: 3,
    planId: 'plan-1',
    status: 'paused',
    source: 'pause',
    createdAt: recent(),
    sessions: [{ sessionId: 's1', intent: 'mount', epoch: 0, running: false, lastTurn: null }],
    goals: [],
    jobs: [],
    attention: [],
  }
}

function bytes(path) {
  return existsSync(path) ? readFileSync(path) : null
}

// A finished plan has nothing outstanding. Writing it again would replace the record on disk with a
// second copy of the same done work; a crash between the writes then offers a restore with nothing
// to do. The guard must skip that write while still answering the caller like a successful persist.
test('persisting a finished plan leaves the on-disk record untouched', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-hardening-finished-'))
  const store = createStore(dir, { log: () => {} })
  store.write(pausePlan())
  // A row journalled by this same boot is landed: nothing is outstanding.
  store.appendJournal('plan-1', 's:s1', 'restored', 'boot-1', { epoch: 0, turn: 1 })
  const before = bytes(join(dir, 'snapshot.json'))

  const engine = engineFor({ store })
  await engine.hydrate()
  assert.equal(engine.phase, 'paused')

  assert.equal(engine.recordAdmission('s1', 'req-2'), true)
  assert.deepEqual(bytes(join(dir, 'snapshot.json')), before, 'a finished plan is not rewritten')
})

// Control: with the same plan and no journal evidence the row is still outstanding, so the write
// happens exactly as before and the admission reaches disk.
test('persisting a plan that still owes work does write the admission', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-hardening-outstanding-'))
  const store = createStore(dir, { log: () => {} })
  store.write(pausePlan())
  const before = bytes(join(dir, 'snapshot.json'))

  const engine = engineFor({ store })
  await engine.hydrate()
  assert.equal(engine.phase, 'paused')

  assert.equal(engine.recordAdmission('s1', 'req-2'), true)
  const after = bytes(join(dir, 'snapshot.json'))
  assert.notDeepEqual(after, before, 'an outstanding plan is still written')
  assert.equal(JSON.parse(after.toString()).sessions[0].admittedRequest, 'req-2')
})
