import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createStore } from '../lib/snapshot.js'

const dir = () => mkdtempSync(join(tmpdir(), 'dsh-pr-'))
const draft = (over = {}) => ({ version: 1, status: 'paused', createdAt: 'now', sessions: [{ sessionId: 's1' }], goals: [], schedules: [], jobs: [], terminals: [], ...over })

test('a written snapshot reads back whole', () => {
  const store = createStore(dir())
  store.write(draft())
  assert.equal(store.read().status, 'paused')
  assert.equal(store.read().sessions[0].sessionId, 's1')
  assert.equal(store.hasSnapshot(), true)
})

test('an interrupted pause is still a snapshot', () => {
  const store = createStore(dir())
  store.write(draft({ status: 'pausing' }))
  assert.equal(store.read().status, 'pausing')
})

test('a foreign or broken file is not a snapshot', () => {
  const store = createStore(dir())
  store.write(draft())
  writeFileSync(store.file, JSON.stringify({ version: 2, status: 'paused' }))
  assert.equal(store.read(), null)
  writeFileSync(store.file, JSON.stringify({ version: 1, status: 'idle' }))
  assert.equal(store.read(), null)
  writeFileSync(store.file, '{"version":1,')
  assert.equal(store.read(), null)
})

test('a write leaves no temp file behind', () => {
  const store = createStore(dir())
  store.write(draft())
  assert.deepEqual(readdirSync(store.dir), ['snapshot.json'])
})

test('consuming answers once and cannot answer again', () => {
  const store = createStore(dir())
  store.write(draft())
  store.consume({ restored: ['session s1'], skipped: [], failed: [], jobs: 0 })
  assert.equal(store.read(), null)
  assert.equal(store.hasSnapshot(), false)
  assert.equal(store.lastRestore().summary.restored[0], 'session s1')
  assert.equal(store.lastRestore().status, 'restored')
})

test('the journal survives a torn last line', () => {
  const store = createStore(dir())
  store.appendJournal('s:s1')
  store.appendJournal('g:g1')
  writeFileSync(join(store.dir, 'restore.jsonl'), `${readFileSync(join(store.dir, 'restore.jsonl'), 'utf8')}{"k":"s:s2`)
  assert.deepEqual([...store.readJournal()], ['s:s1', 'g:g1'])
  store.clearJournal()
  assert.equal(store.readJournal().size, 0)
})

test('a directory that cannot be created reports null instead of throwing', () => {
  const store = createStore('/dev/null/nope')
  assert.equal(store.write(draft()), null)
  assert.equal(store.read(), null)
  assert.equal(store.hasSnapshot(), false)
})
