# 阶段 E：父链与 job 交接证据（commit f8bcb15）

- **已修复**：心跳残留记录每个运行中子会话的 `parent`，crash plan 优先使用该记录、运行期遗忘时回退；暂停计划为每个 job 记录 `stop`/`stopDetail`（`stopped`/`stopping`/`stop-failed`/`unknown`），恢复中暂停也走同一映射；旧残留没有 parent 仍可读。
- **验证场景**：`test/probe.test.mjs` 的 parent 保留、`listResidue` 记录、jobStates 缺 jobs 服务；`test/heartbeat.test.mjs:408` 的 v4 往返；`test/engine.test.mjs` 的三级父链、缺失父合成 mount-only、循环父图、hydrate 保留旧 job 行、interruptResume 应用 jobStates。
- **实际观察**：修复前 crash 残留只有 `{sessionId,lastTurn}`，重启后子会话只能当根挂载，其子会话永远等父；修复后验收场景里 `c2.parent==='c1'` 且父先于子恢复。job 的 `stopped` 结果进入计划文件，而不是只出现在内存摘要里。
- **剩余问题**：崩溃残留只含 sessions/goals，不含 jobs；进程死亡时在跑的 job 无法被下一次启动命名。hydrate 合并保留旧 plan 的 job 行，但不从残留重建 job 行。job 不能被 Host 重放（没有启动闭包），续跑消息只是请求 turn 自行重启，未在真实 Host 上做端到端验证。
- **下一阶段**：确认渐进恢复保持默认关闭（阶段 F），然后冻结、打包、交付。
