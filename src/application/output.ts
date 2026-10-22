import { assert } from '../shared/errors.js';
import { sha256, stableStringify } from '../shared/hash.js';
import { loadConfig } from '../project/index.js';
import { captureFingerprints, readRun, locateRepository, currentRuntimeIdentity, type RuntimeIdentity } from '../runtime/index.js';
import { git } from '../repository/git.js';
import { auditDispatchOutput, type OutputSnapshot } from '../workflow/receipts.js';
import type { WorkflowState } from '../workflow/types.js';

/** Real filesystem/Git observation only. This entry never imports evidence or accepts output. */
export async function auditRunDispatchOutput(project: string, changeId: string, runId: string, input: { dispatchId: string; attemptId: string; runtime?: RuntimeIdentity }) {
  const repo = await locateRepository(project);
  const run = await readRun(repo.root, runId);
  const runtime = input.runtime ?? await currentRuntimeIdentity();
  assert(run.formatVersion === 1 && run.changeId === changeId && run.worktree === repo.root, 'OUTPUT_RUN_MISMATCH', 'Output audit requires the original run/change/worktree');
  assert(stableStringify(run.runtime) === stableStringify(runtime), 'RUNTIME_MISMATCH', 'Output audit must use the pinned run runtime');
  assert(run.branch === (await git(repo.root, ['branch', '--show-current'])).trim(), 'BRANCH_CHANGED', 'Output audit requires the original branch');
  const state = run.workflow as WorkflowState | undefined;
  assert(state?.formatVersion === 1 && state.runId === runId && Array.isArray(state.dispatches), 'OUTPUT_ATTEMPT_UNKNOWN', 'No prepared workflow attempt');
  assert(state.dispatches.some(d => d.id === input.dispatchId && d.attemptId === input.attemptId), 'OUTPUT_ATTEMPT_UNKNOWN', 'Unknown dispatch/attempt');
  const preparations = Object.values((run.checkpoints.dispatchPreparation ?? {}) as Record<string, { dispatchId: string; attemptId: string; start?: OutputSnapshot }>);
  const matches = preparations.filter(r => r.dispatchId === input.dispatchId && r.attemptId === input.attemptId);
  assert(matches.length === 1, 'OUTPUT_BASELINE_REQUIRED', 'Exactly one original preparation receipt is required');
  const snapshot = async (): Promise<OutputSnapshot> => {
    const config = await loadConfig(repo.root);
    const capture = await captureFingerprints(repo.root, { runtime });
    const names = [...new Set(config.validation.commands.flatMap(c => c.envAllowlist))].sort();
    return {
      head: (await git(repo.root, ['rev-parse', '--verify', 'HEAD'])).trim(),
      indexDigest: sha256(await git(repo.root, ['ls-files', '--stage', '-z'])),
      fingerprints: { source: capture.sourceFingerprint, spec: capture.specFingerprint, plan: capture.planFingerprint, policy: capture.policyFingerprint, environment: sha256(stableStringify(names.map(name => ({ name, sha256: process.env[name] === undefined ? null : sha256(process.env[name]!) })))) },
      manifests: capture.manifests,
    };
  };
  const current = await snapshot();
  const config = await loadConfig(repo.root);
  const dispatch = state.dispatches.find(d => d.id === input.dispatchId && d.attemptId === input.attemptId)!;
  const commands = (dispatch.taskPlan?.testCommands ?? []).flatMap(id => config.validation.commands.filter(command => command.id === id));
  const audit = auditDispatchOutput({ state, dispatchId: input.dispatchId, attemptId: input.attemptId, start: matches[0]!.start, current, commands });
  assert(stableStringify(await snapshot()) === stableStringify(current) && stableStringify(await readRun(repo.root, runId)) === stableStringify(run), 'OUTPUT_INPUT_CHANGED', 'Inputs or run changed during output audit');
  return { ...audit, runId, revision: run.revision, dispatchId: input.dispatchId, attemptId: input.attemptId, readonly: true as const, phaseAdvanced: false, acceptanceAvailable: false, nextAction: 'verify-native-host-and-authorization-before-output-acceptance' };
}
