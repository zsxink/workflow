# {{title}}

## Problem
Describe the observed problem with repository evidence and link a tracking issue when available. Record the affected capability, reproducible conditions, current outcome, and impact; cite files, symbols, logs, or scenarios instead of relying on opinion.

## Goals
State outcomes users or maintainers can observe and verify. Avoid describing implementation steps as goals.

## Scope
List the behavior and capabilities this change is authorized to affect, plus the exact project-relative paths that may change. Describe changes to inputs, outputs, or boundary behavior so tasks and ownership can be checked.

## Non-goals
List adjacent behavior this change will leave untouched to keep its scope clear.

## Acceptance
List stable scenario IDs (for example, `SCN-<CAPABILITY>-001-01`) with preconditions, action, observable outcome, and a measurable boundary. Each measure should be decidable through a test, check, or user-visible result. For zero behavior delta, explain the reason, cite evidence, and state how the maintenance outcome can still be accepted.

## Rules
none — Check `.workflow/rules.md`. When citing rules, replace this entire paragraph with entries such as `- RULE-001: disposition and verification references`, and disposition the remaining rules individually. Keep none with a reason only when no rules apply.

## Open questions
- QUESTION-001 | unresolved | behavior | State the undecided behavior, available evidence, and its effect on scope or acceptance; replace this line with `none` when no questions remain. Keep resolved questions in this format and cite decision evidence.
