import * as fs from 'node:fs'
import { dirname, join } from 'node:path'

/**
 * The durable half of the pause button: the active plan, the crash plan a restart inherited, one
 * restore journal, one archive per consumed plan, and the last restore record.
 *
 * Every write is temp file + fsync + rename + best-effort directory fsync, so a reader never sees
 * half a plan and a crash leaves the previous complete file in place. A directory fsync that the
 * platform refuses (EPERM/ENOTSUP on some network and sandboxed filesystems) does not undo a
 * rename that already happened: the record is published, only its power-loss guarantee is weaker.
 * Nothing here throws: a disk that cannot be written answers `false`/`null`, and the caller
 * decides whether to stay in its current phase instead of claiming a state it could not record.
 *
 * Formats read: version 3 (this release), version 2 (0.2.x), version 1 (0.1.x). A version 1 plan is
 * migrated conservatively: it has no turn baseline, so its sessions are mounted and never sent a
 * continuation message, and its goal rows carry no revision, so they are reported, not resumed.
 */

const UNSAFE = /[^A-Za-z0-9._-]/gu
const CURRENT_VERSION = 3
const DIR_SYNC_CODES = new Set(['EPERM', 'EACCES', 'ENOTSUP', 'EINVAL', 'ENOSYS', 'EBADF', 'EISDIR'])

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
  const pendingPath = join(dir, 'pending.json')
  const journalDir = join(dir, 'journal')
  const restoresDir = join(dir, 'restores')
  const lastRestorePath = join(dir, 'last-restore.json')

  const journalPath = (planId) => join(journalDir, `${sanitize(planId)}.jsonl`)

  /** Flush a directory entry, so the rename that just happened survives a power loss too. */ // ui-copy-ignore
  function syncDir(path) {
    if (process.platform === 'win32') return // ui-copy-ignore
    let fd = null
    try {
      fd = fsv.openSync(path, 'r')
      fsv.fsyncSync(fd)
    } catch (error) {
      const code = error?.code
      if (DIR_SYNC_CODES.has(code) === false) log(`cannot flush ${path}: ${error?.message ?? error}`)
    } finally {
      if (fd !== null) closeQuietly(fsv, fd)
    }
  }

  /** `published` is the truth: the rename landed, so readers see the new record. */
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

  function parse(path) {
    let parsed = null
    try {
      parsed = JSON.parse(fsv.readFileSync(path, 'utf8'))
    } catch {
      return null
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    return parsed
  }

  /**
   * A version 1 plan predates the turn baseline and the goal revision. Mounting is safe; claiming
   * that a turn was interrupted is not, and resuming a goal without its revision is not either.
   */
  function migrateLegacy(legacy, stamp) {
    const sessions = (Array.isArray(legacy.sessions) ? legacy.sessions : [])
      .filter((row) => typeof row?.sessionId === 'string')
      .map((row) => ({ sessionId: row.sessionId, running: false, lastTurn: null }))
    const goals = (Array.isArray(legacy.goals) ? legacy.goals : [])
      .filter((row) => typeof row?.sessionId === 'string')
      .map((row) => ({ sessionId: row.sessionId, goalId: typeof row.goalId === 'string' ? row.goalId : null, revision: null }))
    const jobs = (Array.isArray(legacy.jobs) ? legacy.jobs : []).map((row) => ({ id: String(row?.id ?? ''), owner: row?.owner ?? null }))
    return {
      planId: `legacy-${stamp}`, // ui-copy-ignore
      status: 'paused', // ui-copy-ignore
      source: 'legacy', // ui-copy-ignore
      legacy: true, // ui-copy-ignore
      createdAt: legacy.createdAt ?? stamp,
      sessions,
      goals,
      jobs,
      attention: ['legacy plan: sessions are mounted only; goals need a new pause'],
    }
  }

  function normalize(parsed, stamp = now()) {
    if (parsed === null) return null
    if (parsed.version === 1) return migrateLegacy(parsed, typeof parsed.createdAt === 'number' ? parsed.createdAt : stamp)
    if (parsed.version !== 2 && parsed.version !== CURRENT_VERSION) return null
    if (parsed.status !== 'pausing' && parsed.status !== 'paused' && parsed.status !== 'partial') return null
    const plan = { ...parsed, version: CURRENT_VERSION }
    if (typeof plan.planId !== 'string' || plan.planId === '') plan.planId = `plan-${plan.createdAt ?? stamp}`
    if (Array.isArray(plan.attention) === false) plan.attention = []
    if (plan.status === 'pausing') plan.interrupted = true
    return plan
  }

  function readFrom(path) {
    const parsed = parse(path)
    if (parsed === null) return null
    // A version 1 plan has no plan id; the file stamp keeps one journal per legacy press.
    let stamp = now()
    try {
      stamp = Math.trunc(fsv.statSync(path).mtimeMs)
    } catch {}
    return normalize(parsed, stamp)
  }

  function read() {
    return readFrom(snapshotPath)
  }

  function write(plan) {
    if (plan === null || typeof plan !== 'object' || Array.isArray(plan)) return null
    const record = { ...plan, version: CURRENT_VERSION }
    return atomicWrite(snapshotPath, record) ? record : null
  }

  /** The crash plan survives this process: it is written before the heartbeat overwrites its file. */
  function readPending() {
    return readFrom(pendingPath)
  }

  function writePending(plan) {
    if (plan === null || typeof plan !== 'object' || Array.isArray(plan)) return null
    const record = { ...plan, version: CURRENT_VERSION }
    return atomicWrite(pendingPath, record) ? record : null
  }

  function clearPending() {
    try {
      fsv.rmSync(pendingPath, { force: true })
      syncDir(dir)
      return true
    } catch (error) {
      log(`cannot clear pending plan: ${error?.message ?? error}`)
      return false
    }
  }

  /**
   * Journals carry the boot that wrote each row. A row from an earlier process is evidence for the
   * summary, never permission to skip work: the only things a new process can trust are the live
   * Harness and the plan itself.
   */
  function appendJournal(planId, key, status, bootId) {
    let line = null
    try {
      line = JSON.stringify({ k: key, s: status ?? 'ok', b: bootId ?? null, at: now() })
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
    const rows = new Map()
    let raw = ''
    try {
      raw = fsv.readFileSync(journalPath(planId), 'utf8')
    } catch {
      return rows
    }
    for (const line of raw.split('\n')) {
      if (line === '') continue
      try {
        const row = JSON.parse(line)
        if (typeof row?.k === 'string') rows.set(row.k, { status: typeof row.s === 'string' ? row.s : 'ok', boot: typeof row.b === 'string' ? row.b : null })
      } catch {
        // A torn last line is a write that never finished, not a key that was restored.
      }
    }
    return rows
  }

  function clearJournal(planId) {
    try {
      fsv.rmSync(journalPath(planId), { force: true })
    } catch {}
  }

  function writeResult(record) {
    return atomicWrite(lastRestorePath, record)
  }

  /**
   * The plan is spent: archive it, publish the record the UI reads, and only then remove it. A plan
   * that could not be archived stays on disk, so the same work is never claimed twice. A snapshot
   * that could not be removed is reported as a failure even though the archive landed: the next
   * reader would otherwise see a plan that is already restored and try to restore it again.
   */
  function consume(plan, summary) {
    const source = plan !== null && typeof plan === 'object' && !Array.isArray(plan) ? plan : {}
    const archivePath = join(restoresDir, `${sanitize(source.planId)}.json`)
    const record = { ...source, status: 'restored', restoredAt: new Date(now()).toISOString(), summary }
    const archived = atomicWrite(archivePath, record)
    const published = archived && writeResult(record)
    if (published === false) {
      log('cannot archive the restored plan: the snapshot stays')
      return { ok: false, archivePath: null, published: false }
    }
    const current = read()
    // Another press may have written a newer plan while this one restored; that one is not ours.
    if (current === null || current.planId === source.planId) {
      try {
        fsv.rmSync(snapshotPath, { force: true })
        syncDir(dir)
      } catch (error) {
        log(`cannot clear the restored plan: ${error?.message ?? error}`)
        return { ok: false, archivePath, published: true }
      }
    }
    clearJournal(source.planId)
    return { ok: true, archivePath, published: true }
  }

  function lastRestore() {
    const parsed = parse(lastRestorePath)
    return parsed
  }

  function hasSnapshot() {
    try {
      return fsv.existsSync(snapshotPath) === true
    } catch {
      return false
    }
  }

  function hasPending() {
    try {
      return fsv.existsSync(pendingPath) === true
    } catch {
      return false
    }
  }

  return {
    dir,
    snapshotPath,
    pendingPath,
    read,
    write,
    readPending,
    writePending,
    clearPending,
    appendJournal,
    readJournal,
    clearJournal,
    writeResult,
    consume,
    lastRestore,
    hasSnapshot,
    hasPending,
  }
}
