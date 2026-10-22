import { randomUUID } from 'node:crypto';
import picomatch from 'picomatch';
import { markEvidenceBoundary, currentEvidenceSession } from './evidence.js';
import { assert, WorkflowError, type Diagnostic } from '../shared/errors.js';
import type { Dispatch, DispatchReport, Fingerprints, Role, WorkflowState } from './types.js';

export function validRelativePath(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && !value.includes('\\') && !value.includes('\0') && !value.startsWith('/') && !/^[a-z]:/i.test(value) && !value.startsWith('!') && value.split('/').every(p => p !== '..' && p !== '.' && p !== '' && p.toLowerCase() !== '.git');
}
function uniqueStrings(value: unknown): value is string[] { return Array.isArray(value) && value.every(v => typeof v === 'string' && v.trim().length > 0) && new Set(value).size === value.length; }
function id(value: unknown): value is string { return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(value); }
export function parseDispatchReport(value: unknown): DispatchReport {
  assert(value && typeof value === 'object' && !Array.isArray(value), 'REPORT_FORMAT', '回报必须为 JSON 对象');
  const r = value as Record<string, unknown>;
  const required = ['protocolVersion', 'runId', 'dispatchId', 'attemptId', 'status', 'taskIds', 'files', 'evidenceIds', 'requirementIds', 'scenarioIds', 'startHead', 'question', 'next'];
  assert(required.every(k => Object.hasOwn(r, k)), 'REPORT_REQUIRED_FIELD', '回报缺少必需字段');
  assert(Object.keys(r).every(k => required.includes(k)), 'REPORT_UNKNOWN_FIELD', '回报包含未知字段');
  assert(r.protocolVersion === 1, 'REPORT_VERSION', '不支持的回报协议版本');
  assert(['runId', 'dispatchId', 'attemptId'].every(k => id(r[k])), 'REPORT_ID', '回报 ID 格式错误');
  assert(['DONE', 'NEEDS_PARENT_DECISION', 'FAILED'].includes(String(r.status)), 'REPORT_STATUS', '无效回报状态');
  assert(['taskIds', 'files', 'evidenceIds', 'requirementIds', 'scenarioIds'].every(k => uniqueStrings(r[k])), 'REPORT_LIST', '回报列表必须为无重复非空字符串数组');
  assert((r.files as string[]).every(p => validRelativePath(p) && !/[*?\[\]{}!]/.test(p)), 'REPORT_PATH', '回报路径必须为项目相对路径');
  assert(['taskIds', 'evidenceIds', 'requirementIds', 'scenarioIds'].every(k => (r[k] as string[]).every(id)), 'REPORT_ID', '回报引用 ID 格式错误');
  assert(typeof r.startHead === 'string' && /^[a-f0-9]{40}([a-f0-9]{24})?$/.test(r.startHead), 'REPORT_HEAD', 'startHead 必须为完整 SHA');
  assert(r.question === null || typeof r.question === 'string' && r.question.trim().length > 0, 'REPORT_QUESTION', 'question 应为 null 或非空文本');
  assert(r.status !== 'NEEDS_PARENT_DECISION' || typeof r.question === 'string', 'REPORT_QUESTION', '需要主会话决策时必须包含问题');
  assert(r.status !== 'DONE' || r.question === null, 'REPORT_CONTRADICTION', 'DONE 回报不能同时包含未决问题');
  assert(typeof r.next === 'string' && r.next.trim().length > 0, 'REPORT_NEXT', '回报必须说明下一步');
  assert(r.status !== 'DONE' || (r.evidenceIds as string[]).length > 0, 'REPORT_EVIDENCE_REQUIRED', 'DONE 缺少证据引用', 3);
  return structuredClone(value) as DispatchReport;
}
export interface PrepareDispatchInput {
  taskId?: string; role: Role; testMode?: Dispatch['testMode']; taskPlan?: Dispatch['taskPlan']; allowedPaths: string[]; forbiddenPaths?: string[]; requirementIds: string[]; scenarioIds: string[];
  startHead: string; fingerprints: Fingerprints; cycleId?: string;
}
export function prepareDispatch(state: WorkflowState, input: PrepareDispatchInput): { state: WorkflowState; dispatch: Dispatch } {
  const scope = input.taskId === undefined && input.role === 'architect' ? 'change' : 'task';
  assert(scope === 'change' || id(input.taskId), 'DISPATCH_TASK_ID', '任务级派发必须提供有效任务 ID');
  assert(['architect', 'developer-red', 'developer-green', 'developer-verification', 'developer-exempt', 'tester', 'reviewer', 'verifier'].includes(input.role), 'DISPATCH_ROLE', '未知角色');
  assert(uniqueStrings(input.allowedPaths) && uniqueStrings(input.forbiddenPaths ?? []) && uniqueStrings(input.requirementIds) && input.requirementIds.every(id) && uniqueStrings(input.scenarioIds) && input.scenarioIds.every(id), 'DISPATCH_FIELDS', '派发范围、需求与场景必须为无重复且格式有效的列表');
  assert([...input.allowedPaths, ...(input.forbiddenPaths ?? [])].every(validRelativePath), 'DISPATCH_PATH', '派发路径必须为相对路径或相对 glob');
  assert(/^[a-f0-9]{40}([a-f0-9]{24})?$/.test(input.startHead), 'DISPATCH_HEAD', '派发需要完整起始 HEAD');
  assert(!state.dispatches.some(d => ['planned', 'attached'].includes(d.status) && (scope === 'change' || d.scope === 'change' || d.taskId === input.taskId)), 'DISPATCH_ACTIVE_ATTEMPT', '当前任务已有未终结 attempt', 3);
  if (input.role === 'reviewer' || input.role === 'verifier') assert(input.allowedPaths.length === 0, 'DISPATCH_READ_ONLY', '审查与验证角色不允许写入');
  const expectedMode = input.role === 'developer-verification' ? 'verification' : input.role === 'developer-exempt' ? 'exempt' : input.role.startsWith('developer-') ? 'tdd' : undefined;
  if (expectedMode) {
    assert((input.testMode ?? (expectedMode === 'tdd' ? 'tdd' : undefined)) === expectedMode, 'DISPATCH_TEST_MODE', '开发角色必须匹配当前任务的真实 Test-Mode', 3);
    if (expectedMode !== 'tdd') {
      assert(input.cycleId === undefined, 'DISPATCH_NON_TDD_CYCLE', '非 TDD 任务不能借用 cycle', 3);
      assert(input.taskPlan && uniqueStrings(input.taskPlan.testCommands) && input.taskPlan.acceptance.trim() && input.taskPlan.testRationale?.trim(), 'DISPATCH_TEST_PLAN', '非 TDD 派发必须绑定任务的命令、验收标准与理由', 3);
      if (expectedMode === 'verification') assert(input.taskPlan.testCommands.length > 0, 'DISPATCH_TEST_PLAN', 'verification 必须声明验证命令', 3);
      else assert(input.taskPlan.alternativeAcceptance?.trim(), 'DISPATCH_ALTERNATIVE_ACCEPTANCE', 'exempt 必须明确替代验收计划；派发准备不代表计划已获批准', 3);
    }
  }
  if (input.role === 'developer-red' || input.role === 'developer-green') {
    const cycle = state.cycles.find(c => c.id === input.cycleId && c.taskId === input.taskId);
    assert(cycle, 'DISPATCH_CYCLE_REQUIRED', 'TDD 开发派发必须关联当前任务 cycle', 3);
    assert(cycle.status !== 'invalidated' && cycle.status !== 'complete', 'DISPATCH_CYCLE_STALE', 'cycle 已失效或完成', 3);
    if (input.role === 'developer-green') assert(cycle.status === 'red-accepted', 'DISPATCH_RED_REQUIRED', '有效 Red 接受后才允许实现写权限', 3);
    if (input.role === 'developer-red') {
      assert(cycle.status === 'open' || cycle.status === 'red-observed', 'DISPATCH_RED_STATE', '当前 cycle 不允许 Red 派发', 3);
      assert(input.allowedPaths.every(p => cycle.testScopes.includes(p)), 'DISPATCH_TEST_ONLY', 'Red 写范围必须限定于已声明 Test-Scopes', 3);
    } else assert(input.allowedPaths.every(p => [...cycle.testScopes, ...cycle.implementationScopes].includes(p)), 'DISPATCH_SCOPE', 'Green 写范围超出 cycle 授权路径', 3);
  }
  const dispatch: Dispatch = { ...structuredClone(input), evidenceBoundary: markEvidenceBoundary(), evidenceSessionId: currentEvidenceSession(), scope, ...(expectedMode ? { testMode: expectedMode } : {}), id: `dispatch-${randomUUID()}`, attemptId: `attempt-${randomUUID()}`, status: 'planned', forbiddenPaths: input.forbiddenPaths ?? [] };
  const next = structuredClone(state); next.dispatches.push(dispatch); return { state: next, dispatch };
}
// Native host identity, tool-result provenance and isolation have not been independently verified.
// No caller-controlled JSON flag or arbitrary Agent ID can bypass this boundary.
export function attachDispatch(_state: WorkflowState, _dispatchId: string, _attemptId: string, _agentId: string): never {
  throw new WorkflowError('HOST_PROVENANCE_UNVERIFIED', '缺少可核查的宿主原生派发来源及权限隔离，保留 planned attempt；主会话需完成真实宿主验收', 5);
}
export function finishPlannedDispatch(state: WorkflowState, dispatchId: string, attemptId: string): WorkflowState {
  const next = structuredClone(state); const d = next.dispatches.find(d => d.id === dispatchId && d.attemptId === attemptId);
  assert(d && d.status === 'planned', 'DISPATCH_NOT_PLANNED', '仅可终结尚未关联宿主的 planned attempt', 3); d.status = 'failed'; return next;
}
export function collectDispatchReport(state: WorkflowState, value: unknown): { state: WorkflowState; accepted: boolean; diagnostics: Diagnostic[] } {
  const report = parseDispatchReport(value); const next = structuredClone(state);
  const d = next.dispatches.find(d => d.id === report.dispatchId && d.attemptId === report.attemptId);
  const reject = (code: string, message: string) => { next.staleReports.push({ report, reason: code }); return { state: next, accepted: false, diagnostics: [{ code, message }] }; };
  if (report.runId !== state.runId || !d) return reject('REPORT_STALE_ATTEMPT', '回报未关联当前 run 与 attempt，保留审计但不更新状态');
  if (d.status !== 'attached' || !d.agentId) return reject('REPORT_ATTEMPT_NOT_RUNNING', 'planned、已终结或旧 attempt 的回报不推进状态');
  if ((d.scope === 'change' ? d.role !== 'architect' || d.taskId !== undefined || report.taskIds.length !== 0 : report.taskIds.length !== 1 || report.taskIds[0] !== d.taskId) || report.startHead !== d.startHead) return reject('REPORT_ASSOCIATION', '回报 task 或起始 HEAD 与派发不一致');
  if (report.requirementIds.some(x => !d.requirementIds.includes(x)) || report.scenarioIds.some(x => !d.scenarioIds.includes(x)) || report.status === 'DONE' && (d.requirementIds.some(x => !report.requirementIds.includes(x)) || d.scenarioIds.some(x => !report.scenarioIds.includes(x)))) return reject('REPORT_SCOPE_REFERENCE', '回报包含未授权需求或场景');
  if (report.files.some(p => !d.allowedPaths.some(g => picomatch(g, { dot: true })(p)) || d.forbiddenPaths.some(g => picomatch(g, { dot: true })(p)))) return reject('REPORT_PATH_SCOPE', '回报引用了未授权文件');
  d.report = report; if (report.status === 'FAILED') d.status = 'failed';
  // DONE is only a pending claim. Keep attached until leader audit of actual diff/evidence.
  return { state: next, accepted: true, diagnostics: [] };
}
