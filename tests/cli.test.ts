import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, writeFile, cp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArguments } from '../src/cli/args.js';
import { parse, stringify } from 'yaml';

const exec = promisify(execFile);
const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const executable = path.join(sourceRoot, 'dist/workflow.js');
async function cli(project: string, args: string[], entry = executable) {
  try {
    const { stdout, stderr } = await exec(process.execPath, [entry, ...args, '--project', project, '--json'], { maxBuffer: 4 * 1024 * 1024 });
    return { code: 0, envelope: JSON.parse(stdout), stderr };
  } catch (error) {
    const e = error as Error & { code: number; stdout: string; stderr: string };
    assert.equal(typeof e.code, 'number', e.message);
    return { code: e.code, envelope: JSON.parse(e.stdout), stderr: e.stderr };
  }
}
async function git(root: string, args: string[]) {
  return (await exec('git', ['-C', root, ...args])).stdout.trim();
}
async function commit(root: string, message: string) {
  await git(root, ['add', '.']);
  await git(root, ['-c', 'user.name=Workflow Test', '-c', 'user.email=workflow@example.invalid', 'commit', '-m', message]);
}
async function repository(t: { after: (fn: () => Promise<void>) => void }) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'workflow CLI 中文 '));
  t.after(() => rm(root, { recursive: true, force: true }));
  await git(root, ['init', '-b', 'main']);
  await writeFile(path.join(root, 'README.md'), '# Fixture\n');
  await commit(root, 'baseline');
  return root;
}

test('argument parser rejects unknown/repeated flags and missing values', () => {
  assert.throws(() => parseArguments(['validate', 'demo', '--gate']), /requires a value/);
  assert.throws(() => parseArguments(['--json', '--json']), /Repeated/);
  assert.throws(() => parseArguments(['--unknown']), /Unknown/);
  assert.throws(() => parseArguments(['--apply=false']), /takes no value/);
});

test('CLI installs fixed runtime, preserves files, validates and projects example; host remains unverified', async t => {
  const root = await repository(t);
  await writeFile(path.join(root, 'AGENTS.md'), 'User-owned instructions\n');
  const dry = await cli(root, ['init', '--hosts', 'codex,claude', '--dry-run']);
  assert.equal(dry.code, 0, JSON.stringify(dry.envelope));
  assert.equal(dry.envelope.data.applicable, true);
  const install = await cli(root, ['init', '--hosts', 'codex,claude', '--operation-id', 'install-one']);
  assert.equal(install.code, 0, JSON.stringify(install.envelope));
  assert.equal(install.envelope.data.executionReady, false);
  const installReplay = await cli(root, ['init', '--hosts', 'codex,claude', '--operation-id', 'install-one']);
  assert.equal(installReplay.code, 0, JSON.stringify(installReplay.envelope));
  assert.match(await readFile(path.join(root, 'AGENTS.md'), 'utf8'), /^User-owned instructions/);
  const diagnostic = await cli(root, ['doctor']);
  assert.equal(diagnostic.code, 5);
  assert.equal(diagnostic.envelope.data.installed, true);
  assert.equal(diagnostic.envelope.data.executionReady, false);
  assert.equal((await cli(root, ['change', 'new', 'demo', '--operation-id', 'create-on-base'])).code, 3);
  await git(root, ['checkout', '-b', 'codex/demo']);
  const created = await cli(root, ['change', 'new', 'demo', '--operation-id', 'create-demo']);
  assert.equal(created.code, 0, JSON.stringify(created.envelope));
  const createdTasks = await readFile(path.join(root, '.workflow/changes/demo/tasks.md'), 'utf8');
  assert.match(createdTasks, /## \[ \] TASK-001/);
  assert.match(createdTasks, /Test-Mode:/);
  assert.match(createdTasks, /完成并有相应证据后勾选/);
  const createdProposal = await readFile(path.join(root, '.workflow/changes/demo/proposal.md'), 'utf8');
  const createdDesign = await readFile(path.join(root, '.workflow/changes/demo/design.md'), 'utf8');
  assert.match(createdProposal, /结合仓库证据描述当前问题/);
  assert.match(createdProposal, /零 delta 的理由/);
  assert.match(createdDesign, /备选方案及取舍理由/);
  assert.match(createdDesign, /CI/);
  assert.equal((await cli(root, ['validate', 'demo', '--gate', 'draft'])).code, 0);
  assert.notEqual((await cli(root, ['validate', 'demo', '--gate', 'spec'])).code, 0, 'Untouched template placeholders must not pass the spec gate');
  const replay = await cli(root, ['change', 'new', 'demo', '--operation-id', 'create-demo']);
  assert.equal(replay.code, 0, JSON.stringify(replay.envelope));
  assert.equal(replay.envelope.data.transactionId, created.envelope.data.transactionId);
  assert.equal((await cli(root, ['validate', 'demo'])).code, 2);
  await rm(path.join(root, '.workflow/changes/demo'), { recursive: true });
  await cp(path.join(sourceRoot, 'examples/change'), path.join(root, '.workflow/changes/session-timeout'), { recursive: true });
  await cp(path.join(sourceRoot, 'examples/config/minimal.yaml'), path.join(root, '.workflow/config.yaml'));
  await cp(path.join(sourceRoot, 'examples/rules.md'), path.join(root, '.workflow/rules.md'));
  const validation = await cli(root, ['validate', 'session-timeout']);
  assert.equal(validation.code, 0, JSON.stringify(validation.envelope));
  const sync = await cli(root, ['sync', 'session-timeout']);
  assert.equal(sync.code, 0, JSON.stringify(sync.envelope));
  assert.equal(sync.envelope.data.writes.length, 1);
  assert.equal(sync.envelope.data.writes[0].content, await readFile(path.join(sourceRoot, 'examples/expected/specs/session/spec.md'), 'utf8'));
  assert.equal((await cli(root, ['validate', 'session-timeout', '--gate', 'integration'])).code, 3);
  const archived = await cli(root, ['archive', 'session-timeout', '--run', 'fabricated']);
  assert.equal(archived.code, 5);
  assert.equal(archived.envelope.ok, false);
  const runtime = path.join(root, '.workflow/runtime/workflow.js');
  await commit(root, 'installed example');
  await writeFile(path.join(root, '.git/info/exclude'), 'local-only-source.ts\n');
  await writeFile(path.join(root, 'local-only-source.ts'), 'unrelated user work\n');
  const hidden = await cli(root, ['run', 'init', 'session-timeout', '--operation-id', 'reject-local-ignore'], runtime);
  assert.equal(hidden.code, 3, JSON.stringify(hidden.envelope));
  assert.equal(hidden.envelope.diagnostics[0].code, 'RUN_UNTRACKED_INPUT');
  await rm(path.join(root, 'local-only-source.ts'));
  const run = await cli(root, ['run', 'init', 'session-timeout', '--operation-id', 'run-one'], runtime);
  assert.equal(run.code, 0, JSON.stringify(run.envelope));
  assert.equal(run.envelope.data.executionReady, false);
  const runReplay = await cli(root, ['run', 'init', 'session-timeout', '--operation-id', 'run-one'], runtime);
  assert.equal(runReplay.code, 0, JSON.stringify(runReplay.envelope));
  assert.equal(runReplay.envelope.data.runId, run.envelope.data.runId);
  const status = await cli(root, ['status', 'session-timeout', '--run', run.envelope.data.runId], runtime);
  assert.equal(status.code, 0, JSON.stringify(status.envelope));
  assert.equal(status.envelope.data.runs.length, 1);
  assert.equal('owner' in status.envelope.data.runs[0], false);
  const before = await readFile(path.join(root, '.git/workflow/runs/session-timeout', run.envelope.data.runId, 'state.json'), 'utf8');
  const resume = await cli(root, ['resume-plan', 'session-timeout', '--run', run.envelope.data.runId], runtime);
  assert.equal(resume.code, 0, JSON.stringify(resume.envelope));
  assert.equal(await readFile(path.join(root, '.git/workflow/runs/session-timeout', run.envelope.data.runId, 'state.json'), 'utf8'), before);
});

test('remote default base protects local main while allowing a distinct branch at the same HEAD', async t => {
  const root = await repository(t);
  await git(root, ['remote', 'add', 'origin', root]);
  await git(root, ['update-ref', 'refs/remotes/origin/main', 'HEAD']);
  await git(root, ['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main']);
  const install = await cli(root, ['init', '--operation-id', 'remote-install']);
  assert.equal(install.code, 0, JSON.stringify(install.envelope));
  const denied = await cli(root, ['change', 'new', 'remote-demo', '--operation-id', 'main-denied']);
  assert.equal(denied.code, 3, JSON.stringify(denied.envelope));
  await git(root, ['checkout', '-b', 'codex/remote-demo']);
  const allowed = await cli(root, ['change', 'new', 'remote-demo', '--operation-id', 'branch-allowed']);
  assert.equal(allowed.code, 0, JSON.stringify(allowed.envelope));
});

test('change new follows the installed Chinese or English template language', async t => {
  const root = await repository(t);
  assert.equal((await cli(root, ['init', '--language', 'en', '--operation-id', 'language-install'])).code, 0);
  await git(root, ['checkout', '-b', 'codex/english-change']);
  const created = await cli(root, ['change', 'new', 'english-change', '--operation-id', 'english-change-create']);
  assert.equal(created.code, 0, JSON.stringify(created.envelope));
  const tasks = await readFile(path.join(root, '.workflow/changes/english-change/tasks.md'), 'utf8');
  const proposal = await readFile(path.join(root, '.workflow/changes/english-change/proposal.md'), 'utf8');
  const design = await readFile(path.join(root, '.workflow/changes/english-change/design.md'), 'utf8');
  assert.match(tasks, /Check a task only after it is complete and supported by evidence/);
  assert.match(tasks, /Alternative-Acceptance/);
  assert.match(tasks, /## \[ \] TASK-001 —/);
  assert.match(proposal, /Describe the observed problem/);
  assert.match(proposal, /zero behavior delta/i);
  assert.match(design, /alternatives considered with the reasons for the trade-offs/);
  assert.match(design, /CI job or workflow/);
  assert.equal((await cli(root, ['validate', 'english-change', '--gate', 'draft'])).code, 0);
  assert.notEqual((await cli(root, ['validate', 'english-change', '--gate', 'spec'])).code, 0, 'An English scaffold must remain a draft until real requirements and commands are supplied');
});

test('CLI persists real baseline evidence across processes and prepares a non-executable native task packet', async t => {
  const root = await repository(t);
  assert.equal((await cli(root, ['init', '--operation-id', 'evidence-install'])).code, 0);
  await git(root, ['checkout', '-b', 'codex/evidence']);
  await cp(path.join(sourceRoot, 'examples/change'), path.join(root, '.workflow/changes/session-timeout'), { recursive: true });
  const config = parse(await readFile(path.join(sourceRoot, 'examples/config/minimal.yaml'), 'utf8'));
  config.validation.commands = [{ id: 'app-session-test', executable: 'node', args: ['-e', 'process.stdout.write("baseline passed")'], cwd: '.', timeoutSeconds: 10, modules: ['app'], artifacts: [], envAllowlist: ['PATH'] }];
  await writeFile(path.join(root, '.workflow/config.yaml'), stringify(config));
  await cp(path.join(sourceRoot, 'examples/rules.md'), path.join(root, '.workflow/rules.md'));
  await commit(root, 'evidence fixture');
  const started = await cli(root, ['run', 'init', 'session-timeout', '--operation-id', 'evidence-run']);
  assert.equal(started.code, 0, JSON.stringify(started.envelope));
  const run = started.envelope.data;
  const credentials = ['--run', run.runId, '--owner', run.owner, '--expected-revision', '0', '--operation-id', 'baseline-one'];
  const baseline = await cli(root, ['test-cycle', 'baseline', 'session-timeout', '--task', 'TASK-001', ...credentials]);
  assert.equal(baseline.code, 0, JSON.stringify(baseline.envelope));
  assert.equal(baseline.envelope.data.status, 'passed');
  assert.equal(baseline.envelope.data.phaseAdvanced, false);
  assert.equal(baseline.envelope.data.evidence.length, 1);
  assert.equal(baseline.envelope.data.evidence[0].exitCode, 0);
  assert.equal('stdout' in baseline.envelope.data.evidence[0], false);
  const loaded = await cli(root, ['evidence', 'show', 'session-timeout', '--run', run.runId, '--operation-id', baseline.envelope.data.operationIds[0]]);
  assert.equal(loaded.code, 0, JSON.stringify(loaded.envelope));
  assert.equal(loaded.envelope.data.id, baseline.envelope.data.evidence[0].id);
  const replay = await cli(root, ['test-cycle', 'baseline', 'session-timeout', '--task', 'TASK-001', ...credentials]);
  assert.equal(replay.code, 0, JSON.stringify(replay.envelope));
  assert.equal(replay.envelope.data.evidence[0].id, baseline.envelope.data.evidence[0].id);
  const prepared = await cli(root, ['dispatch', 'prepare', 'session-timeout', '--task', 'TASK-001', '--role', 'reviewer', '--run', run.runId, '--owner', run.owner, '--expected-revision', String(baseline.envelope.data.revision), '--operation-id', 'prepare-review']);
  assert.equal(prepared.code, 0, JSON.stringify(prepared.envelope));
  assert.equal(prepared.envelope.data.packet.status, 'planned');
  assert.deepEqual(prepared.envelope.data.packet.allowedPaths, []);
  assert.equal(prepared.envelope.data.executionReady, false);
  const attached = await cli(root, ['dispatch', 'attach', 'session-timeout', '--run', run.runId, '--dispatch', prepared.envelope.data.packet.id, '--attempt', prepared.envelope.data.packet.attemptId, '--agent-id', 'self-reported']);
  assert.equal(attached.code, 5);
});

test('packed package installs into fresh clone and runs without node_modules or source paths', async t => {
  const base = await repository(t);
  const scratch = await mkdtemp(path.join(os.tmpdir(), 'workflow package '));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const packed = JSON.parse((await exec('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', scratch], { cwd: sourceRoot })).stdout);
  const tarball = path.join(scratch, (Array.isArray(packed) ? packed[0] : Object.values(packed)[0] as { filename: string }).filename);
  await exec('tar', ['-xzf', tarball, '-C', scratch]);
  const packageEntry = path.join(scratch, 'package/bin/workflow.js');
  assert.equal((await cli(base, ['init', '--operation-id', 'package-install'], packageEntry)).code, 0);
  await commit(base, 'packaged runtime');
  const clone = path.join(scratch, 'clone');
  await exec('git', ['clone', '--no-hardlinks', base, clone]);
  const installedEntry = path.join(clone, '.workflow/runtime/workflow.js');
  const version = await cli(clone, ['--version'], installedEntry);
  assert.equal(version.code, 0, JSON.stringify(version.envelope));
  assert.match(version.envelope.data.version, /^0\.1\.0-preview\./);
  const doctor = await cli(clone, ['doctor'], installedEntry);
  assert.equal(doctor.code, 5);
  assert.equal(doctor.envelope.data.installed, true, JSON.stringify(doctor.envelope));
  await git(clone, ['checkout', '-b', 'codex/packed-template']);
  const packedChange = await cli(clone, ['change', 'new', 'packed-demo', '--operation-id', 'packed-template-create'], installedEntry);
  assert.equal(packedChange.code, 0, JSON.stringify(packedChange.envelope));
  assert.match(await readFile(path.join(clone, '.workflow/changes/packed-demo/design.md'), 'utf8'), /回滚步骤及其限制/);
  assert.match(await readFile(path.join(clone, '.workflow/changes/packed-demo/tasks.md'), 'utf8'), /Test-Rationale/);
  assert.equal((await cli(clone, ['validate', 'packed-demo', '--gate', 'draft'], installedEntry)).code, 0);
  const uninstall = await cli(clone, ['uninstall'], installedEntry);
  assert.equal(uninstall.code, 0, JSON.stringify(uninstall.envelope));
  const apply = await cli(clone, ['uninstall', '--apply', '--plan-digest', uninstall.envelope.data.planDigest, '--operation-id', 'remove-package'], installedEntry);
  assert.equal(apply.code, 0, JSON.stringify(apply.envelope));
  const removedReplay = await cli(clone, ['uninstall', '--apply', '--plan-digest', uninstall.envelope.data.planDigest, '--operation-id', 'remove-package'], packageEntry);
  assert.equal(removedReplay.code, 0, JSON.stringify(removedReplay.envelope));
  assert.match(await readFile(path.join(clone, '.workflow/config.yaml'), 'utf8'), /formatVersion: 1/);
  assert.match(await readFile(path.join(clone, '.workflow/rules.md'), 'utf8'), /项目规则/);
});

test('CLI prepares Architect without tasks and exposes task-bound non-TDD roles', async t => {
  const root = await repository(t);
  assert.equal((await cli(root, ['init', '--operation-id', 'dispatch-modes-install'])).code, 0);
  await git(root, ['checkout', '-b', 'codex/dispatch-modes']);
  await cp(path.join(sourceRoot, 'examples/change'), path.join(root, '.workflow/changes/session-timeout'), { recursive: true });
  await cp(path.join(sourceRoot, 'examples/config/minimal.yaml'), path.join(root, '.workflow/config.yaml'));
  await cp(path.join(sourceRoot, 'examples/rules.md'), path.join(root, '.workflow/rules.md'));
  const tasksPath = path.join(root, '.workflow/changes/session-timeout/tasks.md');
  const tasks = await readFile(tasksPath, 'utf8');
  await rm(tasksPath);
  await rm(path.join(root, '.workflow/changes/session-timeout/design.md'));
  await commit(root, 'draft fixture');
  const started = await cli(root, ['run', 'init', 'session-timeout', '--operation-id', 'draft-run']);
  assert.equal(started.code, 0, JSON.stringify(started.envelope));
  const run = started.envelope.data;
  const credentials = ['--run', run.runId, '--owner', run.owner, '--expected-revision', '0'];
  const missing = await cli(root, ['dispatch', 'prepare', 'session-timeout', '--role', 'developer-verification', ...credentials, '--operation-id', 'missing-task']);
  assert.equal(missing.envelope.diagnostics[0].code, 'DISPATCH_TASK_ID');
  const architect = await cli(root, ['dispatch', 'prepare', 'session-timeout', '--role', 'architect', ...credentials, '--operation-id', 'draft-architect']);
  assert.equal(architect.code, 0, JSON.stringify(architect.envelope));
  assert.equal(architect.envelope.data.packet.scope, 'change');
  assert.equal('taskId' in architect.envelope.data.packet, false);
  assert.equal(architect.envelope.data.executionReady, false);
  // A separate change exercises task mode parsing without pretending the Architect ran.
  await mkdir(path.join(root, '.workflow/changes/verification-demo'), { recursive: true });
  await cp(path.join(sourceRoot, 'examples/change'), path.join(root, '.workflow/changes/verification-demo'), { recursive: true });
  const metadataPath = path.join(root, '.workflow/changes/verification-demo/change.yaml');
  await writeFile(metadataPath, (await readFile(metadataPath, 'utf8')).replace('id: session-timeout', 'id: verification-demo'));
  await writeFile(path.join(root, '.workflow/changes/verification-demo/tasks.md'), tasks);
  await commit(root, 'verification fixture');
  const verificationRun = await cli(root, ['run', 'init', 'verification-demo', '--operation-id', 'verification-run']);
  assert.equal(verificationRun.code, 0, JSON.stringify(verificationRun.envelope));
  const v = verificationRun.envelope.data;
  const prepared = await cli(root, ['dispatch', 'prepare', 'verification-demo', '--task', 'TASK-002', '--role', 'developer-verification', '--run', v.runId, '--owner', v.owner, '--expected-revision', '0', '--operation-id', 'verification-packet']);
  assert.equal(prepared.code, 0, JSON.stringify(prepared.envelope));
  assert.equal(prepared.envelope.data.packet.testMode, 'verification');
  assert.equal(prepared.envelope.data.packet.cycleId, undefined);
  const beforeAudit = await cli(root, ['status', 'verification-demo', '--run', v.runId]);
  const audited = await cli(root, ['dispatch', 'audit', 'verification-demo', '--run', v.runId, '--dispatch', prepared.envelope.data.packet.id, '--attempt', prepared.envelope.data.packet.attemptId]);
  assert.equal(audited.code, 3, JSON.stringify(audited.envelope));
  assert.equal(audited.envelope.data.readonly, true);
  assert.equal(audited.envelope.data.acceptedOutput, false);
  assert(audited.envelope.diagnostics.some((d: { code: string }) => d.code === 'OUTPUT_ATTEMPT_NOT_ATTACHED'));
  assert.deepEqual((await cli(root, ['status', 'verification-demo', '--run', v.runId])).envelope, beforeAudit.envelope);
});
