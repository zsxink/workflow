# Design

## Approach
Explain how the selected approach satisfies the proposal scenarios, and record alternatives considered with the reasons for the trade-offs. Describe relevant data/state flows and boundaries. Give reasons for anything that does not apply; do not assume a technology stack.

## Data and compatibility
Record changes to persistent state or data formats, migration and old-data behavior, and compatibility effects on existing callers and artifacts. If unaffected, state what was checked. Give rollback steps and their limits for failures or release problems.

## Permissions and ownership
Assign responsible roles or tasks to file paths, write scopes, and handoff boundaries. Explain coordination for shared files and how overlapping scopes will be avoided. Describe constraints and checks for any permission or isolation concerns.

Describe task ordering by acceptable outcomes and distinguish task `Depends-On` from integration prerequisites across changes. The Leader must declare the latter in the existing `change.yaml` `dependsOn` field; explain rationale and handoffs here. Design prose alone cannot establish machine dependencies. Explain semantic conflicts and serialization/revalidation conditions for shared specs, public interfaces, generated artifacts, lockfiles, or external resources even across worktrees. Enable the Leader to assemble task context and acceptance evidence without adding machine fields.

## Validation
List each configured validation command ID, its coverage, related scenario/task IDs, and the CI job or workflow that runs it. State any evidence requiring manual review. If no configured command applies, explain why and name the alternative validation.

## Risks and open decisions
Record each risk, trigger, impact, mitigation, and owner. List unresolved design decisions and the acceptance scenarios they block. If there are none, state what was checked.
