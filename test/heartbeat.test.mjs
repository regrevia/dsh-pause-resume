import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createHeartbeat } from '../lib/heartbeat.js'

const dir = () => mkdtempSync(join(tmpdir(), 'dsh-pr-hb-'))
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

test('a heartbeat from a previous process is crash residue', () => {
  const root = dir()
  writeFileSync(join(root, 'running.json'), JSON.stringify({ version: 1, bootId: 'old', updatedAt: 1, sessions: [{ sessionId: 's1' }] }))
  const beat = createHeartbeat({ dir: root, bootId: 'new', listRunning: async () => [] })
  assert.equal(beat.start(), undefined)
  assert.deepEqual(beat.residue.sessions, [{ sessionId: 's1' }])
})

test('the same process reloading a plugin has no residue', () => {
  const root = dir()
  writeFileSync(join(root, 'running.json'), JSON.stringify({ version: 1, bootId: 'same', updatedAt: 1, sessions: [{ sessionId: 's1' }] }))
  const beat = createHeartbeat({ dir: root, bootId: 'same', listRunning: async () => ['s1'] })
  beat.start()
  assert.equal(beat.residue, null)
})

test('residue outlives a running process that stops its own heartbeat', async () => {
  const root = dir()
  writeFileSync(join(root, 'running.json'), JSON.stringify({ version: 1, bootId: 'old', updatedAt: 1, sessions: [{ sessionId: 's1' }] }))
  const beat = createHeartbeat({ dir: root, bootId: 'new', intervalMs: 10, listRunning: async () => ['s9'] })
  beat.start()
  await sleep(40)
  assert.equal(JSON.parse(readFileSync(join(root, 'running.json'), 'utf8')).bootId, 'old')
  beat.release()
  beat.stop()
  assert.equal(JSON.parse(readFileSync(join(root, 'running.json'), 'utf8')).sessions.length, 0)
})

test('a clean stop leaves nothing to restore', async () => {
  const root = dir()
  const beat = createHeartbeat({ dir: root, bootId: 'b', intervalMs: 10, listRunning: async () => ['s1'] })
  beat.start()
  await sleep(40)
  assert.deepEqual(JSON.parse(readFileSync(join(root, 'running.json'), 'utf8')).sessions, [{ sessionId: 's1' }])
  beat.stop()
  assert.deepEqual(JSON.parse(readFileSync(join(root, 'running.json'), 'utf8')).sessions, [])
})

test('the file is only rewritten when the set changes', async () => {
  const root = dir()
  let calls = 0
  const beat = createHeartbeat({ dir: root, bootId: 'b', intervalMs: 10, listRunning: async () => (calls++, ['s1']) })
  beat.start()
  await sleep(50)
  const first = JSON.parse(readFileSync(join(root, 'running.json'), 'utf8')).updatedAt
  await sleep(50)
  const second = JSON.parse(readFileSync(join(root, 'running.json'), 'utf8')).updatedAt
  beat.stop()
  assert.equal(first, second)
  assert.ok(calls > 1)
})
