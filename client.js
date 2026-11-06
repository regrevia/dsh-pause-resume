window.__ModuleLoader__.load({
  id: 'dsh-pause-resume', // ui-copy-ignore
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const NS = 'pause-resume' // ui-copy-ignore
    /**
     * Two dictionaries, so the button speaks the language the app is in rather than the one
     * Electron happened to launch the renderer with.
     */
    const DICT = { // ui-copy-ignore
      zh: { // ui-copy-ignore
        pause: '暂停', // ui-copy-ignore
        resume: '继续', // ui-copy-ignore
        busy: '正在处理', // ui-copy-ignore
        error: '上次操作没有完成', // ui-copy-ignore
        partial: '部分内容未能恢复，可以再按一次', // ui-copy-ignore
        stopped: '上次暂停的内容还没有恢复', // ui-copy-ignore
        attention: '有内容需要你处理', // ui-copy-ignore
        cont: '继续未完成的任务', // ui-copy-ignore
        contCount: '{n} 个任务中断，点击继续', // ui-copy-ignore
        contAttention: '{n} 个任务上次没有恢复', // ui-copy-ignore
        restart: '跑完这些任务后重启', // ui-copy-ignore
        restartHeld: '重启后继续没放下的内容', // ui-copy-ignore
        expiredDays: '{n} 天前中断的工作已归档，不再恢复', // ui-copy-ignore
        expiredHours: '{n} 小时前中断的工作已归档，不再恢复', // ui-copy-ignore
        pausing: '正在收尾', // ui-copy-ignore
        receipt: '已暂停，继续信息已保存。', // ui-copy-ignore
        tooLarge: '这些会话太大，自动恢复会占满内存，请自己打开', // ui-copy-ignore
      },
      en: { // ui-copy-ignore
        pause: 'Pause', // ui-copy-ignore
        resume: 'Resume', // ui-copy-ignore
        busy: 'Working', // ui-copy-ignore
        error: 'The last action did not finish', // ui-copy-ignore
        partial: 'Some items were not restored; press again to retry', // ui-copy-ignore
        stopped: 'Work is still stopped', // ui-copy-ignore
        attention: 'Some items need a look', // ui-copy-ignore
        cont: 'Continue unfinished work', // ui-copy-ignore
        contCount: '{n} tasks stopped, press to continue', // ui-copy-ignore
        contAttention: '{n} tasks did not resume last time', // ui-copy-ignore
        restart: 'Restart when this work is done', // ui-copy-ignore
        restartHeld: 'Restart to continue what was held back', // ui-copy-ignore
        expiredDays: 'Work interrupted {n} days ago was archived, not restored', // ui-copy-ignore
        expiredHours: 'Work interrupted {n} hours ago was archived, not restored', // ui-copy-ignore
        pausing: 'Wrapping up', // ui-copy-ignore
        receipt: 'Paused. What to continue is saved.', // ui-copy-ignore
        tooLarge: 'Too large to restore automatically; open it yourself', // ui-copy-ignore
      },
    }
    /** Until the dictionary is registered, or on a page that offers no locale service. */
    function localTranslate(lang) {
      const table = /^zh/i.test(lang || '') || /^zh/i.test((typeof navigator !== 'undefined' && navigator.language) || '') ? DICT.zh : DICT.en
      return (key, params) => {
        const template = table[key] ?? DICT.en[key] ?? key
        if (params === undefined) return template
        return String(template).replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match))
      }
    }
    let translate = localTranslate('') // ui-copy-ignore
    /** Current-language string; read at call time so a language switch lands on the next poll. */
    const t = (key, params) => translate(key, params)

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
      scheduling: null, // ui-copy-ignore
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

    // The whole reason lives in the tooltip; a state the glyph cannot show gets a dot, which costs
    // no width: the header row must not shift when the button changes state.
    const DOT_STYLE = {
      position: 'absolute', top: 3, insetInlineEnd: 3, width: 6, height: 6, borderRadius: 3, // ui-copy-ignore
      background: 'var(--dsh-color-status-warning, #d99a2b)', // ui-copy-ignore
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

    /**
     * What the person needs to know after a pause that had to cancel a turn the model did not
     * finish inside the wrap-up window. This is the consequence, not the mechanism: the work is
     * still recorded and the next press continues it. A page reads the top-level `wrapUp` first,
     * because that is the pause result written to disk and re-read after a restart; the copy inside
     * `outcome` is the one a press just returned. Any state without either returns null, so a page  // ui-copy-ignore
     * talking to an older release that never sent one renders as before.
     */
    function receiptOf(state) {
      const top = state?.wrapUp
      const wrapUp = top !== null && top !== undefined && typeof top === 'object' ? top : state?.outcome?.wrapUp
      if (wrapUp === null || wrapUp === undefined || typeof wrapUp !== 'object') return null
      const timedOut = Array.isArray(wrapUp.timedOut) ? wrapUp.timedOut.length : 0
      const completed = Array.isArray(wrapUp.completed) ? wrapUp.completed.length : 0
      return timedOut > 0 && completed === 0 ? t('receipt') : null
    }

    /** The one sentence behind the button, in the tooltip only: the button itself stays a glyph. */
    function hintOf(state) {
      if (state.action === 'continue') {
        const pending = state.pendingContinue ?? {}
        const count = Number.isInteger(pending.count) && pending.count > 0 ? pending.count : 0
        const failed = Number.isInteger(pending.attention) && pending.attention > 0 ? pending.attention : 0
        const base = count > 0 ? t('contCount', { n: count }) : t('cont')
        return failed > 0 ? `${base} · ${t('contAttention', { n: failed })}` : base
      }
      const focus = typeof state.focus === 'string' && state.focus !== '' ? state.focus : ''
      const expired = state.expired
      if (expired !== null && expired !== undefined && typeof expired === 'object' && Number.isFinite(expired.ageHours)) {
        const hours = expired.ageHours
        return hours >= 48 ? t('expiredDays', { n: Math.round(hours / 24) }) : t('expiredHours', { n: Math.round(hours) })
      }
      // A transcript past the size the process can hydrate is not waiting for a restart: the same
      // file would be read again. The only next step is opening it by hand, so say that instead of
      // the generic partial sentence.
      if ((state.scheduling?.needsHand ?? 0) > 0) return t('tooLarge')
      // Rows this process held back are still owed work, and pressing again cannot mount them: the
      // same heap is still there. "Press again" would be a loop, so the restart is the one next step.
      const held = Array.isArray(state.scheduling?.deferred) ? state.scheduling.deferred.length : 0
      const advice = state.scheduling?.restartRecommended
      if (held > 0 && advice !== null && advice !== undefined && typeof advice.at === 'string') return t('restartHeld')
      if (state.error === 'restore-partial') return focus === '' ? t('partial') : `${t('partial')}: ${focus}`
      if (state.error !== null && state.error !== undefined) return focus === '' ? t('error') : `${t('error')}: ${focus}`
      // The one consequence the person has to act on: this process has already mounted everything it
      // safely can, and the rest lands after a restart. It replaces a row's raw reason, which is a
      // diagnostic and not something to put in front of a person.
      const restart = state.scheduling?.restartRecommended
      if (restart !== null && restart !== undefined && typeof restart.at === 'string') return t('restart')
      // Only after the pause is over and a plan is waiting: a busy press or a newer problem keeps its
      // own sentence, and the receipt never hides one.
      if (state.action === 'resume') {
        const receipt = receiptOf(state)
        if (receipt !== null) return receipt
      }
      if ((state.attention ?? 0) > 0) {
        return typeof state.focus === 'string' && state.focus !== '' ? `${t('attention')}: ${state.focus}` : t('attention')
      }
      if ((state.outstanding ?? 0) > 0) return t('stopped')
      return ''
    }

    function Button() {
      const [state, setState] = React.useState(EMPTY)
      const [hover, setHover] = React.useState(false)
      const [pressing, setPressing] = React.useState(false)
      /** This turn's press came back without a mount: marked until the next press replaces it. */
      const [reported, setReported] = React.useState(false)
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
        setReported(false)
        try {
          const answer = await press(action, controller)
          if (mounted.current) setReported(pressedOf(answer))
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

      // A press the heap refused is the one state that needs saying without a word: the glyph stays
      // the play triangle, so a dot marks it and the tooltip carries the sentence.
      const held = busy === false && disabled === false && (heldOf(state) || reported)
      const glyph = busy ? SPIN_GLYPH : action === 'continue' ? CONTINUE_GLYPH : action === 'resume' ? PLAY_GLYPH : PAUSE_GLYPH
      const label = busy ? (state.phase === 'pausing' ? t('pausing') : t('busy')) : action === 'continue' ? t('cont') : action === 'resume' ? t('resume') : t('pause')
      const hint = hintOf(state)

      const control = h('button', {
        type: 'button', // ui-copy-ignore
        style,
        onClick,
        disabled,
        'aria-label': label,
        'aria-busy': busy,
        title: hint === '' ? label : `${label} · ${hint}`,
        onMouseEnter: () => setHover(true),
        onMouseLeave: () => setHover(false),
      }, held ? [glyph, h('span', { key: 'held', style: DOT_STYLE, 'aria-hidden': true })] : glyph)
      return control
    }

    /**
     * Rows this process held back for memory: pressing again re-measures the same heap, so the button
     * has to say so before the press instead of after it.
     */
    function heldOf(state) {
      if (state === null || state === undefined || typeof state !== 'object') return false
      if (state.error === 'restore-blocked-heap') return true
      // A row that may never be mounted automatically is still a press that must show a result.
      if ((state?.scheduling?.needsHand ?? 0) > 0) return true
      const held = Array.isArray(state?.scheduling?.deferred) ? state.scheduling.deferred.length : 0
      return held > 0 && typeof state?.scheduling?.restartRecommended?.at === 'string'
    }

    /**
     * A press that did not land cleanly has to leave a trace on the button: the glyph cannot change
     * on the same turn, and a play triangle that stayed identical read as "my press did nothing".
     * Empty answers (paused, resumed, continued) are their own visible result and stay unmarked.
     */
    function pressedOf(answer) {
      const status = answer !== null && typeof answer === 'object' ? answer.status : null
      return status === 'partial' || status === 'blocked' || status === 'failed' || status === 'expired' // ui-copy-ignore
    }

    const definition = {
      inject: ['slots', 'locale'], // ui-copy-ignore
      apply(ctx) {
        // Registered in the app's own locale service when it is there, so the copy follows the
        // language the person chose rather than the one the renderer was launched with.
        try {
          const locale = typeof ctx.get === 'function' ? ctx.get('locale') : null
          const active = typeof locale?.snapshot?.active === 'string' ? locale.snapshot.active : ''
          if (active !== '') translate = localTranslate(active)
          if (locale !== null && locale !== undefined && typeof locale.register === 'function') {
            locale.register(NS, { zh: DICT.zh, en: DICT.en })
            const bound = locale.bind(NS)
            translate = (key, params) => bound(key, params)
          }
        } catch {}
        ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register({
          name: 'conversation.session.header.utilities',
          id: 'dsh-pause-resume', // ui-copy-ignore
          order: 31, // ui-copy-ignore
          label: () => t('pause'), // ui-copy-ignore
        }, Button))
      },
    }
    // A pure function of the button state, for tests: kept non-enumerable so the loader still walks the
    // two keys a plugin definition has and nothing else.
    Object.defineProperty(definition, 'receiptOf', { value: receiptOf })
    Object.defineProperty(definition, 'heldOf', { value: heldOf })
    Object.defineProperty(definition, 'pressedOf', { value: pressedOf })
    Object.defineProperty(definition, 'setLanguage', { value: (lang) => { translate = localTranslate(lang) } })
    return definition
  },
})
