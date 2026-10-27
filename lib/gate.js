/**
 * The restore gate: the one place that decides how many model requests may be in flight while a
 * pause plan is being put back. A restore that starts six long sessions at once can also start six
 * upstream streams at once; the restore loop alone cannot prevent that, because a session counts as
 * "started" as soon as its turn opens, long before the provider answers. This gate sits in front of
 * `llm/stream`, so it holds the real thing: one adapter request per slot, compaction and retries
 * included, and a slot is released only when the stream ends or is cancelled.
 *
 * Outside a restore the gate is closed for business (`enabled() === false`) and adds no listener
 * cost: the caller forwards straight to the next middleware.
 */

function abortError() {
  const error = new Error('restore gate interrupted')
  error.name = 'AbortError'
  return error
}

export function createGate(options = {}) {
  const maxCapacity = Number.isSafeInteger(options.maxCapacity) && options.maxCapacity > 0 ? options.maxCapacity : 2
  const initial = Number.isSafeInteger(options.capacity) && options.capacity > 0 ? Math.min(options.capacity, maxCapacity) : 1
  const cooldownMs = Number.isSafeInteger(options.cooldownMs) && options.cooldownMs >= 0 ? options.cooldownMs : 40000
  const now = typeof options.now === 'function' ? options.now : Date.now
  const log = typeof options.log === 'function' ? options.log : () => {}

  let guarded = false
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
    return { enabled: guarded, capacity: limit, running: started, queued: queue.length, dispatched, failed, interrupted, cooldownUntil }
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

  function pump() {
    if (guarded === false) {
      while (queue.length > 0) hand(queue.shift())
      return
    }
    while (queue.length > 0 && started < limit) {
      const wait = cooldownUntil - now()
      if (wait > 0) {
        armTimer()
        return
      }
      hand(queue.shift())
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
   * so a restore cannot keep hammering an upstream that is already unwell.
   */
  function release(ticket, outcome = 'ok') {
    if (ticket === null || ticket === undefined || ticket.free === true) return
    started = Math.max(0, started - 1)
    if (outcome === 'cancelled') {
      // Someone walked away from the stream (pause, abort, a cancelled turn). The upstream did not
      // fail, so this neither earns health nor a strike.
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
    const waiters = queue.splice(0, queue.length)
    interrupted += waiters.length
    for (const waiter of waiters) drop(waiter, abortError())
    return waiters.length
  }

  function guard() {
    guarded = true
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
    guarded = false
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
    // Nobody may stay parked behind a gate that is no longer limiting anything, and nothing is
    // counted from here on: the request is simply admitted.
    while (queue.length > 0) queue.shift().resolve({ free: true })
  }

  /** Resolve once nothing is queued or running. Tests and shutdown use it; the engine never waits. */
  async function settle() {
    while (started > 0 || queue.length > 0) await new Promise((resolve) => setTimeout(resolve, 5))
  }

  return { acquire, release, abort, guard, unguard, settle, stats, enabled: () => guarded, lastDispatchAt: () => lastDispatchAt }
}
