import assert from 'node:assert/strict'
import * as nodeFs from 'node:fs'
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createStore } from '../lib/snapshot.js'

const dir = () => mkdtempSync(join(tmpdir(), 'dsh-pr-'))
const draft = (over = {}) => ({ planId: 'p1', status: 'paused', createdAt: 'now', sessions: [{ sessionId: 's1' }], goals: [], schedules: [], jobs: [], terminals: [], ...over })

/**
 * An fs-like object that counts the fds opened and closed, and can fail one call on purpose. A
 * failed call is injected before the real one, so a wrapper that throws the same way as a disk
 * error is enough to exercise every cleanup path.
 */
function countingFs(failOn = () => false, failOnce = true) {
  const counts = { open: 0, close: 0, rename: 0 }
  let tripped = false
  const wrap = (name, run) => (...args) => {
    if (tripped === false && failOn(name, args) === true) {
      if (failOnce) tripped = true
      throw new Error(`injected ${name} failure`)
    }
    if (name === 'openSync') counts.open += 1
    if (name === 'closeSync') counts.close += 1
    if (name === 'renameSync') counts.rename += 1
    return run(...args)
  }
  const impl = { ...nodeFs }
  for (const name of ['openSync', 'closeSync', 'readFileSync', 'writeSync', 'fsyncSync', 'renameSync', 'mkdirSync', 'rmSync', 'existsSync']) {
    impl[name] = wrap(name, nodeFs[name])
  }
  return { impl, counts }
}

test('a written plan reads back and owns the version field', () => {
  const root = dir()
  const store = createStore(root)
  assert.equal(store.dir, root)
  assert.equal(store.snapshotPath, join(root, 'snapshot.json'))
  const written = store.write(draft({ version: 1 }))
  assert.equal(written.version, 3)
  assert.equal(written.planId, 'p1')
  assert.equal(store.read().status, 'paused')
  assert.equal(store.read().sessions[0].sessionId, 's1')
  assert.equal(JSON.parse(readFileSync(store.snapshotPath, 'utf8')).version, 3)
  assert.equal(store.hasSnapshot(), true)
  assert.deepEqual(readdirSync(root), ['snapshot.json'])
})

test('an interrupted pause is still a plan', () => {
  const store = createStore(dir())
  store.write(draft({ status: 'pausing' }))
  assert.equal(store.read().status, 'pausing')
})

test('a missing or broken plan is null and never throws', () => {
  const root = dir()
  const store = createStore(root)
  assert.equal(store.read(), null)
  assert.equal(store.hasSnapshot(), false)
  store.write(draft())
  for (const body of ['{"version":3,', 'null', '[]', JSON.stringify({ version: 3, status: 'idle' }), JSON.stringify({ version: 4, status: 'paused' })]) {
    writeFileSync(store.snapshotPath, body)
    assert.equal(store.read(), null)
  }
})

test('a plan outside the safe filename set is still journaled', () => {
  const store = createStore(dir())
  assert.equal(store.appendJournal('../evil/p1', 's:s1'), true)
  assert.equal(store.readJournal('../evil/p1').has('s:s1'), true)
  assert.equal(readdirSync(join(store.dir, 'journal')).length, 1)
})

test('a failed write answers null, removes its temp file and closes its fd', () => {
  for (const target of ['openSync', 'writeSync', 'fsyncSync', 'renameSync']) {
    const root = dir()
    const { impl, counts } = countingFs((name) => name === target)
    const store = createStore(root, { fs: impl })
    assert.equal(store.write(draft()), null, target)
    assert.equal(store.read(), null, target)
    assert.equal(store.hasSnapshot(), false, target)
    assert.equal(counts.open, counts.close, target)
    assert.deepEqual(readdirSync(root), [], target)
  }
})

test('each write uses its own temp file', () => {
  const root = dir()
  const seen = []
  const { impl } = countingFs((name, args) => {
    if (name === 'openSync' && args[1] === 'w') seen.push(String(args[0]))
    return false
  })
  const store = createStore(root, { fs: impl })
  store.write(draft())
  store.write(draft())
  assert.equal(seen.length, 2)
  assert.notEqual(seen[0], seen[1])
  assert.equal(seen[0].includes(String(process.pid)), true)
})

test('a hundred journal appends read back and close every fd', () => {
  const root = dir()
  const { impl, counts } = countingFs()
  const store = createStore(root, { fs: impl })
  for (let index = 0; index < 100; index += 1) assert.equal(store.appendJournal('p1', `s:${index}`), true)
  const done = store.readJournal('p1')
  assert.equal(done.size, 100)
  assert.equal(done.has('s:99'), true)
  assert.equal(counts.open, counts.close)
})

test('the journal survives a torn last line and clears', () => {
  const store = createStore(dir())
  assert.equal(store.readJournal('p1').size, 0)
  store.appendJournal('p1', 's:s1')
  store.appendJournal('p1', 'g:g1')
  writeFileSync(join(store.dir, 'journal', 'p1.jsonl'), `${readFileSync(join(store.dir, 'journal', 'p1.jsonl'), 'utf8')}{"k":"s:s2`)
  assert.deepEqual([...store.readJournal('p1').keys()], ['s:s1', 'g:g1'])
  store.clearJournal('p1')
  assert.equal(store.readJournal('p1').size, 0)
})

test('a journal append that cannot write answers false and closes its fd', () => {
  const { impl, counts } = countingFs((name) => name === 'writeSync')
  const store = createStore(dir(), { fs: impl })
  assert.equal(store.appendJournal('p1', 's:s1'), false)
  assert.equal(counts.open, counts.close)
})

test('consume archives first, then removes the plan it archived', () => {
  const root = dir()
  const store = createStore(root, { now: () => 1000 })
  store.write(draft())
  store.appendJournal('p1', 's:s1')
  const summary = { restored: ['session s1'], skipped: [], failed: [], jobs: 0 }
  const outcome = store.consume(store.read(), summary)
  assert.equal(outcome.ok, true)
  assert.equal(outcome.archivePath, join(root, 'restores', 'p1.json'))
  assert.equal(store.hasSnapshot(), false)
  assert.equal(store.read(), null)
  const record = JSON.parse(readFileSync(outcome.archivePath, 'utf8'))
  assert.equal(record.status, 'restored')
  assert.equal(record.planId, 'p1')
  assert.equal(record.summary.restored[0], 'session s1')
  assert.equal(record.restoredAt, new Date(1000).toISOString())
  assert.equal(store.lastRestore().planId, 'p1')
  assert.equal(store.lastRestore().status, 'restored')
  assert.equal(store.clearResult(), true)
  assert.equal(store.lastRestore(), null)
  assert.equal(store.readJournal('p1').size, 0)
})

test('a failed archive keeps the plan and the journal', () => {
  const root = dir()
  const { impl, counts } = countingFs((name, args) => name === 'openSync' && String(args[0]).includes('restores'))
  const store = createStore(root, { fs: impl })
  store.write(draft())
  store.appendJournal('p1', 's:s1')
  const outcome = store.consume(store.read(), { restored: ['session s1'], skipped: [], failed: [], jobs: 0 })
  assert.deepEqual(outcome, { ok: false, archivePath: null, published: false })
  assert.equal(store.hasSnapshot(), true)
  assert.equal(store.read().planId, 'p1')
  assert.equal(store.lastRestore(), null)
  assert.equal(store.readJournal('p1').size, 1)
  assert.equal(counts.open, counts.close)
})

test('consume never removes a newer plan', () => {
  const root = dir()
  const store = createStore(root)
  const older = store.write(draft({ planId: 'a' }))
  store.write(draft({ planId: 'b' }))
  const outcome = store.consume(older, { restored: [], skipped: [], failed: [], jobs: 0 })
  assert.equal(outcome.ok, true)
  assert.equal(store.hasSnapshot(), true)
  assert.equal(store.read().planId, 'b')
  assert.equal(store.lastRestore().planId, 'a')
})

test('a directory that cannot be created answers null instead of throwing', () => {
  const store = createStore('/dev/null/nope')
  assert.equal(store.write(draft()), null)
  assert.equal(store.read(), null)
  assert.equal(store.hasSnapshot(), false)
  assert.equal(store.appendJournal('p1', 'k'), false)
  assert.equal(store.readJournal('p1').size, 0)
  assert.equal(store.lastRestore(), null)
  assert.deepEqual(store.consume(draft(), null), { ok: false, archivePath: null, published: false })
})

test('a version 1 plan is migrated conservatively instead of ignored', () => {
  const root = dir()
  writeFileSync(join(root, 'snapshot.json'), JSON.stringify({ version: 1, status: 'paused', sessions: [{ sessionId: 's1', running: true }], goals: [{ sessionId: 's1', goalId: 'g1' }] }))
  const store = createStore(root)
  const plan = store.read()
  assert.equal(plan.source, 'legacy')
  assert.equal(plan.planId.startsWith('legacy-'), true)
  assert.equal(plan.sessions[0].running, false)
  assert.equal(plan.goals[0].revision, null)
  assert.equal(plan.attention.length, 1)
})

test('the crash plan is durable before anything else reads the heartbeat', () => {
  const root = dir()
  const store = createStore(root)
  const crashed = { version: 3, planId: 'crash-1', source: 'crash', status: 'paused', sessions: [{ sessionId: 's1' }], goals: [], jobs: [], attention: [] }
  assert.equal(store.writePending(crashed).planId, 'crash-1')
  const again = createStore(root)
  assert.equal(again.readPending().planId, 'crash-1')
  assert.equal(again.read(), null)
})

test('a journal row records the boot that wrote it', () => {
  const store = createStore(dir())
  store.appendJournal('p1', 's:s1', 'restored', 'boot-a')
  const row = store.readJournal('p1').get('s:s1')
  assert.equal(row.status, 'restored')
  assert.equal(row.boot, 'boot-a')
})

test('every legal intent survives a real file round trip and is not downgraded', () => {
  const root = dir()
  const intents = ['continue', 'mount', 'unknown', 'skip']
  const sessions = intents.map((intent, index) => ({
    sessionId: `s${index}`,
    intent,
    running: intent === 'continue',
    epoch: index,
    lastTurn: 10 + index,
    continuedTurn: 20 + index,
  }))
  createStore(root).write(draft({ sessions }))
  const first = createStore(root).read()
  assert.deepEqual(first.sessions.map((row) => row.intent), intents)
  // Writing the normalized plan again is where an unknown/skip row used to turn into `mount`.
  assert.notEqual(createStore(root).write(first), null)
  const second = createStore(root).read()
  assert.deepEqual(second.sessions.map((row) => ({
    intent: row.intent,
    running: row.running,
    epoch: row.epoch,
    lastTurn: row.lastTurn,
    continuedTurn: row.continuedTurn,
  })), intents.map((intent, index) => ({
    intent,
    running: intent === 'continue',
    epoch: index,
    lastTurn: 10 + index,
    continuedTurn: 20 + index,
  })))
})

test('an explicit intent outranks the old running flag', () => {
  const store = createStore(dir())
  store.write(draft({
    sessions: [
      { sessionId: 's1', intent: 'unknown', running: true, epoch: 0 },
      { sessionId: 's2', intent: 'mount', running: true, epoch: 0 },
      { sessionId: 's3', running: false, epoch: 0 },
    ],
  }))
  const rows = store.read().sessions
  assert.equal(rows[0].intent, 'unknown')
  assert.equal(rows[0].running, false)
  assert.equal(rows[1].intent, 'mount')
  assert.equal(rows[1].running, false)
  // Only a row with no intent at all may fall back to the pre-intent convention.
  assert.equal(rows[2].intent, 'mount')
})

test('an intent this build does not know stays unknown with its old value kept', () => {
  const store = createStore(dir())
  store.write(draft({ sessions: [{ sessionId: 's1', intent: 'await-style', running: true }] }))
  const row = store.read().sessions[0]
  assert.equal(row.intent, 'unknown')
  assert.equal(row.running, false)
  assert.equal(row.legacyIntent, 'await-style')
})

test('a failed rewrite leaves the last complete intent record readable', () => {
  const root = dir()
  const realWrite = nodeFs.writeSync
  let failing = false
  const impl = { ...nodeFs, writeSync: (...args) => {
    if (failing) throw new Error('injected write failure')
    return realWrite(...args)
  } }
  const store = createStore(root, { fs: impl })
  assert.notEqual(store.write(draft({ sessions: [{ sessionId: 's1', intent: 'unknown', epoch: 2 }] })), null)
  failing = true
  assert.equal(store.write(draft({ sessions: [{ sessionId: 's1', intent: 'mount', epoch: 0 }] })), null)
  const kept = createStore(root).read()
  assert.equal(kept.sessions[0].intent, 'unknown')
  assert.equal(kept.sessions[0].epoch, 2)
})


test('a 0.2.x plan is migrated from its running flag, and a migrated read is stable', () => {
  const root = dir()
  writeFileSync(join(root, 'snapshot.json'), JSON.stringify({
    version: 2,
    planId: 'p2',
    status: 'partial',
    createdAt: 'then',
    sessions: [
      { sessionId: 's1', running: true, lastTurn: 3, retry: 2 },
      { sessionId: 's2', running: false },
      { sessionId: 's3' },
    ],
    goals: [{ sessionId: 's1', goalId: 'g1', revision: 7 }],
    jobs: [{ id: 'j1', detail: 'stopped, not restarted' }],
    attention: [{ kind: 'job', id: 'j1', detail: 'stopped' }],
  }))
  const store = createStore(root)
  const first = store.read()
  assert.equal(first.version, 3)
  assert.equal(first.status, 'partial')
  assert.equal(first.planId, 'p2')
  // The old flag is the only intent signal a 0.2.x plan has: a stopped turn continues, a parked
  // session is only mounted, and a row that never declared either is not promoted to a turn.
  assert.deepEqual(first.sessions.map((row) => [row.intent, row.running]), [['continue', true], ['mount', false], ['mount', false]])
  assert.equal(first.sessions[0].epoch, 0)
  // A goal from before the armed-revision proof is reported, never resumed: this read must not
  // invent the proof the old release never wrote.
  assert.equal(first.goals[0].revision, 7)
  assert.equal(first.goals[0].armedRevision, null)
  assert.equal(first.sessions[0].retry, 2)
  assert.deepEqual(createStore(root).read(), first)
})

test('the operation metadata a restore needs survives a write, read and rewrite unchanged', () => {
  const root = dir()
  const store = createStore(root)
  const plan = {
    planId: 'p3',
    status: 'paused',
    createdAt: 'now',
    source: 'pause',
    sessions: [{
      sessionId: 's1',
      intent: 'continue',
      epoch: 4,
      running: true,
      lastTurn: 5,
      continuedTurn: 5,
      admittedRequest: 'req-9',
      admittedEpoch: 4,
      retry: 2,
      note: 'kept',
    }, {
      sessionId: 's2',
      intent: 'mount',
      epoch: 0,
      running: false,
      lastTurn: null,
      pendingRestore: { expect: 6, at: 'now' },
    }],
    goals: [{
      sessionId: 's1',
      goalId: 'g1',
      revision: 9,
      armedRevision: 7,
      pendingRestore: { expect: 9, at: 'now' },
      retry: 1,
    }],
    jobs: [{ id: 'j1', status: 'stopped' }],
    attention: [],
    extra: { keep: true },
  }
  assert.equal(store.write(plan).version, 3)
  const read = createStore(root).read()
  const session = read.sessions.find((row) => row.sessionId === 's1')
  assert.equal(session.epoch, 4)
  assert.equal(session.continuedTurn, 5)
  assert.equal(session.admittedRequest, 'req-9')
  assert.equal(session.admittedEpoch, 4)
  assert.equal(session.retry, 2)
  assert.equal(session.note, 'kept')
  const mounted = read.sessions.find((row) => row.sessionId === 's2')
  assert.equal(mounted.intent, 'mount')
  assert.deepEqual(mounted.pendingRestore, { expect: 6, at: 'now' })
  assert.equal(read.goals[0].revision, 9)
  assert.equal(read.goals[0].armedRevision, 7)
  assert.deepEqual(read.goals[0].pendingRestore, { expect: 9, at: 'now' })
  assert.deepEqual(read.extra, { keep: true })
  // A second pass must not change what the first read already normalized, or every boot would
  // rewrite the plan and throw away its history.
  store.write(read)
  assert.deepEqual(createStore(root).read(), read)
})

test('a legacy plan keeps one journal name for every read of the same file', () => {
  const root = dir()
  const path = join(root, 'snapshot.json')
  writeFileSync(path, JSON.stringify({ version: 1, status: 'paused', sessions: [{ sessionId: 's1', running: true }], goals: [] }))
  const store = createStore(root)
  const first = store.read()
  const second = createStore(root).read()
  assert.equal(first.planId, second.planId)
  assert.equal(first.planId.startsWith('legacy-'), true)
  assert.equal(store.appendJournal(first.planId, 's:s1', 'restored', 'boot-a'), true)
  assert.equal(store.readJournal(second.planId).has('s:s1'), true)
})
