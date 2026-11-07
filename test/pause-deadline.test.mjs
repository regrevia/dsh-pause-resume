import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createProbe } from '../lib/probe.js'

/**
 * Deadline and ownership regressions for the pause press.
 *
 * The probe is the component that owns the clock: `stop()` opens the wrap-up window, steers, shares
 * one deadline across every open turn, then disarms goals before the window and pauses them after it.
 * The engine only forwards its defaults (`wrapUpMs` 3000, `lib/engine.js:91`, `index.js:409`), so the
 * deadline rules are pinned here against the fake service shape the other probe tests use.
 *
 * Timing is measured on the real clock because the module has no clock injection: each window test
 * states a generous hard bound that a regression (one window per session, an unbounded wait) breaks,
 * while small windows keep the file's own runtime down.
 */

const WRAP_TEXT = '收尾：把已经写好的结论留下，然后结束这一轮。'
const USER_MESSAGE = { id: 'm-user', role: 'user', text: '继续把剩下的两章写完' }

function registry(services) {
  return { get: (key) => services[key] }
}

/**
 * The shipped Harness shape the probe depends on: `agents.get`/`agents.list` hand out the agent
 * object itself, the goal service refuses anything that is not that object, `disarm` does not bump
 * the revision (the later `pause` still has to match the capture), and `cancel` keeps the pending
 * inbox. Calls carry their own arrival time so a test can tell "after the window" from "before it".
 *
 * `removeMessage` exists only to prove it is never used: there is no removal call in this build, so
 * a pause that one day starts clearing queued messages would be caught here.
 */
function harness({
  agents = [],
  goals = {},
  keepRunning = false,
  finishAfterMs = null,
  promptThrows = false,
  onPrompt = null,
} = {}) {
  const calls = []
  // How each finished turn ended, shaped like the Harness turn-end records.
  const watchers = new Map()
  const watchTurn = (sessionId, onEvent) => {
    const set = watchers.get(sessionId) ?? new Set()
    set.add(onEvent)
    watchers.set(sessionId, set)
    return () => set.delete(onEvent)
  }
  const emit = (sessionId, event) => {
    for (const onEvent of watchers.get(sessionId) ?? []) onEvent(event)
  }
  const ends = new Map()
  const finish = (id) => {
    const agent = live.get(id)
    if (agent === undefined) return
    agent.status = 'idle'
    agent.phase.lastTurn = (agent.phase.lastTurn ?? 0) + 1
    const rows = ends.get(id) ?? []
    rows.push({ turn: agent.phase.lastTurn, kind: 'completed' })
    ends.set(id, rows)
    emit(id, { type: 'assistant/message', data: { turn: agent.phase.lastTurn, step: 0, message: { role: 'assistant', content: [{ type: 'text', text: '收尾完成' }] } } })
    emit(id, { type: 'turn/end', data: { turn: agent.phase.lastTurn, reason: { kind: 'completed' } } })
  }
  const delivered = []
  const removed = []
  const inbox = [{ ...USER_MESSAGE }]
  const live = new Map(agents.map((agent) => [agent.id, agent]))
  const views = new Map(Object.entries(goals))
  const services = {
    agents: {
      get: (id) => live.get(id),
      list: () => [...live.values()],
    },
    goals: {
      get: (agent) => (live.get(agent?.id) === agent ? { ...(views.get(agent.id) ?? {}) } : null),
      disarm: (agent) => {
        if (live.get(agent?.id) !== agent) throw new Error('GOAL_AGENT_NOT_LIVE')
        const view = views.get(agent.id)
        if (view === undefined) throw new Error('GOAL_NOT_FOUND')
        calls.push({ kind: 'goals.disarm', sessionId: agent.id, at: Date.now() })
        views.set(agent.id, { ...view, activation: 'disarmed' })
        return { ...views.get(agent.id) }
      },
      pause: (agent, ref) => {
        // The arrival is recorded before the service can refuse it: "the press tried exactly once"
        // must be provable even when the transition fails.
        calls.push({ kind: 'goals.pause', sessionId: agent?.id, goalId: ref?.id, revision: ref?.revision, at: Date.now() })
        if (live.get(agent?.id) !== agent) throw new Error('GOAL_AGENT_NOT_LIVE')
        const view = views.get(agent.id)
        if (view === undefined || view.id !== ref.id || view.revision !== ref.revision) throw new Error('GOAL_STALE_REVISION')
        if (view.phase !== 'active') throw new Error('GOAL_INVALID_TRANSITION')
        const next = { ...view, phase: 'paused', activation: 'disarmed', revision: view.revision + 1 }
        views.set(agent.id, next)
        return { ...next }
      },
    },
    jobs: {
      list: () => [],
      get: () => undefined,
      kill: () => {},
    },
    sessionLog: {
      readTurnEnds: async (id) => ends.get(id) ?? [],
    },
    sessionController: {
      cancel: async (request) => {
        calls.push({ kind: 'cancel', sessionId: request.sessionId, at: Date.now() })
        const agent = live.get(request.sessionId)
        // The official cancel stops the turn and keeps the pending inbox; a hung fake keeps the
        // status `running` on purpose so the press has to bound its own wait.
        if (keepRunning !== true) finish(request.sessionId)
      },
      resolveAgent: async (sessionId) => {
        const existing = live.get(sessionId)
        if (existing !== undefined) return existing
        const agent = { id: sessionId, status: 'idle', phase: { lastTurn: 0 }, mounted: true }
        live.set(sessionId, agent)
        return { agent }
      },
      removeMessage: async (request) => {
        removed.push(request)
        const at = inbox.findIndex((message) => message.id === request?.id)
        if (at >= 0) inbox.splice(at, 1)
      },
      prompt: async (request, signal) => {
        calls.push({
          kind: 'prompt',
          sessionId: request.sessionId,
          requestId: request.requestId,
          mode: request.mode,
          text: request.content?.[0]?.text,
          at: Date.now(),
        })
        if (promptThrows === true) throw new Error('PROMPT_REFUSED')
        signal?.throwIfAborted?.()
        const agent = live.get(request.sessionId)
        if (agent === undefined) throw new Error('SESSION_NOT_FOUND')
        agent.status = 'running'
        delivered.push({ sessionId: request.sessionId, requestId: request.requestId, text: request.content?.[0]?.text })
        if (typeof onPrompt === 'function') onPrompt(request, views)
        const wait = finishAfterMs !== null && typeof finishAfterMs === 'object' ? finishAfterMs[request.sessionId] : finishAfterMs
        if (Number.isFinite(wait) && wait >= 0) {
          setTimeout(() => {
            finish(request.sessionId)
          }, wait)
        }
        return { accepted: true }
      },
    },
  }
  return { services, registry: registry(services), calls, delivered, removed, inbox, live, views, watchTurn }
}

const running = (id, lastTurn = 3) => ({ id, status: 'running', phase: { lastTurn } })
const kinds = (fake, kind) => fake.calls.filter((call) => call.kind === kind)
const indexOf = (fake, kind) => fake.calls.findIndex((call) => call.kind === kind)

// Rule 1: an upstream turn that never ends cannot hold the press. The window runs out, the turn is
// still asked to stop, the outcome says so, and the total wait is the window plus exactly one
// cancel grace. Pins lib/probe.js:1124-1187 (window, one shared observe loop, `timedOut`) and
// lib/probe.js:1396-1451 (bounded settle wait, `stillRunning`).
test('a turn that never ends returns inside one window plus one cancel grace', async () => {
  const fake = harness({ agents: [running('s1', 2)], keepRunning: true })
  const probe = createProbe(fake.registry, { watchTurn: fake.watchTurn })
  const started = Date.now()
  const stopped = await probe.stop(probe.live(), { wrapUpMs: 3000, wrapUpText: WRAP_TEXT, planId: 'p-hang' })
  const elapsed = Date.now() - started

  assert.ok(elapsed >= 2900, `the press must really wait out its window (waited ${elapsed} ms)`)
  assert.ok(elapsed < 5500, `3000 ms window + one cancel grace must stay bounded (took ${elapsed} ms)`)
  assert.deepEqual(stopped.wrapUp, {
    windowMs: 3000,
    steered: ['s1'],
    completed: [],
    unclean: [],
    unverified: [],
    timedOut: ['s1'],
    interrupted: [],
    unavailable: null,
    retracted: [],
    // This fake agent exposes no inbox, so the press cannot take its own message back and says so.
    retractUnavailable: ['s1'],
  })
  assert.deepEqual(kinds(fake, 'prompt').map((call) => call.sessionId), ['s1'])
  // The press still ends the turn instead of delegating the whole outcome to the window.
  assert.deepEqual(stopped.canceled, ['s1'])
  assert.deepEqual(stopped.stillRunning, ['s1'])
  assert.ok(stopped.unknown.includes('session s1: still running'), 'an unstopped turn must be reported, never hidden')
  // It is recorded, not dropped: the row the restore owes is still produced.
  assert.deepEqual(stopped.sessions.map((session) => session.sessionId), ['s1'])
})

// Rule 1, second half: `wrapUpMs` 0 (and anything negative) is the pre-0.9.0 hard stop, not a tiny
// window. Pins lib/probe.js:1124 (`wrapWindow`) and the `wrapUp: null` face.
test('wrapUpMs 0 or negative disables the window and cancels at once', async () => {
  for (const wrapUpMs of [0, -50]) {
    const fake = harness({ agents: [running('s1')] })
    const probe = createProbe(fake.registry, { watchTurn: fake.watchTurn })
    const started = Date.now()
    const stopped = await probe.stop(probe.live(), { wrapUpMs, wrapUpText: WRAP_TEXT, planId: 'p-legacy' })
    assert.ok(Date.now() - started < 500, `wrapUpMs ${wrapUpMs} must not open a window`)
    assert.equal(stopped.wrapUp, null)
    assert.deepEqual(kinds(fake, 'prompt'), [])
    assert.deepEqual(stopped.canceled, ['s1'])
    assert.deepEqual(stopped.stillRunning, [])
  }
})

// Rule 2: the window is one shared deadline, not one per session. Three turns that all ignore the
// steer must cost the press one window, not three. Pins lib/probe.js:1128 (`endsBy`) and
// lib/probe.js:1160-1187 (a single observe loop over every steered session).
test('three open turns share one window instead of paying it three times', async () => {
  const fake = harness({ agents: [running('a'), running('b'), running('c')], keepRunning: true })
  const probe = createProbe(fake.registry, { watchTurn: fake.watchTurn })
  const started = Date.now()
  const stopped = await probe.stop(probe.live(), { wrapUpMs: 3000, wrapUpText: WRAP_TEXT, planId: 'p-shared' })
  const elapsed = Date.now() - started

  assert.ok(elapsed >= 2900, `the shared window must really be waited (waited ${elapsed} ms)`)
  assert.ok(elapsed < 6000, `three sessions must cost one window, not three (took ${elapsed} ms)`)
  assert.deepEqual(stopped.wrapUp.steered.slice().sort(), ['a', 'b', 'c'])
  assert.deepEqual(stopped.wrapUp.completed, [])
  assert.deepEqual(stopped.wrapUp.timedOut.slice().sort(), ['a', 'b', 'c'])
  assert.deepEqual(kinds(fake, 'prompt').map((call) => call.sessionId).sort(), ['a', 'b', 'c'])
  // Every session is stopped and recorded individually, not collapsed into one report row.
  assert.deepEqual(stopped.canceled.slice().sort(), ['a', 'b', 'c'])
  assert.deepEqual(stopped.sessions.map((session) => session.sessionId).sort(), ['a', 'b', 'c'])
})

// Rule 3: ownership ordering. A disarmed goal keeps its revision, so the pause after the window
// must present exactly the revision captured before it. Pins lib/probe.js:1129-1149 (disarm before
// the window) and lib/probe.js:1189-1205 (pause after it, with the captured reference).
test('a goal is disarmed before the window and paused after it with the captured revision', async () => {
  const fake = harness({
    agents: [running('s1')],
    goals: { s1: { id: 'g1', revision: 5, phase: 'active', activation: 'armed' } },
    keepRunning: true,
  })
  const probe = createProbe(fake.registry, { watchTurn: fake.watchTurn, graceMs: 300 })
  const started = Date.now()
  const stopped = await probe.stop(probe.live(), { wrapUpMs: 200, wrapUpText: WRAP_TEXT, planId: 'p-goal' })

  const disarmAt = indexOf(fake, 'goals.disarm')
  const steerAt = indexOf(fake, 'prompt')
  const pauseAt = indexOf(fake, 'goals.pause')
  assert.ok(disarmAt >= 0 && steerAt >= 0 && pauseAt >= 0, 'disarm, steer and pause must all run')
  assert.ok(disarmAt < steerAt, 'the goal is disarmed before the steer, so the wrap-up cannot re-arm it')
  assert.ok(steerAt < pauseAt, 'the goal is paused after the steer window, not before it')

  const pause = kinds(fake, 'goals.pause')[0]
  assert.ok(pause.at - started >= 190, `pause must be a post-window step (${pause.at - started} ms after the press)`)
  assert.equal(pause.goalId, 'g1')
  assert.equal(pause.revision, 5, 'the captured revision, not a revision read after the window')
  assert.deepEqual(stopped.goalsDisarmed, [{ sessionId: 's1', goalId: 'g1' }])
  assert.deepEqual(stopped.pausedGoals, [{ sessionId: 's1', goalId: 'g1', pausedRevision: 6 }])
})

// Rule 3, failure half: a revision that moves during the window is a real rejection the person must
// see reported. It must not throw out of the press, must not be retried, and must leave the goal
// out of `pausedGoals` so a restore cannot claim it was settled. Pins lib/probe.js:1198-1205.
test('a goal revision that moves during the window is reported once, not retried or thrown', async () => {
  const fake = harness({
    agents: [running('s1')],
    goals: { s1: { id: 'g1', revision: 5, phase: 'active', activation: 'armed' } },
    keepRunning: true,
    // Someone re-armed or replaced the goal while the wrap-up window was open.
    onPrompt: (request, views) => {
      const view = views.get(request.sessionId)
      views.set(request.sessionId, { ...view, revision: 9 })
    },
  })
  const probe = createProbe(fake.registry, { watchTurn: fake.watchTurn, graceMs: 200 })
  let stopped
  await assert.doesNotReject(async () => {
    stopped = await probe.stop(probe.live(), { wrapUpMs: 120, wrapUpText: WRAP_TEXT, planId: 'p-stale' })
  })

  assert.deepEqual(kinds(fake, 'goals.pause').length, 1, 'a stale revision is not retried')
  assert.deepEqual(stopped.pausedGoals, [])
  assert.equal(stopped.goalErrors.length, 1)
  assert.match(stopped.goalErrors[0], /^goal g1: GOAL_STALE_REVISION$/)
  // The rejected goal never stops the rest of the press.
  assert.deepEqual(stopped.canceled, ['s1'])
  assert.deepEqual(stopped.wrapUp.timedOut, ['s1'])
})

// Rule 4, timed-out half. The task asks the press to remove only its own wrap-up steer and keep the
// person's message. This build has no removal/retract entry at all — the documented contract is that
// `cancel` keeps the pending inbox (`lib/probe.js:10`), and `stop()` never calls a message API. So
// what can be pinned is the observable truth: the person's message survives, and the plugin's own
// steer is still queued too. The gap is reported as a finding rather than patched into lib/.
test('a timed-out pause leaves every message alone, including its own steer', async () => {
  const fake = harness({ agents: [running('s1')], keepRunning: true })
  const probe = createProbe(fake.registry, { watchTurn: fake.watchTurn, graceMs: 150 })
  const stopped = await probe.stop(probe.live(), { wrapUpMs: 120, wrapUpText: WRAP_TEXT, planId: 'p-inbox' })

  assert.deepEqual(stopped.wrapUp.timedOut, ['s1'])
  assert.deepEqual(fake.inbox, [USER_MESSAGE], "the person's queued message is never cleared")
  assert.deepEqual(fake.delivered.map((message) => message.text), [WRAP_TEXT], 'exactly one steer, with the caller text')
  assert.equal(fake.removed.length, 0, 'no message-removal call is made; the steer stays queued as well')
})

// Rule 4, completed half: a wrap-up that ends its own turn inside the window must not touch
// messages either — no cancel, no removal. Pins lib/probe.js:1158-1187 and 1256-1258.
test('a wrap-up that lands on its own changes no message at all', async () => {
  const fake = harness({ agents: [running('s1')], finishAfterMs: 20 })
  const probe = createProbe(fake.registry, { watchTurn: fake.watchTurn })
  const stopped = await probe.stop(probe.live(), { wrapUpMs: 250, wrapUpText: WRAP_TEXT, planId: 'p-done' })

  assert.deepEqual(stopped.wrapUp.completed, ['s1'])
  assert.deepEqual(stopped.wrapUp.timedOut, [])
  assert.deepEqual(kinds(fake, 'cancel'), [], 'a turn that ended itself is not cancelled again')
  assert.deepEqual(fake.inbox, [USER_MESSAGE])
  assert.deepEqual(fake.delivered.map((message) => message.text), [WRAP_TEXT])
  assert.equal(fake.removed.length, 0)
})
