import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  createWorkflowState, requestPhaseTransition, prepareDispatch, attachDispatch, collectDispatchReport,
  parseDispatchReport, invalidateForInputs, assessReviewCoverage, consumeBudget, inheritBudgets,
  captureCommandEvidence, createTestBaseline, openTestCycle, recordTestStep, acceptRed,
  completeRefactorWithoutChanges, commandPlanDigest, assessVerification, assertObservedCommand,
  type ExecutionSnapshot, type WorkflowState, type DispatchReport, type Fingerprints,
} from '../src/workflow/index.js';
import type { ValidationCommand } from '../src/project/index.js';
import { sha256 } from '../src/shared/hash.js';
const fp: Fingerprints = { source: 's', spec: 'p', plan: 'l', policy: 'r', environment: 'e' };
const head = 'a'.repeat(40);
function code(code: string) { return (e: unknown) => (e as { code: string }).code === code; }

test('phase order, success provenance and dispatch identity fail closed', () => {
  let state = createWorkflowState('run-test', fp);
  assert.throws(() => requestPhaseTransition(state, 'dev', 'running'), code('PHASE_PREREQUISITE'));
  assert.throws(() => requestPhaseTransition(state, 'bootstrap', 'succeeded'), code('PHASE_ILLEGAL_TRANSITION'));
  state = requestPhaseTransition(state, 'bootstrap', 'running');
  assert.throws(() => requestPhaseTransition(state, 'bootstrap', 'succeeded'), code('PHASE_EVIDENCE_UNVERIFIED'));
  const prepared = prepareDispatch(state, { taskId: 'TASK-001', role: 'architect', allowedPaths: ['docs/**'], requirementIds: ['REQ-001'], scenarioIds: ['SCN-001'], startHead: head, fingerprints: fp });
  assert.equal(prepared.dispatch.status, 'planned');
  assert.throws(() => attachDispatch(prepared.state, prepared.dispatch.id, prepared.dispatch.attemptId, 'any-string'), code('HOST_PROVENANCE_UNVERIFIED'));
});
function reportFor(state: WorkflowState): DispatchReport {
  const d = state.dispatches[0];
  return { protocolVersion: 1, runId: state.runId, dispatchId: d.id, attemptId: d.attemptId, status: 'DONE', taskIds: d.taskId ? [d.taskId] : [], files: ['docs/design.md'], evidenceIds: ['evidence-1'], requirementIds: ['REQ-001'], scenarioIds: ['SCN-001'], startHead: head, question: null, next: '主会话审计' };
}
test('report schema and current attempt, path, DONE claims', () => {
  const p = prepareDispatch(createWorkflowState('run-test'), { taskId: 'TASK-001', role: 'architect', allowedPaths: ['docs/**'], forbiddenPaths: ['docs/secrets/**'], requirementIds: ['REQ-001'], scenarioIds: ['SCN-001'], startHead: head, fingerprints: fp });
  assert.equal(collectDispatchReport(p.state, reportFor(p.state)).accepted, false);
  const s = structuredClone(p.state); s.dispatches[0].status = 'attached'; s.dispatches[0].agentId = 'fixture-agent';
  const report = reportFor(s);
  assert.throws(() => parseDispatchReport({ ...report, evidenceIds: [] }), code('REPORT_EVIDENCE_REQUIRED'));
  assert.throws(() => parseDispatchReport({ ...report, question: 'unfinished' }), code('REPORT_CONTRADICTION'));
  assert.throws(() => parseDispatchReport({ ...report, files: ['../escape'] }), code('REPORT_PATH'));
  const stale = collectDispatchReport(s, { ...report, attemptId: 'attempt-old' });
  assert.equal(stale.accepted, false); assert.equal(stale.state.staleReports.length, 1); assert.equal(s.staleReports.length, 0);
  assert.equal(collectDispatchReport(s, { ...report, files: ['docs/secrets/key'] }).accepted, false);
  assert.equal(collectDispatchReport(s, { ...report, files: ['src/code.ts'] }).accepted, false);
  const accepted = collectDispatchReport(s, report);
  assert.equal(accepted.accepted, true); assert.equal(accepted.state.dispatches[0].status, 'attached');
  assert.equal(accepted.state.phases.architect.status, 'pending');
});
test('input changes invalidate dependent gates and inherited budgets cannot reset', () => {
  let state = createWorkflowState('run-first', fp); state.phases.cr.status = 'succeeded'; state.phases.verify.status = 'succeeded';
  const invalid = invalidateForInputs(state, { ...fp, source: 'new' });
  assert.deepEqual(invalid.invalidated, ['dev', 'tester', 'cr', 'verify', 'integrate']);
  assert.equal(invalid.state.phases.cr.status, 'pending'); assert.equal(state.phases.cr.status, 'succeeded');
  state = consumeBudget(consumeBudget(state, 'failure-original'), 'failure-original');
  const inherited = inheritBudgets(state, createWorkflowState('run-next'));
  assert.throws(() => consumeBudget(inherited, 'failure-original', 999), code('BUDGET_EXHAUSTED'));
  assert.deepEqual(invalidateForInputs(state, { ...fp, policy: 'changed' }).invalidated[0], 'architect');
});
test('review covers the complete diff, detects writes and independent reviewer', () => {
  const review = { reviewBase: head, head, expectedPaths: ['src/a.ts', '.github/workflows/test.yml', 'old/deleted.ts'], coverage: [{ path: 'src/a.ts', disposition: 'reviewed' as const, rationale: '检查需求场景' }], findings: [], before: fp, after: fp, reviewerId: 'reviewer-1', authorIds: ['developer-1'] };
  assert.equal(assessReviewCoverage(review).ok, false);
  review.coverage.push({ path: '.github/workflows/test.yml', disposition: 'reviewed', rationale: 'CI策略' }, { path: 'old/deleted.ts', disposition: 'reviewed', rationale: '删除审查' });
  assert.equal(assessReviewCoverage(review).ok, true);
  assert.equal(assessReviewCoverage({ ...review, after: { ...fp, spec: 'changed' } }).ok, false);
  assert.equal(assessReviewCoverage({ ...review, reviewerId: 'developer-1' }).ok, false);
});

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'workflow-tdd-'));
  await writeFile(path.join(root, 'implementation.mjs'), 'export const value = 1;\n');
  await writeFile(path.join(root, 'behavior.mjs'), "import assert from 'node:assert/strict'; import {value} from './implementation.mjs'; assert.equal(value, 1);\n");
  const command: ValidationCommand = { id: 'unit', executable: 'node', args: ['behavior.mjs'], cwd: '.', timeoutSeconds: 5, modules: ['*'], artifacts: [], envAllowlist: ['PATH'] };
  const digest = commandPlanDigest([command]);
  const snapshot = async (): Promise<ExecutionSnapshot> => {
    const implementationDigest = sha256(await readFile(path.join(root, 'implementation.mjs'))); const testDigest = sha256(await readFile(path.join(root, 'behavior.mjs')));
    return { fingerprints: { ...fp, source: sha256(implementationDigest + testDigest) }, head, implementationDigest, testDigest, environmentDigest: fp.environment };
  };
  const capture = (step: 'baseline' | 'red' | 'green' | 'refactor' | 'verify', cycleId?: string) => captureCommandEvidence(root, command, { runId: 'run-tdd', taskId: 'TASK-001', cycleId, step, commandPlanDigest: digest }, snapshot);
  const baseline = await capture('baseline'); let state = createWorkflowState('run-tdd', baseline.before);
  const b = createTestBaseline(state, 'TASK-001', [baseline], ['unit']);
  const opened = openTestCycle(state, { baseline: b, snapshot: await snapshot(), scenarioIds: ['SCN-001'], testScopes: ['behavior.mjs'], implementationScopes: ['implementation.mjs'] }); state = opened.state;
  return { root, command, snapshot, capture, state, cycle: opened.cycle, digest };
}
test('real Red → Green pairing; forged records and changed assertions rejected', async () => {
  const f = await fixture();
  try {
    await writeFile(path.join(f.root, 'behavior.mjs'), "import assert from 'node:assert/strict'; import {value} from './implementation.mjs'; assert.equal(value, 2);\n");
    const red = await f.capture('red', f.cycle.id); assert.notEqual(red.exitCode, 0);
    assert.throws(() => assertObservedCommand({ ...red, exitCode: 0 }), code('COMMAND_PROVENANCE_UNVERIFIED'));
    let state = recordTestStep(f.state, f.cycle.id, 'red', [red]);
    const acceptance = { evidenceIds: [red.id], diagnostics: [{ commandEvidenceId: red.id, kind: 'business-assertion' as const, scenarioIds: ['SCN-001'], assertion: 'value 应为 2，实际为 1', sourceReference: `${red.id}:stderr` }], rationale: '业务断言重现授权缺陷', sourceReferences: ['session:test-fixture'] };
    const redSnapshot = await f.snapshot();
    assert.throws(() => acceptRed(state, f.cycle.id, { ...acceptance, diagnostics: [{ ...acceptance.diagnostics[0], kind: 'compile' }] }, redSnapshot), code('TDD_INVALID_RED'));
    state = acceptRed(state, f.cycle.id, acceptance, redSnapshot);
    await writeFile(path.join(f.root, 'implementation.mjs'), 'export const value = 2;\n');
    await writeFile(path.join(f.root, 'behavior.mjs'), "import assert from 'node:assert/strict'; import {value} from './implementation.mjs'; assert.ok(value);\n");
    const weakened = await f.capture('green', f.cycle.id);
    assert.throws(() => recordTestStep(state, f.cycle.id, 'green', [weakened]), code('TDD_TEST_PAIRING'));
    await writeFile(path.join(f.root, 'behavior.mjs'), "import assert from 'node:assert/strict'; import {value} from './implementation.mjs'; assert.equal(value, 2);\n");
    const green = await f.capture('green', f.cycle.id); state = recordTestStep(state, f.cycle.id, 'green', [green]);
    state = completeRefactorWithoutChanges(state, f.cycle.id, '实现只有常量替换，无需重构', await f.snapshot());
    assert.equal(state.cycles[0].status, 'complete');
    const verify = await f.capture('verify');
    assert.equal(assessVerification({ runId: 'run-tdd', evidence: [verify], commandIds: ['unit'], fingerprints: (await f.snapshot()).fingerprints, head, planDigest: f.digest }).ok, true);
    assert.throws(() => assessVerification({ runId: 'run-tdd', evidence: [verify], commandIds: ['unit', 'lint'], fingerprints: verify.after, head, planDigest: f.digest }), code('VERIFY_INCOMPLETE'));
  } finally { await rm(f.root, { recursive: true, force: true }); }
});
test('implementation-first cannot backfill Red', async () => {
  const f = await fixture();
  try {
    await writeFile(path.join(f.root, 'implementation.mjs'), 'export const value = 2;\n');
    const red = await f.capture('red', f.cycle.id);
    assert.throws(() => recordTestStep(f.state, f.cycle.id, 'red', [red]), code('TDD_IMPLEMENTATION_CHANGED_BEFORE_RED'));
  } finally { await rm(f.root, { recursive: true, force: true }); }
});
test('existing-failure mode rejects unrelated baseline failures and imported evidence', async () => {
  const f = await fixture();
  try {
    await writeFile(path.join(f.root, 'behavior.mjs'), "import assert from 'node:assert/strict'; import {value} from './implementation.mjs'; assert.equal(value, 2);\n");
    const evidence = await f.capture('baseline');
    const state = createWorkflowState('run-tdd'); const baseline = createTestBaseline(state, 'TASK-001', [evidence], ['unit']);
    const input = { baseline, snapshot: await f.snapshot(), scenarioIds: ['SCN-001'], testScopes: ['behavior.mjs'], implementationScopes: ['implementation.mjs'] };
    assert.throws(() => openTestCycle(state, input), code('TDD_BASELINE_FAILED'));
    assert.throws(() => openTestCycle(state, { ...input, mode: 'existing-failure' }), code('TDD_EXISTING_FAILURE_ACCEPTANCE'));
    const acceptance = { evidenceIds: [evidence.id], diagnostics: [{ commandEvidenceId: evidence.id, kind: 'business-assertion' as const, scenarioIds: ['SCN-001'], assertion: '原缺陷已复现', sourceReference: `${evidence.id}:stderr` }], rationale: '已授权问题的已有失败测试', sourceReferences: ['session:existing-failure'] };
    assert.throws(() => openTestCycle(state, { ...input, mode: 'existing-failure', existingFailure: { ...acceptance, diagnostics: [{ ...acceptance.diagnostics[0], kind: 'environment' }] } }), code('TDD_INVALID_RED'));
    const opened = openTestCycle(state, { ...input, mode: 'existing-failure', existingFailure: acceptance });
    assert.equal(opened.cycle.status, 'red-accepted'); assert.equal(opened.cycle.mode, 'existing-failure');
    assert.throws(() => createTestBaseline(state, 'TASK-001', [{ ...evidence, id: 'imported-json' }], ['unit']), code('COMMAND_PROVENANCE_UNVERIFIED'));
  } finally { await rm(f.root, { recursive: true, force: true }); }
});
test('commands that change source while running cannot produce accepted evidence', async () => {
  const f = await fixture();
  try {
    await writeFile(path.join(f.root, 'behavior.mjs'), "import { writeFileSync } from 'node:fs'; writeFileSync('implementation.mjs', 'export const value = 99;');\n");
    await assert.rejects(f.capture('verify'), code('COMMAND_INPUT_CHANGED'));
  } finally { await rm(f.root, { recursive: true, force: true }); }
});
test('an actual Green command run before Red acceptance cannot be replayed afterward', async () => {
  const f = await fixture();
  try {
    await writeFile(path.join(f.root, 'behavior.mjs'), "import assert from 'node:assert/strict'; import {value} from './implementation.mjs'; assert.equal(value, 2);\n");
    const red = await f.capture('red', f.cycle.id);
    let state = recordTestStep(f.state, f.cycle.id, 'red', [red]);
    const acceptance = { evidenceIds: [red.id], diagnostics: [{ commandEvidenceId: red.id, kind: 'business-assertion' as const, scenarioIds: ['SCN-001'], assertion: 'value 应为 2', sourceReference: `${red.id}:stderr` }], rationale: '授权缺陷', sourceReferences: ['session:fixture'] };
    await writeFile(path.join(f.root, 'implementation.mjs'), 'export const value = 2;\n');
    const prematurelyRunGreen = await f.capture('green', f.cycle.id);
    const changedSnapshot = await f.snapshot();
    assert.throws(() => acceptRed(state, f.cycle.id, acceptance, changedSnapshot), code('TDD_RED_STALE'));
    await writeFile(path.join(f.root, 'implementation.mjs'), 'export const value = 1;\n');
    state = acceptRed(state, f.cycle.id, acceptance, await f.snapshot());
    assert.throws(() => recordTestStep(state, f.cycle.id, 'green', [prematurelyRunGreen]), code('TDD_GREEN_BEFORE_ACCEPTANCE'));
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('change-scoped Architect reports require an empty task list and block overlapping attempts', () => {
  const prepared = prepareDispatch(createWorkflowState('run-test'), { role: 'architect', allowedPaths: ['docs/**'], requirementIds: ['REQ-001'], scenarioIds: ['SCN-001'], startHead: head, fingerprints: fp });
  assert.equal(prepared.dispatch.scope, 'change');
  assert.throws(() => prepareDispatch(prepared.state, { taskId: 'TASK-001', role: 'tester', allowedPaths: ['tests/**'], requirementIds: [], scenarioIds: [], startHead: head, fingerprints: fp }), code('DISPATCH_ACTIVE_ATTEMPT'));
  const state = structuredClone(prepared.state); state.dispatches[0].status = 'attached'; state.dispatches[0].agentId = 'fixture-agent';
  const report = { ...reportFor(state), taskIds: [] };
  assert.equal(collectDispatchReport(state, report).accepted, true);
  assert.equal(collectDispatchReport(state, { ...report, taskIds: ['TASK-001'] }).accepted, false);
  assert.throws(() => prepareDispatch(createWorkflowState('other'), { role: 'tester', allowedPaths: [], requirementIds: [], scenarioIds: [], startHead: head, fingerprints: fp }), code('DISPATCH_TASK_ID'));
});
