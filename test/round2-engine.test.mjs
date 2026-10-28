import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createEngine } from '../lib/engine.js'
import { createStore } from '../lib/snapshot.js'

/**
 * Round-2 contract tests. Every press here runs the real engine against a store whose surface is the
 * durable one, so the assertions are about what a second process would read back, not about internal
 * variables. The probe is the only fake: stopping jobs, mounting sessions and arming goals are the
 * Host's work and cannot be faked away.
 */

function fakeStore({ plan = null, journal = [], failConsume = false } = {}) {
  const state = { plan, writes: [], consumed: null, result: null, journal: new Map(), failConsume }
  for (const key of journal) state.journal.set(key, { status: 'restored', boot: 'boot-0' })
  return {
    state,
    read: () => state.plan,
    write: (next) => {
      state.writes.push(structuredClone(next))
      state.plan = { ...next }
      return state.plan
    },
    readPending: () => null,
    writePending: (next) => {
      state.writes.push(structuredClone(next))
      state.plan = { ...next }
      return state.plan
    },
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
    consume: (next, summary) => {
      if (state.failConsume === true) return { ok: false, archivePath: null, published: false }
      state.consumed = { plan: structuredClone(next), summary }
      state.plan = null
      state.journal.clear()
      state.result = { planId: next.planId, status: 'restored', summary }
      return { ok: true, archivePath: '/tmp/restores/x.json', published: true }
    },
  }
}

function probeFor({ stopOutcome = {}, restoreSession = null, assessSession = null, prepareGoal = null, restoreGoal = null, crashPlan = null, live = null } = {}) {
  const calls = []
  const liveState = live ?? { sessions: [], goals: [], jobs: [], readable: true }
  return {
    calls,
    live: () => liveState,
    stop: async (current) => {
      calls.push(['stop'])
      return { canceled: [], unknown: [], pausedGoals: [], goalErrors: [], killedJobs: [], jobErrors: [], stillRunning: [], ...stopOutcome }
    },
    restoreSession: async (session, options) => {
      calls.push(['session', session.sessionId, session.intent, session.epoch, session.admittedRequest ?? null])
      if (restoreSession !== null) return restoreSession(session, options)
      return { status: 'restored', detail: 'attached' }
    },
    assessSession: async (session, options) => {
      calls.push(['assess', session.sessionId])
      if (assessSession !== null) return assessSession(session, options)
      return { action: 'unknown', turn: null, mounted: true, admitted: false, detail: 'no verdict' }
    },
    prepareGoal: async (goal) => {
      calls.push(['prepareGoal', goal.goalId, goal.revision])
      if (prepareGoal !== null) return prepareGoal(goal)
      return { status: 'ready', revision: Number.isSafeInteger(goal.revision) ? goal.revision : 0 }
    },
    restoreGoal: async (goal) => {
      calls.push(['restoreGoal', goal.goalId, goal.revision])
      if (restoreGoal !== null) return restoreGoal(goal)
      return { status: 'restored', detail: 'armed' }
    },
    crashPlan: (residue, options) => {
      if (crashPlan !== null) return crashPlan(residue, options)
      if (residue === null) return null
      return {
        version: 3,
        planId: options.planId,
        status: 'paused',
        source: 'crash',
        createdAt: '1970-01-01T00:00:00.000Z',
        sessions: (residue.sessions ?? []).map((row) => ({ sessionId: row.sessionId, intent: 'mount', epoch: 0, running: false, lastTurn: row.lastTurn ?? null, crash: true })),
        goals: [],
        jobs: [],
        crashes: (residue.sessions ?? []).length,
      }
    },
  }
}

function engineFor({ store = null, probe = null, bootId = 'boot-1', maxRestoreAttempts } = {}) {
  const s = store ?? fakeStore()
  const p = probe ?? probeFor()
  const engine = createEngine({ store: s, probe: p, heartbeat: null, now: () => 1700000000000, bootId, maxRestoreAttempts, log: () => {} })
  return { store: s, probe: p, engine }
}

function pausedPlan(overrides = {}) {
  return {
    version: 3,
    planId: 'plan-1',
    status: 'paused',
    source: 'pause',
    createdAt: '2023-11-14T22:13:20.000Z',
    sessions: [],
    goals: [],
    jobs: [],
    attention: [],
    ...overrides,
  }
}

function deferred() {
  let resolve
  const promise = new Promise((done) => { resolve = done })
  return { promise, resolve }
}

const tick = () => new Promise((done) => setImmediate(done))

// §2.1 — one merge decides the outcome for both entry points. An interrupted restore that cannot
// prove silence is `partial`, never a complete pause: the caller's copy and the durable copy agree.
test('an interrupted restore whose stop throws is partial, keeps the residue and reports it', async () => {
  const store = fakeStore({ plan: pausedPlan({ sessions: [{ sessionId: 's1', intent: 'continue', epoch: 2, running: true, lastTurn: 3 }] }) })
  const hold = deferred()
  const probe = probeFor({
    stopOutcome: { stillRunning: ['s2'] },
    restoreSession: () => hold.promise,
  })
  probe.stop = async () => { throw new Error('cannot stop: provider wedged') }
  const { engine } = engineFor({ store, probe })

  const resuming = engine.resume()
  await tick()
  await tick()
  const stopped = await engine.pause()
  hold.resolve({ status: 'restored', detail: 'attached' })
  await resuming

  assert.equal(stopped.status, 'partial')
  const written = store.state.plan
  assert.equal(written.status, 'partial')
  assert.equal(written.stopped.failure, 'cannot stop: provider wedged')
  assert.equal(written.attention.some((row) => typeof row.detail === 'string' && row.detail.includes('stop failed')), true)
  const page = engine.describe()
  assert.equal(page.complete, false)
  assert.equal(page.error, 'pause-partial')
  assert.equal(page.attention > 0, true)
  assert.equal(page.action, 'resume')
})

// §2.1 — the same merge refuses a clean `paused`/`complete:true` while any row is still live.
test('a pause that leaves a session running is partial and not complete', async () => {
  const store = fakeStore({ plan: pausedPlan({ sessions: [{ sessionId: 's1', intent: 'continue', epoch: 1, running: true, lastTurn: 2 }] }) })
  const probe = probeFor({
    stopOutcome: { stillRunning: ['s3'], maintenanceErrors: [{ sessionId: 'm1', detail: 'compaction refused' }] },
    live: { sessions: [{ sessionId: 's1', running: true }], goals: [], jobs: [], readable: true },
  })
  const { engine } = engineFor({ store, probe })
  const result = await engine.pause()

  assert.equal(result.status, 'partial')
  const written = store.state.plan
  assert.equal(written.status, 'partial')
  assert.deepEqual(written.stopped.stillRunning, ['s3'])
  assert.deepEqual(written.stopped.maintenance, { canceled: [], errors: [{ sessionId: 'm1', detail: 'compaction refused' }] })
  assert.equal(written.attention.some((row) => row.id === 'm1' && String(row.detail).includes('compaction refused')), true)
  const page = engine.describe()
  assert.equal(page.complete, false)
  assert.equal(page.attention > 0, true)
})

// §2.2 — the pause records the revision the goals were actually left at; the next resume restores
// that revision instead of accusing the person of editing the goal by hand.
test('pausing mid-restore writes the exact revision the goal was left at', async () => {
  const goal = { sessionId: 'g', goalId: 'g1', revision: 4, armedRevision: 4 }
  const store = fakeStore({ plan: pausedPlan({ goals: [goal] }) })
  const hold = deferred()
  const probe = probeFor({
    stopOutcome: { pausedGoals: [{ sessionId: 'g', goalId: 'g1', pausedRevision: 5, detail: 'revision advanced' }] },
    restoreGoal: () => hold.promise,
  })
  const { engine } = engineFor({ store, probe })

  const resuming = engine.resume()
  await tick()
  const stopped = await engine.pause()
  hold.resolve({ status: 'restored', detail: 'armed' })
  await resuming

  assert.equal(stopped.status === 'paused' || stopped.status === 'partial', true)
  const written = store.state.plan
  assert.equal(written.goals.length, 1)
  assert.equal(written.goals[0].revision, 5)
  assert.equal(written.goals[0].pendingRestore ?? null, null)
  assert.equal(written.goals[0].armedRevision ?? null, null)

  // The next continue must hand the probe revision 5 and persist the pending restore before it does.
  const probe2 = probeFor()
  const next = engineFor({ store, probe: probe2 })
  const resumed = await next.engine.resume()
  assert.equal(resumed.status, 'resumed')
  const prepare = probe2.calls.find((call) => call[0] === 'prepareGoal')
  assert.deepEqual(prepare, ['prepareGoal', 'g1', 5])
  const writes = next.store.state.writes.concat(store.state.writes)
  assert.equal(writes.some((plan) => plan?.goals?.[0]?.pendingRestore?.revision === 5), true)
  assert.equal(writes.some((plan) => plan?.goals?.[0]?.pendingRestore?.expect === 6), true)
})

// §2.3 — a restart merges the durable plan with what is still there; it never rebuilds rows and
// never deletes obligations it merely failed to observe.
test('hydrate keeps the pause plan intact and only marks rows the residue did not name', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-round2-'))
  mkdirSync(join(dir, 'journal'), { recursive: true })
  const store = createStore(dir, { log: () => {} })
  const seeded = pausedPlan({
    sessions: [
      { sessionId: 's1', intent: 'continue', epoch: 3, continuedTurn: 5, admittedRequest: 'req-1', admittedEpoch: 3, retry: 2, running: true, lastTurn: 5, parent: 'root' },
      { sessionId: 's2', intent: 'mount', epoch: 0, running: false, lastTurn: null },
    ],
    goals: [{ sessionId: 's1', goalId: 'g1', revision: 8, armedRevision: 9, pendingRestore: { revision: 8, expect: 9, at: 'x' } }],
  })
  assert.notEqual(store.write(seeded), null)
  const probe = probeFor({ live: { sessions: [], goals: [], jobs: [], readable: true } })
  const { engine } = engineFor({ store, probe })

  const residue = { at: 1700000000000, sessions: [{ sessionId: 's1', lastTurn: 7 }, { sessionId: 's2', lastTurn: null }] }
  const first = await engine.hydrate({ residue })
  assert.equal(first.durable, true)
  assert.equal(first.phase, 'paused')

  const written = store.read()
  const s1 = written.sessions.find((row) => row.sessionId === 's1')
  assert.equal(s1.epoch, 3)
  assert.equal(s1.continuedTurn, 5)
  assert.equal(s1.admittedRequest, 'req-1')
  assert.equal(s1.admittedEpoch, 3)
  assert.equal(s1.retry, 2)
  assert.equal(s1.intent, 'continue')
  assert.equal(s1.lastTurn, 5)
  assert.equal(s1.parent, 'root')
  assert.equal(written.goals.find((row) => row.goalId === 'g1').revision, 8)
  assert.equal(written.goals.find((row) => row.goalId === 'g1').armedRevision, 9)
  assert.deepEqual(written.goals.find((row) => row.goalId === 'g1').pendingRestore, { revision: 8, expect: 9, at: 'x' })

  // A heartbeat that names nothing is not a census: nothing is deleted, it is marked unseen.
  const unseenResidue = { at: 1700000000000, sessions: [] }
  const second = await engine.hydrate({ residue: unseenResidue })
  assert.equal(second.durable, true)
  const afterSecond = store.read()
  assert.equal(afterSecond.sessions.length, 2)
  assert.equal(afterSecond.sessions.every((row) => row.unseen === true), true)
  assert.equal(afterSecond.goals.length, 1)
  assert.equal(afterSecond.goals[0].unseen, true)

  // Third boot: the same residue must not keep rewriting the file.
  const before = readFileSync(join(dir, 'snapshot.json'), 'utf8')
  await engine.hydrate({ residue: unseenResidue })
  assert.equal(readFileSync(join(dir, 'snapshot.json'), 'utf8'), before)
})

// §2.4 — a mounted session the probe could not read is assessed again instead of staying unknown
// for every later press.
test('a session still unknown after mounting is re-assessed and becomes restored', async () => {
  const store = fakeStore({ plan: pausedPlan({ sessions: [{ sessionId: 's1', intent: 'continue', epoch: 2, running: true, lastTurn: 4 }] }) })
  const probe = probeFor({
    restoreSession: async () => ({ status: 'unknown', detail: 'cannot prove the turn', mounted: true }),
    assessSession: async () => ({ action: 'continue', turn: 6, end: 'open', admitted: false, mounted: true, detail: 'turn 6 is open' }),
  })
  const { engine } = engineFor({ store, probe })

  const result = await engine.resume()
  assert.equal(result.status, 'resumed')
  assert.deepEqual(result.summary.unknown, [])
  assert.deepEqual(result.summary.skipped, [])
  assert.deepEqual(result.summary.restored, ['session s1'])
  const row = result.summary.rows.find((item) => item.key === 's:s1')
  assert.equal(row.status, 'restored')
  assert.equal(row.detail, 'turn 6 is open')
  assert.equal(probe.calls.some((call) => call[0] === 'assess' && call[1] === 's1'), true)
  assert.notEqual(store.state.consumed, null)
  const page = engine.describe()
  assert.equal(page.phase, 'idle')
  assert.equal(page.action, 'none')
  assert.equal(page.attention, 0)
})

// §2.4 — a turn that finished before the restart is skipped, not re-continued.
test('a re-assessed session whose turn already completed is skipped', async () => {
  const store = fakeStore({ plan: pausedPlan({ sessions: [{ sessionId: 's1', intent: 'continue', epoch: 1, running: true, lastTurn: 2 }] }) })
  const probe = probeFor({
    restoreSession: async () => ({ status: 'unknown', detail: 'cannot prove the turn', mounted: true }),
    assessSession: async () => ({ action: 'skip', turn: 2, end: 'completed', admitted: false, mounted: true, detail: 'turn completed before this restart' }),
  })
  const { engine } = engineFor({ store, probe })
  const result = await engine.resume()
  assert.equal(result.status, 'resumed')
  assert.deepEqual(result.summary.unknown, [])
  assert.deepEqual(result.summary.skipped, ['session s1'])
  const row = result.summary.rows.find((item) => item.key === 's:s1')
  assert.equal(row.status, 'skipped')
  assert.equal(row.detail, 'turn completed before this restart')
  assert.equal(probe.calls.some((call) => call[0] === 'assess'), true)
})

// §2.5 — an admission recorded mid-restore must survive a later partial write: the write uses the
// plan object the admission landed on, not a stale copy of the file.
test('an admission recorded during a restore is not lost when the restore ends partial', async () => {
  const store = fakeStore({ plan: pausedPlan({ sessions: [{ sessionId: 's1', intent: 'continue', epoch: 4, running: true, lastTurn: 5 }] }) })
  const hold = deferred()
  const probe = probeFor({
    restoreSession: async (session) => {
      await tick()
      // The probe records the admission after the message was accepted by the Harness.
      assert.equal(probe.recorded, undefined)
      probe.recorded = store.state.plan
      return hold.promise
    },
  })
  const { engine } = engineFor({ store, probe })
  const resuming = engine.resume()
  await tick()
  await tick()
  assert.equal(engine.recordAdmission('s1', 'req-77'), true)
  assert.equal(store.state.plan.sessions[0].admittedRequest, 'req-77')
  // The turn cannot be proven either way after the wait, which ends the press `partial`.
  hold.resolve({ status: 'unknown', detail: 'cannot prove the turn', mounted: false })
  const result = await resuming

  assert.equal(result.status, 'partial')
  assert.equal(engine.describe().error, 'restore-partial')
  assert.equal(store.state.plan.sessions[0].admittedRequest, 'req-77')
  assert.equal(store.state.plan.sessions[0].admittedEpoch, 4)
})

test('a re-admission records its retry attempt so the next one gets a fresh request id', async () => {
  const store = fakeStore({ plan: pausedPlan({ sessions: [{ sessionId: 's1', intent: 'continue', epoch: 2, retry: 0, lastTurn: 5 }] }) })
  const { engine } = engineFor({ store, probe: probeFor() })
  assert.equal(engine.recordAdmission('s1', 'crash-1:continue:s1:2.r1'), true)
  assert.equal(store.state.plan.sessions[0].retry, 1)
  assert.equal(engine.recordAdmission('s1', 'crash-1:continue:s1:2.r2'), true)
  assert.equal(store.state.plan.sessions[0].retry, 2)
  assert.equal(store.state.plan.sessions[0].admittedRequest, 'crash-1:continue:s1:2.r2')
})

// §2.6 — the resume may only claim a job stopped when the stop said so.
test('resume copy follows the job stop state instead of assuming the command died', async () => {
  const store = fakeStore({ plan: pausedPlan({ jobs: [
    { id: 'j1', owner: null, status: 'running', stop: 'stopping', stopDetail: 'still running' },
    { id: 'j2', owner: null, status: 'running', stop: 'stop-failed', stopDetail: 'kill threw' },
    { id: 'j3', owner: null, status: 'running', stop: 'unknown' },
    { id: 'j4', owner: null, status: 'running', stop: 'stopped' },
    { id: 'j5', owner: null, status: 'running' },
  ] }) })
  const { engine, probe } = engineFor({ store })
  const result = await engine.resume()

  assert.equal(result.status, 'resumed')
  const lines = result.summary.jobsStopped
  assert.equal(lines.length, 5)
  assert.equal(lines[0].includes('正在停止'), true)
  assert.equal(lines[1].includes('仍可能运行'), true)
  assert.equal(lines[2].includes('仍可能运行'), true)
  assert.equal(lines[3].includes('stopped'), true)
  assert.equal(lines[4], 'job j5: stopped, not restarted')
  assert.equal(probe.calls.some((call) => call[0] === 'session'), false)
})

// §2.6 — a plan that only owes a job report hands the report to the owner; it never replays a
// command whose effect nobody can verify.
test('a job-only plan hands the obligation to its owner instead of replaying the command', async () => {
  const store = fakeStore({ plan: pausedPlan({ jobs: [{ id: 'j9', owner: 's9', status: 'running', stop: 'stopped', command: 'npm run deploy', lastOutput: '32%', stopDetail: 'stopped' }] }) })
  const { engine, probe } = engineFor({ store })
  const result = await engine.resume()

  // The obligation is delivered through the ordinary session restore path, not reported and dropped.
  // It stays `partial`: delivering the message is not proof the owner acted on it, and the plan is
  // the only durable record of what they were told.
  assert.equal(result.status, 'partial')
  const sessionCall = probe.calls.find((call) => call[0] === 'session')
  assert.equal(sessionCall?.[1], 's9')
  assert.equal(sessionCall?.[2], 'continue')
  const handoff = result.summary.rows.find((row) => row.status === 'handoff')
  assert.equal(handoff.label, 'job j9')
  assert.equal(probe.calls.some((call) => call[0] === 'goal' || call[0] === 'restoreGoal'), false)
  // The command is never replayed: the row continues the owner, it does not restart the job.
  assert.equal(Object.hasOwn(result.summary, 'jobsRestarted'), false)
  // The row is written to the store before delivery and stays there with the plan, so a concurrent
  // reader and the next boot both see who still owes the next step.
  assert.equal(store.state.consumed, null)
  assert.equal(store.read()?.sessions.find((row) => row.sessionId === 's9')?.handoff, 'job')
  assert.equal(store.state.result, null, 'a delivered handoff is not a finished restore')
  assert.equal(result.summary.rows.find((row) => row.status === 'handoff')?.label, 'job j9')
})

test('the job handoff row reaches the store before its continuation is delivered', async () => {
  const store = fakeStore({ plan: pausedPlan({ jobs: [{ id: 'j1', owner: 'owner', status: 'running', stop: 'stopped' }] }) })
  let seenAtDelivery = null
  const probe = probeFor({
    restoreSession: async (session) => {
      // A second process must be able to read the obligation while the first one is delivering it.
      seenAtDelivery = store.read()
      return { status: 'restored', turn: 4, detail: 'continued', continued: true }
    },
  })
  const { engine } = engineFor({ store, probe })
  const result = await engine.resume()

  assert.equal(result.status, 'partial')
  assert.notEqual(seenAtDelivery, null)
  const row = seenAtDelivery.sessions.find((item) => item.sessionId === 'owner')
  assert.equal(row?.handoff, 'job')
  assert.equal(row?.job?.id, 'j1')
  // The owner was told in this cycle, but `restored` is delivery, not acknowledgement: only the next
  // press, which finds the turn completed and answers `skipped`, spends the obligation.
  assert.equal(store.state.consumed, null)
  const kept = store.read()
  assert.equal(kept.sessions.find((item) => item.sessionId === 'owner')?.handoff, 'job')
  assert.equal(kept.status, 'partial')
})

test('a handoff the owner already read is spent by the next press, not delivered again', async () => {
  const plan = pausedPlan({
    status: 'partial',
    sessions: [{ sessionId: 'owner', intent: 'continue', epoch: 1, running: false, lastTurn: null, handoff: 'job', job: { id: 'j1' } }],
    jobs: [{ id: 'j1', owner: 'owner', status: 'running', stop: 'stopped' }],
  })
  const store = fakeStore({ plan })
  const probe = probeFor({ restoreSession: async () => ({ status: 'skipped', detail: 'turn completed before this restart', continued: false }) })
  const { engine } = engineFor({ store, probe })
  const result = await engine.resume()
  // `skipped` is proof the handoff turn already completed, so this is the press that ends the
  // obligation; the owner is not told the same thing twice.
  assert.equal(result.status, 'resumed')
  assert.equal(store.read(), null)
  assert.notEqual(store.state.consumed, null)
  assert.equal(probe.calls.filter((call) => call[0] === 'session').length, 1)
})


