# 0.6.0–0.6.1 验收报告：暂停与恢复可靠性收敛

- 候选版本：`0.6.0` 的运行时行为，`0.6.1` 追加真实 Host 冒烟（运行时代码未变；manifest 是唯一版本来源）
- 冻结时间：2026-10-28 02:30（Asia/Shanghai），分支 `main`
- 证据目录：`docs/evidence/acceptance-run.json`（本轮生成的原始 JSON）
- 判定原则：只有真实执行过的场景才写 pass；未在真实 Host 上跑过的场景如实标注 unverified。

## 1. 复现方式

```bash
cd <repo>
node acceptance/run.mjs                 # 7 个端到端场景，真实 temp 目录 + 真实 store/heartbeat/engine/probe
node --test test/*.test.mjs             # 213 个单元/集成测试
npm run audit                           # 静态检查
npm pack --dry-run                      # 打包内容检查
```

验收脚本每个场景自建 `fs.mkdtempSync` 目录，使用真实的 `lib/snapshot.js`（snapshot.json / pending.json / journal 文件）、真实的 `lib/heartbeat.js`（running.json 与跨 boot 残留）、真实的 `lib/engine.js` 与 `lib/probe.js`；只有 Host 的 agents/goals/jobs 服务是脚本化替身（Host 服务不可 import，真实 Host 冒烟见第 4 节，已在隔离实例上执行）。

## 2. 本轮真实执行结果

| 项 | 结果 |
| --- | --- |
| 端到端验收场景 | 7/7 pass（exit 0） |
| 单元/集成测试 | 213/213 pass，0 fail |
| `npm run audit` | 0 error |
| `npm pack --dry-run` | 16 个文件，入口与 `files` 清单完整（见第 5 节） |
| 冷恢复后计划文件 | 消费后 `snapshot.json` 不存在；journal 留证 |
| 崩溃残留父链 | `c2.parent === 'c1'` 跨进程保留 |

端到端场景与观察：

1. `R01-R03`：pause 先落盘（`version:3`、`status:'paused'`、2 行）再 stop；重启后从磁盘读到 paused，一次 resume 恰好续跑 s1、s2 各一次，计划消费后快照文件消失。
2. `R04-R06`：旧进程 running.json 记录 `c1`/`c2(parent:c1)`；新进程 boot 后读到残留，恢复后 pending.json 释放，第三个进程 `peek()` 为 null（无工作）。
3. `R06`：恢复进行中按暂停 → `status:'interrupted'`，计划仍为 paused、planId 不变、pending 为空；被中断的 turn 记入计划。
4. `R07`：目录不可写时 pause 返回 failed，probe 的 stop 调用为 0 次，store 无计划文件。
5. `R08-R10`：`intent:'unknown'` 行 resuming 后返回 partial，行 intent 保持 unknown，`summary.unknown` 点名 s1，不计入 failed。
6. `R13`：仅含 job 的计划 resume 返回 resumed，`summary.jobsStopped` 1 条，未伪造任何 session 恢复。
7. `R11-R12`：恢复顺序 `r1 → c1`（父先于子），缺失父 `gone` 只合成为 mount-only 行，`c2` 仍被处理。

## 3. R01–R18 验收矩阵

| 编号 | 验收点 | 判定 | 证据 |
| --- | --- | --- | --- |
| R01 | 暂停范围诚实：只记录真正打开的工作，不把正常结束的 turn 写入计划 | pass | engine.test「pause() writes the plan before stopping…」「a session that ended normally is not recorded」；acceptance R01-R03 `rowsOnDisk:2` |
| R02 | 先持久化计划再停止；计划不可写时什么也不停 | pass | engine.test「pause() stops nothing when the plan cannot be made durable first」；acceptance R07 stop 调用 0 次 |
| R03 | 暂停结果与运行状态一致：停不掉的 item 报 attention/partial，不伪装成干净暂停 | pass | engine.test「…would not stop as reported attention」「a failed goal pause or job kill makes the stop partial」 |
| R04 | 重启后从磁盘恢复相位，不凭新 boot 发明状态 | pass | engine.test「hydrate() takes the phase from the disk」「a crash plan survives a second restart」；acceptance R01-R03 重启读到 paused |
| R05 | 一键继续：一次 resume 处理全部欠账，全部结算后才消费计划 | pass | engine.test「resume() journals each restored item and consumes the plan only when every item settled」；acceptance R01-R03 两行各续跑一次且快照消失 |
| R06 | 已完成的工作不重复启动：turn 边界判定 + admission 去重 | pass | engine.test turn 边界与 admission 用例；R01-R03 中 s1/s2 各只出现一次 restoreSession |
| R07 | 重复按继续不会产生第二份续跑（单飞 + journal + epoch） | pass | engine.test「an old instance cannot write its pause result after a reload」「a restore that lost its instance cannot consume a plan another press merged」 |
| R08 | 崩溃残留被捕获，子会话父路由跨进程保留 | pass | heartbeat.test:408「a child route survives the crash record」；probe.test parent 保留用例；acceptance R04-R06 `c2.parent==='c1'` |
| R09 | 崩溃残留只在恢复完成后释放，下一次启动无可恢复工作 | pass | heartbeat.test「a v4 file from another boot is residue…」；acceptance R04-R06 pending 释放、第三 boot `peek()===null` |
| R10 | 恢复过程中可以暂停：中断恢复、保留可重试计划、记录停不掉的项 | pass | engine.test:1531 / :1581；acceptance R06 `interrupted` + 计划保留 |
| R11 | 部分停止提供继续而不是在残留上再暂停；部分恢复保留计划重试 | pass | engine.test「a partial stop offers resume, never another pause over its own residue」「resume() keeps the plan and retries only the item that failed」 |
| R12 | `unknown` 不冒充完成：不消费、不算 failed、保留计划；`skip` 是唯一被证明无需继续的状态 | pass | snapshot.test unknown/skip 往返；engine.test「resume() treats skipped and attention as settled…」；acceptance R08-R10 partial |
| R13 | 恢复失败不写成功：计划留盘、行保留、下次只重试失败项 | pass | engine.test 失败重试、`cannot checkpoint` 用例；acceptance R08-R10 |
| R14 | 父链先父后子；缺失父只合成一次 mount-only；父图成环不挂死 | pass | engine.test 父链/缺失父/循环父图用例；acceptance R11-R12 顺序 |
| R15 | job 交接诚实：只报停止结果、绝不声称重启；job-only 计划可结算 | pass | engine.test「resume() records killed jobs as gone and never claims to restart them」；acceptance R13 `jobsStopped:1`、无 session 调用 |
| R16 | 计划跨写入/重启/迁移不变：元数据保真、journal 文件稳定 | pass | snapshot.test 23 项（迁移、metadata、幂等重写、journal 命名）；acceptance 冷启动读回同一 planId |
| R17 | 渐进恢复默认关闭，未显式开启走普通路径且不碰容量 gate | pass | engine.test 新增默认关闭用例（`restore.progressive===false`，gate 计数全 0）与 `:1308` 显式 false 用例 |
| R18 | 交付物自洽：版本单一来源、路由/守卫契约、入口可打包 | pass | apply/integration/client 测试；`npm run audit` 0 error；`npm pack --dry-run` 清单见第 5 节 |
| R19 | 真实 Host 隔离冒烟：从零建 profile、装包挂载、路由与 Origin/Host 守卫、空闲暂停诚实、冷启动 hydrate、无计划恢复 | pass | `acceptance/host-smoke.mjs` 16/16，证据 `docs/evidence/host-smoke.json` |

## 4. 未验证项（诚实标注）

- **真实 Host 运行（pass，仅隔离实例）**：`acceptance/host-smoke.mjs` 在全新 `DSH_HOME` 上从零合成
  profile、安装本包、写入挂载入口、启动 Host（OS 选空闲端口，不触碰 54279），用真实 HTTP 断言 16 项：
  `GET`/`HEAD /state`、无插件头可读、伪造 `Origin`/`Host` 均 403、空闲 `POST /pause` 两次都返回
  `idle` 且不写计划、冷启动后 `phase idle` 且 `restore null`、无计划 `POST /resume` 返回 `empty`、
  插件日志出现 `ready (idle)`。证据：`docs/evidence/host-smoke.json`。
- **live-work 暂停（unverified）**：本机 agent 环境没有模型凭据，无法在隔离 Host 里起一个真实回合，
  所以「真实 Host 上暂停正在跑的 turn、kill 真正的 job」仍只有脚本化替身覆盖。空闲路径通过不等于
  live-work 通过，这里不冒充。
- **job 的端到端重启（unverified）**：Host 没有 job 启动闭包，本版只把停止结果写进计划，
  由续跑消息请求 turn 自行重开；真实 Host 上这一链路未执行。监听 job 生命周期的做法只做了设计评审
  （`docs/design/job-lifecycle.md`），代码未实施。
- **进程死亡时的 job 残留（known gap）**：心跳残留只含 sessions/goals，不含 jobs；崩溃时在跑的 job
  无法被下一次启动命名。设计评审给出了用持久化 `job/registered` 无 `job/settled` 作为残留证据的
  方案，但未实施，当前仍按未知处理。
- **渐进恢复容量 gate（unverified）**：只在 engine 层用 stub gate 验证默认关闭与显式开启，未接真实
  Host 容量信号；该能力按任务要求排在核心恢复之后，默认关闭。

## 5. 包检查

- `exports`：`.`→`index.js`，`./client`→`client.js`，`./locale/*.json`，`./icon`→`icon.svg`；`files` 覆盖 index/client/cordis.patch.yml/lib/locale/icon/README/CHANGELOG。
- `cordis.patch.yml` 安装入口存在；manifest 版本 `0.6.0` 为一来源（`index.js` 运行时读取，测试「every answer names the version in the manifest」锁住）。
- 无运行时依赖（`dependencies` 为空按 0.5.12 保持不变），`npm pack --dry-run` 无报错。

## 6. 剩余限制清单（随版本交付）

1. 崩溃残留无 job 行；hydrate 只保留旧计划中的 job 行，不从残留重建。
2. job 不能被 Host 重放；只能记录停止结果，并由续跑消息请求重开。
3. 父链只保证直接 parent；缺失的祖父不会被补造，旧 bare-id/v2 残留没有 parent，其子会话按根挂载。
4. `unknown` 需要人看一眼；重复继续会保持 partial，不自动转成功。
5. 渐进恢复默认关闭，真实 Host 容量 gate 未冒烟。
6. 真实 Host 的隔离冒烟只覆盖空闲路径（16 项通过，`docs/evidence/host-smoke.json`）；带真实回合的
   live-work 暂停因无模型凭据仍未执行（见第 4 节）。
7. job 生命周期监听只是评审稿（`docs/design/job-lifecycle.md`），没有实现；恢复永不重启 job。
