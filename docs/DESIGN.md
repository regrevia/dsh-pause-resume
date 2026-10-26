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
open turn as a boolean on the session row, so one poll every five seconds re-reads the set and writes
the file only when the set changes: no per-turn hooks, nothing to install into the agent loop.

* Clean exit while idle leaves `running.json` empty, so the next boot shows a dimmed ⏸.
* Exit or crash mid-turn leaves entries behind. The next boot shows ▶, with no press needed.
* A session that ended normally never enters the file, which is why the screenshot case cannot be
  restored by mistake.
* The file is heartbeating state, not a promise: if it is missing or unreadable the plugin reports
  nothing to restore instead of inventing work.

Goals need no heartbeat: the goal lives in the session log, so after a session is resumed
`goals.get` answers with the truth.

## A press, step by step

1. Read the work: sessions in memory, goals whose phase is `active`, live jobs.
2. Write `snapshot.json` with `status: "pausing"` — before stopping anything, so a crash during the
   press is visible on the next boot as an unfinished pause rather than a clean one.
3. Stop it: cancel each running turn, pause each active goal, kill each job. A turn gets a short
   grace period so a read-only tool can finish; whatever it was doing when the grace runs out is
   recorded as unknown rather than claimed as done.
4. Rewrite the snapshot with `status: "paused"` and what was actually stopped.

Restore reverses the same file and nothing else:

1. Each session: `agents.resume({ resumeSessionId })`. A session that is already live, deleted, or
   whose recorded goal revision no longer matches is skipped and named in the outcome.
2. Each goal still `active` in the log: `goals.resume({ id: sessionId }, { id, revision })`. The goal driver then
   queues its next round by itself, which is what "continue" means for a goal: no prompt is typed
   into the person's session on their behalf.
3. The snapshot is renamed to `last-restore.json` and deleted. Consuming it is the only way to
   guarantee that a second press restores nothing.

Every item is journalled to `restore.jsonl` before the next one starts. A crash in the middle of a
restore therefore leaves ▶ up, and the next press continues with the remainder instead of redoing
the sessions that are already running.

## Service contracts that cost a day if guessed

| Service | The trap |
| --- | --- |
| `sessionController.list` | answers `{ items }`, not `{ sessions }`. A reader that guesses wrong sees zero work forever and the button stays dimmed |
| `jobs.list` | a caller-less call sees **only unowned** jobs. A session's jobs are visible only to that session, so every attached session has to be asked for its own bucket |
| `goals.get` / `pause` / `resume` | address one live agent, and an agent names itself by session id: `{ id: sessionId }`. A closed session makes `get` throw; that is the ordinary answer, not an error |
| `sessionController.cancel` | throws for a session that is not attached, and refuses a subagent-owned one. Both are per-item unknowns, never a reason to abandon the rest of the press |
| `schedules` | has no disable: a schedule is deleted or left alone, so it is not part of a press |

## What this deliberately does not do

* **No confirmation dialog.** A pause can be pressed again, and a restore that was wrong can be
  stopped with the same button. A confirm step would make the fast path the slow one.
* **No restored private plugin state.** There is a `register()` seam for a plugin that genuinely owns
  durable state, but nothing is auto-restored on someone else's behalf: a plugin's in-process state
  is not something a snapshot can honestly claim.
* **No fake resumption.** A killed job is not restarted, and a session is not re-prompted with
  invented text. Goals continue because the Harness has a mechanism for that; everything else is put
  back to the state a person left it in.
* **No text on screen.** The counts exist in the Host answer, are logged for support, and are never
  rendered: the icon is the message.

## Failure and edge cases

| Case | Behaviour |
| --- | --- |
| Session finished normally (green dot) | never captured, never restored |
| Session interrupted by the person (Esc) | has `turn/end: aborted`, so not open; not restored |
| Two windows press at once | second gets `busy`; one press, one snapshot |
| Double click | second press is refused by the transient phase |
| Crash while `pausing` | next boot reports unfinished pause, offers ▶, restore journals what it does |
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
| `running.json` | sessions with an open turn, for crash residue |
| `restore.jsonl` | append-only journal of restore steps already done |
| `last-restore.json` | the consumed snapshot, kept as a record of what the last restore did |

Every write is temp file, `fsync`, `rename`. A reader never sees half a file and a crash leaves the
previous complete version in place.
