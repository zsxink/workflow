# 工作流执行协议

## 1. 协作模型

当前主会话为唯一 Leader。主会话调用宿主原生工具派发 Architect、Developer、Tester、Reviewer；Verifier 可由独立原生子 Agent 或主会话执行。CLI 不持有模型调用凭据，不启动外部 Agent 进程。子 Agent 不自行派发下级，也不操作 Git index/HEAD、PR 或归档。

首批宿主为 Codex、Claude Code、OpenCode、pi；无论在哪个宿主使用，实际派发都由当前主会话调用该宿主原生机制完成。Workflow 的 Node.js CLI 不运行模型 SDK、不启动 Agent CLI、不通过 RPC 驱动第二个会话执行角色。任务准备、真实 Agent ID 关联和回报核验只是确定性工具职责。具体机制与能力不足的处理见 [宿主适配](09-hosts.md)。

开发角色是通用职责，技术栈要求来自项目配置和本次任务；Rust/Vue 等可以作为项目自定义角色覆盖，不进入核心阶段逻辑。

用户已确认当前保留五职责/阶段及 Red→Green 两次权限派发；试点观测成本与质量后再评估角色合并，不提前跳过任何阶段。Reviewer 缺只读隔离继续停门禁。

## 2. 阶段与证据

本文 verify-final 为阶段/checkpoint 名称，CLI 对应 `workflow verify <change> --run <id> --stage final`；候选树 capture/confirm 接口见 [CLI 契约](08-cli.md)。

| 阶段 | 执行主体 | 必需通过条件 |
| --- | --- | --- |
| bootstrap | 主会话 + CLI | 固定版本、配置、Git、运行锁、宿主能力、授权范围成立 |
| architect | Architect | design/tasks、写入边界、验证计划完整，无范围扩张 |
| spec-gate | CLI + 主会话 | 严格结构/追踪检查、范围授权指纹、设计与策略基线 |
| dev | Developer | 适用任务完成 Red/Green/Refactor、授权路径差异与相关检查有证据，主会话审计并提交 |
| tester | Tester | 变更场景覆盖映射、必要测试/手工验收结果及提交 |
| cr | 独立 Reviewer | 当前指纹与 diff 的只读审查，无 blocker/major |
| verify | Verifier/主会话 | 当前源码和规格执行项目选定验证命令，前后输入未变 |
| integrate | 主会话 + CLI | 归档事务、归档后最终检查、提交、本地或远端集成事实逐项成立 |

阶段依赖固定为上述顺序。docs/infra 可由配置给轻量验证计划，但不能仅凭标签自动跳过规格适用性判断、独立审查或最后证据检查。

TDD 位于 dev 内部：主会话先派只允许修改测试的 Red 任务，采集并接受预期失败后，再派允许修改实现的 Green/Refactor 任务；不把测试统一推迟到 tester。tester 负责独立覆盖与断言质量检查。测试方式、有效 Red、步骤证据和例外条件见 [TDD、归档与 Git 交付](14-tdd-and-delivery.md)，该协议同时明确归档和 Git 的完整顺序。

bootstrap 必须记录用户既有差异。执行开发和最终验证前，所用 worktree 必须没有与本 run 无关的 staged、unstaged 或未跟踪源文件；原工作树有用户差异时，在干净独立 worktree 执行，或仅输出只读准备计划。不得自动 stash、清理或把用户差异混入提交。原工作树快照仅用于保护用户内容，不能拿含未提交用户源码的测试结果证明另一个提交树通过。

事项输入通过独立 tracking adapter 读取，不由 local/github 集成 profile 决定。bootstrap 核实主事项身份与快照，spec-gate 检查采用内容和授权关系；启动/恢复/集成前按 [事项适配契约](15-tracking-adapters.md)处理来源变化。无来源引用且 tracking.required=false 的变更继续使用直接需求输入。事项状态不能替代 Epic 依赖的实际集成事实。

## 3. 派发包

每个任务包包含 change/run/task IDs、公共角色版本、需求与场景 ID、设计路径、项目规则、允许写路径、禁止写路径、起始 HEAD、工作区快照、能力要求、完成条件和回报格式。

CLI 的 `dispatch prepare` 只生成任务描述和记录 planned attempt。主会话派发后通过 `dispatch attach` 记录真实 Agent ID；派发未成功时 planned 不算运行。工具调用前后出现中断时，恢复先核对真实子 Agent 状态，再决定续派，不能因为缺 ID 就自动重派。

子 Agent 回报采用版本化 JSON 协议；CLI 校验必需字段、状态枚举、ID 与路径格式。字段缺失、相互矛盾、引用未授权路径或没有证据的 DONE 均视为未完成，主会话不得据此推进阶段。回报内容是待核实声明，不是运行事实。

```json
{
  "protocolVersion": 1,
  "runId": "run-example",
  "dispatchId": "dispatch-example",
  "attemptId": "attempt-example",
  "status": "DONE",
  "taskIds": ["TASK-001"],
  "files": ["src/session.ts"],
  "evidenceIds": ["evidence-example"],
  "requirementIds": ["REQ-SESSION-001"],
  "scenarioIds": ["SCN-SESSION-001-01"],
  "startHead": "<full-commit-sha>",
  "question": null,
  "next": "提交主会话审计"
}
```

所有字段必需；列表为空使用 `[]`，无问题使用 `null`。`status` 仅接受 DONE、NEEDS_PARENT_DECISION、FAILED；NEEDS_PARENT_DECISION 必须有非空 question。以上 ID 为格式示意，实际值由派发包提供。真实 Agent 身份取自 dispatch attach，不接受回报自报身份。只接收当前 attempt 的回报，已终结或旧 attempt 的延迟回报保留为审计记录，不能覆盖新状态。Agent 的自报命令、退出码或 HEAD 仅用于定位，成功证据必须来自主会话/运行工具可核查的记录。

主会话核对 HEAD/index 未被子 Agent 更改，差异不越出授权范围，且原有用户差异未混入。只有审计通过后才接收、提交和标记任务完成。

## 4. 验证选择与修复闭环

验证计划由项目配置声明；本次变更按受影响模块、文件范围和需求场景选出适用命令，并记录选择依据。每个适用命令必须执行或明确失败；跳过项必须有理由。通用引擎不根据语言、目录名或包管理器猜测验证命令。项目可用确定性检查脚本表达跨文件不变量，作为普通验证命令纳入同一证据协议。

验证失败或 Reviewer 提出 finding 后，主会话先判断是否属于已授权修复。修复改变哪些指纹，就使对应的旧 CR、Verify 证据失效；修复完成后重新审查和验证。每次承担独立审查的子 Agent 使用新的审查上下文，且未参与被审修改。确定性验证命令可由主会话直接执行，但不能替代独立审查。达到配置重试上限仍未通过时挂起并记录根因、未决 finding 和下一步，不得通过改状态或重复旧证据推进。

Verify 的成功证据绑定命令计划、适用性判断、HEAD 和输入指纹。归档前 Verify 与归档后的 verify-final 是两个门禁：前者允许启动归档事务，后者允许提交归档结果并继续集成。V1 在归档后重新执行所选验证命令，不以自然语言判断“语义等价”复用旧结果。最终验证前仅由主会话暂存本变更文件、固定 candidateTree SHA，并核对该树与工作树的 Git 内容投影相符；验证前后同时检查源码原始字节指纹和 candidateTree。随后 commit 的 tree SHA 必须等于 candidateTree，记录 HEAD 映射；Git 换行/属性规范化按运行时契约比较，不能直接把工作树字节与 blob 字节等同。其他输入改变则返回最早失效阶段。

## 5. 文件所有权与并行

同一 worktree 默认串行写。并行只读任务可以共享基线；独立写任务需无路径交集，且在派发前声明。涉及共享生成文件、锁文件或公共类型的任务视为有依赖，即使表面目录不同也不直接并行。

Epic 并行使用每项独立 worktree/branch，默认上限 3，并受宿主实际剩余配额约束。主会话保留调度入口，不随子变更切换主仓分支。local profile 用可达的集成提交事实解锁依赖；github profile 用本仓正确 base 分支的远端已合并事实解锁。

## 6. 主会话决策

已批准范围内的实现方案、文件归属修正、临时失败重试和 CR 修复可由主会话处理，记录依据即可。产品行为、授权范围、不可逆外部动作、规则冲突和无法可靠判断的事项返回用户。

默认同一问题首次尝试后最多重试 2 次；修复后的再次派发也消耗重试额度。CR 对同一变更实现修复链最多 3 轮。正常归档后的首次最终审查是单独门禁，不消耗实现 CR 轮次；若最终审查发现问题而需修复，受影响实现的复审继续消耗原 CR 轮次，最终门禁的再次执行也消耗对应重试额度。因修复、重新归档、恢复或新建 run 不能重置计数；同 change 的后继 run 继承未决问题和已耗用预算。重复失败记录根因、候选方案与影响后 suspended；只有明确的新用户决策可追加预算，保留原额度、消耗与追加原因，不允许重命名问题规避上限。

## 7. 审查与验证

Reviewer 独立于当前修改者，不允许写源码或规格。finding 至少含 severity、file/line、issue、requirement/scenario reference 和建议。主会话比较前后快照；发现写入即失败，保留现场，不自动清理用户文件。

bootstrap 固定本变更的 reviewBase SHA。CR/最终审查覆盖 reviewBase 到当前 HEAD 的全部分支差异，加上本 run 的 staged、unstaged、未跟踪文件与删除/重命名，不能只看最近提交或源码目录。逐路径记录 reviewed/not-applicable 及依据；大 diff 分块检查，不允许截断后报通过。执行 worktree 中出现无法归属本 run 的用户差异时暂停并保留现场；不得从比较中简单排除后继续报告通过。同步 base 后记录新 reviewBase 并使受影响审查失效。

Verify 使用项目声明的命令计划；每条记录 argv/cwd、开始结束、退出码、HEAD、指纹组及摘要。允许生成明确白名单构建产物；不得改源码/规格/配置。命令启动和结束各计算指纹，运行中变化即拒收成功。

任何修复造成受审源码、规格、设计、验证计划或规则变化，均使相应 CR/Verify 失效。仅完成状态字段改变可以归一化豁免。

## 8. 集成

local profile：sync-base → revalidate-if-changed → archive → verify-final → commit → confirm-base → merge-local → verify-local。仅在有对应用户或项目策略授权时执行本地合并；否则停在集成准备完成，不报告 end-to-end success。

github profile：sync-base → revalidate-if-changed → archive → verify-final → commit → confirm-base → push → get-or-create-pr → wait-required-ci → confirm-base → merge → verify-remote → cleanup。没有写入授权时先完成所有可审阅内容，再停在具体副作用之前。安装 Workflow 不等于授予所有未来变更的推送和合并授权。

`verify-final` 必须检查归档 journal 的逐路径输出摘要、正式规格的完整结构/引用、ADD/UPDATE/REMOVE 投影与历史 ID 索引，并重新执行本变更所选验证命令，记录归档后的指纹。独立 Reviewer 检查最终完整 diff，确认归档新增差异与投影一致、未引入其他内容。只查 requirement 标题存在不构成同步成功。归档前的活动目录校验与归档后的输出校验分开执行，不能对已移走的目录重跑活动变更命令冒充通过。该门禁没有强制跳过选项，也不代替 required CI。

verify-final 失败时先保留现场并标记集成未完成；需要修复前，核实尚未集成、归档输出未被外部改变，再通过受控 reopen 恢复活动输入，修复并重做受影响审批/CR/Verify，然后重新归档和执行 verify-final。只读的基础设施故障可在剩余预算内重试当前检查；禁止先编辑归档再用 reopen 覆盖差异。输出已损坏或事务未完成时走 recover/冲突处理，不能伪装为正常 reopen。

首次同步 base 必须在最终归档之前进行。源码、正式规格或计划被同步/修复改变时，回到最早失效阶段，活动变更中重新基线、修订和验证，全部通过后才归档。revalidate-if-changed 是恢复到对应阶段的流程边，不是跳过 CR 的单条测试命令。

confirm-base 在推送前与合并前重新核对目标分支及 PR head。若 base 已变化，不在已归档输入上直接 sync：保持挂起，确认当前变更尚未集成后按规格文档的受控 reopen 事务恢复活动变更，再同步和重验。归档产生的提交保留在历史，通过新提交记录恢复和再次归档，不 reset、force push 或改写历史。GitHub 策略要求远端合并检查同一 PR head/base 仍成立；宿主无法保证该条件时暂停合并并重查，不能忽略竞态。

每个 checkpoint 先查询当前事实，成功后立即持久化。远端合并完成但清理失败记 cleanup warning，远端 success 与清理状态分开报告。

已关联事项的变更在提交归档、推送和合并前，还由应用层独立执行 tracking 来源检查；需要变更语义时停止推进。已归档且未集成则按 source-changed 原因及 triage 证据受控 reopen，再修订和重验；事项无关状态变化只记决策，不强制重归档。该来源核查不由仓库 adapter 代查，也不把事项关闭当作集成事实。
