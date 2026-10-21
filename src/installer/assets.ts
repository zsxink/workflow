import { hostEntry, type InstallHost } from '../hosts/index.js';

export const PACKAGE_VERSION = '0.1.0-preview.1';
export const ASSET_FORMAT_VERSION = 1;
export const BLOCK_START = '<!-- WORKFLOW:MANAGED:START -->';
export const BLOCK_END = '<!-- WORKFLOW:MANAGED:END -->';
export const AGENT_BLOCK = `${BLOCK_START}\nWorkflow ${PACKAGE_VERSION}: read .workflow/managed/protocol.md and .agents/skills/workflow/SKILL.md.\nUse the project-local runtime: node .workflow/runtime/workflow.js.\nThe current main session is Leader; only native host sub-agent tools may dispatch roles.\n${BLOCK_END}\n`;

export interface Asset { path: string; content: string | Buffer; sourceTemplateId: string; mode: 'file' | 'block' }
const protocol = `# Workflow protocol ${PACKAGE_VERSION}\n\nThe current host's main session is the only Leader. Workflow CLI executes deterministic repository/state/specification operations; it never starts model sessions. Native roles must have verified version-bound capability evidence, real dispatch identities, and enforced permissions. Unknown capabilities stop the gate. Reviewer requires read-only isolation across file, shell, connector and extension channels.\n\nRequired phase order: bootstrap → architect → spec-gate → dev (Red, accepted expected failure, new Green/Refactor dispatch) → tester → independent cr → verify → integrate. Missing evidence never becomes success. Requirements, design, policy or validation-input changes invalidate affected approvals, review and verification. Preserve user changes; never auto-stash or include unrelated changes.\n\nDispatch packages bind change/run/task IDs, role version, requirement/scenario IDs, allowed/forbidden paths, fixed HEAD, workspace snapshot, capabilities and completion criteria. Prepare a planned attempt, dispatch through native tools, attach the real identity, then collect the current attempt's versioned JSON report. A role's DONE claim is not accepted evidence.\n\nOnly Leader may initiate Git writes, archive transactions or external integrations, after verified authorization and evidence. Verification runs configured deterministic commands, compares input fingerprints before/after and binds the candidate tree. Archive requires valid review and verification; archive output needs a new final verification and independent complete-diff review. No bypass or force-success path exists.\n\nPreview limitation: native host execution, role isolation, remote integrations and production readiness remain unverified. Run doctor; installation is distinct from execution readiness. Unsupported operations must stop explicitly.\n`;
const roles: Record<string, string> = {
  architect: 'Within approved requirements, write only assigned design/tasks. Do not expand product scope. Report assumptions and decision requests.',
  developer: 'Work only on assigned task paths. Red may edit only Test-Scopes. Green/Refactor requires a new dispatch after accepted failure evidence. Do not alter Git index/HEAD.',
  tester: 'Map scenarios to independent coverage and assertions. Edit only assigned test paths; implementation changes require a new authorization and dispatch.',
  reviewer: 'Independently inspect the complete baseline diff, behavior, compatibility and evidence. All channels must be read-only before dispatch. Report severity, file/line, requirement/scenario and remediation; do not edit or use Git writes.',
  verifier: 'Run only the declared validation plan against the fixed baseline. Only declared artifacts may be written. Record real command results and before/after input fingerprints.',
};
export function managedAssets(hosts: InstallHost[], runtime: Buffer, notices = ''): Asset[] {
  return [
    { path: '.workflow/runtime/workflow.js', content: runtime, sourceTemplateId: `runtime:${PACKAGE_VERSION}`, mode: 'file' },
    { path: '.workflow/runtime/THIRD_PARTY_LICENSES.txt', content: notices, sourceTemplateId: `notices:${PACKAGE_VERSION}`, mode: 'file' },
    { path: '.workflow/managed/protocol.md', content: protocol, sourceTemplateId: 'protocol:v1', mode: 'file' },
    ...Object.entries(roles).map(([id, body]) => ({ path: `.workflow/managed/roles/${id}.md`, content: `# ${id}\n\nProtocol version: ${PACKAGE_VERSION}\n\n${body}\n\nUse the task package's project policy, paths, baseline and result schema. Never dispatch subordinate agents or initiate Git/archive/integration writes.\n`, sourceTemplateId: `role:${id}:v1`, mode: 'file' as const })),
    { path: '.agents/skills/workflow/SKILL.md', content: `---\nname: workflow\ndescription: Follow the fixed local Workflow protocol.\n---\n\nRead .workflow/managed/protocol.md and the relevant .workflow/managed/roles/ file.\nRun node .workflow/runtime/workflow.js doctor before execution. All paths are relative to the repository root.\nThe current main session dispatches native sub-agents; the CLI never starts Agent processes.\n`, sourceTemplateId: 'skill:shared:v1', mode: 'file' },
    ...hosts.map(id => ({ ...hostEntry(id), sourceTemplateId: `host:${id}:v1`, mode: 'file' as const })),
    { path: 'AGENTS.md', content: AGENT_BLOCK, sourceTemplateId: 'entry:agents:v1', mode: 'block' },
  ];
}
