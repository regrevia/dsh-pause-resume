// End-to-end acceptance run against the real store, heartbeat, engine and probe modules.
// Every scenario owns a fresh temp directory; no production process is touched.
//
// Coverage boundary, stated here so a green run cannot be read as more than it is:
// - real: lib/snapshot.js, lib/heartbeat.js, lib/engine.js, lib/probe.js (createProbe), temp dirs
// - scripted: the official Harness services (`agents`, `sessionController`, `goals`, `jobs`,
//   `sessionProjections`, `sessionLog`, `subagents`), because they are not importable outside the
//   Host. No scenario replaces probe.stop/restoreSession with a stub any more: the probe under test
//   is the shipped one, and only its service boundary is controllable.
// - NOT covered: a real Host process with a real model stream. See acceptance/host-smoke.mjs for
//   the Host half and docs/acceptance-0.6.2.md for the explicit unverified list.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import os from 'node:os'
import path from 'node:path'
import { createStore } from '../lib/snapshot.js'
import { createHeartbeat } from '../lib/heartbeat.js'
import { createEngine } from '../lib/engine.js'
import { createProbe } from '../lib/probe.js'

const results = []
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const dir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-accept-'))

/**
 * A scripted Host: the official services a real probe reads, with the state they would hold.
 * `cancelRefuses` / `promptGate` / `jobKill` are the failure knobs; everything else is normal.
 */
function harness(options = {}) {
  const calls = []
  const prompts = []
  const sessions = new Map()
  const goals = new Map()
  const jobs = new Map()
  const turnEnds = new Map()
  const seenPrompts = new Set()
  const refusedCancel = new Set(options.cancelRefuses ?? [])
  let promptGate = null

  function turnOf(agent) {
    const phase = agent?.phase
    const value = phase?.kind === 'running' ? phase.turn : phase?.lastTurn
    return Number.isSafeInteger(value) ? value : null
  }

  // A delivered prompt opens its turn immediately: the agent is `running` while the model is still
  // thinking, which is exactly the window a pause has to be able to cancel.
  function begin(sessionId) {
    const agent = sessions.get(sessionId)?.agent
    if (agent === undefined) return
    if (agent.phase?.kind === 'running') return
    const turn = turnOf(agent)
    agent.status = 'running'
    agent.phase = { kind: 'running', turn: (turn ?? 0) + 1 }
  }

  function advance(sessionId, kind) {
    const agent = sessions.get(sessionId)?.agent
    if (agent === undefined) return
    begin(sessionId)
    finishTurn(agent, kind)
  }

  function addSession(spec) {
    const agent = {
      id: spec.sessionId,
      status: spec.running === false ? 'idle' : 'running',
      phase: spec.running === false
        ? { kind: 'idle', lastTurn: spec.lastTurn ?? null }
        : { kind: 'running', turn: spec.turn ?? spec.lastTurn ?? 1 },
      session: { id: spec.sessionId, header: spec.parent ? { parentSession: spec.parent } : {} },
    }
    sessions.set(spec.sessionId, {
      agent,
      // Default: the turn boundary is closed. A crash row can say `open: true`, and then the
      // projection alone is evidence of an open turn the probe can never date.
      projection: { lastTurn: spec.lastTurn ?? 0, openTurnStartSeq: spec.open === true ? 41 : null },
    })
    if (spec.goal) goals.set(spec.sessionId, { id: spec.goal, revision: spec.revision ?? 1, phase: 'active', activation: 'armed' })
    if (Array.isArray(spec.ends)) turnEnds.set(spec.sessionId, spec.ends.slice())
    return agent
  }

  function finishTurn(agent, kind) {
    const turn = turnOf(agent)
    agent.status = 'idle'
    agent.phase = { kind: 'idle', lastTurn: turn }
    const row = sessions.get(agent.id)
    if (row) row.projection = { lastTurn: turn, openTurnStartSeq: null }
    const ends = turnEnds.get(agent.id) ?? []
    ends.push({ turn, kind })
    turnEnds.set(agent.id, ends)
  }

  const agents = {
    get(id) {
      return sessions.get(id)?.agent
    },
    list() {
      return [...sessions.values()].map((row) => row.agent)
    },
    isOwnedBy() {
      return false
    },
  }

  const sessionController = {
    async cancel({ sessionId }) {
      calls.push(['cancel', sessionId])
      const agent = sessions.get(sessionId)?.agent
      if (agent === undefined) return
      if (refusedCancel.has(sessionId)) {
        // The neutralised adapter returns without stopping anything: the turn is still there, so the
        // session is still running. A refusal that looked like an idle session made a stop report a
        // clean pause while the work kept going.
        agent.status = 'running'
        agent.phase = { kind: 'running', turn: turnOf(agent) ?? 0 }
        return
      }
      finishTurn(agent, 'interrupted')
    },
    resolveAgent(sessionId) {
      calls.push(['resolve', sessionId])
      const agent = sessions.get(sessionId)?.agent
      if (agent === undefined) return { error: new Error(`session ${sessionId} not found`) }
      return { agent }
    },
    async prompt(request, signal) {
      calls.push(['prompt', request?.requestId ?? null])
      prompts.push({ requestId: request?.requestId ?? null, sessionId: request?.sessionId ?? null })
      if (signal?.aborted === true) throw new Error('aborted')
      const id = String(request?.requestId ?? '')
      // A second delivery of the same obligation is exactly the duplicate the plan must prevent.
      if (seenPrompts.has(id)) throw new Error('DUPLICATE')
      seenPrompts.add(id)
      begin(request?.sessionId)
      if (promptGate !== null) await promptGate
      advance(request?.sessionId, options.promptEnd ?? 'completed')
    },
  }

  const goalsSvc = {
    get(agent) {
      return goals.get(agent?.id) ?? null
    },
    pause(agent, { id, revision }) {
      const goal = goals.get(agent?.id)
      if (goal === undefined || goal.id !== id) throw new Error('goal not found')
      if (goal.revision !== revision) throw new Error(`revision mismatch: ${goal.revision} != ${revision}`)
      goal.revision += 1
      goal.phase = 'paused'
      goal.activation = 'disarmed'
      return { id: goal.id, revision: goal.revision }
    },
    resume(agent, { id, revision }) {
      const goal = goals.get(agent?.id)
      if (goal === undefined || goal.id !== id) throw new Error('goal not found')
      if (goal.revision !== revision) throw new Error(`revision mismatch: ${goal.revision} != ${revision}`)
      goal.revision += 1
      goal.phase = 'active'
      goal.activation = 'armed'
      return { id: goal.id, revision: goal.revision }
    },
  }

  const jobsSvc = {
    list(owner) {
      const rows = [...jobs.values()]
      return rows.filter((job) => owner === undefined || job.owner === owner).map((job) => ({ ...job }))
    },
    get(id) {
      return jobs.get(id)
    },
    kill(id) {
      calls.push(['kill', id])
      const job = jobs.get(id)
      if (job === undefined) throw new Error('job not found')
      job.status = options.jobKill ?? 'killed'
      if (job.status === 'killed') job.settled = true
    },
  }

  const services = new Map([
    ['agents', agents],
    ['sessionController', sessionController],
    ['goals', goalsSvc],
    ['jobs', jobsSvc],
    ['sessionProjections', {
      stateOf(session) {
        return sessions.get(session?.id)?.projection ?? null
      },
    }],
    ['sessionLog', {
      async readTurnEnds(sessionId) {
        return (turnEnds.get(sessionId) ?? []).slice()
      },
    }],
    ['subagents', {
      async prompt(request, signal) {
        calls.push(['childPrompt', request?.requestId ?? null])
        if (signal?.aborted === true) throw new Error('aborted')
        if (promptGate !== null) await promptGate
        advance(request?.childSessionId, options.promptEnd ?? 'completed')
      },
      async interrupt(childId) {
        calls.push(['interrupt', childId])
        const agent = sessions.get(childId)?.agent
        if (agent !== undefined && refusedCancel.has(childId) === false) finishTurn(agent, 'interrupted')
      },
    }],
    ['sessionQueue', {
      has() {
        return false
      },
    }],
  ])

  return {
    services,
    calls,
    prompts,
    sessions,
    goals,
    jobs,
    addSession,
    addJob(spec) {
      jobs.set(spec.id, { status: 'running', settled: false, ...spec })
    },
    holdPrompt() {
      let release = null
      promptGate = new Promise((resolve) => { release = resolve })
      return () => { promptGate = null; release() }
    },
    running: () => [...sessions.values()].filter((row) => row.agent.status === 'running').map((row) => row.agent.id),
  }
}

function engineOf(root, probe, options = {}) {
  return createEngine({
    store: createStore(root),
    probe,
    heartbeat: options.heartbeat,
    bootId: options.bootId ?? 'boot-1',
    now: () => options.now ?? 1700000000000,
    graceMs: options.graceMs ?? 250,
    startGapMs: options.startGapMs,
    log: () => {},
  })
}

const probeOf = (h, options = {}) => createProbe(h.services, {
  callMs: 800,
  cancelMs: 300,
  jobExitMs: 150,
  graceMs: 200,
  ...options,
})

async function scenario(id, name, run) {
  const root = dir()
  const started = Date.now()
  try {
    const detail = await run(root)
    results.push({ id, name, status: 'pass', ms: Date.now() - started, detail: detail ?? null })
  } catch (error) {
    results.push({ id, name, status: 'fail', ms: Date.now() - started, detail: String(error?.stack ?? error) })
  } finally {
    try { fs.chmodSync(root, 0o700) } catch {}
    fs.rmSync(root, { recursive: true, force: true })
  }
}

// R01/R02/R03: a pause writes its plan before stopping, and a cold restart continues each owed turn once.
await scenario('R01-R03', 'pause persists before stop, cold boot continues every owed turn exactly once', async (root) => {
  const h1 = harness({ promptTarget: null })
  h1.addSession({ sessionId: 's1', lastTurn: 4 })
  h1.addSession({ sessionId: 's2', lastTurn: 2 })
  const probe1 = probeOf(h1)
  const engine1 = engineOf(root, probe1)
  assert.equal((await engine1.hydrate()).phase, 'idle')
  const paused = await engine1.pause()
  assert.equal(paused.status, 'paused', `pause should be clean: ${JSON.stringify(paused)}`)
  const onDisk = JSON.parse(fs.readFileSync(path.join(root, 'snapshot.json'), 'utf8'))
  assert.equal(onDisk.version, 3)
  assert.equal(onDisk.status, 'paused', 'a clean stop is not partial')
  assert.equal(onDisk.sessions.length, 2)
  assert.deepEqual(h1.calls.filter((call) => call[0] === 'cancel').map((call) => call[1]).sort(), ['s1', 's2'], 'the real probe cancelled both turns')
  assert.equal(h1.running().length, 0)

  // The turns were cut short by the pause, so their durable projection still has an open turn.
  const h2 = harness()
  h2.addSession({ sessionId: 's1', running: false, lastTurn: 4, ends: [{ turn: 4, kind: 'aborted' }] })
  h2.addSession({ sessionId: 's2', running: false, lastTurn: 2, ends: [{ turn: 2, kind: 'aborted' }] })
  const engine2 = engineOf(root, probeOf(h2), { bootId: 'boot-2', now: 1700000100000 })
  assert.equal((await engine2.hydrate({ residue: null })).phase, 'paused', 'a restart reads the phase from disk')
  const resumed = await engine2.resume()
  assert.equal(resumed.status, 'resumed', `resume should finish: ${JSON.stringify(resumed)}`)
  assert.deepEqual(h2.calls.filter((call) => call[0] === 'prompt').map((call) => call[1]).sort(), h2.calls.filter((call) => call[0] === 'prompt').map((call) => call[1]), 'request ids are unique')
  assert.equal(h2.calls.filter((call) => call[0] === 'prompt').length, 2, 'each owed turn is continued exactly once')
  assert.equal(fs.existsSync(path.join(root, 'snapshot.json')), false, 'the spent plan is consumed')
  assert.equal(fs.existsSync(path.join(root, 'pending.json')), false)
  return { rowsOnDisk: onDisk.sessions.length, continued: 2, probe: 'real createProbe' }
})

// R04/R05/R06: crash residue is offered after boot, released only when restored, and a third boot finds nothing.
await scenario('R04-R06', 'crash residue restores once, then a third boot finds no work', async (root) => {
  const beat1 = createHeartbeat({ dir: root, bootId: 'old', intervalMs: 20, listRunning: async () => [{ sessionId: 'c1', lastTurn: 7 }, { sessionId: 'c2', lastTurn: 3, parent: 'c1' }] })
  beat1.start()
  await sleep(60)
  beat1.stop()
  const beat2 = createHeartbeat({ dir: root, bootId: 'new', intervalMs: 20, listRunning: async () => [] })
  const residue = beat2.peek()
  assert.equal(residue.sessions.length, 2)
  assert.equal(residue.sessions.find((row) => row.sessionId === 'c2').parent, 'c1', 'the child route survives the dead process')

  const h2 = harness()
  // The dead process stopped mid-turn: the disk projection still has an open turn for both.
  h2.addSession({ sessionId: 'c1', running: false, lastTurn: 7, open: true, ends: [{ turn: 7, kind: 'interrupted' }] })
  h2.addSession({ sessionId: 'c2', running: false, lastTurn: 3, parent: 'c1', open: true, ends: [{ turn: 3, kind: 'interrupted' }] })
  // A session that provably finished before the crash is not residue and must never be continued.
  h2.addSession({ sessionId: 'done', running: false, lastTurn: 4, ends: [{ turn: 4, kind: 'completed' }] })
  const probe2 = probeOf(h2)
  const engine2 = engineOf(root, probe2, { bootId: 'new', now: 1700000200000 })
  assert.equal((await engine2.hydrate({ residue })).phase, 'idle', 'a crash record is not a pause')
  // R04 consumption: the real probe must derive "continue" from the durable turn end, not from the
  // projection. An open projection alone is not evidence that a turn still runs.
  assert.equal(typeof probe2.assessSession, 'function', 'probe.assessSession is missing; the crash verdict cannot be honest')
  // hydrate() derives the crash plan from the residue in memory; the same shape is what resume
  // writes. The probe only needs the plan to answer admission questions, so build it from residue.
  const crashPlan = {
    planId: 'crash-plan',
    sessions: residue.sessions.map((row) => ({ sessionId: row.sessionId, intent: 'continue', epoch: 0, running: true, lastTurn: row.lastTurn })),
    goals: [], jobs: [],
  }
  for (const sessionId of ['c1', 'c2']) {
    const verdict = await probe2.assessSession(
      { sessionId, intent: 'continue', epoch: 0, running: true, lastTurn: sessionId === 'c1' ? 7 : 3 },
      { plan: crashPlan },
    )
    assert.equal(verdict.action, 'continue', `${sessionId}: an interrupted turn with an open projection must continue, got ${JSON.stringify(verdict)}`)
    assert.equal(verdict.end, 'interrupted', `${sessionId}: the verdict names the durable end`)
  }
  const done = await probe2.assessSession({ sessionId: 'done', intent: 'continue', epoch: 1, running: true, lastTurn: 4 }, { plan: crashPlan })
  assert.equal(done.action, 'skip', `a completed turn owes nothing, got ${JSON.stringify(done)}`)
  const resumed = await engine2.resume()
  assert.equal(resumed.status, 'resumed', `crash restore should finish: ${JSON.stringify(resumed)}`)
  const continued = h2.calls.filter((call) => call[0] === 'prompt' || call[0] === 'childPrompt').map((call) => call[1])
  // Contract: a turn whose durable end is `interrupted` is continued, even when the dead process
  // left its projection open. Treating an open projection as "already running" (0.6.1) must not
  // survive, so this assertion is expected to fail until probe.assessSession lands.
  assert.equal(continued.length, 2, `both interrupted residue rows must be continued, got ${JSON.stringify(continued)}`)
  assert.equal(continued.filter((id) => String(id).includes('done')).length, 0, 'a completed turn is skipped, not continued')
  // Exactly once: a second press has nothing left to deliver.
  const again = await engine2.resume()
  assert.equal(h2.calls.filter((call) => call[0] === 'prompt' || call[0] === 'childPrompt').length, continued.length, `a second press re-sent work: ${JSON.stringify(again)}`)
  assert.equal(fs.existsSync(path.join(root, 'pending.json')), false, 'restored residue is released')
  beat2.start()
  await sleep(60)
  beat2.stop()
  const beat3 = createHeartbeat({ dir: root, bootId: 'third', intervalMs: 20, listRunning: async () => [] })
  assert.equal(beat3.peek(), null, 'no work left for the next process')
  return { restored: continued.length }
})

// R06: pressing pause during a restore interrupts it, keeps the plan and records what refused to stop.
// Contract: a stop with stillRunning rows is `partial`, never `complete`, and carries attention.
await scenario('R06', 'pause during restore with a session that refuses to stop ends partial, not complete', async (root) => {
  const plan = {
    version: 3, planId: 'p-accept-2', source: 'pause', status: 'paused',
    sessions: [{ sessionId: 's1', running: true, intent: 'continue', lastTurn: 4, epoch: 1 }],
    goals: [], jobs: [], attention: [],
  }
  const store = createStore(root)
  store.write(plan)
  const h = harness({ cancelRefuses: ['s1'] })
  h.addSession({ sessionId: 's1', running: false, lastTurn: 4, ends: [{ turn: 4, kind: 'aborted' }] })
  const engine = engineOf(root, probeOf(h), { graceMs: 400 })
  assert.equal((await engine.hydrate()).phase, 'paused', 'the stored pause is read before the press')
  const release = h.holdPrompt()
  const running = engine.resume()
  const deadline = Date.now() + 4000
  while (h.calls.some((call) => call[0] === 'prompt') === false && Date.now() < deadline) await sleep(10)
  assert.ok(h.calls.some((call) => call[0] === 'prompt'), `the restore was already delivering when the press came: calls=${JSON.stringify(h.calls)} describe=${JSON.stringify(engine.describe())}`)
  const interrupted = await engine.pause()
  release()
  assert.equal(interrupted.interrupted, true)
  const settled = await running
  assert.ok(settled.status === 'interrupted' || settled.status === 'paused' || settled.status === 'partial', `restore settled as ${settled.status}`)
  const kept = store.read()
  assert.equal(kept.planId, 'p-accept-2')
  assert.equal(store.readPending(), null, 'nothing was consumed')
  assert.equal(kept.status, 'partial', `stillRunning must make the plan partial, got ${kept.status}`)
  const described = engine.describe()
  assert.equal(described.complete, false, 'a partial stop is not complete')
  assert.ok(described.attention > 0, `attention should name the running item, got ${described.attention}`)
  assert.ok((kept.attention ?? []).some((row) => JSON.stringify(row).includes('s1')), 'the row named in the plan is the one that refused to stop')
  return { keptRows: kept.sessions.length, attention: kept.attention.length, status: kept.status, complete: described.complete }
})

// R07: when the plan cannot be made durable, pause stops nothing and says why.
await scenario('R07', 'a pause that cannot persist stops nothing', async (root) => {
  const h = harness()
  h.addSession({ sessionId: 's1', lastTurn: 4 })
  h.addSession({ sessionId: 's2', lastTurn: 2 })
  const store = createStore(root)
  const engine = engineOf(root, probeOf(h))
  await engine.hydrate()
  fs.chmodSync(root, 0o500)
  let outcome = null
  try {
    outcome = await engine.pause()
  } finally {
    fs.chmodSync(root, 0o700)
  }
  assert.equal(outcome.status, 'failed')
  assert.equal(h.calls.filter((call) => call[0] === 'cancel' || call[0] === 'prompt').length, 0, 'no stop without a durable plan')
  assert.equal(store.read(), null)
  return { reason: outcome.reason ?? outcome.error ?? null }
})

// R08/R10: an unprovable intent and an unreadable turn are held, never reported as success.
await scenario('R08-R10', 'a plan row without proof of its turn is held, not faked as restored', async (root) => {
  const plan = {
    version: 3, planId: 'p-accept-3', source: 'pause', status: 'paused',
    sessions: [{ sessionId: 's1', intent: 'unknown', epoch: 0, running: false, lastTurn: null }],
    goals: [], jobs: [], attention: [],
  }
  const store = createStore(root)
  store.write(plan)
  // No turn-end record and no open turn: the honest verdict is "unknown", never skip.
  const h = harness()
  h.addSession({ sessionId: 's1', running: false, lastTurn: null, open: false })
  const engine = engineOf(root, probeOf(h))
  await engine.hydrate()
  const outcome = await engine.resume()
  assert.equal(outcome.status, 'partial', `unproven row must keep the plan open: ${JSON.stringify(outcome)}`)
  assert.equal(store.read().sessions[0].intent, 'unknown', 'the row keeps its honest verdict')
  assert.equal(outcome.summary.failed.includes('s1'), false, 'unknown is not a failure')
  assert.ok(outcome.summary.unknown.some((row) => String(row).includes('s1')), 'the unprovable row is named as unknown')
  assert.equal(h.calls.filter((call) => call[0] === 'prompt').length, 0, 'nothing was sent for an unprovable turn')
  return { status: outcome.status }
})

// R13: a job-only plan reports the stop and never claims the job runs again.
// Full owner-handoff semantics (intent continue + handoff job) are asserted in acceptance/round2.mjs.
await scenario('R13', 'a job-only plan closes with the job reported as stopped, not restarted', async (root) => {
  const plan = {
    version: 3, planId: 'p-accept-4', source: 'pause', status: 'paused',
    sessions: [], goals: [], attention: [],
    jobs: [{ id: 'j1', owner: 's1', status: 'running', stop: 'stopped' }],
  }
  const store = createStore(root)
  store.write(plan)
  const h = harness()
  const engine = engineOf(root, probeOf(h))
  await engine.hydrate()
  const outcome = await engine.resume()
  assert.notEqual(outcome.status, 'failed', JSON.stringify(outcome))
  assert.equal(h.calls.filter((call) => call[0] === 'prompt').length, 0, 'a job is not restarted by sending a message')
  if (outcome.status === 'resumed') {
    assert.equal(outcome.summary.jobsStopped.length, 1)
    assert.equal(fs.existsSync(path.join(root, 'snapshot.json')), false, 'a fully settled job-only plan is released')
  } else {
    // The owner handoff keeps an obligation instead of claiming the job came back.
    assert.ok(JSON.stringify(outcome).includes('handoff') || JSON.stringify(outcome).includes('owner'), `unexpected outcome ${JSON.stringify(outcome)}`)
  }
  return { status: outcome.status }
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
  const h = harness()
  h.addSession({ sessionId: 'r1', running: false, lastTurn: 5, ends: [{ turn: 5, kind: 'aborted' }] })
  h.addSession({ sessionId: 'c1', running: false, lastTurn: 3, parent: 'r1', ends: [{ turn: 3, kind: 'aborted' }] })
  h.addSession({ sessionId: 'c2', running: false, lastTurn: 1, parent: 'gone', ends: [{ turn: 1, kind: 'aborted' }] })
  const engine = engineOf(root, probeOf(h))
  await engine.hydrate()
  const outcome = await engine.resume()
  const order = h.calls.filter((call) => call[0] === 'prompt' || call[0] === 'childPrompt')
    .map((call) => String(call[1]).split(':')[2])
  assert.ok(order.indexOf('r1') !== -1 && order.indexOf('r1') < order.indexOf('c1'), `the parent is restored before its child, got ${JSON.stringify(order)}`)
  // A child whose parent disappeared has no routing Activation. The honest outcome keeps it in the
  // plan for a later attempt; claiming it restored (the old fake-probe test did) would lose the row.
  assert.equal(order.includes('c2'), false, 'no delivery is attempted without a live parent route')
  assert.notEqual(outcome.status, 'resumed', `a lost-parent child keeps the plan open: ${JSON.stringify(outcome)}`)
  assert.ok(store.read() !== null, 'the unfinished plan is kept')
  assert.ok((store.read().sessions ?? []).some((row) => row.sessionId === 'c2'), 'the lost-parent row survives for a retry')
  return { order, status: outcome.status }
})

const summary = {
  generatedAt: new Date().toISOString(),
  node: process.version,
  packageVersion: JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version,
  coverage: {
    real: ['lib/snapshot.js', 'lib/heartbeat.js', 'lib/engine.js', 'lib/probe.js'],
    scripted: ['agents', 'sessionController', 'goals', 'jobs', 'sessionProjections', 'sessionLog', 'subagents'],
    notCovered: ['real Host process with a live model stream (see acceptance/host-smoke.mjs)'],
  },
  results,
}
summary.passed = results.filter((row) => row.status === 'pass').length
summary.failed = results.filter((row) => row.status === 'fail').length
// Evidence is written from this run, never hand-edited: the file the release doc quotes is the
// output of the command a reader can re-run.
const evidence = new URL('../docs/evidence/acceptance-run.json', import.meta.url)
fs.mkdirSync(path.dirname(fileURLToPath(evidence)), { recursive: true })
fs.writeFileSync(evidence, `${JSON.stringify(summary, null, 2)}\n`)
console.log(JSON.stringify(summary, null, 2))
// Strict gate: seven scenarios exist and every one of them must pass. A run that silently loses a
// scenario (`|| true`, a swallowed assertion) must not exit 0.
if (summary.passed + summary.failed !== 7 || summary.failed !== 0) process.exitCode = 1
