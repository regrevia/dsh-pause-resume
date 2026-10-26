import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeSync } from 'node:fs'
import { join } from 'node:path'

/**
 * The one durable fact this plugin owns: a snapshot of the work a press stopped, plus a journal
 * of what the following restore already put back.
 *
 * Every write is temp-file + fsync + rename, so a reader never sees half a snapshot and a crash
 * leaves the previous complete one in place. Nothing here throws: a disk that cannot be written
 * is reported as `null`, and the caller decides to stay in its current phase instead of claiming
 * a state it could not record.
 */
export function createStore(dir) {
  const file = join(dir, 'snapshot.json')
  const journal = join(dir, 'restore.jsonl')
  const consumed = join(dir, 'last-restore.json')
  let ready = false

  function ensure() {
    if (ready) return true
    try {
      mkdirSync(dir, { recursive: true })
      ready = true
      return true
    } catch {
      return false
    }
  }

  function read() {
    try {
      const raw = readFileSync(file, 'utf8')
      const parsed = JSON.parse(raw)
      if (parsed === null || typeof parsed !== 'object') return null
      if (parsed.version !== 1) return null
      if (parsed.status !== 'paused' && parsed.status !== 'pausing') return null
      return parsed
    } catch {
      return null
    }
  }

  function write(value) {
    if (!ensure()) return null
    const body = JSON.stringify({ ...value, version: 1 })
    const tmp = `${file}.${process.pid}.tmp`
    let fd = null
    try {
      fd = openSync(tmp, 'w')
      writeSync(fd, body)
      fsyncSync(fd)
      closeSync(fd)
      fd = null
      renameSync(tmp, file)
      return value
    } catch {
      if (fd !== null) {
        try {
          closeSync(fd)
        } catch {}
      }
      try {
        rmSync(tmp, { force: true })
      } catch {}
      return null
    }
  }

  /** The snapshot is spent: the same press must not restore the same work twice. */
  function consume(summary) {
    if (!ensure()) return null
    try {
      const current = read()
      const record = current === null ? { status: 'restored' } : { ...current, status: 'restored', restoredAt: new Date().toISOString(), summary }
      const tmp = `${consumed}.${process.pid}.tmp`
      writeSync(openSync(tmp, 'w'), JSON.stringify(record))
      renameSync(tmp, consumed)
    } catch {}
    try {
      rmSync(file, { force: true })
    } catch {}
    return summary
  }

  /** Journals are append-only lines of `{"k":"s:<id>"}`; a torn last line is dropped on read. */
  function readJournal() {
    const done = new Set()
    let raw = ''
    try {
      raw = readFileSync(journal, 'utf8')
    } catch {
      return done
    }
    for (const line of raw.split('\n')) {
      if (line === '') continue
      try {
        const row = JSON.parse(line)
        if (typeof row?.k === 'string') done.add(row.k)
      } catch {}
    }
    return done
  }

  function appendJournal(key) {
    if (!ensure()) return false
    try {
      writeSync(openSync(journal, 'a'), `${JSON.stringify({ k: key })}\n`)
      return true
    } catch {
      return false
    }
  }

  function clearJournal() {
    try {
      rmSync(journal, { force: true })
    } catch {}
  }

  function lastRestore() {
    try {
      return JSON.parse(readFileSync(consumed, 'utf8'))
    } catch {
      return null
    }
  }

  function hasSnapshot() {
    return existsSync(file)
  }

  return { dir, file, read, write, consume, readJournal, appendJournal, clearJournal, lastRestore, hasSnapshot }
}
