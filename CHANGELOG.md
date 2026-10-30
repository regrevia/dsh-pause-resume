## 0.8.3

- 3 天前那份没人按的崩溃计划不再是一个随时会踩的地雷：崩溃记录超过 `restoreMaxAgeHours`（默认 72 小时）就整份归档到 `restores/<planId>.json` 并在 `lastRestore` 里留一条 `status: expired`，恢复流程一次都不会碰它。以前这种记录会一直躺着，谁按一下 ▶ 就把好几天前就停下的会话重新打开一遍，堆全花在别人已经放下的事情上。归档不删除：行还在盘上。
- 归档发生在启动（`hydrate`）和按下（`resume`）两个入口，所以「没重启就按了」和「重启之后按了」是同一个结论。`/state.expired` 报出被归档计划的小时数与行数，按钮文案说清「已归档，不再恢复」，不再留一个按了没反应的空状态。
- 时长可配（`restoreMaxAgeHours`），但调大只是延长重放窗口，不改变「只恢复一个大会话」的那条线。计划归档失败时 `expired.archived === false`，文件仍在，下一次启动重试。
- 测试：单测 378 个（新增 3：三天以上的崩溃记录只归档不挂载、一天内的记录照旧恢复、归档后 `pending.json` 一起清掉不留给下次启动），原先固定写成 1970 年 `createdAt` 的崩溃夹具改成「刚刚发生」。

## 0.8.2

- 「重启后又没能全部恢复」的根因修掉了：前一个进程挂过的行没有留下可验证的凭据，于是每次重启都**从第一份转录重新挂载一遍**，同一批大会话把堆吃满，后面的行又被预算拦下——看起来是恢复不动，实际是同一件事做第二遍。现在一行恢复成功就写下 `restoreDoneAt`/`restoreDoneBoot`；下一次启动读到早先进程留下的 `restored` 日志时，只要那一行是「只挂载」且没有记下任何 continuation，就直接采纳为已完成、不再反序列化它的转录。
- 采纳有边界：日志里记了 continuation 轮次（`turn`）的行以及 `intent: continue` 的行仍然重新核对——记下的 turn 是随那个进程一起消失的提示，不能当已交付。本轮已恢复的行在同一个进程里的重复询问也一样：`continue` 行先读一次实时状态，确认那个 turn 已经结束才跳过。
- 用户自己按停的 turn 不再被报成「需要确认」：`turn/end` 为 `aborted` 且原因是用户（`reason.kind === 'user'`）时按 `skipped` 收尾（暂停计划自己写的 aborted 仍归暂停所有）。这类行以前会停在 attention 里，让人以为还有活没放回去。
- 跳过与采纳的说明都带原因（`restored before this restart`、`the turn was stopped by hand before this restore`），`/state` 与结果摘要里能分清「已做过」和「没做」。
- 测试：单测 375 个（新增 3：早先进程挂过的行不再重复挂载、手停的 turn 记为 skipped、暂停计划仍拥有自己写的 aborted），`acceptance/run.mjs` 8/8、`acceptance/round2.mjs` 5/5。

## 0.8.1

- 修一个会让「被拦下的工作」消失的缺陷：准入拦下整轮所有行时，这一轮仍走到计划消费那一步，把 `snapshot.json`/`pending.json` 里的计划删掉，于是下次启动看起来是干净恢复，实际那份大会话一次都没被打开过。现在只要有行被拦下，这一轮就以 `partial` 结束并保留计划：每行的 `deferred` 落盘、`intent` 不动、`/state.restore.deferred` 列出被拦下的行；重启后堆是空的，同一份计划自然能挂上。
- `/state.scheduling` 在任何一次恢复之前就报出解析后的阈值（`heavyMB`/`reserveMB`/`concurrency`/`derived`）。以前这些字段只在跑过一次恢复后才有值，健康启动看上去像没配置；现在它们和 `scheduling.heap` 用同一次堆读数推导。
- 有行被拦下时，按钮提示改成「重启后继续没放下的内容」而不是「可以再按一次」：同一个堆还在，再按一次挂不上，那是个没有出口的循环。
- 测试：单测 372 个（恢复节流 12 个；其中三个断言补上「计划必须留在盘上、不被消费」，一个跑完整回路：被拦下的行由下一个进程挂载，挂载成功后才消费计划），`acceptance/run.mjs` 8/8、`acceptance/round2.mjs` 5/5。

## 0.8.0

- 恢复准入多一道「预测成本」闸门：挂载一份转录的堆代价约等于它压缩体积的 6 倍（`EXPANSION`），准入时先按这个估算需要多少堆；放不下就在**读之前**拦下，不再出现「读完才把堆撑爆」。体积读不出来的会话一律按大会话处理（独占、串行），`/state.scheduling.unknownWeights` 报告本轮有几个测不出来。
- 被拦下的行不再丢原意：`deferred.park` 记住它是「该挂载」还是「该继续」，下次恢复按原意回来；旧数据没有这个字段时仍按挂载处理。被拦下的行也不改写 `intent`，计划不关闭。
- `/state.scheduling.deferred` 公开这些行（会话 id、原因、时间），页面用它解释按钮为什么恢复不了这一行；`restartRecommended` 与它们同寿命——`deferred` 非空就保留，健康且没有 deferred 的一轮清除，超过 6 小时的旧建议不再上报，时钟回拨不算过期。
- 一处堆读数服务一个 `describe()`：`heap` 与 `heapLimitMB` 取自同一次 `getHeapStatistics()`；goal 与 session 走同一套预算与延迟逻辑；恢复被按下暂停时返回 `status: 'interrupted'`，不消费计划、不算一次失败、不显示成「上次操作没有完成」。
- 崩溃记录存在却解析不出来时不再等同于干净启动：崩溃行只挂载不继续，`/state.error` 为 `residue`，日志写明原因。账本对「未来时间戳」的行不再隐藏，时钟回拨不会让行凭空消失。
- 跨平台收口：`npm run audit` 改用 flat config（不再依赖引号转义）、`engines.node >= 22.15.0`、`npm test` 用 Node 自己展开的 glob；快照名撞上 Windows 保留设备名（`con`/`prn`/`aux`/`nul`/`com1-9`/`lpt1-9`）时加下划线；acceptance 用 `os.homedir()` 而不是拼 `~`；probe 侧修掉 BOM、`CRLF`、半截 JSONL 帧、单帧 64 MiB 上限、`session-` 前缀大小写、坏 id 与目录占位这些 Windows 上真实出现的形状。
- 测试：单测 371 个（新增恢复节流 11、probe Windows 13、跨平台 12），`acceptance/run.mjs` 8/8、`acceptance/round2.mjs` 5/5。

## 0.7.1

- 恢复节流的三个内存数字不再写死。0.7.0 把它们定成 12 MB / 700 MB / 2 并发，那只是本机 4 GB V8 上限下的合适值；换一台机器、或换一个 `--max-old-space-size`，同一个数字要么太松（堆先炸）要么太紧（该恢复的不恢复）。现在默认按进程实际的 `heap_size_limit` 推导：大会话阈值 `heapLimitMB / 340`（夹在 8–48 MB），堆余量 `22%`（夹在 320–1536 MB），并发在 V8 上限 < 3 GB 时退成 1。
- 配置仍然可以覆盖任何一项：写了就是人定的值，`/state.scheduling.derived` 会标明哪几项来自推导、哪几项来自配置；同时新增 `heapLimitMB` 与 `concurrency` 两个上报字段，`restoreHeapReserveMB` 的注释也不再声称默认 700。
- 测试：单测 343 个（新增「阈值为 8 GB / 2 GB 上限分别推导，且显式配置覆盖推导」），`acceptance/run.mjs` 8/8、`acceptance/round2.mjs` 5/5。

## 0.7.0

- 恢复改成按堆预算调度，这是本机 2026-10-29 连崩三次的直接修复。三次都是宿主 OOM：`crash-*-host.log` 里 pid 91126 跑满 64 分钟、堆 3.65 GB，pid 61989 在恢复 15 个会话后 15 分钟、堆 3.58 GB，都停在 `FATAL ERROR: MarkCompactCollector: young object promotion failed`。恢复一个会话要把它整段转录反序列化进同一个进程，大会话一条就是 GB 级，而 V8 上限约 4 GB——不是慢，是死。
- 四条调度规则，全部按堆算而不是按数量算：①只恢复本次崩溃真正中断的会话（0.6.12 起的行为不变）；②按压缩转录体积从小到大排队，轻会话仍走 `restoreConcurrency`（默认 2）；③体积 ≥ `restoreHeavyMB`（默认 12 MB）的会话独占一段：等它的 turn 结束，或等到 `restoreSettleMs`（默认 90 s）上限再放下一个；④每步之前读 `v8.getHeapStatistics()`，余量低于 `restoreHeapReserveMB`（默认 700 MB）就不再挂载任何会话。
- 没轮到的会话不加载转录、写入 `deferred`（含时间与原因），计划不关闭、行仍可见并进 `attention`；一轮里有大会话或产生 `deferred` 时，计划与 `/state` 同时给出 `restartRecommended`（带本轮堆用量和原因）。插件从不退出或重启宿主：进程里是用户正在跑的 turn 和 job，插件无权替用户按那个键，只摆事实。
- 客户端把 `restartRecommended` 翻成一句后果话「跑完这些任务后重启宿主」，替换掉原来的诊断性 reason，不新增任何常驻提示。
- probe 新增 `sessionWeight(sessionId)`（复用 `findSessionLog` + `stat`，目录占位按 null 处理），供调度按体积排队；`describe()` 新增 `scheduling { heap, heavyMB, reserveMB, deferred, restartRecommended }`，超过 6 小时的旧建议不再上报。
- 跨平台：README 新增 Supported platforms，并对持久状态层（`lib/ledger.js`、`lib/snapshot.js`、`lib/heartbeat.js`、`lib/store.js`）做了 POSIX 假设审计——路径只走 `node:path`、临时文件与目标同目录再 `rename`（Windows 上目标被占用时有限重试）、Windows 只跳过目录 `fsync`、JSONL 读侧容忍 `\r\n`、带 BOM 的状态文件仍可读。
- 测试：单测 342 个（新增恢复节流 5 个、跨平台 5 个、probe 体积 6 个），`acceptance/run.mjs` 8/8、`acceptance/round2.mjs` 5/5。文档见 `docs/memory-safety.md`。

## 0.6.13

- 恢复时的并发上限从 4 降到 2，并且不再依赖渐进恢复开关：恢复一个会话要把它整段记录反序列化，大会话一条就是一两个 GB 堆，四个同时开就是本机 3.9 GB 堆被打满的那次崩溃（宿主 01:29:47Z 的 OOM，栈全在 `app.asar`）。现在每一层波次最多同时挂载 2 个，需要更慢可以配 `restoreConcurrency: 1`。
- 新增回归用例：六个会话同层恢复时记录实际并发峰值，必须 ≤ 2；测试 326 个，全过。
- 这一条只削平峰值，不会改变“恢复哪些”：集合收敛仍然只认本次重启的残留。

## 0.6.12

- 重启不再重放上一次崩溃留下的继续行。判断“这次该恢复什么”只认本次重启的残留（`running.json` 里真正在跑的会话），历史崩溃计划里的继续行一律降级为挂载：行仍然可见、仍然可点，但不会替一个几小时前就停下的会话开新轮次。实测证据：连续五轮重启把同一批 16 个会话各“恢复”一次，其中 6 个会话的日志在重启前后几个小时内没有任何写入；审计见 `docs/evidence/crash-restore-audit-2026-10-29.md`。
- 残留的核对提前到派发之前，而不是等启动后的 `hydrate`：宿主可能先开始恢复、后跑 `hydrate`，旧版本正是在这个顺序里把闲置会话重新打开。`resume()` 现在先按残留把没被点名的崩溃行降级，必要时直接读一次残留文件（只读，不覆盖本轮证据）。
- 本轮根本没有心跳文件时，崩溃计划里的继续行同样降级为挂载；手工暂停的计划不动，那些行是人按停止键留下的。
- 测试：325 个单测；新增用例覆盖“残留只点名一部分时只继续被点名的”“派发先于 hydrate 时仍按残留降级”“没有心跳时崩溃行只挂载、暂停计划仍可继续”。

## 0.6.11

- 修掉“同一任务再次失败后 ↻ 就发不出消息”的缓存错位：结束事件在缓存里是字符串，读取方却按对象取 `kind`，第二次失败把整行读成不可读；现在只有一种结束事件形状，错误、`max-tokens` 连续发生也仍然各自成为下一次可按的候选。再次失败不是丢失，只是等下一次人工按压。
- 修掉“批量继续时按暂停只停住已发出的请求”：暂停取消的是同一个批次（`ledger.cancel()` + `gate.abort()` + `ledger.drain()`），排队中的行不会再被 `mapLimit` 取走；批次结束前按钮不会被第二次继续占据。
- 准入归属统一为 `engine.ownsAdmission(sessionId)`：只有本实例计划里记录的那次准入才算“已经发过”，别的窗口/旧进程的残留不会被误认成自己的重试，也不会因重试而重复发送。
- job 交付证明只认“本次恢复真的发出过请求”：`already running`、只挂载、已准入但没有 `requestId` 都返回继续但不置 `delivered`；带负向用例，防止把“没发”记成“已交付”。
- 冷会话里只能挂载后才看得见的 goal：挂载后重新读取并按当前 revision 重新武装；goal 读不出来时落 `attention`，不再猜一个 revision 去恢复。
- 过期 goal 检查点（`pendingRestore`）按当前 revision 对账后重写，不再让旧 revision 永远卡住恢复；写检查点失败仍保留意图并报 `partial`。
- 渐进恢复开启时，`POST /continue` 与恢复批次走同一道门控：批次期间 `gate.enabled()` 为真，正常返回和抛错都必须关闭；补了应用级测试，否则异常继续可以绕过并发上限。
- 账本新增只读分类：每行 `blocking` / `actionable`，`pendingContinue` 汇总 `blocking` / `actionable`。`attention` 行和“重试也修不好”的错误码（鉴权、权限、额度、模型不存在、上下文超长等）标成 `blocking`，其余标成 `actionable`。它只是给页面看的标签，不改变“一次按压继续全部可见行”的语义，也不会隐藏任何行。
- 测试：321 个单测；`acceptance/run.mjs` 8/8、`acceptance/round2.mjs` 5/5、真实 Host smoke 18/18、host-live 14/14、host-maintenance 11/11。验收记录见 `docs/acceptance-0.6.11.md`。

## 0.6.10

- Turns that stop on their own now have a home: a turn whose latest end is `error` or `max-tokens`, with no later start or end, becomes one “继续未完成的任务” row in a new independent ledger (`continue.json`). A person presses ↻ once and the visible rows are continued two at a time with ordinary user messages. Nothing is sent on load, on a timer, or automatically after a failed batch; a row that fails waits for the next press.
- The continue set is deliberately narrow. `completed`, `aborted`, `interrupted` and `blocked` clear a row, so a turn a person stopped by pressing pause never comes back as unrequested work. Child and subagent sessions are excluded: their stop is answered by the parent's tool result, not by talking to the child directly. A new message in a session clears its row as a takeover.
- An `error` end is not owed to a crash or pause restore. The existing restore paths keep their behaviour; only the explicit continue press passes `allowAbnormalEnd`, which is what makes an upstream failure actionable without turning every restart into a retry of a broken provider.
- The button gained a third action and a retry-arrow glyph. `/state` reports `pendingContinue {count, attention, busy, tasks}` and the decorated `action`; `/continue` accepts a press only when that decorated action is `continue`, otherwise it answers 409. The tooltip carries the count and how many rows need attention; the button itself stays glyph-only.
- Reliability work carried in the same tree:
  - The restore gate is batch-scoped and reservation-aware. A prompt that emits `turn/start` before returning is counted from the reservation, a late start inside a bounded window reopens the batch instead of bypassing the limit, and a person's stream in an unrelated session is never queued behind a restore.
  - A stream cancelled by the person's own pause is neither a success nor a failure strike; only an upstream abort/error earns a cooldown.
  - A job handoff row now has a lifecycle (`pending` → `delivered` → `completed`). Delivery is not acknowledgement: an old completed owner turn cannot spend a pending row, a delivered row survives a reboot until its own turn proves completion, and a skipped answer keeps the obligation.
  - A stale pending goal restore is re-armed with the goal's current revision, and a goal whose rearm cannot be persisted keeps its tracking and reports `partial` instead of losing the intent.
  - A heartbeat one round behind no longer skips work: an unclosed later turn and a trailing `turn/start` are owed work, and a cold child's raw unclosed log is continued rather than reported running.
  - Crash and mount rows re-read the durable turn log before closing; a settled job is evidence for handoff, not live work; an awaited job reader is parked so a late settlement cannot wake the owner.

## 0.6.9

- A completed turn from before the pause is no longer used to settle a newer turn the plan still owes. A stale `completed` end used to satisfy the turn check for any turn, which let the press skip the continuation turn 2 still owed; only an end at or after the owed turn can answer for it, and a newer owed turn with an older readable end is held as `unknown` instead of prompted.
- A `blocked` turn is now split by admission. Before a continuation is admitted it is work that never ran, so the press continues it; after admission it is a real result and becomes one attention line instead of being sent again.
- The restore gate now tracks turn ownership, not just the stream. A restored turn makes one model call per step with tool calls in between, so the gate used to close in the gap and a stream whose model call started a moment later walked past the slot limit. `session/event` opens and closes the turn, the drain waits for `openTurns === 0`, and the caller's abort signal reaches the permit wait.
- A second press over the same unreadable set no longer consumes the plan. It keeps the plan on disk, counts `unknownAttempts`, rebuilds the attention rows from that press and returns `partial`, so the last manual entry point is still there after auto-retry stops.
- Goal restore proof survives a pause that did not touch the goal. Clearing `pendingRestore` / `armedRevision` from untouched goal rows erased the only proof that the goal belonged to the plan; an already armed goal now also gets its own pre-arm checkpoint before a second re-arm.
- A maintenance compaction is no longer reported paused before it stops writing. `cancel()` only asks; the press now waits up to 4 seconds for `phase.kind` to leave `maintenance`, and a compaction that stays there is an explicit `maintenance` error on the stop result, not a clean pause.
- A background job handoff is per owner instead of requiring an otherwise empty plan, and its row is persisted before the continuation is delivered. A delivered handoff (`restored`) keeps the plan `partial` so the next boot can still read who was told what; only a later press that finds the turn already finished (`skipped`) spends the obligation, and deletion happens only after the completed plan is durable. A late `awaited:false` settle after a pause no longer wakes the owner.
- A re-admission records its `.rN` attempt, so the next one gets a fresh request id; reusing `.r1` made the official prompt dedupe answer `accepted: true` without waking the session again.
- A crash plan is classified against official turn ends before anybody presses continue, and a cold child mounts its parent once (bounded) before failing the row.
- `npm test`: 265 pass / 0 fail. `npm run audit`: 0 errors. Mock acceptance: 7/7 and 5/5. Host smoke: 17/17.

## 0.6.8

- Closing the restore gate no longer releases every parked model request at once. `unguard()` used to resolve the whole queue the moment a press returned, so a restore that parked five sessions behind a capacity of two turned them into five concurrent provider streams; the queue is now drained at the slot budget, and `abort()` closes a drained gate instead of parking the next request behind a finished batch.
- A child row now mounts its parent instead of giving up on a cold one. With the parent agent not live, `restoreChild()` waited and then failed with "parent is not live yet" on every attempt, so a plan whose only problem was an unmounted parent kept coming back `partial`; it now calls `mount()` on the parent once (bounded), still waits, and still leaves the row retryable when the mount cannot make it live.
- Release entrypoints are one line again. GitHub Releases now exist for `v0.6.0`–`v0.6.8`, where the Releases page had stopped at `0.5.12` while the tag and the npm package were already `0.6.x`; the code installed from the Releases page and from npm is the same release.
- Every P1 in the latest review was re-checked against this tree and is recorded with its regression test in `docs/acceptance-0.6.8.md`. The review itself inspected main `3ac91bf` / tag `v0.5.3` / Release `0.5.2` / 168 tests, which is the pre-0.6 tree; main at that time was `b99c637` (0.6.7) with 256 tests.
- `npm test`: 258 pass / 0 fail.

## 0.6.7

- A real restart no longer leaves the button moving while nothing restarts. A crash row recorded `unknown` used to answer "turn state unknown; open the session to decide" even when the persisted session log already carried the reason: its latest turn ended `interrupted` / `blocked`, i.e. the crash cut it in flight. That is the same obligation an `interrupted` row carries, so the press now sends the continuation instead of holding the row unreadable on every press. `aborted` (a person's deliberate stop) and a missing end stay on the conservative path: no evidence is not the same as nothing to do.
- The "a turn advanced while this plan was stopped" guard now distinguishes a clean advance from a cut one. An end that was cut in flight means nobody finished the work, so the continuation is owed; a `completed` end (or no readable end) still holds the row for the person.
- A stale crash end is no longer counted as the continuation's own end. After admitting a continuation, the post-submit backfill re-read the same `interrupted` end that routed the row in and reported "continuation turn ended as interrupted" with `continued:false` — which left the row retryable and made the next press send the same continuation again. Only an end newer than the pre-submit evidence can now belong to the admitted turn.
- `npm test`: 256 pass / 0 fail.

## 0.6.6

- A crash row recorded `unknown` that a person continued by hand and let finish no longer stays `unknown` forever. The latest official turn end being `completed` is evidence that no turn is open, but not that the paused work was part of it, so that press now closes the row as one attention line ("a turn completed after the crash; confirm the paused work was part of it") and sends nothing. Where 0.6.5 kept reporting the row on every press until retirement, the evidence alone now settles it; a `completed` end read from the persisted session log works the same as one from the end service.
- A child row now honours the same three intents a root row does. Before this, a child recorded `skip` could still be sent a queue continuation whenever no turn end was readable, and a child recorded `unknown` was prompted on the same guess; both now answer without a prompt (`skipped`, or the same attention line for a finished turn), and a child already running by hand is reported `restored` / `already running` instead of being queued a second continuation. Root and child behaviour were divergent; they are now one rule.
- `npm test`: 252 pass / 0 fail.

## 0.6.5

- A press no longer touches the sessions a person already continued by hand. A crash row that was recorded `unknown` but whose session now has a live running turn is reported `restored` / `already running` with no message sent, instead of `unknown` and an attention line; a `continue` row re-reads its agent immediately before admitting the prompt, so a manual continue that lands during the press is not sent a second continuation. Two sessions continued by hand plus three dead ones now means: nothing for the two, the three stay named.
- Retirement measures progress against the previous press's unknown set instead of counting restored rows: a session continued by hand is restored on every press while it runs, and counting it as new progress kept the button promising a restore it could never finish. A manual continue still counts as progress (the plan stays open, the reduced set is what the next press compares against).
- Attention became per-row. A partial press replaces the captured "N sessions need a look" count with one row per unresolved session, and a restore row leaves the dot the moment that session runs again — while a stop row ("would not stop") stays exactly because that work is still running.
- Remaining race, stated plainly: the Harness offers no compare-and-admit for a continuation, so a window remains between the final status read and prompt admission. The request id derived from the plan and session, the admitted-request guard, the immediate re-read before admission and the post-admission turn proof narrow it; none of them makes it atomic.
- `npm test`: 247 pass / 0 fail.

## 0.6.4

- A press that can only ever repeat itself now ends. A crash plan whose rows all stay `unknown` used to keep the plan at `restore.attempts:0`, so every press re-read the same unreadable turns, reported `partial`, and left the button offering the identical restore forever. The first press still records the exact unknown set and keeps the plan, because a late settle or a fresh boot can make a row readable; the next press that finds the identical set and started nothing retires the plan as `partial`, publishes those rows as `attention` (the dot and "open the session to decide" stay), and the button goes back to `none`. Nothing is reported as restored, skipped or failed.
- A compaction in flight is now stop work: `workOf()` reports `maintenance`, `live.maintenance` names it, and a pause with nothing else live cancels it instead of answering `idle`. Nothing is written to disk for it — compaction is not resumable work — and the result carries `maintenance.canceled` / `maintenance.errors`; a mixed plan keeps the separate `stopped.maintenance` block. A failed cancel is reported as `partial`, never as a clean pause.
- The maintenance check is no longer a stand-in: `acceptance/host-maintenance.mjs` (`npm run smoke:maintenance`) boots the shipped plugin on a throwaway profile and asserts 11 behaviours over real HTTP twice, including a real `phase.kind === 'maintenance'` observed on the live agent, a pause response of `paused` in ~100 ms, `stopped.maintenance.canceled` in the plan, the summarization settling as "Compaction cancelled." and the second pause answering `already`. Evidence is written to `docs/evidence/host-maintenance.json`; the local mock model remains the only stand-in and is labelled as such.

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
