import { lstat, readdir, readFile, realpath } from 'node:fs/promises';
import { join, relative, isAbsolute } from 'node:path';
import { parseDocument } from 'yaml';
import { WorkflowError } from '../shared/errors.js';
import { diagnostic, KEBAB_ID, parseDelta, parseMetadata, parseProposal, parseSpec, parseTasks } from './parser.js';
import { emptyHistory } from './sync.js';
import type { ArchiveMetadata, ChangeBundle, HistoryIndex } from './types.js';

export async function loadChange(projectRoot: string, changeId: string): Promise<ChangeBundle> {
  if (!KEBAB_ID.test(changeId)) throw new WorkflowError('SPEC_INVALID_ID', 'change ID 必须为小写 kebab-case');
  const root = await realpath(projectRoot);
  const diagnostics: ChangeBundle['diagnostics'] = [];
  async function safe(path: string): Promise<boolean> {
    const rel = relative(root, path);
    if (isAbsolute(rel) || rel === '..' || rel.startsWith('../')) throw new WorkflowError('SPEC_PATH_ESCAPE', `路径越界 ${path}`);
    let current = root;
    for (const component of rel.split('/')) {
      if (!component) continue;
      current = join(current, component);
      try { const info = await lstat(current); if (info.isSymbolicLink()) throw new WorkflowError('SPEC_SYMLINK_REJECTED', `规格输入不允许符号链接 ${current}`); }
      catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false; throw e; }
    }
    return true;
  }
  async function read(path: string): Promise<string | undefined> { if (!await safe(path)) return undefined; return readFile(path, 'utf8'); }
  async function dirs(path: string): Promise<string[]> {
    if (!await safe(path)) return [];
    const entries = await readdir(path, { withFileTypes: true });
    const names: string[] = []; const seen = new Set<string>();
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.isSymbolicLink()) throw new WorkflowError('SPEC_SYMLINK_REJECTED', `规格目录不允许符号链接 ${join(path, entry.name)}`);
      if (!entry.isDirectory()) continue;
      const nameValid = path === join(root, '.workflow', 'archive') ? /^[a-z0-9][a-z0-9-]*$/.test(entry.name) : KEBAB_ID.test(entry.name);
      if (!nameValid) { diagnostics.push(diagnostic('SPEC_INVALID_ID', `目录名必须为小写 kebab-case ${entry.name}`, join(path, entry.name))); continue; }
      const folded = entry.name.toLowerCase();
      if (seen.has(folded)) diagnostics.push(diagnostic('SPEC_CASE_COLLISION', `目录大小写冲突 ${entry.name}`, join(path, entry.name)));
      seen.add(folded); names.push(entry.name);
    }
    return names;
  }
  const changeRoot = join(root, '.workflow', 'changes', changeId);
  const metaPath = join(changeRoot, 'change.yaml'); const metaContent = await read(metaPath);
  if (metaContent === undefined) throw new WorkflowError('SPEC_CHANGE_MISSING', `缺少活动变更 ${metaPath}`);
  const metadata = parseMetadata(metaContent, metaPath);
  const proposalPath = join(changeRoot, 'proposal.md'), taskPath = join(changeRoot, 'tasks.md'), designPath = join(changeRoot, 'design.md');
  const [proposal, tasks, design, rules, configContent, historyContent] = await Promise.all([read(proposalPath), read(taskPath), read(designPath), read(join(root, '.workflow', 'rules.md')), read(join(root, '.workflow', 'config.yaml')), read(join(root, '.workflow', 'specs', 'history.json'))]);
  const bundle: ChangeBundle = { projectRoot: root, changeId, metadata, deltas: [], specs: [], history: emptyHistory(), archives: [], activeChanges: [], activeReferences: [], diagnostics,
    ...(proposal !== undefined ? { proposal: parseProposal(proposal, proposalPath) } : {}), ...(tasks !== undefined ? { tasks: parseTasks(tasks, taskPath) } : {}), ...(design !== undefined ? { design: { path: designPath, line: 1, content: design } } : {}), ...(rules !== undefined ? { rules: { path: join(root, '.workflow', 'rules.md'), line: 1, content: rules } } : {}) };
  if (configContent !== undefined) {
    const config = parseDocument(configContent, { uniqueKeys: true });
    if (config.errors.length) diagnostics.push(diagnostic('SPEC_CONFIG_INVALID', config.errors.map(e => e.message).join('; '), join(root, '.workflow', 'config.yaml')));
    else {
      try { const value = config.toJS(); if (value && typeof value === 'object' && !Array.isArray(value)) bundle.config = value as Record<string, unknown>; else throw new Error('无效配置'); }
      catch { diagnostics.push(diagnostic('SPEC_CONFIG_INVALID', '项目配置必须为可安全解析的对象', join(root, '.workflow', 'config.yaml'))); }
    }
  }
  if (historyContent !== undefined) {
    try { const h = JSON.parse(historyContent) as HistoryIndex; if (h?.formatVersion !== 1 || !Array.isArray(h.changes) || !Array.isArray(h.removed)) throw new Error('历史索引格式无效'); bundle.history = h; }
    catch { diagnostics.push(diagnostic('SPEC_HISTORY_INVALID', '历史索引不是有效的 v1 JSON', join(root, '.workflow', 'specs', 'history.json'))); }
  }
  for (const capability of await dirs(join(root, '.workflow', 'specs'))) {
    const path = join(root, '.workflow', 'specs', capability, 'spec.md'); const content = await read(path);
    if (content === undefined) { diagnostics.push(diagnostic('SPEC_FILE_MISSING', 'capability 目录缺少 spec.md', path)); continue; }
    const spec = parseSpec(content, path); if (spec.capability !== capability) diagnostics.push(diagnostic('SPEC_CAPABILITY_PATH_MISMATCH', 'capability 与目录不匹配', path, 3)); bundle.specs.push(spec);
  }
  for (const capability of await dirs(join(changeRoot, 'specs'))) {
    const path = join(changeRoot, 'specs', capability, 'delta.md'); const content = await read(path);
    if (content === undefined) { diagnostics.push(diagnostic('SPEC_FILE_MISSING', 'capability 目录缺少 delta.md', path)); continue; }
    const delta = parseDelta(content, path); if (delta.capability !== capability) diagnostics.push(diagnostic('SPEC_CAPABILITY_PATH_MISMATCH', 'capability 与目录不匹配', path, 3)); bundle.deltas.push(delta);
  }
  for (const id of await dirs(join(root, '.workflow', 'changes'))) {
    const activeRoot = join(root, '.workflow', 'changes', id);
    const content = await read(join(activeRoot, 'change.yaml'));
    if (content === undefined) { diagnostics.push(diagnostic('SPEC_FILE_MISSING', '活动变更缺少 change.yaml', activeRoot)); continue; }
    const active = parseMetadata(content, join(activeRoot, 'change.yaml'));
    diagnostics.push(...active.diagnostics); bundle.activeChanges.push(active.value);
    if (active.value.id !== id) diagnostics.push(diagnostic('SPEC_CHANGE_ID_MISMATCH', '活动目录与 change ID 不匹配', active.path));
    if (id === changeId) continue;
    const referenceFiles = [join(activeRoot, 'proposal.md'), join(activeRoot, 'design.md'), join(activeRoot, 'tasks.md')];
    for (const cap of await dirs(join(activeRoot, 'specs'))) referenceFiles.push(join(activeRoot, 'specs', cap, 'delta.md'));
    for (const path of referenceFiles) {
      const text = await read(path); if (text === undefined) continue;
      for (const [line, value] of text.split(/\r?\n/).entries()) for (const match of value.matchAll(/\b(?:REQ-[A-Z0-9-]+-\d{3}|SCN-[A-Z0-9-]+-\d{3}-\d{2})\b/g)) bundle.activeReferences.push({ changeId: id, id: match[0], path, line: line + 1 });
    }
  }
  for (const archiveDir of await dirs(join(root, '.workflow', 'archive'))) {
    const archivePath = `.workflow/archive/${archiveDir}`; const path = join(root, archivePath, 'archive.json'); const content = await read(path);
    if (content === undefined) { diagnostics.push(diagnostic('SPEC_ARCHIVE_METADATA_MISSING', '归档缺少 archive.json', path)); continue; }
    try {
      const archive = JSON.parse(content) as ArchiveMetadata;
      if (!archive || archive.formatVersion !== 1 || !Array.isArray(archive.removed)) throw new Error('无效归档元数据');
      bundle.archives.push({ path: archivePath, content, metadata: archive });
    } catch { diagnostics.push(diagnostic('SPEC_ARCHIVE_INVALID', '归档元数据不是有效 v1 JSON', path)); }
  }
  return bundle;
}
