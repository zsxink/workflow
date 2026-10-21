import type { Diagnostic } from '../shared/errors.js';
import { sha256, stableStringify } from '../shared/hash.js';
import { diagnostic, KEBAB_ID } from './parser.js';
import { planSync, validateHistory } from './sync.js';
import type { ChangeBundle, Gate, ScenarioEvidence, Task, TraceResult } from './types.js';

export function taskPlanFingerprint(tasks: Task[]): string {
  return sha256(stableStringify(tasks.map(t => ({ id: t.id, title: t.title, fields: Object.fromEntries(Object.entries(t.fields).filter(([k]) => k !== 'Status')) }))));
}
function cycles(nodes: { id: string; dependencies: string[]; path: string; line: number }[], code: string): Diagnostic[] {
  const diagnostics: Diagnostic[] = []; const byId = new Map(nodes.map(n => [n.id, n])); const colors = new Map<string, number>();
  function visit(id: string, chain: string[]) {
    const node = byId.get(id); if (!node) return;
    if (colors.get(id) === 1) { diagnostics.push(diagnostic(code, `依赖形成环: ${[...chain, id].join(' → ')}`, node.path, node.line)); return; }
    if (colors.get(id) === 2) return;
    colors.set(id, 1); for (const dep of node.dependencies) visit(dep, [...chain, id]); colors.set(id, 2);
  }
  for (const node of nodes) visit(node.id, []);
  return diagnostics;
}
export const validScope = (scope: string): boolean => !!scope && !scope.startsWith('/') && !scope.includes('\\') && !/^[A-Za-z]:/.test(scope) && !scope.split('/').some(s => s === '..' || s === '.') && !/[\x00-\x1f\x7f]/.test(scope);
/** Deliberately conservative glob inclusion: arbitrary glob implication is not guessed. */
export function scopeWithin(scope: string, parent: string): boolean {
  return validScope(scope) && validScope(parent) && (scope === parent || parent === '**' || parent.endsWith('/**') && scope.startsWith(parent.slice(0, -2)));
}
export function traceChange(bundle: ChangeBundle, evidence: ScenarioEvidence[] = bundle.integrationEvidence?.scenarioEvidence ?? []): TraceResult {
  const diagnostics: Diagnostic[] = []; const entries: TraceResult['entries'] = [];
  const changed = bundle.deltas.flatMap(d => d.requirements.filter(r => r.operation !== 'REMOVE'));
  for (const requirement of changed) for (const scenario of requirement.scenarios) {
    const tasks = bundle.tasks?.tasks.filter(t => t.requires.includes(requirement.id)) ?? [];
    if (!tasks.length) diagnostics.push(diagnostic('TRACE_MISSING_TASK', `场景 ${scenario.id} 缺少关联任务`, scenario.path, scenario.line));
    const matched = evidence.filter(e => e.scenarioId === scenario.id && tasks.some(t => t.id === e.taskId));
    const covered = matched.some(e => e.outcome === 'passed' && !!e.evidenceId?.trim() && !/^(?:none|todo|pending|placeholder|unknown|n\/a)$/i.test(e.evidenceId.trim()) && ['automated', 'manual', 'not-applicable'].includes(e.mode) && (e.mode !== 'not-applicable' || !!e.rationale?.trim()));
    if (!covered) diagnostics.push(diagnostic('TRACE_MISSING_SCENARIO', `场景 ${scenario.id} 缺少有效验收证据`, scenario.path, scenario.line));
    entries.push({ requirementId: requirement.id, scenarioId: scenario.id, taskIds: tasks.map(t => t.id), evidence: matched, covered });
  }
  for (const e of evidence) if (!entries.some(x => x.scenarioId === e.scenarioId && x.taskIds.includes(e.taskId))) diagnostics.push(diagnostic('TRACE_DANGLING_EVIDENCE', `证据 ${e.evidenceId} 引用未知场景或任务`, bundle.tasks?.path ?? 'tasks.md'));
  return { entries, diagnostics };
}
export function validateChange(bundle: ChangeBundle, gate: Gate = 'spec'): Diagnostic[] {
  const diagnostics: Diagnostic[] = [...bundle.diagnostics, ...bundle.metadata.diagnostics];
  const path = bundle.metadata.path;
  if (!['draft', 'spec', 'integration'].includes(gate)) return [...diagnostics, diagnostic('SPEC_GATE_INVALID', `未知 gate ${gate}`, path)];
  if (bundle.changeId !== bundle.metadata.value.id) diagnostics.push(diagnostic('SPEC_CHANGE_ID_MISMATCH', '目录与 change.yaml ID 不同', path));
  const historyDiagnostics = validateHistory(bundle.history, bundle.archives);
  diagnostics.push(...historyDiagnostics);
  // Raw JSON from the I/O boundary must never reach traversal code with invalid nested shapes.
  if (historyDiagnostics.some(d => d.code === 'SPEC_HISTORY_INVALID')) return unique(diagnostics);
  if (bundle.history.changes.some(c => c.changeId === bundle.changeId)) diagnostics.push(diagnostic('SPEC_CHANGE_ID_REUSED', '活动 change ID 已归档；不能复用', path));
  const metadata = bundle.metadata.value;
  const allChanges = [...bundle.activeChanges.filter(c => c.id !== metadata.id), metadata];
  const knownChanges = new Set([...allChanges.map(c => c.id), ...bundle.history.changes.map(c => c.changeId)]);
  for (const change of allChanges) for (const dep of change.dependsOn) {
    if (dep === change.id || !knownChanges.has(dep)) diagnostics.push(diagnostic('SPEC_DEPENDENCY_INVALID', `变更 ${change.id} 依赖自己或缺失变更 ${dep}`, path));
  }
  diagnostics.push(...cycles(allChanges.map(c => ({ id: c.id, dependencies: c.dependsOn, path, line: 1 })), 'SPEC_DEPENDENCY_CYCLE'));
  if (gate === 'integration') for (const dep of metadata.dependsOn) if (!bundle.integratedChanges?.includes(dep)) diagnostics.push(diagnostic('SPEC_DEPENDENCY_NOT_INTEGRATED', `依赖 ${dep} 缺少当前 profile 已集成事实`, path));
  const sync = planSync({ specs: bundle.specs, deltas: bundle.deltas, history: bundle.history, activeReferences: bundle.activeReferences, changeId: bundle.changeId });
  // Stale baseline is meaningful at every gate; active reference deletion blocks integration.
  diagnostics.push(...sync.diagnostics.filter(d => gate === 'integration' || d.code !== 'SPEC_ACTIVE_REFERENCE'));
  if (bundle.proposal) diagnostics.push(...bundle.proposal.diagnostics);
  if (bundle.tasks) diagnostics.push(...bundle.tasks.diagnostics);
  if (gate === 'draft') return unique(diagnostics);
  if (!bundle.proposal) diagnostics.push(diagnostic('SPEC_PROPOSAL_REQUIRED', 'spec gate 需要 proposal.md', path));
  if (!bundle.design?.content.trim()) diagnostics.push(diagnostic('SPEC_DESIGN_REQUIRED', 'spec gate 需要非空 design.md', path));
  if (!bundle.tasks) diagnostics.push(diagnostic('SPEC_TASKS_REQUIRED', 'spec gate 需要 tasks.md', path));
  if (!bundle.deltas.length && !/无行为|无业务行为|no behaviou?r|docs|infra|文档|基础设施/i.test(bundle.proposal?.content ?? '')) diagnostics.push(diagnostic('SPEC_NO_DELTA_RATIONALE_REQUIRED', '零 delta 变更须在 proposal 说明无行为变化的理由', bundle.proposal?.path ?? path));
  for (const q of bundle.proposal?.questions ?? []) {
    if (q.status === 'unresolved' && q.type === 'behavior') diagnostics.push(diagnostic('SPEC_UNRESOLVED_BEHAVIOR', `行为问题未解决 ${q.id}`, bundle.proposal!.path, q.line));
    if (q.status === 'resolved' && !/\[[^\]]+\]\([^)]+\)|(?:DECISION|EVIDENCE|ADR)-[A-Za-z0-9_-]+|evidence\/|决策证据[:：]\s*\S/.test(q.text)) diagnostics.push(diagnostic('SPEC_QUESTION_EVIDENCE_REQUIRED', `已解决问题 ${q.id} 必须引用决策证据`, bundle.proposal!.path, q.line));
  }
  const ruleIds = [...(bundle.rules?.content ?? '').matchAll(/^## (RULE-\d{3}) (?:—|–|-) .+$/gm)].map(m => m[1]!);
  const seenRules = new Set<string>();
  for (const id of ruleIds) { if (seenRules.has(id)) diagnostics.push(diagnostic('SPEC_DUPLICATE_ID', `长期规则重复 ${id}`, bundle.rules!.path)); seenRules.add(id); }
  const referenced = new Set<string>();
  for (const rule of bundle.proposal?.rules ?? []) {
    if (referenced.has(rule.id)) diagnostics.push(diagnostic('SPEC_DUPLICATE_ID', `规则处置重复 ${rule.id}`, bundle.proposal!.path, rule.line));
    if (!seenRules.has(rule.id)) diagnostics.push(diagnostic('SPEC_RULE_MISSING', `规则引用不存在 ${rule.id}`, bundle.proposal!.path, rule.line));
    referenced.add(rule.id);
  }
  const noRules = /^none\b/i.test(bundle.proposal?.sections.Rules?.trim() ?? '');
  if (!noRules) for (const id of ruleIds) if (!referenced.has(id)) diagnostics.push(diagnostic('SPEC_RULE_DISPOSITION_REQUIRED', `规则 ${id} 缺少适用/不适用处置`, bundle.proposal?.path ?? path));
  const config = bundle.config ?? {};
  const rawModules = config.modules;
  const modules = Array.isArray(rawModules) ? rawModules.filter((m): m is { id: string; paths: string[] } => !!m && typeof m === 'object' && typeof m.id === 'string' && Array.isArray(m.paths) && m.paths.every((p: unknown) => typeof p === 'string')) : [];
  if (rawModules !== undefined && (!Array.isArray(rawModules) || modules.length !== rawModules.length)) diagnostics.push(diagnostic('SPEC_CONFIG_INVALID', '项目 modules 配置格式无效', '.workflow/config.yaml'));
  if (modules.length) for (const id of metadata.modules) if (!modules.some(m => m.id === id)) diagnostics.push(diagnostic('SPEC_MODULE_UNKNOWN', `未知模块 ${id}`, path));
  if ((config.tracking as { required?: boolean } | undefined)?.required && !metadata.tracking) diagnostics.push(diagnostic('SPEC_TRACKING_REQUIRED', '项目策略要求 tracking 引用', path));
  const rawCommands = (config.validation as { commands?: unknown } | undefined)?.commands;
  const commands = Array.isArray(rawCommands) ? rawCommands.filter(c => c && typeof c === 'object' && typeof c.id === 'string').map(c => c.id as string) : [];
  if (rawCommands !== undefined && (!Array.isArray(rawCommands) || commands.length !== rawCommands.length)) diagnostics.push(diagnostic('SPEC_CONFIG_INVALID', '项目 validation.commands 配置格式无效', '.workflow/config.yaml'));
  const validReqs = new Set([...bundle.specs.flatMap(s => s.requirements.map(r => r.id)), ...bundle.deltas.flatMap(d => d.requirements.filter(r => r.operation !== 'REMOVE').map(r => r.id))]);
  for (const d of bundle.deltas) for (const r of d.requirements) if (r.operation === 'REMOVE') validReqs.delete(r.id);
  const tasks = bundle.tasks?.tasks ?? [];
  for (const task of tasks) {
    for (const req of task.requires) if (!validReqs.has(req)) diagnostics.push(diagnostic('TASK_REQUIREMENT_MISSING', `任务引用不存在的需求 ${req}`, task.path, task.line));
    for (const dep of task.dependsOn) if (!tasks.some(t => t.id === dep)) diagnostics.push(diagnostic('TASK_DEPENDENCY_MISSING', `任务依赖不存在 ${dep}`, task.path, task.line));
    for (const scope of [...task.writeScopes, ...task.testScopes]) if (!validScope(scope)) diagnostics.push(diagnostic('TASK_SCOPE_INVALID', `无效路径范围 ${scope}`, task.path, task.line));
    for (const scope of task.testScopes) if (!task.writeScopes.some(s => scopeWithin(scope, s))) diagnostics.push(diagnostic('TASK_TEST_SCOPE_OUTSIDE_WRITE', `测试范围不属于写入范围 ${scope}`, task.path, task.line));
    const allowed = modules.filter(m => metadata.modules.includes(m.id)).flatMap(m => m.paths ?? []);
    if (modules.length) for (const scope of task.writeScopes) if (!allowed.some(s => scopeWithin(scope, s))) diagnostics.push(diagnostic('TASK_SCOPE_OUTSIDE_MODULE', `写入范围未被模块授权 ${scope}`, task.path, task.line));
    for (const command of task.testCommands) if (!KEBAB_ID.test(command) || !commands.includes(command)) diagnostics.push(diagnostic('TASK_COMMAND_UNKNOWN', `测试命令未在项目声明 ${command}`, task.path, task.line));
  }
  diagnostics.push(...cycles(tasks.map(t => ({ id: t.id, dependencies: t.dependsOn, path: t.path, line: t.line })), 'TASK_DEPENDENCY_CYCLE'));
  diagnostics.push(...traceChange(bundle).diagnostics.filter(d => d.code === 'TRACE_MISSING_TASK'));
  if (gate === 'integration') {
    const e = bundle.integrationEvidence;
    if (!e?.current || !e.approval) diagnostics.push(diagnostic('SPEC_APPROVAL_REQUIRED', '缺少当前输入有效的批准证据', path));
    if (!e?.current || !e.codeReview) diagnostics.push(diagnostic('SPEC_CODE_REVIEW_REQUIRED', '缺少当前输入有效的独立 CR 证据', path));
    if (!e?.current || !e.verification) diagnostics.push(diagnostic('SPEC_VERIFICATION_REQUIRED', '缺少当前输入有效的 Verify 证据', path));
    diagnostics.push(...traceChange(bundle).diagnostics);
  }
  return unique(diagnostics);
}
function unique(diagnostics: Diagnostic[]): Diagnostic[] {
  return diagnostics.filter((d, i) => diagnostics.findIndex(x => x.code === d.code && x.path === d.path && x.line === d.line && x.message === d.message) === i);
}
