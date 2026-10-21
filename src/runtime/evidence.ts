import { mkdir, open, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import picomatch from 'picomatch';
import { executeCommand, loadConfig, type CommandResult, type ExecuteOptions, type ValidationCommand } from '../project/index.js';
import { loadChange } from '../spec/index.js';
import { assert, WorkflowError } from '../shared/errors.js';
import { sha256, stableStringify } from '../shared/hash.js';
import { git, locateRepository } from '../repository/git.js';
import { assertNoSymlinkPath, safeId } from './io.js';
import { acquireLock, changeLockPath, releaseLock, requireLock } from './locks.js';
import { captureFingerprints, type FingerprintCapture } from './fingerprints.js';
import { currentRuntimeIdentity, mutateRun, readRun, type RunState, type RuntimeIdentity } from './state.js';
import { assertStoreReadable } from './transactions.js';

export interface CommandBaseline {
  fingerprints: FingerprintCapture; head: string; indexDigest: string;
  environmentDigest: string; testDigest: string; implementationDigest: string;
}
export interface BaselineOptions extends ExecuteOptions { testScopes?: string[]; implementationScopes?: string[] }
export interface RunCommandInput {
  runId: string; owner: string; expectedRevision: number; operationId: string; taskId: string;
  command: ValidationCommand; runtime?: RuntimeIdentity;
  step?: 'baseline' | 'red' | 'green' | 'refactor' | 'verify'; cycleId?: string;
}
export interface StoredCommandEvidence {
  formatVersion: 1; id: string; runId: string; operationId: string; taskId: string;
  runtime: RuntimeIdentity; worktree: string; startedRevision: number; startedAt: string;
  command: ValidationCommand; commandPlanDigest: string; before: CommandBaseline;
  step?: RunCommandInput['step']; cycleId?: string;
  status: 'started' | 'passed' | 'failed' | 'rejected' | 'unknown';
  after?: CommandBaseline; result?: CommandResult; finishedAt?: string;
  rejection?: string;
}
interface SidecarReference { id: string; digest: string }
interface EvidenceLink { formatVersion: 1; started: SidecarReference; completed?: SidecarReference; completionOperationId?: string }
interface BatchReceipt {
  formatVersion: 1; kind: 'task-baseline-completion'; id: string;
  runId: string; operationId: string; taskId: string; runtime: RuntimeIdentity; worktree: string;
  requestDigest: string; operationIds: string[]; commandEvidence: SidecarReference[];
  status: 'passed' | 'failed'; currentFreshness: boolean; currentBaselines: CommandBaseline[];
  completedRevision: number; completedAt: string;
}
type EvidenceLinks = Record<string, EvidenceLink>;
const outputLimit = 64 * 1024;
const sidecarLimit = 32 * 1024 * 1024;
const digestPattern = /^[a-f0-9]{64}$/;
function same(a: unknown, b: unknown): boolean { return stableStringify(a) === stableStringify(b); }
function links(run: RunState): EvidenceLinks {
  const value = run.checkpoints.commandEvidence;
  assert(value === undefined || (!!value && typeof value === 'object' && !Array.isArray(value)), 'EVIDENCE_SCHEMA', '命令证据索引格式无效');
  return (value ?? {}) as EvidenceLinks;
}
function environment(command?: ValidationCommand, options: ExecuteOptions = {}, secrets: string[] = []): NodeJS.ProcessEnv {
  const source = options.env ?? process.env;
  const result: NodeJS.ProcessEnv = {};
  for (const name of options.envAllowlist ?? command?.envAllowlist ?? []) {
    assert(/^[A-Za-z_][A-Za-z0-9_]*$/.test(name), 'CONFIG_INVALID', '环境变量名无效');
    // Credentials for the run writer never become credentials for its subprocess.
    if (/WORKFLOW.*(?:OWNER|OPERATION|TOKEN)|(?:OWNER_TOKEN|OPERATION_ID)$/i.test(name)) continue;
    const value = source[name];
    if (value !== undefined && !secrets.some(secret => secret && value.includes(secret))) result[name] = value;
  }
  return result;
}
/** Read-only CLI baseline entry point. No caller supplied snapshot is accepted as fact. */
export async function observeCommandBaseline(project: string, runtime?: RuntimeIdentity, command?: ValidationCommand, options: BaselineOptions = {}): Promise<CommandBaseline> {
  const fingerprints = await captureFingerprints(project, { runtime: runtime ?? await currentRuntimeIdentity() });
  const scoped = (scopes: string[] | undefined, excludedScopes: string[] = []): string => {
    if (!scopes) return sha256(stableStringify(fingerprints.manifests.source));
    const match = picomatch(scopes, { dot: true });
    const excluded = picomatch(excludedScopes, { dot: true });
    return sha256(stableStringify(fingerprints.manifests.source.filter(entry => match(entry.path) && !excluded(entry.path))));
  };
  return { fingerprints, head: (await git(project, ['rev-parse', '--verify', 'HEAD'])).trim(), indexDigest: sha256(await git(project, ['ls-files', '--stage', '-z'])), environmentDigest: sha256(stableStringify({ executable: command?.executable ?? null, cwd: command?.cwd ?? null, environment: environment(command, options) })), testDigest: scoped(options.testScopes), implementationDigest: scoped(options.implementationScopes, options.testScopes) };
}
async function evidenceDirectory(project: string, run: RunState): Promise<string> {
  return path.join((await locateRepository(project)).runtimeRoot, 'runs', safeId(run.changeId), safeId(run.runId), 'command-evidence');
}
async function writeEvidence(project: string, run: RunState, evidence: StoredCommandEvidence | BatchReceipt): Promise<SidecarReference> {
  const directory = await evidenceDirectory(project, run);
  const filename = path.join(directory, `${safeId(evidence.id)}.json`);
  await assertNoSymlinkPath(filename); await mkdir(directory, { recursive: true });
  const content = JSON.stringify(evidence) + '\n';
  assert(Buffer.byteLength(content) <= sidecarLimit, 'EVIDENCE_CAPACITY_EXCEEDED', '证据副文件超出 32 MiB 容量上限，挂起并保留现场', 5);
  const handle = await open(filename, 'wx', 0o400);
  try { await handle.writeFile(content); await handle.sync(); } finally { await handle.close(); }
  const parent = await open(directory, 'r'); try { await parent.sync(); } finally { await parent.close(); }
  return { id: evidence.id, digest: sha256(content) };
}
async function readSidecar(project: string, run: RunState, reference: SidecarReference): Promise<unknown> {
  assert(reference && typeof reference.id === 'string' && digestPattern.test(reference.digest), 'EVIDENCE_SCHEMA', '证据引用无效');
  const filename = path.join(await evidenceDirectory(project, run), `${safeId(reference.id)}.json`);
  await assertNoSymlinkPath(filename);
  assert((await stat(filename)).size <= sidecarLimit, 'EVIDENCE_CAPACITY_EXCEEDED', '证据副文件超出安全读取容量', 5);
  const bytes = await readFile(filename);
  assert(sha256(bytes) === reference.digest, 'EVIDENCE_TAMPERED', '证据副文件摘要与 run 索引不同');
  try { return JSON.parse(bytes.toString('utf8')); } catch { throw new WorkflowError('EVIDENCE_SCHEMA', '证据不是合法 JSON'); }
}
async function recheck(project: string, input: RunCommandInput, revision?: number): Promise<RunState> {
  const repo = await locateRepository(project); await assertStoreReadable(repo.root);
  const run = await readRun(project, input.runId);
  assert(run.formatVersion === 1, 'UNSUPPORTED_VERSION', '未知 run 格式');
  assert(run.worktree === repo.root, 'WORKTREE_MISMATCH', '命令必须在原 worktree 执行', 4);
  assert(run.branch === (await git(repo.root, ['branch', '--show-current'])).trim(), 'BRANCH_CHANGED', '运行分支已经改变', 4);
  assert(run.owner === input.owner, 'OWNER_CONFLICT', '命令 owner 与 run 不同', 4);
  await requireLock(await changeLockPath(project, run.changeId), input.owner);
  assert(same(run.runtime, input.runtime ?? await currentRuntimeIdentity()), 'RUNTIME_MISMATCH', '证据 runtime 与 run 不同');
  assert(revision === undefined || run.revision === revision, 'STATE_CONFLICT', '命令运行期间 revision 已改变', 4);
  return run;
}
async function declaredTaskCommands(project: string, run: RunState, taskId: string): Promise<{ commands: ValidationCommand[]; testScopes: string[]; implementationScopes: string[] }> {
  const config = await loadConfig(project); const bundle = await loadChange(project, run.changeId);
  assert(bundle.tasks && bundle.tasks.diagnostics.length === 0, 'COMMAND_TASK_PLAN_INVALID', '任务计划不存在或格式错误', 3);
  const task = bundle.tasks.tasks.find(value => value.id === taskId);
  assert(task && task.testCommands.length > 0, 'COMMAND_TASK_NOT_FOUND', '任务不存在或未声明验证命令', 3);
  const commands = task.testCommands.map(id => {
    const matches = config.validation.commands.filter(command => command.id === id);
    assert(matches.length === 1, 'COMMAND_NOT_DECLARED', `任务命令未在项目中唯一声明: ${id}`, 3);
    return matches[0]!;
  });
  return { commands, testScopes: task.testScopes, implementationScopes: task.writeScopes.filter(scope => !task.testScopes.includes(scope)) };
}
/** Execute only here; the durable index has no import/append API. A started operation is never replayed. */
export async function executeRunCommand(project: string, input: RunCommandInput, options: BaselineOptions = {}): Promise<{ run: RunState; evidence: StoredCommandEvidence }> {
  input = structuredClone(input); options = structuredClone(options);
  safeId(input.operationId); safeId(input.taskId); if (input.cycleId) safeId(input.cycleId);
  assert(!stableStringify(input.command).includes(input.owner), 'COMMAND_CREDENTIAL_EXPOSURE', '命令参数不得包含 owner 凭据');
  const initial = await recheck(project, input, input.expectedRevision);
  const plan = await declaredTaskCommands(project, initial, input.taskId);
  assert(plan.commands.some(command => same(command, input.command)), 'COMMAND_NOT_DECLARED', '命令内容与当前任务声明计划不同', 3);
  assert(!options.envAllowlist || options.envAllowlist.every(name => input.command.envAllowlist.includes(name)), 'COMMAND_ENV_NOT_DECLARED', '执行环境不得扩展声明的 envAllowlist', 3);
  assert(!initial.operations[input.operationId] && !links(initial)[input.operationId], 'EVIDENCE_OPERATION_USED', 'operation-id 已占用；中断结果不能重试补造历史，必须重新采集', 4);
  const repo = await locateRepository(project);
  const executionLock = path.join(repo.runtimeRoot, 'locks', `command-${safeId(input.runId)}.lock`);
  const lockOwner = randomUUID();
  await acquireLock(executionLock, { owner: lockOwner, sessionId: 'command-evidence' });
  try {
    await recheck(project, input, input.expectedRevision);
    const runtime = input.runtime ?? await currentRuntimeIdentity();
    // Keep a private argv/env copy; caller mutation never changes an execution in flight.
    const command = structuredClone(input.command);
    const env = environment(command, options, [input.owner, input.operationId, lockOwner]);
    const executionOptions: BaselineOptions = { ...structuredClone(options), testScopes: plan.testScopes, implementationScopes: plan.implementationScopes, env, envAllowlist: Object.keys(env), maxOutputBytes: Math.min(options.maxOutputBytes ?? outputLimit, outputLimit) };
    const before = await observeCommandBaseline(project, runtime, command, executionOptions);
    const currentPlan = await declaredTaskCommands(project, initial, input.taskId);
    assert(currentPlan.commands.some(value => same(value, command)) && same(currentPlan.testScopes, plan.testScopes) && same(currentPlan.implementationScopes, plan.implementationScopes), 'COMMAND_PLAN_CHANGED', '采集开始前任务命令计划已经改变', 3);
    const started: StoredCommandEvidence = { formatVersion: 1, id: `command-${randomUUID()}`, runId: input.runId, operationId: input.operationId, taskId: input.taskId, runtime, worktree: repo.root, startedRevision: input.expectedRevision + 1, startedAt: new Date().toISOString(), command, commandPlanDigest: sha256(stableStringify(command)), before, step: input.step, cycleId: input.cycleId, status: 'started' };
    const startReference = await writeEvidence(project, initial, started);
    let run = await mutateRun(project, input.runId, { owner: input.owner, expectedRevision: input.expectedRevision, operationId: input.operationId, runtime, input: { commandEvidence: startReference } }, draft => {
      const index = links(draft); assert(!index[input.operationId], 'EVIDENCE_OPERATION_USED', 'operation-id 已占用');
      draft.checkpoints.commandEvidence = { ...index, [input.operationId]: { formatVersion: 1, started: startReference } };
    });
    const completed: StoredCommandEvidence = { ...started, id: `command-${randomUUID()}`, status: 'unknown' };
    try {
      await recheck(project, input, run.revision);
      completed.result = await executeCommand(repo.root, command, executionOptions);
      for (const stream of ['stdout', 'stderr'] as const) {
        if (Buffer.byteLength(completed.result[stream]) > outputLimit) {
          completed.result[stream] = Buffer.from(completed.result[stream]).subarray(0, outputLimit).toString('utf8');
          completed.result[`${stream}Truncated`] = true;
        }
      }
      completed.finishedAt = completed.result.finishedAt;
      completed.after = await observeCommandBaseline(project, runtime, command, executionOptions);
      await recheck(project, input, run.revision);
      if (!same(before, completed.after)) { completed.status = 'rejected'; completed.rejection = 'COMMAND_INPUT_CHANGED'; }
      else if (completed.result.timedOut || completed.result.signal || completed.result.exitCode === null) { completed.status = 'rejected'; completed.rejection = 'COMMAND_ABNORMAL_EXIT'; }
      else completed.status = completed.result.exitCode === 0 ? 'passed' : 'failed';
    } catch (error) {
      completed.finishedAt = new Date().toISOString(); completed.status = 'rejected';
      completed.rejection = error instanceof WorkflowError ? error.code : 'COMMAND_OBSERVATION_FAILED';
    }
    const completedReference = await writeEvidence(project, initial, completed);
    // A changed writer identity/revision cannot adopt this result. The immutable orphan
    // remains diagnostic material, while the trusted index deliberately stays started.
    const completionOperationId = `command-finish-${randomUUID()}`;
    run = await mutateRun(project, input.runId, { owner: input.owner, expectedRevision: run.revision, operationId: completionOperationId, runtime, input: { commandEvidence: completedReference } }, draft => {
      const index = links(draft); assert(same(index[input.operationId]?.started, startReference) && !index[input.operationId]?.completed, 'EVIDENCE_LINK_CHANGED', '证据索引已改变');
      draft.checkpoints.commandEvidence = { ...index, [input.operationId]: { ...index[input.operationId], completed: completedReference, completionOperationId } };
    });
    return { run, evidence: completed };
  } finally { await releaseLock(executionLock, lockOwner); }
}
export type TaskBaselineInput = Omit<RunCommandInput, 'command' | 'step' | 'cycleId'>;
export interface TaskBaselineResult { run: RunState; evidence: StoredCommandEvidence[]; operationIds: string[]; status: 'passed' | 'failed'; historical: boolean; currentFreshness: boolean }
async function batchCurrentFreshness(project: string, input: TaskBaselineInput, runtime: RuntimeIdentity, plan: Awaited<ReturnType<typeof declaredTaskCommands>>, evidence: StoredCommandEvidence[], options: BaselineOptions): Promise<{ currentFreshness: boolean; currentBaselines: CommandBaseline[] }> {
  const currentBaselines: CommandBaseline[] = [];
  for (let index = 0; index < plan.commands.length; index++) {
    const command = plan.commands[index]!;
    const env = environment(command, options, [input.owner, input.operationId]);
    const current = await observeCommandBaseline(project, runtime, command, { ...options, env, envAllowlist: Object.keys(env), testScopes: plan.testScopes, implementationScopes: plan.implementationScopes });
    currentBaselines.push(current);
  }
  return { currentFreshness: currentBaselines.every((current, index) => same(current, evidence[index]?.after)), currentBaselines };
}
function baselineCommandsPassed(evidence: StoredCommandEvidence[]): boolean {
  return evidence.length > 0 && evidence.every(value => value.status === 'passed') && evidence.every(value => same(value.before.fingerprints, evidence[0]!.before.fingerprints) && value.before.head === evidence[0]!.before.head && value.before.indexDigest === evidence[0]!.before.indexDigest);
}
/** Atomically reserves the whole batch before any command; an interrupted batch cannot be replayed. */
export async function executeTaskBaseline(project: string, input: TaskBaselineInput, options: BaselineOptions = {}): Promise<TaskBaselineResult> {
  input = structuredClone(input); options = structuredClone(options);
  safeId(input.operationId); safeId(input.taskId);
  const initial = await recheck(project, { ...input, command: {} as ValidationCommand });
  const plan = await declaredTaskCommands(project, initial, input.taskId);
  const runtime = input.runtime ?? await currentRuntimeIdentity();
  const requestDigest = sha256(stableStringify({ taskId: input.taskId, expectedRevision: input.expectedRevision, runtime, commands: plan.commands, testScopes: plan.testScopes, implementationScopes: plan.implementationScopes, maxOutputBytes: Math.min(options.maxOutputBytes ?? outputLimit, outputLimit), environments: plan.commands.map(command => environment(command, options, [input.owner, input.operationId])) }));
  type BatchRecord = { formatVersion: 1; taskId: string; status: 'started' | 'passed' | 'failed'; operationIds: string[]; requestDigest: string; completionOperationId?: string; completion?: SidecarReference; currentFreshness?: boolean };
  const previous = (initial.checkpoints.taskBaselines as Record<string, BatchRecord> | undefined)?.[input.operationId];
  if (initial.operations[input.operationId]) {
    assert(previous && previous.formatVersion === 1 && previous.requestDigest === requestDigest, 'OPERATION_CONFLICT', 'baseline operation-id 已用于不同请求或命令/环境计划已变化', 4);
    assert(Array.isArray(previous.operationIds) && previous.operationIds.every(value => typeof value === 'string') && initial.operations[input.operationId]!.revision === input.expectedRevision + 1 && initial.operations[input.operationId]!.inputHash === sha256(stableStringify({ expectedRevision: input.expectedRevision, input: { taskId: input.taskId, commands: plan.commands, operationIds: previous.operationIds, requestDigest } })), 'EVIDENCE_LINK_CHANGED', 'baseline 预留索引未绑定已提交 operation');
    assert(previous.status !== 'started', 'EVIDENCE_OPERATION_USED', 'baseline 尚未完成，必须用新的 operation-id 重新采集', 4);
    const evidence = await Promise.all(previous.operationIds.map(operationId => loadCommandEvidence(project, input.runId, operationId, { runtime })));
    assert(evidence.length === plan.commands.length && evidence.every((value, index) => value.taskId === input.taskId && value.step === 'baseline' && same(value.command, plan.commands[index]) && value.status !== 'started' && value.status !== 'unknown'), 'EVIDENCE_LINK_CHANGED', 'baseline 批次证据关联不完整');
    const finalOperation = previous.completionOperationId && initial.operations[previous.completionOperationId];
    const finalExpectedRevision = input.expectedRevision + 1 + 2 * plan.commands.length;
    assert(previous.completion && finalOperation && finalOperation.revision === finalExpectedRevision + 1 && finalOperation.inputHash === sha256(stableStringify({ expectedRevision: finalExpectedRevision, input: { operationIds: previous.operationIds, requestDigest, completion: previous.completion } })), 'EVIDENCE_LINK_CHANGED', 'baseline 完成索引未绑定已提交 operation');
    const value = await readSidecar(project, initial, previous.completion);
    assert(value && typeof value === 'object' && !Array.isArray(value), 'EVIDENCE_SCHEMA', '批次完成回执必须为对象');
    const receipt = value as BatchReceipt;
    assert(receipt.formatVersion === 1 && receipt.kind === 'task-baseline-completion' && receipt.id === previous.completion.id && receipt.runId === input.runId && receipt.operationId === input.operationId && receipt.taskId === input.taskId && receipt.worktree === initial.worktree && same(receipt.runtime, runtime) && receipt.requestDigest === requestDigest && same(receipt.operationIds, previous.operationIds) && receipt.completedRevision === finalExpectedRevision + 1 && Number.isFinite(Date.parse(receipt.completedAt)) && ['passed', 'failed'].includes(receipt.status) && typeof receipt.currentFreshness === 'boolean' && Array.isArray(receipt.currentBaselines) && receipt.currentBaselines.length === evidence.length, 'EVIDENCE_SCHEMA', '批次完成回执格式或绑定无效');
    const references = previous.operationIds.map(operationId => links(initial)[operationId]?.completed);
    assert(same(receipt.commandEvidence, references), 'EVIDENCE_LINK_CHANGED', '批次回执与子命令副文件引用不同');
    // Reuse the complete command schema to validate every captured conclusion snapshot.
    for (let index = 0; index < receipt.currentBaselines.length; index++) schema({ ...evidence[index], status: 'rejected', after: receipt.currentBaselines[index], rejection: 'RECEIPT_SCHEMA_CHECK' });
    const receiptFreshness = receipt.currentBaselines.every((current, index) => same(current, evidence[index]?.after));
    const receiptStatus = baselineCommandsPassed(evidence) && receiptFreshness ? 'passed' : 'failed';
    assert(receipt.currentFreshness === receiptFreshness && receipt.status === receiptStatus && previous.status === receipt.status && previous.currentFreshness === receipt.currentFreshness, 'EVIDENCE_TAMPERED', '批次完成结论与不可覆写回执或子命令结果不一致');
    const { currentFreshness } = await batchCurrentFreshness(project, input, runtime, plan, evidence, options);
    return { run: initial, evidence, operationIds: previous.operationIds, status: receipt.status, historical: true, currentFreshness };
  }
  assert(initial.revision === input.expectedRevision, 'STATE_CONFLICT', 'baseline revision 已改变', 4);
  const operationIds = plan.commands.map(() => `baseline-command-${randomUUID()}`);
  let run = await mutateRun(project, input.runId, { owner: input.owner, expectedRevision: input.expectedRevision, operationId: input.operationId, runtime: input.runtime, input: { taskId: input.taskId, commands: plan.commands, operationIds, requestDigest } }, draft => {
    const current = (draft.checkpoints.taskBaselines ?? {}) as Record<string, unknown>;
    draft.checkpoints.taskBaselines = { ...current, [input.operationId]: { formatVersion: 1, taskId: input.taskId, status: 'started', operationIds, requestDigest } };
  });
  const evidence: StoredCommandEvidence[] = [];
  for (let index = 0; index < plan.commands.length; index++) {
    const command = plan.commands[index]!;
    const env = environment(command, options, [input.owner, input.operationId]);
    const result = await executeRunCommand(project, { ...input, expectedRevision: run.revision, operationId: operationIds[index]!, command, step: 'baseline' }, { ...options, env, envAllowlist: Object.keys(env) });
    run = result.run; evidence.push(result.evidence);
  }
  const conclusion = await batchCurrentFreshness(project, input, runtime, plan, evidence, options);
  const status: TaskBaselineResult['status'] = baselineCommandsPassed(evidence) && conclusion.currentFreshness ? 'passed' : 'failed';
  const receipt: BatchReceipt = { formatVersion: 1, kind: 'task-baseline-completion', id: `baseline-receipt-${randomUUID()}`, runId: input.runId, operationId: input.operationId, taskId: input.taskId, runtime, worktree: run.worktree, requestDigest, operationIds, commandEvidence: operationIds.map(operationId => links(run)[operationId]!.completed!), status, ...conclusion, completedRevision: run.revision + 1, completedAt: new Date().toISOString() };
  const completion = await writeEvidence(project, run, receipt);
  const completionOperationId = `baseline-finish-${randomUUID()}`;
  run = await mutateRun(project, input.runId, { owner: input.owner, expectedRevision: run.revision, operationId: completionOperationId, runtime: input.runtime, input: { operationIds, requestDigest, completion } }, async draft => {
    // A command's after snapshot predates its completed-state write. Re-observe under
    // the final CAS lock so changes in that completion window cannot become a fresh batch.
    const current = await batchCurrentFreshness(project, input, runtime, plan, evidence, options);
    assert(same(current, conclusion), 'COMMAND_INPUT_CHANGED', '完成回执写入后输入又发生变化，保持批次未完成并要求重新采集', 3);
    const batches = draft.checkpoints.taskBaselines as Record<string, unknown>;
    draft.checkpoints.taskBaselines = { ...batches, [input.operationId]: { formatVersion: 1, taskId: input.taskId, status, operationIds, requestDigest, completionOperationId, completion, currentFreshness: conclusion.currentFreshness } };
  });
  return { run, evidence, operationIds, status, historical: false, currentFreshness: conclusion.currentFreshness };
}
function schema(value: unknown): asserts value is StoredCommandEvidence {
  assert(!!value && typeof value === 'object' && !Array.isArray(value), 'EVIDENCE_SCHEMA', '证据必须为对象');
  const e = value as StoredCommandEvidence;
  assert(e.formatVersion === 1 && ['started', 'passed', 'failed', 'rejected', 'unknown'].includes(e.status), 'EVIDENCE_SCHEMA', '未知命令证据版本或状态');
  for (const field of ['id', 'runId', 'operationId', 'taskId', 'worktree', 'startedAt', 'commandPlanDigest'] as const) assert(typeof e[field] === 'string' && e[field].length > 0, 'EVIDENCE_SCHEMA', `证据字段无效: ${field}`);
  safeId(e.id); safeId(e.runId); safeId(e.operationId); safeId(e.taskId);
  assert(Number.isSafeInteger(e.startedRevision) && e.startedRevision > 0 && Number.isFinite(Date.parse(e.startedAt)), 'EVIDENCE_SCHEMA', '证据 revision/时间无效');
  const text = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && !v.includes('\0');
  const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every(text);
  assert(e.runtime && text(e.runtime.version) && digestPattern.test(e.runtime.sha256), 'EVIDENCE_SCHEMA', 'runtime 摘要无效');
  assert(e.command && text(e.command.id) && text(e.command.executable) && text(e.command.cwd) && Array.isArray(e.command.args) && e.command.args.every(v => typeof v === 'string' && !v.includes('\0')) && strings(e.command.modules) && strings(e.command.artifacts) && strings(e.command.envAllowlist) && Number.isSafeInteger(e.command.timeoutSeconds) && e.command.timeoutSeconds > 0 && e.commandPlanDigest === sha256(stableStringify(e.command)), 'EVIDENCE_SCHEMA', '命令计划摘要无效');
  for (const baseline of [e.before, ...(e.after ? [e.after] : [])]) {
    assert(baseline && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(baseline.head) && digestPattern.test(baseline.indexDigest) && digestPattern.test(baseline.environmentDigest) && digestPattern.test(baseline.testDigest) && digestPattern.test(baseline.implementationDigest), 'EVIDENCE_SCHEMA', '命令快照无效');
    const f = baseline.fingerprints;
    assert(f && ['sourceFingerprint', 'specFingerprint', 'planFingerprint', 'policyFingerprint'].every(k => digestPattern.test(f[k as keyof FingerprintCapture] as string)), 'EVIDENCE_SCHEMA', '输入指纹无效');
    for (const group of ['source', 'spec', 'plan', 'policy'] as const) assert(Array.isArray(f.manifests?.[group]) && f.manifests[group].every(entry => entry && text(entry.path) && ['file', 'symlink'].includes(entry.type) && digestPattern.test(entry.sha256) && (entry.executable === undefined || typeof entry.executable === 'boolean')) && f[`${group}Fingerprint`] === sha256(stableStringify(f.manifests[group])), 'EVIDENCE_SCHEMA', '输入 manifest 摘要无效');
  }
  if (e.result) assert(e.result.commandId === e.command.id && same(e.result.args, e.command.args) && e.result.executable === e.command.executable && e.result.cwd === e.command.cwd && Number.isFinite(Date.parse(e.result.startedAt)) && Date.parse(e.result.finishedAt) >= Date.parse(e.result.startedAt) && typeof e.result.stdout === 'string' && typeof e.result.stderr === 'string' && Buffer.byteLength(e.result.stdout) <= outputLimit + 32 && Buffer.byteLength(e.result.stderr) <= outputLimit + 32 && digestPattern.test(e.result.stdoutSha256) && digestPattern.test(e.result.stderrSha256) && Number.isSafeInteger(e.result.stdoutBytes) && e.result.stdoutBytes >= 0 && Number.isSafeInteger(e.result.stderrBytes) && e.result.stderrBytes >= 0 && typeof e.result.stdoutTruncated === 'boolean' && typeof e.result.stderrTruncated === 'boolean' && strings(e.result.environmentNames) && typeof e.result.timedOut === 'boolean' && (e.result.signal === null || text(e.result.signal)) && (e.result.exitCode === null || Number.isSafeInteger(e.result.exitCode)), 'EVIDENCE_SCHEMA', '命令结果无效');
  if (e.status === 'started') assert(!e.after && !e.result && !e.finishedAt && !e.rejection, 'EVIDENCE_SCHEMA', 'started 不能夹带完成结果');
  else assert(e.finishedAt && Date.parse(e.finishedAt) >= Date.parse(e.startedAt), 'EVIDENCE_SCHEMA', '完成证据缺少有效结束时间');
  if (e.status === 'rejected') assert(text(e.rejection), 'EVIDENCE_SCHEMA', '拒收证据缺少诊断');
  if (e.status === 'passed' || e.status === 'failed') assert(e.result && e.after && same(e.before, e.after) && !e.result.timedOut && !e.result.signal && e.result.exitCode !== null && (e.status === 'passed' ? e.result.exitCode === 0 : e.result.exitCode !== 0), 'EVIDENCE_SCHEMA', '命令状态与结果不一致');
}
/** Validates durable provenance, not current freshness or Red semantics. Never approves a phase. */
export async function loadCommandEvidence(project: string, runId: string, operationId: string, options: { runtime?: RuntimeIdentity } = {}): Promise<StoredCommandEvidence> {
  safeId(operationId); const repo = await locateRepository(project); await assertStoreReadable(repo.root);
  const run = await readRun(project, runId);
  assert(run.formatVersion === 1 && run.worktree === repo.root, 'WORKTREE_MISMATCH', '证据必须在原 worktree 读取');
  const runtime = options.runtime ?? await currentRuntimeIdentity();
  assert(same(run.runtime, runtime), 'RUNTIME_MISMATCH', '运行固定 runtime 与当前版本不同');
  const link = links(run)[operationId];
  assert(link && link.formatVersion === 1 && run.operations[operationId], 'EVIDENCE_NOT_FOUND', 'run 未关联该执行证据');
  const read = async (reference: SidecarReference): Promise<StoredCommandEvidence> => {
    assert(reference && typeof reference.id === 'string' && digestPattern.test(reference.digest), 'EVIDENCE_SCHEMA', '证据引用无效');
    const filename = path.join(await evidenceDirectory(project, run), `${safeId(reference.id)}.json`);
    await assertNoSymlinkPath(filename);
    assert((await stat(filename)).size <= sidecarLimit, 'EVIDENCE_CAPACITY_EXCEEDED', '证据副文件超出安全读取容量', 5);
    const bytes = await readFile(filename);
    assert(sha256(bytes) === reference.digest, 'EVIDENCE_TAMPERED', '证据副文件摘要与 run 索引不同');
    let value: unknown; try { value = JSON.parse(bytes.toString('utf8')); } catch { throw new WorkflowError('EVIDENCE_SCHEMA', '证据不是合法 JSON'); }
    schema(value);
    assert(value.id === reference.id && value.runId === run.runId && value.operationId === operationId && value.worktree === run.worktree && same(value.runtime, runtime), 'EVIDENCE_LINK_CHANGED', '证据绑定与 run 不同');
    return value;
  };
  const started = await read(link.started);
  assert(started.status === 'started' && started.startedRevision === run.operations[operationId]!.revision && started.startedRevision <= run.revision, 'EVIDENCE_LINK_CHANGED', 'started 记录不匹配已提交 operation');
  assert(run.operations[operationId]!.inputHash === sha256(stableStringify({ expectedRevision: started.startedRevision - 1, input: { commandEvidence: link.started } })), 'EVIDENCE_LINK_CHANGED', 'started 引用未由关联 operation 提交');
  if (!link.completed) return started;
  const completed = await read(link.completed);
  const { id: _completedId, status: _completedStatus, after: _after, result: _result, finishedAt: _finishedAt, rejection: _rejection, ...completedBase } = completed;
  const { id: _startedId, status: _startedStatus, ...startedBase } = started;
  assert(completed.status !== 'started' && same(startedBase, completedBase), 'EVIDENCE_LINK_CHANGED', '完成记录改变了执行开始时的输入');
  const operation = link.completionOperationId && run.operations[link.completionOperationId];
  assert(operation && operation.revision === completed.startedRevision + 1 && operation.inputHash === sha256(stableStringify({ expectedRevision: completed.startedRevision, input: { commandEvidence: link.completed } })), 'EVIDENCE_LINK_CHANGED', '完成引用未由关联 operation 提交');
  return completed;
}
