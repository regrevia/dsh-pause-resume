import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createProbe, listResidue, listRunning } from '../lib/probe.js'

function registry(services) {
  return { get: (key) => services[key] }
}

/**
 * A Harness shaped like the shipped one: `agents.get` and `agents.list` hand out the agent object
 * itself, the goal service refuses anything that is not that object, and every transition bumps the
 * revision. The fake keeps those three properties because they are the ones the probe depends on.
 */
function harness({ agents = [], goals = {}, jobs = {}, unownedJobs = [], keepRunning = false } = {}) {
  const calls = []
  const live = new Map(agents.map((agent) => [agent.id, agent]))
  const views = new Map(Object.entries(goals))
  const services = {
    agents: {
      get: (id) => live.get(id),
      list: () => [...live.values()],
      resume: async (request) => {
        calls.push(['agents.resume', request.resumeSessionId])
      },
    },
    goals: {
      get: (agent) => {
        // The shipped service asserts `agents.get(agent.id) === agent`; a bare id must fail here.
        if (live.get(agent?.id) !== agent) throw new Error('GOAL_AGENT_NOT_LIVE')
        const view = views.get(agent.id)
        return view === undefined ? undefined : { ...view }
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
      resume: (agent, ref) => {
        if (live.get(agent?.id) !== agent) throw new Error('GOAL_AGENT_NOT_LIVE')
        const view = views.get(agent.id)
        if (view === undefined || view.id !== ref.id || view.revision !== ref.revision) throw new Error('GOAL_STALE_REVISION')
        if (view.phase === 'active' && view.activation === 'armed') throw new Error('GOAL_INVALID_TRANSITION')
        const next = { ...view, phase: 'active', activation: 'armed', revision: view.revision + 1 }
        views.set(agent.id, next)
        calls.push(['goals.resume', agent.id, ref.id, ref.revision])
        return { ...next }
      },
    },
    jobs: {
      list: (caller) => {
        calls.push(['jobs.list', caller ?? null])
        return caller === undefined ? unownedJobs : jobs[caller] ?? []
      },
      kill: (id, caller) => {
        calls.push(['jobs.kill', id, caller ?? null])
      },
    },
    sessionController: {
      cancel: async (request) => {
        calls.push(['cancel', request.sessionId])
        if (keepRunning !== true) {
          const agent = live.get(request.sessionId)
          if (agent !== undefined) {
            agent.status = 'idle'
            // A real abort ends the turn, which moves the counter past the plan's pre-press value.
            agent.phase.lastTurn = (agent.phase.lastTurn ?? 0) + 1
          }
        }
      },
      // The shipped service answers `{agent}` when it had to mount, and the live Agent itself when
      // it was already there. Callers unwrap one or the other; this fake keeps both shapes.
      resolveAgent: async (sessionId) => {
        calls.push(['resolveAgent', sessionId])
        const existing = live.get(sessionId)
        if (existing !== undefined) return existing
        const agent = { id: sessionId, status: 'idle', phase: { lastTurn: 0 }, mounted: true }
        live.set(sessionId, agent)
        return { agent }
      },
      // The transport takes `(request, signal)`: it checks the signal before admitting anything and
      // dispatches `agent.followup` or `agent.steer`. `{accepted:true}` is admission, not a turn.
      prompt: async (request, signal) => {
        calls.push(['prompt', request.sessionId, request.requestId, request.mode, request.content[0].text, signal instanceof AbortSignal, typeof signal?.throwIfAborted === 'function'])
        signal.throwIfAborted()
        const agent = live.get(request.sessionId)
        if (agent === undefined) throw new Error('SESSION_NOT_FOUND')
        agent.status = 'running'
        agent.phase.lastTurn = (agent.phase.lastTurn ?? 0) + 1
        return { accepted: true }
      },
    },
  }
  return { services, registry: registry(services), calls, live, views }
}

async function settle(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

test('live() reads the live registry, active goals and running jobs', () => {
  const a = { id: 's1', status: 'running', phase: { lastTurn: 3 } }
  const b = { id: 's2', status: 'idle', phase: { lastTurn: 1 } }
  const fake = harness({
    agents: [a, b],
    goals: {
      s1: { id: 'g1', revision: 4, phase: 'active', activation: 'armed' },
      s2: { id: 'g2', revision: 2, phase: 'paused', activation: 'disarmed' },
    },
    jobs: { s1: [{ id: 'j1', status: 'running' }, { id: 'j2', status: 'done' }] },
    unownedJobs: [{ id: 'j3', status: 'stopping' }],
  })
  const probe = createProbe(fake.registry)
  const live = probe.live()
  assert.equal(live.readable, true)
  assert.deepEqual(live.sessions, [
    { sessionId: 's1', running: true, lastTurn: 3 },
    { sessionId: 's2', running: false, lastTurn: 1 },
  ])
  // A paused goal is the person's pause, not this press's work.
  assert.deepEqual(live.goals, [{ sessionId: 's1', goalId: 'g1', revision: 4 }])
  assert.deepEqual(live.jobs.map((job) => job.id), ['j3', 'j1'])
})

test('live() reads the agent inside a listed row, not the row own status', () => {
  const agent = { id: 's1', status: 'idle', phase: { lastTurn: 7 } }
  const probe = createProbe(registry({
    agents: {
      list: () => [{ id: 's1', status: 'running', agent }],
      get: () => agent,
    },
  }))
  assert.equal(listRunning(registry({ agents: { list: () => [{ id: 's1', status: 'running', agent }] } })).length, 0)
  assert.deepEqual(probe.live().sessions, [{ sessionId: 's1', running: false, lastTurn: 7 }])
})

test('live() reports an unreadable registry instead of claiming there is nothing to stop', () => {
  const probe = createProbe(registry({ agents: { list: () => { throw new Error('disposed') } } }))
  const live = probe.live()
  assert.equal(live.readable, false)
  assert.deepEqual(live.sessions, [])
  assert.deepEqual(live.goals, [])
})

test('stop() pauses goals with the real agent object and returns the bumped revision', async () => {
  const a = { id: 's1', status: 'running', phase: { lastTurn: 2 } }
  const fake = harness({
    agents: [a],
    goals: { s1: { id: 'g1', revision: 7, phase: 'active', activation: 'armed' } },
    jobs: { s1: [{ id: 'j1', status: 'running' }] },
  })
  const probe = createProbe(fake.registry, { graceMs: 200 })
  const live = probe.live()
  const stopped = await probe.stop(live)
  assert.deepEqual(fake.calls.filter((call) => call[0] === 'goals.pause'), [['goals.pause', 's1', 'g1', 7]])
  assert.deepEqual(stopped.pausedGoals, [{ sessionId: 's1', goalId: 'g1', pausedRevision: 8 }])
  assert.deepEqual(stopped.canceled, ['s1'])
  assert.deepEqual(stopped.killedJobs, [{ id: 'j1', owner: 's1' }])
  // Goal first, then the turn, then the job: a round must not be queued behind the press.
  const order = fake.calls.map((call) => call[0]).filter((name) => ['goals.pause', 'cancel', 'jobs.kill'].includes(name))
  assert.deepEqual(order, ['goals.pause', 'cancel', 'jobs.kill'])
  assert.equal(a.status, 'idle')
  assert.deepEqual(stopped.stillRunning, [])
  assert.deepEqual(stopped.sessions, [{ sessionId: 's1', lastTurn: 3 }])
})

test('stop() waits for a stubborn turn and reports it instead of claiming it stopped', async () => {
  const a = { id: 's1', status: 'running', phase: { lastTurn: 1 } }
  const fake = harness({ agents: [a], keepRunning: true })
  const probe = createProbe(fake.registry, { graceMs: 150 })
  const stopped = await probe.stop(probe.live())
  assert.deepEqual(stopped.stillRunning, ['s1'])
  assert.match(stopped.unknown[0], /still running/u)
})

test('stop() skips a goal whose agent disappeared and reports it', async () => {
  const fake = harness({ agents: [] })
  const probe = createProbe(fake.registry)
  const stopped = await probe.stop({
    sessions: [],
    goals: [{ sessionId: 'gone', goalId: 'g1', revision: 1 }],
    jobs: [],
  })
  assert.deepEqual(stopped.pausedGoals, [])
  assert.equal(stopped.goalErrors.length, 0)
})

test('restoreSession() mounts an idle session and does not invent a turn', async () => {
  const fake = harness({ agents: [] })
  const probe = createProbe(fake.registry)
  const outcome = await probe.restoreSession({ sessionId: 's9', running: false }, { plan: { planId: 'p1' } })
  assert.deepEqual(outcome, { status: 'restored', detail: 'attached', continued: false })
  assert.deepEqual(fake.calls.filter((call) => call[0] === 'resolveAgent'), [['resolveAgent', 's9']])
  assert.equal(fake.calls.some((call) => call[0] === 'prompt'), false)
})

test('restoreSession() continues a stopped turn with one visible, idempotent message', async () => {
  const agent = { id: 's1', status: 'idle', phase: { lastTurn: 4 } }
  const fake = harness({ agents: [agent] })
  const probe = createProbe(fake.registry, { continueText: '接着来' })
  const outcome = await probe.restoreSession({ sessionId: 's1', running: true, lastTurn: 4 }, { plan: { planId: 'pause-1' } })
  assert.equal(outcome.continued, true)
  const prompt = fake.calls.find((call) => call[0] === 'prompt')
  assert.deepEqual(prompt, ['prompt', 's1', 'pause-1:continue:s1:1', 'queue', '接着来', true, true])
  assert.equal(agent.status, 'running')
})

test('a pre-epoch plan keeps its legacy continuation id through an upgrade', async () => {
  const agent = { id: 's1', status: 'idle', phase: { lastTurn: 4 } }
  const fake = harness({ agents: [agent] })
  const probe = createProbe(fake.registry)
  const outcome = await probe.restoreSession({ sessionId: 's1', intent: 'continue', epoch: 0, running: true, lastTurn: 4 }, { plan: { planId: 'pause-1' } })
  assert.equal(outcome.continued, true)
  const prompt = fake.calls.find((call) => call[0] === 'prompt')
  // The id the old version may already have admitted, not a new suffixed operation.
  assert.equal(prompt[2], 'pause-1:continue:s1')
})

test('restoreSession() does not resend after a turn already advanced', async () => {
  const fake = harness({ agents: [{ id: 's1', status: 'idle', phase: { lastTurn: 9 } }] })
  const probe = createProbe(fake.registry)
  const outcome = await probe.restoreSession({ sessionId: 's1', running: true, lastTurn: 4 }, { plan: { planId: 'p1' } })
  // A turn number past the baseline can mean the continuation ran, or that a turn was interrupted
  // after admission. Neither allows a resend, and neither is a clean skip: it needs a look.
  assert.equal(outcome.status, 'attention')
  assert.match(outcome.detail, /not sent again/u)
  assert.equal(fake.calls.some((call) => call[0] === 'prompt'), false)
})

test('restoreSession() keeps a session that failed to mount retryable', async () => {
  const failing = registry({
    agents: { get: () => undefined, list: () => [] },
    sessionController: { resolveAgent: async () => { throw new Error('REMOTE_CONFLICT') } },
  })
  const probe = createProbe(failing)
  const outcome = await probe.restoreSession({ sessionId: 's1', running: false }, { plan: { planId: 'p1' } })
  assert.equal(outcome.status, 'failed')
  assert.match(outcome.detail, /REMOTE_CONFLICT/u)
})

test('restoreSession() reports a subagent row as skipped, not as work a person must fix', async () => {
  const failing = registry({
    agents: { get: () => undefined, list: () => [] },
    sessionController: { resolveAgent: async () => { throw new Error('session "s1" is owned by subagent routing') } },
  })
  const probe = createProbe(failing)
  const outcome = await probe.restoreSession({ sessionId: 's1', running: false }, { plan: { planId: 'p1' } })
  assert.equal(outcome.status, 'skipped')
  assert.match(outcome.detail, /parent restores it/u)
})

test('a continuation that already moved the turn is not sent twice', async () => {
  const agent = { id: 's1', status: 'idle', phase: { lastTurn: 4 } }
  const fake = harness({ agents: [agent] })
  const probe = createProbe(fake.registry)
  await probe.restoreSession({ sessionId: 's1', running: true, lastTurn: 4 }, { plan: { planId: 'p1' } })
  await probe.restoreSession({ sessionId: 's1', running: true, lastTurn: 4 }, { plan: { planId: 'p1' } })
  const ids = fake.calls.filter((call) => call[0] === 'prompt').map((call) => call[2])
  assert.deepEqual(ids, ['p1:continue:s1:1'])
  // Its request id is still derived only from the plan and session, so a retry before any turn
  // starts asks the Harness to dedupe the very same message instead of adding a second one.
  const third = await probe.restoreSession({ sessionId: 's1', running: false, lastTurn: 5 }, { plan: { planId: 'p1' } })
  assert.equal(third.status, 'restored')
})

test('restoreGoal() arms the paused goal with its exact revision and refuses a changed goal', async () => {
  const agent = { id: 's1', status: 'idle', phase: { lastTurn: 2 } }
  const fake = harness({
    agents: [agent],
    goals: { s1: { id: 'g1', revision: 8, phase: 'paused', activation: 'disarmed' } },
  })
  const probe = createProbe(fake.registry)
  assert.deepEqual(await probe.restoreGoal({ sessionId: 's1', goalId: 'g1', pausedRevision: 8 }), { status: 'restored', detail: 'armed', revision: 9 })
  assert.deepEqual(fake.calls.filter((call) => call[0] === 'goals.resume'), [['goals.resume', 's1', 'g1', 8]])

  // The person edited the goal after the pause: its revision moved, so this press must not revive it.
  const moved = harness({
    agents: [{ id: 's2', status: 'idle', phase: {} }],
    goals: { s2: { id: 'g2', revision: 12, phase: 'paused', activation: 'disarmed' } },
  })
  const second = createProbe(moved.registry)
  assert.equal((await second.restoreGoal({ sessionId: 's2', goalId: 'g2', pausedRevision: 8 })).status, 'skipped')
  assert.equal((await second.restoreGoal({ sessionId: 's2', goalId: 'g2', revision: 8 })).status, 'skipped')
  assert.equal(moved.calls.some((call) => call[0] === 'goals.resume'), false)
})

test('restoreSession() never continues a crash row, even when the turn was open', async () => {
  const agent = { id: 's1', status: 'idle', phase: { lastTurn: 3 } }
  const fake = harness({ agents: [agent] })
  const probe = createProbe(fake.registry)
  const outcome = await probe.restoreSession(
    { sessionId: 's1', running: true, intent: 'mount', epoch: 0, crash: true, lastTurn: 3 },
    { plan: { planId: 'crash-1' } },
  )
  assert.equal(outcome.continued, false)
  assert.equal(fake.calls.some((call) => call[0] === 'prompt'), false)
})

test('restoreSession() gives a new pause cycle a new request id', async () => {
  const fake = harness({ agents: [{ id: 's1', status: 'idle', phase: { lastTurn: 4 } }] })
  const probe = createProbe(fake.registry)
  await probe.restoreSession({ sessionId: 's1', running: true, intent: 'continue', epoch: 1, lastTurn: 4 }, { plan: { planId: 'p1' } })
  const agent = fake.live.get('s1')
  agent.status = 'idle'
  agent.phase.lastTurn = 5
  await probe.restoreSession({ sessionId: 's1', running: true, intent: 'continue', epoch: 2, lastTurn: 5 }, { plan: { planId: 'p1' } })
  const ids = fake.calls.filter((call) => call[0] === 'prompt').map((call) => call[2])
  assert.deepEqual(ids, ['p1:continue:s1:1', 'p1:continue:s1:2'])
})

test('restoreGoal() re-arms an active goal only when this plan is what disarmed it', async () => {
  const fake = harness({
    agents: [{ id: 's1', status: 'idle' }],
    goals: { s1: { id: 'g1', revision: 6, phase: 'active', activation: 'disarmed' } },
  })
  const probe = createProbe(fake.registry)
  const refused = await probe.restoreGoal({ sessionId: 's1', goalId: 'g1', pausedRevision: 6 })
  assert.equal(refused.status, 'skipped')
  assert.equal(fake.calls.some((call) => call[0] === 'goals.resume'), false)

  const own = await probe.restoreGoal({ sessionId: 's1', goalId: 'g1', pausedRevision: 6, armedRevision: 6 })
  assert.equal(own.status, 'restored')
  assert.equal(own.revision, 7)
  assert.deepEqual(fake.calls.filter((call) => call[0] === 'goals.resume'), [['goals.resume', 's1', 'g1', 6]])
})

test('restoreGoal() leaves an active goal alone and reports a finished one', async () => {
  const fake = harness({
    agents: [{ id: 's1', status: 'idle' }, { id: 's2', status: 'idle' }],
    goals: {
      s1: { id: 'g1', revision: 3, phase: 'active', activation: 'armed' },
      s2: { id: 'g2', revision: 5, phase: 'complete', activation: 'disarmed' },
    },
  })
  const probe = createProbe(fake.registry)
  assert.equal((await probe.restoreGoal({ sessionId: 's1', goalId: 'g1', revision: 3 })).status, 'skipped')
  assert.equal((await probe.restoreGoal({ sessionId: 's2', goalId: 'g2', pausedRevision: 4 })).status, 'skipped')
  assert.equal(fake.calls.some((call) => call[0] === 'goals.resume'), false)
})

test('restoreGoal() mounts the session first, then re-arms its goal', async () => {
  const fake = harness({
    agents: [],
    goals: { s1: { id: 'g1', revision: 2, phase: 'paused', activation: 'disarmed' } },
  })
  const mounted = { id: 's1', status: 'idle', phase: { lastTurn: 1 } }
  fake.services.agents.get = () => undefined
  const realResolve = fake.services.sessionController.resolveAgent
  fake.services.sessionController.resolveAgent = async (sessionId) => {
    await realResolve(sessionId)
    fake.live.set(sessionId, mounted)
    return mounted
  }
  const probe = createProbe(fake.registry)
  assert.equal((await probe.restoreGoal({ sessionId: 's1', goalId: 'g1', pausedRevision: 2 })).status, 'restored')
  assert.deepEqual(fake.calls.filter((call) => call[0] === 'resolveAgent'), [['resolveAgent', 's1']])
})

test('crashPlan() mounts what a dead process was running but never continues it', () => {
  const probe = createProbe(registry({}))
  const plan = probe.crashPlan({ sessions: [{ sessionId: 's1' }, { sessionId: 's2' }], at: 1700000000000 }, { planId: 'crash-1' })
  assert.equal(plan.source, 'crash')
  assert.equal(plan.planId, 'crash-1')
  assert.deepEqual(plan.sessions, [
    { sessionId: 's1', intent: 'mount', epoch: 0, running: false, lastTurn: null, crash: true },
    { sessionId: 's2', intent: 'mount', epoch: 0, running: false, lastTurn: null, crash: true },
  ])
  assert.deepEqual(plan.goals, [])
  assert.deepEqual(plan.attention, [{ kind: 'session', id: '', detail: 'crashed before it could be paused: sessions are reattached, their turns are not re-sent' }])
  assert.equal(plan.crashes, 2)
  assert.equal(probe.crashPlan(null), null)
  assert.equal(probe.crashPlan({ sessions: [] }), null)
})

test('crashPlan() carries armed goals over without faking a pause', () => {
  const probe = createProbe(registry({}))
  const plan = probe.crashPlan(
    {
      sessions: [{ sessionId: 's1' }],
      goals: [{ sessionId: 's1', goalId: 'g1', revision: 4 }, { sessionId: 's2', goalId: 'g2', revision: 9 }],
      at: 1700000000000,
    },
    { planId: 'crash-2' },
  )
  assert.deepEqual(plan.goals, [
    { sessionId: 's1', goalId: 'g1', revision: 4, armedRevision: 4 },
    { sessionId: 's2', goalId: 'g2', revision: 9, armedRevision: 9 },
  ])
  // The goal row survives even when its session was not running between rounds.
  assert.equal(plan.sessions.length, 1)
  assert.equal(plan.crashes, 1)

  // Goals alone are still work worth restoring: no plan would lose the next round silently.
  const goalsOnly = probe.crashPlan({ sessions: [], goals: [{ sessionId: 's2', goalId: 'g2', revision: 9 }] }, { planId: 'crash-3' })
  assert.equal(goalsOnly !== null, true)
  assert.deepEqual(goalsOnly.sessions, [])
  assert.deepEqual(goalsOnly.goals, [{ sessionId: 's2', goalId: 'g2', revision: 9, armedRevision: 9 }])
  assert.deepEqual(goalsOnly.attention, [])
})

test('crashPlan() drops goal rows that cannot be proven instead of guessing a revision', () => {
  const probe = createProbe(registry({}))
  const plan = probe.crashPlan(
    {
      sessions: [{ sessionId: 's1' }],
      goals: [
        { sessionId: 's1', goalId: 'g1', revision: 4 },
        { sessionId: 's1', goalId: 'g2' },
        { sessionId: '', goalId: 'g3', revision: 4 },
      ],
    },
    { planId: 'crash-4' },
  )
  assert.deepEqual(plan.goals, [{ sessionId: 's1', goalId: 'g1', revision: 4, armedRevision: 4 }])
})

test('listResidue() records the open turns and the armed goals, and nothing else', () => {
  const running = { id: 'a', status: 'running', phase: { lastTurn: 1 } }
  const idle = { id: 'b', status: 'idle', phase: { lastTurn: 2 } }
  const fake = harness({
    agents: [running, idle],
    goals: {
      a: { id: 'ga', revision: 3, phase: 'active', activation: 'armed' },
      b: { id: 'gb', revision: 8, phase: 'active', activation: 'armed' },
    },
  })
  assert.deepEqual(listResidue(fake.registry), {
    sessions: ['a'],
    goals: [
      { sessionId: 'a', goalId: 'ga', revision: 3 },
      { sessionId: 'b', goalId: 'gb', revision: 8 },
    ],
  })
  assert.deepEqual(listResidue(registry({})), { sessions: [], goals: [] })
})

test('listResidue() skips paused, disarmed and unreadable goals', () => {
  const paused = { id: 'a', status: 'idle', phase: { lastTurn: 0 } }
  const disarmed = { id: 'b', status: 'idle', phase: { lastTurn: 0 } }
  const unreadable = { id: 'c', status: 'idle', phase: { lastTurn: 0 } }
  const fake = harness({
    agents: [paused, disarmed, unreadable],
    goals: {
      a: { id: 'ga', revision: 1, phase: 'paused', activation: 'disarmed' },
      b: { id: 'gb', revision: 2, phase: 'active', activation: 'disarmed' },
      c: { id: 'gc', revision: 3, phase: 'active', activation: 'armed' },
    },
  })
  const original = fake.services.goals.get
  fake.services.goals.get = (agent) => {
    if (agent?.id === 'c') throw new Error('GOAL_READ_FAILED')
    return original(agent)
  }
  assert.deepEqual(listResidue(fake.registry), { sessions: [], goals: [] })
})

test('listRunning() names exactly the sessions whose turn is open', () => {
  const fake = harness({ agents: [{ id: 'a', status: 'running' }, { id: 'b', status: 'idle' }] })
  assert.deepEqual(listRunning(fake.registry), ['a'])
  assert.deepEqual(listRunning(registry({})), [])
})

test('restoreSchedule() is honest about having nothing to restore', async () => {
  const probe = createProbe(registry({}))
  assert.deepEqual(await probe.restoreSchedule(), { status: 'skipped', detail: 'no schedules' })
})

test('restoreGoal() re-arms an active goal that its restore intent owns after a restart', async () => {
  const agent = { id: 's1', status: 'idle', phase: { lastTurn: 0 } }
  const fake = harness({
    agents: [agent],
    goals: { s1: { id: 'g1', revision: 5, phase: 'active', activation: 'disarmed' } },
  })
  const probe = createProbe(fake.registry)
  const outcome = await probe.restoreGoal(
    { sessionId: 's1', goalId: 'g1', revision: 4, armedRevision: null, pendingRestore: { revision: 4, expect: 5, at: 1 } },
    { plan: { planId: 'pause-1' } },
  )
  assert.equal(outcome.status, 'restored')
  assert.equal(outcome.revision, 6)
  assert.deepEqual(fake.calls.filter((call) => call[0] === 'goals.resume'), [['goals.resume', 's1', 'g1', 5]])
})

test('restoreGoal() retries a goal whose state cannot be read instead of recording a skip', async () => {
  const agent = { id: 's1', status: 'idle', phase: { lastTurn: 0 } }
  const fake = harness({ agents: [agent], goals: { s1: { id: 'g1', revision: 4, phase: 'paused', activation: 'disarmed' } } })
  const original = fake.services.goals.get
  let reads = 0
  fake.services.goals.get = (target) => {
    reads += 1
    if (reads === 1) throw new Error('GOAL_READ_FAILED')
    return original(target)
  }
  const probe = createProbe(fake.registry)
  const outcome = await probe.restoreGoal({ sessionId: 's1', goalId: 'g1', revision: 4 }, { plan: { planId: 'pause-1' } })
  assert.equal(outcome.status, 'failed')
  assert.match(outcome.detail, /unreadable/u)
  assert.equal(fake.calls.some((call) => call[0] === 'goals.resume'), false)
})

test('a reload during a cold mount stops the old probe before it reports or prompts', async () => {
  const fake = harness({ agents: [] })
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const original = fake.services.sessionController.resolveAgent
  fake.services.sessionController.resolveAgent = async (sessionId) => {
    await gate
    return original(sessionId)
  }
  let current = true
  const probe = createProbe(fake.registry, { isCurrent: () => current })
  const pending = probe.restoreSession({ sessionId: 's9', intent: 'continue', epoch: 0, running: true, lastTurn: 0 }, { plan: { planId: 'pause-1' } })
  current = false
  release()
  const outcome = await pending
  assert.deepEqual(outcome, { status: 'reloaded' })
  assert.equal(fake.calls.some((call) => call[0] === 'prompt'), false)
})

test('restoreGoal() refuses an active goal edited after this operation produced it', async () => {
  const fake = harness({
    agents: [{ id: 's1', status: 'idle' }],
    goals: { s1: { id: 'g1', revision: 10, phase: 'active', activation: 'disarmed' } },
  })
  const probe = createProbe(fake.registry)
  const outcome = await probe.restoreGoal(
    { sessionId: 's1', goalId: 'g1', revision: 8, pendingRestore: { revision: 8, expect: 9, at: 1 } },
    { plan: { planId: 'pause-1' } },
  )
  assert.equal(outcome.status, 'attention')
  assert.equal(fake.calls.some((call) => call[0] === 'goals.resume'), false)
})

test('restoreGoal() accepts exactly the revision its own resume produced', async () => {
  const fake = harness({
    agents: [{ id: 's1', status: 'idle' }],
    goals: { s1: { id: 'g1', revision: 9, phase: 'active', activation: 'disarmed' } },
  })
  const probe = createProbe(fake.registry)
  const outcome = await probe.restoreGoal(
    { sessionId: 's1', goalId: 'g1', revision: 8, pendingRestore: { revision: 8, expect: 9, at: 1 } },
    { plan: { planId: 'pause-1' } },
  )
  assert.equal(outcome.status, 'restored')
  assert.equal(outcome.revision, 10)
  assert.deepEqual(fake.calls.filter((call) => call[0] === 'goals.resume'), [['goals.resume', 's1', 'g1', 9]])
})

test('prepareGoal() verifies the paused state before any intent is written', async () => {
  const fake = harness({
    agents: [{ id: 's1', status: 'idle' }, { id: 's2', status: 'idle' }],
    goals: {
      s1: { id: 'g1', revision: 8, phase: 'paused', activation: 'disarmed' },
      s2: { id: 'g2', revision: 9, phase: 'paused', activation: 'disarmed' },
    },
  })
  const probe = createProbe(fake.registry)
  assert.deepEqual(await probe.prepareGoal({ sessionId: 's1', goalId: 'g1', revision: 8 }), { status: 'ready', revision: 8 })
  assert.equal((await probe.prepareGoal({ sessionId: 's2', goalId: 'g2', revision: 8 })).status, 'skipped')
  assert.equal(fake.calls.some((call) => call[0] === 'goals.resume'), false)
})

test('restoreGoal() refuses a paused goal edited after its restore intent was written', async () => {
  const fake = harness({
    agents: [{ id: 's1', status: 'idle' }],
    goals: { s1: { id: 'g1', revision: 9, phase: 'paused', activation: 'disarmed' } },
  })
  const probe = createProbe(fake.registry)
  const outcome = await probe.restoreGoal(
    { sessionId: 's1', goalId: 'g1', revision: 8, pendingRestore: { revision: 8, expect: 9, at: 1 } },
    { plan: { planId: 'pause-1' } },
  )
  assert.equal(outcome.status, 'attention')
  assert.equal(fake.calls.some((call) => call[0] === 'goals.resume'), false)
})

test('stop() cancels every open turn in one round trip', async () => {
  const agents = new Map([
    ['s1', { id: 's1', status: 'running', phase: { lastTurn: 0 } }],
    ['s2', { id: 's2', status: 'running', phase: { lastTurn: 0 } }],
  ])
  let inFlight = 0
  let peak = 0
  const services = {
    agents: { get: (id) => agents.get(id), list: () => [...agents.values()] },
    jobs: { list: () => [], kill: () => {} },
    sessionController: {
      cancel: async ({ sessionId }) => {
        inFlight += 1
        peak = Math.max(peak, inFlight)
        await new Promise((resolve) => setTimeout(resolve, 60))
        inFlight -= 1
        const agent = agents.get(sessionId)
        agent.status = 'idle'
        agent.phase.lastTurn += 1
      },
    },
  }
  const probe = createProbe(registry(services), { graceMs: 500 })
  const stopped = await probe.stop(probe.live())
  assert.equal(peak, 2)
  assert.deepEqual([...stopped.canceled].sort(), ['s1', 's2'])
  assert.deepEqual(stopped.stillRunning, [])
})

test('stop() bounds a cancel that never answers instead of pinning the press forever', async () => {
  const agent = { id: 's1', status: 'running', phase: { lastTurn: 0 } }
  const services = {
    agents: { get: () => agent, list: () => [agent] },
    jobs: { list: () => [], kill: () => {} },
    sessionController: { cancel: () => new Promise(() => {}) },
  }
  const probe = createProbe(registry(services), { graceMs: 200, cancelMs: 40 })
  const started = Date.now()
  const stopped = await probe.stop(probe.live())
  assert.ok(Date.now() - started < 1000)
  assert.deepEqual(stopped.canceled, [])
  assert.match(stopped.unknown[0], /timed out/u)
  assert.deepEqual(stopped.stillRunning, ['s1'])
})

test('stop() stops touching live work once a reload owns the plan', async () => {
  const agents = new Map([
    ['s1', { id: 's1', status: 'running', phase: { lastTurn: 0 } }],
    ['s2', { id: 's2', status: 'idle', phase: { lastTurn: 0 } }],
  ])
  const canceled = []
  let current = true
  const services = {
    agents: { get: (id) => agents.get(id), list: () => [...agents.values()] },
    jobs: { list: () => [], kill: () => { if (current === false) throw new Error('kill after reload') } },
    sessionController: {
      cancel: async ({ sessionId }) => {
        canceled.push(sessionId)
        const agent = agents.get(sessionId)
        agent.status = 'idle'
        agent.phase.lastTurn += 1
        // The first cancel is in flight when the plugin reloads and a new instance takes the plan.
        current = false
        // New work the next instance is already running: cancelling it would be a pause nobody asked
        // for in this process, so it must stay untouched.
        agents.get('s2').status = 'running'
      },
    },
  }
  const probe = createProbe(registry(services), { graceMs: 300, isCurrent: () => current })
  const stopped = await probe.stop(probe.live())
  assert.equal(stopped.reloaded, true)
  assert.deepEqual(canceled, ['s1'])
  assert.deepEqual(stopped.sessions, [])
  assert.equal(agents.get('s2').status, 'running')
})

test('stop() reports a missing cancel or kill service instead of claiming success', async () => {
  const agent = { id: 's1', status: 'running', phase: { lastTurn: 0 } }
  const services = { agents: { get: () => agent, list: () => [agent] } }
  const probe = createProbe(registry(services), { graceMs: 100 })
  const stopped = await probe.stop({
    sessions: [{ sessionId: 's1', running: true }],
    goals: [],
    jobs: [{ id: 'j1', owner: null }],
  })
  assert.deepEqual(stopped.canceled, [])
  assert.deepEqual(stopped.killedJobs, [])
  assert.match(stopped.unknown[0], /cancel unavailable/u)
  assert.match(stopped.jobErrors[0], /job service unavailable/u)
})

test('stop() cancels a turn that started after the capture and returns it as discovered', async () => {
  const agents = new Map([
    ['s1', { id: 's1', status: 'running', phase: { lastTurn: 0 } }],
    ['s2', { id: 's2', status: 'idle', phase: { lastTurn: 0 } }],
  ])
  const services = {
    agents: { get: (id) => agents.get(id), list: () => [...agents.values()] },
    jobs: { list: () => [], kill: () => {} },
    sessionController: {
      cancel: async ({ sessionId }) => {
        const agent = agents.get(sessionId)
        agent.status = 'idle'
        agent.phase.lastTurn += 1
        // A queued continuation starts the moment the first turn ends.
        if (sessionId === 's1') agents.get('s2').status = 'running'
      },
    },
  }
  const probe = createProbe(registry(services), { graceMs: 300 })
  const stopped = await probe.stop({
    sessions: [{ sessionId: 's1', running: true }],
    goals: [],
    jobs: [],
  })
  assert.deepEqual([...stopped.canceled].sort(), ['s1', 's2'])
  assert.deepEqual(stopped.discovered, [{ sessionId: 's2', lastTurn: 0 }])
  assert.equal(stopped.sessions.find((row) => row.sessionId === 's2').lastTurn, 1)
  assert.deepEqual(stopped.stillRunning, [])
})
