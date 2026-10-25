import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, mkdir, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { planInit, initProject, planUpgrade, planUninstall, applyInstallPlan, doctor, replayInstallOperation, uninstallProject } from '../src/installer/index.js';
import { CAPABILITIES } from '../src/hosts/index.js';
import { loadConfig } from '../src/project/index.js';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'workflow-install-'));
  execFileSync('git', ['init', '-b', 'trunk', root], { stdio: 'pipe' });
  execFileSync('git', ['-C', root, 'config', 'user.email', 'fixture@example.invalid']);
  execFileSync('git', ['-C', root, 'config', 'user.name', 'Fixture']);
  await writeFile(join(root, 'README.md'), '# Fixture\n');
  execFileSync('git', ['-C', root, 'add', '.']);
  execFileSync('git', ['-C', root, 'commit', '-m', 'fixture'], { stdio: 'pipe' });
  await writeFile(join(root, 'THIRD_PARTY_LICENSES.txt'), 'Fixture license\n');
  const runtimePath = join(root, 'runtime-fixture.js'); await writeFile(runtimePath, '#!/usr/bin/env node\nconsole.log("fixture");\n');
  return { root, runtimePath, dispose: () => rm(root, { recursive: true, force: true }) };
}
async function install(root: string, runtimePath: string, id = 'init-one') { return initProject(root, { runtimePath, hosts: ['codex', 'claude'], operationId: id }); }

test('init plans first, installs exact runtime and verified bases, keeps host execution unverified', async () => {
  const f = await fixture(); try {
    await writeFile(join(f.root, 'AGENTS.md'), '# User instructions\n');
    const plan = await planInit(f.root, { runtimePath: f.runtimePath });
    assert.equal(plan.applicable, true);
    await assert.rejects(readFile(join(f.root, '.workflow/install.json')));
    await install(f.root, f.runtimePath);
    assert.deepEqual(await readFile(join(f.root, '.workflow/runtime/workflow.js')), await readFile(f.runtimePath));
    assert.match(await readFile(join(f.root, '.workflow/config.yaml'), 'utf8'), /baseBranch: trunk/);
    const agents = await readFile(join(f.root, 'AGENTS.md'), 'utf8'); assert.ok(agents.startsWith('# User instructions\n'));
    const status = await doctor(f.root); assert.equal(status.installed, true); assert.equal(status.executionReady, false); assert.equal(status.exitCode, 5);
    const again = await planInit(f.root, { runtimePath: f.runtimePath }); assert.equal(again.applicable, true); assert.equal(again.changes.every(c => ['unchanged', 'preserved'].includes(c.status)), true);
  } finally { await f.dispose(); }
});
test('a generated draft config keeps a project-rooted module so artifacts are only accepted once real scopes are declared', async () => {
  const f = await fixture(); try {
    await install(f.root, f.runtimePath, 'artifact-draft');
    const draft = await readFile(join(f.root, '.workflow/config.yaml'), 'utf8');
    // The draft module is project-rooted: it cannot be proven disjoint from a build
    // artifact, so an artifacts declaration must fail closed rather than guess.
    assert.match(draft, /paths:\s*\n\s*- "\*\*"/);
    await mkdir(join(f.root, 'dist'), { recursive: true });
    await writeFile(join(f.root, 'dist', 'bundle.js'), 'build output\n');
    const rootOnly = draft.replace('commands: []', "commands:\n    - id: build\n      executable: node\n      args: ['-e', '1']\n      cwd: .\n      timeoutSeconds: 10\n      modules: ['*']\n      artifacts: ['dist/**']");
    await writeFile(join(f.root, '.workflow/config.yaml'), rootOnly);
    await assert.rejects(loadConfig(f.root), { code: 'CONFIG_ARTIFACT_SOURCE_OVERLAP' });
    // Once the project declares real directories, the same artifacts are accepted.
    await writeFile(join(f.root, '.workflow/config.yaml'), rootOnly.replace('      - "**"', '      - "src/**"\n      - "README.md"'));
    const config = await loadConfig(f.root);
    assert.deepEqual(config.modules.map(m => m.paths), [['src/**', 'README.md']]);
    assert.deepEqual(config.validation.commands.map(c => c.artifacts), [['dist/**']]);
  } finally { await f.dispose(); }
});

test('doctor consumes fresh host evidence without claiming the preview lifecycle is ready', async () => {
  const f = await fixture(); try {
    await install(f.root, f.runtimePath);
    const capabilities = Object.fromEntries(CAPABILITIES.map(name => [name, { status: 'supported', basis: `Verified ${name} in the pinned host session.`, references: [`probe-${name}`] }]));
    const hosts = ['codex', 'claude'].map(id => ({ id, clientVersion: `${id} 1.2.3`, verifiedAt: new Date().toISOString(), nativeDispatch: `${id} native subagent tool observed`, identityAndResult: 'Observed native ID and completion result', capabilities }));
    await writeFile(join(f.root, '.workflow/host-evidence.json'), JSON.stringify({ formatVersion: 1, hosts }));
    const status = await doctor(f.root);
    assert.equal(status.installed, true);
    assert.equal(status.hostExecutionReady, true);
    assert.equal(status.workflowLifecycleReady, false);
    assert.equal(status.executionReady, false);
    assert.equal(status.exitCode, 5);
    assert.equal(status.hosts.every(host => host.executionReady && host.roleIsolationVerified), true);
  } finally { await f.dispose(); }
});
test('unregistered existing files conflict even when bytes equal; user config is never adopted', async () => {
  const f = await fixture(); try {
    await mkdir(join(f.root, '.workflow/managed'), { recursive: true }); await writeFile(join(f.root, '.workflow/managed/protocol.md'), 'user');
    await writeFile(join(f.root, '.workflow/config.yaml'), '# user config');
    const plan = await planInit(f.root, { runtimePath: f.runtimePath }); assert.equal(plan.applicable, false);
    assert.equal(plan.changes.find(c => c.path === '.workflow/managed/protocol.md')?.status, 'conflict');
    await assert.rejects(install(f.root, f.runtimePath), { code: 'INSTALL_CONFLICT' });
    assert.equal(await readFile(join(f.root, '.workflow/config.yaml'), 'utf8'), '# user config');
  } finally { await f.dispose(); }
});
test('upgrade compares old base, current bytes and new bytes and does not overwrite edits', async () => {
  const f = await fixture(); try {
    await install(f.root, f.runtimePath);
    await writeFile(join(f.root, '.workflow/managed/protocol.md'), 'user edited');
    await writeFile(f.runtimePath, 'console.log("new runtime")');
    const plan = await planUpgrade(f.root, { runtimePath: f.runtimePath }); assert.equal(plan.applicable, false);
    assert.equal(plan.changes.find(c => c.path === '.workflow/managed/protocol.md')?.status, 'conflict');
    await assert.rejects(applyInstallPlan(f.root, plan, { operationId: 'upgrade', planDigest: plan.digest }), { code: 'INSTALL_CONFLICT' });
    assert.equal(await readFile(join(f.root, '.workflow/managed/protocol.md'), 'utf8'), 'user edited');
  } finally { await f.dispose(); }
});
test('fresh checkout verifies decoded base bytes and rejects corrupt cache', async () => {
  const f = await fixture(); const clone = await mkdtemp(join(tmpdir(), 'workflow-clone-')); try {
    await install(f.root, f.runtimePath);
    execFileSync('git', ['-C', f.root, 'add', '.']); execFileSync('git', ['-C', f.root, 'commit', '-m', 'install'], { stdio: 'pipe' });
    execFileSync('git', ['clone', '--no-local', f.root, clone], { stdio: 'pipe' });
    assert.equal((await doctor(clone)).installed, true);
    const manifest = JSON.parse(await readFile(join(clone, '.workflow/install.json'), 'utf8'));
    const cache = join(clone, '.workflow/managed-bases/sha256', `${manifest.managedPaths[0].baseContentHash}.json`);
    const base = JSON.parse(await readFile(cache, 'utf8')); await writeFile(cache, JSON.stringify(base, null, 2).replace(/\n/g, '\r\n'));
    assert.equal((await doctor(clone)).installed, true);
    base.content = Buffer.from('corrupt').toString('base64'); await writeFile(cache, JSON.stringify(base));
    await assert.rejects(planUpgrade(clone, { runtimePath: f.runtimePath }), { code: 'MANAGED_BASE_CORRUPT' });
    assert.equal((await doctor(clone)).installed, false);
  } finally { await f.dispose(); await rm(clone, { recursive: true, force: true }); }
});
test('uninstall removes only unmodified managed content and preserves user data and AGENTS text', async () => {
  const f = await fixture(); try {
    await writeFile(join(f.root, 'AGENTS.md'), '# User\n'); await install(f.root, f.runtimePath);
    await writeFile(join(f.root, '.workflow/managed/roles/developer.md'), 'custom role');
    await mkdir(join(f.root, '.workflow/specs'), { recursive: true }); await writeFile(join(f.root, '.workflow/specs/user.md'), 'user spec');
    const plan = await planUninstall(f.root); await applyInstallPlan(f.root, plan, { operationId: 'uninstall', planDigest: plan.digest });
    assert.equal(await readFile(join(f.root, 'AGENTS.md'), 'utf8'), '# User\n');
    assert.equal(await readFile(join(f.root, '.workflow/managed/roles/developer.md'), 'utf8'), 'custom role');
    assert.equal(await readFile(join(f.root, '.workflow/specs/user.md'), 'utf8'), 'user spec');
    assert.match(await readFile(join(f.root, '.workflow/config.yaml'), 'utf8'), /baseBranch: trunk/);
    await assert.rejects(readFile(join(f.root, '.workflow/runtime/workflow.js')));
  } finally { await f.dispose(); }
});
test('unsupported hosts, changed inputs, symlink paths and empty Git repository fail closed', async () => {
  const f = await fixture(); try {
    await assert.rejects(planInit(f.root, { runtimePath: f.runtimePath, hosts: ['pi'] }), { code: 'UNSUPPORTED_HOST' });
    const plan = await planInit(f.root, { runtimePath: f.runtimePath });
    await writeFile(join(f.root, 'AGENTS.md'), 'new user instructions');
    await assert.rejects(applyInstallPlan(f.root, plan, { operationId: 'stale', planDigest: plan.digest }), { code: 'INSTALL_INPUT_CHANGED' });
    const linkRoot = join(f.root, 'linked'); await mkdir(linkRoot); await symlink(linkRoot, join(f.root, '.workflow'));
    await assert.rejects(planInit(f.root, { runtimePath: f.runtimePath }), { code: 'SYMLINK_INSTALL_PATH' });
    await rm(join(f.root, '.workflow'));
    const empty = join(f.root, 'empty'); await mkdir(empty); execFileSync('git', ['init', empty], { stdio: 'pipe' });
    await assert.rejects(initProject(empty, { runtimePath: f.runtimePath, operationId: 'empty' }), { code: 'INSTALL_CONFLICT' });
  } finally { await f.dispose(); }
});
test('stable plans bind digest, replay operation ids and block active runs', async () => {
  const f = await fixture(); try {
    const a = await planInit(f.root, { runtimePath: f.runtimePath });
    const b = await planInit(f.root, { runtimePath: f.runtimePath });
    assert.equal(a.digest, b.digest); assert.equal(a.planId, b.planId);
    await assert.rejects(applyInstallPlan(f.root, a, { operationId: 'install-replay', planDigest: 'bad' }), { code: 'INSTALL_PLAN_CHANGED' });
    await applyInstallPlan(f.root, a, { operationId: 'install-replay', planDigest: a.digest });
    const replay = await applyInstallPlan(f.root, a, { operationId: 'install-replay', planDigest: a.digest }); assert.equal(replay.replayed, true);
    const plan = await planUninstall(f.root);
    await assert.rejects(applyInstallPlan(f.root, plan, { operationId: 'install-replay', planDigest: plan.digest }), { code: 'OPERATION_ID_CONFLICT' });
    const stateDir = join(f.root, '.git/workflow/runs/change/run'); await mkdir(stateDir, { recursive: true }); await writeFile(join(stateDir, 'state.json'), JSON.stringify({ status: 'running' }));
    await assert.rejects(applyInstallPlan(f.root, plan, { operationId: 'uninstall-active', planDigest: plan.digest }), { code: 'ACTIVE_RUN' });
  } finally { await f.dispose(); }
});
test('upgrade replaces clean assets atomically and retains AGENTS edits outside the managed block', async () => {
  const f = await fixture(); try {
    await install(f.root, f.runtimePath);
    await writeFile(join(f.root, 'AGENTS.md'), '# Extra user guidance\n' + await readFile(join(f.root, 'AGENTS.md'), 'utf8'));
    await writeFile(f.runtimePath, 'console.log("runtime next");\n');
    const a = await planUpgrade(f.root, { runtimePath: f.runtimePath }); const b = await planUpgrade(f.root, { runtimePath: f.runtimePath });
    assert.equal(a.digest, b.digest); assert.equal(a.applicable, true);
    await applyInstallPlan(f.root, a, { operationId: 'upgrade-clean', planDigest: a.digest });
    assert.deepEqual(await readFile(join(f.root, '.workflow/runtime/workflow.js')), await readFile(f.runtimePath));
    assert.ok((await readFile(join(f.root, 'AGENTS.md'), 'utf8')).startsWith('# Extra user guidance\n'));
    assert.equal((await doctor(f.root)).installed, true);
  } finally { await f.dispose(); }
});
test('entry retries reuse original request before replanning and reject changed requests and outputs', async () => {
  const f = await fixture(); try {
    const first = await initProject(f.root, { runtimePath: f.runtimePath, operationId: 'entry-init', hosts: ['codex'] });
    const second = await initProject(f.root, { runtimePath: f.runtimePath, operationId: 'entry-init', hosts: ['codex'] });
    assert.ok('transactionId' in first && 'transactionId' in second); assert.equal(first.transactionId, second.transactionId); assert.ok('replayed' in second && second.replayed);
    await assert.rejects(initProject(f.root, { runtimePath: f.runtimePath, operationId: 'entry-init', hosts: ['claude'] }), { code: 'OPERATION_ID_CONFLICT' });
    await writeFile(f.runtimePath, 'console.log("new version");\n');
    await assert.rejects(initProject(f.root, { runtimePath: f.runtimePath, operationId: 'entry-init', hosts: ['codex'] }), { code: 'OPERATION_ID_CONFLICT' });
    const upgrade = await planUpgrade(f.root, { runtimePath: f.runtimePath });
    await applyInstallPlan(f.root, upgrade, { operationId: 'entry-upgrade', planDigest: upgrade.digest });
    const replay = await replayInstallOperation(f.root, 'entry-upgrade', { operation: 'upgrade', runtimePath: f.runtimePath, planDigest: upgrade.digest }); assert.equal(replay?.replayed, true);
    const uninstall = await planUninstall(f.root);
    await uninstallProject(f.root, { dryRun: false, operationId: 'entry-uninstall', planDigest: uninstall.digest });
    const removedReplay = await uninstallProject(f.root, { dryRun: false, operationId: 'entry-uninstall', planDigest: uninstall.digest });
    assert.ok('replayed' in removedReplay && removedReplay.replayed);
    await assert.rejects(replayInstallOperation(f.root, 'entry-uninstall', { operation: 'uninstall', planDigest: 'changed' }), { code: 'OPERATION_ID_CONFLICT' });
    await writeFile(join(f.root, '.workflow/runtime/workflow.js'), 'unexpected recreated output');
    await assert.rejects(uninstallProject(f.root, { dryRun: false, operationId: 'entry-uninstall', planDigest: uninstall.digest }), { code: 'OUTPUT_MISMATCH' });
  } finally { await f.dispose(); }
});
