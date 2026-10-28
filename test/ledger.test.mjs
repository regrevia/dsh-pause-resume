import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createLedger } from '../lib/ledger.js'

function home() {
  return mkdtempSync(join(tmpdir(), 'dsh-continue-test-'))
}

// The ledger settles a row before showing it. A test moves this clock instead of sleeping.
function rig(overrides = {}) {
  const dir = home()
  let clock = 1000
  const calls = { goal: [], session: [] }
  const status = () => overrides.status ?? { mounted: true, running: false, parent: null, origin: null, goal: null }
  const probe = {
    statusOf: () => status(),
    latestTurnEnd: async () => overrides.latest ?? null,
    continueGoal: async (row) => {
      calls.goal.push(row)
      return overrides.goal ?? { status: 'restored', detail: 'armed again' }
    },
    continueSession: async (row) => {
      calls.session.push(row)
      return overrides.session ?? { status: 'restored', detail: 'continued', continued: true, turn: row.turn, turnEnd: 'running' }
    },
  }
  const ledger = createLedger({ dir, probe, now: () => clock, log: () => {} })
  const end = (turn, kind, extra = {}) => ({ type: 'turn/end', seq: turn * 10, time: clock, data: { turn, reason: { kind, ...extra } } })
  const start = (turn) => ({ type: 'turn/start', seq: turn * 10 - 5, time: clock, data: { turn } })
  const title = (value) => ({ type: 'session/title', seq: 1, time: clock, data: { title: value, messageSeqs: [], source: 'model' } })
  const observe = (sessionId, event, meta = { parent: null, origin: null }) => ledger.observe(sessionId, event, meta)
  const push = (sessionId, event, meta) => {
    observe(sessionId, event, meta)
    clock += 2000
  }
  return { dir, ledger, calls, end, start, title, observe, push, advance: (ms) => { clock += ms }, state: () => ledger.describe(), reload: () => createLedger({ dir, probe, now: () => clock, log: () => {} }) }
}

test('a final error or max-tokens end becomes one row after it settles', () => {
  const r = rig()
  r.observe('s1', r.title('修复登录'))
  r.observe('s1', r.start(3))
  r.observe('s1', r.end(3, 'error', { error: { message: 'upstream 502', code: 'SERVER', status: 502 } }))
  assert.equal(r.state().count, 0, 'a row is not shown in the same instant it ended')
  r.advance(1600)
  const state = r.state()
  assert.equal(state.count, 1)
  assert.equal(state.tasks[0].sessionId, 's1')
  assert.equal(state.tasks[0].turn, 3)
  assert.equal(state.tasks[0].kind, 'error')
  assert.equal(state.tasks[0].title, '修复登录')
  assert.equal(state.tasks[0].status, 'waiting')

  r.push('s2', r.end(1, 'max-tokens'))
  assert.equal(r.state().count, 2)
  assert.equal(r.state().tasks[0].sessionId, 's2', 'newest first')
})

test('a deliberate end clears the row, and a later start clears work already picked up', () => {
  for (const kind of ['completed', 'aborted', 'interrupted', 'blocked']) {
    const r = rig()
    r.push('s1', r.end(1, 'error'))
    assert.equal(r.state().count, 1)
    r.push('s1', r.end(1, kind))
    assert.equal(r.state().count, 0, `${kind} is not resumable work`)
  }
  const r = rig()
  r.push('s1', r.end(1, 'error'))
  r.push('s1', r.start(2))
  assert.equal(r.state().count, 0, 'a newer turn is the person or queue taking over')
})

test('a child session is left to its parent and never becomes a row', () => {
  const r = rig()
  r.push('child', r.end(1, 'error'), { parent: 'root', origin: 'subagent' })
  assert.equal(r.state().count, 0)
})

test('a row survives a reload; a press interrupted by the restart comes back as a candidate', () => {
  const r = rig()
  r.push('s1', r.end(4, 'error'))
  writeFileSync(join(r.dir, 'continue.json'), JSON.stringify({ version: 1, rows: [{ sessionId: 's1', turn: 4, kind: 'error', status: 'running', at: 900 }] }))
  const next = createLedger({ dir: r.dir, probe: { statusOf: () => ({ running: false }) }, now: () => 9000, log: () => {} })
  const state = next.describe()
  assert.equal(state.count, 1)
  assert.equal(state.tasks[0].status, 'waiting')
  assert.equal(state.busy, false)
  rmSync(r.dir, { recursive: true, force: true })
})

test('a press drops rows a person already continued, and re-reads a newer failure', async () => {
  const r = rig({ latest: { end: { turn: 3, kind: 'completed' }, openTurn: null } })
  r.push('s1', r.end(3, 'error'))
  const answer = await r.ledger.continueAll()
  assert.equal(answer.attempted, 1)
  assert.equal(answer.continued, 0)
  assert.equal(r.calls.session.length, 0, 'no message is sent for work that already ended')
  assert.equal(r.state().count, 0)

  const open = rig({ latest: { end: null, openTurn: 5 } })
  open.push('s1', r.end(3, 'error'))
  assert.equal((await open.ledger.continueAll()).continued, 0)
  assert.equal(open.calls.session.length, 0, 'a turn still in flight is not resumed again')

  const newer = rig({
    latest: { end: { turn: 5, kind: 'error', seq: 50, failure: { code: 'SERVER' } }, openTurn: null },
    session: { status: 'restored', detail: 'continued', continued: true, turn: 5, turnEnd: 'running' },
  })
  newer.push('s1', newer.end(3, 'error'))
  assert.equal((await newer.ledger.continueAll()).continued, 1)
  assert.equal(newer.calls.session[0].turn, 5, 'the press continues the newest stop, not the stale one')
})

test('a running session is dropped without a message', async () => {
  const r = rig({ status: { mounted: true, running: true, parent: null, goal: null } })
  r.push('s1', r.end(2, 'error'))
  assert.equal((await r.ledger.continueAll()).continued, 0)
  assert.equal(r.calls.session.length, 0)
  assert.equal(r.state().count, 0)
})

test('an active but disarmed goal is re-armed, never also prompted', async () => {
  const r = rig({ status: { mounted: true, running: false, parent: null, goal: { id: 'g1', revision: 7, phase: 'active', activation: 'disarmed' } } })
  r.push('s1', r.end(2, 'error'))
  const answer = await r.ledger.continueAll()
  assert.equal(answer.continued, 1)
  assert.equal(r.calls.goal.length, 1)
  assert.equal(r.calls.goal[0].goalId, 'g1')
  assert.equal(r.calls.session.length, 0, 'a goal continuation is the only execution')
})

test('an armed goal, or a goal stopped on purpose, is not reopened', async () => {
  for (const goal of [
    { id: 'g1', revision: 7, phase: 'active', activation: 'armed' },
    { id: 'g1', revision: 7, phase: 'paused', activation: 'disarmed' },
    { id: 'g1', revision: 7, phase: 'complete', activation: 'disarmed' },
  ]) {
    const r = rig({ status: { mounted: true, running: false, parent: null, goal } })
    r.push('s1', r.end(2, 'error'))
    await r.ledger.continueAll()
    assert.equal(r.calls.goal.length, 0, `${goal.phase}/${goal.activation} is not an abnormal stop`)
    assert.equal(r.calls.session.length, 0)
  }
})

test('a failed press keeps the row for the next one, with no automatic retry', async () => {
  const r = rig({ session: { status: 'failed', detail: 'admission failed', continued: false } })
  r.push('s1', r.end(2, 'error'))
  const first = await r.ledger.continueAll()
  assert.equal(first.continued, 0)
  assert.equal(first.attention, 1)
  assert.equal(r.state().count, 1)
  assert.equal(r.state().tasks[0].status, 'attention')
  assert.equal(r.state().tasks[0].attempt, 1)
  assert.equal(r.calls.session.length, 1, 'exactly one attempt per press')
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(r.calls.session.length, 1, 'a failed press does not retry itself')
})

test('a continuation that stops again stays for the next press at its new turn', async () => {
  const r = rig({ session: { status: 'restored', detail: 'continued', continued: true, turn: 5, turnEnd: 'error' } })
  r.push('s1', r.end(2, 'error'))
  await r.ledger.continueAll()
  r.advance(1600)
  const state = r.state()
  assert.equal(state.count, 1)
  assert.equal(state.tasks[0].turn, 5)
  assert.equal(state.tasks[0].status, 'waiting')
})

test('one press is one batch; a second press while it runs is refused', async () => {
  const dir = home()
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const ledger = createLedger({
    dir,
    now: () => 9000,
    log: () => {},
    probe: {
      statusOf: () => ({ running: false, goal: null }),
      latestTurnEnd: async () => null,
      continueSession: async () => { await gate; return { status: 'restored', continued: true, turn: 1, turnEnd: 'running' } },
      continueGoal: async () => ({ status: 'skipped' }),
    },
  })
  ledger.observe('s1', { type: 'turn/end', seq: 9, time: 100, data: { turn: 1, reason: { kind: 'error' } } })
  const first = ledger.continueAll()
  const second = await ledger.continueAll()
  assert.equal(second.status, 'busy')
  assert.equal(second.attempted, 0)
  release()
  assert.equal((await first).continued, 1)
  rmSync(dir, { recursive: true, force: true })
})

test('a corrupt file loses no session and starts empty instead of throwing', () => {
  const dir = home()
  writeFileSync(join(dir, 'continue.json'), '{ not json')
  const ledger = createLedger({ dir, now: () => 9000, log: () => {}, probe: { statusOf: () => null } })
  assert.equal(ledger.describe().count, 0)
  assert.equal(readFileSync(join(dir, 'continue.json'), 'utf8'), '{ not json', 'reading never rewrites what it cannot understand')
  rmSync(dir, { recursive: true, force: true })
})
