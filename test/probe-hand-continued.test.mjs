import { test } from 'node:test'
import assert from 'node:assert/strict'
import { handContinued } from '../lib/probe.js'

/** The services shape the probe depends on: `get('agents')` hands back the live registry. */
function registry(agents) {
  return { get: (key) => (key === 'agents' ? agents : undefined) }
}

/** A live registry that hands out the agent objects themselves, as the shipped one does. */
function liveAgents(agents) {
  return { list: () => agents, get: (id) => agents.find((agent) => agent?.id === id) }
}

test('a session whose live turn counter moved past the plan owes no restore', () => {
  const services = registry(liveAgents([
    { id: 'wedged', status: 'running', phase: { kind: 'running', turn: 7 } },
  ]))
  const rows = [{ sessionId: 'wedged', lastTurn: 3, intent: 'continue', running: true }]

  const result = handContinued(services, rows)

  assert.equal(result.size, 1)
  assert.deepEqual(result.get('wedged'), { lastTurn: 7, running: true, moved: true, present: true })
})

test('an idle session whose counter equals the plan row did not move', () => {
  const services = registry(liveAgents([
    { id: 'waiting', status: 'idle', phase: { kind: 'idle', lastTurn: 4 } },
  ]))

  const result = handContinued(services, [{ sessionId: 'waiting', lastTurn: 4 }])

  assert.deepEqual(result.get('waiting'), { lastTurn: 4, running: false, moved: false, present: true })
})

test('a counter behind the plan row is not a move either', () => {
  const services = registry(liveAgents([
    { id: 'behind', status: 'idle', phase: { kind: 'idle', lastTurn: 2 } },
  ]))

  const result = handContinued(services, [{ sessionId: 'behind', lastTurn: 6 }])

  assert.equal(result.get('behind').moved, false)
  assert.equal(result.get('behind').lastTurn, 2)
})

test('a plan row with no live agent is present:false, not moved', () => {
  const services = registry(liveAgents([
    { id: 'someone-else', status: 'idle', phase: { kind: 'idle', lastTurn: 9 } },
  ]))

  const result = handContinued(services, [{ sessionId: 'gone', lastTurn: 1 }])

  assert.deepEqual(result.get('gone'), { lastTurn: null, running: false, moved: false, present: false })
})

test('a plan row that is not a safe integer cannot prove a move', () => {
  const services = registry(liveAgents([
    { id: 'shape-a', status: 'idle', phase: { kind: 'idle', lastTurn: 8 } },
    { id: 'shape-b', status: 'idle', phase: { kind: 'idle', lastTurn: 8 } },
    { id: 'shape-c', status: 'idle', phase: { kind: 'idle', lastTurn: 8 } },
    { id: 'shape-d', status: 'idle', phase: { kind: 'idle' } },
  ]))
  const rows = [
    { sessionId: 'shape-a', lastTurn: null },
    { sessionId: 'shape-b', lastTurn: '3' },
    { sessionId: 'shape-c', lastTurn: 3.5 },
    { sessionId: 'shape-d', lastTurn: 1 },
  ]

  const result = handContinued(services, rows)

  for (const id of ['shape-a', 'shape-b', 'shape-c']) assert.equal(result.get(id).moved, false, id)
  // A live agent that exposes no counter at all is present but cannot have moved.
  assert.deepEqual(result.get('shape-d'), { lastTurn: null, running: false, moved: false, present: true })
})

test('a malformed live list never throws and proves nothing', () => {
  const rows = [
    { sessionId: 'a', lastTurn: 1 },
    { sessionId: 'b', lastTurn: 2 },
  ]
  const shapes = [
    null,
    {},
    { get: () => { throw new Error('service gone') } },
    registry(null),
    registry({ list: () => { throw new Error('registry gone') } }),
    registry({ list: () => 'not a list' }),
    registry({ list: () => [null, 42, 'x', { nope: true }, { agent: null }, { agent: { status: 'idle' } }] }),
  ]

  for (const services of shapes) {
    const result = handContinued(services, rows)
    assert.equal(result.size, 2)
    for (const id of ['a', 'b']) {
      assert.deepEqual(result.get(id), { lastTurn: null, running: false, moved: false, present: false })
    }
  }
})

test('a wrapper handle is unwrapped, and malformed rows are skipped without throwing', () => {
  const services = registry(liveAgents([
    { agent: { id: 'wrapped', status: 'idle', phase: { kind: 'idle', lastTurn: 5 } }, status: 'idle' },
  ]))
  const rows = [null, 7, 'x', {}, { sessionId: '' }, { sessionId: 5 }, { sessionId: 'wrapped', lastTurn: 4 }]

  const result = handContinued(services, rows)

  assert.equal(result.size, 1)
  assert.deepEqual(result.get('wrapped'), { lastTurn: 5, running: false, moved: true, present: true })
})

test('rows that are not an array, and a duplicate row for one session, are handled', () => {
  const services = registry(liveAgents([
    { id: 'twice', status: 'idle', phase: { kind: 'idle', lastTurn: 5 } },
  ]))

  assert.equal(handContinued(services, null).size, 0)
  assert.equal(handContinued(services, undefined).size, 0)

  const result = handContinued(services, [
    { sessionId: 'twice', lastTurn: 2 },
    { sessionId: 'twice', lastTurn: 4 },
  ])
  assert.equal(result.size, 1)
  assert.deepEqual(result.get('twice'), { lastTurn: 5, running: false, moved: true, present: true })
})

test('reading the answer does not mutate the rows or the live agents', () => {
  const agent = { id: 'still', status: 'running', phase: { kind: 'running', turn: 3 } }
  const services = registry(liveAgents([agent]))
  const rows = [{ sessionId: 'still', lastTurn: 1 }]

  handContinued(services, rows)

  assert.deepEqual(rows, [{ sessionId: 'still', lastTurn: 1 }])
  assert.deepEqual(agent, { id: 'still', status: 'running', phase: { kind: 'running', turn: 3 } })
})
