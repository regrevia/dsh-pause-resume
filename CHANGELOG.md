## 0.6.3

- The largest remaining `unverified` row is now a real run instead of a stand-in: `acceptance/host-live.mjs` boots the shipped plugin on a throwaway `DSH_HOME`, holds one real turn open with a local OpenAI-compatible mock model, pauses it over the plugin's HTTP surface, kills the Host with `SIGKILL`, restarts on the same home, resumes once and asserts that the mock received exactly one continuation carrying the original turn text, that the plan row lands at `epoch:1, lastTurn:2, continuedTurn:2`, and that no second continuation is sent. The 14 assertions run against real processes, real files and real HTTP; the model is the only stand-in, and it is labelled as such in the evidence.
- `npm run smoke:live` reruns that gate and writes `docs/evidence/host-live.json`; the mock server (`acceptance/mock-llm.mjs`) and the spike plugin that produces the turn are kept out of the shipped package and are marked `// spike`.
- The acceptance record now says `crash-turn-backfill` is verified on a real Host, and names the three checks that stay unverified (maintenance compaction cancellability, a stopping job visible to a person, job-only owner handoff) with the reason each needs a service this profile cannot provide.

## 0.6.2

- Crash residue is continued instead of being taken for live work: a session whose disk projection still showed an open turn after the process died used to be reported as "already running", so the whole crashed set was never resumed. An open projection now proves nothing about a running turn; only a live `running` agent does, and the durable `turn/end` decides what the dead turn owes. A plan that cannot finish every row reports `partial` with a named `attention` list instead of claiming it is `paused`, and the button keeps offering resume.
- A plan that only carries a stopped background job hands its owner session back once, with a continuation that names the job, then stays `partial` so the person can see what was handed over; pressing resume again reports it as already continued instead of replaying the command. Jobs that were `stopping`, `stop-failed`, or unrecorded are no longer described to the continued turn as stopped.
- The Host smoke gate now derives its verdict and exit code from the steps it actually ran, records the four live-work checks as `unverified` with a reason instead of silently passing, and keeps an injected self-test failure out of the real evidence file. The acceptance rerun adds controllable-service coverage for crash residue, a pause that interrupts a restore, and the job-only handoff.

## 0.6.1

- A real Host, not just stand-ins: `acceptance/host-smoke.mjs` builds a throwaway profile on a fresh `DSH_HOME`, links the package, mounts it, boots the shipped web app on an OS-picked port (never the live one) and asserts 16 behaviours over real HTTP — `GET`/`HEAD /state`, reads without the button header, a forged `Origin` and a forged `Host` both refused with 403, an idle pause twice in a row honestly reporting `idle` without writing a plan, a cold restart hydrating `idle` with no restore, and a plan-less resume reporting `empty`. Evidence is written to `docs/evidence/host-smoke.json`; `npm run smoke:host` reruns it.
- The job-lifecycle listening design is reviewed in `docs/design/job-lifecycle.md` and implemented nowhere: it records why a job is never restarted, which durable session facts would name a crash residue, and what stays `unknown` when no persistence backend is mounted. Nothing in this version changes runtime behaviour.
- The acceptance record names what the smoke does not cover: a live turn paused on a real Host (no model credential in this environment), job restart end-to-end, crash job residue, parent-chain depth, and the progressive restore's capacity gate. The versions above are still shipped with those limits.

## 0.6.0

- The plan records what a job stop actually achieved (`stopped`, `stopping`, `stop-failed`, `unknown`) beside each job row, including when a pause interrupts a restore, so "we asked it to stop" is not mistaken for "it stopped". A job still shown as running keeps the pause partial and needs a person.
- A child's parent route is written into the heartbeat residue and preferred over a runtime that has already forgotten it, so a crash no longer turns a child into an unmountable root; residue read back without a route still restores. Missing parents are synthesized once as mount-only rows, and a cyclic parent map restores without hanging.
- The progressive restore stays off unless the setting is explicitly enabled: an install that never opted in reports the plain path, and its restore never touches the capacity gate. That gating is now covered by tests instead of only by the default value.

- Old plans read the way they were written: a 0.2.x plan gets its intent from the old `running` flag exactly once (and never for a row that declared none), and the metadata a restore depends on (`epoch`, `continuedTurn`, `admittedRequest`, `admittedEpoch`, `pendingRestore`, `armedRevision`, `retry`) survives a real write/read/rewrite unchanged. A 0.1.x plan names the same journal file on every read, so a retry after crash cannot become a second restore of the same row. Merging a newer crash residue into a pause plan adds only sessions and goals the plan does not describe; an existing row keeps its cycle, admission and retry count, and a repeated boot writes nothing.
- A restore intent is read back exactly as it was declared: `unknown` and `skip` survive every read, a declared intent outranks the old `running` flag, and a cold restore no longer mounts a session whose plan said it had nothing to prove.
- Whether a continuation finished is decided from the turn boundary (`turn/start`, `turn/end`, the open turn start) instead of the phase counter, and the admitted request id is written to its row before the turn is waited on. A turn that already ended is skipped, an open one is reported restored, and a message admitted just before a restart is waited for instead of being sent a second time.
- Sessions discovered mid-pause are written into the plan before they are stopped. A plan that cannot be written leaves those sessions running and says so, instead of cancelling work it cannot name.
- A pause during a restore starts a new cycle for exactly the rows whose turn was still open when they were stopped: those owe another continuation under a higher epoch, while a row that was already restored and idle is only mounted again and a row whose admission has not begun keeps its pending request and its epoch. A restore result that lands after the pause cannot write into the plan the pause rebuilt.

## 0.5.12

- The page that started a restore can now stop it: while the Host reports `pause` (a restore is running), the glyph is the pause button again and pressing it aborts this tab's own open request and interrupts the restore, leaving the plan retryable. A pause press in flight is still never interrupted by pressing pause again, and a resume press still spins until the Host stops calling it resuming.
- The button's press rules are covered by tests that load the real `client.js` with a stubbed React, so "the same page cannot stop its own restore" fails a test instead of shipping again.
- A goal-only crash residue is now proven end-to-end through the real plan reader: no session row is invented, the goal is armed alone, and the restore reports no failure.

## 0.5.11

- The continuation message now names the background jobs this pause stopped and asks for them to be restarted, so a continued turn puts that work back itself. A job cannot be replayed by the host: a job is a live process, and starting one needs the closure that produced it.

## 0.5.10

- When a crash plan is re-derived, a row the current residue no longer names keeps its mount-only form and its attention line instead of disappearing from the plan.

## 0.5.9

- A crash plan written by a build that could not read live turns (every row mount-only) is re-derived at the next boot from the residue that is readable now. The press then continues the open turns instead of only attaching them; a pause plan is never rewritten.
- Crash-plan upgrades keep per-row retry counts and the goal revisions the old plan recorded.

## 0.5.8

- A cancelled restore now also stops before arming a goal, not only before prompting a session: pressing pause during a restore leaves the goal unarmed and the plan retryable.
- README describes the play button by what it does, not by a guess about the last process.

## 0.5.8

A crashed set is restored or kept, never declared restored with nothing started. This fixes the report
that the icon flipped to play but no session came back, and the plan was already gone so pressing again
did nothing. Versions 0.5.4 and 0.5.5 on npm were built from an intermediate state that still skipped
crashed rows; they are deprecated, and this release is the fixed build.

* Crash rows are no longer skipped before the probe sees them. Every recorded session is attached and
  read; the probe decides continue, idle or unknown from the live turn, instead of the engine deciding
  from a saved field that the old writer never filled.
* A goal recorded in a crash plan is restored. The gate that reported every crashed goal as attention
  whenever its session's predecessor turn was unprovable is gone; that gate turned a full crashed set
  into 6/6 attention with zero `goals.resume` calls.
* `unknown` is a non-terminal outcome: it is not a failure, it is not written as a finished row, and a
  restore that ends with unproven rows keeps the plan and returns `partial`. Consuming the plan there is
  what made one press erase the work it had just failed to start.
* Running out of attempts no longer closes the plan as attention. Failed rows stay outstanding, the
  plan stays on disk, and every later press offers the same restore.
* Journal rows carry the epoch they belong to and the continued turn, so a row from an earlier boot is
  re-checked against the live continuation instead of being trusted by name alone.
* A restore that is interrupted aborts its provider calls and child prompts through one signal.
* Missing parents are added as mount rows, so a child whose parent was not recorded can still restore.
* The button keeps polling while a restore is in flight, and pressing pause during one now reaches the
  Host and interrupts it instead of being ignored until the restore answers.
* Tests: crash sessions and their goals are attached and re-armed; unproven rows keep the plan open;
  a plan that never comes back is never consumed; the heartbeat crash record is read by the real plan
  reader.

## 0.5.3

A resume no longer starts work that was not working when the process stopped, the button turns into a
pause as soon as a restore begins, and a child or a stubborn turn is no longer dropped mid-restore.

* A crash row is evidence the session existed, not evidence a turn was open after the restart. Rows
  whose saved turn number does not match the live one are now reported as skipped instead of being
  mounted, because mounting can fire queued prompts and open a turn nobody asked for. Their goals are
  reported as attention for the same reason: an unproven owner is not re-armed.
* The glyph follows the work again during a restore: while `resuming`, the button shows the pause so
  the press can stop the restore. Before, the unfinished plan kept it on play, so sessions were
  visibly running while the icon still offered to start them. An unfinished plan still shows play
  outside a restore, because pausing on top of one would capture over rows that are not back yet.
* A journal row written by an earlier boot is checked again under a new continuation cycle instead of
  being trusted as done. A `restored` row only says that boot finished; it does not say a turn is
  running now. This is why a second crash left sessions that had been reported restored sitting idle.
* A subagent child whose parent is not live yet is retryable (`failed`) instead of terminal
  (`attention`), so the plan keeps it and the next pass delivers it. The wait for the parent is a
  real poll rather than a single look.
* The child delivery passes an abort signal to `subagents.prompt`; without it every child row threw
  `Cannot read properties of undefined (reading 'aborted')` and was reported as a failure.
* A turn that ignores the first cancel is retried inside the grace window, and the reported cancel
  list has one entry per session. Four sessions were being reported as "still running" after a
  single cancel each.
* Every restore outcome lands on a final glyph: attention and skipped rows close the plan, retryable
  failures keep it, and a restore interrupted by the button returns to a pressable pause.
* Tests: nothing that was only present at a crash is started or re-armed; the glyph is pause while a
  restore is in flight; an earlier boot's journal entry is checked again with a fresh cycle; a child
  waits for a late parent and delivers with a signal; a turn that shrugs off one cancel is stopped.

## 0.5.2

Restore no longer mistakes its own timing for a failure, and a restore that cannot finish now ends
instead of pinning the button forever. Both were visible in a real paused set of sixteen sessions:
ten of sixteen were reported as "resume timed out" while their turns were in fact continuing, and the
plan stayed paused for hours because two rows kept failing on every boot.

* A restore attempt that overruns its budget is observed a little longer before it is called a
  failure, and a late success counts as success. The budget also grows with the size of the paused
  set, so a cold attach of many sessions is not judged by a single-session deadline. Only a real
  error from the Harness is reported as a failure.
* A session this plan already restored stays restored. A restarted Harness can revive a session and
  advance its turn by itself; probing it again used to relabel finished work as `attention`, which is
  why a complete restore could never be recognised as complete. The earlier result is kept and
  journaled for the current boot.
* Goals are still checked on every attempt. A goal row can carry an intent that has not been armed
  yet, and skipping it would silently drop that restore.
* A retried session attempt sends a new request id, so the official prompt deduplication cannot
  accept the message and leave the session asleep. The retry count is persisted with the plan.
* A plan whose rows keep failing now closes after three attempts: those rows become `attention`,
  which is terminal. The plan is archived, the button returns to idle and the details stay in
  `/state`, so a permanently broken session cannot trap the plugin in paused.
* `cleanup()` aborts queued restore permits and the plugin exports its gate, so a reload cannot leave
  waiters behind on an instance that no longer exists.
* Tests: a session restored in an earlier boot is not downgraded by a later one; a cold attach that
  settles after its budget is reconciled as restored; a retried attempt sends a distinct request id;
  a plan that never comes back closes as attention with nothing outstanding.

## 0.5.1

Progressive restore is now opt-in, off by default. For most people the ordinary restore path is
already healthy, and staging it only adds waiting; the extra capacity control belongs to the
environments that need it.

* New `restoreProgressive` setting (default `false`). When off, the plugin installs no `llm/stream`
  middleware, no request queue and no cooldown timer, applies no start spacing, and restores exactly
  as before. When on, the 0.5.0 behaviour applies unchanged.
* The switch is read at the moment restore starts and the batch keeps that setting; flipping it
  mid-restore does not release queued requests. Use pause to stop the current batch.
* Everything else is unaffected by the switch: pause and restore of sessions, subagents and jobs,
  pausing during a restore, plan persistence, crash recovery, continuation deduplication and the
  retry entry.
* `restore` in `/state` now reports `progressive` and `active` alongside the pool counters.
* Tests: the plain path never touches the gate and applies no spacing; a progressive batch reports
  itself as active and guards/releases exactly once.

## 0.5.0

Restoring six long sessions at once also started six upstream model streams at once. The restore
loop could not prevent that on its own: a session counts as started as soon as its turn opens, long
before the provider answers. Restore is now progressive by default, and pausing during a restore is
immediate instead of refused.

* New `lib/gate.js`: one permit per real adapter request, held until that stream ends, fails or is
  cancelled. The plugin installs an `llm/stream` middleware only while a restore runs, so ordinary
  chatting never queues behind it. Compaction takes a permit from the same pool, and each official
  retry takes a fresh one.
* The pool starts at one request. Two clean streams raise it to two; two failures in a row drop it
  back to one and close it for a cooldown, so a queue of sessions cannot hammer an unwell upstream.
  An abandoned stream counts as neither success nor strike.
* Restore starts are spaced by three seconds plus jitter, so a multi-session restore is a sequence
  rather than a burst even before the first request is made.
* Pressing pause while a restore is running interrupts it: dispatch stops, queued permits are
  refused, the work that already started is stopped, un-restored rows stay in the plan as
  outstanding continuations, and the answer is `paused` with `interrupted: true`. Late callbacks
  from the interrupted round can no longer dispatch or consume the plan.
* A session discovered while the probe is already stopping is persisted before it is cancelled, so
  its continuation is not lost with the process.
* `/state` carries the pool counters under `restore`; the button stays icon-only.
* A job already `stopping` is no longer listed as work to pause: the press did not start that stop
  and must not wait on it.
* New coverage: permit accounting, health ramp, neutral cancellation, cooldown, interruptible
  restore keeping its plan, no dispatch after the interrupt, and the guard being released on every
  path.

## 0.4.15

Two ways the crash reader could invent work that was not there, found while tracing the record a
real restart leaves behind.

* A residue row can name an empty session id (a hand-built record, a file from a different writer).
  The crash plan used to keep it as a mount row, so the next press tried to attach a session with
  no name and the restore could never finish. Empty ids are now dropped, the same rule the goal
  rows already used.
* The same session id twice became two mount rows and inflated the crash count. The heartbeat
  dedupes before writing, so this only arrived from a foreign record; the reader now dedupes too
  instead of trusting its caller.
* New coverage: a real version 3 heartbeat file written by one boot is read by the next, turned
  into a plan by the real reader, and resumed through the real store - the turn is mounted, the
  armed goal is restored by its recorded revision, and no extra read is made. The writer, the
  reader and the resume loop are now tested against each other instead of against a stub.

## 0.4.14

A pause symbol shown after an unclean exit promised work that the crash record did not keep.
`running.json` stored session ids only, so a goal armed between rounds was invisible to the next
process; the crash plan then mounted what it could, reported a clean restore, and left the goal
paused. The page showed a pause glyph over an idle Host, and the press read as "cannot pause".

* `running.json` is version 3 and records armed goals next to the open turns:
  `{sessionId, goalId, revision}` per row, deduplicated and sorted.
* A crash plan carries those rows with `armedRevision`, the proof of ownership the restore needs.
  `armedRevision` is read back from the file, never inferred, and a row whose revision is not a
  safe integer or whose ids are empty is dropped instead of guessed.
* Goals alone are residue: a crash that hit between rounds still produces a plan, so the next
  round is not lost just because no turn happened to be open.
* A crash plan from an earlier pause is merged into the pending plan; goal rows the pause plan
  already owns stay authoritative, and the crash fills only the gaps.
* Jobs are still never replayed. The crash report keeps saying so instead of claiming they resumed.
* Version 2 heartbeat files are still read; their goal list is empty, exactly as before.
* New coverage: the v3 write/read round trip, malformed goal rows, a legacy array lister, a
  goals-only residue, the hydrate merge, and a goals-only resume that re-arms without a session.

## 0.4.13

Every answer from `/state`, `/pause` and `/resume` carried `version: '0.4.9'`. The literal was
written once and then not touched while the package advanced through three releases, so anyone
reading the field — a bug report, a log line, a future client refusing an old Host — was told the
wrong build. The version now comes from `package.json`, and a test compares the exported constant,
the manifest and a real `/state` answer, so the two can never drift again.

## 0.4.12

A crash record answered the state question with a flag that described a stop which never
happened. `complete` is documented as "the stop finished and nothing is still turning", but a
record written by the heartbeat after a process died also has `status: paused`, so the API said
`complete: true` for it. The page does not read the flag; anything else that does would be told
a press had finished successfully when the process had simply gone away.

* `complete` is now `null` for a plan whose source is `crash`, the same answer given when no
  plan exists. A crash plan converted into a real pause by the next press still reports `true`,
  because that stop did run.
* New integration coverage drives the real heartbeat file across two simulated processes: a
  residue is offered as a crash plan, resuming it mounts both sessions and sends no
  continuation, the pending copy is cleared afterwards, and the released heartbeat takes the
  file back so a third process sees no phantom crash.
* A regression test for the repair path: a pause pressed after a failed merge writes the merged
  plan durably and hands the held heartbeat back exactly once.

# Changelog

## 0.4.11

A Host that stops answering had no way to release its requests: the page waited for an answer,
gave up on the answer, and left the connection open. Repeating that fills the browser's
per-origin connection pool, and from then on every poll queues behind requests nobody is
reading, so the button stops updating even though the Host is back.

* Every page request now has its own abort controller chained to the caller's signal, and the
  deadline aborts it instead of only abandoning the promise. A press in flight when the page
  unmounts is aborted too.
* A press whose answer was lost asks for the state with a fresh request instead of reusing the
  controller the timeout just aborted.
* A new integration suite drives the real atomic writer across simulated restarts: a paused plan
  resumes with the same baselines, an interrupted stop is mounted only and never continued, and
  the archive and last-restore record survive the process that wrote them.

## 0.4.10

A plugin reload during a pause could keep cancelling turns and jobs that the next instance had
already captured, stopping work that no press in that process asked to stop.

* A stop now checks ownership before every cancel round, before each goal pause and each job
  kill, and once more before it reads the post-stop turn baselines. If a newer instance owns
  the plan, the stop returns with no rows and the engine discards the result instead of writing
  a plan over the new one. A regression test drives a reload from inside an in-flight cancel and
  asserts the newly started work is left running.

## 0.4.9

A pause could report "paused" while work it had not captured was still starting, and two disk
failures could turn a complete stop into a mount-only restore. This is the 0.4.8 review.

* A turn that started after the capture was left running behind a `paused` label. The stop now
  discovers newcomers within a bounded budget, cancels them in parallel with the captured turns,
  and records them with the same continuation cycle and post-stop turn baseline. A newcomer that
  arrives after the budget is reported as `still running`, never hidden.
* A stop whose final plan write failed kept the pre-stop `pausing` copy on disk and silently
  dropped the complete in-memory plan, so the next resume mounted sessions without continuing
  their interrupted turn. The complete plan now stays in memory for that process and is still
  offered for restore, while the failed write is reported.
* A probe that threw was recorded as a clean pause with no stopped sessions. The throw is now a
  `partial` stop with its own attention row, and every captured session keeps its plan.
* Cancelling turns is parallel and bounded: a Harness cancel that never answers fails the item
  after 3s instead of pinning the button in `pausing` forever, and a missing cancel or job service
  is reported instead of counted as stopped.
* After a crash the Host can apply plugins before its web server exists. The plugin asked once,
  found nothing, and stayed mounted without a route, so the header button was permanently a
  disabled pause glyph with nothing behind it. Mounting now waits for the web server and registers
  the routes as soon as it appears.
* A subagent row a pause could not claim was reported as restore attention even though its parent
  restores it. It is now `skipped`: a normal fan-out pause no longer marks the button as something
  a person has to fix.
* The red attention dot is gone. It appeared for conditions that resolve themselves and never said
  which condition it was; the button now only reports the phase, and the explanation stays in the
  tooltip.

## 0.4.8

* A restore report could leave its attention dot on the header forever: the report is written once
  and nothing cleared it after the person handled the item. A successful pause now starts a new
  cycle and removes the previous report, so the dot reflects only the work the current plan owns.

## 0.4.7

Four restore-boundary bugs and two reporting gaps found in the 0.4.6 review.

* A pause plan whose crash merge could not be written released the heartbeat only when the whole
  restore finished. A later partial restore left the old process record protected, so work started
  after the failed write was missing from the next boot. The heartbeat is now released as soon as
  the merged plan itself is durable, and stays held only while that write still fails.
* A goal restore intent recorded the revision from before the resume and then accepted any later
  revision as its own. A person editing the goal after a failed checkpoint was silently resumed on
  the next boot. The intent now stores the revision this process actually read plus the exact
  revision its own resume produces; only that state is re-armed, and every later edit becomes
  restore attention instead of a resume.
* A pause bumped the continuation cycle for every captured session, including one that only carried
  a goal and was mounted rather than continued. That changed an already admitted request id and the
  official dedupe admitted a second message. Only sessions whose running turn was actually captured
  get a new cycle.
* A migrated crash plan cleared `pending.json` only when its content still matched the snapshot
  exactly. A cleanup that failed and then saw the snapshot grow left the old copy behind, and the
  next boot offered the same restore again. Completion now clears a pending copy recorded as the
  migration source when every item in it is covered by the completed plan; anything extra survives.
* A goal checkpoint failure returned before publishing the restore summary, so the paused page could
  omit the failed item. Every partial return now publishes `result`, which also gives the dot its
  focused item.

## 0.4.6

* Restore attention rows are deduplicated by their own text, so two different items no longer
  collapse into one.
* Restore records from before 0.4.3 no longer keep a clean idle page dotted for killed jobs, which
  can never restart. Modern records already list them in `jobsStopped`.
* A pending copy left by a failed migration cleanup is removed before the completed plan is
  consumed, so the next boot does not offer the same restore again.

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
