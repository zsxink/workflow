import { randomUUID } from 'node:crypto';
import { assert } from '../shared/errors.js';
import { stableStringify } from '../shared/hash.js';
import { assertObservedCommand, markEvidenceBoundary, type ExecutionSnapshot } from './evidence.js';
import { validRelativePath } from './dispatch.js';
import type { Baseline, CommandEvidence, Fingerprints, RedAcceptance, TestCycle, WorkflowState } from './types.js';
function equal(a: unknown, b: unknown): boolean { return stableStringify(a) === stableStringify(b); }
function allCommands(evidence: CommandEvidence[], commands: string[]): boolean { return evidence.length === commands.length && commands.every(id => evidence.filter(e => e.commandId === id).length === 1); }
function ensureRecord(e: CommandEvidence, state: WorkflowState, taskId: string): void {
  assertObservedCommand(e); assert(e.runId === state.runId && e.taskId === taskId, 'TDD_EVIDENCE_ASSOCIATION', '命令证据必须属于当前 run/task', 3);
}
export function createTestBaseline(state: WorkflowState, taskId: string, evidence: CommandEvidence[], commandIds: string[]): Baseline {
  assert(commandIds.length > 0 && new Set(commandIds).size === commandIds.length && allCommands(evidence, commandIds), 'TDD_BASELINE_COMMANDS', '基线必须执行全部定向与回归计划命令，不能为空或重复', 3);
  for (const e of evidence) { ensureRecord(e, state, taskId); assert(e.step === 'baseline' && !e.cycleId, 'TDD_BASELINE_STEP', '开 cycle 前必须采集任务 baseline 证据', 3); }
  const first = evidence[0];
  assert(evidence.every(e => equal(e.before, first.before) && e.head === first.head && e.testDigest === first.testDigest && e.implementationDigest === first.implementationDigest && e.commandPlanDigest === first.commandPlanDigest && e.environmentDigest === first.environmentDigest), 'TDD_BASELINE_CHANGED', '基线检查之间输入或命令环境改变', 3);
  return { id: `baseline-${randomUUID()}`, runId: state.runId, taskId, commandIds: [...commandIds], evidence: structuredClone(evidence), fingerprints: first.before, implementationDigest: first.implementationDigest, testDigest: first.testDigest, commandPlanDigest: first.commandPlanDigest, environmentDigest: first.environmentDigest };
}
export interface OpenCycleInput { baseline: Baseline; snapshot: ExecutionSnapshot; scenarioIds: string[]; testScopes: string[]; implementationScopes: string[]; mode?: 'new-test' | 'existing-failure'; existingFailure?: RedAcceptance }
function validateAcceptance(cycle: TestCycle, acceptance: RedAcceptance, records: CommandEvidence[]): void {
  assert(acceptance.rationale.trim() && acceptance.sourceReferences.length > 0 && acceptance.sourceReferences.every(r => r.trim()), 'TDD_RED_RATIONALE', 'Red 接受需要主会话理由和可引用来源', 3);
  const failures = records.filter(e => e.exitCode !== 0);
  assert(failures.length > 0, 'TDD_NO_RED', '未观察到业务测试失败，不能制造 Red', 3);
  assert(new Set(acceptance.evidenceIds).size === acceptance.evidenceIds.length && equal([...acceptance.evidenceIds].sort(), failures.map(e => e.id).sort()), 'TDD_RED_EVIDENCE', '必须准确引用全部失败命令证据', 3);
  for (const failure of failures) {
    assert(!failure.outputTruncated, 'TDD_RED_TRUNCATED', 'Red 诊断输出被截断，无法可靠核查失败原因', 3);
    const diagnostics = acceptance.diagnostics.filter(d => d.commandEvidenceId === failure.id);
    assert(diagnostics.length > 0 && diagnostics.every(d => d.kind === 'business-assertion' && d.assertion.trim() && d.sourceReference.trim() && d.scenarioIds.length > 0 && d.scenarioIds.every(s => cycle.scenarioIds.includes(s))), 'TDD_INVALID_RED', 'Red 必须逐项绑定授权场景的业务断言；编译、依赖、未发现测试等不适用', 3);
  }
  assert(acceptance.diagnostics.every(d => failures.some(e => e.id === d.commandEvidenceId)), 'TDD_RED_DIAGNOSTIC_REFERENCE', '失败诊断引用了未选定的命令', 3);
  assert(cycle.scenarioIds.every(s => acceptance.diagnostics.some(d => d.scenarioIds.includes(s))), 'TDD_RED_SCENARIO', '每个 cycle 场景都需要失败断言引用', 3);
}
export function openTestCycle(state: WorkflowState, input: OpenCycleInput): { state: WorkflowState; cycle: TestCycle } {
  const { baseline: b, snapshot } = input;
  assert(b.runId === state.runId, 'TDD_BASELINE_RUN', '基线不属于当前 run', 3);
  assert(!state.cycles.some(c => c.taskId === b.taskId && c.status !== 'complete' && c.status !== 'invalidated'), 'TDD_ACTIVE_CYCLE', '任务存在未终结 cycle', 3);
  assert(input.scenarioIds.length > 0 && new Set(input.scenarioIds).size === input.scenarioIds.length, 'TDD_SCENARIOS', 'cycle 需要非空场景集合');
  assert(input.testScopes.length > 0 && [...input.testScopes, ...input.implementationScopes].every(validRelativePath), 'TDD_SCOPES', 'cycle 必须声明有效的测试与实现范围');
  assert(!input.testScopes.some(p => input.implementationScopes.includes(p)), 'TDD_SCOPE_OVERLAP', '测试与实现范围不能相同');
  assert(equal(snapshot.fingerprints, b.fingerprints) && snapshot.testDigest === b.testDigest && snapshot.implementationDigest === b.implementationDigest && snapshot.environmentDigest === b.environmentDigest && b.evidence.every(e => e.head === snapshot.head), 'TDD_BASELINE_STALE', '开 cycle 时源码、测试或环境已偏离基线', 3);
  const fresh = createTestBaseline(state, b.taskId, b.evidence, b.commandIds);
  assert(equal({ ...fresh, id: b.id }, b), 'TDD_BASELINE_TAMPERED', 'baseline 摘要或字段与执行器证据不符', 3);
  const mode = input.mode ?? 'new-test';
  assert(mode === 'new-test' || mode === 'existing-failure', 'TDD_MODE', '未知 cycle 模式');
  const cycle: TestCycle = { id: `cycle-${randomUUID()}`, runId: state.runId, taskId: b.taskId, revision: 0, mode, status: 'open', scenarioIds: [...input.scenarioIds], baseline: structuredClone(b), testScopes: [...input.testScopes], implementationScopes: [...input.implementationScopes], red: [], green: [], refactor: [] };
  if (mode === 'new-test') assert(b.evidence.every(e => e.exitCode === 0), 'TDD_BASELINE_FAILED', 'new-test 模式必须全部基线通过', 3);
  else { assert(input.existingFailure, 'TDD_EXISTING_FAILURE_ACCEPTANCE', 'existing-failure 需在 open 前接受已授权的真实失败', 3); validateAcceptance(cycle, input.existingFailure, b.evidence); cycle.red = structuredClone(b.evidence); cycle.acceptance = structuredClone(input.existingFailure); cycle.pairedTestDigest = b.testDigest; cycle.status = 'red-accepted'; cycle.redAcceptedSequence = markEvidenceBoundary(); }
  const next = structuredClone(state); next.cycles.push(cycle); return { state: next, cycle };
}
export function recordTestStep(state: WorkflowState, cycleId: string, step: 'red' | 'green' | 'refactor', evidence: CommandEvidence[]): WorkflowState {
  const next = structuredClone(state); const c = next.cycles.find(c => c.id === cycleId);
  assert(c, 'TDD_CYCLE_UNKNOWN', '未知 cycle');
  assert((step === 'red' && ['open', 'red-observed'].includes(c.status)) || (step === 'green' && c.status === 'red-accepted') || (step === 'refactor' && c.status === 'green'), 'TDD_STEP_ORDER', '步骤时序错误：先接受 Red，再 Green，最后 Refactor', 3);
  assert(allCommands(evidence, c.baseline.commandIds), 'TDD_COMMANDS_INCOMPLETE', '每个步骤必须执行全部计划命令', 3);
  for (const e of evidence) {
    ensureRecord(e, state, c.taskId);
    assert(e.cycleId === cycleId && e.step === step, 'TDD_STEP_ASSOCIATION', '证据不属于当前 cycle/步骤', 3);
    assert(['spec', 'plan', 'policy', 'environment'].every(k => e.before[k as keyof Fingerprints] === c.baseline.fingerprints[k as keyof Fingerprints]), 'TDD_PLAN_CHANGED', '规格、计划、策略或环境输入改变，需要重新建立 cycle', 3);
    if (step === 'green') assert(c.redAcceptedSequence !== undefined && e.startedSequence > c.redAcceptedSequence, 'TDD_GREEN_BEFORE_ACCEPTANCE', 'Green 执行早于主会话接受 Red，不能倒补步骤顺序', 3);
    const baselineCommand = c.baseline.evidence.find(b => b.commandId === e.commandId)!;
    assert(e.commandPlanDigest === c.baseline.commandPlanDigest && e.environmentDigest === c.baseline.environmentDigest && equal(e.argv, baselineCommand.argv) && e.cwd === baselineCommand.cwd, 'TDD_COMMAND_PAIRING', 'Red/Green 命令、argv、cwd 或环境改变，需要新 cycle', 3);
    assert(Date.parse(e.startedAt) >= Math.max(...(step === 'red' ? c.baseline.evidence : step === 'green' ? c.red : c.green).map(p => Date.parse(p.finishedAt))), 'TDD_TIME_ORDER', '步骤命令早于前置证据', 3);
    if (step === 'red') assert(e.implementationDigest === c.baseline.implementationDigest, 'TDD_IMPLEMENTATION_CHANGED_BEFORE_RED', 'Red 前实现已改变，不能倒补 TDD 历史', 3);
    else assert(e.testDigest === c.pairedTestDigest, 'TDD_TEST_PAIRING', 'Red 后测试或 fixture 内容改变，当前配对失效，需要新 cycle', 3);
  }
  assert(evidence.every(e => e.testDigest === evidence[0].testDigest && e.implementationDigest === evidence[0].implementationDigest && equal(e.after, evidence[0].after)), 'TDD_STEP_INPUT_CHANGED', '步骤内各条命令输入不一致', 3);
  if (step === 'red') {
    assert(c.mode === 'existing-failure' || evidence[0].testDigest !== c.baseline.testDigest, 'TDD_NEW_TEST_REQUIRED', 'new-test 模式需要先新增或修改行为测试', 3);
    assert(evidence.some(e => e.exitCode !== 0), 'TDD_NO_RED', '未观察到测试失败，须判断已有行为或无效测试', 3);
    c.red = structuredClone(evidence); c.pairedTestDigest = evidence[0].testDigest; c.status = 'red-observed';
  } else {
    assert(evidence.every(e => e.exitCode === 0), 'TDD_GREEN_FAILED', 'Green/Refactor 的全部定向与回归命令必须通过', 3);
    c[step] = structuredClone(evidence); c.status = step === 'green' ? 'green' : 'complete';
  }
  c.revision++; return next;
}
export function acceptRed(state: WorkflowState, cycleId: string, acceptance: RedAcceptance, snapshot: ExecutionSnapshot): WorkflowState {
  const next = structuredClone(state); const c = next.cycles.find(c => c.id === cycleId);
  assert(c && c.status === 'red-observed', 'TDD_RED_NOT_OBSERVED', '当前 cycle 没有待接受 Red', 3);
  for (const e of c.red) ensureRecord(e, state, c.taskId);
  assert(snapshot.implementationDigest === c.baseline.implementationDigest && snapshot.testDigest === c.pairedTestDigest && snapshot.environmentDigest === c.baseline.environmentDigest && snapshot.head === c.red[0].head && equal(snapshot.fingerprints, c.red[0].after), 'TDD_RED_STALE', '接受 Red 前实现、测试或其他输入已经改变，不能追认历史', 3);
  validateAcceptance(c, acceptance, c.red); c.redAcceptedSequence = markEvidenceBoundary(); c.acceptance = structuredClone(acceptance); c.status = 'red-accepted'; c.revision++; return next;
}
export function completeRefactorWithoutChanges(state: WorkflowState, cycleId: string, rationale: string, snapshot: ExecutionSnapshot): WorkflowState {
  const next = structuredClone(state); const c = next.cycles.find(c => c.id === cycleId);
  assert(c && c.status === 'green' && rationale.trim(), 'TDD_REFACTOR_NOT_NEEDED', '无需重构也需已通过 Green 与明确理由', 3);
  for (const e of c.green) ensureRecord(e, state, c.taskId);
  const green = c.green[0];
  assert(snapshot.testDigest === green.testDigest && snapshot.implementationDigest === green.implementationDigest && snapshot.environmentDigest === green.environmentDigest && snapshot.head === green.head && equal(snapshot.fingerprints, green.after), 'TDD_GREEN_STALE', '无需重构声明与当前 Green 快照不同', 3);
  c.refactorNotNeeded = rationale; c.status = 'complete'; c.revision++; return next;
}
export function invalidateCycle(state: WorkflowState, cycleId: string, reason: string): WorkflowState {
  assert(reason.trim(), 'TDD_INVALIDATION_REASON', '失效必须记录原因'); const next = structuredClone(state); const c = next.cycles.find(c => c.id === cycleId);
  assert(c, 'TDD_CYCLE_UNKNOWN', '未知 cycle'); c.status = 'invalidated'; c.invalidatedReason = reason; c.revision++; return next;
}
export function requireCompletedCycles(state: WorkflowState, taskId: string, current: Fingerprints): void {
  const cycles = state.cycles.filter(c => c.taskId === taskId && c.status !== 'invalidated');
  assert(cycles.length > 0 && cycles.every(c => c.status === 'complete'), 'TDD_INCOMPLETE', '任务所有适用 cycle 尚未完成', 3);
  // Earlier completed cycles remain history as later behavior increments change the implementation.
  // The last cycle must bind the current task snapshot; all historical commands remain observed facts.
  for (const c of cycles) for (const e of [...c.red, ...c.green, ...c.refactor]) ensureRecord(e, state, taskId);
  const last = cycles.at(-1)!; const final = last.refactor.length ? last.refactor : last.green;
  assert(final.every(e => equal(e.after, current)), 'TDD_COMPLETION_STALE', '最后 cycle 完成证据不属于当前源码快照', 3);
}
