# 0.6.7 验收记录

本轮修一个从真实使用里报出来的缺陷：Host 崩溃后重启，按播放键**按钮会动、但没有工作真的重启**。

## 1. 现场

- 崩溃：桌面端日志 `crash-2026-10-28T09-23-22-876Z-host.log`，`host exited with 1`，栈顶 `TypeError: this.holding is not a function`，来自另一个插件 `dsh-inner-browser-use` 的 `sidecar.js:743:20`（`this.holding is not a function`）。桌面端因此重启了 Host（`bootId` 90362），并留下了崩溃计划。
- 插件状态 `/state`：`phase:"paused"`、`error:"restore-partial"`、`attention:14`、`outstanding:11`、`restore.active:false`，11 条 `result.unknown[]` 全是「turn state unknown; open the session to decide」。
- 计划 `crash-1793110217612-12` 有 16 条 `intent:"unknown"` 行；人的每次按播放都只改了按钮相位，没有任何 `prompt` 被发出。

## 2. 根因（两个叠加的门）

崩溃后的 `unknown` 行由 `restoreSession()` 的 `intent === 'unknown'` 分支处理。当时它只认两种证据：

1. `agent.status === 'running'` → `restored` / already running；
2. `assessSession()` 判 `skip`（最新 end 为 `completed`）→ 终态 `attention`；
3. 其余一律 `{ status: 'unknown', detail: 'turn state unknown; open the session to decide' }`。

但崩溃把回合切在半路时，官方证据是 `interrupted`（或 `blocked`），既不是 `completed`，也不是「没有证据」。这类行指向的正是**同一件被欠下的续跑**，`intent:"continue"` 的行一直按这个语义恢复，`unknown` 行却被第 3 条挡在 `prompt` 之前。于是：按钮相位从 `paused` 变成 `pausing`/`resuming`（引擎确实在恢复计划），行却永远留在 `unknown`，计划只能停在 `paused`/`restore-partial`，`restore.active:false` —— 与实际运行状态不一致。

第二个门在续跑提交之后：`prompt()` 返回后有一次 durable backfill 重读证据。它把提交前就已存在的那个 `interrupted` end 当成「刚提交的这轮已经结束且被中断」，返回 `interrupted` + `continued:false`，行保持可重试；下一次按播放会再发同一条续跑。

## 3. 修复

`lib/probe.js`：

- 新增 `OWED_END_KINDS = new Set(['interrupted', 'blocked'])`。`unknown` 行读到的最新 end 属于该集合时，交出 `knownContinue`，走与 `continue` 行相同的恢复路径（发续跑、按 admitted/推进/运行中逐项判断）。
- `aborted`（人主动停止）与读不到 end 的证据**不**进这条路径，保持保守：前者不是欠账，后者是没有证据，两者都不该被当成「没活可干」。
- 「回合在计划停止期间推进过」的守卫只在 end **不是**切在半路时保留该行；切在半路说明没人把它做完，续跑仍然欠着。
- post-submit backfill 只在 end **比提交前证据更新**时才把它算作本轮续跑的结束，避免把崩溃证据重复记成续跑结果。

## 4. 本轮真实执行结果

| 项 | 结果 | 退出码 | 证据 |
| --- | --- | --- | --- |
| `node --test test/*.test.mjs` | 256 pass / 0 fail | 0 | 终端输出 |
| `npm run audit` | 0 error | 0 | 终端输出 |
| `node acceptance/run.mjs` | 7 pass / 0 fail，`packageVersion 0.6.7` | 0 | `docs/evidence/acceptance-run.json` |
| `node acceptance/round2.mjs` | 5 pass / 0 fail，`packageVersion 0.6.7` | 0 | `docs/evidence/round2.json` |
| `node acceptance/host-smoke.mjs` | 16/16 步 ok，verdict `pass`，`plugin.version 0.6.7` | 0 | `docs/evidence/host-smoke.json` |
| `node acceptance/host-smoke.mjs --self-test-fail` | 注入失败 → verdict `fail`，退出码 1（预期） | 1 | `docs/evidence/host-smoke-self-test.json` |
| `node acceptance/host-live.mjs` | 14/14 步 ok，verdict `pass`，`plugin.version 0.6.7` | 0 | `docs/evidence/host-live.json` |
| `node acceptance/host-maintenance.mjs` | 11/11 步 ok，verdict `pass`，`plugin.version 0.6.7` | 0 | `docs/evidence/host-maintenance.json` |

新增 4 个回归用例（`test/round2-probe.test.mjs`）：

- `unknown` + 服务证据 `interrupted`、回合已越过计划基线 → 发一条续跑，`restored`；
- 同上，但证据只存在于真实 zstd 会话日志尾部（没有 end 服务）→ 同样续跑；
- `unknown` + 最新 end `aborted` → 仍 `unknown`，一条都不发；
- 提交后 backfill 不得把提交前的 `interrupted` 报成「continuation turn ended as interrupted」。

## 5. 真实计划回放（只读诊断）

`node acceptance/replay-unknown.mjs`：读现网 `~/.dsh/pause-resume/pending.json`，用只记录、不执行的 controller 跑一遍恢复路径，回答「这一按会发几条续跑」。

修复前：16 条 unknown 行（15 根 + 1 子），`prompt` 发出 0 条（全部在 `prompt` 前被 `unknown` 短路）。
修复后（同一份计划，2026-10-28）：15 条根行 → **8 条会发续跑**、7 条按 `completed` 证据走 `attention`（终态，不重复报）。行数与 earlier `16` 的差值来自其中 1 条是子会话行（`parent` 非空），根行回放不计；对子行的规则未在本轮改动。

## 6. 仍未验证 / 剩余限制

- 回放是「会发什么」的证据，不是「已发出去」的证据：真实 Host 里已装入的插件是 `link:` 指向本仓库，需要重启一次 Host 才会加载 0.6.7 的 `lib/probe.js`。重启前现网仍是 0.6.6 行为。
- 提交后的 `waitForTurn` 仍依赖可见的回合证据（running / lastTurn 前进）。若续跑被接受但宿主在结算窗口里没有露出任何可见回合，行会如实停在 `unknown`（计划保留），不会被报成已恢复；这条 0.6.5 记录的观察窗口仍未在真实 Host 覆盖。
- 崩溃日志里的 `sidecar.js` 异常属于 `dsh-inner-browser-use`，不是本插件；本轮只把它作为「崩溃场景来源」引用，没有修它。
- 渐进恢复默认关闭，行为未变。
