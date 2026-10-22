# Markdown 模板维护

模板提供填写指引，不是已批准的规格或可执行证据。默认中文，英文与中文保持同等契约；机器字段、ID、路径和 front matter 不随语言翻译。

| 源文件（位于 `templates/installer/<language>/`） | 用途与输出 |
| --- | --- |
| `agents-block.md` | AGENTS.md 中的托管启动区块，由安装器添加边界标记 |
| `shared-skill.md` | `.agents/skills/workflow/SKILL.md`，定位协议和任务约束 |
| `host-skill.md` | 宿主薄入口，检查当前宿主派发与权限证据 |
| `protocol.md` | `.workflow/managed/protocol.md`，阶段、门禁及公共回报契约 |
| `roles/*.md` | `.workflow/managed/roles/`，角色输入、路径边界、工作与交接要求 |
| `project-rules.md` | `.workflow/rules.md` 初始内容，生成后由项目维护 |
| `change/{proposal,design,tasks}.md` | `change new` 创建的变更草案，生成后由项目维护 |

可用语言为 `zh-CN` 与 `en`。`{{version}}` 由安装资产渲染，变更 proposal 的 `{{title}}` 由变更 ID 生成；其他填写提示需由主会话按仓库事实处理，不能留下示例命令、路径或 ID 后宣称可执行。新增占位符前须同步调用方提供的值。规格增量和正式规格的完整格式见 [规格规范](../docs/03-specification.md) 和 [示例](../examples/README.md)，当前 `change new` 不自动创建 delta。

先更新权威契约再改模板；阶段规则集中在 protocol，入口只保留必要启动约束，角色不重复另造回报 schema。上游参考与取舍见 [参考资料](../docs/12-references.md)。不要复制上游命令、元数据字段、技术栈或运行时。

角色文件按执行手册维护：目标、启动输入、允许/禁止操作、分步方法、证据标准、停止/升级和可读交接结构。Architect 重在行为与方案、Developer 重在测试步骤配对、Tester 重在独立覆盖、Reviewer 重在完整 diff 和可复核发现、Verifier 重在固定输入及逐命令结果。检查维度按影响与风险选用，不机械扩展任务范围；角色报告仍使用 protocol 中的公共 JSON 契约。审查严重度采用引擎已有的 blocker/major/minor/info，不另外发明枚举。

每份角色文件先说明在 Workflow 中的位置：从哪个阶段进入、接收哪些上游产物、使用哪个角色 ID、交付给谁、满足什么退出门槛、失败返回哪里。角色不会自行接力；阶段接受、证据失效和再次派发由 Leader 核实。Developer 的 Red/Green 共用 `developer.md`，是 dev 阶段内不同 attempt；最终 Reviewer/Verifier 在 integrate 的门禁中复用角色职责，不新增顶层阶段。完整交接契约见 [工作流协议](../docs/04-workflow.md)。

当前 `dispatch prepare` 生成 planned 包及上下文路径，不自动加载角色正文或证明阶段成功。原生派发前 Leader 按 protocol 的映射，将角色文件、当前阶段/检查点、项目规则、任务包和上游证据一起提供给子 Agent；不能把本轮文档衔接描述成已实现自动派发或阶段推进。

草案可暂缺 design/tasks；`dispatch prepare --role architect` 可不传 task，生成仅授权该变更 design/tasks 的 change scope planned 包，其报告 taskIds=[]。任务级派发仍精确关联一个任务；Developer 的 verification/exempt 包绑定真实任务模式与验收计划，不伪造 cycle 或批准。Architect 应按明确写入 scope 工作；未授权的规格细化交 Leader 决定。模板中的权限来源与冲突顺序、正常 attempt 输入接收、Tester 补测回归和 readiness 字段含义需中英文同步维护；hostExecutionReady 不代表 executionReady 或 workflowLifecycleReady。

构建脚本将模板嵌入单文件 runtime。修改后运行 `npm run check`；其中 CLI 测试覆盖双语草案和打包后离线生成，安装测试覆盖幂等、冲突及用户内容保留。文档测试不构成宿主权限隔离或真实闭环验收。托管模板变更会改变内容摘要，已有项目通过安装/升级计划处理；项目自有 rules 与变更文档不作为可覆盖的托管资产。

产物接收分为纯领域转换与应用只读审计。`dispatch audit` 从派发准备的完整起始 manifest 与真实工作树核对差异，不执行接收或标记成功；角色说明不得把该诊断当作宿主身份、授权或替代验收来源。Tester 的删除场景矩阵使用 current/removal 用途区分，与规格追踪一致。接收中的命令时序同时绑定派发序列和观察进程，不以重启后碰巧相同的计数认证旧派发。

维护 Leader 执行循环、可读派发上下文、Epic 调度边界和决策/预算分类时，以 `docs/04-workflow.md` 为权威：双语 `protocol.md` 精简同步执行契约，`shared-skill.md` 只引导查阅；Architect、design 和 tasks 模板仅补充验收拆分、任务依赖与集成依赖的区分及派发证据要求。保持两种语言语义一致，不复制整份权威契约、不增加 JSON/CLI 字段或角色。Epic 调度入口属于 M6，当前未实现；模板更新不代表运行时能力已交付。
