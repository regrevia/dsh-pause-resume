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
        }
      : {
          pause: 'Pause', // ui-copy-ignore
          resume: 'Resume', // ui-copy-ignore
          busy: 'Working', // ui-copy-ignore
          error: 'The last action did not finish',
          partial: 'Some items were not restored; press again to retry',
          stopped: 'Work is still stopped',
          attention: 'Some items need a look',
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
      error: null, // ui-copy-ignore
    }

    function withTimeout(promise, ms = REQUEST_MS) {
      let id = null
      const timer = new Promise((_resolve, reject) => {
        id = setTimeout(() => reject(new Error('timeout')), ms) // ui-copy-ignore
      })
      return Promise.race([promise, timer]).finally(() => clearTimeout(id))
    }

    async function readState(signal) {
      try {
        const response = await withTimeout(fetch(`${HOST_BASE}/state`, { cache: 'no-store', credentials: 'same-origin', signal })) // ui-copy-ignore
        if (!response.ok) return null
        const data = await withTimeout(response.json())
        return data !== null && typeof data === 'object' ? data : null
      } catch {
        return null
      }
    }

    async function press(action, signal) {
      try {
        const response = await withTimeout(fetch(`${HOST_BASE}/${action}`, {
          method: 'POST', // ui-copy-ignore
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json', 'x-dsh-pause-resume': '1' }, // ui-copy-ignore
          body: '{}', // ui-copy-ignore
          signal,
        }))
        if (!response.ok) return null
        const data = await withTimeout(response.json())
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

    const DOT_STYLE = {
      position: 'absolute', // ui-copy-ignore
      top: 4, // ui-copy-ignore
      right: 4, // ui-copy-ignore
      width: 5, // ui-copy-ignore
      height: 5, // ui-copy-ignore
      borderRadius: '50%',
      background: 'var(--dsh-color-danger, #d1242f)',
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

    /** The one sentence behind the dot, in the tooltip only: the button itself stays a glyph. */
    function hintOf(state) {
      if (state.error === 'restore-partial') return COPY.partial
      if (state.error !== null && state.error !== undefined) return COPY.error
      if ((state.attention ?? 0) > 0) return COPY.attention
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
          if (stopped || document.visibilityState !== 'visible' || inflight.current !== null) { schedule() ; return }
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
          } catch {}
          document.removeEventListener('visibilitychange', onVisible)
        }
      }, [pull])

      const busy = pressing || state.action === 'busy'
      const action = state.action === 'pause' || state.action === 'resume' ? state.action : null
      const disabled = action === null && !busy

      const onClick = async () => {
        if (busy || action === null || inflight.current !== null) return
        // One press at a time, in this tab and across tabs: the Host also refuses an overlapping // ui-copy-ignore
        // press, so a second window's button settles on the same answer instead of starting work.
        const controller = typeof AbortController === 'function' ? new AbortController() : null
        inflight.current = controller
        setPressing(true)
        try {
          const answer = await press(action, controller?.signal)
          const next = answer ?? (await readState())
          if (mounted.current) {
            if (next !== null) {
              seq.current += 1
              setState({ ...EMPTY, ...next })
            } else {
              // The press may still have landed: ask again rather than guessing the phase.
              void pull(controller?.signal)
            }
          }
        } finally {
          inflight.current = null
          if (mounted.current) setPressing(false)
        }
      }

      const style = busy || disabled
        ? { ...BUTTON_STYLE, opacity: 0.4 }
        : hover
          ? { ...BUTTON_STYLE, opacity: 1, background: 'var(--dsh-color-surface-hover, rgba(127,127,127,0.14))' }
          : BUTTON_STYLE

      const glyph = busy ? SPIN_GLYPH : action === 'resume' ? PLAY_GLYPH : PAUSE_GLYPH
      const label = busy ? COPY.busy : action === 'resume' ? COPY.resume : COPY.pause
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
      }, glyph, hint === '' ? null : h('span', { style: DOT_STYLE, 'aria-hidden': true }))
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
