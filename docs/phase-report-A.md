# 阶段 A：存储协议（commit d2216e8）

- **已修复**：`snapshot.normalize()` 不再把新 probe 生成的 `unknown` / `skip` 降级成 `mount`；声明的 intent 优先于旧的 `running` 标志，未知键原样保留。
- **验证场景**：`test/snapshot.test.mjs` 中 unknown/skip 往返、旧 v1/v2 计划迁移、journal 文件名稳定；`test/engine.test.mjs` 中「已声明 intent 不被第二次读取改写」。
- **实际观察**：升级前，快照里 12 行 `intent:'unknown'` 在读取时全部变成 `mount`，恢复会把无法证明的工作当成已挂载；升级后同一份文件读回的 intent 与写入一致。
- **剩余问题**：`skip` 行仍需要一个能证明「无需继续」的来源；旧 bare-id 计划没有 turn 信息，只能保守地保留原判。
- **下一阶段**：把「恢复判定」从 phase 计数换成 turn 边界证据（阶段 B）。
