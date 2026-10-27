# 阶段 B：turn 证据与 admission 去重（commit 7e831c7）

- **已修复**：续跑是否完成由 `turn/start`、`turn/end`、open-turn 起始判定，不再只看 phase 计数；已 admit 的请求 id 在等待 turn 前写入行内，重启后等待而不是再按一次。
- **验证场景**：`test/engine.test.mjs` 与 `test/probe.test.mjs` 的 turn 边界、admission 重放、`turnRig` 相关用例；`test/integration.test.mjs` 的 admitted-then-restart 场景。
- **实际观察**：仅改 phase 计数时，已完成但计数未前进的 turn 会被再次续跑；改后已结束的 turn 跳过，open turn 报 restored，admitted 未开始的请求不会被发第二遍。
- **剩余问题**：Host 若在 `turn/start` 与持久化之间崩溃，仍只能依赖请求 id 去重，不能证明消息体未重复。
- **下一阶段**：处理恢复进行中按暂停的周期语义（阶段 C）。
