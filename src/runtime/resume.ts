import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { git, locateRepository } from '../repository/git.js';
import { type Diagnostic } from '../shared/errors.js';
import { stableStringify } from '../shared/hash.js';
import { captureFingerprints, type FingerprintCapture } from './fingerprints.js';
import { readRun, currentRuntimeIdentity, type RuntimeIdentity } from './state.js';
import { listTransactions, inspectTransaction } from './transactions.js';
import { changeLockPath, requireLock, type LockRecord } from './locks.js';
import { exists, readJson } from './io.js';

export interface ResumeDiagnostics {
  readonly: true; runId: string; revision: number; worktreeAvailable: boolean;
  lock: LockRecord | null; fingerprints: FingerprintCapture | 'unknown';
  git: { head: string | null; branch: string | null; index: string | null; status: string | null };
  diagnostics: Diagnostic[]; actions: string[];
  integration: 'unknown'; tracking: 'unknown'; writerLiveness: 'unknown';
  transactions: Awaited<ReturnType<typeof inspectTransaction>>[];
}
export async function resumePlan(project: string, runId: string, options: { runtime?: RuntimeIdentity } = {}): Promise<ResumeDiagnostics> {
  const repo = await locateRepository(project);
  const run = await readRun(project, runId);
  const diagnostics: Diagnostic[] = [];
  const actions: string[] = [];
  if (run.formatVersion !== 1) return { readonly: true, runId, revision: run.revision, worktreeAvailable: false, lock: null, fingerprints: 'unknown', git: { head: null, branch: null, index: null, status: null }, diagnostics: run.diagnostics ?? [{ code: 'UNSUPPORTED_VERSION', message: '未知状态格式，不解释运行事实或执行恢复' }], actions, integration: 'unknown', tracking: 'unknown', writerLiveness: 'unknown', transactions: [] };
  const lockPath = await changeLockPath(project, run.changeId);
  let lock: LockRecord | null = null;
  if (await exists(lockPath)) {
    try {
      const candidate = await readJson<LockRecord>(lockPath);
      if (candidate && candidate.formatVersion !== 1) diagnostics.push({ code: 'UNSUPPORTED_VERSION', message: '未知锁格式，只读诊断' });
      else lock = await requireLock(lockPath, candidate?.owner);
    } catch { diagnostics.push({ code: 'LOCK_CORRUPT', message: '锁创建可能中断或字段损坏；不能推断无写入者' }); }
  }
  if (!lock || lock.owner !== run.owner) diagnostics.push({ code: 'OWNER_CONFLICT', message: '锁缺失或 owner 与 run 不一致；需要独立恢复证据' });
  const worktreeAvailable = await exists(run.worktree);
  const runtime = options.runtime ?? await currentRuntimeIdentity();
  if (stableStringify(run.runtime) !== stableStringify(runtime)) diagnostics.push({ code: 'RUNTIME_MISMATCH', message: '当前 runtime 与运行固定版本/摘要不一致，只读诊断，不得继续写入' });
  const result: ResumeDiagnostics = { readonly: true, runId, revision: run.revision, worktreeAvailable, lock, fingerprints: 'unknown', git: { head: null, branch: null, index: null, status: null }, diagnostics, actions, integration: 'unknown', tracking: 'unknown', writerLiveness: 'unknown', transactions: [] };
  const pending = (await listTransactions(path.join(repo.runtimeRoot, 'transactions'))).filter(journal => journal.root === run.worktree && !['committed', 'rolled-back'].includes(journal.status));
  for (const journal of pending) {
    diagnostics.push({ code: 'RECOVERY_REQUIRED', message: `未完成事务 ${journal.transactionId}: ${journal.status}`, path: journal.journalPath });
    actions.push(`recover ${journal.transactionId}`);
    try { result.transactions.push(await inspectTransaction(journal.journalPath)); }
    catch (error) { diagnostics.push({ code: 'TRANSACTION_FACTS_UNAVAILABLE', message: String(error), path: journal.journalPath }); }
  }
  if (!worktreeAvailable) diagnostics.push({ code: 'WORKTREE_MISSING', message: '原 worktree 已删除，运行状态仍保留；不能推断 Git/指纹事实' });
  else {
    try {
      const actual = await locateRepository(run.worktree);
      if (actual.root !== run.worktree || actual.commonDir !== repo.commonDir) throw new Error('worktree identity changed');
      result.git.head = (await git(run.worktree, ['rev-parse', '--verify', 'HEAD'])).trim();
      result.git.branch = (await git(run.worktree, ['branch', '--show-current'])).trim();
      result.git.index = await git(run.worktree, ['ls-files', '--stage', '-z']);
      result.git.status = await git(run.worktree, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
      if (result.git.branch !== run.branch) diagnostics.push({ code: 'BRANCH_CHANGED', message: '当前分支与运行快照不同' });
      if (!pending.length && run.formatVersion === 1) {
        result.fingerprints = await captureFingerprints(run.worktree, { runtime });
        if (run.fingerprints) for (const key of ['sourceFingerprint', 'specFingerprint', 'planFingerprint', 'policyFingerprint'] as const) if (run.fingerprints[key] !== result.fingerprints[key]) diagnostics.push({ code: 'INPUT_CHANGED', message: `${key} 已变化，相关证据失效` });
      }
    } catch (error) { diagnostics.push({ code: 'FACTS_UNAVAILABLE', message: String(error) }); }
  }
  if (run.formatVersion !== 1) diagnostics.push({ code: 'UNSUPPORTED_VERSION', message: '未知状态格式，不尝试迁移或写入' });
  diagnostics.push({ code: 'LIVENESS_UNKNOWN', severity: 'warning', message: '尚无宿主停止证据采集；heartbeat/PID 不授权接管，不能自动重派写入者' });
  if (run.fingerprints && diagnostics.some(item => item.code === 'INPUT_CHANGED')) actions.push('revalidate');
  return result;
}
