# Changelog

## 0.4.5

A restore now leaves a durable record before every side effect, so a restart can finish it.

* Before `goals.resume`, the plan records `pendingRestore` and writes it to disk. If the process dies
  after the goal was armed but before the checkpoint was saved, the next boot sees the active,
  disarmed goal and the intent that proves it is ours to re-arm. A goal is no longer reported as
  `skipped` with an empty attention list after such a restart.
* A goal whose state cannot be read is a retryable failure (`goal unreadable: …`) instead of being
  treated as absent and consumed. Only a readable paused goal is resumed, and an unreadable goal is
  never counted as work the pause can stop.
* A crash plan on boot sets `phase` to `idle` and offers `resume`; it no longer claims the page is
  paused. The dot still names the crash work through attention.
* A pause plan that ended up in the crash slot can complete its restore, clear the slot and release
  the heartbeat. It no longer leaves the button in `resuming`/`busy`.
* Restore attention survives the consumed plan and is shown with a focused item id even when no work
  is live. Killed jobs stay excluded from the dot.
* A new pause bumps the continuation epoch only for the sessions it captured; rows owned by another
  plan keep their request id.
* A reload during a cold mount stops the old probe before it reports or prompts, so stale side
  effects from a replaced instance cannot reach a session.
* A full restore journals each item only after its outcome, and the plan is consumed only when every
  item settled.

## 0.4.4

Restores are now safe to hand over between instances and across an upgrade.

* An interrupted pause resets the whole restore policy (`intent: "mount"`, `epoch: 0`), so it is
  mounted and never sends a continuation.
* When a merged crash plan could not be written to disk, resume restores that in-memory plan, which
  holds both the old and the newly found sessions. The older `pending.json` no longer wins and hides
  half the work.
* `heartbeat.release()` restores a full lifecycle: the periodic sample is re-armed, `stopped` is
  cleared, and state events can persist again. Previously the file stayed frozen after a repaired
  write failure.
* A pre-epoch plan keeps its original continuation request id (`…:continue:<session>`), so upgrading
  cannot queue a second copy of a message the old version already admitted.
* A restore that loses ownership (plugin reload) stops before publishing, consuming or clearing. It
  also compares the plan's actual work, not only its id, so additions from a newer press survive.
* A goal whose checkpoint cannot be written keeps the plan on disk with the failure named, instead of
  silently skipping the goal on the next boot.
* The button hint combines the error with the focused item for partial pause/restore.

## 0.4.3

- The dot now means one thing: something is waiting on you (a paused plan with commands that will not restart, or a stop/restore that failed). A clean idle page has no dot, and killed jobs live in the restore record instead of becoming a permanent red light.
- Restore mounts sessions in bounded parallel batches, so wall time is the slowest batch instead of the sum of every session.
- Duplicate attention rows for the same item are collapsed.

## 0.4.1

A stop that could not finish no longer traps the button, and the dot stops lying after a resume.

* An unfinished stop now always offers the resume that releases it. The button used to prefer
  `pause` whenever live work remained, so a partial stop re-ran the same stop on the same
  uncancellable turn: the icon never changed, the attention dot stayed, and pressing it did
  nothing a person could see.
* Work that starts while a plan waits no longer flips the button back to pause. The plan owns the
  action until it is consumed.
## 0.4.0

The crash path is now a first-class restore path, and a dead button after a restart is fixed.

* Routes are registered synchronously while `apply` runs. Registration itself is not the problem —
  the server keeps a live route table — but registering after hydration meant the button could be
  pressed before the table had an entry. Handlers now wait for hydration instead.
* A crash plan is written to `pending.json` before the heartbeat is replaced. If that write fails,
  the heartbeat is held and the previous `running.json` is left untouched, so the next boot still
  sees the work.
* Crash rows record `intent: "mount"` and are mounted only; they can never turn into a continuation
  by accident. A pause row records `intent: "continue"`.
* A subagent session that cannot be mounted directly is reported once as attention for its parent,
  not retried forever as a failure that keeps the plan open.
* Partial pauses and partial restores name the first item that needs a person in `focus`, so the
  button's dot has an explanation without adding text to the button.
* A hot reload bumps a shared epoch; an old instance's in-flight press can no longer overwrite the
  plan written by the new instance.
* A continuation request id gets a new epoch after a restore attempt, so pausing again after a
  partial restore is not silently deduplicated by the Host.
* Directed regression tests for the route-registration order, crash-plan durability, subagent rows
  and stale-instance writes.

## 0.3.0

* Crash residue is turned into a plan and offered as a restore, with no press needed.
* Version 3 plans distinguish mount-only crash rows from continuation rows.
* Restores re-check live state instead of trusting the journal.

## 0.2.0

* One header button: pause stops turns, goals and jobs; resume restores them after a restart.
* Durable snapshots, per-item outcomes, journaled restore attempts.

## 0.1.0

* First release.
