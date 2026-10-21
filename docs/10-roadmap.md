# 实施路线与验收

当前任务全部为计划项。文档完成不代表下面实现项已完成。不估算未经实施验证的精确工期。

## M0：方案和协议冻结

- [ ] 固定自研规格语法、AST、ID 和诊断 code。
- [ ] 确认 scope、Node/Git 支持范围与格式版本策略。
- [ ] 根据 Codex、Claude Code、OpenCode、pi 四个首批宿主当前版本完成原生派发、入口与权限能力调查。
- [ ] 将本方案转成可执行变更任务，保留用户已确认的方向。

交付门禁：示例无歧义、内部引用一致，宿主能力未知项有明确验证任务。源码包名与分发许可证在首次公开发布前确定。

## M1：规格引擎

- [ ] parser/AST：front matter、正式规格、ADD/UPDATE/REMOVE、任务字段及 Test-Mode/Test-Scopes/Test-Commands/Test-Rationale。
- [ ] validate：ID、引用、场景、依赖、适用性与 gate。
- [ ] trace：需求 → 任务 → 场景证据。
- [ ] planSync：基线摘要、冲突、完整块替换、历史 ID。
- [ ] archive 领域计划：输出、元数据、删除 ID 索引。

验收：纯 fixture 完成新增、更新、删除、无行为变更、同 capability 冲突；无外部规格工具及网络。错误定位到文件行号，未知格式明确拒绝。

## M2：运行状态与事务

依赖 M1 的格式输入。

- [ ] common-dir 定位、run ID、revision、状态/视图。
- [ ] 原子快照、journal、锁与有证据的 takeover。
- [ ] source/spec/plan/policy 指纹及证据 schema。
- [ ] 文件系统 manifest 在删除、stage/commit 前后保持一致；已忽略的跟踪源文件不得漏采。
- [ ] archive/reopen 文件事务，崩溃注入、幂等恢复和外部改动冲突。
- [ ] resume-plan 只读约束，takeover/recover/reopen 必须由独立写命令执行。
- [ ] resume-plan 的当前 Git/文件事实核查。

验收：在每个事务 checkpoint 注入中断并恢复；拒绝陈旧输入、双 owner 和伪成功；子 worktree 删除后状态仍可读；squash 语义不误用祖先关系。

## M3：单变更本地工作流

依赖 M1、M2。

- [ ] 项目配置、命令计划、路径边界。
- [ ] 阶段门禁、任务封装、范围授权、决策预算。
- [ ] 任务内 TDD cycle 状态、实现前基线、有效 Red 接受、同测试 Green/Refactor；verification/exempt 适用性与替代验收。
- [ ] Red 仅测试范围派发，接收后新派实现范围；test-cycle 执行证据、无效失败分类和中断恢复。
- [ ] 版本化 JSON 回报及 run/dispatch/attempt 关联；拒绝旧 attempt 的延迟回报。
- [ ] 按完整变更/项目 CI 契约选择命令、核查环境依赖与跳过理由；固定审查基线和逐路径覆盖。
- [ ] 修复预算跨恢复、重新归档及后继 run 继承；额度追加绑定新用户决策。
- [ ] 主会话验收子 Agent 差异、唯一 Git 写入与独立 CR。
- [ ] Verify 证据与输入不可变检查。
- [ ] local 集成 checkpoint 与当前事实判定。
- [ ] archive 前 sync-base、受影响重验；archive 后强制 verify-final，校验完整规格投影、重跑所选命令与最终独立审查。
- [ ] archive 后 base 前移或最终检查失败触发受控 reopen/重验/再次归档；最终提交树与验证快照映射。
- [ ] 用户脏工作树隔离；candidateTree 与工作树原始 manifest 分别绑定，覆盖 CRLF/attributes 转换及未跟踪源码漏提交。
- [ ] 统一 CLI envelope、退出码、幂等 operation-id。

验收：临时 Git 项目从 change 到本地归档/提交完成；缺测试证据、任务勾选伪造、格式错误/陈旧回报、无证据的 DONE、CR 写文件、验证后源码变化均阻断。覆盖归档后验证失败且 base 未变的 reopen、重新归档、预算保留，以及新 run 不能重置预算。验证失败修复后旧证据失效，必须重新独立复核；命令/规格/环境缺项不能假称通过。模拟 Agent 只验证协议，真实宿主另验。

TDD 验收包括：Bug 先复现；实现先改、缺依赖、编译失败、未发现测试均不能伪装 Red；修改断言后不能复用旧配对；预期 Red 不消耗重试预算；未采集结果的中断不能补造历史；非 TDD 任务必须有适用理由和验收。Git 交付 fixture 验证代码/测试/正式规格/归档一起进入同一候选树，base 前移重验、归档目录冲突拒绝覆盖、已集成规格仅通过新 change 修订。

## M4：安装和四个首批宿主入口

依赖 M2、M3；宿主模板调研可在 M0 后只读并行。

- [ ] 共享协议、角色、Skill 和宿主薄壳。
- [ ] 精确版本 runtime、install manifest、能力探测。
- [ ] init/dry-run/doctor/upgrade/uninstall。
- [ ] 升级三方比较、活动 run 检查、事务恢复。
- [ ] 打包产物 fresh clone 和离线可执行验收。
- [ ] 逐宿主完成真实派发/只读/恢复能力报告。
- [ ] Codex/Claude Code/OpenCode/pi 入口分别映射原生子 Agent 工具；验证实际身份、状态/结果关联与失败路径。
- [ ] pi 合规原生会话派发机制专项核验；不采用 Node.js spawn 外部 pi 进程的示例作为实现。
- [ ] CLI/模板/扩展无外部 Agent runner、模型 SDK 会话管理、Agent CLI 或 RPC 角色启动路径。

验收：在至少两个不同技术栈项目接入；包中无原项目绝对路径，未安装其他规格工具；用户文件不被覆盖。四个宿主入口均可检查，原生派发和角色隔离分别留证；未通过真实执行的宿主必须明确标记，不能宣称全支持。

M1–M4 通过且至少一个宿主完整执行验收后，可发布首个受限预览版本；对外能力表注明每个宿主的真实状态。完整首版支持承诺需目标宿主逐项通过，不能用模拟结果补齐。

## M5a：事项来源适配，先支持 GitHub Issues

依赖 M3、M4，与 M5b 独立实施。

- [ ] tracking 标准引用、身份与快照、能力报告和项目连接配置。
- [ ] GitHub Issues readItem：认证、来源 server/repository 核实，拒绝 PR 伪装事项；不实现创建/评论/关闭。
- [ ] bootstrap/spec-gate/恢复/集成前的快照核对、needs-triage、语义变化与授权失效。
- [ ] tracking read/refresh CLI 与证据保存，元数据可选引用及 required 策略。

验收：local Git + GitHub Issues、GitHub PR + 无事项均能配置；不同事项仓库与代码仓库不混淆。fake adapter fixtures 覆盖相同编号不同空间、连接重绑定、读取失败、来源修改、closed 不能伪装集成成功；归档后且 base 未变时，事项语义变化须经 source-changed reopen 修订重验。真实临时来源只读 smoke 单独记录；不承诺其他项目管理软件已支持。

## M5b：GitHub 仓库集成

依赖 M3、M4。

- [ ] branch/repo/base 验证、push、PR 复用、required CI；不读取事项作为仓库完成事实。
- [ ] 合并授权、同一 head/base 条件、远端事实、squash 后内容核对。
- [ ] 无网络/认证失败、有界重试、已合并恢复、cleanup warning。

验收：fake GitHub fixtures 覆盖确定性分支，真实临时仓 smoke 单独记录。无 required checks 时必须显式判断策略，不能把“暂未出现 checks”当通过。

## M6：Epic 与迁移

依赖 M5b 或已验证的 local 集成能力；使用外部事项输入时另依赖相应 tracking adapter，不因 Epic 强制 GitHub Issues。

- [ ] Epic DAG、就绪集、独占调度锁、每项 worktree。
- [ ] profile 对应集成事实、并发上限、调度恢复。
- [ ] 自研格式 importer 的只读预览与旧 ID 映射。
- [ ] MusicTag 等既有项目显式迁移演练。

验收：依赖未集成不解锁；陈旧 done、错误仓 PR 或不匹配目标分支不被接受；互不覆盖工作树。导入不改原文件，不承诺原工具双向兼容。

## 验证分层

| 层 | 重点 |
| --- | --- |
| 单元 | 解析、状态转换、指纹归一化、计划与依赖图 |
| 契约 | CLI envelope、宿主薄壳、角色包、证据 schema |
| 集成 | 临时 Git、文件事务、安装升级、crash recovery |
| 打包 | npm pack 产物、fresh clone、离线运行 |
| 真实环境 | 原生子 Agent、权限隔离、可选远端事实 |

路径空格/中文、Windows 路径解析、符号链接、大小写碰撞、无 final newline、linked worktree 都纳入相关 fixture。实现期间按变化范围运行验证，不靠反复全量执行代替故障定位。

## 发布检查

- [ ] 文档、配置 schema、runtime 和 assets 版本一致。
- [ ] 全部承诺能力有本版本证据，计划能力清楚标注。
- [ ] 无未解决的 blocker/major。
- [ ] 升级/卸载保留用户数据，失败事务可恢复。
- [ ] 包依赖、许可证、内容清单和无秘密检查完成。
- [ ] 用户明确授权公开发布；否则仅保留可审阅产物。
