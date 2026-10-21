import { mkdir, readFile, lstat, realpath, readdir, unlink, rm } from 'node:fs/promises';
import path from 'node:path';
import { sha256, stableStringify } from '../shared/hash.js';
import { assert, WorkflowError } from '../shared/errors.js';
import { atomicWrite, boundedPath, exists, readJson, relativePath, safeId, within, assertNoSymlinkPath } from './io.js';
import { locateRepository } from '../repository/git.js';

export interface FileChange { path: string; content: string | Uint8Array | null; expectedHash?: string | null; }
export interface TransactionEntry { path: string; beforeHash: string | null; afterHash: string | null; before: string | null; after: string | null; mode: number | null; }
export interface FileTransaction { formatVersion: 1; transactionId: string; operation: string; root: string; storePath: string; journalPath: string; expectedRevision?: number; entries: TransactionEntry[]; planHash: string; status: 'prepared' | 'applying' | 'committed' | 'rolled-back' | 'conflict'; applied: string[]; conflict?: string; }
export interface TransactionInput { root: string; storePath?: string; journalRoot?: string; operation: string; transactionId: string; changes: FileChange[]; expectedRevision?: number; }
export interface TransactionOptions { checkpoint?: (name: string) => void | Promise<void>; mode?: 'roll-forward' | 'roll-back'; }
function planDigest(journal: FileTransaction): string { return sha256(stableStringify({ formatVersion: journal.formatVersion, transactionId: journal.transactionId, operation: journal.operation, root: journal.root, storePath: journal.storePath, expectedRevision: journal.expectedRevision, entries: journal.entries })); }
async function inspect(root: string, relative: string): Promise<{ hash: string | null; content: string | null; mode: number | null }> {
  const filename = await boundedPath(root, relative);
  if (!(await exists(filename))) return { hash: null, content: null, mode: null };
  const stat = await lstat(filename);
  assert(stat.isFile() && !stat.isSymbolicLink(), 'UNSUPPORTED_INPUT', `事务只支持普通文件，拒绝符号链接/特殊文件: ${relative}`);
  const bytes = await readFile(filename);
  return { hash: sha256(bytes), content: bytes.toString('base64'), mode: stat.mode & 0o777 };
}
export async function listTransactions(journalRoot: string): Promise<FileTransaction[]> {
  await assertNoSymlinkPath(journalRoot);
  if (!(await exists(journalRoot))) return [];
  const result: FileTransaction[] = [];
  for (const entry of await readdir(journalRoot, { withFileTypes: true })) {
    const directory = path.join(journalRoot, entry.name);
    await assertNoSymlinkPath(directory);
    if (!entry.isDirectory()) continue;
    const journal = path.join(directory, 'journal.json');
    assert(await exists(journal), 'RECOVERY_REQUIRED', `事务目录缺少完整 journal，不能推断无未完成写入: ${directory}`, 7);
    result.push(await readTransaction(journal, false));
  }
  return result;
}
export async function assertStoreReadable(project: string, storePath?: string): Promise<void> {
  const repo = await locateRepository(project);
  const store = path.resolve(repo.root, storePath ?? '.workflow');
  await assertNoSymlinkPath(store);
  assert(within(repo.root, store), 'PATH_ESCAPE', '规格库必须位于 worktree 内');
  const journals = [...await listTransactions(path.join(repo.runtimeRoot, 'transactions')), ...await listTransactions(path.join(repo.root, '.workflow-transactions'))];
  for (const journal of journals) {
    if (journal.root !== repo.root || (journal.status === 'committed' || journal.status === 'rolled-back')) continue;
    if (within(store, journal.storePath) || within(journal.storePath, store)) throw new WorkflowError('RECOVERY_REQUIRED', '当前 worktree 存在未完成文件事务；先显式 recover', 7, { journalPath: journal.journalPath, status: journal.status });
  }
}
export async function planTransaction(input: TransactionInput): Promise<FileTransaction> {
  safeId(input.transactionId);
  const root = await realpath(input.root);
  const localJournalRoot = path.join(root, '.workflow-transactions');
  const requestedJournalRoot = path.resolve(input.journalRoot ?? localJournalRoot);
  // Canonicalize the caller's root alias (for example macOS /var -> /private/var)
  // while still rejecting symlinks anywhere below that trusted root.
  const declaredRoot = path.resolve(input.root);
  const journalRoot = within(declaredRoot, requestedJournalRoot) ? path.resolve(root, path.relative(declaredRoot, requestedJournalRoot)) : requestedJournalRoot;
  await assertNoSymlinkPath(journalRoot);
  if (journalRoot !== localJournalRoot) {
    const repo = await locateRepository(root).catch(error => {
      if (error instanceof WorkflowError && error.code === 'GIT_ERROR') return null;
      throw error;
    });
    assert(repo && repo.root === root && journalRoot === path.join(repo.runtimeRoot, 'transactions'), 'UNSUPPORTED_JOURNAL_ROOT', '事务 journal 仅允许 worktree 默认目录或 Git common-dir 下的受管理目录');
  }
  const journalPath = path.join(journalRoot, input.transactionId, 'journal.json');
  await assertNoSymlinkPath(journalPath);
  const storePath = path.resolve(root, input.storePath ?? '.workflow');
  assert(within(root, storePath), 'PATH_ESCAPE', '事务规格库必须位于 worktree 内');
  await assertNoSymlinkPath(storePath);
  const normalized = input.changes.map(change => ({ ...change, path: relativePath(change.path) })).sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)));
  const unique = new Set(normalized.map(change => change.path.toLowerCase()));
  assert(unique.size === normalized.length, 'PATH_COLLISION', '事务包含重复或大小写冲突路径');
  for (const change of normalized) assert(!change.path.split('/').some(part => part.toLowerCase() === '.git'), 'PATH_ESCAPE', '事务不能修改 Git 元数据');
  // Existing journals are authoritative: retries may not silently recapture changed before-images.
  if (await exists(journalPath)) {
    const journal = await loadTransaction(journalPath);
    const request = normalized.map(change => ({ path: change.path, afterHash: change.content === null ? null : sha256(typeof change.content === 'string' ? Buffer.from(change.content) : change.content) }));
    assert(journal.root === root && journal.storePath === storePath && journal.operation === input.operation && journal.expectedRevision === input.expectedRevision && stableStringify(request) === stableStringify(journal.entries.map(({ path: entryPath, afterHash }) => ({ path: entryPath, afterHash }))), 'TRANSACTION_CONFLICT', '同一事务 ID 已绑定不同计划');
    for (const change of normalized) if (change.expectedHash !== undefined) assert(journal.entries.find(entry => entry.path === change.path)!.beforeHash === change.expectedHash, 'TRANSACTION_CONFLICT', '重试的 expectedHash 与原事务输入不一致');
    return journal;
  }
  const entries: TransactionEntry[] = [];
  for (const change of normalized) {
    const before = await inspect(root, change.path);
    if (change.expectedHash !== undefined) assert(change.expectedHash === before.hash, 'STALE_INPUT', `事务输入已变化: ${change.path}`, 4);
    const bytes = change.content === null ? null : Buffer.from(change.content);
    entries.push({ path: change.path, beforeHash: before.hash, afterHash: bytes === null ? null : sha256(bytes), before: before.content, after: bytes === null ? null : bytes.toString('base64'), mode: before.mode });
  }
  await mkdir(journalRoot, { recursive: true });
  try { await mkdir(path.dirname(journalPath)); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new WorkflowError('TRANSACTION_CONFLICT', '事务目录存在但 journal 不完整，需要诊断', 7); throw error; }
  const journal: FileTransaction = { formatVersion: 1, transactionId: input.transactionId, operation: input.operation, root, storePath, journalPath, expectedRevision: input.expectedRevision, entries, planHash: '', status: 'prepared', applied: [] };
  journal.planHash = planDigest(journal);
  await atomicWrite(journalPath, JSON.stringify(journal, null, 2));
  return journal;
}
export async function loadTransaction(journalPath: string): Promise<FileTransaction> { return readTransaction(journalPath, true); }
async function readTransaction(journalPath: string, verifyRoot: boolean): Promise<FileTransaction> {
  const value = await readJson<unknown>(journalPath);
  const object = (item: unknown): item is Record<string, unknown> => !!item && typeof item === 'object' && !Array.isArray(item);
  assert(object(value), 'JOURNAL_CORRUPT', '事务 journal 必须为对象');
  assert(value.formatVersion === 1, 'UNSUPPORTED_VERSION', '未知事务格式，只允许诊断');
  assert(typeof value.transactionId === 'string' && typeof value.operation === 'string' && typeof value.root === 'string' && path.isAbsolute(value.root) && typeof value.storePath === 'string' && path.isAbsolute(value.storePath) && typeof value.journalPath === 'string' && typeof value.planHash === 'string' && Array.isArray(value.entries) && Array.isArray(value.applied) && value.applied.every(item => typeof item === 'string') && ['prepared', 'applying', 'committed', 'rolled-back', 'conflict'].includes(value.status as string) && (value.expectedRevision === undefined || Number.isSafeInteger(value.expectedRevision) && (value.expectedRevision as number) >= 0), 'JOURNAL_CORRUPT', '事务 journal 字段无效');
  safeId(value.transactionId);
  for (const entry of value.entries) assert(object(entry) && typeof entry.path === 'string' && (entry.beforeHash === null || typeof entry.beforeHash === 'string') && (entry.afterHash === null || typeof entry.afterHash === 'string') && (entry.before === null || typeof entry.before === 'string') && (entry.after === null || typeof entry.after === 'string') && (entry.mode === null || Number.isSafeInteger(entry.mode) && (entry.mode as number) >= 0 && (entry.mode as number) <= 0o777), 'JOURNAL_CORRUPT', '事务 entry 字段无效');
  const journal = value as unknown as FileTransaction;
  assert(journal.journalPath === path.resolve(journalPath) && journal.planHash === planDigest(journal), 'JOURNAL_CORRUPT', '事务计划或路径摘要不匹配');
  // Listing must still diagnose journals belonging to deleted linked worktrees.
  // Only inspect/apply/recover interpret live file facts and require the root.
  if (verifyRoot) assert(await realpath(journal.root) === journal.root, 'PATH_ESCAPE', '事务 worktree 路径已重绑定');
  assert(within(journal.root, journal.storePath), 'PATH_ESCAPE', '事务规格库不能越出 worktree');
  await assertNoSymlinkPath(journal.storePath);
  const seen = new Set<string>();
  for (const entry of journal.entries) {
    assert(relativePath(entry.path) === entry.path && !entry.path.split('/').some(part => part.toLowerCase() === '.git'), 'JOURNAL_CORRUPT', '事务路径非法或涉及 Git 元数据');
    const key = entry.path.normalize('NFC').toLowerCase();
    assert(!seen.has(key), 'JOURNAL_CORRUPT', '事务路径重复或大小写/Unicode 冲突'); seen.add(key);
    assert((entry.before === null ? null : sha256(Buffer.from(entry.before, 'base64'))) === entry.beforeHash && (entry.after === null ? null : sha256(Buffer.from(entry.after, 'base64'))) === entry.afterHash, 'JOURNAL_CORRUPT', '事务内容摘要不匹配');
  }
  assert(new Set(journal.applied).size === journal.applied.length && journal.applied.every(item => journal.entries.some(entry => entry.path === item)), 'JOURNAL_CORRUPT', '事务 applied 引用未知或重复路径');
  return journal;
}
export async function inspectTransaction(journalPath: string): Promise<{ transactionId: string; status: FileTransaction['status']; paths: { path: string; beforeHash: string | null; afterHash: string | null; currentHash: string | null; state: 'before' | 'after' | 'conflict' }[] }> {
  const journal = await loadTransaction(journalPath);
  const paths = [];
  for (const entry of journal.entries) {
    const currentHash = (await inspect(journal.root, entry.path)).hash;
    paths.push({ path: entry.path, beforeHash: entry.beforeHash, afterHash: entry.afterHash, currentHash, state: currentHash === entry.afterHash ? 'after' as const : currentHash === entry.beforeHash ? 'before' as const : 'conflict' as const });
  }
  return { transactionId: journal.transactionId, status: journal.status, paths };
}
async function executeTransaction(journalPath: string, options: TransactionOptions): Promise<FileTransaction> {
  const guard = `${journalPath}.guard`;
  await assertNoSymlinkPath(guard);
  try { await mkdir(guard); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new WorkflowError('RECOVERY_REQUIRED', '事务执行 guard 已存在，不能假定原写入者停止', 7); throw error; }
  try {
    const journal = await loadTransaction(journalPath);
    const rollback = options.mode === 'roll-back';
    assert(!(journal.status === 'committed' && rollback), 'TRANSACTION_COMMITTED', '已提交事务不能回滚；reopen 必须建立独立逆向事务');
    assert(!(journal.status === 'rolled-back' && !rollback), 'TRANSACTION_ROLLED_BACK', '已回滚事务不能改为提交');
    const terminal = rollback ? 'rolled-back' : 'committed';
    if (journal.status === terminal) {
      for (const entry of journal.entries) assert((await inspect(journal.root, entry.path)).hash === (rollback ? entry.beforeHash : entry.afterHash), 'OUTPUT_MISMATCH', `已提交输出丢失或变化: ${entry.path}`, 7);
      return journal;
    }
    await options.checkpoint?.('prepared');
    journal.status = 'applying'; delete journal.conflict;
    await atomicWrite(journalPath, JSON.stringify(journal, null, 2));
    await options.checkpoint?.('applying');
    const entries = rollback ? [...journal.entries].reverse() : journal.entries;
    for (const entry of entries) {
      const current = await inspect(journal.root, entry.path);
      const targetHash = rollback ? entry.beforeHash : entry.afterHash;
      const originalHash = rollback ? entry.afterHash : entry.beforeHash;
      if (current.hash !== targetHash && current.hash !== originalHash) {
        journal.status = 'conflict'; journal.conflict = entry.path;
        await atomicWrite(journalPath, JSON.stringify(journal, null, 2));
        throw new WorkflowError('TRANSACTION_CONFLICT', `外部修改阻止事务恢复: ${entry.path}`, 7);
      }
      if (current.hash !== targetHash) {
        const filename = await boundedPath(journal.root, entry.path);
        const content = rollback ? entry.before : entry.after;
        if (content === null) await unlink(filename);
        else {
          await atomicWrite(filename, Buffer.from(content, 'base64'));
          if (entry.mode !== null) { const { chmod } = await import('node:fs/promises'); await chmod(filename, entry.mode); }
        }
      }
      await options.checkpoint?.(`written:${entry.path}`);
      if (!journal.applied.includes(entry.path)) journal.applied.push(entry.path);
      await atomicWrite(journalPath, JSON.stringify(journal, null, 2));
      await options.checkpoint?.(`applied:${entry.path}`);
    }
    for (const entry of journal.entries) assert((await inspect(journal.root, entry.path)).hash === (rollback ? entry.beforeHash : entry.afterHash), 'OUTPUT_MISMATCH', `事务输出核验失败: ${entry.path}`, 7);
    await options.checkpoint?.('outputs-verified');
    journal.status = terminal;
    await atomicWrite(journalPath, JSON.stringify(journal, null, 2));
    await options.checkpoint?.(terminal);
    return journal;
  } finally { await rm(guard, { recursive: true }); }
}
export async function applyTransaction(plan: FileTransaction, options: TransactionOptions = {}): Promise<FileTransaction> {
  const saved = await loadTransaction(plan.journalPath);
  assert(saved.planHash === plan.planHash, 'TRANSACTION_CONFLICT', '提交计划与 prepared journal 不同');
  return executeTransaction(plan.journalPath, { ...options, mode: 'roll-forward' });
}
export async function recoverTransaction(journalPath: string, options: TransactionOptions = {}): Promise<FileTransaction> { return executeTransaction(journalPath, options); }
