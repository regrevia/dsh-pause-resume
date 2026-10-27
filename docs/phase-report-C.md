# 阶段 C：恢复中暂停（commit 65ddf0a）

- **已修复**：暂停打断恢复时按 live 快照重建 stop 范围——当时仍在跑的 turn 进入新 epoch 并欠一次续跑，已证明空闲的行只 mount；未开始的 admission 保留 request id 与 epoch；暂停后落地的恢复结果不写回新计划。
- **验证场景**：`test/engine.test.mjs:1531`（新周期）与 `:1581`（同一周期保留 admission）；新增 `interruptResume` 应用 `jobStates` 的用例。
- **实际观察**：修复前，恢复途中按暂停会把「恢复已把 turn 跑完」的行当成仍欠工作，或反过来把新周期压回旧 epoch；修复后两种情形分别按证据落到 `continue`/`mount`。
- **剩余问题**：恢复结果与暂停两个写者竞争时，以 epoch 判定丢弃迟到结果；丢弃只记日志，没有单独的审计行。
- **下一阶段**：旧计划读取与迁移（阶段 D）。
