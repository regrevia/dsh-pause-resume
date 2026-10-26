window.__ModuleLoader__.load({
  id: 'dsh-pause-resume',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const zh = /^zh/i.test(navigator.language || '')
    const COPY = zh
      ? { pause: '暂停', resume: '继续', busy: '正在处理' }
      : { pause: 'Pause', resume: 'Resume', busy: 'Working' }

    const HOST_BASE = '/dsh-pause-resume' // ui-copy-ignore
    const POLL_MS = 2000 // ui-copy-ignore
    const REQUEST_MS = 30000 // ui-copy-ignore

    /**
     * The glyph is the whole status, so it may not be guessed from anything the page can see: the
     * Host owns the phase and this asks for it. Until an answer arrives the button renders the // ui-copy-ignore
     * settled state (`none`), never a spinner, so a slow Host cannot look like a running press. // ui-copy-ignore
     */
    const EMPTY = { phase: 'idle', action: 'none', source: null, complete: null, counts: { sessions: 0, goals: 0, schedules: 0, jobs: 0 }, live: { sessions: 0, goals: 0, jobs: 0 }, error: null }

    function withTimeout(promise, ms = REQUEST_MS) {
      let id = null
      const timer = new Promise((_resolve, reject) => {
        id = setTimeout(() => reject(new Error('timeout')), ms) // ui-copy-ignore
      })
      return Promise.race([promise, timer]).finally(() => clearTimeout(id))
    }

    async function readState() {
      try {
        const response = await withTimeout(fetch(`${HOST_BASE}/state`, { cache: 'no-store', credentials: 'same-origin' }))
        if (!response.ok) return null
        const data = await withTimeout(response.json())
        return data !== null && typeof data === 'object' ? data : null
      } catch {
        return null
      }
    }

    async function press(action) {
      try {
        const response = await withTimeout(fetch(`${HOST_BASE}/${action}`, {
          method: 'POST', // ui-copy-ignore
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json', 'x-dsh-pause-resume': '1' }, // ui-copy-ignore
          body: '{}', // ui-copy-ignore
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

    function Button() {
      const [state, setState] = React.useState(EMPTY)
      const [hover, setHover] = React.useState(false)
      const mounted = React.useRef(true)

      React.useEffect(() => {
        ensureStyle()
        mounted.current = true
        let timer = null
        const pull = async () => {
          const next = await readState()
          if (!mounted.current) return
          if (next !== null) setState({ ...EMPTY, ...next })
        }
        pull()
        timer = setInterval(() => {
          if (document.visibilityState === 'visible') pull()
        }, POLL_MS)
        const onVisible = () => {
          if (document.visibilityState === 'visible') pull()
        }
        document.addEventListener('visibilitychange', onVisible)
        return () => {
          mounted.current = false
          if (timer !== null) clearInterval(timer)
          document.removeEventListener('visibilitychange', onVisible)
        }
      }, [])

      const busy = state.action === 'busy'
      const action = state.action === 'pause' || state.action === 'resume' ? state.action : null
      const disabled = action === null && !busy

      const onClick = async () => {
        if (busy || action === null) return
        // The phase is set from the Host's answer, never optimistically: the spinner appears when // ui-copy-ignore
        // the Host says it started, so two windows can never show different phases. // ui-copy-ignore
        setState((current) => ({ ...current, action: 'busy' }))
        const answer = await press(action)
        const next = await readState()
        if (!mounted.current) return
        if (next !== null) setState({ ...EMPTY, ...next })
        else if (answer === null) setState((current) => ({ ...current, action }))
      }

      const style = busy || disabled
        ? { ...BUTTON_STYLE, opacity: 0.4 }
        : hover
          ? { ...BUTTON_STYLE, opacity: 1, background: 'var(--dsh-color-surface-hover, rgba(127,127,127,0.14))' }
          : BUTTON_STYLE

      const glyph = busy ? SPIN_GLYPH : action === 'resume' ? PLAY_GLYPH : PAUSE_GLYPH
      const label = busy ? COPY.busy : action === 'resume' ? COPY.resume : COPY.pause

      return h('button', {
        type: 'button', // ui-copy-ignore
        style,
        onClick,
        disabled,
        'aria-label': label,
        'aria-busy': busy,
        onMouseEnter: () => setHover(true),
        onMouseLeave: () => setHover(false),
      }, glyph, state.error === null || state.error === undefined ? null : h('span', { style: DOT_STYLE, 'aria-hidden': true }))
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
