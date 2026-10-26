import * as fs from 'node:fs'
import { join } from 'node:path'

/**
 * Crash residue without reading logs.
 *
 * A plan only exists because a person pressed the button. A crash has no press, so this file
 * answers the other half: which sessions had a turn running a few seconds ago. It is written from
 * the same list the button already reads, coalesced, and only when the set changes.
 *
 * The file carries the id of the process that wrote it. The same process reloading the plugin (HMR)
 * therefore sees its own heartbeat and nothing to restore, while a new process sees the previous
 * one's and offers resume. `stop()` deliberately leaves the last heartbeat in place: it is the
 * evidence the next process reads.
 */

const DEBOUNCE_MS = 150

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
  let lastWritten = ''

  function noteError(message) {
    try {
      log(message)
    } catch {}
  }

  function normalize(ids) {
    const rows = []
    const seen = new Set()
    if (Array.isArray(ids)) {
      for (const item of ids) {
        const sessionId = typeof item === 'string' ? item : item?.sessionId
        if (typeof sessionId !== 'string' || sessionId === '' || seen.has(sessionId)) continue
        seen.add(sessionId)
        rows.push({ sessionId })
      }
    }
    rows.sort((a, b) => (a.sessionId < b.sessionId ? -1 : a.sessionId > b.sessionId ? 1 : 0))
    return rows
  }

  function serialize(rows) {
    return JSON.stringify(rows)
  }

  function dirty() {
    return serialize(pending) !== lastWritten
  }

  /** Flush a directory entry, so the rename that just happened survives a power loss too. */ // ui-copy-ignore
  function syncDir(path) {
    let fd = null
    try {
      fd = fsImpl.openSync(path, 'r')
      fsImpl.fsyncSync(fd)
    } finally {
      if (fd !== null) closeQuietly(fsImpl, fd)
    }
  }

  function persist(rows) {
    let body = ''
    try {
      body = JSON.stringify({ version: 2, bootId, updatedAt: now(), sessions: rows })
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
      fsImpl.renameSync(tmp, file)
      renamed = true
      syncDir(dir)
      lastWritten = serialize(rows)
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

  /** Claims the previous process's heartbeat exactly once, before this process overwrites it. */
  function capture() {
    if (captured) return residue
    captured = true
    let parsed = null
    try {
      parsed = JSON.parse(fsImpl.readFileSync(file, 'utf8'))
    } catch {
      return null
    }
    if (parsed === null || typeof parsed !== 'object') return null
    if (typeof parsed.bootId === 'string' && parsed.bootId === bootId) return null
    const sessions = normalize(parsed.sessions)
    if (sessions.length === 0) return null
    residue = { sessions, at: typeof parsed.updatedAt === 'number' ? parsed.updatedAt : null }
    return residue
  }

  function writePending() {
    return dirty() ? persist(pending) : true
  }

  /**
   * Read the running set and record it. A listing that throws keeps the previous set; a dirty set
   * left behind by a failed write is retried on the next tick.
   */
  function refresh(force = false) {
    const apply = (ids) => {
      if (ids !== null) pending = normalize(ids)
      if (stopped === true && force !== true) return true
      return writePending()
    }
    let value = null
    try {
      value = typeof listRunning === 'function' ? listRunning() : pending
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

  /** Event hooks report a changed set: write once, after a burst, and never block the caller. */
  function note(sessionIds) {
    pending = normalize(sessionIds)
    if (stopped === true || dirty() === false || noteTimer !== null) return
    noteTimer = setTimeout(() => {
      noteTimer = null
      void flush()
    }, DEBOUNCE_MS)
    if (typeof noteTimer.unref === 'function') noteTimer.unref()
  }

  function flush() {
    try {
      return Promise.resolve(writePending())
    } catch (error) {
      noteError(`cannot record running sessions: ${error?.message ?? error}`)
      return Promise.resolve(false)
    }
  }

  function start() {
    if (started) return
    started = true
    stopped = false
    capture()
    void refresh()
    timer = setInterval(() => {
      void refresh()
    }, intervalMs)
    if (typeof timer.unref === 'function') timer.unref()
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

  /** The residue was restored: from here on the heartbeat describes this process again. */
  function release() {
    residue = null
    void refresh(true)
  }

  return {
    note,
    start,
    stop,
    release,
    flush,
    get residue() {
      return residue
    },
  }
}
