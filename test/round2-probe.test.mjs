import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import * as zlib from 'node:zlib'
import { createProbe } from '../lib/probe.js'

function registry(services) {
  return { get: (key) => services[key] }
}

/** The same Harness shape the shipped probe depends on: agents, goals, jobs, sessionController. */
function harness({ agents = [], goals = {}, jobs = {}, unownedJobs = [], kill = null, cancel = null } = {}) {
  const calls = []
  const live = new Map(agents.map((agent) => [agent.id, agent]))
  const services = {
    agents: { get: (id) => live.get(id), list: () => [...live.values()] },
    goals: {
      get: (agent) => {
        if (live.get(agent?.id) !== agent) throw new Error('GOAL_AGENT_NOT_LIVE')
        const view = goals[agent.id]
        return view === undefined ? undefined : { ...view }
      },
      pause: (agent, ref) => {
        const view = goals[agent.id]
        if (view === undefined || view.id !== ref.id || view.revision !== ref.revision) throw new Error('GOAL_STALE_REVISION')
        goals[agent.id] = { ...view, phase: 'paused', activation: 'disarmed', revision: view.revision + 1 }
        return { ...goals[agent.id] }
      },
    },
    jobs: {
      list: (caller) => (caller === undefined ? unownedJobs : jobs[caller] ?? []),
      kill: (id, caller) => {
        calls.push(['jobs.kill', id, caller ?? null])
        if (typeof kill === 'function') {
          kill(id, caller)
          return
        }
        const rows = caller === undefined ? unownedJobs : jobs[caller] ?? []
        for (const row of rows) if (row.id === id) row.status = 'killed'
      },
    },
    sessionController: {
      cancel: async (request) => {
        calls.push(['cancel', request.sessionId])
        if (typeof cancel === 'function') {
          cancel(request.sessionId)
          return
        }
        const agent = live.get(request.sessionId)
        if (agent !== undefined) {
          agent.status = 'idle'
          agent.phase.lastTurn = (agent.phase.lastTurn ?? 0) + 1
        }
      },
      resolveAgent: async (sessionId) => {
        calls.push(['resolveAgent', sessionId])
        const existing = live.get(sessionId)
        if (existing !== undefined) return existing
        const agent = { id: sessionId, status: 'idle', phase: { lastTurn: 0 }, mounted: true }
        live.set(sessionId, agent)
        return { agent }
      },
      prompt: async (request, signal) => {
        calls.push(['prompt', request.sessionId, request.requestId, signal instanceof AbortSignal])
        signal.throwIfAborted()
        const agent = live.get(request.sessionId)
        if (agent === undefined) throw new Error('SESSION_NOT_FOUND')
        agent.status = 'running'
        agent.phase.lastTurn = (agent.phase.lastTurn ?? 0) + 1
        return { accepted: true }
      },
    },
  }
  services.subagents = {
    prompt: async (request, signal) => {
      calls.push(['subagents.prompt', request.childSessionId, request.requestId, signal instanceof AbortSignal])
      const child = live.get(request.childSessionId)
      if (child !== undefined) {
        child.status = 'running'
        child.phase.lastTurn = (child.phase.lastTurn ?? 0) + 1
      }
      return { accepted: true }
    },
    interrupt: async (sessionId) => {
      calls.push(['subagents.interrupt', sessionId])
    },
  }
  return { services, registry: registry(services), calls, live }
}

/** A readable turn boundary plus a real event channel, like the shipped projection and watcher. */
function turnRig({ lastTurn = 6, open = false, status = 'idle' } = {}) {
  const fake = harness({ agents: [{ id: 's1', status, phase: { lastTurn }, session: { id: 's1' } }] })
  const state = { lastTurn, openTurnStartSeq: open ? 1 : null }
  fake.services.sessionProjections = { stateOf: (session, key) => (key === 'turnBoundary' ? state : undefined) }
  const handlers = new Map()
  const order = []
  const watchTurn = (sessionId, onEvent) => {
    order.push(['watch', sessionId])
    handlers.set(sessionId, onEvent)
    return () => handlers.delete(sessionId)
  }
  const emit = (sessionId, event) => handlers.get(sessionId)?.(event)
  return { fake, state, watchTurn, emit, order }
}

const UUID = () => randomUUID()

/** A real zstd session log: one compressed frame per flush, exactly like the shipped writer. */
async function writeSessionLog(home, sessionId, frames) {
  const dir = join(home, 'sessions', 'bucket', `session-${sessionId}`)
  await mkdir(dir, { recursive: true })
  const file = join(dir, 'session.v4.jsonl.zstd')
  const parts = frames.map((lines) => {
    const text = lines.map((line) => JSON.stringify(line)).join('\n') + '\n'
    return zlib.zstdCompressSync(Buffer.from(text, 'utf8'))
  })
  await writeFile(file, Buffer.concat(parts))
  return file
}

function turnEnd(turn, kind) {
  return { type: 'turn/end', data: { turn, reason: { kind } } }
}

test('assessSession() reads a completed turn from the persisted session log and skips it', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-round2-'))
  try {
    const sessionId = UUID()
    await writeSessionLog(home, sessionId, [[turnEnd(3, 'interrupted')], [turnEnd(5, 'completed')]])
    const fake = harness({ agents: [{ id: sessionId, status: 'idle', phase: { lastTurn: 4 }, session: { id: sessionId } }] })
    const probe = createProbe(fake.registry, { dshHome: home, settleMs: 60 })
    const session = { sessionId, intent: 'continue', epoch: 1, lastTurn: 4 }
    const verdict = await probe.assessSession(session, { plan: { planId: 'p1' } })
    assert.equal(verdict.action, 'skip')
    assert.equal(verdict.turn, 5)
    assert.equal(verdict.end, 'completed')
    assert.match(verdict.detail, /completed before this restore/)
    const outcome = await probe.restoreSession(session, { plan: { planId: 'p1' } })
    assert.equal(outcome.status, 'skipped')
    assert.equal(outcome.continued, false)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('assessSession() returns unknown, never skip, when no turn end is readable', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-round2-'))
  try {
    const sessionId = UUID()
    const probe = createProbe(harness({}).registry, { dshHome: home, settleMs: 60 })
    const verdict = await probe.assessSession({ sessionId, intent: 'continue', epoch: 1, lastTurn: 6 })
    assert.equal(verdict.action, 'unknown')
    assert.match(verdict.detail, /refusing to guess/)
    // A turn number (6) exists in the row; it is not evidence, so the verdict is not `skip`.
    assert.notEqual(verdict.action, 'skip')
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('assessSession() reads an interrupted turn as owed work, not as completion', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-round2-'))
  try {
    const sessionId = UUID()
    await writeSessionLog(home, sessionId, [[turnEnd(7, 'interrupted')]])
    const probe = createProbe(harness({}).registry, { dshHome: home, settleMs: 60 })
    const verdict = await probe.assessSession({ sessionId, intent: 'continue', epoch: 1, lastTurn: 6 })
    assert.equal(verdict.action, 'continue')
    assert.equal(verdict.end, 'interrupted')
    assert.match(verdict.detail, /interrupted/)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('assessSession() trusts a turn end service over guessing from the turn counter', async () => {
  const fake = harness({ agents: [{ id: 's1', status: 'idle', phase: { lastTurn: 6 } }] })
  fake.services.sessionLog = { readTurnEnds: () => [{ turn: 4, kind: 'completed' }] }
  const probe = createProbe(fake.registry, { settleMs: 60 })
  const verdict = await probe.assessSession({ sessionId: 's1', intent: 'continue', epoch: 1, lastTurn: 6 })
  assert.equal(verdict.action, 'skip')
  assert.equal(verdict.end, 'completed')
})

test('a continuation names only stopped jobs as stopped and flags the rest for inspection', async () => {
  const rig = turnRig({ lastTurn: 6 })
  let sent = null
  rig.fake.services.sessionController.prompt = async (request) => {
    sent = request.content[0].text
    const agent = rig.fake.live.get('s1')
    agent.status = 'running'
    agent.phase.lastTurn = 7
    rig.state.lastTurn = 7
    rig.state.openTurnStartSeq = 4
    return { accepted: true }
  }
  const probe = createProbe(rig.fake.registry, { settleMs: 60, watchTurn: rig.watchTurn })
  const plan = {
    planId: 'p1',
    jobs: [
      { id: 'j1', owner: 's1', status: 'stopped' },
      { id: 'j2', owner: 's1', status: 'stopping' },
      { id: 'j3', owner: 's1', status: 'stop-failed' },
      { id: 'j4', owner: 's1', status: 'unknown' },
      { id: 'j5', owner: 'other', status: 'stopped' },
    ],
  }
  const outcome = await probe.restoreSession(
    { sessionId: 's1', intent: 'continue', epoch: 1, lastTurn: 6 },
    { plan },
  )
  assert.equal(outcome.status, 'restored')
  assert.match(sent, /暂停时停止了后台任务 j1；/)
  assert.match(sent, /后台任务 j2 正在停止，继续前请先检查/)
  assert.match(sent, /后台任务 j3、j4 仍可能运行，请先检查/)
  // Only the truly stopped job may appear in the stopped clause; another session's job is not ours.
  assert.equal(sent.match(/暂停时停止了后台任务 ([^；]*)/)[1], 'j1')
  assert.equal(sent.includes('j5'), false)
})

test('a pure job handoff never claims the background work was stopped', async () => {
  const rig = turnRig({ lastTurn: 6 })
  let sent = null
  rig.fake.services.sessionController.prompt = async (request) => {
    sent = request.content[0].text
    rig.state.lastTurn = 7
    rig.state.openTurnStartSeq = 4
    return { accepted: true }
  }
  const probe = createProbe(rig.fake.registry, { settleMs: 60, watchTurn: rig.watchTurn })
  await probe.restoreSession(
    { sessionId: 's1', intent: 'continue', epoch: 1, lastTurn: 6 },
    { plan: { planId: 'p1', jobs: [{ id: 'j9', owner: null, status: 'stop-failed' }] } },
  )
  assert.equal(sent, '继续')
})

test('a completed turn is never pressed twice even when the row carries a newer counter', async () => {
  const rig = turnRig({ lastTurn: 7 })
  rig.fake.services.sessionLog = { readTurnEnds: () => [{ turn: 7, kind: 'completed' }] }
  rig.fake.calls.length = 0
  const probe = createProbe(rig.fake.registry, { settleMs: 60, watchTurn: rig.watchTurn })
  const outcome = await probe.restoreSession(
    { sessionId: 's1', intent: 'continue', epoch: 1, lastTurn: 7 },
    { plan: { planId: 'p1' } },
  )
  assert.equal(outcome.status, 'skipped')
  assert.equal(rig.fake.calls.some((call) => call[0] === 'prompt'), false)
})

test('an unknown row continued by hand and finished becomes one attention line, not an endless unknown', async () => {
  const rig = turnRig({ lastTurn: 7 })
  rig.fake.services.sessionLog = { readTurnEnds: () => [{ turn: 7, kind: 'completed' }] }
  rig.fake.calls.length = 0
  const probe = createProbe(rig.fake.registry, { settleMs: 60, watchTurn: rig.watchTurn })
  const outcome = await probe.restoreSession(
    { sessionId: 's1', intent: 'unknown', epoch: 1, lastTurn: 6 },
    { plan: { planId: 'p1' } },
  )
  assert.equal(outcome.status, 'attention')
  assert.equal(outcome.continued, false)
  assert.match(outcome.detail, /confirm the paused work was part of it/)
  // No continuation may be sent: the row is terminal for this press, not a duplicate.
  assert.equal(rig.fake.calls.some((call) => call[0] === 'prompt'), false)
})

test('the same unknown row resolves from the persisted log when no end service exists', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-round2-'))
  try {
    const sessionId = UUID()
    await writeSessionLog(home, sessionId, [[turnEnd(7, 'interrupted')], [turnEnd(8, 'completed')]])
    const fake = harness({ agents: [{ id: sessionId, status: 'idle', phase: { lastTurn: 8 }, session: { id: sessionId } }] })
    const probe = createProbe(fake.registry, { dshHome: home, settleMs: 60 })
    const outcome = await probe.restoreSession(
      { sessionId, intent: 'unknown', epoch: 1, lastTurn: 6 },
      { plan: { planId: 'p1' } },
    )
    assert.equal(outcome.status, 'attention')
    assert.equal(outcome.turn, 8)
    assert.equal(fake.calls.some((call) => call[0] === 'prompt'), false)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('the turn listener is registered before the prompt is submitted', async () => {
  const rig = turnRig({ lastTurn: 6 })
  const probe = createProbe(rig.fake.registry, { settleMs: 60, watchTurn: rig.watchTurn })
  rig.fake.services.sessionController.prompt = async (request) => {
    rig.order.push(['prompt', request.requestId])
    const agent = rig.fake.live.get('s1')
    agent.status = 'running'
    agent.phase.lastTurn = 7
    rig.state.lastTurn = 7
    // The turn opens and closes inside the submit window: only a listener registered before the
    // prompt can see it, and a miss would report "no turn started" and resend the continuation.
    rig.emit('s1', { type: 'turn/start', data: { turn: 7 } })
    rig.emit('s1', { type: 'turn/end', data: { turn: 7, reason: { kind: 'completed' } } })
    return { accepted: true }
  }
  const outcome = await probe.restoreSession(
    { sessionId: 's1', intent: 'continue', epoch: 1, lastTurn: 6 },
    { plan: { planId: 'p1' } },
  )
  const watchAt = rig.order.findIndex((call) => call[0] === 'watch')
  const promptAt = rig.order.findIndex((call) => call[0] === 'prompt')
  assert.ok(watchAt !== -1, 'the turn listener was never registered')
  assert.ok(watchAt < promptAt, `listener registered at ${watchAt}, prompt submitted at ${promptAt}`)
  assert.equal(outcome.status, 'restored')
  assert.equal(outcome.turn, 7)
  assert.equal(outcome.turnEnd, 'completed')
  assert.equal(rig.order.filter((call) => call[0] === 'prompt').length, 1)
})

test('restoreChild() skips a completed child turn instead of interrupting it again', async () => {
  const fake = harness({
    agents: [
      { id: 'p1', status: 'idle', phase: { lastTurn: 9 }, session: { id: 'p1' } },
      { id: 'c1', status: 'idle', phase: { lastTurn: 5 }, session: { id: 'c1', header: { parentSession: 'p1' } } },
    ],
  })
  fake.services.sessionLog = { readTurnEnds: () => [{ turn: 6, kind: 'completed' }] }
  const probe = createProbe(fake.registry, { settleMs: 60 })
  const outcome = await probe.restoreSession(
    { sessionId: 'c1', parent: 'p1', origin: 'subagent', intent: 'continue', epoch: 1, lastTurn: 5 },
    { plan: { planId: 'p1' } },
  )
  assert.equal(outcome.status, 'skipped')
  assert.equal(fake.calls.some((call) => call[0] === 'prompt'), false)
})

test('restoreChild() never resumes a child row whose turn ended before the restart', async () => {
  const fake = harness({
    agents: [
      { id: 'p1', status: 'idle', phase: { lastTurn: 9 }, session: { id: 'p1' } },
      { id: 'c1', status: 'idle', phase: { lastTurn: 5 }, session: { id: 'c1', header: { parentSession: 'p1' } } },
    ],
  })
  // No end service and no log: without the intent check this row would be prompted on a guess.
  const probe = createProbe(fake.registry, { settleMs: 60 })
  const outcome = await probe.restoreSession(
    { sessionId: 'c1', parent: 'p1', origin: 'subagent', intent: 'skip', epoch: 1, lastTurn: 5 },
    { plan: { planId: 'p1' } },
  )
  assert.equal(outcome.status, 'skipped')
  assert.equal(fake.calls.some((call) => call[0] === 'subagents.prompt'), false)
})

test('restoreChild() closes a hand-finished unknown child as attention, not a prompt', async () => {
  const fake = harness({
    agents: [
      { id: 'p1', status: 'idle', phase: { lastTurn: 9 }, session: { id: 'p1' } },
      { id: 'c1', status: 'idle', phase: { lastTurn: 5 }, session: { id: 'c1', header: { parentSession: 'p1' } } },
    ],
  })
  fake.services.sessionLog = { readTurnEnds: () => [{ turn: 6, kind: 'completed' }] }
  const probe = createProbe(fake.registry, { settleMs: 60 })
  const outcome = await probe.restoreSession(
    { sessionId: 'c1', parent: 'p1', origin: 'subagent', intent: 'unknown', epoch: 1, lastTurn: 5 },
    { plan: { planId: 'p1' } },
  )
  assert.equal(outcome.status, 'attention')
  assert.equal(outcome.turn, 6)
  assert.equal(fake.calls.some((call) => call[0] === 'subagents.prompt'), false)
})

test('restoreChild() reports a child already running by hand as running, never as a prompt', async () => {
  const fake = harness({
    agents: [
      { id: 'p1', status: 'idle', phase: { lastTurn: 9 }, session: { id: 'p1' } },
      { id: 'c1', status: 'running', phase: { lastTurn: 6 }, session: { id: 'c1', header: { parentSession: 'p1' } } },
    ],
  })
  const probe = createProbe(fake.registry, { settleMs: 60 })
  const outcome = await probe.restoreSession(
    { sessionId: 'c1', parent: 'p1', origin: 'subagent', intent: 'unknown', epoch: 1, lastTurn: 5 },
    { plan: { planId: 'p1' } },
  )
  assert.equal(outcome.status, 'restored')
  assert.equal(outcome.continued, true)
  assert.equal(fake.calls.some((call) => call[0] === 'subagents.prompt'), false)
})

test('restoreChild() reports an already admitted continuation instead of sending it again', async () => {
  const fake = harness({
    agents: [
      { id: 'p1', status: 'idle', phase: { lastTurn: 9 }, session: { id: 'p1' } },
      { id: 'c1', status: 'idle', phase: { lastTurn: 5 }, session: { id: 'c1', header: { parentSession: 'p1' } } },
    ],
  })
  const probe = createProbe(fake.registry, { settleMs: 60 })
  const outcome = await probe.restoreSession(
    {
      sessionId: 'c1',
      parent: 'p1',
      origin: 'subagent',
      intent: 'continue',
      epoch: 2,
      lastTurn: 5,
      admittedRequest: 'continue:p1:c1:2:0',
      admittedEpoch: 2,
    },
    { plan: { planId: 'p1' } },
  )
  assert.equal(outcome.status, 'restored')
  assert.equal(outcome.continued, true)
  assert.equal(outcome.turn, 5)
  assert.match(outcome.detail, /already admitted/)
  assert.equal(fake.calls.some((call) => call[0] === 'prompt'), false)
  assert.equal(fake.calls.some((call) => call[0] === 'subagents.prompt'), false)
})

test('live() reports a maintenance compaction apart from the resume sessions', () => {
  const fake = harness({
    agents: [
      { id: 'm1', status: 'idle', phase: { kind: 'maintenance', lastTurn: 2 } },
      { id: 's1', status: 'running', phase: { lastTurn: 4 } },
    ],
  })
  const probe = createProbe(fake.registry)
  const view = probe.live()
  assert.deepEqual(view.maintenance, [{ sessionId: 'm1' }])
  assert.deepEqual(view.sessions.map((row) => row.sessionId), ['s1'])
})

test('stop() cancels a maintenance compaction through the official entry, not a session row', async () => {
  const fake = harness({ agents: [{ id: 'm1', status: 'idle', phase: { kind: 'maintenance', lastTurn: 2 } }] })
  const probe = createProbe(fake.registry, { graceMs: 200 })
  const stopped = await probe.stop(probe.live())
  assert.deepEqual(stopped.maintenanceCanceled, ['m1'])
  assert.deepEqual(stopped.maintenanceErrors, [])
  assert.deepEqual(stopped.sessions, [])
  assert.equal(fake.calls.some((call) => call[0] === 'cancel' && call[1] === 'm1'), true)
})

test('stop() reports a maintenance entry it could not cancel as unknown', async () => {
  const fake = harness({
    agents: [{ id: 'm1', status: 'idle', phase: { kind: 'maintenance', lastTurn: 2 } }],
    cancel: () => {
      throw new Error('cancel entry unreachable')
    },
  })
  const probe = createProbe(fake.registry, { graceMs: 200 })
  const stopped = await probe.stop(probe.live())
  assert.deepEqual(stopped.maintenanceCanceled, [])
  assert.equal(stopped.maintenanceErrors.length, 1)
  assert.equal(stopped.maintenanceErrors[0].sessionId, 'm1')
  assert.match(stopped.maintenanceErrors[0].detail, /unreachable/)
})

test('stop() keeps a job the kill refused in the handoff evidence and in live()', async () => {
  const fake = harness({
    unownedJobs: [{ id: 'j1', status: 'running' }],
    kill: () => {
      throw new Error('job service refused')
    },
  })
  const probe = createProbe(fake.registry, { graceMs: 200 })
  const stopped = await probe.stop(probe.live())
  assert.deepEqual(stopped.jobHandoff, [{ id: 'j1', owner: null, status: 'stop-failed', detail: 'job service refused' }])
  const after = probe.live()
  assert.equal(after.jobs.some((job) => job.id === 'j1' && job.status === 'stop-failed'), true)
})

test('stop() keeps a job that was still stopping after the pause as a handoff obligation', async () => {
  const fake = harness({ unownedJobs: [{ id: 'j2', status: 'running' }], kill: () => {} })
  const probe = createProbe(fake.registry, { graceMs: 120 })
  const stopped = await probe.stop(probe.live())
  assert.equal(stopped.jobHandoff.length, 1)
  assert.equal(stopped.jobHandoff[0].status, 'stopping')
  const after = probe.live()
  assert.equal(after.jobs.some((job) => job.id === 'j2' && job.status === 'stopping'), true)
})

test('a plan that only carried jobs reports a handoff and no session to continue', async () => {
  const fake = harness({
    unownedJobs: [{ id: 'j3', status: 'running' }],
    kill: () => {
      throw new Error('job service refused')
    },
  })
  const probe = createProbe(fake.registry, { graceMs: 200 })
  const stopped = await probe.stop({ sessions: [], goals: [], jobs: [{ id: 'j3', owner: null }] })
  assert.deepEqual(stopped.sessions, [])
  assert.deepEqual(stopped.jobHandoff.map((row) => row.status), ['stop-failed'])
})

test('restoreSession() continues crash residue whose dead projection is still open', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-round2-'))
  try {
    const sessionId = 's1'
    // The dead process left the projection open; the durable log is the only proof of what the
    // turn did. The open boundary alone must never read as "a turn is running right now".
    await writeSessionLog(home, sessionId, [[turnEnd(7, 'interrupted')]])
    const rig = turnRig({ lastTurn: 7, open: true, status: 'idle' })
    // The delivered prompt is what opens the new turn; the projection follows it, exactly like the
    // shipped one. Without this the rig could never show the continuation starting.
    const basePrompt = rig.fake.services.sessionController.prompt
    rig.fake.services.sessionController.prompt = async (request, signal) => {
      const result = await basePrompt(request, signal)
      rig.state.lastTurn = 8
      rig.state.openTurnStartSeq = 2
      rig.emit(sessionId, { kind: 'turn/start', turn: 8 })
      return result
    }
    const probe = createProbe(rig.fake.registry, { dshHome: home, settleMs: 200 })
    const session = { sessionId, intent: 'continue', epoch: 1, lastTurn: 7 }
    const outcome = await probe.restoreSession(session, { plan: { planId: 'crash-1', sessions: [session] } })
    assert.doesNotMatch(String(outcome.detail), /already running/, 'a dead projection is not live work')
    assert.equal(outcome.continued, true, `crash residue must be continued, got ${JSON.stringify(outcome)}`)
    assert.ok(rig.fake.calls.some((call) => call[0] === 'prompt' && call[1] === sessionId), 'the continuation is delivered')
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('restoreSession() still treats a live running turn as already running, never as residue', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-round2-'))
  try {
    const sessionId = 's1'
    await writeSessionLog(home, sessionId, [[turnEnd(7, 'interrupted')]])
    const rig = turnRig({ lastTurn: 7, open: true, status: 'running' })
    const probe = createProbe(rig.fake.registry, { dshHome: home, settleMs: 60 })
    const session = { sessionId, intent: 'continue', epoch: 1, lastTurn: 7 }
    const outcome = await probe.restoreSession(session, { plan: { planId: 'live-1', sessions: [session] } })
    assert.match(String(outcome.detail), /already running/)
    assert.equal(rig.fake.calls.some((call) => call[0] === 'prompt'), false, 'a live turn gets no second continuation')
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('an unknown root row whose log proves the turn was cut in flight is continued, not held forever', async () => {
  // The reported failure: after a real restart, play moved the button but no work restarted, because
  // every `unknown` row answered "open the session to decide" even though the persisted log already
  // carried the reason (its latest turn ended `interrupted`). A cut turn owes its continuation.
  const rig = turnRig({ lastTurn: 7 })
  const live = rig.fake.live.get('s1')
  rig.fake.services.sessionProjections = { stateOf: (session, key) => (key === 'turnBoundary' ? { lastTurn: live.phase.lastTurn, openTurnStartSeq: null } : undefined) }
  rig.fake.services.sessionLog = { readTurnEnds: () => [{ turn: 7, kind: 'interrupted' }] }
  rig.fake.calls.length = 0
  const probe = createProbe(rig.fake.registry, { settleMs: 200, watchTurn: rig.watchTurn })
  const outcome = await probe.restoreSession(
    { sessionId: 's1', intent: 'unknown', epoch: 1, lastTurn: 6 },
    { plan: { planId: 'p1' } },
  )
  assert.equal(outcome.continued, true, JSON.stringify(outcome))
  assert.equal(outcome.status, 'restored')
  assert.equal(outcome.turn, 8)
  assert.equal(rig.fake.calls.filter((call) => call[0] === 'prompt').length, 1)
})

test('the cut-in-flight continuation also works from the persisted zstd log with no end service', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-round2-'))
  try {
    const sessionId = UUID()
    await writeSessionLog(home, sessionId, [[turnEnd(4, 'interrupted')]])
    const agent = { id: sessionId, status: 'idle', phase: { lastTurn: 4 }, session: { id: sessionId } }
    const live = new Map([[sessionId, agent]])
    const calls = []
    const services = {
      agents: { get: (id) => live.get(id), list: () => [...live.values()] },
      sessionProjections: { stateOf: (session, key) => (key === 'turnBoundary' ? { lastTurn: agent.phase.lastTurn, openTurnStartSeq: null } : undefined) },
      sessionController: {
        resolveAgent: async () => agent,
        prompt: async (request) => {
          calls.push(['prompt', request.requestId])
          agent.status = 'running'
          agent.phase.lastTurn += 1
          return { accepted: true }
        },
      },
    }
    const probe = createProbe({ get: (key) => services[key] }, { dshHome: home, settleMs: 200 })
    const outcome = await probe.restoreSession(
      { sessionId, intent: 'unknown', epoch: 1, lastTurn: 3 },
      { plan: { planId: 'p1' } },
    )
    assert.equal(outcome.continued, true, JSON.stringify(outcome))
    assert.equal(calls.length, 1)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('an unknown row whose latest end was an aborted turn is still held, never continued', async () => {
  const rig = turnRig({ lastTurn: 7 })
  rig.fake.services.sessionLog = { readTurnEnds: () => [{ turn: 7, kind: 'aborted' }] }
  rig.fake.calls.length = 0
  const probe = createProbe(rig.fake.registry, { settleMs: 60, watchTurn: rig.watchTurn })
  const outcome = await probe.restoreSession(
    { sessionId: 's1', intent: 'unknown', epoch: 1, lastTurn: 6 },
    { plan: { planId: 'p1' } },
  )
  assert.equal(outcome.status, 'unknown')
  assert.equal(outcome.continued, false)
  assert.equal(rig.fake.calls.some((call) => call[0] === 'prompt'), false)
})

test('the stale crash end is not reported as the admitted continuation ending interrupted', async () => {
  // Second half of the reported failure: after the continuation was actually admitted, the post-submit
  // backfill re-read the same cut end that routed the row in and answered "continuation turn ended as
  // interrupted" with continued:false, leaving the row for the next press to send again.
  const rig = turnRig({ lastTurn: 7 })
  rig.fake.services.sessionLog = { readTurnEnds: () => [{ turn: 7, kind: 'interrupted' }] }
  rig.fake.calls.length = 0
  const probe = createProbe(rig.fake.registry, { settleMs: 80 })
  const outcome = await probe.restoreSession(
    { sessionId: 's1', intent: 'unknown', epoch: 1, lastTurn: 6 },
    { plan: { planId: 'p1' } },
  )
  assert.equal(rig.fake.calls.filter((call) => call[0] === 'prompt').length, 1)
  assert.doesNotMatch(String(outcome.detail), /continuation turn ended/)
  assert.notEqual(outcome.status, 'interrupted')
  assert.equal(outcome.continued, true)
})
