#!/usr/bin/env node
/**
 * Real-Host smoke test on an isolated profile.
 *
 * This is the one acceptance run that does NOT stand in for the Harness: it boots the
 * shipped DSH CLI against a throwaway DSH_HOME, mounts this plugin through the ordinary
 * loader patch, and drives the real HTTP surface. It answers the question the scripted
 * scenarios cannot: does the plugin mount, serve, guard, restart and hydrate inside the
 * real composition?
 *
 * It deliberately does not need a model credential. With no live turn it can only prove
 * mount/route/guards/persistence honesty ("nothing to pause" stays idle; a cold resume
 * reports `empty` instead of faking a restore). Live-work pause against the real Host
 * still requires a configured provider and is documented as unverified.
 *
 * Exit status is part of the contract: any step with `ok: false`, any verdict other than
 * `pass`, or an injected failure makes the process exit non-zero. `--self-test-fail` proves
 * that path without booting anything, so the gate itself cannot silently regress.
 *
 * Usage: node acceptance/host-smoke.mjs [--keep] [--self-test-fail]
 * Env: DSH_ELECTRON (override the app binary), DSH_REPO (default: repo root).
 */
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { createServer } from 'node:net'
import { request as httpRequest } from 'node:http'
import { fileURLToPath } from 'node:url'
import { redactedJson } from './redact.mjs'

const ROOT = dirname(fileURLToPath(new URL('.', import.meta.url)))
const REPO = process.env.DSH_REPO ?? ROOT
const ELECTRON = process.env.DSH_ELECTRON ?? '/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness'
const CLI = join(dirname(ELECTRON), '..', 'Resources', 'app.asar', 'dsh', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
const KEEP = process.argv.includes('--keep')
const SELF_TEST_FAIL = process.argv.includes('--self-test-fail')

// Live-work assertions need a real turn, which needs a configured model provider. On an isolated
// profile there is none, so these stay `unverified` with a reason instead of being reported as
// passing Host coverage. The controllable-service evidence lives in acceptance/round2.mjs.
// `crash-turn-backfill` is no longer listed here: acceptance/host-live.mjs verifies it end-to-end
// against a real Host with a held mock model stream (pause -> SIGKILL -> restart -> resume).
const LIVE_CHECKS = [
  { id: 'maintenance-compaction-cancellable', expectation: 'a maintenance compaction in flight is cancelled by pause', reason: 'verified on a real Host by npm run smoke:maintenance (docs/evidence/host-maintenance.json); this smoke profile cannot produce a compaction' },
  { id: 'stopping-job-visible', expectation: 'a job that is stopping shows up in the live state while stop is in flight' },
  { id: 'job-only-owner-handoff', expectation: 'a plan with only a stopped background job hands the owner session back' },
]

if (!existsSync(ELECTRON)) throw new Error(`DSH app binary not found: ${ELECTRON}`)
// The CLI entry lives inside app.asar, which plain Node cannot stat. Electron's fs can;
// the path is only ever handed to Electron, never read by this script.

const manifest = JSON.parse(await readFile(join(REPO, 'package.json'), 'utf8'))
const version = manifest.version
const home = await mkdtemp(join(tmpdir(), 'dsh-host-smoke-'))
const evidence = {
  generatedAt: new Date().toISOString(),
  plugin: { name: manifest.name, version },
  host: { electron: ELECTRON, cli: CLI, dshHome: home, profile: 'smoke' },
  steps: [],
  live: LIVE_CHECKS.map((check) => ({
    ...check,
    status: 'unverified',
    reason: check.reason ?? 'isolated smoke profile has no model provider, so no live turn can be produced; the same behaviour is exercised against controllable services in acceptance/round2.mjs',
  })),
  verdict: 'fail',
}

const log = (step, detail) => {
  evidence.steps.push({ step, at: new Date().toISOString(), ...detail })
  process.stdout.write(`- ${step}: ${detail.ok === false ? 'FAIL' : 'ok'}\n`)
}

function cliEnv() {
  return { ...process.env, DSH_HOME: home, ELECTRON_RUN_AS_NODE: '1' }
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
  const server = createServer()
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  await new Promise((resolve) => server.close(resolve))
  return port
}

async function bootHost() {
  const port = await freePort()
  const child = spawn(ELECTRON, [CLI, '--profile', 'smoke', '--no-open', '--port', String(port)], {
    env: cliEnv(),
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let out = ''
  let err = ''
  const url = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`host did not print a URL; stdout=${out.slice(-800)} stderr=${err.slice(-800)}`)), 90_000)
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
    child.on('close', (code) => reject(new Error(`host exited before serving (code ${code}); stderr=${err.slice(-800)}`)))
  })
  return { child, url: new URL(url), out: () => out, err: () => err }
}

async function stopHost(host) {
  host.child.kill('SIGTERM')
  await new Promise((resolve) => {
    const timer = setTimeout(() => { host.child.kill('SIGKILL'); resolve() }, 15_000)
    host.child.on('close', () => { clearTimeout(timer); resolve() })
  })
}

// Raw HTTP, not fetch: fetch strips forbidden headers, so it cannot exercise the Host/Origin
// guard at all (it would report a false 200 and hide a real regression).
function request(host, path, { method = 'GET', header = true, origin = true, hostOverride = null } = {}) {
  return new Promise((resolve, reject) => {
    const headers = {}
    if (header) headers['x-dsh-pause-resume'] = '1'
    if (origin === true) headers.Origin = host.url.origin
    else if (typeof origin === 'string') headers.Origin = origin
    if (hostOverride) headers.Host = hostOverride
    const req = httpRequest({
      hostname: '127.0.0.1',
      port: host.url.port,
      path,
      method,
      headers,
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

try {
  if (SELF_TEST_FAIL) {
    // Failure injection: the gate under test must turn this into exit code 1. No Host is booted,
    // because the point is the exit path, not Host coverage.
    log('self-test-fail', { ok: false, detail: 'injected failure: this step must force a non-zero exit' })
    evidence.verdict = 'fail'
    evidence.selfTest = { injected: true, expectedExitCode: 1 }
  } else {
  // 1. Compose an isolated web profile. `--from-default-profile web` alone would boot a host
  // and never return; `--dump-config` materializes the same profile and exits.
  const create = await run(['--profile', 'smoke', '--from-default-profile', 'web', '--dump-config'])
  log('create-profile', { ok: create.code === 0, code: create.code, stderr: create.err.slice(-400) })
  if (create.code !== 0) throw new Error('profile creation failed')

  // `plugin add` links this repo into that profile (it also creates one from the bare base
  // template when none exists, which would lack the web app).
  const add = await run(['plugin', '--profile', 'smoke', 'add', REPO])
  log('install-plugin', { ok: add.code === 0, code: add.code, stderr: add.err.slice(-400) })
  if (add.code !== 0) throw new Error('plugin install failed')

  // `plugin add` links the package but does not insert a loader entry; the patch layer does.
  const profileDir = join(home, 'profiles', 'smoke')
  const patchPath = join(profileDir, 'cordis.patch.yml')
  const patch = profileDir && existsSync(patchPath) ? await readFile(patchPath, 'utf8') : ''
  const entry = `- insert:\n    - id: dsh-pause-resume\n      name: 'dsh-pause-resume'\n`
  // The seeded patch layer is comments plus a literal `[]`; appending to that is invalid YAML,
  // so the empty document is replaced rather than extended.
  const body = patch.split('\n').filter((line) => !line.trim().startsWith('#')).join('\n').trim()
  await writeFile(patchPath, body === '' || body === '[]' ? entry : `${body}\n${entry}`)
  log('mount-entry', { ok: true, patch: entry.trim() })

  // 2. Boot the real host and check the real HTTP surface.
  const host = await bootHost()
  try {
    log('boot', { ok: true, url: host.url.origin })

    const ready = await request(host, '/dsh-pause-resume/state')
    log('state-after-boot', {
      ok: ready.status === 200 && ready.json?.version === version && ready.json?.phase === 'idle',
      status: ready.status,
      body: ready.json,
    })

    const headCheck = await request(host, '/dsh-pause-resume/state', { method: 'HEAD' })
    log('state-head', { ok: headCheck.status === 200, status: headCheck.status })

    const noHeader = await request(host, '/dsh-pause-resume/state', { header: false })
    log('state-without-guard-header', { ok: noHeader.status === 200 || noHeader.status === 403, status: noHeader.status, body: noHeader.json })

    const foreignOrigin = await request(host, '/dsh-pause-resume/state', { origin: 'http://evil.example' })
    log('foreign-origin-rejected', { ok: foreignOrigin.status === 403, status: foreignOrigin.status, body: foreignOrigin.json })

    const foreignHost = await request(host, '/dsh-pause-resume/state', { origin: false, hostOverride: 'evil.example' })
    log('foreign-host-rejected', { ok: foreignHost.status === 403, status: foreignHost.status, body: foreignHost.json })

    const paused = await request(host, '/dsh-pause-resume/pause', { method: 'POST' })
    log('pause-idle', {
      ok: paused.status === 200 && paused.json?.outcome?.status === 'idle',
      status: paused.status,
      body: paused.json,
    })
    const pausedAgain = await request(host, '/dsh-pause-resume/pause', { method: 'POST' })
    log('pause-idle-again', {
      ok: pausedAgain.status === 200 && pausedAgain.json?.outcome?.status === 'idle',
      status: pausedAgain.status,
      body: pausedAgain.json,
    })

    const residue = await request(host, '/dsh-pause-resume/state')
    log('no-plan-created-by-idle-pause', {
      ok: residue.status === 200 && (residue.json?.outcome ?? null) === null && (residue.json?.restore ?? null) === null,
      status: residue.status,
      body: residue.json,
    })
    const files = await import('node:fs/promises').then(({ readdir }) => readdir(join(home, 'pause-resume')).catch(() => []))
    log('state-dir', { ok: Array.isArray(files), files })
  } finally {
    await stopHost(host)
  }

  // 3. Restart the same isolated home: hydration must not invent work.
  const host2 = await bootHost()
  try {
    const cold = await request(host2, '/dsh-pause-resume/state')
    log('state-after-restart', {
      ok: cold.status === 200 && cold.json?.version === version && cold.json?.phase === 'idle' && cold.json?.restore === null,
      status: cold.status,
      body: cold.json,
    })
    const resume = await request(host2, '/dsh-pause-resume/resume', { method: 'POST' })
    log('resume-without-plan', {
      ok: resume.status === 200 && resume.json?.outcome?.status === 'empty',
      status: resume.status,
      body: resume.json,
    })
    const lines = host2.out().split('\n').filter((line) => line.includes('[dsh-pause-resume]'))
    log('plugin-ready-line', { ok: lines.some((line) => line.includes('ready')), lines })
  } finally {
    await stopHost(host2)
  }

  evidence.verdict = evidence.steps.every((step) => step.ok !== false) ? 'pass' : 'fail'
  }
} catch (error) {
  evidence.error = String(error?.stack ?? error)
  process.exitCode = 1
} finally {
  if (!KEEP) await rm(home, { recursive: true, force: true })
  evidence.keptHome = KEEP ? home : null
  // A pass with a recorded failure, or a non-passing verdict, must never leave exit code 0.
  if (evidence.verdict !== 'pass' || evidence.steps.some((step) => step.ok === false)) process.exitCode = 1
  // An injected failure is not evidence about the Host: it must never replace the real smoke
  // record, or a later reader would see a failed verdict for a Host that actually passed.
  const outPath = join(REPO, 'docs', 'evidence', SELF_TEST_FAIL ? 'host-smoke-self-test.json' : 'host-smoke.json')
  await mkdir(dirname(outPath), { recursive: true })
  await writeFile(outPath, redactedJson(evidence))
  process.stdout.write(`\nverdict: ${evidence.verdict}\nexitCode: ${process.exitCode ?? 0}\nevidence: ${outPath}\n`)
}
