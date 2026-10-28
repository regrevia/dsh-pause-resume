# 0.6.6 验收记录

本轮只做两件「特殊情况」，都是 0.6.5 记录在案的剩余项：

1. 一个 `unknown` 行被人手动继续并**已经跑完**，过去每次按播放都还报 `unknown`，直到收尾才进注意力。
2. 子会话行过去不看 `intent`：`skip` 的子行在没有任何结束证据时会被发一条续跑，`unknown` 的子行同样会被猜着发。

## 1. 方法与边界

- 门禁与 0.6.5 相同：真实进程、真实文件、真实 HTTP（`acceptance/host-*.mjs`，隔离 `DSH_HOME`，不碰正在使用的 GUI `127.0.0.1:53344`）；唯一替身是本地 mock 模型，证据里标明。
- 本轮行为先由 `test/round2-probe.test.mjs` 的可控服务替身覆盖（含真实 zstd 会话日志），再跑全部真实门禁确认无回归。
- 失败即非零退出。
- 提交进仓库的证据 JSON 经 `acceptance/redact.mjs` 去掉本机绝对路径（仓库路径→`<repo>`，家目录→`<home>`，临时目录→`<tmp>`），其余内容逐字保留；生成的 spike 源码例外，它只写进临时 `DSH_HOME`。

## 2. 本轮真实执行结果

| 项 | 结果 | 退出码 | 证据 |
| --- | --- | --- | --- |
| `node --test test/*.test.mjs` | 252 pass / 0 fail | 0 | 终端输出 |
| `npm run audit` | 0 error | 0 | 终端输出 |
| `node acceptance/run.mjs` | 7 pass / 0 fail，`packageVersion 0.6.6` | 0 | `docs/evidence/acceptance-run.json` |
| `node acceptance/round2.mjs` | 5 pass / 0 fail，`packageVersion 0.6.6` | 0 | `docs/evidence/round2.json` |
| `node acceptance/host-smoke.mjs` | 16/16 步 ok，verdict `pass`，`plugin.version 0.6.6` | 0 | `docs/evidence/host-smoke.json` |
| `node acceptance/host-smoke.mjs --self-test-fail` | 注入失败 → verdict `fail`，只写自己的文件 | 1（预期） | `docs/evidence/host-smoke-self-test.json` |
| `node acceptance/host-live.mjs` | 14/14 步 ok，verdict `pass`，`plugin.version 0.6.6` | 0 | `docs/evidence/host-live.json` |
| `node acceptance/host-maintenance.mjs` | 11/11 步 ok，verdict `pass`，`plugin.version 0.6.6` | 0 | `docs/evidence/host-maintenance.json` |

新增 5 个断言用例：根行 2 个（服务证据、持久化 zstd 日志各一），子行 3 个（`skip` 不发、`unknown`+完成证据转注意力、`unknown` 但正在跑转 `already running`）。

## 3. 手动继续并跑完的行

`lib/probe.js` 的根行 `intent === 'unknown'` 分支：先按 0.6.5 判断正在跑（`restored` / `already running`）；否则用 `assessSession()` 读官方结束证据，最新 end 为 `completed` 时返回

```
{ status: 'attention', detail: 'a turn completed after the crash; confirm the paused work was part of it', continued: false, turn }
```

`attention` 是终态：该行记进 journal、进入注意力，下次按播放不再重复报同一行；**不发任何续跑**。证据来自本进程观察、官方 `sessionLog.readTurnEnds`、或落盘 JSONL 尾部，三条路径等价（各有用例）。end 不是 `completed` 时保持原样：`unknown` + 「open the session to decide」，计划保留。

## 4. 子会话行与根行同一条规则

`restoreChild()` 现按 `intent` 先分流，再读证据：

| 子行 intent | 旧行为 | 0.6.6 |
| --- | --- | --- |
| `skip` | 直接 `assessSession()`；无证据 → 发一条 queue 续跑 | `skipped`，不发消息 |
| `unknown`，最新 end `completed` | 发续跑 | `attention`（同上文案），不发消息 |
| `unknown`，正在跑 | 发续跑（可能重复） | `restored` / `already running`，不发言 |
| `unknown`，无证据 | 发续跑 | `unknown`，计划保留，不发消息 |
| `continue` | 不变（证据判 `skip`/`admitted`/续跑） | 不变 |

向后兼容：`intent` 缺失且 `session.running === true` 时按 `continue` 处理，与旧计划一致。

## 5. 仍未验证 / 剩余限制

- `host-live` 仍是「暂停 → SIGKILL → 重启 → 恢复一次」；「老进程里人工继续两条 + 按播放」的多行场景只有可控替身单测（`test/engine.test.mjs`），未在真实 Host 复现，不写成已通过。
- 0.6.5 记录的亚秒竞态不变：人工继续与 prompt 入队之间没有 compare-and-admit；requestId 去重、admitted 守卫、提交前重读、提交后 turn 证据只能收窄。
- 会话在崩溃与按播放之间被删除/找不到：挂载失败仍报 `failed` 并保留该行，重试同一条错误；没有可靠办法区分「会话不存在」和「日志暂不可读」，因此本轮不改，不把猜测写成结论。
- `stopping-job-visible`、`job-only-owner-handoff` 仍是替身覆盖。
- 渐进恢复默认关闭，行为未变。
