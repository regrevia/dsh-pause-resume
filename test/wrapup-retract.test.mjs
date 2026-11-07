import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createProbe, WRAP_UP_TEXT } from '../lib/probe.js'

/**
 * The wrap-up steer is a message like any other: the official cancel keeps the pending inbox
 * (`keepInbox: true`), so a steer whose window ran out is still queued when the pause returns and
 * the next resume replays it as if the person had asked for it. The press therefore takes back the
 * one message it queued itself — never the person's, never a build's that it cannot see.
 */

const USER_MESSAGE = { id: 'm-user', role: 'user', content: [{ type: 'text', text: '继续把剩下的两章写完' }] }
const SECOND_MESSAGE = { id: 'm-second', role: 'user', content: [{ type: 'text', text: '先别改测试' }] }

function registry(services) {
  return { get: (key) => services[key] }
}

function queued(fake, sessionId) {
  const inbox = fake.inboxes.get(sessionId)
  if (inbox === null || inbox === undefined) return []
  return [...inbox.nextTurn, ...inbox.nextStep]
}

/**
 * The shipped shape the probe depends on, with the inbox variant spelled out per agent:
 * `queue: 'none'` is a build whose Agent exposes no inbox, `queue: 'no-remove'` one that exposes
 * the queues but no removal entry. Both must still stop and must not pretend to have retracted.
 */
function harness({ agents = [], finishAfterMs = null, keepRunning = false } = {}) {
  const calls = []
  const delivered = []
  const removed = []
  const live = new Map()
  const inboxes = new Map()
  // The Harness records how each turn ended; `completed` is what a landed wrap-up looks like.
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
  let seq = 0
  for (const row of agents) {
    const agent = { id: row.id, status: row.status ?? 'running', phase: { lastTurn: 3 }, mounted: true }
    live.set(agent.id, agent)
    if (row.queue === 'none') {
      inboxes.set(agent.id, null)
      continue
    }
    const nextTurn = (row.queued ?? []).map((message) => ({ ...message }))
    const nextStep = []
    const inbox = { nextTurn, nextStep }
    if (row.queue !== 'no-remove') {
      inbox.remove = (id) => {
        removed.push({ sessionId: agent.id, id })
        for (const list of [nextTurn, nextStep]) {
          const at = list.findIndex((message) => message?.id === id)
          if (at >= 0) {
            list.splice(at, 1)
            return true
          }
        }
        return false
      }
    }
    agent.inbox = inbox
    inboxes.set(agent.id, inbox)
  }
  const services = {
    agents: {
      get: (id) => live.get(id),
      list: () => [...live.values()],
    },
    goals: {
      get: () => null,
      disarm: () => { throw new Error('GOAL_NOT_FOUND') },
      pause: () => { throw new Error('GOAL_NOT_FOUND') },
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
        calls.push({ kind: 'cancel', sessionId: request.sessionId })
        const agent = live.get(request.sessionId)
        // A cancelled turn ends at once; a hung fake keeps `running` so the press has to bound its
        // own wait, which is what the timed-out cases need.
        if (keepRunning !== true) finish(request.sessionId)
      },
      prompt: async (request) => {
        calls.push({
          kind: 'prompt',
          sessionId: request.sessionId,
          mode: request.mode,
          requestId: request.requestId,
          text: request.content?.[0]?.text,
        })
        const agent = live.get(request.sessionId)
        if (agent === undefined) throw new Error('SESSION_NOT_FOUND')
        const inbox = inboxes.get(request.sessionId)
        if (inbox !== null && inbox !== undefined) {
          const id = `wrap-${++seq}`
          inbox.nextStep.push({ id, role: 'user', content: [{ type: 'text', text: request.content?.[0]?.text }] })
          delivered.push({ sessionId: request.sessionId, id, text: request.content?.[0]?.text })
        }
        const wait = finishAfterMs !== null && typeof finishAfterMs === 'object' ? finishAfterMs[request.sessionId] : finishAfterMs
        if (Number.isFinite(wait) && wait >= 0) {
          setTimeout(() => finish(request.sessionId), wait)
        }
        return { accepted: true }
      },
    },
  }
  return { services, registry: registry(services), calls, delivered, removed, live, inboxes, watchTurn }
}

const cancels = (fake) => fake.calls.filter((call) => call.kind === 'cancel').map((call) => call.sessionId)

test('a timed-out steer is taken back, and the message queued before it is left alone', async () => {
  const fake = harness({ agents: [{ id: 's1', queued: [USER_MESSAGE] }], keepRunning: true })
  const probe = createProbe(fake.registry, { watchTurn: fake.watchTurn, graceMs: 300 })
  const stopped = await probe.stop(probe.live(), { wrapUpMs: 120, planId: 'p1' })

  assert.deepEqual(stopped.wrapUp, {
    windowMs: 120,
    steered: ['s1'],
    completed: [],
    unclean: [],
    unverified: [],
    timedOut: ['s1'],
    interrupted: [],
    unavailable: null,
    retracted: ['s1'],
    retractUnavailable: [],
  })
  // The fallback sentence is the exported one, so the record the retraction matches on is the text
  // that was actually steered.
  assert.equal(fake.delivered.length, 1)
  assert.equal(fake.delivered[0].text, WRAP_UP_TEXT)
  assert.deepEqual(fake.removed, [{ sessionId: 's1', id: fake.delivered[0].id }])
  // What the person queued is still queued, character for character.
  assert.deepEqual(queued(fake, 's1'), [USER_MESSAGE])
})

test('a turn that ends inside the window keeps its steer and asks for no removal', async () => {
  const fake = harness({ agents: [{ id: 's1', queued: [USER_MESSAGE] }], finishAfterMs: { s1: 20 } })
  const probe = createProbe(fake.registry, { watchTurn: fake.watchTurn, graceMs: 300 })
  const stopped = await probe.stop(probe.live(), { wrapUpMs: 300, planId: 'p1' })

  assert.deepEqual(stopped.wrapUp.completed, ['s1'])
  assert.deepEqual(stopped.wrapUp.timedOut, [])
  assert.deepEqual(stopped.wrapUp.retracted, [])
  assert.deepEqual(stopped.wrapUp.retractUnavailable, [])
  // The message was consumed by the turn it woke: there is nothing stale to take back.
  assert.deepEqual(fake.removed, [])
  assert.deepEqual(cancels(fake), [])
})

test('a build with no readable queue cannot retract, and the press still stops', async () => {
  const fake = harness({
    agents: [
      { id: 's1', queue: 'none' },
      { id: 's2', queue: 'no-remove', queued: [USER_MESSAGE] },
    ],
  })
  const probe = createProbe(fake.registry, { watchTurn: fake.watchTurn, graceMs: 300 })
  const stopped = await probe.stop(probe.live(), { wrapUpMs: 120, planId: 'p1' })

  assert.deepEqual(stopped.wrapUp.timedOut.slice().sort(), ['s1', 's2'])
  assert.deepEqual(stopped.wrapUp.retracted, [])
  assert.deepEqual(stopped.wrapUp.retractUnavailable.slice().sort(), ['s1', 's2'])
  // Nothing claims a removal it did not make, and nothing throws instead of stopping.
  assert.deepEqual(fake.removed, [])
  assert.deepEqual(stopped.canceled.slice().sort(), ['s1', 's2'])
  assert.deepEqual(cancels(fake).sort(), ['s1', 's2'])
})

test('of two sessions only the one that timed out is retracted', async () => {
  const fake = harness({
    agents: [
      { id: 's1', queued: [USER_MESSAGE] },
      { id: 's2', queued: [SECOND_MESSAGE] },
    ],
    finishAfterMs: { s1: 20 },
  })
  const probe = createProbe(fake.registry, { watchTurn: fake.watchTurn, graceMs: 300 })
  const stopped = await probe.stop(probe.live(), { wrapUpMs: 300, planId: 'p2' })

  assert.deepEqual(stopped.wrapUp.completed, ['s1'])
  assert.deepEqual(stopped.wrapUp.timedOut, ['s2'])
  assert.deepEqual(stopped.wrapUp.retracted, ['s2'])
  assert.deepEqual(stopped.wrapUp.retractUnavailable, [])
  const s2wrap = fake.delivered.find((row) => row.sessionId === 's2')
  assert.deepEqual(fake.removed, [{ sessionId: 's2', id: s2wrap.id }])
  assert.deepEqual(queued(fake, 's2'), [SECOND_MESSAGE])
  // The completed session's steer is untouched, and so is its own earlier message.
  assert.deepEqual(queued(fake, 's1').map((message) => message.id), ['m-user', fake.delivered.find((row) => row.sessionId === 's1').id])
  assert.deepEqual(cancels(fake), ['s2'])
})
