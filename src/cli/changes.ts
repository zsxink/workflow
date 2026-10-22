import { readFile, readdir, lstat } from 'node:fs/promises';
import path from 'node:path';
import { stringify } from 'yaml';
import { assert, WorkflowError } from '../shared/errors.js';
import { locateRepository } from '../repository/git.js';
import { resolveBaseRef, assertChangeBranch } from '../repository/base.js';
import { loadConfig, resolveProjectPath } from '../project/index.js';
import { applyTransaction, planTransaction, assertStoreReadable, acquireLock, releaseLock } from '../runtime/index.js';
import { renderTemplate, type TemplateLanguage } from '../installer/render-template.js';

async function changeLanguage(root: string): Promise<TemplateLanguage> {
  const manifestPath = await resolveProjectPath(root, '.workflow/install.json');
  try {
    const info = await lstat(manifestPath);
    assert(info.isFile() && !info.isSymbolicLink(), 'INSTALL_MANIFEST_INVALID', '安装清单必须是普通文件。');
    const value = JSON.parse(await readFile(manifestPath, 'utf8')) as { language?: unknown };
    assert(value.language === undefined || value.language === 'zh-CN' || value.language === 'en', 'INSTALL_MANIFEST_INVALID', '安装清单中的语言设置无效。');
    return value.language ?? 'zh-CN';
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'zh-CN';
    throw error;
  }
}

function changeTemplates(id: string, language: TemplateLanguage, modules: string[]) {
  const title = id.replaceAll('-', ' ');
  const metadata = stringify({ formatVersion: 1, id, title, modules, dependsOn: [], extensions: {} });
  return [
    { path: `.workflow/changes/${id}/change.yaml`, content: metadata },
    { path: `.workflow/changes/${id}/proposal.md`, content: renderTemplate(language, 'change/proposal', { title }) },
    { path: `.workflow/changes/${id}/design.md`, content: renderTemplate(language, 'change/design') },
    { path: `.workflow/changes/${id}/tasks.md`, content: renderTemplate(language, 'change/tasks') },
  ];
}

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
    const configuredModules = config.modules.length === 1 ? [config.modules[0]!.id] : [];
    const files = changeTemplates(id, await changeLanguage(root), configuredModules);
    const plan = await planTransaction({ root, journalRoot: path.join(repo.runtimeRoot, 'transactions'), operation: 'change-new', transactionId, changes: files });
    await applyTransaction(plan);
    return { changeId: id, path: prefix, transactionId: plan.transactionId, status: 'draft', executionReady: false };
  } finally { await releaseLock(lockPath, lock.owner); }
}
