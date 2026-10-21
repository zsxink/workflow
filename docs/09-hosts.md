# 宿主适配与共享角色

## 1. 适配范围

首批优先适配 Codex、Claude Code、OpenCode、pi，配置 ID 分别为 codex、claude、opencode、pi。当前只定义工程契约，尚未完成四个宿主的真实安装和执行验收；具体发现路径、注册字段及权限机制在实施时按宿主版本固定。首批目标不等于已验证支持。

宿主适配包括入口生成、角色注册、能力声明和诊断，不通过外部 Agent CLI 适配模型运行时。主会话是 Leader，不派第二个 Leader 子 Agent，不为每个宿主复制整份阶段协议。

## 2. 原生派发边界

用户在任一宿主的当前会话触发 Workflow，该主会话直接使用本宿主提供的原生子 Agent 工具派发、等待、收集结果和处理后续消息。Workflow 的 adapter 只生成宿主入口/角色映射并核查能力，不持有 Agent 执行循环。

```text
宿主当前主会话
  → workflow dispatch prepare：任务包与 planned attempt
  → 宿主原生子 Agent 工具：实际派发并取得真实身份
  → workflow dispatch attach：关联该身份
  → 宿主原生等待/状态/结果工具
  → workflow dispatch collect：核查回报和证据
```

Node.js CLI 用于规格、状态、测试命令、事务、安装和仓库操作。禁止由 Workflow 的 Node.js/Python/shell 代码、SDK 包装器、RPC 驱动或 MCP 工具另启模型会话来执行角色；也禁止以 codex exec、claude -p、opencode run、pi 打印模式等 Agent CLI 代替原生派发。不能把同一条进程启动链藏在宿主扩展内后称为原生子 Agent。宿主内部如何实现其原生生命周期由宿主管理，Workflow 不接管该运行器。

允许宿主入口调用确定性 Workflow CLI；该调用不启动 Agent。若所需原生派发、结果关联或角色权限不能满足，报告 unknown/unsupported 并停在相应门禁，不降级为外部进程编排，不把缺能力当作角色已完成。

## 3. 首批宿主的机制核查

2026-10-21 的官方资料核查仅用于候选机制，未运行四宿主验收：

| 宿主 | 候选机制与核查重点 | 当前 Workflow 状态 |
| --- | --- | --- |
| Codex | [原生 subagent 工作流](https://developers.openai.com/codex/subagents)；工具名称、身份/状态和沙箱继承按具体客户端版本探测 | planned / execution-unverified |
| Claude Code | [原生 Agent 工具与角色注册](https://code.claude.com/docs/en/sub-agents)；工具白名单、独立上下文和角色权限 | planned / execution-unverified |
| OpenCode | [primary agent 调用 subagent](https://docs.opencode.ai/docs/agents/)；权限、派发和结果恢复按实际版本检查 | planned / execution-unverified |
| pi | [官方扩展机制](https://pi.dev/docs/latest)需进一步核查符合本契约的宿主会话内派发；不能采用官方示例中的外部 pi 进程启动方式 | planned / native-dispatch-unverified |

pi 的[官方 subagent 示例源码](https://raw.githubusercontent.com/badlogic/pi-mono/main/packages/coding-agent/examples/extensions/subagent/index.ts)显式使用子进程启动 pi，该示例不满足本项目派发约束。不能由示例推断 pi 所有版本永久缺少原生能力，也不能默认安装第三方扩展绕过约束；先调查具体版本，只有发现并验证合规机制才标 execution-ready。

原生派发和只读隔离分别核查。例如 Codex 官方文档说明子 Agent 继承父会话权限，角色提示词不创建单独只读沙箱；OpenCode 文档也提醒部分受限角色仍可使用 shell。安装角色定义、禁用编辑工具或角色名叫 readonly，都不足以证明所有命令/连接器写入通道已隔离。

## 4. 安装资产

共享协议、公共角色位于 `.workflow/managed/`；标准共享 Skill 入口位于 `.agents/skills/workflow/`，指向本地固定版本协议和 runtime。宿主专属目录中只生成其确实需要的入口/注册薄壳。

V1 使用普通文件和明确相对引用，避免依赖平台符号链接权限。所有生成文件进入 install manifest，项目已有同名入口按冲突处理。AGENTS.md 用唯一管理区块追加入口说明，保留项目已有约定。

## 5. 能力契约

```text
readFiles, searchFiles, writeFiles, shell, gitRead,
nativeSpawn, nativeMessage, nativeStatus,
readOnlyIsolation, scopedWriteIsolation, cancellation
```

每项报告 supported/unsupported/unknown 及依据、宿主版本、核查时间。安装发现、执行原生派发、角色权限限制是三种不同事实，文件存在不能证明 runtime 可用。

报告另含宿主 ID/客户端版本、实际派发工具或机制、角色注册位置、子 Agent 身份类型、完成结果获取方式及扩展依赖（如有）。扩展也须注明版本、来源和派发实现；未知能力不得仅由名称或入口文件推定 supported。结果能够关联真实派发是必要条件，不能以无关联的日志文本冒充子 Agent 回报。

原生工具的交互探测由当前主会话发起并保存证据；doctor/inspectCapabilities 只核查配置、已提供的宿主证据及其版本/时效，不为探测能力自行启动 Agent。宿主没有暴露状态或取消工具时如实报告，不伪造支持；恢复中写入者活性不明时维持挂起，不能为了续跑改用 CLI 重派。

只有 nativeSpawn 与角色必需能力满足才执行多 Agent 阶段。Reviewer 要求只读隔离；宿主不能提供时报告 unsupported 并停在该门禁，不能把 prompt “请只读”或事后快照当作事前隔离。写角色若仅支持全工作区写，明确标为 audit-only 范围保障；项目策略可以只允许严格 scopedWriteIsolation，具体选择记录在 policy 指纹。

宿主权限始终由宿主控制，Workflow 不能批准宿主本身拒绝的访问。缺能力时提供人工完成门禁的明确路径，但不冒称原生自动化验收通过。

## 6. 公共角色

| 角色 | 职责 | 默认边界 |
| --- | --- | --- |
| architect | 在已批准范围内补设计和任务 | 仅 design/tasks，不能改变需求 |
| developer | 任务内 Red/Green/Refactor、实现及相关检查 | Red 仅 Test-Scopes；接收后由主会话新派 Green 的实现范围 |
| tester | 场景映射、必要测试与验收 | 明确测试范围；修改实现需重派授权 |
| reviewer | 独立审查行为、兼容性和证据 | 只读，不改 Git |
| verifier | 指定源码基线的验证计划 | 只允许声明产物写入 |

角色正文不含具体模型名、宿主工具名或项目路径。技术栈和任务范围通过派发包注入。项目可额外定义角色，但不能取消基本所有权与证据规则。

## 7. 共同验收

四个宿主共用“同规格、同任务、同阶段输出”的契约 fixture，分别验证注册、找到本地 runtime、主会话原生派发、真实身份关联、等待/结果回传、只读角色、失败与恢复。真实宿主不可用时明确 blocked/unverified，模拟 fixture 只能证明模板与协议，不证明真实宿主能力。

验收必须确认 Workflow CLI/模板/扩展未通过进程、RPC 或 SDK 包装器另启 Agent。还应覆盖派发失败、能力禁用、结果无法关联、中断后的子 Agent 活性不明和权限不足等拒绝路径。四宿主逐项记录 install-supported、native-dispatch-verified、role-isolation-verified 和 execution-verified；不能用一个宿主的成功替其他宿主背书。

宿主功能变化后需要更新版本支持表并回归；工具不能从产品名称推断永久能力。发行说明按宿主逐项列 install-supported 与 execution-verified 状态。
