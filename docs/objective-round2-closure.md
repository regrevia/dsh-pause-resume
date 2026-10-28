# 第二轮恢复可靠性收敛：验收与收口

结论：评审要求的八项已经全部落到代码路径、单测与验收证据中；本轮没有新增行为改动，只重跑全部门禁并把“哪条要求由哪段代码/哪条测试证明”固定下来。发布件是 `dsh-pause-resume@0.6.10`。渐进恢复仍默认关闭，自动发送仍默认关闭：只有用户按下继续，才允许当前这批任务继续，失败项留到下一次按。

## 一、本次重跑结果

环境：`/Users/apple/Desktop/DSH/dsh-pause-resume`，工作树 = 发布提交 `766b468` + 本次证据刷新。

| 门禁 | 结果 |
|---|---|
| `node --test test/*.test.mjs` | **311 / 311 pass，0 fail** |
| `npm run audit` | **0 error** |
| `node acceptance/run.mjs` | **8 / 8 pass**，R01–R14 |
| `node acceptance/round2.mjs` | **5 / 5 pass**，P1-1–P1-5 |
| `npm run smoke:host` | **18 / 18 pass**，真实 Host HTTP |
| `node acceptance/host-smoke.mjs --self-test-fail` | **exit 1**，证明失败不会被吞成 0 |
| `npm run smoke:live` | **14 / 14 pass**，真实 turn 暂停 → SIGKILL → 重启 → 只续一次 |
| `npm run smoke:maintenance` | **11 / 11 pass**，真实 `maintenance` 相位取消 |

证据文件在 `docs/evidence/`，这批结果由当前 0.6.10 安装重新生成。

## 二、八项要求与证据

### ① 用 turn 结束原因判断，不再用 turn 数字猜

代码：`lib/probe.js` 的 `END_KINDS` / `OWED_END_KINDS`、`assessSession()`、`observeTurns()`。只有 `completed` 才 `skip`；`interrupted` 保留恢复义务；`aborted` 停在 `unknown`（暂停自己产生的 `aborted` 除外）；`blocked` 未准入继续、准入后转 attention；`error` 只有用户按继续（`allowAbnormalEnd:true`）才继续。

订阅顺序与漏事件：`assessSession()` 先订阅本进程事件，再读持久化日志补漏；`test/round2-probe.test.mjs` 的 `the turn listener is registered before the prompt is submitted` 直接断言订阅时间早于提交时间。挂载后仍读不出时，`lib/engine.js` 的 `reassess()` 在 `mounted:true` 后重判，不再永远返回同一个 unknown。

锁定测试：`reads an interrupted turn as owed work`、`returns unknown, never skip, when no turn end is readable`、`an older completed end never settles a newer turn`、`a blocked turn with no admission is continued`、`a continuation blocked after admission is attention`、`an unknown row whose latest end was an aborted turn is still held`、`an upstream error is resumed only by the person press`；重判见 `test/round2-engine.test.mjs` 的 `a session still unknown after mounting is re-assessed and becomes restored`。

### ② 子 Agent 与根会话共用恢复语义

代码：`lib/probe.js` 的 `assessSession()` 同时服务 `restoreSession()`（根）与 `restoreChild()`；`restoreChild()` 不直接续跑，先判定 `skip / unknown / admitted / 已完成`；冷父先有界挂载一次再重试；`lib/engine.js` 只按 intent 决定继续还是挂载。

锁定测试：`restoreChild() skips a completed child turn`、`never resumes a child row whose turn ended before the restart`、`closes a hand-finished unknown child as attention`、`mounts a cold parent before declaring the child unrestorable`、`reports a child already running by hand as running`、`reports an already admitted continuation instead of sending it again`；`acceptance/round2.mjs` 的 P1-5 覆盖 job-only 与 owner 交接。

### ③ 普通暂停与中途暂停共用停止结果归并

代码：`lib/engine.js` 的 `mergeStopResult()` 是 `pause()` 与 `interruptResume()` 的唯一归并入口，合并 session / Goal / job / maintenance / 失败项并把结果落盘；`stillRunning`、`unknown`、Goal 错误、job 错误任一存在即 `partial`，`complete:false`，并写 attention。Goal 暂停后写官方返回的确切 revision，同时清掉上一轮 `pendingRestore` / `armedRevision`。

锁定测试：`test/round2-engine.test.mjs` 的 `a pause that leaves a session running is partial and not complete`、`an interrupted restore whose stop throws is partial`、`pausing mid-restore writes the exact revision the goal was left at`（断言 revision=5 且旧标记为 null）；`acceptance/run.mjs` 的 R06 断言 `status:'partial'`、`complete:false`、`attention>0`。

### ④ hydrate 非破坏性合并旧计划

代码：`lib/engine.js` 的 `hydrate()` 以磁盘旧计划为基底合并 heartbeat，保留 `epoch`、`continuedTurn`、`admittedRequest`、`admittedEpoch`、`retry`、`intent`、`lastTurn` 和未完成 Goal；旧计划里 heartbeat 没提到的行只标 `unseen`，不删行、不重建；同一 residue 第三次启动不重写文件。

锁定测试：`hydrate keeps the pause plan intact and only marks rows the residue did not name`（逐字段断言 + 第三次启动文件字节不变）。

### ⑤ 后台任务：真实 stop 状态、stopping 可见、迟到结算不唤醒、job-only 交接

代码：`lib/probe.js` 的 job `stop()` / `waitJobExit()` 产出 `stopped`、`stopping`、`stop-failed`、`unknown`；`lib/engine.js` 的 `describeJob()` 只在 `stopped` 时写“已停止”，`stopping` 写“正在停止”，失败写“仍可能运行”；job-only 计划按 owner 合成 `handoff:'job'` 行，`pending → delivered → completed` 三阶段持久化，交付不等于消费。

锁定测试：`resume copy follows the job stop state instead of assuming the command died`、`a job-only plan hands the obligation to its owner`、`the job handoff row reaches the store before its continuation is delivered`、`a delivered handoff whose own turn reads completed is spent without a second prompt`、`two boots keep the handoff obligation until the delivered turn settles`；迟到结算见 `test/round2-probe.test.mjs` 的 `the pause parks an awaited job reader so a late settlement cannot wake the owner`、`stop() keeps a job that was still stopping after the pause as a handoff obligation`。

### ⑥ 独立 maintenance compaction 可取消，并与用户任务分开保存

代码：`lib/probe.js` 的 `MAINTENANCE` 路径先对每个 maintenance 条目发官方 `cancel()`，再在 `MAINTENANCE_SETTLE_MS=4000` 内轮询到 `phase.kind` 离开 `maintenance`；取消失败进 `maintenanceErrors`，暂停如实 `partial`。`lib/engine.js` 把 `maintenanceCanceled` / `maintenanceErrors` 存在计划的 `maintenance` 字段，不混进 session 行。

锁定测试：`stop() cancels a maintenance compaction through the official entry`、`stop() reports a maintenance entry it could not cancel as unknown`、`stop() issues every maintenance cancel before waiting under one total deadline`；真实 Host 见 `npm run smoke:maintenance` 的 `maintenance-observed`、`maintenance-canceled-apart`、`maintenance-cleared`。

### ⑦ admission 不被旧 plan 副本覆盖，每次 rearm 有预写意图

代码：`lib/engine.js` 的 `recordAdmission()` 直接改当前 plan 对象，后续 `partial` 写盘不再用 hydrate 前的旧副本整体覆盖；每次 resume/rearm 前先写 `pendingRestore:{revision,expect,at}`，历史 `armedRevision` 不能替代本次记录；revision 校验不放宽。

锁定测试：`an admission recorded during a restore is not lost when the restore ends partial`、`a re-admission records its retry attempt so the next one gets a fresh request id`、`a stale pending goal restore is re-armed with the current revision`、`a checkpoint write failure after the second rearm keeps the fresh intent on disk`。

### ⑧ 验收脚本说真话，并带真实活动的 Host 测试

代码：`acceptance/run.mjs` 与 `acceptance/round2.mjs` 都按“场景数必须全过”设退出码，失败即 1；R06 显式断言 `partial`、`complete:false`、`attention>0`；`acceptance/host-smoke.mjs` 在任一 step 失败或 verdict 非 pass 时设 `exitCode=1`，并用 `--self-test-fail` 证明失败确实非零退出。没有 `|| true` 吞结果。

真实活动：`acceptance/host-live.mjs` 用可控 mock 模型流把首个请求扣住，真实 Host 里 turn 保持 running，暂停后 SIGKILL、同 home 重启、恢复一次；`acceptance/host-maintenance.mjs` 同样走真实 Host 与 mock 流，观察真实 `maintenance` 相位。两者都要求全过才 exit 0。

## 三、第二阶段能力（0.6.10）

自动发现异常停止与一键继续已经接上，但不改变“用户点击才继续”的边界：

- `lib/ledger.js` 独立 `continue.json`，只把 `turn/end error` 和 `max-tokens` 记为候选；`completed / aborted / interrupted / blocked` 清除；任何新 `turn/start` 清除；子会话不直接列为候选。
- `POST /continue` 只在状态明确为 `continue` 时可调用，否则 409；缺 guard header 为 403；每批最多两个 worker；失败项保留给下一次点击，不无限自动重试。
- `client.js` 在有待继续项时显示“继续未完成的任务”按钮，不带自动发送。
- 锁定测试：`test/ledger.test.mjs` 12 项、`test/apply.test.mjs` 10 项；`acceptance/run.mjs` R14 覆盖 `error` 候选与“只按一次”；`test/round2-probe.test.mjs` 覆盖 `interrupted` / `max-tokens` 的继续义务。

## 四、仍未独立证明的限制

这些不是门禁失败，而是当前环境不能诚实宣称已经覆盖：

1. **真实供应商故障与真实 max-tokens**：`error` / `max-tokens` 用可控 mock 流与 fake 结束记录验证；没有对真实上游跑满官方重试后再按继续。
2. **真实 Host 重启后重新读取 `continue.json`**：单测与 mock 验收覆盖；真实 Host smoke 只验证暂停/崩溃/恢复与维护压缩，没有在真实重启后点一次“继续未完成的任务”。
3. **真实 GUI 点击**：按钮文案与 HTTP 路由有测试，未在真实浏览器里点它。
4. **两个 worker 的真实并发**：`WORKERS=2` 有单测；没有用两条真实模型流验证同时只跑两个。
5. **真实 goal API / 真实 job owner 唤醒 / 深层父链**：goal revision 与交接有单测和 mock；没有跨真实 `SIGKILL` 调官方 goal 服务，也没有让真实后台 job 被暂停后观察 owner 真正被唤醒。
6. **真实慢维护压缩的 4 秒超时分支**：真实 Host 观察到 maintenance 相位与取消结果，但 mock 下压缩结束较快；超时分支由 fake 覆盖。
7. **全部分支的真实崩溃矩阵**：live smoke 只跑一条真实 turn；其余分支由 47 项 probe 测试、26 项 engine 测试与两组 mock 验收覆盖。

## 五、发布身份与复跑

- 发布提交：`766b4688124cc188943dedb1784fa3f95f8f097c`
- git tag：`v0.6.10`
- npm：`dsh-pause-resume@0.6.10`，shasum `a0c83bbd54e204c08421c4e798b35e59bb8b4ba6`
- 本收口文档与刷新后的证据提交在 tag 之后，只改文档/证据，不改运行代码。

复跑：

```bash
node --test test/*.test.mjs
npm run audit
node acceptance/run.mjs
node acceptance/round2.mjs
npm run smoke:host
node acceptance/host-smoke.mjs --self-test-fail  # 期望 exit 1
npm run smoke:live
npm run smoke:maintenance
```
