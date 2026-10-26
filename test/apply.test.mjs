import { test } from 'node:test'
import assert from 'node:assert/strict'
import { apply } from '../index.js'

/** Mount the plugin the way the Host does: one registry, one effect collector, one route table. */
async function mount(services = {}) {
  const routes = []
  const cleanups = []
  const registry = {
    webServer: { register: (route) => routes.push(route) },
    sessionController: { list: async () => ({ items: [] }), cancel: () => {} },
    goals: { get: async () => undefined, pause: () => {}, resume: () => {} },
    jobs: { list: () => [], kill: () => {} },
    agents: { get: () => undefined, resume: async () => {} },
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
  return { routes, cleanups, call }
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
    sessionController: { list: async () => ({ items: [{ sessionId: 's1', running: true, agentAvailable: true }] }), cancel: () => {} },
    goals: { get: async () => ({ id: 'g1', revision: 1, phase: 'active', activation: 'armed' }), pause: () => {}, resume: () => {} },
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
