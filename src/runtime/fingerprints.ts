import { readdir, readFile, lstat, readlink, realpath } from 'node:fs/promises';
import path from 'node:path';
import ignore, { type Ignore } from 'ignore';
import picomatch from 'picomatch';
import { parse } from 'yaml';
import { git, locateRepository } from '../repository/git.js';
import { assert, WorkflowError } from '../shared/errors.js';
import { sha256, stableStringify } from '../shared/hash.js';
import { exists, relativePath, within, assertNoSymlinkPath } from './io.js';
import { assertStoreReadable } from './transactions.js';

export interface ManifestEntry { path: string; type: 'file' | 'symlink'; sha256: string; executable?: boolean; }
export interface FingerprintGroup { sourceFingerprint: string; specFingerprint: string; planFingerprint: string; policyFingerprint: string; }
export interface FingerprintCapture extends FingerprintGroup { manifests: { source: ManifestEntry[]; spec: ManifestEntry[]; plan: ManifestEntry[]; policy: ManifestEntry[] }; }
export interface FingerprintOptions { extraSourceInputs?: string[]; artifactExcludes?: string[]; policyInputs?: string[]; runtime?: {version: string; sha256: string}; }
interface Rule { base: string; matcher: Ignore; }
function order(a: ManifestEntry, b: ManifestEntry): number { return Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)); }
function category(filename: string): 'spec' | 'plan' | 'policy' | 'source' | 'omit' {
  if (filename.startsWith('.workflow-transactions/')) return 'omit';
  if (filename.startsWith('.workflow/changes/')) return /\/(?:tasks|design|validation-plan)\.md$/.test(filename) ? 'plan' : 'spec';
  if (filename.startsWith('.workflow/specs/') || filename.startsWith('.workflow/archive/') || filename.startsWith('.workflow/epics/')) return 'spec';
  if (filename.startsWith('.workflow/')) return 'policy';
  if (filename === '.gitignore' || filename.endsWith('/.gitignore') || filename === '.gitattributes' || filename.endsWith('/.gitattributes')) return 'policy';
  return 'source';
}
function ignored(filename: string, directory: boolean, rules: Rule[]): boolean {
  let result = false;
  for (const rule of rules) {
    if (rule.base && !filename.startsWith(rule.base)) continue;
    const relative = rule.base ? filename.slice(rule.base.length) : filename;
    const test = rule.matcher.test(relative + (directory ? '/' : ''));
    if (test.ignored) result = true;
    if (test.unignored) result = false;
  }
  return result;
}
export async function captureFingerprints(project: string, options: FingerprintOptions = {}): Promise<FingerprintCapture> {
  const repo = await locateRepository(project);
  await assertStoreReadable(repo.root);
  const configPath = path.join(repo.root, '.workflow/config.yaml');
  await assertNoSymlinkPath(configPath);
  const config = await exists(configPath) ? parse(await readFile(configPath, 'utf8')) : {};
  const extraSourceInputs = options.extraSourceInputs ?? config?.validation?.extraSourceInputs ?? [];
  const artifactExcludes = options.artifactExcludes ?? (config?.validation?.commands ?? []).flatMap((command: { artifacts?: string[] }) => command.artifacts ?? []);
  assert(Array.isArray(extraSourceInputs) && Array.isArray(artifactExcludes), 'INVALID_CONFIG', '指纹路径配置必须为数组');
  for (const pattern of [...extraSourceInputs, ...artifactExcludes, ...(options.policyInputs ?? [])]) relativePath(pattern);
  assert(!artifactExcludes.some((pattern: string) => ['**', '**/*', '*'].includes(pattern)), 'INVALID_CONFIG', '产物排除不得覆盖整个项目');
  const extra = picomatch(extraSourceInputs, { dot: true });
  const artifact = picomatch(artifactExcludes, { dot: true });
  const policyInputs = [...(options.policyInputs ?? []), config?.project?.rules ?? '.workflow/rules.md', 'AGENTS.md'];
  for (const pattern of policyInputs) relativePath(pattern);
  const policy = picomatch(policyInputs, { dot: true });
  const modules = (config?.modules ?? []).flatMap((module: { paths?: string[] }) => module.paths ?? []);
  const sourceScope = picomatch(modules, { dot: true });
  const tracked = new Set((await git(repo.root, ['ls-files', '-z'])).split('\0').filter(Boolean));
  const index = await git(repo.root, ['ls-files', '--stage', '-z']);
  assert(!index.split('\0').some(entry => entry.startsWith('160000 ')), 'UNSUPPORTED_INPUT', 'V1 不支持 submodule 输入，不能把 gitlink 当作源码');
  const sparse = await git(repo.root, ['config', '--get-regexp', '^(core\\.sparsecheckout|extensions\\.worktreeconfig|filter\\.)']).catch(error => {
    // git config exits 1 when there are no matching keys.
    if (error instanceof WorkflowError && String(error.details).includes('Command failed')) return '';
    throw error;
  });
  assert(!/^core\.sparsecheckout\s+true$/mi.test(sparse), 'UNSUPPORTED_INPUT', 'V1 不支持 sparse checkout 输入');
  const infoAttributes = path.join(repo.commonDir, 'info/attributes');
  await assertNoSymlinkPath(infoAttributes);
  assert(!(await exists(infoAttributes)) || !(await readFile(infoAttributes, 'utf8')).trim(), 'UNSUPPORTED_INPUT', 'V1 不支持本机 .git/info/attributes 转换输入');
  const manifests: FingerprintCapture['manifests'] = { source: [], spec: [], plan: [], policy: [] };
  const collisions = new Map<string, string>();
  const rules: Rule[] = [];
  function mayNeedDescendants(patterns: string[], directory: string): boolean {
    return patterns.some(pattern => {
      const base = picomatch.scan(pattern).base.replace(/\/$/, '');
      return !base || base === directory || base.startsWith(`${directory}/`) || directory.startsWith(`${base}/`);
    });
  }
  async function walk(relative: string): Promise<void> {
    const folder = path.join(repo.root, relative);
    if (relative && await exists(path.join(folder, '.git'))) throw new WorkflowError('UNSUPPORTED_INPUT', `不遍历嵌套仓库或其他 worktree: ${relative}`);
    const ignorePath = path.join(folder, '.gitignore');
    if (await exists(ignorePath)) {
      const stat = await lstat(ignorePath);
      assert(stat.isFile() && !stat.isSymbolicLink(), 'UNSUPPORTED_INPUT', '.gitignore 必须是仓库内普通文件');
      if (!relative || !ignored(relative, true, rules)) rules.push({ base: relative ? `${relative}/` : '', matcher: ignore().add(await readFile(ignorePath, 'utf8')) });
    }
    const activeCount = rules.length;
    for (const name of (await readdir(folder)).sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
      if (name === '.git') continue;
      const filename = relative ? `${relative}/${name}` : name;
      const lower = filename.normalize('NFC').toLowerCase();
      assert(!collisions.has(lower), 'PATH_COLLISION', `跨平台路径大小写/Unicode 冲突: ${collisions.get(lower)} / ${filename}`);
      collisions.set(lower, filename);
      const fullPath = path.join(repo.root, filename);
      const stat = await lstat(fullPath);
      if (stat.isDirectory()) {
        if (filename === '.workflow-transactions') continue;
        const sourceDirectory = !filename.startsWith('.workflow/') && filename !== '.workflow';
        const excluded = sourceDirectory && (ignored(filename, true, rules) || artifact(`${filename}/`) || artifact(filename));
        if (excluded && !mayNeedDescendants(extraSourceInputs, filename) && !mayNeedDescendants(policyInputs, filename)) {
          const trackedInside = [...tracked].filter(item => item.startsWith(`${filename}/`) && category(item) === 'source' && !artifact(item));
          assert(trackedInside.length === 0, 'TRACKED_IGNORED_INPUT', `已跟踪但被忽略的源码必须声明 validation.extraSourceInputs: ${trackedInside[0]}`);
          assert(!artifact(`${filename}/`) || !mayNeedDescendants(modules, filename), 'SOURCE_ARTIFACT_OVERLAP', `产物排除与源码范围重叠: ${filename}`);
          continue;
        }
        await walk(filename); rules.splice(activeCount); continue;
      }
      let kind = category(filename);
      if (kind === 'omit') continue;
      if (policy(filename)) kind = 'policy';
      if (kind === 'source') {
        if (artifact(filename)) { assert(!extra(filename) && !sourceScope(filename), 'SOURCE_ARTIFACT_OVERLAP', `产物排除与源码范围重叠: ${filename}`); continue; }
        if (ignored(filename, false, rules) && !extra(filename)) {
          assert(!tracked.has(filename), 'TRACKED_IGNORED_INPUT', `已跟踪但被忽略的源码必须声明 validation.extraSourceInputs: ${filename}`);
          continue;
        }
      }
      let entry: ManifestEntry;
      if (stat.isSymbolicLink()) {
        const target = await readlink(fullPath);
        const resolved = path.resolve(path.dirname(fullPath), target);
        assert(within(repo.root, resolved), 'PATH_ESCAPE', `符号链接越出仓库: ${filename}`);
        if (await exists(resolved)) assert(within(repo.root, await realpath(resolved)), 'PATH_ESCAPE', `符号链接间接越出仓库: ${filename}`);
        entry = { path: filename, type: 'symlink', sha256: sha256(target) };
      } else {
        assert(stat.isFile(), 'UNSUPPORTED_INPUT', `无法完整枚举特殊文件: ${filename}`);
        let bytes = await readFile(fullPath);
        if (name === '.gitattributes') assert(!/(?:^|\s)filter\s*=/.test(bytes.toString('utf8')), 'UNSUPPORTED_INPUT', 'V1 不支持 .gitattributes clean/LFS filter');
        if (kind === 'source') assert(!bytes.subarray(0, 200).toString('utf8').startsWith('version https://git-lfs.github.com/spec/v1\n'), 'UNSUPPORTED_INPUT', `LFS 指针不能冒充完整源码: ${filename}`);
        if (kind === 'plan' && name === 'tasks.md') {
          let task = false; let fence = false;
          bytes = Buffer.from(bytes.toString('utf8').split('\n').map(line => {
            if (/^\s*(?:```|~~~)/.test(line)) fence = !fence;
            if (!fence && /^##\s/.test(line)) task = /^## TASK-\d{3} (?:—|–|-) .+/.test(line);
            return task && !fence && /^- Status:\s*(?:pending|running|done|blocked)\s*\r?$/.test(line) ? line.replace(/(Status:\s*).*/, '$1<derived>') : line;
          }).join('\n'));
        }
        entry = { path: filename, type: 'file', sha256: sha256(bytes), executable: Boolean(stat.mode & 0o111) };
      }
      manifests[kind].push(entry);
    }
  }
  await walk('');
  for (let offset = 0; offset < manifests.source.length; offset += 100) {
    const attributes = (await git(repo.root, ['check-attr', '-z', 'filter', '--', ...manifests.source.slice(offset, offset + 100).map(entry => entry.path)])).split('\0');
    for (let index = 2; index < attributes.length; index += 3) assert(attributes[index] === 'unspecified' || attributes[index] === 'unset', 'UNSUPPORTED_INPUT', `V1 不支持参与源码的 filter: ${attributes[index - 2]}`);
  }
  // Conversion policy is audited separately from raw worktree bytes. Ignore sources here are never used to select files.
  const conversion = await git(repo.root, ['config', '--get-regexp', '^(core\\.(autocrlf|eol|safecrlf|attributesfile)|filter\\.)']).catch(() => '');
  assert(!/^core\.attributesfile\s+/mi.test(conversion), 'UNSUPPORTED_INPUT', 'V1 无法核验仓库外 attributesFile 转换策略');
  manifests.policy.push({ path: '@git-content-conversion', type: 'file', sha256: sha256(conversion) });
  if (options.runtime) manifests.policy.push({ path: '@runtime', type: 'file', sha256: sha256(stableStringify(options.runtime)) });
  for (const entries of Object.values(manifests)) entries.sort(order);
  return { sourceFingerprint: sha256(stableStringify(manifests.source)), specFingerprint: sha256(stableStringify(manifests.spec)), planFingerprint: sha256(stableStringify(manifests.plan)), policyFingerprint: sha256(stableStringify(manifests.policy)), manifests };
}
