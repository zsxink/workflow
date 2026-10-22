# Workflow 方案全面复核报告

复核日期：2026-10-21。本文含其他 Agent 的原始复核（第 1–11 节）与本轮交叉复核（第 12 节）。**2026-10-21 复核结论以第 12 节为准；最新规范衔接复核见 [2026-10-22 复核](18-contract-review.md)；用户已确认的 D1–D4 决策统一记录在文末第 13 节。**

原始复核仅分析，2026-10-21 轮次修订了文档及示例；以下“设计阶段/无实现”均为当时记录，当前受限预览实现状态以 [实现记录](17-implementation.md) 为准。原始章节保留用于对照，不代表其中所有事实、严重度及建议均获认可。第 4–6 节未逐项重验的论文/宿主/开源结论仅作调查线索，不提升为权威契约或已验证支持声明。

本报告与 [工作流复核记录](13-workflow-review.md) 的关系：13 是 2026-10-21 针对 MusicTag / MarkFlow 两个参考项目的设计缺口复核，聚焦"借鉴与边界"；本报告是对 Workflow 自身方案的整体可行性、证据基础与通用性复核，聚焦"是否可行、是否足够通用"。两者结论互补，不重复。

---

## 1. 复核方法与限制

### 1.1 三条并行调查线

| 线 | 内容 | 方法 | 产物 |
| --- | --- | --- | --- |
| 工程审计 | 方案自身的可实现性、内部一致性、通用性缺口 | 逐份通读 16 份文档 + examples，本地静态核对（链接、YAML、grep 交叉验证） | 第 3 节 |
| 证据调研 | 2024–2026 agent harness / 多 Agent / TDD / 规格形式化的论文与权威工程文献 | Web 检索论文与官方文档 | 第 4 节 |
| 开源对照 | 现有开源 agent 工作流实现的形态、机制与失败教训 | Web 检索公开仓库与 issue | 第 5 节 |
| 宿主机制核实 | 四首批宿主的原生派发与权限强制面 | 官方文档抓取 | 第 6 节 |

### 1.2 本报告的证据分级

全文对每条结论标注来源类型，避免把不同强度的材料混为一谈：

- **[已核实]**：本次复核直接读取本地文档原文并交叉验证，或直接抓取官方页面原文。
- **[论文]**：同行评审论文或 arXiv 预印本。**本报告未逐篇复核原文**，数值与结论经由检索与摘要获得，引用前应回查原文。
- **[工程观察]**：行业博客、官方文档、第三方仓库的公开事实，权威性低于论文但高于设计推演。
- **[推断]**：本报告基于以上材料的分析，非事实。

### 1.3 本次复核不证明的事项

- 未运行 Workflow 任何代码（当前无实现）。
- 未执行 MusicTag / MarkFlow 的测试、流水线、归档或远端操作。
- 未在四个首批宿主中做真实安装与原生派发验收。
- 未复核 arXiv 论文全文；第 4 节的所有数值均应在正式引用前回查。
- 论文类材料多为 2026 年近期预印本，尚未经过同行评审。

---

## 2. 总体判断

**方向正确，规格与证据层的契约质量高于同类开源实现；但当前形态存在两个结构性问题与一批可修的定义缺口。**

**值得肯定并应保留的核心判断**（三件具体的工程决策，而非"规格驱动"这个壳）：

1. **状态来源边界**。`state.json` 是 run 的权威机器状态；`tasks.md` 是计划文档，复选框只表示清单完成状态且不能替代运行证据（[05-runtime.md](05-runtime.md) §1）。
2. **证据指纹使修复能精确失效下游**，而不是笼统地"重跑一遍"（[05-runtime.md](05-runtime.md) §3）。这是同类项目普遍缺失的部分。
3. **归档是事务而非 last-write-wins**，含 journal、staging、compare-and-write 与受控 reopen（[05-runtime.md](05-runtime.md) §5、[03-specification.md](03-specification.md) §9）。这与 Roo Code 归档停运前"编排器提前完成、未验证 todo 完成度"的真实事故直接对应（见 §5.2）。

**两个结构性问题**：

- **P1 强制面缺失**：全套文档没有任何 hook / 权限 deny / pre-commit 定义（grep 命中数为 0），而 CLI 位于宿主进程之外，本质上无法阻止主会话（一个 LLM）绕过它调用。这使"确定性代码检查"目前只约束愿意配合的执行者。[已核实]
- **P2 执行模型超载**：方案把"可核查性"与"角色数量"绑定（五角色脊柱 + 每个行为任务拆成两次互不继承上下文的派发）。现有多 Agent 实证显示增益常常极小而成本 6–15×，与本方案的形状叠加后风险显著。[论文，需回查]

**通用性结论**：技术栈抽象是真实的，但通用性只覆盖了**配置层**，未覆盖**执行层**（强制面随宿主能力变化）与**规模层**（大仓全树哈希、完整 diff 审查、上下文预算均无上限设计）。详见 §7。

---

## 3. 工程审计发现

所有条目的位置引用已逐条回查本地文档。**未标注"抽样"的条目表示该条已完整回查。**

### 3.1 Blocker

#### B1 无任何强制点，门禁存在自证循环 [已核实]

- 位置：[AGENTS.md](../AGENTS.md) 第 16 行声明"流程约束由确定性代码检查，提示词不能代替权限隔离"；[08-cli.md](08-cli.md) 第 38 行同时承认"命令执行权限和允许产物写入须由宿主约束，CLI 的事后快照不构成隔离"；第 23 行 `workflow approve <change> --evidence <file>` 只接收一个证据文件。
- 事实：`grep -rn "hook|PreToolUse|pre-commit" docs` 命中 0。文档中不存在任何在写文件、提交 Git 或阶段推进前实际拦截的定义。
- 后果：门禁的实际效力取决于主会话是否自觉调用 CLI。授权可由主会话自行写入证据文件自证，阶段可被自报状态推进。所有下游证据链（指纹、事务、归档）建立在一个未受约束的入口之上。
- 影响范围：01-product.md REQ-PRODUCT-005、REQ-PRODUCT-015；04-workflow.md §2 全部阶段；05-runtime.md §4。

#### B2 锁活性不可证，恢复路径存在死锁 [已核实]

- 位置：[05-runtime.md](05-runtime.md) §2（锁记录 heartbeat；第 17 行"不能按超时自动删锁，不能只凭主会话已退出就重派文件写入者"）、[09-hosts.md](09-hosts.md) §5（"恢复中写入者活性不明时维持挂起"）。
- 事实：锁的存活依赖 heartbeat，但 CLI 是无常驻进程的一次性命令，[08-cli.md](08-cli.md) §1 命令表（约 30 条）中**没有任何 heartbeat 续租或锁续期命令**。
- 后果：三条规则合起来构成死锁——崩溃后无法证明写入者已停止（→ 挂起）、不允许超时删锁（→ 不能自动解锁）、也没有机制刷新活性证据（→ 永远无法接管）。需要人工删除锁文件才能推进。
- 次生问题：[05-runtime.md](05-runtime.md) §2 要求归档时"释放/按序重新取得并复核 revision"，扩大竞态窗口；§5 规定事务未收敛时"该规格库的读写均返回 RECOVERY_REQUIRED"，在 Epic 多 worktree 共享 spec-store 时，一处未收敛即阻塞全仓。

#### B3 同 capability 并发变更无定义路径 [已核实]

- 位置：[03-specification.md](03-specification.md) §8"两个变更修改同一 capability 时，后者需显式重新基线并重新检查受影响验证；禁止 last-write-wins"。
- 事实：全文与 [08-cli.md](08-cli.md) 命令目录中**不存在 rebaseline 命令**，也未定义 delta 的 `baseHash` 如何重写、两个 delta 如何三方合并、冲突如何判定与消解。
- 后果：规范要求了一个工具无法执行的操作。并行分支、Epic 并行、多人协作下的同 capability 变更没有合法路径。
- 相关：[03-specification.md](03-specification.md) §3 定义 `dependsOn` 字段但全文未赋予任何语义。

#### B4 规格引擎边界条件未闭合 [已核实]

| 缺口 | 位置 | 说明 |
| --- | --- | --- |
| tombstone 索引无 schema | 03 §4、§8 | 只说"归档 tombstone 索引""历史 ID 索引"，未定义存放位置、字段与格式，而 `verify-final` 依赖它做删除语义核查 |
| change ID 可复用 | 03 §2 | 只禁止 requirement ID 复用，未禁止 change ID 复用；与 archive 目录名、`previousRunId`、reopen 幂等键（changeId + operation + transactionId）冲突 |
| UPDATE 静默删除场景 | 03 §4 | "UPDATE 按 ID 替换完整块"会删除原块中未列出的 scenario，且未禁止 scenario ID 复用 |
| REMOVE 不检查引用 | 03 §4 | 移除 requirement 时不检查其他活动 change 是否仍引用它 |
| reopen 后再次归档的冲突 | 03 §9 第 2 步 | 要求"当前正式规格及 tombstone 索引仍等于该事务的输出"；若 reopen 之后又有新归档落盘，只有"挂起"而无可执行解法 |
| 无 delta 变更的归档 | 03 §4 | 允许零 delta 变更归档，但 `baseHash`、投影与事务输出语义未定义 |

### 3.2 Major

| # | 问题 | 位置 | 核实 |
| --- | --- | --- | --- |
| M1 | 示例违反自身规范：规范称 AND 为同字段续行，示例连写两个 THEN | 03 §5 vs `examples/change/specs/session/delta.md:14-15` | 已核实 |
| M2 | 配置字段无契约：`requireScopedWriteIsolation` 出现在两个示例配置，`06-configuration.md` 的 policy 字段表未定义；§3 提到的"CI 映射字段"同样无 schema | 06 §1 policy 行、§3 末段 vs `examples/config/minimal.yaml:52`、`github.yaml:45` | 已核实 |
| M3 | 命令名不一致：文档通篇用 `verify-final`，CLI 为 `verify --stage final` | 04 §8、05 §7、14 §5 vs 08 §1 | 已核实 |
| M4 | CLI 契约未定义：`phase/task/checkpoint ...` 参数未定义，实现者只能自创 | 08 §1 | 已核实 |
| M5 | 指纹跨平台不可用：baseHash 用工作树原始 UTF-8 字节，与 CRLF/.gitattributes 冲突（文档自己在 05 §7 承认）；`git check-ignore --no-index` 受用户全局 gitignore 影响，同仓不同机 manifest 不同 | 03 §3、05 §3、05 §7 | 已核实 |
| M6 | 复核记录自身证据不成立：声称静态检查覆盖"22 份 Markdown、32 个本地链接和 2 个 JSON 示例"，实际为 27 份 Markdown、0 个 JSON 示例 | 13 末段 | 已核实 |
| M7 | TDD 基线缺口：开 cycle 前无"基线测试必须绿"前置；仓内本就有失败测试时，Green 要求回归 exitCode=0 逻辑上不可达 | 14 §3、14 §2 | 已核实 |
| M8 | candidateTree 证据链靠自觉：candidateTree 由主会话 `git add` 生成，但 CLI 无命令记录 index→tree→commit 的映射 | 04 §4、05 §7 vs 08 §1 | 已核实 |
| M9 | 退出码语义混用：退出码 0 同时用于"查询成功"与"写操作完成"，脚本仍须解析 data | 08 §3 | 已核实 |
| M10 | `approve` / `dispatch collect` 的证据均为可伪造文件，无绑定真实主体的机制 | 08 §1 | 已核实 |
| M11 | 规则 ID 无机器可读关联：RULE-001/002 只出现在 proposal 散文，spec-gate 的"规则关系"检查无定义 | 03 §7、examples/change/proposal.md:16 | 已核实 |
| M12 | unresolved 语法未定义：文档称 proposal 的 Open questions 需标 unresolved，但无字段规范 | 03 §5 | 已核实 |
| M13 | 设计声称的验证范围超出 delta 场景：design 声称验证"大于阈值"，delta 仅有"等于阈值"与"小于阈值"两个场景 | examples/change/design.md Validation vs delta.md | 已核实 |

### 3.3 Minor

- `03-specification.md` §5 规定场景必须有 WHEN/THEN，GIVEN 可选，但未规定多 WHEN 或多 THEN 时的语义与解析结构。
- `05-runtime.md` §3 的 source manifest 规则未覆盖 submodule、sparse checkout、Git LFS。
- `06-configuration.md` §4 提到"Windows 可执行文件解析由进程层统一处理"，但未定义该层的行为。
- `08-cli.md` 的 `workflow change new` 描述"在主会话已准备的变更分支写入；目标分支上拒绝写入"，但未定义目标分支判定方式。

---

## 4. 证据基础对照

以下为第 4 节的来源均为 [论文] 或 [工程观察]，详见 §1.2 分级说明与 §1.3 的复核限制。

### 4.1 支持方案的结论

| 结论 | 来源 | 强度 | 对方案的意义 |
| --- | --- | --- | --- |
| 无外部反馈的自我纠错不可靠，甚至降分；有可运行的确定性检查才形成闭环 | "Large Language Models Cannot Self-Correct Reasoning Yet"（ICLR 2024, arXiv:2310.01798） | 论文 | 正面支持 Red→Green 与确定性门禁路线 |
| hooks 是确定性闸门，CLAUDE.md 类指令仅为建议 | Claude Code 官方文档 | 工程观察 | 支持"把规则落到工具而非提示词"的方向，但见 §6 关于 hook 强度的更正 |
| 多 Agent 的失败模式恰在"违反规范 / 该问不问 / 不懂终止 / 推理-行动不一致" | "Why Do Multi-Agent LLM Systems Fail?"（MAST, arXiv:2503.13657，1600+ 标注轨迹，κ=0.88） | 论文 | 方案的"角色任务包 + 验收条件 + 派发协议"正对症；但必须显式实现规范遵从检查 |
| 独立 fresh-context Reviewer 优于同构自评 | "tap: A File-Based Protocol for Heterogeneous LLM Agent Collaboration"（KCC 2026, arXiv:2606.14445，209 个 PR，异构 69.8% vs 同构 53.1%）；Claude Code 官方文档同向 | 论文 + 工程观察 | 支持保留独立只读 Reviewer——这是收益最明确、相对成本最低的一环 |
| 需求歧义是硬失败源，且强模型掉得更厉害 | "Clarity Is Not Assumed"（Orchid, arXiv:2604.21505，1304 任务） | 论文 | 支持 architect 角色与稳定场景 ID；但要求引入澄清轮次，否则 architect 仍只是"该问不问"的温床 |
| 规格形式化对 agent 正确率有正向但中低强度的证据 | EPIC 框架（2026-10，114 个开源 SDD 仓库按 ISO/IEC/IEEE 29148 评分，top 1/3 仓库 bug-fix 提交占 11.8% vs bottom 1/3 的 20.4%）；KBSpec 等 | 论文（观察性） | 支持稳定 ID + 增量归档的可追溯性；不支持"加更多规格机制 = 更好结果" |

### 4.2 挑战方案的结论

| 结论 | 来源 | 强度 | 对方案的意义 |
| --- | --- | --- | --- |
| 多 Agent 相对单 Agent 的收益"常常极小"，成本 6–15×；失败率 41%–86.7%；66 个 Pareto 最优配置中 59 个来自非 agent/单 agent | MAST（arXiv:2503.13657）；"Engineering Sustainable Agents"（arXiv:2610.03010，耗能 6.36×、耗时 6.07×）；Anthropic 多 Agent 研究系统博客（~15× token，并明言"编码任务可并行部分少，模型不擅长实时协调委派"） | 论文 + 工程观察 | **最直接的结构性挑战**。方案的六阶段 + 五角色 + TDD 两次派发落在同一成本量级，须给出相对单 Agent 基线的增量证据 |
| harness 选择造成每任务 token 40× 差异，而通过率只差 0–8 个百分点 | "The Scaffold Effect in Coding Agents"（arXiv:2607.22585，Terminal-Bench Pro 50 任务） | 论文 | 成本控制优先级高于流程细化；方案的 token 成本无预算与观测指标 |
| 上下文是有限预算，context rot 是梯度性退化；同模型仅换 harness 即可把 fail-to-pass 28%→49%、完整解 43%→72%（三个模型泛化，窗口紧时） | "Same Model, Different Harness"（arXiv:2608.26218）；Anthropic "Effective context engineering for AI agents"（2025-09-29） | 论文 + 工程观察 | **与"V1 不做自动上下文压缩"直接冲突**。方案的长任务阶段链正处退化区 |
| 人类任务超 4 小时成功率 <10% | METR（2025-03 博客与数据） | 工程观察 | 长任务需要显式分阶段开新上下文与状态外置 |
| "有效 Red"是真实风险：PR 级场景仅 13% 产出有效 fail-to-pass 测试、63% 编译错误、64% 的 PR 无任何有效测试；过滤后基准 resolve 12.47%→3.97%；345 个"假通过"补丁 | "PR-Aware Automated Unit Test Generation"（arXiv:2605.25285）；"SWE-bench+"（arXiv:2410.06992）；UTBoost（ACL 2025, arXiv:2506.09289） | 论文 | **方案 TDD 协议缺一环**：需要"测试有效性"门禁（能编译、断言非空、真正绑定需求场景），否则 Red 可能产出恒真/错绑测试并让下游全链路看似通过 |
| TDD 对 LLM 的正证据存在但幅度中等且任务相关 | TDD-Bench Verified（arXiv:2412.02883）；e-Otter++（arXiv:2508.06365，平均 fail-to-pass 63%）；"Test-Driven Development for Code Generation"（2024） | 论文 | 支持保留 TDD 形态，但需接受效应量有限，不宜作为质量主杠杆 |
| spec 会腐化、混入实现细节；且 agent 可靠性提升伴随规划与评审成本上升 | "Spec-Driven Development as Prescribed and as Practiced"（2026-08，21 次访谈 + 47 万 spec 文件语料） | 论文（混合方法） | 削弱"更多规格机制 = 更好结果"的假设；需显式规划 spec 腐化的维护成本 |
| LLM-as-judge 有系统性偏置（position bias、self-preference、prompt 诱发偏置可翻转排名）；高 test-retest 可靠性 ≠ 有效度 | arXiv:2606.19544（21 judge / 54.1 万次判定）、arXiv:2604.16790、arXiv:2410.21819、EMNLP 2026 Findings（rubric 顺序置换可缓解） | 论文 | 若 Verifier 用 LLM 判断"语义正确"，须做 rubric 顺序随机化并与确定性检查交叉验证；当前方案以确定性命令为主，此处风险较低 |
| 基准把 model/harness/environment 折叠成单一分数，任一组件影响可与一代模型相当 | "Position: Coding Benchmarks Are Misaligned with Agentic Software Engineering"（arXiv:2606.17799） | 论文 | **方法论要求**：方案若声称有效，验收必须给出同任务、同模型下的单 Agent 基线与成本对照，不能只有自己的成功案例 |

### 4.3 三项"不做"的证据对照

| 方案取舍 | 证据对照 | 判定 |
| --- | --- | --- |
| V1 不做语义等价判断 | 与"测试通过不等于行为等价"（TDD 综述）、Spec-Harness"verifier 接受的 spec 常行为弱"一致 | **可辩护**，但需在文档中写明 Red/Green 验收仅为"指定测试集通过" |
| V1 不做验证缓存 | 证据指纹方案本质是缓存+失效的弱化版；不做缓存省实现成本，但使"修复使下游失效"的重算成本随长任务放大（叠加 §4.2 的上下文退化结论） | **需重新权衡**，尤其在多角色高派发次数下 |
| V1 不做自动上下文压缩 | 与 §4.2 中最强的一组证据直接冲突 | **证据基础最弱的一环**，建议至少保留显式上下文预算 + 阶段级新会话 + 状态外置，并预留 compact 策略接口 |

---

## 5. 开源对照

### 5.1 形态对照

以下项目的共同特征：**提示词流程 + 轻量状态**。除本方案外，公开实现中未见到"完整证据指纹 + 事务归档 + 可恢复状态机"级别的机制。

| 项目 | 定位 | 规格/任务形态 | 状态与恢复 | 多 Agent / 角色 | 门禁与验证 | 安装分发 |
| --- | --- | --- | --- | --- | --- | --- |
| OpenSpec | 变更驱动规格 | 变更含 proposal / specs / design / tasks，完成后归档更新正式规格 | 轻量 | 无 | 结构校验为主 | CLI / npm |
| Spec Kit (GitHub) | 规格驱动脚手架 | 独立可验收的用户场景、任务依赖、明确文件范围 | 轻量 | 模板化阶段 | 以模板阶段为主 | CLI 模板 |
| BMAD-METHOD / Agent OS | 多角色方法论 | Markdown 角色定义 + 工作流文件 | 文件态 | 角色分工 | 流程约定 | 文档包 |
| Kiro | spec/plan/tasks 三段 | 三段式文档 | 轻量 | 阶段角色 | 阶段检查点 | IDE 插件 |
| Claude Code subagents / skills / plugins | 宿主原生多 Agent | 角色文件 + frontmatter | 宿主会话态 | 原生子 Agent | 权限规则、hooks、sandbox | 仓库内配置 |
| OpenCode | primary/subagent | agent 定义 | 宿主态 | 原生 subagent | 权限（需逐通道核查） | 宿主配置 |
| Cline | 模式化 | 无 YAML 角色定义（issue #9174） | 宿主私有 DB（`~/.cline/data/db/teams.db`） | 模式而非角色 | 模式内约定 | 扩展 |
| pi (badlogic/pi-mono) | 可扩展终端 agent | 无内建 subagent | JSONL session 树 | 仅示例扩展（独立进程） | 扩展自实现 | npm 包 |
| Aider / OpenHands / SWE-agent | 编码 agent 运行时 | 无规格层 | 运行时 | 单 agent 为主 | 测试通过 | pip / docker |
| Roo Code | 编排式 IDE 扩展 | todo 列表 | 编排状态 | 编排器 + worker | 编排器自判完成 | 扩展（**已于 2026-05-15 停运**） |

**关键差异**：本方案在"证据、指纹、事务、可恢复性"上投入的工程量远超同类，这构成真差异化；同时也意味着**这部分没有现成先例可借鉴，风险全部由项目自担**。

### 5.2 前人踩过的坑

| 事实 | 出处 | 对本方案的意义 |
| --- | --- | --- |
| 编排器可在未验证 todo 完成度的情况下"提前完成"任务 | Roo-Code issue #11435（2026-02-12，报告时仍 open） | 直接印证本方案"archive ≠ done、verify-final 为独立强制门"的设计动机；同时提示：编排层自身缺少终态校验是通用事故模式 |
| 编排历史占用约 93GB 后无法派生新任务 | Roo-Code issue #2201（2025-04-01） | 本方案的 run/evidence 目录位于 Git common-dir 且不受 clone 传播，但**无保留期与容量策略**（05 §8 仅说"垃圾回收只清理已终态且被明确保留策略覆盖的数据"），存在同类风险 |
| 无 YAML 角色定义；`/deep-planning` 于 2026-07-08（PR #12147）移除 | Cline issue #9174（2026-02-07）、PR #12147 | 角色定义形式在实践中会被简化甚至删除；方案的 `assets/roles/` 单一来源应接受"角色常被项目覆盖"这一现实（方案已允许角色覆盖，但需禁止取消框架不变量——见 06 §2） |
| 子 Agent 状态存宿主私有 DB | Cline | 印证本方案把状态放 common-dir 的选择；但也意味着宿主侧状态不可作权威源 |
| 扩展与宿主同 OS 权限、隔离需容器或 micro-VM | pi 官方示例与文档 | 见 §6.2 |

### 5.3 复用边界

本项目当前的复用边界（不内嵌第三方源码、不依赖第三方 CLI、不承诺格式兼容）与所对照项目的做法一致且清晰，[12-references.md](12-references.md) 的记录方式可继续沿用。**建议补充**：在引入任何第三方代码或模板时另行记录来源、固定版本、许可与 notices（该条已在 12 §借鉴边界中写明，属有效约束，无需修改）。

---

## 6. 宿主机制核实

### 6.1 Claude Code（本轮直接抓取官方文档核实）

| 事实 | 官方原文要点 | 对方案的影响 |
| --- | --- | --- |
| `allowManagedPermissionRulesOnly` 存在，Scope 为 `Managed` | 开启后忽略 user/project/local/`--settings` 中的 `allow`/`ask`/`deny` 规则、`--allowedTools`，隐藏 always-allow 选项，停止保存新规则；v2.1.282+ 还忽略仓库 `.claude/`、个人 skills/commands、`--add-dir`、仓库内插件 skills 的 `allowed-tools`；managed 与 bundled skills 的 `allowed-tools` 保留，`disallowed-tools` 仍生效 | **企业托管策略会静默削弱 skill 自带授权**。任何"靠 skill 授权实现门禁"的设计在企业环境不可靠 |
| skill 的 `allowed-tools` 是**预授权**而非限制 | "It does not restrict which tools are available: every tool remains callable"；只在调用那一轮有效，下条用户消息即失效 | 方案的"角色只读"不能依赖 skill `allowed-tools`；应改用 `disallowed-tools` 或子 Agent 的 `tools` 白名单 |
| PreToolUse 可阻断 Write/Edit/Bash，但强度有限 | matcher 只匹配工具名，不能写 `Bash(git commit)`；子命令过滤靠 handler 的 `if: "Bash(git commit *)"`，官方注明该过滤是 best-effort，应使用权限系统而非 hook 做硬 allow/deny | **hook 不可作为门禁依据**，只能作纵深防御与审计 |
| hook 退出码语义不利 | 0 = 放行并应用 JSON；**2 = 阻断**（stderr 为原因）；**其他任何码（含 1）= 非阻塞错误，动作继续**；超时默认**不阻断**，需 `onFailure: "block"` | 实现时必须以退出码 2 阻断；默认配置下 hook 失败等于放行 |
| deny 规则在所有模式生效 | "Deny rules block in every mode, including `bypassPermissions`" | deny 是唯一可靠的工具级阻断手段 |
| `permissions.disableBypassPermissionsMode: "disable"` 可放任意 scope，managed 中不可覆盖 | — | 提供"不可被用户绕过"的一档强度 |
| managed settings 高于一切本地设置 | "A developer's own settings files, `--settings` values, and project files never override a managed value" | 真正强制需 MDM/server-managed settings；个人项目拿不到此档 |
| deny 不覆盖任意子进程 | Read/Edit deny 不覆盖 "arbitrary subprocesses… like a Python or Node script that opens files itself" | **决定性限制**：安装进项目的工具无法从机制上阻止主会话绕过它写文件 |
| sandbox 覆盖范围有限 | "The sandbox covers shell commands only. Claude's file tools, MCP servers, and hooks run outside it" | sandbox 不能覆盖文件工具路径 |
| 子 Agent `tools` 可做只读白名单 | `tools: Read, Grep, Glob` 即无 Write/Edit/Bash；`disallowedTools` 先应用；带 specifier 的条目会移除整个工具 | **Reviewer 只读隔离在 Claude Code 上原生可达**，应从"待验证"升为"首发验证目标" |
| plugin 子 Agent 忽略 `hooks` / `mcpServers` / `permissionMode` | — | 角色的分发形态（subagent 文件 vs plugin 子 Agent）直接决定权限是否生效，方案须显式固定分发形态 |
| 后台子 Agent 工具集与前台不同 | 后台子 Agent 保留一组固定内置工具，官方说明会移除其余内置工具，无论是否继承或列在 `tools` 字段 | 后台派发与前台派发的能力报告不能共用一份结论 |
| `isolation: worktree` 默认从**仓库默认分支**（origin/HEAD）派生 | 只有 `worktree.baseRef: "head"` 才用本地 HEAD | **与 14 §6 冲突**：方案 bootstrap 要求"固定 base SHA 并从它建变更分支、reviewBase 绑定该 SHA"。若用原生 worktree 隔离且未设 `baseRef: head`，基线会被静默改变 |
| 仓库内 checked-in settings 可共享，但 allow 规则需每人接受 workspace trust 才生效，deny/ask 立即生效 | 用户可用 `.claude/settings.local.json` 覆盖共享配置 | 项目级配置的可靠性低于文档预期 |
| 未在文档中明确 | 子 Agent 是否继承 skill 的 `allowed-tools` | 未核实，需实测 |

### 6.2 pi（直接抓取官方文档首页核实）

官方原文：

> "Project trust controls which project resources Pi loads, but it does not sandbox tool calls."
> "Pi's tools and extensions run with the permissions of the Pi process."

- 无内建 subagent；官方仅提供 `examples/extensions/subagent`（**独立进程启动**）与 `plan-mode`（禁写工具 + bash 只读白名单）两个示例扩展。
- 进程模型文档列出的自动化路径为 print 模式、JSON 事件流、RPC（控制独立 Pi 进程）、TypeScript SDK——**均非同会话内派发**。
- 结论：pi 场景下的只读隔离必须自建扩展实现，等价于自建执行层，与 [09-hosts.md](09-hosts.md) §2 "Workflow 不接管宿主运行器" 的边界直接冲突。**pi 作为首批宿主的技术基础弱于文档标注的 `native-dispatch-unverified`**，建议移出首批或标为实验性。

### 6.3 Codex / OpenCode

维持 [09-hosts.md](09-hosts.md) §3 已有判断（子 Agent 继承父会话权限、受限角色仍可使用 shell），本轮未取得新的相反证据。因此：

- Codex 上 Reviewer 只读隔离不可强��，只能标 `audit-only`。
- OpenCode 需逐通道核查后才能承诺。
- [09-hosts.md](09-hosts.md) §3 表格中 pi 一行需按 §6.2 更新。

### 6.4 宿主机制对方案的直接修正

| 原方案的隐含假设 | 核实结果 |
| --- | --- |
| hook 可在写操作与 `git commit` 前可靠拦截 | 不成立（best-effort 子命令过滤；非 2 退出码不阻断；默认超时放行） |
| 可通过 skill 限定角色能力 | 不成立（`allowed-tools` 是预授权且单轮有效） |
| 门禁可阻止主会话越界 | 不成立（deny 不覆盖子进程；sandbox 不覆盖文件工具） |
| 原生 worktree 隔离可保持方案定义的 base | 不成立（默认从 origin/HEAD 派生） |
| 角色分发形态与权限无关 | 不成立（plugin 子 Agent 忽略 hooks/permissionMode） |

**结论**：宿主侧的"阻断"能力是**分级的、有限的**。方案的文档表述必须把"拒绝为不可核验的事实推进"（CLI 侧，跨宿主统一有效）与"阻止越界行为"（宿主侧，逐宿主分级，多数不可得）明确拆开。当前文档把两者混为一谈，是 B1 的直接成因。

---

## 7. 通用性评估

对应复核要求的第 3 项。判定标准：方案宣称"不把 backend/frontend 固定为 Rust/Vue、不识别项目特例"，这一层确实做到了；但"足够通用"需要更强的主张。

| 维度 | 现状 | 判定 |
| --- | --- | --- |
| 技术栈与目录 | 模块用任意稳定 ID（如 api/web/docs）、验证命令显式声明、引擎不识别 MusicTag/Tauri/Rust/Vue | **成立**（真中立） |
| 验证命令 | 必须由项目声明，引擎不猜；空命令集不得隐式通过 | **成立**（正确取舍） |
| 规格 ID 与格式 | 自研 Markdown + YAML，跨项目一致 | **成立** |
| 配置严格性 | 未知字段、越界路径、重复 ID、无效命令由确定性检查拒绝 | **成立** |
| **项目形态** | 无 monorepo 包边界、跨包依赖、生成代码、submodule/LFS/sparse checkout 契约 | **缺口**（05 §3 未覆盖 submodule/LFS/sparse；06 §2 的模块仅 glob） |
| **规模** | "全树逐文件哈希"+"完整 diff 不截断"+"逐路径审查"在大型仓不可行；主会话上下文成本无预算 | **不成立**（大仓不可用，与 §4.2 的 context rot 叠加） |
| **遗留 / 无测试项目** | 只能大量 `exempt`；首个变更需凭空建立正式规格 | **缺口**（冷启动成本未评估） |
| **非 Git 项目** | 仅允许计划或生成非执行草案 | **合理但受限**（需在产品页明确写为限制） |
| **平台** | Windows 大小写 / CRLF / symlink 无处理路径；Codespaces 重建后 common-dir 丢失，跨会话恢复承诺不成立 | **缺口**（05 §3 末段只承诺同一逻辑仓库的跨会话/跨 worktree 恢复，未覆盖容器重建） |
| **并行 / 规模协作** | 正式规格随分支提交，并行分支下正式规格并非单一权威 | **缺口**（与 B3 叠加） |
| **宿主可移植性** | 强制面随宿主能力变化；pi 无合规原生派发，Codex 无只读隔离 | **最大约束**（见下） |

### 7.1 关于"跨宿主通用"的性质判定

现状下**不可能做到"跨宿主行为一致"**：可强制的程度由宿主决定（Claude Code 有 `tools` 白名单与 deny 规则；Codex 子 Agent 继承父权限；OpenCode 需逐通道核查；pi 无内建 subagent）。

因此"通用"必须重新定义为二选一：

- **定义 A（通用性 = 能力如实分级）**：每个宿主如实报告能做什么、缺什么时降级并停在门禁。方案方向已正确，但**承诺清单尚未同步降级**——[01-product.md](01-product.md) REQ-PRODUCT-014 与 [10-roadmap.md](10-roadmap.md) M4 仍以四宿主并列方式承诺。
- **定义 B（通用性 = 行为一致）**：在所有宿主上以同一方式执行同一门禁。**当前不可达**，除非放弃宿主原生派发、改为自建执行层——而 [09-hosts.md](09-hosts.md) §2 与 [11-decisions.md](11-decisions.md) ADR-003 明确禁止该方向。

**建议采纳定义 A**，并在文档中把"通用"一词的所有出现处补上限定，避免读者按定义 B 理解。

### 7.2 首批宿主收敛建议

| 宿主 | 建议 | 依据 |
| --- | --- | --- |
| Claude Code | **首批，优先** | 唯一原生可达只读隔离（`tools: Read, Grep, Glob`）、deny 规则跨模式生效、hooks 可作纵深防御 |
| Codex | **首批，降级** | 原生 subagent 可用；只读隔离不可得 → Reviewer 标 `audit-only` 并在门禁如实标注 |
| OpenCode | 延后 | 权限通道需逐项实测；[09-hosts.md](09-hosts.md) §3 已列为待核查 |
| pi | **移出首批** | 无内建 subagent；扩展与宿主同权限、无沙箱；官方示例即进程包装，违反 §6.2 与 ADR-017 边界 |

---

## 8. 最小可行版本建议

以下为提案，未生效。

### 8.1 保留（不可妥协的不变量）

1. 单一 `state.json` + revision + CAS 状态机；派生视图可重建。
2. `change` / `delta` / `baseHash` / ADD-UPDATE-REMOVE / 归档 tombstone。
3. 主会话唯一 Git 写入者；子 Agent 不动 index/HEAD。
4. 确定性门禁：结构、引用、依赖、追踪、证据齐备性由 CLI 判定。
5. 独立 fresh-context 只读 Reviewer（Claude Code 上用 `tools` 白名单兑现）。
6. 证据指纹与"修复使下游证据失效"语义。
7. 归档为事务（journal + staging + compare-and-write + 受控 reopen）。

### 8.2 延后

Epic 与 worktree 并行 → GitHub tracking 与 PR 集成 → 第三/第四宿主 → 安装器三方合并 → reopen 之外的复杂恢复分支 → CI 映射 → 多锁体系（先做单锁）→ 权限规则托管档（依赖企业环境）。

### 8.3 降级或改写

| 项 | 现状 | 建议 |
| --- | --- | --- |
| 角色脊柱 | architect / developer / tester / reviewer / verifier 五角色固定 | 收缩为"实现 + 独立 Reviewer + 确定性 Verify"；architect / tester / verifier 降为按需角色。**可核查性由门禁与证据保证，不由角色数量保证** |
| TDD cycle 状态机 | opened → red-accepted → green-passed → refactor-passed 多子状态 | 简化为"Red 证据 + 同测试 Green + 重构检查"，但**必须补"测试有效性"门禁**（能编译、断言非空、绑定到需求场景 ID），以对冲 SWE-bench+ / UTBoost 的假通过证据 |
| 指纹比较基准 | 工作树原始字节 + candidateTree 双记录 | 统一以 **Git blob 投影**为比较基准，工作树原始字节仅作诊断；baseHash 同样按 blob 投影计算，以消除 CRLF / .gitattributes 误报 |
| 门禁表述 | "确定性代码检查" | 拆为两层：**拒绝为不可核验的事实推进**（CLI 侧，跨宿主统一有效）+ **阻止越界行为**（宿主侧，按能力分级，多数不可得） |
| 变更 ID 复用 | 未禁止 | change ID 归档后禁复用，与 requirement ID 策略对齐 |

### 8.4 新增（当前缺失）

1. **显式上下文预算 + 阶段级新会话 + 状态外置**。方案已有 JSON 状态源，正好可承载外部化状态；这是对 §4.2 中最强证据的直接回应，也是当前方案最大的一处证据缺口。
2. **"测试有效性"门禁**（见 8.3）。
3. **宿主能力分级与承诺清单对齐**（见 §7.1、§7.2）。
4. **单 Agent 基线与成本对照**作为 v1 验收项（对应 arXiv:2606.17799 的方法论要求）。
5. **run/evidence 保留期与容量策略**（对应 §5.2 的 Roo 93GB 事故）。
6. **`rebaseline` 命令与 delta 三方合并语义**（解 B3）。

### 8.5 成本与质量的取舍表述

方案目前未给出"多角色 / TDD 两次派发"相对"单 Agent + 确定性门禁"的增量证据。论文证据（§4.2）指出该增量的期望值小、成本期望值大。**因此建议在 v1 中显式设置可观测指标**：单次真实变更的 Token 消耗、门禁实际拦截次数、返工轮次、端到端时长——并以单 Agent 基线对照，而不是以"流程跑通"作为成功判据。

---

## 9. 原提案的处理状态

原有五项提案已结合本轮证据重新评估，用户确认结果统一见文末第 13 节；本节不再保留第二份待决策清单。Codex/Claude Code 优先、自用项目先试点已同步；角色结构、严格 Reviewer 与 runtime 分发方式保持现方案。

---

## 10. 建议的文档修订清单

以下为原报告的修订建议，部分已在本轮处理，部分被纠正或留待决策。实际变更以第 12.2 节为准，不可将本表当成全部待办或既定方案。

| 文档 | 修订方向 |
| --- | --- |
| [AGENTS.md](../AGENTS.md) | 拆分"确定性检查"与"宿主阻断"两层表述；明确门禁的权威来源是事实核验 |
| [01-product.md](01-product.md) | REQ-PRODUCT-005/014/015 的措辞与实际强制能力对齐；新增"测试有效性""上下文预算"类需求 |
| [02-architecture.md](02-architecture.md) | 补强制面/宿主能力的模块归属；指纹比较基准改为 blob 投影 |
| [03-specification.md](03-specification.md) | change ID 禁复用；tombstone 索引 schema；rebaseline 语义；UPDATE 场景删除语义；REMOVE 引用检查；unresolved 与 RULE 关联的机器可读定义；修正 AND/THEN 示例 |
| [04-workflow.md](04-workflow.md) | 门禁语义分层；角色脊柱按决策调整；`verify-final` 与 CLI 命令名统一 |
| [05-runtime.md](05-runtime.md) | heartbeat 续租或替代的活性证明方案；spec-store 全局阻塞的范围限定；子进程写入的不可阻止性披露；保留期与容量策略 |
| [06-configuration.md](06-configuration.md) | 补 `policy.requireScopedWriteIsolation` 与 CI 映射字段 schema；`dependsOn` 语义 |
| [07-installation.md](07-installation.md) | runtime 提交与否按决策 5 调整；base 内容缓存位置；三方比较落地 |
| [08-cli.md](08-cli.md) | 补 `rebaseline`、锁续租/接管相关命令、index→tree→commit 映射记录；`phase/task/checkpoint` 参数；命令名统一；候选树证据命令 |
| [09-hosts.md](09-hosts.md) | 补 §6.1 的 Claude Code 事实（hook 强度、allowed-tools 语义、worktree baseRef、plugin 子 Agent 忽略项、后台/前台工具集差异）；pi 降级或移出首批；Codex Reviewer 标 audit-only；能力分级与承诺清单对齐 |
| [10-roadmap.md](10-roadmap.md) | 按最小可行版本重排里程碑；补 B2/B3 修复项与验证；新增上下文预算、测试有效性、基线对照验收 |
| [11-decisions.md](11-decisions.md) | 新增 ADR：强制面与门禁语义、首批宿主范围、runtime 分发、上下文预算、执行模型形态 |
| [12-references.md](12-references.md) | 补本次调研的论文与官方文档来源及查阅日期 |
| [13-workflow-review.md](13-workflow-review.md) | 修正静态检查结论的计数错误（22 份 Markdown / 2 个 JSON 示例 → 实测 27 份 Markdown / 0 个 JSON 示例） |
| [README.md](../README.md) | 增加本报告入口；按最终决策更新"当前状态" |

---

## 11. 原始复核结论（历史，已由第 12 节复核）

1. 方案的**规格与证据层设计质量高于同类开源实现**，尤其状态单一权威源、证据指纹失效语义、归档事务化三点，属于真差异化，应保留。
2. 方案的**强制面目前不存在**（B1），且**恢复路径存在死锁**（B2）、**并发规格变更无合法路径**（B3）、**规格引擎边界未闭合**（B4）。这四项是当前最应优先处理的问题。
3. 方案的**执行模型超载**：多角色与 TDD 双派发叠加的期望成本显著高于期望收益（§4.2），建议收缩角色脊柱并补上下文预算与测试有效性门禁。
4. 方案的**通用性只覆盖配置层**；跨宿主的通用性应重新定义为"能力如实分级"（定义 A），并据此收敛首批宿主。
5. 方案的**开源对标结论**：同类项目普遍只做到提示词流程 + 轻量状态，本方案所选方向正确但无先例可循；已知的真实事故（Roo 提前完成、93GB 历史、子 Agent 状态存宿主 DB、pi 进程包装示例）均已被本设计的相应条款覆盖或提示。
6. 方案的**论文证据基础总体支持其核心主张**（确定性检查、任务规范遵从、独立 Reviewer、需求澄清），但对**角色数量**、**上下文策略**与**测试有效性**三处构成挑战，且这三处恰是当前实现成本最高、验收最弱的部分。

以上为原始结论；本轮已修订部分权威文档，具体结果、限制及用户确认决策见下文。

## 12. 本轮交叉复核与已执行优化

### 12.1 复核结论与原报告纠偏

本轮读取当前权威设计、示例与原报告，并由两个只读子 Agent 分别核对规格/配置、运行恢复/安装/宿主约束；主会话核对证据并统一修改。仓库没有 `.codegraph/`，未进行索引或代码分析。以下判断针对本次修订前的文档，修订结果见下一节。

| 原条目 | 本轮结论 | 处理 |
| --- | --- | --- |
| B1 / M10：无强制点、自证循环 | **存在信任边界与证据来源接口缺口，但“全部门禁无效”不成立。** 05 §4、08 §4 已要求重新采集事实、不能只信 JSON；09 §5 已区分宿主隔离 | 补 CLI 状态推进与宿主越界阻断的边界，以及 approve/attach 来源核查。仍不防御恶意本地主机 |
| B2：heartbeat 不续租必然死锁 | **“死锁证明”不成立。** 原契约明确 heartbeat 仅诊断且已有 takeover；无停止证明时挂起是安全策略 | 补诊断刷新、可接受停止证据、无 state/接管中断恢复。未知写入者仍不能强行接管；固定锁顺序与重取后核对 revision 保留 |
| B2：全仓阻断 | 混合规格禁止读写是正确取舍，规格库身份与阻断边界不足 | 限定到事务所属 worktree/store，保留只读恢复诊断 |
| B3 / B4：重新基线与规格边界 | **主要成立。** 原已有完整块替换、冲突拒绝及零 delta 许可，缺少可操作细节 | 补索引、ID 生命周期、显式场景删除、引用阻断、零 delta、rebaseline、reopen 冲突路径 |
| M1 / M13：示例语法与边界 | **成立** | 改 AND，增加大于阈值场景，同步 proposal/design/tasks |
| M2 / M4 / M8 / M11 / M12 | **接口和机器语法缺口成立**；candidateTree 一致性并非原来完全没要求 | 补配置字段、CI 证据格式、推进/候选树接口、规则与未决问题语法 |
| M3：verify-final 与 CLI 不一致 | 属阶段名/命令名未说明对应关系 | 明确唯一 CLI 为 verify --stage final，保留可读的 checkpoint 名称 |
| M5：raw 字节与 blob 不同即不可用 | **结论过度。** 05 §7 已明确双记录与转换核验；只保留 blob 会漏掉命令实际读取的字节变化 | 保留双记录及显式换行冲突。修复全局 ignore 隐式影响；不改成 blob 单指纹 |
| M6：历史检查计数应改为 27 / 0 | **两份报告的数字均不应直接沿用。** 本轮按 git ls-files 固定范围，并解析 fenced JSON，而非仅数 .json 文件 | 撤回 13 中无法复现的数字，当前实际结果记录于 §12.4 |
| M7：TDD 无绿色基线 | **成立，限于 tdd cycle。** verification 原已有前基线通过要求 | 补默认绿色基线与 existing-failure 模式；仅本次授权目标缺陷的既有断言失败可按真实 Red 接受，无关失败阻断 |
| M9：退出码 0 同时表示查询/写成功 | **不构成缺陷。** CLI 调用成功与被查询 run 成功是不同事实，08 §3 已说明 | 保持接口，禁止脚本据 status exit 0 推断 run 成功 |
| §4 / §8：完全缺测试有效性门禁 | **误报。** 14 §3 已排除编译失败、无测试等假 Red，要求断言/场景语义复核 | 保留既有契约并补绿色基线，不声称通用工具可机械证明断言正确 |
| §7：完整 diff 大仓必然不可用 | **未证实。** 04 §7 原已要求分块审查；没有规模实测 | 补分片覆盖并集、预算不足挂起与实际成本观测，性能结论留待试点 |
| §6 / §7：Codex Reviewer 改 audit-only，pi 必须移出首批 | **产品取舍，不是事实修复。** 原契约已将四宿主列为目标、pi 能力未验证；Reviewer 缺只读须停门禁 | 不放宽只读要求、不改宿主范围。用户已确认的优先级与约束集中到文末 |
| §9：必须改 runtime 依赖分发 | **没有必然性。** 现有 ADR 选择提交 runtime 以支持离线 fresh clone | 补旧模板缓存与跨 worktree 版本校验，分发方向不变 |

不能将未发现 hook 视为没有状态机，也不能将文档写有门禁视为已实现隔离。当前最直接的实施风险是：**来源证据能否取得、宿主能否满足只读要求，以及新增状态/事务契约能否经故障注入闭合。** 这些在实现与实测前仍未通过。

### 12.2 已直接修改的权威文档与示例

| 文档 | 本轮实际修改 |
| --- | --- |
| [产品需求](01-product.md)、[宿主适配](09-hosts.md) | 明确 CLI 拒绝推进与宿主工具隔离的不同覆盖面；Reviewer 缺隔离继续阻断，逐版本/模式核查；固定 worktree 起点 SHA |
| [规格规范](03-specification.md) | change/scenario ID 禁复用；dependsOn 集成事实语义；UPDATE 显式列删除场景；REMOVE 引用检查；场景词法、Rules/Open questions 语法；派生历史索引 schema/重建；零 delta；rebaseline 预览/三方冲突/事务应用；reopen 被后续输出阻挡时的保守恢复路径 |
| [执行协议](04-workflow.md)、[CLI](08-cli.md) | verify-final 名称对应；具体 phase/task/checkpoint、test-cycle accept、dispatch 参数；授权来源核查；candidate capture/confirm 记录验证树到提交的映射 |
| [状态与恢复](05-runtime.md) | heartbeat 仅诊断及停止证据；锁创建/接管中断恢复；事务 store 边界；排除本机 ignore；runtime 版本绑定；特殊 Git 输入不支持时阻断；分片审查及上下文交接 |
| [配置](06-configuration.md) | requireScopedWriteIsolation 与 epicConcurrency 类型/默认/作用；CI 映射明确属于验证计划证据并定义字段，不凭空增加 config 键 |
| [安装](07-installation.md)、[架构](02-architecture.md) | 固定随仓保存的内容寻址旧模板缓存；缺失/损坏时拒绝猜测；增加历史索引/缓存目录说明 |
| [TDD 与交付](14-tdd-and-delivery.md) | TDD 默认从定向/回归全绿基线开 cycle；本次授权要修的既有业务断言失败可按 existing-failure 模式固定为 Red，无关失败仍阻断 |
| [路线图](10-roadmap.md) | 增加上述设计的实施验收、拒绝路径及同条件单 Agent 基线观测；全部仍未完成 |
| [参考资料](12-references.md)、[前次记录](13-workflow-review.md) | 增加抽查原文与适用范围，撤回无可复现范围的旧检查计数 |
| [proposal](../examples/change/proposal.md)、[delta](../examples/change/specs/session/delta.md)、[design](../examples/change/design.md)、[tasks](../examples/change/tasks.md) | AND 语法、三个阈值场景一致、规则引用与 none 未决语法 |

这些是设计契约优化，不是实现交付。审批、派发、测试、安装命令仍不能运行。

### 12.3 外部证据的适用范围

本轮抽查了两篇原始论文；原报告其余论文、仓库事故与宿主权限细节未逐条重新验证，不能引用“原报告已核实”来替代本项目版本实测。

- [tap 原文](https://arxiv.org/html/2606.14445v1) 中的异构/同构比例衡量的是审查记录含 finding 的比例，研究为单项目观察；它不能直接证明真实缺陷检出率提高，也没有单独识别 fresh-context 的因果收益。可作为独立审查的调查线索，不能写成通用收益承诺。
- [Engineering Sustainable Agents 原文](https://arxiv.org/html/2610.03010v1) 对比的是特定模型、任务及其非 Agent 基线；不能把相对成本外推为 Workflow 必然增加同等倍数，更不能直接推导出五角色必须删除。可支持在真实试点加入匹配基线、质量与成本共同观测。
- 原报告“V1 不做自动压缩”与“需要上下文管理”并非逻辑矛盾。状态外置、分片审查、阶段交接可独立实现；Workflow 不因此取得另启模型会话的权限。
- 宿主候选机制只提供待验证方向。不能仅凭 Claude Code 工具白名单就承诺所有旁路写入已隔离，也不能由 pi 的一个进程示例推断其未来所有版本永不合规。

### 12.4 实际验证与尚未验证范围

本轮运行静态检查：以 `git ls-files '*.md'` 固定 Markdown 范围，逐一检查本地链接目标、fenced JSON 语法及行尾空白；使用 PyYAML 读取 examples 中所有 YAML 文件；运行 `git diff --check`。实际范围为 26 份受跟踪 Markdown、111 个本地链接引用、2 个 fenced JSON、4 个示例 YAML；上述检查及 git diff --check 均通过。这里的 JSON 数是代码块数，不是独立 .json 文件数。

未执行引擎/CLI 测试、未做安装/升级/故障注入、未做四宿主原生派发/隔离实测、未重跑论文实验。没有把文档检查当成上述能力已通过。

后续实施仍须补齐：完整 JSON/AST schema 与诊断 fixtures、Windows 可执行文件解析细则、容量/保留策略的具体参数及 GC 计划、特殊 Git 输入支持矩阵、性能与上下文预算阈值。这些属于实施冻结前的明确待办，不能用本轮文档补充直接关闭 M0–M4。

## 13. 最后汇总：用户确认结果（2026-10-21）

用户已逐项确认 D1–D4。本节记录生效选择，不再保留待确认状态；确认设计方向不代表实现或宿主验收完成。

| 编号 | 已确认决策 | 执行边界 |
| --- | --- | --- |
| D1 | **Codex 和 Claude Code 优先，自用项目优先试点。** | 先在两个真实自用仓库观测闭环、质量、成本与拦截效果；逐宿主留证，至少一个宿主通过完整只读/原生执行验收才可报告完整闭环。OpenCode/pi 保留后续适配目标，不阻塞优先宿主试点，不列为首个预览的必交付入口 |
| D2 | **采纳先保留、再观测的建议。** | 当前保留五职责/阶段、独立 Reviewer 和 Red→Green 两次权限派发；根据试点成本与质量证据再决定 architect/tester/verifier 是否合并或按需。此次确认未授权直接删角色或跳阶段 |
| D3 | **保持现有 Reviewer 只读约束。** | 缺少已核实的只读隔离就停门禁；不改为 audit-only Reviewer。Codex 优先级不豁免此要求，能力不足时如实阻断并记录 |
| D4 | **保留当前 runtime 分发方案。** | 随仓提交固定版本 runtime/managed assets，保留离线 fresh clone 目标、旧模板缓存与跨 worktree 版本绑定，不改为依赖安装方案 |

同步位置：产品需求、完整方案、实施路线、宿主适配、执行协议、安装说明、README、项目约定及 ADR-008/014/017/018。未新增待用户确认事项；实现冻结前的技术待办仍见 §12.4 和路线图，全部保持未完成。
