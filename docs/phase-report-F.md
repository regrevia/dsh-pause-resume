# 阶段 F：渐进恢复默认关闭（无独立 commit，随 0.6.0 验证）

- **已修复**：无需改代码——`index.js` 只在 `config.restoreProgressive === true` 时安装 `llm/stream` 与 start gap；`createEngine()` 的 `progressive` 默认 `false`。本阶段补上测试，锁住「未显式开启即普通路径」。
- **验证场景**：`test/engine.test.mjs` 新增「the progressive restore stays off unless the setting is explicitly enabled」：不传 `progressive` 时 `describe().restore.progressive===false`，resume 全程 gate 的 `guard/unguard/abort` 均为 0；另有 `:1308` 显式 `progressive:false` 用例。
- **实际观察**：默认路径不触碰容量 gate，也不应用 start gap；渐进批处理只在显式配置后 `restore.active` 为 true。
- **剩余问题**：渐进路径只在 engine 层用 stub gate 验证；没有在真实 Host 上做容量 gate 冒烟，且该能力仍排在核心恢复能力之后。
- **下一阶段**：冻结 0.6.0，完成 R01–R18 验收与打包检查后交付；渐进恢复保持 opt-in，不进入本版默认路径。
