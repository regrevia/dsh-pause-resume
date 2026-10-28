// spike: starts one real turn inside a booted Host so the pause/resume plugin
// has live work to act on. Installed only into the throwaway profile that
// acceptance/host-live.mjs composes; never shipped, never imported by index.js
// or lib/.
//
// It mirrors what `dsh headless` does (see @deepseek-ai/dsh-headless): create a
// Session through the public `agents` service, then `agent.followup(...)` one
// user message. The model stream is held open by acceptance/mock-llm.mjs, so
// the turn stays `running` until the test pauses and kills the Host.
//
// Env:
//   SPIKE_TURN_MARKER  file written after the turn starts; its presence on the
//                      next boot means "already started, do not start another".
import { randomUUID } from 'node:crypto'
import { existsSync, writeFileSync } from 'node:fs'

export const name = 'spike-live-turn'
export const inject = ['agents', 'agentDefaultModel', 'sessions']

const MARKER = process.env.SPIKE_TURN_MARKER ?? ''
const SESSION_ID = process.env.SPIKE_TURN_SESSION ?? 'spike-live-turn'
const TASK = process.env.SPIKE_TURN_TEXT ?? 'spike live turn'

export function apply(ctx) {
  void (async () => {
    try {
      await ctx.get('loader')?.await()
      if (MARKER !== '' && existsSync(MARKER)) {
        console.log('[spike-live-turn] marker present; not starting another turn')
        return
      }
      const agents = ctx.get('agents')
      const defaultModel = ctx.get('agentDefaultModel')
      if (agents === undefined || defaultModel === undefined) {
        console.log('[spike-live-turn] missing agents/agentDefaultModel service')
        return
      }
      const selection = defaultModel.currentSelection()
      const agentOptions = { provider: selection.provider, model: selection.model }
      const fs = ctx.get('fs')
      const cwd = fs === undefined ? process.cwd() : fs.processPath(await fs.resolve('.'))
      const created = await agents.create({
        sessionId: SESSION_ID,
        meta: { cwd },
        agentOptions,
      })
      const agent = created.agent
      await agent.whenIdle()
      if (MARKER !== '') writeFileSync(MARKER, `${SESSION_ID} ${randomUUID()}\n`)
      agent.followup({
        id: randomUUID(),
        role: 'user',
        content: [{ type: 'text', text: TASK }],
        source: { kind: 'user' },
      })
      console.log(`[spike-live-turn] started session ${SESSION_ID}`)
    } catch (error) {
      console.log(`[spike-live-turn] failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  })()
}
