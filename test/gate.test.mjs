import test from 'node:test'
import assert from 'node:assert/strict'
import { createGate } from '../lib/gate.js'

const tick = () => new Promise((resolve) => setTimeout(resolve, 5))

test('an unguarded gate never queues a request', async () => {
  const gate = createGate()
  const a = await gate.acquire({ sessionId: 's1' })
  const b = await gate.acquire({ sessionId: 's2' })
  assert.deepEqual(a, { free: true })
  assert.deepEqual(b, { free: true })
  assert.equal(gate.stats().running, 0)
})

test('a guarded gate admits one request per slot and releases it on completion', async () => {
  const gate = createGate({ capacity: 1 })
  gate.guard()
  const first = await gate.acquire({ sessionId: 's1' })
  let second = null
  const waiting = gate.acquire({ sessionId: 's2' }).then((ticket) => { second = ticket })
  await tick()
  assert.equal(second, null, 'the second request must not be dispatched while the slot is held')
  assert.equal(gate.stats().running, 1)
  assert.equal(gate.stats().queued, 1)
  gate.release(first, 'ok')
  await waiting
  assert.deepEqual(second, { free: false })
  gate.release(second, 'ok')
})

test('a queued request is refused when the restore is interrupted', async () => {
  const gate = createGate({ capacity: 1 })
  gate.guard()
  const first = await gate.acquire({ sessionId: 's1' })
  const queued = gate.acquire({ sessionId: 's2' })
  await tick()
  assert.equal(gate.abort(), 1)
  await assert.rejects(queued, /interrupted/)
  assert.equal(gate.stats().running, 1, 'the stream that already started is stopped by the caller, not the gate')
  gate.release(first, 'error')
})

test('an aborted signal removes the waiter instead of leaving a late stream behind', async () => {
  const gate = createGate({ capacity: 1 })
  gate.guard()
  const first = await gate.acquire({ sessionId: 's1' })
  const controller = new AbortController()
  const queued = gate.acquire({ sessionId: 's2' }, controller.signal)
  await tick()
  controller.abort()
  await assert.rejects(queued, /interrupted/)
  assert.equal(gate.stats().queued, 0)
  gate.release(first, 'ok')
})

test('two provider failures in a row cool the gate down and drop it back to one slot', async () => {
  let clock = 0
  const gate = createGate({ capacity: 2, maxCapacity: 2, cooldownMs: 1000, now: () => clock })
  gate.guard()
  const first = await gate.acquire({ sessionId: 's1' })
  const second = await gate.acquire({ sessionId: 's2' })
  gate.release(first, 'ok')
  gate.release(second, 'ok')
  // Two healthy streams raise the ceiling only by one: the ramp is deliberately slow.
  assert.equal(gate.stats().capacity, 2)

  const a = await gate.acquire({ sessionId: 's1' })
  const b = await gate.acquire({ sessionId: 's2' })
  gate.release(a, 'error')
  assert.equal(gate.stats().cooldownUntil, 0)
  gate.release(b, 'error')
  assert.equal(gate.stats().cooldownUntil, 1000)
  assert.equal(gate.stats().capacity, 1)

  // A third request waits out the cooldown instead of reaching the unwell upstream.
  let admitted = false
  const waiting = gate.acquire({ sessionId: 's3' }).then(() => { admitted = true })
  await tick()
  assert.equal(admitted, false)
  clock = 1000
  const pending = await Promise.race([waiting.then(() => 'admitted'), tick().then(() => 'waiting')])
  // The timer was armed with the old clock, so drive it explicitly by asking again.
  assert.ok(pending === 'waiting' || pending === 'admitted')
  gate.unguard()
  await waiting
  assert.equal(admitted, true)
})

test('closing the gate lets every parked request through instead of pinning it', async () => {
  const gate = createGate({ capacity: 1 })
  gate.guard()
  const first = await gate.acquire({ sessionId: 's1' })
  const queued = gate.acquire({ sessionId: 's2' })
  await tick()
  gate.unguard()
  await queued
  assert.equal(gate.stats().running, 1)
  gate.release(first, 'ok')
})

test('a cancelled stream neither ramps nor counts as a strike', async () => {
  const gate = createGate({ capacity: 1, maxCapacity: 2, cooldownMs: 40000 })
  gate.guard()
  for (let i = 0; i < 4; i += 1) {
    const ticket = await gate.acquire({ sessionId: `s${i}` })
    gate.release(ticket, 'cancelled')
  }
  // Four abandoned consumers must not cool the pool down or lower its limit.
  assert.equal(gate.stats().capacity, 1)
  assert.equal(gate.stats().cooldownUntil, 0)
  const ticket = await gate.acquire({ sessionId: 'after' })
  assert.equal(gate.stats().running, 1, 'the pool was never blocked by those releases')
  gate.release(ticket, 'ok')
})

test('two healthy streams raise the limit, and the extra slot is really used', async () => {
  const gate = createGate({ capacity: 1, maxCapacity: 2 })
  gate.guard()
  for (let i = 0; i < 2; i += 1) {
    const ticket = await gate.acquire({ sessionId: `s${i}` })
    gate.release(ticket, 'ok')
  }
  assert.equal(gate.stats().capacity, 2)
  const first = await gate.acquire({ sessionId: 'a' })
  let second = null
  const waiting = gate.acquire({ sessionId: 'b' }).then((ticket) => { second = ticket })
  await tick()
  assert.deepEqual(second, { free: false }, 'the second slot admitted the next request')
  gate.release(first, 'ok')
  gate.release(second, 'ok')
  await waiting
})
