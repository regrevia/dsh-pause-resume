/**
 * The restore gate: the one place that decides how many model requests may be in flight while a
 * pause plan is being put back. A restore that starts six long sessions at once can also start six
 * upstream streams at once; the restore loop alone cannot prevent that, because a session counts as
 * "started" as soon as its turn opens, long before the provider answers. This gate sits in front of
 * `llm/stream`, so it holds the real thing: one adapter request per slot, compaction and retries
 * included, and a slot is released only when the stream ends or is cancelled.
 *
 * The gate is batch-scoped: only sessions this restore batch reserved or tracked are limited. A
 * person typing in another session while a restore runs keeps the ordinary request path — the gate
 * must never queue an unrelated stream behind a restore.
 *
 * Outside a restore the gate is closed for business (`enabled() === false`) and adds no listener
 * cost: the caller forwards straight to the next middleware.
 */

function abortError() {
  const error = new Error('restore gate interrupted')
  error.name = 'AbortError'
  return error
}

/**
 * Map how one model stream ended onto the release outcome. A stream the consumer walked away from
 * never reaches a terminal chunk, so it is cancelled by definition. A full-consumption `aborted`
 * is only a strike when the upstream (not this process) aborted: a pause cancels through the
 * caller's signal, and a restore cooldown caused by the person pressing pause would be wrong.
 */
export function streamOutcome({ ended = false, kind = null, aborted = false } = {}) {
  if (ended !== true) return 'cancelled'
  if (kind === 'aborted') return aborted === true ? 'aborted' : 'error'
  if (kind === 'error' || kind === 'blocked') return 'error'
  return 'ok'
}

export function createGate(options = {}) {
  const maxCapacity = Number.isSafeInteger(options.maxCapacity) && options.maxCapacity > 0 ? options.maxCapacity : 2
  const initial = Number.isSafeInteger(options.capacity) && options.capacity > 0 ? Math.min(options.capacity, maxCapacity) : 1
  const cooldownMs = Number.isSafeInteger(options.cooldownMs) && options.cooldownMs >= 0 ? options.cooldownMs : 40000
  // A tracked turn that never reports its end must not pin the gate forever.
  const holdMs = Number.isSafeInteger(options.holdMs) && options.holdMs > 0 ? options.holdMs : 1800000
  // A prompt that was admitted but whose turn opens after the drain visibly ended still belongs to
  // the batch for a moment. Past this window a turn in the same session is a person's own work.
  const lateWindowMs = Number.isSafeInteger(options.lateWindowMs) && options.lateWindowMs >= 0 ? options.lateWindowMs : 30000
  const now = typeof options.now === 'function' ? options.now : Date.now
  const log = typeof options.log === 'function' ? options.log : () => {}

  let guarded = false
  // Set by `unguard()` while requests are still parked: the batch is over, but the queue is emptied
  // one slot at a time instead of all at once. Releasing every waiter together is what turned a
  // six-session restore into six concurrent provider streams the moment the press returned.
  let draining = false
  // Sessions this batch admitted. A turn outlives the streams it makes (tool calls sit between
  // them), so the gate must stay armed while one is open: closing on "no stream right now" let the
  // second model call of a restored turn start outside the limit.
  const tracked = new Set()
  // Every session this batch has touched. Membership outlives `tracked` so the turn edges of an
  // admitted continuation can still be recognised after a drain closed early.
  const restored = new Set()
  // A pending start: `reserve()` runs immediately before the restore prompts, because the shipped
  // controller emits `turn/start` synchronously inside `prompt()` — before `onAdmitted()` exists.
  // Without this the event arrived untracked, `openTurns` stayed 0, and the drain closed while six
  // restored sessions were still about to stream.
  const reserved = new Set()
  // Sessions whose prompt was reported as failed (or whose admission outlived the drain): a turn may
  // still open, and it still belongs to the batch inside this bounded window.
  const late = new Map()
  let openTurns = 0
  // Sessions whose turn is currently open. A duplicated `turn/start` (a reconnected dispatch can
  // replay one) must not be counted twice, or one turn end would leave the gate armed for the whole
  // hold window and throttle unrelated restored work.
  const open = new Set()
  let holdTimer = null
  let limit = initial
  let started = 0
  let healthy = 0
  let strike = 0
  let cooldownUntil = 0
  let timer = null
  let dispatched = 0
  let failed = 0
  let interrupted = 0
  let lastDispatchAt = 0
  /** @type {Array<{meta: object, resolve: Function, reject: Function, signal?: AbortSignal, onAbort?: Function}>} */
  const queue = []

  function stats() {
    return {
      enabled: guarded,
      draining,
      capacity: limit,
      running: started,
      queued: queue.length,
      openTurns,
      tracked: tracked.size,
      reserved: reserved.size,
      restored: restored.size,
      late: late.size,
      dispatched,
      failed,
      interrupted,
      cooldownUntil,
    }
  }

  function batchOpen() {
    return guarded === true || draining === true
  }

  /** Re-arm a batch whose drain closed early: a late admission still has to be limited. */
  function reopen() {
    if (guarded === true) return
    guarded = true
    draining = true
  }

  /** Nothing is left to limit: no waiter, no stream, no open turn, no pending prompt. */
  function drained() {
    return queue.length === 0 && started === 0 && openTurns === 0 && reserved.size === 0
  }

  function armTimer() {
    if (timer !== null) return
    const wait = Math.max(0, cooldownUntil - now())
    timer = setTimeout(() => {
      timer = null
      pump()
    }, wait)
    if (typeof timer.unref === 'function') timer.unref()
  }

  function drop(waiter, error) {
    const at = queue.indexOf(waiter)
    if (at !== -1) queue.splice(at, 1)
    if (typeof waiter.onAbort === 'function' && waiter.signal !== undefined && waiter.signal !== null) {
      try {
        waiter.signal.removeEventListener('abort', waiter.onAbort)
      } catch {
        /* an already-aborted signal is fine */
      }
    }
    if (error !== null) waiter.reject(error)
  }

  function hand(waiter) {
    started += 1
    dispatched += 1
    lastDispatchAt = now()
    if (typeof waiter.onAbort === 'function' && waiter.signal !== undefined && waiter.signal !== null) {
      try {
        waiter.signal.removeEventListener('abort', waiter.onAbort)
      } catch {
        /* ignore */
      }
    }
    waiter.resolve({ free: false })
  }

  function finishDrain() {
    // An admitted turn whose `turn/start` has not arrived yet keeps a bounded claim on the batch:
    // demoting instead of forgetting is what makes a late event reopen the drain rather than leak.
    const at = now()
    for (const sessionId of tracked) late.set(sessionId, at)
    tracked.clear()
    open.clear()
    openTurns = 0
    draining = false
    guarded = false
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
    if (holdTimer !== null) {
      clearTimeout(holdTimer)
      holdTimer = null
    }
  }

  /** One authoritative grant path: capacity and cooldown are checked in exactly one place. */
  function grant() {
    const wait = cooldownUntil - now()
    if (wait > 0) {
      armTimer()
      return false
    }
    hand(queue.shift())
    return true
  }

  function armHold() {
    if (holdTimer !== null) return
    holdTimer = setTimeout(() => {
      holdTimer = null
      tracked.clear()
      reserved.clear()
      open.clear()
      openTurns = 0
      pump()
    }, holdMs)
    if (typeof holdTimer.unref === 'function') holdTimer.unref()
  }

  function pump() {
    if (draining) {
      while (queue.length > 0 && started < limit) {
        if (grant() === false) return
      }
      if (drained()) finishDrain()
      return
    }
    if (guarded === false) {
      while (queue.length > 0) hand(queue.shift())
      return
    }
    while (queue.length > 0 && started < limit) {
      if (grant() === false) return
    }
  }

  /**
   * Wait for a slot. `meta` is diagnostic only (`sessionId`, `purpose`, `provider`); a request is
   * never prioritised by it, because fairness between sessions is the point of the queue.
   * Resolves `{free:true}` when the gate is closed, so callers can always release unconditionally.
   */
  async function acquire(meta = {}, signal = null) {
    if (guarded === false) return { free: true }
    if (signal !== null && signal !== undefined && signal.aborted === true) throw abortError()
    return new Promise((resolve, reject) => {
      const waiter = { meta, resolve, reject, signal: signal ?? undefined }
      if (signal !== null && signal !== undefined) {
        waiter.onAbort = () => {
          drop(waiter, abortError())
        }
        signal.addEventListener('abort', waiter.onAbort, { once: true })
      }
      queue.push(waiter)
      pump()
    })
  }

  /**
   * Release one slot with the real outcome of the stream. A provider timeout or a failed stream is
   * a strike; two strikes in a row close the gate for `cooldownMs` and drop the limit back to one,
   * so a restore cannot keep hammering an upstream that is already unwell. `cancelled`/`aborted`
   * mean the consumer (or this pause) walked away: the upstream did not fail, so no strike.
   */
  function release(ticket, outcome = 'ok') {
    if (ticket === null || ticket === undefined || ticket.free === true) return
    started = Math.max(0, started - 1)
    if (outcome === 'cancelled' || outcome === 'aborted') {
      // Someone walked away from the stream (pause, abort, a cancelled turn, a full-consumption
      // abort caused by this pause's own signal). The upstream did not fail, so this neither earns
      // health nor a strike.
    } else if (outcome === 'ok') {
      healthy += 1
      strike = 0
      if (healthy >= 2 && limit < maxCapacity) limit += 1
    } else {
      healthy = 0
      failed += 1
      strike += 1
      if (strike >= 2) {
        strike = 0
        limit = 1
        cooldownUntil = now() + cooldownMs
        log(`restore gate cooling down for ${cooldownMs}ms`)
      }
    }
    pump()
  }

  /** Refuse every request that has not been dispatched yet: a pause must not leak a late stream. */
  function abort() {
    tracked.clear()
    reserved.clear()
    restored.clear()
    late.clear()
    open.clear()
    openTurns = 0
    const waiters = queue.splice(0, queue.length)
    interrupted += waiters.length
    for (const waiter of waiters) drop(waiter, abortError())
    // A drained queue with no stream left has nothing to limit any more: close the gate instead of
    // leaving the next request parked behind a batch that is already over.
    if (draining && drained()) finishDrain()
    return waiters.length
  }

  function track(sessionId) {
    if (typeof sessionId !== 'string' || sessionId === '') return
    if (batchOpen() === false) return
    restored.add(sessionId)
    tracked.add(sessionId)
    armHold()
  }

  /**
   * Called synchronously on the admission path, immediately before the restore prompts. The
   * controller emits `turn/start` inside `prompt()`, so this is the only moment at which a pending
   * start can be counted. The reservation also scopes the session and keeps the drain open.
   */
  function reserve(sessionId) {
    if (typeof sessionId !== 'string' || sessionId === '') return false
    if (batchOpen() === false) return false
    restored.add(sessionId)
    reserved.add(sessionId)
    late.delete(sessionId)
    armHold()
    return true
  }

  /** The prompt returned: the pending start becomes a tracked turn. Idempotent, as `onAdmitted` may repeat. */
  function admitted(sessionId) {
    if (typeof sessionId !== 'string' || sessionId === '') return false
    // An admission this batch never reserved belongs to something else and must not arm the gate.
    if (batchOpen() === false && restored.has(sessionId) === false) return false
    if (batchOpen() === false) reopen()
    restored.add(sessionId)
    reserved.delete(sessionId)
    late.delete(sessionId)
    tracked.add(sessionId)
    armHold()
    // An admission alone is not an open turn: if nothing else keeps the batch alive, close it and
    // let the turn edge reopen under its bounded window rather than holding the gate open forever.
    if (draining && drained()) finishDrain()
    return true
  }

  /**
   * The prompt was reported as failed. Admission is not transactional, so a turn may still open;
   * keep a bounded claim instead of deleting the session, or that turn would stream past the limit.
   */
  function abandon(sessionId) {
    if (typeof sessionId !== 'string' || sessionId === '') return false
    if (batchOpen() === false) return false
    if (reserved.delete(sessionId) === false) return false
    late.set(sessionId, now())
    pump()
    if (draining && drained()) finishDrain()
    return true
  }

  /** A session this batch owns. Ordinary sessions pass the interceptor untouched. */
  function scopes(sessionId) {
    if (batchOpen() === false) return false
    if (typeof sessionId !== 'string') return false
    return tracked.has(sessionId) === true || reserved.has(sessionId) === true
  }

  /** A tracked session's turn opened: hold the batch open until it ends. */
  function turnOpen(sessionId) {
    if (typeof sessionId !== 'string' || sessionId === '') return
    if (tracked.has(sessionId) === false && reserved.has(sessionId) === false) {
      const at = late.get(sessionId)
      const belongs = at !== undefined && now() - at <= lateWindowMs
      // A turn in a session this batch never touched is a person's own work, not a restore event.
      if (belongs === false) return
      late.delete(sessionId)
    }
    reserved.delete(sessionId)
    if (batchOpen() === false) reopen()
    restored.add(sessionId)
    tracked.add(sessionId)
    if (open.has(sessionId) === true) {
      // A replayed edge for a turn that is already open: keep the batch alive, count it once.
      armHold()
      return
    }
    open.add(sessionId)
    openTurns += 1
    armHold()
  }

  /** A tracked session's turn ended: the last one closes a drained batch. */
  function turnEnd(sessionId) {
    if (open.has(sessionId) === false) return
    open.delete(sessionId)
    openTurns = Math.max(0, openTurns - 1)
    tracked.delete(sessionId)
    pump()
    if (draining && drained()) finishDrain()
  }

  function guard() {
    guarded = true
    draining = false
    tracked.clear()
    restored.clear()
    reserved.clear()
    late.clear()
    open.clear()
    openTurns = 0
    healthy = 0
    strike = 0
    cooldownUntil = 0
    limit = initial
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
  }

  function unguard() {
    if (guarded === false) return
    // Nobody may stay parked behind a gate that is no longer limiting anything, but nobody gets to
    // overtake the slot budget either. Drain the queue at the current capacity; only an empty queue,
    // no running stream, no open turn and no pending prompt close the gate.
    draining = true
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
    pump()
    if (drained()) finishDrain()
  }

  /** Resolve once nothing is queued or running. Tests and shutdown use it; the engine never waits. */
  async function settle() {
    while (started > 0 || queue.length > 0 || reserved.size > 0) await new Promise((resolve) => setTimeout(resolve, 5))
  }

  return {
    acquire,
    release,
    abort,
    guard,
    unguard,
    settle,
    stats,
    track,
    reserve,
    admitted,
    abandon,
    scopes,
    turnOpen,
    turnEnd,
    enabled: () => guarded,
    lastDispatchAt: () => lastDispatchAt,
  }
}
