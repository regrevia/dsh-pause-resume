/**
 * Windows compatibility of the sources this repo runs on a person's machine.
 *
 * None of this needs a Windows host: the path math is exercised with `path.win32`, the Windows
 * filesystem refusals (`EPERM`/`EACCES`/`EBUSY` from a rename over a target another handle holds)
 * are injected through the `{ fs }` seam every writer already takes, and the encoded-file cases
 * (UTF-8 BOM, CRLF) are written as bytes. A test that only passed on darwin would not prove the
 * claim; nothing here branches on the host platform.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as nodeFs from 'node:fs'
import { basename, dirname, join, relative, sep, win32 } from 'node:path'
import test from 'node:test'

import { createLedger } from '../lib/ledger.js'
import { createHeartbeat } from '../lib/heartbeat.js'
import { createStore } from '../lib/snapshot.js'

const RESERVED = new Set(['CON', 'PRN', 'AUX', 'NUL', 'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9', 'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9'])

function makeRoot() {
  return mkdtempSync(join(tmpdir(), 'dsh-win-'))
}

/** The characters Windows refuses in a file name, plus the control range. */
function windowsNameProblem(name) {
  if (/[:*?"<>|]/.test(name)) return 'a Windows-reserved character'
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f]/.test(name)) return 'a control character'
  const stem = name.split('.')[0].toUpperCase()
  if (RESERVED.has(stem)) return `the reserved device name ${stem}`
  return null
}

/**
 * A filesystem that behaves like `node:fs` except that every `renameSync` goes through `fail`,
 * and every path handed to a write or a rename is recorded. That is exactly what an antivirus
 * scanner holding the target open does to a Windows rename.
 */
function recordingFs(fail = () => null) {
  const opened = []
  const renamed = []
  const impl = {
    ...nodeFs,
    openSync(path, flags, mode) {
      opened.push({ path: String(path), flags })
      return nodeFs.openSync(path, flags, mode)
    },
    renameSync(from, to) {
      renamed.push({ from: String(from), to: String(to) })
      const code = fail(renamed.length, { from, to })
      if (code !== null) {
        const error = new Error(`injected ${code}`)
        error.code = code
        throw error
      }
      return nodeFs.renameSync(from, to)
    },
  }
  return { impl, opened, renamed }
}

function draft() {
  return { planId: 'p1', status: 'paused', source: 'pause', boot: 'b1', sessions: [], goals: [], jobs: [], attention: [], createdAt: 1 }
}

/* 1. Windows path math: the state directory stays inside the home it was derived from. */
test('win32 join keeps the state directory inside DSH_HOME, trailing separator or not', () => {
  const clean = 'C:\\Users\\x\\.dsh'
  for (const home of [clean, `${clean}\\`]) {
    const sessions = win32.join(home, 'sessions')
    const stateDir = win32.join(home, 'pause-resume')
    const statePath = win32.join(home, 'pause-resume', 'snapshot.json')
    assert.equal(win32.relative(home, sessions), 'sessions')
    assert.equal(win32.relative(home, stateDir), 'pause-resume')
    assert.equal(win32.relative(home, statePath), win32.join('pause-resume', 'snapshot.json'))
    assert.equal(win32.relative(home, statePath).startsWith('..'), false)
    assert.equal(win32.isAbsolute(statePath), true)
    // Hand-rolled concatenation is what breaks here: `home + '\\' + ...` keeps the doubled
    // separator, and a naive template keeps a stray `..` that walks out of the home.
    assert.equal(stateDir.includes('\\\\'), false)
  }
  // A UNC share is a legal DSH_HOME too and has no drive letter to assume.
  const unc = '\\\\server\\share\\.dsh'
  assert.equal(win32.relative(unc, win32.join(unc, 'sessions')), 'sessions')
  assert.equal(win32.join(unc, 'sessions').startsWith(unc), true)
})

/* 2. The temp file every writer creates must be a legal Windows name. */
test('temp files written next to their target have no Windows-hostile name', () => {
  const root = makeRoot()
  try {
    const store = createStore(join(root, 'state'), { fs: recordingFs().impl })
    assert.notEqual(store.write(draft()), null)
    const recorder = recordingFs()
    const ledger = createLedger({ dir: join(root, 'ledger'), fs: recorder.impl })
    ledger.observe('s1', { type: 'turn/end', data: { turn: 2, reason: { kind: 'error', error: { message: 'boom' } } }, time: 1 })
    const heartbeatRecorder = recordingFs()
    const heartbeat = createHeartbeat({ dir: join(root, 'hb'), bootId: 'b1', fs: heartbeatRecorder.impl })
    heartbeat.note([{ sessionId: 's1', lastTurn: 2 }])
    void heartbeat.flush()

    const names = []
    for (const { opened } of [recorder, heartbeatRecorder]) {
      for (const entry of opened) {
        if (entry.flags !== 'w') continue
        names.push(basename(entry.path))
      }
    }
    assert.ok(names.length >= 1, 'the writers opened a temp file')
    for (const name of names) {
      assert.equal(windowsNameProblem(name), null, `temp name ${name} has ${windowsNameProblem(name)}`)
      // The temp lives in the target's own directory, so a rename is never a cross-device move.
      assert.match(name, /\.\d+\.\d+\.tmp$/u)
      assert.equal(basename(name).startsWith('.'), false)
    }

    const snapshotRecorder = recordingFs()
    const second = createStore(join(root, 'state2'), { fs: snapshotRecorder.impl })
    assert.notEqual(second.write(draft()), null)
    for (const { from, to } of snapshotRecorder.renamed) {
      assert.equal(dirname(from), dirname(to))
      assert.equal(windowsNameProblem(basename(from)), null)
      assert.equal(dirname(from), second.dir)
    }
    assert.equal(readdirSync(second.dir).filter((name) => name.endsWith('.tmp')).length, 0)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

/* 3. A locked target is retried, then reported as a failed write instead of throwing. */
for (const code of ['EPERM', 'EACCES', 'EBUSY']) {
  test(`a rename refusing ${code} is retried and then fails as a value, not a throw`, async () => {
    const root = makeRoot()
    try {
      const recorder = recordingFs((attempt) => (attempt <= 99 ? code : null))
      const store = createStore(join(root, 'state'), { fs: recorder.impl })
      assert.equal(store.write(draft()), null)
      assert.equal(recorder.renamed.length, 5, 'five attempts before giving up')
      assert.equal(readdirSync(store.dir).includes('snapshot.json'), false)
      assert.equal(readdirSync(store.dir).filter((name) => name.endsWith('.tmp')).length, 0, 'the temp is cleaned up')

      const ledgerRecorder = recordingFs(() => code)
      const ledger = createLedger({ dir: join(root, 'ledger'), fs: ledgerRecorder.impl })
      ledger.observe('s1', { type: 'turn/end', data: { turn: 2, reason: { kind: 'error', error: { message: 'boom' } } }, time: 1 })
      assert.equal(ledgerRecorder.renamed.length, 5)
      assert.equal(readdirSync(join(root, 'ledger')).filter((name) => name === 'continue.json').length, 0)

      const heartbeatRecorder = recordingFs(() => code)
      const heartbeat = createHeartbeat({ dir: join(root, 'hb'), bootId: 'b1', fs: heartbeatRecorder.impl })
      heartbeat.note([{ sessionId: 's1', lastTurn: 2 }])
      assert.equal(await heartbeat.flush(), false)
      assert.equal(heartbeatRecorder.renamed.length, 5)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
}

test('a rename that is only transiently refused still lands the write', () => {
  const root = makeRoot()
  try {
    const recorder = recordingFs((attempt) => (attempt <= 2 ? 'EBUSY' : null))
    const store = createStore(join(root, 'state'), { fs: recorder.impl })
    assert.notEqual(store.write(draft()), null)
    assert.equal(recorder.renamed.length, 3)
    assert.equal(store.read()?.planId, 'p1')
    assert.equal(readdirSync(store.dir).filter((name) => name.endsWith('.tmp')).length, 0)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

/* 4. Files a Windows editor re-saved: UTF-8 BOM and CRLF separators still read back. */
test('a plan and a journal saved with a BOM and CRLF are still read', () => {
  const root = makeRoot()
  try {
    const store = createStore(join(root, 'state'))
    assert.notEqual(store.write(draft()), null)
    const planText = readFileSync(store.snapshotPath, 'utf8')
    writeFileSync(store.snapshotPath, `\uFEFF${planText.replace(/\n/g, '\r\n')}`)
    assert.equal(store.read()?.planId, 'p1')

    assert.equal(store.appendJournal('p1', 'u1', 'delivered', 'b1', { epoch: 1, turn: 2 }), true)
    assert.equal(store.appendJournal('p1', 'u2', 'waiting', 'b1', { epoch: 1, turn: 3 }), true)
    const journalDir = readdirSync(store.dir).find((name) => name === 'journal')
    assert.equal(typeof journalDir, 'string')
    const journalFile = join(store.dir, journalDir, 'p1.jsonl')
    const journalText = readFileSync(journalFile, 'utf8')
    assert.equal(journalText.includes('\r'), false, 'a JSONL line always ends with a bare LF')
    assert.equal(journalText.endsWith('\n'), true)
    // A person opening the file in an editor that saves CRLF must not make the journal unreadable.
    writeFileSync(journalFile, `\uFEFF${journalText.replace(/\n/g, '\r\n')}`)
    const rows = store.readJournal('p1')
    assert.equal(rows.size, 2)
    assert.equal(rows.get('u1')?.status, 'delivered')
    assert.equal(rows.get('u2')?.turn, 3)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

/* 5. A trailing separator in DSH_HOME must not create a sibling directory on any platform. */
test('DSH_HOME ending in a separator does not escape into a sibling directory', () => {
  const root = makeRoot()
  try {
    const home = join(root, 'home')
    rmSync(home, { recursive: true, force: true })
    const stateDir = join(`${home}${sep}`, 'pause-resume')
    assert.equal(relative(`${home}${sep}`, stateDir), join('pause-resume'))
    assert.equal(relative(`${home}${sep}`, stateDir).startsWith('..'), false)
    assert.equal(dirname(stateDir), home)

    const store = createStore(stateDir)
    assert.notEqual(store.write(draft()), null)
    assert.equal(dirname(store.snapshotPath), join(home, 'pause-resume'))
    assert.deepEqual(readdirSync(root), ['home'])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

/* 6. Static guarantees that hold without a Windows host. */
test('no source file shells out, and the npm scripts stay a single cross-platform command', () => {
  const repo = join(import.meta.dirname, '..')
  for (const file of ['index.js', 'client.js', 'lib/engine.js', 'lib/probe.js']) {
    const source = readFileSync(join(repo, file), 'utf8')
    assert.equal(/node:child_process|\bshell:\s*true\b|\bexecSync\b|\bspawnSync\b|\bexecFileSync\b/u.test(source), false, `${file} must not shell out`)
    assert.equal(/process\.platform\s*===\s*'win32'/u.test(source), false, `${file} must not branch on the host platform`)
  }
  const pkg = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8'))
  const commands = Object.values(pkg.scripts ?? {})
  assert.ok(commands.length > 0)
  for (const command of commands) {
    // cmd.exe (npm's shell on Windows) does not expand these; a script that needs them fails there.
    assert.equal(/&&|\|\||;|\$\(|`|rm -rf|cp -r|chmod|\/dev\/null/u.test(command), false, `POSIX-only shell syntax in: ${command}`)
  }
  // The client must address the host by an absolute URL path, never by the page's own pathname.
  const client = readFileSync(join(repo, 'client.js'), 'utf8')
  assert.equal(/location\.pathname|location\.search|document\.baseURI/u.test(client), false)
})

/* 7. Files the plugin ships and reads back through JSON keep no BOM. */
test('shipped JSON files parse without a BOM strip', () => {
  const repo = join(import.meta.dirname, '..')
  for (const name of ['package.json', 'cordis.patch.yml']) {
    const path = join(repo, name)
    let text
    try {
      text = readFileSync(path, 'utf8')
    } catch {
      continue
    }
    assert.equal(text.charCodeAt(0) === 0xfeff, false, `${name} must ship without a BOM`)
  }
})
