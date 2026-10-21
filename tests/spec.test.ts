import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sha256 } from '../src/shared/hash.js';
import { emptyHistory, loadChange, parseDelta, parseMetadata, parseProposal, parseSpec, parseTasks, planArchive, planRebaseline, planSync, rebuildHistory, resolveRebaseline, taskPlanFingerprint, traceChange, validateChange, validateHistory, verifyArchiveProjection } from '../src/spec/index.js';
import type { ChangeBundle, SpecDocument } from '../src/spec/index.js';

const fm = (baseHash: string | null, capability = 'session') => `---\nformatVersion: 1\ncapability: ${capability}\nbaseHash: ${baseHash}\n---\n# 会话\n\n`;
const requirement = (operation = 'ADD', scenarios = '01', body = '系统应拒绝过期会话。') => `## ${operation ? operation + ' ' : ''}REQ-SESSION-001 — 会话\n${body}\n${operation === 'UPDATE' ? '- Removed-Scenarios: none\n' : ''}\n${scenarios.split(',').filter(Boolean).map(id => `### SCN-SESSION-001-${id} — 场景\n- GIVEN 会话过期\n- WHEN 访问\n- THEN 要求认证\n- AND 数据保留\n`).join('\n')}`;
const delta = (base: SpecDocument | null = null, op = 'ADD', scenarios = '01') => parseDelta(fm(base ? sha256(base.content) : null) + requirement(op, scenarios), 'delta.md');
const metadata = () => parseMetadata('formatVersion: 1\nid: session-timeout\ntitle: 会话\nmodules: [app]\ndependsOn: []\n');
const proposal = () => parseProposal('# Proposal\n\n## Problem\n会话过期问题\n## Goals\n认证\n## Scope\n会话\n## Non-goals\n业务数据\n## Acceptance\n场景通过\n## Rules\nnone：项目无适用长期规则\n## Open questions\nnone\n');
const tasks = () => parseTasks('## TASK-001 — 实现认证\n- Status: pending\n- Requires: REQ-SESSION-001\n- Depends-On: none\n- Write-Scopes: src/session/**, tests/session/**\n- Test-Mode: tdd\n- Test-Scopes: tests/session/**\n- Test-Commands: app-test\n- Acceptance: 会话场景通过\n');
function bundle(): ChangeBundle {
  return { projectRoot: '/project', changeId: 'session-timeout', metadata: metadata(), proposal: proposal(), design: { path: 'design.md', line: 1, content: '方案与验证' }, tasks: tasks(), deltas: [delta()], specs: [], history: emptyHistory(), archives: [], activeChanges: [], activeReferences: [], diagnostics: [], config: { modules: [{ id: 'app', paths: ['src/**', 'tests/**'] }], validation: { commands: [{ id: 'app-test' }] } } };
}
function formal(d = delta()): SpecDocument { return parseSpec(planSync({ specs: [], deltas: [d] }).writes[0]!.content, 'spec.md'); }
const codes = (diagnostics: { code: string }[]) => diagnostics.map(d => d.code);

test('example delta parses, and projection preserves complete scenarios and AND lexical meaning', async () => {
  const d = parseDelta(await readFile('examples/change/specs/session/delta.md', 'utf8'));
  assert.deepEqual(d.diagnostics, []);
  assert.equal(d.requirements[0]?.scenarios[0]?.then.length, 2);
  const plan = planSync({ specs: [], deltas: [d] });
  assert.deepEqual(plan.diagnostics, []); assert.equal(plan.writes.length, 1);
  const result = parseSpec(plan.writes[0]!.content);
  assert.deepEqual(result.diagnostics, []); assert.equal(result.requirements[0]!.scenarios.length, 3);
  assert.deepEqual(result.requirements[0]!.scenarios[0]!.then, d.requirements[0]!.scenarios[0]!.then);
});
test('unsupported version, duplicate YAML, unknown field, capability and stable line diagnostics', () => {
  assert.ok(codes(parseMetadata('formatVersion: 2\nid: ../bad\nmodules: []\ndependsOn: []\nextra: x\n').diagnostics).includes('SPEC_UNSUPPORTED_VERSION'));
  assert.ok(codes(parseMetadata('formatVersion: 1\nid: a\nid: b\n').diagnostics).includes('SPEC_YAML_INVALID'));
  const unknown = parseDelta(fm(null).replace('baseHash: null', 'baseHash: null\nextra: x') + requirement());
  assert.equal(unknown.diagnostics.find(d => d.code === 'SPEC_UNKNOWN_FIELD')?.line, 5);
  assert.ok(codes(parseDelta(fm(null, 'Session') + requirement()).diagnostics).includes('SPEC_INVALID_ID'));
  assert.ok(codes(parseSpec(fm(null) + requirement('')).diagnostics).includes('SPEC_UNKNOWN_FIELD'));
});
test('scenario lexical fixtures reject duplicate, out-of-order, empty and leading AND', () => {
  for (const steps of ['- THEN result\n- WHEN action', '- WHEN action\n- THEN result\n- THEN another', '- AND first\n- WHEN action\n- THEN result', '- WHEN \n- THEN result', '  - WHEN action\n- THEN result']) {
    const d = parseDelta(fm(null) + `## ADD REQ-SESSION-001 — 需求\n行为\n### SCN-SESSION-001-01 — 场景\n${steps}\n`);
    assert.ok(d.diagnostics.length, steps); assert.ok(d.diagnostics.every(d => (d.line ?? 0) > 0));
  }
  assert.deepEqual(parseDelta((fm(null) + requirement()).replaceAll('\n', '\r\n')).diagnostics, []);
});
test('ADD collision, UPDATE complete replacement and explicit deletion requirements', () => {
  const base = formal(delta(null, 'ADD', '01,02'));
  assert.ok(codes(planSync({ specs: [base], deltas: [delta(base)] }).diagnostics).includes('SPEC_ADD_EXISTS'));
  const update = delta(base, 'UPDATE', '01');
  assert.ok(codes(planSync({ specs: [base], deltas: [update] }).diagnostics).includes('SPEC_SCENARIO_REMOVAL_MISMATCH'));
  const explicit = parseDelta(update.content.replace('- Removed-Scenarios: none', '- Removed-Scenarios: SCN-SESSION-001-02\n- Removal-Reason: SCN-SESSION-001-02 — 场景合并至 SCN-SESSION-001-01'));
  const plan = planSync({ specs: [base], deltas: [explicit] });
  assert.deepEqual(plan.diagnostics, []); assert.equal(plan.removed[0]!.id, 'SCN-SESSION-001-02');
  assert.equal(parseSpec(plan.writes[0]!.content).requirements[0]!.scenarios.length, 1);
  const bogus = parseDelta(explicit.content.replace('Removed-Scenarios: SCN-SESSION-001-02', 'Removed-Scenarios: SCN-SESSION-001-01'));
  assert.ok(codes(planSync({ specs: [base], deltas: [bogus] }).diagnostics).includes('SPEC_SCENARIO_REMOVAL_MISMATCH'));
});
test('REMOVE generates requirement/scenario tombstones, blocks active references and permits empty formal capability', () => {
  const base = formal();
  const remove = parseDelta(fm(sha256(base.content)) + '## REMOVE REQ-SESSION-001 — 会话\n- Reason: 替换为新认证需求\n- Impact: 移除过期判断\n');
  const plan = planSync({ specs: [base], deltas: [remove], changeId: 'remove-session', activeReferences: [{ changeId: 'other', id: 'SCN-SESSION-001-01', path: 'other/tasks.md', line: 8 }] });
  assert.ok(codes(plan.diagnostics).includes('SPEC_ACTIVE_REFERENCE')); assert.equal(plan.removed.length, 2);
  assert.deepEqual(parseSpec(plan.writes[0]!.content).diagnostics, []);
  assert.equal(parseSpec(plan.writes[0]!.content).requirements.length, 0);
});
test('raw UTF-8 baseline conflict includes CRLF differences and same capability deltas conflict', () => {
  const base = formal(); const d = delta(base, 'UPDATE');
  const changed = parseSpec(base.content.replaceAll('\n', '\r\n'));
  assert.ok(codes(planSync({ specs: [changed], deltas: [d] }).diagnostics).includes('SPEC_STALE_BASE'));
  assert.ok(codes(planSync({ specs: [base], deltas: [d, d] }).diagnostics).includes('SPEC_DUPLICATE_CAPABILITY'));
});
test('metadata, task semantics, unknown commands, scopes, cycles and status-independent plan fingerprint', () => {
  const b = bundle(); assert.deepEqual(validateChange(b), []);
  const changed = parseTasks(b.tasks!.content.replace('pending', 'done'));
  assert.equal(taskPlanFingerprint(changed.tasks), taskPlanFingerprint(b.tasks!.tasks));
  b.tasks = parseTasks(b.tasks!.content.replace('Depends-On: none', 'Depends-On: TASK-001').replace('tests/session/**\n- Test-Commands', 'outside/**\n- Test-Commands').replace('app-test', 'unknown'));
  const errors = codes(validateChange(b));
  assert.ok(errors.includes('TASK_DEPENDENCY_CYCLE')); assert.ok(errors.includes('TASK_TEST_SCOPE_OUTSIDE_WRITE')); assert.ok(errors.includes('TASK_COMMAND_UNKNOWN'));
  assert.ok(codes(parseTasks(tasks().content.replace('Test-Mode: tdd', 'Test-Mode: exempt')).diagnostics).includes('TASK_TEST_RATIONALE_REQUIRED'));
});
test('spec rejects unresolved behavior, dangling rules and resolved questions without decision evidence', () => {
  const b = bundle();
  b.proposal = parseProposal(b.proposal!.content.replace('## Open questions\nnone', '## Open questions\n- QUESTION-001 | unresolved | behavior | 超时阈值？\n- QUESTION-002 | resolved | behavior | 已处理\n').replace('none：项目无适用长期规则', '- RULE-999: 测试'));
  const errors = codes(validateChange(b)); assert.ok(errors.includes('SPEC_UNRESOLVED_BEHAVIOR')); assert.ok(errors.includes('SPEC_QUESTION_EVIDENCE_REQUIRED')); assert.ok(errors.includes('SPEC_RULE_MISSING'));
});
test('integration fails closed on missing external approval/CR/Verify even if task done, and trace requires real result', () => {
  const b = bundle(); b.tasks = parseTasks(b.tasks!.content.replace('pending', 'done'));
  const errors = codes(validateChange(b, 'integration'));
  for (const code of ['SPEC_APPROVAL_REQUIRED', 'SPEC_CODE_REVIEW_REQUIRED', 'SPEC_VERIFICATION_REQUIRED', 'TRACE_MISSING_SCENARIO']) assert.ok(errors.includes(code));
  b.integrationEvidence = { current: true, approval: true, codeReview: true, verification: true, scenarioEvidence: [{ scenarioId: 'SCN-SESSION-001-01', taskId: 'TASK-001', mode: 'manual', outcome: 'failed', evidenceId: 'manual-001' }] };
  assert.equal(traceChange(b).entries[0]!.covered, false);
  b.integrationEvidence.scenarioEvidence[0]!.outcome = 'passed'; assert.deepEqual(validateChange(b, 'integration'), []);
  b.integrationEvidence.scenarioEvidence[0]!.evidenceId = 'placeholder'; assert.equal(traceChange(b).entries[0]!.covered, false);
});
test('change dependencies need current integration facts; historical directory alone is insufficient', () => {
  const b = bundle(); b.metadata.value.dependsOn = ['base-change']; b.activeChanges.push({ ...metadata().value, id: 'base-change', dependsOn: [] });
  assert.ok(codes(validateChange(b, 'integration')).includes('SPEC_DEPENDENCY_NOT_INTEGRATED'));
  b.activeChanges[0]!.dependsOn = ['session-timeout']; assert.ok(codes(validateChange(b)).includes('SPEC_DEPENDENCY_CYCLE'));
});
test('zero delta has empty specification write set and still archives change identity', () => {
  const b = bundle(); b.deltas = []; b.tasks = parseTasks(tasks().content.replace('REQ-SESSION-001', 'none') + '- Rationale: docs 维护无业务行为\n'); b.proposal!.content += '\n仅 docs 文档，无行为变化。';
  assert.deepEqual(validateChange(b), []);
  const plan = planArchive({ bundle: b, transactionId: 'txn-001' });
  assert.deepEqual(plan.sync.writes, []); assert.deepEqual(plan.metadata.deltaHashes, {}); assert.deepEqual(plan.metadata.inputHashes, {}); assert.deepEqual(plan.history.removed, []); assert.equal(plan.history.changes[0]!.changeId, b.changeId);
});
test('archive projection, history rebuild, tamper detection and ID reuse', () => {
  const b = bundle(); const plan = planArchive({ bundle: b, transactionId: 'txn-001' });
  assert.deepEqual(plan.diagnostics, []);
  const archives = [{ path: plan.metadata.archivePath, content: plan.metadataContent, metadata: plan.metadata }];
  assert.deepEqual(validateHistory(plan.history, archives), []); assert.deepEqual(rebuildHistory(archives).history, plan.history);
  const outputs = plan.sync.writes.map(w => parseSpec(w.content, w.path));
  assert.deepEqual(verifyArchiveProjection(plan.metadata, b.deltas, [], outputs, plan.history, archives), []);
  outputs[0] = parseSpec(outputs[0]!.content.replace('要求认证', '允许访问'));
  assert.ok(codes(verifyArchiveProjection(plan.metadata, b.deltas, [], outputs, plan.history, archives)).includes('SPEC_ARCHIVE_OUTPUT_MISMATCH'));
  const badHistory = structuredClone(plan.history); badHistory.changes[0]!.archiveMetadataHash = '0'.repeat(64);
  assert.ok(codes(validateHistory(badHistory, archives)).includes('SPEC_HISTORY_ARCHIVE_MISMATCH'));
  b.history = plan.history; b.archives = archives; assert.ok(codes(validateChange(b)).includes('SPEC_CHANGE_ID_REUSED'));
  const history = emptyHistory(); history.removed.push({ kind: 'scenario', id: 'SCN-SESSION-001-01', capability: 'session', parentRequirementId: 'REQ-SESSION-001', changeId: 'old', transactionId: 'txn-old', reason: '删除' });
  assert.ok(codes(planSync({ specs: [], deltas: [delta()], history }).diagnostics).includes('SPEC_HISTORY_ID_REUSED'));
});
test('history rejects malformed nested records and archive unknown fields without accepting a weaker source', () => {
  const b = bundle(); const plan = planArchive({ bundle: b, transactionId: 'txn-001' });
  const invalid = { ...plan.metadata, unknown: true };
  const content = JSON.stringify(invalid);
  const history = structuredClone(plan.history); history.changes[0]!.archiveMetadataHash = sha256(content);
  assert.ok(codes(validateHistory(history, [{ path: invalid.archivePath, content, metadata: invalid }])).includes('SPEC_ARCHIVE_INVALID'));
  const corrupt = { ...history, removed: [null] } as unknown as typeof history;
  assert.ok(codes(validateHistory(corrupt, [])).includes('SPEC_HISTORY_INVALID'));
});
test('three-way rebaseline requires original snapshot, explicit conflict resolution and fresh input', () => {
  const base = formal(); const current = parseSpec(base.content.replace('要求认证', '要求二次认证'));
  const d = parseDelta(delta(base, 'UPDATE').content.replace('要求认证', '禁止所有访问'));
  const input = { baseSpecs: [base], currentSpecs: [current], deltas: [d], changeId: 'session-timeout', owner: 'owner-1', revision: 2 };
  const plan = planRebaseline(input); assert.deepEqual(plan.diagnostics, []); assert.ok(plan.conflicts.some(c => c.id === 'REQ-SESSION-001')); assert.ok(plan.conflicts.some(c => c.id === 'SCN-SESSION-001-01'));
  assert.ok(codes(planRebaseline({ ...input, baseSpecs: [] }).diagnostics).includes('SPEC_REBASELINE_BASE_UNAVAILABLE'));
  const content = d.content.replace(sha256(base.content), sha256(current.content));
  const resolution = { formatVersion: 1 as const, planId: plan.planId, deltas: [{ capability: 'session', content, resolvedConflicts: plan.conflicts.map(c => ({ id: c.id, rationale: '当前行为与新授权意图冲突，采用新规则' })) }] };
  const resolved = resolveRebaseline(plan, input, resolution); assert.deepEqual(resolved.diagnostics, []); assert.equal(resolved.writes[0]!.path, '.workflow/changes/session-timeout/specs/session/delta.md'); assert.ok(resolved.invalidates.includes('verification'));
  assert.ok(codes(resolveRebaseline(plan, { ...input, revision: 3 }, resolution).diagnostics).includes('SPEC_REBASELINE_STALE_PLAN'));
  resolution.deltas[0]!.resolvedConflicts = []; assert.equal(resolveRebaseline(plan, input, resolution).writes.length, 0);
});
test('loader handles paths with spaces/Chinese, immutable bytes, missing tasks at draft, and rejects symlinks', async () => {
  const root = await mkdtemp(join(tmpdir(), 'workflow 规格 '));
  try {
    const change = join(root, '.workflow/changes/session-timeout'); await mkdir(join(change, 'specs/session'), { recursive: true });
    await writeFile(join(change, 'change.yaml'), metadata().content); await writeFile(join(change, 'proposal.md'), proposal().content); await writeFile(join(change, 'specs/session/delta.md'), delta().content.trimEnd());
    const b = await loadChange(root, 'session-timeout'); assert.equal(b.deltas[0]!.content.endsWith('\n'), false); assert.deepEqual(validateChange(b, 'draft'), []); assert.ok(codes(validateChange(b)).includes('SPEC_TASKS_REQUIRED'));
    await symlink(join(change, 'proposal.md'), join(change, 'tasks.md')); await assert.rejects(loadChange(root, 'session-timeout'), { code: 'SPEC_SYMLINK_REJECTED' });
    await assert.rejects(loadChange(root, '../escape'), { code: 'SPEC_INVALID_ID' });
  } finally { await rm(root, { recursive: true, force: true }); }
});
