---
name: workflow
description: 遵循当前宿主会话使用的项目本地 Workflow 协议。
---

默认中文；用户明确选择英文后切换。
从仓库根目录先运行 `node .workflow/runtime/workflow.js doctor`，再阅读 `.workflow/managed/protocol.md`、`.workflow/rules.md` 和 `.agents/skills/workflow/SKILL.md`。
主会话始终是唯一 Leader。仅当 doctor 对本宿主的派发、身份关联和权限隔离均有有效证据时，才用本宿主原生子 Agent 工具派发；否则停止并说明缺项。
派发前声明角色、需求/场景、固定基线、允许/禁止路径、验收证据和报告格式；完成后核对真实 Agent 身份、当前 attempt、改动路径和命令结果。勾选任务须由 Leader 根据证据完成。
安装不等于执行就绪；不得把未验证的阶段报告为完成。
