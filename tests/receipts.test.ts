import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { auditDispatchOutput, applyAcceptedOutput, acceptDispatchOutput, outputManifestChanges, type OutputSnapshot } from '../src/workflow/receipts.js';
import { createWorkflowState } from '../src/workflow/state.js';
import { captureCommandEvidence, commandPlanDigest, markEvidenceBoundary, currentEvidenceSession } from '../src/workflow/evidence.js';
import { createTestBaseline, openTestCycle, recordTestStep, acceptRed, completeRefactorWithoutChanges } from '../src/workflow/tdd.js';
import { prepareDispatch } from '../src/workflow/dispatch.js';
import type { Dispatch, DispatchReport, Fingerprints } from '../src/workflow/types.js';
import type { ManifestEntry } from '../src/runtime/fingerprints.js';
import type { ValidationCommand } from '../src/project/index.js';
import { sha256, stableStringify } from '../src/shared/hash.js';

function code(expected: string) { return (error: unknown) => !!error && typeof error === 'object' && 'code' in error && error.code === expected; }
const head = 'a'.repeat(40);
const file = (name: string, content: string, executable = false): ManifestEntry => ({ path: name, type: 'file', sha256: sha256(content), executable });
function snapshot(source: ManifestEntry[], overrides: Partial<OutputSnapshot['manifests']> = {}): OutputSnapshot {
  const manifests = { source, spec: [], plan: [], policy: [], ...overrides };
  const fingerprints = Object.fromEntries(Object.entries(manifests).map(([key, entries]) => [key, sha256(stableStringify(entries))])) as Omit<Fingerprints, 'environment'>;
  return { head, indexDigest: sha256('index'), fingerprints: { ...fingerprints, environment: sha256('environment') }, manifests };
}
const command: ValidationCommand = { id: 'unit', executable: 'node', args: ['-e', 'process.stdout.write("observed")'], cwd: '.', timeoutSeconds: 5, modules: ['app'], artifacts: [], envAllowlist: ['PATH'] };
async function fixture(t: { after: (callback: () => Promise<void>) => void }) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'workflow-receipts-')); t.after(() => rm(root, { recursive: true, force: true }));
  const start = snapshot([file('src/change.ts', 'old'), file('src/deleted.ts', 'delete')]);
  const current = snapshot([file('src/added.ts', 'new'), file('src/change.ts', 'changed')]);
  const state = createWorkflowState('run-receipt', start.fingerprints);
  const commands = [command];
  const d: Dispatch = { id: 'dispatch-one', attemptId: 'attempt-one', taskId: 'TASK-001', scope: 'task', role: 'developer-verification', status: 'attached', agentId: 'fixture-native-agent', startHead: head, fingerprints: start.fingerprints, allowedPaths: ['src/**'], forbiddenPaths: [], requirementIds: ['REQ-001'], scenarioIds: ['SCN-001'], evidenceBoundary: markEvidenceBoundary(), evidenceSessionId: currentEvidenceSession(), testMode: 'verification', taskPlan: { commandPlanDigest: sha256(stableStringify(commands)), testCommands: ['unit'], acceptance: '验证产物' } };
  state.dispatches.push(d);
  const executionSnapshot = () => Promise.resolve({ head, fingerprints: current.fingerprints, testDigest: sha256('tests'), implementationDigest: current.fingerprints.source, environmentDigest: current.fingerprints.environment });
  const evidence = await captureCommandEvidence(root, command, { runId: state.runId, taskId: 'TASK-001', step: 'verify' }, executionSnapshot);
  const report: DispatchReport = { protocolVersion: 1, runId: state.runId, dispatchId: d.id, attemptId: d.attemptId, status: 'DONE', taskIds: ['TASK-001'], files: ['src/added.ts', 'src/change.ts', 'src/deleted.ts'], evidenceIds: [evidence.id], requirementIds: d.requirementIds, scenarioIds: d.scenarioIds, startHead: head, question: null, next: '主会话接收' };
  d.report = report;
  const input = { state, dispatchId: d.id, attemptId: d.attemptId, start, current, commandEvidence: [evidence], commands: [command] };
  return { root, state, d, report, start, current, evidence, input, executionSnapshot };
}

test('complete manifest audit includes deletion, additions, mode/type changes and both rename endpoints', () => {
  const before = snapshot([file('old.ts', 'rename'), file('mode.ts', 'same')]);
  const after = snapshot([file('new.ts', 'rename'), file('mode.ts', 'same', true)]);
  assert.deepEqual(outputManifestChanges(before.manifests, after.manifests).map(change => [change.path, change.kind]), [['mode.ts', 'modified'], ['new.ts', 'added'], ['old.ts', 'deleted']]);
  const symlink = snapshot([{ path: 'mode.ts', type: 'symlink', sha256: sha256('same') }]);
  assert.equal(outputManifestChanges(snapshot([file('mode.ts', 'same')]).manifests, symlink.manifests)[0].kind, 'modified');
});

test('legitimate observed output has a domain transition, invalidates downstream and never grants phase success', async t => {
  const f = await fixture(t);
  f.state.phases.dev.status = 'running';
  for (const phase of ['tester', 'cr', 'verify', 'integrate'] as const) f.state.phases[phase] = { status: 'succeeded', evidenceIds: ['old-proof'] };
  const original = structuredClone(f.state);
  const audit = auditDispatchOutput(f.input);
  assert.equal(audit.deterministicChecksPassed, true, JSON.stringify(audit.diagnostics));
  assert.equal(audit.acceptedOutput, false); assert.equal(audit.executionReady, false);
  assert.deepEqual(audit.diagnostics.map(value => value.code), ['OUTPUT_AUTHORSHIP_UNVERIFIED']);
  const next = applyAcceptedOutput(f.state, audit, f.current);
  assert.equal(next.dispatches[0].status, 'completed'); assert.deepEqual(next.fingerprints, f.current.fingerprints);
  assert.equal(next.phases.dev.status, 'running');
  for (const phase of ['tester', 'cr', 'verify', 'integrate'] as const) { assert.equal(next.phases[phase].status, 'pending'); assert.deepEqual(next.phases[phase].evidenceIds, []); }
  assert.deepEqual(f.state, original);
  assert.throws(() => acceptDispatchOutput(f.input), code('HOST_PROVENANCE_UNVERIFIED'));
});

test('copied, modified, stale and rejected audits cannot accept output', async t => {
  const f = await fixture(t); const audit = auditDispatchOutput(f.input);
  assert.throws(() => applyAcceptedOutput(f.state, structuredClone(audit), f.current), code('OUTPUT_AUDIT_UNVERIFIED'));
  assert.throws(() => applyAcceptedOutput({ ...f.state, staleReports: [{ report: {}, reason: 'changed' }] }, audit, f.current), code('OUTPUT_AUDIT_STALE'));
  assert.throws(() => applyAcceptedOutput(f.state, audit, { ...f.current, head: 'b'.repeat(40) }), code('OUTPUT_AUDIT_STALE'));
  audit.deterministicChecksPassed = false;
  assert.throws(() => applyAcceptedOutput(f.state, audit, f.current), code('OUTPUT_AUDIT_UNVERIFIED'));
  f.report.files = f.report.files.filter(value => value !== 'src/deleted.ts');
  const rejected = auditDispatchOutput(f.input);
  assert.equal(rejected.deterministicChecksPassed, false);
  assert(rejected.diagnostics.some(value => value.code === 'OUTPUT_FILES_INCOMPLETE'));
  assert.throws(() => applyAcceptedOutput(f.state, rejected, f.current), code('OUTPUT_AUDIT_REJECTED'));
});

test('old attempt, unattached attempt, HEAD/index changes, missing and tampered manifests are diagnosed', async t => {
  const f = await fixture(t);
  const cases: Array<[Partial<typeof f.input>, string]> = [
    [{ attemptId: 'attempt-old' }, 'OUTPUT_ATTEMPT_UNKNOWN'],
    [{ start: undefined }, 'OUTPUT_BASELINE_REQUIRED'],
    [{ current: { ...f.current, head: 'b'.repeat(40) } }, 'OUTPUT_HEAD_CHANGED'],
    [{ current: { ...f.current, indexDigest: sha256('other-index') } }, 'OUTPUT_INDEX_CHANGED'],
    [{ start: { ...f.start, manifests: { ...f.start.manifests, source: [] } } }, 'OUTPUT_SNAPSHOT_INVALID'],
  ];
  for (const [override, expected] of cases) assert(auditDispatchOutput({ ...f.input, ...override }).diagnostics.some(value => value.code === expected), expected);
  f.d.status = 'planned';
  assert(auditDispatchOutput(f.input).diagnostics.some(value => value.code === 'OUTPUT_ATTEMPT_NOT_ATTACHED'));
});

test('unreported, forbidden, other-writer and protected input changes cannot be hidden by a DONE claim', async t => {
  const f = await fixture(t);
  f.d.forbiddenPaths = ['src/deleted.ts'];
  assert(auditDispatchOutput(f.input).diagnostics.some(value => value.code === 'OUTPUT_PATH_SCOPE'));
  f.d.forbiddenPaths = [];
  f.state.dispatches.push({ ...structuredClone(f.d), id: 'other-writer', attemptId: 'other-attempt', taskId: 'TASK-002', allowedPaths: ['elsewhere/**'], status: 'planned' });
  assert(auditDispatchOutput(f.input).diagnostics.some(value => value.code === 'OUTPUT_OTHER_WRITER'));
  f.state.dispatches.pop();
  for (const group of ['spec', 'plan', 'policy'] as const) {
    const current = snapshot(f.current.manifests.source, { [group]: [file(`${group}.md`, 'changed')] });
    assert(auditDispatchOutput({ ...f.input, current }).diagnostics.some(value => value.code === 'OUTPUT_PROTECTED_INPUT_CHANGED'), group);
  }
  const current = { ...f.current, fingerprints: { ...f.current.fingerprints, environment: sha256('changed') } };
  assert(auditDispatchOutput({ ...f.input, current }).diagnostics.some(value => value.code === 'OUTPUT_PROTECTED_INPUT_CHANGED'));
});

test('forged command records and arbitrary real commands cannot substitute for planned execution', async t => {
  const f = await fixture(t);
  const forged = { ...f.evidence, outputDigest: sha256('made-up') };
  assert(auditDispatchOutput({ ...f.input, commandEvidence: [forged] }).diagnostics.some(value => value.code === 'COMMAND_PROVENANCE_UNVERIFIED'));
  f.d.taskPlan!.testCommands = ['regression'];
  assert(auditDispatchOutput(f.input).diagnostics.some(value => value.code === 'OUTPUT_COMMAND_PLAN'));
  f.d.taskPlan!.testCommands = ['unit'];
  f.report.evidenceIds = ['claimed-command'];
  assert(auditDispatchOutput({ ...f.input, commandEvidence: [] }).diagnostics.some(value => value.code === 'OUTPUT_EVIDENCE_INCOMPLETE'));
});

test('Architect plan output reopens spec gate and retains completed history while invalidating unfinished cycles', async t => {
  const f = await fixture(t);
  const start = snapshot([], { plan: [file('.workflow/changes/demo/tasks.md', 'old')] });
  const current = snapshot([], { plan: [file('.workflow/changes/demo/tasks.md', 'new')] });
  f.state.fingerprints = start.fingerprints;
  Object.assign(f.d, { scope: 'change', taskId: undefined, role: 'architect', testMode: undefined, taskPlan: undefined, fingerprints: start.fingerprints, allowedPaths: ['.workflow/changes/demo/tasks.md'] });
  Object.assign(f.report, { taskIds: [], files: ['.workflow/changes/demo/tasks.md'], evidenceIds: [`manifest-${sha256(stableStringify(current.manifests))}`] });
  const baselineEvidence = await captureCommandEvidence(f.root, command, { runId: f.state.runId, taskId: 'TASK-002', step: 'baseline' }, () => Promise.resolve({ head, fingerprints: start.fingerprints, testDigest: sha256('tests'), implementationDigest: start.fingerprints.source, environmentDigest: start.fingerprints.environment }));
  const baseline = createTestBaseline(f.state, 'TASK-002', [baselineEvidence], ['unit']);
  const opened = openTestCycle(f.state, { baseline, snapshot: { head, fingerprints: start.fingerprints, testDigest: baseline.testDigest, implementationDigest: baseline.implementationDigest, environmentDigest: baseline.environmentDigest }, scenarioIds: ['SCN-001'], testScopes: ['tests/**'], implementationScopes: ['src/**'] });
  const unfinished = opened.cycle;
  const completed = { ...structuredClone(unfinished), id: 'history-complete', status: 'complete' as const };
  f.state.cycles = [completed, unfinished];
  const input = { ...f.input, start, current, commandEvidence: [] };
  const audit = auditDispatchOutput(input);
  assert.equal(audit.deterministicChecksPassed, true, JSON.stringify(audit.diagnostics));
  const next = applyAcceptedOutput(f.state, audit, current);
  assert.deepEqual(next.cycles[0], completed); assert.equal(next.cycles[1].status, 'invalidated');
  assert.deepEqual(audit.invalidatedPhases, ['spec-gate', 'dev', 'tester', 'cr', 'verify', 'integrate']);
  assert.equal(next.phases.architect.status, f.state.phases.architect.status);
});

test('command evidence from before this attempt and same-ID substituted commands are rejected', async t => {
  const f = await fixture(t);
  f.d.evidenceBoundary = markEvidenceBoundary();
  assert(auditDispatchOutput(f.input).diagnostics.some(d => d.code === 'OUTPUT_EVIDENCE_BEFORE_ATTEMPT'));
  delete f.d.evidenceBoundary;
  assert(auditDispatchOutput(f.input).diagnostics.some(d => d.code === 'OUTPUT_EVIDENCE_BEFORE_ATTEMPT'));
  f.d.evidenceBoundary = 1;
  const wrong = { ...command, args: ['-e', ''] };
  const evidence = await captureCommandEvidence(f.root, wrong, { runId: f.state.runId, taskId: 'TASK-001', step: 'verify' }, f.executionSnapshot);
  f.report.evidenceIds = [evidence.id];
  const audit = auditDispatchOutput({ ...f.input, commandEvidence: [evidence] });
  assert(audit.diagnostics.some(d => d.code === 'OUTPUT_COMMAND_DEFINITION'));
  assert.equal(audit.deterministicChecksPassed, false);
});

test('an exempt plan and manifest cannot manufacture observed manual acceptance', async t => {
  const f = await fixture(t);
  f.d.role = 'developer-exempt'; f.d.testMode = 'exempt';
  f.d.taskPlan = { testCommands: [], acceptance: 'manual acceptance', testRationale: 'documentation', alternativeAcceptance: 'inspect rendered result' };
  f.report.evidenceIds = [`manifest-${sha256(stableStringify(f.current.manifests))}`];
  const audit = auditDispatchOutput({ ...f.input, commandEvidence: [] });
  assert.equal(audit.deterministicChecksPassed, false);
  assert(audit.diagnostics.some(d => d.code === 'OUTPUT_ALTERNATIVE_ACCEPTANCE_UNVERIFIED'));
  assert.throws(() => applyAcceptedOutput(f.state, audit, f.current), code('OUTPUT_AUDIT_REJECTED'));
});

test('Tester supplemental tests preserve completed history and invalidate only later gates', async t => {
  const f = await fixture(t);
  f.d.role = 'tester';
  f.state.phases.tester.status = 'running';
  for (const phase of ['cr', 'verify', 'integrate'] as const) f.state.phases[phase] = { status: 'succeeded', evidenceIds: ['prior-result'] };
  const prior = { id: 'completed-history', runId: f.state.runId, taskId: 'TASK-000', revision: 2, mode: 'new-test' as const, status: 'complete' as const, scenarioIds: [], baseline: {} as never, testScopes: ['tests/**'], implementationScopes: ['src/**'], red: [], green: [], refactor: [] };
  f.state.cycles = [prior];
  const audit = auditDispatchOutput(f.input);
  assert.equal(audit.deterministicChecksPassed, true, JSON.stringify(audit.diagnostics));
  const next = applyAcceptedOutput(f.state, audit, f.current);
  assert.deepEqual(next.cycles[0], prior);
  assert.equal(next.phases.tester.status, 'running');
  assert.deepEqual(audit.invalidatedPhases, ['cr', 'verify', 'integrate']);
  assert.deepEqual(next.dispatches[0].outputReceipt?.changedPaths, audit.changes.map(c => c.path));
  assert.deepEqual(next.dispatches[0].outputReceipt?.outputFingerprints, f.current.fingerprints);
});

test('observed Red and Green receipts advance one cycle without erasing history or skipping Refactor', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'workflow-receipt-tdd-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'src')); await mkdir(path.join(root, 'tests'));
  await writeFile(path.join(root, 'src/ready'), 'old');
  const planned: ValidationCommand = { ...command, args: ['-e', "const fs=require('node:fs'); if(fs.existsSync('tests/need') && fs.readFileSync('src/ready','utf8')!=='ready') process.exitCode=1"] };
  const plan = sha256(stableStringify([planned]));
  const observe = async () => {
    const implementation = await readFile(path.join(root, 'src/ready'), 'utf8');
    const test = await readFile(path.join(root, 'tests/need'), 'utf8').catch(() => '');
    const current = snapshot([file('src/ready', implementation), ...(test ? [file('tests/need', test)] : [])]);
    return { current, execution: { head, fingerprints: current.fingerprints, testDigest: sha256(test), implementationDigest: sha256(implementation), environmentDigest: current.fingerprints.environment } };
  };
  const initial = await observe();
  let state = createWorkflowState('run-tdd-receipt', initial.current.fingerprints);
  const base = await captureCommandEvidence(root, planned, { runId: state.runId, taskId: 'TASK-001', step: 'baseline' }, async () => (await observe()).execution);
  const opened = openTestCycle(state, { baseline: createTestBaseline(state, 'TASK-001', [base], ['unit']), snapshot: initial.execution, scenarioIds: ['SCN-001'], testScopes: ['tests/**'], implementationScopes: ['src/**'] });
  state = opened.state;
  const prepare = (role: 'developer-red' | 'developer-green', start: OutputSnapshot) => prepareDispatch(state, { role, taskId: 'TASK-001', cycleId: opened.cycle.id, testMode: 'tdd', taskPlan: { testCommands: ['unit'], commandPlanDigest: plan, acceptance: 'observed cycle' }, allowedPaths: role === 'developer-red' ? ['tests/**'] : ['tests/**', 'src/**'], requirementIds: ['REQ-001'], scenarioIds: ['SCN-001'], startHead: head, fingerprints: start.fingerprints });
  const redPrepared = prepare('developer-red', initial.current); state = redPrepared.state;
  await writeFile(path.join(root, 'tests/need'), 'behavior assertion');
  const red = await captureCommandEvidence(root, planned, { runId: state.runId, taskId: 'TASK-001', cycleId: opened.cycle.id, step: 'red' }, async () => (await observe()).execution);
  state = recordTestStep(state, opened.cycle.id, 'red', [red]);
  const report = (id: string, evidenceId: string, files: string[]) => {
    const d = state.dispatches.find(d => d.id === id)!;
    d.status = 'attached'; d.agentId = 'native-fixture';
    d.report = { protocolVersion: 1, runId: state.runId, dispatchId: d.id, attemptId: d.attemptId, status: 'DONE', taskIds: ['TASK-001'], files, evidenceIds: [evidenceId], requirementIds: d.requirementIds, scenarioIds: d.scenarioIds, startHead: head, question: null, next: 'audit' };
    return d;
  };
  const redDispatch = report(redPrepared.dispatch.id, red.id, ['tests/need']);
  const redCurrent = await observe();
  const redAudit = auditDispatchOutput({ state, dispatchId: redDispatch.id, attemptId: redDispatch.attemptId, start: initial.current, current: redCurrent.current, commandEvidence: [red], commands: [planned] });
  assert.equal(redAudit.deterministicChecksPassed, true, JSON.stringify(redAudit.diagnostics));
  state = applyAcceptedOutput(state, redAudit, redCurrent.current);
  assert.equal(state.cycles[0].status, 'red-observed');
  state = acceptRed(state, opened.cycle.id, { evidenceIds: [red.id], diagnostics: [{ commandEvidenceId: red.id, kind: 'business-assertion', scenarioIds: ['SCN-001'], assertion: 'requires ready state', sourceReference: 'tests/need' }], rationale: 'observed behavior missing', sourceReferences: ['tests/need'] }, redCurrent.execution);
  const greenPrepared = prepare('developer-green', redCurrent.current); state = greenPrepared.state;
  await writeFile(path.join(root, 'src/ready'), 'ready');
  const green = await captureCommandEvidence(root, planned, { runId: state.runId, taskId: 'TASK-001', cycleId: opened.cycle.id, step: 'green' }, async () => (await observe()).execution);
  state = recordTestStep(state, opened.cycle.id, 'green', [green]);
  const greenDispatch = report(greenPrepared.dispatch.id, green.id, ['src/ready']);
  const current = await observe();
  const input = () => ({ state, dispatchId: greenDispatch.id, attemptId: greenDispatch.attemptId, start: redCurrent.current, current: current.current, commandEvidence: [green], commands: [planned] });
  assert(auditDispatchOutput(input()).diagnostics.some(d => d.code === 'OUTPUT_TDD_CYCLE_NOT_READY'));
  state = completeRefactorWithoutChanges(state, opened.cycle.id, 'minimal implementation', current.execution);
  const audit = auditDispatchOutput(input());
  assert.equal(audit.deterministicChecksPassed, true, JSON.stringify(audit.diagnostics));
  state = applyAcceptedOutput(state, audit, current.current);
  assert.equal(state.cycles[0].status, 'complete');
  assert.equal(state.cycles[0].red[0].id, red.id);
  assert.equal(state.cycles[0].green[0].id, green.id);
  assert(state.dispatches.every(d => d.status === 'completed' && d.outputReceipt));
});


test('output receipts cannot replace independent review or verification gates', async t => {
  const f = await fixture(t);
  for (const role of ['reviewer', 'verifier'] as const) {
    f.d.role = role;
    const audit = auditDispatchOutput(f.input);
    assert.equal(audit.deterministicChecksPassed, false);
    assert(audit.diagnostics.some(d => d.code === 'OUTPUT_ROLE_UNSUPPORTED'));
    assert.throws(() => applyAcceptedOutput(f.state, audit, f.current), code('OUTPUT_AUDIT_REJECTED'));
  }
});


test('a persisted attempt cannot reuse a numeric sequence from a different observation session', async t => {
  const f = await fixture(t);
  f.d.evidenceSessionId = 'previous-process'; f.d.evidenceBoundary = 1;
  const audit = auditDispatchOutput(f.input);
  assert.equal(audit.deterministicChecksPassed, false);
  assert(audit.diagnostics.some(d => d.code === 'OUTPUT_EVIDENCE_SESSION'));
});
