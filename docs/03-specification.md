# 自研规格规范 v1

本规范是 Workflow 自身的产品协议。OpenSpec、Spec Kit 提供思路参考；无源码嵌入、格式兼容或 CLI 依赖承诺。

## 1. 文档分工

| 文件 | 权威内容 |
| --- | --- |
| `.workflow/rules.md` | 长期项目规则及明确的约束 ID |
| `change.yaml` | 变更 ID、格式版本、关联事项、依赖与影响模块 |
| `proposal.md` | 问题、目标、范围、非目标、用户可观察的验收结果 |
| `specs/<capability>/delta.md` | 需求和场景的新增、更新、移除及基线摘要 |
| `design.md` | 方案、数据流、兼容性、权限、实现与验证计划 |
| `tasks.md` | 稳定任务 ID、依赖、范围、需求引用和完成标准 |
| 正式 `spec.md` | 当前已集成的行为契约 |

Markdown 是语义内容的唯一来源。可生成 JSON 索引缓存，但缓存记录输入摘要，不能独立修改或作为冲突时的第二权威源。机器语法字段使用英文，正文允许中文。

## 2. 标识符

- change/capability/module：小写 kebab-case，禁止路径分隔、`.`、`..`、控制字符和大小写碰撞。
- requirement：`REQ-<CAPABILITY>-<NNN>`；例如 `REQ-SESSION-001`。逻辑项目内唯一，删除后不能复用。
- scenario：`SCN-<CAPABILITY>-<NNN>-<NN>`，归属单个 requirement；删除后不能复用，也不能迁移到另一 requirement。
- task：`TASK-001`，在当前 change 内唯一；跨 change 用 `<change>#TASK-001`。
- 长期规则：`RULE-001`。各类 ID 不能由文件行号、排序位置或标题计算。

change ID 在活动变更和归档历史中唯一；归档后不得用于新变更。reopen 是恢复原 change，不是复用 ID。

标题调整保留 ID。需求拆分/合并通过显式 REMOVE + ADD，并在理由中给出替代 ID。V1 无隐式重命名匹配或模糊文本合并。

## 3. 元数据

`change.yaml` 示例见 [样例](../examples/change/change.yaml)。必要字段：formatVersion、id、title、modules、dependsOn。可选 tracking 对象为 `{provider, itemId}`，引用独立项目管理连接；是否必需由 tracking.required 决定，与 integration.profile 无关。来源身份、内容快照和变化处理见 [事项适配](15-tracking-adapters.md)。未知字段在 strict 校验中报错，扩展只能放 `extensions` 命名空间。

`dependsOn` 是同一逻辑项目内的 change ID 数组，允许空数组；不得重复、自引用、形成环或引用缺失的活动/归档变更。执行依赖的满足条件是对应 profile 下已核实的集成事实，归档目录存在或 run succeeded 不等于满足。未满足时可准备草案，禁止派发实现和集成；重新基线不能移除依赖以绕过该条件。

规格 front matter：

```yaml
formatVersion: 1
capability: session
baseHash: null
```

delta 的 `baseHash: null` 表示正式 capability 不存在；存在时为其原始 UTF-8 内容的 SHA-256 小写十六进制，不包含 mtime。正式 spec 无 baseHash 字段。相同逻辑内容但不同换行也形成冲突，工具只提供明确重新基线，不悄悄改写输入。

## 4. 正式规格与增量语法

正式规格示例：

```markdown
---
formatVersion: 1
capability: session
---
# 会话

## REQ-SESSION-001 — 空闲会话到期
会话达到配置的空闲时长后，系统应要求重新认证。

### SCN-SESSION-001-01 — 到期后的访问
- GIVEN 会话已超过空闲时长
- WHEN 用户访问受保护资源
- THEN 系统要求重新认证
```

delta 用 `## ADD REQ-... — 标题`、`## UPDATE REQ-... — 标题`、`## REMOVE REQ-... — 标题` 表示操作。ADD/UPDATE 必须提供完整的新 requirement 内容和至少一个场景；UPDATE 按 ID 替换完整块，不做句子级补丁。REMOVE 必须给出 Reason 与 Impact 字段，不带有效场景块。

UPDATE 中未保留的旧 scenario 必须逐项列入 `- Removed-Scenarios: <ID>, ...`，无删除写 none；每个删除另写 `- Removal-Reason: <ID> — <理由>`。漏列、列入仍保留的 ID 或复用历史 ID 均拒绝，防止完整块替换静默删除场景。REMOVE requirement 同时移除其全部 scenario。同步计划列出其他活动 change 对被删除 requirement/scenario 的引用；有引用时 integration gate 阻断，先修订引用方并使其审批/验证失效，再重新生成计划，不级联改写其他变更。

同一 capability 中一个 ID 一次变更只能有一个操作。ADD 目标必须不存在；UPDATE/REMOVE 目标必须存在。已归档 ID 的重用检查包含归档 tombstone 索引。没有行为变化的 docs/infra 变更允许零 delta，但 proposal 必须说明，spec-gate 记录适用性判断。

## 5. 场景与可测试性

每个有效 requirement 至少一个场景。场景必须有 WHEN、THEN，GIVEN 可选；每个场景按 GIVEN（可选）→ WHEN → THEN 排列，各关键字最多出现一次且内容非空；AND 追加到最近的字段，首行不得为 AND。多项条件/动作/结果分别形成对应字段的有序条目，不表示分支或并发。parser fixtures 固定空白与列表词法。

解析器检查结构与 ID，不能证明期望正确。审查者检查是否可观察、边界是否遗漏以及是否与长期规则冲突。proposal 的 Open questions 使用 `- QUESTION-001 | unresolved|resolved | behavior|non-behavior | <问题及处理依据>`（status/type 各选一个值）；无问题写 `none`。resolved 项须引用决策证据；spec-gate 不接受 behavior 类型的 unresolved 项，不能仅靠改标签消除行为歧义。

proposal 的 Rules 小节使用 `- RULE-001: <本次如何满足及验证引用>`，无适用规则写 `none` 并说明理由。ID 必须命中 rules.md 的 `## RULE-001 — <标题>`；spec-gate 检查重复/悬空引用及所有适用规则是否已有处置，是否适用及语义符合仍由主会话与独立审查核对，不声称 parser 自动理解规则。

## 6. 任务格式和追踪

```markdown
## TASK-001 — 实现会话到期判定
- Status: pending
- Requires: REQ-SESSION-001
- Depends-On: none
- Write-Scopes: src/session/**, tests/session/**
- Test-Mode: tdd
- Test-Scopes: tests/session/**
- Test-Commands: session-test
- Acceptance: SCN-SESSION-001-01 有有效 Red/Green 与重构检查证据，判定使用项目时钟接口
```

Status 只接受 pending/running/done/blocked。主会话唯一写入任务状态；子 Agent 回报证据。开发任务必须引用需求；纯维护任务可 `Requires: none`，同时写 `Rationale:` 解释适用性。依赖不能形成环，不能引用不存在的任务。

每个任务必填 Test-Mode（tdd/verification/exempt）、Test-Scopes、Test-Commands；范围或命令为空写 none。Test-Scopes 必须为 Write-Scopes 子集，Test-Commands 引用项目声明命令。tdd 必须有非空测试范围与命令；verification 必须有命令；verification/exempt 必须补 Test-Rationale，exempt 另关联明确的替代验收计划。可自动验证的行为变更及 Bug 修复使用 tdd；纯重构先补齐特征测试并通过，再以 verification 重构和回归；独立覆盖任务及无业务行为的骨架准备也可用 verification。spec-gate 审查适用性，Developer 不得在失败后自行改为例外。完整时序见 [TDD 与交付](14-tdd-and-delivery.md)。

TASK 内容及依赖属于计划指纹，Status 是显示状态，归一化后不影响计划指纹。done 不是完成证据；运行引擎要求当前 run 中可核实的提交、路径审计和验收结论。手改为 done 不会使阶段自动通过。

tdd 任务验收还需关联 cycle 的 Red/Green/Refactor 证据；Red 的预期失败不表示任务失败，也不允许跳过最终 Green。任务中的 Test-* 字段属于计划语义，修改会使相应派发/验证失效。cycle 和命令的机器进度不写回规格作为第二状态源。

Tester 生成 `scenario → task → verification evidence` 映射，标记 automated/manual/not-applicable。每个变更场景都需映射；manual 未取得记录的验收结论时不可报告通过；not-applicable 必须有依据，不能用来跳过已批准行为。

## 7. 校验层次

| gate | 检查 |
| --- | --- |
| draft | 路径、front matter、ID、基本语法；允许缺少尚未生成的 design/tasks |
| spec | proposal/spec/design/tasks 完整、引用、依赖、场景、未决问题、范围授权及规则关系 |
| integration | spec 校验 + 当前审批、CR/Verify、场景证据、基线无冲突、事务计划完整 |

`validate` 不执行用户项目的测试命令，不证明 Agent 权限，也不代替产品批准。错误按稳定 code 返回文件和行号，例如 SPEC_DUPLICATE_ID、SPEC_STALE_BASE、TRACE_MISSING_SCENARIO、TASK_DEPENDENCY_CYCLE。

## 8. 同步与归档

`workflow sync <change>` 只计算同步计划：输入正式 specs、delta、预期 baseHash 和历史 ID 索引，输出将更新的文档及冲突。不会提前改变当前正式规格。

`workflow archive <change>` 由 integrate 发起，在通过 integration gate 后，以事务应用同步计划、登记 removed ID，并将活动变更移动到归档。正式 spec、归档元数据、tombstone 索引和运行 checkpoint 必须具备恢复计划；不能移动目录成功就报告整个归档成功。

归档元数据记录 change ID、原始 delta 摘要、输入正式规格摘要、输出摘要、指纹组和事务 ID。归档重试按 change/transaction ID 查询已落地事实，不能再次应用同一 delta。两个变更修改同一 capability 时，后者需显式重新基线并重新检查受影响验证；禁止 last-write-wins。

正式归档是否已经集成，由 local/GitHub profile 的当前集成事实判断，不在归档目录中另维护可变的完成状态。已集成的归档和需求历史保持不可变，后续修订必须创建新变更。

事务提交仅证明归档输出落盘，不代表变更已通过最终检查或完成集成。归档后 `verify-final` 必须按 journal 的预期摘要和规格 AST 核查正式规格、归档内容及历史 ID 索引，覆盖完整 requirement/scenario 内容与删除语义；不能只检查标题是否存在。该检查以归档 bundle 和事务输出为输入，不要求活动目录仍存在。

## 9. 未集成归档的受控 reopen

归档只是变更分支上的一个 checkpoint。`workflow change reopen <change> --transaction <id> --reason base-changed|final-check-failed|source-changed` 用于尚未集成、因 base 前移、归档后最终审查/验证失败，或外部事项变化经 triage 确认必须修订活动输入的恢复；原因须绑定当前事实、失败证据或来源快照差异及处理决策：

1. 在固定锁顺序下读取原归档 journal、归档元数据和当前 Git/远端事实，证明目标分支尚未集成本变更；无法证明时拒绝。
2. 检查当前正式规格及 tombstone 索引仍等于该事务的输出，活动目录不存在；任何后续编辑均报冲突，不覆盖。
3. 用新的逆向 journal 恢复原事务记录的规格输入、仅撤销该事务增加的索引项，并把原始变更内容恢复为活动目录。保留旧事务内容和审计关系。
4. 将 archive 及后续 checkpoint 标记 invalidated；该分支已提交的归档保持在 Git 历史中，以新提交表达恢复，不重写 index/HEAD 历史。
5. 主会话按原因在活动目录同步 base、重新基线或修复，重做受影响的审批/CR/Verify，再建立新的归档事务并执行 verify-final。reopen 不重置修复/审查预算。

若已集成，只复核完成事实，不能 reopen；若归档输出与当前文件不符，挂起并给出逐路径冲突计划。reopen 的幂等键与原 transaction ID 关联，重复操作不得创建第二份活动目录。此路径不用于绕过审批或改写已完成历史。

## 10. 导入与兼容

未来 importer 可把旧 OpenSpec/Spec Kit 文档转成自研格式，输出映射和需要确认的缺项。V1 不自动扫描并改造旧目录；不同时维护两份规格来源；原始目录仅作为导入输入，显式确认转换后再切换权威根。

## 11. 历史索引与重新基线

历史索引位于 `.workflow/specs/history.json`，是从不可变归档元数据重建的派生索引，不能独立编辑。格式为 `{formatVersion: 1, changes: [...], removed: [...]}`；changes 项含 changeId、archivePath、transactionId、archiveMetadataHash；removed 项含 kind（requirement/scenario）、id、capability、parentRequirementId（requirement 时为 null）、changeId、transactionId、reason。归档元数据保存相同的 ID 登记与删除记录，索引与归档不一致时拒绝门禁并要求重建/恢复；不得选择更宽松的一份。两者随同一归档事务提交。reopen 只撤销原事务的登记，旧 journal 保留，原 change 身份仍不可用于另一变更。

零 delta 的同步计划输出空规格写集，不生成虚构 baseHash；仍登记 change 历史并归档，正式规格及 removed 集合不变。最终检查核对空写集及变更登记事实。

`workflow change rebaseline <change>` 默认只读：以原 baseHash 对应的旧规格、当前正式规格及 delta 投影生成三方冲突计划；旧内容须从固定 Git 对象或原始快照取得并验证摘要，缺失时拒绝，不能猜测。resolution 文件使用 `{formatVersion: 1, planId, deltas: [{capability, content, resolvedConflicts: [{id, rationale}]}]}`，content 为完整 delta 文本；capability 必须命中计划，路径由引擎从 capability 推导，不接受任意目标路径。解析并检查新 delta 对当前规格的完整投影及历史 ID 后才应用。V1 不做句子级自动合并。同 requirement/scenario 的双边修改、删除/引用冲突均列为显式冲突。主会话在授权范围内准备完整新 delta，`--apply --plan-id <id> --resolution <file>` 在重新核对旧/当前摘要、owner/revision 后事务写入新 delta 与 baseHash；无冲突也需显式 apply，不得只覆盖摘要。rebaseline 不改正式规格或 Git 引用；spec/plan 变化使审批及相关下游证据失效，重新经过 spec-gate。原基线内容摘要及决策保留在证据中。

reopen 若被后续事务输出阻挡，不允许强制覆盖。诊断列出阻挡事务与逐路径差异；仅对仍未集成且可逐个证明输出匹配的后续事务，按逆序分别 reopen 后重试。已集成或存在外部编辑时保留现场，通过新 change 修订；不能以删除锁/索引解冲突。
