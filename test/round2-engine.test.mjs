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

function fakeStore({ plan = null, journal = [], failConsume = false, failWrite = null } = {}) {
  const state = { plan, writes: [], consumed: null, result: null, journal: new Map(), failConsume, writeCount: 0 }
  for (const key of journal) state.journal.set(key, { status: 'restored', boot: 'boot-0' })
  const write = (next) => {
    state.writeCount += 1
    if (typeof failWrite === 'function' && failWrite(state.writeCount, structuredClone(next)) === true) return null
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

function engineFor({ store = null, probe = null, bootId = 'boot-1', maxRestoreAttempts, heartbeat = null } = {}) {
  const s = store ?? fakeStore()
  const p = probe ?? probeFor()
  const engine = createEngine({ store: s, probe: p, heartbeat, now: () => 1700000000000, bootId, maxRestoreAttempts, log: () => {} })
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
  // A pause plan keeps `continue` here on purpose: its rows were stopped by the press itself, so a
  // later press still owes them a continuation. Only a crash plan treats "not named" as "was idle".
  const unseenResidue = { at: 1700000000000, sessions: [] }
  const second = await engine.hydrate({ residue: unseenResidue })
  assert.equal(second.durable, true)
  const afterSecond = store.read()
  assert.equal(afterSecond.sessions.length, 2)
  assert.equal(afterSecond.sessions.every((row) => row.unseen === true), true)
  assert.equal(afterSecond.sessions.find((row) => row.sessionId === 's1').intent, 'continue')
  assert.equal(afterSecond.goals.length, 1)
  assert.equal(afterSecond.goals[0].unseen, true)

  // Third boot: the same residue must not keep rewriting the file.
  const before = readFileSync(join(dir, 'snapshot.json'), 'utf8')
  await engine.hydrate({ residue: unseenResidue })
  assert.equal(readFileSync(join(dir, 'snapshot.json'), 'utf8'), before)
})

// Regression: a crash plan written for boot N must not queue continuations for rows boot N+1's
// residue does not name. That replay is how a two-day-old session got a fresh turn on every boot,
// while the person only asked to restore the crash that had just happened.
test('a previous crash plan leaves rows the new residue does not name mount-only', async () => {
  const oldPlan = {
    version: 3,
    planId: 'crash-old-1',
    status: 'paused',
    source: 'crash',
    createdAt: '2023-11-14T22:13:20.000Z',
    sessions: [
      { sessionId: 's1', intent: 'continue', epoch: 2, running: true, lastTurn: 22, continuedTurn: 22, crash: true, unseen: true },
      { sessionId: 's2', intent: 'continue', epoch: 0, running: true, lastTurn: 45, continuedTurn: 45, crash: true, unseen: true },
    ],
    goals: [],
    jobs: [],
    attention: [],
    crashes: 2,
  }
  const store = fakeStore({ plan: oldPlan })
  // The new residue only names s3: s1/s2 were not running when this process died.
  const residue = { at: 1700000500000, sessions: [{ sessionId: 's3', lastTurn: 1 }] }
  const { engine, probe } = engineFor({ store })

  const hydrated = await engine.hydrate({ residue })
  assert.equal(hydrated.durable, true)
  const after = store.read()
  const s1 = after.sessions.find((row) => row.sessionId === 's1')
  const s2 = after.sessions.find((row) => row.sessionId === 's2')
  for (const row of [s1, s2]) {
    assert.equal(row.intent, 'mount')
    assert.equal(row.running, false)
    assert.equal(row.epoch, 0)
    assert.equal(row.unseen, true)
    assert.equal(row.continuedTurn, row.lastTurn)
  }

  probe.calls.length = 0
  await engine.resume()
  const restoredRows = probe.calls.filter((call) => call[0] === 'session')
  for (const call of restoredRows) {
    if (call[1] === 's1' || call[1] === 's2') assert.equal(call[2], 'mount')
  }
  assert.equal(restoredRows.some((call) => call[1] === 's1' && call[2] === 'continue'), false)
  assert.equal(restoredRows.some((call) => call[1] === 's2' && call[2] === 'continue'), false)
})

// §2.4 — a boot that found no heartbeat at all cannot prove any old crash row was mid-turn, so the
// plan keeps its rows as mounts instead of replaying every continuation once more.
test('a boot without a heartbeat turns stale crash rows into mounts', async () => {
  const oldPlan = {
    version: 3,
    planId: 'crash-stale-1',
    status: 'paused',
    source: 'crash',
    createdAt: '2023-11-14T22:13:20.000Z',
    sessions: [
      { sessionId: 's1', intent: 'continue', epoch: 3, running: true, lastTurn: 85, continuedTurn: 85, crash: true, unseen: true },
      { sessionId: 's2', intent: 'mount', epoch: 2, running: false, lastTurn: 17, crash: true, unseen: true },
    ],
    goals: [{ sessionId: 's1', goalId: 'g1', revision: 4, armedRevision: 4, crash: true }],
    jobs: [],
    attention: [],
    crashes: 1,
  }
  const store = fakeStore({ plan: oldPlan })
  const { engine, probe } = engineFor({ store })

  const hydrated = await engine.hydrate({ residue: null })
  assert.equal(hydrated.durable, true)
  const after = store.read()
  const s1 = after.sessions.find((row) => row.sessionId === 's1')
  assert.equal(s1.intent, 'mount')
  assert.equal(s1.running, false)
  assert.equal(s1.epoch, 0)
  assert.equal(s1.unseen, true)
  assert.equal(after.sessions.find((row) => row.sessionId === 's2').intent, 'mount')

  probe.calls.length = 0
  await engine.resume()
  const sessionCalls = probe.calls.filter((call) => call[0] === 'session')
  assert.equal(sessionCalls.some((call) => call[1] === 's1' && call[2] === 'continue'), false)
})

// A pause plan is what a person stopped by hand, so a boot without a heartbeat leaves it alone.
test('a boot without a heartbeat leaves a pause plan continuable', async () => {
  const paused = pausedPlan({ sessions: [{ sessionId: 's1', intent: 'continue', epoch: 1, running: true, lastTurn: 4 }] })
  const store = fakeStore({ plan: paused })
  const { engine, probe } = engineFor({ store })
  await engine.hydrate({ residue: null })
  const row = store.read().sessions.find((item) => item.sessionId === 's1')
  assert.equal(row.intent, 'continue')
  assert.equal(row.running, true)
  probe.calls.length = 0
  await engine.resume()
  const sessionCalls = probe.calls.filter((call) => call[0] === 'session')
  assert.equal(sessionCalls.some((call) => call[1] === 's1' && call[2] === 'continue'), true)
})

// A Host can start restoring before this boot's hydrate ran, so the residue is checked once more at
// dispatch: a crash row the residue does not name is mounted, never continued.
test('a crash row the residue does not name is mounted even when dispatch starts first', async () => {
  const crash = {
    ...pausedPlan({ sessions: [
      { sessionId: 's1', intent: 'continue', epoch: 2, running: true, lastTurn: 10, crash: true },
      { sessionId: 's2', intent: 'continue', epoch: 2, running: true, lastTurn: 40, crash: true },
    ] }),
    planId: 'crash-direct-1',
    source: 'crash',
  }
  const store = fakeStore({ plan: crash })
  const heartbeat = { residue: { at: 1700000400000, sessions: [{ sessionId: 's1', lastTurn: 10 }], goals: [] } }
  const { engine, probe } = engineFor({ store, heartbeat })
  probe.calls.length = 0
  await engine.resume()
  const sessionCalls = probe.calls.filter((call) => call[0] === 'session')
  assert.equal(sessionCalls.some((call) => call[1] === 's1' && call[2] === 'continue'), true)
  assert.equal(sessionCalls.some((call) => call[1] === 's2' && call[2] === 'continue'), false)
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
      // Cloned at call time: the engine mutates the plan rows in place during the press.
      seenAtDelivery = structuredClone(store.read())
      return { status: 'restored', turn: 4, detail: 'continued', continued: true, requestId: 'plan:continue:owner:1' }
    },
  })
  const { engine } = engineFor({ store, probe })
  const result = await engine.resume()

  assert.equal(result.status, 'partial')
  assert.notEqual(seenAtDelivery, null)
  const row = seenAtDelivery.sessions.find((item) => item.sessionId === 'owner')
  assert.equal(row?.handoff, 'job')
  assert.equal(row?.handoffPhase, 'pending', 'the probe must see an undelivered obligation')
  assert.equal(row?.job?.id, 'j1')
  // The owner was told in this cycle, but `restored` is delivery, not acknowledgement: only the next
  // press, which finds the turn completed and answers `skipped`, spends the obligation.
  assert.equal(store.state.consumed, null)
  const kept = store.read()
  const keptRow = kept.sessions.find((item) => item.sessionId === 'owner')
  assert.equal(keptRow?.handoff, 'job')
  assert.equal(keptRow?.handoffPhase, 'delivered', 'delivery is recorded so the next boot can check it')
  assert.equal(keptRow?.deliveredTurn, 4)
  assert.equal(kept.status, 'partial')
})

test('a handoff is not marked delivered without proof that this restore sent a request', async () => {
  const plan = pausedPlan({
    sessions: [{ sessionId: 'owner', intent: 'continue', epoch: 1, running: false, lastTurn: null, handoff: 'job', handoffPhase: 'pending', job: { id: 'j1' } }],
    jobs: [{ id: 'j1', owner: 'owner', status: 'running', stop: 'stopped' }],
  })
  const store = fakeStore({ plan })
  // A mount-only answer reports `continued` because the owner is live, but nothing was submitted by
  // this restore. Spending the obligation here would silently drop the one message the job owed.
  const probe = probeFor({ restoreSession: async () => ({ status: 'restored', turn: 4, detail: 'already running', continued: true }) })
  const { engine } = engineFor({ store, probe })
  const result = await engine.resume()
  assert.equal(result.status, 'partial')
  const row = store.read()?.sessions.find((item) => item.sessionId === 'owner')
  assert.equal(row?.handoffPhase, 'pending', 'only a real request spends the pending obligation')
  assert.equal(row?.deliveredTurn, undefined)
  assert.equal(store.state.consumed, null)
})

// §2.6 — delivery is not acknowledgement. Only a completed handoff turn at the delivered turn spends
// the obligation; an older completed owner turn is never proof and never suppresses the prompt.
test('a delivered handoff whose own turn reads completed is spent without a second prompt', async () => {
  const plan = pausedPlan({
    status: 'partial',
    sessions: [{ sessionId: 'owner', intent: 'continue', epoch: 1, running: false, lastTurn: null, handoff: 'job', handoffPhase: 'delivered', deliveredTurn: 4, job: { id: 'j1' } }],
    jobs: [{ id: 'j1', owner: 'owner', status: 'running', stop: 'stopped' }],
  })
  const store = fakeStore({ plan })
  const probe = probeFor({ restoreSession: async () => ({ status: 'skipped', turn: 4, detail: 'handoff turn completed at 4', continued: false }) })
  const { engine } = engineFor({ store, probe })
  const result = await engine.resume()

  assert.equal(result.status, 'resumed')
  assert.equal(store.read(), null)
  assert.notEqual(store.state.consumed, null)
  // The row is re-checked, never re-prompted: one probe call that only reads the settled turn.
  assert.equal(probe.calls.filter((call) => call[0] === 'session').length, 1)
})

test('a pending handoff with an old completed owner turn is still delivered once and never spent', async () => {
  const plan = pausedPlan({
    sessions: [{ sessionId: 'owner', intent: 'continue', epoch: 1, running: false, lastTurn: null, handoff: 'job', handoffPhase: 'pending', job: { id: 'j1' } }],
    jobs: [{ id: 'j1', owner: 'owner', status: 'running', stop: 'stopped' }],
  })
  const store = fakeStore({ plan })
  let seen = null
  const probe = probeFor({
    restoreSession: async (session) => {
      // Copied at call time: the engine mutates the plan row while the press is in flight.
      seen = { ...session }
      // The owner's old turn 3 completed before the pause. A compliant probe still delivers the
      // handoff once instead of calling the pre-pause turn proof.
      return { status: 'restored', turn: 3, detail: 'continued', continued: true, requestId: 'plan:continue:owner:1' }
    },
  })
  const { engine } = engineFor({ store, probe })
  const result = await engine.resume()

  assert.equal(seen?.handoffPhase, 'pending')
  assert.equal(probe.calls.filter((call) => call[0] === 'session').length, 1, 'the owner is prompted exactly once')
  assert.equal(result.status, 'partial')
  assert.equal(store.state.consumed, null)
  const kept = store.read()
  const row = kept.sessions.find((item) => item.sessionId === 'owner')
  assert.equal(row?.handoffPhase, 'delivered')
  assert.equal(row?.deliveredTurn, 3)
  assert.equal(kept.status, 'partial')
})

test('a pending handoff answered skipped is kept owed instead of being spent', async () => {
  const plan = pausedPlan({
    sessions: [{ sessionId: 'owner', intent: 'continue', epoch: 1, running: false, lastTurn: null, handoff: 'job', handoffPhase: 'pending', job: { id: 'j1' } }],
    jobs: [{ id: 'j1', owner: 'owner', status: 'running', stop: 'stopped' }],
  })
  const store = fakeStore({ plan })
  const probe = probeFor({ restoreSession: async () => ({ status: 'skipped', turn: 3, detail: 'turn completed before this restart', continued: false }) })
  const { engine } = engineFor({ store, probe })
  const result = await engine.resume()

  // Skipped at an old turn is not delivery. Spending the row here is how a handoff vanished without
  // the owner ever being told, so the plan stays open and the row stays pending.
  assert.equal(result.status, 'partial')
  assert.equal(store.state.consumed, null)
  assert.equal(store.state.result, null)
  assert.equal(store.read().sessions.find((item) => item.sessionId === 'owner')?.handoffPhase, 'pending')
  assert.deepEqual(result.summary.interrupted, [])
  assert.deepEqual(result.summary.failed, [])
})

test('a delivered handoff whose turn is still running stays partial without a duplicate prompt', async () => {
  const plan = pausedPlan({
    status: 'partial',
    sessions: [{ sessionId: 'owner', intent: 'continue', epoch: 1, running: false, lastTurn: null, handoff: 'job', handoffPhase: 'delivered', deliveredAt: '2023-11-14T22:20:00.000Z', deliveredTurn: 4, job: { id: 'j1' } }],
    jobs: [{ id: 'j1', owner: 'owner', status: 'running', stop: 'stopped' }],
  })
  const store = fakeStore({ plan })
  const probe = probeFor({ restoreSession: async () => ({ status: 'restored', turn: 4, detail: 'still running', continued: false }) })
  const { engine } = engineFor({ store, probe })
  const result = await engine.resume()

  assert.equal(result.status, 'partial')
  assert.equal(store.state.consumed, null)
  assert.equal(probe.calls.filter((call) => call[0] === 'session').length, 1)
  const row = store.read().sessions.find((item) => item.sessionId === 'owner')
  assert.equal(row?.handoffPhase, 'delivered')
  assert.equal(row?.deliveredAt, '2023-11-14T22:20:00.000Z', 'a delivered handoff is not re-marked')
})

test('two boots keep the handoff obligation until the delivered turn settles', async () => {
  const store = fakeStore({
    plan: pausedPlan({
      sessions: [{ sessionId: 'owner', intent: 'continue', epoch: 1, running: false, lastTurn: null, handoff: 'job', handoffPhase: 'pending', job: { id: 'j1' } }],
      jobs: [{ id: 'j1', owner: 'owner', status: 'running', stop: 'stopped' }],
    }),
  })
  const first = engineFor({
    store,
    bootId: 'boot-1',
    probe: probeFor({ restoreSession: async () => ({ status: 'restored', turn: 3, detail: 'continued', continued: true, requestId: 'plan:continue:owner:1' }) }),
  })
  const one = await first.engine.resume()
  assert.equal(one.status, 'partial')
  assert.equal(store.read().sessions.find((item) => item.sessionId === 'owner')?.handoffPhase, 'delivered')

  // A new process re-checks the delivered row instead of trusting the old journal or the old turn.
  const second = engineFor({
    store,
    bootId: 'boot-2',
    probe: probeFor({ restoreSession: async () => ({ status: 'restored', turn: 3, detail: 'still running', continued: false }) }),
  })
  const two = await second.engine.resume()
  assert.equal(two.status, 'partial')
  assert.equal(store.state.consumed, null)
  assert.equal(store.read().sessions.find((item) => item.sessionId === 'owner')?.handoffPhase, 'delivered')

  const third = engineFor({
    store,
    bootId: 'boot-3',
    probe: probeFor({ restoreSession: async () => ({ status: 'skipped', turn: 4, detail: 'handoff turn completed at 4', continued: false }) }),
  })
  const three = await third.engine.resume()
  assert.equal(three.status, 'resumed')
  assert.notEqual(store.state.consumed, null)
  assert.equal(store.read(), null)
})

// §2.7 — a stale pending goal credential belongs to an older revision. Re-arming must write a fresh
// intent for the current revision, and a failed checkpoint write must not lose that intent.
test('a stale pending goal restore is re-armed with the current revision', async () => {
  const plan = pausedPlan({
    goals: [{ sessionId: 's1', goalId: 'g1', revision: 7, pendingRestore: { revision: 5, expect: 6, at: '2023-11-14T22:00:00.000Z' } }],
  })
  const store = fakeStore({ plan })
  let armedWith = null
  const probe = probeFor({
    prepareGoal: async (goal) => ({ status: 'ready', revision: Number.isSafeInteger(goal.revision) ? goal.revision : 0 }),
    restoreGoal: async (goal) => {
      armedWith = goal.pendingRestore ?? null
      return { status: 'restored', revision: 8 }
    },
  })
  const { engine } = engineFor({ store, probe })
  const result = await engine.resume()

  assert.equal(result.status, 'resumed')
  assert.deepEqual(probe.calls.filter((call) => call[0] === 'prepareGoal'), [['prepareGoal', 'g1', 7]])
  assert.equal(armedWith?.revision, 7, 'the old expect 6 must not be reused for revision 7')
  assert.equal(armedWith?.expect, 8)
  assert.equal(store.state.consumed?.goals?.[0]?.pendingRestore ?? null, null)
})

test('a stale pending goal that cannot be reconciled keeps its tracking and reports partial', async () => {
  const plan = pausedPlan({
    goals: [{ sessionId: 's1', goalId: 'g1', revision: 7, pendingRestore: { revision: 5, expect: 6, at: '2023-11-14T22:00:00.000Z' } }],
  })
  const store = fakeStore({ plan })
  const probe = probeFor({ prepareGoal: async () => ({ status: 'skipped', detail: 'goal changed' }) })
  const { engine } = engineFor({ store, probe })
  const result = await engine.resume()

  assert.equal(result.status, 'partial')
  assert.equal(store.state.consumed, null)
  assert.deepEqual(store.read().goals[0].pendingRestore, { revision: 5, expect: 6, at: '2023-11-14T22:00:00.000Z' })
  assert.equal(probe.calls.some((call) => call[0] === 'restoreGoal'), false)
  assert.equal(result.summary.failed.some((line) => /stale restore intent not reconciled/.test(line)), true)
})

test('a pending goal that moved without a checkpoint is re-read and given a fresh intent', async () => {
  const plan = pausedPlan({
    // The row never changed, so comparing intent to the row cannot detect that the goal itself has
    // advanced past it. Only reading the goal can, and that is what makes the next restart possible.
    goals: [{ sessionId: 's1', goalId: 'g1', revision: 7, pendingRestore: { revision: 7, expect: 8, at: 'x' } }],
  })
  const store = fakeStore({ plan })
  let armedWith = null
  const probe = probeFor({
    prepareGoal: async () => ({ status: 'ready', revision: 9 }),
    restoreGoal: async (goal) => {
      armedWith = goal.pendingRestore ?? null
      return { status: 'restored', revision: 10 }
    },
  })
  const { engine } = engineFor({ store, probe })
  const result = await engine.resume()

  assert.equal(result.status, 'resumed')
  assert.equal(probe.calls.some((call) => call[0] === 'prepareGoal'), true, 'a pending row is still verified')
  assert.equal(armedWith?.revision, 9)
  assert.equal(armedWith?.expect, 10)
  const row = store.state.consumed?.plan?.goals?.find((item) => item.goalId === 'g1')
  assert.equal(row?.armedRevision, 10)
  assert.equal(row?.pendingRestore ?? null, null)
})

test('a checkpoint write failure after the second rearm keeps the fresh intent on disk', async () => {
  const plan = pausedPlan({
    goals: [{ sessionId: 's1', goalId: 'g1', revision: 7, pendingRestore: { revision: 5, expect: 6, at: '2023-11-14T22:00:00.000Z' } }],
  })
  const store = fakeStore({
    plan,
    // Allow the fresh intent write, fail the write that would clear it after the restore.
    failWrite: (count, next) => count > 0 && (next.goals?.[0]?.pendingRestore ?? null) === null,
  })
  const probe = probeFor({
    prepareGoal: async (goal) => ({ status: 'ready', revision: Number.isSafeInteger(goal.revision) ? goal.revision : 0 }),
    restoreGoal: async () => ({ status: 'restored', revision: 8 }),
  })
  const { engine } = engineFor({ store, probe })
  const result = await engine.resume()

  assert.equal(result.status, 'partial')
  assert.equal(store.state.consumed, null)
  const kept = store.read().goals[0].pendingRestore
  assert.equal(kept?.revision, 7)
  assert.equal(kept?.expect, 8)
  assert.equal(result.summary.failed.some((line) => /checkpoint not saved/.test(line)), true)
})

// §2.8 — a pause cancels its own work. That abort is the pause succeeding, not a strike against the
// row and not an error line in the summary.
test('a continuation aborted by the pause is an interruption, not a failed attempt', async () => {
  const plan = pausedPlan({ sessions: [{ sessionId: 's1', intent: 'continue', epoch: 2, running: true, lastTurn: 3 }] })
  const store = fakeStore({ plan })
  const probe = probeFor({ restoreSession: async () => ({ status: 'interrupted', detail: 'continuation turn was aborted', continued: false }) })
  const { engine } = engineFor({ store, probe })
  const result = await engine.resume()

  assert.equal(result.status, 'partial')
  assert.deepEqual(result.summary.failed, [])
  assert.equal(result.summary.interrupted.length, 1)
  assert.match(result.summary.interrupted[0], /aborted/)
  assert.equal(store.state.consumed, null)
  const kept = store.read()
  assert.equal(kept.sessions[0].retry ?? null, null, 'an interrupted row keeps no failed-attempt mark')
  assert.deepEqual(kept.restore?.interrupted, result.summary.interrupted)
})


