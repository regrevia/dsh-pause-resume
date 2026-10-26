# dsh-pause-resume

One button in the DeepSeek Harness session header. It stops what is running, writes a small plan to
disk, and after a restart the same button puts that work back.

* ⏸ — work is running. Press to stop it.
* ▶ — work is stopped, or a previous process died mid-turn. Press to restore it.
* ⏸ dimmed — nothing to stop and nothing to restore.

The glyph is the only status. There is no counter, no panel and no toast, because a status badge next
to the button would be a second source of truth for the same fact. A red dot is added only when the
last press left something for a person to look at.

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
starts a turn; the button then shows ⏸ again, truthfully.

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

A crash record is deliberately weaker than a press: it proves a turn was open, not whether the person
wanted it continued. So restore mounts those sessions and lists them in the outcome; it does not
type a continuation message on their behalf. Sessions that ended normally never enter the file.

The same process reloading the plugin (hot reload) sees its own id and knows there is nothing to
restore. A `pausing` plan found on disk means the press itself was interrupted: those sessions are
mounted but never continued, and the button carries a dot until a person presses restore.

## Installing

```bash
plugin_manager install_bundle dsh-pause-resume
```

or install the bundle from the Harness plugin manager with the package name. The plugin needs no
configuration and holds no credentials. `allowRemote` exists for a Harness reached from another
machine; local-only is the default.

## Guarantees and limits

* **Exclusive.** The phase lives on the Host and is written before any work starts, so two windows,
  a double press and a tool call cannot overlap. The second caller is told `busy`.
* **Durable before destructive.** No turn is cancelled until the plan is on disk. A failed write means
  nothing was stopped.
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
接回来。正常结束的会话不记录、不恢复；崩溃靠心跳文件识别，但只挂载不代发消息；日程不会被动
（该服务只有删除，没有停用），后台命令只记录不重跑。
