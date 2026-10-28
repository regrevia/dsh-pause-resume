# 0.6.2 修复契约（engine / probe / acceptance 分工）

基线 `v0.6.1` / `e8fa55a`。目标：评审列出的四组 P1 与后台任务、maintenance、持久化、验收缺陷。
文件所有权：`lib/engine.js` 只有 engine-owner 改；`lib/probe.js` 只有 probe-owner 改；`acceptance/*` 只有 acceptance-owner 改。跨文件需求走本契约，不直接改对方文件。

## 1. probe 的新证据接口（probe-owner 实现，engine-owner 调用）

```js
// 判断一条待恢复 session 现在到底欠不欠一次续跑。root 与 child 共用，分流只决定怎么调用。
async function assessSession(session, { plan } = {}) => {
  action: 'skip' | 'mount' | 'continue' | 'unknown',
  turn: number | null,
  end: 'completed' | 'interrupted' | 'aborted' | 'error' | 'blocked' | 'open' | null,
  admitted: boolean,      // 本 epoch 的 continuation 已经在官方队列里
  mounted: boolean,
  detail: string,
}
```

规则（必须按官方结束原因判定，不看 turn 数字是否变大）：
- `end === 'completed'`：`skip`（正常完成，不重跑）。
- `end === 'interrupted'`：`continue`（崩溃补写的 turn/end 不是完成；恢复义务保留）。
- `end === 'error' | 'aborted' | 'blocked'`：`unknown`（需要人看，不伪造完成，也不自动续跑）。
- `end === 'open'`：`continue`；若该 turn 是本 epoch 已 admission 的，返回 `admitted: true`，不重复投递。
- 无结束记录且无打开 turn：`unknown`，不猜。
- `turn/end` 的 reason 读取顺序：本进程事件订阅缓存 → 持久化会话日志（zstd JSONL，按需只读尾部）→ `null`。读不到就是 `unknown`，不许降级成 `skip`。
- `restoreSession`（root）与 `restoreChild` 都必须在发送任何 continuation 之前调用 `assessSession`；`skip` 一律返回 `{status:'skipped'}`，`unknown` 返回 `{status:'unknown'}`，`admitted:true` 返回 `{status:'restored', detail:'already admitted'}` 且不再入队。child 不再直接续跑。
- child 追加去重：plan 里该 child 的 `admittedRequest` 与当前 epoch 一致且消息仍在队列时，不投递第二条。

## 2. engine 的合并与迁移（engine-owner 实现）

- `mergeStopResult(result, plan)`：普通暂停与 `interruptResume()` 共用的唯一归并入口；合并 `canceled/stillRunning/unknown/pausedGoals/goalErrors/killedJobs/jobErrors/jobStates/maintenance` 后写盘。任何 `stillRunning.length || unknown.length || goalErrors.length || jobErrors.length` ⇒ `status:'partial'`、`phase:'paused'`、`attention>0`，`complete:false`；只有全空才 `status:'paused'`/`complete:true`。
- Goal：暂停后把官方返回的**确切 revision** 写入 plan（`pausedGoals` 归并），同一操作内清除上一轮 `pendingRestore`/`armedRevision`；每次 resume/rearm 前先落盘本次 `pendingRestore:{revision, expect, at}`，历史 `armedRevision` 不能替代本次记录。revision 校验不放宽。
- `hydrate()`：以旧 plan 的未完成义务为基底合并 heartbeat。session 行保留 `epoch/continuedTurn/admittedRequest/admittedEpoch/retry/intent/lastTurn`；heartbeat 缺某项只标记 `unseen` 并保留，不删行；Goal 取旧 plan ∪ 新 heartbeat，旧 plan 中未完成的 Goal（含 disarmed/active 但 revision 未达成）保留并标 `unseen`；迁移只为旧格式补字段，不每次重建。
- `unknown` 挂载后重判：挂载成功且 `assessSession` 返回可判定原因时改用新 verdict；只有仍无证据才保留 `unknown` 并留在 plan。
- `recordAdmission` 与后续写盘必须操作同一个 plan 对象；`partial` 结果写盘不得带旧 plan 副本（禁止用 hydrate 前的对象整体覆盖）。写失败保留内存 fallback。
- 续跑消息的 job 段落只依据 `job.stop` 结果：`stopped` 才可写已停止；`stopping` 写“正在停止”；`stop-failed/unknown` 写“仍可能运行，请先检查”，不得写成已停止。job-only 计划：恢复时生成 owner 交接义务（owner session 行 `intent:'continue'` 且 `handoff:'job'`，附带 job id/命令/最后输出摘要），不再“恢复即消费”。

## 3. 验收（acceptance-owner）

- `acceptance/run.mjs`：删除 `|| true` 与任何恒真断言；R06 等注入 `stillRunning` 的场景必须断言 `status:'partial'`、`complete:false`、`attention>0`；run 结果必须 `passed+failed===7`，失败时退出码 1。
- `acceptance/host-smoke.mjs`：任一 step `ok===false` ⇒ `process.exitCode=1`；新增失败注入自测（可用 `--self-test-fail` 或环境变量）证明失败会非零退出；新增 maintenance 取消、stopping job 可见、job-only 交接、interrupted 续跑四类断言。
- 新增 `acceptance/round2.mjs`：真实临时文件 + 未修改的 `lib/engine.js`/`lib/probe.js` + 可控 mock 模型流，覆盖评审四组 P1 的复现脚本；证据写 `docs/evidence/round2.json`。
- 所有命令都要有界；Host 用空闲端口 + 临时 `DSH_HOME`；不得访问 54279 或读取凭据。

## 4. 共同约束

- 渐进恢复保持默认关闭，不改默认值。
- 不跳过断言、不清除失败任务、不放宽 revision 校验、不把 `unknown` 当成功。
- 完成后 `node --test test/*.test.mjs`、`node acceptance/run.mjs`、`node acceptance/round2.mjs`、`npm run audit` 全绿；失败项写进验收报告“未验证项”，不得隐藏。
