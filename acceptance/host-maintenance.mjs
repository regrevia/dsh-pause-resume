#!/usr/bin/env node
// Live Host acceptance for maintenance-compaction-cancellable: a real `/compact`
// command runs a real maintenance compaction (agent.phase.kind === 'maintenance'),
// its summarization request is held open by the mock provider, the Host is paused
// over the plugin's HTTP surface, and the pause must cancel that maintenance work
// separately: it is recorded under plan.stopped.maintenance and must NOT appear as
// a resumable session row.
//
// Why a generated spike plugin: this Host exposes no plain-REST chat endpoint and
// no REST command endpoint, so the only public way is the same `agents.create` +
// `agent.followup` + `commands.execute(agent, '/compact')` path the UI uses.
// acceptance/host-maintenance.mjs writes the spike into the throwaway $DSH_HOME
// only; the shipped plugin is never modified and nothing here is imported by
// index.js or lib/.
//
// Everything runs against a temp DSH_HOME and OS-assigned ports; the real ~/.dsh
// and this GUI's port are never touched.
//
// Usage: node acceptance/host-maintenance.mjs [--keep]
// Exit: 0 only when every assertion below holds.
import { request as httpRequest } from 'node:http'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(fileURLToPath(import.meta.url))
const REPO = dirname(ROOT)
const KEEP = process.argv.includes('--keep')
const ELECTRON = process.env.DSH_ELECTRON ?? '/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness'
const CLI = process.env.DSH_CLI ?? '/Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js'
const PROFILE = 'maint'
const SESSION_ID = 'spike-maintenance'
const HOLDER_SESSION = 'spike-holding'
const TASK_TEXT = 'maintenance compaction acceptance task'
const HOLDER_TASK = 'hold this turn open until the pause arrives'
const LONG_TEXT = `${'The acceptance mock provider streams a deliberately long answer so the session carries enough history to compact beyond the retained window. '.repeat(160)}`
const LIVE_REASON = 'real maintenance compaction over a live Host: phase.kind maintenance observed, paused over HTTP, canceled apart from sessions'

const manifest = JSON.parse(await readFile(join(REPO, 'package.json'), 'utf8'))
const home = await mkdtemp(join(tmpdir(), 'dsh-host-maint-'))
const evidencePath = join(REPO, 'docs', 'evidence', 'host-maintenance.json')

const evidence = {
  generatedAt: new Date().toISOString(),
  kind: 'host-maintenance',
  plugin: { name: manifest.name, version: manifest.version },
  host: {
    kind: 'isolated-electron',
    electron: ELECTRON,
    cli: CLI,
    dshHome: home,
    dshHomeRetained: KEEP,
    profile: PROFILE,
    baseProfile: 'web',
    note: 'throwaway DSH_HOME and OS-assigned port; the real ~/.dsh profile is not read or written',
  },
  mock: { kind: 'inline openai-completions mock', turn: 'a holder session streams a long answer and stays open: the pause needs a real running turn to capture', target: 'the maintenance target streams a long answer and finishes (compactNow needs an idle agent)', summary: 'the compaction summarization request streams a short summary in delayed pieces, held=false, so no request stalls' },
  spike: {
    file: 'inline in acceptance/host-maintenance.mjs, written to <home>/spike/spike-maint-observer.mjs',
    note: 'creates one Session through the public agents service, finishes one turn, then runs the real /compact command through commands.execute',
  },
  observation: 'agent.phase.kind sampled by the spike observer inside the Host; plan.stopped.maintenance read back from the persisted pause plan',
  steps: [],
  maintenance: {
    id: 'maintenance-compaction-cancellable',
    status: 'unverified',
    reason: LIVE_REASON,
  },
  verdict: 'fail',
}

let allOk = true
const log = (step, detail) => {
  if (detail.ok !== true) allOk = false
  evidence.steps.push({ step, at: new Date().toISOString(), ...detail })
  process.stdout.write(`- ${step}: ${detail.ok === true ? 'ok' : 'FAIL'}\n`)
}

function cliEnv(extra = {}) {
  return { ...process.env, DSH_HOME: home, ELECTRON_RUN_AS_NODE: '1', ...extra }
}

function run(args, { timeoutMs = 180_000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(ELECTRON, [CLI, ...args], { env: cliEnv(), stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs)
    child.stdout.on('data', (chunk) => { out += chunk })
    child.stderr.on('data', (chunk) => { err += chunk })
    child.on('close', (code, signal) => {
      clearTimeout(timer)
      resolve({ code, signal, out, err })
    })
  })
}

async function freePort() {
  const { createServer: netCreateServer } = await import('node:net')
  const server = netCreateServer()
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  await new Promise((resolve) => server.close(resolve))
  return port
}

async function bootHost(extraEnv = {}) {
  const port = await freePort()
  const child = spawn(ELECTRON, [CLI, '--profile', PROFILE, '--no-open', '--port', String(port)], {
    env: cliEnv(extraEnv),
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let out = ''
  let err = ''
  const url = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`host did not print a URL; stdout=${out.slice(-1200)} stderr=${err.slice(-1200)}`)), 120_000)
    const onData = (chunk) => {
      out += chunk
      const match = out.match(/(http:\/\/127\.0\.0\.1:\d+\/?\S*)/)
      if (match) {
        clearTimeout(timer)
        resolve(match[1])
      }
    }
    child.stdout.on('data', onData)
    child.stderr.on('data', (chunk) => { err += chunk })
    child.on('close', (code) => reject(new Error(`host exited before serving (code ${code}); stderr=${err.slice(-1200)}`)))
  })
  return { child, url: new URL(url), out: () => out, err: () => err }
}

async function stopHost(host) {
  if (host.child.exitCode !== null || host.child.signalCode !== null) return
  host.child.kill('SIGTERM')
  await new Promise((resolve) => {
    const timer = setTimeout(() => { host.child.kill('SIGKILL'); resolve() }, 15_000)
    host.child.on('close', () => { clearTimeout(timer); resolve() })
  })
}

function request(host, path, { method = 'GET', timeoutMs = 30_000 } = {}) {
  return new Promise((resolve, reject) => {
    const req = httpRequest({
      hostname: '127.0.0.1',
      port: host.url.port,
      path,
      method,
      headers: { Origin: host.url.origin, 'x-dsh-pause-resume': '1' },
    }, (res) => {
      let text = ''
      res.setEncoding('utf8')
      res.on('data', (chunk) => { text += chunk })
      res.on('end', () => {
        let json = null
        try { json = JSON.parse(text) } catch { /* non-JSON body stays text */ }
        resolve({ status: res.statusCode, json, text: text.slice(0, 800) })
      })
    })
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`request timeout after ${timeoutMs}ms`)))
    req.on('error', reject)
    req.end()
  })
}

async function waitFor(label, predicate, { timeoutMs = 60_000, intervalMs = 100 } = {}) {
  const started = Date.now()
  let last
  while (Date.now() - started < timeoutMs) {
    try {
      last = await predicate()
      if (last) return last
    } catch { /* boot/poll race: keep polling until the deadline */ }
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
  throw new Error(`${label} timed out after ${timeoutMs}ms`)
}

/**
 * Minimal OpenAI-compatible provider. The holder turn stays open until the pause cancels it, the
 * maintenance target streams a long answer and finishes, and summarization calls answer at once so
 * the real maintenance phase stays observable instead of stalling on the mock.
 */
async function startMock() {
  const requests = []
  let release = false
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    if (req.method === 'GET' && url.pathname === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ object: 'list', data: [{ id: 'mock-model', object: 'model' }] }))
      return
    }
    if (req.method !== 'POST' || !url.pathname.endsWith('/chat/completions')) {
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { message: 'no route' } }))
      return
    }
    let raw = ''
    for await (const part of req) raw += part
    let body = {}
    try { body = JSON.parse(raw) } catch { /* empty body */ }
    const model = typeof body.model === 'string' ? body.model : 'mock-model'
    const stream = body.stream === true
    const n = requests.length + 1
    const lastText = textOf(body.messages?.at(-1))
    // The turn preface replaces the user message as the last entry, so the marker is searched across
    // the whole request. The title prompt quotes the user message, which is why summary classification
    // is decided first and the holder is only the plain turn that carries the marker itself.
    const isTitle = lastText.includes('Generate the session title')
    const isSummary = isTitle || lastText.includes('compaction engine')
    const holder = !isSummary && JSON.stringify(body.messages ?? []).includes('hold this turn open')
    const targetTurn = !holder && !isSummary
    const record = {
      n,
      at: new Date().toISOString(),
      stream,
      messages: Array.isArray(body.messages) ? body.messages.length : 0,
      lastRole: Array.isArray(body.messages) ? body.messages.at(-1)?.role ?? null : null,
      lastText: lastText.slice(0, 200),
      targetTurn,
      summary: isSummary,
      held: holder,
      note: holder
        ? 'holder turn: stays open so the pause always has a real running turn to capture; cancelled by the pause'
        : targetTurn
          ? 'maintenance target turn: streams long history, then finishes so compactNow can run on an idle agent'
          : 'compaction summarization: streams a short summary in delayed pieces, held=false, so the real maintenance phase stays observable without stalling',
    }
    requests.push(record)
    process.stderr.write(`mock request ${n}: ${JSON.stringify(record)}\n`)

    if (holder) {
      // A real open turn: the pause captures this session as running work, and cancelling it is what
      // closes this stream. The hold is bounded so a broken pause cannot hang the acceptance.
      if (stream) {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
        res.write(chunk(`mock-${n}`, model, { role: 'assistant', content: '' }))
        res.write(chunk(`mock-${n}`, model, { content: 'holding the turn open' }))
      } else {
        res.writeHead(200, { 'content-type': 'application/json' })
      }
      await new Promise((resolve) => {
        let done = false
        const finish = () => { if (done) return; done = true; clearInterval(timer); resolve() }
        const timer = setInterval(() => { if (release) finish() }, 50)
        req.on('close', finish)
        res.on('close', finish)
        setTimeout(finish, 30_000)
      })
      record.closed = true
      record.finishedAt = new Date().toISOString()
      return
    }

    if (targetTurn) {
      if (!stream) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({
          id: `mock-${n}`, object: 'chat.completion', created: Math.floor(Date.now() / 1000), model,
          choices: [{ index: 0, message: { role: 'assistant', content: LONG_TEXT }, finish_reason: 'stop' }],
          usage: usageOf(raw, LONG_TEXT),
        }))
        return
      }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
      const pieces = splitText(LONG_TEXT, 24)
      res.write(chunk(`mock-${n}`, model, { role: 'assistant', content: '' }))
      for (const piece of pieces) {
        res.write(chunk(`mock-${n}`, model, { content: piece }))
        await sleep(15)
      }
      res.write(usageChunk(`mock-${n}`, model, raw, LONG_TEXT))
      res.write(chunk(`mock-${n}`, model, {}, 'stop'))
      res.write('data: [DONE]\n\n')
      record.finishedAt = new Date().toISOString()
      res.end()
      return
    }

    // Compaction summarization: never held open. It streams a short summary in small,
    // delayed pieces, which keeps the real maintenance phase observable for a few
    // seconds while every piece still makes progress (no 120s stall).
    let closed = false
    req.on('close', () => { closed = true })
    const summary = isTitle ? 'Maintenance acceptance' : 'SUMMARY_STREAMED_BY_MOCK'
    if (stream) {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
      res.write(chunk(`mock-${n}`, model, { role: 'assistant', content: '' }))
      for (const piece of splitText(summary, isTitle ? 1 : 40)) {
        if (closed) break
        res.write(chunk(`mock-${n}`, model, { content: piece }))
        if (!isTitle) await sleep(80)
      }
      if (closed) { record.closed = true; return }
      res.write(usageChunk(`mock-${n}`, model, raw, summary))
      res.write(chunk(`mock-${n}`, model, {}, 'stop'))
      res.write('data: [DONE]\n\n')
    } else {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        id: `mock-${n}`, object: 'chat.completion', created: Math.floor(Date.now() / 1000), model,
        choices: [{ index: 0, message: { role: 'assistant', content: summary }, finish_reason: 'stop' }],
        usage: usageOf(raw, summary),
      }))
    }
    record.finishedAt = new Date().toISOString()
    record.closed = closed
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const { port } = server.address()
  return {
    port,
    baseURL: `http://127.0.0.1:${port}/v1`,
    requests,
    releaseAll() { release = true },
    async close() {
      release = true
      await new Promise((resolve) => server.close(() => resolve()))
    },
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const textOf = (message) => {
  const content = message?.content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return content.map((part) => (typeof part?.text === 'string' ? part.text : '')).join(' ')
  return ''
}
const usageOf = (prompt, completion) => ({
  prompt_tokens: Math.max(1, Math.ceil(prompt.length / 4)),
  completion_tokens: Math.max(1, Math.ceil(completion.length / 4)),
  total_tokens: Math.max(1, Math.ceil((prompt.length + completion.length) / 4)),
})
const chunk = (id, model, delta, finishReason = null) => `data: ${JSON.stringify({
  id, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model,
  choices: [{ index: 0, delta, finish_reason: finishReason }],
})}\n\n`
const usageChunk = (id, model, prompt, completion) => `data: ${JSON.stringify({
  id, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model,
  choices: [], usage: usageOf(prompt, completion),
})}\n\n`
const splitText = (text, parts) => {
  const size = Math.ceil(text.length / parts) || 1
  const out = []
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size))
  return out.length === 0 ? [''] : out
}

const patch = (mock) => `- id: agent-default-model
  config:
    provider: mock
    model: mock-model
- id: llm-pi-ai
  config:
    providers:
      mock:
        displayName: Mock
        apiKeyEnv: MOCK_LLM_TOKEN
        api: openai-completions
        baseURL: ${mock.baseURL}
        models:
          - id: mock-model
            contextWindow: 8000
            maxTokens: 256
        defaultContextWindow: 8000
        defaultMaxTokens: 256
- insert:
    - id: dsh-pause-resume
      name: 'dsh-pause-resume'
    - id: spike-maint-observer
      name: 'file://${join(home, 'spike', 'spike-maint-observer.mjs')}'
`

// The spike: one public Session, one finished turn, then the real /compact command.
// It samples agent.phase.kind continuously — the only place maintenance is visible.
const OBSERVER = `// spike: generated into the throwaway DSH_HOME by acceptance/host-maintenance.mjs
import { appendFileSync } from 'node:fs'
export const name = 'spike-maint-observer'
export const inject = ['agents', 'agentDefaultModel', 'agentPresets', 'commands']
const LOG = process.env.SPIKE_MAINT_LOG ?? ''
const SESSION = process.env.SPIKE_MAINT_SESSION ?? 'spike-maintenance'
const TASK = process.env.SPIKE_MAINT_TASK ?? 'maintenance task'
const HOLDER = process.env.SPIKE_MAINT_HOLDER ?? 'spike-holding'
const HOLDER_TASK = process.env.SPIKE_MAINT_HOLDER_TASK ?? 'hold this turn open'
const NOTE = (row) => { if (LOG !== '') appendFileSync(LOG, JSON.stringify({ at: new Date().toISOString(), ...row }) + '\\n') }
export function apply(ctx) {
  void (async () => {
    try {
      await ctx.get('loader')?.await()
      const agents = ctx.get('agents')
      const commands = ctx.get('commands')
      const defaultModel = ctx.get('agentDefaultModel')
      const presets = ctx.get('agentPresets')
      if (agents === undefined || commands === undefined || defaultModel === undefined || presets === undefined) {
        NOTE({ event: 'missing-service', agents: agents !== undefined, commands: commands !== undefined, model: defaultModel !== undefined, agentPresets: presets !== undefined })
        return
      }
      const selection = defaultModel.currentSelection()
      const fs = ctx.get('fs')
      const cwd = fs === undefined ? process.cwd() : fs.processPath(await fs.resolve('.'))
      const mountStandard = async (agentCtx) => { await agentCtx.get('agentPresets').mount(agentCtx, 'standard') }
      const created = await agents.create({
        sessionId: SESSION,
        meta: { cwd },
        agentOptions: { provider: selection.provider, model: selection.model },
        setup: mountStandard
      })
      const agent = created.agent
      NOTE({ event: 'session-preset', sessionId: agent.id, agentPreset: presets.composedPreset(agent.ctx) ?? null, provider: selection.provider, model: selection.model })
      // A second real session holds an open turn. The pause needs live work to capture, and the
      // maintenance target must be idle before /compact, so the two cannot be the same session.
      const held = await agents.create({
        sessionId: HOLDER,
        meta: { cwd },
        agentOptions: { provider: selection.provider, model: selection.model },
        setup: mountStandard
      })
      const holder = held.agent
      NOTE({ event: 'holder-preset', sessionId: holder.id, agentPreset: presets.composedPreset(holder.ctx) ?? null })
      const last = new Map()
      const sample = () => {
        for (const target of [agent, holder]) {
          const row = { event: 'phase', sessionId: target.id, kind: target.phase?.kind ?? null, status: target.status ?? null }
          const key = String(row.kind) + '/' + String(row.status)
          if (key !== (last.get(target.id) ?? '')) { last.set(target.id, key); NOTE(row) }
        }
      }
      sample()
      const timer = setInterval(sample, 15)
      NOTE({ event: 'session-created', sessionId: agent.id })
      NOTE({ event: 'holder-created', sessionId: holder.id })
      holder.followup({ id: 'spike-holder-turn', role: 'user', content: [{ type: 'text', text: HOLDER_TASK }], source: { kind: 'user' } })
      NOTE({ event: 'holder-turn-started', sessionId: holder.id })
      await new Promise((resolve) => setTimeout(resolve, 500))
      agent.followup({ id: 'spike-maint-turn', role: 'user', content: [{ type: 'text', text: TASK }], source: { kind: 'user' } })
      await agent.whenIdle()
      NOTE({ event: 'turn-done', sessionId: agent.id, kind: agent.phase?.kind ?? null, status: agent.status ?? null })
      await new Promise((resolve) => setTimeout(resolve, 250))
      const meter = ctx.get('tokenMeter')
      NOTE({ event: 'commands-visible', sessionId: agent.id, names: commands.list(agent).map((row) => row.name) })
      NOTE({ event: 'compact-start', sessionId: agent.id, kind: agent.phase?.kind ?? null })
      try {
        let measured = null
        try { measured = meter === undefined ? null : meter.measure(agent.session) } catch (error) { measured = { error: String(error?.message ?? error) } }
        NOTE({ event: 'measure-before-compact', sessionId: agent.id, surfaceNodes: agent.session.surface?.nodes?.length ?? null, tokens: measured?.totalTokens ?? null, nodes: measured?.nodes?.map((node) => ({ seq: node.seq, tokens: node.tokens })) ?? null })
        const outcome = await commands.execute(agent, '/compact', [], new AbortController().signal)
        NOTE({ event: 'compact-settled', sessionId: agent.id, kind: agent.phase?.kind ?? null, keys: outcome === undefined ? null : Object.keys(outcome), result: outcome?.result ?? null })
      } catch (error) {
        NOTE({ event: 'compact-threw', sessionId: agent.id, message: String(error?.message ?? error).slice(0, 300) })
      }
      sample()
      // Keep sampling after the command settles: the pause must be seen clearing maintenance.
      setTimeout(() => clearInterval(timer), 120_000).unref?.()
    } catch (error) {
      NOTE({ event: 'observer-failed', message: String(error?.message ?? error).slice(0, 400) })
    }
  })()
}
`

let mock
let host
let failure = null
try {
  const created = await run(['--profile', PROFILE, '--from-default-profile', 'web', '--dump-config'])
  log('profile-created', { ok: created.code === 0, code: created.code, profile: PROFILE, from: 'web', stderr: created.err.slice(-400) })
  if (created.code !== 0) throw new Error('cannot compose the isolated web profile')

  const added = await run(['plugin', '--profile', PROFILE, 'add', REPO])
  log('plugin-installed', { ok: added.code === 0, code: added.code, plugin: REPO, stderr: added.err.slice(-400) })
  if (added.code !== 0) throw new Error('cannot install dsh-pause-resume into the isolated profile')

  mock = await startMock()
  const spikeDir = join(home, 'spike')
  await mkdir(spikeDir, { recursive: true })
  await writeFile(join(spikeDir, 'spike-maint-observer.mjs'), OBSERVER)
  const patchPath = join(home, 'profiles', PROFILE, 'cordis.patch.yml')
  const previous = (await readFile(patchPath, 'utf8')).split('\n').filter((line) => !line.trim().startsWith('#')).join('\n').trim()
  const providerLayer = patch(mock)
  await writeFile(patchPath, previous === '' || previous === '[]' ? providerLayer : `${previous}\n${providerLayer}`)
  const written = await readFile(patchPath, 'utf8')
  log('model-overridden', {
    ok: written.includes(mock.baseURL) && written.includes("name: 'dsh-pause-resume'") && written.includes('spike-maint-observer'),
    provider: 'mock',
    api: 'openai-completions',
    baseURL: mock.baseURL,
    contextWindow: 8000,
    maxTokens: 256,
    command: '/compact',
  })

  const observerLog = join(home, 'maintenance-observer.jsonl')
  host = await bootHost({ MOCK_LLM_TOKEN: 'spike', SPIKE_MAINT_LOG: observerLog, SPIKE_MAINT_SESSION: SESSION_ID, SPIKE_MAINT_TASK: TASK_TEXT, SPIKE_MAINT_HOLDER: HOLDER_SESSION, SPIKE_MAINT_HOLDER_TASK: HOLDER_TASK })
  log('host-ready', { ok: host.url.port > 0, url: host.url.origin })

  const readObserved = async () => {
    const text = await readFile(observerLog, 'utf8').catch(() => '')
    return text.split('\n').filter(Boolean).map((line) => { try { return JSON.parse(line) } catch { return null } }).filter(Boolean)
  }

  const holderRequest = await waitFor('holder turn held open', () => mock.requests.find((row) => row.held === true), { timeoutMs: 30_000 })
  log('holder-turn-observed', { ok: holderRequest.held === true, n: holderRequest.n, stream: holderRequest.stream, lastText: holderRequest.lastText, held: holderRequest.held })

  const turnDone = await waitFor('first turn finished', async () => (await readObserved()).find((row) => row.event === 'turn-done'), { timeoutMs: 60_000 })
  log('turn-finished', { ok: true, sessionId: turnDone.sessionId, kind: turnDone.kind, status: turnDone.status })

  const compactStart = await waitFor('compact-start note', async () => (await readObserved()).find((row) => row.event === 'compact-start'), { timeoutMs: 15_000 })
  const heldRequest = await waitFor('post-command model request', () => mock.requests.filter((row) => row.summary === true && row.held === false && row.at >= compactStart.at).at(-1), { timeoutMs: 30_000 })
  const maintenanceRow = await waitFor('maintenance phase observed', async () => (await readObserved()).find((row) => row.event === 'phase' && row.sessionId === SESSION_ID && row.kind === 'maintenance'), { timeoutMs: 60_000 })
  const phases = (await readObserved()).filter((row) => row.event === 'phase' && row.sessionId === SESSION_ID).map((row) => `${row.kind}/${row.status}`)
  const holderPhases = (await readObserved()).filter((row) => row.event === 'phase' && row.sessionId === HOLDER_SESSION).map((row) => `${row.kind}/${row.status}`)
  log('maintenance-observed', {
    ok: maintenanceRow.kind === 'maintenance' && heldRequest.at >= compactStart.at,
    observedPhases: phases,
    holderPhases,
    maintenanceAt: maintenanceRow.at,
    heldRequest: { n: heldRequest.n, stream: heldRequest.stream, messages: heldRequest.messages, lastText: heldRequest.lastText, summary: heldRequest.summary, held: heldRequest.held },
  })

  const pauseStarted = Date.now()
  const paused = await request(host, '/dsh-pause-resume/pause', { method: 'POST', timeoutMs: 60_000 })
  const pauseMs = Date.now() - pauseStarted
  const statePaused = await request(host, '/dsh-pause-resume/state')

  const readPlan = async () => {
    const snapshot = await readFile(join(home, 'pause-resume', 'snapshot.json'), 'utf8').catch(() => null)
    if (snapshot !== null) return { file: 'snapshot.json', plan: JSON.parse(snapshot) }
    const pending = await readFile(join(home, 'pause-resume', 'pending.json'), 'utf8').catch(() => null)
    if (pending !== null) return { file: 'pending.json', plan: JSON.parse(pending) }
    return null
  }
  const stored = await readPlan()
  const plan = stored?.plan ?? null
  const maintenance = plan?.stopped?.maintenance ?? null
  const sessionRows = Array.isArray(plan?.sessions) ? plan.sessions : []
  const maintenanceCanceled = Array.isArray(maintenance?.canceled) ? maintenance.canceled : []
  const holderCaptured = sessionRows.some((row) => row?.sessionId === HOLDER_SESSION)
  const pauseStatus = paused.json?.outcome?.status ?? null
  log('paused', {
    ok: paused.status === 200
      && (pauseStatus === 'paused' || pauseStatus === 'partial')
      && statePaused.json?.live?.sessions === 0
      && maintenanceCanceled.includes(SESSION_ID)
      && pauseMs < 30_000,
    status: paused.status,
    outcome: paused.json?.outcome,
    pauseMs,
    liveSessions: statePaused.json?.live?.sessions ?? null,
    maintenanceCanceled,
    accepted: 'paused with no live session and a canceled maintenance row, or a partial stop recorded as observed',
    state: statePaused.json,
  })
  log('maintenance-canceled-apart', {
    ok: maintenanceCanceled.includes(SESSION_ID)
      && Array.isArray(maintenance?.errors) && maintenance.errors.length === 0
      && !sessionRows.some((row) => row?.sessionId === SESSION_ID)
      && holderCaptured,
    planFile: stored?.file ?? null,
    planStatus: plan?.status ?? null,
    stoppedMaintenance: maintenance,
    holderCaptured,
    sessions: sessionRows.map((row) => ({ sessionId: row?.sessionId, kind: row?.kind ?? null, status: row?.status ?? null })),
  })

  const observedAfter = await readObserved()
  const clearedRow = await waitFor('maintenance phase cleared', async () => (await readObserved()).find((row) => row.event === 'phase' && row.sessionId === SESSION_ID && row.kind === 'idle' && Date.parse(row.at) > pauseStarted), { timeoutMs: 90_000 })
  const settledRow = observedAfter.find((row) => row.sessionId === SESSION_ID && (row.event === 'compact-settled' || row.event === 'compact-threw'))
  const cleared = settledRow !== undefined && clearedRow !== undefined
  log('maintenance-cleared', {
    ok: cleared,
    settled: settledRow ?? null,
    idleAfterPause: clearedRow ?? null,
    note: 'the in-flight compaction no longer runs after the pause, and the pause returned without waiting for the held summarization stream',
  })

  const stateAfter = await request(host, '/dsh-pause-resume/state')
  const secondStarted = Date.now()
  const secondPause = await request(host, '/dsh-pause-resume/pause', { method: 'POST', timeoutMs: 30_000 })
  const secondPauseMs = Date.now() - secondStarted
  log('pause-not-waiting', {
    ok: stateAfter.json?.phase === 'paused'
      && stateAfter.json?.live?.sessions === 0
      && secondPauseMs < 3_000
      && ['already', 'partial', 'paused'].includes(secondPause.json?.outcome?.status),
    phase: stateAfter.json?.phase,
    outstanding: stateAfter.json?.outstanding,
    secondPauseMs,
    live: stateAfter.json?.live,
    counts: stateAfter.json?.counts,
    secondPause: secondPause.json?.outcome ?? null,
  })

  evidence.host.port = host.url.origin
  evidence.mock.requests = mock.requests.map((row) => ({
    n: row.n, stream: row.stream, messages: row.messages, lastRole: row.lastRole, lastText: row.lastText,
    targetTurn: row.targetTurn, summary: row.summary, held: row.held, finishedAt: row.finishedAt ?? null, closed: row.closed ?? null,
  }))
  evidence.maintenance = {
    id: 'maintenance-compaction-cancellable',
    status: allOk ? 'verified' : 'unverified',
    reason: `${LIVE_REASON}; observed phase.kind maintenance and the persisted plan's stopped.maintenance row`,
    sessionId: SESSION_ID,
    holderSessionId: HOLDER_SESSION,
    holderRequest: { n: holderRequest.n, stream: holderRequest.stream, lastText: holderRequest.lastText, held: holderRequest.held },
    observedPhases: phases,
    holderPhases,
    summarizationRequest: { n: heldRequest.n, stream: heldRequest.stream, messages: heldRequest.messages, lastText: heldRequest.lastText, held: heldRequest.held },
    pause: { status: paused.status, outcome: paused.json?.outcome ?? null, pauseMs },
    plan: { file: stored?.file ?? null, status: plan?.status ?? null, stoppedMaintenance: maintenance, sessions: sessionRows },
    cleared: { settled: settledRow ?? null, idleAfterPause: clearedRow ?? null },
  }
  evidence.verdict = allOk ? 'pass' : 'fail'
} catch (error) {
  failure = error
  evidence.error = error instanceof Error ? error.message : String(error)
  process.stdout.write(`- FAILED: ${evidence.error}\n`)
  try {
    const text = await readFile(join(home, 'maintenance-observer.jsonl'), 'utf8').catch(() => '')
    evidence.observed = text.split('\n').filter(Boolean).slice(0, 200).map((line) => { try { return JSON.parse(line) } catch { return line } })
  } catch { /* diagnostics only */ }
} finally {
  if (mock !== undefined) {
    try { await mock.close() } catch { /* best effort */ }
    evidence.mock.requests ??= mock.requests
  }
  if (host !== undefined) { try { await stopHost(host) } catch { /* best effort */ } }
  evidence.verdict = failure === null && allOk === true ? 'pass' : 'fail'
  await mkdir(dirname(evidencePath), { recursive: true })
  await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`)
  process.stdout.write(`evidence: ${evidencePath}\n`)
  process.stdout.write(`verdict: ${evidence.verdict} (exit ${evidence.verdict === 'pass' ? 0 : 1})\n`)
  if (!KEEP) {
    const { rm } = await import('node:fs/promises')
    await rm(home, { recursive: true, force: true }).catch(() => {})
  }
  process.exit(evidence.verdict === 'pass' ? 0 : 1)
}
