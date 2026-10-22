import { randomUUID } from 'node:crypto';
import { executeCommand, type ValidationCommand, type ExecuteOptions } from '../project/index.js';
import { assert } from '../shared/errors.js';
import { sha256, stableStringify } from '../shared/hash.js';
import type { CommandEvidence, Fingerprints } from './types.js';
const observed = new Map<string, string>();
let observationSequence = 0;
const observationSession = randomUUID();
export function currentEvidenceSession(): string { return observationSession; }
export function markEvidenceBoundary(): number { return ++observationSequence; }
export interface ExecutionSnapshot { fingerprints: Fingerprints; head: string; testDigest: string; implementationDigest: string; environmentDigest: string }
export interface CaptureContext { runId: string; taskId: string; cycleId?: string; step: CommandEvidence['step']; commandPlanDigest: string }
export function commandPlanDigest(commands: ValidationCommand[]): string { return sha256(stableStringify(commands)); }
/** This is the only command-evidence producer. Reports and JSON imports are never trusted executions.
 * Snapshot adapter belongs to the application (Git/filesystem), not user-supplied evidence files.
 * A fresh process cannot authenticate old command records: recovery must rerun commands.
 */
export async function captureCommandEvidence(root: string, command: ValidationCommand, context: CaptureContext, snapshot: () => Promise<ExecutionSnapshot>, options?: ExecuteOptions): Promise<CommandEvidence> {
  const startedSequence = markEvidenceBoundary();
  const before = await snapshot();
  const result = await executeCommand(root, command, { maxOutputBytes: 64 * 1024, ...options });
  const after = await snapshot();
  const evidence: CommandEvidence = {
    id: `evidence-${randomUUID()}`, ...context, commandId: command.id, argv: [command.executable, ...command.args], cwd: command.cwd,
    startedAt: result.startedAt, finishedAt: result.finishedAt, startedSequence, finishedSequence: markEvidenceBoundary(), exitCode: result.exitCode, signal: result.signal ?? undefined,
    timedOut: result.timedOut, outputTruncated: result.stdoutTruncated || result.stderrTruncated,
    before: before.fingerprints, after: after.fingerprints, head: before.head, testDigest: before.testDigest,
    implementationDigest: before.implementationDigest, environmentDigest: before.environmentDigest,
    outputDigest: sha256(result.stdoutSha256 + result.stderrSha256), output: { stdout: result.stdout, stderr: result.stderr },
  };
  assert(before.head === after.head && before.testDigest === after.testDigest && before.implementationDigest === after.implementationDigest && before.environmentDigest === after.environmentDigest, 'COMMAND_INPUT_CHANGED', '命令运行期间 HEAD、测试、实现或环境改变；结果不可接受', 3);
  observed.set(evidence.id, sha256(stableStringify(evidence)));
  return evidence;
}
export function assertObservedCommand(evidence: CommandEvidence): void {
  assert(observed.get(evidence.id) === sha256(stableStringify(evidence)), 'COMMAND_PROVENANCE_UNVERIFIED', '证据不是当前执行器采集的原始记录；恢复时重新执行，不能导入 JSON 伪造命令事实', 5);
  assert(stableStringify(evidence.before) === stableStringify(evidence.after), 'COMMAND_INPUT_CHANGED', '命令运行期间输入指纹改变', 3);
  assert(!evidence.timedOut && !evidence.signal && evidence.exitCode !== null, 'COMMAND_ABNORMAL_EXIT', '超时或进程异常不能作为有效测试结果', 3);
}
export interface VerificationInput { runId: string; evidence: CommandEvidence[]; commandIds: string[]; fingerprints: Fingerprints; head: string; planDigest: string }
export function assessVerification(input: VerificationInput): { ok: true; evidenceIds: string[] } {
  assert(input.commandIds.length > 0 && new Set(input.commandIds).size === input.commandIds.length, 'VERIFY_PLAN_REQUIRED', '验证必须选择非空且无重复的命令计划', 3);
  assert(input.evidence.length === input.commandIds.length, 'VERIFY_INCOMPLETE', '每条适用命令都必须执行', 3);
  const seen = new Set<string>();
  for (const e of input.evidence) {
    assertObservedCommand(e);
    assert(e.runId === input.runId && e.step === 'verify' && input.commandIds.includes(e.commandId) && !seen.has(e.commandId), 'VERIFY_COMMAND_PLAN', '验证结果不匹配命令计划或重复', 3);
    assert(e.exitCode === 0, 'VERIFY_FAILED', `验证命令 ${e.commandId} 失败`, 3);
    assert(e.head === input.head && e.commandPlanDigest === input.planDigest && stableStringify(e.after) === stableStringify(input.fingerprints), 'VERIFY_STALE', '验证证据与当前 HEAD、计划或输入不同', 3);
    seen.add(e.commandId);
  }
  return { ok: true, evidenceIds: input.evidence.map(e => e.id) };
}
