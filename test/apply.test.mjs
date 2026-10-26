import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../index.js'

/** Mount the plugin the way the Host does: one registry, one effect collector, one route table. */
async function mount(services = {}, home = mkdtempSync(join(tmpdir(), 'dsh-pause-test-'))) {
  const routes = []
  const cleanups = []
  // Every mount owns a fresh state directory: a test may never read or write the real profile.
  process.env.DSH_HOME = home
  const registry = {
    webServer: { register: (route) => routes.push(route) },
    sessionController: { cancel: async () => {}, resolveAgent: async () => undefined },
    goals: { get: () => undefined, pause: () => {}, resume: () => {} },
    jobs: { list: () => [], kill: () => {} },
    agents: { get: () => undefined, list: () => [], resume: async () => {} },
    ...services,
  }
  apply({ get: (key) => registry[key], effect: (fn) => cleanups.push(fn), on: () => {} }, {})
  await new Promise((resolve) => setTimeout(resolve, 250))
  const call = async (path, request = {}) => {
    const route = routes.find((entry) => entry.path === path)
    assert.ok(route !== undefined, `route ${path} is registered`)
    const answer = { headersSent: false, status: 0, body: '', writeHead(status) { this.status = status }, end(body) { this.body = body ?? '' } }
    await route.handler({ method: 'GET', headers: { host: '127.0.0.1:54601' }, ...request }, answer)
    return { status: answer.status, value: answer.body === '' ? null : JSON.parse(answer.body) }
  }
  return { routes, cleanups, call, home }
}

test('the mount registers the three routes and answers state', async () => {
  const { routes, call } = await mount()
  assert.deepEqual(routes.map((route) => route.path).sort(), [
    '/dsh-pause-resume/pause',
    '/dsh-pause-resume/resume',
    '/dsh-pause-resume/state',
  ])
  const { status, value } = await call('/dsh-pause-resume/state')
  assert.equal(status, 200)
  assert.equal(value.phase, 'idle')
  assert.equal(value.action, 'none')
})

test('a live turn and an armed goal turn the glyph into pause', async () => {
  const { call } = await mount({
    agents: {
      get: (id) => (id === 's1' ? { id: 's1', status: 'running', phase: { lastTurn: 1 } } : undefined),
      list: () => [{ id: 's1', status: 'running', phase: { lastTurn: 1 } }],
      resume: async () => {},
    },
    goals: { get: () => ({ id: 'g1', revision: 1, phase: 'active', activation: 'armed' }), pause: () => {}, resume: () => {} },
  })
  const { value } = await call('/dsh-pause-resume/state')
  assert.equal(value.phase, 'idle')
  assert.notEqual(value.action, 'none')
  assert.equal(value.live.sessions, 1)
  assert.equal(value.live.goals, 1)
})

test('the header is required and the verb is checked', async () => {
  const { call } = await mount()
  assert.equal((await call('/dsh-pause-resume/pause', { method: 'GET' })).status, 405)
  assert.equal((await call('/dsh-pause-resume/pause', { method: 'POST' })).status, 403)
  const allowed = await call('/dsh-pause-resume/pause', { method: 'POST', headers: { host: '127.0.0.1:54601', 'x-dsh-pause-resume': '1' } })
  assert.ok([200, 500].includes(allowed.status))
})

test('a previous process running.json is offered as resume before any press', async () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-pause-test-'))
  const dir = join(home, 'pause-resume')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'running.json'), JSON.stringify({
    version: 2,
    bootId: '111-foreign',
    updatedAt: 1000,
    sessions: [{ sessionId: 's9' }],
  }))
  const { call } = await mount({}, home)
  const { value } = await call('/dsh-pause-resume/state')
  assert.equal(value.source, 'crash')
  assert.equal(value.action, 'resume')
  assert.equal(value.counts.sessions, 1)
  assert.equal(value.error, null)
  rmSync(home, { recursive: true, force: true })
})

test('routes exist before hydration settles and state waits for it', async () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-pause-test-'))
  const routes = []
  process.env.DSH_HOME = home
  const registry = {
    webServer: { register: (route) => routes.push(route) },
    sessionController: { cancel: async () => {}, resolveAgent: async () => undefined },
    goals: { get: () => undefined, pause: () => {}, resume: () => {} },
    jobs: { list: () => [], kill: () => {} },
    agents: { get: () => undefined, list: () => [], resume: async () => {} },
  }
  apply({ get: (key) => registry[key], effect: () => {}, on: () => {} }, {})
  // The Host freezes its route table when the server starts; a late register is a live 404 and the
  // header button cannot ask for anything. Registration must therefore finish inside `apply`.
  assert.equal(routes.length, 3, 'routes are registered synchronously')
  const route = routes.find((entry) => entry.path === '/dsh-pause-resume/state')
  const answer = { headersSent: false, status: 0, body: '', writeHead(status) { this.status = status }, end(body) { this.body = body ?? '' } }
  await route.handler({ method: 'GET', headers: { host: '127.0.0.1:54601' } }, answer)
  assert.equal(answer.status, 200)
  assert.equal(JSON.parse(answer.body).phase, 'idle')
  rmSync(home, { recursive: true, force: true })
})
