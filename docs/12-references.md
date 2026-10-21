# 官方参考资料

查阅日期：2026-10-21。这里只记录思路来源，不表示引入代码或兼容上游格式。上游 main 会变化，未来实现应以本项目已版本化协议为准。

## OpenSpec

来源：[官方仓库](https://github.com/Fission-AI/OpenSpec)。参考其将长期行为规格与单次变更产物关联的组织思路：变更具有 proposal、specs、design、tasks，完成后归档并更新正式规格。

Workflow 的稳定 ID、增量语法、指纹、证据和事务规则由本项目定义；不采用上游 CLI、不导入其运行时或源码，也不跟随上游升级自动改变协议。

## Spec Kit

来源：[官方仓库](https://github.com/github/spec-kit)、[规格模板](https://github.com/github/spec-kit/blob/main/templates/spec-template.md)、[任务模板](https://github.com/github/spec-kit/blob/main/templates/tasks-template.md)。

参考可独立验收的用户场景、可观察成功条件，以及任务依赖和明确文件范围的表达方法。Workflow 将这些方法转成自身的 requirement/scenario/task 引用与证据检查。

## 借鉴边界

所有示例为本项目重新编写。文档说明的是方法上的取舍，不表示两个上游产品共有本项目的门禁或执行语义。未来若实际复用任何第三方代码或模板，另行记录来源、固定版本、许可与 notices；当前方案没有这类内嵌实现。

## 首批宿主原生子 Agent 机制

2026-10-21 实际读取以下官方资料，作为 [宿主适配](09-hosts.md)的调查证据；文档核查不代替具体安装版本的实测，也不作为四宿主已支持声明。

- [Codex Subagents](https://developers.openai.com/codex/subagents)：原生派发、线程控制、角色配置与父会话权限继承；角色提示词不能建立独立只读沙箱。
- [Claude Code Subagents](https://code.claude.com/docs/en/sub-agents)：Agent 工具、角色注册、独立上下文与工具/权限限制。
- [OpenCode Agents](https://docs.opencode.ai/docs/agents/)：primary/subagent 机制与角色权限；需要逐通道核查 shell 等能力。
- [pi 官方文档](https://pi.dev/docs/latest)与[官方 subagent 扩展示例](https://raw.githubusercontent.com/badlogic/pi-mono/main/packages/coding-agent/examples/extensions/subagent/index.ts)：文档提供宿主扩展入口，该示例使用子进程启动 pi，不作为本项目原生派发实现。未核实其他合规机制前保留 unknown。
