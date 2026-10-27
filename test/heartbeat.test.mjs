import assert from 'node:assert/strict'
import * as nodeFs from 'node:fs'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createHeartbeat } from '../lib/heartbeat.js'

const dir = () => mkdtempSync(join(tmpdir(), 'dsh-pr-hb-'))
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const settle = () => sleep(0)
const beatPath = (root) => join(root, 'running.json')
const readBeat = (root) => JSON.parse(readFileSync(beatPath(root), 'utf8'))
const readBytes = (root) => readFileSync(beatPath(root), 'utf8')
const oldBeat = (root, over = {}) => writeFileSync(beatPath(root), JSON.stringify({ version: 2, bootId: 'old', updatedAt: 111, sessions: [{ sessionId: 's1' }], ...over }))

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

test('a heartbeat from another process is crash residue', async () => {
  const root = dir()
  oldBeat(root)
  const beat = createHeartbeat({ dir: root, bootId: 'new', listRunning: async () => [] })
  beat.start()
  assert.deepEqual(beat.residue, { sessions: [{ sessionId: 's1', lastTurn: null }], goals: [], at: 111 })
  await beat.flush()
  assert.equal(readBeat(root).bootId, 'new')
  assert.deepEqual(beat.residue.sessions, [{ sessionId: 's1', lastTurn: null }])
  beat.stop()
})

test('a non-numeric timestamp is residue without a time', () => {
  const root = dir()
  oldBeat(root, { updatedAt: 'then' })
  const beat = createHeartbeat({ dir: root, bootId: 'new', listRunning: async () => [] })
  beat.start()
  assert.deepEqual(beat.residue, { sessions: [{ sessionId: 's1', lastTurn: null }], goals: [], at: null })
  beat.stop()
})

test('no residue from an absent, empty or unreadable file', () => {
  for (const body of [null, '', '{', JSON.stringify({ version: 2, bootId: 'old', updatedAt: 1, sessions: [] })]) {
    const root = dir()
    if (body !== null) writeFileSync(beatPath(root), body)
    const beat = createHeartbeat({ dir: root, bootId: 'new', listRunning: async () => [] })
    beat.start()
    assert.equal(beat.residue, null)
    beat.stop()
  }
})

test('the same process reloading a plugin has no residue', () => {
  const root = dir()
  oldBeat(root, { bootId: 'same' })
  const beat = createHeartbeat({ dir: root, bootId: 'same', listRunning: async () => ['s1'] })
  beat.start()
  assert.equal(beat.residue, null)
  beat.stop()
})

test('the file records this boot and the current set', async () => {
  const root = dir()
  const beat = createHeartbeat({ dir: root, bootId: 'b', listRunning: async () => ['b', 'a', 'a'] })
  beat.start()
  await beat.flush()
  await settle()
  const written = readBeat(root)
  assert.equal(written.version, 4)
  assert.equal(written.bootId, 'b')
  assert.equal(typeof written.updatedAt, 'number')
  assert.deepEqual(written.sessions, [{ sessionId: 'a', lastTurn: null }, { sessionId: 'b', lastTurn: null }])
  assert.deepEqual(written.goals, [])
  beat.stop()
})

test('note coalesces a burst into one write', async () => {
  const root = dir()
  const { impl, counts } = countingFs()
  const beat = createHeartbeat({ dir: root, bootId: 'b', intervalMs: 60000, listRunning: async () => [], fs: impl })
  beat.start()
  await settle()
  await beat.flush()
  const before = counts.rename
  beat.note(['a'])
  beat.note(['a', 'b'])
  beat.note(['a', 'b', 'c'])
  assert.equal(counts.rename, before)
  await beat.flush()
  assert.equal(counts.rename, before + 1)
  assert.deepEqual(readBeat(root).sessions, [
    { sessionId: 'a', lastTurn: null },
    { sessionId: 'b', lastTurn: null },
    { sessionId: 'c', lastTurn: null },
  ])
  await sleep(250)
  assert.equal(counts.rename, before + 1)
  assert.equal(counts.open, counts.close)
  beat.stop()
})

test('a tick with the same set does not rewrite the file', async () => {
  const root = dir()
  const { impl, counts } = countingFs()
  const beat = createHeartbeat({ dir: root, bootId: 'b', intervalMs: 5, listRunning: async () => ['s1'], fs: impl })
  beat.start()
  await sleep(40)
  const writes = counts.rename
  const first = readBeat(root).updatedAt
  await sleep(40)
  assert.equal(counts.rename, writes)
  assert.equal(readBeat(root).updatedAt, first)
  assert.equal(counts.open, counts.close)
  beat.stop()
})

test('a failed write stays dirty and the next tick retries', async () => {
  const root = dir()
  const logs = []
  const { impl, counts } = countingFs((name) => name === 'writeSync')
  const beat = createHeartbeat({ dir: root, bootId: 'b', intervalMs: 5, listRunning: async () => ['s1'], fs: impl, log: (line) => logs.push(line) })
  beat.start()
  await sleep(40)
  assert.deepEqual(readBeat(root).sessions, [{ sessionId: 's1', lastTurn: null }])
  assert.equal(logs.length > 0, true)
  assert.equal(counts.open, counts.close)
  beat.stop()
})

test('a clean stop leaves the file and the residue in place', async () => {
  const root = dir()
  oldBeat(root)
  const beat = createHeartbeat({ dir: root, bootId: 'new', intervalMs: 5, listRunning: async () => ['s9'] })
  beat.start()
  await sleep(30)
  const before = readFileSync(beatPath(root), 'utf8')
  beat.stop()
  await sleep(30)
  assert.equal(readFileSync(beatPath(root), 'utf8'), before)
  assert.deepEqual(beat.residue, { sessions: [{ sessionId: 's1', lastTurn: null }], goals: [], at: 111 })
})

test('release clears the residue and records this process instead', async () => {
  const root = dir()
  oldBeat(root)
  const beat = createHeartbeat({ dir: root, bootId: 'new', intervalMs: 5, listRunning: async () => ['s9'] })
  beat.start()
  await sleep(30)
  assert.deepEqual(beat.residue.sessions, [{ sessionId: 's1', lastTurn: null }])
  beat.release()
  assert.equal(beat.residue, null)
  await settle()
  const written = readBeat(root)
  assert.equal(written.bootId, 'new')
  assert.deepEqual(written.sessions, [{ sessionId: 's9', lastTurn: null }])
  beat.stop()
})

test('a listing that throws keeps the previous set and is logged', async () => {
  const root = dir()
  const logs = []
  let calls = 0
  const beat = createHeartbeat({
    dir: root,
    bootId: 'b',
    intervalMs: 5,
    log: (line) => logs.push(line),
    listRunning: async () => {
      calls += 1
      if (calls > 1) throw new Error('agents unavailable')
      return ['s1']
    },
  })
  beat.start()
  await sleep(40)
  assert.deepEqual(readBeat(root).sessions, [{ sessionId: 's1', lastTurn: null }])
  assert.equal(logs.some((line) => line.includes('cannot list')), true)
  beat.stop()
})

test('flush answers false while the disk refuses and true once it works', async () => {
  const root = dir()
  const { impl, counts } = countingFs((name) => name === 'renameSync', false)
  const beat = createHeartbeat({ dir: root, bootId: 'b', listRunning: async () => ['s1'], fs: impl })
  beat.note(['s1'])
  assert.equal(await beat.flush(), false)
  assert.equal(counts.open, counts.close)
  beat.stop()

  const healthy = createHeartbeat({ dir: root, bootId: 'b2', listRunning: async () => ['s1'] })
  healthy.note(['s1'])
  assert.equal(await healthy.flush(), true)
  const written = readBeat(root)
  assert.equal(written.bootId, 'b2')
  assert.deepEqual(written.sessions, [{ sessionId: 's1', lastTurn: null }])
  healthy.stop()
})

test('armed goals are recorded next to the sessions and survive as residue', async () => {
  const root = dir()
  const goals = [
    { sessionId: 's1', goalId: 'g1', revision: 4 },
    { sessionId: 's2', goalId: 'g2', revision: 7 },
    { sessionId: 's1', goalId: 'g1', revision: 4 },
  ]
  const beat = createHeartbeat({ dir: root, bootId: 'b', listRunning: async () => ({ sessions: ['s1', 's2'], goals }) })
  beat.start()
  await beat.flush()
  const written = readBeat(root)
  assert.deepEqual(written.sessions, [{ sessionId: 's1', lastTurn: null }, { sessionId: 's2', lastTurn: null }])
  assert.deepEqual(written.goals, [
    { sessionId: 's1', goalId: 'g1', revision: 4 },
    { sessionId: 's2', goalId: 'g2', revision: 7 },
  ])
  beat.stop()

  const next = createHeartbeat({ dir: root, bootId: 'next', listRunning: async () => [] })
  next.start()
  assert.deepEqual(next.residue.goals, [
    { sessionId: 's1', goalId: 'g1', revision: 4 },
    { sessionId: 's2', goalId: 'g2', revision: 7 },
  ])
  next.stop()
})

test('goals alone are enough residue: a goal between rounds is still owed work', () => {
  const root = dir()
  oldBeat(root, { version: 3, sessions: [], goals: [{ sessionId: 's1', goalId: 'g1', revision: 2 }] })
  const beat = createHeartbeat({ dir: root, bootId: 'new', listRunning: async () => [] })
  beat.start()
  assert.deepEqual(beat.residue, { sessions: [], goals: [{ sessionId: 's1', goalId: 'g1', revision: 2 }], at: 111 })
  beat.stop()
})

test('a malformed goal row is dropped instead of poisoning the residue', async () => {
  const root = dir()
  const goals = [
    { sessionId: 's1', goalId: 'g1', revision: 3 },
    { sessionId: 's2', goalId: 'g2', revision: '3' },
    { sessionId: '', goalId: 'g3', revision: 3 },
    { sessionId: 's4', goalId: '', revision: 3 },
    { sessionId: 's5', goalId: 'g5' },
  ]
  const beat = createHeartbeat({ dir: root, bootId: 'b', listRunning: async () => ({ sessions: [], goals }) })
  beat.note({ sessions: [], goals })
  await beat.flush()
  assert.deepEqual(readBeat(root).goals, [{ sessionId: 's1', goalId: 'g1', revision: 3 }])
  beat.stop()
})

test('a legacy array lister still records sessions and no goals', async () => {
  const root = dir()
  oldBeat(root, { version: 3, sessions: [{ sessionId: 's9' }], goals: [{ sessionId: 's9', goalId: 'g9', revision: 1 }] })
  const beat = createHeartbeat({ dir: root, bootId: 'b', listRunning: async () => ['s1'] })
  beat.start()
  await beat.flush()
  const written = readBeat(root)
  assert.deepEqual(written.sessions, [{ sessionId: 's1', lastTurn: null }])
  assert.deepEqual(written.goals, [])
  beat.stop()
})

test('a v3 file with bare ids reads back with no turn', () => {
  const root = dir()
  writeFileSync(beatPath(root), JSON.stringify({ version: 3, bootId: 'old', updatedAt: 222, sessions: ['s2', 's1'], goals: [] }))
  const beat = createHeartbeat({ dir: root, bootId: 'new', listRunning: async () => [] })
  assert.deepEqual(beat.peek(), {
    sessions: [{ sessionId: 's1', lastTurn: null }, { sessionId: 's2', lastTurn: null }],
    goals: [],
    at: 222,
  })
  beat.stop()
})

test('a v4 file round-trips the turn numbers', async () => {
  const root = dir()
  const beat = createHeartbeat({ dir: root, bootId: 'b', listRunning: async () => [] })
  beat.note({
    sessions: [{ sessionId: 's2', lastTurn: null }, { sessionId: 's1', lastTurn: 4 }],
    goals: [{ sessionId: 's1', goalId: 'g1', revision: 2 }],
  })
  assert.equal(await beat.flush(), true)
  const written = readBeat(root)
  assert.equal(written.version, 4)
  assert.deepEqual(written.sessions, [{ sessionId: 's1', lastTurn: 4 }, { sessionId: 's2', lastTurn: null }])
  beat.stop()

  const next = createHeartbeat({ dir: root, bootId: 'next', listRunning: async () => [] })
  assert.deepEqual(next.peek(), {
    sessions: [{ sessionId: 's1', lastTurn: 4 }, { sessionId: 's2', lastTurn: null }],
    goals: [{ sessionId: 's1', goalId: 'g1', revision: 2 }],
    at: readBeat(root).updatedAt,
  })
  next.stop()
})

test('a legacy array input records rows with no turn and no goals', async () => {
  const root = dir()
  const beat = createHeartbeat({ dir: root, bootId: 'b', listRunning: async () => [] })
  assert.doesNotThrow(() => beat.note(['b', 'a']))
  await beat.flush()
  const written = readBeat(root)
  assert.equal(written.version, 4)
  assert.deepEqual(written.sessions, [{ sessionId: 'a', lastTurn: null }, { sessionId: 'b', lastTurn: null }])
  assert.deepEqual(written.goals, [])
  beat.stop()
})

test('duplicate ids collapse to the highest turn', async () => {
  const root = dir()
  const beat = createHeartbeat({ dir: root, bootId: 'b', listRunning: async () => [] })
  beat.note({
    sessions: [
      's1',
      { sessionId: 's1', lastTurn: 3 },
      { sessionId: 's1', lastTurn: 9 },
      { sessionId: 's1', lastTurn: 'later' },
      { sessionId: 's1', lastTurn: 2 },
      { sessionId: 's2', lastTurn: '7' },
      { sessionId: 's2' },
    ],
    goals: [],
  })
  await beat.flush()
  assert.deepEqual(readBeat(root).sessions, [{ sessionId: 's1', lastTurn: 9 }, { sessionId: 's2', lastTurn: null }])
  beat.stop()
})

test('an unreadable registry keeps the file byte-identical', async () => {
  const root = dir()
  const { impl, counts } = countingFs()
  const beat = createHeartbeat({ dir: root, bootId: 'b', intervalMs: 60000, listRunning: async () => [], fs: impl })
  beat.note({
    sessions: [{ sessionId: 's1', lastTurn: 5 }, { sessionId: 's2', lastTurn: null }],
    goals: [{ sessionId: 's1', goalId: 'g1', revision: 3 }],
  })
  assert.equal(await beat.flush(), true)
  const bytes = readBytes(root)
  const renames = counts.rename
  assert.doesNotThrow(() => beat.note({ sessions: [], goals: [], readable: false }))
  assert.equal(await beat.flush(), true)
  assert.equal(readBytes(root), bytes)
  assert.equal(counts.rename, renames)
  assert.equal(counts.open, counts.close)
  beat.stop()
})

test('an unreadable registry does not erase the rows already recorded', async () => {
  const root = dir()
  const { impl, counts } = countingFs((name) => name === 'renameSync')
  const beat = createHeartbeat({ dir: root, bootId: 'b', intervalMs: 60000, listRunning: async () => [], fs: impl })
  beat.note({ sessions: [{ sessionId: 's1', lastTurn: 5 }], goals: [] })
  // The first rename is refused, so the rows exist only in memory.
  assert.equal(await beat.flush(), false)
  beat.note({ sessions: [], goals: [], readable: false })
  assert.equal(await beat.flush(), true)
  assert.deepEqual(readBeat(root).sessions, [{ sessionId: 's1', lastTurn: 5 }])
  assert.equal(counts.open, counts.close)
  beat.stop()
})

test('rows are recorded again once the registry is readable', async () => {
  const root = dir()
  let value = { sessions: [{ sessionId: 's1', lastTurn: 2 }], goals: [], readable: true }
  const beat = createHeartbeat({ dir: root, bootId: 'b', intervalMs: 60000, listRunning: async () => value })
  beat.start()
  await settle()
  await beat.flush()
  const bytes = readBytes(root)
  value = { sessions: [], goals: [], readable: false }
  beat.note(value)
  await beat.flush()
  assert.equal(readBytes(root), bytes)
  value = { sessions: [{ sessionId: 's1', lastTurn: 6 }], goals: [], readable: true }
  beat.note(value)
  assert.equal(await beat.flush(), true)
  const written = readBeat(root)
  assert.equal(written.version, 4)
  assert.deepEqual(written.sessions, [{ sessionId: 's1', lastTurn: 6 }])
  beat.stop()
})

test('a v4 file from another boot is residue, this boot own file is not', () => {
  const root = dir()
  writeFileSync(beatPath(root), JSON.stringify({ version: 4, bootId: 'dead', updatedAt: 333, sessions: [{ sessionId: 's1', lastTurn: 8 }], goals: [] }))
  const other = createHeartbeat({ dir: root, bootId: 'new', listRunning: async () => [] })
  assert.deepEqual(other.peek(), { sessions: [{ sessionId: 's1', lastTurn: 8 }], goals: [], at: 333 })
  const same = createHeartbeat({ dir: root, bootId: 'dead', listRunning: async () => [] })
  assert.equal(same.peek(), null)
})

test('a child route survives the crash record so it can be restored through its parent', async () => {
  const root = dir()
  oldBeat(root, { sessions: [{ sessionId: 's2', lastTurn: 3, parent: 's1' }, { sessionId: 's1', lastTurn: 1 }] })
  const beat = createHeartbeat({ dir: root, bootId: 'new', listRunning: async () => [{ sessionId: 's1', lastTurn: 1 }, { sessionId: 's2', lastTurn: 3, parent: 's1' }] })
  const residue = beat.peek()
  assert.deepEqual(residue.sessions, [{ sessionId: 's1', lastTurn: 1 }, { sessionId: 's2', lastTurn: 3, parent: 's1' }])
  beat.start()
  await sleep(30)
  const written = readBeat(root)
  assert.deepEqual(written.sessions, [{ sessionId: 's1', lastTurn: 1 }, { sessionId: 's2', lastTurn: 3, parent: 's1' }])
})
