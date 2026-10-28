# 0.6.9 验收记录：暂停与恢复可靠性收敛

结论：0.6.9 修复了本轮评审点名的 10 个缺陷，全部有代码位置和回归测试；单测、两组 mock 验收、Host smoke、真实进程崩溃/重启与真实维护压缩取消均通过。渐进恢复仍默认关闭，不随本版开启。

## 一、版本边界

- 0.6.8 评审已确认的四项保持成立：冷启动根会话 `unknown` 会继续、重启时较新的中断日志胜过计划里的旧 turn、冷父会话会先挂载再恢复子会话、门控按槽位排空（峰值 2）。
- 本机仍在运行 0.6.6，直到用户重启 Host；磁盘上的 0.6.9 不会在重启前生效。本次没有重启、没有杀当前 Host。
- `restoreProgressive` 仍只在配置显式为 `true` 时启用；默认安装走普通路径，不碰容量门控。

## 二、10 个缺陷与落点

| # | 评审缺陷 | 修复落点 | 锁定它的测试 |
|---|---|---|---|
| 1 | 旧的 `completed` 结束记录被用来结算计划仍欠的新 turn，导致该继续时被跳过 | `lib/probe.js` `assessSession()`：只有结束 turn 达到 `owedTurn` 才算数；更新的欠账配旧结束 → `unknown` 保留 | `test/round2-probe.test.mjs`：`an older completed end never settles a newer turn the plan still owes` |
| 2 | `blocked` 不分“入队前/入队后”，入队前也不继续、入队后仍重发 | `lib/probe.js`：未准入的 `blocked` 继续；准入后的 `blocked`/`error` 落为单条 `attention`，`continued:true` | `a blocked turn with no admission is continued, because the work never ran`；`a continuation blocked after admission is attention, not another send` |
| 3 | 门控只盯 stream，不盯 turn；工具调用间隙关闭后，稍后启动的模型调用绕过并发上限 | `lib/gate.js` turn 所有权（`track`/`turnOpen`/`turnEnd`/`openTurns`），`index.js` 订阅 `session/event`，`lib/engine.js` 统一 `grant()`；排空等 `openTurns===0`，调用方 `signal` 进入许可等待 | `test/gate.test.mjs`：`a tracked turn keeps a drained gate open so its second model call is still limited`；`closing the gate drains parked requests at the slot budget instead of releasing them together` |
| 4 | 同一个不可读集合第二次按下会吞掉计划，最后的人工入口消失 | `lib/engine.js`：写 `restore.unknown`、`unknownAttempts+1`、逐行 attention，保持 `partial` 且计划留在磁盘 | `test/round2-engine.test.mjs`：二次 unknown 保留计划/人工继续用例；`test/engine.test.mjs` 的 unknown 退休用例改为“保留计划” |
| 5 | 暂停会清掉未被暂停触碰的 goal 的 `pendingRestore`/`armedRevision`，丢掉已武装证明；已武装 goal 二次 re-arm 无检查点 | `lib/engine.js`：未暂停 goal 原样保留；任何尚无 `pendingRestore` 的 goal（含已武装）都先写 pre-arm 检查点 | `test/engine.test.mjs`：`['prepareGoal','goal']` 的二次 re-arm 用例；goal revision 持久化用例 |
| 6 | 维护压缩只 `cancel()` 就报告已暂停，实际仍在写 | `lib/probe.js`：`MAINTENANCE_SETTLE_MS=4000`、75ms 轮询到 `phase.kind` 离开 `maintenance`；超时写入 `maintenanceErrors` 并返回 `partial` | `test/round2-engine.test.mjs`：维护 stop 抛错报错用例；真实 Host：`npm run smoke:maintenance`（11 项，含真实 `maintenance` 相位） |
| 7 | job 交接只在“计划里没有别的会话”时合成，且只在内存里，进程退出即丢 | `lib/engine.js`：按 owner 逐 job 合成 `handoff:'job'` 行，先持久化再交付；同一 owner 只合成一次 | `test/round2-engine.test.mjs`：`a job-only plan hands the obligation to its owner instead of replaying the command`；`the job handoff row reaches the store before its continuation is delivered` |
| 8 | 交接一交付（`restored`）就消费计划，报告和读取记录同时消失；应只由后续“已完成”证明消费 | `lib/engine.js`：交付后计划保持 `partial` 并留行；只有后续按下得到 `skipped` 才消费，先持久化完成计划再删行 | `a handoff the owner already read is spent by the next press, not delivered again` |
| 9 | 重新准入复用同一 request id，官方去重返回 `accepted:true` 却不唤醒会话 | `lib/probe.js` `continuation()`：重试请求 id 加 `.rN`；`lib/engine.js` `recordAdmission()` 解析并持久化 `retry` | `test/round2-engine.test.mjs`：`a re-admission records its retry attempt so the next one gets a fresh request id` |
| 10 | 冷子会话只报“父未挂载”就失败；crash 计划未先按官方 turn end 分类 | `lib/probe.js` `restoreChild()`：冷父有界挂载一次再重试；`classifyCrashPlan()` 在恢复规划前读官方结束记录 | `test/round2-probe.test.mjs`：`restoreChild() mounts a cold parent before declaring the child unrestorable`；crash plan 分类用例 |

附带回归：普通 pause 自己取消 turn 留下的 `aborted` 结束，不能被“谨慎保留”规则误判成不可读。修复按计划来源区分：`source:'pause'` 的 `aborted` 是本次暂停的足迹，继续；crash 来源的 `aborted` 仍保留不自动发送。两组 mock 验收（R01–R03、R06、P1-3、P1-5）重新变绿。

## 三、已有测试能证明

1. 单测：`node --test test/*.test.mjs` → **265 tests / 265 pass / 0 fail**。
2. 静态检查：`npm run audit` → 0 error。
3. mock 验收 A：`node acceptance/run.mjs` → **7 / 7 pass**，覆盖 R01–R13：暂停先落盘再停、冷启动每个欠账只继续一次、恢复中暂停落 `partial`、父子顺序与丢失父只合成一次等。
4. mock 验收 B：`node acceptance/round2.mjs` → **5 / 5 pass**，覆盖中断只继续一次、已完成跳过、已准入不重发、取消失败不报完成、job-only 交接 owner。
5. Host smoke：`npm run smoke:host` → **17 / 17 pass**，真实 HTTP 的 `/state`、`/pause`、`/resume`、guard header、Origin/Host 拒绝、冷启动无恢复。
6. 真实进程崩溃/重启：`npm run smoke:live` → pass；真实 Host + 本地 mock 模型，暂停后 `SIGKILL`、同一 home 重启、恢复一次，断言只收到一条续接、`epoch:1/continuedTurn:2`、无第二条。
7. 真实维护压缩：`npm run smoke:maintenance` → pass；真实 `phase.kind==='maintenance'`、暂停约 100ms 返回 `paused`、`stopped.maintenance.canceled` 落盘、压缩显示 “Compaction cancelled.”、第二次暂停答 `already`。
8. 渐进恢复默认关闭：`test/engine.test.mjs` `the progressive restore stays off unless the setting is explicitly enabled`；`test/engine.test.mjs` 非渐进路径不触门控、忽略启动间隔。

## 四、还需独立证明

以下不是“已有测试失败”，而是当前环境无法诚实地宣称已覆盖，交付说明必须保留：

1. **真实用户模型流下的并发上限**：门控测试用可控 stream 计时；没有用两个真实供应商流验证“稍晚启动的模型调用”被同一 turn 限住。`restoreProgressive` 仍默认关闭，因此本版不把该能力作为默认承诺。
2. **真实 goal API 跨重启恢复**：单测覆盖了 goal 行、revision、pre-arm 检查点和二次 re-arm；没有在真实 Host 上跨 `SIGKILL` 调用官方 goal 服务并确认重新武装。
3. **真实 job owner 唤醒与交接**：单测覆盖按 owner 合成、先落盘、交付后保持 `partial`、下一次 `skipped` 才消费；没有在真实 Host 上让后台 job 被暂停后，观察 owner 会话真正被唤醒并读到交接文本。
4. **真实维护压缩取消的等待窗口**：smoke 观察到真实 `maintenance` 相位和取消结果，但本机 mock 模型下压缩结束很快；4 秒超时分支由单测/可控 fake 覆盖，没有在真实慢压缩上跑满超时。
5. **更深的父子链**：覆盖到冷父一层；多层父链、父会话自身也欠恢复的组合没有真实运行证据。
6. **真实崩溃后所有恢复分支的组合矩阵**：live smoke 证明一条真实 turn 的崩溃/重启/一次续接；10 个缺陷的全部分支由单测和 mock 验收覆盖，不是每一条都跑了真实崩溃。

## 五、复跑与发布身份

复跑命令（在 `/Users/apple/Desktop/DSH/dsh-pause-resume`）：

```bash
node --test test/*.test.mjs
npm run audit
node acceptance/run.mjs
node acceptance/round2.mjs
npm run smoke:host
npm run smoke:live
npm run smoke:maintenance
```

发布身份（发布后核对）：

- npm：`dsh-pause-resume@0.6.9`
- git tag：`v0.6.9`，指向本次发布提交
- GitHub Release：`v0.6.9`
- 安装核对：`npm view dsh-pause-resume version` 与 `curl -s https://registry.npmjs.org/dsh-pause-resume/0.6.9` 的 `version` 均为 `0.6.9`；GitHub Release 与 npm tarball 来自同一棵树。

证据文件：

- `docs/evidence/host-smoke.json`
- `docs/evidence/host-live.json`
- `docs/evidence/host-maintenance.json`
