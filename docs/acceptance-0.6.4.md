# 0.6.4 验收记录

本轮验收针对「暂停与恢复可靠性收敛」的收尾能力：把 maintenance（压缩）纳入停止面，并让一个「只能重复自己」的崩溃恢复计划收尾。版本号、断言结果、证据文件全部由脚本自己写入，从不手改。

## 1. 方法与边界

- 每个门禁用**真实进程、真实文件、真实 HTTP**：`acceptance/host-*.mjs` 用隔离的 `DSH_HOME` 起一个自己的 Host，从不触碰正在用的 GUI（127.0.0.1:53344）。
- 唯一替身是模型：Host 侧门禁用一个本地 OpenAI 兼容 mock（`acceptance/mock-llm.mjs`），并且实测值里把「哪部分是替身」写清楚（mock 的 `contextWindow` / `maxTokens`、mint 的 token、是否 held）。
- `host-smoke.mjs --self-test-fail` 只写自己的 `host-smoke-self-test.json`，失败注入不污染真实证据。
- 所有门禁失败即非零退出（无 `|| true`）；`verdict` 由脚本从步骤结果推导，不由人写。

## 2. 本轮真实执行结果

| 项 | 结果 | 退出码 | 证据 |
| --- | --- | --- | --- |
| `node --test test/*.test.mjs` | 243 pass / 0 fail | 0 | 终端输出 |
| `npm run audit` | 0 error | 0 | 终端输出 |
| `node acceptance/run.mjs` | 7 pass / 0 fail | 0 | `docs/evidence/acceptance-run.json` |
| `node acceptance/round2.mjs` | 5 pass / 0 fail（P1-1..P1-5） | 0 | `docs/evidence/round2.json` |
| `node acceptance/host-smoke.mjs` | 16/16 步 ok，verdict `pass`，3 项 live 行标注 `unverified`（其中 maintenance 行指向 `smoke:maintenance`） | 0 | `docs/evidence/host-smoke.json` |
| `node acceptance/host-smoke.mjs --self-test-fail` | 注入失败 → verdict `fail`，只写自己的文件 | 1 | `docs/evidence/host-smoke-self-test.json` |
| `node acceptance/host-live.mjs` | 14/14 断言 ok，verdict `pass` | 0 | `docs/evidence/host-live.json` |
| `node acceptance/host-maintenance.mjs` RUN1 | 11/11 步 ok，verdict `pass`，`plugin.version 0.6.4` | 0 | `docs/evidence/host-maintenance.json` |
| `node acceptance/host-maintenance.mjs` RUN2 | 11/11 步 ok，verdict `pass`（连续两轮共 22 次断言全绿） | 0 | 同上（覆盖写，两轮都过） |

### host-maintenance 关键实测值（RUN2）

- 真实 maintenance 阶段：`observedPhases ["idle/idle","running/running","idle/idle","maintenance/idle"]`，读的是 `agent.phase.kind === 'maintenance'`；summarization 请求 n=6、`held:false`。
- pause 响应：`{"status":"paused","counts":{"sessions":1,"goals":0,"jobs":0},"outstanding":1}`，`pauseMs=101`。
- 计划落盘：`snapshot.json` 里 `stopped.maintenance = {"canceled":["spike-maintenance"],"errors":[]}`；`plan.sessions` 只有持有 turn 的会话，压缩目标会话不在 `sessions[]` 里 —— 停止面里 sessions 与 maintenance 分开记录。
- 取消真正生效：`compact-settled {"kind":"error","text":"Compaction cancelled."}` 同刻回到 `phase idle/idle`；第二次 pause 返回 `{"status":"already","phase":"paused"}`，`secondPauseMs=2`，`live.sessions=0`。
- 11 步全部 ok：`profile-created` / `plugin-installed` / `model-overridden` / `host-ready` / `holder-turn-observed` / `turn-finished` / `maintenance-observed` / `paused` / `maintenance-canceled-apart` / `maintenance-cleared` / `pause-not-waiting`。

## 3. 场景矩阵

### run.mjs（真实 `lib/engine.js` + `lib/probe.js` + 真实文件 store/heartbeat）

| 场景 | 断言要点 | 结果 |
| --- | --- | --- |
| R01–R03 | pause 先落盘再停；冷启动把欠的每个 turn 各续一次 | pass（落盘 2 行、续跑 2 个） |
| R04–R06 | 崩溃残留只恢复一次；第三次启动找不到工作 | pass（restored 2） |

### round2.mjs（可控服务替身，补 Host 门禁进不去的边角）

| 场景 | 断言要点 | 结果 |
| --- | --- | --- |
| P1-1 | 部分停止的结果被如实合并，`partial` 带 `stopped` 明细 | pass |
| P1-2 | 新计划到达时，未完成的旧工作不丢 | pass |
| P1-3 | 恢复进行中按暂停：中断恢复而不是发布假结果 | pass |
| P1-4 | 崩溃残留每一行只恢复一次（journal 去重） | pass |
| P1-5 | 只含后台 job 的计划把 owner 会话交还一次 | pass（替身，见第 5 节） |

### host-smoke（真实 Host，路由与状态机）

16 步覆盖：`GET`/`HEAD /state`、无按钮头的读取、伪造 `Origin`/`Host` 403、空闲 pause 连按两次如实 `idle` 且不落盘、冷启动 hydrate `idle` 且不恢复、无计划 resume 返回 `empty`、只读接口不产生副作用等。verdict 由步骤结果推导。

### host-live（真实 Host + 本地 mock 模型流）

paused 一个真实 turn → `SIGKILL` → 同 home 重启 → resume 一次：mock 恰好收到 1 次续跑，携带原 turn 文本（`carriesTurnText:true`），计划行落在 `epoch:1, lastTurn:2, continuedTurn:2`，没有第二次续跑（`duplicateContinuation:false`）。14/14。

### host-maintenance（真实 Host 上取消真实压缩）

见第 2 节实测值：pause 在 ~100 ms 内返回 `paused`，实数 `phase.kind==='maintenance'` 被观测到并随后回到 `idle`，取消错误文本与 `stopped.maintenance.canceled` 对上，第二次 pause `already` 不再做任何事。

## 4. 本轮修掉的问题（0.6.3 → 0.6.4）

1. **maintenance 不是停止面**：`workOf()` / `liveWorkCount()` / `describe().live` 都不算在飞的压缩，所以只有压缩在跑时 pause 返回 `{status:"idle",action:"none"}`，压缩继续跑。现在 compression 计入 live work，单独一路取消：不落计划（压缩不可恢复），结果带 `maintenance.canceled/errors`，失败如实 `partial`；混合计划继续用 `plan.stopped.maintenance`。
2. **只能重复自己的恢复计划**：「崩溃后所有行都 `unknown`」的计划每次按播放都重读同一批不可读 turn，`attempts` 不增、计划不消费、按钮永远承诺同一个恢复。现在第一次按仍记录精确的 unknown 集合并保留计划（晚些结算或新 boot 可能让它可读）；第二次按若集合完全一致且什么都没启动，计划以 `partial` 收尾，这些行转为 `attention`（圆点与「open the session to decide」仍在），按钮回到 `none`。没有任何行被报成 restored/skipped/failed。
3. `host-smoke` 的 `maintenance-compaction-cancellable` 行不再只说「不可验证」，而是指向新的真实门禁证据。

## 5. 仍未验证的项（如实列出）

| 项 | 状态 | 原因 |
| --- | --- | --- |
| `stopping-job-visible`（停止中的 job 在 live 状态里可见） | unverified | 当前离线 Host 没有可运行的 job；停止窗口是毫秒级，没有稳定可观测的中间态。 |
| `job-only-owner-handoff`（只含后台 job 的计划交还 owner 会话一次） | unverified（替身） | 真实 Host 造不出「只含 job」的计划；只在 round2 P1-5 用可控服务替身覆盖。 |
| 渐进恢复（progressive restore） | 默认关闭 | 按要求排在核心恢复能力之后；容量门限本轮未执行。 |
| maintenance 门禁的模型部分 | 替身 | 本地 OpenAI 兼容 mock（`contextWindow 8000` / `maxTokens 256`）；Host 进程、文件、HTTP 都是真的。 |

`host-smoke.json` 里的 3 条 `live` 行保持 `unverified` 只表示「本门禁不覆盖」，其中 `crash-turn-backfill` 由 `host-live`、`maintenance-compaction-cancellable` 由 `host-maintenance` 在真实 Host 上验证；剩下两条就是上表前两行。

## 6. 复现

```bash
npm test
npm run audit
node acceptance/run.mjs
node acceptance/round2.mjs
npm run smoke:host          # 真实 Host（隔离 DSH_HOME）
npm run smoke:host -- --self-test-fail   # 期望退出码 1
npm run smoke:live          # 真实 Host + 本地 mock 模型
npm run smoke:maintenance   # 真实 Host：取消在飞压缩
```

`host-*` 门禁都会自建临时 `DSH_HOME` 并在结束时清理；不会读写正在使用的 GUI 的 `~/.dsh`。
