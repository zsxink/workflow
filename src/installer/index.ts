import { readFile, lstat, mkdir, readdir, realpath } from 'node:fs/promises';
import { dirname, resolve, relative, basename, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { stringify as yamlStringify } from 'yaml';
import { WorkflowError, assert } from '../shared/errors.js';
import { sha256, stableStringify } from '../shared/hash.js';
import { loadConfig } from '../project/index.js';
import { INSTALL_HOSTS, diagnoseHost, type InstallHost } from '../hosts/index.js';
import { readHostEvidence } from '../hosts/evidence.js';
import { PACKAGE_VERSION, ASSET_FORMAT_VERSION, BLOCK_START, BLOCK_END, managedAssets } from './assets.js';
import { isTemplateLanguage, renderTemplate, resolveTemplateLanguage, type TemplateLanguage } from './render-template.js';
import { acquireLock, releaseLock } from '../runtime/locks.js';
import { planTransaction, applyTransaction, loadTransaction, assertStoreReadable } from '../runtime/transactions.js';

const exec = promisify(execFile);
const MANIFEST = '.workflow/install.json';
export interface ManagedPath { path: string; sourceTemplateId: string; installedHash: string; baseContentHash: string; mode: 'file' | 'block' }
export interface InstallManifest { formatVersion: 1; packageVersion: string; assetFormatVersion: 1; runtimeSha256: string; installedAt: string; language?: TemplateLanguage; hosts: InstallHost[]; managedPaths: ManagedPath[]; userOwned: string[] }
export interface InstallChange { path: string; status: 'added' | 'updated' | 'unchanged' | 'conflict' | 'removed' | 'preserved'; expectedHash: string | null; content: string | null; reason?: string }
export interface InstallPlan { formatVersion: 1; operation: 'init' | 'upgrade' | 'uninstall'; planId: string; projectRoot: string; packageVersion: string; createdAt: string; changes: InstallChange[]; digest: string; applicable: boolean; diagnostics: string[] }
export interface InitOptions { hosts?: string[]; language?: TemplateLanguage; dryRun?: boolean; operationId?: string; planDigest?: string; runtimePath?: string }

async function git(root: string, args: string[]): Promise<string> { return (await exec('git', ['-C', root, ...args], { encoding: 'utf8' })).stdout.trim(); }
async function repository(root: string) {
  root = await realpath(root);
  let top: string;
  try { top = await realpath(await git(root, ['rev-parse', '--show-toplevel'])); }
  catch { throw new WorkflowError('GIT_REQUIRED', '实际安装需要已有提交的 Git 仓库；普通目录仅支持 dry-run 草案。'); }
  assert(top === root, 'PROJECT_ROOT_REQUIRED', '安装目标必须是 Git worktree 根目录。');
  const common = resolve(root, await git(root, ['rev-parse', '--git-common-dir']));
  return { root, common };
}
async function checkedPath(root: string, path: string): Promise<string> {
  assert(!isAbsolute(path) && path !== '' && !path.split(/[\\/]/).includes('..') && !path.includes('\\'), 'UNSAFE_INSTALL_PATH', `不安全安装路径: ${path}`);
  const abs = resolve(root, path); assert(relative(root, abs) !== '' && !relative(root, abs).startsWith('..'), 'UNSAFE_INSTALL_PATH', path);
  let cursor = root;
  for (const part of path.split('/')) {
    cursor = resolve(cursor, part);
    try { const s = await lstat(cursor); assert(!s.isSymbolicLink(), 'SYMLINK_INSTALL_PATH', `安装路径不可含符号链接: ${path}`); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  return abs;
}
async function bytes(root: string, path: string): Promise<Buffer | null> {
  const abs = await checkedPath(root, path);
  try { const s = await lstat(abs); assert(s.isFile(), 'INSTALL_PATH_NOT_FILE', `安装路径不是普通文件: ${path}`); return await readFile(abs); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
}
function hosts(value: string[] = ['codex']): InstallHost[] {
  assert(value.length > 0 && new Set(value).size === value.length, 'INVALID_HOSTS', '至少选择一个不重复的宿主。');
  for (const id of value) assert((INSTALL_HOSTS as readonly string[]).includes(id), 'UNSUPPORTED_HOST', `宿主 ${id} 尚未交付安装适配。`, 5);
  return value as InstallHost[];
}
function basePath(hash: string) { assert(/^[a-f0-9]{64}$/.test(hash), 'INVALID_BASE_HASH', '非法模板摘要。'); return `.workflow/managed-bases/sha256/${hash}.json`; }
async function readBase(root: string, item: ManagedPath): Promise<Buffer> {
  const raw = await bytes(root, basePath(item.baseContentHash));
  assert(raw, 'MANAGED_BASE_MISSING', `旧模板缓存缺失: ${item.path}`, 3);
  let base: any; try { base = JSON.parse(raw.toString()); } catch { throw new WorkflowError('MANAGED_BASE_CORRUPT', `旧模板缓存损坏: ${item.path}`, 3); }
  assert(base.formatVersion === 1 && base.encoding === 'base64' && typeof base.content === 'string' && /^[A-Za-z0-9+/]*={0,2}$/.test(base.content), 'MANAGED_BASE_CORRUPT', `旧模板格式错误: ${item.path}`, 3);
  const content = Buffer.from(base.content, 'base64');
  assert(content.toString('base64') === base.content && base.sha256 === item.baseContentHash && sha256(content) === item.baseContentHash && item.installedHash === item.baseContentHash, 'MANAGED_BASE_CORRUPT', `旧模板摘要不匹配: ${item.path}`, 3);
  return content;
}
async function manifest(root: string): Promise<InstallManifest | null> {
  const raw = await bytes(root, MANIFEST); if (!raw) return null;
  let value: InstallManifest; try { value = JSON.parse(raw.toString()); } catch { throw new WorkflowError('INSTALL_MANIFEST_INVALID', '安装清单不是有效 JSON。'); }
  assert(value.formatVersion === 1 && value.assetFormatVersion === 1 && typeof value.packageVersion === 'string' && Array.isArray(value.managedPaths) && Array.isArray(value.hosts), 'INSTALL_MANIFEST_INVALID', '未知安装清单格式。');
  assert(value.language === undefined || isTemplateLanguage(value.language), 'INSTALL_MANIFEST_INVALID', '安装清单中的语言设置无效。');
  hosts(value.hosts);
  const allowed = new Set(managedAssets(value.hosts, Buffer.alloc(0), '', value.language ?? 'zh-CN').map(x => x.path));
  const seen = new Set<string>();
  for (const item of value.managedPaths) {
    assert(allowed.has(item.path) && !seen.has(item.path) && typeof item.sourceTemplateId === 'string' && (item.mode === (item.path === 'AGENTS.md' ? 'block' : 'file')), 'INSTALL_MANIFEST_INVALID', '清单包含未知、重复或用户所有路径。');
    seen.add(item.path); await checkedPath(root, item.path); await readBase(root, item);
  }
  assert(seen.size === allowed.size && seen.has('.workflow/runtime/workflow.js') && /^[a-f0-9]{64}$/.test(value.runtimeSha256), 'INSTALL_MANIFEST_INVALID', '安装清单缺少 runtime。');
  assert(value.managedPaths.find(x => x.path === '.workflow/runtime/workflow.js')?.installedHash === value.runtimeSha256, 'INSTALL_MANIFEST_INVALID', 'runtime 摘要与安装清单不一致。');
  return value;
}
function block(content: Buffer | null): { text: string | null; start: number; end: number } {
  if (!content) return { text: null, start: -1, end: -1 };
  const s = content.toString(); assert(Buffer.from(s).equals(content), 'MANAGED_BLOCK_INVALID', 'AGENTS.md 必须为有效 UTF-8；拒绝重新编码用户字节。'); const a = s.indexOf(BLOCK_START), b = s.indexOf(BLOCK_END);
  if (a === -1 && b === -1) return { text: null, start: -1, end: -1 };
  assert(a >= 0 && b > a && s.indexOf(BLOCK_START, a + 1) < 0 && s.indexOf(BLOCK_END, b + 1) < 0, 'MANAGED_BLOCK_INVALID', 'AGENTS.md 中管理区块不完整或重复。');
  const end = b + BLOCK_END.length + (s[b + BLOCK_END.length] === '\n' ? 1 : 0);
  return { text: s.slice(a, end), start: a, end };
}
function replaceBlock(current: Buffer | null, content: string | null): string {
  const b = block(current), s = current?.toString() ?? '';
  if (b.start >= 0) return s.slice(0, b.start) + (content ?? '') + s.slice(b.end);
  return s + (s && !s.endsWith('\n') ? '\n' : '') + (content ?? '');
}
async function runtimeBytes(path?: string) {
  const runtimePath = path ?? fileURLToPath(import.meta.url);
  assert(runtimePath.endsWith('.js'), 'RUNTIME_NOT_BUILT', '请先构建独立 dist/workflow.js；安装不能分发 TypeScript 源码。');
  const content = await readFile(runtimePath); assert(content.length > 0, 'RUNTIME_NOT_BUILT', 'runtime 为空。');
  let notices: string; try { notices = await readFile(resolve(dirname(runtimePath), 'THIRD_PARTY_LICENSES.txt'), 'utf8'); } catch { throw new WorkflowError('RUNTIME_NOT_BUILT', 'runtime 必须包含 THIRD_PARTY_LICENSES.txt。'); }
  assert(notices.trim().length > 0, 'RUNTIME_NOT_BUILT', 'runtime 许可证清单为空。');
  return { content, notices };
}
function payloadDigest(plan: Omit<InstallPlan, 'digest' | 'applicable'>): string {
  const { planId, createdAt, ...payload } = plan;
  return sha256(stableStringify(payload));
}
function finish(plan: Omit<InstallPlan, 'digest' | 'applicable'>): InstallPlan {
  const digest = payloadDigest(plan);
  return { ...plan, planId: `install-${digest.slice(0, 24)}`, applicable: !plan.changes.some(x => x.status === 'conflict') && plan.diagnostics.length === 0, digest };
}
async function newPlan(root: string, operation: InstallPlan['operation'], options: InitOptions = {}): Promise<InstallPlan> {
  root = await realpath(root); const diagnostics: string[] = [];
  let repo: Awaited<ReturnType<typeof repository>> | null = null;
  try { repo = await repository(root); } catch (error) { if (!options.dryRun) throw error; diagnostics.push((error as Error).message); }
  const old = await manifest(root);
  if (old && operation === 'init') assert(old.packageVersion === PACKAGE_VERSION, 'UPGRADE_REQUIRED', '项目已安装其他版本；请显式生成 upgrade 计划。', 3);
  if (operation !== 'init') assert(old, 'NOT_INSTALLED', '项目尚未安装 Workflow。');
  const selected = hosts(options.hosts ?? old?.hosts);
  const language = resolveTemplateLanguage(options.language ?? old?.language ?? 'zh-CN');
  const changes: InstallChange[] = [];
  const add = async (path: string, content: string | null, status: InstallChange['status'], reason?: string) => {
    const current = await bytes(root, path); changes.push({ path, content, status, expectedHash: current ? sha256(current) : null, ...(reason ? { reason } : {}) });
  };
  if (operation === 'uninstall') {
    for (const item of old!.managedPaths) {
      const current = await bytes(root, item.path); const local = item.mode === 'block' ? block(current).text : current;
      const equal = local !== null && sha256(local) === item.installedHash;
      await add(item.path, equal ? (item.mode === 'block' ? Buffer.from(replaceBlock(current, null)).toString('base64') : null) : current?.toString('base64') ?? null, equal ? 'removed' : 'preserved', equal ? undefined : '用户修改或路径已缺失，保留。');
    }
    await add(MANIFEST, null, 'removed');
  } else {
    const runtimePackage = await runtimeBytes(options.runtimePath); const runtime = runtimePackage.content; const desired = managedAssets(selected, runtime, runtimePackage.notices, language); const entries: ManagedPath[] = [];
    for (const asset of desired) {
      const current = await bytes(root, asset.path); const before = old?.managedPaths.find(x => x.path === asset.path);
      const wanted = Buffer.isBuffer(asset.content) ? asset.content : Buffer.from(asset.content); const hash = sha256(wanted);
      const local = asset.mode === 'block' ? block(current).text : current;
      let status: InstallChange['status'] = 'added', reason: string | undefined;
      if (before) {
        const original = await readBase(root, before);
        if (local !== null && sha256(local) === hash) status = 'unchanged';
        else if (local !== null && sha256(local) === sha256(original)) status = 'updated';
        else { status = 'conflict'; reason = '现有管理内容已修改或缺失，旧模板/用户内容/新模板需要人工处理。'; }
      } else if ((asset.mode === 'file' && current !== null) || (asset.mode === 'block' && local !== null)) { status = 'conflict'; reason = '已有未登记文件或区块不可认领。'; }
      const content = asset.mode === 'block' ? Buffer.from(replaceBlock(current, wanted.toString())) : wanted;
      await add(asset.path, content.toString('base64'), status, reason);
      entries.push({ path: asset.path, sourceTemplateId: asset.sourceTemplateId, installedHash: hash, baseContentHash: hash, mode: asset.mode });
      const path = basePath(hash); const cache = await bytes(root, path);
      if (cache) {
        await readBase(root, entries[entries.length - 1]);
      } else if (!changes.some(change => change.path === path)) await add(path, Buffer.from(JSON.stringify({ formatVersion: 1, encoding: 'base64', sha256: hash, content: wanted.toString('base64') }) + '\n').toString('base64'), 'added');
    }
    for (const item of old?.managedPaths ?? []) if (!entries.some(x => x.path === item.path)) {
      const current = await bytes(root, item.path); const local = item.mode === 'block' ? block(current).text : current;
      await add(item.path, null, local !== null && sha256(local) === item.installedHash ? 'removed' : 'conflict', '旧版本资产移除前须确认未被修改。');
    }
    if (!old) {
      let baseBranch: string | null = null;
      if (repo) try {
        await git(root, ['rev-parse', '--verify', 'HEAD^{commit}']);
        try { baseBranch = (await git(root, ['symbolic-ref', 'refs/remotes/origin/HEAD'])).replace('refs/remotes/', ''); }
        catch { baseBranch = await git(root, ['symbolic-ref', '--short', 'HEAD']); }
        await git(root, ['rev-parse', '--verify', `${baseBranch}^{commit}`]);
      } catch { diagnostics.push('无法从已有提交核实 baseBranch；实际 init 需要有提交的分支，且不猜测 main。'); }
      const config = { formatVersion: 1, project: { id: basename(root).toLowerCase().replace(/[^a-z0-9-]/g, '-') || 'project', name: basename(root), authoritativeDocs: [], rules: '.workflow/rules.md' }, hosts: selected, modules: [{ id: 'project', paths: ['**'], role: 'developer' }], git: { baseBranch, branchPrefix: 'workflow/' }, integration: { profile: 'local', mode: 'prepare' }, tracking: { required: false, providers: [] }, validation: { extraSourceInputs: [], commands: [] }, policy: { retryLimit: 2, crRoundLimit: 3, epicConcurrency: 3, requireScopedWriteIsolation: false }, extensions: {} };
      for (const [path, content] of [['.workflow/config.yaml', yamlStringify(config)], ['.workflow/rules.md', renderTemplate(language, 'project-rules')]] as const) {
        if (await bytes(root, path) === null) await add(path, Buffer.from(content).toString('base64'), 'added');
        else await add(path, null, 'preserved', '已有用户配置/规则，保持用户所有。');
      }
    } else if (language !== (old.language ?? 'zh-CN')) {
      const rulesPath = '.workflow/rules.md';
      const currentRules = await bytes(root, rulesPath);
      const previousDefaults = [renderTemplate(old.language ?? 'zh-CN', 'project-rules'), '# Project rules\n\nDefine project-specific validation and ownership before execution.\n'];
      if (currentRules && previousDefaults.includes(currentRules.toString())) {
        await add(rulesPath, Buffer.from(renderTemplate(language, 'project-rules')).toString('base64'), 'updated');
      }
    }
    const next: InstallManifest = { formatVersion: 1, packageVersion: PACKAGE_VERSION, assetFormatVersion: ASSET_FORMAT_VERSION, runtimeSha256: sha256(runtime), installedAt: old?.installedAt ?? '', language, hosts: selected, managedPaths: entries, userOwned: ['.workflow/config.yaml', '.workflow/rules.md', '.workflow/host-evidence.json', '.workflow/specs/**', '.workflow/changes/**', '.workflow/archive/**'] };
    const content = Buffer.from(JSON.stringify(next, null, 2) + '\n'); const existing = await bytes(root, MANIFEST);
    await add(MANIFEST, content.toString('base64'), existing && sha256(existing) === sha256(content) ? 'unchanged' : old ? 'updated' : 'added');
  }
  return finish({ formatVersion: 1, operation, planId: randomUUID(), projectRoot: root, packageVersion: PACKAGE_VERSION, createdAt: new Date().toISOString(), changes, diagnostics });
}
export const planInit = (root: string, options: InitOptions = {}) => newPlan(root, 'init', { ...options, dryRun: true });
export const planUpgrade = (root: string, options: InitOptions = {}) => newPlan(root, 'upgrade', options);
export const planUninstall = (root: string) => newPlan(root, 'uninstall');
async function filesBelow(path: string): Promise<string[]> {
  let entries; try { entries = await readdir(path, { withFileTypes: true }); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return []; throw e; }
  const paths: string[] = [];
  for (const entry of entries) {
    assert(!entry.isSymbolicLink(), 'UNSAFE_RUNTIME_PATH', '运行状态目录不可含符号链接。');
    const p = resolve(path, entry.name); if (entry.isDirectory()) paths.push(...await filesBelow(p)); else paths.push(p);
  }
  return paths;
}
async function assertIdle(common: string) {
  for (const path of await filesBelow(resolve(common, 'workflow/locks'))) assert(basename(path) === 'project-install.lock', 'ACTIVE_RUN', '存在运行锁，不能修改安装资产。', 4);
  for (const path of await filesBelow(resolve(common, 'workflow/runs'))) if (basename(path) === 'state.json') {
    let state: any; try { state = JSON.parse((await readFile(path)).toString()); } catch { throw new WorkflowError('ACTIVE_RUN_UNKNOWN', '运行状态损坏，不能确认没有活动写入者。', 5); }
    assert(['succeeded', 'failed'].includes(state.status), 'ACTIVE_RUN', '存在非终态 run，不能修改安装资产。', 5);
  }
  for (const path of await filesBelow(resolve(common, 'workflow/transactions'))) if (basename(path) === 'journal.json') {
    let journal: any; try { journal = JSON.parse((await readFile(path)).toString()); } catch { throw new WorkflowError('TRANSACTION_UNKNOWN', '事务状态损坏，需恢复后安装。', 7); }
    assert(['committed', 'rolled-back'].includes(journal.status), 'TRANSACTION_PENDING', '存在未完成事务，需恢复后修改安装资产。', 7);
  }
}
function materialize(c: InstallChange): Buffer | null {
  if (c.content === null) return null;
  const content = Buffer.from(c.content, 'base64');
  if (c.path === MANIFEST) {
    const manifest = JSON.parse(content.toString());
    if (!manifest.installedAt) { manifest.installedAt = new Date().toISOString(); return Buffer.from(JSON.stringify(manifest, null, 2) + '\n'); }
  }
  return content;
}
export interface InstallOperationRequest {
  operation: InstallPlan['operation'];
  hosts?: string[];
  language?: TemplateLanguage;
  runtimePath?: string;
  planDigest?: string;
}
interface InstallRequestRecord {
  operation: InstallPlan['operation']; requestedHosts: string[] | null; requestedLanguage: TemplateLanguage | null;
  runtimeSha256: string | null; noticesSha256: string | null; planDigest: string | null;
}
interface InstallReceipt { formatVersion: 1; planDigest: string; planId: string; request: InstallRequestRecord }
function validateOperationId(id: string) { assert(/^[A-Za-z0-9][A-Za-z0-9._-]{0,100}$/.test(id), 'INVALID_OPERATION_ID', 'operation-id 无效。'); }
async function normalizeRequest(request: InstallOperationRequest): Promise<InstallRequestRecord> {
  assert(['init', 'upgrade', 'uninstall'].includes(request.operation), 'INSTALL_REQUEST_INVALID', '安装请求操作无效。');
  const runtime = request.operation === 'uninstall' ? null : await runtimeBytes(request.runtimePath);
  return { operation: request.operation, requestedHosts: request.hosts ? hosts(request.hosts).slice().sort() : null, requestedLanguage: request.language === undefined ? null : resolveTemplateLanguage(request.language),
    runtimeSha256: runtime ? sha256(runtime.content) : null, noticesSha256: runtime ? sha256(runtime.notices) : null,
    planDigest: request.planDigest ?? null };
}
function requestFromPlan(plan: InstallPlan): InstallRequestRecord {
  const hash = (path: string) => { const content = plan.changes.find(c => c.path === path)?.content; assert(content, 'INSTALL_PLAN_INVALID', `安装计划缺少 ${path}`); return sha256(Buffer.from(content, 'base64')); };
  return { operation: plan.operation, requestedHosts: null, requestedLanguage: null, runtimeSha256: plan.operation === 'uninstall' ? null : hash('.workflow/runtime/workflow.js'),
    noticesSha256: plan.operation === 'uninstall' ? null : hash('.workflow/runtime/THIRD_PARTY_LICENSES.txt'), planDigest: plan.digest };
}
function encodeReceipt(receipt: InstallReceipt): string { return 'workflow-install-v1:' + Buffer.from(stableStringify(receipt)).toString('base64'); }
function decodeReceipt(operation: string): InstallReceipt {
  assert(operation.startsWith('workflow-install-v1:'), 'OPERATION_ID_CONFLICT', 'operation-id 已用于其他或未知格式的操作。', 4);
  let receipt: InstallReceipt; try { receipt = JSON.parse(Buffer.from(operation.slice('workflow-install-v1:'.length), 'base64').toString()); }
  catch { throw new WorkflowError('INSTALL_RECEIPT_INVALID', '安装操作凭据损坏。', 7); }
  assert(receipt.formatVersion === 1 && typeof receipt.planDigest === 'string' && typeof receipt.planId === 'string' && receipt.request, 'INSTALL_RECEIPT_INVALID', '安装操作凭据格式错误。', 7);
  return receipt;
}
async function replayUnderLock(repo: Awaited<ReturnType<typeof repository>>, operationId: string, request: InstallRequestRecord) {
  const journalPath = await checkedPath(repo.common, `workflow/transactions/install-${operationId}/journal.json`);
  try { await lstat(journalPath); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  const previous = await loadTransaction(journalPath); const receipt = decodeReceipt(previous.operation);
  const previousRequest = { ...receipt.request } as InstallRequestRecord;
  if (!Object.prototype.hasOwnProperty.call(previousRequest, 'requestedLanguage')) previousRequest.requestedLanguage = 'zh-CN';
  assert(previous.root === repo.root && stableStringify(previousRequest) === stableStringify(request), 'OPERATION_ID_CONFLICT', '同一 operation-id 已绑定其他安装请求。', 4);
  assert(previous.status === 'committed', 'TRANSACTION_PENDING', '此安装操作尚未完成，需显式恢复。', 7);
  await applyTransaction(previous);
  return { planId: receipt.planId, operationId, transactionId: previous.transactionId, changed: previous.entries.length > 0,
    installed: receipt.request.operation !== 'uninstall', executionReady: false, replayed: true };
}
/** Check persisted request identity before rebuilding a plan against already changed installation state. */
export async function replayInstallOperation(root: string, operationId: string, request: InstallOperationRequest) {
  validateOperationId(operationId); const repo = await repository(root); const normalized = await normalizeRequest(request);
  await checkedPath(repo.common, 'workflow/locks/project-install.lock');
  const lockPath = resolve(repo.common, 'workflow/locks/project-install.lock'); const lock = await acquireLock(lockPath, { sessionId: `install:${operationId}` });
  try { return await replayUnderLock(repo, operationId, normalized); } finally { await releaseLock(lockPath, lock.owner); }
}
export async function applyInstallPlan(root: string, plan: InstallPlan, options: { operationId: string; planDigest: string; request?: InstallOperationRequest }) {
  const repo = await repository(root);
  const { digest, applicable, ...body } = plan;
  assert(plan.formatVersion === 1 && ['init', 'upgrade', 'uninstall'].includes(plan.operation) && plan.projectRoot === repo.root && plan.packageVersion === PACKAGE_VERSION, 'INSTALL_PLAN_INVALID', '安装计划版本或项目不匹配。');
  assert(digest === options.planDigest && digest === payloadDigest(body), 'INSTALL_PLAN_CHANGED', '安装计划摘要不匹配。', 3);
  assert(applicable && plan.diagnostics.length === 0 && !plan.changes.some(x => x.status === 'conflict'), 'INSTALL_CONFLICT', '安装计划有冲突或缺少已核实基线。', 3);
  validateOperationId(options.operationId);
  const planRequest = requestFromPlan(plan);
  const request = options.request ? await normalizeRequest(options.request) : planRequest;
  assert(request.operation === plan.operation && request.runtimeSha256 === planRequest.runtimeSha256 && request.noticesSha256 === planRequest.noticesSha256, 'INSTALL_REQUEST_CHANGED', '请求与计划的 runtime 资产不匹配。', 3);
  const allowed = new Set([...managedAssets(['codex', 'claude'], Buffer.alloc(0)).map(x => x.path), MANIFEST]);
  const seen = new Set<string>();
  for (const c of plan.changes) {
    const userDraft = plan.operation === 'init' && ['.workflow/config.yaml', '.workflow/rules.md'].includes(c.path) && c.status === 'added' && c.expectedHash === null;
    assert(!seen.has(c.path) && (allowed.has(c.path) || /^\.workflow\/managed-bases\/sha256\/[a-f0-9]{64}\.json$/.test(c.path) || userDraft || c.status === 'preserved'), 'INSTALL_PLAN_INVALID', '计划含重复或非安装所有路径。');
    seen.add(c.path); await checkedPath(repo.root, c.path);
    if (c.content !== null && c.status !== 'preserved') assert(Buffer.from(c.content, 'base64').toString('base64') === c.content, 'INSTALL_PLAN_INVALID', '计划内容不是规范 base64。');
  }
  await checkedPath(repo.common, 'workflow/locks/project-install.lock');
  const lockPath = resolve(repo.common, 'workflow/locks/project-install.lock');
  const lock = await acquireLock(lockPath, { sessionId: `install:${options.operationId}` });
  try {
    const replay = await replayUnderLock(repo, options.operationId, request);
    if (replay) return replay;
    await assertIdle(repo.common);
    // Recheck all observations, including unchanged and preserved files, before transaction preparation.
    for (const c of plan.changes) {
      const current = await bytes(repo.root, c.path);
      assert((current ? sha256(current) : null) === c.expectedHash, 'INSTALL_INPUT_CHANGED', `计划生成后文件发生变化: ${c.path}`, 3);
    }
    const mutations = plan.changes.filter(c => !['unchanged', 'preserved'].includes(c.status));
    const transaction = await planTransaction({ root: repo.root, storePath: resolve(repo.root, MANIFEST), journalRoot: resolve(repo.common, 'workflow/transactions'), operation: encodeReceipt({ formatVersion: 1, planDigest: plan.digest, planId: plan.planId, request }), transactionId: `install-${options.operationId}`, changes: mutations.map(c => ({ path: c.path, content: materialize(c), expectedHash: c.expectedHash })) });
    await applyTransaction(transaction);
    return { planId: plan.planId, operationId: options.operationId, transactionId: transaction.transactionId, changed: mutations.length > 0, installed: plan.operation !== 'uninstall', executionReady: false, replayed: false };
  } finally { await releaseLock(lockPath, lock.owner); }
}
export async function initProject(root: string, options: InitOptions = {}) {
  if (options.dryRun) return newPlan(root, 'init', options);
  assert(options.operationId, 'OPERATION_ID_REQUIRED', '实际 init 需要 operation-id。');
  const request: InstallOperationRequest = { operation: 'init', hosts: options.hosts, language: options.language, runtimePath: options.runtimePath, planDigest: options.planDigest };
  const replay = await replayInstallOperation(root, options.operationId, request); if (replay) return replay;
  const plan = await newPlan(root, 'init', options);
  return applyInstallPlan(root, plan, { operationId: options.operationId, planDigest: options.planDigest ?? plan.digest, request });
}
export async function doctor(root: string) {
  root = await realpath(root);
  const diagnostics: { code: string; message: string }[] = [];
  let install: InstallManifest | null = null;
  let config: Awaited<ReturnType<typeof loadConfig>> | null = null;
  try {
    await assertStoreReadable(root, MANIFEST);
    install = await manifest(root);
    if (!install) diagnostics.push({ code: 'NOT_INSTALLED', message: '项目没有 Workflow 安装清单。' });
    if (install) for (const item of install.managedPaths) {
      const current = await bytes(root, item.path); const content = item.mode === 'block' ? block(current).text : current;
      if (content === null || sha256(content) !== item.installedHash) diagnostics.push({ code: 'MANAGED_ASSET_CHANGED', message: `管理资产缺失或被修改: ${item.path}` });
    }
    await repository(root);
    if (install) config = await loadConfig(root);
    const [major, minor] = process.versions.node.split('.').map(Number);
    if (major < 22 || (major === 22 && minor < 12)) diagnostics.push({ code: 'NODE_VERSION_UNSUPPORTED', message: '要求 Node.js 22.12+。' });
  } catch (error) { diagnostics.push({ code: (error as WorkflowError).code ?? 'INSTALL_INVALID', message: (error as Error).message }); }
  const installed = install !== null && diagnostics.length === 0;
  const hostEvidence = install ? await readHostEvidence(root, install.hosts) : { hosts: {}, diagnostics: [] };
  const hostDiagnostics = hostEvidence.diagnostics;
  const hosts = (install?.hosts ?? []).map(id => diagnoseHost(id, hostEvidence.hosts[id], config?.policy.requireScopedWriteIsolation ?? false));
  const hostExecutionReady = installed && hostDiagnostics.length === 0 && hosts.length > 0 && hosts.every(host => host.executionReady && host.roleIsolationVerified);
  // The preview CLI still rejects phase-success evidence; host capability evidence alone cannot complete its lifecycle.
  const workflowLifecycleReady = false;
  const executionReady = hostExecutionReady && workflowLifecycleReady;
  return { installed, executionReady, hostExecutionReady, workflowLifecycleReady, packageVersion: install?.packageVersion ?? null, expectedPackageVersion: PACKAGE_VERSION, runtimeVersionMatches: install?.packageVersion === PACKAGE_VERSION, language: install?.language ?? 'zh-CN', hostEvidencePath: '.workflow/host-evidence.json', hosts, diagnostics: [...diagnostics, ...hostDiagnostics], exitCode: installed && executionReady ? 0 : 5, status: !installed ? 'not-installed-or-invalid' : executionReady ? 'installed-execution-ready' : hostExecutionReady ? 'installed-host-ready-lifecycle-unverified' : 'installed-execution-unverified' };
}
export async function uninstallProject(root: string, options: { dryRun?: boolean; operationId?: string; planDigest?: string } = {}) {
  if (options.dryRun !== false) return planUninstall(root);
  assert(options.operationId && options.planDigest, 'INSTALL_APPLY_CREDENTIALS_REQUIRED', '卸载应用需要 operation-id 与已审阅 plan digest。');
  const replay = await replayInstallOperation(root, options.operationId, { operation: 'uninstall', planDigest: options.planDigest }); if (replay) return replay;
  const plan = await planUninstall(root);
  return applyInstallPlan(root, plan, { operationId: options.operationId, planDigest: options.planDigest });
}
