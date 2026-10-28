#!/usr/bin/env node
// Live Host acceptance for crash-turn-backfill: one real running turn, paused by the
// plugin's HTTP surface, killed with SIGKILL (a crash, not a graceful stop), restarted,
// resumed once, and checked to have landed exactly one model continuation.
//
// Why a generated spike plugin: this Host has no plain-REST chat endpoint, so the only
// public way to produce a real live turn is the same `agents.create` + `agent.followup`
// path `dsh headless` uses. acceptance/spike-live-turn.mjs is copied into the throwaway
// $DSH_HOME (not installed anywhere else) and marked `// spike`; the shipped plugin is
// never modified for this.
//
// The model is acceptance/mock-llm.mjs: an OpenAI-compatible SSE server whose first
// request is held open, so the turn stays `running` for as long as the test needs.
// Everything runs against a temp DSH_HOME and OS-assigned ports; the real ~/.dsh and
// this GUI's port are never touched.
//
// Usage: node acceptance/host-live.mjs [--keep]
// Exit: 0 only when every assertion below holds.
import { request as httpRequest } from 'node:http'
import { spawn } from 'node:child_process'
import { copyFile, mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { zstdDecompressSync } from 'node:zlib'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { startMockLlm } from './mock-llm.mjs'
import { redactedJson } from './redact.mjs'

const ROOT = dirname(fileURLToPath(import.meta.url))
const REPO = dirname(ROOT)
const KEEP = process.argv.includes('--keep')
const ELECTRON = process.env.DSH_ELECTRON ?? '/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness'
const CLI = process.env.DSH_CLI ?? '/Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js'
const PROFILE = 'live'
const SESSION_ID = 'spike-live-turn'
const TURN_TEXT = 'live turn for crash-turn-backfill'
const MOCK_TEXT = 'MOCK_LLM_OK'
const LIVE_TURN_REASON = 'live Host turn: paused over HTTP, SIGKILLed, restarted, resumed exactly once'

const manifest = JSON.parse(await readFile(join(REPO, 'package.json'), 'utf8'))
const home = await mkdtemp(join(tmpdir(), 'dsh-host-live-'))
const evidencePath = join(REPO, 'docs', 'evidence', 'host-live.json')

const evidence = {
  generatedAt: new Date().toISOString(),
  kind: 'host-live',
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
  mock: { kind: 'acceptance/mock-llm.mjs', holdRequests: 1, text: MOCK_TEXT },
  spike: {
    file: 'acceptance/spike-live-turn.mjs',
    note: 'generated into the throwaway DSH_HOME only; starts one turn through the public agents service, then steps aside after a crash',
  },
  steps: [],
  live: {
    id: 'crash-turn-backfill',
    status: 'unverified',
    reason: LIVE_TURN_REASON,
  },
  verdict: 'fail',
}

const log = (step, detail) => {
  if (detail.ok !== true) allOk = false
  evidence.steps.push({ step, at: new Date().toISOString(), ...detail })
  process.stdout.write(`- ${step}: ${detail.ok === false ? 'FAIL' : 'ok'}\n`)
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
  const { createServer } = await import('node:net')
  const server = createServer()
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

function killHost(host) {
  return new Promise((resolve) => {
    if (host.child.exitCode !== null || host.child.signalCode !== null) { resolve({ signal: host.child.signalCode }); return }
    host.child.on('close', (code, signal) => resolve({ code, signal }))
    host.child.kill('SIGKILL')
  })
}

function request(host, path, { method = 'GET' } = {}) {
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
        resolve({ status: res.statusCode, json, text: text.slice(0, 400) })
      })
    })
    req.on('error', reject)
    req.end()
  })
}

async function waitFor(label, predicate, { timeoutMs = 120_000, intervalMs = 150 } = {}) {
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

/** Requests that carry conversation history: the turn itself, not the title call. */
const turnRequests = (mock) => mock.requests.filter((row) => row.messages >= 3)

/** Session transcripts are framed zstd streams: one frame per persisted batch. */
function zstdFrames(buffer) {
  let text = ''
  for (let i = 0; i <= buffer.length - 4; i += 1) {
    if (buffer[i] !== 0x28 || buffer[i + 1] !== 0xb5 || buffer[i + 2] !== 0x2f || buffer[i + 3] !== 0xfd) continue
    try { text += zstdDecompressSync(buffer.subarray(i)).toString('utf8') } catch { /* partial tail frame */ }
  }
  return text
}

async function readSessionText(dir) {
  let entries
  try { entries = await readdir(dir, { withFileTypes: true }) } catch { return '' }
  let text = ''
  for (const entry of entries) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) { text += await readSessionText(path); continue }
    const buffer = await readFile(path).catch(() => null)
    if (buffer === null) continue
    if (entry.name.endsWith('.jsonl')) text += buffer.toString('utf8')
    else if (entry.name.endsWith('.zstd')) text += zstdFrames(buffer)
  }
  return text
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
            contextWindow: 32000
            maxTokens: 4096
        defaultContextWindow: 32000
        defaultMaxTokens: 4096
- insert:
    - id: dsh-pause-resume
      name: 'dsh-pause-resume'
    - id: spike-live-turn
      name: 'file://${join(home, 'spike', 'spike-live-turn.mjs')}'
`

let allOk = true
let mock
let host1
let host2
let failure = null
try {
  const created = await run(['--profile', PROFILE, '--from-default-profile', 'web', '--dump-config'])
  log('profile-created', { ok: created.code === 0, code: created.code, profile: PROFILE, from: 'web', stderr: created.err.slice(-400) })
  if (created.code !== 0) throw new Error('cannot compose the isolated web profile')

  const added = await run(['plugin', '--profile', PROFILE, 'add', REPO])
  log('plugin-installed', { ok: added.code === 0, code: added.code, plugin: REPO, stderr: added.err.slice(-400) })
  if (added.code !== 0) throw new Error('cannot install dsh-pause-resume into the isolated profile')

  mock = await startMockLlm({ holdRequests: 1, text: MOCK_TEXT })
  const spikeDir = join(home, 'spike')
  await mkdir(spikeDir, { recursive: true })
  await copyFile(join(ROOT, 'spike-live-turn.mjs'), join(spikeDir, 'spike-live-turn.mjs'))
  const patchPath = join(home, 'profiles', PROFILE, 'cordis.patch.yml')
  const previous = (await readFile(patchPath, 'utf8')).split('\n').filter((line) => !line.trim().startsWith('#')).join('\n').trim()
  const providerLayer = patch(mock)
  await writeFile(patchPath, previous === '' || previous === '[]' ? providerLayer : `${previous}\n${providerLayer}`)
  const written = await readFile(patchPath, 'utf8')
  log('model-overridden', {
    ok: written.includes(mock.baseURL) && written.includes("name: 'dsh-pause-resume'") && written.includes('spike-live-turn'),
    provider: 'mock',
    api: 'openai-completions',
    baseURL: mock.baseURL,
  })

  const marker = join(home, 'spike-turn.marker')
  host1 = await bootHost({ MOCK_LLM_TOKEN: 'spike', SPIKE_TURN_MARKER: marker, SPIKE_TURN_SESSION: SESSION_ID, SPIKE_TURN_TEXT: TURN_TEXT })
  log('host-ready', { ok: host1.url.port > 0, url: host1.url.origin, boot: 1 })

  const beforeTurn = await waitFor('live turn request', () => (turnRequests(mock).length >= 1 ? turnRequests(mock)[0] : null), { timeoutMs: 120_000 })
  let debugState = null
  const stateBefore = await waitFor('live turn registered', async () => {
    const state = await request(host1, '/dsh-pause-resume/state')
    debugState = state
    return state.json?.live?.sessions >= 1 ? state : null
  }, { timeoutMs: 60_000 }).catch((error) => { throw new Error(`${error.message}; lastState=${JSON.stringify(debugState)}`) })
  log('live-turn-running', {
    ok: stateBefore.json.phase === 'idle' && stateBefore.json.live.sessions === 1 && beforeTurn.held === true,
    phase: stateBefore.json.phase,
    liveSessions: stateBefore.json.live.sessions,
    request: { n: beforeTurn.n, messages: beforeTurn.messages, lastText: beforeTurn.lastText, held: beforeTurn.held },
  })

  const paused = await request(host1, '/dsh-pause-resume/pause', { method: 'POST' })
  const statePaused = await request(host1, '/dsh-pause-resume/state')
  log('paused-with-plan', {
    ok: paused.status === 200
      && paused.json?.outcome?.status === 'paused'
      && paused.json?.outcome?.counts?.sessions === 1
      && statePaused.json?.phase === 'paused'
      && statePaused.json?.outstanding >= 1
      && statePaused.json?.counts?.sessions === 1
      && statePaused.json?.live?.sessions === 0,
    status: paused.status,
    outcome: paused.json?.outcome,
    phase: statePaused.json?.phase,
    outstanding: statePaused.json?.outstanding,
    counts: statePaused.json?.counts,
  })
  if (paused.json?.outcome?.status !== 'paused') throw new Error(`pause did not record the live turn: ${JSON.stringify(paused.json)}`)

  const killed = await killHost(host1)
  log('crashed', { ok: killed.signal === 'SIGKILL' || killed.code === null, signal: killed.signal, code: killed.code, note: 'SIGKILL: no graceful shutdown, no shutdown hook, no flush' })
  host1 = null

  host2 = await bootHost({ MOCK_LLM_TOKEN: 'spike', SPIKE_TURN_MARKER: marker, SPIKE_TURN_SESSION: SESSION_ID, SPIKE_TURN_TEXT: TURN_TEXT })
  log('host-ready', { ok: host2.url.port > 0, url: host2.url.origin, boot: 2 })
  const stateAfterRestart = await waitFor('plan survived the crash', async () => {
    const state = await request(host2, '/dsh-pause-resume/state')
    return state.json?.counts?.sessions >= 1 ? state : null
  }, { timeoutMs: 60_000 })
  log('plan-survived-crash', {
    ok: stateAfterRestart.json.counts.sessions === 1 && stateAfterRestart.json.outstanding >= 1 && stateAfterRestart.json.live.sessions === 0,
    phase: stateAfterRestart.json.phase,
    outstanding: stateAfterRestart.json.outstanding,
    counts: stateAfterRestart.json.counts,
  })

  const resumed = await request(host2, '/dsh-pause-resume/resume', { method: 'POST' })
  log('resumed', { ok: resumed.status === 200 && resumed.json?.outcome?.status === 'resumed', status: resumed.status, outcome: resumed.json?.outcome })

  const continuation = await waitFor('model continuation', () => (turnRequests(mock).length >= 2 ? turnRequests(mock)[1] : null), { timeoutMs: 120_000 })
  const settled = await waitFor('resume settled', async () => {
    const state = await request(host2, '/dsh-pause-resume/state')
    return state.json?.phase === 'idle' && state.json?.outstanding === 0 && state.json?.live?.sessions === 0 ? state : null
  }, { timeoutMs: 120_000 })
  log('continuation-request', {
    ok: continuation.n !== beforeTurn.n
      && continuation.messages > beforeTurn.messages
      && continuation.allText.includes(TURN_TEXT),
    afterResume: { n: continuation.n, messages: continuation.messages, lastText: continuation.lastText, carriesTurnText: continuation.allText.includes(TURN_TEXT) },
    beforeCrash: { n: beforeTurn.n, messages: beforeTurn.messages },
    phase: settled.json.phase,
    outstanding: settled.json.outstanding,
  })

  await new Promise((resolve) => setTimeout(resolve, 3000))
  const turns = turnRequests(mock)
  log('exactly-once', {
    ok: turns.length === 2 && turns[0].n !== turns[1].n,
    turnRequests: turns.length,
    totalRequests: mock.requests.length,
    note: 'one turn before the crash plus one continuation after resume; no third turn and no duplicate continuation',
  })

  const planId = resumed.json?.summary?.planId
  const restoreFiles = (await readdir(join(home, 'pause-resume', 'restores')).catch(() => [])).filter((name) => name.endsWith('.json'))
  const restoreRecords = await Promise.all(restoreFiles.map((name) => readFile(join(home, 'pause-resume', 'restores', name), 'utf8').then((text) => JSON.parse(text)).catch(() => null)))
  const restore = restoreRecords.find((record) => record?.planId === planId) ?? restoreRecords[0] ?? null
  const row = restore?.sessions?.find((entry) => entry.sessionId === SESSION_ID) ?? null
  log('restore-record', {
    ok: restoreFiles.length === 1
      && restore?.status === 'restored'
      && row?.running === true
      && row?.intent === 'continue'
      && row?.epoch === 1
      && row?.continuedTurn === row?.lastTurn
      && restore.summary?.rows?.some((summaryRow) => summaryRow.key === `s:${SESSION_ID}` && summaryRow.status === 'restored'),
    planId,
    files: restoreFiles,
    row,
    summaryRow: restore?.summary?.rows?.find((summaryRow) => summaryRow.key === `s:${SESSION_ID}`) ?? null,
    note: 'persisted plan row: turn continued once, same turn number, epoch 1 (no duplicate continuation)',
  })

  const sessionText = await readSessionText(join(home, 'sessions'))
  log('model-text-in-session', {
    ok: sessionText.includes(MOCK_TEXT) && sessionText.includes(TURN_TEXT),
    sessionId: SESSION_ID,
    mockTextOccurrences: sessionText.split(MOCK_TEXT).length - 1,
  })

  evidence.host.port = host2.url.origin
  evidence.mock.requests = mock.requests.map((row) => ({ n: row.n, messages: row.messages, lastRole: row.lastRole, lastText: row.lastText, held: row.held, finishedAt: row.finishedAt ?? null }))
  evidence.live = {
    id: 'crash-turn-backfill',
    status: 'verified',
    reason: `${LIVE_TURN_REASON}; one real turn request before the crash and one continuation after it`,
    sessionId: SESSION_ID,
    beforeCrash: { request: beforeTurn.n, messages: beforeTurn.messages },
    pause: { outcome: paused.json.outcome, outstanding: statePaused.json.outstanding },
    crash: { signal: killed.signal, code: killed.code },
    afterRestart: { phase: stateAfterRestart.json.phase, outstanding: stateAfterRestart.json.outstanding, counts: stateAfterRestart.json.counts },
    resume: resumed.json.outcome,
    continuation: { request: continuation.n, messages: continuation.messages, carriesTurnText: continuation.allText.includes(TURN_TEXT) },
    plan: { planId, status: restore?.status ?? null, row },
    duplicateContinuation: turns.length > 2,
  }
  evidence.verdict = 'pass'
} catch (error) {
  failure = error
  evidence.error = error instanceof Error ? error.message : String(error)
  process.stdout.write(`- FAILED: ${evidence.error}\n`)
} finally {
  if (host2) await stopHost(host2).catch(() => {})
  if (host1) await stopHost(host1).catch(() => {})
  if (mock) await mock.close()
  evidence.finishedAt = new Date().toISOString()
  if (failure !== null || allOk !== true) evidence.verdict = 'fail'
  await mkdir(dirname(evidencePath), { recursive: true })
  await writeFile(evidencePath, redactedJson(evidence))
  process.stdout.write(`\nverdict: ${evidence.verdict}\nevidence: ${evidencePath}\ndshHome: ${home}${KEEP ? ' (kept)' : ''}\n`)
  if (!KEEP) {
    const { rm } = await import('node:fs/promises')
    await rm(home, { recursive: true, force: true }).catch(() => {})
  }
  process.exit(failure === null && allOk === true ? 0 : 1)
}
