import { parseDocument, LineCounter } from 'yaml';
import type { Diagnostic } from '../shared/errors.js';
import type { ChangeMetadata, MetadataDocument, ProposalDocument, Requirement, Scenario, SpecDocument, Task, TaskDocument } from './types.js';

export const KEBAB_ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const REQ_ID = /^REQ-[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)*-\d{3}$/;
const SCN_ID = /^SCN-[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)*-\d{3}-\d{2}$/;
export const diagnostic = (code: string, message: string, path: string, line = 1): Diagnostic => ({ code, message, path, line, severity: 'error' });
const split = (text: string): string[] => text === 'none' ? [] : text.split(',').map(x => x.trim()).filter(Boolean);
function yamlObject(content: string, path: string, diagnostics: Diagnostic[], offset = 0): Record<string, unknown> {
  const lineCounter = new LineCounter();
  const doc = parseDocument(content, { uniqueKeys: true, lineCounter });
  for (const err of doc.errors) diagnostics.push(diagnostic('SPEC_YAML_INVALID', err.message, path, offset + lineCounter.linePos(err.pos[0]).line));
  let value: unknown;
  try { value = doc.toJS(); } catch {
    diagnostics.push(diagnostic('SPEC_YAML_INVALID', 'YAML 别名或对象无法安全解析', path, offset + 1));
    return {};
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    diagnostics.push(diagnostic('SPEC_METADATA_INVALID', '元数据必须是对象', path, offset + 1));
    return {};
  }
  return value as Record<string, unknown>;
}
function knownFields(value: Record<string, unknown>, allowed: string[], path: string, diagnostics: Diagnostic[], content: string, offset = 0): void {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) diagnostics.push(diagnostic('SPEC_UNKNOWN_FIELD', `未知字段 ${key}；扩展必须置于 extensions`, path, offset + Math.max(1, content.split('\n').findIndex(x => x.startsWith(key + ':')) + 1)));
}
export function parseMetadata(content: string, path = 'change.yaml'): MetadataDocument {
  const diagnostics: Diagnostic[] = [];
  const value = yamlObject(content, path, diagnostics);
  knownFields(value, ['formatVersion', 'id', 'title', 'modules', 'dependsOn', 'tracking', 'extensions'], path, diagnostics, content);
  if (value.formatVersion !== 1) diagnostics.push(diagnostic('SPEC_UNSUPPORTED_VERSION', '仅支持 formatVersion: 1', path));
  if (typeof value.id !== 'string' || !KEBAB_ID.test(value.id)) diagnostics.push(diagnostic('SPEC_INVALID_ID', 'change ID 必须是小写 kebab-case', path));
  if (typeof value.title !== 'string' || !value.title.trim()) diagnostics.push(diagnostic('SPEC_METADATA_INVALID', 'title 必须是非空字符串', path));
  for (const field of ['modules', 'dependsOn']) {
    const list = value[field];
    if (!Array.isArray(list) || list.some(x => typeof x !== 'string' || !KEBAB_ID.test(x)) || new Set(list).size !== list.length || (field === 'modules' && !list.length)) diagnostics.push(diagnostic('SPEC_METADATA_INVALID', `${field} 必须为无重复的 kebab-case ID 数组`, path));
  }
  if (value.tracking !== undefined) {
    const t = value.tracking as Record<string, unknown>;
    if (!t || typeof t !== 'object' || Array.isArray(t) || Object.keys(t).some(k => !['provider', 'itemId'].includes(k)) || typeof t.provider !== 'string' || !KEBAB_ID.test(t.provider) || typeof t.itemId !== 'string' || !t.itemId.trim()) diagnostics.push(diagnostic('SPEC_METADATA_INVALID', 'tracking 只允许非空 provider/itemId', path));
  }
  if (value.extensions !== undefined && (!value.extensions || typeof value.extensions !== 'object' || Array.isArray(value.extensions))) diagnostics.push(diagnostic('SPEC_METADATA_INVALID', 'extensions 必须为对象', path));
  return { path, content, line: 1, value: { formatVersion: 1, id: typeof value.id === 'string' ? value.id : '', title: typeof value.title === 'string' ? value.title : '', modules: Array.isArray(value.modules) ? value.modules.filter((x): x is string => typeof x === 'string') : [], dependsOn: Array.isArray(value.dependsOn) ? value.dependsOn.filter((x): x is string => typeof x === 'string') : [], ...(value.tracking ? { tracking: value.tracking as ChangeMetadata['tracking'] } : {}), ...(value.extensions ? { extensions: value.extensions as Record<string, unknown> } : {}) }, diagnostics };
}

function parse(content: string, path: string, kind: 'spec' | 'delta'): SpecDocument {
  const diagnostics: Diagnostic[] = [];
  const lines = content.split(/\r?\n/);
  let end = lines.indexOf('---', 1);
  if (lines[0] !== '---' || end < 1) { diagnostics.push(diagnostic('SPEC_FRONT_MATTER_REQUIRED', '文档必须以 YAML front matter 开始', path)); end = -1; }
  const fm = end > 0 ? yamlObject(lines.slice(1, end).join('\n'), path, diagnostics, 1) : {};
  knownFields(fm, kind === 'delta' ? ['formatVersion', 'capability', 'baseHash'] : ['formatVersion', 'capability'], path, diagnostics, lines.slice(1, end).join('\n'), 1);
  if (fm.formatVersion !== 1) diagnostics.push(diagnostic('SPEC_UNSUPPORTED_VERSION', '仅支持 formatVersion: 1', path, 2));
  const capability = typeof fm.capability === 'string' ? fm.capability : '';
  if (!KEBAB_ID.test(capability)) diagnostics.push(diagnostic('SPEC_INVALID_ID', 'capability 必须是小写 kebab-case', path, 3));
  if (kind === 'delta' && !(fm.baseHash === null || typeof fm.baseHash === 'string' && /^[a-f0-9]{64}$/.test(fm.baseHash))) diagnostics.push(diagnostic('SPEC_INVALID_BASE', 'delta 必须显式声明 baseHash: null 或 SHA-256', path, 4));
  const requirements: Requirement[] = [];
  const headings: { index: number; match: RegExpMatchArray }[] = [];
  for (let i = Math.max(0, end + 1); i < lines.length; i++) {
    if (/^##\s/.test(lines[i]!)) {
      const match = lines[i]!.match(/^## (?:(ADD|UPDATE|REMOVE) )?(REQ-[A-Z0-9-]+) (?:—|–|-) (.+)$/);
      if (match) headings.push({ index: i, match });
      else diagnostics.push(diagnostic('SPEC_REQUIREMENT_SYNTAX', '需求标题必须包含操作、稳定 ID 和标题', path, i + 1));
    }
  }
  const ids = new Set<string>();
  for (let n = 0; n < headings.length; n++) {
    const { index, match } = headings[n]!;
    const blockEnd = headings[n + 1]?.index ?? lines.length;
    const operation = match[1] as Requirement['operation'];
    const id = match[2]!;
    if (ids.has(id)) diagnostics.push(diagnostic('SPEC_DUPLICATE_ID', `重复 ID ${id}`, path, index + 1));
    ids.add(id);
    if (!REQ_ID.test(id) || !id.startsWith(`REQ-${capability.toUpperCase()}-`) || !/^\d{3}$/.test(id.slice(`REQ-${capability.toUpperCase()}-`.length))) diagnostics.push(diagnostic('SPEC_INVALID_ID', `需求 ID 与 capability 不匹配: ${id}`, path, index + 1));
    if (kind === 'delta' ? !operation : !!operation) diagnostics.push(diagnostic('SPEC_OPERATION_INVALID', kind === 'delta' ? 'delta 必须显式给出 ADD/UPDATE/REMOVE' : '正式规格不能含增量操作', path, index + 1));
    const scenarioHeads: { index: number; match: RegExpMatchArray }[] = [];
    for (let i = index + 1; i < blockEnd; i++) if (/^###\s/.test(lines[i]!)) {
      const sm = lines[i]!.match(/^### (SCN-[A-Z0-9-]+) (?:—|–|-) (.+)$/);
      if (sm) scenarioHeads.push({ index: i, match: sm });
      else diagnostics.push(diagnostic('SPEC_SCENARIO_SYNTAX', '场景标题必须包含稳定 ID 和标题', path, i + 1));
    }
    const scenarios: Scenario[] = [];
    for (let s = 0; s < scenarioHeads.length; s++) {
      const sh = scenarioHeads[s]!;
      const scenarioEnd = scenarioHeads[s + 1]?.index ?? blockEnd;
      const sid = sh.match[1]!;
      if (ids.has(sid)) diagnostics.push(diagnostic('SPEC_DUPLICATE_ID', `重复 ID ${sid}`, path, sh.index + 1));
      ids.add(sid);
      if (!SCN_ID.test(sid) || !sid.startsWith(id.replace(/^REQ-/, 'SCN-') + '-') || !/^\d{2}$/.test(sid.slice(id.length + 1))) diagnostics.push(diagnostic('SPEC_INVALID_ID', `场景 ${sid} 不属于 ${id}`, path, sh.index + 1));
      const scenario: Scenario = { id: sid, title: sh.match[2]!, path, line: sh.index + 1, content: lines.slice(sh.index, scenarioEnd).join('\n').trimEnd(), given: [], when: [], then: [] };
      let previous = 0; let field: 'given' | 'when' | 'then' | undefined;
      const seen = new Set<string>();
      for (let i = sh.index + 1; i < scenarioEnd; i++) {
        const text = lines[i]!;
        if (!text.trim()) continue;
        const step = text.match(/^- (GIVEN|WHEN|THEN|AND)\s+(.+?)\s*$/);
        if (!step) { diagnostics.push(diagnostic('SPEC_SCENARIO_STEP', '场景只允许 - GIVEN/WHEN/THEN/AND 非空内容', path, i + 1)); continue; }
        const key = step[1]!;
        if (key === 'AND') {
          if (!field) diagnostics.push(diagnostic('SPEC_SCENARIO_ORDER', 'AND 之前必须有 GIVEN/WHEN/THEN', path, i + 1));
          else scenario[field].push(step[2]!);
          continue;
        }
        const order = { GIVEN: 1, WHEN: 2, THEN: 3 }[key as 'GIVEN' | 'WHEN' | 'THEN'];
        if (seen.has(key) || order < previous) diagnostics.push(diagnostic('SPEC_SCENARIO_ORDER', '各关键字最多一次，顺序为 GIVEN → WHEN → THEN', path, i + 1));
        seen.add(key); previous = order; field = key.toLowerCase() as typeof field;
        scenario[field!].push(step[2]!);
      }
      if (!scenario.when.length || !scenario.then.length) diagnostics.push(diagnostic('SPEC_SCENARIO_INCOMPLETE', '场景必须有 WHEN 和 THEN', path, sh.index + 1));
      scenarios.push(scenario);
    }
    const body = lines.slice(index + 1, scenarioHeads[0]?.index ?? blockEnd).join('\n').trim();
    const fieldLines = body.split('\n');
    const fieldValue = (name: string) => fieldLines.find(x => x.startsWith(`- ${name}:`))?.slice(name.length + 3).trim();
    const removedText = fieldValue('Removed-Scenarios');
    const removalReasons: Record<string, string> = {};
    for (const text of fieldLines) {
      const rr = text.match(/^- Removal-Reason: (SCN-[A-Z0-9-]+) (?:—|–|-) (.+)$/);
      if (rr) {
        if (removalReasons[rr[1]!]) diagnostics.push(diagnostic('SPEC_DUPLICATE_ID', `重复删除理由 ${rr[1]}`, path, index + 1));
        removalReasons[rr[1]!] = rr[2]!;
      }
    }
    if (operation === 'UPDATE' && removedText === undefined) diagnostics.push(diagnostic('SPEC_REMOVAL_DECLARATION_REQUIRED', 'UPDATE 必须声明 Removed-Scenarios（无删除写 none）', path, index + 1));
    if (operation === 'REMOVE') {
      if (!fieldValue('Reason') || !fieldValue('Impact')) diagnostics.push(diagnostic('SPEC_REMOVAL_REASON_REQUIRED', 'REMOVE 必须包含 Reason 和 Impact', path, index + 1));
      if (scenarios.length) diagnostics.push(diagnostic('SPEC_REMOVE_HAS_SCENARIOS', 'REMOVE 不允许场景块', path, index + 1));
    } else {
      if (!scenarios.length) diagnostics.push(diagnostic('SPEC_SCENARIO_REQUIRED', '有效需求至少包含一个场景', path, index + 1));
      if (!body.replace(/^- (Removed-Scenarios|Removal-Reason):.*$/gm, '').trim()) diagnostics.push(diagnostic('SPEC_REQUIREMENT_BODY_REQUIRED', '有效需求必须包含行为正文', path, index + 1));
    }
    requirements.push({ id, title: match[3]!, path, line: index + 1, content: lines.slice(index, blockEnd).join('\n').trimEnd(), body, scenarios, ...(operation ? { operation } : {}), removedScenarios: removedText === undefined ? [] : split(removedText), removalReasons, reason: fieldValue('Reason'), impact: fieldValue('Impact') });
  }
  if (!requirements.length && kind === 'delta') diagnostics.push(diagnostic('SPEC_REQUIREMENT_REQUIRED', '零 delta 变更应省略 delta 文件', path, Math.max(1, end + 2)));
  return { kind, formatVersion: 1, path, content, line: 1, capability, ...(kind === 'delta' ? { baseHash: fm.baseHash as string | null } : {}), title: lines.slice(Math.max(0, end + 1)).find(x => /^# /.test(x))?.slice(2) ?? capability, requirements, diagnostics };
}
export const parseSpec = (content: string, path = 'spec.md'): SpecDocument => parse(content, path, 'spec');
export const parseDelta = (content: string, path = 'delta.md'): SpecDocument => parse(content, path, 'delta');

const TASK_FIELDS = ['Status', 'Requires', 'Depends-On', 'Write-Scopes', 'Test-Mode', 'Test-Scopes', 'Test-Commands', 'Acceptance', 'Rationale', 'Test-Rationale', 'Alternative-Acceptance'];
export function parseTasks(content: string, path = 'tasks.md'): TaskDocument {
  const diagnostics: Diagnostic[] = []; const tasks: Task[] = []; const lines = content.split(/\r?\n/);
  const heads: { index: number; match: RegExpMatchArray }[] = [];
  for (let i = 0; i < lines.length; i++) if (/^##\s/.test(lines[i]!)) {
    const match = lines[i]!.match(/^## (TASK-\d{3}) (?:—|–|-) (.+)$/);
    if (match) heads.push({ index: i, match }); else diagnostics.push(diagnostic('TASK_SYNTAX', '任务标题必须含 TASK-NNN 和标题', path, i + 1));
  }
  for (let n = 0; n < heads.length; n++) {
    const { index, match } = heads[n]!; const end = heads[n + 1]?.index ?? lines.length;
    const fields: Record<string, string> = {};
    for (let i = index + 1; i < end; i++) {
      if (!lines[i]!.trim()) continue;
      const m = lines[i]!.match(/^- ([A-Za-z-]+):\s*(.*?)\s*$/);
      if (!m) { diagnostics.push(diagnostic('TASK_FIELD_SYNTAX', '任务字段格式为 - Name: value', path, i + 1)); continue; }
      if (!TASK_FIELDS.includes(m[1]!)) diagnostics.push(diagnostic('TASK_UNKNOWN_FIELD', `未知任务字段 ${m[1]}`, path, i + 1));
      if (Object.hasOwn(fields, m[1]!)) diagnostics.push(diagnostic('TASK_DUPLICATE_FIELD', `重复字段 ${m[1]}`, path, i + 1));
      fields[m[1]!] = m[2]!;
    }
    for (const key of TASK_FIELDS.slice(0, 8)) if (!fields[key]) diagnostics.push(diagnostic('TASK_FIELD_REQUIRED', `任务缺少 ${key}`, path, index + 1));
    if (!['pending', 'running', 'done', 'blocked'].includes(fields.Status!)) diagnostics.push(diagnostic('TASK_STATUS_INVALID', '无效任务状态', path, index + 1));
    if (!['tdd', 'verification', 'exempt'].includes(fields['Test-Mode']!)) diagnostics.push(diagnostic('TASK_TEST_MODE_INVALID', 'Test-Mode 必须为 tdd/verification/exempt', path, index + 1));
    const task: Task = { id: match[1]!, title: match[2]!, path, line: index + 1, content: lines.slice(index, end).join('\n').trimEnd(), fields, status: fields.Status as Task['status'], requires: split(fields.Requires ?? ''), dependsOn: split(fields['Depends-On'] ?? ''), writeScopes: split(fields['Write-Scopes'] ?? ''), testMode: fields['Test-Mode'] as Task['testMode'], testScopes: split(fields['Test-Scopes'] ?? ''), testCommands: split(fields['Test-Commands'] ?? ''), acceptance: fields.Acceptance ?? '', rationale: fields.Rationale, testRationale: fields['Test-Rationale'] };
    if (tasks.some(t => t.id === task.id)) diagnostics.push(diagnostic('SPEC_DUPLICATE_ID', `重复任务 ${task.id}`, path, task.line));
    for (const list of [task.requires, task.dependsOn, task.writeScopes, task.testScopes, task.testCommands]) if (new Set(list).size !== list.length || list.includes('none')) diagnostics.push(diagnostic('TASK_LIST_INVALID', '列表不能重复或将 none 与 ID 混用', path, task.line));
    if (!task.requires.length && !task.rationale) diagnostics.push(diagnostic('TASK_RATIONALE_REQUIRED', 'Requires: none 必须给出 Rationale', path, task.line));
    if (task.testMode === 'tdd' && (!task.testScopes.length || !task.testCommands.length)) diagnostics.push(diagnostic('TASK_TDD_REQUIREMENTS', 'tdd 必须有测试范围和命令', path, task.line));
    if (task.testMode === 'verification' && !task.testCommands.length) diagnostics.push(diagnostic('TASK_VERIFICATION_COMMAND_REQUIRED', 'verification 必须有命令', path, task.line));
    if (['verification', 'exempt'].includes(task.testMode) && !task.testRationale) diagnostics.push(diagnostic('TASK_TEST_RATIONALE_REQUIRED', 'verification/exempt 必须有 Test-Rationale', path, task.line));
    if (task.testMode === 'exempt' && !fields['Alternative-Acceptance'] && !/替代|alternative|验收|acceptance/i.test(task.testRationale ?? '')) diagnostics.push(diagnostic('TASK_ALTERNATIVE_ACCEPTANCE_REQUIRED', 'exempt 必须关联替代验收计划', path, task.line));
    tasks.push(task);
  }
  if (!tasks.length) diagnostics.push(diagnostic('TASK_REQUIRED', '至少需要一个任务', path));
  return { path, content, line: 1, tasks, diagnostics };
}
export function parseProposal(content: string, path = 'proposal.md'): ProposalDocument {
  const diagnostics: Diagnostic[] = []; const sections: Record<string, string> = {}; const lines = content.split(/\r?\n/);
  let current = ''; const starts: Record<string, number> = {};
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i]!.match(/^## (.+?)\s*$/);
    if (m) {
      current = m[1]!;
      if (Object.hasOwn(sections, current)) diagnostics.push(diagnostic('PROPOSAL_DUPLICATE_SECTION', `重复小节 ${current}`, path, i + 1));
      sections[current] = ''; starts[current] = i + 1;
    } else if (current) sections[current] += lines[i] + '\n';
  }
  for (const key of ['Problem', 'Goals', 'Scope', 'Non-goals', 'Acceptance', 'Rules', 'Open questions']) if (!sections[key]?.trim()) diagnostics.push(diagnostic('PROPOSAL_SECTION_REQUIRED', `proposal 缺少 ${key}`, path));
  const rules: ProposalDocument['rules'] = [];
  if (/^none\b/i.test(sections.Rules?.trim() ?? '') && /^- RULE-/m.test(sections.Rules ?? '')) diagnostics.push(diagnostic('PROPOSAL_RULE_SYNTAX', 'none 不能与规则处置混用', path, starts.Rules));
  for (const [i, text] of (sections.Rules ?? '').split('\n').entries()) {
    if (!text.trim()) continue;
    const m = text.match(/^- (RULE-\d{3}):\s*(.+)$/);
    if (m) rules.push({ id: m[1]!, text: m[2]!, line: (starts.Rules ?? 0) + i + 1 });
    else if (!/^none\b/i.test(text) && !/^none\b/i.test(sections.Rules!.trim())) diagnostics.push(diagnostic('PROPOSAL_RULE_SYNTAX', 'Rules 使用 - RULE-NNN: 处置；无适用规则写 none 并说明理由', path, (starts.Rules ?? 0) + i + 1));
  }
  if (/^none\s*$/i.test(sections.Rules?.trim() ?? '')) diagnostics.push(diagnostic('PROPOSAL_RULE_RATIONALE_REQUIRED', '无适用规则仍需说明理由', path, starts.Rules));
  const questions: ProposalDocument['questions'] = [];
  if (/^none\s*$/mi.test(sections['Open questions'] ?? '') && /^- QUESTION-/m.test(sections['Open questions'] ?? '')) diagnostics.push(diagnostic('PROPOSAL_QUESTION_SYNTAX', 'none 不能与问题列表混用', path, starts['Open questions']));
  for (const [i, text] of (sections['Open questions'] ?? '').split('\n').entries()) {
    if (!text.trim() || /^none\s*$/i.test(text)) continue;
    const m = text.match(/^- (QUESTION-\d{3})\s*\|\s*(unresolved|resolved)\s*\|\s*(behavior|non-behavior)\s*\|\s*(.+)$/);
    if (!m) diagnostics.push(diagnostic('PROPOSAL_QUESTION_SYNTAX', '问题必须使用 QUESTION ID | status | type | 问题及依据', path, (starts['Open questions'] ?? 0) + i + 1));
    else {
      if (questions.some(q => q.id === m[1])) diagnostics.push(diagnostic('SPEC_DUPLICATE_ID', `重复问题 ${m[1]}`, path, (starts['Open questions'] ?? 0) + i + 1));
      questions.push({ id: m[1]!, status: m[2] as 'unresolved' | 'resolved', type: m[3] as 'behavior' | 'non-behavior', text: m[4]!, line: (starts['Open questions'] ?? 0) + i + 1 });
    }
  }
  return { path, content, line: 1, sections, rules, questions, diagnostics };
}
