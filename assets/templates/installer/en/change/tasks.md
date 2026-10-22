# Tasks

Replace the example IDs, paths, scenarios, and commands with real project values. Keep each task small and independently acceptable, with a stated outcome and evidence. Dependencies should express real ordering and remain acyclic. Keep task `Write-Scopes` non-overlapping where possible; when paths must be shared, document coordination and ownership in the tasks and design. Check a task only after it is complete and supported by evidence; a check mark does not replace review, verification, or the integration gate.

Use `tdd`, `verification`, or `exempt` for `Test-Mode`: behavior changes and bug fixes normally use `tdd`; independent coverage work or refactoring supported by existing characterization tests may use `verification`; `exempt` requires an explicit alternative acceptance plan. `verification` and `exempt` require `Test-Rationale`; `exempt` also requires `Alternative-Acceptance`. For maintenance with no requirement reference, use `Requires: none` and explain applicability in `Rationale`. Command IDs must come from project configuration. Use `none` for an inapplicable test scope or command and explain why. Test scopes must be contained by the task's write scopes.

`Depends-On` only orders tasks within the same change. The Leader must declare integration prerequisites across changes in the existing `change.yaml` `dependsOn` field; design explains rationale and shared-resource handoffs/revalidation. Independent worktrees do not prove that specs, interfaces, or external resources are conflict-free. Task prose and Acceptance should let the Leader extract goals/non-goals, basis, prerequisite evidence, paths, steps, and acceptance outcomes using existing fields.

## [ ] TASK-001 — Replace with an independently acceptable task title
- Requires: REQ-EXAMPLE-001
- Depends-On: none
- Write-Scopes: path/**, tests/path/**
- Test-Mode: tdd
- Test-Scopes: tests/path/**
- Test-Commands: replace-with-configured-command-id
- Acceptance: Name the scenario IDs, observable outcome, and completion evidence; replace all example values.
