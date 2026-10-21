import { readFile, readdir, lstat } from 'node:fs/promises';
import path from 'node:path';
import { stringify } from 'yaml';
import { assert, WorkflowError } from '../shared/errors.js';
import { locateRepository } from '../repository/git.js';
import { resolveBaseRef, assertChangeBranch } from '../repository/base.js';
import { loadConfig, resolveProjectPath } from '../project/index.js';
import { applyTransaction, planTransaction, assertStoreReadable, acquireLock, releaseLock } from '../runtime/index.js';

export function changeId(value: string | undefined): string {
  assert(value && /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(value), 'CHANGE_INVALID_ID', 'Change ID must be lowercase kebab-case');
  return value;
}

export async function listChanges(root: string): Promise<{ active: string[]; archived: string[] }> {
  const readDirectories = async (relative: string) => {
    const dir = await resolveProjectPath(root, relative);
    try {
      const entries = await readdir(dir, { withFileTypes: true });
      assert(entries.every(e => !e.isSymbolicLink()), 'PATH_SYMLINK', `Symlinks are not supported in ${relative}`);
      return entries.filter(e => e.isDirectory()).map(e => e.name).sort();
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  };
  return { active: await readDirectories('.workflow/changes'), archived: await readDirectories('.workflow/archive') };
}

export async function newChange(root: string, id: string, operationId: string) {
  changeId(id);
  assert(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,100}$/.test(operationId), 'CLI_ARGUMENT', 'Invalid operation ID');
  const repo = await locateRepository(root);
  assert(repo.root === root, 'PROJECT_ROOT', '--project must select the Git worktree root');
  const config = await loadConfig(root);
  await assertStoreReadable(root);
  const base = await resolveBaseRef(root, config.git.baseBranch);
  await assertChangeBranch(root, base, 'CHANGE_BASE_BRANCH');
  const lockPath = path.join(repo.runtimeRoot, 'locks', 'project-install.lock');
  const lock = await acquireLock(lockPath);
  try {
    const destination = await resolveProjectPath(root, `.workflow/changes/${id}`);
    const transactionId = `change-new-${id}-${operationId}`;
    let replay = false;
    try { await lstat(path.join(repo.runtimeRoot, 'transactions', transactionId, 'journal.json')); replay = true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    try { await lstat(destination); if (!replay) throw new WorkflowError('CHANGE_EXISTS', `Change already exists: ${id}`, 3); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const listed = await listChanges(root);
    assert(!listed.archived.some(name => name.endsWith(`-${id}`)), 'CHANGE_REUSED_ID', `Archived change ID cannot be reused: ${id}`, 3);
    const historyPath = await resolveProjectPath(root, '.workflow/specs/history.json');
    try {
      const history = JSON.parse(await readFile(historyPath, 'utf8'));
      assert(history.formatVersion === 1 && Array.isArray(history.changes), 'HISTORY_INVALID', 'Invalid history index');
      assert(!history.changes.some((entry: { changeId: string }) => entry.changeId === id), 'CHANGE_REUSED_ID', `Historical change ID cannot be reused: ${id}`, 3);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const prefix = `.workflow/changes/${id}`;
    const files = [
      { path: `${prefix}/change.yaml`, content: stringify({ formatVersion: 1, id, title: id, modules: [], dependsOn: [], extensions: {} }) },
      { path: `${prefix}/proposal.md`, content: `# ${id}\n\n## Problem\nDescribe the observed problem.\n\n## Goals\nDescribe the intended outcome.\n\n## Scope\nRecord the authorized behavior and paths.\n\n## Non-goals\nRecord exclusions.\n\n## Acceptance\nReference observable scenario IDs, or justify no behavior change.\n\n## Rules\nnone — Determine applicable project rules before spec-gate.\n\n## Open questions\n- QUESTION-001 | unresolved | behavior | Confirm the intended behavior and authorized scope.\n` },
      { path: `${prefix}/design.md`, content: `# Design\n\nRecord the chosen approach, compatibility, permissions, validation selection and CI mapping.\n` },
      { path: `${prefix}/tasks.md`, content: '# Tasks\n\nCreate stable TASK-001 blocks with requirement references, write scopes and Test-* fields before spec-gate.\n' }
    ];
    const plan = await planTransaction({ root, journalRoot: path.join(repo.runtimeRoot, 'transactions'), operation: 'change-new', transactionId, changes: files });
    await applyTransaction(plan);
    return { changeId: id, path: prefix, transactionId: plan.transactionId, status: 'draft', executionReady: false };
  } finally { await releaseLock(lockPath, lock.owner); }
}
