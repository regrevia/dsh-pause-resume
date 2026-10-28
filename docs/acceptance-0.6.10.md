# 0.6.10 验收记录：异常中断的发现与一次“继续”

结论：0.6.10 在 0.6.9 的暂停/恢复基础上新增“自行停下的任务”账本和一次继续入口。正常完成、被暂停取消、受阻的 turn 不会变成待继续项；供应商报错和模型达到输出上限会变成一条可继续项，但只有人按下 ↻ 才会发送，插件不会自动重试。单测、三组 mock 验收和三项真实 Host smoke 均通过。真实 Host 进程仍是 0.6.6，磁盘上的 0.6.10 在重启前不生效；本次没有重启、没有杀当前 Host。

## 一、版本边界

- 公开基线是 0.6.9（提交 `0da039c`）。本版是它的后继，未把 0.6.9 已确认的修复重新算作新增。
- 新增能力只有一件：发现“不是人停的、也不是正常结束”的最新 turn，并在按下按钮时继续当前可见的一批。
- 暂停、崩溃恢复、子会话恢复、job 交接、goal 恢复、渐进恢复（仍默认关闭）走原路径，未被本版改写。
- 0.6.10 同时收敛了同一棵树里尚未发布的恢复可靠性问题（见第五节），它们有各自测试，不依赖继续功能。

## 二、什么会成为待继续项

账本独立于暂停计划，落在 `$DSH_HOME/pause-resume/continue.json`，最多 40 行，不进入 `pending.json`，不会触发任何取消。

| 最新 turn 的结束方式 | 结果 | 理由 |
|---|---|---|
| `error` | 候选 | 官方 `dsh-llm-retry` 已耗尽重试，工作没有完成 |
| `max-tokens` | 候选 | turn 被输出上限截断，任务可能未完成 |
| `completed` | 清除 | 正常结束 |
| `aborted` | 清除 | 人为暂停、父会话取消、hook 或 disposed；人手停的不算异常 |
| `interrupted` | 清除 | 已有恢复语义接管 |
| `blocked` | 清除 | 准入前是 work 未运行，不属于本账本；准入后是 attention |

另外两条硬边界：

1. 只有最新 turn 是候选且其后没有新的 `turn/start` / `turn/end` 才算数；旧错误不会在正常重开后复活。
2. 带 `parentSession` 或 `origin === 'subagent'` 的会话整类排除。子会话的停止由父会话的 tool result 回答，直接继续子会话会写进没人看的对话。

## 三、继续流程

1. 客户端轮询 `/state`；`engine.describe().action` 为 `none` 且账本有可见行时，装饰成 `action: 'continue'`，并使用 ↻ 和带数量的提示。
2. 按下只发 `POST /dsh-pause-resume/continue`。路由重新读取装饰后的状态：不是 `continue` 就返回 409（暂停/恢复占着按钮、或批次正忙）；是才调用 `ledger.continueAll()`。
3. `continueAll()` 只取当前可见行，标记 `running`，以 2 个 worker 并发执行。每行先重读最新 turn end，再检查会话是否已打开、是否为子会话、goal 是否 active、会话是否已消失；通过后以合成计划 `source: 'continue'`、`allowAbnormalEnd: true` 调 `probe.continueSession()`。
4. 一行成功继续后若又出现更新的候选结束，保留该行等待下一次人工按压；继续后正常完成则清除。批次返回 `{status, attempted, continued, remaining, attention, results}`。
5. 同一行失败不会被自动重发。下一次按压重新判定，`attempt` 递增；失败行保留给用户。

## 四、按钮与接口

- `action` 仍只有一个：`pause` / `resume` / `continue` / `busy` / `none`，由服务器决定，客户端不自行推断。
- `GET/HEAD /state` 在有待继续项时附带 `pendingContinue`；`POST /continue` 需要 `x-dsh-pause-resume: 1` 请求头，缺头 403。
- 按钮形状：暂停 ⏸、恢复 ▶、继续 ↻、忙时 spinner。继续使用重试箭头而不是播放三角，避免“恢复我暂停的”和“继续它自己停的”看起来是同一个动作。
- 提示文案只给数量与是否需要处理（例如“2 个任务中断，点击继续”），不暴露 provider、重试策略、账本文件名。中文文案通过 `ui-restraint`、`zh-ui-type-lint`、`style-lint`。

## 五、同树收敛的可靠性问题

这些不是 0.6.10 的新用户功能，但和本次发布一起交付，测试锁定在各自的文件：

| 问题 | 修复落点 | 锁定测试 |
|---|---|---|
| 恢复门控只按 stream 放行，prompt 同步发出的 `turn/start` 未被计数，drain 提前关闭 | `lib/gate.js` 批次作用域 + `reserve/abandon`；`index.js` 在 prompt 前预留；晚到的 start 在有界窗口内重开门控 | `test/gate.test.mjs`、`test/apply.test.mjs` 的 reservation / late-start / unrelated-session 用例 |
| 暂停自己造成的 `aborted` 被当成上游失败并触发冷却 | `streamOutcome()` 区分 full-consumption 的上游 abort 与调用方取消；暂停不记 strike | `test/gate.test.mjs` `a full-consumption aborted caused by our own pause...` |
| job 交接一交付就被消费；旧 completed 被当成已读证明 | `lib/engine.js` 的 `handoffPhase: pending/delivered/completed`，交付不等于确认，重启后重新对账 | `test/round2-engine.test.mjs` 五条 handoff 生命周期用例 |
| goal 的 pending restore 用的是旧 revision，写检查点失败后意图丢失 | 用当前 revision 重新武装；无法持久化时保留跟踪并报 `partial` | `test/round2-engine.test.mjs` stale goal 三条用例 |
| heartbeat 慢一圈时，较新的未闭合 turn 被跳过；冷子会话的裸日志被当成 running | 以 durable log 的 start/end 边界为准；冷子会话继续而不是报 running | `test/round2-probe.test.mjs` heartbeat / cold root / cold child / skip 重读用例 |
| 等待中的 job reader 在暂停后被 late settlement 唤醒 owner | pause 时把 awaited reader 停住 | `test/round2-probe.test.mjs` parked-reader 用例 |

## 六、已有测试能证明

1. 单测：`node --test test/*.test.mjs` → **311 tests / 311 pass / 0 fail**。
2. 静态检查：`npm run audit` → 0 error。
3. mock 验收 A：`node acceptance/run.mjs` → **8 / 8 pass**。新增 R14 用真实 `createLedger` + 真实 `lib/probe.js` + 脚本化 Host：一个 `error` turn 出现 1 条待继续项，一次 `continueAll()` 只发 1 条消息、批次归零，第二次按压返回 `empty` 且不再发送。
4. mock 验收 B：`node acceptance/round2.mjs` → **5 / 5 pass**，覆盖 job 交接、恢复中暂停、已准入不重发等既有语义。
5. Host smoke：`npm run smoke:host` → **18 / 18 checks pass**，真实 HTTP 额外验证 `/continue` 缺 guard 头 403、无待继续项时 409 且 `outcome.status === 'empty'`。
6. 真实进程崩溃/重启：`npm run smoke:live` → pass（14 checks）。
7. 真实维护压缩取消：`npm run smoke:maintenance` → pass（11 checks）。
8. 文案检查：`client.js` 的 `ui-copy-lint`、`zh-lint` 均为 0 error；`style-lint` 0 error。

## 七、还需独立证明

以下不是“测试失败”，而是本机当前条件无法诚实宣称已覆盖：

1. **真实供应商报错后的继续**：R14 与单测使用结构化 `turn/end error` 事件，未让真实 provider 在官方重试耗尽后返回 502/限流并观察账本落行；也未经真实 Host 的 `session/event` 总线验证标题缓存。
2. **真实 `max-tokens` 继续**：单测覆盖候选判定，没有让真实模型跑到输出上限再按 ↻。
3. **真实 Host 进程崩溃后的账本恢复**：`continue.json` 的加载/归一化有单测（`running` → `waiting`、损坏文件保留），没有在真实 Host `SIGKILL` 后验证同一账本再次出现并可继续。
4. **真实 UI 点击**：客户端通过静态检查与路由测试，未在真实 Harness Web GUI 里点 ↻ 验证 glyph、tooltip 和 409 收口。
5. **并发上限**：`continueAll()` 用 2 个 worker；测试是脚本化 prompt，没有两个真实供应商流同时继续的并发证据。
6. **真实 goal API 跨重启恢复、真实 job owner 唤醒、深父子链**：与 0.6.9 验收记录相同的未覆盖项仍然成立，本版未新增真实环境证据。
7. **本机生效版本**：当前 Host 进程仍是 0.6.6；磁盘上的 0.6.10 需要重启 Host 才生效。本记录不声称已在运行进程里验证。

## 八、复跑与发布身份

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

- npm：`dsh-pause-resume@0.6.10`
- git tag：`v0.6.10`，指向本次发布提交
- GitHub Release：`v0.6.10`
- 安装核对：`npm view dsh-pause-resume version` 与 registry 的 `0.6.10` 元数据 `version` 一致；GitHub Release 与 npm tarball 来自同一棵树。

证据文件：

- `docs/evidence/acceptance-run.json`
- `docs/evidence/round2.json`
- `docs/evidence/host-smoke.json`
- `docs/evidence/host-live.json`
- `docs/evidence/host-maintenance.json`
