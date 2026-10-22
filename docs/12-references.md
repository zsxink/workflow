# 参考资料与工作流取舍

查阅日期：2026-10-21。这里只记录思路来源，不表示引入代码或兼容上游格式。上游 main 会变化，未来实现应以本项目已版本化协议为准。

## 2026-10-22 本地工作流对照

本轮读取 MarkFlow 的 `markflow-issue` 和 MusicTag 的 `pipe epic` 定义及相关角色/前置检查脚本，比较可迁移的机制。仅作静态阅读，没有运行两仓的工作流、修改其文件或验证宿主/远端闭环。以下路径相对于各参考仓库，不作为 Workflow 运行依赖；内容摘要固定本次读取的工作区版本，不假定未提交内容等于仓库 HEAD。

| 参考文件 | SHA-256 |
| --- | --- |
| MarkFlow：`.claude/commands/markflow-issue.md` | `19197f6e57f14a2652284cef6024d5548a12adf7571cee4bfe15be87a69715f3` |
| MusicTag：`.agents/skills/pipe/WORKFLOW.md` | `34a28200afdb2445fea73743b1bf9397cc93eb95169d0e43315470545f1feb03` |
| MusicTag：`.opencode/commands/pipe-epic.md` | `5daba05b30d39fd7b517039e79ab7976fb6c37b15c9cb2ae0eec7a886549cc11` |
| MusicTag：`.agents/workflows/pipe-epic-preflight.sh` | `f86e1b9a03903b7ff830ea29995349732a1077a49e368f3af17ffff8234e0ed0` |

| 观察到的机制 | 当前 Workflow 的取舍与优化 |
| --- | --- |
| MarkFlow 命令第 20–40、236–378 行：显式阶段门禁、Apply/Verify 独立实例及严格结果检查 | 保留已有五职责与公共 JSON，不压成 Apply/Verify 两角色；在[执行协议](04-workflow.md)补主会话逐次核查循环与最小完整派发上下文，结果数量和 DONE 均不代替证据 |
| MarkFlow 第 380–518 行：有界修复、fresh verifier、归档后再次验证与累计修复预算 | 保留已有独立 Reviewer、确定性 Verifier 和 verify-final；明确失败分类/回流。归档恢复仍用 Workflow 的 journal/reopen，不移植直接移动目录的恢复方式 |
| MusicTag WORKFLOW 第 15–38、67–77 行及 Epic 入口：核对在途执行者、先查事实再做 checkpoint，running 不因恢复被重置 | 补充 Leader 的等待/结果不明处理；按真实身份复用已有 worktree/run/PR，禁止重复写入者；沿用 JSON 状态与生成视图，不以 Markdown 状态为权威 |
| MusicTag WORKFLOW 第 73–77 行及 preflight 第 42–85 行：DAG、逐项工作树、刷新完成事实、有限并发 | 补齐 Epic 就绪/容量/起始基线/阻塞传播/恢复收尾契约；与单变更门禁组合。事项关闭不是通用完成事实，local/github 各用自身集成事实；M6 仍未实现 |
| 两个流程都把集成写入集中在主会话 | 保留已有唯一 Leader，不派发递归子 Leader 或启动完整子流水线；子 Agent 只交回其角色产物，主会话验收后接力 |

没有移植的约定：MarkFlow 的 OpenSpec 命令/产物状态、逐阶段重复确认、归档前 force-continue、固定 GitHub 关闭语法及技术栈验证；MusicTag 的产品需求、目录布局、专用角色、cargo/npm 基线、专项审查维度和 Markdown 进度写入。Workflow 继续使用自研规格、原生子 Agent、确定性门禁和事务；既有授权不重复申请，质量与隔离门禁没有强制放行开关。

本轮落点为权威协议、规格填写指引、双语安装模板与路线图。未新增机器 schema、CLI 能力或 Agent 编排运行时；安装模板变更不证明真实宿主、Epic 或集成已验收。

## OpenSpec

来源：[官方仓库](https://github.com/Fission-AI/OpenSpec)。参考其将长期行为规格与单次变更产物关联的组织思路：变更具有 proposal、specs、design、tasks，完成后归档并更新正式规格。

Workflow 的稳定 ID、增量语法、指纹、证据和事务规则由本项目定义；不采用上游 CLI、不导入其运行时或源码，也不跟随上游升级自动改变协议。

## Spec Kit

来源：[官方仓库](https://github.com/github/spec-kit)、[规格模板](https://github.com/github/spec-kit/blob/main/templates/spec-template.md)、[任务模板](https://github.com/github/spec-kit/blob/main/templates/tasks-template.md)。

参考可独立验收的用户场景、可观察成功条件，以及任务依赖和明确文件范围的表达方法。Workflow 将这些方法转成自身的 requirement/scenario/task 引用与证据检查。

## 借鉴边界

所有示例为本项目重新编写。文档说明的是方法上的取舍，不表示两个上游产品共有本项目的门禁或执行语义。未来若实际复用任何第三方代码或模板，另行记录来源、固定版本、许可与 notices；当前方案没有这类内嵌实现。

## 2026-10-22 模板优化核查

本轮实际读取以下上游 main 文件，以方法参考重新编写本项目模板，没有复制模板正文。链接为可变上游位置，不是 Workflow 的运行依赖；本项目随版本固定 `assets/templates/` 内容，后续不自动跟随上游变化。

| 官方文件 | 参考方法 | Workflow 中的落点与取舍 |
| --- | --- | --- |
| [OpenSpec proposal](https://github.com/Fission-AI/OpenSpec/blob/main/schemas/spec-driven/templates/proposal.md) | 问题动机、能力影响和变更范围 | proposal 提示记录现状证据与受影响能力；保留自身机器章节和零 delta 判定，不采用上游元数据开关 |
| [OpenSpec design](https://github.com/Fission-AI/OpenSpec/blob/main/schemas/spec-driven/templates/design.md) | 关键决策、备选与风险取舍 | design 增加方案依据、恢复与回滚、风险责任方，避免只列技术步骤 |
| [Spec Kit spec](https://github.com/github/spec-kit/blob/main/templates/spec-template.md) | 独立可验收的场景与可衡量结果 | proposal/Architect 明确场景输入、动作、可观察结果；仍用本项目 REQ/SCN ID 与 delta 语法 |
| [Spec Kit tasks](https://github.com/github/spec-kit/blob/main/templates/tasks-template.md) | 任务依赖、明确文件路径和可独立验证 | tasks 提示路径所有权和依赖；保留自身任务标题、Test-* 与任务内 TDD，不采用上游可选测试或逐任务提交约定 |
| [Spec Kit constitution](https://github.com/github/spec-kit/blob/main/templates/constitution-template.md) | 将长期原则与治理依据显式化 | rules 提供稳定 RULE ID、适用范围和核对依据；命令配置和运行证据仍各有权威源，不增加第二份执行状态 |

角色模板以“输入与边界、工作要求、交回 Leader”组织；公共 JSON 回报字段沿用已有 v1 契约，Markdown 仅提供可读说明，不产生批准或执行证据。安装与宿主入口保留短指引，完整流程集中在 protocol；中文和英文采用对应结构。

## 首批宿主原生子 Agent 机制

2026-10-21 实际读取以下官方资料，作为 [宿主适配](09-hosts.md)的调查证据；文档核查不代替具体安装版本的实测，也不作为四宿主已支持声明。

- [Codex Subagents](https://developers.openai.com/codex/subagents)：原生派发、线程控制、角色配置与父会话权限继承；角色提示词不能建立独立只读沙箱。
- [Claude Code Subagents](https://code.claude.com/docs/en/sub-agents)：Agent 工具、角色注册、独立上下文与工具/权限限制。
- [OpenCode Agents](https://docs.opencode.ai/docs/agents/)：primary/subagent 机制与角色权限；需要逐通道核查 shell 等能力。
- [pi 官方文档](https://pi.dev/docs/latest)与[官方 subagent 扩展示例](https://raw.githubusercontent.com/badlogic/pi-mono/main/packages/coding-agent/examples/extensions/subagent/index.ts)：文档提供宿主扩展入口，该示例使用子进程启动 pi，不作为本项目原生派发实现。未核实其他合规机制前保留 unknown。

## 综合复核抽查的论文证据

2026-10-21 读取下列原始论文 HTML，核对摘要、研究范围与结果含义；未重跑实验。其余综合报告引文未在本轮逐篇复验，不据此改变产品承诺。

- [tap，arXiv:2606.14445v1](https://arxiv.org/html/2606.14445v1)：观察单一项目中的异构审查，记录 finding 的比例不等同于真实缺陷检出率，也不能证明 fresh-context 的独立因果收益。
- [Engineering Sustainable Agents，arXiv:2610.03010v1](https://arxiv.org/html/2610.03010v1)：研究六种开放权重模型与五类任务，成本相对其非 Agent 基线；不足以直接预测 Workflow 的成本或证明必须减少角色。它支持在真实试点中加入匹配基线。
