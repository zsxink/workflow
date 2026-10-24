import picomatch from 'picomatch';
import { assert, WorkflowError, type Diagnostic } from '../shared/errors.js';
import { sha256, stableStringify } from '../shared/hash.js';
import type { ManifestEntry } from '../runtime/fingerprints.js';
import { assertObservedCommand, currentEvidenceSession } from './evidence.js';
import type { ValidationCommand } from '../project/index.js';
import { parseDispatchReport, validRelativePath } from './dispatch.js';
import { phases, type Phase, type CommandEvidence, type Fingerprints, type WorkflowState } from './types.js';

export interface OutputSnapshot {
  head: string;
  indexDigest: string;
  fingerprints: Fingerprints;
  manifests: Record<'source' | 'spec' | 'plan' | 'policy', ManifestEntry[]>;
}
export interface OutputChange {
  path: string;
  kind: 'added' | 'modified' | 'deleted';
  before?: ManifestEntry;
  after?: ManifestEntry;
}
export interface OutputAuditInput {
  state: WorkflowState;
  dispatchId: string;
  attemptId: string;
  /** The application must obtain this from the dispatch-preparation checkpoint. */
  start?: OutputSnapshot;
  /** The application must capture this directly from Git and the filesystem. */
  current: OutputSnapshot;
  /** Only the in-process command executor can authenticate these records. */
  commandEvidence?: CommandEvidence[];
  /** Trusted project-config command definitions selected by the application. */
  commands?: ValidationCommand[];
}
export interface OutputAudit {
  acceptedOutput: false;
  executionReady: false;
  deterministicChecksPassed: boolean;
  changes: OutputChange[];
  changedInputs: Array<keyof Fingerprints>;
  diagnostics: Diagnostic[];
  manifestEvidenceId: string;
  invalidatedPhases: Phase[];
}
interface AuditBinding { stateDigest: string; currentDigest: string; auditDigest: string; dispatchId: string; attemptId: string; preserveCycleId?: string }
const audits = new WeakMap<OutputAudit, AuditBinding>();
const groups = ['source', 'spec', 'plan', 'policy'] as const;
const inputs = [...groups, 'environment'] as const;
function same(a: unknown, b: unknown): boolean { return stableStringify(a) === stableStringify(b); }

/** Compares complete before/after manifests, including removed files and mode/type changes.
 * A rename is deliberately represented as delete + add so neither endpoint escapes audit.
 */
export function outputManifestChanges(start: OutputSnapshot['manifests'], current: OutputSnapshot['manifests']): OutputChange[] {
  const before = new Map(groups.flatMap(group => start[group]).map(entry => [entry.path, entry]));
  const after = new Map(groups.flatMap(group => current[group]).map(entry => [entry.path, entry]));
  return [...new Set([...before.keys(), ...after.keys()])].sort().flatMap(filename => {
    const previous = before.get(filename); const next = after.get(filename);
    if (same(previous, next)) return [];
    return [{ path: filename, kind: !previous ? 'added' as const : !next ? 'deleted' as const : 'modified' as const, ...(previous ? { before: structuredClone(previous) } : {}), ...(next ? { after: structuredClone(next) } : {}) }];
  });
}

/** Read-only deterministic checks. Snapshots and a DONE report do not prove native-host
 * authorship, authorization, or isolation. Applications may expose the audit but must
 * independently authenticate those capabilities before calling the domain transition.
 */
export function auditDispatchOutput(input: OutputAuditInput): OutputAudit {
  const diagnostics: Diagnostic[] = [];
  const error = (code: string, message: string) => diagnostics.push({ code, message });
  const d = input.state.dispatches.find(value => value.id === input.dispatchId && value.attemptId === input.attemptId);
  if (d && !['architect', 'developer-red', 'developer-green', 'developer-verification', 'developer-exempt', 'tester'].includes(d.role)) error('OUTPUT_ROLE_UNSUPPORTED', '审查与验证职责须使用各自门禁，文件产物接收不能替代审查或验证');
  if (!d) error('OUTPUT_ATTEMPT_UNKNOWN', '产物必须关联当前 run 的 dispatch/attempt');
  if (d && (d.status !== 'attached' || !d.agentId)) error('OUTPUT_ATTEMPT_NOT_ATTACHED', '产物仅可归属已关联宿主且仍运行的 attempt');
  let report = d?.report;
  if (report) {
    try { report = parseDispatchReport(report); }
    catch (cause) { error(cause instanceof WorkflowError ? cause.code : 'OUTPUT_REPORT_INVALID', '产物回报格式无效'); report = undefined; }
  }
  if (!report || report.status !== 'DONE') error('OUTPUT_REPORT_NOT_DONE', '必须先收集当前 attempt 的 DONE 回报；收集回报不等于接收产物');
  if (d && report) {
    if (report.runId !== input.state.runId || report.dispatchId !== d.id || report.attemptId !== d.attemptId || report.startHead !== d.startHead || !same(report.taskIds, d.taskId ? [d.taskId] : [])) error('OUTPUT_REPORT_ASSOCIATION', '回报 run/task/dispatch/attempt/HEAD 关联错误');
    if (!same([...report.requirementIds].sort(), [...d.requirementIds].sort()) || !same([...report.scenarioIds].sort(), [...d.scenarioIds].sort())) error('OUTPUT_REPORT_COVERAGE', 'DONE 回报必须准确覆盖授权需求和场景');
  }
  function validateSnapshot(snapshot: OutputSnapshot): boolean {
    const seen = new Set<string>(); let valid = true;
    if (!/^[a-f0-9]{40}([a-f0-9]{24})?$/.test(snapshot.head) || !/^[a-f0-9]{64}$/.test(snapshot.indexDigest) || !/^[a-f0-9]{64}$/.test(snapshot.fingerprints.environment)) valid = false;
    for (const group of groups) {
      if (!Array.isArray(snapshot.manifests?.[group])) { valid = false; continue; }
      for (const entry of snapshot.manifests[group]) {
        if (!entry || !validRelativePath(entry.path) || seen.has(entry.path) || !['file', 'symlink'].includes(entry.type) || !/^[a-f0-9]{64}$/.test(entry.sha256) || entry.executable !== undefined && typeof entry.executable !== 'boolean') valid = false;
        if (entry) seen.add(entry.path);
      }
      if (snapshot.fingerprints[group] !== sha256(stableStringify(snapshot.manifests[group]))) valid = false;
    }
    if (!valid) error('OUTPUT_SNAPSHOT_INVALID', '起始/当前快照的 HEAD、index、manifest 或摘要无效');
    return valid;
  }
  const currentValid = validateSnapshot(input.current);
  const startValid = input.start ? validateSnapshot(input.start) : false;
  if (!input.start) error('OUTPUT_BASELINE_REQUIRED', '派发准备记录缺少完整起始 manifest，不能从当前快照补造起始状态');
  const changes = startValid && currentValid ? outputManifestChanges(input.start!.manifests, input.current.manifests) : [];
  const changedInputs = input.start ? inputs.filter(key => input.start!.fingerprints[key] !== input.current.fingerprints[key]) : [];
  if (d && input.start) {
    if (input.start.head !== d.startHead || !same(input.start.fingerprints, d.fingerprints) || input.state.fingerprints !== undefined && !same(input.state.fingerprints, d.fingerprints)) error('OUTPUT_BASELINE_STALE', '起始 manifest 或当前 workflow 指纹不属于派发输入');
    if (input.current.head !== input.start.head) error('OUTPUT_HEAD_CHANGED', '产物期间 HEAD 改变，不能按原 attempt 接收');
    if (input.current.indexDigest !== input.start.indexDigest) error('OUTPUT_INDEX_CHANGED', '产物期间 Git index 改变，不能按原 attempt 接收');
    if (changedInputs.some(key => key === 'spec' || key === 'policy' || key === 'environment' || key === 'plan' && d.role !== 'architect')) error('OUTPUT_PROTECTED_INPUT_CHANGED', '规格、计划、策略或环境变化必须重新走相关门禁，不能以合法产物豁免');
    const allows = picomatch(d.allowedPaths, { dot: true }); const forbids = picomatch(d.forbiddenPaths, { dot: true });
    for (const change of changes) if (!allows(change.path) || forbids(change.path)) error('OUTPUT_PATH_SCOPE', `变化越出 attempt 写范围: ${change.path}`);
    if (report && !same([...report.files].sort(), changes.map(change => change.path).sort())) error('OUTPUT_FILES_INCOMPLETE', '回报 files 必须与全部新增、修改、删除路径完全相符');
    if (changes.length && input.state.dispatches.some(other => other.id !== d.id && ['planned', 'attached'].includes(other.status) && other.allowedPaths.length)) error('OUTPUT_OTHER_WRITER', '存在其他未终结写入 attempt，无法独占归属全部变化');
  }
  if (d && changedInputs.includes('source') && !['developer-red', 'developer-green', 'developer-verification', 'developer-exempt', 'tester'].includes(d.role)) error('OUTPUT_ROLE_INPUT', '当前角色不能接收源码变化');
  const manifestEvidenceId = `manifest-${sha256(stableStringify(input.current.manifests))}`;
  const records = input.commandEvidence ?? [];
  const evidenceIds = (report?.evidenceIds ?? []).filter(id => id !== manifestEvidenceId);
  if (!same(records.map(record => record.id).sort(), [...evidenceIds].sort()) || new Set(records.map(record => record.id)).size !== records.length) error('OUTPUT_EVIDENCE_INCOMPLETE', '必须提供回报逐项引用的真实命令证据，不能以证据 ID 代替采集记录');
  if (d?.testMode === 'exempt' || d?.role === 'developer-exempt') error('OUTPUT_ALTERNATIVE_ACCEPTANCE_UNVERIFIED', '豁免理由和 manifest 不能证明替代验收已执行；当前尚无可核查替代验收来源');
  if (records.length && (!input.commands?.length || new Set(input.commands.map(command => command.id)).size !== input.commands.length)) error('OUTPUT_COMMAND_DEFINITIONS_REQUIRED', '需要应用从当前项目配置选定的完整命令定义，不能只核对命令 ID');
  if (records.length && (!d?.taskPlan?.commandPlanDigest || d.taskPlan.commandPlanDigest !== sha256(stableStringify(input.commands ?? [])))) error('OUTPUT_COMMAND_PLAN_DIGEST', '命令定义必须匹配派发时绑定的完整计划摘要');
  for (const record of records) {
    if (d?.evidenceSessionId !== currentEvidenceSession()) error('OUTPUT_EVIDENCE_SESSION', '当前进程不能认证另一进程的派发时序，须按恢复协议重新准备');
    if (!d?.evidenceBoundary || record.startedSequence <= d.evidenceBoundary) error('OUTPUT_EVIDENCE_BEFORE_ATTEMPT', '命令必须在当前 attempt 准备边界之后执行，旧派发无边界时需重新准备');
    const declared = input.commands?.find(command => command.id === record.commandId);
    const expectedDigest = sha256(stableStringify(declared!));
    if (!declared || !same(record.argv, [declared.executable, ...declared.args]) || record.cwd !== declared.cwd || record.commandPlanDigest !== expectedDigest) error('OUTPUT_COMMAND_DEFINITION', '真实执行的 argv/cwd/计划摘要不匹配当前项目声明');
    try { assertObservedCommand(record); }
    catch (cause) { error(cause instanceof WorkflowError ? cause.code : 'OUTPUT_EVIDENCE_INVALID', '命令证据未通过执行器来源核查'); }
    if (!d || record.runId !== input.state.runId || record.taskId !== d.taskId || record.head !== input.current.head || !same(record.after, input.current.fingerprints) || record.cycleId !== d.cycleId) error('OUTPUT_EVIDENCE_STALE', '命令证据不属于当前 run/task/cycle/HEAD/产物快照');
  }
  // Bind the selected command set to the declared task plan, not just arbitrary real commands.
  if (d?.taskPlan && d.role !== 'architect' && d.testMode !== 'exempt') {
    if (!same(records.map(record => record.commandId).sort(), [...d.taskPlan.testCommands].sort()) || new Set(records.map(record => record.commandId)).size !== records.length) error('OUTPUT_COMMAND_PLAN', '必须执行当前任务计划的全部命令，不能用任意真实命令代替');
  }
  for (const record of records) {
    const expectedStep = d?.role === 'developer-red' ? 'red' : d?.role === 'developer-green' ? ['green', 'refactor'] : ['verify'];
    if (!expectedStep.includes(record.step)) error('OUTPUT_COMMAND_STEP', '命令步骤不匹配当前角色');
    if (d?.role !== 'developer-red' && record.exitCode !== 0) error('OUTPUT_COMMAND_FAILED', '非 Red 产物需要全部命令通过');
  }
  const cycle = d?.cycleId ? input.state.cycles.find(value => value.id === d.cycleId && value.taskId === d.taskId) : undefined;
  let preserveCycleId: string | undefined;
  if (d?.role === 'developer-red' || d?.role === 'developer-green') {
    const selected = d.role === 'developer-red' ? cycle?.red : cycle?.refactor.length ? cycle.refactor : cycle?.green;
    const allowedStatuses = d.role === 'developer-red' ? ['red-observed', 'red-accepted'] : ['complete'];
    if (!cycle || !allowedStatuses.includes(cycle.status) || !selected?.length || !same(selected.map(e => e.id).sort(), records.map(e => e.id).sort()) || !selected.every(e => same(e.after, input.current.fingerprints))) error('OUTPUT_TDD_CYCLE_NOT_READY', 'TDD 产物必须已通过同一 cycle 的真实 Red/Green 领域核查');
    else preserveCycleId = cycle.id;
  }
  const earliest: Phase | undefined = !changedInputs.length ? undefined : d?.role === 'architect' ? 'spec-gate' : d?.role === 'tester' ? 'cr' : 'tester';
  const invalidatedPhases = earliest ? [...phases.slice(phases.indexOf(earliest))] : [];
  const deterministicChecksPassed = diagnostics.length === 0;
  error('OUTPUT_AUTHORSHIP_UNVERIFIED', '只读审计不认证原生宿主作者、用户授权或独占写入来源；应用入口不能据此接收产物');
  const result: OutputAudit = { acceptedOutput: false, executionReady: false, deterministicChecksPassed, changes, changedInputs, diagnostics, manifestEvidenceId, invalidatedPhases };
  audits.set(result, { stateDigest: sha256(stableStringify(input.state)), currentDigest: sha256(stableStringify(input.current)), auditDigest: sha256(stableStringify(result)), dispatchId: input.dispatchId, attemptId: input.attemptId, preserveCycleId });
  return result;
}

/** Pure-domain transition, like the TDD state functions: the caller must already own
 * authenticated host/authorization facts. This never succeeds any phase and is not an
 * application or CLI bypass. JSON/imported/modified/stale audits cannot be applied.
 */
export function applyAcceptedOutput(state: WorkflowState, audit: OutputAudit, current: OutputSnapshot): WorkflowState {
  const binding = audits.get(audit);
  assert(binding && binding.auditDigest === sha256(stableStringify(audit)), 'OUTPUT_AUDIT_UNVERIFIED', '必须使用本进程生成且未修改的产物审计对象，不能导入 JSON', 5);
  assert(binding.stateDigest === sha256(stableStringify(state)) && binding.currentDigest === sha256(stableStringify(current)), 'OUTPUT_AUDIT_STALE', '审计后的状态或当前输入改变，必须重新审计', 3);
  assert(audit.deterministicChecksPassed, 'OUTPUT_AUDIT_REJECTED', '产物未通过全部确定性核查', 3);
  const next = structuredClone(state);
  const dispatch = next.dispatches.find(value => value.id === binding.dispatchId && value.attemptId === binding.attemptId)!;
  dispatch.status = 'completed';
  dispatch.outputReceipt = { manifestEvidenceId: audit.manifestEvidenceId, inputFingerprints: structuredClone(dispatch.fingerprints), outputFingerprints: structuredClone(current.fingerprints), changedPaths: audit.changes.map(change => change.path), evidenceIds: [...dispatch.report!.evidenceIds], invalidatedPhases: [...audit.invalidatedPhases] };
  next.fingerprints = structuredClone(current.fingerprints);
  for (const phase of audit.invalidatedPhases) next.phases[phase] = { status: 'pending', evidenceIds: [], invalidatedBy: [...audit.changedInputs] };
  if (audit.changedInputs.length) for (const cycle of next.cycles) {
    if (cycle.status === 'complete' || cycle.status === 'invalidated' || cycle.id === binding.preserveCycleId) continue;
    cycle.status = 'invalidated'; cycle.invalidatedReason = `已接收产物改变输入: ${audit.changedInputs.join(', ')}`; cycle.revision++;
  }
  return next;
}

/** Application boundary remains fail closed until native-host provenance is available. */
export function acceptDispatchOutput(_input: OutputAuditInput): never {
  throw new WorkflowError('HOST_PROVENANCE_UNVERIFIED', '产物接收需要可核查的宿主作者、主会话授权及权限隔离；当前仅支持只读产物审计', 5);
}
