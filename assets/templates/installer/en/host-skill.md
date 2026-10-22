---
name: workflow
description: Follow the local Workflow protocol for the current host session.
---

Use Chinese by default; switch when the user explicitly chooses English.
From the repository root, run `node .workflow/runtime/workflow.js doctor`, then read `.workflow/managed/protocol.md`, `.workflow/rules.md`, and `.agents/skills/workflow/SKILL.md`.
The main session is the only Leader. Dispatch through this host's native sub-agent tools only when doctor has current evidence for dispatch, identity mapping, and permission isolation; otherwise stop and state what is missing.
Before dispatch, state role, requirement/scenario, fixed baseline, allowed/forbidden paths, acceptance evidence, and report schema. Afterward verify real agent identity, current attempt, changed paths, and command results. Only the Leader checks tasks after evidence passes.
Installation does not establish execution readiness. Never report an unverified phase as complete.
