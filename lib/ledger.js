import * as fs from 'node:fs'
import { dirname, join } from 'node:path'

/**
 * The ledger of work that stopped on its own.
 *
 * A pause plan is a person's stop and lives only as long as that operation. This file is the other
 * kind of residue: a turn that ended because the model call failed or ran out of budget, while the
 * process is still alive. Nothing here auto-sends. A row is evidence for the one button the person
 * presses, and the press authorizes exactly the rows it saw; a row that fails again stays for the
 * next press instead of retrying in a loop.
 *
 * Only the final `turn/end` of a turn is a candidate. The official retry layer reports its attempts
 * through `llm/retry`, and a request that failed and was retried is not a stopped task. A `turn/end`
 * with `completed`, `aborted`, `interrupted` or `blocked` clears the row: a person's stop and a
 * deliberate end must never look resumable.
 *
 * The file is best effort. A disk that cannot be written loses the reminder, not the session, so
 * every write answers a boolean and nothing here throws into the event stream.
 */

const VERSION = 1
const MAX_ROWS = 40
// Work is only "fully stopped" after its end event and a short quiet window. A queued follow-up
// opens its own turn; clearing on `turn/start` is what makes the row disappear before it is shown.
const SETTLE_MS = 1500
const CANDIDATE_KINDS = new Set(['error', 'max-tokens'])
const CLEAR_KINDS = new Set(['completed', 'aborted', 'interrupted', 'blocked'])
const TITLE_LIMIT = 80
const DETAIL_LIMIT = 120
const WORKERS = 2
/** Errors a retry cannot fix on its own: the person has to change something first. */
const PERMANENT_CODE = /(?:auth|api[_-]?key|permission|forbidden|unauthori[sz]ed|quota|billing|insufficient|invalid[_-]?request|invalid[_-]?argument|model[_-]?not[_-]?found|not[_-]?found|unsupported[_-]?model|context[_-]?length)/i
const DIR_SYNC_CODES = new Set(['EPERM', 'EACCES', 'ENOTSUP', 'EINVAL', 'ENOSYS', 'EBADF', 'EISDIR'])

let counter = 0

function textOf(value, limit) {
  return typeof value === 'string' && value !== '' ? value.slice(0, limit) : null
}

function closeQuietly(fsv, fd) {
  try {
    fsv.closeSync(fd)
  } catch {}
}

/** The fields of one end event this ledger classifies, or null when it is not a readable end. */
function readEnd(event) {
  if (event === null || typeof event !== 'object' || event.type !== 'turn/end') return null
  const turn = Number.isSafeInteger(event?.data?.turn) ? event.data.turn : null
  const kind = typeof event?.data?.reason?.kind === 'string' ? event.data.reason.kind : null
  if (turn === null || kind === null) return null
  const failure = kind === 'error' && event?.data?.reason?.error !== null && typeof event?.data?.reason?.error === 'object'
    ? event.data.reason.error
    : null
  return {
    turn,
    kind,
    seq: Number.isSafeInteger(event.seq) ? event.seq : null,
    code: textOf(failure?.code, 40),
    status: Number.isInteger(failure?.status) ? failure.status : null,
    failure: textOf(failure?.message, 160),
    at: Number.isFinite(event?.time) ? event.time : null,
  }
}

export function createLedger(options = {}) {
  const fsv = options.fs ?? fs
  const now = typeof options.now === 'function' ? options.now : Date.now
  const log = typeof options.log === 'function' ? options.log : () => {}
  const probe = options.probe ?? null
  const dir = typeof options.dir === 'string' && options.dir !== '' ? options.dir : null
  const file = dir === null ? null : join(dir, 'continue.json')

  /** sessionId -> row. Insertion order is not used; `at` orders the view. */
  const rows = new Map()
  /** Titles arrive before or after the row; a bounded cache keeps the later one named. */
  const titles = new Map()
  let busy = false
  /**
   * The press in flight. A pause must be able to stop the rows that have not been dispatched yet:
   * clearing `busy` is not enough, because every worker is already awaiting its own row. The token
   * is checked at each boundary and its AbortSignal reaches the official prompt.
   */
  let batch = null
  /** The last press's dispatched ids, kept after the batch unwinds so a pause can report them. */
  let lastStarted = []

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

  function atomicWrite(value) {
    if (file === null) return false
    let body = null
    try {
      body = JSON.stringify(value)
    } catch (error) {
      log(`cannot serialize continues: ${error?.message ?? error}`)
      return false
    }
    const tmp = `${file}.${process.pid}.${counter++}.tmp`
    let fd = null
    let renamed = false
    try {
      fsv.mkdirSync(dirname(file), { recursive: true })
      fd = fsv.openSync(tmp, 'w', 0o600)
      fsv.writeFileSync(fd, body)
      try {
        fsv.fsyncSync(fd)
      } catch {
        /* the rename still publishes a complete file */
      }
      fsv.closeSync(fd)
      fd = null
      fsv.renameSync(tmp, file)
      renamed = true
      syncDir(dirname(file))
      return true
    } catch (error) {
      log(`cannot write continues: ${error?.message ?? error}`)
      return false
    } finally {
      if (fd !== null) closeQuietly(fsv, fd)
      if (renamed === false) {
        try {
          fsv.unlinkSync(tmp)
        } catch {}
      }
    }
  }

  function normalize(row) {
    if (row === null || typeof row !== 'object') return null
    if (typeof row.sessionId !== 'string' || row.sessionId === '') return null
    if (Number.isSafeInteger(row.turn) === false) return null
    if (CANDIDATE_KINDS.has(row.kind) === false) return null
    // A row written as `running` belonged to a press the old process did not finish. Nothing is
    // running until this process proves it, so it comes back as a candidate, never as progress.
    const status = row.status === 'attention' ? 'attention' : 'waiting'
    return {
      sessionId: row.sessionId,
      turn: row.turn,
      seq: Number.isSafeInteger(row.seq) ? row.seq : null,
      kind: row.kind,
      code: textOf(row.code, 40),
      status,
      at: Number.isFinite(row.at) ? row.at : now(),
      attempt: Number.isSafeInteger(row.attempt) && row.attempt > 0 ? row.attempt : 0,
      parent: textOf(row.parent, 120),
      origin: row.origin === 'subagent' ? 'subagent' : null,
      title: textOf(row.title, TITLE_LIMIT),
      detail: textOf(row.detail, DETAIL_LIMIT),
      admittedRequest: textOf(row.admittedRequest, 160),
    }
  }

  function load() {
    if (file === null) return
    let parsed = null
    try {
      parsed = JSON.parse(fsv.readFileSync(file, 'utf8'))
    } catch {
      return
    }
    const list = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.rows) ? parsed.rows : []
    for (const raw of list) {
      const row = normalize(raw)
      if (row === null) continue
      rows.set(row.sessionId, row)
    }
  }

  function persist() {
    const list = [...rows.values()].sort((a, b) => b.at - a.at).slice(0, MAX_ROWS)
    return atomicWrite({ version: VERSION, rows: list, at: now() })
  }

  function trim() {
    if (rows.size <= MAX_ROWS) return
    const sorted = [...rows.values()].sort((a, b) => b.at - a.at)
    for (const row of sorted.slice(MAX_ROWS)) rows.delete(row.sessionId)
  }

  function drop(sessionId) {
    return rows.delete(sessionId)
  }

  /** The row a status call may show: recent enough to be settled, and not already running. */
  function visible(row) {
    if (now() - row.at < SETTLE_MS) return false
    if (probe === null) return true
    try {
      const status = probe.statusOf(row.sessionId)
      return status === null || status.running !== true
    } catch {
      return true
    }
  }

  /**
   * One session event. Called for every event of every session, so it must stay cheap and must not
   * throw: a title is cached, a start clears, and only a final end can create a row.
   */
  function observe(sessionId, event, meta = null) {
    try {
      if (typeof sessionId !== 'string' || sessionId === '' || event === null || typeof event !== 'object') return
      // A child session's stop is answered by its parent's tool result, which becomes the parent's
      // own turn. Continuing the child directly would write into a conversation nobody is reading.
      if (meta?.parent !== null && meta?.parent !== undefined) return
      if (meta?.origin === 'subagent') return
      if (event.type === 'session/title') {
        const title = textOf(event?.data?.title, TITLE_LIMIT)
        if (title === null) return
        titles.set(sessionId, title)
        if (titles.size > 200) {
          const first = titles.keys().next()
          if (first?.done === false) titles.delete(first.value)
        }
        const row = rows.get(sessionId)
        if (row !== undefined && row.title !== title) {
          row.title = title
          persist()
        }
        return
      }
      const end = readEnd(event)
      if (end !== null) {
        const row = rows.get(sessionId)
        if (CLEAR_KINDS.has(end.kind)) {
          if (row !== undefined) {
            drop(sessionId)
            persist()
          }
          return
        }
        if (CANDIDATE_KINDS.has(end.kind) === false) return
        if (row !== undefined && (row.turn > end.turn || (row.turn === end.turn && row.seq !== null && end.seq !== null && end.seq <= row.seq))) return
        // A newer failure replaces the older one: the later end is the work still owed. The
        // attempt counter resets because this is a different stop, not a retry of the same press.
        const next = {
          sessionId,
          turn: end.turn,
          seq: end.seq,
          kind: end.kind,
          code: end.code,
          status: 'waiting',
          at: end.at ?? now(),
          attempt: 0,
          parent: row?.parent ?? meta?.parent ?? null,
          origin: row?.origin ?? (meta?.origin === 'subagent' ? 'subagent' : null),
          title: row?.title ?? titles.get(sessionId) ?? null,
          detail: null,
        }
        if (row?.parent === null || row?.parent === undefined) {
          try {
            const status = probe?.statusOf?.(sessionId)
            if (status?.parent !== null && status?.parent !== undefined) next.parent = status.parent
            if (status?.origin === 'subagent') next.origin = 'subagent'
          } catch {}
        }
        rows.set(sessionId, next)
        trim()
        persist()
        return
      }
      if (event.type === 'turn/start') {
        const turn = Number.isSafeInteger(event?.data?.turn) ? event.data.turn : null
        const row = rows.get(sessionId)
        // A start at or after the stopped turn means the person or a queued message already picked
        // the work up. A start before it cannot clear a later stop.
        if (row !== undefined && (turn === null || turn >= row.turn)) {
          drop(sessionId)
          persist()
        }
      }
    } catch (error) {
      log(`cannot follow a turn end: ${error?.message ?? error}`)
    }
  }

  /** What the button and the API see. No session is mounted to answer this. */
  function describe() {
    let list = []
    try {
      list = [...rows.values()].filter(visible).sort((a, b) => b.at - a.at)
    } catch (error) {
      log(`cannot describe continues: ${error?.message ?? error}`)
    }
    const tasks = list.map((row) => {
      const blocking = blockingOf(row)
      return {
        sessionId: row.sessionId,
        turn: row.turn,
        kind: row.kind,
        code: row.code,
        status: row.status,
        blocking,
        actionable: blocking === false,
        title: row.title,
        at: row.at,
        attempt: row.attempt,
      }
    })
    const blocking = tasks.filter((task) => task.blocking === true).length
    return {
      count: list.length,
      attention: list.filter((row) => row.status === 'attention').length,
      // A row that failed permanently is still shown and still costs the same single press; only
      // the label differs, so a page can say "needs you" without hiding it from the list.
      blocking,
      actionable: tasks.length - blocking,
      busy,
      tasks,
    }
  }

  /**
   * Actionable means this row can be offered again as-is: the failure looked transient, or nothing
   * has been attempted yet. Blocking means a press is unlikely to help until the person fixes the
   * cause (a key, a permission, a model name) or reads what the last attempt said. It is a label for
   * the page, not a second queue: a blocking row stays in the same list and the same single press.
   */
  function blockingOf(row) {
    if (row.status === 'attention') return true
    const code = typeof row.code === 'string' ? row.code.trim() : ''
    return code !== '' && PERMANENT_CODE.test(code) === true
  }

  function outcomeOf(row, result) {
    const status = typeof result?.status === 'string' ? result.status : 'failed'
    const detail = textOf(result?.detail, DETAIL_LIMIT) ?? status
    const turnEnd = typeof result?.turnEnd === 'string' ? result.turnEnd : null
    const turn = Number.isSafeInteger(result?.turn) ? result.turn : row.turn
    return { status, detail, turnEnd, turn }
  }

  /**
   * Revalidate one row against durable evidence before any message is admitted. The row was a
   * reminder, not proof: a person may have continued the turn, it may have ended better, or a newer
   * failure may now be the work owed.
   */
  async function revalidate(row) {
    let latest = null
    if (probe !== null && typeof probe.latestTurnEnd === 'function') {
      try {
        latest = await probe.latestTurnEnd(row.sessionId)
      } catch (error) {
        return { action: 'keep', detail: `无法读取结束记录：${String(error?.message ?? error).slice(0, 80)}` }
      }
    }
    if (latest === null) return { action: 'attempt' }
    if (latest.openTurn !== null && latest.openTurn >= row.turn) return { action: 'drop', detail: '这一轮已经在进行' }
    const end = latest.end
    if (end === null) return { action: 'attempt' }
    if (end.turn < row.turn) return { action: 'attempt' }
    if (end.turn > row.turn || end.kind !== row.kind) {
      if (CLEAR_KINDS.has(end.kind)) return { action: 'drop', detail: '这一轮已经结束' }
      if (CANDIDATE_KINDS.has(end.kind) === false) return { action: 'drop', detail: '这一轮已经结束' }
      row.turn = end.turn
      row.kind = end.kind
      row.seq = Number.isSafeInteger(end.seq) ? end.seq : null
      row.code = textOf(end.code, 40)
      row.detail = null
    }
    return { action: 'attempt' }
  }

  function settle(row, detail) {
    row.status = 'attention'
    row.detail = textOf(detail, DETAIL_LIMIT)
    row.attempt += 1
  }

  function cancelled(token) {
    return token !== null && token.cancelled === true
  }

  /** The message was actually handed to the official controller, so this row is no longer queued. */
  function noteStarted(sessionId) {
    if (batch === null || typeof sessionId !== 'string') return false
    batch.started.add(sessionId)
    return true
  }

  /**
   * The admitted request id, persisted on the ledger row. The synthetic continue plan has no engine
   * row, so without this the admission would exist only in this process and a crash could resend it.
   */
  function noteAdmitted(sessionId, requestId) {
    const row = rows.get(sessionId)
    if (row === undefined) return false
    if (typeof requestId === 'string' && requestId !== '') row.admittedRequest = requestId
    if (batch !== null) batch.admissions.set(sessionId, requestId ?? null)
    return persist()
  }

  /** One row, after its evidence was re-read. Returns `continued`, `dropped` or `kept`. */
  async function attempt(row, token = null) {
    if (cancelled(token)) return { sessionId: row.sessionId, status: 'cancelled', detail: '暂停已取消' }
    const check = await revalidate(row)
    if (cancelled(token)) return { sessionId: row.sessionId, status: 'cancelled', detail: '暂停已取消' }
    if (check.action === 'drop') {
      drop(row.sessionId)
      return { sessionId: row.sessionId, status: 'dropped', detail: check.detail ?? null }
    }
    if (check.action === 'keep') {
      settle(row, check.detail)
      return { sessionId: row.sessionId, status: 'attention', detail: row.detail }
    }
    let status = null
    try {
      status = probe?.statusOf?.(row.sessionId) ?? null
    } catch {
      status = null
    }
    if (status?.running === true) {
      drop(row.sessionId)
      return { sessionId: row.sessionId, status: 'dropped', detail: '已经恢复运行' }
    }
    if (status?.parent !== null && status?.parent !== undefined) row.parent = status.parent
    if (status?.origin === 'subagent') row.origin = 'subagent'
    const goal = status?.goal
    if (goal !== null && goal !== undefined) {
      if (goal.unreadable === true) {
        settle(row, `无法读取目标：${String(goal.detail ?? '').slice(0, 80)}`)
        return { sessionId: row.sessionId, status: 'attention', detail: row.detail }
      }
      if (goal.phase === 'active') {
        // An armed goal is already running; re-arming it would be a second execution. A disarmed
        // active goal is exactly what the round driver leaves after an abnormal stop.
        if (goal.activation === 'armed') {
          drop(row.sessionId)
          return { sessionId: row.sessionId, status: 'dropped', detail: '目标仍在运行' }
        }
        if (cancelled(token)) return { sessionId: row.sessionId, status: 'cancelled', detail: '暂停已取消' }
        let result = null
        try {
          result = await probe.continueGoal(
            { sessionId: row.sessionId, goalId: goal.id },
            { isCancelled: () => cancelled(token), signal: token?.controller?.signal ?? null },
          )
        } catch (error) {
          result = { status: 'failed', detail: String(error?.message ?? error) }
        }
        if (cancelled(token)) return { sessionId: row.sessionId, status: 'cancelled', detail: '暂停已取消' }
        if (result?.status === 'restored' || result?.status === 'skipped') {
          drop(row.sessionId)
          return { sessionId: row.sessionId, status: 'continued', detail: result.detail ?? null }
        }
        settle(row, result?.detail ?? '无法恢复目标')
        return { sessionId: row.sessionId, status: 'attention', detail: row.detail }
      }
      // Paused, blocked and completed goals were stopped or finished on purpose. They are not an
      // abnormal stop and this press must not reopen them.
      drop(row.sessionId)
      return { sessionId: row.sessionId, status: 'dropped', detail: `目标处于 ${goal.phase}` }
    }
    if (cancelled(token)) return { sessionId: row.sessionId, status: 'cancelled', detail: '暂停已取消' }
    let result = null
    try {
      result = await probe.continueSession(row, {
        isCancelled: () => cancelled(token),
        signal: token?.controller?.signal ?? null,
      })
    } catch (error) {
      result = { status: 'failed', detail: String(error?.message ?? error) }
    }
    if (cancelled(token) && result?.continued !== true) {
      return { sessionId: row.sessionId, status: 'cancelled', detail: '暂停已取消' }
    }
    const outcome = outcomeOf(row, result)
    if (outcome.status === 'restored') {
      // The admitted turn may already have ended inside the observe window. If it ended the same
      // abnormal way it is still owed work, at the new turn, and belongs in the next press.
      if (outcome.turnEnd !== null && CANDIDATE_KINDS.has(outcome.turnEnd) && outcome.turn > row.turn) {
        row.turn = outcome.turn
        row.kind = outcome.turnEnd
        row.seq = null
        row.status = 'waiting'
        row.detail = null
        row.at = now()
        return { sessionId: row.sessionId, status: 'kept', detail: '又中断了一次' }
      }
      drop(row.sessionId)
      return { sessionId: row.sessionId, status: 'continued', detail: outcome.detail }
    }
    if (outcome.status === 'skipped') {
      drop(row.sessionId)
      return { sessionId: row.sessionId, status: 'dropped', detail: outcome.detail }
    }
    settle(row, outcome.detail)
    return { sessionId: row.sessionId, status: 'attention', detail: row.detail }
  }

  async function mapLimit(items, limit, work) {
    const results = new Array(items.length)
    let cursor = 0
    const worker = async () => {
      for (;;) {
        const index = cursor
        cursor += 1
        if (index >= items.length) return
        try {
          results[index] = await work(items[index], index)
        } catch (error) {
          results[index] = { sessionId: items[index].sessionId, status: 'failed', detail: String(error?.message ?? error) }
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
    return results
  }

  /**
   * Continue the rows this call was shown. `ids` limits the batch to what the person actually saw;
   * a row that appears later is not part of this press. Nothing is retried automatically.
   */
  async function continueAll({ ids = null } = {}) {
    if (busy) return { status: 'busy', attempted: 0, continued: 0, remaining: describe().count, attention: 0, results: [] }
    let picked = []
    if (Array.isArray(ids)) {
      const wanted = new Set(ids.filter((id) => typeof id === 'string'))
      picked = [...rows.values()].filter((row) => wanted.has(row.sessionId) && visible(row))
    } else {
      picked = [...rows.values()].filter(visible)
    }
    if (picked.length === 0) return { status: 'empty', attempted: 0, continued: 0, remaining: 0, attention: 0, results: [], cancelled: false, started: [] }
    const token = { cancelled: false, controller: new AbortController(), started: new Set(), admissions: new Map() }
    batch = token
    busy = true
    for (const row of picked) row.status = 'running'
    persist()
    let results = []
    try {
      results = await mapLimit(picked, WORKERS, (row) => attempt(row, token))
    } finally {
      busy = false
      for (const row of rows.values()) if (row.status === 'running') row.status = 'waiting'
      persist()
      lastStarted = [...token.started]
      if (batch === token) batch = null
      token.done = true
      for (const resolve of token.waiters ?? []) resolve()
    }
    const state = describe()
    const continued = results.filter((row) => row.status === 'continued').length
    const cancelledCount = results.filter((row) => row.status === 'cancelled').length
    log(`continue: ${continued}/${picked.length} continued, ${cancelledCount} cancelled, ${state.count} waiting`)
    return {
      status: 'accepted',
      attempted: picked.length,
      continued,
      cancelled: token.cancelled === true,
      cancelledCount,
      started: [...token.started],
      remaining: state.count,
      attention: state.attention,
      results,
    }
  }

  load()

  /** Stop dispatching the press in flight. Rows already prompted are reported as started. */
  function cancel() {
    if (batch === null) return false
    batch.cancelled = true
    try {
      batch.controller.abort()
    } catch {
      /* an already aborted controller is the desired state */
    }
    return true
  }

  /** Wait for the cancelled press to unwind, bounded: a pause must never hang on one prompt. */
  async function drain(timeoutMs = 8000) {
    const token = batch
    if (token === null) return true
    const ms = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 8000
    if (token.done === true) return true
    return await new Promise((resolve) => {
      let timer = null
      const finish = (value) => {
        if (timer !== null) clearTimeout(timer)
        resolve(value)
      }
      token.waiters = token.waiters ?? []
      token.waiters.push(() => finish(true))
      timer = setTimeout(() => finish(false), ms)
      if (token.done === true) finish(true)
    })
  }

  return {
    observe,
    describe,
    continueAll,
    cancel,
    drain,
    noteStarted,
    noteAdmitted,
    /** Test and API helper: the number of rows a state answer would show. */
    count: () => describe().count,
    busy: () => busy,
    /** True while this press owns a dispatch that a pause can still cut. */
    inFlight: () => batch !== null,
    startedIds: () => (batch === null ? [...lastStarted] : [...batch.started]),
  }
}
