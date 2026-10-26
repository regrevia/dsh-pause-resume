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
  assert.deepEqual(beat.residue, { sessions: [{ sessionId: 's1' }], at: 111 })
  await beat.flush()
  assert.equal(readBeat(root).bootId, 'new')
  assert.deepEqual(beat.residue.sessions, [{ sessionId: 's1' }])
  beat.stop()
})

test('a non-numeric timestamp is residue without a time', () => {
  const root = dir()
  oldBeat(root, { updatedAt: 'then' })
  const beat = createHeartbeat({ dir: root, bootId: 'new', listRunning: async () => [] })
  beat.start()
  assert.deepEqual(beat.residue, { sessions: [{ sessionId: 's1' }], at: null })
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
  assert.equal(written.version, 2)
  assert.equal(written.bootId, 'b')
  assert.equal(typeof written.updatedAt, 'number')
  assert.deepEqual(written.sessions, [{ sessionId: 'a' }, { sessionId: 'b' }])
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
  assert.deepEqual(readBeat(root).sessions, [{ sessionId: 'a' }, { sessionId: 'b' }, { sessionId: 'c' }])
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
  assert.deepEqual(readBeat(root).sessions, [{ sessionId: 's1' }])
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
  assert.deepEqual(beat.residue, { sessions: [{ sessionId: 's1' }], at: 111 })
})

test('release clears the residue and records this process instead', async () => {
  const root = dir()
  oldBeat(root)
  const beat = createHeartbeat({ dir: root, bootId: 'new', intervalMs: 5, listRunning: async () => ['s9'] })
  beat.start()
  await sleep(30)
  assert.deepEqual(beat.residue.sessions, [{ sessionId: 's1' }])
  beat.release()
  assert.equal(beat.residue, null)
  await settle()
  const written = readBeat(root)
  assert.equal(written.bootId, 'new')
  assert.deepEqual(written.sessions, [{ sessionId: 's9' }])
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
  assert.deepEqual(readBeat(root).sessions, [{ sessionId: 's1' }])
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
  assert.deepEqual(written.sessions, [{ sessionId: 's1' }])
  healthy.stop()
})
