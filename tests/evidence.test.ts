import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, cp, chmod, readdir } from 'node:fs/promises';
import { watch, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { stringify } from 'yaml';
import { createRun, currentRuntimeIdentity, mutateRun, readRun } from '../src/runtime/state.js';
import { executeRunCommand, executeTaskBaseline, loadCommandEvidence, observeCommandBaseline } from '../src/runtime/evidence.js';
import { locateRepository } from '../src/repository/git.js';
import type { ValidationCommand } from '../src/project/index.js';
import { sha256, stableStringify } from '../src/shared/hash.js';

const exec = promisify(execFile);
const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const evidenceModule = pathToFileURL(path.join(sourceRoot, 'src/runtime/evidence.ts')).href;
function code(expected: string): (error: unknown) => boolean { return error => !!error && typeof error === 'object' && 'code' in error && error.code === expected; }
async function git(root: string, ...args: string[]): Promise<string> { return (await exec('git', ['-C', root, ...args], { env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } })).stdout; }
function command(id: string, script: string, overrides: Partial<ValidationCommand> = {}): ValidationCommand { return { id, executable: 'node', args: ['-e', script], cwd: '.', timeoutSeconds: 5, modules: ['app'], artifacts: [], envAllowlist: ['PATH'], ...overrides }; }
async function fixture(t: { after: (fn: () => Promise<void>) => void }, commands: ValidationCommand[]) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'workflow-evidence-中文 ')); t.after(() => rm(root, { recursive: true, force: true }));
  await git(root, 'init', '-q'); await git(root, 'config', 'user.name', 'Fixture'); await git(root, 'config', 'user.email', 'fixture@example.invalid');
  await writeFile(path.join(root, 'source.txt'), 'initial\n');
  await mkdir(path.join(root, '.workflow/changes'), { recursive: true });
  await cp(path.join(sourceRoot, 'examples/change'), path.join(root, '.workflow/changes/session-timeout'), { recursive: true });
  await writeFile(path.join(root, '.workflow/changes/session-timeout/tasks.md'), `# 任务\n\n## [ ] TASK-001 — 验证行为\n- Requires: REQ-SESSION-001\n- Depends-On: none\n- Write-Scopes: source.txt, tests/**\n- Test-Mode: tdd\n- Test-Scopes: tests/**\n- Test-Commands: ${commands.map(value => value.id).join(', ')}\n- Acceptance: 验证已声明行为\n`);
  await writeFile(path.join(root, '.workflow/config.yaml'), stringify({ formatVersion: 1, project: { id: 'fixture', name: 'Fixture' }, hosts: ['codex'], modules: [{ id: 'app', paths: ['source.txt', 'tests/**'], role: 'developer' }], git: { baseBranch: 'main' }, integration: { profile: 'local', mode: 'prepare' }, tracking: { required: false, providers: [] }, validation: { commands }, policy: {}, extensions: {} }));
  await git(root, 'add', '.'); await git(root, 'commit', '-qm', 'initial');
  const run = await createRun(root, { changeId: 'session-timeout', operationId: 'create' });
  return { root, run, input: { runId: run.runId, owner: run.owner, expectedRevision: run.revision, operationId: 'observe', taskId: 'TASK-001', command: commands[0]!, step: 'baseline' as const } };
}

test('real execution persists full output digests and loads in another process without importing JSON', async t => {
  const cmd = command('unit', `process.stdout.write('x'.repeat(100000)); process.stderr.write('checked')`);
  const { root, input } = await fixture(t, [cmd]);
  const result = await executeRunCommand(root, input, { maxOutputBytes: 100 });
  assert.equal(result.evidence.status, 'passed'); assert.equal(result.run.revision, 2);
  assert.equal(result.evidence.result?.stdoutBytes, 100000); assert.equal(result.evidence.result?.stdout.length, 100);
  assert.equal(result.evidence.result?.stdoutTruncated, true); assert.equal(result.evidence.result?.stderr, 'checked');
  assert.deepEqual(await loadCommandEvidence(root, input.runId, input.operationId), JSON.parse(JSON.stringify(result.evidence)));
  const script = `import {loadCommandEvidence} from ${JSON.stringify(evidenceModule)}; const e=await loadCommandEvidence(${JSON.stringify(root)},${JSON.stringify(input.runId)},'observe'); console.log(JSON.stringify({status:e.status,bytes:e.result.stdoutBytes}));`;
  const loaded = await exec(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], { cwd: sourceRoot });
  assert.deepEqual(JSON.parse(loaded.stdout), { status: 'passed', bytes: 100000 });
  await assert.rejects(executeRunCommand(root, { ...input, expectedRevision: result.run.revision }), code('EVIDENCE_OPERATION_USED'));
});

test('baseline batch executes every declared command and keeps operation reservation and exact revisions', async t => {
  const { root, input } = await fixture(t, [command('one', `process.stdout.write('one')`), command('two', `process.stdout.write('two')`)]);
  const batch = await executeTaskBaseline(root, input);
  assert.equal(batch.status, 'passed'); assert.equal(batch.run.revision, 6); assert.equal(batch.evidence.length, 2);
  assert.deepEqual(batch.evidence.map(value => value.result?.stdout), ['one', 'two']);
  for (const operationId of batch.operationIds) assert.equal((await loadCommandEvidence(root, input.runId, operationId)).status, 'passed');
  const replay = await executeTaskBaseline(root, input);
  assert.equal(replay.historical, true); assert.equal(replay.currentFreshness, true); assert.equal(replay.run.revision, 6); assert.deepEqual(replay.operationIds, batch.operationIds);
  await assert.rejects(executeTaskBaseline(root, { ...input, expectedRevision: batch.run.revision }), code('OPERATION_CONFLICT'));
  await writeFile(path.join(root, 'source.txt'), 'later change');
  const historical = await executeTaskBaseline(root, input);
  assert.equal(historical.status, 'passed'); assert.equal(historical.historical, true); assert.equal(historical.currentFreshness, false);
});

test('first baseline completion rechecks the exact window after command completion and before final CAS', async t => {
  const { root, input } = await fixture(t, [command('unit', `console.log('passed at command snapshot')`)]);
  const runDirectory = path.join((await locateRepository(root)).runtimeRoot, 'runs/session-timeout', input.runId);
  let changedAtRevision: number | undefined;
  const watcher = watch(runDirectory, (_event, filename) => {
    if (filename !== 'state.json' || changedAtRevision !== undefined) return;
    const state = JSON.parse(readFileSync(path.join(runDirectory, 'state.json'), 'utf8'));
    if (state.revision === 3) {
      writeFileSync(path.join(root, 'source.txt'), 'changed after command completion');
      changedAtRevision = state.revision;
    }
  });
  t.after(async () => watcher.close());
  const batch = await executeTaskBaseline(root, input);
  assert.equal(changedAtRevision, 3); assert.equal(batch.run.revision, 4);
  assert.equal(batch.evidence[0]?.status, 'passed');
  assert.equal(batch.status, 'failed'); assert.equal(batch.currentFreshness, false);
  const current = await observeCommandBaseline(root);
  assert.notEqual(current.fingerprints.sourceFingerprint, batch.evidence[0]?.after?.fingerprints.sourceFingerprint);
  const replay = await executeTaskBaseline(root, input);
  assert.equal(replay.historical, true); assert.equal(replay.status, 'failed'); assert.equal(replay.currentFreshness, false);
  // Restoring the original source does not authorize rewriting the historical
  // failed completion conclusion into a passed batch.
  await writeFile(path.join(root, 'source.txt'), 'initial\n');
  const statePath = path.join(runDirectory, 'state.json');
  const state = JSON.parse(await readFile(statePath, 'utf8'));
  state.checkpoints.taskBaselines[input.operationId].status = 'passed';
  await writeFile(statePath, JSON.stringify(state));
  await assert.rejects(executeTaskBaseline(root, input), code('EVIDENCE_TAMPERED'));
});

test('batch completion receipt rejects checkpoint outcome forgery, sidecar tampering and malformed schema', async t => {
  const { root, input } = await fixture(t, [command('unit', 'process.exit(7)')]);
  const batch = await executeTaskBaseline(root, input);
  assert.equal(batch.status, 'failed'); assert.equal(batch.currentFreshness, true);
  const runDirectory = path.join((await locateRepository(root)).runtimeRoot, 'runs/session-timeout', input.runId);
  const statePath = path.join(runDirectory, 'state.json');
  const originalState = await readFile(statePath, 'utf8');
  const state = JSON.parse(originalState);
  const record = state.checkpoints.taskBaselines[input.operationId];
  record.status = 'passed';
  await writeFile(statePath, JSON.stringify(state));
  await assert.rejects(executeTaskBaseline(root, input), code('EVIDENCE_TAMPERED'));
  await writeFile(statePath, originalState);
  const receiptPath = path.join(runDirectory, 'command-evidence', `${record.completion.id}.json`);
  const originalReceipt = await readFile(receiptPath, 'utf8');
  await chmod(receiptPath, 0o600);
  await writeFile(receiptPath, originalReceipt.replace('"status":"failed"', '"status":"passed"'));
  await assert.rejects(executeTaskBaseline(root, input), code('EVIDENCE_TAMPERED'));
  // Even a manually rehashed state cannot turn a malformed receipt into a valid schema.
  const malformed = JSON.parse(originalReceipt); malformed.formatVersion = 99;
  const malformedBytes = JSON.stringify(malformed) + '\n';
  await writeFile(receiptPath, malformedBytes);
  const rehashed = JSON.parse(originalState);
  const altered = rehashed.checkpoints.taskBaselines[input.operationId];
  altered.completion.digest = sha256(malformedBytes);
  rehashed.operations[altered.completionOperationId].inputHash = sha256(stableStringify({ expectedRevision: batch.run.revision - 1, input: { operationIds: altered.operationIds, requestDigest: altered.requestDigest, completion: altered.completion } }));
  await writeFile(statePath, JSON.stringify(rehashed));
  await assert.rejects(executeTaskBaseline(root, input), code('EVIDENCE_SCHEMA'));
});

test('execution environment filters owner and operation credentials, retains configured secret redaction', async t => {
  const cmd = command('unit', `process.stdout.write(JSON.stringify(process.env))`, { envAllowlist: ['PATH', 'API_TOKEN', 'WORKFLOW_OWNER_TOKEN', 'OPERATION_ID', 'CUSTOM_VALUE'] });
  const { root, input } = await fixture(t, [cmd]);
  const result = await executeRunCommand(root, input, { env: { PATH: process.env.PATH, API_TOKEN: 'sensitive-value', WORKFLOW_OWNER_TOKEN: input.owner, OPERATION_ID: input.operationId, CUSTOM_VALUE: input.owner } });
  const output = result.evidence.result!.stdout;
  assert(!output.includes(input.owner)); assert(!output.includes('WORKFLOW_OWNER_TOKEN')); assert(!output.includes('CUSTOM_VALUE')); assert(!output.includes('OPERATION_ID')); assert(!output.includes('sensitive-value')); assert(output.includes('[REDACTED]'));
  const json = JSON.stringify(result.evidence); assert(!json.includes(input.owner)); assert(!json.includes('sensitive-value'));
});

test('changed source during execution is rejected while its failed scene and output stay reloadable', async t => {
  const cmd = command('unit', `require('node:fs').writeFileSync('source.txt','changed'); console.log('ran')`);
  const { root, input } = await fixture(t, [cmd]); const result = await executeRunCommand(root, input);
  assert.equal(result.evidence.status, 'rejected'); assert.equal(result.evidence.rejection, 'COMMAND_INPUT_CHANGED');
  assert.equal(result.evidence.result?.exitCode, 0); assert.equal(result.run.phase, 'bootstrap');
  assert.notEqual(result.evidence.before.fingerprints.sourceFingerprint, result.evidence.after?.fingerprints.sourceFingerprint);
  assert.equal((await loadCommandEvidence(root, input.runId, input.operationId)).result?.stdout, 'ran\n');
});

test('index-only and HEAD-only changes invalidate command success', async t => {
  for (const kind of ['index', 'head']) {
    const script = kind === 'index' ? `require('node:child_process').execFileSync('git',['update-index','--chmod=+x','source.txt'])` : `require('node:child_process').execFileSync('git',['commit','--allow-empty','-qm','during-command'])`;
    const { root, input } = await fixture(t, [command('unit', script)]);
    const result = await executeRunCommand(root, input);
    assert.equal(result.evidence.status, 'rejected', kind); assert.equal(result.evidence.rejection, 'COMMAND_INPUT_CHANGED');
    assert.equal(result.evidence.before.fingerprints.sourceFingerprint, result.evidence.after?.fingerprints.sourceFingerprint);
  }
});

test('nonzero, no-tests, start failure and timeout are observations without Red acceptance', async t => {
  for (const cmd of [command('unit', `console.error('no tests found');process.exit(7)`), command('unit', '', { executable: 'workflow-nonexistent-binary' }), command('unit', `setInterval(()=>{},1000)`, { timeoutSeconds: 1 })]) {
    const { root, input } = await fixture(t, [cmd]); const result = await executeRunCommand(root, { ...input, step: 'red' });
    assert.equal(result.evidence.status, cmd.executable !== 'node' || cmd.timeoutSeconds === 1 ? 'rejected' : 'failed');
    assert.equal(result.run.phase, 'bootstrap'); assert.equal(result.run.workflow, undefined);
    assert.equal((await loadCommandEvidence(root, input.runId, input.operationId)).status, result.evidence.status);
  }
});

test('unplanned command/task/env and stale owner, revision or runtime fail before reserving evidence', async t => {
  const { root, input } = await fixture(t, [command('unit', '')]);
  await assert.rejects(executeRunCommand(root, { ...input, owner: 'wrong-owner' }), code('OWNER_CONFLICT'));
  await assert.rejects(executeRunCommand(root, { ...input, expectedRevision: 1 }), code('STATE_CONFLICT'));
  await assert.rejects(executeRunCommand(root, { ...input, runtime: { version: 'other', sha256: '0'.repeat(64) } }), code('RUNTIME_MISMATCH'));
  await assert.rejects(executeRunCommand(root, { ...input, taskId: 'TASK-999' }), code('COMMAND_TASK_NOT_FOUND'));
  await assert.rejects(executeRunCommand(root, { ...input, command: { ...input.command, args: ['-e', 'process.exit(0)'] } }), code('COMMAND_NOT_DECLARED'));
  await assert.rejects(executeRunCommand(root, input, { envAllowlist: ['UNDECLARED'] }), code('COMMAND_ENV_NOT_DECLARED'));
  assert.equal((await readRun(root, input.runId)).revision, 0);
});

test('sidecar changes and runtime mismatch are detected on load', async t => {
  const { root, input } = await fixture(t, [command('unit', `console.log('valid')`)]); const result = await executeRunCommand(root, input);
  await assert.rejects(loadCommandEvidence(root, input.runId, input.operationId, { runtime: { ...(await currentRuntimeIdentity()), version: 'wrong' } }), code('RUNTIME_MISMATCH'));
  const directory = path.join((await locateRepository(root)).runtimeRoot, 'runs/session-timeout', input.runId, 'command-evidence');
  const filename = path.join(directory, `${result.evidence.id}.json`); await chmod(filename, 0o600); await writeFile(filename, (await readFile(filename, 'utf8')).replace('valid', 'forged'));
  await assert.rejects(loadCommandEvidence(root, input.runId, input.operationId), code('EVIDENCE_TAMPERED'));
});

test('abrupt executor death leaves started operation; neither replay nor concurrent new command fabricates a result', async t => {
  const { root, input } = await fixture(t, [command('unit', `process.kill(process.ppid,'SIGKILL')`)]);
  const script = `import {executeRunCommand} from ${JSON.stringify(evidenceModule)}; await executeRunCommand(${JSON.stringify(root)},${JSON.stringify(input)});`;
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], { cwd: sourceRoot, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = ''; child.stderr.on('data', chunk => { stderr += String(chunk); });
  const exit = await new Promise<{code: number | null; signal: string | null}>(resolve => child.once('close', (code, signal) => resolve({ code, signal })));
  assert.equal(exit.signal, 'SIGKILL', stderr);
  const run = await readRun(root, input.runId); assert.equal(run.revision, 1);
  assert.equal((await loadCommandEvidence(root, input.runId, input.operationId)).status, 'started');
  await assert.rejects(executeRunCommand(root, { ...input, expectedRevision: 1 }), code('EVIDENCE_OPERATION_USED'));
  await assert.rejects(executeRunCommand(root, { ...input, expectedRevision: 1, operationId: 'new-observation' }), code('LOCKED'));
  const directory = path.join((await locateRepository(root)).runtimeRoot, 'runs/session-timeout', input.runId, 'command-evidence');
  assert.equal((await readdir(directory)).length, 1);
});

test('baseline observation reads Git and manifests without modifying run state', async t => {
  const { root, input } = await fixture(t, [command('unit', '')]); const first = await observeCommandBaseline(root);
  await writeFile(path.join(root, 'source.txt'), 'different'); const second = await observeCommandBaseline(root);
  assert.notEqual(first.fingerprints.sourceFingerprint, second.fingerprints.sourceFingerprint); assert.equal(first.head, second.head);
  assert.equal((await readRun(root, input.runId)).revision, 0);
});

test('live command lock prevents concurrent execution; a concurrent state mutation cannot adopt success', async t => {
  const { root, input } = await fixture(t, [command('unit', `setTimeout(()=>console.log('finished'),1500)`)]);
  const running = executeRunCommand(root, input);
  let run = await readRun(root, input.runId);
  for (let attempt = 0; run.revision === 0 && attempt < 200; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 10)); run = await readRun(root, input.runId);
  }
  assert.equal(run.revision, 1);
  await assert.rejects(executeRunCommand(root, { ...input, operationId: 'concurrent', expectedRevision: 1 }), code('LOCKED'));
  await mutateRun(root, input.runId, { owner: input.owner, expectedRevision: 1, operationId: 'external-mutation', input: {} }, draft => { draft.status = 'suspended'; });
  await assert.rejects(running, code('STATE_CONFLICT'));
  assert.equal((await loadCommandEvidence(root, input.runId, input.operationId)).status, 'started');
  const directory = path.join((await locateRepository(root)).runtimeRoot, 'runs/session-timeout', input.runId, 'command-evidence');
  const records = await Promise.all((await readdir(directory)).map(async name => JSON.parse(await readFile(path.join(directory, name), 'utf8'))));
  const rejected = records.find(value => value.status === 'rejected');
  assert.equal(rejected.rejection, 'STATE_CONFLICT'); assert.equal(rejected.result.stdout, 'finished\n');
});
