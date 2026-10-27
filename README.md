# dsh-pause-resume

One button in the DeepSeek Harness session header. It stops what is running, writes a small plan to
disk, and after a restart the same button puts that work back.

* ⏸ — work is running. Press to stop it.
* ▶ — work is stopped, or a previous process died mid-turn. Press to restore it.
* ⏸ dimmed — nothing to stop and nothing to restore.

The glyph is the only status. There is no counter, no panel, no badge and no toast, because a second
indicator would be a second source of truth for the same fact. When the last press left something for
a person to look at, the one-sentence tooltip says so and the button still offers the same glyph.

## What it restores

| Work | Pause | Restore |
| --- | --- | --- |
| A session with an unfinished turn | turn cancelled, session recorded | session mounted, then one visible continuation message |
| A goal that was armed | paused with the revision it had | `goals.resume` with that exact revision; the goal driver continues on its own |
| A session that only carried that goal | recorded, nothing stopped | mounted; the resumed goal takes over |
| A running background job | killed and recorded | recorded only: a job is a live process, not replayable |
| A session that ended normally | untouched | untouched, and never recorded in the first place |
| A terminal / finished session | untouched | untouched |
| A schedule | untouched | untouched |

Schedules are not paused: the schedule service has no disable operation, only delete, and deleting a
person's schedule to pause it is not a trade this plugin makes. A schedule that fires while paused
starts a turn, but the button keeps showing ▶ while a pause plan waits: a pending plan owns the main
action, so the only honest next step is to finish the restore. The schedule appears in that restore
summary like any other work started after the press.

## How resume works

A restore is not a claim that work continued. It is three honest steps per item:

1. **Mount.** A stopped session is mounted through the Harness resume path, which preserves its agent
   preset. If it is already mounted, that step is skipped.
2. **Continue, only where the press actually cancelled a turn.** The continuation is one ordinary
   user message sent through `sessionController.prompt`, with a request id derived from the plan and
   the session. The id makes a repeated restore idempotent, and the message is visible in the
   transcript, so the person can see exactly what was resumed.
3. **Re-arm a goal** with the revision it had when paused. The revision is the person's veto: if the
   goal changed while paused, it is not ours to resume and the item is `skipped`.

Every attempt is journaled with the id of the process that made it, but a journal is reporting, not a
promise: the next boot asks the live Harness again instead of trusting an old row. The continuation
request id is derived from the plan and the session, so a retry before a turn starts is deduplicated
by the Host. A failure leaves the plan on disk and the next press retries every item that still needs
work.

A subagent session cannot be mounted by this process: its parent chat owns the routing. That row is
reported once as attention for the parent, not retried as a failure, so it never keeps the plan open.

## Crash, not just a press

A press writes a snapshot. A crash writes nothing, so the plugin keeps a heartbeat instead:
`running.json` holds the sessions whose turn is open right now and the id of the process that wrote
it. The previous process's record is turned into a crash plan in `pending.json` before the heartbeat
file is replaced, so a second or third restart still sees the same work and offers ▶ with no press
needed.

A crash record is weaker than a press: it proves a session existed, not that a turn was open after the
restart. Restore attaches every recorded session and reads the live turn. A row whose turn is still
running is continued; a row that is idle is left idle by the probe, which mounts it to read it and does
not prompt it. A row whose state cannot be read or proven is reported as unknown, and unknown is not
finished: the plan stays on disk, the button keeps offering ▶, and the next press tries again. A
recorded goal is restored whether or not its session's turn is provable, because dropping it was the
path that ended a crashed set with every goal in attention and none resumed. Sessions that ended
normally never enter the file.

The same process reloading the plugin (hot reload) sees its own id and knows there is nothing to
restore. A `pausing` plan found on disk means the press itself was interrupted: those sessions are
left alone, and the button keeps offering the restore until a person presses it.

## Progressive restore (off by default)

Six long sessions restored at once are six upstream model requests at once, and a gateway that is
happy with one slow stream is often unhappy with six. For Direct API users this is usually fine and
the extra waiting is pure cost, so progressive restore is **off by default**: restore follows the
ordinary path with no added spacing, no request pool and no cooldown timer installed at all.

Turn it on when batch restores run into rate limits or timeouts: a shared account or gateway quota,
a self-hosted proxy with limited capacity, or an environment where restoring several sessions at
once is what triggers the failures. Single-session timeouts are not helped by it; those need
investigation of the request and the upstream.

Two layers, because either alone is enough to defeat the other:

* **Dispatch spacing.** Sessions are restored in waves by lineage depth, with a gap of
  `restoreStartGapMs` (3 s) plus up to 0.4 s jitter between starts.
* **A real request pool.** The plugin registers an `llm/stream` middleware and holds one permit per
  adapter request until that stream ends, fails or is cancelled — not when the turn opens, not when
  the first chunk arrives, and not when a tool or subagent wait begins (that request is over).
  Compaction enters the same pool with `purpose: 'compaction'`, and every official retry takes a
  fresh permit. The guard is open only while a restore runs, so ordinary chatting is never queued
  behind it.

The pool starts at `restoreCapacity` (1). Two clean streams in a row raise it by one, up to
`restoreMaxCapacity` (2). Two failures in a row drop it back to one and close the pool for
`restoreCooldownMs` (40 s), so one unwell upstream cannot be hammered by a queue of sessions. An
abandoned stream (the person paused) is neither a success nor a strike: cancelling is cheap.

The switch is read when you press restore; a running batch keeps the setting it started with, so
turning the feature off mid-batch cannot suddenly release the queue. Press pause to stop the
current batch.

Nothing about reliability depends on this switch. Pause and restore of sessions, subagents and
background jobs, pausing again during a restore, plan persistence, crash recovery, continuation
deduplication and the retry entry all still apply with progressive restore off. The restore loop
keeps its own small worker waves either way; only the extra limit on real model requests is
optional.

Pausing while a restore is running is immediate. The press stops dispatching, refuses every request
still waiting for a permit, asks the Harness to stop the work that already started, writes what is
left back to the plan as an outstanding continuation, and returns `paused` with
`interrupted: true`. The next press resumes the same plan; the continuation request id is per cycle,
so a message already admitted is deduplicated instead of sent twice.

`/state` reports the setting and the queue while a plan exists: `{progressive, active, enabled,
capacity, running, queued, dispatched, failed, interrupted, cooldownUntil}` under `restore`. The
button itself stays icon-only.

Configuration (all optional):

| Key | Default | Meaning |
| --- | --- | --- |
| `restoreProgressive` | `false` | opt-in staged restore; off keeps the plain path |
| `restoreCapacity` | `1` | model requests allowed when a restore starts |
| `restoreMaxCapacity` | `2` | ceiling the health gate may raise the limit to |
| `restoreCooldownMs` | `40000` | pause after two consecutive failures across sessions |
| `restoreStartGapMs` | `3000` | spacing between restore starts, plus jitter |

Scope, stated honestly: this governs requests that pass through this Host's model stack. The
Harness's own restore flow and a subagent that reaches a provider outside this Host are outside the
pool, and no plugin can promise a concurrency limit for a company gateway it does not own. The
300 s upstream idle timeout is an upstream decision; progressive restore cannot pretend to fix it,
but it makes the restore produce evidence (one session, one exact request) instead of an avalanche.

## Installing

```bash
plugin_manager install_bundle dsh-pause-resume
```

or install the bundle from the Harness plugin manager with the package name. Every configuration
key is optional (see Progressive restore) and the plugin holds no credentials. `allowRemote` exists for a Harness reached from another
machine; local-only is the default.

## Guarantees and limits

* **Exclusive.** The phase lives on the Host and is written before any work starts, so two windows,
  a double press and a tool call cannot overlap. The second caller is told `busy` — except a pause
  during a restore, which interrupts it on the spot instead of refusing: stopping must never be the
  operation that waits.
* **Durable before destructive.** No turn is cancelled until the plan is on disk. A failed write means
  nothing was stopped.
* **Bounded.** A restore that keeps failing closes after three attempts and reports those rows as
  attention instead of staying paused indefinitely. An attempt that overruns its budget is watched a
  little longer before it is called a failure, and a session this plan already restored stays
  restored even if the Harness revives it and moves its turn on a later boot.
* **Idempotent.** The continuation request id is derived from the plan and the session, so a retry
  cannot post the same message twice; a turn that already moved is not continued again.
* **Honest.** Unreadable state never reports `paused`. A session deleted by hand, a goal changed by
  hand, a session already running: each is skipped and named in the outcome.
* **No hidden takeover.** There is no public API to detach an agent, so the pause guarantee is
  "turns cancelled, goals paused, jobs killed" — not "the process is frozen". A goal continues because
  the Harness has a mechanism for that; a plain session continues through one visible user message.
* **No third-party plugin state.** A plugin's in-process state belongs to that plugin's mount.
* **Local by default.** The routes require a same-origin request and a plugin header. Remote use must
  be opted into and still cannot skip the header.

## Files

All state lives under `$DSH_HOME/pause-resume/`:

| File | Purpose |
| --- | --- |
| `snapshot.json` | the work a press stopped, `pausing` or `paused` |
| `pending.json` | a crash plan, kept until a restore finishes |
| `journal/<planId>.jsonl` | restore attempts, tagged with the boot that made them |
| `restores/<planId>.json` | the archived plan, kept as a record of the last restore |
| `last-restore.json` | summary of the last restore |
| `running.json` | sessions with an open turn, for crash residue |

Every write is a unique temp file, `fsync`, `rename`, then a directory `fsync`. State is never inside
the package.

## Development

```bash
npm test
npm run audit
```

`lib/engine.js` performs no I/O, `lib/snapshot.js` persists, `lib/probe.js` holds every Harness service
contract (agent identity, goal revision, per-owner jobs, continuation prompts), and `index.js` only
wires them to the web routes. All of them are testable without a Harness: `test/apply.test.mjs` mounts
the plugin against a fake registry.

MIT.

---

一行说明：会话头一个按钮，⏸ 停掉正在跑的回合、目标与后台任务；重启后同一个按钮变 ▶，把上次的工作
接回来。正常结束的会话不记录、不恢复；崩溃会接回记录里的会话与其目标，暂时无法确认状态的会话保持计划未完成，按钮继续给 ▶；日程不会被动
（该服务只有删除，没有停用），后台命令只记录不重跑。
