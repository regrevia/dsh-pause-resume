import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createEngine } from '../lib/engine.js'
import { createStore } from '../lib/snapshot.js'

let dir = null
let store = null

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pause-resume-'))
  store = createStore(dir)
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const session = (id, turnOpen = true) => ({ sessionId: id, turnOpen, title: id })
const goal = (sessionId, goalId, revision = 1) => ({ sessionId, goalId, revision })

function deferred() {
  let resolve
  const promise = new Promise((done) => {
    resolve = done
  })
  return { promise, resolve }
}

/** A probe that records what the engine asked of it, so every assertion is about the engine's own logic. */
function fakeProbe(overrides = {}) {
  const calls = { stop: [], restoreSession: [], restoreGoal: [], restoreSchedule: [] }
  const liveValue = overrides.live ?? { sessions: [session('s1')], goals: [goal('s1', 'g1')] }
  return {
    calls,
    async live() {
      return liveValue
    },
    async crashPlan() {
      return overrides.crashPlan ?? null
    },
    async stop(current) {
      calls.stop.push(current)
      return { canceled: current.sessions.map((row) => row.sessionId), unknown: [] }
    },
    async restoreSession(row) {
      calls.restoreSession.push(row)
      return overrides.restoreSession?.(row) ?? 'restored'
    },
    async restoreGoal(row) {
      calls.restoreGoal.push(row)
      return overrides.restoreGoal?.(row) ?? 'restored'
    },
    async restoreSchedule(row) {
      calls.restoreSchedule.push(row)
      return 'restored'
    },
  }
}

describe('pause', () => {
  it('writes the snapshot before stopping anything and ends paused', async () => {
    const probe = fakeProbe()
    const engine = createEngine({ store, probe })
    const result = await engine.pause()
    assert.equal(result.status, 'paused')
    assert.deepEqual(result.counts, { sessions: 1, goals: 1, schedules: 0, jobs: 0 })
    assert.equal(store.read()?.status, 'paused')
    assert.equal(probe.calls.stop.length, 1)
  })

  it('reports nothing to pause instead of writing an empty snapshot', async () => {
    const probe = fakeProbe({ live: { sessions: [], goals: [] } })
    const engine = createEngine({ store, probe })
    assert.equal((await engine.pause()).status, 'idle')
    assert.equal(store.read(), null)
  })

  it('keeps a second press out while the first is still stopping work', async () => {
    const gate = deferred()
    const probe = fakeProbe()
    probe.stop = (current) => {
      probe.calls.stop.push(current)
      return gate.promise.then(() => ({ canceled: current.sessions.map((row) => row.sessionId), unknown: [] }))
    }
    const engine = createEngine({ store, probe })
    const first = engine.pause()
    const second = engine.pause()
    assert.equal((await second).status, 'busy')
    gate.resolve()
    assert.equal((await first).status, 'paused')
    assert.equal(probe.calls.stop.length, 1)
  })

  it('leaves the snapshot saying pausing when the durable copy cannot be finished', async () => {
    const broken = { ...store, write: (value) => (value.status === 'pausing' ? store.write(value) : null) }
    const engine = createEngine({ store: broken, probe: fakeProbe() })
    const result = await engine.pause()
    assert.equal(result.status, 'paused')
    assert.equal(store.read()?.status, 'pausing')
  })
})

describe('resume', () => {
  it('restores only what the snapshot names, once', async () => {
    const probe = fakeProbe()
    const engine = createEngine({ store, probe })
    await engine.pause()
    const result = await engine.resume()
    assert.equal(result.status, 'resumed')
    assert.equal(result.summary.restored.length, 2)
    assert.equal(store.read(), null)
    probe.calls.restoreSession.length = 0
    assert.equal((await engine.resume()).status, 'empty')
    assert.equal(probe.calls.restoreSession.length, 0)
  })

  it('keeps going after one item fails and says which one', async () => {
    const probe = fakeProbe({
      live: { sessions: [session('s1'), session('s2')], goals: [] },
      restoreSession: (row) => {
        if (row.sessionId === 's1') throw new Error('agent unavailable')
        return 'restored'
      },
    })
    const engine = createEngine({ store, probe })
    await engine.pause()
    const result = await engine.resume()
    assert.equal(result.summary.failed.length, 1)
    assert.equal(result.summary.failed[0].startsWith('session s1'), true)
    assert.equal(result.summary.restored.length, 1)
  })

  it('finishes the remainder after a crash mid-restore', async () => {
    const probe = fakeProbe({ live: { sessions: [session('s1'), session('s2')], goals: [] } })
    const engine = createEngine({ store, probe })
    await engine.pause()
    store.appendJournal('s:s1')
    const result = await engine.resume()
    assert.equal(result.summary.restored.length, 1)
    assert.equal(probe.calls.restoreSession[0].sessionId, 's2')
  })

  it('offers crash residue when no press left a snapshot', async () => {
    const probe = fakeProbe({ live: { sessions: [], goals: [] }, crashPlan: { source: 'crash', sessions: [session('s9')], goals: [], schedules: [], jobs: [] } })
    const engine = createEngine({ store, probe })
    const described = await engine.describe()
    assert.equal(described.action, 'resume')
    assert.equal(described.source, 'crash')
    const result = await engine.resume()
    assert.equal(result.status, 'resumed')
    assert.equal(probe.calls.restoreSession[0].sessionId, 's9')
  })

  it('joins a second resume instead of restoring the same work twice', async () => {
    const gate = deferred()
    const probe = fakeProbe({ live: { sessions: [session('s1')], goals: [] } })
    probe.restoreSession = (row) => {
      probe.calls.restoreSession.push(row)
      return gate.promise.then(() => 'restored')
    }
    const engine = createEngine({ store, probe })
    await engine.pause()
    const first = engine.resume()
    const second = engine.resume()
    assert.equal((await second).status, 'busy')
    gate.resolve()
    const result = await first
    assert.equal(result.status, 'resumed')
    assert.equal(probe.calls.restoreSession.length, 1)
  })
})

describe('the one phase the button renders', () => {
  it('maps running work to pause, a pending snapshot to resume and neither to none', async () => {
    const engine = createEngine({ store, probe: fakeProbe() })
    assert.equal((await engine.describe()).action, 'pause')
    await engine.pause()
    assert.equal((await engine.describe()).action, 'resume')
    await engine.resume()
    const after = await engine.describe()
    assert.equal(after.action, 'pause')
  })

  it('reports no action when nothing is running and nothing is pending', async () => {
    const engine = createEngine({ store, probe: fakeProbe({ live: { sessions: [], goals: [] } }) })
    assert.equal((await engine.describe()).action, 'none')
  })

  it('does not invent a phase when it was reloaded', async () => {
    await createEngine({ store, probe: fakeProbe() }).pause()
    const reloaded = createEngine({ store, probe: fakeProbe({ live: { sessions: [], goals: [] } }) })
    await reloaded.hydrate()
    assert.equal(reloaded.phase, 'paused')
    assert.equal((await reloaded.describe()).action, 'resume')
  })
})
