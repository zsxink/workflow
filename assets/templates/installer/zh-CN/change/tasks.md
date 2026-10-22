# 任务

将示例 ID、路径、场景和命令替换为本项目的真实值。每个任务应小而可独立验收，写清结果和证据；任务间依赖只表达真实先后关系，不形成循环。尽可能让任务的 Write-Scopes 互不交叠；确需共享路径时，在任务及 design 中说明协调和所有权。仅在任务完成并有相应证据后勾选；勾选不替代审查、验证或集成门禁。

`Test-Mode` 使用 `tdd`、`verification` 或 `exempt`：行为变化和 Bug 修复通常采用 `tdd`；独立补充覆盖或已有特征测试支撑的纯重构可采用 `verification`；`exempt` 必须有明确替代验收计划。`verification`/`exempt` 必须填写 `Test-Rationale`；`exempt` 还须填写 `Alternative-Acceptance`。无需求引用的纯维护任务写 `Requires: none`，并用 `Rationale` 解释适用性。命令 ID 必须来自项目配置；无适用测试范围或命令时写 `none` 并说明原因。测试范围须包含在任务写入范围内。

`Depends-On` 只表示同一 change 内的任务先后；跨 change 集成前提须由 Leader 在现有 `change.yaml` 的 `dependsOn` 声明，design 解释理由及共享资源的交接/重验。独立 worktree 不证明规格、接口或外部资源无冲突。任务正文及 Acceptance 应足够让 Leader 提取目标/非目标、依据、前置证据、路径、步骤与验收结果；沿用现有字段。

## [ ] TASK-001 — 替换为可独立验收的任务标题
- Requires: REQ-EXAMPLE-001
- Depends-On: none
- Write-Scopes: path/**, tests/path/**
- Test-Mode: tdd
- Test-Scopes: tests/path/**
- Test-Commands: replace-with-configured-command-id
- Acceptance: 关联场景 ID、可观察结果和完成证据；将示例值替换为真实内容。
