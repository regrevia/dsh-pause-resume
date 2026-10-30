import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createStore } from '../lib/snapshot.js'
import { createEngine } from '../lib/engine.js'
import { createHeartbeat } from '../lib/heartbeat.js'
import { createProbe } from '../lib/probe.js'

// The store is the only thing that survives a process here: these tests run the real atomic writer
// against a temp directory, so a plan field the writer drops or a file the reader misses fails a
// test instead of a person's restart.

function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'pause-resume-it-'))
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

function harness({ live = { readable: true, sessions: [], goals: [], jobs: [] }, stop = {} } = {}) {
  const calls = []
  return {
    calls,
    live: () => live,
    // Small measured transcripts keep the heap gate out of the way of the behaviour under test.
    sessionWeight: async () => ({ bytes: 1024 * 1024, file: null }),
    stop: async (current) => {
      calls.push(['stop', current.sessions.map((row) => row.sessionId)])
      return {
        canceled: (current.sessions ?? []).map((row) => row.sessionId),
        unknown: [], pausedGoals: [], goalErrors: [], killedJobs: [], jobErrors: [], stillRunning: [],
        sessions: (current.sessions ?? []).map((row) => ({ sessionId: row.sessionId, lastTurn: (row.lastTurn ?? 0) + 1 })),
        ...stop,
      }
    },
    restoreSession: async (session) => {
      calls.push(['session', session.sessionId, session.intent, session.lastTurn])
      return { status: 'restored', detail: 'attached' }
    },
    prepareGoal: async (goal) => {
      calls.push(['prepareGoal', goal.goalId])
      return { status: 'ready', revision: Number.isSafeInteger(goal.revision) ? goal.revision : 0 }
    },
    restoreGoal: async (goal) => {
      calls.push(['goal', goal.goalId])
      return { status: 'restored', revision: 9 }
    },
    crashPlan: (residue, options) => (residue === null ? null : {
      version: 2,
      planId: options.planId,
      status: 'paused',
      source: 'crash',
      createdAt: new Date().toISOString(),
      sessions: residue.sessions.map((row) => ({ sessionId: row.sessionId, running: false, lastTurn: null, crash: true })),
      goals: [],
      jobs: [],
    }),
  }
}

function boot(dir, probe) {
  const store = createStore(dir, { log: () => {} })
  return { store, probe, engine: createEngine({ store, probe, now: () => 1700000000000, bootId: 'boot-1', log: () => {} }) }
}

test('a pause written through the real store is resumable by the next process', async () => {
  const { dir, cleanup } = tempDir()
  try {
    const live = { readable: true, sessions: [{ sessionId: 's1', running: true, lastTurn: 3 }], goals: [], jobs: [] }
    const first = boot(dir, harness({ live }))
    const paused = await first.engine.pause()
    assert.equal(paused.status, 'paused')

    // Same process, new engine and store: what a restart does.
    const next = boot(dir, harness())
    const hydrated = await next.engine.hydrate()
    assert.equal(hydrated.phase, 'paused')
    assert.equal(next.engine.describe().action, 'resume')

    const resumed = await next.engine.resume()
    assert.equal(resumed.status, 'resumed')
    assert.equal(resumed.summary.restored.length, 1)
    // The continuation must be admitted against the very session that was stopped, at a new cycle.
    assert.deepEqual(next.probe.calls.filter((call) => call[0] === 'session'), [['session', 's1', 'continue', 4]])

    assert.equal(fs.existsSync(join(dir, 'snapshot.json')), false)
    const archive = join(dir, 'restores', `${resumed.summary.planId}.json`)
    assert.equal(fs.existsSync(archive), true)
    const record = JSON.parse(fs.readFileSync(archive, 'utf8'))
    assert.equal(record.status, 'restored')
    assert.equal(record.summary.planId, resumed.summary.planId)
    assert.equal(JSON.parse(fs.readFileSync(join(dir, 'last-restore.json'), 'utf8')).planId, resumed.summary.planId)
    assert.equal(fs.existsSync(join(dir, 'journal.jsonl')), false)
  } finally {
    cleanup()
  }
})

test('a pause interrupted in its stop is mounted by the next process, never continued', async () => {
  const { dir, cleanup } = tempDir()
  try {
    const live = { readable: true, sessions: [{ sessionId: 's1', running: true, lastTurn: 3 }], goals: [], jobs: [] }
    const first = boot(dir, harness({ live }))
    // A crash between the durable pausing write and the stop leaves exactly this on disk.
    const store = first.store
    store.write({
      version: 3,
      planId: 'pause-interrupted-1',
      status: 'pausing',
      source: 'pause',
      createdAt: Date.now(),
      sessions: [{ sessionId: 's1', intent: 'continue', running: true, epoch: 1, lastTurn: 3 }],
      goals: [],
      jobs: [],
      attention: [],
    })

    const next = boot(dir, harness())
    const hydrated = await next.engine.hydrate()
    assert.equal(hydrated.phase, 'paused')
    const state = next.engine.describe()
    assert.equal(state.action, 'resume')
    assert.equal(state.complete, false)

    const resumed = await next.engine.resume()
    assert.equal(resumed.status, 'resumed')
    // The person asked for silence and the turn may have died mid-way: mount only, no admission.
    assert.deepEqual(next.probe.calls.filter((call) => call[0] === 'session'), [['session', 's1', 'mount', null]])
    const record = JSON.parse(fs.readFileSync(join(dir, 'restores', 'pause-interrupted-1.json'), 'utf8'))
    assert.equal(record.source, 'interrupted')
    assert.equal(record.sessions[0].intent, 'mount')
    assert.equal(record.status, 'restored')
  } finally {
    cleanup()
  }
})

test('a restored plan stays archived and readable after the process that restored it is gone', async () => {
  const { dir, cleanup } = tempDir()
  try {
    const live = { readable: true, sessions: [{ sessionId: 's1', running: true, lastTurn: 0 }], goals: [], jobs: [] }
    const first = boot(dir, harness({ live }))
    await first.engine.pause()
    const next = boot(dir, harness())
    await next.engine.hydrate()
    await next.engine.resume()

    // Third process: the work is done, so the button offers a fresh pause and the last restore is
    // still reported instead of looking like a plan nobody finished.
    const third = boot(dir, harness())
    await third.engine.hydrate()
    const state = third.engine.describe()
    assert.equal(state.phase, 'idle')
    assert.equal(state.action, 'none')
    assert.equal(state.result.planId !== undefined, true)
    assert.equal(state.counts.sessions, 0)
  } finally {
    cleanup()
  }
})

test('a crash found by the heartbeat is reported without starting its idle rows, and the heartbeat takes the file back', async () => {
  const { dir, cleanup } = tempDir()
  try {
    // First process: two turns are open, then it dies without saying anything. The heartbeat file
    // it leaves behind is the only evidence the next boot has.
    const before = createHeartbeat({
      dir, bootId: 'boot-1', intervalMs: 20,
      listRunning: () => ['s1', 's2'], log: () => {},
    })
    before.start()
    await new Promise((resolve) => setTimeout(resolve, 80))
    before.stop()

    const probe = harness()
    const later = createHeartbeat({ dir, bootId: 'boot-2', intervalMs: 20, listRunning: () => [], log: () => {} })
    const first = createEngine({
      store: createStore(dir, { log: () => {} }), probe, now: () => 1700000000000, bootId: 'boot-2',
      heartbeat: later, log: () => {},
    })
    // The real plugin reads the residue before starting its own heartbeat, because starting is what
    // overwrites the file.
    const hydrated = await first.hydrate({ residue: later.peek() })
    assert.equal(hydrated.durable, true)
    assert.equal(hydrated.phase, 'idle')
    const state = first.describe()
    assert.equal(state.source, 'crash')
    assert.equal(state.action, 'resume')
    assert.equal(state.counts.sessions, 2)
    // A crash record is not a finished stop, so the flag must not claim one.
    assert.equal(first.describe().complete, null)

    const outcome = await first.resume()
    assert.equal(outcome.status, 'resumed')
    // Both sessions are asked. The probe attaches them and reports what it can prove; skipping the
    // rows here is what used to consume a crashed plan with nothing restored.
    const sessions = probe.calls.filter((call) => call[0] === 'session').map((call) => call[1])
    assert.deepEqual(sessions, ['s1', 's2'])
    assert.deepEqual(outcome.summary.skipped, [])
    assert.equal(probe.calls.some((call) => call[0] === 'stop'), false)

    const store = createStore(dir, { log: () => {} })
    // A crash plan lives in pending.json, so finishing it clears that file and leaves a restore
    // report; nothing was ever archived because no pause had been written.
    assert.equal(store.hasPending(), false)
    assert.equal(store.hasSnapshot(), false)
    const report = store.lastRestore()
    assert.equal(report.source, 'crash')
    assert.equal(report.status, 'restored')
    assert.equal(report.summary.failed.length, 0)

    // The next process must not see the same crash again: once the plan is gone, the heartbeat owns
    // the file and describes this boot, not the dead one.
    await new Promise((resolve) => setTimeout(resolve, 120))
    const residue = JSON.parse(fs.readFileSync(join(dir, 'running.json'), 'utf8'))
    assert.deepEqual(residue.sessions, [])
    const second = createEngine({
      store, probe, now: () => 1700000000000, bootId: 'boot-3',
      heartbeat: createHeartbeat({ dir, bootId: 'boot-3', intervalMs: 20, listRunning: () => [], log: () => {} }),
      log: () => {},
    })
    const again = await second.hydrate()
    assert.equal(again.phase, 'idle')
    assert.equal(second.describe().source, null)
  } finally {
    cleanup()
  }
})

test('a real v4 heartbeat record is read by the resume loop without reviving idle work', async () => {
  const { dir, cleanup } = tempDir()
  try {
    // The dead process left one open turn and one armed goal in the file on disk.
    const dead = createHeartbeat({
      dir,
      bootId: 'dead-1',
      intervalMs: 20,
      now: () => 1700000000001,
      log: () => {},
      listRunning: () => ({ sessions: [{ sessionId: 's1' }], goals: [{ sessionId: 's1', goalId: 'g1', revision: 4 }] }),
    })
    dead.start()
    await dead.flush()
    dead.stop()
    const raw = JSON.parse(fs.readFileSync(join(dir, 'running.json'), 'utf8'))
    assert.equal(raw.version, 4)
    assert.deepEqual(raw.goals, [{ sessionId: 's1', goalId: 'g1', revision: 4 }])

    // The next process reads that file before overwriting it and uses the real plan reader, so a
    // field the writer and the reader disagree on fails here instead of at a person's restart.
    const live = createHeartbeat({ dir, bootId: 'live-1', intervalMs: 20, listRunning: () => ({ sessions: [], goals: [] }), log: () => {} })
    const residue = live.peek()
    assert.deepEqual(residue.goals, [{ sessionId: 's1', goalId: 'g1', revision: 4 }])
    const probe = harness()
    probe.crashPlan = createProbe({}, {}).crashPlan
    const store = createStore(dir, { log: () => {} })
    const engine = createEngine({ store, probe, heartbeat: live, now: () => 1700000000000, bootId: 'live-1', log: () => {} })
    await engine.hydrate({ residue })
    assert.equal(engine.phase, 'idle')
    assert.equal(engine.describe().action, 'resume')
    assert.equal(engine.describe().counts.goals, 1)
    assert.equal(engine.describe().counts.sessions, 1)

    const outcome = await engine.resume()
    assert.equal(outcome.status, 'resumed')
    // What this case guards is that the writer and the reader agree on the file, so nothing is
    // silently dropped: the session is probed and the goal is restored instead of being gated off.
    assert.deepEqual(probe.calls.filter((call) => call[0] === 'session').map((call) => call[1]), ['s1'])
    assert.deepEqual(probe.calls.filter((call) => call[0] === 'goal').map((call) => call[1]), ['g1'])
    assert.equal(outcome.summary.skipped.length, 0)
    live.stop()
  } finally {
    cleanup()
  }
})

test('goal-only crash residue goes through the real plan reader and restores the goal alone', async () => {
  const { dir, cleanup } = tempDir()
  try {
    // No session row at all: the dead process was only carrying an armed goal. The real probe must
    // still turn that into a plan, and the engine must arm the goal without inventing a session.
    const probe = harness()
    probe.crashPlan = createProbe({}, {}).crashPlan
    const store = createStore(dir, { log: () => {} })
    const engine = createEngine({ store, probe, now: () => Date.now(), bootId: 'boot-1', log: () => {} })
    await engine.hydrate({ residue: { sessions: [], goals: [{ sessionId: 's2', goalId: 'g2', revision: 3 }], at: Date.now() } })

    assert.notEqual(store.readPending(), null)
    assert.deepEqual(store.readPending().sessions, [])
    assert.deepEqual(store.readPending().goals, [{ sessionId: 's2', goalId: 'g2', revision: 3, armedRevision: 3, crash: true }])
    assert.equal(engine.describe().action, 'resume')
    assert.equal(engine.describe().counts.goals, 1)

    const outcome = await engine.resume()
    assert.equal(outcome.status, 'resumed')
    assert.deepEqual(probe.calls.filter((call) => call[0] === 'session'), [])
    assert.deepEqual(probe.calls.filter((call) => call[0] === 'goal').map((call) => call[1]), ['g2'])
    assert.deepEqual(outcome.summary.failed, [])
  } finally {
    cleanup()
  }
})
