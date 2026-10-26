# Design

One header button. Pressing it stops the work a person would otherwise have to stop by hand; pressing
it again after a restart puts that same work back. The button's shape is the only status, because a
status badge, a counter or a toast would each need a second source of truth next to the one the
button already is.

## What a press claims

A press may only claim what the Harness itself promised to keep. That boundary is the whole design:

| Kept by the Harness across a restart | Restored | How |
| --- | --- | --- |
| A session with an unfinished turn | yes | resume the session, then continue it |
| A goal that was armed | yes | `goals.resume` with the revision it was paused at |
| A running background job | recorded only | a job is a live process; it cannot be replayed from a view |
| A terminal / shell | no | not the plugin's process to end |
| A schedule | no | the schedule service has no disable, only delete |
| Anything a plugin keeps in its own memory | no | it belongs to that plugin's mount, not to a snapshot |

A session with no unfinished turn is finished. It is not restored, and the green dot in the session
list is not evidence either way: a session interrupted mid-turn and a session that ended normally can
both look settled in the list. The only durable question is "does this session's log end with a turn
that never ended", and that question is answered below without reading logs on every boot.

## One phase, written before the work

```
idle ──press──▶ pausing ──stopped──▶ paused
 │                                    │
 │◀──────────resume done──────────────┘
 └──press with a snapshot on disk────▶ resuming ──▶ idle
```

* `phase` lives in the Host, not the client, and not in memory alone: both transient phases are
  written to disk before any work starts.
* `pause()` and `resume()` set the transient phase **synchronously**, before their first `await`.
  Two windows, a double press, a tool call and a UI retry therefore cannot overlap, in the same tick
  they were dispatched.
* A second caller during a press is told `busy`. It never joins the work, so it can never restore
  the same session twice.
* On mount the phase is derived from disk. A reloaded plugin that trusted a memory flag would show
  ⏸ over a paused Harness and let a person believe the work was still running.

The client renders `action`, and only `action`:

| `action` | Glyph | Meaning |
| --- | --- | --- |
| `pause` | ⏸ solid | there is work to stop |
| `resume` | ▶ solid | a snapshot or crash residue is waiting |
| `busy` | ⏸ with an in-place spinner | a press is running |
| `none` | ⏸ dimmed, inert | nothing to stop, nothing to restore |

A failure adds a red dot to ▶ and leaves it pressable. There is no fifth shape: the dot is the
smallest thing that can be added without moving the layout.

## Crash residue without log archaeology

A snapshot only exists if a person pressed the button. A crash has no press, so the plugin keeps a
heartbeat instead: `running.json` holds the sessions whose turn is open right now. The Host exposes an
open turn as the live agent's status, so one poll every five seconds re-reads the set and writes the
file only when the set changes: no per-turn hooks, nothing to install into the agent loop.

* Clean exit while idle leaves `running.json` empty, so the next boot shows a dimmed ⏸.
* Exit or crash mid-turn leaves entries behind. The next boot shows ▶, with no press needed.
* A session that ended normally never enters the file, which is why the screenshot case cannot be
  restored by mistake.
* The file is heartbeating state, not a promise: if it is missing or unreadable the plugin reports
  nothing to restore instead of inventing work.
* A crash record only proves a turn was open, not that the person wanted it continued. Restore mounts
  those sessions and lists them in the outcome; it never posts a continuation message that no one
  asked for.

Goals need no heartbeat: the goal lives in the session log, so after a session is mounted
`goals.get` answers with the truth.

## A press, step by step

1. Read the work: sessions in memory, goals whose phase is `active`, live jobs.
2. Write `snapshot.json` with `status: "pausing"` — before stopping anything, so a crash during the
   press is visible on the next boot as an unfinished pause rather than a clean one.
3. Stop it in the order goals → turns → jobs, so a goal driver cannot start a new round while its
   session is being cancelled. A turn gets a short grace period; whatever is still running when the
   deadline passes is recorded as attention rather than claimed as stopped.
4. Rewrite the snapshot with `status: "paused"` and only what was actually stopped. A goal enters the
   file with the revision it has *after* the pause, which is the revision a later resume must present.

The plan records only work that was really stopped: sessions whose turn was open, plus sessions that
carry an armed goal. A session that ended normally is not in the file at all, so no later step can
resurrect it by accident.

Restore reverses the same file and nothing else:

1. Each session is mounted through `sessionController.resolveAgent`, the same preset-preserving path
   the Harness itself uses. An already-live session is skipped; a deleted one is reported.
2. Only a session whose recorded turn was cancelled gets a continuation: one ordinary user message
   through `sessionController.prompt`, with a request id derived from the plan and the session. The
   message is visible in the transcript, and the deterministic id keeps a retry idempotent. A session
   that was running again by hand (`lastTurn` advanced) is skipped, so the restore never adds a
   second turn.
3. Each goal still active in the log is re-armed with `goals.resume(realAgent, { id, revision })`. The
   goal driver then queues its next round by itself. A changed revision is `skipped`: the person's
   edit outranks the snapshot.
4. The plan is archived to `restores/<planId>.json`, summarised in `last-restore.json`, and only then
   removed from `snapshot.json`. Consuming it is the only way to guarantee a second press restores
   nothing.

Every item is journalled to `journal/<planId>.jsonl` before the next one starts. A crash in the middle
of a restore therefore leaves ▶ up, and the next press continues with the remainder instead of redoing
sessions that are already mounted. A failed item is not journalled and stays retryable.

## Service contracts that cost a day if guessed

| Service | The trap |
| --- | --- |
| `agents.list` / `agents.get` | the cheap truth for "who is attached": a couple of dozen handles in memory. Walking every session on disk takes seconds and is never needed for a status answer |
| Goal services | `goals.get`, `pause` and `resume` require the **real agent object** (`ctx.agents.get(sessionId)`), not a `{ id }` placeholder: the service asserts identity and answers `GOAL_AGENT_NOT_LIVE` otherwise |
| `goals.resume(agent, ref)` | needs the exact `{ id, revision }`; a stale revision throws `GOAL_STALE_REVISION` and every transition bumps the revision by one |
| `jobs.list` | a caller-less call sees **only unowned** jobs. A session's jobs are visible only to that session, so every attached session has to be asked for its own bucket |
| `sessionController.cancel` | cancels the turn but leaves the agent registered: `status` becomes `idle` after the abort settles. There is no public detach, which is why the pause guarantee is "turns cancelled", not "process frozen" |
| `sessionController.prompt` | requires an `AbortSignal`; `{ sessionId, requestId, content, mode }` with source `{ kind: 'user', rpcId }`. It is the only way to continue a plain session without reaching into asar-private imports |
| `schedules` | has no disable: a schedule is deleted or left alone, so it is not part of a press |

## What this deliberately does not do

* **No confirmation dialog.** A pause can be pressed again, and a restore that was wrong can be
  stopped with the same button. A confirm step would make the fast path the slow one.
* **No restored private plugin state.** There is a `register()` seam for a plugin that genuinely owns
  durable state, but nothing is auto-restored on someone else's behalf: a plugin's in-process state
  is not something a snapshot can honestly claim.
* **No fake resumption.** A killed job is not restarted. A session is continued only if the press
  cancelled its turn, and then through one visible, deterministic user message — never hidden text.
  Goals continue because the Harness has a mechanism for that.
* **No auto-continue after a crash.** Crash residue is mounted and listed in the outcome, because a
  crashed process never recorded whether the person wanted that turn continued.
* **No text on screen.** The counts exist in the Host answer, are logged for support, and are never
  rendered: the icon is the message.

## Failure and edge cases

| Case | Behaviour |
| --- | --- |
| Session finished normally (green dot) | never captured, never restored |
| Session interrupted by the person (Esc) | has `turn/end: aborted`, so not open; not restored |
| Two windows press at once | second gets `busy`; one press, one snapshot |
| Double click | second press is refused by the transient phase |
| Crash while `pausing` | next boot reports unfinished pause and offers ▶; sessions are mounted, never continued |
| Crash while `resuming` | journal continues with the remainder |
| Snapshot names a deleted session | skipped, named in the outcome |
| Goal revision changed by hand | skipped rather than resurrected |
| Session already running when restored | skipped |
| Disk unwritable | never claim `paused`: stay in the previous phase, show the dot |
| Plugin reloaded (HMR) | phase re-derived from disk |
| Headless Harness (no web server) | routes absent, the same operations stay available to an agent call |
| Large restore | serial with a short gap, so a restart does not become a burst |

## Files

All state lives under `$DSH_HOME/pause-resume/`:

| File | Purpose |
| --- | --- |
| `snapshot.json` | the work a press stopped, `pausing` or `paused` |
| `journal/<planId>.jsonl` | restore items already finished |
| `restores/<planId>.json` | the archived plan, kept as a record of the last restore |
| `last-restore.json` | summary of the last restore |
| `running.json` | sessions with an open turn, for crash residue |

Every write is a unique temp file, `fsync`, `rename`, then a directory `fsync`. A reader never sees
half a file and a crash leaves the previous complete version in place.
