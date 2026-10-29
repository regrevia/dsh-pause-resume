# Crash-restore audit, 2026-10-29

Scope: what the pause/resume plugin actually did on the two restarts named in the report, and on
every boot after them, against the promise "restore the work this crash interrupted — nothing else".
All numbers come from the live files on this machine; nothing here was produced by a scripted
service pretending to be the Host.

## Runs inspected

| boot | started (UTC) | journal rows | restored | skipped | attention |
| --- | --- | --- | --- | --- | --- |
| `75480-mvsml5z6` | 2026-10-28T21:27Z | 26 | 9 | 12 | 5 |
| `88580-mvsn1k10` | 2026-10-28T21:40Z | 27 | 14 | 12 | 1 |
| `34072-mvsp3n8p` | 2026-10-28T22:59Z | 30 | 18 | 11 | 1 |
| `48728-mvspwhme` | 2026-10-28T23:00Z | 30 | 16 | 13 | 1 |
| `50282-mvspywon` | 2026-10-28T23:03Z | 30 | 16 | 13 | 1 |
| `59524-mvsq3l9r` | 2026-10-28T23:10Z | 30 | 16 | 13 | 1 |
| `79732-mvsuyb7m` | 2026-10-29T01:23Z | 30 | 16 | 13 | 1 |
| `91126-mvsv8uat` | 2026-10-29T01:30Z | 30 | 16 | 13 | 1 |

Every row above belongs to the same crash plan `crash-1793110217612-12` (`crashes: 12`), so the
restores after `88580` replayed one old record instead of describing a new crash.

## What was wrong

1. **A plan from an old crash was replayed.** `~/.dsh/pause-resume/` held no `heartbeat.json` — the
   process had not written one — yet the carrier of the crash residue is exactly that file. With no
   residue, the previous plan was treated as current and every continuation row was dispatched
   again, once per boot.
2. **Admission was counted as restore.** The journal records `restored` when the Host accepts a
   continuation, not when a turn actually opens, and each acceptance bumped `epoch`. The durable
   baseline `continuedTurn` therefore lagged the opened turn by one and never advanced on a boot
   that changed nothing: `53f2e745` went `e:3 t:50 → e:4 t:51 → e:5 t:52`, `1ca8e13b`
   `e:3 t:24 → e:4 t:25 → e:5 t:26`.
3. **Sessions that were not running came back.** These were restored on `88580` and again on every
   later boot while their session files stayed untouched — no turn ever opened:

   | session | last write (UTC) | restored by |
   | --- | --- | --- |
   | `6d791279-72d7-4179-a46f-f80aa0062c62` | 2026-10-28T21:28Z | `34072`, `48728`, `50282`, `59524`, `79732` |
   | `2683415a-12d1-433a-98b5-4c98d0b2c343` | 2026-10-28T22:38Z | `48728`, `50282`, `59524`, `79732` |
   | `355dbb86-d92d-45c3-a14e-73ae91d063bb` | 2026-10-28T21:28Z | `34072` … `79732` (ended in `attention`) |

   `79732` had residue naming six sessions and `91126` naming ten, yet both journals recorded sixteen
   `restored` rows: the Host started restoring before that boot's `hydrate` ran, so the plan on disk
   was still the old one at dispatch time.

## What changed

- `hydrate` demotes crash rows that the restart residue does not name to `intent: 'mount'`,
  `running: false`, `epoch: 0`, and marks them `unseen`. A pause plan is never touched: its rows are
  what a person stopped by hand.
- A boot that found no heartbeat at all demotes every continuing crash row the same way instead of
  replaying the record.
- `resume()` re-checks the residue immediately before dispatch (`keepCrashRowsButMountTheRest`), so
  a Host that starts restoring before `hydrate` still cannot continue a row this boot did not name.
- Regression tests: `a previous crash plan leaves rows the new residue does not name mount-only`,
  `a boot without a heartbeat turns stale crash rows into mounts`, `a boot without a heartbeat
  leaves a pause plan continuable`, `a crash row the residue does not name is mounted even when
  dispatch starts first`. Full suite: 325/325.

## Progressive restore

Off on this machine, confirmed from the code and the profile rather than from a default:
`index.js` reads `config?.restoreProgressive === true`, and neither `cordis.yml` nor
`cordis.patch.yml` in `~/.dsh/profiles/desktop` mentions `restoreProgressive` or this plugin at all.
Progressive restore is an opt-in pacing measure, not part of the crash-recovery guarantee; every
finding above happens with it disabled.

## Residual risk

Journal `restored` still means "the Host accepted the continuation". Turning that into "a turn
opened" needs a durable turn proof at journal time; the row baselines now make the churn visible but
do not remove it.

## Confirmation after the fix

Boot `91126-mvsv8uat` (started 01:30:07Z, before the dispatch veto could read a residue) still
journaled `restored:16`. The boot after it (01:45Z) is the first one carrying the working veto:

- `/dsh-pause-resume/state`: `phase: idle`, `source: crash`, `restored: 0`, `skipped: 3`,
  `failed: 0`; the skipped rows read `crashed outside a turn; not started`.
- `pending.json` (01:46:08Z): 22 rows, **0 continuing, 15 mount-only** — the nine rows that were
  still `continue` at 01:31 are now mount-only, so a later boot cannot open a turn for them.
- No session file was touched for the three largest sessions in that window, which is what a mount
  looks like and what the previous boots' `restored:16` did not look like.

The same restart exposed one more thing worth writing down: the Host died at 01:29:47Z of a V8 heap
OOM (3.9 GB of a 3.96 GB cap, stack entirely inside `app.asar/lib/main.js`), and the restart at
01:30Z immediately restored sixteen sessions, three of which are the largest on disk (312 MB,
238 MB and 204 MB of plain JSONL). Progressive restore is **off** on this machine, so the restore
loop was free to mount up to four sessions at once (`Promise.all(Math.min(4, indexes.length))`).
The fix does not remove that peak by itself — it removes the sixteen-session replay; capping
concurrency is a separate, opt-in setting.
