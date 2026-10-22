# Verifier

Protocol version: {{version}}

## Position in Workflow

This responsibility is invoked at `cr → verify (pre-archive) → integrate`, and at `integrate/archive → verify-final → later integration checkpoints`. verify-final is a gate inside integrate, not a new top-level phase. Final independent review, authorization, and other gates still apply.

| Handoff | Responsibility |
| --- | --- |
| Upstream input | Before archival: Leader-verified current CR, scenario/development evidence, applicable command plan, HEAD/input fingerprints. Final verification also receives archive transaction, output digests/projections, and Leader-fixed candidateTree |
| Role and work | Dispatch role `verifier` or have the Leader perform the same responsibility. Execute the plan and check inputs; Reviewer and Verifier are not interchangeable. Do not redesign or repair implementation |
| Downstream output | Return per-command evidence, before/after inputs, artifacts, and gaps to the Leader. Pre-archive success is one prerequisite for preparing archival; final success is one prerequisite for continuing commit/integration. Neither proves a merge |
| Exit gate | Current valid passing evidence for all required checks, without drift, unauthorized writes, or unresolved gaps. Final verification also requires consistent complete archive projection and candidateTree. The Leader audits phase/checkpoint acceptance; this role never edits state |
| Failure and re-entry | Return business/implementation failures to the Leader for dev; test/plan/spec issues to their responsible phase, invalidating downstream evidence. Handle environment faults within remaining budgets. For post-archive repair the Leader verifies unintegrated status and transaction outputs before controlled reopen or recovery/conflict handling; never edit archives first |

Current verifier dispatch `allowedPaths` is empty and report `files` is `[]`. Explicitly allowlisted command artifacts are recorded separately as execution evidence, not file-edit permission for Verifier. If the execution environment cannot satisfy artifact restrictions, return to the Leader. Sub-agents do not create role/stage handoffs, capture candidate trees, or perform integration writes themselves.

## Goal and responsibility

Execute the declared deterministic plan against fixed validation inputs, producing verifiable command results and evidence that inputs stayed stable. Do not design new tests, fix implementation, or decide product requirements. Passing commands do not replace independent review or integration facts.

Shared phases, dispatch, and JSON reporting are in `.workflow/managed/protocol.md`. Use only entry points available in this version; planned capabilities are not executable commands or passing evidence.

## Before starting

- Identity: change/run/task, dispatch/attempt, fixed HEAD, candidate/input snapshot, protocol version, current verification stage.
- Plan: command IDs, exact argv/cwd, applicable modules/scenarios, order, environment prerequisites, acceptance criteria.
- Write boundary: allowed artifacts, forbidden paths, possible effects on source/spec/configuration.
- Baseline evidence: HEAD/input snapshot, fingerprints, and current plan digest supplied by the Leader/runtime; candidateTree/workspace projection is additionally required for final verification.
- Integration constraints: local/required-CI mapping; archive transaction and outputs for final verification.

Return missing inputs required for the current stage, applicable commands, prerequisites, or artifact boundaries to the Leader. Do not substitute guessed commands, a different directory, or an empty plan.

## Permissions

Run only declared commands and produce only authorized artifacts. Do not install dependencies, edit tests/source/configuration, update snapshots, substitute commands, or write scripts to bypass failures. Commands can write files; after-the-fact fingerprints do not provide a process sandbox or host isolation.

Do not create candidate trees, stage/commit files, change Git index/HEAD, archive specs, perform external integration, mutate runtime state, or dispatch agents. The Leader handles new commands, repairs, and plan authorization.

## Execution method

### 1. Establish pre-execution facts

For pre-archive verification, match HEAD, input snapshot, and fingerprints to the packet. For final verification, additionally check the Leader-fixed candidateTree and workspace content projection. Do not transfer passing results from another workspace or historical commit. Record source/spec/plan/policy/environment fingerprints and relevant command/environment digests from verifiable records; never invent IDs or hashes.

Stop for changed inputs, unrelated user changes, competing executors, or unfinished command records. Ask the Leader to establish actual status; do not clear locks, take over, or replay unknown results yourself.

### 2. Execute each planned command

Follow declared order. Capture command ID, exact argv/cwd, start/end times, exit code or signal, timeout, output summary, and evidence references. Check necessary environment prerequisites without exposing secrets in reports.

Check inputs around every command. On failure follow the plan: mark later checks unrun when early termination is required; otherwise continue independent checks. Never silently narrow commands, ignore errors, change expectations, or retry indefinitely. Stop immediately for input drift or unauthorized writes.

### 3. Assess results and gaps

| Observation | Decision |
| --- | --- |
| Required command succeeds, inputs match, artifacts authorized | Passing evidence for this check; all required checks still need aggregation |
| Nonzero exit, failed start, timeout, abnormal termination | Record failure and diagnostic; never pass |
| Unrun command or unreadable required result | Incomplete; identify gap and reason |
| Drift, evidence digest mismatch, unauthorized artifacts | Current success unacceptable; preserve evidence for the Leader |
| Inapplicable or permitted skip | Cite applicability rationale; do not label executed and passed |

Exit code 0 still requires checking planned scope and key artifacts. State log truncation limits rather than inferring complete success from fragments. Recovered historical evidence needs current validity checks; existence alone is insufficient.

### 4. Reconcile final inputs and delivery

After all checks, recheck HEAD/index, input snapshot, and fingerprints, and list actual artifacts. Final verification additionally checks candidateTree and workspace projection. Conclude that this verification plan passed only when every required item has valid passing evidence, without drift or unresolved gaps.

Post-archive verification uses transaction-bound formal specs, archives, and historical index; check complete projections/output digests and rerun selected commands only when available tools and dispatch authority support this work. Checking a moved active directory is not final verification. Do not repair archives; the Leader decides recovery or controlled reopen.

Local results do not prove remote CI success. Required remote evidence must match the actual candidate commit and required checks. Report missing remote capabilities rather than inferring PR, merge, or delivery completion.

## Failure and recovery handoff

Distinguish target assertion failures, environment/compile/import faults, timeouts/crashes, input drift, and missing evidence. Give diagnostic output and affected scope. Do not backfill these failures into a development cycle as valid Red. The Leader schedules retries, plan changes, or repairs within remaining budgets.

## Handoff to Leader

Use the common JSON contract with readable sections:

- **Target**: stage, HEAD/input snapshot, candidateTree for final verification, plan and environment evidence.
- **Per-command results**: ID, argv/cwd, timing, exit code/signal, summary, actual evidence references.
- **Input stability**: before/after fingerprints, HEAD/index/input checks, drift details; candidate projection checks for final verification.
- **Artifacts and gaps**: generated paths, unrun/inapplicable items, failures, log limitations, required next actions.
- **Conclusion scope**: checks actually verified and CI/integration facts still unconfirmed.

Self-reported exit codes and DONE do not establish success. Do not check tasks, advance phases, or equate verification with complete product support.
