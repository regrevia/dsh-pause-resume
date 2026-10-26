# Changelog

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

* Routes are registered synchronously while `apply` runs. The web server freezes its route table
  when it starts, so registering after `hydrate()` left the button answering 404 on a fresh boot.
  Handlers now wait for hydration instead of the route table waiting for it.
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
