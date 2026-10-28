# 0.6.2 验收报告：恢复诚实性与崩溃恢复收敛

- 候选版本：`dsh-pause-resume@0.6.2`（`package.json`、`CHANGELOG.md`、证据 JSON 的 `plugin.version` / `packageVersion` 一致）
- 生成时间：2026-10-28 12:14（Asia/Shanghai），最终门禁由 Lead 于 12:15–12:16 复跑并重写对应证据；证据由脚本真实运行写入
- 判定原则：**只写真实执行过的结果**。没跑过、没有证据、依赖真实模型流的，写 unverified 或 fail，不写 pass。
- **当前结论：验收通过（真实 Host 的 4 项 live 行为仍为 unverified，原因见第 4、5 节）。** 3 个验收脚本全部退出码 0，7/7、5/5、16/16；失败注入按预期退出码 1；`node --test` 241/241；`npm run audit` 0 error。

## 1. 复现方式

```bash
cd <repo>
node acceptance/run.mjs                 # 7 个端到端场景：真实 temp 目录 + 真实 store/heartbeat/engine/probe
node acceptance/round2.mjs              # 5 组 0.6.2 契约场景：真实 engine/probe + 可控服务层
node acceptance/host-smoke.mjs          # 隔离 DSH_HOME 的真实 Host 冒烟（本机 DSH 应用，不动 54279）
node acceptance/host-smoke.mjs --self-test-fail   # 失败注入，必须非零退出
node --test test/*.test.mjs
npm run audit
```

三个验收脚本都是失败即非零退出：任一场景失败、任一 `ok:false`、任一 `verdict!=='pass'`、场景数不足，都会 `process.exitCode=1`。证据 JSON 由脚本自己写入，从不手改。

## 2. 本轮真实执行结果

| 项 | 结果 | 退出码 | 证据 |
| --- | --- | --- | --- |
| `node acceptance/run.mjs` | 7 pass / 0 fail | 0 | `docs/evidence/acceptance-run.json` |
| `node acceptance/round2.mjs` | 5 pass / 0 fail（P1-1..P1-5） | 0 | `docs/evidence/round2.json` |
| `node acceptance/host-smoke.mjs` | 16/16 步 ok，verdict `pass`，4 项 live `unverified` | 0 | `docs/evidence/host-smoke.json` |
| `node acceptance/host-smoke.mjs --self-test-fail` | 注入失败 → verdict `fail`（只写自己的文件） | 1 | `docs/evidence/host-smoke-self-test.json` |
| `node --test test/*.test.mjs` | 241 pass / 0 fail | 0 | 终端输出 |
| `npm run audit` | 0 error | 0 | 终端输出 |
| `npm pack --dry-run` | 16 files，82.6 kB（unpacked 286.8 kB） | 0 | 终端输出 |

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

覆盖说明由 `acceptance-run.json` 的 `coverage` 自述：真实模块为 `lib/snapshot.js`、`lib/heartbeat.js`、`lib/engine.js`、`lib/probe.js`；`agents` / `sessionController` / `goals` / `jobs` / `sessionProjections` / `sessionLog` / `subagents` 是脚本化替身。**真实 Host + 活模型流不在 run.mjs 覆盖内**，由 `host-smoke.mjs` 单独验。

### round2.mjs 契约组（真实 engine/probe + 可控服务层）

| 组 | 断言要点 | 结果 |
| --- | --- | --- |
| P1-1 | 活 turn + 持久化证据 ⇒ `continue` 并续跑 | pass（continued 1） |
| P1-2 | 已结束的 turn ⇒ `skip`，未结束 ⇒ `continue` | pass（done=skip, admitted=continue） |
| P1-3 | 恢复中暂停且 cancel 被拒 ⇒ `partial`、interrupted | pass |
| P1-4 | 已续跑的行保留 epoch/turn，不被重复续跑 | pass（epoch 3、turn 9、retained） |
| P1-5 | 只有 stopped job 的计划把 owner 交还（`intent:'continue'`、`handoff:'job'`、消息点名 job） | pass（`partial`、owner 行、continuation 含 j1） |

## 3. 失败注入的隔离性

`--self-test-fail` 运行在同一真实 Host 冒烟流程上，但证据固定写入 `docs/evidence/host-smoke-self-test.json`（`verdict:'fail'`、`selfTest:{injected:true, expectedExitCode:1}`），**不覆盖** `host-smoke.json`。本轮验证顺序：真实 smoke（pass）→ 注入（EXIT=1，只改 self-test 文件）→ 再跑真实 smoke（pass，时间戳更新）。因此“注入失败”与“真实冒烟通过”两件事各有独立、可复核的文件。

## 4. 真实 Host 覆盖范围

`host-smoke.mjs` 在临时 `DSH_HOME` 上启动真实 DSH CLI（自动选空闲端口，不动 54279），驱动真实 HTTP 接口，16 步全部 ok：create-profile、install-plugin、mount-entry、boot、state-after-boot、state-head、state-without-guard-header、foreign-origin-rejected、foreign-host-rejected、pause-idle、pause-idle-again、no-plan-created-by-idle-pause、state-dir、state-after-restart、resume-without-plan、plugin-ready-line。

以下 4 项需要真实模型流，本轮 **unverified**，原因写在 `docs/evidence/host-smoke.json` 的 `live[]` 里，不计入 pass：

1. 崩溃中断的 turn 重启后续跑一次（`crash-turn-backfill`）；
2. 恢复期间进行中的 maintenance compaction 可被取消（`maintenance-compaction-cancellable`）；
3. stopping 状态的 job 在 live 状态里可见（`stopping-job-visible`）；
4. job-only 计划把 owner 会话交还（`job-only-owner-handoff`）。

4 项的共同原因：隔离 smoke profile 没有模型 provider，产不出活 turn；同样的行为已在 `acceptance/round2.mjs` 用可控服务层验证，但那**不是**真实 Host 证据。

## 5. 未验证项与验证边界（不得当成通过依据）

- 真实 Host + 真实模型流的 pause/resume 全链路：本轮刻意不配置 provider、不用凭据，未验。
- 真实 maintenance compaction、真实后台 job 进程在 pause 时的取消时序：仅有可控服务层证据。
- 上述 4 项 live 行为在真实 Host 上仍为 unverified；“round2 全绿”只证明 engine/probe 在可控输入下的行为，不证明真实 Host 的时序。

除这 4 项外，本页无 fail、无脚本报错项；`run.mjs` / `round2.mjs` / `host-smoke.mjs` 的通过均来自本轮真实运行，证据文件时间戳为 2026-10-28 12:15–12:16（Asia/Shanghai），均为 Lead 最终门禁那次运行写出。
