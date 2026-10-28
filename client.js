window.__ModuleLoader__.load({
  id: 'dsh-pause-resume', // ui-copy-ignore
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const zh = /^zh/i.test(navigator.language || '')
    const COPY = zh
      ? {
          pause: '暂停', // ui-copy-ignore
          resume: '继续', // ui-copy-ignore
          busy: '正在处理', // ui-copy-ignore
          error: '上次操作没有完成', // ui-copy-ignore
          partial: '部分内容未能恢复，可以再按一次', // ui-copy-ignore
          stopped: '上次暂停的内容还没有恢复', // ui-copy-ignore
          attention: '有内容需要你处理',
          cont: '继续未完成的任务', // ui-copy-ignore
          contCount: (n) => `${n} 个任务中断，点击继续`,
          contAttention: (n) => `${n} 个任务上次没有恢复`,
        }
      : {
          pause: 'Pause', // ui-copy-ignore
          resume: 'Resume', // ui-copy-ignore
          busy: 'Working', // ui-copy-ignore
          error: 'The last action did not finish',
          partial: 'Some items were not restored; press again to retry',
          stopped: 'Work is still stopped',
          attention: 'Some items need a look',
          cont: 'Continue unfinished work',
          contCount: (n) => `${n} ${n === 1 ? 'task stopped' : 'tasks stopped'}, press to continue`,
          contAttention: (n) => `${n} ${n === 1 ? 'task did' : 'tasks did'} not resume last time`,
        }

    const HOST_BASE = '/dsh-pause-resume' // ui-copy-ignore
    const POLL_MS = 2000 // ui-copy-ignore
    const REQUEST_MS = 30000 // ui-copy-ignore

    /**
     * The glyph is the whole status, so it may not be guessed from anything the page can see: the
     * Host owns the phase and this asks for it. Until an answer arrives the button renders the // ui-copy-ignore
     * settled state (`none`), never a spinner, so a slow Host cannot look like a running press. // ui-copy-ignore
     */
    const EMPTY = {
      phase: 'idle', // ui-copy-ignore
      action: 'none', // ui-copy-ignore
      source: null, // ui-copy-ignore
      complete: null, // ui-copy-ignore
      outstanding: 0,
      counts: { sessions: 0, goals: 0, jobs: 0 },
      live: { sessions: 0, goals: 0, jobs: 0 },
      attention: 0,
      focus: null, // ui-copy-ignore
      error: null, // ui-copy-ignore
    }

    // A deadline must also release the request, not only stop waiting for it: a server that keeps
    // the socket open would otherwise leave one hung request per timeout until the browser's per
    // origin connection pool is full and every later poll queues behind dead requests.
    function withTimeout(promise, ms = REQUEST_MS, controller = null) {
      let id = null
      const timer = new Promise((_resolve, reject) => {
        id = setTimeout(() => {
          try {
            controller?.abort()
          } catch {}
          reject(new Error('timeout')) // ui-copy-ignore
        }, ms)
      })
      return Promise.race([promise, timer]).finally(() => clearTimeout(id))
    }

    /** One request's own controller, aborted when the page goes away or its deadline passes. */
    function link(parent) {
      const own = typeof AbortController === 'function' ? new AbortController() : null
      if (own !== null && parent !== null && parent !== undefined) {
        if (parent.aborted === true) own.abort()
        else {
          try {
            parent.addEventListener('abort', () => own.abort(), { once: true })
          } catch {}
        }
      }
      return own
    }

    async function readState(signal) {
      const own = link(signal)
      try {
        const response = await withTimeout(fetch(`${HOST_BASE}/state`, { cache: 'no-store', credentials: 'same-origin', signal: own?.signal }), REQUEST_MS, own) // ui-copy-ignore
        if (!response.ok) return null
        const data = await withTimeout(response.json(), REQUEST_MS, own)
        return data !== null && typeof data === 'object' ? data : null
      } catch {
        return null
      }
    }

    async function press(action, controller) {
      try {
        const response = await withTimeout(fetch(`${HOST_BASE}/${action}`, {
          method: 'POST', // ui-copy-ignore
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json', 'x-dsh-pause-resume': '1' }, // ui-copy-ignore
          body: '{}', // ui-copy-ignore
          signal: controller?.signal,
        }), REQUEST_MS, controller)
        if (!response.ok) return null
        const data = await withTimeout(response.json(), REQUEST_MS, controller)
        return data !== null && typeof data === 'object' ? data : null
      } catch {
        return null
      }
    }

    // One style element for the whole page: the in-place spinner is the only motion, and it is
    // defined once instead of on every render.
    const STYLE_ID = 'dsh-pause-resume-style' // ui-copy-ignore
    function ensureStyle() {
      try {
        if (document.getElementById(STYLE_ID) !== null) return
        const style = document.createElement('style')
        style.id = STYLE_ID
        style.textContent = '@keyframes dsh-pr-spin{to{transform:rotate(360deg)}}'
        document.head.appendChild(style)
      } catch {}
    }

    const BUTTON_STYLE = {
      display: 'inline-flex', // ui-copy-ignore
      alignItems: 'center',
      justifyContent: 'center',
      width: 28, // ui-copy-ignore
      height: 28, // ui-copy-ignore
      padding: 0, // ui-copy-ignore
      border: 'none', // ui-copy-ignore
      borderRadius: 6,
      background: 'transparent',
      color: 'inherit', // ui-copy-ignore
      cursor: 'pointer', // ui-copy-ignore
      opacity: 0.75, // ui-copy-ignore
      position: 'relative', // ui-copy-ignore
    }

    const SPIN_STYLE = { display: 'inline-flex', animation: 'dsh-pr-spin 900ms linear infinite' } // ui-copy-ignore

    function icon(paths, extra) {
      return h('svg', {
        width: 16, height: 16, viewBox: '0 0 16 16', fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round',
        'aria-hidden': true, style: extra,
      }, paths.map((d) => h('path', { key: d, d })))
    }

    const PAUSE_GLYPH = icon(['M6 3.5v9', 'M10 3.5v9'])
    const PLAY_GLYPH = h('svg', {
      width: 16, height: 16, viewBox: '0 0 16 16', fill: 'currentColor', 'aria-hidden': true,
    }, h('path', { d: 'M5.2 3.4a.7.7 0 0 0-1.05.6v8a.7.7 0 0 0 1.05.6l6.9-4a.7.7 0 0 0 0-1.2l-6.9-4z' }))
    const SPIN_GLYPH = icon(['M8 2.5a5.5 5.5 0 1 1-4.3 2.06'], SPIN_STYLE)
    // A retry arrow, not the play triangle: "continue what stopped" is a different act from
    // "resume what I paused", and the same glyph for both made the button look like it did one thing.
    const CONTINUE_GLYPH = icon(['M13 8a5 5 0 1 1-1.46-3.54', 'M13 2.8v2.6h-2.6'])

    /** The one sentence behind the button, in the tooltip only: the button itself stays a glyph. */
    function hintOf(state) {
      if (state.action === 'continue') {
        const pending = state.pendingContinue ?? {}
        const count = Number.isInteger(pending.count) && pending.count > 0 ? pending.count : 0
        const failed = Number.isInteger(pending.attention) && pending.attention > 0 ? pending.attention : 0
        const base = count > 0 ? COPY.contCount(count) : COPY.cont
        return failed > 0 ? `${base} · ${COPY.contAttention(failed)}` : base
      }
      const focus = typeof state.focus === 'string' && state.focus !== '' ? state.focus : ''
      if (state.error === 'restore-partial') return focus === '' ? COPY.partial : `${COPY.partial}: ${focus}`
      if (state.error !== null && state.error !== undefined) return focus === '' ? COPY.error : `${COPY.error}: ${focus}`
      if ((state.attention ?? 0) > 0) {
        return typeof state.focus === 'string' && state.focus !== '' ? `${COPY.attention}: ${state.focus}` : COPY.attention
      }
      if ((state.outstanding ?? 0) > 0) return COPY.stopped
      return ''
    }

    function Button() {
      const [state, setState] = React.useState(EMPTY)
      const [hover, setHover] = React.useState(false)
      const [pressing, setPressing] = React.useState(false)
      const mounted = React.useRef(true)
      /** Each answer carries a number: a slow reply may never overwrite a newer one. */
      const seq = React.useRef(0)
      const inflight = React.useRef(null)
      /** Distinguishes presses so a superseded one cannot clear the newer one's state. */
      const pressToken = React.useRef(0)
      /** Which action this tab's open request is: a pause press must not interrupt another pause. */
      const pressKind = React.useRef(null)

      const apply = React.useCallback((next) => {
        if (!mounted.current || next === null) return
        seq.current += 1
        setState({ ...EMPTY, ...next })
      }, [])

      const pull = React.useCallback(async (signal) => {
        const mine = seq.current
        const next = await readState(signal)
        if (!mounted.current || seq.current !== mine) return
        if (next !== null) apply(next)
      }, [apply])

      React.useEffect(() => {
        ensureStyle()
        mounted.current = true
        let timer = null
        let stopped = false
        let current = null
        // One request at a time, and the next one starts after this one settles. A fixed interval
        // that aborts its own predecessor made any answer slower than the interval invisible.
        const beat = async () => {
          timer = null
          // The poll keeps running while a press waits for its answer: the answer can take a whole
          // restore, and a frozen glyph is what made the button look dead during one.
          if (stopped || document.visibilityState !== 'visible') { schedule() ; return }
          current = typeof AbortController === 'function' ? new AbortController() : null
          try {
            await pull(current?.signal)
          } finally {
            current = null
            schedule()
          }
        }
        const schedule = () => {
          if (stopped || timer !== null) return
          timer = setTimeout(() => { void beat() }, POLL_MS)
        }
        const onVisible = () => {
          if (document.visibilityState !== 'visible') return
          if (timer !== null) { clearTimeout(timer); timer = null }
          void beat()
        }
        void beat()
        document.addEventListener('visibilitychange', onVisible)
        return () => {
          stopped = true
          mounted.current = false
          if (timer !== null) clearTimeout(timer)
          try {
            current?.abort()
            // A press in flight when the page unmounts must not keep its socket either.
            inflight.current?.abort()
          } catch {}
          document.removeEventListener('visibilitychange', onVisible)
        }
      }, [pull])

      const action = state.action === 'pause' || state.action === 'resume' || state.action === 'continue' ? state.action : null
      /**
       * A resume request can stay open for the whole restore, and the Host answers `pause` while it // ui-copy-ignore
       * is resuming. That answer is the same page's way back out: the glyph returns to the pause
       * button, so this tab's own open request may not keep the press blocked.
       */
      const interrupt = pressing && action === 'pause' && pressKind.current !== 'pause'
      const busy = state.action === 'busy' || (pressing && interrupt === false)
      const disabled = action === null && !busy

      const onClick = async () => {
        if (busy || action === null) return
        if (inflight.current !== null) {
          // A restore in flight still answers the press that started it, so its request can sit open
          // for the whole restore. Pressing pause now means "stop that restore": drop this tab's wait
          // and let the new press interrupt the restore and keep the plan.
          if (action !== 'pause' || pressKind.current === 'pause') return
          try {
            inflight.current.abort()
          } catch {}
          inflight.current = null
        }
        // One press at a time, in this tab and across tabs: the Host also refuses an overlapping // ui-copy-ignore
        // press, so a second window's button settles on the same answer instead of starting work.
        const controller = typeof AbortController === 'function' ? new AbortController() : null
        const mine = pressToken.current + 1
        pressToken.current = mine
        pressKind.current = action
        inflight.current = controller
        setPressing(true)
        try {
          const answer = await press(action, controller)
          const next = answer ?? (await readState())
          if (mounted.current) {
            if (next !== null) {
              seq.current += 1
              setState({ ...EMPTY, ...next })
            } else {
              // The press may still have landed: ask again rather than guessing the phase. A new
              // request of its own, never the press's controller, which a timeout has aborted.
              void pull()
            }
          }
        } finally {
          if (pressToken.current === mine) {
            inflight.current = null
            pressKind.current = null
            if (mounted.current) setPressing(false)
          }
        }
      }

      const style = busy || disabled
        ? { ...BUTTON_STYLE, opacity: 0.4 }
        : hover
          ? { ...BUTTON_STYLE, opacity: 1, background: 'var(--dsh-color-surface-hover, rgba(127,127,127,0.14))' }
          : BUTTON_STYLE

      const glyph = busy ? SPIN_GLYPH : action === 'continue' ? CONTINUE_GLYPH : action === 'resume' ? PLAY_GLYPH : PAUSE_GLYPH
      const label = busy ? COPY.busy : action === 'continue' ? COPY.cont : action === 'resume' ? COPY.resume : COPY.pause
      const hint = hintOf(state)

      return h('button', {
        type: 'button', // ui-copy-ignore
        style,
        onClick,
        disabled,
        'aria-label': label,
        'aria-busy': busy,
        title: hint === '' ? label : `${label} · ${hint}`,
        onMouseEnter: () => setHover(true),
        onMouseLeave: () => setHover(false),
      }, glyph)
    }

    return {
      inject: ['slots'], // ui-copy-ignore
      apply(ctx) {
        ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register({
          name: 'conversation.session.header.utilities',
          id: 'dsh-pause-resume', // ui-copy-ignore
          order: 31, // ui-copy-ignore
          label: () => COPY.pause, // ui-copy-ignore
        }, Button))
      },
    }
  },
})
