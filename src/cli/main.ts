import { readFile, realpath } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { fileURLToPath } from 'node:url';
import { WorkflowError, assert, type Diagnostic } from '../shared/errors.js';
import { sha256 } from '../shared/hash.js';
import { parseArguments, requireFlag, requireWords, allowFlags, type Arguments } from './args.js';
import { changeId, listChanges, newChange } from './changes.js';
import { loadChange, validateChange, traceChange, planSync } from '../spec/index.js';
import { loadConfig, pathMatches, resolveProjectPath } from '../project/index.js';
import { initProject, doctor, planUpgrade, planUninstall, applyInstallPlan, replayInstallOperation, type InstallPlan } from '../installer/index.js';
import { createRun, readRun, listRuns, assertStoreReadable, heartbeatChangeLock, mutateRun, resumePlan, locateRepository, captureFingerprints } from '../runtime/index.js';
import { git } from '../repository/git.js';
import { resolveBaseRef, assertChangeBranch } from '../repository/base.js';
import { prepareRunDispatch, collectRunDispatch } from '../application/dispatch.js';
import type { Role } from '../workflow/index.js';
import { executeTaskBaseline, loadCommandEvidence, type StoredCommandEvidence } from '../runtime/evidence.js';
import { previewRebaseline } from '../application/rebaseline.js';

declare const __WORKFLOW_VERSION__: string;
const version = typeof __WORKFLOW_VERSION__ === 'undefined' ? '0.1.0-preview.1' : __WORKFLOW_VERSION__;

async function selectHosts(): Promise<string[]> {
  if (!stdin.isTTY || !stdout.isTTY) return ['codex'];
  const prompt = createInterface({ input: stdin, output: stdout });
  try {
    const answer = (await prompt.question('选择要支持的宿主：\n  1) Codex\n  2) Claude\n  3) Codex + Claude\n请输入 1、2 或 3 [默认 1]：')).trim();
    if (!answer || answer === '1' || answer.toLowerCase() === 'codex') return ['codex'];
    if (answer === '2' || answer.toLowerCase() === 'claude') return ['claude'];
    if (answer === '3' || answer.toLowerCase() === 'codex,claude') return ['codex', 'claude'];
    throw new WorkflowError('CLI_ARGUMENT', '请输入 1、2、3，或 codex、claude、codex,claude。');
  } finally { prompt.close(); }
}

const help = `Workflow ${version} — 受限预览 / Node.js 22.12+

已实现的 CLI：
  init [--hosts codex|claude|codex,claude] [--dry-run]
  doctor
  upgrade|uninstall [--apply --plan-digest HASH --operation-id ID]
  change new ID --operation-id ID
  change list
  change rebaseline ID --run ID
  validate ID [--gate draft|spec|integration]
  trace ID
  sync ID
  run init ID --operation-id ID
  status ID [--run ID]
  resume-plan ID --run ID
  lock heartbeat ID --run ID --owner TOKEN --expected-revision N --operation-id ID
  dispatch prepare ID --task TASK-ID --role ROLE --run ID --owner TOKEN --expected-revision N --operation-id ID
  dispatch collect ID --dispatch ID --attempt ID --report PATH --run ID --owner TOKEN --expected-revision N --operation-id ID
  test-cycle baseline ID --task TASK-ID --run ID --owner TOKEN --expected-revision N --operation-id ID
  evidence show ID --run ID --operation-id COMMAND-OPERATION-ID

通用选项：--project PATH --json --help --version
安装器保留用户文件，upgrade/uninstall 默认只输出计划。
宿主执行尚未验收：授权、真实派发、阶段成功、归档及集成入口会阻断。
不会调用模型、启动 Agent CLI 或自动提交、推送、合并。
`;

interface Outcome { data: unknown; diagnostics?: Diagnostic[]; exitCode?: number }

function planSummary(plan: InstallPlan) {
  return { formatVersion: plan.formatVersion, operation: plan.operation, planId: plan.planId, planDigest: plan.digest, applicable: plan.applicable, projectRoot: plan.projectRoot, packageVersion: plan.packageVersion, changes: plan.changes.map(({ content, ...entry }) => ({ ...entry, outputBytes: content === null ? 0 : Buffer.from(content, 'base64').length })), diagnostics: plan.diagnostics };
}

function evidenceSummary(evidence: StoredCommandEvidence) {
  return { id: evidence.id, runId: evidence.runId, taskId: evidence.taskId, operationId: evidence.operationId, commandId: evidence.command.id, step: evidence.step, status: evidence.status, startedAt: evidence.startedAt, finishedAt: evidence.finishedAt, head: evidence.before.head, inputFingerprints: { sourceFingerprint: evidence.before.fingerprints.sourceFingerprint, specFingerprint: evidence.before.fingerprints.specFingerprint, planFingerprint: evidence.before.fingerprints.planFingerprint, policyFingerprint: evidence.before.fingerprints.policyFingerprint }, commandPlanDigest: evidence.commandPlanDigest, exitCode: evidence.result?.exitCode ?? null, timedOut: evidence.result?.timedOut ?? false, stdoutSha256: evidence.result?.stdoutSha256, stderrSha256: evidence.result?.stderrSha256, truncated: evidence.result ? evidence.result.stdoutTruncated || evidence.result.stderrTruncated : false, rejection: evidence.rejection };
}

async function checkedProject(args: Arguments): Promise<string> {
  const root = await realpath(args.project);
  const repo = await locateRepository(root);
  assert(root === repo.root, 'PROJECT_ROOT', '--project must select the Git worktree root');
  return root;
}

async function runForChange(root: string, args: Arguments, id: string) {
  const run = await readRun(root, requireFlag(args, 'run'));
  assert(run.changeId === id, 'RUN_CHANGE_MISMATCH', 'Run does not belong to the selected change');
  return run;
}

async function writeCredentials(args: Arguments) {
  const expectedRevision = Number(requireFlag(args, 'expected-revision'));
  assert(Number.isSafeInteger(expectedRevision) && expectedRevision >= 0, 'CLI_ARGUMENT', 'Invalid expected revision');
  return { owner: requireFlag(args, 'owner'), expectedRevision, operationId: requireFlag(args, 'operation-id'), runtime: { version, sha256: sha256(await readFile(fileURLToPath(import.meta.url))) } };
}

async function command(args: Arguments): Promise<Outcome> {
  if (args.flags.help || !args.words.length && !args.flags.version) return { data: { version, help } };
  if (args.flags.version) { allowFlags(args, ['version']); requireWords(args, 0); return { data: { version } }; }
  const name = args.words[0];
  if (name === 'init') {
    requireWords(args, 1); allowFlags(args, ['hosts', 'profile', 'dry-run', 'operation-id']);
    assert(!args.flags.profile || args.flags.profile === 'local', 'PROFILE_UNSUPPORTED', 'Only the local initialization profile is implemented', 5);
    const hosts = typeof args.flags.hosts === 'string' ? args.flags.hosts.split(',') : await selectHosts();
    const data = await initProject(args.project, { hosts, dryRun: !!args.flags['dry-run'], operationId: args.flags['dry-run'] ? undefined : String(args.flags['operation-id'] ?? `init-${randomUUID()}`), runtimePath: fileURLToPath(import.meta.url) });
    return { data: 'changes' in data ? planSummary(data) : data };
  }
  if (name === 'doctor') {
    requireWords(args, 1); allowFlags(args, []);
    const data = await doctor(args.project);
    return { data, diagnostics: data.diagnostics, exitCode: data.exitCode };
  }
  if (name === 'upgrade' || name === 'uninstall') {
    requireWords(args, 1); allowFlags(args, ['apply', 'dry-run', 'operation-id', 'plan-digest', 'to']);
    assert(!args.flags.to || args.flags.to === version, 'VERSION_UNAVAILABLE', 'Upgrade uses the version of this local package; download or remote execution is not supported', 5);
    assert(!(args.flags.apply && args.flags['dry-run']), 'CLI_ARGUMENT', '--apply and --dry-run are mutually exclusive');
    const root = await checkedProject(args);
    if (args.flags.apply) {
      const replay = await replayInstallOperation(root, requireFlag(args, 'operation-id'), { operation: name, runtimePath: name === 'upgrade' ? fileURLToPath(import.meta.url) : undefined, planDigest: requireFlag(args, 'plan-digest') });
      if (replay) return { data: replay };
    }
    const plan = name === 'upgrade' ? await planUpgrade(root, { runtimePath: fileURLToPath(import.meta.url) }) : await planUninstall(root);
    if (!args.flags.apply) return { data: planSummary(plan), exitCode: plan.applicable ? 0 : 3 };
    return { data: await applyInstallPlan(root, plan, { operationId: requireFlag(args, 'operation-id'), planDigest: requireFlag(args, 'plan-digest') }) };
  }
  const root = await checkedProject(args);
  if (name === 'change' && args.words[1] === 'list') {
    requireWords(args, 2); allowFlags(args, []); await assertStoreReadable(root);
    return { data: await listChanges(root) };
  }
  if (name === 'change' && args.words[1] === 'new') {
    requireWords(args, 3); allowFlags(args, ['operation-id']);
    return { data: await newChange(root, changeId(args.words[2]), requireFlag(args, 'operation-id')) };
  }
  if (name === 'change' && args.words[1] === 'rebaseline' && !args.flags.apply) {
    requireWords(args, 3); allowFlags(args, ['run']);
    const id = changeId(args.words[2]);
    const run = await runForChange(root, args, id);
    const data = await previewRebaseline(root, id, run.runId);
    return { data, diagnostics: data.diagnostics, exitCode: data.diagnostics.some(d => d.severity !== 'warning') ? 3 : 0 };
  }
  if (['validate', 'trace', 'sync'].includes(name)) {
    requireWords(args, 2); allowFlags(args, name === 'validate' ? ['gate'] : []);
    await assertStoreReadable(root);
    await loadConfig(root);
    const bundle = await loadChange(root, changeId(args.words[1]));
    if (name === 'validate') {
      const gate = args.flags.gate ?? 'spec';
      assert(['draft', 'spec', 'integration'].includes(String(gate)), 'CLI_ARGUMENT', 'Unknown validation gate');
      const diagnostics = validateChange(bundle, gate as 'draft' | 'spec' | 'integration');
      const errors = diagnostics.filter(d => d.severity !== 'warning');
      return { data: { changeId: bundle.changeId, gate, passed: !errors.length }, diagnostics, exitCode: errors.length ? (gate === 'integration' ? 3 : 2) : 0 };
    }
    if (name === 'trace') {
      const graph = traceChange(bundle);
      const diagnostics = [...validateChange(bundle, 'draft'), ...graph.diagnostics];
      return { data: graph, diagnostics, exitCode: diagnostics.some(d => d.severity !== 'warning') ? 2 : 0 };
    }
    const plan = planSync({ specs: bundle.specs, deltas: bundle.deltas, history: bundle.history, activeReferences: bundle.activeReferences });
    const diagnostics = [...validateChange(bundle, 'draft'), ...plan.diagnostics];
    return { data: plan, diagnostics, exitCode: diagnostics.some(d => d.severity !== 'warning') ? 3 : 0 };
  }
  if (name === 'run' && args.words[1] === 'init') {
    requireWords(args, 3); allowFlags(args, ['operation-id']);
    await assertStoreReadable(root);
    const config = await loadConfig(root);
    const id = changeId(args.words[2]);
    const bundle = await loadChange(root, id);
    const diagnostics = validateChange(bundle, 'draft');
    assert(!diagnostics.some(d => d.severity !== 'warning'), 'RUN_INVALID_CHANGE', 'Draft validation failed', 2);
    const baseRef = await resolveBaseRef(root, config.git.baseBranch);
    await assertChangeBranch(root, baseRef, 'RUN_BASE_BRANCH');
    assert(!(await git(root, ['status', '--porcelain=v1', '--untracked-files=all'])).trim(), 'RUN_DIRTY_WORKTREE', 'Commit or isolate existing work before creating a run; Workflow does not stash or clean user files', 3);
    const runtime = { version, sha256: sha256(await readFile(fileURLToPath(import.meta.url))) };
    const observed = await captureFingerprints(root, { runtime });
    const tracked = new Set((await git(root, ['ls-files', '-z'])).split('\0'));
    const omitted = Object.values(observed.manifests).flat().filter(entry => !entry.path.startsWith('@') && !tracked.has(entry.path) && !pathMatches(entry.path, config.validation.extraSourceInputs));
    assert(!omitted.length, 'RUN_UNTRACKED_INPUT', `Untracked inputs must be committed or isolated; local ignore rules cannot hide them: ${omitted.map(entry => entry.path).join(', ')}`, 3);
    const run = await createRun(root, { changeId: id, operationId: requireFlag(args, 'operation-id'), projectId: config.project.id, runtime, budgets: { retry: config.policy.retryLimit, cr: config.policy.crRoundLimit } });
    return { data: { ...run, executionReady: false, nextAction: 'verify-native-host-capabilities-and-authorization-provenance' } };
  }
  if (name === 'status') {
    requireWords(args, 2); allowFlags(args, ['run']); const id = changeId(args.words[1]);
    const runs = args.flags.run ? [await runForChange(root, args, id)] : await listRuns(root, id);
    return { data: { changeId: id, executionReady: false, runs: runs.map(({ owner, ...run }) => run) } };
  }
  if (name === 'resume-plan') {
    requireWords(args, 2); allowFlags(args, ['run']); const id = changeId(args.words[1]);
    const run = await runForChange(root, args, id);
    const runtime = { version, sha256: sha256(await readFile(fileURLToPath(import.meta.url))) };
    return { data: await resumePlan(root, run.runId, { runtime }) };
  }
  if (name === 'lock' && args.words[1] === 'heartbeat') {
    requireWords(args, 3); allowFlags(args, ['run', 'owner', 'expected-revision', 'operation-id']);
    const id = changeId(args.words[2]); const run = await runForChange(root, args, id);
    const owner = requireFlag(args, 'owner');
    const revision = Number(requireFlag(args, 'expected-revision'));
    assert(Number.isSafeInteger(revision) && revision >= 0, 'CLI_ARGUMENT', 'Invalid expected revision');
    const runtime = { version, sha256: sha256(await readFile(fileURLToPath(import.meta.url))) };
    const result = await mutateRun(root, run.runId, { owner, expectedRevision: revision, operationId: requireFlag(args, 'operation-id'), runtime, input: { command: 'lock heartbeat', changeId: id } }, () => {});
    await heartbeatChangeLock(root, id, owner);
    return { data: { changeId: id, runId: result.runId, revision: result.revision, heartbeatUpdated: true } };
  }
  if (name === 'dispatch' && args.words[1] === 'prepare') {
    requireWords(args, 3); allowFlags(args, ['run', 'owner', 'expected-revision', 'operation-id', 'task', 'role']);
    const id = changeId(args.words[2]);
    const run = await runForChange(root, args, id);
    const data = await prepareRunDispatch(root, id, run.runId, await writeCredentials(args), { taskId: requireFlag(args, 'task'), role: requireFlag(args, 'role') as Role });
    return { data };
  }
  if (name === 'dispatch' && args.words[1] === 'collect') {
    requireWords(args, 3); allowFlags(args, ['run', 'owner', 'expected-revision', 'operation-id', 'dispatch', 'attempt', 'report']);
    const id = changeId(args.words[2]);
    const run = await runForChange(root, args, id);
    const data = await collectRunDispatch(root, id, run.runId, await writeCredentials(args), { dispatchId: requireFlag(args, 'dispatch'), attemptId: requireFlag(args, 'attempt'), reportPath: await resolveProjectPath(root, requireFlag(args, 'report')) });
    return { data, diagnostics: data.diagnostics, exitCode: data.accepted ? 0 : 3 };
  }
  if (name === 'test-cycle' && args.words[1] === 'baseline') {
    requireWords(args, 3); allowFlags(args, ['run', 'owner', 'expected-revision', 'operation-id', 'task']);
    const id = changeId(args.words[2]);
    const run = await runForChange(root, args, id);
    const result = await executeTaskBaseline(root, { ...await writeCredentials(args), runId: run.runId, taskId: requireFlag(args, 'task') });
    return { data: { runId: run.runId, revision: result.run.revision, status: result.status, historical: result.historical, currentFreshness: result.currentFreshness, evidence: result.evidence.map(evidenceSummary), operationIds: result.operationIds, phaseAdvanced: false, executionReady: false, nextAction: 'review-baseline-results-before-opening-any-test-cycle' }, exitCode: result.status === 'passed' && result.currentFreshness ? 0 : result.status === 'passed' ? 3 : 6 };
  }
  if (name === 'evidence' && args.words[1] === 'show') {
    requireWords(args, 3); allowFlags(args, ['run', 'operation-id']);
    const id = changeId(args.words[2]);
    const run = await runForChange(root, args, id);
    const evidence = await loadCommandEvidence(root, run.runId, requireFlag(args, 'operation-id'), { runtime: { version, sha256: sha256(await readFile(fileURLToPath(import.meta.url))) } });
    return { data: evidenceSummary(evidence) };
  }
  // These command families require host/user facts which the current adapters cannot
  // authenticate. Reject before reading user-supplied success JSON or changing files.
  const gated = new Set(['approve', 'dispatch', 'test-cycle', 'phase', 'task', 'checkpoint', 'candidate', 'archive', 'verify', 'integrate', 'takeover', 'recover', 'tracking', 'epic']);
  if (gated.has(name) || name === 'change' && ['reopen', 'rebaseline'].includes(args.words[1])) {
    throw new WorkflowError('CAPABILITY_UNVERIFIED', `Command ${args.words.slice(0, 2).join(' ')} is blocked: native host provenance, authorization and isolated review/recovery evidence are not yet verified. This preview cannot report workflow completion.`, 5);
  }
  throw new WorkflowError('CLI_UNKNOWN_COMMAND', 'Unknown command; use workflow --help');
}

let commandName = 'unknown';
let jsonMode = process.argv.includes('--json');
try {
  const [major, minor] = process.versions.node.split('.').map(Number);
  assert(major > 22 || major === 22 && minor >= 12, 'NODE_VERSION', 'Node.js 22.12+ is required');
  const args = parseArguments(process.argv.slice(2));
  commandName = args.words.slice(0, ['change', 'run', 'lock', 'dispatch', 'test-cycle', 'evidence'].includes(args.words[0]) ? 2 : 1).join(' ') || (args.flags.version ? 'version' : 'help');
  jsonMode = args.json;
  const outcome = await command(args);
  const exitCode = outcome.exitCode ?? 0;
  const envelope = { apiVersion: 1, ok: exitCode === 0, command: commandName, data: outcome.data, diagnostics: outcome.diagnostics ?? [] };
  if (jsonMode) process.stdout.write(JSON.stringify(envelope) + '\n');
  else if (commandName === 'help') process.stdout.write(help);
  else if (commandName === 'version') process.stdout.write(version + '\n');
  else process.stdout.write(JSON.stringify(envelope, null, 2) + '\n');
  process.exitCode = exitCode;
} catch (error) {
  const failure = error instanceof WorkflowError ? error : new WorkflowError('INTERNAL_ERROR', error instanceof Error ? error.message : String(error), 1);
  const envelope = { apiVersion: 1, ok: false, command: commandName, data: null, diagnostics: [{ code: failure.code, message: failure.message, severity: 'error' }] };
  process.stdout.write(JSON.stringify(envelope, null, jsonMode ? undefined : 2) + '\n');
  process.exitCode = failure.exitCode;
}
