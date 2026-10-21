# 状态、证据与恢复

## 1. 单一状态源

每个 run 的 `state.json` 是权威机器状态。包含 formatVersion、revision、projectId、changeId、runId、owner、worktree、branch、phase/task/attempt、approval、fingerprints、checkpoints、decisions、各类有界重试预算及 terminal 状态。同 change 的后继 run 记录 previousRunId 并在变更锁内核对历史状态、继承未决问题及预算消耗；新 run 不能重置计数。追加预算需引用新的用户决策，保留初始额度、已用额度与追加记录，不另设可修改的 Markdown 账本。

`events.jsonl` 和 `progress.md` 从已提交 revision 派生。状态中的事务 ID/事件 ID 用于检测遗漏和重复；视图写失败时可重建，不把日志尾部未提交记录当成状态。文档 `tasks.md` 的 Status 为可核对视图，实际验收依赖 state 中的证据。

阶段状态为 pending → running → succeeded / failed / suspended。跳转使用预期 revision 的 compare-and-swap。对旧 revision 的修改返回 STATE_CONFLICT，不重写新状态。事件和失败记录保留，不用覆写最终状态抹去 attempt。

## 2. 锁与所有权

按主仓逻辑 ID + change ID 建独占锁，另有安装锁、规格库写锁与 Epic 调度锁。锁记录 owner 随机标识、宿主会话、机器标识、进程事实、开始时间和 heartbeat。PID/heartbeat 只能辅助诊断，不能单独证明跨宿主 Agent 已停止。

写命令同时检查 owner 和 revision。所有需要多把锁的操作按 project/install → spec-store → epic → change 的固定顺序获取，不在持有变更锁时反向申请规格库锁。读取 run 后准备写归档时需释放/按序重新取得并复核 revision。

接管要求显式 previous-owner 和无活动写入者的证据，保留 takeover journal。锁创建后状态未写、接管中途崩溃、主会话丢失但子 Agent 仍运行，都必须有独立恢复分支。不能按超时自动删锁，不能只凭主会话已退出就重派文件写入者。

## 3. 指纹组

| 指纹 | 输入 | 失效影响 |
| --- | --- | --- |
| sourceFingerprint | tracked 与允许纳入的 untracked 源文件内容、路径和类型 | CR、Verify、Integrate |
| specFingerprint | proposal、delta、正式规格基线、授权语义、事项身份及已采纳需求语义 | approval、spec-gate 及下游 |
| planFingerprint | design、任务语义/依赖/范围、验证计划 | spec-gate、派发及下游 |
| policyFingerprint | config/rules、宿主能力要求、角色及运行器精确版本、Git 内容转换策略 | 所有受影响门禁 |

所有路径相对仓库根，分隔符规范化，UTF-8 字节排序，记录类型及 SHA-256。符号链接只哈希链接目标文本，拒绝通过链接访问项目外文件。大小写碰撞在跨平台校验时报错。

source manifest 从工作树实际文件系统枚举，使用 `git check-ignore --no-index` 的忽略规则及项目明确声明的构建产物排除；Git 元数据、其他 worktree 和 `.workflow/` 中已由其他指纹覆盖的数据不重复纳入。额外必须覆盖的 ignored 文件由 validation.extraSourceInputs 声明；已跟踪但被忽略且未归属其他指纹/产物的文件，配置检查拒绝漏采并要求声明。Git index 仅用于审计，不决定 manifest 路径集合。删除表现为原 manifest 条目消失，删除证据另记 tombstone；相同磁盘内容在 stage/commit 前后必须得到相同 sourceFingerprint。不能按任一路径分量叫 dist/target 就自动排除，避免漏掉真实源目录。

spec/plan 归一化只允许忽略明确的任务 Status 和展示时间；审批内容、场景、命令参数、路径与约束不能被归一化掉。规格归档的路径变化通过事务记录的 before/after specFingerprint 映射解释，不能泛化为“规格改了也可复用验证”。

## 4. 证据最小字段

命令证据：commandId、executable、args、cwd、exitCode/signal、时间、HEAD、指纹组、输出摘要或证据文件摘要。日志大小受限，敏感值脱敏；成功命令必须有 exitCode=0，手工验收使用独立类型及授权主体。

开发证据：任务/需求 ID、实际路径、差异摘要、审计前后 HEAD/index、commit SHA。CR 证据：审查者身份、独立性、readonly 能力级别、指纹、findings。GitHub 证据：repo、base、PR、head、required checks、merge SHA、查询时间。

Agent 回报证据：原始回报摘要、protocolVersion、run/dispatch/attempt ID、task IDs、声明状态、声明路径、解析结果和主会话审计结论，绑定 dispatch attach 的真实 Agent 身份。回报中的命令退出码、HEAD 或权限声明不作为命令/Git/权限事实；事实须由对应运行工具重新采集。失败和复核轮次写入 run 状态，恢复和后继 run 继续使用剩余预算。

审查证据另含 reviewBase SHA、完整变更路径 manifest 及逐路径结论。验证计划证据另含适用/跳过判断、项目 CI 映射与环境准备情况；适用但无法执行的检查标为 blocked，不能用不适用掩盖缺依赖。verify-final 独立记录归档 transaction ID、输出校验、最终审查、candidateTree SHA 和归档后命令结果，不能挪用归档前证据充数。

TDD cycle 是 task 内部子状态，保存 cycle ID、实现基线、测试/fixture 摘要、command/环境摘要、Red 失败诊断和接受结论、Green/Refactor 的证据引用及 revision 顺序。步骤从 opened → red-accepted → green-passed → refactor-passed/not-needed 推进；无效 Red、测试内容改变和基线失配保留失败/失效记录，不能直接跳到 Green。业务断言语义由主会话接受、独立审查复核，工具不把任意非零退出码当成有效 Red。恢复按 [TDD 契约](14-tdd-and-delivery.md)核对快照与活性，不补造丢失历史。

事项证据独立于 GitHub PR 证据：记录 adapter/连接摘要、来源 canonicalIdentity、sourceRevision（如有）、内容摘要、获取时间和已接受快照引用；来源原始正文保存在 evidence，默认不提交。刷新、needs-triage 和主会话对语义变化的决策存入 run；仅时间戳或无关状态变化不更新审批语义指纹。tracking 配置修改属于 policyFingerprint 变化；实际身份重绑定不能只改连接别名规避校验。

这些字段提供可重查性，不构成对抗恶意主机或模型的密码学证明。恢复时仍查文件、Git 和必要的远端事实；不能仅接受调用方提交的 JSON。

## 5. 事务模型

状态快照单文件用临时文件、flush 和 rename。规格归档、安装升级涉及多文件，采用 write-ahead journal + staging + 持久化 checkpoint：

1. 锁定写入范围；记录 transaction ID、预期 revision 和每个输入/目标原摘要。
2. 在同一文件系统 staging 中生成全部输出并验证；落盘 prepared journal。
3. 逐文件 compare-and-write/rename，记录已应用项；保留恢复所需原内容。
4. 重新核对输出摘要，写 committed 状态和归档/安装元数据。
5. 更新 run/checkpoint、重建视图，清理 staging。

多文件操作在 OS 层不是真正整体原子。prepared/applying 时该规格库的读写均返回 RECOVERY_REQUIRED，直到恢复收敛为 committed 或 rolled-back。已被外部修改的文件不能自动回滚覆盖；记录冲突并挂起。

幂等键为 changeId + operation + transactionId；恢复优先查询事务和输出事实。归档已提交而 state 未更新时补 state；state 指成功但输出丢失时拒绝成功。不能重算一个不同计划冒充旧事务重试。

## 6. 只读诊断与恢复执行

`resume-plan` 的只读算法：

1. 读取项目定位、活动锁、state revision 和 journal，收集当前主会话/子 Agent 活性依据。
2. 读取 branch/worktree、Git HEAD/index/diff；有未完成文件事务时只读取其 journal 和各路径摘要，不把混合正式规格当作有效输入。
3. 核查提交及目标历史，按 profile 查询当前本地/远端集成事实；存在主事项引用时独立查询 tracking 来源并输出变化/unavailable，不按 PR 连接代查。
4. 比较能够安全读取的指纹与已记录证据，生成复用项、失效项、冲突和下一步操作。事务未恢复前无法判断的项标 unknown，不能推断有效。
5. 输出 takeover/recover/reopen/revalidate 等所需行动及依据，不修改锁、状态、文件、引用或远端对象。

主会话根据诊断执行恢复：确认原写入者停止后调用 takeover；有未完成事务时显式 recover；归档后 base 前移、最终检查失败或来源变化经 triage 确认需修订输入，尚未集成时显式 reopen；每一步成功后重新运行只读诊断，再决定接续阶段。任何写操作都不隐含在 resume-plan 中。

恢复工具不自动执行测试、不重新派 Agent、不推送或合并。真正重做由主会话在相应授权范围内逐步执行。

## 7. 集成后的指纹关系

Verify 绑定验证 HEAD 和指纹组。归档只允许改变事务计划列出的规格路径与任务展示状态；输出映射写入 checkpoint，但不代替归档后的 verify-final。verify-final 在干净起始、由本 run 独占的 worktree 中对归档后状态重新验证，绑定新指纹、candidateTree 与最终审查。candidateTree 是主会话暂存本变更后由 Git 生成的待提交树，包含路径、blob ID 和文件模式；验证开始与结束时树不能变化，工作树版本化内容须按 Git 的内容投影与该树一致，未跟踪源文件不得漏入验证但漏出提交。

sourceFingerprint 保存工作树原始字节，candidateTree 保存 Git blob 投影，两者分别记录。换行转换、.gitattributes 和 clean filter 会使二者字节不同，不能直接比较；记录相关 attributes、Git 转换配置和过滤器版本摘要，在授权的转换规则下核对投影，规则不明确或转换不可复现时挂起。额外 ignored 输入属于显式验证环境，不冒充已提交源码。随后 commit 的 tree SHA 必须与 candidateTree 完全相同，并记录验证 HEAD → commit SHA 的映射；仅 HEAD 改变不强迫重跑，但任何额外内容、sync-base 合并改变输入或配置升级均使对应证据失效。

归档后的 confirm-base 发现主线前移、verify-final 失败而需要修复，或独立来源检查发现必须修订的事项变化，先确认尚未集成并通过受控 reopen 恢复活动输入，再进行同步/修订和受影响重验。reopen 也使用独立 journal，逆向写入须比较原输出摘要，不以运行状态自报“未合并”作为充分依据。

GitHub squash merge 后验证提交可能不再是 main 的祖先，不能单独使用 ancestry 判定。远端完成核对 merge/PR 关系以及已验证补丁的源码内容投影。local 合并也须核对目标分支结果。cleanup 可与主结果分别恢复。

## 8. 版本与保留

配置、规格、runtime、install manifest 分别有格式版本。未知 major 只读并提示迁移。迁移需计划、原文件保护、journal 与 fixtures。升级期间有活动 run 时，默认阻止替换 runtime；先结束/挂起并验证无写入者，必要迁移再显式应用。

运行记录不随 clone 携带；完成摘要可显式导出为不含秘密的交付记录。垃圾回收只清理已终态且被明确保留策略覆盖的数据，不自动删除历史失败与活跃事务。
