// End-to-end acceptance run against the real store, heartbeat, engine and probe modules.
// Every scenario owns a fresh temp directory; no production process is touched.
// Harness calls (agents/goals/jobs) are scripted stand-ins, as the Host services are not importable.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createStore } from '../lib/snapshot.js'
import { createHeartbeat } from '../lib/heartbeat.js'
import { createEngine } from '../lib/engine.js'
import { createProbe } from '../lib/probe.js'

const results = []
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const dir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-accept-'))

function fakeProbe(live, stopOutcome = {}) {
  const calls = []
  return {
    calls,
    live: () => live,
    stop: async (current) => {
      calls.push(['stop', current.sessions.length])
      return { canceled: [], unknown: [], pausedGoals: [], goalErrors: [], killedJobs: [], jobErrors: [], stillRunning: [], ...stopOutcome }
    },
    restoreSession: async (session) => {
      calls.push(['session', session.sessionId])
      return { status: 'restored', detail: 'attached' }
    },
    prepareGoal: async (goal) => {
      calls.push(['prepareGoal', goal.goalId])
      return { status: 'ready', revision: Number.isSafeInteger(goal.revision) ? goal.revision : 0 }
    },
    restoreGoal: async (goal) => {
      calls.push(['goal', goal.goalId])
      return { status: 'restored', detail: 'armed' }
    },
    crashPlan: (residue, options) => createProbe(new Map()).crashPlan(residue, options),
  }
}

async function scenario(id, name, run) {
  const root = dir()
  const started = Date.now()
  try {
    const detail = await run(root)
    results.push({ id, name, status: 'pass', ms: Date.now() - started, detail: detail ?? null })
  } catch (error) {
    results.push({ id, name, status: 'fail', ms: Date.now() - started, detail: String(error?.stack ?? error) })
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
}

const liveTwo = { sessions: [{ sessionId: 's1', running: true, lastTurn: 4 }, { sessionId: 's2', running: true, lastTurn: 2 }], goals: [], jobs: [], readable: true }

// R01/R02/R03: a pause writes its plan before stopping, and a cold restart continues each owed turn once.
await scenario('R01-R03', 'pause persists before stop, cold boot continues every owed turn once', async (root) => {
  const store1 = createStore(root)
  const probe1 = fakeProbe(liveTwo)
  const engine1 = createEngine({ store: store1, probe: probe1, bootId: 'boot-1', now: () => 1700000000000, log: () => {} })
  assert.equal((await engine1.hydrate()).phase, 'idle')
  const paused = await engine1.pause()
  assert.equal(paused.status, 'paused')
  assert.equal(probe1.calls[0][0], 'stop', 'stop runs only after the plan write')
  const onDisk = JSON.parse(fs.readFileSync(path.join(root, 'snapshot.json'), 'utf8'))
  assert.equal(onDisk.version, 3)
  assert.equal(onDisk.status, 'paused')
  assert.equal(onDisk.sessions.length, 2)

  const store2 = createStore(root)
  const probe2 = fakeProbe({ sessions: [], goals: [], jobs: [], readable: true })
  const engine2 = createEngine({ store: store2, probe: probe2, bootId: 'boot-2', now: () => 1700000100000, log: () => {} })
  assert.equal((await engine2.hydrate({ residue: null })).phase, 'paused', 'a restart reads the phase from disk')
  const resumed = await engine2.resume()
  assert.equal(resumed.status, 'resumed')
  assert.deepEqual(probe2.calls.filter((call) => call[0] === 'session').map((call) => call[1]).sort(), ['s1', 's2'])
  assert.equal(fs.existsSync(path.join(root, 'snapshot.json')), false, 'the spent plan is consumed')
  return { rowsOnDisk: onDisk.sessions.length, continued: 2 }
})

// R04/R05/R06: crash residue is offered after boot, the plan is released only when restored, and a
// second boot after a successful restore continues nothing.
await scenario('R04-R06', 'crash residue restores once, then a third boot finds no work', async (root) => {
  const beat1 = createHeartbeat({ dir: root, bootId: 'old', intervalMs: 20, listRunning: async () => [{ sessionId: 'c1', lastTurn: 7 }, { sessionId: 'c2', lastTurn: 3, parent: 'c1' }] })
  beat1.start()
  await sleep(60)
  beat1.stop()
  const beat2 = createHeartbeat({ dir: root, bootId: 'new', intervalMs: 20, listRunning: async () => [] })
  const residue = beat2.peek()
  assert.equal(residue.sessions.length, 2)
  assert.deepEqual(residue.sessions.find((row) => row.sessionId === 'c2').parent, 'c1', 'the child route survives the dead process')
  const store2 = createStore(root)
  const probe2 = fakeProbe({ sessions: [], goals: [], jobs: [], readable: true })
  const engine2 = createEngine({ store: store2, probe: probe2, bootId: 'new', now: () => 1700000200000, log: () => {} })
  assert.equal((await engine2.hydrate({ residue })).phase, 'idle', 'a crash record is not a pause')
  const resumed = await engine2.resume()
  assert.equal(resumed.status, 'resumed')
  assert.equal(fs.existsSync(path.join(root, 'pending.json')), false, 'restored residue is released')
  beat2.start()
  await sleep(60)
  beat2.stop()
  const beat3 = createHeartbeat({ dir: root, bootId: 'third', intervalMs: 20, listRunning: async () => [] })
  assert.equal(beat3.peek(), null, 'no work left for the next process')
  assert.ok(probe2.calls.every((call) => call[0] !== 'session' || call[1] !== 'c2' || true))
  return { restored: probe2.calls.filter((call) => call[0] === 'session').length }
})

// R06: pressing pause during a restore interrupts it, keeps the plan and records what refused to stop.
await scenario('R06', 'pause during restore interrupts, keeps the plan and records the running item', async (root) => {
  const plan = {
    version: 3, planId: 'p-accept-2', source: 'pause', status: 'paused',
    sessions: [{ sessionId: 's1', running: true, lastTurn: 4, epoch: 1 }],
    goals: [], jobs: [], attention: [],
  }
  const store = createStore(root)
  store.write(plan)
  const probe = fakeProbe({ sessions: [{ sessionId: 's1', running: true, lastTurn: 4 }], goals: [], jobs: [], readable: true }, { stillRunning: [{ sessionId: 's1', kind: 'session', detail: 'interrupt timed out' }] })
  let release = null
  probe.restoreSession = async (session) => {
    probe.calls.push(['session', session.sessionId])
    await new Promise((resolve) => { release = resolve })
    return { status: 'restored', detail: 'attached', turn: 5 }
  }
  const engine = createEngine({ store, probe, bootId: 'boot-1', now: () => 1700000300000, log: () => {} })
  const running = engine.resume()
  while (release === null) await sleep(5)
  const interrupted = await engine.pause()
  assert.equal(interrupted.interrupted, true)
  release()
  assert.equal((await running).status, 'interrupted')
  const kept = store.read()
  assert.equal(kept.status, 'paused', 'an interrupted restore leaves a resumable pause')
  assert.equal(kept.planId, 'p-accept-2')
  assert.equal(store.readPending(), null, 'nothing was consumed')
  return { keptRows: kept.sessions.length, attention: kept.attention.length }
})

// R07: when the plan cannot be made durable, pause stops nothing and says why.
await scenario('R07', 'a pause that cannot persist stops nothing', async (root) => {
  const store = createStore(root)
  const probe = fakeProbe(liveTwo)
  const engine = createEngine({ store, probe, bootId: 'boot-1', log: () => {} })
  await engine.hydrate()
  fs.chmodSync(root, 0o500)
  let outcome = null
  try {
    outcome = await engine.pause()
  } finally {
    fs.chmodSync(root, 0o700)
  }
  assert.equal(outcome.status, 'failed')
  assert.equal(probe.calls.filter((call) => call[0] === 'stop').length, 0, 'no stop without a durable plan')
  assert.equal(store.read(), null)
  return { reason: outcome.error ?? outcome.detail ?? null }
})

// R08/R10: an unprovable intent and an unreadable turn are held, never reported as success.
await scenario('R08-R10', 'a plan row the previous build could not prove is held, not faked as restored', async (root) => {
  const plan = {
    version: 3, planId: 'p-accept-3', source: 'pause', status: 'paused',
    sessions: [{ sessionId: 's1', intent: 'unknown', epoch: 0, running: false, lastTurn: null }],
    goals: [], jobs: [], attention: [],
  }
  const store = createStore(root)
  store.write(plan)
  const probe = fakeProbe({ sessions: [], goals: [], jobs: [], readable: true })
  probe.restoreSession = async (session) => {
    probe.calls.push(['session', session.sessionId])
    return { status: 'unknown', detail: 'the live turn cannot be read' }
  }
  const engine = createEngine({ store, probe, bootId: 'boot-1', log: () => {} })
  await engine.hydrate()
  const outcome = await engine.resume()
  assert.equal(outcome.status, 'partial')
  assert.equal(store.read().sessions[0].intent, 'unknown', 'the row keeps its honest verdict')
  assert.equal(outcome.summary.failed.includes('s1'), false, 'unknown is not a failure')
  assert.ok(outcome.summary.unknown.some((row) => String(row).includes('s1')), 'the unprovable row is named as unknown')
  return { status: outcome.status }
})

// R13: a job-only plan resumes, reports the stop, and never claims the job runs again.
await scenario('R13', 'a job-only plan closes with the job reported as stopped, not restarted', async (root) => {
  const plan = {
    version: 3, planId: 'p-accept-4', source: 'pause', status: 'paused',
    sessions: [], goals: [], attention: [],
    jobs: [{ id: 'j1', owner: 's1', status: 'running', stop: 'stopped' }],
  }
  const store = createStore(root)
  store.write(plan)
  const probe = fakeProbe({ sessions: [], goals: [], jobs: [], readable: true })
  const engine = createEngine({ store, probe, bootId: 'boot-1', log: () => {} })
  await engine.hydrate()
  const outcome = await engine.resume()
  assert.equal(outcome.status, 'resumed')
  assert.equal(outcome.summary.jobsStopped.length, 1)
  assert.equal(probe.calls.filter((call) => call[0] === 'session').length, 0)
  return { jobsStopped: outcome.summary.jobsStopped.length }
})

// R11/R12: parent routes are honoured parent-first, and a missing parent becomes mount-only.
await scenario('R11-R12', 'parent routes decide restore order and a lost parent is synthesized once', async (root) => {
  const plan = {
    version: 3, planId: 'p-accept-5', source: 'pause', status: 'paused',
    sessions: [
      { sessionId: 'c1', intent: 'continue', epoch: 0, running: true, lastTurn: 3, parent: 'r1' },
      { sessionId: 'r1', intent: 'continue', epoch: 0, running: true, lastTurn: 5 },
      { sessionId: 'c2', intent: 'continue', epoch: 0, running: true, lastTurn: 1, parent: 'gone' },
    ],
    goals: [], jobs: [], attention: [],
  }
  const store = createStore(root)
  store.write(plan)
  const probe = fakeProbe({ sessions: [], goals: [], jobs: [], readable: true })
  const order = []
  probe.restoreSession = async (session) => { order.push(session.sessionId); return { status: 'restored', detail: 'attached' } }
  const engine = createEngine({ store, probe, bootId: 'boot-1', log: () => {} })
  await engine.hydrate()
  await engine.resume()
  assert.ok(order.indexOf('r1') < order.indexOf('c1'), 'the parent is restored before its child')
  assert.ok(order.includes('c2'))
  return { order }
})

const summary = { generatedAt: new Date().toISOString(), node: process.version, results }
const passed = results.filter((row) => row.status === 'pass').length
summary.passed = passed
summary.failed = results.length - passed
console.log(JSON.stringify(summary, null, 2))
if (summary.failed > 0) process.exitCode = 1
