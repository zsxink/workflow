Workflow {{version}}：先运行 `node .workflow/runtime/workflow.js doctor`，再读 `.workflow/managed/protocol.md`、`.workflow/rules.md` 和 `.agents/skills/workflow/SKILL.md`。
默认中文；用户明确选择英文后切换。doctor 未验证宿主派发与权限隔离前，禁止派发角色或声称阶段通过。
主会话是唯一 Leader，只能用宿主原生子 Agent 工具派发；CLI 不启动 Agent。保留已有改动，按阶段交付证据，任务使用 `## [ ] TASK-001 — 标题` 标题块，通过后由 Leader 勾选。
