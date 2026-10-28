# 0.6.11 验收记录：把“还能继续”和“按暂停能截断”做实

结论：0.6.11 是 0.6.10 的可靠性收口版，不新增按钮、不新增自动行为。上一轮评审指出的三个 P1
（再次失败后按 ↻ 发不出消息；批量继续中按暂停只停住已发出的请求；准入归属靠猜）和四个次级问题
（job 交付证明、冷会话 goal、过期 goal 检查点、异常继续绕过渐进门控）都已落到代码与测试；账本另
加了只读的 `blocking` / `actionable` 分类，供页面区分“按一下可能好”和“得先处理上游”。全部单测、
mock 验收、真实 Host smoke 均通过。真实 Host 进程仍是 0.6.6，磁盘版本重启后才生效；本次没有重启、
没有杀当前 Host。

## 一、版本边界

- 公开基线是 0.6.10（提交 `766b468`）。本版是它的后继，0.6.10 已交付的账本与一次继续入口不重复计算。
- 用户可见行为只有两处，且都朝“不丢工作”方向：
  1. 同一任务再次失败后，下一次按 ↻ 仍然能发出消息，不再因为结束事件缓存形状不一致而整行读不出来。
  2. 批量继续中点暂停，取消的是整个批次；排队中的行不会再被取走，按钮也不会在批次结束前被第二次继续占用。
- 其余改动不改变单次按压语义：一次按压仍然继续当前可见的**全部**行，失败行保留待下次按；`blocking`
  只是标签，不隐藏、不跳过、不改成第二次队列。
- 暂停、恢复、崩溃恢复、子会话恢复、job 交接、goal 恢复、渐进恢复（仍默认关闭）走原路径。

## 二、三个 P1

### ① 再次失败后仍然可以继续（不丢行）

代码：`lib/probe.js` 的结束事件缓存统一为 `{type:'turn/end', data:{turn, reason:{kind}}}` 一种形状，
`endOfEvent()` 同时服务首次失败、重试失败、`max-tokens`；`lib/ledger.js` 的 `normalize()` 不再把
可读行降级成不可读。

锁定测试：

- `test/ledger.test.mjs` — `a continuation that stops again stays for the next press at its new turn`：
  turn 3 error → 按压继续 → turn 4 再次 error，第二次按压仍然发出消息，行停在新 turn 上。
- `test/ledger.test.mjs` — `a failed press keeps the row for the next one, with no automatic retry`：
  失败不自动重发，行保留、`attempt` 递增。
- `test/round2-probe.test.mjs` — `an in-process stop observed after the request returns stays continuable, and completion stays closed`：
  prompt 返回后异步到达的 error 进入缓存，第二次仍读到 `end: 'error'` 并可继续；随后 completed 关闭，不再发第三条。
  这条直接锁住“缓存里是字符串、读取方按对象取 kind”的错位。

### ② 批量继续中的暂停截断后续任务

代码：`index.js` 的 `/pause` 在暂停计划落盘后调用 `ledger.cancel()`，再 `gate.abort()`，最后
`ledger.drain()`；`lib/ledger.js` 的 `mapLimit()` 在取下一行前检查批次令牌，取消后不再启动新行，
`continueAll()` 返回 `cancelled:true` 与已发出的 `started` 列表。取消与 `/pause` 共用同一个信号，
不存在“暂停只停住当前请求、队列继续跑”的第二条路径。

锁定测试：

- `test/ledger.test.mjs` — `a pause cancels the running batch and no queued row starts after it`：
  批次进行中取消，后续排队行一个都不启动，`cancelled === true`。
- `test/ledger.test.mjs` — `one press is one batch; a second press while it runs is refused`：
  批次未结束时第二次按压被拒，不会另起一批绕过取消。
- `test/apply.test.mjs` — `a pause press owns the button, so continuing waiting work is refused`：
  路由层同样拒绝，状态与账本一致。

### ③ 准入归属不再靠猜

代码：`lib/engine.js` 的 `ownsAdmission(sessionId)`（导出，测试可直接断言）只承认本实例计划行里
记录的 `admittedRequest`；`lib/probe.js` 的准入记录与重试走同一份计划对象，不再用“看起来像已准入”
推断。跨窗口、旧进程残留、只读心跳都不会被误认成本次重试，因此不会重复发送。

锁定测试：

- `test/engine.test.mjs` — 准入归属断言段：`engine.ownsAdmission('s1') === true`，
  `engine.ownsAdmission('s9') === false`。
- `test/engine.test.mjs` — `a pause during a restore keeps an unstarted admission in the same cycle`。
- `test/round2-engine.test.mjs` — `a re-admission records its retry attempt so the next one gets a fresh request id`。

## 三、四个次级可靠性问题

| 问题 | 修复落点 | 锁定测试 |
|---|---|---|
| job 交付“没发也算已交付” | `lib/engine.js` 交接证明要求本次恢复真的产生过 `requestId`；`already running`、纯挂载、已准入但无请求都不置 `delivered` | `test/round2-engine.test.mjs` — `a handoff is not marked delivered without proof that this restore sent a request`；`test/round2-probe.test.mjs` — 交付轮次与旧 completed 的两条用例 |
| 冷会话挂载后才看得见的 goal | `lib/probe.js` 的 `restoreSession()` 挂载后重读 goal；可读则按当前 revision 重新武装；读不出时按 `attention` 处理（该分支尚无单独测试，见第五节） | `test/round2-probe.test.mjs` — `restoreSession() re-arms a cold goal it can only see after attaching the session` |
| 过期 goal 检查点永远卡住 | 用当前 revision 对账后重写 `pendingRestore`；写失败保留意图并报 `partial` | `test/round2-engine.test.mjs` — stale goal 两条用例（可对账 / 不可对账） |
| 异常继续绕过渐进门控 | `index.js` 的 `/continue` 仅在 `options.progressive === true` 时 `guard()`，`finally` 必 `unguard()`；抛错路径同样关闭 | `test/apply.test.mjs` — `the continue press runs inside the progressive gate and always closes it`（返回后与抛错后都断言 `gate.enabled() === false`） |

另外，账本的只读分类：

- 代码：`lib/ledger.js` 的 `PERMANENT_CODE`、`blockingOf()`、`describe()`；`index.js` 的
  `stateOf()` 把 `blocking` / `actionable` 汇总进 `pendingContinue`。
- 语义：`status === 'attention'` 或错误码命中鉴权/权限/额度/模型不存在/上下文超长等永久类错误 →
  `blocking`；其余 → `actionable`。两数相加等于 `count`，任何行都不会被隐藏。
- 锁定测试：`test/ledger.test.mjs` 两条（永久 vs 瞬时；attention 再次展示仍 blocking）、
  `test/apply.test.mjs` — `failed work stays readable while another batch runs, and is pressable once it ends`
  （批次 `busy` 时仍能看到 2 行、`blocking:1` / `actionable:1`；批次结束一次按压有效）。

## 四、门禁结果（本工作树）

| 门禁 | 结果 |
|---|---|
| `node --test test/*.test.mjs` | **321 / 321 pass，0 fail** |
| `npm run audit` | **0 error** |
| `node acceptance/run.mjs` | **8 / 8 pass**，R01–R14 |
| `node acceptance/round2.mjs` | **5 / 5 pass**，P1-1–P1-5 |
| `npm run smoke:host` | **18 / 18 checks pass** |
| `node acceptance/host-smoke.mjs --self-test-fail` | **exit 1**（失败不会被吞成 0） |
| `npm run smoke:live` | **14 / 14 pass**（暂停 → SIGKILL → 重启 → 只续一次） |
| `npm run smoke:maintenance` | **11 / 11 pass**（维护相位取消） |

证据文件已由本次运行刷新在 `docs/evidence/`：`acceptance-run.json`、`round2.json`、`host-smoke.json`、
`host-live.json`、`host-maintenance.json`。失败自检记录是 `host-smoke-self-test.json`。

## 五、这版没有证明的

1. **真实供应商连续两次报错后的继续**：单测用结构化结束事件覆盖两次失败，没有让真实 provider 在
   官方重试耗尽后连续返回两次 502 再按 ↻。
2. **真实 Host 进程崩溃后的账本恢复**：`continue.json` 的加载/归一化有单测，没有在真实 Host
   `SIGKILL` 后验证账本再次出现并可继续。
3. **真实 UI 点击**：`blocking` / `actionable` 只进了 `/state`，客户端文案未改，也没有在真实 GUI
   里点 ↻ 验证。
4. **两个真实供应商流同时继续的并发证据**：`continueAll()` 仍是 2 个 worker，测试是脚本化 prompt。
5. **真实 goal API 跨重启恢复、真实 job owner 唤醒、深父子链**：与 0.6.10 记录相同的未覆盖项仍成立。
6. **冷会话 goal 读不出的 attention 分支**：代码会把读不出的 goal 降级为 `attention` 而不是猜 revision，
   但没有一条测试把 `goals.get` 打桩成抛错来断言这条路径。
7. **本机生效版本**：当前 Host 进程仍是 0.6.6；磁盘上的 0.6.11 需要重启 Host 才生效。
