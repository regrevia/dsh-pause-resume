import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../index.js'

/**
 * The window between "asked to stop" and "stopped" is the only time this plugin may refuse a tool
 * call. These cases drive a real press to that phase instead of stubbing it: the guard is only worth
 * anything if it reads the phase the engine actually sets.
 */
async function mount(services = {}, config = {}) {
  const home = mkdtempSync(join(tmpdir(), 'dsh-wrap-guard-'))
  process.env.DSH_HOME = home
  const routes = []
  const cleanups = []
  const listeners = []
  const registry = {
    webServer: { register: (route) => routes.push(route) },
    sessionController: { cancel: async () => {}, resolveAgent: async () => undefined },
    goals: { get: () => undefined, pause: () => {}, resume: () => {} },
    jobs: { list: () => [], kill: () => {} },
    agents: { get: () => undefined, list: () => [], resume: async () => {} },
    ...services,
  }
  apply({
    get: (key) => registry[key],
    effect: (fn) => cleanups.push(fn),
    on: (name, handler) => {
      listeners.push({ name, handler })
      return () => {
        const at = listeners.findIndex((entry) => entry.handler === handler)
        if (at !== -1) listeners.splice(at, 1)
      }
    },
  }, config)
  await new Promise((resolve) => setTimeout(resolve, 250))
  const call = async (path, request = {}) => {
    const route = routes.find((entry) => entry.path === path)
    assert.ok(route !== undefined, `route ${path} is registered`)
    const answer = { headersSent: false, status: 0, body: '', writeHead(status) { this.status = status }, end(body) { this.body = body ?? '' } }
    await route.handler({ method: 'GET', headers: { host: '127.0.0.1:54601' }, ...request }, answer)
    return { status: answer.status, value: answer.body === '' ? null : JSON.parse(answer.body) }
  }
  return { call, listeners, cleanups }
}

const press = { method: 'POST', headers: { host: '127.0.0.1:54601', 'x-dsh-pause-resume': '1' } }
const allow = () => Promise.resolve({ kind: 'allow' })
const guardOf = (listeners) => listeners.find((entry) => entry.name === 'tools/pre-execute')?.handler

/** One running session whose cancel never returns until the test lets it. */
function heldController() {
  let release = () => {}
  const held = new Promise((resolve) => { release = resolve })
  return { cancel: async () => { await held }, release: () => release() }
}

function runningSession(id = 's1') {
  return { id, status: 'running', phase: { lastTurn: 1 } }
}

async function untilPausing(call, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const { value } = await call('/dsh-pause-resume/state')
    if (value?.phase === 'pausing') return value
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error('the press never reached the wrapping phase')
}

test('a spawn ordered while the press is finishing is refused, and nothing else is', async () => {
  const controller = heldController()
  const agent = runningSession()
  const { call, listeners } = await mount({
    sessionController: controller,
    agents: { get: (id) => (id === 's1' ? agent : undefined), list: () => [agent], resume: async () => {} },
  })
  const guard = guardOf(listeners)
  assert.equal(typeof guard, 'function', 'the guard is installed at mount')
  try {
    const pending = call('/dsh-pause-resume/pause', press)
    await untilPausing(call)
    // A subagent is new work the plan never captured; it must be refused while the press runs.
    const spawned = await guard({ name: 'subagent', arguments: {} }, allow)
    assert.equal(spawned.kind, 'deny')
    assert.match(spawned.reason, /wrap/i)
    // The same holds for a fork and for a scheduled task nobody would pause.
    assert.equal((await guard({ name: 'subagent_fork', arguments: {} }, allow)).kind, 'deny')
    assert.equal((await guard({ name: 'schedule_create', arguments: {} }, allow)).kind, 'deny')
    assert.equal((await guard({ name: 'workflow', arguments: {} }, allow)).kind, 'deny')
    // Background jobs are the other way work escapes a pause.
    assert.equal((await guard({ name: 'bash', arguments: { run_in_background: true } }, allow)).kind, 'deny')
    // A turn still has to be able to finish its sentence: ordinary calls are delegated untouched.
    let delegated = 0
    const stillAllowed = await guard({ name: 'bash', arguments: { command: 'ls' } }, async () => {
      delegated += 1
      return { kind: 'allow' }
    })
    assert.equal(stillAllowed.kind, 'allow')
    assert.equal(delegated, 1)
    const text = await guard({ name: 'read', arguments: { file_path: '/tmp/x' } }, allow)
    assert.equal(text.kind, 'allow')
    controller.release()
    await pending
  } finally {
    controller.release()
  }
  // Once the press returned, the guard is out of the way again.
  const settled = await guard({ name: 'subagent', arguments: {} }, allow)
  assert.equal(settled.kind, 'allow')
})

test('a press that stops nothing never blocks a call', async () => {
  const { call, listeners } = await mount()
  const guard = guardOf(listeners)
  const { value } = await call('/dsh-pause-resume/pause', press)
  assert.equal(value.phase === 'pausing', false)
  assert.equal((await guard({ name: 'subagent', arguments: {} }, allow)).kind, 'allow')
})

test('a guard retains its listener until the mount is disposed', async () => {
  const { cleanups, listeners } = await mount()
  assert.equal(listeners.filter((entry) => entry.name === 'tools/pre-execute').length, 1)
  // An effect callback returns its disposer; the Host calls that, so the test does too.
  for (const fn of cleanups) {
    const dispose = fn()
    if (typeof dispose === 'function') dispose()
  }
  assert.equal(listeners.filter((entry) => entry.name === 'tools/pre-execute').length, 0)
})
