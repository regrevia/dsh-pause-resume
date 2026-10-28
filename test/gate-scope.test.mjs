import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../index.js'

const tick = () => new Promise((resolve) => setTimeout(resolve, 5))

// The real seam: `apply` installs the interceptor on the host's `llm/stream` dispatch, and a restore
// batch is armed by the engine through `gate.guard()`/`reserve()`. Mounting the plugin is the only
// way to prove an ordinary session passes straight through while a restore is running.
async function mountProgressive() {
  const home = mkdtempSync(join(tmpdir(), 'dsh-pause-gate-'))
  process.env.DSH_HOME = home
  const handlers = new Map()
  const cleanups = []
  const registry = {
    webServer: { register: () => {} },
    sessionController: { cancel: async () => {}, resolveAgent: async () => undefined },
    goals: { get: () => undefined, pause: () => {}, resume: () => {} },
    jobs: { list: () => [], kill: () => {} },
    agents: { get: () => undefined, list: () => [], resume: async () => {} },
  }
  const ctx = {
    get: (key) => registry[key],
    effect: (fn) => cleanups.push(fn),
    on: (name, fn) => {
      if (name === 'llm/stream') handlers.set('stream', fn)
      return () => handlers.delete('stream')
    },
  }
  const mounted = apply(ctx, { restoreProgressive: true })
  await new Promise((resolve) => setTimeout(resolve, 50))
  return {
    gate: mounted.gate,
    stream: handlers.get('stream'),
    async close() {
      for (const cleanup of cleanups.splice(0)) {
        try {
          await cleanup()
        } catch {
          /* the mount may already be gone */
        }
      }
      rmSync(home, { recursive: true, force: true })
    },
  }
}

/** Drive the middleware the way the host does: consume its async generator. */
function consume(handler, options, next) {
  const iterator = handler(options, next)
  const chunks = []
  const done = (async () => {
    for await (const chunk of iterator) chunks.push(chunk)
    return chunks
  })()
  return { chunks, done }
}

async function* healthy(hold = null) {
  yield { type: 'text', text: 'hello' }
  if (hold !== null) await hold
  yield { type: 'finish', reason: { kind: 'completed' } }
}

test('a stream in a session outside the restore batch passes straight through while the gate is armed', async () => {
  const mounted = await mountProgressive()
  try {
    const { gate, stream } = mounted
    assert.equal(typeof stream, 'function', 'progressive mode installs the interceptor')
    gate.guard()
    gate.reserve('restored')

    let called = 0
    const ordinary = consume(stream, { sessionId: 'ordinary', signal: new AbortController().signal }, () => {
      called += 1
      return healthy()
    })
    const chunks = await ordinary.done
    assert.equal(called, 1, 'the unrelated request reached the provider without waiting')
    assert.equal(chunks.at(-1).type, 'finish')
    assert.equal(gate.stats().running, 0, 'an ordinary request never takes a restore slot')
    assert.equal(gate.stats().dispatched, 0)
    assert.equal(gate.enabled(), true, 'the restore batch is still armed')
  } finally {
    await mounted.close()
  }
})

test('a reserved session is limited to one stream even when the prompt opened its turn first', async () => {
  const mounted = await mountProgressive()
  try {
    const { gate, stream } = mounted
    gate.guard()
    // This is the shipped ordering: reserve the pending start, the prompt emits `turn/start` inside
    // the call, admission follows. The reservation is what makes both sessions visible to the gate.
    gate.reserve('restored')
    gate.turnOpen('restored')
    gate.admitted('restored')
    gate.reserve('restored2')
    gate.turnOpen('restored2')
    gate.admitted('restored2')

    let releaseHold = () => {}
    const hold = new Promise((resolve) => { releaseHold = resolve })
    const first = consume(stream, { sessionId: 'restored' }, () => healthy(hold))
    await tick()
    assert.equal(gate.stats().running, 1)
    let secondCalled = false
    const second = consume(stream, { sessionId: 'restored2' }, () => {
      secondCalled = true
      return healthy()
    })
    await tick()
    assert.equal(secondCalled, false, 'the second restored stream waits for the one slot')
    assert.equal(gate.stats().queued, 1)
    releaseHold()
    await first.done
    const chunks = await second.done
    assert.equal(secondCalled, true)
    assert.equal(chunks.at(-1).type, 'finish')
    assert.equal(gate.stats().running, 0)
    gate.turnEnd('restored')
    gate.turnEnd('restored2')
  } finally {
    await mounted.close()
  }
})
