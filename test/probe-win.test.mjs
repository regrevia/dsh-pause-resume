import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { randomUUID } from 'node:crypto'
import zlib from 'node:zlib'
import { createProbe } from '../lib/probe.js'

/**
 * The probe's session scan is a Windows-shape risk: case-insensitive lookups, a readdir order that is
 * not sorted, and paths that may carry a drive letter and separators of either kind. None of that is
 * reachable from a POSIX host through the real filesystem, so the two calls the scan makes are
 * injectable and these tests hand it a fake filesystem with Windows rules. `latestTurnEnd` reads the
 * real log, so the encoding cases use a real temp home.
 */

const probeFor = (dshHome, options = {}) => createProbe({ get: () => undefined }, { dshHome, ...options })

const normalize = (path) => path.replaceAll('\\', '/').replace(/\/{2,}/g, '/')

/** A fake fs that answers like a Windows volume: optional case folding, and any readdir order. */
function windowsFs(spec, options = {}) {
  const insensitive = options.insensitive !== false
  const clean = (path) => normalize(path).replace(/\/+$/, '')
  const fold = (path) => (insensitive ? clean(path).toLowerCase() : clean(path))
  const nodes = new Map()
  const add = (path, node) => nodes.set(fold(path), { path: clean(path), ...node })
  for (const entry of spec) {
    if (entry.endsWith('/')) add(entry, { kind: 'dir' })
    else if (entry.includes(':dir')) {
      const [path] = entry.split(':dir')
      add(path, { kind: 'dir' })
    } else {
      const at = entry.lastIndexOf(':')
      add(entry.slice(0, at), { kind: 'file', size: Number(entry.slice(at + 1)) })
    }
  }
  const order = options.reverse === true ? (names) => [...names].reverse() : (names) => names
  const calls = { readdir: [], stat: [] }
  const missing = (path) => {
    const error = new Error(`ENOENT: no such file or directory, stat '${path}'`)
    error.code = 'ENOENT'
    return error
  }
  return {
    calls,
    async readdir(dir) {
      calls.readdir.push(dir)
      const root = nodes.get(fold(dir))
      if (root === undefined || root.kind !== 'dir') throw missing(dir)
      const names = new Set()
      for (const node of nodes.values()) {
        if (node.path.length > root.path.length
          && node.path.startsWith(`${root.path}/`)
          && node.path.slice(root.path.length + 1).includes('/') === false) {
          names.add(node.path.slice(root.path.length + 1))
        }
      }
      return order([...names])
    },
    async stat(file) {
      calls.stat.push(file)
      const node = nodes.get(fold(file))
      if (node === undefined) throw missing(file)
      if (options.denied !== undefined && options.denied.includes(fold(file))) {
        const error = new Error(`EACCES: permission denied, stat '${file}'`)
        error.code = 'EACCES'
        throw error
      }
      return { size: node.size ?? 0, isFile: () => node.kind === 'file', isDirectory: () => node.kind === 'dir' }
    },
  }
}

const HOME = 'C:\\Users\\Ada\\.dsh\\'
const UUID = '9c1f2d3e-0000-4000-8000-000000000001'
const BUCKET = '--C:-Users-Ada-work--'
const LOG = 'session.v4.jsonl.zstd'

const layout = (sessionDirName = `session-${UUID}`, size = 2048, bucket = BUCKET) => [
  `${HOME}sessions/`,
  `${HOME}sessions/${bucket}/`,
  `${HOME}sessions/${bucket}/${sessionDirName}/`,
  `${HOME}sessions/${bucket}/${sessionDirName}/${LOG}:${size}`,
]

test('a Windows home resolves the log through a case-insensitive lookup and a mixed-case id', async () => {
  const fs = windowsFs(layout())
  const probe = probeFor(HOME, { fs })
  // The runtime writes lowercase ids; a caller that upper-cases one must still find the same file.
  const weight = await probe.sessionWeight(`SESSION-${UUID.toUpperCase()}`)
  assert.deepEqual(weight, {
    bytes: 2048,
    file: join(HOME, 'sessions', BUCKET, `session-${UUID.toUpperCase()}`, LOG),
  })
  // Only node:path built these: the root the scan asked for is exactly join(home, 'sessions').
  assert.equal(fs.calls.readdir[0], join(HOME, 'sessions'))
  assert.equal(fs.calls.stat[0], weight.file)
})

test('the same query is null on a case-sensitive volume, because nothing quietly folds it', async () => {
  const fs = windowsFs(layout(), { insensitive: false })
  const probe = probeFor(HOME, { fs })
  assert.equal(await probe.sessionWeight(UUID.toUpperCase()), null)
  assert.notEqual(await probe.sessionWeight(UUID), null)
})

test('an unsorted readdir does not change which session is found', async () => {
  const other = ['--C:-Users-Ada-Desktop--', '--C:-Users-Ada-other--', 'zzz-last']
  const spec = [
    ...other.map((bucket) => `${HOME}sessions/${bucket}/`),
    ...layout(),
    `${HOME}sessions/stray-file.txt:5`,
  ]
  const probe = probeFor(HOME, { fs: windowsFs(spec, { reverse: true }) })
  assert.equal((await probe.sessionWeight(UUID)).bytes, 2048)
})

test('two buckets holding the same session: one self-consistent answer, order not promised', async () => {
  const spec = [
    `${HOME}sessions/`,
    `${HOME}sessions/--C:-Users-Ada-a--/`,
    `${HOME}sessions/--C:-Users-Ada-a--/session-${UUID}/`,
    `${HOME}sessions/--C:-Users-Ada-a--/session-${UUID}/${LOG}:100`,
    `${HOME}sessions/--C:-Users-Ada-b--/`,
    `${HOME}sessions/--C:-Users-Ada-b--/session-${UUID}/`,
    `${HOME}sessions/--C:-Users-Ada-b--/session-${UUID}/${LOG}:200`,
  ]
  const fs = windowsFs(spec)
  const weight = await probeFor(HOME, { fs }).sessionWeight(UUID)
  assert.ok(weight !== null)
  assert.equal(weight.bytes === 100 || weight.bytes === 200, true)
  // Whichever bucket readdir yielded first, the returned path and size describe that same file.
  assert.equal(fs.calls.stat.includes(weight.file), true)
})

test('the legacy log name and a bucket whose name differs only by case are both found', async () => {
  const spec = [
    `${HOME}sessions/`,
    `${HOME}sessions/--C:-Users-Ada-Legacy--/`,
    `${HOME}sessions/--C:-Users-Ada-Legacy--/session-${UUID}/`,
    `${HOME}sessions/--C:-Users-Ada-Legacy--/session-${UUID}/session.jsonl.zstd:333`,
  ]
  const weight = await probeFor(HOME, { fs: windowsFs(spec) }).sessionWeight(UUID)
  assert.equal(weight.bytes, 333)
  assert.equal(weight.file.endsWith(`session.jsonl.zstd`), true)
})

test('missing home, unreadable log, empty log and a directory in its place are all null', async () => {
  const empty = windowsFs([])
  assert.equal(await probeFor(HOME, { fs: empty }).sessionWeight(UUID), null)
  const denied = windowsFs(layout(), { denied: [normalize(`${HOME}sessions/${BUCKET}/session-${UUID}/${LOG}`).toLowerCase()] })
  assert.equal(await probeFor(HOME, { fs: denied }).sessionWeight(UUID), null)
  const zero = windowsFs([
    `${HOME}sessions/${BUCKET}/`,
    `${HOME}sessions/${BUCKET}/session-${UUID}/`,
    `${HOME}sessions/${BUCKET}/session-${UUID}/${LOG}:0`,
  ])
  assert.equal(await probeFor(HOME, { fs: zero }).sessionWeight(UUID), null)
  // A directory named like a log stats successfully; its size is a filesystem detail, not a transcript.
  const occupied = windowsFs([
    `${HOME}sessions/${BUCKET}/`,
    `${HOME}sessions/${BUCKET}/session-${UUID}/`,
    `${HOME}sessions/${BUCKET}/session-${UUID}/${LOG}:dir`,
  ])
  assert.equal(await probeFor(HOME, { fs: occupied }).sessionWeight(UUID), null)
  assert.equal(await probeFor(HOME, { fs: occupied }).sessionWeight(`${UUID.slice(0, 8)}-0000-4000-8000-0000000000ff`), null)
})

test('a pathological id never throws and never leaves the home', async () => {
  const fs = windowsFs(layout())
  const probe = probeFor(HOME, { fs })
  for (const id of [null, undefined, '', 42, {}, [], 'session-', '..\\..\\etc\\passwd', `${UUID}/../../x`]) {
    assert.equal(await probe.sessionWeight(id), null)
  }
  // A traversal-shaped id is one path segment under the scan root, not an escape: each stat stays inside it.
  for (const stat of fs.calls.stat) assert.equal(normalize(stat).startsWith('C:/Users/Ada/.dsh/sessions/'), true)
})

test('a home deeper than MAX_PATH is handled the same way by the scan', async () => {
  const deep = `C:\\Users\\Ada\\${'nested-folder\\'.repeat(20)}.dsh\\`
  assert.ok(deep.length > 260)
  const spec = [
    `${deep}sessions/`,
    `${deep}sessions/${BUCKET}/`,
    `${deep}sessions/${BUCKET}/session-${UUID}/`,
    `${deep}sessions/${BUCKET}/session-${UUID}/${LOG}:77`,
  ]
  const weight = await probeFor(deep, { fs: windowsFs(spec) }).sessionWeight(UUID)
  assert.equal(weight.bytes, 77)
})

test('a real DSH_HOME with a trailing separator still finds its log', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-win-home-'))
  try {
    const sessionId = randomUUID()
    const dir = join(home, 'sessions', '--Users-ada--', `session-${sessionId}`)
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, LOG), Buffer.alloc(512, 0x28))
    const weight = await probeFor(`${home}${sep}`).sessionWeight(sessionId)
    assert.deepEqual(weight, { bytes: 512, file: join(home, 'sessions', '--Users-ada--', `session-${sessionId}`, LOG) })
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

async function withLog(frames) {
  const home = await mkdtemp(join(tmpdir(), 'dsh-win-log-'))
  const sessionId = randomUUID()
  const dir = join(home, 'sessions', '--Users-ada--', `session-${sessionId}`)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, LOG), Buffer.concat(frames))
  return { home, sessionId, cleanup: () => rm(home, { recursive: true, force: true }) }
}

const frame = (text) => zlib.zstdCompressSync(Buffer.from(text, 'utf8'))

test('a log written with a UTF-8 BOM and CRLF is read, not discarded', async () => {
  const { home, sessionId, cleanup } = await withLog([
    frame('\uFEFF{"type":"turn/start","data":{"turn":1}}\r\n{"type":"turn/end","data":{"turn":2,"reason":{"kind":"interrupted"}}}\r\n'),
  ])
  try {
    const probe = probeFor(home)
    assert.deepEqual(await probe.latestTurnEnd(sessionId), {
      end: { turn: 2, kind: 'interrupted', seq: null, failure: null, cause: null },
      openTurn: null,
    })
  } finally {
    await cleanup()
  }
})

test('a torn final frame is dropped while the frames before it still answer', async () => {
  const { home, sessionId, cleanup } = await withLog([
    frame('{"type":"turn/end","data":{"turn":4,"reason":{"kind":"completed"}}}\n'),
    // Half a flush: the magic arrives, the rest of the frame never does.
    Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0x00, 0x01, 0x02]),
  ])
  try {
    assert.deepEqual(await probeFor(home).latestTurnEnd(sessionId), {
      end: { turn: 4, kind: 'completed', seq: null, failure: null, cause: null },
      openTurn: null,
    })
  } finally {
    await cleanup()
  }
})

test('a header-only or empty log answers null instead of inventing a boundary', async () => {
  const headerOnly = await withLog([Buffer.from([0x28, 0xb5, 0x2f, 0xfd])])
  try {
    assert.equal(await probeFor(headerOnly.home).latestTurnEnd(headerOnly.sessionId), null)
  } finally {
    await headerOnly.cleanup()
  }
  const empty = await withLog([Buffer.alloc(0)])
  try {
    assert.equal(await probeFor(empty.home).latestTurnEnd(empty.sessionId), null)
  } finally {
    await empty.cleanup()
  }
})

test('a frame that claims more output than the tail accepts is ignored, not decoded', async () => {
  const huge = Buffer.alloc(65 * 1024 * 1024, 0x41)
  const compressed = zlib.zstdCompressSync(huge)
  const { home, sessionId, cleanup } = await withLog([compressed])
  try {
    // The probe answers "nothing readable" rather than pulling that frame into the heap.
    assert.equal(await probeFor(home).latestTurnEnd(sessionId), null)
  } finally {
    await cleanup()
  }
})
