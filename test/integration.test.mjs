import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createStore } from '../lib/snapshot.js'
import { createEngine } from '../lib/engine.js'

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
      createdAt: '1970-01-01T00:00:00.000Z',
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
      createdAt: 1700000000000,
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
