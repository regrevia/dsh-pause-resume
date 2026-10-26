# dsh-pause-resume

One button in the DeepSeek Harness session header. It stops everything that is running, and after a
restart the same button puts that work back.

* ⏸ — work is running. Press to stop it.
* ▶ — work is stopped, or a previous run ended mid-turn. Press to restore it.
* ⏸ dimmed — nothing to stop and nothing to restore.

The glyph is the only status. There is no counter, no panel and no toast, because a status badge next
to the button would be a second source of truth for the same fact.

## What it restores

| Work | Pause | Restore |
| --- | --- | --- |
| A session with an unfinished turn | turn cancelled, session recorded | session resumed |
| An armed goal | paused, with its revision | resumed with the same revision; the goal driver continues on its own |
| A running background job | killed and recorded | recorded only: a job is a live process, not replayable |
| A terminal | untouched | untouched — that process is not the plugin's to end |
| An open tab / finished session | untouched | untouched |

A session that ended normally is never restored: the decision is made from the turn the session's log
ends with, not from how the session list happens to colour it.

## Crash, not just a press

A press writes a snapshot. A crash writes nothing, so the plugin keeps a heartbeat instead:
`running.json` holds the sessions whose turn is open right now and the id of the process that wrote
it. A new process finds the previous one's heartbeat and offers ▶ with no press needed. The same
process reloading the plugin (hot reload) sees its own id and knows there is nothing to restore.

## Installing

```bash
plugin_manager install_bundle dsh-pause-resume
```

or install the bundle from the Harness plugin manager with the package name. The plugin needs no
configuration and holds no credentials.

## Guarantees and limits

* **Exclusive.** The phase lives on the Host and is written before any work starts, so two windows,
  a double press and a tool call cannot overlap. The second caller is told `busy`.
* **Idempotent.** A restore journals every item it finished. A crash in the middle of a restore
  continues with the remainder instead of restoring the same session twice.
* **Honest.** Disk that cannot be written never reports `paused`. A session deleted by hand, a goal
  changed by hand, a session already running: each is skipped and named in the outcome.
* **Schedules are not paused.** The schedule service has no disable operation, only delete, and
  deleting a person's schedule to pause it is not a trade this plugin makes. A schedule that fires
  while paused starts a turn; the button then shows ⏸ again, truthfully.
* **No third-party plugin state.** A plugin's in-process state belongs to that plugin's mount. There
  is a seam for a plugin that owns durable state, but nothing is restored on someone else's behalf.
* **No synthetic prompts.** Nothing is typed into a person's session on their behalf. A goal
  continues because the Harness has a mechanism for that; a plain session is put back at the turn it
  was interrupted in.

## Files

All state lives under `$DSH_HOME/pause-resume/`:

| File | Purpose |
| --- | --- |
| `snapshot.json` | the work a press stopped |
| `running.json` | sessions with an open turn, for crash residue |
| `restore.jsonl` | restore steps already done |
| `last-restore.json` | record of the last restore |

Every write is temp file + `fsync` + `rename`. State is never inside the package.

## Development

```bash
node --test --test-timeout=15000 'test/*.test.mjs'
```

`lib/engine.js` performs no I/O, `lib/snapshot.js` persists, `lib/probe.js` holds every Harness service
contract (listing shape, goal addressing, per-owner jobs), and `index.js` only wires them to the web
routes. All four are testable without a Harness: `test/apply.test.mjs` mounts the plugin against a fake
registry and fails if a service call is stale, which is how the `{ items }` listing bug was caught.

MIT.

---

一行说明：会话头一个按钮，⏸ 停掉正在跑的回合、目标与后台任务；重启后同一个按钮变 ▶，把上次的工作
接回来。崩溃也能识别：靠心跳文件，不靠人按过按钮。日程不会被动（该服务只有删除，没有停用），
后台命令只记录不重跑。
