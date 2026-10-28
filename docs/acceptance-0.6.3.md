# 0.6.3 验收报告：崩溃中断的 turn 在真实 Host 上续跑一次

- 候选版本：`dsh-pause-resume@0.6.3`（`package.json`、`CHANGELOG.md`、5 个证据 JSON 的版本字段一致：`acceptance-run.json` / `round2.json` 用 `packageVersion`，`host-smoke.json` / `host-smoke-self-test.json` / `host-live.json` 用 `plugin.version`）
- 生成时间：2026-10-28 12:38（Asia/Shanghai）；最终门禁由 Lead 在 12:38 于 0.6.3 树上独立复跑，证据文件时间戳与之一致（`generatedAt` 04:38:2x–04:38:39Z）
- 判定原则：**只写真实执行过的结果**。没跑过、没有证据、时序无法稳定复现的，写 unverified 或 fail，不写 pass。
- **当前结论：验收通过。** 4 个验收脚本退出码全为 0：`run.mjs` 7/7、`round2.mjs` 5/5、`host-smoke.mjs` 16/16、`host-live.mjs` 14/14；失败注入按预期退出码 1；`node --test` 241/241；`npm run audit` 0 error。上一版遗留 4 项 live `unverified` 中，`crash-turn-backfill` 本轮由 `host-live.mjs` 转为真实验证，剩 3 项仍未验证（见第 4、5 节）。

## 1. 复现方式

```bash
cd <repo>
node acceptance/run.mjs                 # 7 个端到端场景：真实 temp 目录 + 真实 store/heartbeat/engine/probe
node acceptance/round2.mjs              # 5 组契约场景：真实 engine/probe + 可控服务层
node acceptance/host-smoke.mjs          # 隔离 DSH_HOME 的真实 Host 冒烟（本机 DSH 应用，不动 54279）
node acceptance/host-smoke.mjs --self-test-fail   # 失败注入，必须非零退出
node acceptance/host-live.mjs           # 隔离 DSH_HOME + 本地 mock 模型流的真实 Host 活 turn 验收
node --test test/*.test.mjs
npm run audit
```

四个验收脚本都是失败即非零退出：任一场景失败、任一 `ok:false`、任一 `verdict!=='pass'`、场景数不足或断言数不足，都会 `process.exitCode=1`。证据 JSON 由脚本自己写入，从不手改。

## 2. 本轮真实执行结果

| 项 | 结果 | 退出码 | 证据 |
| --- | --- | --- | --- |
| `node acceptance/run.mjs` | 7 pass / 0 fail | 0 | `docs/evidence/acceptance-run.json` |
| `node acceptance/round2.mjs` | 5 pass / 0 fail（P1-1..P1-5） | 0 | `docs/evidence/round2.json` |
| `node acceptance/host-smoke.mjs` | 16/16 步 ok，verdict `pass`，3 项 live `unverified` | 0 | `docs/evidence/host-smoke.json` |
| `node acceptance/host-smoke.mjs --self-test-fail` | 注入失败 → verdict `fail`（只写自己的文件） | 1 | `docs/evidence/host-smoke-self-test.json` |
| `node acceptance/host-live.mjs` | 14/14 断言 ok，verdict `pass`，`crash-turn-backfill` → `live.status:"verified"` | 0 | `docs/evidence/host-live.json` |
| `node --test test/*.test.mjs` | 241 pass / 0 fail | 0 | 终端输出 |
| `npm run audit` | 0 error | 0 | 终端输出 |

### run.mjs 场景（真实 `lib/engine.js` + `lib/probe.js` + 真实文件 store/heartbeat）

| 场景 | 断言要点 | 结果 |
| --- | --- | --- |
| R01–R03 | pause 先落盘再停；冷启动把欠的每个 turn 各续一次 | pass（落盘 2 行、续跑 2 个） |
| R04–R06 | 崩溃残留只恢复一次；第三次启动找不到工作 | pass（restored 2） |
| R06 | 恢复中按暂停且会话拒绝停止 ⇒ `status:'partial'`、`complete:false`、attention>0 | pass（保留 1 行、attention 2） |
| R07 | 无法落盘的 pause 不停任何东西 | pass（`reason:'store'`） |
| R08–R10 | 没有 turn 证据的计划行被挂起，不伪装成 restored | pass（`partial`） |
| R13 | 只有 job 的计划以“job 已停、未重启”收尾 | pass（`partial`） |
| R11–R12 | 父级路由决定恢复顺序；丢失的父级只补一次 | pass（顺序 `r1→c1`、`partial`） |

覆盖说明由 `acceptance-run.json` 的 `coverage` 自述：真实模块为 `lib/snapshot.js`、`lib/heartbeat.js`、`lib/engine.js`、`lib/probe.js`；`agents` / `sessionController` / `goals` / `jobs` / `sessionProjections` / `sessionLog` / `subagents` 是脚本化替身。**真实 Host + 活模型流不在 run.mjs 覆盖内**，由 `host-smoke.mjs` 与 `host-live.mjs` 分别验证。

### round2.mjs 契约组（真实 engine/probe + 可控服务层）

| 组 | 断言要点 | 结果 |
| --- | --- | --- |
| P1-1 | 活 turn + 持久化证据 ⇒ `continue` 并续跑 | pass（continued 1） |
| P1-2 | 已结束的 turn ⇒ `skip`，未结束 ⇒ `continue` | pass（done=skip, admitted=continue） |
| P1-3 | 恢复中暂停且 cancel 被拒 ⇒ `partial`、interrupted | pass |
| P1-4 | 已续跑的行保留 epoch/turn，不被重复续跑 | pass（epoch 3、turn 9、retained） |
| P1-5 | 只有 stopped job 的计划把 owner 交还（`intent:'continue'`、`handoff:'job'`、消息点名 job） | pass（`partial`、owner 行、continuation 含 j1） |

### host-live.mjs 场景（真实 Host + 本地 mock 模型流）

`acceptance/host-live.mjs` 在临时 `DSH_HOME` 上组合 `--from-default-profile web` 的隔离 profile，用 `cordis.patch.yml` 把 `agent-default-model` 与 `llm-pi-ai` 指向 `acceptance/mock-llm.mjs`（OpenAI 兼容 `/v1/chat/completions` SSE，OS 分配端口），再由一个一次性 spike 插件通过公开的 `agents.create` + `agent.followup` 路径起一个**真实 running turn**——与 `dsh headless` 同一条链路，不改 `lib/`、不改已安装插件。14 个断言全部 ok：

| 断言 | 验证内容 | 结果 |
| --- | --- | --- |
| `profile-created` / `plugin-installed` / `model-overridden` | 隔离 profile 建好、插件装上、模型覆盖为 mock | ok |
| `host-ready` / `live-turn-running` | 真实 Host 起在 OS 分配端口；mock 首个请求被挂住，turn 持续 running | ok |
| `paused-with-plan` | HTTP `POST /pause`（带 `x-dsh-pause-resume: 1`）返回 `paused`，计划记录 1 个 session、1 outstanding | ok |
| `crashed` | 对 Host 发 **SIGKILL**（无优雅退出），模拟崩溃 | ok |
| `host-ready` / `plan-survived-crash` | 同一 `DSH_HOME` 重启后 plan 仍在：phase `paused`、1 session、1 outstanding | ok |
| `resumed` | 重启后 `POST /resume` 返回 `status:'resumed'`，summary 行 status `restored` | ok |
| `continuation-request` | mock 收到**第二个 turn 请求**（n=3、`messages:8`，且携带原 turn 文本），证明是续跑而不是重放首轮 | ok |
| `exactly-once` | 全程 turn 请求恰好 2 个（首轮 + 续跑；另有 1 个标题生成请求，`messages:2` 不计入），无重复续跑 | ok |
| `restore-record` | 落盘 `pause-resume/restores/<planId>.json` 只有 1 份：`sessions[0] = {sessionId, running:true, intent:'continue', epoch:1, lastTurn:2, continuedTurn:2}`，summary 行 `restored / "resumed and continued"` | ok |
| `model-text-in-session` | 会话转录（zstd 分帧）里确有 mock 回包 `MOCK_LLM_OK`，证明续跑的模型输出被持久化 | ok |

## 3. 失败注入的隔离性

`--self-test-fail` 运行在同一真实 Host 冒烟流程上，但证据固定写入 `docs/evidence/host-smoke-self-test.json`（`verdict:'fail'`、`selfTest:{injected:true, expectedExitCode:1}`），**不覆盖** `host-smoke.json`。本轮验证顺序：真实 smoke（pass）→ 注入（EXIT=1，只改 self-test 文件）→ 再跑真实 smoke（pass，时间戳更新）。因此“注入失败”与“真实冒烟通过”两件事各有独立、可复核的文件。`host-live.json` 不受注入影响，它不读取该注入开关。

## 4. 真实 Host 覆盖范围

`host-smoke.mjs` 在临时 `DSH_HOME` 上启动真实 DSH CLI（自动选空闲端口，不动 54279），驱动真实 HTTP 接口，16 步全部 ok：create-profile、install-plugin、mount-entry、boot、state-after-boot、state-head、state-without-guard-header、foreign-origin-rejected、foreign-host-rejected、pause-idle、pause-idle-again、no-plan-created-by-idle-pause、state-dir、state-after-restart、resume-without-plan、plugin-ready-line。

`host-live.mjs` 补上了 smoke 无法覆盖的“活 turn”一节：真实的 pause → SIGKILL → 重启 → resume 链路，模型流由本地 mock 提供（只作模型替身，不改变 Host 的 pause/resume 逻辑）。`crash-turn-backfill` 因此从 `unverified` 变为 **verified**（`docs/evidence/host-live.json` 的 `live.status:"verified"`），验证方式即第 2 节表格：真 turn → HTTP pause → SIGKILL → 重启 → resume → mock 恰好收到一次续跑（`messages:8` 带原 turn 文本）→ 落盘 `epoch:1 / lastTurn:2 / continuedTurn:2` → 无重复续跑。

以下 3 项本轮仍为 **unverified**，不计入 pass：

1. **`maintenance-compaction-cancellable`**——“恢复期间进行中的 maintenance compaction 可被取消”：隔离 profile 里没有可触发的会话压缩工作负载，mock 模型流也不会产生 compaction；`round2.mjs` 里用可控服务层验证了 engine 的取消分支，但那是替身证据。
2. **`stopping-job-visible`**——“stopping 状态的 job 在 live 状态里可见”：隔离 profile 里没有可运行的作业可制造 stop，且“stop 进行中”的窗口是毫秒级时序，验收里无法稳定复现该瞬间；同样的可见性断言只在 `round2.mjs` 的可控服务层里成立。
3. **`job-only-owner-handoff`**——“只有 job 的计划把 owner 会话交还”：同上，没有真实 job 可用于制造 job-only 计划；`round2.mjs` P1-5 的 handoff 证据是可控服务层，不是真实 Host。

这 3 项的共同原因（写在 `docs/evidence/host-smoke.json` 的 `live[]` 里）：隔离 smoke/live profile 里没有可用的 compaction / job 工作负载，相关时序也无从稳定复现，因此宁可保持 unverified，也不拿替身证据冒充真实 Host 通过。

## 5. 未验证项与验证边界（不得当成通过依据）

- `host-live.mjs` 的模型流是**本地 mock**（OS 分配端口、临时 `DSH_HOME`、不读写真实 `~/.dsh`、不碰 54279）；它证明 Host 侧的 pause / 崩溃 / 重启 / resume 与“恰好一次续跑”，不证明真实模型供应商的流式行为。
- 真实 maintenance compaction、真实后台 job 进程在 pause 时的取消时序：仍只有可控服务层证据，见第 4 节 3 项。
- 上述 3 项 live 行为在真实 Host 上仍为 unverified；“round2 全绿”只证明 engine/probe 在可控输入下的行为，不证明真实 Host 的时序。
- 真实 `~/.dsh` 用户 profile 与本机 GUI 端口 54279 全程未被读写或占用。

除这 3 项外，本页无 fail、无脚本报错项；`run.mjs` / `round2.mjs` / `host-smoke.mjs` / `host-live.mjs` 的通过均来自本轮真实运行，证据文件时间戳见各 JSON 的 `generatedAt`。
