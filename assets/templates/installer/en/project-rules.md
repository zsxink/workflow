# Project Execution Rules

This project-owned file defines policy, not runtime progress. Replace prompts with confirmed repository facts and references. Mark unknown items `unconfirmed`; explain inapplicable items. This document neither configures executable commands nor grants write or release permission.

## Project facts

- Purpose and primary users: unconfirmed; cite README or authoritative product docs.
- Architecture entry points and authoritative docs: unconfirmed; list real paths and their responsibilities.
- Modules and key data: unconfirmed; align module paths and data stores with `.workflow/config.yaml`.
- Runtime and compatibility: unconfirmed; cite version evidence rather than treating the local environment as a support matrix.

## Validation plan

Align with validation.commands in `.workflow/config.yaml`. For each entry, record command ID, full command, working directory, coverage, trigger conditions, permitted artifacts, and CI job/workflow. Include format, type, test, and build checks as applicable. Explain absent categories; never guess executable commands.

- Required commands: unconfirmed.
- Additional commands triggered by paths/behavior: unconfirmed.
- Manual acceptance and evidence location: unconfirmed.
- Local/CI differences and environment prerequisites: unconfirmed.

Unconfigured, unrun, and environment-failed commands cannot count as passed validation. Actual execution evidence must record exit code, result, and input identity.

## Path ownership and forbidden areas

List real specification/documentation, implementation, and test directories with maintaining roles and write scopes matching configured modules. Sequence shared-file handoffs through task dependencies rather than concurrent writers.

- Specification/documentation paths and owners: unconfirmed.
- Implementation/test paths and owners: unconfirmed.
- Generated artifacts and regeneration commands: unconfirmed; state delivery and validation rules.
- Forbidden paths: unconfirmed; secrets, production data, and unauthorized deployment configuration are off-limits by default.

## RULE-001 — Preserve existing changes

Check baseline and existing workspace changes before starting. Never auto-stash, overwrite, revert, or include content unrelated to the current change. Record evidence of path conflicts and hand them to the Leader.

## RULE-002 — Match evidence to scope

Acceptance evidence must match current requirements, scenarios, tasks, and candidate tree. Distinguish passed, failed, unrun, and inapplicable checks. Reassess affected evidence after specification, design, or project-policy changes; do not retain invalidated conclusions.

## Project-specific constraints

Append confirmed constraints as `## RULE-NNN — Title`, starting at RULE-003 without reusing IDs. State applicability, required behavior, and inspection evidence. Cover compatibility, security, migration, and rollback where needed, or write `no additional requirements`. Reference and disposition rules in the proposal's Rules section; these prompts are not confirmed policy.

Use Chinese by default for communication and documents; switch when the user explicitly chooses English. Report evidence of conflicts between docs and code so the Leader can synchronize authoritative policy and affected validation.
