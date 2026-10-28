// Round-2 acceptance: the 0.6.2 continuation contract, exercised through the real engine and the
// real probe. Only the official Harness service layer is scripted, and it is scripted so that every
// awkward upstream answer is reachable: a service that never produces, one that answers late, and
// one that refuses to cancel.
//
// What this file is allowed to prove: engine/probe behaviour against controllable services.
// What it is NOT allowed to prove: a real Host process with a live model stream. That boundary is
// stated in docs/acceptance-0.6.2.md; acceptance/host-smoke.mjs owns the Host half.
//
// Contract under test (docs/design/round2-contract.md §3):
//   P1-1 a turn interrupted by a crash is continued exactly once, from durable turn-end evidence
//   P1-2 a turn that provably completed is skipped; an already admitted continuation is not re-sent
//   P1-3 a cancel that fails during a restore leaves the plan partial (never complete)
//   P1-4 hydrate keeps the obligations it did not fulfil: epoch, continuedTurn, admitted record,
//        goal revision, retry
//   P1-5 a plan that only carries a stopped job hands the owner session back instead of dying
//
// Usage: node acceptance/round2.mjs
// Exit: 0 only when every group passes; 1 when anything fails or the interface is missing.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { redactedJson } from './redact.mjs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createStore } from '../lib/snapshot.js'
import { createEngine } from '../lib/engine.js'
import { createProbe } from '../lib/probe.js'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))

/** One controllable answer per upstream service; every call is recorded for the assertions. */
function services(options = {}) {
  const sessions = new Map()
  const goals = new Map()
  const jobs = []
  const calls = []
  const asks = []
  const turnEnds = new Map()
  const sessionLogs = new Map()
  let promptGate = null
  let releasePrompt = null

  const addSession = (spec) => {
    const sessionId = String(spec.sessionId)
    const parent = typeof spec.parent === 'string' ? spec.parent : null
    const turn = Number.isSafeInteger(spec.turn) ? spec.turn : (Number.isSafeInteger(spec.lastTurn) ? spec.lastTurn : 0)
    const agent = {
      id: sessionId,
      status: spec.running === true ? 'running' : 'idle',
      phase: spec.running === true ? { kind: 'running', turn } : { kind: 'idle', lastTurn: turn },
      origin: parent === null ? 'root' : 'subagent',
    }
    if (parent !== null) agent.parentSessionId = parent
    sessions.set(sessionId, { agent, sessionId, parent, projection: { lastTurn: turn, openTurnStartSeq: spec.open === true ? 41 : null } })
    if (Array.isArray(spec.ends)) turnEnds.set(sessionId, spec.ends.map((row) => ({ ...row })))
    if (Array.isArray(spec.log)) sessionLogs.set(sessionId, spec.log.map((row) => ({ ...row })))
    return agent
  }
  const addGoal = (spec) => {
    goals.set(String(spec.sessionId), { ...spec, revision: Number.isSafeInteger(spec.revision) ? spec.revision : 1 })
  }
  const setTurnEnds = (sessionId, ends) => turnEnds.set(sessionId, ends.map((row) => ({ ...row })))
  // A delivered prompt opens its turn at once; the agent is `running` while the model works, which
  // is the window a pause must be able to cancel. Ending the turn leaves `lastTurn` behind.
  const begin = (sessionId) => {
    const row = sessions.get(sessionId)
    if (row === undefined) return
    if (row.agent.phase?.kind === 'running') return
    const turn = Number.isSafeInteger(row.projection.lastTurn) ? row.projection.lastTurn : 0
    row.agent.status = 'running'
    row.agent.phase = { kind: 'running', turn: turn + 1 }
  }
  const advance = (sessionId, kind = 'completed') => {
    const row = sessions.get(sessionId)
    if (row === undefined) return
    begin(sessionId)
    const turn = Number.isSafeInteger(row.agent.phase?.turn) ? row.agent.phase.turn : 1
    row.projection.lastTurn = turn
    row.projection.openTurnStartSeq = null
    row.agent.status = 'idle'
    row.agent.phase = { kind: 'idle', lastTurn: turn }
    setTurnEnds(sessionId, [...(turnEnds.get(sessionId) ?? []), { turn, kind }])
  }
  const holdPrompt = () => {
    promptGate = new Promise((resolve) => { releasePrompt = resolve })
    return () => { const resolve = releasePrompt; promptGate = null; resolve?.() }
  }

  const map = new Map()
  map.set('agents', {
    async resume({ resumeSessionId }) {
      calls.push(['agents.resume', resumeSessionId])
      if (options.mountFails?.includes(resumeSessionId)) throw new Error('resume refused')
      const row = sessions.get(resumeSessionId)
      if (row === undefined) throw new Error('no such session')
      return row.agent
    },
    get(sessionId) { return sessions.get(sessionId)?.agent },
    // The read path the probe's live() uses. The official service has both; a mock without `list`
    // reads as "nothing is running", which would make a stopped session look idle.
    list() { return [...sessions.values()].map((row) => row.agent) },
  })
  map.set('sessionController', {
    resolveAgent(sessionId) {
      calls.push(['resolveAgent', sessionId])
      const row = sessions.get(sessionId)
      if (row === undefined) return { error: new Error('unknown session') }
      return { agent: row.agent }
    },
    async prompt(request, signal) {
      calls.push(['prompt', request.requestId])
      asks.push({ requestId: request.requestId, sessionId: request.sessionId, text: request.content?.[0]?.text ?? null })
      if (signal?.aborted === true) throw new Error('aborted')
      begin(request.sessionId)
      if (promptGate !== null) await promptGate
      if (options.promptDelayMs) await new Promise((resolve) => setTimeout(resolve, options.promptDelayMs))
      // A service that never produces: the message is admitted but no turn opens. The plan must then
      // keep the obligation as unproven instead of claiming a restore.
      if (options.neverProduces === true) return { accepted: true }
      advance(request.sessionId, options.promptEndKind ?? 'completed')
      return { accepted: true }
    },
    async cancel({ sessionId }, signal) {
      calls.push(['cancel', sessionId])
      if (signal?.aborted === true) throw new Error('aborted')
      if (options.cancelRefuses?.includes(sessionId)) throw new Error('cancel refused')
      const row = sessions.get(sessionId)
      if (row !== undefined) {
        row.agent.status = 'idle'
        row.agent.phase = { kind: 'idle', lastTurn: row.projection.lastTurn }
        row.projection.openTurnStartSeq = null
      }
      return { cancelled: true }
    },
  })
  map.set('goals', {
    get(sessionId) { return goals.get(sessionId) ?? null },
    async pause(agentOrId, { id, revision } = {}) {
      const sessionId = typeof agentOrId === 'string' ? agentOrId : agentOrId?.id
      calls.push(['goal.pause', sessionId, revision])
      const goal = goals.get(sessionId)
      if (goal === undefined) throw new Error('no goal')
      if (Number.isSafeInteger(revision) && revision !== goal.revision) throw new Error('revision mismatch')
      goal.revision += 1
      goal.paused = true
      return goal
    },
    async resume(agentOrId, { id, revision } = {}) {
      const sessionId = typeof agentOrId === 'string' ? agentOrId : agentOrId?.id
      calls.push(['goal.resume', sessionId, revision])
      const goal = goals.get(sessionId)
      if (goal === undefined) throw new Error('no goal')
      if (Number.isSafeInteger(revision) && revision !== goal.revision) throw new Error('revision mismatch')
      goal.revision += 1
      goal.paused = false
      return goal
    },
  })
  map.set('sessionProjections', {
    stateOf(sessionId, key) {
      const row = sessions.get(sessionId)
      if (row === undefined) return null
      if (key === 'turnBoundary') return row.projection
      return null
    },
  })
  map.set('sessionLog', {
    readTurnEnds(sessionId) { return turnEnds.get(sessionId) ?? [] },
    read(sessionId) { return sessionLogs.get(sessionId) ?? [] },
  })
  map.set('sessionQueue', { has() { return false } })
  map.set('jobs', {
    list() { return jobs.map((job) => ({ ...job })) },
    async kill(id) {
      calls.push(['job.kill', id])
      const job = jobs.find((row) => row.id === id)
      if (job === undefined) throw new Error('no job')
      job.stop = options.jobStop ?? 'stopped'
      job.status = job.stop === 'stopped' ? 'stopped' : 'running'
      return { ok: job.stop === 'stopped', stop: job.stop }
    },
  })
  map.set('subagents', {
    async prompt(request, signal) {
      calls.push(['childPrompt', request.requestId])
      asks.push({ requestId: request.requestId, sessionId: request.childSessionId, text: request.content?.[0]?.text ?? null })
      if (signal?.aborted === true) throw new Error('aborted')
      begin(request.sessionId)
      if (promptGate !== null) await promptGate
      if (options.neverProduces === true) return { accepted: true }
      advance(request.childSessionId, options.promptEndKind ?? 'completed')
      return { accepted: true }
    },
    async interrupt(sessionId) { calls.push(['childInterrupt', sessionId]); return { ok: true } },
  })

  return { services: map, calls, asks, sessions, goals, jobs, addSession, addGoal, setTurnEnds, advance, holdPrompt }
}

const probeOf = (h, extra = {}) => createProbe(h.services, {
  callMs: 800,
  cancelMs: 300,
  jobExitMs: 150,
  graceMs: 200,
  ...extra,
})

function engineOf(root, probe, options = {}) {
  const store = createStore(root)
  const engine = createEngine({
    store,
    probe,
    bootId: options.bootId ?? 'boot-round2',
    now: () => new Date('2026-10-28T03:00:00.000Z'),
    graceMs: options.graceMs ?? 250,
    log: () => {},
    ...options.engine,
  })
  return { store, engine }
}

const results = []
const coverage = {
  real: ['lib/snapshot.js', 'lib/engine.js', 'lib/probe.js (assessSession, restoreSession, stop)'],
  scripted: ['agents', 'sessionController', 'goals', 'jobs', 'sessionProjections', 'sessionLog', 'subagents', 'sessionQueue'],
  notCovered: ['real Host process with a live model stream (acceptance/host-smoke.mjs owns the Host half)'],
}

async function group(id, name, run) {
  const started = Date.now()
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'dsh-round2-'))
  try {
    const detail = await run(root)
    results.push({ id, name, status: 'pass', ms: Date.now() - started, detail })
    process.stdout.write(`- ${id}: ok\n`)
  } catch (error) {
    results.push({ id, name, status: 'fail', ms: Date.now() - started, detail: String(error?.message ?? error) })
    process.stdout.write(`- ${id}: FAIL ${String(error?.message ?? error)}\n`)
  } finally {
    await fs.promises.chmod(root, 0o700).catch(() => {})
    await fs.promises.rm(root, { recursive: true, force: true })
  }
}

const pausePlan = (sessions, extra = {}) => ({
  version: 3,
  planId: 'p-round2',
  source: 'pause',
  status: 'paused',
  sessions,
  goals: [],
  jobs: [],
  attention: [],
  ...extra,
})

// P1-1: a crash left an open turn whose durable end is `interrupted`. The probe must be able to say
// so from evidence, and the engine must send exactly one continuation.
await group('P1-1', 'a turn interrupted by a crash is continued exactly once', async (root) => {
  const h = services()
  h.addSession({ sessionId: 's1', running: false, lastTurn: 7, open: true, ends: [{ turn: 7, kind: 'interrupted' }] })
  const { store, engine } = engineOf(root, probeOf(h))
  store.write(pausePlan([{ sessionId: 's1', intent: 'continue', epoch: 1, running: true, lastTurn: 7 }]))
  await engine.hydrate()
  const probe = probeOf(h)
  assert.equal(typeof probe.assessSession, 'function', 'probe.assessSession is missing (0.6.1 does not implement the round-2 verdict)')
  const verdict = await probe.assessSession({ sessionId: 's1', intent: 'continue', epoch: 1, lastTurn: 7 }, { plan: store.read() })
  assert.equal(verdict.action, 'continue', `interrupted end must continue, got ${JSON.stringify(verdict)}`)
  assert.equal(verdict.end, 'interrupted', 'the verdict reports how the turn ended')
  const outcome = await engine.resume()
  assert.equal(h.asks.filter((ask) => ask.sessionId === 's1').length, 1, `exactly one continuation, got ${JSON.stringify(h.calls)}`)
  assert.equal(outcome.status, 'resumed', `the restore should finish: ${JSON.stringify(outcome)}`)
  return { verdict: verdict.action, continued: 1 }
})

// P1-2: completed evidence means skip; an admitted continuation means wait, never re-send.
await group('P1-2', 'completed turns are skipped and an already admitted continuation is not re-sent', async (root) => {
  const h = services()
  h.addSession({ sessionId: 'done', running: false, lastTurn: 4, ends: [{ turn: 4, kind: 'completed' }] })
  h.addSession({ sessionId: 'admitted', running: false, lastTurn: 9, ends: [] })
  const { store, engine } = engineOf(root, probeOf(h))
  store.write(pausePlan([
    { sessionId: 'done', intent: 'continue', epoch: 1, running: true, lastTurn: 4 },
    { sessionId: 'admitted', intent: 'continue', epoch: 2, running: true, lastTurn: 9, admittedRequest: 'p-round2:continue:admitted:2', admittedEpoch: 2 },
  ]))
  await engine.hydrate()
  const probe = probeOf(h)
  assert.equal(typeof probe.assessSession, 'function', 'probe.assessSession is missing (0.6.1 does not implement the round-2 verdict)')
  const done = await probe.assessSession({ sessionId: 'done', intent: 'continue', epoch: 1, lastTurn: 4 }, { plan: store.read() })
  assert.equal(done.action, 'skip', `a completed turn owes nothing, got ${JSON.stringify(done)}`)
  const admitted = await probe.assessSession(
    { sessionId: 'admitted', intent: 'continue', epoch: 2, lastTurn: 9, admittedRequest: 'p-round2:continue:admitted:2', admittedEpoch: 2 },
    { plan: store.read() },
  )
  assert.equal(admitted.admitted, true, `the earlier admission must be recognised, got ${JSON.stringify(admitted)}`)
  await engine.resume()
  assert.equal(h.asks.filter((ask) => ask.sessionId === 'admitted').length, 0, `an admitted continuation must not be sent again: ${JSON.stringify(h.calls)}`)
  assert.equal(h.asks.filter((ask) => ask.sessionId === 'done').length, 0, 'a completed turn must not be continued')
  return { done: done.action, admitted: admitted.action }
})

// P1-3: the press stops a restore, and the session refuses to stop. Partial is the only honest end.
await group('P1-3', 'a cancel that fails during a restore leaves the plan partial', async (root) => {
  const h = services({ cancelRefuses: ['s1'], promptDelayMs: 600 })
  h.addSession({ sessionId: 's1', running: false, lastTurn: 4, ends: [{ turn: 4, kind: 'aborted' }] })
  const probe = probeOf(h)
  const { store, engine } = engineOf(root, probe, { graceMs: 400 })
  store.write(pausePlan([{ sessionId: 's1', intent: 'continue', epoch: 1, running: true, lastTurn: 4 }]))
  await engine.hydrate()
  const restoring = engine.resume()
  // The press lands while the continuation is being delivered, which is the window in which the
  // session is really running and a cancel can be refused.
  const deadline = Date.now() + 3000
  while (h.calls.some((call) => call[0] === 'prompt') === false && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  assert.ok(h.calls.some((call) => call[0] === 'prompt'), `the restore was already delivering: ${JSON.stringify(h.calls)}`)
  const pressed = await engine.pause()
  await restoring
  assert.equal(pressed.interrupted, true, `the press must interrupt the restore: ${JSON.stringify(pressed)}`)
  const kept = store.read()
  assert.equal(kept.status, 'partial', `a session that would not stop makes the plan partial, got ${kept.status}`)
  const view = engine.describe()
  assert.equal(view.complete, false, 'partial is never complete')
  assert.ok(view.attention > 0, 'the session that kept running is called out')
  return { status: kept.status, interrupted: pressed.interrupted }
})

// P1-4: hydrate must not launder a still-owed obligation into a fresh one.
await group('P1-4', 'hydrate keeps epoch, continuedTurn, admission record and goal revision', async (root) => {
  const h = services()
  h.addSession({ sessionId: 's1', running: false, lastTurn: 12, ends: [{ turn: 12, kind: 'interrupted' }] })
  h.addGoal({ sessionId: 's1', goalId: 'g1', revision: 5, paused: true })
  const probe = probeOf(h)
  const { store, engine } = engineOf(root, probe)
  store.write(pausePlan(
    [{
      sessionId: 's1', intent: 'continue', epoch: 3, retry: 2, running: true, lastTurn: 12,
      continuedTurn: 9, admittedRequest: 'p-round2:continue:s1:3', admittedEpoch: 3,
    }],
    { goals: [{ sessionId: 's1', goalId: 'g1', revision: 5, armedRevision: 5, paused: true, pendingRestore: false }] },
  ))
  await engine.hydrate()
  const row = store.read().sessions.find((item) => item.sessionId === 's1')
  for (const field of ['epoch', 'continuedTurn', 'admittedRequest', 'admittedEpoch', 'retry', 'intent', 'lastTurn']) {
    assert.ok(Object.hasOwn(row, field), `hydrate dropped ${field}: ${JSON.stringify(row)}`)
  }
  assert.equal(row.epoch, 3, 'the pause cycle is preserved')
  assert.equal(row.continuedTurn, 9, 'the turn the plan already paid for is preserved')
  assert.equal(row.admittedRequest, 'p-round2:continue:s1:3', 'the admission record is preserved')
  assert.equal(row.retry, 2, 'the retry counter is preserved')
  const goal = store.read().goals.find((item) => item.sessionId === 's1')
  assert.equal(goal.armedRevision, 5, `the armed revision is preserved: ${JSON.stringify(goal)}`)
  return { row: { epoch: row.epoch, continuedTurn: row.continuedTurn, retained: true } }
})

// P1-5: a plan that only carries a stopped job still owes the owner its working context back.
await group('P1-5', 'a job-only plan hands the owner session back', async (root) => {
  const h = services()
  h.addSession({ sessionId: 'owner', running: false, lastTurn: 3, ends: [] })
  const probe = probeOf(h)
  const { store, engine } = engineOf(root, probe)
  store.write(pausePlan([], { jobs: [{ id: 'j1', owner: 'owner', status: 'running', stop: 'stopped' }] }))
  await engine.hydrate()
  const outcome = await engine.resume()
  const plan = store.read()
  const ownerRow = (plan?.sessions ?? []).find((row) => row.sessionId === 'owner')
  assert.ok(ownerRow !== undefined, `the owner session must be handed back, plan=${JSON.stringify(plan)}`)
  assert.equal(ownerRow.intent, 'continue', `the owner row is a continuation, got ${JSON.stringify(ownerRow)}`)
  assert.equal(ownerRow.handoff, 'job', 'the row records that a stopped job is why it continues')
  const delivered = h.asks.find((ask) => ask.sessionId === 'owner')
  assert.ok(delivered !== undefined, `the owner continuation is delivered: ${JSON.stringify(outcome)}`)
  assert.match(String(delivered.text), /j1/, 'the message names the job the pause stopped')
  return { status: outcome.status, owner: ownerRow.sessionId }
})

const summary = {
  generatedAt: new Date().toISOString(),
  packageVersion: manifest.version,
  node: process.version,
  contract: 'docs/design/round2-contract.md §3',
  coverage,
  results,
}
summary.passed = results.filter((row) => row.status === 'pass').length
summary.failed = results.filter((row) => row.status === 'fail').length

const evidencePath = path.join(ROOT, 'docs', 'evidence', 'round2.json')
fs.mkdirSync(path.dirname(evidencePath), { recursive: true })
fs.writeFileSync(evidencePath, redactedJson(summary))
process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`)
// Strict gate: five groups exist and all of them must pass. A missing interface is a failure, not a
// skip, because "the code cannot express the contract yet" is exactly what this run must expose.
if (summary.passed + summary.failed !== 5 || summary.failed !== 0) process.exitCode = 1
