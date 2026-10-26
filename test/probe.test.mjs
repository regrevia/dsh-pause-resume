import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createProbe, listRunning } from '../lib/probe.js'

function registry(services) {
  return { get: (key) => services[key] }
}

function row(sessionId, over = {}) {
  return { sessionId, running: false, agentAvailable: true, blank: false, ...over }
}

function goal(id, over = {}) {
  return { id, revision: 1, phase: 'active', activation: 'armed', objective: 'work', ...over }
}

/** A judge that answers with the session listing and records every mutating call it receives. */
function fake(services = {}) {
  const calls = []
  const base = {
    sessionController: {
      list: async () => ({ items: services.rows ?? [] }),
      cancel: (request) => {
        calls.push(['cancel', request.sessionId])
        // A real cancel ends the turn; a stubborn turn is the case that keeps reporting running.
        if (services.keepRunning !== true) {
          const target = (services.rows ?? []).find((entry) => entry.sessionId === request.sessionId)
          if (target !== undefined) target.running = false
        }
      },
    },
    goals: {
      get: async (agent) => {
        calls.push(['goal.get', agent.id])
        if (services.goalError === true) throw new Error('agent is not live')
        const view = services.goals?.[agent.id]
        return view?.phase === undefined ? view : { ...view }
      },
      pause: (agent, ref) => calls.push(['goal.pause', agent.id, ref.id, ref.revision]),
      resume: (agent, ref) => calls.push(['goal.resume', agent.id, ref.id, ref.revision]),
    },
    jobs: {
      list: (caller) => {
        calls.push(['job.list', caller ?? null])
        return caller === undefined ? services.unowned ?? [] : services.jobs?.[caller] ?? []
      },
      kill: (id, caller) => calls.push(['job.kill', id, caller]),
    },
    agents: {
      ...(services.agentHandles === undefined
        ? {}
        : {
            list: () => {
              calls.push(['agent.list'])
              if (services.agentListError === true) throw new Error('registry disposed')
              return services.agentHandles.map((handle) => ({ agent: handle }))
            },
          }),
      get: (sessionId) => (services.live?.includes(sessionId) === true ? { id: sessionId } : undefined),
      resume: async (request) => {
        calls.push(['agent.resume', request.resumeSessionId])
        services.live?.push(request.resumeSessionId)
      },
    },
  }
  const merged = { ...base, ...services.override }
  return { probe: createProbe(registry(merged), services.heartbeat ?? { residue: null }), calls }
}

test('the listing is read through its items field', async () => {
  const { probe } = fake({ rows: [row('s1', { running: true }), row('s2'), { sessionId: 7 }] })
  const live = await probe.live()
  assert.deepEqual(live.sessions, [{ sessionId: 's1', running: true }])
})

test('an open tab without a running turn is not work', async () => {
  const { probe } = fake({ rows: [row('s1')] })
  const live = await probe.live()
  assert.deepEqual(live.sessions, [])
  assert.deepEqual(live.goals, [])
})

test('a goal is read by session id and counts as work while it is active', async () => {
  const { probe, calls } = fake({ rows: [row('s1')], goals: { s1: goal('g1') } })
  const live = await probe.live()
  assert.deepEqual(live.sessions, [{ sessionId: 's1', running: false }])
  assert.deepEqual(live.goals, [{ sessionId: 's1', goalId: 'g1', revision: 1 }])
  assert.deepEqual(calls.find((call) => call[0] === 'goal.get'), ['goal.get', 's1'])
})

test('a paused goal leaves its session alone and a dead agent is not an error', async () => {
  const paused = fake({ rows: [row('s1')], goals: { s1: goal('g1', { phase: 'paused' }) } })
  assert.deepEqual((await paused.probe.live()).goals, [])
  assert.deepEqual((await paused.probe.live()).sessions, [])

  const dead = fake({ rows: [row('s1')], goalError: true })
  assert.deepEqual((await dead.probe.live()).goals, [])
})

test('owned jobs are asked for per session and deduped across buckets', async () => {
  const shared = { id: 'job-1', status: 'running', owner: 's1', label: 'build' }
  const { probe, calls } = fake({
    rows: [row('s1', { running: true })],
    unowned: [{ id: 'job-0', status: 'running' }],
    jobs: { s1: [shared, { id: 'job-2', status: 'completed', owner: 's1' }] },
  })
  const live = await probe.live()
  assert.deepEqual(live.jobs, [
    { id: 'job-0', label: '', owner: undefined },
    { id: 'job-1', label: 'build', owner: 's1' },
  ])
  assert.ok(calls.some((call) => call[0] === 'job.list' && call[1] === 's1'))
})

test('stop cancels running turns and pauses goals before it waits', async () => {
  const rows = [row('s1', { running: true }), row('s2')]
  const { probe, calls } = fake({ rows, goals: { s2: goal('g2', { revision: 4 }) } })
  const current = {
    sessions: [{ sessionId: 's1', running: true }, { sessionId: 's2', running: false }],
    goals: [{ sessionId: 's2', goalId: 'g2', revision: 4 }],
    jobs: [{ id: 'job-1', owner: 's1' }],
    schedules: [],
    terminals: [],
  }
  const outcome = await probe.stop(current, { graceMs: 1 })
  assert.deepEqual(outcome, { canceled: ['s1'], unknown: [] })
  assert.deepEqual(calls.filter((call) => call[0] === 'goal.pause'), [['goal.pause', 's2', 'g2', 4]])
  assert.deepEqual(calls.filter((call) => call[0] === 'cancel'), [['cancel', 's1']])
  assert.deepEqual(calls.filter((call) => call[0] === 'job.kill'), [['job.kill', 'job-1', 's1']])
})

test('stop reports a turn that is still running when the grace runs out', async () => {
  // cancel is a request: a turn that keeps reporting running is not claimed as stopped.
  const rows = [row('s1', { running: true })]
  const { probe } = fake({ rows, keepRunning: true })
  const outcome = await probe.stop({ sessions: [{ sessionId: 's1', running: true }], goals: [], jobs: [] }, { graceMs: 120 })
  assert.deepEqual(outcome.canceled, ['s1'])
  assert.deepEqual(outcome.unknown, ['session s1: still running'])
})

test('restore skips a session that is still live instead of starting a second driver', async () => {
  const { probe, calls } = fake({ live: ['s1'] })
  assert.equal(await probe.restoreSession({ sessionId: 's1' }), 'skipped')
  assert.deepEqual(calls.filter((call) => call[0] === 'agent.resume'), [])
})

test('restore resumes a closed session and rearms its disarmed goal', async () => {
  const { probe, calls } = fake({ live: [], goals: { s1: goal('g1', { activation: 'idle' }) } })
  assert.equal(await probe.restoreSession({ sessionId: 's1' }), 'restored')
  assert.deepEqual(calls.filter((call) => call[0] === 'agent.resume'), [['agent.resume', 's1']])
  assert.deepEqual(calls.filter((call) => call[0] === 'goal.resume'), [['goal.resume', 's1', 'g1', 1]])
})

test('a paused goal is resumed only at the revision the person left behind', async () => {
  const same = fake({ goals: { s1: goal('g1', { phase: 'paused', revision: 3 }) } })
  assert.equal(await same.probe.restoreGoal({ sessionId: 's1', goalId: 'g1', revision: 3 }), 'restored')

  const moved = fake({ goals: { s1: goal('g1', { phase: 'paused', revision: 4 }) } })
  assert.equal(await moved.probe.restoreGoal({ sessionId: 's1', goalId: 'g1', revision: 3 }), 'skipped')
  assert.deepEqual(moved.calls.filter((call) => call[0] === 'goal.resume'), [])
})

test('crash residue becomes work only for sessions that still exist', async () => {
  const heartbeat = { residue: { sessions: [{ sessionId: 's1' }, { sessionId: 'gone' }] } }
  const { probe } = fake({ rows: [row('s1')], heartbeat })
  const plan = await probe.crashPlan()
  assert.deepEqual(plan.sessions, [{ sessionId: 's1', running: true }])
  assert.equal(plan.source, 'crash')

  const empty = fake({ rows: [], heartbeat })
  assert.equal(await empty.probe.crashPlan(), null)
})

test('live agents are read without walking every session on disk', async () => {
  const { probe, calls } = fake({
    agentHandles: [
      { id: 'a1', status: 'running' },
      { id: 'a2', status: 'idle' },
    ],
    goals: { a1: goal('g1') },
  })
  const live = await probe.live()
  assert.deepEqual(live.sessions, [{ sessionId: 'a1', running: true }])
  assert.deepEqual(live.goals, [{ sessionId: 'a1', goalId: 'g1', revision: 1 }])
  assert.equal(calls.some(([name]) => name === 'goal.get' && true), true)
  // a2 is attached but has neither a turn nor a goal: an open tab is not work.
  assert.equal(calls.some(([name, id]) => name === 'goal.get' && id === 'a2'), true)
})

test('an unreadable agent registry falls back to the listing instead of reporting no work', async () => {
  const { probe, calls } = fake({
    rows: [row('s1', { running: true })],
    agentHandles: [{ id: 's1', status: 'running' }],
    agentListError: true,
  })
  const live = await probe.live()
  assert.deepEqual(live.sessions, [{ sessionId: 's1', running: true }])
  assert.equal(calls.some(([name]) => name === 'agent.list'), true)
  assert.equal(calls.some(([name]) => name === 'goal.get'), true)

  const running = await listRunning(
    registry({
      agents: { list: () => { throw new Error('registry disposed') } },
      sessionController: { list: async () => ({ items: [row('s9', { running: true })] }) },
    }),
  )
  assert.deepEqual(running, ['s9'])
})

test('the heartbeat asks live agents first', async () => {
  const running = await listRunning(
    registry({
      agents: { list: () => [{ id: 'a1', status: 'running' }, { id: 'a2', status: 'idle' }] },
      sessionController: { list: async () => assert.fail('the listing is not needed when agents answer') },
    }),
  )
  assert.deepEqual(running, ['a1'])
})
