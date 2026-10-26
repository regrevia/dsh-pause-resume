import * as fs from 'node:fs'
import { dirname, join } from 'node:path'

/**
 * The durable half of the pause button: one plan file, a per-plan restore journal, one archive per
 * consumed plan, and the last restore record.
 *
 * Every write is temp file + fsync + rename + directory fsync, so a reader never sees half a plan
 * and a crash leaves the previous complete file in place. Nothing here throws: a disk that cannot
 * be written answers `null`, and the caller decides whether to stay in its current phase instead
 * of claiming a state it could not record.
 */

const UNSAFE = /[^A-Za-z0-9._-]/gu

let counter = 0

function sanitize(value) {
  const name = String(value ?? '').replace(UNSAFE, '_')
  return name === '' ? '_' : name
}

function closeQuietly(fsv, fd) {
  try {
    fsv.closeSync(fd)
  } catch {}
}

export function createStore(dir, options = {}) {
  const fsv = options.fs ?? fs
  const now = typeof options.now === 'function' ? options.now : Date.now
  const log = typeof options.log === 'function' ? options.log : () => {}

  const snapshotPath = join(dir, 'snapshot.json')
  const journalDir = join(dir, 'journal')
  const restoresDir = join(dir, 'restores')
  const lastRestorePath = join(dir, 'last-restore.json')

  const journalPath = (planId) => join(journalDir, `${sanitize(planId)}.jsonl`)

  /** Flush a directory entry, so the rename that just happened survives a power loss too. */ // ui-copy-ignore
  function syncDir(path) {
    let fd = null
    try {
      fd = fsv.openSync(path, 'r')
      fsv.fsyncSync(fd)
    } finally {
      if (fd !== null) closeQuietly(fsv, fd)
    }
  }

  function atomicWrite(target, value) {
    let body = null
    try {
      body = JSON.stringify(value)
    } catch (error) {
      log(`cannot serialize ${target}: ${error?.message ?? error}`)
      return false
    }
    const tmp = `${target}.${process.pid}.${counter++}.tmp`
    let fd = null
    let renamed = false
    try {
      fsv.mkdirSync(dirname(target), { recursive: true })
      fd = fsv.openSync(tmp, 'w')
      fsv.writeSync(fd, body)
      fsv.fsyncSync(fd)
      const opened = fd
      fd = null
      fsv.closeSync(opened)
      fsv.renameSync(tmp, target)
      renamed = true
      syncDir(dirname(target))
      return true
    } catch (error) {
      log(`cannot write ${target}: ${error?.message ?? error}`)
      return false
    } finally {
      if (fd !== null) closeQuietly(fsv, fd)
      if (renamed === false) {
        try {
          fsv.rmSync(tmp, { force: true })
        } catch {}
      }
    }
  }

  function read() {
    let parsed = null
    try {
      parsed = JSON.parse(fsv.readFileSync(snapshotPath, 'utf8'))
    } catch {
      return null
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    if (parsed.version !== 2) return null
    if (parsed.status !== 'pausing' && parsed.status !== 'paused') return null
    return parsed
  }

  function write(plan) {
    if (plan === null || typeof plan !== 'object' || Array.isArray(plan)) return null
    const record = { ...plan, version: 2 }
    return atomicWrite(snapshotPath, record) ? record : null
  }

  function appendJournal(planId, key) {
    let line = null
    try {
      line = JSON.stringify({ k: key })
    } catch {
      return false
    }
    let fd = null
    try {
      fsv.mkdirSync(journalDir, { recursive: true })
      fd = fsv.openSync(journalPath(planId), 'a')
      fsv.writeSync(fd, `${line}\n`)
      fsv.fsyncSync(fd)
      return true
    } catch (error) {
      log(`cannot journal ${planId}: ${error?.message ?? error}`)
      return false
    } finally {
      if (fd !== null) closeQuietly(fsv, fd)
    }
  }

  function readJournal(planId) {
    const done = new Set()
    let raw = ''
    try {
      raw = fsv.readFileSync(journalPath(planId), 'utf8')
    } catch {
      return done
    }
    for (const line of raw.split('\n')) {
      if (line === '') continue
      try {
        const row = JSON.parse(line)
        if (typeof row?.k === 'string') done.add(row.k)
      } catch {
        // A torn last line is a write that never finished, not a key that was restored.
      }
    }
    return done
  }

  function clearJournal(planId) {
    try {
      fsv.rmSync(journalPath(planId), { force: true })
    } catch {}
  }

  /**
   * The plan is spent: archive it, publish the record the UI reads, and only then remove it. A plan
   * that could not be archived stays on disk, so the same work is never claimed twice.
   */
  function consume(plan, summary) {
    const source = plan !== null && typeof plan === 'object' && !Array.isArray(plan) ? plan : {}
    const archivePath = join(restoresDir, `${sanitize(source.planId)}.json`)
    const record = { ...source, status: 'restored', restoredAt: new Date(now()).toISOString(), summary }
    const archived = atomicWrite(archivePath, record)
    const published = archived && atomicWrite(lastRestorePath, record)
    if (published === false) {
      log('cannot archive the restored plan: the snapshot stays')
      return { ok: false, archivePath: null }
    }
    const current = read()
    // Another press may have written a newer plan while this one restored; that one is not ours.
    if (current !== null && current.planId === source.planId) {
      try {
        fsv.rmSync(snapshotPath, { force: true })
      } catch {}
    }
    clearJournal(source.planId)
    return { ok: true, archivePath }
  }

  function lastRestore() {
    try {
      const parsed = JSON.parse(fsv.readFileSync(lastRestorePath, 'utf8'))
      return parsed !== null && typeof parsed === 'object' ? parsed : null
    } catch {
      return null
    }
  }

  function hasSnapshot() {
    try {
      return fsv.existsSync(snapshotPath) === true
    } catch {
      return false
    }
  }

  return { dir, snapshotPath, read, write, appendJournal, readJournal, clearJournal, consume, lastRestore, hasSnapshot }
}
