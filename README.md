# Workflow

一个可安装到不同项目的 Agent 开发工作流，包含自研规格引擎、原生子 Agent 协作协议、运行恢复工具和安装器。

> 当前状态：方案与示例已建立，CLI、规格引擎和宿主适配尚未实现。文档中的命令、接口和安装效果均为目标设计，不能当作已可用功能。

## 已确定的方向

- 独立项目，技术栈、目录和验证命令由接入项目配置。
- 规格系统自行设计与实现，参考 OpenSpec、Spec Kit 的方法；不嵌入、不调用、不要求安装二者，也不承诺文件格式兼容。
- 一个版本化安装包，提供统一 `workflow` 命令、共享协议、角色和模板。
- 首批适配 Codex、Claude Code、OpenCode、pi；当前主会话直接使用宿主原生子 Agent 机制，CLI 执行确定性检查、状态记录和恢复计算。
- 需求、场景、任务、审查、验证证据可追踪；完成结论由事实支撑。
- 默认本地 Git 工作流；PR/CI 是可选仓库集成。事项来源由独立项目管理适配层接入，先支持 GitHub Issues，可与仓库集成独立组合。

“不依赖其他”指无需 OpenSpec、Spec Kit、其他工作流产品或常驻服务。目标使用环境仍包含 Node.js、Git 和支持相应能力的 Agent 宿主；项目自身的构建工具由项目提供。普通解析库可以随安装包分发，不承诺零第三方代码。

## 阅读顺序

| 文档 | 内容 |
| --- | --- |
| [完整方案](docs/PLAN.md) | 目标、关键选择、交付边界与整体闭环 |
| [产品需求](docs/01-product.md) | 用户故事、需求编号、验收标准 |
| [工程架构](docs/02-architecture.md) | 源码组织、模块边界、数据目录、依赖方向 |
| [规格规范](docs/03-specification.md) | 自研格式、稳定 ID、增量、校验、同步与归档 |
| [执行协议](docs/04-workflow.md) | 阶段、角色、任务、证据与决策边界 |
| [状态与恢复](docs/05-runtime.md) | 单一状态源、锁、指纹、崩溃恢复与集成事务 |
| [项目配置](docs/06-configuration.md) | 配置字段、项目规则、命令与路径约束 |
| [安装与升级](docs/07-installation.md) | 发布、安装、固定版本、升级与卸载 |
| [CLI 契约](docs/08-cli.md) | 命令、结构化输出、退出码与幂等语义 |
| [宿主适配](docs/09-hosts.md) | 原生协作能力、共享角色与权限检查 |
| [实施计划](docs/10-roadmap.md) | 里程碑、任务依赖、验证与发布门禁 |
| [设计决策](docs/11-decisions.md) | 决策依据、代价与未来扩展边界 |
| [参考资料](docs/12-references.md) | 已查阅的官方资料及参考范围 |
| [工作流复核](docs/13-workflow-review.md) | MusicTag / MarkFlow 对照、设计缺口与修正依据 |
| [TDD 与交付](docs/14-tdd-and-delivery.md) | Red/Green/Refactor、Spec 归档、Git 提交与合并顺序 |
| [事项适配](docs/15-tracking-adapters.md) | 项目管理来源接口、GitHub Issues 首个实现及与仓库集成的边界 |
| [整体复核报告](docs/16-comprehensive-review.md) | 对方案的全面复核：工程可行性、论文证据基础、开源对照、宿主强制面与通用性；含待决策事项 |

[examples/](examples/README.md) 提供接入项目的配置和一组完整的规格、设计、任务示例。它们是设计样本，不代表 CLI 已生成或验证过这些文件。

## 目标体验

```sh
# 将来发布后的接口示意，包名待正式发布前确认
npm install -g <published-package>@<exact-version>
cd your-project
workflow init --hosts codex --profile local
# 主会话先按项目策略准备独立变更分支和干净工作树
workflow change new session-timeout
workflow validate session-timeout --gate spec
workflow status session-timeout
workflow resume-plan session-timeout
```

然后在宿主主会话中触发 `workflow session-timeout`，由共享 Skill 指导主会话完成设计、开发、审查、验证与集成。命令行本身不启动模型进程。

Node.js 为确定性工具运行环境；Workflow 不用 Node.js、其他脚本或 Agent CLI 启动子 Agent。四个宿主是首批适配目标，具体原生派发和权限能力以 [宿主适配报告](docs/09-hosts.md)为准，尚未通过真实宿主执行验收。

## 当前仓库

当前交付只有方案、示例、项目约定及基础元数据。未安装依赖、未导入第三方项目代码、未发布 npm 包、未创建远端仓库。
