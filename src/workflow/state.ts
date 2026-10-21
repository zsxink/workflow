import { assert, WorkflowError, type Diagnostic } from '../shared/errors.js';
import { stableStringify } from '../shared/hash.js';
import { validRelativePath } from './dispatch.js';
import { phases, type Fingerprints, type Phase, type PhaseStatus, type WorkflowState } from './types.js';
export function createWorkflowState(runId: string, fingerprints?: Fingerprints): WorkflowState {
  assert(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(runId), 'RUN_ID', 'run ID 格式错误');
  return { formatVersion: 1, runId, phases: Object.fromEntries(phases.map(p => [p, { status: 'pending', evidenceIds: [] }])) as unknown as WorkflowState['phases'], dispatches: [], cycles: [], staleReports: [], fingerprints, budgets: {} };
}
const edges: Record<PhaseStatus, PhaseStatus[]> = { pending: ['running', 'suspended'], running: ['succeeded', 'failed', 'suspended'], succeeded: [], failed: ['running', 'suspended'], suspended: ['running'] };
export function requestPhaseTransition(state: WorkflowState, phase: Phase, status: PhaseStatus): WorkflowState {
  assert(phases.includes(phase), 'PHASE_UNKNOWN', '未知阶段');
  assert(Object.hasOwn(edges, status), 'PHASE_STATUS', '未知阶段状态');
  const next = structuredClone(state); const previous = next.phases[phase].status;
  assert(edges[previous].includes(status), 'PHASE_ILLEGAL_TRANSITION', `不允许 ${phase}: ${previous} → ${status}`, 3);
  if (status === 'running' || status === 'succeeded') {
    const prior = phases.slice(0, phases.indexOf(phase));
    assert(prior.every(p => state.phases[p].status === 'succeeded'), 'PHASE_PREREQUISITE', `阶段 ${phase} 的前置阶段未全部通过`, 3);
  }
  // All phase success includes human/host facts. Preview cannot authenticate native dispatch,
  // user approval or isolated independent review and must never turn JSON claims into success.
  if (status === 'succeeded') throw new WorkflowError('PHASE_EVIDENCE_UNVERIFIED', '阶段成功需要可核查授权、宿主与独立审查证据；受限预览仅支持准备与确定性核查', 5);
  next.phases[phase].status = status; return next;
}
export function invalidateForInputs(state: WorkflowState, current: Fingerprints): { state: WorkflowState; invalidated: Phase[]; changed: Array<keyof Fingerprints> } {
  const next = structuredClone(state); const keys = ['source', 'spec', 'plan', 'policy', 'environment'] as const;
  const changed = keys.filter(k => state.fingerprints && state.fingerprints[k] !== current[k]);
  if (!changed.length) { next.fingerprints = structuredClone(current); return { state: next, invalidated: [], changed: [] }; }
  const earliest = changed.some(k => ['spec', 'policy'].includes(k)) ? 'architect' : changed.includes('plan') ? 'spec-gate' : 'dev';
  const invalidated = phases.slice(phases.indexOf(earliest));
  for (const p of invalidated) next.phases[p] = { status: 'pending', evidenceIds: [], invalidatedBy: [...changed] };
  for (const cycle of next.cycles) if (cycle.status !== 'invalidated') { cycle.status = 'invalidated'; cycle.invalidatedReason = `输入改变: ${changed.join(', ')}`; cycle.revision++; }
  next.fingerprints = structuredClone(current); return { state: next, invalidated: [...invalidated], changed: [...changed] };
}
export interface ReviewCoverageInput {
  reviewBase: string; head: string; expectedPaths: string[];
  coverage: Array<{ path: string; disposition: 'reviewed' | 'not-applicable'; rationale: string }>;
  findings: Array<{ severity: 'blocker' | 'major' | 'minor' | 'info'; file: string; line: number; issue: string; references: string[]; suggestion: string }>;
  before: Fingerprints; after: Fingerprints; reviewerId: string; authorIds: string[];
}
export function assessReviewCoverage(input: ReviewCoverageInput): { ok: boolean; diagnostics: Diagnostic[] } {
  const diagnostics: Diagnostic[] = [];
  const error = (code: string, message: string) => diagnostics.push({ code, message });
  if (!/^[a-f0-9]{40}([a-f0-9]{24})?$/.test(input.reviewBase) || !/^[a-f0-9]{40}([a-f0-9]{24})?$/.test(input.head)) error('REVIEW_BASE', '审查需要固定完整 reviewBase 与 HEAD');
  if (!input.reviewerId || input.authorIds.includes(input.reviewerId)) error('REVIEW_INDEPENDENCE', '审查者必须独立于所有当前修改者');
  if (stableStringify(input.before) !== stableStringify(input.after)) error('REVIEW_INPUT_CHANGED', '审查期间输入改变');
  const seen = new Set<string>();
  for (const c of input.coverage) {
    if (seen.has(c.path) || !input.expectedPaths.includes(c.path) || !c.rationale.trim() || !['reviewed', 'not-applicable'].includes(c.disposition)) error('REVIEW_COVERAGE_ENTRY', `无效或重复覆盖项: ${c.path}`);
    seen.add(c.path);
  }
  for (const path of input.expectedPaths) if (!seen.has(path)) error('REVIEW_INCOMPLETE_DIFF', `完整 diff 尚未覆盖: ${path}`);
  for (const f of input.findings) {
    if (!validRelativePath(f.file) || !['blocker', 'major', 'minor', 'info'].includes(f.severity) || !Number.isInteger(f.line) || f.line < 1 || !f.issue.trim() || !f.references.length || !f.suggestion.trim()) error('REVIEW_FINDING_FORMAT', 'finding 缺少定位、引用或建议');
    if (['blocker', 'major'].includes(f.severity)) error('REVIEW_UNRESOLVED_FINDING', `${f.severity}: ${f.issue}`);
  }
  return { ok: !diagnostics.length, diagnostics };
}
export function consumeBudget(state: WorkflowState, issueId: string, limit = 2): WorkflowState {
  assert(issueId.trim() && Number.isInteger(limit) && limit >= 0, 'BUDGET_INPUT', '预算 issue 与 limit 无效');
  const next = structuredClone(state); const b = next.budgets[issueId] ??= { limit, consumed: 0, additions: [] };
  assert(b.consumed < b.limit + b.additions.reduce((n, a) => n + a.amount, 0), 'BUDGET_EXHAUSTED', '重试额度已耗尽，需明确的新用户决策', 5);
  b.consumed++; return next;
}
export function inheritBudgets(previous: WorkflowState, next: WorkflowState): WorkflowState {
  const result = structuredClone(next);
  for (const [id, budget] of Object.entries(previous.budgets)) {
    const current = result.budgets[id];
    assert(!current || current.consumed <= budget.consumed, 'BUDGET_INHERIT_CONFLICT', '后继 run 预算冲突', 3);
    result.budgets[id] = structuredClone(budget);
  }
  return result;
}
export function approveScope(_evidence: unknown): never { throw new WorkflowError('AUTHORIZATION_PROVENANCE_UNVERIFIED', '无法从自写 JSON 核实用户授权来源，需可引用的宿主会话记录', 5); }
