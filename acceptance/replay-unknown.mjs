#!/usr/bin/env node
// Diagnostic, not a gate: replays one real pause-resume plan's `unknown` rows through the shipped
// restore path with a controller that only records the continuation. Nothing is executed, nothing
// is written; the output says how many prompts the press would send and what each row would report.
// Usage: node acceptance/replay-unknown.mjs [--home <DSH_HOME>] [--plan <pending.json>]
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createProbe } from '../lib/probe.js'

const args = process.argv.slice(2)
const arg = (name, fallback) => {
  const at = args.indexOf(name)
  return at === -1 ? fallback : args[at + 1]
}
const home = arg('--home', process.env.DSH_HOME ?? join(homedir(), '.dsh'))
const planPath = arg('--plan', join(home, 'pause-resume', 'pending.json'))
const plan = JSON.parse(readFileSync(planPath, 'utf8'))
const rows = (Array.isArray(plan.sessions) ? plan.sessions : []).filter((row) => row.intent === 'unknown' && !row.parent)
const prompts = []
const agents = new Map()
const services = {
  agents: {
    get: (id) => agents.get(id),
    list: () => [...agents.values()],
    resume: async ({ resumeSessionId }) => {
      const agent = { id: resumeSessionId, status: 'idle', phase: { lastTurn: 0 }, session: { id: resumeSessionId }, mounted: true }
      agents.set(resumeSessionId, agent)
      return { agent }
    },
  },
  sessionController: {
    prompt: async (request) => {
      prompts.push(request.sessionId)
      const agent = agents.get(request.sessionId)
      if (agent !== undefined) {
        agent.status = 'running'
        agent.phase.lastTurn += 1
      }
      return { accepted: true }
    },
  },
}
const probe = createProbe({ get: (key) => services[key] }, { settleMs: Number(arg('--settle', '120')) })
const outcomes = []
for (const row of rows) outcomes.push({ sessionId: row.sessionId, lastTurn: row.lastTurn ?? null, outcome: await probe.restoreSession(row, { plan }) })
const byStatus = {}
for (const row of outcomes) byStatus[row.outcome.status] = (byStatus[row.outcome.status] ?? 0) + 1
console.log(JSON.stringify({ plan: plan.planId ?? null, planStatus: plan.status ?? null, rows: rows.length, prompts: prompts.length, byStatus, outcomes }, null, 2))
