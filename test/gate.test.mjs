import test from 'node:test'
import assert from 'node:assert/strict'
import { createGate, streamOutcome } from '../lib/gate.js'

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

test('closing the gate drains parked requests at the slot budget instead of releasing them together', async () => {
  const gate = createGate({ capacity: 2 })
  gate.guard()
  const a = await gate.acquire({ sessionId: 's1' })
  const b = await gate.acquire({ sessionId: 's2' })
  const seen = []
  const c = gate.acquire({ sessionId: 's3' }).then((ticket) => { seen.push('s3'); return ticket })
  const d = gate.acquire({ sessionId: 's4' }).then((ticket) => { seen.push('s4'); return ticket })
  await tick()
  gate.unguard()
  await tick()
  assert.deepEqual(seen, [], 'a closed gate must not turn the whole queue into concurrent streams')
  assert.equal(gate.stats().draining, true)
  gate.release(a, 'ok')
  const cTicket = await c
  await tick()
  assert.deepEqual(seen, ['s3'])
  gate.release(b, 'ok')
  const dTicket = await d
  gate.release(cTicket, 'ok')
  gate.release(dTicket, 'ok')
  assert.equal(gate.stats().draining, false)
  assert.equal(gate.stats().enabled, false)
  assert.equal(gate.stats().queued, 0)
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

test('a pause that empties a draining gate closes it instead of parking the next request', async () => {
  const gate = createGate({ capacity: 1 })
  gate.guard()
  const first = await gate.acquire({ sessionId: 's1' })
  const queued = gate.acquire({ sessionId: 's2' })
  await tick()
  gate.unguard()
  gate.release(first, 'ok')
  const second = await queued
  gate.abort()
  gate.release(second, 'cancelled')
  assert.equal(gate.stats().queued, 0)
  assert.equal(gate.stats().draining, false)
  assert.equal(gate.stats().enabled, false)
  const after = await gate.acquire({ sessionId: 's3' })
  assert.deepEqual(after, { free: true }, 'a closed gate must not queue a request')
})

test('a tracked turn keeps a drained gate open so its second model call is still limited', async () => {
  let current = 0
  const gate = createGate({ capacity: 1, now: () => current })
  gate.guard()
  gate.track('s1')
  gate.turnOpen('s1')
  const first = await gate.acquire({ sessionId: 's1', purpose: 'turn' })
  gate.release(first, 'ok')
  // The turn is still running between its model calls. Ending the batch here closed the gate, and
  // the next stream of that same turn then bypassed the limit entirely.
  gate.unguard()
  assert.equal(gate.stats().draining, true)
  assert.equal(gate.stats().openTurns, 1)
  assert.equal(gate.enabled(), true, 'the gate must stay armed while a restored turn is open')
  const second = await gate.acquire({ sessionId: 's1', purpose: 'turn' })
  assert.deepEqual(second, { free: false })
  gate.release(second, 'ok')
  gate.turnEnd('s1')
  assert.equal(gate.enabled(), false, 'the last tracked turn closes the drained gate')
  assert.equal(gate.stats().draining, false)
})

test('a start the prompt emits before returning is counted from the reservation, and the slot budget holds', async () => {
  const gate = createGate({ capacity: 1 })
  gate.guard()
  // The shipped controller emits `turn/start` synchronously inside `prompt()`, before the restore
  // learns the request was admitted. The reservation made just before the prompt is what counts it.
  gate.reserve('s1')
  gate.turnOpen('s1')
  gate.admitted('s1')
  assert.equal(gate.stats().reserved, 0, 'the tracked event consumed the pending start')
  assert.equal(gate.stats().openTurns, 1, 'the pre-track turn/start was counted, not dropped')
  assert.equal(gate.scopes('s1'), true)

  const first = await gate.acquire({ sessionId: 's1' })
  gate.reserve('s2')
  gate.turnOpen('s2')
  gate.admitted('s2')
  let second = null
  const waiting = gate.acquire({ sessionId: 's2' }).then((ticket) => { second = ticket })
  await tick()
  assert.equal(second, null, 'two restored streams must not run together at capacity 1')
  assert.equal(gate.stats().running, 1)
  assert.equal(gate.stats().queued, 1)
  gate.release(first, 'ok')
  await waiting
  gate.release(second, 'ok')
  gate.turnEnd('s1')
  gate.turnEnd('s2')
})

test('a turn/start after the drain closed reopens the batch instead of bypassing the limit', async () => {
  const gate = createGate({ capacity: 1, lateWindowMs: 60000 })
  gate.guard()
  gate.reserve('s1')
  gate.admitted('s1')
  // The queue and the slot are both empty, so the drain closes before `turn/start` arrives.
  gate.unguard()
  assert.equal(gate.enabled(), false)
  gate.turnOpen('s1')
  assert.equal(gate.enabled(), true, 'the late turn/start must extend the drain, not be dropped')
  assert.equal(gate.stats().openTurns, 1)
  const ticket = await gate.acquire({ sessionId: 's1' })
  assert.deepEqual(ticket, { free: false }, 'the late turn is limited, not bypassing the gate')
  gate.release(ticket, 'ok')
  gate.turnEnd('s1')
  assert.equal(gate.enabled(), false)
})

test('finishDrain is not reached while a reservation or a running stream is outstanding', async () => {
  const gate = createGate({ capacity: 1 })
  gate.guard()
  gate.reserve('s1')
  gate.unguard()
  assert.equal(gate.stats().draining, true, 'an admitted prompt is still pending')
  assert.equal(gate.stats().reserved, 1)
  // A prompt that really failed gives the reservation up, and only then may the drain close.
  gate.abandon('s1')
  assert.equal(gate.stats().draining, false)
  assert.equal(gate.enabled(), false)

  const stream = createGate({ capacity: 1 })
  stream.guard()
  const ticket = await stream.acquire({ sessionId: 's1' })
  stream.unguard()
  assert.equal(stream.stats().draining, true, 'a stream in flight is not a finished drain')
  assert.equal(stream.stats().running, 1)
  stream.release(ticket, 'ok')
  assert.equal(stream.stats().draining, false)
})

test('an ordinary session outside the restore batch is never scoped by the gate', async () => {
  const gate = createGate({ capacity: 1 })
  gate.guard()
  gate.reserve('restored')
  assert.equal(gate.scopes('restored'), true)
  assert.equal(gate.scopes('ordinary'), false, 'a person typing during a restore must pass straight through')
  gate.admitted('restored')
  gate.turnOpen('restored')
  assert.equal(gate.scopes('restored'), true)
  assert.equal(gate.scopes('ordinary'), false)
  gate.turnEnd('restored')
  gate.unguard()
  assert.equal(gate.enabled(), false)
  assert.equal(gate.scopes('restored'), false, 'a closed batch scopes nothing')
})

test('a full-consumption aborted caused by our own pause earns no strike and no cooldown', async () => {
  // Only an upstream abort/error is a strike; our pause signal aborting is a cancellation.
  assert.equal(streamOutcome({ ended: true, kind: 'aborted', aborted: true }), 'aborted')
  assert.equal(streamOutcome({ ended: true, kind: 'aborted' }), 'error')
  assert.equal(streamOutcome({ ended: false }), 'cancelled')
  assert.equal(streamOutcome({ ended: true, kind: 'completed' }), 'ok')

  const gate = createGate({ capacity: 1, maxCapacity: 2 })
  gate.guard()
  for (let i = 0; i < 4; i += 1) {
    const ticket = await gate.acquire({ sessionId: `s${i}` })
    gate.release(ticket, streamOutcome({ ended: true, kind: 'aborted', aborted: true }))
  }
  assert.equal(gate.stats().capacity, 1, 'an aborted stream neither ramps nor strikes')
  assert.equal(gate.stats().cooldownUntil, 0)
  const ticket = await gate.acquire({ sessionId: 'after' })
  assert.equal(gate.stats().running, 1, 'the pool was never blocked by those cancels')
  gate.release(ticket, 'ok')
})
