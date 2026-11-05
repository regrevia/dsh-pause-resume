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
  return { render, module }
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
  // A pause asks for a wrap-up first; the button says what it is waiting for, not that it is busy.
  assert.equal(button.props['aria-label'], 'Wrapping up')
  await button.props.onClick()
  assert.deepEqual(calls.map((call) => `${call.method} ${call.url}`), ['POST /dsh-pause-resume/pause'])
})

const wrapUp = (timedOut, completed) => ({ outcome: { wrapUp: { windowMs: 3000, steered: [], completed, timedOut, unavailable: null } } })

test('a pause that cancelled what did not finish says the work to continue is saved', () => {
  const { module } = harness({ calls: [], answer: IDLE })
  assert.equal(module.receiptOf(wrapUp(['s1'], [])), 'Paused. What to continue is saved.')
})

test('the receipt stays off unless a turn actually had to be cancelled', () => {
  const { module } = harness({ calls: [], answer: IDLE })
  // Everything wrapped up inside the window: the plan is complete, nothing was cancelled.
  assert.equal(module.receiptOf(wrapUp([], ['s1'])), null)
  assert.equal(module.receiptOf(wrapUp(['s1'], ['s2'])), null)
  // An older release has no `outcome` at all, and a malformed one must not throw into the render.
  assert.equal(module.receiptOf(IDLE), null)
  assert.equal(module.receiptOf({ outcome: { wrapUp: null } }), null)
  assert.equal(module.receiptOf({ outcome: { wrapUp: { timedOut: 's1' } } }), null)
  assert.equal(module.receiptOf({}), null)
})

const wrapUpAtTop = (timedOut, completed) => ({ wrapUp: { windowMs: 3000, steered: [], completed, timedOut, unavailable: null } })

test('a receipt also comes from the top-level wrapUp a restart reports', () => {
  const { module } = harness({ calls: [], answer: IDLE })
  // A plan re-read from disk has no `outcome` yet, only the top-level pause result.
  assert.equal(module.receiptOf(wrapUpAtTop(['s1'], [])), 'Paused. What to continue is saved.')
  assert.equal(module.receiptOf(wrapUpAtTop([], ['s1'])), null)
})

test('when the two disagree, the top-level wrapUp is the one that wins', () => {
  const { module } = harness({ calls: [], answer: IDLE })
  // Disk says a turn had to be cancelled; a stale `outcome` says everything finished.
  assert.equal(module.receiptOf({ ...wrapUpAtTop(['s1'], []), ...wrapUp([], ['s1']) }), 'Paused. What to continue is saved.')
  // And the other way round: disk says nothing was cancelled, so no receipt.
  assert.equal(module.receiptOf({ ...wrapUpAtTop([], ['s1']), ...wrapUp(['s1'], []) }), null)
})

test('the receipt is the tooltip once a pause finished, and a continue press still wins', () => {
  const { render } = harness({ calls: [], answer: IDLE })
  const paused = { ...IDLE, phase: 'paused', action: 'resume', ...wrapUp(['s1'], []) }
  assert.equal(render([paused, false, false]).props.title, 'Resume · Paused. What to continue is saved.')
  const cont = { ...IDLE, action: 'continue', pendingContinue: { count: 2, attention: 0 }, ...wrapUp(['s1'], []) }
  assert.equal(render([cont, false, false]).props.title, 'Continue unfinished work · 2 tasks stopped, press to continue')
})

test('a transcript too large to restore automatically asks to be opened by hand', () => {
  const { render, module } = harness({ calls: [], answer: IDLE })
  const manual = {
    ...IDLE,
    action: 'resume',
    error: 'restore-partial',
    scheduling: { deferred: [{ sessionId: 'a', manual: true, reason: 'transcript is too large to restore here' }], needsHand: 1, restartRecommended: null },
  }
  // Pressing again re-reads the same file and dies the same way; a restart mounts it again. The mark
  // is the only way the button can say that, because the header has room for one 28px glyph.
  assert.equal(module.heldOf(manual), true, 'a session waiting to be opened by hand is marked')
  assert.equal(module.heldOf({ ...manual, scheduling: { deferred: [], needsHand: 0, restartRecommended: null } }), false)
  const held = render([manual, false, false])
  assert.equal(held.props.style.width, 28)
  assert.equal(JSON.stringify(held.children).includes('borderRadius'), true, 'the mark is a dot')
  assert.ok(held.props.title.includes('Too large to restore automatically'), 'the tooltip says why pressing cannot help')
})

test('a restore the heap refused is marked on the button, never beside it', () => {
  const { render, module } = harness({ calls: [], answer: IDLE })
  const blocked = {
    ...IDLE,
    action: 'resume',
    error: 'restore-blocked-heap',
    scheduling: { deferred: [{ sessionId: 'a' }], restartRecommended: { at: '2026-01-01T00:00:00.000Z', usedMB: 3900, limitMB: 4000 } },
  }
  // The header gives a control 28px: no sentence may be painted there or next to it, or the row
  // shifts and the button covers its neighbours. A dot marks the state; the tooltip carries the words.
  assert.equal(module.heldOf(blocked), true)
  assert.equal(module.heldOf(IDLE), false)
  const held = render([blocked, false, false])
  assert.equal(held.type, 'button', 'the header holds one control and nothing beside it')
  assert.equal(held.props.style.width, 28, 'the control keeps its box, so the row cannot move')
  assert.equal(held.props['aria-label'], 'Resume', 'the control is still the control')
  const box = held.children[0]
  assert.equal(Array.isArray(box), true, 'the button holds its glyph and mark together')
  assert.equal(box.length, 2, 'the glyph and the mark, no text')
  assert.equal(JSON.stringify(box[0]).includes('svg'), true, 'the glyph keeps its own box')
  assert.equal(box[1].props.style.borderRadius, 3, 'the mark is a dot, not a label')
  assert.equal(typeof box[1].props.children, 'undefined', 'the dot has no words in it')
  assert.ok(held.props.title.includes('Restart to continue what was held back'), 'the full reason is one hover away')
  // Nothing held back: the button alone, with no mark.
  const plain = render([IDLE, false, false])
  assert.equal(plain.type, 'button')
  assert.equal(JSON.stringify(plain.children).includes('borderRadius'), false, 'no mark without a held row')
})
