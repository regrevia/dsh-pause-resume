// The button is the only way back into a paused harness, so its press rules are tested against the
// real client module instead of a copy of them: while the Host reports `pause` (a restore is
// running), the same page that started the restore must still be able to stop it.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const SOURCE = readFileSync(join(here, '..', 'client.js'), 'utf8')

const untimed = (fn, ms) => {
  const timer = setTimeout(fn, ms)
  timer.unref?.()
  return timer
}

function harness({ calls, answer }) {
  const def = { factory: null }
  const document = {
    visibilityState: 'visible',
    addEventListener() {},
    removeEventListener() {},
    getElementById() { return null },
    createElement() { return { style: {}, setAttribute() {} } },
    head: { appendChild() {} },
  }
  const window = { __ModuleLoader__: { load(module) { def.id = module.id; def.factory = module.factory } } }
  const React = {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    useState: null,
    useRef: null,
    useCallback: null,
    useEffect: null,
  }
  const fetch = (url, options) => {
    calls.push({ url, method: options?.method ?? 'GET' })
    if (url.endsWith('/resume')) return new Promise(() => {})
    return Promise.resolve({ ok: true, json: async () => answer })
  }
  // eslint-disable-next-line no-new-func
  const load = new Function('window', 'navigator', 'document', 'fetch', 'setTimeout', 'clearTimeout', SOURCE)
  load(window, { language: 'en' }, document, fetch, untimed, clearTimeout)
  const module = def.factory(() => React)
  let Button = null
  module.apply({ slots: { inject(_slot, add) { add() }, register(_config, component) { Button = component } } })
  assert.equal(typeof Button, 'function')

  // Hooks are replayed per render: React state is given, refs persist the way a real component's do.
  const refs = []
  let plan = null
  let index = 0
  React.useState = () => {
    const value = plan.states[index]
    index += 1
    return [value, () => {}]
  }
  React.useRef = (initial) => {
    if (refs[index] === undefined) refs[index] = { current: initial }
    const ref = refs[index]
    index += 1
    return ref
  }
  React.useCallback = (fn) => { index += 1; return fn }
  React.useEffect = () => { index += 1 }
  const render = (states) => {
    plan = { states }
    index = 0
    return Button()
  }
  return { render }
}

const IDLE = { phase: 'idle', action: 'none', source: null, outstanding: 0, attention: 0, live: {}, counts: {} }
const RESUMING = { ...IDLE, phase: 'resuming', action: 'pause' }

test('the page that started a restore can stop it while the Host reports pause', async () => {
  const calls = []
  const { render } = harness({ calls, answer: RESUMING })

  // Press resume: the request stays open for the whole restore.
  render([{ ...IDLE, action: 'resume' }, false, false]).props.onClick()
  // The Host now says the restore is running: same page, same open request.
  const button = render([RESUMING, false, true])

  assert.equal(button.props.disabled, false)
  assert.equal(button.props['aria-busy'], false)
  assert.equal(button.props['aria-label'], 'Pause')

  await button.props.onClick()
  assert.deepEqual(calls.map((call) => `${call.method} ${call.url}`), [
    'POST /dsh-pause-resume/resume',
    'POST /dsh-pause-resume/pause',
  ])
})

test('a restore press still spins and cannot be pressed again while it is merely resuming itself', () => {
  const calls = []
  const { render } = harness({ calls, answer: IDLE })
  const button = render([{ ...IDLE, action: 'resume' }, false, true])
  assert.equal(button.props['aria-busy'], true)
  assert.equal(button.props['aria-label'], 'Working')
  button.props.onClick()
  assert.deepEqual(calls, [])
})

test('a pause press in flight is not interrupted by pressing pause again', async () => {
  const calls = []
  const { render } = harness({ calls, answer: { ...IDLE, action: 'busy' } })
  render([{ ...IDLE, action: 'pause' }, false, false]).props.onClick()
  const button = render([{ ...IDLE, phase: 'pausing', action: 'busy' }, false, true])
  assert.equal(button.props['aria-busy'], true)
  await button.props.onClick()
  assert.deepEqual(calls.map((call) => `${call.method} ${call.url}`), ['POST /dsh-pause-resume/pause'])
})
