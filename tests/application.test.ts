import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, cp, mkdir, rm, chmod } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { sha256 } from '../src/shared/hash.js';
import { createRun, readRun } from '../src/runtime/index.js';
import { prepareRunDispatch, collectRunDispatch } from '../src/application/dispatch.js';
import { previewRebaseline } from '../src/application/rebaseline.js';

const exec = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runtime = { version: '0.1.0-preview.1', sha256: sha256(await readFile(path.join(root, 'dist/workflow.js'))) };
async function fixture(t: { after: (f: () => Promise<void>) => void }) {
  const project = await mkdtemp(path.join(os.tmpdir(), 'workflow-packet-'));
  t.after(() => rm(project, { recursive: true, force: true }));
  await mkdir(path.join(project, '.workflow/changes'), { recursive: true });
  await cp(path.join(root, 'examples/change'), path.join(project, '.workflow/changes/session-timeout'), { recursive: true });
  await cp(path.join(root, 'examples/config/minimal.yaml'), path.join(project, '.workflow/config.yaml'));
  await cp(path.join(root, 'examples/rules.md'), path.join(project, '.workflow/rules.md'));
  const git = async (...args: string[]) => (await exec('git', ['-C', project, ...args])).stdout;
  await git('init', '-b', 'codex/change');
  await git('add', '.');
  await git('-c', 'user.name=Workflow Test', '-c', 'user.email=workflow@example.invalid', 'commit', '-m', 'fixture');
  const run = await createRun(project, { changeId: 'session-timeout', operationId: 'run', runtime });
  return { project, run };
}

test('prepared role packet is scoped, persistent and idempotent but cannot imply native execution', async t => {
  const { project, run } = await fixture(t);
  const credentials = { owner: run.owner, expectedRevision: 0, operationId: 'prepare', runtime };
  const input = { taskId: 'TASK-001', role: 'reviewer' as const };
  const prepared = await prepareRunDispatch(project, run.changeId, run.runId, credentials, input);
  assert.equal(prepared.executionReady, false);
  assert.deepEqual(prepared.packet.allowedPaths, []);
  assert.equal(prepared.packet.status, 'planned');
  assert(!JSON.stringify(prepared.packet).includes(run.owner));
  assert(prepared.packet.contextPaths.every(p => !path.isAbsolute(p)));
  const replay = await prepareRunDispatch(project, run.changeId, run.runId, credentials, input);
  assert.equal(replay.packet.id, prepared.packet.id);
  assert.equal(replay.revision, 1);
  await assert.rejects(prepareRunDispatch(project, run.changeId, run.runId, credentials, { ...input, role: 'tester' }), { code: 'OPERATION_CONFLICT' });
  const state = await readRun(project, run.runId);
  assert.equal(state.status, 'pending');
  assert.equal((state.workflow as { dispatches: unknown[] }).dispatches.length, 1);
});

test('collecting DONE for a planned packet records rejection and never promotes phase', async t => {
  const { project, run } = await fixture(t);
  const prepared = await prepareRunDispatch(project, run.changeId, run.runId, { owner: run.owner, expectedRevision: 0, operationId: 'prepare', runtime }, { taskId: 'TASK-001', role: 'reviewer' });
  const reportPath = path.join(project, 'report.json');
  await writeFile(reportPath, JSON.stringify({ protocolVersion: 1, runId: run.runId, dispatchId: prepared.packet.id, attemptId: prepared.packet.attemptId, status: 'DONE', taskIds: ['TASK-001'], files: [], evidenceIds: ['evidence-claim'], requirementIds: prepared.packet.requirementIds, scenarioIds: prepared.packet.scenarioIds, startHead: prepared.packet.startHead, question: null, next: 'audit' }));
  const credentials = { owner: run.owner, expectedRevision: 1, operationId: 'collect', runtime };
  const input = { dispatchId: prepared.packet.id, attemptId: prepared.packet.attemptId, reportPath };
  const result = await collectRunDispatch(project, run.changeId, run.runId, credentials, input);
  assert.equal(result.accepted, false);
  assert.equal(result.phaseAdvanced, false);
  assert.equal(result.diagnostics[0].code, 'REPORT_ATTEMPT_NOT_RUNNING');
  assert.equal((await collectRunDispatch(project, run.changeId, run.runId, credentials, input)).revision, 2);
  const state = await readRun(project, run.runId);
  const workflow = state.workflow as { staleReports: unknown[]; dispatches: { status: string }[] };
  assert.equal(workflow.staleReports.length, 1);
  assert.equal(workflow.dispatches[0].status, 'planned');
  assert.equal(state.status, 'pending');
});

test('Green packet needs a valid accepted cycle and cannot be prepared from task checkboxes', async t => {
  const { project, run } = await fixture(t);
  await assert.rejects(prepareRunDispatch(project, run.changeId, run.runId, { owner: run.owner, expectedRevision: 0, operationId: 'green', runtime }, { taskId: 'TASK-001', role: 'developer-green' }), { code: 'DISPATCH_CYCLE_REQUIRED' });
  assert.equal((await readRun(project, run.runId)).revision, 0);
});

test('rebaseline preview uses original Git snapshot and does not guess unavailable baseline content', async t => {
  const { project, run } = await fixture(t);
  const original = await previewRebaseline(project, run.changeId, run.runId);
  assert.equal(original.readonly, true);
  assert.equal(original.applyAvailable, false);
  assert.deepEqual(original.oldHashes, { session: null });
  assert.equal(original.diagnostics.length, 0);
  await mkdir(path.join(project, '.workflow/specs/session'), { recursive: true });
  const currentSpec = (await readFile(path.join(root, 'examples/expected/specs/session/spec.md'), 'utf8')).replace('服务端应在', '服务端必须在');
  await writeFile(path.join(project, '.workflow/specs/session/spec.md'), currentSpec);
  const conflicted = await previewRebaseline(project, run.changeId, run.runId);
  assert(conflicted.conflicts.some(conflict => conflict.id === 'REQ-SESSION-001'));
  assert.equal(await readFile(path.join(project, '.workflow/specs/session/spec.md'), 'utf8'), currentSpec);
  assert.equal((await readRun(project, run.runId)).revision, 0);
  const deltaPath = path.join(project, '.workflow/changes/session-timeout/specs/session/delta.md');
  await writeFile(deltaPath, (await readFile(deltaPath, 'utf8')).replace('baseHash: null', `baseHash: ${'a'.repeat(64)}`));
  const unavailable = await previewRebaseline(project, run.changeId, run.runId);
  assert(unavailable.diagnostics.some(diagnostic => diagnostic.code === 'SPEC_REBASELINE_BASE_UNAVAILABLE'));
});

test('a task scope edit between parsing and fingerprint capture cannot authenticate an old wider packet', { skip: process.platform === 'win32' }, async t => {
  const { project, run } = await fixture(t);
  const wrappers = await mkdtemp(path.join(os.tmpdir(), 'workflow-git-wrapper-'));
  t.after(() => rm(wrappers, { recursive: true, force: true }));
  const realGit = (await exec('which', ['git'])).stdout.trim();
  const originalPath = process.env.PATH;
  const tasksPath = path.join(project, '.workflow/changes/session-timeout/tasks.md');
  const marker = path.join(wrappers, 'edited');
  const wrapper = `#!${process.execPath}\nconst fs = require('node:fs');\nconst cp = require('node:child_process');\nif (process.argv.includes('ls-files') && !fs.existsSync(${JSON.stringify(marker)})) {\n fs.writeFileSync(${JSON.stringify(marker)}, 'edited');\n const p = ${JSON.stringify(tasksPath)};\n fs.writeFileSync(p, fs.readFileSync(p, 'utf8').replaceAll('tests/session/**', 'tests/session/narrow/**'));\n}\ntry { cp.execFileSync(${JSON.stringify(realGit)}, process.argv.slice(2), { stdio: 'inherit' }); } catch (error) { process.exit(error.status || 1); }\n`;
  await writeFile(path.join(wrappers, 'git'), wrapper);
  await chmod(path.join(wrappers, 'git'), 0o755);
  process.env.PATH = `${wrappers}${path.delimiter}${originalPath}`;
  try {
    await assert.rejects(prepareRunDispatch(project, run.changeId, run.runId, { owner: run.owner, expectedRevision: 0, operationId: 'race', runtime }, { taskId: 'TASK-001', role: 'tester' }), { code: 'DISPATCH_PLAN_CHANGED' });
  } finally {
    if (originalPath === undefined) delete process.env.PATH; else process.env.PATH = originalPath;
  }
  assert.match(await readFile(tasksPath, 'utf8'), /tests\/session\/narrow/);
  assert.equal((await readRun(project, run.runId)).revision, 0);
});

test('Architect can prepare a change-scoped packet before design and tasks exist', async t => {
  const { project, run } = await fixture(t);
  await rm(path.join(project, '.workflow/changes/session-timeout/tasks.md'));
  await rm(path.join(project, '.workflow/changes/session-timeout/design.md'));
  const prepared = await prepareRunDispatch(project, run.changeId, run.runId, { owner: run.owner, expectedRevision: 0, operationId: 'architect-draft', runtime }, { role: 'architect' });
  assert.equal(prepared.packet.scope, 'change');
  assert.equal(prepared.packet.taskId, undefined);
  assert.deepEqual(prepared.packet.allowedPaths, ['.workflow/changes/session-timeout/design.md', '.workflow/changes/session-timeout/tasks.md']);
  assert(prepared.packet.requirementIds.includes('REQ-SESSION-001'));
  assert.equal(prepared.packet.executionReady, false);
  await assert.rejects(prepareRunDispatch(project, run.changeId, run.runId, { owner: run.owner, expectedRevision: 1, operationId: 'missing-task', runtime }, { role: 'tester' }), { code: 'DISPATCH_TASK_ID' });
});

test('non-TDD developer packets bind the actual task mode and cannot borrow Green', async t => {
  const { project, run } = await fixture(t);
  await assert.rejects(prepareRunDispatch(project, run.changeId, run.runId, { owner: run.owner, expectedRevision: 0, operationId: 'green-bypass', runtime }, { taskId: 'TASK-002', role: 'developer-green' }), { code: 'DISPATCH_TEST_MODE' });
  const prepared = await prepareRunDispatch(project, run.changeId, run.runId, { owner: run.owner, expectedRevision: 0, operationId: 'verification', runtime }, { taskId: 'TASK-002', role: 'developer-verification' });
  assert.equal(prepared.packet.scope, 'task');
  assert.equal(prepared.packet.testMode, 'verification');
  assert.equal(prepared.packet.cycleId, undefined);
  assert.deepEqual(prepared.packet.taskPlan?.testCommands, ['app-session-test']);
  assert(prepared.packet.taskPlan?.testRationale);
  assert.equal(prepared.executionReady, false);
  const next = { owner: run.owner, expectedRevision: 1, operationId: 'wrong-mode', runtime };
  await assert.rejects(prepareRunDispatch(project, run.changeId, run.runId, next, { taskId: 'TASK-001', role: 'developer-verification' }), { code: 'DISPATCH_TEST_MODE' });
});

test('exempt packet preserves an alternative acceptance plan without claiming approval', async t => {
  const { project, run } = await fixture(t);
  const tasksPath = path.join(project, '.workflow/changes/session-timeout/tasks.md');
  await writeFile(tasksPath, (await readFile(tasksPath, 'utf8')).replace('Test-Mode: verification', 'Test-Mode: exempt').replace('- Test-Rationale: 独立检查场景和边界覆盖，可补充缺失测试；不得替代 TASK-001 的任务内 TDD。', '- Test-Rationale: 手工替代验收\n- Alternative-Acceptance: Leader 按场景逐项检查并记录责任人'));
  const withAlternative = await readFile(tasksPath, 'utf8');
  await writeFile(tasksPath, withAlternative.replace('- Alternative-Acceptance: Leader 按场景逐项检查并记录责任人\n', ''));
  await assert.rejects(prepareRunDispatch(project, run.changeId, run.runId, { owner: run.owner, expectedRevision: 0, operationId: 'exempt-no-plan', runtime }, { taskId: 'TASK-002', role: 'developer-exempt' }), { code: 'DISPATCH_INVALID_DRAFT' });
  await writeFile(tasksPath, withAlternative);
  const prepared = await prepareRunDispatch(project, run.changeId, run.runId, { owner: run.owner, expectedRevision: 0, operationId: 'exempt', runtime }, { taskId: 'TASK-002', role: 'developer-exempt' });
  assert.equal(prepared.packet.testMode, 'exempt');
  assert.match(prepared.packet.taskPlan!.alternativeAcceptance!, /Leader/);
  assert(prepared.packet.requiredCapabilities.includes('approved-alternative-acceptance'));
  assert.equal(prepared.packet.status, 'planned');
  assert.equal(prepared.executionReady, false);
});

test('non-TDD preparation rejects unknown commands and paths outside configured modules', async t => {
  const { project, run } = await fixture(t);
  const taskPath = path.join(project, '.workflow/changes/session-timeout/tasks.md');
  const original = await readFile(taskPath, 'utf8');
  const verification = original.replace(/Test-Mode: tdd/g, 'Test-Mode: verification\n- Test-Rationale: Characterization and regression');
  const credentials = { owner: run.owner, expectedRevision: 0, operationId: 'bad-non-tdd', runtime };
  await writeFile(taskPath, verification.replace(/Test-Commands: .+/g, 'Test-Commands: nonexistent-command'));
  await assert.rejects(prepareRunDispatch(project, run.changeId, run.runId, credentials, { taskId: 'TASK-001', role: 'developer-verification' }), { code: 'DISPATCH_INVALID_DRAFT' });
  await writeFile(taskPath, verification.replace(/Write-Scopes: .+/g, 'Write-Scopes: outside-module/**'));
  await assert.rejects(prepareRunDispatch(project, run.changeId, run.runId, credentials, { taskId: 'TASK-001', role: 'developer-verification' }), { code: 'DISPATCH_INVALID_DRAFT' });
  assert.equal((await readRun(project, run.runId)).revision, 0);
});
