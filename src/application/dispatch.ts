import { lstat, readFile } from 'node:fs/promises';
import path from 'node:path';
import { assert, WorkflowError } from '../shared/errors.js';
import { sha256, stableStringify } from '../shared/hash.js';
import { loadConfig, type ProjectConfig } from '../project/index.js';
import { loadChange, validateChange, traceChange } from '../spec/index.js';
import { captureFingerprints, readRun, mutateRun, type MutationInput, type RunState } from '../runtime/index.js';
import { git } from '../repository/git.js';
import { createWorkflowState, prepareDispatch, collectDispatchReport, parseDispatchReport, type Role, type WorkflowState, type Fingerprints } from '../workflow/index.js';

function workflow(run: RunState): WorkflowState {
  if (!run.workflow) return createWorkflowState(run.runId);
  const value = run.workflow as WorkflowState;
  assert(value.formatVersion === 1 && value.runId === run.runId && Array.isArray(value.dispatches) && Array.isArray(value.cycles) && Array.isArray(value.staleReports) && value.phases, 'WORKFLOW_STATE_INVALID', 'Invalid persisted workflow state', 7);
  assert(value.dispatches.every(dispatch => (dispatch.scope === undefined || dispatch.scope === 'task') ? typeof dispatch.taskId === 'string' && dispatch.taskId.length > 0 : dispatch.scope === 'change' && dispatch.role === 'architect' && dispatch.taskId === undefined), 'WORKFLOW_STATE_INVALID', 'Invalid persisted dispatch scope', 7);
  return value;
}

function environmentDigest(config: ProjectConfig): string {
  const names = [...new Set(config.validation.commands.flatMap(command => command.envAllowlist))].sort();
  return sha256(stableStringify(names.map(name => ({ name, sha256: process.env[name] === undefined ? null : sha256(process.env[name]!) }))));
}

export async function prepareRunDispatch(project: string, changeId: string, runId: string, credentials: MutationInput, input: { taskId?: string; role: Role }) {
  const run = await readRun(project, runId);
  assert(run.changeId === changeId, 'RUN_CHANGE_MISMATCH', 'Run does not belong to change');
  const config = await loadConfig(project);
  const bundle = await loadChange(project, changeId);
  assert(input.taskId !== undefined || input.role === 'architect', 'DISPATCH_TASK_ID', 'Task-scoped role requires a task ID');
  const diagnostics = validateChange(bundle, input.role === 'architect' ? 'draft' : 'spec');
  assert(!diagnostics.some(d => d.severity !== 'warning'), 'DISPATCH_INVALID_DRAFT', 'Cannot prepare a packet with invalid structure, task scopes or command references', 2);
  const task = input.taskId === undefined ? undefined : bundle.tasks?.tasks.find(task => task.id === input.taskId);
  assert(input.taskId === undefined || task, 'DISPATCH_TASK_UNKNOWN', 'Task must exist in current change');
  const requirementIds = task?.requires ?? [...new Set(bundle.deltas.flatMap(delta => delta.requirements.map(req => req.id)))];
  const commands = task ? task.testCommands.map(id => config.validation.commands.find(command => command.id === id)!) : [];
  const taskPlan = task ? { commandPlanDigest: sha256(stableStringify(commands)), testCommands: task.testCommands, acceptance: task.acceptance, testRationale: task.testRationale, alternativeAcceptance: task.fields['Alternative-Acceptance'] } : undefined;
  const capture = await captureFingerprints(project, { runtime: credentials.runtime });
  const fingerprints: Fingerprints = { source: capture.sourceFingerprint, spec: capture.specFingerprint, plan: capture.planFingerprint, policy: capture.policyFingerprint, environment: environmentDigest(config) };
  const head = (await git(project, ['rev-parse', '--verify', 'HEAD'])).trim();
  const indexDigest = sha256(await git(project, ['ls-files', '--stage', '-z']));
  const contextPaths = [bundle.metadata.path, bundle.proposal?.path, bundle.design?.path, bundle.tasks?.path, bundle.rules?.path, ...bundle.deltas.map(delta => delta.path)].filter((value): value is string => !!value).map(value => path.relative(bundle.projectRoot, value).split(path.sep).join('/'));
  const scenarioIds = [...new Set(traceChange(bundle).entries.filter(entry => task ? entry.taskIds.includes(task.id) : requirementIds.includes(entry.requirementId)).map(entry => entry.scenarioId))];
  const allowedPaths = input.role === 'reviewer' || input.role === 'verifier' ? [] : input.role === 'architect' ? [`.workflow/changes/${changeId}/design.md`, `.workflow/changes/${changeId}/tasks.md`] : input.role === 'tester' || input.role === 'developer-red' ? task!.testScopes : task!.writeScopes;
  const payload = { command: 'dispatch prepare', changeId, ...input, fingerprints, head, indexDigest };
  const result = await mutateRun(project, runId, { ...credentials, input: payload }, async draft => {
    // A snapshot captured after parsing must not authenticate task scopes read before
    // an edit. Close that window by reloading the exact parsed inputs inside CAS.
    assert(stableStringify(await loadConfig(project)) === stableStringify(config) && stableStringify(await loadChange(project, changeId)) === stableStringify(bundle), 'DISPATCH_PLAN_CHANGED', 'Configuration or task scope changed while preparing task packet', 3);
    assert(stableStringify((await captureFingerprints(project, { runtime: credentials.runtime }))) === stableStringify(capture), 'DISPATCH_INPUT_CHANGED', 'Inputs changed while preparing task packet', 3);
    assert((await git(project, ['rev-parse', '--verify', 'HEAD'])).trim() === head && sha256(await git(project, ['ls-files', '--stage', '-z'])) === indexDigest, 'DISPATCH_GIT_CHANGED', 'HEAD/index changed while preparing task packet', 3);
    const current = workflow(draft);
    // Seed the workflow baseline only on first preparation; an advanced baseline from an
    // accepted output must survive later preparations.
    current.fingerprints ??= structuredClone(fingerprints);
    const cycleId = input.role === 'developer-red' || input.role === 'developer-green' ? current.cycles.find(cycle => cycle.taskId === task!.id && cycle.status !== 'complete' && cycle.status !== 'invalidated')?.id : undefined;
    const prepared = prepareDispatch(current, { ...(task ? { taskId: task.id, testMode: task.testMode, taskPlan } : {}), role: input.role, allowedPaths, requirementIds, scenarioIds, fingerprints, startHead: head, cycleId });
    draft.workflow = prepared.state;
    const receipts = (draft.checkpoints.dispatchPreparation ?? {}) as Record<string, unknown>;
    draft.checkpoints.dispatchPreparation = { ...receipts, [credentials.operationId]: { dispatchId: prepared.dispatch.id, attemptId: prepared.dispatch.attemptId, indexDigest, contextPaths, start: { head, indexDigest, fingerprints, manifests: capture.manifests } } };
  });
  const receipt = (result.checkpoints.dispatchPreparation as Record<string, { dispatchId: string; attemptId: string; indexDigest: string; contextPaths: string[] }>)[credentials.operationId];
  const dispatch = workflow(result).dispatches.find(dispatch => dispatch.id === receipt.dispatchId && dispatch.attemptId === receipt.attemptId);
  assert(dispatch, 'DISPATCH_PACKET_MISSING', 'Preparation receipt has no matching packet', 7);
  return {
    runId, revision: result.revision, packet: { protocolVersion: 1, runId, ...dispatch, indexDigest: receipt.indexDigest, contextPaths: receipt.contextPaths, hostTargets: config.hosts,
      executionReady: false, requiredCapabilities: ['native-dispatch-provenance', 'leader-user-authorization', ...(input.role === 'reviewer' ? ['isolated-readonly-review'] : []), ...(dispatch.testMode === 'exempt' ? ['approved-alternative-acceptance'] : [])],
      restrictions: ['Native host dispatch only', 'No Git index/HEAD writes, archive or integration', 'Report claims require leader audit'] },
    executionReady: false, nextAction: 'verify-host-and-authorization-before-native-dispatch'
  };
}

/** Collects a bounded declaration for audit; it cannot authenticate an unattached Agent. */
export async function collectRunDispatch(project: string, changeId: string, runId: string, credentials: MutationInput, input: { dispatchId: string; attemptId: string; reportPath: string }) {
  const run = await readRun(project, runId);
  assert(run.changeId === changeId, 'RUN_CHANGE_MISMATCH', 'Run does not belong to change');
  const info = await lstat(input.reportPath);
  assert(info.isFile() && !info.isSymbolicLink() && info.size <= 64 * 1024, 'REPORT_FILE_INVALID', 'Report must be a regular JSON file no larger than 64 KiB');
  const raw = await readFile(input.reportPath, 'utf8');
  assert(Buffer.byteLength(raw) <= 64 * 1024, 'REPORT_FILE_INVALID', 'Report grew beyond 64 KiB');
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new WorkflowError('REPORT_FORMAT', 'Report is not valid JSON'); }
  const report = parseDispatchReport(value);
  assert(report.dispatchId === input.dispatchId && report.attemptId === input.attemptId, 'REPORT_ASSOCIATION', 'Report does not match dispatch/attempt arguments', 3);
  let collection: ReturnType<typeof collectDispatchReport> | undefined;
  const result = await mutateRun(project, runId, { ...credentials, input: { command: 'dispatch collect', changeId, dispatchId: input.dispatchId, attemptId: input.attemptId, reportHash: sha256(raw) } }, draft => {
    const current = workflow(draft);
    assert(current.staleReports.length < 100, 'REPORT_AUDIT_CAPACITY', 'Report audit capacity reached; preserve state for explicit cleanup', 5);
    collection = collectDispatchReport(current, report);
    draft.workflow = collection.state;
    const receipts = (draft.checkpoints.dispatchCollection ?? {}) as Record<string, unknown>;
    draft.checkpoints.dispatchCollection = { ...receipts, [credentials.operationId]: { accepted: collection.accepted, diagnostics: collection.diagnostics, reportHash: sha256(raw) } };
  });
  const receipt = (result.checkpoints.dispatchCollection as Record<string, { accepted: boolean; diagnostics: { code: string; message: string }[] }>)[credentials.operationId];
  return { runId, revision: result.revision, ...receipt, phaseAdvanced: false, executionReady: false };
}
