---
name: workflow
description: 遵循项目本地 Workflow 协议。
---

默认中文；用户明确选英文后全程切换。
先运行 `node .workflow/runtime/workflow.js doctor`，再读 `.workflow/managed/protocol.md`、`.workflow/rules.md` 和对应角色文件。doctor 未证明宿主及权限能力时停止，不派发、不把任何阶段标成功。
`hostExecutionReady` 不等于 `executionReady` 或 `workflowLifecycleReady`；当前预览仍未开放完整成功链。按 protocol 的规范来源与冲突规则核对权限和行为依据。
每项任务先确认需求/场景、基线、允许路径和可复制验证命令；任务使用 `## [ ] TASK-001 — 标题` 标题块，证据通过后 Leader 才勾选。交付必须报告真实路径、命令/退出码、证据及未完成项。
Leader 只能通过宿主原生工具派发；CLI 不启动 Agent。保留已有改动；不自动 stash、不越权写入、不跳过门禁。

派发前按 protocol 的“角色如何接入阶段”核对阶段/检查点，映射实际角色 ID 到 `.workflow/managed/roles/<role>.md`（四种 developer 角色共用 developer.md），并将角色说明与当前任务包、固定输入和上游证据一同交付。角色回报只交 Leader 审计；不自行接力，失败按协议回流并重做受影响门禁。

启动、恢复和交接均按 protocol 的 Leader 六步循环处理；Epic 就绪、活性、集成解锁、预算和失败分类也以 protocol 为准。Epic 执行当前属于 M6 目标，尚未实现，不得宣称已支持。
