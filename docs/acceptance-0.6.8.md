# 0.6.8 验收记录

本轮回应最近一次只读审阅。结论先说三句：

1. **审阅的树不是当前树**：`main 3ac91bf` / `v0.5.3 (acafd41)` / Release `0.5.2` / 168 测试都是 0.6 之前的快照；审阅时仓库 `main` 是 `b99c637`（0.6.7）、256 测试。审阅对那棵树成立，但不能直接当作当前实现的缺陷清单。
2. **真实存在的入口缺口已补齐**：GitHub Releases 只到 `0.5.12`，而 tag 和 npm 已经是 `0.6.x`。本轮补发 `v0.6.0`–`v0.6.8`，现在 main / tag / Release / npm 指向同一份代码。
3. **审阅的 P1 逐条复核，两处仍有真缺陷，已在本轮修掉**：父会话未挂载时子行永远恢复不了；渐进恢复的 `unguard()` 把排队请求一次性全放。其余各条在当前树已有实现和回归用例（下表逐条给证据）。

## 1. 版本口径核对

| 项 | 审阅所称 | 本轮发布后 |
| --- | --- | --- |
| main | `3ac91bf` | `v0.6.8` 的提交 |
| tag | `v0.5.3` = `acafd41` | `v0.6.8` |
| 最新 GitHub Release | `v0.5.2` | `v0.6.8`（`v0.6.0`–`v0.6.8` 已补齐） |
| npm | 未提 | `dsh-pause-resume@0.6.8` |
| 测试 | 168 pass | 259 pass / 0 fail |

`3ac91bf` 的提交信息是 `Revert "chore: 0.5.3 — author/homepage/bugs 元数据"`，`acafd41` 是 `v0.5.3` 标签 —— 两者都在 0.6.0 之前，不含 0.6.x 的崩溃恢复、Goal、取消、journal 改动。这是审阅结论「只修了一部分」的主要来源。

## 2. 逐条复核

| # | 审阅指出的问题 | 结论 | 证据（用例 / 代码） |
| --- | --- | --- | --- |
| 1 | 崩溃时「无法确认」被写成 skipped/done | 已修（0.6.6/0.6.7） | `test/probe.test.mjs` · `crashPlan() continues the open turn and marks a finished or unprovable one apart`；`test/round2-probe.test.mjs` · `an unknown root row whose log proves the turn was cut in flight is continued, not held forever`；`lib/probe.js` `OWED_END_KINDS` |
| 2 | Goal-only（active+armed）崩溃恢复回归 | 已修（0.6.5） | `test/engine.test.mjs` · `a crash plan that holds only goals still resumes them and never fakes a session`；`test/probe.test.mjs` · `crashPlan() carries armed goals over without faking a pause` |
| 3 | 恢复过程中不能随时暂停 | 已修 | `test/client.test.mjs` · `the page that started a restore can stop it while the Host reports pause`；`test/engine.test.mjs` · `pause() interrupts a running restore, keeps the plan and stops only what started` |
| 4 | 取消信号没有贯穿等待/挂载/result/prompt/success | 已修 | `test/probe.test.mjs` · `restoreSession() stops before admitting when the restore was cancelled`；`test/round2-engine.test.mjs` · `an interrupted restore whose stop throws is partial, keeps the residue and reports it`；`lib/engine.js` `resumeAbort` + 每步 `interrupted()` |
| 5 | 恢复成功记录没有绑定暂停周期和实际回合 | 已修（0.6.5；本轮补写侧用例） | `lib/snapshot.js` `appendJournal` 写 `e`/`t`；本轮新增 `test/engine.test.mjs` · `a restored row is journaled with its pause cycle and the turn it actually opened`；`a pause during a restore gives a restored session a new cycle only while its turn still runs` |
| 6 | 子会话恢复缺少父链依赖，父不在就永远失败 | **本轮修复** | `lib/probe.js` `restoreChild()`：父未挂载时先 `mount(parent)`（有界），再 `waitForAgent`；仍失败则行保持可重试。用例：`test/round2-probe.test.mjs` · `restoreChild() mounts a cold parent before declaring the child unrestorable` |
| 7 | 「三次失败即恢复完毕」把欠账归档 | 已修 | `test/engine.test.mjs` · `a plan that never comes back stays open instead of closing as attention`（超出次数保留 plan、行仍 outstanding） |
| 8 | 已入队但未开始回合被 attention 并清计划 | 已修 | `test/probe.test.mjs` · `an admitted turn that made no progress is unknown, not attention and not pressed twice`；`test/round2-engine.test.mjs` · `an admission recorded during a restore is not lost when the restore ends partial` |
| 9 | 后台任务仍在 `stopping` 却从活动统计消失 | 已修 | `test/round2-probe.test.mjs` · `stop() keeps a job that was still stopping after the pause as a handoff obligation`；`test/round2-engine.test.mjs` · `resume copy follows the job stop state instead of assuming the command died` |
| 10 | Goal checkpoint 未写就 re-arm / 丢意图 | 已修 | `test/engine.test.mjs` · `a goal whose checkpoint cannot be written keeps the plan instead of skipping it`；`a resume that could not checkpoint a goal keeps the restore intent for the next boot` |
| 11 | 渐进恢复 unguard 把 5 个排队请求一起放行 | **本轮修复** | `lib/gate.js`：`unguard()` 改为按槽位排空（`draining` + `finishDrain()`），`abort()` 在排空后关闸。用例：`test/gate.test.mjs` · `closing the gate drains parked requests at the slot budget instead of releasing them together`、`a pause that empties a draining gate closes it instead of parking the next request` |
| 12 | main / tag / Release / npm 不是同一份代码 | **本轮修复** | 补发 `v0.6.0`–`v0.6.8` Release；本版发布后四处一致（见 §4） |

## 3. 本轮改动

- `lib/gate.js`：`unguard()` 不再 `while (queue.length) resolve({free:true})`。加入 `draining` 状态，只按 `started < limit` 逐个放行；队列空且无在跑流才真正关闸。`abort()` 排空后同样收尾，避免下一请求被已结束的批次挡在门外。
- `lib/probe.js`：`restoreChild()` 在父 agent 不在时先尝试 `mount(parent, budget)`（失败不抛），再按原逻辑等待；父最终仍不在才返回可重试的 `failed`。父链不再是「等它自己出现」的隐式假设。
- `test/gate.test.mjs`：原「关闸即全放」用例改写为按槽位排空断言；新增 abort 收尾用例（gate 9 项）。
- `test/round2-probe.test.mjs`：新增冷父挂载用例（28 项）。
- `test/engine.test.mjs`：新增 journal 绑定 epoch+turn 用例（82 项）。
- `package.json` / `package-lock.json` 0.6.8；`CHANGELOG.md` 顶部 0.6.8 条目。

## 4. 本轮真实执行结果

| 项 | 结果 | 退出码 | 证据 |
| --- | --- | --- | --- |
| `node --test test/*.test.mjs` | 259 pass / 0 fail | 0 | 终端输出 |
| `npm run audit` | 0 error | 0 | 终端输出 |
| `node acceptance/run.mjs` | 7 pass / 0 fail，`packageVersion 0.6.8` | 0 | [acceptance-run.json](/Users/apple/Desktop/DSH/dsh-pause-resume/docs/evidence/acceptance-run.json) |
| `node acceptance/round2.mjs` | 5 pass / 0 fail，`packageVersion 0.6.8` | 0 | [round2.json](/Users/apple/Desktop/DSH/dsh-pause-resume/docs/evidence/round2.json) |
| `node acceptance/host-smoke.mjs` | 16/16 步 ok，verdict `pass`，`plugin.version 0.6.8` | 0 | [host-smoke.json](/Users/apple/Desktop/DSH/dsh-pause-resume/docs/evidence/host-smoke.json) |
| `node acceptance/host-smoke.mjs --self-test-fail` | 注入失败 → verdict `fail`，退出码 1（预期） | 1 | [host-smoke-self-test.json](/Users/apple/Desktop/DSH/dsh-pause-resume/docs/evidence/host-smoke-self-test.json) |
| `node acceptance/host-live.mjs` | 14/14 步 ok，verdict `pass`，`plugin.version 0.6.8` | 0 | [host-live.json](/Users/apple/Desktop/DSH/dsh-pause-resume/docs/evidence/host-live.json) |
| `node acceptance/host-maintenance.mjs` | 11/11 步 ok，verdict `pass`，`plugin.version 0.6.8` | 0 | [host-maintenance.json](/Users/apple/Desktop/DSH/dsh-pause-resume/docs/evidence/host-maintenance.json) |

## 5. 仍未验证 / 限制

- 已装入的桌面端 Host 仍运行 0.6.6（进程内 link 加载），要重启一次桌面端才会加载 0.6.8；重启前现网行为不变。
- 父链只补了「父未挂载 → 尝试挂载一次」，没有递归挂载更深祖先；更深的链要等父恢复后的下一轮进入，本轮不声称覆盖。
- 渐进恢复仍默认关闭。本轮只修 `unguard()` 的放行语义，并发能力门 1→2 的时序仍只有单测覆盖，没有真实 Host 压测。
- 现网计划 `crash-1793110217612-12`（16 条 unknown）仍在盘上；`acceptance/replay-unknown.mjs` 只做只读回放，未在真实 Host 重放。
- `docs/acceptance-0.6.7.md` 记录的真实崩溃现场本版没有再复现一遍；本版验证的是同一批回归用例未退化。
