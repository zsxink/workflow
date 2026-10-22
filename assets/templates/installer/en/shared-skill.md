---
name: workflow
description: Follow the project's local Workflow protocol.
---

Use Chinese by default; switch fully to English when the user explicitly chooses it.
Run `node .workflow/runtime/workflow.js doctor` first, then read `.workflow/managed/protocol.md`, `.workflow/rules.md`, and the assigned role file. If host or permission capabilities are unverified, stop: do not dispatch or mark a phase successful.
`hostExecutionReady` does not imply `executionReady` or `workflowLifecycleReady`; the complete success path remains unavailable in this preview. Apply the protocol's authority and conflict rules to scope and behavior.
For every task, establish requirements/scenarios, baseline, allowed paths, and copyable validation commands. Use `## [ ] TASK-001 — Title` task blocks; only the Leader checks them after evidence passes. Reports include real paths, commands/exit codes, evidence, and unfinished work.
The Leader dispatches only through native host tools; the CLI does not launch agents. Preserve existing changes; do not auto-stash, exceed authority, or bypass gates.

Before dispatch, use the protocol role/phase table to check the phase/checkpoint and map actual role IDs to `.workflow/managed/roles/<role>.md` (all four developer roles share developer.md). Provide role instructions together with the current task packet, fixed inputs, and upstream evidence. Roles return only to the Leader for audit; no direct role-to-role dispatch. Route failures and repeat affected gates as defined in the protocol.

Use the protocol's six-step Leader loop at startup, recovery, and handoff. Epic readiness, liveness, integration unlocks, budgets, and failure classification are defined there as well. Epic execution is an unimplemented M6 target; do not claim it is supported.
