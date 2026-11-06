import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createProbe } from '../lib/probe.js'

function registry(services) {
  return { get: (key) => services[key] }
}

/**
 * The shipped Harness shape the probe depends on: `agents.get` and `agents.list` hand out the agent
 * object itself, the goal service refuses anything that is not that object, and a transition bumps
 * the revision. A steer does not end a turn by itself: the fake turns the agent idle after
 * `finishAfterMs`, which is the only way the probe can tell a wrap-up that landed from one that did
 * not.
 */
function harness({ agents = [], goals = {}, jobs = {}, keepRunning = false, finishAfterMs = null, promptThrows = false, noPrompt = false, endKind = 'completed' } = {}) {
  const calls = []
  const live = new Map(agents.map((agent) => [agent.id, agent]))
  const views = new Map(Object.entries(goals))
  // The shipped Harness records a turn end when a turn finishes; without that record a wrap-up has
  // no proof of how it ended, which is exactly what these tests need to distinguish.
  const ends = new Map()
  const finish = (id) => {
    const agent = live.get(id)
    if (agent === undefined) return
    // A running phase reports the open turn as `turn`; finishing it closes that same turn. Only an
    // idle agent opens a new number.
    const open = agent.phase.kind === 'running' && Number.isSafeInteger(agent.phase.turn)
    const turn = open ? agent.phase.turn : (agent.phase.lastTurn ?? 0) + 1
    agent.status = 'idle'
    agent.phase = { kind: 'idle', lastTurn: turn }
    const kind = endKind !== null && typeof endKind === 'object' ? (endKind[id] ?? 'completed') : endKind
    if (kind === null) return
    const rows = ends.get(id) ?? []
    rows.push({ turn, kind })
    ends.set(id, rows)
  }
  const jobRows = new Map()
  for (const rows of Object.values(jobs)) for (const row of rows) jobRows.set(row.id, row)
  const services = {
    agents: {
      get: (id) => live.get(id),
      list: () => [...live.values()],
    },
    goals: {
      // The capture reads the goal through the same live-agent handle the services use.
      get: (agent) => (live.get(agent?.id) === agent ? { ...(views.get(agent.id) ?? {}) } : null),
      // `disarm` takes the live agent only and does not bump the revision: the later pause still
      // has to match the revision the capture recorded.
      disarm: (agent) => {
        if (live.get(agent?.id) !== agent) throw new Error('GOAL_AGENT_NOT_LIVE')
        const view = views.get(agent.id)
        if (view === undefined) throw new Error('GOAL_NOT_FOUND')
        views.set(agent.id, { ...view, activation: 'disarmed' })
        calls.push(['goals.disarm', agent.id])
        return { ...views.get(agent.id) }
      },
      pause: (agent, ref) => {
        if (live.get(agent?.id) !== agent) throw new Error('GOAL_AGENT_NOT_LIVE')
        const view = views.get(agent.id)
        if (view === undefined || view.id !== ref.id || view.revision !== ref.revision) throw new Error('GOAL_STALE_REVISION')
        if (view.phase !== 'active') throw new Error('GOAL_INVALID_TRANSITION')
        const next = { ...view, phase: 'paused', activation: 'disarmed', revision: view.revision + 1 }
        views.set(agent.id, next)
        calls.push(['goals.pause', agent.id, ref.id, ref.revision])
        return { ...next }
      },
    },
    jobs: {
      list: (caller) => (caller === undefined ? [] : jobs[caller] ?? []),
      get: (id) => jobRows.get(id),
      kill: (id, caller) => {
        calls.push(['jobs.kill', id, caller ?? null])
        const row = jobRows.get(id)
        if (row === undefined) return
        const exit = row.exitAfterMs
        if (Number.isFinite(exit) && exit > 0) setTimeout(() => { row.status = 'killed' }, exit)
        else row.status = 'killed'
      },
    },
    sessionLog: {
      readTurnEnds: async (id) => ends.get(id) ?? [],
    },
    sessionController: {
      cancel: async (request) => {
        calls.push(['cancel', request.sessionId])
        if (keepRunning !== true) finish(request.sessionId)
      },
      resolveAgent: async (sessionId) => {
        calls.push(['resolveAgent', sessionId])
        const existing = live.get(sessionId)
        if (existing !== undefined) return existing
        const agent = { id: sessionId, status: 'idle', phase: { lastTurn: 0 }, mounted: true }
        live.set(sessionId, agent)
        return { agent }
      },
    },
  }
  if (noPrompt !== true) {
    services.sessionController.prompt = async (request, signal) => {
      calls.push(['prompt', request.sessionId, request.requestId, request.mode])
      if (promptThrows === true) throw new Error('PROMPT_REFUSED')
      signal.throwIfAborted()
      const agent = live.get(request.sessionId)
      if (agent === undefined) throw new Error('SESSION_NOT_FOUND')
      agent.status = 'running'
      const wait = finishAfterMs !== null && typeof finishAfterMs === 'object' ? finishAfterMs[request.sessionId] : finishAfterMs
      if (Number.isFinite(wait) && wait >= 0) {
        setTimeout(() => finish(request.sessionId), wait)
      }
      return { accepted: true }
    }
  }
  return { services, registry: registry(services), calls, live, views }
}

/** A session whose turn boundary is readable, like the shipped projection. */
function turnRig({ lastTurn = 6, status = 'idle' } = {}) {
  const fake = harness({ agents: [{ id: 's1', status, phase: { lastTurn }, session: { id: 's1' } }] })
  const state = { lastTurn, openTurnStartSeq: null }
  fake.services.sessionProjections = {
    stateOf: (session, key) => (key === 'turnBoundary' ? state : undefined),
  }
  return { fake, state }
}

const running = (id, lastTurn = 0) => ({ id, status: 'running', phase: { lastTurn } })

test('a wrap-up window steers first, and a turn that ends there is not cancelled again', async () => {
  const fake = harness({
    agents: [running('s1', 2), running('s2', 2)],
    finishAfterMs: { s1: 30 },
  })
  const probe = createProbe(fake.registry, { graceMs: 300 })
  const stopped = await probe.stop(probe.live(), { wrapUpMs: 200, wrapUpText: '收尾', planId: 'p1' })

  const steers = fake.calls.filter((call) => call[0] === 'prompt')
  assert.deepEqual(steers.map((call) => call[1]), ['s1', 's2'])
  assert.deepEqual(steers.map((call) => call[3]), ['steer', 'steer'])
  // The id is idempotent per plan and session, so a held-back retry cannot steer twice.
  assert.deepEqual(steers.map((call) => call[2]), ['pause-wrap-p1-s1-0', 'pause-wrap-p1-s2-0'])
  assert.deepEqual(stopped.wrapUp, {
    windowMs: 200,
    steered: ['s1', 's2'],
    completed: ['s1'],
    unclean: [],
    unverified: [],
    timedOut: ['s2'],
    unavailable: null,
    retracted: [],
    // These fake agents expose no inbox, so the stale steer cannot be taken back: the press reports
    // that instead of claiming a clean retraction.
    retractUnavailable: ['s2'],
  })
  // s1 ended its own turn during the window: the press leaves it alone. s2 did not, so it is stopped.
  assert.deepEqual(fake.calls.filter((call) => call[0] === 'cancel').map((call) => call[1]), ['s2'])
  assert.deepEqual(stopped.canceled, ['s2'])
  assert.deepEqual(stopped.stillRunning, [])
})

test('a steer that throws falls back to the normal cancel instead of failing the stop', async () => {
  const fake = harness({ agents: [running('s1')], promptThrows: true })
  const probe = createProbe(fake.registry, { graceMs: 300 })
  const stopped = await probe.stop(probe.live(), { wrapUpMs: 120, planId: 'p1' })
  assert.deepEqual(stopped.wrapUp, {
    windowMs: 120,
    steered: [],
    completed: [],
    unclean: [],
    unverified: [],
    // A steer the runtime refused was never delivered, so it is not a timed-out wrap-up either: the
    // session falls straight through to the normal cancel.
    timedOut: [],
    unavailable: null,
    // Nothing was steered and nothing timed out, so there is no queued message to take back.
    retracted: [],
    retractUnavailable: [],
  })
  assert.deepEqual(stopped.canceled, ['s1'])
  assert.deepEqual(stopped.unknown, [])
})

test('a controller without a steer entry is reported as unavailable, and the cancel still runs', async () => {
  const fake = harness({ agents: [running('s1')], noPrompt: true })
  const probe = createProbe(fake.registry, { graceMs: 300 })
  const stopped = await probe.stop(probe.live(), { wrapUpMs: 120, planId: 'p1' })
  assert.equal(stopped.wrapUp.unavailable, 'no-prompt')
  assert.deepEqual(stopped.wrapUp.steered, [])
  assert.deepEqual(stopped.canceled, ['s1'])
})

test('many sessions share one wrap-up window instead of waiting one window each', async () => {
  const fake = harness({
    agents: [running('s1'), running('s2'), running('s3')],
    finishAfterMs: { s1: 150, s2: 150, s3: 150 },
  })
  const probe = createProbe(fake.registry, { graceMs: 600 })
  const started = Date.now()
  const stopped = await probe.stop(probe.live(), { wrapUpMs: 300, planId: 'p3' })
  const elapsed = Date.now() - started
  assert.deepEqual(stopped.wrapUp.completed, ['s1', 's2', 's3'])
  assert.deepEqual(stopped.wrapUp.timedOut, [])
  // One window, not one window per session: three 300 ms waits would be 900 ms.
  assert.ok(elapsed < 500, `expected one shared window, took ${elapsed} ms`)
  assert.deepEqual(stopped.canceled, [])
})

test('a goal is disarmed before it is paused, and the pause still matches the recorded revision', async () => {
  const fake = harness({
    agents: [running('s1')],
    goals: { s1: { id: 'g1', revision: 4, phase: 'active', activation: 'armed' } },
    finishAfterMs: { s1: 20 },
  })
  const probe = createProbe(fake.registry, { graceMs: 300 })
  const stopped = await probe.stop(probe.live(), { wrapUpMs: 150, planId: 'p1' })
  assert.deepEqual(stopped.goalsDisarmed, [{ sessionId: 's1', goalId: 'g1' }])
  assert.deepEqual(stopped.pausedGoals, [{ sessionId: 's1', goalId: 'g1', pausedRevision: 5 }])
  const order = fake.calls.map((call) => call[0]).filter((name) => name === 'goals.disarm' || name === 'goals.pause')
  assert.deepEqual(order, ['goals.disarm', 'goals.pause'])
})

test('without a wrap-up window nothing disarms and the old stop order holds', async () => {
  const fake = harness({
    agents: [running('s1', 2)],
    goals: { s1: { id: 'g1', revision: 4, phase: 'active', activation: 'armed' } },
    jobs: { s1: [{ id: 'j1', status: 'running' }] },
  })
  const probe = createProbe(fake.registry, { graceMs: 200 })
  const stopped = await probe.stop(probe.live())
  assert.equal(stopped.wrapUp, null)
  assert.deepEqual(stopped.goalsDisarmed, [])
  assert.equal(fake.calls.some((call) => call[0] === 'goals.disarm'), false)
  const order = fake.calls.map((call) => call[0]).filter((name) => ['goals.pause', 'cancel', 'jobs.kill'].includes(name))
  assert.deepEqual(order, ['goals.pause', 'cancel', 'jobs.kill'])
  assert.deepEqual(stopped.pausedGoals, [{ sessionId: 's1', goalId: 'g1', pausedRevision: 5 }])
})

test('every background job kill is issued before any exit is waited on', async () => {
  const fake = harness({
    agents: [running('s1'), running('s2')],
    jobs: {
      s1: [{ id: 'j1', status: 'running', exitAfterMs: 200 }],
      s2: [{ id: 'j2', status: 'running', exitAfterMs: 200 }],
    },
  })
  const probe = createProbe(fake.registry, { graceMs: 900 })
  const started = Date.now()
  const stopped = await probe.stop(probe.live(), {})
  const elapsed = Date.now() - started
  const kills = fake.calls.filter((call) => call[0] === 'jobs.kill').map((call) => call[1])
  assert.deepEqual(kills, ['j1', 'j2'])
  assert.deepEqual(stopped.killedJobs, [{ id: 'j1', owner: 's1' }, { id: 'j2', owner: 's2' }])
  assert.deepEqual(stopped.jobStates.map((row) => row.status), ['stopped', 'stopped'])
  // Sequential waits would pay two ~200 ms lifetimes; one shared deadline pays one.
  assert.ok(elapsed < 380, `expected parallel job waits, took ${elapsed} ms`)
})

test('a completion caused by a pause wrap-up is not treated as the original task finishing', async () => {
  const plain = turnRig({ lastTurn: 7 })
  const first = createProbe(plain.fake.registry, { settleMs: 60 })
  const skipped = await first.restoreSession(
    { sessionId: 's1', intent: 'continue', epoch: 1, lastTurn: 7, continuedTurn: 7 },
    { plan: { planId: 'p1' } },
  )
  assert.equal(skipped.status, 'skipped')
  assert.equal(skipped.continued, true)
  assert.deepEqual(plain.fake.calls, [])

  const owedRig = turnRig({ lastTurn: 7 })
  const second = createProbe(owedRig.fake.registry, { settleMs: 60 })
  const owed = await second.restoreSession(
    { sessionId: 's1', intent: 'continue', epoch: 1, lastTurn: 7, continuedTurn: 7, owedContinue: true },
    { plan: { planId: 'p1' } },
  )
  assert.notEqual(owed.status, 'skipped')
  // The wrap-up completion closes the turn, not the obligation: the continuation is re-admitted. This
  // fake never opens a turn, so the press is held as "admitted, no turn yet" rather than claiming the
  // work came back; what matters here is that the row was not reported done and one prompt went out.
  const prompts = owedRig.fake.calls.filter((call) => call[0] === 'prompt')
  assert.equal(prompts.length, 1)
  assert.equal(prompts[0][1], 's1')
})

test('a wrap-up whose turn ended in error is not reported as the finished answer', async () => {
  const fake = harness({ agents: [{ id: 's1', status: 'running', phase: { lastTurn: 2 } }], finishAfterMs: { s1: 20 }, endKind: 'error' })
  const probe = createProbe(fake.registry, { graceMs: 300 })
  const stopped = await probe.stop(probe.live(), { wrapUpMs: 300, planId: 'p-error' })

  assert.deepEqual(stopped.wrapUp.completed, [], 'an error is not a completed wrap-up')
  assert.deepEqual(stopped.wrapUp.unclean, [{ sessionId: 's1', kind: 'error' }])
  assert.deepEqual(stopped.wrapUp.timedOut, [], 'the turn did end, so the press need not wait it out')
})

test('a wrap-up is unverified when no turn end was recorded at all', async () => {
  const fake = harness({ agents: [{ id: 's1', status: 'running', phase: { lastTurn: 2 } }], finishAfterMs: { s1: 20 }, endKind: null })
  const probe = createProbe(fake.registry, { graceMs: 300 })
  const stopped = await probe.stop(probe.live(), { wrapUpMs: 300, planId: 'p-none' })

  assert.deepEqual(stopped.wrapUp.completed, [])
  assert.deepEqual(stopped.wrapUp.unverified, [{ sessionId: 's1', detail: 'no turn end was recorded' }])
  assert.deepEqual(stopped.wrapUp.timedOut, ['s1'], 'without evidence the press falls back, it does not guess')
})

test('a steer into an already-open turn is verified when that same turn ends cleanly', async () => {
  // The steer joins the open turn instead of opening a new one, so the end carries the same number
  // the baseline saw. Only the baseline's open flag distinguishes it from a stale end.
  const fake = harness({ agents: [{ id: 's1', status: 'running', phase: { kind: 'running', turn: 5, lastTurn: 4 } }], finishAfterMs: { s1: 20 } })
  const probe = createProbe(fake.registry, { graceMs: 300 })
  const stopped = await probe.stop(probe.live(), { wrapUpMs: 300, planId: 'p-open' })

  assert.deepEqual(stopped.wrapUp.completed, ['s1'])
  assert.deepEqual(stopped.wrapUp.unclean, [])
  assert.deepEqual(stopped.wrapUp.unverified, [])
})
