#!/usr/bin/env node
// Live Host acceptance for pause wrap-up: one real running turn, paused over the plugin's
// HTTP surface while its model stream is still open, given a chance to answer the pause as a
// real turn (the mock's first request is released only after the pause is in flight), and
// checked that the session ended on its own with an ordinary `completed` — not cancelled —
// and that the pause recorded the wrap-up instead of silently dropping it.
//
// What the assertions prove, in order:
//   1. the wrap-up instruction reached the model as a real turn request (a second, unheld
//      request whose last user text carries the steer prompt),
//   2. the model's answer really landed in the session transcript (a second mock reply after
//      the steer prompt, not just a steered message nobody answered),
//   3. the turn ended by itself: `wrapUp.completed` contains the session and `timedOut` is
//      empty, and the persisted plan's `stopped.canceled` does not contain it,
//   4. the durable plan then shows a normal paused state: phase `paused`, one session owed a
//      continuation, live sessions 0, top-level `wrapUp` present.
//
// The model is acceptance/mock-llm.mjs (OpenAI-compatible SSE): its first request is held
// open, release() lets it finish, and only then does the wrap-up turn run. A generated spike
// plugin (acceptance/spike-live-turn.mjs) starts the real turn through the public `agents`
// service, exactly like acceptance/host-live.mjs. Everything runs against a temp DSH_HOME
// and OS-assigned ports; the real ~/.dsh and this GUI's port are never touched.
//
// Usage: node acceptance/host-wrapup.mjs [--keep]
// Exit: 0 only when every assertion below holds.
import { request as httpRequest } from 'node:http'
import { spawn } from 'node:child_process'
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
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
const PROFILE = 'wrapup'
const SESSION_ID = 'spike-live-turn'
const TURN_TEXT = 'live turn for pause wrap-up'
const MOCK_TEXT = 'MOCK_WRAPUP_OK'
// The steer prompt lib/engine.js passes to the probe; only its opening phrase is asserted, so a
// wording edit in the default text does not silently turn this acceptance into a tautology.
const WRAP_UP_PROMPT = '用户要求暂停当前任务'
const WRAP_UP_REASON = 'live Host turn: paused with its model stream held open, then released so the wrap-up turn could answer before the window closed'

async function freePort() {
  const { createServer } = await import('node:net')
  const server = createServer()
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  await new Promise((resolve) => server.close(resolve))
  return port
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

/** The plan is persisted in one of a few wrapper shapes; find the node that owns `sessions`. */
function findPlanNode(value, depth = 0) {
  if (value === null || typeof value !== 'object' || depth > 6) return null
  if (Array.isArray(value.sessions) && typeof value.planId === 'string') return value
  for (const child of Object.values(value)) {
    const found = findPlanNode(child, depth + 1)
    if (found !== null) return found
  }
  return null
}

async function main() {
  const manifest = JSON.parse(await readFile(join(REPO, 'package.json'), 'utf8'))
  const home = await mkdtemp(join(tmpdir(), 'dsh-host-wrapup-'))
  const evidencePath = join(REPO, 'docs', 'evidence', 'host-wrapup.json')
  const startedAt = Date.now()
  const evidence = {
    generatedAt: new Date().toISOString(),
    kind: 'host-wrapup',
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
      note: 'generated into the throwaway DSH_HOME only; starts one turn through the public agents service',
    },
    steps: [],
    live: {
      id: 'pause-wrapup-turn',
      status: 'unverified',
      reason: WRAP_UP_REASON,
    },
    timing: { startedAt, finishedAt: null, runtimeMs: null },
    verdict: 'fail',
  }

  let allOk = true
  const log = (step, detail) => {
    if (detail.ok !== true) allOk = false
    evidence.steps.push({ step, at: new Date().toISOString(), ...detail })
    process.stdout.write(`- ${step}: ${detail.ok === false ? 'FAIL' : 'ok'}\n`)
  }

  const cliEnv = (extra = {}) => ({ ...process.env, DSH_HOME: home, ELECTRON_RUN_AS_NODE: '1', ...extra })

  const run = (args, { timeoutMs = 180_000 } = {}) => new Promise((resolve) => {
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

  const bootHost = async (extraEnv = {}) => {
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

  const stopHost = async (host) => {
    if (host === null) return
    if (host.child.exitCode !== null || host.child.signalCode !== null) return
    host.child.kill('SIGTERM')
    await new Promise((resolve) => {
      const timer = setTimeout(() => { host.child.kill('SIGKILL'); resolve() }, 15_000)
      host.child.on('close', () => { clearTimeout(timer); resolve() })
    })
  }

  const request = (host, path, { method = 'GET', timeoutMs = 60_000 } = {}) => new Promise((resolve, reject) => {
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
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`${path} did not answer within ${timeoutMs}ms`)))
    req.on('error', reject)
    req.end()
  })

  const waitFor = async (label, predicate, { timeoutMs = 120_000, intervalMs = 150 } = {}) => {
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

  let mock = null
  let host = null
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
    host = await bootHost({ MOCK_LLM_TOKEN: 'spike', SPIKE_TURN_MARKER: marker, SPIKE_TURN_SESSION: SESSION_ID, SPIKE_TURN_TEXT: TURN_TEXT })
    log('host-ready', { ok: host.url.port > 0, url: host.url.origin })

    const firstTurn = await waitFor('live turn request', () => (turnRequests(mock).length >= 1 ? turnRequests(mock)[0] : null), { timeoutMs: 120_000 })
    let debugState = null
    const stateBefore = await waitFor('live turn registered', async () => {
      const state = await request(host, '/dsh-pause-resume/state')
      debugState = state
      return state.json?.live?.sessions >= 1 ? state : null
    }, { timeoutMs: 60_000 }).catch((error) => { throw new Error(`${error.message}; lastState=${JSON.stringify(debugState)}`) })
    log('live-turn-running', {
      ok: stateBefore.json.phase === 'idle' && stateBefore.json.live.sessions === 1 && firstTurn.held === true,
      phase: stateBefore.json.phase,
      liveSessions: stateBefore.json.live.sessions,
      request: { n: firstTurn.n, messages: firstTurn.messages, held: firstTurn.held, heldAt: firstTurn.heldAt ?? null },
    })
    if (firstTurn.held !== true) throw new Error('the first model request is not held; the wrap-up window would be meaningless')

    // The press must be in flight when the steered turn boundary arrives: fire it without
    // awaiting, give the probe time to deliver the steer, then let the held stream finish so the
    // turn can consume that steer as its next step. Releasing first would end the turn before
    // there was anything to wrap up.
    const pauseFiredAt = Date.now()
    const pausePromise = request(host, '/dsh-pause-resume/pause', { method: 'POST', timeoutMs: 60_000 })
    await new Promise((resolve) => setTimeout(resolve, 500))
    const released = await Promise.resolve(mock.release?.()).catch((error) => String(error?.message ?? error))
    const releasedAt = Date.now()
    const paused = await pausePromise
    const pauseDoneAt = Date.now()

    const secondTurn = await waitFor('wrap-up turn request', () => {
      const turns = turnRequests(mock)
      return turns.length >= 2 ? turns[1] : null
    }, { timeoutMs: 60_000 })
    log('wrapup-turn-request', {
      ok: secondTurn.n !== firstTurn.n
        && secondTurn.lastRole === 'user'
        && secondTurn.lastText.includes(WRAP_UP_PROMPT)
        && secondTurn.held === false,
      after: { n: secondTurn.n, messages: secondTurn.messages, lastRole: secondTurn.lastRole, lastText: secondTurn.lastText, held: secondTurn.held, at: secondTurn.at },
      before: { n: firstTurn.n, messages: firstTurn.messages },
      note: 'a real second turn request carrying the pause steer prompt, not a cancelled turn',
    })
    if (secondTurn.lastText.includes(WRAP_UP_PROMPT) === false) throw new Error(`the second request does not carry the wrap-up prompt: ${JSON.stringify(secondTurn.lastText)}`)

    const stateSettled = await waitFor('pause settled', async () => {
      const state = await request(host, '/dsh-pause-resume/state')
      return state.json?.phase === 'paused' && state.json?.live?.sessions === 0 && state.json?.counts?.sessions >= 1 ? state : null
    }, { timeoutMs: 60_000 })
    const wrapUp = paused.json?.outcome?.wrapUp ?? null
    const completed = Array.isArray(wrapUp?.completed) ? wrapUp.completed : []
    const timedOut = Array.isArray(wrapUp?.timedOut) ? wrapUp.timedOut : []
    log('paused-after-wrapup', {
      ok: paused.status === 200
        && paused.json?.outcome?.status === 'paused'
        && paused.json?.outcome?.counts?.sessions === 1
        && Array.isArray(wrapUp?.steered) && wrapUp.steered.includes(SESSION_ID)
        && completed.includes(SESSION_ID)
        && timedOut.length === 0
        && wrapUp?.unavailable === null
        // Nothing timed out, so nothing may be taken back: a press that removed a message it had
        // already had answered would be deleting the model's own turn. Empty by construction.
        && Array.isArray(wrapUp?.retracted) && wrapUp.retracted.length === 0
        && Array.isArray(wrapUp?.retractUnavailable) && wrapUp.retractUnavailable.length === 0,
      status: paused.status,
      outcomeStatus: paused.json?.outcome?.status,
      counts: paused.json?.outcome?.counts,
      wrapUp,
      note: 'the session was steered and then finished its turn inside the window',
    })
    if (completed.includes(SESSION_ID) === false) throw new Error(`pause did not record a completed wrap-up: ${JSON.stringify(wrapUp)}`)

    const snapshotText = await readFile(join(home, 'pause-resume', 'snapshot.json'), 'utf8').catch(() => '')
    const planNode = snapshotText === '' ? null : findPlanNode(JSON.parse(snapshotText))
    const planRow = planNode?.sessions?.find((row) => row.sessionId === SESSION_ID) ?? null
    const canceledRows = Array.isArray(planNode?.stopped?.canceled) ? planNode.stopped.canceled : []
    const canceledIds = canceledRows.map((row) => (typeof row === 'string' ? row : row?.sessionId)).filter((id) => typeof id === 'string')
    log('normal-terminal-state', {
      ok: planNode !== null
        && planNode.status === 'paused'
        && planRow?.wrapUp === 'completed'
        && planRow?.owedContinue === true
        && canceledIds.includes(SESSION_ID) === false
        && (planNode.wrapUp?.completed ?? []).includes(SESSION_ID)
        && (planNode.wrapUp?.timedOut ?? []).length === 0
        && (planNode.wrapUp?.retracted ?? []).length === 0,
      planId: planNode?.planId ?? null,
      planStatus: planNode?.status ?? null,
      row: planRow,
      canceled: canceledIds,
      planWrapUp: planNode?.wrapUp ?? null,
      note: 'the turn ended with an ordinary completed state, so it was not cancelled; the plan still owes the continuation',
    })
    if (planRow?.wrapUp !== 'completed' || planRow?.owedContinue !== true) throw new Error(`plan row does not prove a self-ended wrap-up: ${JSON.stringify(planRow)}`)
    if (canceledIds.includes(SESSION_ID) === true) throw new Error('the session was cancelled by the press; the wrap-up did not end on its own')

    log('state-shows-wrapup', {
      ok: stateSettled.json?.phase === 'paused'
        && stateSettled.json?.counts?.sessions === 1
        && stateSettled.json?.live?.sessions === 0
        && Array.isArray(stateSettled.json?.wrapUp?.completed)
        && stateSettled.json.wrapUp.completed.includes(SESSION_ID),
      phase: stateSettled.json?.phase,
      counts: stateSettled.json?.counts,
      live: stateSettled.json?.live,
      wrapUp: stateSettled.json?.wrapUp,
    })

    const sessionText = await readSessionText(join(home, 'sessions'))
    const promptIndex = sessionText.lastIndexOf(WRAP_UP_PROMPT)
    const answerIndex = sessionText.lastIndexOf(MOCK_TEXT)
    log('wrapup-reply-in-session', {
      ok: promptIndex !== -1 && answerIndex > promptIndex && sessionText.split(MOCK_TEXT).length - 1 >= 2,
      sessionId: SESSION_ID,
      promptIndex,
      answerIndex,
      mockTextOccurrences: sessionText.split(MOCK_TEXT).length - 1,
      wrapUpPromptPresent: promptIndex !== -1,
      note: 'the wrap-up prompt and a model answer after it are both in the real transcript',
    })

    evidence.mock.requests = mock.requests.map((row) => ({
      n: row.n,
      messages: row.messages,
      lastRole: row.lastRole,
      lastText: row.lastText,
      held: row.held,
      heldAt: row.heldAt ?? null,
      releasedAt: row.releasedAt ?? null,
      finishedAt: row.finishedAt ?? null,
    }))
    evidence.pause = {
      status: paused.status,
      outcome: paused.json?.outcome ?? null,
      firedAt: pauseFiredAt,
      releasedAt,
      doneAt: pauseDoneAt,
      releaseResult: released,
      note: 'the press was fired first and the held stream released 500ms later, so the steer arrived at a turn boundary',
    }
    evidence.state = stateSettled.json ?? null
    evidence.plan = { planId: planNode?.planId ?? null, status: planNode?.status ?? null, row: planRow, wrapUp: planNode?.wrapUp ?? null, canceled: canceledIds }
    evidence.transcript = { wrapUpPromptPresent: promptIndex !== -1, answerAfterPrompt: answerIndex > promptIndex, mockTextOccurrences: sessionText.split(MOCK_TEXT).length - 1 }
    evidence.live.status = 'verified'
    evidence.live.reason = `${WRAP_UP_REASON}; wrap-up completed in the window, turn ended by itself, plan owes one continuation`
    evidence.verdict = allOk === true ? 'pass' : 'fail'
  } catch (error) {
    const failure = error instanceof Error ? error.message : String(error)
    evidence.failure = failure
    evidence.verdict = 'fail'
    process.stdout.write(`FAILED: ${failure}\n`)
  } finally {
    try { await stopHost(host) } catch { /* the temp home goes away with the process */ }
    try { await mock?.close?.() } catch { /* the mock is in-process; nothing durable */ }
    const finishedAt = Date.now()
    evidence.timing.finishedAt = new Date(finishedAt).toISOString()
    evidence.timing.runtimeMs = finishedAt - startedAt
    evidence.generatedAt = new Date(finishedAt).toISOString()
    try {
      await mkdir(dirname(evidencePath), { recursive: true })
      await writeFile(evidencePath, redactedJson(evidence))
    } catch (error) {
      process.stdout.write(`cannot write evidence: ${error instanceof Error ? error.message : String(error)}\n`)
      allOk = false
    }
    if (KEEP === false) await rm(home, { recursive: true, force: true }).catch(() => {})
    process.stdout.write(`\nverdict: ${evidence.verdict} in ${Math.round(evidence.timing.runtimeMs / 1000)}s\n`)
    process.stdout.write(`evidence: ${evidencePath}\n`)
    if (KEEP === true) process.stdout.write(`dsh home kept: ${home}\n`)
    return allOk === true && evidence.verdict === 'pass' ? 0 : 1
  }
}

main().then((code) => { process.exitCode = code }, (error) => {
  process.stdout.write(`UNEXPECTED: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
  process.exitCode = 1
})
