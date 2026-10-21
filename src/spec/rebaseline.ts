import type { Diagnostic } from '../shared/errors.js';
import { sha256, stableStringify } from '../shared/hash.js';
import { diagnostic, parseDelta, parseSpec } from './parser.js';
import { planSync } from './sync.js';
import type { ActiveReference, HistoryIndex, Requirement, SpecDocument } from './types.js';

export interface RebaselineConflict { id: string; capability: string; reason: 'both-modified' | 'delete-modify' | 'active-reference'; base: string | null; current: string | null; proposed: string | null }
export interface RebaselineInput { baseSpecs: SpecDocument[]; currentSpecs: SpecDocument[]; deltas: SpecDocument[]; history?: HistoryIndex; activeReferences?: ActiveReference[]; changeId?: string; owner?: string; revision?: number }
export interface RebaselinePlan { formatVersion: 1; planId: string; capabilities: string[]; oldHashes: Record<string, string | null>; currentHashes: Record<string, string | null>; deltaHashes: Record<string, string>; conflicts: RebaselineConflict[]; diagnostics: Diagnostic[]; owner?: string; revision?: number }
const semantic = (req: Requirement | undefined): string | null => req ? stableStringify({ id: req.id, title: req.title, body: req.body, scenarios: req.scenarios.map(s => ({ id: s.id, title: s.title, given: s.given, when: s.when, then: s.then })) }) : null;
/** baseSpecs must come from a fixed Git object or immutable snapshot; hashes are always checked. */
export function planRebaseline(input: RebaselineInput): RebaselinePlan {
  const diagnostics: Diagnostic[] = []; const conflicts: RebaselineConflict[] = []; const oldHashes: RebaselinePlan['oldHashes'] = {}, currentHashes: RebaselinePlan['currentHashes'] = {}, deltaHashes: RebaselinePlan['deltaHashes'] = {};
  const capabilities = input.deltas.map(d => d.capability);
  for (const delta of input.deltas) {
    const old = input.baseSpecs.find(s => s.capability === delta.capability); const current = input.currentSpecs.find(s => s.capability === delta.capability);
    const oldHash = old ? sha256(old.content) : null;
    oldHashes[delta.capability] = oldHash; currentHashes[delta.capability] = current ? sha256(current.content) : null; deltaHashes[delta.capability] = sha256(delta.content);
    if (oldHash !== delta.baseHash) { diagnostics.push(diagnostic('SPEC_REBASELINE_BASE_UNAVAILABLE', '缺少通过原 baseHash 核实的旧规格快照；不能猜测', delta.path, 4)); continue; }
    const projection = planSync({ specs: old ? [old] : [], deltas: [delta], history: input.history }); diagnostics.push(...projection.diagnostics);
    if (projection.diagnostics.length) continue;
    const proposed = parseSpec(projection.writes[0]!.content);
    for (const operation of delta.requirements) {
      const baseReq = old?.requirements.find(r => r.id === operation.id); const currentReq = current?.requirements.find(r => r.id === operation.id); const proposedReq = proposed.requirements.find(r => r.id === operation.id);
      const a = semantic(baseReq), b = semantic(currentReq), c = semantic(proposedReq);
      if (a !== b && a !== c && b !== c) conflicts.push({ id: operation.id, capability: delta.capability, reason: !b || !c ? 'delete-modify' : 'both-modified', base: a, current: b, proposed: c });
      const oldScenarios = baseReq?.scenarios ?? [];
      for (const scenario of oldScenarios) {
        const scnValue = (list: Requirement['scenarios'] | undefined) => { const s = list?.find(s => s.id === scenario.id); return s ? stableStringify({ title: s.title, given: s.given, when: s.when, then: s.then }) : null; };
        const sa = scnValue(oldScenarios), sb = scnValue(currentReq?.scenarios), sc = scnValue(proposedReq?.scenarios);
        if (sa !== sb && sa !== sc && sb !== sc) conflicts.push({ id: scenario.id, capability: delta.capability, reason: !sb || !sc ? 'delete-modify' : 'both-modified', base: sa, current: sb, proposed: sc });
      }
    }
    for (const removed of projection.removed) for (const ref of input.activeReferences ?? []) if (ref.id === removed.id && ref.changeId !== input.changeId) conflicts.push({ id: removed.id, capability: delta.capability, reason: 'active-reference', base: ref.path, current: ref.changeId, proposed: null });
  }
  const value = { formatVersion: 1 as const, capabilities, oldHashes, currentHashes, deltaHashes, conflicts, diagnostics, ...(input.owner ? { owner: input.owner } : {}), ...(input.revision !== undefined ? { revision: input.revision } : {}) };
  return { ...value, planId: sha256(stableStringify(value)) };
}
export interface RebaselineResolution { formatVersion: 1; planId: string; deltas: { capability: string; content: string; resolvedConflicts: { id: string; rationale: string }[] }[] }
/** Produces a write plan only. Runtime must atomically recheck these preconditions before applying. */
export function resolveRebaseline(plan: RebaselinePlan, input: RebaselineInput, resolution: RebaselineResolution): { writes: { path: string; content: string; beforeHash: string; afterHash: string }[]; diagnostics: Diagnostic[]; invalidates: string[] } {
  const diagnostics = [...plan.diagnostics]; const writes: { path: string; content: string; beforeHash: string; afterHash: string }[] = [];
  const actual = planRebaseline(input);
  if (actual.planId !== plan.planId || resolution?.formatVersion !== 1 || resolution.planId !== plan.planId) diagnostics.push(diagnostic('SPEC_REBASELINE_STALE_PLAN', '重新基线计划、owner/revision 或输入已经变化', 'resolution.json'));
  if (!resolution || Object.keys(resolution).some(k => !['formatVersion', 'planId', 'deltas'].includes(k)) || !Array.isArray(resolution.deltas)) return { writes: [], diagnostics: [...diagnostics, diagnostic('SPEC_REBASELINE_RESOLUTION_INVALID', 'resolution 格式无效', 'resolution.json')], invalidates: [] };
  const seen = new Set<string>(); const parsed: SpecDocument[] = [];
  for (const entry of resolution.deltas) {
    if (!entry || Object.keys(entry).some(k => !['capability', 'content', 'resolvedConflicts'].includes(k)) || !plan.capabilities.includes(entry.capability) || seen.has(entry.capability) || typeof entry.content !== 'string' || !Array.isArray(entry.resolvedConflicts)) { diagnostics.push(diagnostic('SPEC_REBASELINE_RESOLUTION_INVALID', 'resolution capability 重复、未知或包含任意路径/字段', 'resolution.json')); continue; }
    seen.add(entry.capability);
    const path = `.workflow/changes/${input.changeId ?? 'change'}/specs/${entry.capability}/delta.md`;
    const delta = parseDelta(entry.content, path); parsed.push(delta); diagnostics.push(...delta.diagnostics);
    if (delta.capability !== entry.capability) diagnostics.push(diagnostic('SPEC_CAPABILITY_PATH_MISMATCH', 'resolution 内容 capability 不匹配', path));
    const required = plan.conflicts.filter(c => c.capability === entry.capability);
    const resolved = new Set<string>();
    for (const c of entry.resolvedConflicts) {
      if (!c || typeof c.id !== 'string' || typeof c.rationale !== 'string' || !c.rationale.trim() || !required.some(x => x.id === c.id) || resolved.has(c.id)) diagnostics.push(diagnostic('SPEC_REBASELINE_RESOLUTION_INVALID', '冲突解决项缺少理由、重复或引用未知 ID', path));
      else resolved.add(c.id);
    }
    for (const c of required) if (!resolved.has(c.id)) diagnostics.push(diagnostic('SPEC_REBASELINE_CONFLICT_UNRESOLVED', `冲突缺少显式解决 ${c.id}`, path));
    writes.push({ path, content: entry.content, beforeHash: plan.deltaHashes[entry.capability]!, afterHash: sha256(entry.content) });
  }
  for (const capability of plan.capabilities) if (!seen.has(capability)) diagnostics.push(diagnostic('SPEC_REBASELINE_RESOLUTION_INVALID', `resolution 缺少 capability ${capability}`, 'resolution.json'));
  diagnostics.push(...planSync({ specs: input.currentSpecs, deltas: parsed, history: input.history, activeReferences: input.activeReferences, changeId: input.changeId }).diagnostics);
  return { writes: diagnostics.length ? [] : writes, diagnostics, invalidates: diagnostics.length ? [] : ['spec-approval', 'plan-approval', 'dispatch', 'code-review', 'verification', 'archive', 'final-check'] };
}
