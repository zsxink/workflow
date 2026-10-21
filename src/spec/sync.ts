import { sha256, stableStringify } from '../shared/hash.js';
import type { Diagnostic } from '../shared/errors.js';
import { diagnostic, KEBAB_ID, parseSpec } from './parser.js';
import type { ActiveReference, ArchiveMetadata, ArchivePlan, ArchiveRecord, ChangeBundle, HistoryIndex, Requirement, SpecDocument, SyncPlan } from './types.js';

export const emptyHistory = (): HistoryIndex => ({ formatVersion: 1, changes: [], removed: [] });
const TX_ID = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const HASH = /^[a-f0-9]{64}$/;
const ARCHIVE_PATH = /^\.workflow\/archive\/[a-z0-9][a-z0-9-]*$/;
function fieldsAre(value: unknown, keys: string[]): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === keys.length && keys.every(k => Object.hasOwn(value, k));
}
function validRemoved(item: unknown): boolean {
  if (!fieldsAre(item, ['kind', 'id', 'capability', 'parentRequirementId', 'changeId', 'transactionId', 'reason'])) return false;
  if (typeof item.capability !== 'string' || !KEBAB_ID.test(item.capability) || typeof item.changeId !== 'string' || !KEBAB_ID.test(item.changeId) || typeof item.transactionId !== 'string' || !TX_ID.test(item.transactionId) || typeof item.reason !== 'string' || !item.reason.trim()) return false;
  const prefix = item.capability.toUpperCase();
  return item.kind === 'requirement' ? typeof item.id === 'string' && new RegExp(`^REQ-${prefix}-\\d{3}$`).test(item.id) && item.parentRequirementId === null : item.kind === 'scenario' && typeof item.id === 'string' && new RegExp(`^SCN-${prefix}-\\d{3}-\\d{2}$`).test(item.id) && typeof item.parentRequirementId === 'string' && item.id.slice(0, -3).replace(/^SCN-/, 'REQ-') === item.parentRequirementId;
}
function hashMap(value: unknown, nullable = false): boolean {
  return !!value && typeof value === 'object' && !Array.isArray(value) && Object.entries(value).every(([k, v]) => KEBAB_ID.test(k) && (nullable && v === null || typeof v === 'string' && HASH.test(v)));
}
export function validateHistory(history: HistoryIndex, archives: ArchiveRecord[] = []): Diagnostic[] {
  const diagnostics: Diagnostic[] = []; const path = '.workflow/specs/history.json';
  if (!history || history.formatVersion !== 1 || !Array.isArray(history.changes) || !Array.isArray(history.removed)) return [diagnostic('SPEC_HISTORY_INVALID', '历史索引格式无效或版本不支持', path)];
  const keys = Object.keys(history); if (keys.some(k => !['formatVersion', 'changes', 'removed'].includes(k))) diagnostics.push(diagnostic('SPEC_HISTORY_INVALID', '历史索引包含未知字段', path));
  const changes = new Set<string>(); const ids = new Set<string>();
  for (const change of history.changes) {
    if (!fieldsAre(change, ['changeId', 'archivePath', 'transactionId', 'archiveMetadataHash']) || typeof change.changeId !== 'string' || !KEBAB_ID.test(change.changeId) || typeof change.archivePath !== 'string' || !ARCHIVE_PATH.test(change.archivePath) || typeof change.transactionId !== 'string' || !TX_ID.test(change.transactionId) || typeof change.archiveMetadataHash !== 'string' || !HASH.test(change.archiveMetadataHash)) { diagnostics.push(diagnostic('SPEC_HISTORY_INVALID', '历史变更登记格式无效', path)); continue; }
    if (changes.has(change.changeId)) diagnostics.push(diagnostic('SPEC_HISTORY_DUPLICATE', `历史变更重复 ${change.changeId}`, path));
    changes.add(change.changeId);
    const archive = archives.find(a => a.path === change.archivePath);
    if (!archive || sha256(archive.content) !== change.archiveMetadataHash || archive.metadata.changeId !== change.changeId || archive.metadata.transactionId !== change.transactionId || archive.metadata.archivePath !== change.archivePath || archive.metadata.formatVersion !== 1) diagnostics.push(diagnostic('SPEC_HISTORY_ARCHIVE_MISMATCH', `历史登记与归档元数据不一致 ${change.changeId}`, path));
  }
  for (const item of history.removed) {
    if (!validRemoved(item)) { diagnostics.push(diagnostic('SPEC_HISTORY_INVALID', '历史删除记录格式无效', path)); continue; }
    if (ids.has(item.id)) diagnostics.push(diagnostic('SPEC_HISTORY_DUPLICATE', `历史删除 ID 重复 ${item.id}`, path));
    ids.add(item.id);
    const registration = history.changes.find(c => c && c.changeId === item.changeId && c.transactionId === item.transactionId);
    if (!registration) diagnostics.push(diagnostic('SPEC_HISTORY_ARCHIVE_MISMATCH', `删除 ID 缺少对应变更登记 ${item.id}`, path));
  }
  const archivePaths = new Set<string>();
  for (const archive of archives) {
    const m = archive.metadata;
    if (archivePaths.has(archive.path)) diagnostics.push(diagnostic('SPEC_HISTORY_DUPLICATE', '归档路径重复', archive.path));
    archivePaths.add(archive.path);
    let decoded: unknown; try { decoded = JSON.parse(archive.content); } catch { diagnostics.push(diagnostic('SPEC_ARCHIVE_INVALID', '归档元数据 JSON 无效', archive.path)); continue; }
    if (!fieldsAre(m, ['formatVersion', 'changeId', 'transactionId', 'archivePath', 'deltaHashes', 'inputHashes', 'outputHashes', 'fingerprints', 'removed']) || m.formatVersion !== 1 || typeof m.changeId !== 'string' || !KEBAB_ID.test(m.changeId) || typeof m.transactionId !== 'string' || !TX_ID.test(m.transactionId) || !ARCHIVE_PATH.test(m.archivePath) || !Array.isArray(m.removed) || m.removed.some(r => !validRemoved(r) || r.changeId !== m.changeId || r.transactionId !== m.transactionId) || !hashMap(m.deltaHashes) || !hashMap(m.inputHashes, true) || !hashMap(m.outputHashes) || !m.fingerprints || typeof m.fingerprints !== 'object' || Array.isArray(m.fingerprints) || Object.values(m.fingerprints).some(v => typeof v !== 'string' || !HASH.test(v)) || stableStringify(decoded) !== stableStringify(m)) { diagnostics.push(diagnostic('SPEC_ARCHIVE_INVALID', '归档元数据字段、摘要或删除记录无效', archive.path)); continue; }
    const registration = history.changes.find(c => c && c.archivePath === archive.path && c.changeId === m.changeId && c.transactionId === m.transactionId);
    if (!registration) diagnostics.push(diagnostic('SPEC_HISTORY_ARCHIVE_MISMATCH', `归档缺少历史登记 ${m.changeId}`, archive.path));
    const indexed = history.removed.filter(r => r && r.changeId === m.changeId && r.transactionId === m.transactionId);
    if (stableStringify([...indexed].sort((a, b) => a.id.localeCompare(b.id))) !== stableStringify([...m.removed].sort((a, b) => a.id.localeCompare(b.id)))) diagnostics.push(diagnostic('SPEC_HISTORY_ARCHIVE_MISMATCH', '归档删除记录与历史索引不同', archive.path));
  }
  return diagnostics;
}
function renderRequirement(req: Requirement): string {
  const body = req.body.split('\n').filter(l => !/^- (Removed-Scenarios|Removal-Reason):/.test(l)).join('\n').trim();
  return [`## ${req.id} — ${req.title}`, body, ...req.scenarios.map(s => [`### ${s.id} — ${s.title}`, ...(s.given.length ? [`- GIVEN ${s.given[0]}`, ...s.given.slice(1).map(t => `- AND ${t}`)] : []), `- WHEN ${s.when[0]}`, ...s.when.slice(1).map(t => `- AND ${t}`), `- THEN ${s.then[0]}`, ...s.then.slice(1).map(t => `- AND ${t}`)].join('\n'))].join('\n\n');
}
export function renderSpec(capability: string, title: string, requirements: Requirement[]): string {
  return `---\nformatVersion: 1\ncapability: ${capability}\n---\n# ${title}\n\n${requirements.map(renderRequirement).join('\n\n')}\n`;
}
export interface SyncInput { specs: SpecDocument[]; deltas: SpecDocument[]; history?: HistoryIndex; archives?: ArchiveRecord[]; activeReferences?: ActiveReference[]; changeId?: string }
export function planSync(input: SyncInput): SyncPlan {
  const history = input.history ?? emptyHistory(); const diagnostics: Diagnostic[] = [];
  const writes: SyncPlan['writes'] = []; const removed: SyncPlan['removed'] = [];
  const inputHashes: SyncPlan['inputHashes'] = {}; const deltaHashes: SyncPlan['deltaHashes'] = {};
  // Pure callers may pass an already checked index; archive-aware callers always check both sources.
  if (input.archives !== undefined) diagnostics.push(...validateHistory(history, input.archives));
  else if (!history || history.formatVersion !== 1 || !Array.isArray(history.changes) || !Array.isArray(history.removed) || history.removed.some(r => !validRemoved(r))) diagnostics.push(diagnostic('SPEC_HISTORY_INVALID', '历史索引格式无效', '.workflow/specs/history.json'));
  if (diagnostics.length) return finish();
  const tombstones = new Set(history.removed.map(r => r.id));
  const globalIds = new Map<string, string>(); const capabilities = new Set<string>();
  for (const spec of input.specs) {
    diagnostics.push(...spec.diagnostics);
    if (capabilities.has(spec.capability)) diagnostics.push(diagnostic('SPEC_DUPLICATE_CAPABILITY', `重复 capability ${spec.capability}`, spec.path));
    capabilities.add(spec.capability);
    for (const req of spec.requirements) for (const id of [req.id, ...req.scenarios.map(s => s.id)]) {
      if (globalIds.has(id)) diagnostics.push(diagnostic('SPEC_DUPLICATE_ID', `项目内重复 ID ${id}`, spec.path, req.line));
      if (tombstones.has(id)) diagnostics.push(diagnostic('SPEC_HISTORY_ID_REUSED', `正式规格复用了删除 ID ${id}`, spec.path, req.line));
      globalIds.set(id, spec.capability);
    }
  }
  const deltaCaps = new Set<string>();
  for (const delta of input.deltas) {
    diagnostics.push(...delta.diagnostics);
    if (deltaCaps.has(delta.capability)) { diagnostics.push(diagnostic('SPEC_DUPLICATE_CAPABILITY', `多个 delta 修改 ${delta.capability}`, delta.path)); continue; }
    deltaCaps.add(delta.capability);
    const baseline = input.specs.find(s => s.capability === delta.capability);
    const beforeHash = baseline ? sha256(baseline.content) : null;
    inputHashes[delta.capability] = beforeHash; deltaHashes[delta.capability] = sha256(delta.content);
    if (delta.baseHash !== beforeHash) diagnostics.push(diagnostic('SPEC_STALE_BASE', `基线冲突 ${delta.capability}；需要显式重新基线`, delta.path, 4));
    const reqs = new Map((baseline?.requirements ?? []).map(r => [r.id, r]));
    for (const req of delta.requirements) {
      const old = reqs.get(req.id);
      if (req.operation === 'ADD') {
        if (old || globalIds.has(req.id)) diagnostics.push(diagnostic('SPEC_ADD_EXISTS', `ADD 目标已经存在 ${req.id}`, req.path, req.line));
        if (tombstones.has(req.id)) diagnostics.push(diagnostic('SPEC_HISTORY_ID_REUSED', `已删除需求不能复用 ${req.id}`, req.path, req.line));
      } else if (!old) diagnostics.push(diagnostic('SPEC_TARGET_MISSING', `${req.operation} 目标不存在 ${req.id}`, req.path, req.line));
      for (const scenario of req.scenarios) {
        if (tombstones.has(scenario.id)) diagnostics.push(diagnostic('SPEC_HISTORY_ID_REUSED', `已删除场景不能复用 ${scenario.id}`, scenario.path, scenario.line));
        if (globalIds.has(scenario.id) && !old?.scenarios.some(s => s.id === scenario.id)) diagnostics.push(diagnostic('SPEC_SCENARIO_REASSIGNED', `场景不能迁移或重用 ${scenario.id}`, scenario.path, scenario.line));
      }
      if (req.operation === 'UPDATE' && old) {
        const deleted = old.scenarios.filter(s => !req.scenarios.some(n => n.id === s.id));
        const expected = new Set(deleted.map(s => s.id));
        if (req.removedScenarios.length !== new Set(req.removedScenarios).size || req.removedScenarios.length !== expected.size || req.removedScenarios.some(id => !expected.has(id))) diagnostics.push(diagnostic('SPEC_SCENARIO_REMOVAL_MISMATCH', 'Removed-Scenarios 必须逐项等于被删除的旧场景', req.path, req.line));
        for (const s of deleted) {
          if (!req.removalReasons[s.id]?.trim()) diagnostics.push(diagnostic('SPEC_REMOVAL_REASON_REQUIRED', `缺少场景删除理由 ${s.id}`, req.path, req.line));
          removed.push({ kind: 'scenario', id: s.id, capability: delta.capability, parentRequirementId: old.id, reason: req.removalReasons[s.id] ?? '' });
        }
        for (const id of Object.keys(req.removalReasons)) if (!expected.has(id)) diagnostics.push(diagnostic('SPEC_SCENARIO_REMOVAL_MISMATCH', `删除理由引用未删除场景 ${id}`, req.path, req.line));
      }
      if (req.operation === 'REMOVE' && old) {
        removed.push({ kind: 'requirement', id: old.id, capability: delta.capability, parentRequirementId: null, reason: req.reason ?? '' }, ...old.scenarios.map(s => ({ kind: 'scenario' as const, id: s.id, capability: delta.capability, parentRequirementId: old.id, reason: req.reason ?? '' })));
        reqs.delete(req.id);
      } else reqs.set(req.id, req);
    }
    // An empty capability is still a valid formal document after explicit removal.
    const content = renderSpec(delta.capability, baseline?.title ?? delta.capability, [...reqs.values()]);
    writes.push({ capability: delta.capability, path: `.workflow/specs/${delta.capability}/spec.md`, beforeHash, afterHash: sha256(content), content });
  }
  for (const item of removed) for (const ref of input.activeReferences ?? []) if (ref.changeId !== input.changeId && ref.id === item.id) diagnostics.push(diagnostic('SPEC_ACTIVE_REFERENCE', `删除 ${item.id} 被活动变更 ${ref.changeId} 引用`, ref.path, ref.line));
  return finish();
  function finish(): SyncPlan {
    const payload = { formatVersion: 1 as const, writes, removed, diagnostics, inputHashes, deltaHashes };
    return { ...payload, planId: sha256(stableStringify(payload)) };
  }
}
export interface ArchiveInput { bundle: ChangeBundle; transactionId: string; archivePath?: string; fingerprints?: Record<string, string> }
export function planArchive({ bundle, transactionId, archivePath = `.workflow/archive/${bundle.changeId}`, fingerprints = {} }: ArchiveInput): ArchivePlan {
  const sync = planSync({ specs: bundle.specs, deltas: bundle.deltas, history: bundle.history, archives: bundle.archives, activeReferences: bundle.activeReferences, changeId: bundle.changeId });
  const diagnostics = [...bundle.diagnostics, ...sync.diagnostics];
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(transactionId)) diagnostics.push(diagnostic('SPEC_TRANSACTION_ID_INVALID', 'transaction ID 不能包含路径或控制字符', 'archive.json'));
  if (!/^\.workflow\/archive\/[a-z0-9][a-z0-9-]*$/.test(archivePath)) diagnostics.push(diagnostic('SPEC_ARCHIVE_PATH_INVALID', '归档路径必须位于 .workflow/archive 单层子目录', 'archive.json'));
  if (bundle.history.changes?.some(c => c?.changeId === bundle.changeId)) diagnostics.push(diagnostic('SPEC_CHANGE_ID_REUSED', '变更已登记；重试应核查原事务，不能重复应用 delta', bundle.metadata.path));
  const removed = sync.removed.map(r => ({ ...r, changeId: bundle.changeId, transactionId }));
  const metadata: ArchiveMetadata = { formatVersion: 1, changeId: bundle.changeId, transactionId, archivePath, deltaHashes: sync.deltaHashes, inputHashes: sync.inputHashes, outputHashes: Object.fromEntries(sync.writes.map(w => [w.capability, w.afterHash])), fingerprints, removed };
  const metadataContent = JSON.stringify(metadata, null, 2) + '\n';
  const history: HistoryIndex = { formatVersion: 1, changes: [...bundle.history.changes, { changeId: bundle.changeId, transactionId, archivePath, archiveMetadataHash: sha256(metadataContent) }], removed: [...bundle.history.removed, ...removed] };
  const historyContent = JSON.stringify(history, null, 2) + '\n';
  const moves = [{ from: `.workflow/changes/${bundle.changeId}`, to: archivePath }];
  return { formatVersion: 1, planId: sha256(stableStringify({ sync: sync.planId, metadata, history })), sync, metadata, metadataContent, history, historyContent, moves, diagnostics };
}
/** Verify complete projection from archived inputs; no active directory is needed. */
export function verifyArchiveProjection(metadata: ArchiveMetadata, deltas: SpecDocument[], inputSpecs: SpecDocument[], outputSpecs: SpecDocument[], history: HistoryIndex, archives: ArchiveRecord[]): Diagnostic[] {
  const diagnostics = validateHistory(history, archives);
  const sync = planSync({ specs: inputSpecs, deltas }); diagnostics.push(...sync.diagnostics);
  if (stableStringify(sync.deltaHashes) !== stableStringify(metadata.deltaHashes) || stableStringify(sync.inputHashes) !== stableStringify(metadata.inputHashes) || stableStringify(Object.fromEntries(sync.writes.map(w => [w.capability, w.afterHash]))) !== stableStringify(metadata.outputHashes)) diagnostics.push(diagnostic('SPEC_ARCHIVE_PROJECTION_MISMATCH', '归档输入/输出摘要与完整投影不一致', metadata.archivePath));
  const projectedRemoved = sync.removed.map(r => ({ ...r, changeId: metadata.changeId, transactionId: metadata.transactionId }));
  if (stableStringify(projectedRemoved) !== stableStringify(metadata.removed)) diagnostics.push(diagnostic('SPEC_ARCHIVE_PROJECTION_MISMATCH', '归档删除语义与投影不一致', metadata.archivePath));
  for (const write of sync.writes) {
    const actual = outputSpecs.find(s => s.capability === write.capability);
    if (!actual || actual.content !== write.content || sha256(actual.content) !== metadata.outputHashes[write.capability]) diagnostics.push(diagnostic('SPEC_ARCHIVE_OUTPUT_MISMATCH', '正式规格与归档完整投影不一致', write.path));
    else diagnostics.push(...parseSpec(actual.content, actual.path).diagnostics.filter(d => d.code !== 'SPEC_REQUIREMENT_REQUIRED'));
  }
  return diagnostics;
}
/** Rebuild the derived history only from immutable archive metadata bytes. */
export function rebuildHistory(archives: ArchiveRecord[]): { history: HistoryIndex; diagnostics: Diagnostic[] } {
  const history: HistoryIndex = { formatVersion: 1, changes: archives.map(a => ({ changeId: a.metadata.changeId, archivePath: a.path, transactionId: a.metadata.transactionId, archiveMetadataHash: sha256(a.content) })), removed: archives.flatMap(a => a.metadata.removed ?? []) };
  return { history, diagnostics: validateHistory(history, archives) };
}
