# 示例说明

这些文件展示自研 v1 格式，不依赖外部规格工具。规格与配置已作为 parser/CLI fixtures 在临时 Git 项目验收；示例应用本身尚未实现。

- [最小配置](config/minimal.yaml)：普通项目、本地集成、通用开发角色。
- [GitHub 配置](config/github.yaml)：展示 GitHub 集成与 GitHub Issues 事项来源适配器分别配置；事项来源可以指向与代码仓库不同的项目。
- [项目规则](rules.md)：长期约束。
- [示例变更](change/proposal.md)：新增会话空闲到期行为，包含 metadata、proposal、delta、design 和 tasks。
- [GitHub 事项关联片段](change/github-tracking.yaml)：可选的 `change.yaml` 片段，仅可用于配置了同名事项来源 provider（此例为 `github-issues`）的项目。它只提供事项来源和事项 ID，不是第二份 change 元数据权威源。`integration.profile: local` 的项目也可以配置并使用 GitHub 事项来源；`integration.profile: github` 的项目则可以将 `tracking.required` 设为 `false`，无需强制关联事项。
- [期望正式规格](expected/specs/session/spec.md)：CLI 同步投影的精确期望内容；当前未开放实际归档命令。

代码测试和应用源码尚未实现。将示例用于 fixture 时，应在临时项目提供对应源码和命令；`app-session-test` 中的 `npm test -- tests/session` 仅是 fixture 目标示意，当前不能直接运行。配置中的 npm 命令只展示用户项目如何声明验证，Workflow 自身不固定 npm 或任何技术栈。
