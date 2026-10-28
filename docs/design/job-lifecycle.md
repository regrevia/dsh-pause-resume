# 设计评审：job 生命周期监听

状态：评审稿（未实施）
日期：2026-10-28
适用版本：dsh-pause-resume 0.6.0 / DSH 0.2.1-rc.3
结论一句话：**job 生命周期事件值得监听，但只能用来采集「崩溃前什么在跑」的证据；它不能成为暂停/恢复的义务，也不能变成重启 job 的入口。**

## 1. 要解决的问题

0.6.0 的暂停能停 job（`jobs.kill`），但有三处靠猜：

| 缺口 | 现状 | 后果 |
| --- | --- | --- |
| 崩溃前的 job 残留 | 只有 `running.json` 心跳里的 session/goal 列表，没有 job 明细 | 崩溃后重启，`/state` 只能报「有未知的暂停计划」，无法说出哪些 job 当时在跑 |
| 暂停期间 job 是否真的停下 | `stop()` 轮询 `jobs.get`/`jobs.list`，超过预算记 `stopping` | 进程在轮询窗口内死掉时，记录停在 `stopping`，没有终态证据 |
| 恢复时 job 的结局 | `plan.jobs` 只用于 `summary.jobsStopped`（"stopped, not restarted"） | 无法区分「被暂停正常杀掉」和「随进程消失、可能成为孤儿进程」 |

这不是「加一个 jobs.start」的问题。DSH 的 job 契约明确是**进程内**的：
`dsh-jobs` README「Known Limitations」第一条——`JobSpec.run()` 传的是回调，registry 解析 owner session 背后的活 `Agent`；durable/cross-process backend 必须重做身份、重启、归属、观察语义。同一 README 又写明：进程退出后已持久化的生命周期事件仍可读，**活 job 与输出环不会恢复**。所以本插件的正确姿态是「如实记录 job 因进程死亡而消失」，不是「把 job 拉起来」。

## 2. 事实基础（均为已安装包内的可核对事实）

| 事实 | 证据位置（`app.asar/dsh/node_modules/@deepseek-ai/…`） |
| --- | --- |
| job 注册与结算会写入 owner session 的 durable 事件：`job/registered`、`job/settled` | `dsh-jobs-local/lib/index.js` 的 `recordSessionEvent(job, settlement)`；`data = { jobId, owner, kind, label, startedAt, ...toolCall }`，settled 追加 `{ finishedAt, status, cause, producerReported, detail? }` |
| 事件写在结算提交点、live 订阅者之前；写失败只 warn，不阻断 | 同上，`session.append(...)` 包在 try/catch，注释 "Publish committed facts before live subscribers or completion waiters react" |
| 结算 cause 只有三种：`producer` / `kill` / `teardown` | 同上：`settle(job, outcome, job.settleCause ?? "producer", …)`、`settleCause = "kill"`、`settleCause = "teardown"` |
| 实时 hub 事件类型：`registered` / `stopping` / `output` / `progress` / `settled` / `removed` | 同上 `emit({ type: … })`；`removed` 是唯一「从可见集合消失」的变化 |
| 未结算记录会一直列在 registry 里，直到 owner 销毁、服务销毁或显式 remove | `dsh-jobs` README「Known Limitations」第三条 |
| job 归属是 session 隔离的；`list()` 看不到别人的 owned job，必须按 owner 逐桶读 | `dsh-jobs-local` 的 `assertAccess`；本插件 `lib/probe.js:141-166` 已按这个事实实现 |
| session 事件是一条 append-only 日志，`session.append(type, data)` 提交后通知观察者；持久化由 `ctx.sessionPersistence` 后端提供，`flush()` 是耐久屏障 | `dsh-session` README「Append and derive」；`dsh-session-persistence` README「What the service provides」 |
| 只有被 backend 取得写句柄的 session 才会落盘；agent-loop 是生产环境的取得点 | `dsh-session-persistence` README「Known Limitations」第四条 |

本插件现有可复用点：

- `index.js:241` 已经订阅 `ctx.on('session/event', …)` 做 `watchTurn`，加 job 事件不需要新开传输。
- `lib/probe.js` 的 `listJobs(services, owners)`、`waitJobExit()`、`stop()` 里的 `jobStates`（`stopped` / `stopping` / `stop-failed` / `unknown`）已经是「按 job 记账」的形状，缺的是**跨进程**的那一半。
- `lib/engine.js:551-553` 把 `jobStates` 合并进 plan（`applyJobStates`），`:927` 生成 `summary.jobsStopped`；plan 里已有 `jobs` 字段，**没有** `jobs.start`（全仓 grep 无此调用）。

## 3. 备选方案

| 方案 | 做法 | 优点 | 致命问题 | 结论 |
| --- | --- | --- | --- | --- |
| A. 继续轮询 registry（现状） | 暂停时 `jobs.list`/`jobs.get`，恢复时不管 | 零新依赖，已验证 | 只能看见活进程；崩溃即失明；`stopping` 无终局 | 保留为实时权威，不作为唯一证据 |
| B. 订阅 session 生命周期事件并持久化到 plan/journal | 监听 `job/registered`/`job/settled`，把 jobId→状态写入 journal；hydrate 时读回 | 与 owner session 同一条耐久日志，不需要第二套存储；崩溃后仍可读（有 persistence 后端时） | 事件可能因 append 失败缺失（必须保留「不完整」标记）；无 persistence 后端时不跨进程 | **推荐**，作为证据层 |
| C. 订阅 live hub 事件做快路径 | `ctx.jobs.events.subscribe({owners:'scope'}, handler)` 收 `registered`/`settled`/`removed` | 实时、低延迟、能拿到 `cause`/`awaited` | 纯内存，进程死即无；不能作为恢复依据 | 作为 B 的实时补充，仅用于缩短暂停等待与纠偏 |
| D. 通过 closure/handle 重启 job | 保存 `JobSpec.run` 或产出可重放的命令 | 表面能「继续」 | 契约明确不支持跨进程；run 是闭包，序列化即伪造执行；且与「job 不是 plan 义务」冲突 | **禁止**。不新增 `jobs.start`，不在恢复里重放 job |

评分（1-5，越高越好）：

| 维度 | A | B | C | D |
| --- | --- | --- | --- | --- |
| 暂停正确性 | 4 | 4 | 3 | 1 |
| 崩溃残留可解释性 | 1 | 4 | 1 | 1 |
| 恢复诚实性 | 4 | 5 | 4 | 1 |
| 实现风险 | 5 | 3 | 4 | 1 |
| 与 Host 契约一致 | 4 | 5 | 5 | 1 |

## 4. 推荐设计

分三层，职责不混：

### 4.1 采集层（暂停期间）

在 `createProbe` 已有的 `watchTurn` 旁边加 `watchJob`：

- `ctx.on('session/event', (session, event) => …)`，只认 `event.type === 'job/registered' | 'job/settled'`，且 `event.data.owner === session.id`（事件里 owner 与 session 必须一致，否则丢弃并记一条 warn，不把串台事实写进 plan）。
- 实时 hub（可选 P1）：`ctx.jobs.events.subscribe({ owners: 'scope' }, handler)`（owner 过滤按包内契约），收到 `settled` 时立刻缩短 `waitJobExit` 的轮询；**它只影响等待，不影响记账**。
- 所有采集结果先写 journal，再改内存：`journal/<planId>.jsonl` 追加 `{"k":"j:<jobId>","state":"registered"|"settled","status":…,"cause":…,"at":…}`，复用现有 `noteDiscovered` 的「先持久化再继续」顺序（`lib/engine.js:689` 附近的写失败回滚语义）。

### 4.2 持久层（不新增存储）

不新建 job 状态文件。理由：session 日志已经是 Host 的耐久事实源，plan/journal 是本插件自己的耐久事实源；再加第三份只会制造三方不一致。

- 若宿主挂了 persistence 后端：`job/registered`/`job/settled` 随 session 日志落盘，重启后可读。
- 若没挂：本插件 journal 仍记下了「暂停当时看到过哪些 job」，但跨进程的**结算**读不到——hydrate 必须把这类 job 标成 `unknown`，不允许推断成 `stopped`。

### 4.3 恢复层（hydrate / resume）

hydrate 时**只对上一个 plan 里列出的 session** 做回读（不扫全库）：

1. 读 journal 的 `j:<jobId>` 记录，得到暂停时的 job 集合与最后已知状态。
2. 若有 persistence 后端，打开这些 session 的读句柄，找 `job/registered` 且没有匹配 `job/settled` 的 jobId；`finishedAt`/`status` 以持久化事件为准。
3. 生成 plan 行的 `stopDetail`：
   - 有 settled：`job <id> settled <status> (cause=<cause>) before restart` → 该 job 已正常结束，不进入 residue。
   - registered 无 settled 且进程已重启：`job <id> vanished with the previous process (registered <t>, no settlement)` → 这是**孤儿证据**，不是失败，也不是成功。
   - 读不到（无后端 / 事件缺失 / append 失败过）：保持现有 `unknown`，detail 写 `job <id>: lifecycle record incomplete`。
4. resume **不启动任何 job**；汇总继续放 `summary.jobsStopped`，另外新增 `summary.jobsResidue`（仅证据，不是义务），且不计入 `outstanding`，不阻塞 plan 收尾。
5. `job/settled` 里 `cause === 'teardown'` 的，视为「服务销毁顺带杀掉」，在 detail 中注明，不当成用户暂停的成功证据。

### 4.4 语义矩阵

| 暂停时看到 | 重启后能读到 | plan 记录 | 恢复动作 | 是否阻塞完成 |
| --- | --- | --- | --- | --- |
| running，随后 `kill` 结算 | 是（settled, cause=kill） | `stopped` | 无 | 否 |
| running，进程在轮询窗口内死 | 否（无 settled） | `unknown` + residue detail | 无 | 否，但计入 `attention` 展示 |
| running，服务 teardown 杀掉 | 是（settled, cause=teardown） | `stopped`（detail 注明 teardown） | 无 | 否 |
| 未拥有 / 归属他人 | 可能可见 id | 保持 `stop-failed: owned by another session` | 无 | 否 |
| 无 persistence 后端 | 读不到 | `unknown` + `lifecycle record incomplete` | 无 | 否 |

关键不变量：

- `jobs` 永不成为 plan 的义务：`outstanding` 只数 session/goal 行；job-only plan 继续「恢复即花掉」。
- 任何路径都不调用 `jobs.start`；不伪造 `job/registered`。
- `unknown` 永不降级为 `stopped`/`restored`/`skipped`；未知就是未知，展示在 `attention`。

## 5. 失败模式与降级

| 失败 | 检测 | 处理 |
| --- | --- | --- |
| `session.append` 失败（Host 已 warn） | 事件缺失；journal 有 registered 无 settled 且 session 日志也缺 | 标 `incomplete`，不推断终态 |
| persistence 读句柄打不开/格式版本不认识 | `open(id,'read')` 抛错 | 该 session 的 job 全部 `unknown`，错误写 detail，不中断其他 session 的恢复 |
| 事件 owner 与 session 不一致 | 采集时比对 | 丢弃该事件并 warn，不写 plan |
| job 在暂停后、进程死前才结算 | journal 没有 settled，日志有 | 以日志为准，记 `stopped`，detail 带时间 |
| 同一 jobId 多次 registered（理论上 registry 保证唯一） | journal 出现重复 key | 保留最早 registered、最晚 settled，并记 `duplicate lifecycle record` |

## 6. 测试与验收计划

单元（新增 `test/job-lifecycle.test.mjs`，用现有 fake session event feed，不引入真 Host）：

1. registered 后 settle(kill) → plan 行 `stopped`，summary 有 jobsStopped，无 residue。
2. registered 后进程死（只 replay registered）→ `unknown` + residue，`attention` 增 1，`outstanding` 不变。
3. 无 persistence 后端 → 全部 `unknown`，detail 含 incomplete。
4. owner 不一致事件被丢弃。
5. append 失败注入 → 不抛、不降级。
6. resume 不调用 `jobs.start`（用 spy registry 断言零调用）。

验收（扩展 `acceptance/run.mjs`）：

- R19：脚本化 Harness 里注册 job → 暂停 → 重启 → resume，断言 residue 行存在且 plan 完成、job 未被重启。
- R20：删掉 persistence 后端跑同一场景，断言 `unknown` 与 `incomplete` 文案，不出现 `stopped`。

真实 Host：`acceptance/host-smoke.mjs` 已覆盖「真 Host 挂载 + 路由 + 守卫 + 空闲暂停诚实 + 冷启动 hydrate」；job 真链路还需要一次带模型凭据的 live-work smoke（见第 8 节）。

## 7. 实施顺序与工作量

| 阶段 | 内容 | 预估 |
| --- | --- | --- |
| P0 | `watchJob` 采集 + journal 追加 + hydrate 回读（有后端才做）+ 单测 1/3/4/5/6 | 0.5 天 |
| P1 | 实时 hub 快路径（缩短 waitJobExit）+ 单测 2（需要 fake 事件回放） | 0.25 天 |
| P2 | acceptance R19/R20 + 文档矩阵更新 | 0.25 天 |

本评审**不实施**：不改 `lib/engine.js` 主流程，不升 plan version，不动 `CURRENT_VERSION`（3）。若实施后需要 plan 字段，另行提案 version 4 的迁移与回滚。

## 8. 仍未验证 / 明确不承诺

1. **job 跨进程恢复不存在**，这是 Host 契约限制，不是本项目待办；本设计只保证「如实记录消失」。
2. **桌面 profile 是否挂了能读的 session 持久化后端未验证**：`~/.dsh/profiles/desktop/cordis.patch.yml` 里有 `session-log-deepseek`，但它是 session log 服务，不等于 `sessionPersistence` 读句柄可用；实施前必须在隔离 profile 做一次真实回读 smoke。
3. **`ctx.jobs.events.subscribe` 的真实行为未在隔离 Host 验证**：包内契约存在该订阅面，但 owner 过滤范围与投递时机需一次真实 smoke；设计里它只是可选快路径，缺了不影响正确性。
4. **live-work 暂停在真实 Host 上未验证**：当前环境无模型凭据，`host-smoke` 只能验证空闲路径。需要一次带凭据的验收，届时才能把「真 Host 上 job 在暂停中被 kill 并结算」从「脚本化」升级为「真实」。
5. 本评审不是实施承诺：上面 P0 的代码一行都还没写。
