# 0.6.5 验收记录

本轮只解决一件事：**按下播放时，只影响还没继续的那些会话**。一个人先手动继续了两条、崩溃前还有三条没动，按下播放必须是「两条不碰、三条照旧对待」，而不是把已经在跑的再续一次、或者把它们的注意力灯继续挂着。

## 1. 方法与边界

- 门禁仍是真实进程、真实文件、真实 HTTP（`acceptance/host-*.mjs`，隔离 `DSH_HOME`，不碰正在用的 GUI `127.0.0.1:53344`）；唯一替身是本地 mock 模型，并在证据里标明。
- 失败即非零退出，`verdict` 由脚本从步骤结果推导；`host-smoke.mjs --self-test-fail` 只写自己的文件。
- 本轮新增的行为先由 `test/probe.test.mjs` / `test/engine.test.mjs` 的可控服务替身覆盖，再跑全部真实门禁确认没有回归。

## 2. 本轮真实执行结果

| 项 | 结果 | 退出码 | 证据 |
| --- | --- | --- | --- |
| `node --test test/*.test.mjs` | 247 pass / 0 fail | 0 | 终端输出 |
| `npm run audit` | 0 error | 0 | 终端输出 |
| `node acceptance/run.mjs` | 7 pass / 0 fail | 0 | `docs/evidence/acceptance-run.json` |
| `node acceptance/round2.mjs` | 5 pass / 0 fail | 0 | `docs/evidence/round2.json` |
| `node acceptance/host-smoke.mjs` | 16/16 步 ok，verdict `pass`，`plugin.version 0.6.5` | 0 | `docs/evidence/host-smoke.json` |
| `node acceptance/host-smoke.mjs --self-test-fail` | 注入失败 → verdict `fail`，只写自己的文件 | 1（预期） | `docs/evidence/host-smoke-self-test.json` |
| `node acceptance/host-live.mjs` | 14/14 步 ok，verdict `pass`，`plugin.version 0.6.5` | 0 | `docs/evidence/host-live.json` |
| `node acceptance/host-maintenance.mjs` | 11/11 步 ok，verdict `pass`，`plugin.version 0.6.5` | 0 | `docs/evidence/host-maintenance.json` |

## 3. 手动继续过的会话：逐行隔离

场景：崩溃留下 5 行 `unknown`，其中 2 行已被人工继续（进程里确实在跑），3 行仍无证据。按播放后的行为：

| 行 | 旧行为（0.6.4） | 0.6.5 行为 |
| --- | --- | --- |
| 人工继续、正在跑（2 行） | 仍判 `unknown` → 注意力 +1，并可能让计划以 `partial` 收尾、把活着的会话列成「需要看一眼」 | `restored` / `already running`，**不发消息、不打断 turn**，也不进 unknown 集合 |
| 没动过、仍不可读（3 行） | `unknown`，计划保留 | `unknown`，计划保留，注意力按行列出 |
| 计划进度 | 每次按都把「已 restored 的行」算成新进度，于是永远收不了尾 | 进度对比上一次的 unknown 集合：集合变小才算进度；人工继续一次＝进度（计划保留），此后集合不变才收尾 |

实现位置：

- `lib/probe.js`：`intent === 'unknown'` 分支先看 `agent.status === 'running'`，在跑就直接回 `outcomeOf('already running', true, lastTurn, 'running')`，不进入 unknown 路径；`continue` 分支在提交 prompt 前再读一遍 agent，窗口期被人工继续就不再发第二条（避免重复续跑）。
- `lib/engine.js`：收尾判定从「restored+skipped > 0」改成「相对上一轮 unknown 集合是否变小」；注意力由 `attentionRow()` 保留每行主体（`kind/id/detail`），`describe()` 只对 restore 行的 running 会话摘灯；`plan.source === 'crash'` 的部分恢复用逐行注意力替换捕获时的「N sessions need a look」计数，避免数字过期。
- 停止面注意力（`would not stop` 这类）**不带** restore 标记，即使对应 job/session 仍在跑也不会被自动摘掉——它描述的正是「还在运行」这件事。

## 4. 竞态

| 竞态 | 处理 | 是否声称原子 |
| --- | --- | --- |
| 人工继续发生在「评估」和「提交」之间 | 提交前最后一次 `agentOf` 重读，running 即放弃提交 | 否，窗口仍在 |
| 同一行被两次按播放/两次续跑 | requestId 由 `planId:continue:sessionId:retry` 派生；已 admitted 不重发；提交后看 turn 证据 | 否，靠去重与证据 |
| 人工继续发生在「最后一次重读」与「prompt 入队」之间 | Harness 没有 compare-and-admit，无法做到零窗口 | **明确不声称**，列为剩余限制 |
| 两次按播放并发 | 引擎独占锁，第二次得到 `busy`；暂停可中途打断恢复（`interrupted`），不发布假结果 | 是（进程内） |
| 收尾时注意力重复 | `dedupeRows` 按 `kind|id|detail` 去重；同一行重试不叠加 | 是 |

## 5. 仍未验证 / 剩余限制

- `host-live` 验证的是「暂停 → SIGKILL → 重启 → 恢复一次」，**没有**在真实 Host 上复现「人工继续两条 + 播放」这一多行场景；该场景目前只有可控服务替身的单测（`test/engine.test.mjs` 的三次按压用例）覆盖。这是本轮最大的未验证项，不写成已通过。
- 播放期间人工继续与 prompt 入队之间的亚秒窗口仍然存在（第 4 节）；requestId 去重、admitted 守卫、提交前重读、提交后 turn 证据只能收窄，不能消除。要消除需要 Harness 提供 compare-and-admit。
- 一个 `unknown` 行如果被人工继续后**已经跑完**，下一次按播放仍报 `unknown`（崩溃记录没有该 turn 的 baseline，本进程只能看到结束记录时存在歧义），收尾后进入注意力，由人决定。这是有意的保守：宁可让人看一眼，不把「可能没跑」写成 restored。
- `stopping-job-visible`、`job-only-owner-handoff` 仍是替身覆盖，未在本轮改动范围内。
- 渐进恢复默认关闭，行为未变。
