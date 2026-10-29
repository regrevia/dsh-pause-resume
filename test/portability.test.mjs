import assert from 'node:assert/strict'
import * as nodeFs from 'node:fs'
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { test } from 'node:test'
import { createStore } from '../lib/snapshot.js'

const dir = () => mkdtempSync(join(tmpdir(), 'dsh-pr-port-'))
const draft = (over = {}) => ({ planId: 'p1', status: 'paused', createdAt: 'now', sessions: [{ sessionId: 's1' }], goals: [], schedules: [], jobs: [], terminals: [], ...over })

/** An fs-like object that records every rename and can refuse one the way Windows does. */
function recordingFs(deny = () => false) {
  const renames = []
  let attempts = 0
  return {
    renames,
    attempts: () => attempts,
    impl: {
      ...nodeFs,
      renameSync(from, to) {
        attempts += 1
        if (deny(attempts, from, to) === true) {
          const error = new Error('EPERM: operation not permitted, rename')
          error.code = 'EPERM'
          throw error
        }
        renames.push({ from: resolve(from), to: resolve(to) })
        return nodeFs.renameSync(from, to)
      },
    },
  }
}

test('a journal written with CRLF reads back row for row', () => {
  const store = createStore(dir())
  assert.equal(store.appendJournal('p1', 's:s1', 'ok', 'boot-1', { epoch: 2, turn: 3 }), true)
  assert.equal(store.appendJournal('p1', 'g:g1', 'failed', 'boot-1', { epoch: 2 }), true)
  const path = join(store.dir, 'journal', 'p1.jsonl')
  // What a Windows editor or a copied file produces: every separator becomes `\r\n`.
  writeFileSync(path, readFileSync(path, 'utf8').replace(/\n/g, '\r\n'))
  const rows = store.readJournal('p1')
  assert.equal(rows.size, 2)
  assert.deepEqual(rows.get('s:s1'), { status: 'ok', boot: 'boot-1', epoch: 2, turn: 3 })
  assert.deepEqual(rows.get('g:g1'), { status: 'failed', boot: 'boot-1', epoch: 2, turn: null })
})

test('a DSH_HOME with a trailing separator keeps its state inside that home', () => {
  const root = dir()
  const home = join(root, 'home')
  nodeFs.mkdirSync(home, { recursive: true })
  // The user-supplied variable may end in a separator; `join` is what normalizes it.
  const homeWithSeparator = `${home}${sep}`
  const stateDir = join(homeWithSeparator, 'pause-resume')
  const store = createStore(stateDir)
  assert.equal(store.dir, join(home, 'pause-resume'))
  assert.equal(dirname(store.snapshotPath), stateDir)
  // `..` would be a sibling: a hand-built `home + '/pause-resume'` on Windows can escape, `join` cannot.
  assert.equal(relative(homeWithSeparator, store.snapshotPath), join('pause-resume', 'snapshot.json'))
  assert.equal(relative(homeWithSeparator, store.snapshotPath).includes('..'), false)
  assert.notEqual(store.write(draft()), null)
  assert.equal(store.read()?.planId, 'p1')
  assert.equal(existsSync(store.snapshotPath), true)
  // Nothing was created next to the home, which is what a naive string concatenation would do.
  assert.deepEqual(readdirSync(root), ['home'])
})

test('a temp file is created next to its target, so a rename is never cross-device', () => {
  const root = dir()
  const recorder = recordingFs()
  const store = createStore(join(root, 'state'), { fs: recorder.impl })
  assert.notEqual(store.write(draft()), null)
  assert.notEqual(store.writePending(draft({ planId: 'p2' })), null)
  assert.equal(recorder.renames.length, 2)
  for (const rename of recorder.renames) {
    assert.equal(dirname(rename.from), dirname(rename.to))
    assert.equal(dirname(rename.to), store.dir)
  }
  // The temporary names are gone: the rename moved them, the failure path would have removed them.
  assert.deepEqual(readdirSync(store.dir).sort(), ['pending.json', 'snapshot.json'])
})

test('a rename that Windows refuses once is retried and publishes the record', () => {
  const root = dir()
  const recorder = recordingFs((attempt) => attempt <= 2)
  const store = createStore(join(root, 'state'), { fs: recorder.impl })
  const written = store.write(draft())
  assert.equal(written?.planId, 'p1')
  assert.equal(recorder.attempts(), 3)
  assert.deepEqual(store.read()?.planId, 'p1')
  assert.deepEqual(readdirSync(store.dir), ['snapshot.json'])
})

test('a state file saved with a UTF-8 BOM still reads back', () => {
  const store = createStore(dir())
  assert.notEqual(store.write(draft()), null)
  const raw = readFileSync(store.snapshotPath, 'utf8')
  // Notepad and several Windows editors prepend a BOM when a person edits a file by hand.
  writeFileSync(store.snapshotPath, `\uFEFF${raw}`)
  assert.equal(store.read()?.planId, 'p1')
})
