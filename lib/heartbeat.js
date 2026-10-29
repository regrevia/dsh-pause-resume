import * as fs from 'node:fs'
import { join } from 'node:path'

/**
 * Crash residue without reading logs.
 *
 * A plan only exists because a person pressed the button. A crash has no press, so this file
 * answers the other half: which sessions had a turn running a few seconds ago. It is written from
 * the same list the button already reads, coalesced, and only when the set changes.
 *
 * Version 4 records a per-session `lastTurn` with every id. The turn number is the only thing that
 * can tell a later boot whether the interrupted turn ran again after the restart: the id alone says
 * "this session was busy", the turn says "this is the turn that was lost or no longer is".
 *
 * The file carries the id of the process that wrote it. The same process reloading the plugin (HMR)
 * therefore sees its own heartbeat and nothing to restore, while a new process sees the previous
 * one's and offers resume. `stop()` deliberately leaves the last heartbeat in place: it is the
 * evidence the next process reads.
 */

const DEBOUNCE_MS = 150

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

function closeQuietly(fsv, fd) {
  try {
    fsv.closeSync(fd)
  } catch {}
}

export function createHeartbeat({ dir, bootId, intervalMs = 5000, listRunning, now = () => Date.now(), fs: fsImpl = fs, log = () => {} }) {
  const file = join(dir, 'running.json')
  let timer = null
  let noteTimer = null
  let residue = null
  let captured = false
  let started = false
  let stopped = false
  let pending = []
  let pendingGoals = []
  let lastWritten = ''
  /** A boot whose crash residue could not be recorded must not overwrite the previous heartbeat. */
  let writable = true
  /**
   * The last listing could not read the registry. That is not "nothing is running": the previous
   * rows stay in memory and on disk until a readable listing says otherwise.
   */
  let readable = true

  function noteError(message) {
    try {
      log(message)
    } catch {}
  }

  /**
   * One row per session, `{ sessionId, lastTurn }`. A bare id and a v3 row carry no turn, so their
   * `lastTurn` is null; duplicates keep the highest safe integer, which is the furthest turn the
   * record can prove.
   */
  function normalizeSessions(value) {
    const rows = new Map()
    if (Array.isArray(value)) {
      for (const item of value) {
        const sessionId = typeof item === 'string' ? item : item?.sessionId
        if (typeof sessionId !== 'string' || sessionId === '') continue
        const turn = typeof item === 'object' && item !== null && Number.isSafeInteger(item.lastTurn) ? item.lastTurn : null
        // A child's route is part of the residue: after a crash the runtime may no longer know the
        // parent, and a row without it can only be attached as a root and waits forever.
        const parent = typeof item === 'object' && item !== null && typeof item.parent === 'string' && item.parent !== '' ? item.parent : null
        const before = rows.get(sessionId)
        if (before === undefined) {
          rows.set(sessionId, { lastTurn: turn, parent })
          continue
        }
        if (turn !== null && (before.lastTurn === null || turn > before.lastTurn)) before.lastTurn = turn
        if (parent !== null) before.parent = parent
      }
    }
    const out = []
    for (const row of rows) {
      out.push(row[1].parent === null ? { sessionId: row[0], lastTurn: row[1].lastTurn } : { sessionId: row[0], lastTurn: row[1].lastTurn, parent: row[1].parent })
    }
    out.sort((a, b) => (a.sessionId < b.sessionId ? -1 : a.sessionId > b.sessionId ? 1 : 0))
    return out
  }

  /**
   * An armed goal is work even between rounds: the next round is owed to the person, and only its
   * revision proves the restore owns it. Rows without a stable id cannot be restored and are not
   * recorded, because a bad row would make the whole residue unusable.
   */
  function normalizeGoals(goals) {
    const rows = []
    const seen = new Set()
    if (Array.isArray(goals)) {
      for (const item of goals) {
        const sessionId = typeof item?.sessionId === 'string' ? item.sessionId : ''
        const goalId = typeof item?.goalId === 'string' ? item.goalId : ''
        if (sessionId === '' || goalId === '' || Number.isSafeInteger(item?.revision) === false) continue
        const key = `${sessionId}\u0000${goalId}`
        if (seen.has(key)) continue
        seen.add(key)
        rows.push({ sessionId, goalId, revision: item.revision })
      }
    }
    rows.sort((a, b) => (a.sessionId === b.sessionId ? (a.goalId < b.goalId ? -1 : a.goalId > b.goalId ? 1 : 0) : a.sessionId < b.sessionId ? -1 : 1))
    return rows
  }

  function serialize(sessions, goals) {
    return JSON.stringify({ sessions, goals })
  }

  function dirty() {
    return serialize(pending, pendingGoals) !== lastWritten
  }

  /**
   * Adopt a listing. Session ids alone describe sessions only; the residue shape describes goals
   * too. Anything else (a throw, a bare scalar) leaves the previous set rather than erasing it.
   * `readable: false` is the registry saying it cannot see its own state: that must not be recorded
   * as "nothing was running", so the last known-good rows stay untouched.
   */
  function assign(value) {
    if (value === null || value === undefined) return
    if (Array.isArray(value)) {
      readable = true
      pending = normalizeSessions(value)
      pendingGoals = []
      return
    }
    if (typeof value !== 'object') return
    if (value.readable === false) {
      readable = false
      return
    }
    readable = true
    pending = normalizeSessions(value.sessions)
    pendingGoals = normalizeGoals(value.goals)
  }

  /** Flush a directory entry, so the rename that just happened survives a power loss too. */ // ui-copy-ignore
  function syncDir(path) {
    if (process.platform === 'win32') return // ui-copy-ignore
    let fd = null
    try {
      fd = fsImpl.openSync(path, 'r')
      fsImpl.fsyncSync(fd)
    } catch (error) {
      // Some filesystems refuse a directory fsync after a rename that already landed. The record is
      // published either way; only the power-loss guarantee is weaker, so this is not a failure.
      const code = error?.code
      if (code !== 'EPERM' && code !== 'EACCES' && code !== 'ENOTSUP' && code !== 'EINVAL' && code !== 'ENOSYS' && code !== 'EBADF' && code !== 'EISDIR') {
        noteError(`cannot flush ${path}: ${error?.message ?? error}`)
      }
    } finally {
      if (fd !== null) closeQuietly(fsImpl, fd)
    }
  }

  function persist(rows, goals) {
    let body = ''
    try {
      body = JSON.stringify({ version: 4, bootId, updatedAt: now(), sessions: rows, goals })
    } catch (error) {
      noteError(`cannot record running sessions: ${error?.message ?? error}`)
      return false
    }
    const tmp = `${file}.${process.pid}.${counter++}.tmp`
    let fd = null
    let renamed = false
    try {
      fsImpl.mkdirSync(dir, { recursive: true })
      fd = fsImpl.openSync(tmp, 'w')
      fsImpl.writeSync(fd, body)
      fsImpl.fsyncSync(fd)
      const opened = fd
      fd = null
      fsImpl.closeSync(opened)
      renameReplacing(fsImpl, tmp, file)
      renamed = true
      syncDir(dir)
      lastWritten = serialize(rows, goals)
      return true
    } catch (error) {
      noteError(`cannot record running sessions: ${error?.message ?? error}`)
      return false
    } finally {
      if (fd !== null) closeQuietly(fsImpl, fd)
      if (renamed === false) {
        try {
          fsImpl.rmSync(tmp, { force: true })
        } catch {}
      }
    }
  }

  /**
   * Read the previous process's record without claiming it. The caller has to read this before
   * `start()` overwrites the file, and turning it into a durable plan may take a moment: a read that
   * also claimed would leave the very next read empty if that write failed.
   *
   * A file written before v4 stores bare ids; both shapes read back as `{ sessionId, lastTurn }`
   * with a null turn, because that file cannot prove which turn it saw.
   */
  function peek() {
    if (residue !== null) return residue
    let parsed = null
    try {
      parsed = JSON.parse(stripBom(fsImpl.readFileSync(file, 'utf8')))
    } catch {
      return null
    }
    if (parsed === null || typeof parsed !== 'object') return null
    if (typeof parsed.bootId === 'string' && parsed.bootId === bootId) return null
    const sessions = normalizeSessions(parsed.sessions)
    const goals = normalizeGoals(parsed.goals)
    if (sessions.length === 0 && goals.length === 0) return null
    residue = { sessions, goals, at: typeof parsed.updatedAt === 'number' ? parsed.updatedAt : null }
    return residue
  }

  /** Claims the previous process's heartbeat exactly once, before this process overwrites it. */
  function capture() {
    if (captured) return residue
    captured = true
    return peek()
  }

  function writePending() {
    if (writable === false) return false
    return dirty() ? persist(pending, pendingGoals) : true
  }

  /**
   * Read the running work and record it. A listing that throws keeps the previous set; a dirty set
   * left behind by a failed write is retried on the next tick. The lister may return session ids
   * alone (the legacy shape) or the full residue `{ sessions, goals }`; an unreadable registry
   * (`readable: false`) leaves the previous rows in place instead of recording an empty set.
   */
  function refresh(force = false) {
    const apply = (value) => {
      assign(value)
      if (stopped === true && force !== true) return true
      return writePending()
    }
    let value = null
    try {
      value = typeof listRunning === 'function' ? listRunning() : { sessions: pending, goals: pendingGoals }
    } catch (error) {
      noteError(`cannot list running sessions: ${error?.message ?? error}`)
      return Promise.resolve(apply(null))
    }
    if (value !== null && typeof value?.then === 'function') {
      return Promise.resolve(value).then(
        (ids) => apply(ids),
        (error) => {
          noteError(`cannot list running sessions: ${error?.message ?? error}`)
          return apply(null)
        },
      )
    }
    return Promise.resolve(apply(value))
  }

  /**
   * Event hooks report a changed set: write once, after a burst, and never block the caller. The
   * hook may pass session ids or the full `{ sessions, goals }` residue. An unreadable registry is
   * not a change: it keeps the last known-good rows and schedules no write, because the file is the
   * crash record and "I could not read" must never be published as "nothing was running".
   */
  function note(work) {
    try {
      if (work !== null && typeof work === 'object' && work.readable === false) {
        readable = false
        return
      }
      assign(work)
      if (readable === false) readable = true
      if (stopped === true || dirty() === false || noteTimer !== null) return
      noteTimer = setTimeout(() => {
        noteTimer = null
        void flush()
      }, DEBOUNCE_MS)
      if (typeof noteTimer.unref === 'function') noteTimer.unref()
    } catch (error) {
      noteError(`cannot note running sessions: ${error?.message ?? error}`)
    }
  }

  function flush() {
    try {
      return Promise.resolve(writePending())
    } catch (error) {
      noteError(`cannot record running sessions: ${error?.message ?? error}`)
      return Promise.resolve(false)
    }
  }

  function arm() {
    if (timer !== null) return
    timer = setInterval(() => {
      void refresh()
    }, intervalMs)
    if (typeof timer.unref === 'function') timer.unref()
  }

  function start() {
    if (started) return
    started = true
    stopped = false
    capture()
    void refresh()
    arm()
  }

  function stop() {
    stopped = true
    if (timer !== null) {
      clearInterval(timer)
      timer = null
    }
    if (noteTimer !== null) {
      clearTimeout(noteTimer)
      noteTimer = null
    }
  }

  /** Freeze the file after a failed crash-plan write: it is the only remaining copy of that work. */
  function hold() {
    writable = false
    stop()
  }

  /**
   * The residue was restored: this process owns the file again. Clear `stopped`, re-arm the timer
   * and allow `note()`; a permission flip alone would leave both write paths dead.
   */
  function release() {
    writable = true
    readable = true
    residue = null
    started = true
    stopped = false
    if (dirty() && noteTimer === null) {
      noteTimer = setTimeout(() => {
        noteTimer = null
        void flush()
      }, DEBOUNCE_MS)
      if (typeof noteTimer.unref === 'function') noteTimer.unref()
    }
    arm()
    void refresh(true)
  }

  return {
    note,
    peek,
    start,
    stop,
    hold,
    release,
    flush,
    get residue() {
      return residue
    },
  }
}
