import { mkdirSync, openSync, closeSync, fsyncSync, readFileSync, renameSync, writeSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Crash residue without reading logs.
 *
 * A snapshot only exists because a person pressed the button. A crash has no press, so this file
 * answers the other half: which sessions had a turn running a few seconds ago. It is written on a
 * timer from the same list the button already reads, and only when the set changes.
 *
 * The file carries the id of the process that wrote it. The same process reloading the plugin (HMR)
 * therefore sees its own heartbeat and nothing to restore, while a new process sees the previous
 * one's and offers ▶.
 */
export function createHeartbeat({ dir, bootId, intervalMs = 5000, listRunning, now = () => Date.now(), log = () => {} }) {
  const file = join(dir, 'running.json')
  let timer = null
  let last = ''
  let residue = null
  let stopped = false

  function write(sessions) {
    const body = JSON.stringify({ version: 1, bootId, updatedAt: now(), sessions })
    try {
      mkdirSync(dir, { recursive: true })
      const tmp = `${file}.${process.pid}.tmp`
      const fd = openSync(tmp, 'w')
      try {
        writeSync(fd, body)
        fsyncSync(fd)
      } finally {
        closeSync(fd)
      }
      renameSync(tmp, file)
      return true
    } catch (error) {
      log(`cannot record running sessions: ${error?.message ?? error}`)
      return false
    }
  }

  /** Claims the previous process's heartbeat once, at start, before this process overwrites it. */
  function capture() {
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8'))
      if (parsed === null || typeof parsed !== 'object' || parsed.version !== 1) return null
      if (typeof parsed.bootId === 'string' && parsed.bootId === bootId) return null
      const sessions = Array.isArray(parsed.sessions) ? parsed.sessions.filter((row) => typeof row?.sessionId === 'string') : []
      if (sessions.length === 0) return null
      residue = { sessions, at: typeof parsed.updatedAt === 'number' ? parsed.updatedAt : null }
      return residue
    } catch {
      return null
    }
  }

  async function tick() {
    if (stopped || residue !== null) return
    let sessions
    try {
      sessions = await listRunning()
    } catch (error) {
      log(`cannot list running sessions: ${error?.message ?? error}`)
      return
    }
    const body = JSON.stringify(sessions.map((sessionId) => ({ sessionId })))
    if (body === last) return
    last = body
    write(sessions.map((sessionId) => ({ sessionId })))
  }

  function start() {
    if (stopped || timer !== null) return
    capture()
    void tick()
    timer = setInterval(() => void tick(), intervalMs)
    if (typeof timer.unref === 'function') timer.unref()
  }

  /** The residue was restored: from here on the heartbeat describes this process again. */
  function release() {
    residue = null
    last = ''
    write([])
  }

  function stop() {
    stopped = true
    if (timer !== null) clearInterval(timer)
    timer = null
    if (residue === null) write([])
  }

  return { start, stop, release, get residue() { return residue } }
}
