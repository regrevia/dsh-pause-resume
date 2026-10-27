# 阶段 D：旧计划读取（commit 9534366）

- **已修复**：0.2.x 计划只从旧 `running` 标志取一次 intent，且不替未声明 intent 的行发明声明；恢复依赖的元数据（`epoch`、`continuedTurn`、`admittedRequest`、`admittedEpoch`、`pendingRestore`、`armedRevision`、`retry`）经过真实写入/读取/重写不变；0.1.x 计划每次读到同一个 journal 文件。
- **验证场景**：`test/snapshot.test.mjs` 的版本迁移、metadata 保真、journal 命名；`test/engine.test.mjs` 的 hydrate 迁移分支。
- **实际观察**：迁移测试证明，同一份旧文件经过两次读取得到相同计划，重试不会变成第二次恢复同一行。
- **剩余问题**：0.1.x 计划没有 `version: 3` 的 status 概念，只能按迁移规则当成 `paused`，无法区分「当时是干净暂停还是部分停止」。
- **下一阶段**：子代理父链与 job 交接证据（阶段 E）。
