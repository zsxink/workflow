import { mkdir, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { assert, type Diagnostic } from '../shared/errors.js';
import { sha256, stableStringify } from '../shared/hash.js';
import { locateRepository, git } from '../repository/git.js';
import { atomicWrite, exists, readJson, safeId, assertNoSymlinkPath } from './io.js';
import { acquireChangeLock, changeLockPath, requireLock, withLockGuard, releaseChangeLock } from './locks.js';
import { captureFingerprints, type FingerprintGroup } from './fingerprints.js';

// Direct source consumers bind the entire source tree, not just state.ts. Distributed
// CLI callers provide the actual bundled runtime identity instead.
export async function currentRuntimeIdentity(): Promise<RuntimeIdentity> {
  const modulePath = fileURLToPath(import.meta.url);
  if (path.basename(path.dirname(modulePath)) !== 'runtime' || !/^state\.[cm]?[jt]s$/.test(path.basename(modulePath))) return { version: '0.1.0-preview.1', sha256: sha256(await readFile(modulePath)) };
  const sourceRoot = fileURLToPath(new URL('../', import.meta.url));
  const entries: { path: string; sha256: string }[] = [];
  async function walk(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const filename = path.join(directory, entry.name);
      await assertNoSymlinkPath(filename);
      if (entry.isDirectory()) await walk(filename);
      else if (entry.isFile()) entries.push({ path: path.relative(sourceRoot, filename).split(path.sep).join('/'), sha256: sha256(await readFile(filename)) });
      else assert(false, 'UNSUPPORTED_INPUT', '开发运行时源码必须为普通文件');
    }
  }
  await walk(sourceRoot);
  entries.sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)));
  return { version: '0.1.0-preview.1-development', sha256: sha256(stableStringify(entries)) };
}
export interface RuntimeIdentity { version: string; sha256: string; }
export interface Budget { initial: number; used: number; additions: { decisionId: string; amount: number }[]; }
export interface RunState {
  formatVersion: number; revision: number; projectId: string; changeId: string; runId: string; owner: string;
  worktree: string; branch: string; runtime: RuntimeIdentity; phase: string;
  status: 'pending' | 'running' | 'succeeded' | 'failed' | 'suspended';
  previousRunId?: string; fingerprints?: FingerprintGroup; budgets: Record<string, Budget>;
  workflow?: unknown; checkpoints: Record<string, unknown>; decisions: unknown[];
  operations: Record<string, { revision: number; inputHash: string }>;
  history: { revision: number; operationId: string; at: string }[];
  diagnostics?: Diagnostic[];
}
export interface CreateRunInput { changeId: string; owner?: string; sessionId?: string; operationId: string; runtime?: RuntimeIdentity; budgets?: Record<string, number>; previousRunId?: string; projectId?: string; }
export interface MutationInput { owner: string; expectedRevision: number; operationId: string; runtime?: RuntimeIdentity; input?: unknown; }

function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value); }
function integer(value: unknown): value is number { return Number.isSafeInteger(value) && (value as number) >= 0; }
function validRuntime(value: unknown): value is RuntimeIdentity { return record(value) && typeof value.version === 'string' && value.version.length > 0 && typeof value.sha256 === 'string' && /^[a-f0-9]{64}$/.test(value.sha256); }
function validId(value: unknown): value is string { return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/.test(value) && value !== '..'; }
function parseRun(value: unknown, changeId: string, runId: string, validateBudgetUsage = true): RunState {
  const valid = (condition: unknown) => assert(condition, 'STATE_CORRUPT', `运行状态格式损坏: ${changeId}/${runId}`);
  valid(record(value));
  const state = value as Record<string, unknown>;
  valid(integer(state.formatVersion) && state.formatVersion !== 0 && state.changeId === changeId && state.runId === runId);
  if (state.formatVersion !== 1) {
    // Never interpret nested data from a future schema as today's authority. Only
    // the directory-bound identity and numeric revision survive diagnostic reads.
    return { formatVersion: state.formatVersion as number, revision: integer(state.revision) ? state.revision : 0, projectId: '', changeId, runId, owner: '', worktree: '', branch: '', runtime: { version: 'unknown', sha256: '' }, phase: 'unknown', status: 'suspended', budgets: {}, checkpoints: {}, decisions: [], operations: {}, history: [], diagnostics: [{ code: 'UNSUPPORTED_VERSION', message: '未知状态格式，仅暴露诊断标识；不解释嵌套数据或继承预算' }] };
  }
  valid(integer(state.revision) && typeof state.projectId === 'string' && state.projectId.length > 0 && typeof state.owner === 'string' && state.owner.length > 0);
  valid(typeof state.worktree === 'string' && path.isAbsolute(state.worktree) && typeof state.branch === 'string' && validRuntime(state.runtime));
  valid(typeof state.phase === 'string' && ['pending', 'running', 'succeeded', 'failed', 'suspended'].includes(state.status as string));
  valid(state.previousRunId === undefined || validId(state.previousRunId));
  valid(record(state.budgets) && record(state.checkpoints) && Array.isArray(state.decisions) && record(state.operations) && Array.isArray(state.history));
  for (const budget of Object.values(state.budgets as Record<string, unknown>)) {
    valid(record(budget)); const item = budget as Record<string, unknown>;
    valid(integer(item.initial) && integer(item.used) && Array.isArray(item.additions));
    const seen = new Set<string>(); let total = item.initial as number;
    for (const addition of item.additions as unknown[]) {
      valid(record(addition)); const entry = addition as Record<string, unknown>;
      valid(validId(entry.decisionId) && integer(entry.amount) && (entry.amount as number) > 0 && !seen.has(entry.decisionId as string));
      seen.add(entry.decisionId as string); total += entry.amount as number; valid(Number.isSafeInteger(total));
    }
    if (validateBudgetUsage) valid((item.used as number) <= total);
  }
  for (const [id, operation] of Object.entries(state.operations as Record<string, unknown>)) valid(validId(id) && record(operation) && integer(operation.revision) && operation.revision <= (state.revision as number) && typeof operation.inputHash === 'string' && /^[a-f0-9]{64}$/.test(operation.inputHash));
  const history = state.history as unknown[];
  valid(history.length === (state.revision as number) + 1);
  history.forEach((entry, index) => valid(record(entry) && entry.revision === index && validId(entry.operationId) && typeof entry.at === 'string' && Number.isFinite(Date.parse(entry.at)) && (state.operations as Record<string, {revision: number}>)[entry.operationId]?.revision === index));
  if (state.fingerprints !== undefined) valid(record(state.fingerprints) && ['sourceFingerprint', 'specFingerprint', 'planFingerprint', 'policyFingerprint'].every(key => typeof state.fingerprints === 'object' && /^[a-f0-9]{64}$/.test((state.fingerprints as Record<string, string>)[key] ?? '')));
  return state as unknown as RunState;
}

export async function listRuns(project: string, changeId?: string): Promise<RunState[]> {
  const { runtimeRoot } = await locateRepository(project);
  const root = path.join(runtimeRoot, 'runs');
  await assertNoSymlinkPath(root);
  if (!(await exists(root))) return [];
  const changes = changeId ? [safeId(changeId)] : await readdir(root);
  const result: RunState[] = [];
  for (const change of changes) {
    safeId(change);
    await assertNoSymlinkPath(path.join(root, change));
    if (!(await exists(path.join(root, change)))) continue;
    for (const run of await readdir(path.join(root, change))) {
      safeId(run);
      await assertNoSymlinkPath(path.join(root, change, run));
      const filename = path.join(root, change, run, 'state.json');
      if (await exists(filename)) result.push(parseRun(await readJson<unknown>(filename), change, run));
    }
  }
  return result.sort((a, b) => a.runId.localeCompare(b.runId));
}
export async function readRun(project: string, runId: string): Promise<RunState> {
  safeId(runId);
  const matches = (await listRuns(project)).filter(run => run.runId === runId);
  assert(matches.length === 1, 'RUN_NOT_FOUND', `运行记录不存在或不唯一: ${runId}`);
  return matches[0]!;
}
async function statePath(project: string, run: RunState): Promise<string> {
  return path.join((await locateRepository(project)).runtimeRoot, 'runs', safeId(run.changeId), safeId(run.runId), 'state.json');
}
export async function rebuildRunViews(project: string, run: RunState): Promise<void> {
  assert(run.formatVersion === 1, 'UNSUPPORTED_VERSION', '未知 state 格式，只允许诊断');
  const directory = path.dirname(await statePath(project, run));
  await atomicWrite(path.join(directory, 'events.jsonl'), run.history.map(event => JSON.stringify({ ...event, runId: run.runId })).join('\n') + '\n');
  await atomicWrite(path.join(directory, 'progress.md'), `# ${run.changeId}\n\nRun: ${run.runId}\nRevision: ${run.revision}\nPhase: ${run.phase}\nStatus: ${run.status}\n\n本文件从 state.json 派生。\n`);
}
async function save(project: string, run: RunState): Promise<void> {
  await atomicWrite(await statePath(project, run), JSON.stringify(run, null, 2) + '\n');
  // Derived views must never turn a committed state mutation into a reported failure.
  try { await rebuildRunViews(project, run); } catch { /* Rebuildable from committed state. */ }
}
async function noInstall(project: string): Promise<void> {
  const { runtimeRoot } = await locateRepository(project);
  assert(!(await exists(path.join(runtimeRoot, 'locks', 'project-install.lock'))), 'INSTALL_ACTIVE', '安装事务持锁，不能创建或修改运行记录', 4);
}
async function requireRunBinding(project: string, run: RunState, runtime?: RuntimeIdentity): Promise<void> {
  assert(run.formatVersion === 1, 'UNSUPPORTED_VERSION', '未知 state 格式，只允许诊断');
  const repo = await locateRepository(project);
  assert(run.worktree === repo.root, 'WORKTREE_MISMATCH', '写入或重放必须在原 worktree 执行', 4);
  assert((await git(repo.root, ['branch', '--show-current'])).trim() === run.branch, 'BRANCH_CHANGED', '分支与 run 绑定分支不一致', 4);
  assert(stableStringify(run.runtime) === stableStringify(runtime ?? await currentRuntimeIdentity()), 'RUNTIME_MISMATCH', '当前 runtime 与 run 固定版本/摘要不一致');
}
export async function createRun(project: string, input: CreateRunInput): Promise<RunState> {
  const repo = await locateRepository(project);
  const installLock = path.join(repo.runtimeRoot, 'locks/project-install.lock');
  await assertNoSymlinkPath(installLock);
  await mkdir(path.dirname(installLock), { recursive: true });
  return withLockGuard(installLock, () => createRunLocked(project, input));
}
async function createRunLocked(project: string, input: CreateRunInput): Promise<RunState> {
  safeId(input.changeId); safeId(input.operationId);
  await noInstall(project);
  const repo = await locateRepository(project);
  await assertNoSymlinkPath(path.join(repo.runtimeRoot, 'locks'));
  await mkdir(path.join(repo.runtimeRoot, 'locks'), { recursive: true });
  const creationHash = sha256(stableStringify(input));
  const records = await listRuns(project, input.changeId);
  assert(records.every(run => run.formatVersion === 1), 'UNSUPPORTED_VERSION', '存在未知运行格式，不能重放创建或继承预算');
  const existing = records.find(run => run.operations[input.operationId]);
  if (existing) {
    const replayLock = await changeLockPath(project, input.changeId);
    return withLockGuard(replayLock, async () => {
      await requireLock(replayLock, existing.owner);
      await requireRunBinding(project, existing, input.runtime);
      assert(existing.operations[input.operationId]!.inputHash === creationHash, 'OPERATION_CONFLICT', 'operation-id 已用于不同创建请求');
      return existing;
    });
  }
  const owner = input.owner ?? randomUUID();
  const lockPath = await changeLockPath(project, input.changeId);
  let acquired = false;
  if (await exists(lockPath)) await requireLock(lockPath, owner);
  else { await acquireChangeLock(project, input.changeId, { owner, sessionId: input.sessionId }); acquired = true; }
  try { return await withLockGuard(lockPath, async () => {
    await requireLock(lockPath, owner); await noInstall(project);
    const history = await listRuns(project, input.changeId);
    assert(history.every(run => run.formatVersion === 1), 'UNSUPPORTED_VERSION', '未知运行格式不能继承预算');
    const inputHash = sha256(stableStringify(input));
    const replay = history.find(run => run.operations[input.operationId]);
    if (replay) { await requireRunBinding(project, replay, input.runtime); assert(replay.operations[input.operationId]!.inputHash === inputHash && replay.owner === owner, 'OPERATION_CONFLICT', 'operation-id 已用于不同创建请求'); return replay; }
    const previous = history.at(-1);
    assert(!previous || input.previousRunId === previous.runId, 'PREVIOUS_RUN_REQUIRED', '后继运行必须引用最近 run，不能重置预算');
    assert(!previous || ['succeeded', 'failed'].includes(previous.status), 'RUN_ACTIVE', '前一个运行尚未终态');
    let configId = input.projectId;
    await assertNoSymlinkPath(path.join(repo.root, '.workflow/config.yaml'));
    if (!configId && await exists(path.join(repo.root, '.workflow/config.yaml'))) configId = parse(await readFile(path.join(repo.root, '.workflow/config.yaml'), 'utf8'))?.project?.id;
    const budgets: Record<string, Budget> = previous ? structuredClone(previous.budgets) : Object.fromEntries(Object.entries(input.budgets ?? {}).map(([key, initial]) => {
      assert(Number.isSafeInteger(initial) && initial >= 0, 'INVALID_BUDGET', '预算必须为非负整数'); return [key, { initial, used: 0, additions: [] }];
    }));
    if (previous && input.budgets) for (const [key, amount] of Object.entries(input.budgets)) assert(previous.budgets[key]?.initial === amount, 'BUDGET_RESET', '新 run 不得重置或扩充预算');
    const run: RunState = { formatVersion: 1, revision: 0, projectId: configId ?? sha256(repo.commonDir), changeId: input.changeId, runId: `${Date.now()}-${randomUUID()}`, owner, worktree: repo.root, branch: (await git(repo.root, ['branch', '--show-current'])).trim(), runtime: input.runtime ?? await currentRuntimeIdentity(), phase: 'bootstrap', status: 'pending', previousRunId: previous?.runId, budgets, checkpoints: {}, decisions: previous ? structuredClone(previous.decisions) : [], operations: { [input.operationId]: { revision: 0, inputHash } }, history: [{ revision: 0, operationId: input.operationId, at: new Date().toISOString() }] };
    parseRun(run, run.changeId, run.runId);
    const capture = await captureFingerprints(repo.root, { runtime: run.runtime });
    const { manifests, ...fingerprints } = capture;
    run.fingerprints = fingerprints;
    run.checkpoints.bootstrap = { head: (await git(repo.root, ['rev-parse', '--verify', 'HEAD'])).trim(), index: await git(repo.root, ['ls-files', '--stage', '-z']), manifests };
    await save(project, run); return run;
  }); } catch (error) {
    // No host dispatch can happen inside createRun. A freshly acquired lock with no
    // committed state is therefore known to have no attached writer and is safe to release.
    if (acquired) {
      const committed = (await listRuns(project, input.changeId)).some(run => run.operations[input.operationId]);
      if (!committed) await releaseChangeLock(project, input.changeId, owner);
    }
    throw error;
  }
}
export async function mutateRun(project: string, runId: string, input: MutationInput, updater: (draft: RunState) => void | Promise<void>): Promise<RunState> {
  const repo = await locateRepository(project);
  const installLock = path.join(repo.runtimeRoot, 'locks/project-install.lock');
  await assertNoSymlinkPath(installLock);
  await mkdir(path.dirname(installLock), { recursive: true });
  return withLockGuard(installLock, () => mutateRunLocked(project, runId, input, updater));
}
async function mutateRunLocked(project: string, runId: string, input: MutationInput, updater: (draft: RunState) => void | Promise<void>): Promise<RunState> {
  safeId(input.operationId);
  const initial = await readRun(project, runId);
  assert(initial.formatVersion === 1, 'UNSUPPORTED_VERSION', '未知 state 格式，只允许诊断');
  const lockPath = await changeLockPath(project, initial.changeId);
  return withLockGuard(lockPath, async () => {
    await noInstall(project); await requireLock(lockPath, input.owner);
    const run = await readRun(project, runId);
    await requireRunBinding(project, run, input.runtime);
    assert(run.owner === input.owner, 'OWNER_CONFLICT', 'owner 与运行记录不一致', 4);
    const inputHash = sha256(stableStringify({ expectedRevision: input.expectedRevision, input: input.input ?? null }));
    const replay = run.operations[input.operationId];
    if (replay) { assert(replay.inputHash === inputHash, 'OPERATION_CONFLICT', 'operation-id 已用于不同请求'); return run; }
    assert(run.revision === input.expectedRevision, 'STATE_CONFLICT', '运行 revision 已变化', 4);
    const draft = structuredClone(run);
    await updater(draft);
    for (const field of ['formatVersion', 'projectId', 'changeId', 'runId', 'owner', 'worktree', 'branch', 'runtime', 'previousRunId', 'operations', 'history', 'revision'] as const) assert(stableStringify(draft[field]) === stableStringify(run[field]), 'IMMUTABLE_STATE', `不可直接修改 ${field}`);
    parseRun(draft, run.changeId, run.runId, false);
    assert(stableStringify(Object.keys(draft.budgets).sort()) === stableStringify(Object.keys(run.budgets).sort()), 'BUDGET_RESET', '不可新增或删除预算账户');
    assert(draft.decisions.length >= run.decisions.length && stableStringify(draft.decisions.slice(0, run.decisions.length)) === stableStringify(run.decisions), 'DECISION_HISTORY_RESET', '用户决策历史不可覆写');
    for (const [key, budget] of Object.entries(run.budgets)) {
      const next = draft.budgets[key];
      assert(next && next.initial === budget.initial && next.used >= budget.used && Number.isSafeInteger(next.used) && next.additions.length >= budget.additions.length && stableStringify(next.additions.slice(0, budget.additions.length)) === stableStringify(budget.additions), 'BUDGET_RESET', '预算历史不可重置');
      assert(next.additions.length === budget.additions.length, 'BUDGET_AUTHORIZATION_UNVERIFIED', '尚无可信宿主用户决策来源核验，不能凭自报 actor:user 追加预算', 5);
      assert(next.used <= next.initial + next.additions.reduce((sum, item) => sum + item.amount, 0), 'BUDGET_EXHAUSTED', '预算已耗尽');
    }
    draft.revision++;
    draft.operations[input.operationId] = { revision: draft.revision, inputHash };
    draft.history.push({ revision: draft.revision, operationId: input.operationId, at: new Date().toISOString() });
    parseRun(draft, run.changeId, run.runId);
    await save(project, draft); return draft;
  });
}
