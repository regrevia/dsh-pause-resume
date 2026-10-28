import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply, VERSION } from '../index.js'

/** Mount the plugin the way the Host does: one registry, one effect collector, one route table. */
async function mount(services = {}, home = mkdtempSync(join(tmpdir(), 'dsh-pause-test-')), config = {}) {
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
  const plugin = apply({ get: (key) => registry[key], effect: (fn) => cleanups.push(fn), on: () => {} }, config)
  await new Promise((resolve) => setTimeout(resolve, 250))
  const call = async (path, request = {}) => {
    const route = routes.find((entry) => entry.path === path)
    assert.ok(route !== undefined, `route ${path} is registered`)
    const answer = { headersSent: false, status: 0, body: '', writeHead(status) { this.status = status }, end(body) { this.body = body ?? '' } }
    await route.handler({ method: 'GET', headers: { host: '127.0.0.1:54601' }, ...request }, answer)
    return { status: answer.status, value: answer.body === '' ? null : JSON.parse(answer.body) }
  }
  return { routes, cleanups, call, home, ledger: plugin.ledger, gate: plugin.gate }
}

test('the mount registers the four routes and answers state', async () => {
  const { routes, call } = await mount()
  assert.deepEqual(routes.map((route) => route.path).sort(), [
    '/dsh-pause-resume/continue',
    '/dsh-pause-resume/pause',
    '/dsh-pause-resume/resume',
    '/dsh-pause-resume/state',
  ])
  const { status, value } = await call('/dsh-pause-resume/state')
  assert.equal(status, 200)
  assert.equal(value.phase, 'idle')
  assert.equal(value.action, 'none')
})

test('every answer names the version in the manifest, never a second forgotten literal', async () => {
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  assert.equal(VERSION, manifest.version)
  const { call } = await mount()
  const { value } = await call('/dsh-pause-resume/state')
  assert.equal(value.version, manifest.version)
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
  assert.equal(routes.length, 4, 'routes are registered synchronously')
  const route = routes.find((entry) => entry.path === '/dsh-pause-resume/state')
  const answer = { headersSent: false, status: 0, body: '', writeHead(status) { this.status = status }, end(body) { this.body = body ?? '' } }
  await route.handler({ method: 'GET', headers: { host: '127.0.0.1:54601' } }, answer)
  assert.equal(answer.status, 200)
  assert.equal(JSON.parse(answer.body).phase, 'idle')
  rmSync(home, { recursive: true, force: true })
})

test('a plugin applied before the web server mounts its routes once the service appears', async () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-pause-test-'))
  process.env.DSH_HOME = home
  const routes = []
  let pending = null
  const registry = {
    sessionController: { cancel: async () => {}, resolveAgent: async () => undefined },
    goals: { get: () => undefined, pause: () => {}, resume: () => {} },
    jobs: { list: () => [], kill: () => {} },
    agents: { get: () => undefined, list: () => [], resume: async () => {} },
  }
  // After a crash the Host can apply plugins before its web server exists. A one-shot lookup then
  // found nothing and the button stayed disabled with no route behind it for the whole session.
  apply({
    get: (key) => registry[key],
    effect: () => {},
    on: () => {},
    inject: (deps, fn) => { pending = { deps, fn }; return () => {} },
  }, {})
  assert.equal(routes.length, 0, 'no route before the service exists')
  assert.deepEqual(pending.deps, ['webServer'])
  pending.fn({ get: (key) => (key === 'webServer' ? { register: (route) => routes.push(route) } : registry[key]) })
  await new Promise((resolve) => setTimeout(resolve, 50))
  assert.deepEqual(routes.map((route) => route.path).sort(), [
    '/dsh-pause-resume/continue',
    '/dsh-pause-resume/pause',
    '/dsh-pause-resume/resume',
    '/dsh-pause-resume/state',
  ])
  rmSync(home, { recursive: true, force: true })
})


test('stopped work becomes the one continue press, and only when no other press owns the button', async () => {
  const { call, ledger } = await mount()
  ledger.describe = () => ({ count: 2, attention: 1, busy: false, tasks: [{ sessionId: 's1', turn: 4, kind: 'error', status: 'waiting', title: '修复登录', at: 1, attempt: 0 }] })
  const state = await call('/dsh-pause-resume/state')
  assert.equal(state.value.action, 'continue')
  assert.equal(state.value.pendingContinue.count, 2)
  let pressed = 0
  ledger.continueAll = async () => {
    pressed += 1
    return { status: 'accepted', attempted: 2, continued: 2, remaining: 0, attention: 0, results: [] }
  }
  const answer = await call('/dsh-pause-resume/continue', { method: 'POST', headers: { host: '127.0.0.1:54601', 'x-dsh-pause-resume': '1' } })
  assert.equal(answer.status, 200)
  assert.equal(answer.value.outcome.continued, 2)
  assert.equal(pressed, 1)
})

test('the continue press runs inside the progressive gate and always closes it', async () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-pause-test-'))
  const { call, ledger, gate } = await mount({}, home, { restoreProgressive: true })
  ledger.describe = () => ({ count: 1, attention: 0, busy: false, tasks: [] })
  let armedDuringBatch = null
  ledger.continueAll = async () => {
    armedDuringBatch = gate.enabled()
    return { status: 'accepted', attempted: 1, continued: 1, remaining: 0, attention: 0, results: [] }
  }
  const answer = await call('/dsh-pause-resume/continue', { method: 'POST', headers: { host: '127.0.0.1:54601', 'x-dsh-pause-resume': '1' } })
  assert.equal(answer.status, 200)
  assert.equal(armedDuringBatch, true, 'a batch of restores is limited like a restore batch')
  assert.equal(gate.enabled(), false, 'a finished batch leaves no gate behind')

  // A batch that throws must not leave the interceptor armed: every later ordinary request would be
  // queued behind a gate nobody will ever close.
  ledger.continueAll = async () => { throw new Error('boom') }
  await assert.rejects(call('/dsh-pause-resume/continue', { method: 'POST', headers: { host: '127.0.0.1:54601', 'x-dsh-pause-resume': '1' } }), /boom/)
  assert.equal(gate.enabled(), false)
  rmSync(home, { recursive: true, force: true })
})

test('a pause press owns the button, so continuing waiting work is refused', async () => {
  const { call, ledger } = await mount({
    agents: {
      get: (id) => (id === 's1' ? { id: 's1', status: 'running', phase: { lastTurn: 1 } } : undefined),
      list: () => [{ id: 's1', status: 'running', phase: { lastTurn: 1 } }],
    },
  })
  ledger.describe = () => ({ count: 1, attention: 0, busy: false, tasks: [] })
  let pressed = 0
  ledger.continueAll = async () => {
    pressed += 1
    return { status: 'accepted', attempted: 1, continued: 1, remaining: 0, attention: 0, results: [] }
  }
  const state = await call('/dsh-pause-resume/state')
  assert.equal(state.value.action, 'pause')
  const answer = await call('/dsh-pause-resume/continue', { method: 'POST', headers: { host: '127.0.0.1:54601', 'x-dsh-pause-resume': '1' } })
  assert.equal(answer.status, 409)
  assert.equal(pressed, 0)
})

test('failed work stays readable while another batch runs, and is pressable once it ends', async () => {
  const { call, ledger } = await mount()
  ledger.describe = () => ({
    count: 2,
    attention: 1,
    blocking: 1,
    actionable: 1,
    busy: true,
    tasks: [
      { sessionId: 's1', turn: 4, kind: 'error', code: 'AUTH', status: 'attention', blocking: true, actionable: false, title: '修复登录', at: 2, attempt: 1 },
      { sessionId: 's2', turn: 7, kind: 'error', code: 'SERVER', status: 'waiting', blocking: false, actionable: true, title: '跑测试', at: 1, attempt: 0 },
    ],
  })
  const running = await call('/dsh-pause-resume/state')
  assert.equal(running.value.action, 'busy', 'a running batch owns the button')
  assert.equal(running.value.pendingContinue.count, 2, 'the list is not hidden by the batch')
  assert.equal(running.value.pendingContinue.blocking, 1)
  assert.equal(running.value.pendingContinue.actionable, 1)
  assert.equal(running.value.pendingContinue.tasks[0].actionable, false)

  // The batch unwinds. Nothing is running now, so the same rows are one press away.
  ledger.describe = () => ({
    count: 2,
    attention: 1,
    blocking: 1,
    actionable: 1,
    busy: false,
    tasks: [
      { sessionId: 's1', turn: 4, kind: 'error', code: 'AUTH', status: 'attention', blocking: true, actionable: false, title: '修复登录', at: 2, attempt: 1 },
      { sessionId: 's2', turn: 7, kind: 'error', code: 'SERVER', status: 'waiting', blocking: false, actionable: true, title: '跑测试', at: 1, attempt: 0 },
    ],
  })
  const ready = await call('/dsh-pause-resume/state')
  assert.equal(ready.value.action, 'continue')
  assert.equal(ready.value.pendingContinue.tasks.length, 2, 'a permanent failure does not hide the retriable one')
  let seen = null
  ledger.continueAll = async () => ({ status: 'accepted', attempted: 2, continued: 1, remaining: 1, attention: 1, results: [] })
  const answer = await call('/dsh-pause-resume/continue', { method: 'POST', headers: { host: '127.0.0.1:54601', 'x-dsh-pause-resume': '1' } })
  assert.equal(answer.status, 200)
  assert.equal(answer.value.outcome.continued, 1)
  seen = answer.value.pendingContinue
  assert.equal(seen.blocking, 1)
})

test('the continue press still needs the button header', async () => {
  const { call, ledger } = await mount()
  ledger.describe = () => ({ count: 1, attention: 0, busy: false, tasks: [] })
  let pressed = 0
  ledger.continueAll = async () => {
    pressed += 1
    return { status: 'accepted', attempted: 1, continued: 1, remaining: 0, attention: 0, results: [] }
  }
  const answer = await call('/dsh-pause-resume/continue', { method: 'POST', headers: { host: '127.0.0.1:54601' } })
  assert.equal(answer.status, 403)
  assert.equal(pressed, 0)
})
