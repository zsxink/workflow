import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, readdir, stat, cp } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import os from 'node:os';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { captureFingerprints, locateRepository, createRun, readRun, listRuns, mutateRun, releaseChangeLock, acquireChangeLock, heartbeatChangeLock, takeoverLock, resumePlan, planTransaction, applyTransaction, recoverTransaction, assertStoreReadable, listTransactions } from '../src/runtime/index.js';
const execute = promisify(execFile);
async function command(root: string, ...args: string[]): Promise<string> { return (await execute('git', ['-C', root, ...args], { env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } })).stdout; }
async function fixture(t: { after: (fn: () => Promise<void>) => void }): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'workflow-runtime-中文 '));
  t.after(() => rm(root, { recursive: true, force: true }));
  await command(root, 'init', '-q'); await command(root, 'config', 'user.name', 'Fixture'); await command(root, 'config', 'user.email', 'fixture@example.invalid');
  await writeFile(path.join(root, 'source.txt'), 'initial\n'); await command(root, 'add', '.'); await command(root, 'commit', '-qm', 'initial');
  return root;
}
function code(expected: string): (error: unknown) => boolean { return error => typeof error === 'object' && error !== null && 'code' in error && error.code === expected; }

test('source manifest is stable before staging and after commit, including deletion', async t => {
  const root = await fixture(t);
  await mkdir(path.join(root, 'src/dist'), { recursive: true });
  await writeFile(path.join(root, 'src/dist/real-source.ts'), 'source');
  await writeFile(path.join(root, 'new.txt'), 'new');
  const before = await captureFingerprints(root);
  assert(before.manifests.source.some(entry => entry.path === 'src/dist/real-source.ts'));
  await command(root, 'add', '.'); const staged = await captureFingerprints(root);
  await command(root, 'commit', '-qm', 'added'); const committed = await captureFingerprints(root);
  assert.equal(before.sourceFingerprint, staged.sourceFingerprint); assert.equal(before.sourceFingerprint, committed.sourceFingerprint);
  await rm(path.join(root, 'new.txt'));
  const removed = await captureFingerprints(root); assert.notEqual(removed.sourceFingerprint, committed.sourceFingerprint);
  await command(root, 'add', '-u'); assert.equal((await captureFingerprints(root)).sourceFingerprint, removed.sourceFingerprint);
});
test('checking a completed task does not invalidate its plan fingerprint', async t => {
  const root = await fixture(t);
  const directory = path.join(root, '.workflow/changes/checklist');
  await mkdir(directory, { recursive: true });
  const taskPath = path.join(directory, 'tasks.md');
  await writeFile(taskPath, '# Tasks\n\n## [ ] TASK-001 — Implement behavior\n- Requires: REQ-CHECKLIST-001\n');
  const before = await captureFingerprints(root);
  await writeFile(taskPath, (await readFile(taskPath, 'utf8')).replace('## [ ] TASK-001', '## [x] TASK-001'));
  const after = await captureFingerprints(root);
  assert.equal(after.planFingerprint, before.planFingerprint);
});
test('only repository gitignore rules select inputs; tracked ignored inputs require declaration', async t => {
  const root = await fixture(t);
  await writeFile(path.join(root, 'local.txt'), 'included');
  await writeFile(path.join(root, '.git/info/exclude'), 'local.txt\n');
  await writeFile(path.join(root, 'global-exclude'), 'local.txt\n');
  await command(root, 'config', 'core.excludesFile', path.join(root, 'global-exclude'));
  assert((await captureFingerprints(root)).manifests.source.some(entry => entry.path === 'local.txt'));
  await writeFile(path.join(root, '.gitignore'), 'source.txt\nignored/\n');
  await mkdir(path.join(root, 'ignored')); await writeFile(path.join(root, 'ignored/file'), 'ignored');
  await assert.rejects(captureFingerprints(root), code('TRACKED_IGNORED_INPUT'));
  const captured = await captureFingerprints(root, { extraSourceInputs: ['source.txt'] });
  assert(captured.manifests.source.some(entry => entry.path === 'source.txt'));
  assert(!captured.manifests.source.some(entry => entry.path === 'ignored/file'));
  const prior = captured.policyFingerprint;
  await command(root, 'add', '.gitignore');
  assert.equal((await captureFingerprints(root, { extraSourceInputs: ['source.txt'] })).policyFingerprint, prior);
});
test('authoritative docs and agent instructions are policy inputs, including ignored docs and artifact paths', async t => {
  const root = await fixture(t);
  await mkdir(path.join(root, '.workflow'), { recursive: true });
  await mkdir(path.join(root, 'docs/private'), { recursive: true });
  await mkdir(path.join(root, 'nested/deeper'), { recursive: true });
  await writeFile(path.join(root, '.workflow/config.yaml'), 'project:\n  authoritativeDocs:\n    - docs/private/contract.md\n');
  await writeFile(path.join(root, 'docs/private/contract.md'), 'contract v1\n');
  await writeFile(path.join(root, 'AGENTS.md'), 'root instructions\n');
  await writeFile(path.join(root, 'CLAUDE.md'), 'root claude instructions\n');
  await writeFile(path.join(root, 'nested/AGENTS.md'), 'nested instructions\n');
  await writeFile(path.join(root, 'nested/deeper/CLAUDE.md'), 'nested claude instructions\n');
  await writeFile(path.join(root, '.gitignore'), 'docs/private/\n');

  const before = await captureFingerprints(root, { artifactExcludes: ['docs/private/**'] });
  const policyPaths = before.manifests.policy.map(entry => entry.path);
  for (const filename of ['docs/private/contract.md', 'AGENTS.md', 'CLAUDE.md', 'nested/AGENTS.md', 'nested/deeper/CLAUDE.md']) {
    assert(policyPaths.includes(filename), `${filename} should be fingerprinted as policy`);
  }
  assert(!before.manifests.source.some(entry => entry.path.startsWith('docs/private/')));

  await writeFile(path.join(root, 'docs/private/contract.md'), 'contract v2\n');
  const after = await captureFingerprints(root, { artifactExcludes: ['docs/private/**'] });
  assert.notEqual(after.policyFingerprint, before.policyFingerprint);
  assert.equal(after.sourceFingerprint, before.sourceFingerprint);
});
test('explicit policy globs opt ignored agent instructions into traversal', async t => {
  const root = await fixture(t);
  await mkdir(path.join(root, 'private'), { recursive: true });
  await writeFile(path.join(root, '.gitignore'), 'private/\n');
  await writeFile(path.join(root, 'private/AGENTS.md'), 'applicable instructions\n');
  await writeFile(path.join(root, 'private/CLAUDE.md'), 'applicable claude instructions\n');
  const defaults = await captureFingerprints(root);
  assert(!defaults.manifests.policy.some(entry => entry.path.startsWith('private/')));
  const explicit = await captureFingerprints(root, { policyInputs: ['**/AGENTS.md', '**/CLAUDE.md'] });
  assert(explicit.manifests.policy.some(entry => entry.path === 'private/AGENTS.md'));
  assert(explicit.manifests.policy.some(entry => entry.path === 'private/CLAUDE.md'));
});
test('nested gitignore rules and symlink text are fingerprinted without following links', async t => {
  const root = await fixture(t);
  await mkdir(path.join(root, 'nested')); await writeFile(path.join(root, 'nested/.gitignore'), '*.tmp\n');
  await writeFile(path.join(root, 'nested/skip.tmp'), 'skip'); await writeFile(path.join(root, 'nested/include.ts'), 'yes');
  await symlink('../source.txt', path.join(root, 'nested/link'));
  const captured = await captureFingerprints(root);
  assert(!captured.manifests.source.some(entry => entry.path.endsWith('skip.tmp')));
  assert.equal(captured.manifests.source.find(entry => entry.path === 'nested/link')?.type, 'symlink');
  await symlink(os.tmpdir(), path.join(root, 'outside'));
  await assert.rejects(captureFingerprints(root), code('PATH_ESCAPE'));
});
test('special Git inputs and broad artifact exclusions fail closed', async t => {
  const root = await fixture(t);
  await command(root, 'config', 'core.sparseCheckout', 'true');
  await assert.rejects(captureFingerprints(root), code('UNSUPPORTED_INPUT'));
  await command(root, 'config', '--unset', 'core.sparseCheckout');
  await writeFile(path.join(root, '.gitattributes'), '*.txt filter=lfs\n');
  await assert.rejects(captureFingerprints(root), code('UNSUPPORTED_INPUT'));
  await rm(path.join(root, '.gitattributes'));
  await assert.rejects(captureFingerprints(root, { artifactExcludes: ['**'] }), code('INVALID_CONFIG'));
});
test('state CAS binds owner/revision/runtime, keeps operation-id idempotent and derives progress', async t => {
  const root = await fixture(t);
  const input = { changeId: 'first', operationId: 'create', budgets: { retry: 2 } };
  const run = await createRun(root, input);
  assert.equal((await createRun(root, input)).runId, run.runId);
  assert(run.fingerprints); assert(run.checkpoints.bootstrap);
  const mutation = { owner: run.owner, expectedRevision: 0, operationId: 'advance', input: { phase: 'spec' } };
  const updated = await mutateRun(root, run.runId, mutation, draft => { draft.phase = 'spec'; });
  assert.equal(updated.revision, 1);
  assert.equal((await mutateRun(root, run.runId, mutation, () => { throw new Error('must not execute replay'); })).revision, 1);
  await assert.rejects(mutateRun(root, run.runId, { ...mutation, operationId: 'stale' }, () => {}), code('STATE_CONFLICT'));
  await assert.rejects(mutateRun(root, run.runId, { ...mutation, input: { phase: 'other' } }, () => {}), code('OPERATION_CONFLICT'));
  await assert.rejects(mutateRun(root, run.runId, { ...mutation, owner: 'other' }, () => {}), code('OWNER_CONFLICT'));
  await assert.rejects(mutateRun(root, run.runId, { ...mutation, runtime: { version: 'other', sha256: 'wrong' } }, () => {}), code('RUNTIME_MISMATCH'));
  const repo = await locateRepository(root);
  assert.match(await readFile(path.join(repo.runtimeRoot, 'runs/first', run.runId, 'progress.md'), 'utf8'), /Revision: 1/);
});
test('lock heartbeat never permits a second owner or unsupported takeover', async t => {
  const root = await fixture(t);
  const lock = await acquireChangeLock(root, 'change', { owner: 'one' });
  assert.equal((await heartbeatChangeLock(root, 'change', 'one')).owner, lock.owner);
  await assert.rejects(acquireChangeLock(root, 'change', { owner: 'two' }), code('LOCKED'));
  await assert.rejects(takeoverLock(), code('UNSUPPORTED_TAKEOVER'));
  await assert.rejects(releaseChangeLock(root, 'change', 'two'), code('OWNER_CONFLICT'));
  await releaseChangeLock(root, 'change', 'one');
});
test('successor runs inherit spent budgets and cannot reset initial额度', async t => {
  const root = await fixture(t); const first = await createRun(root, { changeId: 'budget', operationId: 'create', budgets: { retry: 2 } });
  const done = await mutateRun(root, first.runId, { owner: first.owner, expectedRevision: 0, operationId: 'finish', input: {} }, draft => { draft.status = 'failed'; draft.budgets.retry!.used = 1; });
  await releaseChangeLock(root, done.changeId, done.owner);
  const next = await createRun(root, { changeId: 'budget', operationId: 'next', previousRunId: done.runId });
  assert.equal(next.budgets.retry!.used, 1);
  await assert.rejects(mutateRun(root, next.runId, { owner: next.owner, expectedRevision: 0, operationId: 'reset', input: {} }, draft => { draft.budgets.retry!.used = 0; }), code('BUDGET_RESET'));
});
test('linked worktree state survives deletion and resume diagnostics remain read-only', async t => {
  const root = await fixture(t); const linked = `${root}-linked`;
  t.after(() => rm(linked, { recursive: true, force: true }));
  await command(root, 'worktree', 'add', '-qb', 'fixture-linked', linked);
  const repo = await locateRepository(root); const other = await locateRepository(linked);
  assert.equal(repo.commonDir, other.commonDir); assert.notEqual(repo.gitDir, other.gitDir);
  const run = await createRun(linked, { changeId: 'linked', operationId: 'start' });
  const stateFile = path.join(repo.runtimeRoot, 'runs/linked', run.runId, 'state.json');
  const before = await readFile(stateFile, 'utf8');
  const diagnose = await resumePlan(root, run.runId); assert.equal(diagnose.readonly, true);
  assert.equal(await readFile(stateFile, 'utf8'), before);
  await command(root, 'worktree', 'remove', '--force', linked);
  assert.equal((await readRun(root, run.runId)).runId, run.runId);
  assert.equal((await resumePlan(root, run.runId)).worktreeAvailable, false);
});
test('resume reports source invalidation and leaves lock/state timestamps intact', async t => {
  const root = await fixture(t); const run = await createRun(root, { changeId: 'resume', operationId: 'create' });
  const repo = await locateRepository(root); const lock = path.join(repo.runtimeRoot, 'locks/resume.lock');
  const before = await stat(lock); await writeFile(path.join(root, 'source.txt'), 'changed');
  const result = await resumePlan(root, run.runId);
  assert(result.diagnostics.some(diagnostic => diagnostic.code === 'INPUT_CHANGED'));
  assert.equal((await stat(lock)).mtimeMs, before.mtimeMs);
});
test('run mutation rejects another worktree and changed branch', async t => {
  const root = await fixture(t); const linked = `${root}-other`;
  t.after(() => rm(linked, { recursive: true, force: true }));
  await command(root, 'worktree', 'add', '-qb', 'other-branch', linked);
  const run = await createRun(root, { changeId: 'bound', operationId: 'start' });
  const input = { owner: run.owner, expectedRevision: 0, operationId: 'mutate', input: {} };
  await assert.rejects(mutateRun(linked, run.runId, input, () => {}), code('WORKTREE_MISMATCH'));
  await command(root, 'checkout', '-qb', 'changed-branch');
  await assert.rejects(mutateRun(root, run.runId, input, () => {}), code('BRANCH_CHANGED'));
});
test('creation replays validate branch, runtime and the original owner lock', async t => {
  const root = await fixture(t);
  const input = { changeId: 'replay-facts', operationId: 'start' };
  const run = await createRun(root, input);
  await assert.rejects(createRun(root, { ...input, runtime: { version: 'other', sha256: 'f'.repeat(64) } }), code('RUNTIME_MISMATCH'));
  const branch = (await command(root, 'branch', '--show-current')).trim();
  await command(root, 'checkout', '-qb', 'replay-changed');
  await assert.rejects(createRun(root, input), code('BRANCH_CHANGED'));
  await command(root, 'checkout', branch);
  await releaseChangeLock(root, run.changeId, run.owner);
  await acquireChangeLock(root, run.changeId, { owner: 'different' });
  await assert.rejects(createRun(root, input), code('OWNER_CONFLICT'));
});
test('branch binding is immutable and self-reported user decisions cannot expand budgets', async t => {
  const root = await fixture(t);
  const run = await createRun(root, { changeId: 'budget-authority', operationId: 'start', budgets: { retry: 1 } });
  const input = { owner: run.owner, expectedRevision: 0, operationId: 'forged' };
  await assert.rejects(mutateRun(root, run.runId, input, draft => {
    draft.decisions.push({ decisionId: 'self-reported', actor: 'user' });
    draft.budgets.retry!.additions.push({ decisionId: 'self-reported', amount: 100 });
  }), code('BUDGET_AUTHORIZATION_UNVERIFIED'));
  await assert.rejects(mutateRun(root, run.runId, { ...input, operationId: 'branch' }, draft => { draft.branch = 'other'; }), code('IMMUTABLE_STATE'));
  const unchanged = await readRun(root, run.runId);
  assert.equal(unchanged.revision, 0); assert.deepEqual(unchanged.decisions, []); assert.deepEqual(unchanged.budgets.retry!.additions, []);
});
test('known state schemas reject malformed nested records before use', async t => {
  const root = await fixture(t);
  const run = await createRun(root, { changeId: 'schema', operationId: 'start', budgets: { retry: 1 } });
  const { runtimeRoot } = await locateRepository(root);
  const statePath = path.join(runtimeRoot, 'runs/schema', run.runId, 'state.json');
  for (const update of [{ budgets: { retry: { initial: 1, used: 0, additions: null } } }, { operations: null }, { history: [] }, { runtime: { version: 'x', sha256: 'unverified' } }, { fingerprints: { sourceFingerprint: 'only-one' } }]) {
    await writeFile(statePath, JSON.stringify({ ...run, ...update }));
    await assert.rejects(readRun(root, run.runId), code('STATE_CORRUPT'));
    await assert.rejects(listRuns(root), code('STATE_CORRUPT'));
  }
});
test('future state versions expose diagnostic identities without interpreting or inheriting nested fields', async t => {
  const root = await fixture(t);
  const run = await createRun(root, { changeId: 'future', operationId: 'start' });
  const { runtimeRoot } = await locateRepository(root);
  const statePath = path.join(runtimeRoot, 'runs/future', run.runId, 'state.json');
  await writeFile(statePath, JSON.stringify({ ...run, formatVersion: 2, status: 'succeeded', budgets: { poisoned: null }, operations: null, workflow: { trusted: true }, checkpoints: null }));
  const before = await readFile(statePath, 'utf8');
  const diagnostic = await readRun(root, run.runId);
  assert.equal(diagnostic.formatVersion, 2); assert.deepEqual(diagnostic.budgets, {}); assert.equal(diagnostic.workflow, undefined); assert.deepEqual(diagnostic.checkpoints, {});
  assert(diagnostic.diagnostics?.some(item => item.code === 'UNSUPPORTED_VERSION'));
  const resume = await resumePlan(root, run.runId);
  assert(resume.diagnostics.some(item => item.code === 'UNSUPPORTED_VERSION')); assert.deepEqual(resume.transactions, []); assert.equal(resume.fingerprints, 'unknown');
  await assert.rejects(mutateRun(root, run.runId, { owner: run.owner, expectedRevision: 0, operationId: 'write' }, () => {}), code('UNSUPPORTED_VERSION'));
  await assert.rejects(createRun(root, { changeId: run.changeId, previousRunId: run.runId, operationId: 'next' }), code('UNSUPPORTED_VERSION'));
  assert.equal(await readFile(statePath, 'utf8'), before);
});
test('development identity covers changes outside the state module', async t => {
  const copyRoot = await mkdtemp(path.join(os.tmpdir(), 'workflow-source-identity-'));
  t.after(() => rm(copyRoot, { recursive: true, force: true }));
  const projectRoot = fileURLToPath(new URL('../', import.meta.url));
  await cp(path.join(projectRoot, 'src'), path.join(copyRoot, 'src'), { recursive: true });
  await writeFile(path.join(copyRoot, 'package.json'), '{"type":"module"}');
  await symlink(path.join(projectRoot, 'node_modules'), path.join(copyRoot, 'node_modules'));
  const copy = await import(pathToFileURL(path.join(copyRoot, 'src/runtime/state.ts')).href);
  const before = await copy.currentRuntimeIdentity();
  const locks = path.join(copyRoot, 'src/runtime/locks.ts');
  await writeFile(locks, (await readFile(locks, 'utf8')) + '\n// Changed implementation.\n');
  const after = await copy.currentRuntimeIdentity();
  assert.match(before.version, /development/); assert.notEqual(before.sha256, after.sha256);
});
test('orphaned guard remains suspended without timeout or PID takeover', async t => {
  const root = await fixture(t);
  await acquireChangeLock(root, 'orphan', { owner: 'owner' });
  const { runtimeRoot } = await locateRepository(root);
  const guard = path.join(runtimeRoot, 'locks/orphan.lock.guard');
  await mkdir(guard);
  await assert.rejects(heartbeatChangeLock(root, 'orphan', 'owner'), code('STATE_CONFLICT'));
  await assert.rejects(releaseChangeLock(root, 'orphan', 'owner'), code('STATE_CONFLICT'));
  assert((await stat(guard)).isDirectory());
});
test('runtime metadata symlinks cannot redirect state, locks or journal reads/writes', async t => {
  const root = await fixture(t); const repo = await locateRepository(root);
  const outside = await mkdtemp(path.join(os.tmpdir(), 'workflow-outside-'));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await mkdir(path.join(repo.runtimeRoot, 'runs'), { recursive: true });
  await symlink(outside, path.join(repo.runtimeRoot, 'runs/escape'));
  await assert.rejects(createRun(root, { changeId: 'escape', operationId: 'escape' }), code('PATH_ESCAPE'));
  assert.deepEqual(await readdir(outside), []);
  await rm(path.join(repo.runtimeRoot, 'runs/escape'));
  await symlink(outside, path.join(repo.runtimeRoot, 'transactions'));
  await assert.rejects(planTransaction({ root, journalRoot: path.join(repo.runtimeRoot, 'transactions'), operation: 'archive', transactionId: 'escape', changes: [] }), code('PATH_ESCAPE'));
  await rm(path.join(repo.runtimeRoot, 'transactions'));
  await symlink(outside, path.join(repo.runtimeRoot, 'locks/evil.lock'));
  await assert.rejects(heartbeatChangeLock(root, 'evil', 'owner'), code('PATH_ESCAPE'));
});
test('failed run creation releases its newly acquired lock before any host dispatch', async t => {
  const root = await fixture(t);
  await symlink(os.tmpdir(), path.join(root, 'outside'));
  await assert.rejects(createRun(root, { changeId: 'retry-create', operationId: 'start' }), code('PATH_ESCAPE'));
  await rm(path.join(root, 'outside'));
  const run = await createRun(root, { changeId: 'retry-create', operationId: 'start' });
  assert.equal(run.revision, 0);
});
test('ignored directories are pruned without inspecting nested Git repositories or special files', async t => {
  const root = await fixture(t);
  await writeFile(path.join(root, '.gitignore'), 'node_modules/\n');
  await mkdir(path.join(root, 'node_modules/dependency/.git'), { recursive: true });
  await execute('mkfifo', [path.join(root, 'node_modules/pipe')]);
  const result = await captureFingerprints(root);
  assert(!result.manifests.source.some(entry => entry.path.startsWith('node_modules/')));
  await writeFile(path.join(root, '.git/info/attributes'), '*.txt filter=other\n');
  await assert.rejects(captureFingerprints(root), code('UNSUPPORTED_INPUT'));
  await rm(path.join(root, '.git/info/attributes'));
  await symlink(path.join(root, 'source.txt'), path.join(root, '.git/info/attributes'));
  await assert.rejects(captureFingerprints(root), code('PATH_ESCAPE'));
});

for (const checkpoint of ['prepared', 'applying', 'written:a.txt', 'applied:a.txt', 'written:b.txt', 'applied:b.txt', 'outputs-verified', 'committed']) {
  test(`transaction recovers idempotently after interruption at ${checkpoint}`, async t => {
    const root = await fixture(t); const repo = await locateRepository(root);
    await writeFile(path.join(root, 'a.txt'), 'old-a'); await writeFile(path.join(root, 'b.txt'), 'old-b');
    const plan = await planTransaction({ root, journalRoot: path.join(repo.runtimeRoot, 'transactions'), operation: 'archive', transactionId: 'txn', changes: [{ path: 'a.txt', content: 'new-a' }, { path: 'b.txt', content: null }, { path: 'nested/c.txt', content: 'created' }] });
    await assert.rejects(applyTransaction(plan, { checkpoint(name) { if (name === checkpoint) throw new Error('injected crash'); } }), /injected crash/);
    if (checkpoint !== 'committed') await assert.rejects(assertStoreReadable(root), code('RECOVERY_REQUIRED'));
    assert.equal((await recoverTransaction(plan.journalPath)).status, 'committed');
    assert.equal(await readFile(path.join(root, 'a.txt'), 'utf8'), 'new-a');
    await assert.rejects(readFile(path.join(root, 'b.txt')), { code: 'ENOENT' });
    assert.equal(await readFile(path.join(root, 'nested/c.txt'), 'utf8'), 'created');
    assert.equal((await applyTransaction(plan)).status, 'committed'); await assertStoreReadable(root);
  });
}
test('transaction rejects external changes, changed operation retry and lost committed output', async t => {
  const root = await fixture(t); await writeFile(path.join(root, 'a.txt'), 'old');
  const input = { root, operation: 'archive', transactionId: 'external', changes: [{ path: 'a.txt', content: 'new' }] };
  const plan = await planTransaction(input);
  await assert.rejects(planTransaction({ ...input, changes: [{ path: 'a.txt', content: 'other' }] }), code('TRANSACTION_CONFLICT'));
  await writeFile(path.join(root, 'a.txt'), 'external');
  await assert.rejects(applyTransaction(plan), code('TRANSACTION_CONFLICT'));
  assert.equal(await readFile(path.join(root, 'a.txt'), 'utf8'), 'external');
  await writeFile(path.join(root, 'a.txt'), 'old'); await recoverTransaction(plan.journalPath);
  await rm(path.join(root, 'a.txt')); await assert.rejects(applyTransaction(plan), code('OUTPUT_MISMATCH'));
});
test('rollback restores before-images without overwriting external data', async t => {
  const root = await fixture(t); await writeFile(path.join(root, 'a.txt'), 'old');
  const plan = await planTransaction({ root, operation: 'archive', transactionId: 'rollback', changes: [{ path: 'a.txt', content: 'new' }, { path: 'new.txt', content: 'created' }] });
  await assert.rejects(applyTransaction(plan, { checkpoint(name) { if (name === 'written:new.txt') throw new Error('stop'); } }));
  assert.equal((await recoverTransaction(plan.journalPath, { mode: 'roll-back' })).status, 'rolled-back');
  assert.equal(await readFile(path.join(root, 'a.txt'), 'utf8'), 'old');
  await assert.rejects(readFile(path.join(root, 'new.txt')), { code: 'ENOENT' });
});
test('transaction rejects leaf symlinks, escaping parents and duplicate paths', async t => {
  const root = await fixture(t);
  await symlink('source.txt', path.join(root, 'leaf'));
  await assert.rejects(planTransaction({ root, operation: 'x', transactionId: 'leaf', changes: [{ path: 'leaf', content: 'bad' }] }), code('UNSUPPORTED_INPUT'));
  await symlink(os.tmpdir(), path.join(root, 'outside'));
  await assert.rejects(planTransaction({ root, operation: 'x', transactionId: 'outside', changes: [{ path: 'outside/file', content: 'bad' }] }), code('PATH_ESCAPE'));
  await assert.rejects(planTransaction({ root, operation: 'x', transactionId: 'dup', changes: [{ path: 'same', content: '1' }, { path: 'same', content: '2' }] }), code('PATH_COLLISION'));
});
test('store reads fail closed on corrupt, unknown, incomplete and symlinked transaction metadata', async t => {
  const root = await fixture(t); const { runtimeRoot } = await locateRepository(root);
  const journals = path.join(runtimeRoot, 'transactions');
  const plan = await planTransaction({ root, journalRoot: journals, operation: 'archive', transactionId: 'schema', changes: [] });
  for (const update of [{ formatVersion: 2 }, { entries: [null] }, { status: 'ignored' }, { storePath: null }]) {
    await writeFile(plan.journalPath, JSON.stringify({ ...plan, ...update }));
    await assert.rejects(assertStoreReadable(root), code('formatVersion' in update ? 'UNSUPPORTED_VERSION' : 'JOURNAL_CORRUPT'));
  }
  await rm(path.dirname(plan.journalPath), { recursive: true });
  await mkdir(path.join(journals, 'incomplete'));
  await assert.rejects(assertStoreReadable(root), code('RECOVERY_REQUIRED'));
  await rm(path.join(journals, 'incomplete'), { recursive: true });
  await symlink(os.tmpdir(), path.join(journals, 'redirect'));
  await assert.rejects(assertStoreReadable(root), code('PATH_ESCAPE'));
  await rm(path.join(journals, 'redirect'));
  await symlink(os.tmpdir(), path.join(root, '.workflow'));
  await assert.rejects(assertStoreReadable(root), code('PATH_ESCAPE'));
});
test('default direct-API transactions block store reads until recovery completes', async t => {
  const root = await fixture(t);
  const plan = await planTransaction({ root, operation: 'archive', transactionId: 'default-location', changes: [{ path: '.workflow/specs/spec.md', content: 'new' }] });
  await assert.rejects(assertStoreReadable(root), code('RECOVERY_REQUIRED'));
  await assert.rejects(captureFingerprints(root), code('RECOVERY_REQUIRED'));
  await applyTransaction(plan);
  await assertStoreReadable(root);
});
test('transaction plans reject undiscoverable custom journal roots before writing', async t => {
  const root = await fixture(t);
  const custom = path.join(root, 'custom-journals');
  await assert.rejects(planTransaction({ root, journalRoot: custom, operation: 'archive', transactionId: 'custom', changes: [{ path: 'source.txt', content: 'changed' }] }), code('UNSUPPORTED_JOURNAL_ROOT'));
  await assert.rejects(stat(custom), { code: 'ENOENT' });
  assert.equal(await readFile(path.join(root, 'source.txt'), 'utf8'), 'initial\n');
  const genericRoot = await mkdtemp(path.join(os.tmpdir(), 'workflow-generic-transaction-'));
  t.after(() => rm(genericRoot, { recursive: true, force: true }));
  const generic = await planTransaction({ root: genericRoot, operation: 'generic', transactionId: 'default', changes: [{ path: 'file.txt', content: 'new' }] });
  await applyTransaction(generic);
  assert.equal(await readFile(path.join(genericRoot, 'file.txt'), 'utf8'), 'new');
  await assert.rejects(planTransaction({ root: genericRoot, journalRoot: path.join(genericRoot, 'custom'), operation: 'generic', transactionId: 'custom', changes: [] }), code('UNSUPPORTED_JOURNAL_ROOT'));
});
test('transaction listing retains diagnostics for deleted worktrees without reading their file facts', async t => {
  const root = await fixture(t); const linked = `${root}-journal-linked`;
  t.after(() => rm(linked, { recursive: true, force: true }));
  await command(root, 'worktree', 'add', '-qb', 'journal-linked', linked);
  const { runtimeRoot } = await locateRepository(root);
  const journals = path.join(runtimeRoot, 'transactions');
  const plan = await planTransaction({ root: linked, journalRoot: journals, operation: 'archive', transactionId: 'deleted-worktree', changes: [] });
  await command(root, 'worktree', 'remove', '--force', linked);
  assert.equal((await listTransactions(journals))[0]?.transactionId, plan.transactionId);
  await assertStoreReadable(root);
});
