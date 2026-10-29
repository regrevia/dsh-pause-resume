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
// Every intent a plan may carry. `continue` owes a turn, `mount` owes only an attach, `skip`
// proved the turn ended, `unknown` proved nothing yet and keeps the plan open.
const INTENTS = new Set(['continue', 'mount', 'unknown', 'skip'])
const DIR_SYNC_CODES = new Set(['EPERM', 'EACCES', 'ENOTSUP', 'EINVAL', 'ENOSYS', 'EBADF', 'EISDIR'])

/**
 * A rename over an existing file is atomic-replace on every platform Node supports, but Windows
 * refuses it while another handle is open on the target (an antivirus scan, a concurrent reader).
 * That refusal is transient, so a few short retries keep a pause record from being reported lost.
 * The temp file is always created next to its target, so EXDEV cannot apply: a retry here never
 * means a cross-device move.
 */
const RENAME_RETRY_CODES = new Set(['EPERM', 'EACCES', 'EBUSY', 'ENOTEMPTY'])

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/** A file saved by a Windows editor can start with a UTF-8 BOM; JSON.parse does not skip it. */
function stripBom(text) {
  return typeof text === 'string' && text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
}

function renameReplacing(fsv, from, to) {
  let last = null
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      fsv.renameSync(from, to)
      return
    } catch (error) {
      last = error
      if (RENAME_RETRY_CODES.has(error?.code) === false) throw error
      sleepSync(5 * (attempt + 1))
    }
  }
  throw last
}

let counter = 0

// Windows reserves these device names in every directory, with or without an extension: a state
// file called `CON.json` cannot be created there. Plan ids are generated, so this is only reachable
// through a hand-edited file, but padding the stem costs nothing and keeps the write path total.
const RESERVED = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/iu

function sanitize(value) {
  let name = String(value ?? '').replace(UNSAFE, '_')
  if (name === '') name = '_'
  if (RESERVED.test(name.split('.')[0]) === true) name = `_${name}`
  return name
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
      renameReplacing(fsv, tmp, target)
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
      parsed = JSON.parse(stripBom(fsv.readFileSync(path, 'utf8')))
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
    // `running` used to mean two different things: "this press stopped a turn here" (continue on
    // resume) and "this session is merely in the plan" (mount only). Version 3 records the intent
    // explicitly so a crash-only row can never turn into a continuation by accident.
    plan.sessions = (Array.isArray(plan.sessions) ? plan.sessions : []).map((row) => {
      if (typeof row?.sessionId !== 'string') return row
      const epoch = Number.isSafeInteger(row.epoch) && row.epoch > 0 ? row.epoch : 0
      // Only a row that never declared an intent may be inferred from the old `running` flag.
      // An explicit value is data: downgrading `unknown` to `mount` made a cold restore consume the
      // plan for a turn it had not proven, and reported it as finished work.
      if (typeof row.intent !== 'string') {
        const intent = row.running === true ? 'continue' : 'mount'
        return { ...row, intent, epoch, running: intent === 'continue' }
      }
      if (INTENTS.has(row.intent)) {
        return { ...row, epoch, running: row.intent === 'continue' }
      }
      // An intent this version does not know is not permission to mount: keep it, label it, and let
      // the restore report an unproven row so the button and the plan stay where they are.
      return { ...row, intent: 'unknown', legacyIntent: row.intent, epoch, running: false }
    })
    plan.goals = (Array.isArray(plan.goals) ? plan.goals : []).map((row) => (
      row !== null && typeof row === 'object' && Number.isSafeInteger(row.armedRevision) === false
        ? { ...row, armedRevision: null }
        : row
    ))
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
  function appendJournal(planId, key, status, bootId, extra = null) {
    let line = null
    try {
      const row = { k: key, s: status ?? 'ok', b: bootId ?? null, at: now() }
      // The pause cycle and the turn this row's operation admitted. A later boot needs both to tell
      // "the continuation ran and finished" from "this process never admitted it".
      if (Number.isSafeInteger(extra?.epoch)) row.e = extra.epoch
      if (Number.isSafeInteger(extra?.turn)) row.t = extra.turn
      line = JSON.stringify(row)
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
      raw = stripBom(fsv.readFileSync(journalPath(planId), 'utf8'))
    } catch {
      return rows
    }
    // A Windows editor or a copied file can make every separator `\r\n`: split on either and
    // parse the text JSON already tolerates.
    for (const line of raw.split(/\r?\n/)) {
      if (line === '') continue
      try {
        const row = JSON.parse(line)
        if (typeof row?.k === 'string') rows.set(row.k, {
          status: typeof row.s === 'string' ? row.s : 'ok',
          boot: typeof row.b === 'string' ? row.b : null,
          epoch: Number.isSafeInteger(row.e) ? row.e : null,
          turn: Number.isSafeInteger(row.t) ? row.t : null,
        })
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

  /** A fresh pause starts a new cycle, so the previous restore's report is no longer current. */
  function clearResult() {
    try {
      fsv.rmSync(lastRestorePath, { force: true })
      syncDir(dir)
      return true
    } catch (error) {
      log(`cannot clear the restore report: ${error?.message ?? error}`)
      return false
    }
  }

  /**
   * The plan is spent: archive it, publish the record the UI reads, and only then remove it. A plan
   * that could not be archived stays on disk, so the same work is never claimed twice. A snapshot
   * that could not be removed is reported as a failure even though the archive landed: the next
   * reader would otherwise see a plan that is already restored and try to restore it again.
   */
  function consume(plan, summary, status = 'restored') {
    const source = plan !== null && typeof plan === 'object' && !Array.isArray(plan) ? plan : {}
    const archivePath = join(restoresDir, `${sanitize(source.planId)}.json`)
    const record = { ...source, status, restoredAt: new Date(now()).toISOString(), summary }
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
    clearResult,
    consume,
    lastRestore,
    hasSnapshot,
    hasPending,
  }
}
