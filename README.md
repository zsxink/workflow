# Workflow

一个可安装到不同项目的 Agent 开发工作流，包含自研规格引擎、原生子 Agent 协作协议、运行恢复工具和安装器。

> 当前状态：`0.1.0-preview.1` 受限预览。已实现规格引擎、状态与文件事务内核、安全安装及部分 CLI；原生宿主身份、授权来源与 Reviewer 权限隔离尚未验收，完整开发、归档和集成入口保持阻断。具体边界见 [实现记录](docs/17-implementation.md)。

## 本地运行

需要 Node.js 22.12+ 和 Git；开发依赖由 lockfile 固定。

```sh
npm ci
npm run check
node bin/workflow.js --help
```

在已有提交的目标 Git 仓库中安装本地固定 runtime：

```sh
node /absolute/path/to/workflow/bin/workflow.js init --project /path/to/project --hosts codex,claude --operation-id install-001
node /path/to/project/.workflow/runtime/workflow.js doctor --project /path/to/project --json
```

`doctor` 在资产完整时可报告 `installed: true`，但当前 `executionReady: false`、退出码为 5。配置默认没有验证命令，接入项目必须自行声明范围、规则和验证计划。安装不会调用模型。

已开放 `init`、`doctor`、`upgrade`、`uninstall`、`change new/list`、`validate`、`trace`、`sync`、`run init`、`status`、`resume-plan`、`lock heartbeat`，以及只读 `change rebaseline --run ID`、`dispatch prepare/collect`、`test-cycle baseline`、`evidence show`。`sync` 只生成正式规格投影；派发包保持 planned，基线结果不自动推进阶段。升级和卸载默认只输出计划，应用需提供该计划的 `--plan-digest` 与 `--operation-id`；已改动的用户文件不被覆盖。所有命令支持 `--project` 和 `--json`。

`approve`、真实派发关联、TDD cycle 开启/接受/推进、阶段成功、`archive`、`verify`、`candidate`、`reopen/rebaseline` 应用、`recover/takeover`、`integrate`、tracking 和 Epic 尚未开放 CLI 执行。底层已有部分纯函数和事务测试，不代表这些流程可用。

## 已确定的方向

- 独立项目，技术栈、目录和验证命令由接入项目配置。
- 规格系统自行设计与实现，参考 OpenSpec、Spec Kit 的方法；不嵌入、不调用、不要求安装二者，也不承诺文件格式兼容。
- 一个版本化安装包，提供统一 `workflow` 命令、共享协议、角色和模板。
- 优先适配 Codex、Claude Code，自用项目先试点；OpenCode、pi 后续适配；当前主会话直接使用宿主原生子 Agent 机制，CLI 执行确定性检查、状态记录和恢复计算。
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
| [整体复核报告](docs/16-comprehensive-review.md) | 对方案的全面复核：工程可行性、论文证据基础、开源对照、宿主强制面与通用性；含本轮修正与用户确认结果 |
| [实现与验收记录](docs/17-implementation.md) | 当前 CLI、库级能力、测试范围和未完成项 |

[examples/](examples/README.md) 提供配置和完整变更 fixture；自动化测试会在临时 Git 项目中校验规格并比对同步结果。示例应用和其中的 npm 验证命令仍非可运行应用。

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

此段是完整版本的目标体验，尚非预览版的执行闭环；当前写命令还需要显式 operation-id，run 查询必须关联 run ID。

然后在宿主主会话中触发 `workflow session-timeout`，由共享 Skill 指导主会话完成设计、开发、审查、验证与集成。命令行本身不启动模型进程。

Node.js 为确定性工具运行环境；Workflow 不用 Node.js、其他脚本或 Agent CLI 启动子 Agent。Codex、Claude Code 是优先适配目标，OpenCode、pi 后续适配，具体原生派发和权限能力以 [宿主适配报告](docs/09-hosts.md)为准，尚未通过真实宿主执行验收。

## 当前仓库

源码位于 `src/`，测试位于 `tests/`，`npm run build` 生成单文件离线 CLI。运行依赖及许可证随 runtime 分发；没有引入其他规格产品实现。npm 包仍为 private，未公开发布；GitHub/tracking/Epic 及双仓真实宿主试点仍在路线图中。
