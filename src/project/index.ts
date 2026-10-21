import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import picomatch from 'picomatch';
import { parseDocument } from 'yaml';
import { assert, WorkflowError } from '../shared/errors.js';

export interface ValidationCommand {
  id: string; executable: string; args: string[]; cwd: string; timeoutSeconds: number;
  modules: string[]; artifacts: string[]; envAllowlist: string[];
}
export interface ProjectConfig {
  formatVersion: 1;
  project: { id: string; name: string; authoritativeDocs: string[]; rules: string };
  hosts: Array<'codex' | 'claude' | 'opencode' | 'pi'>;
  modules: Array<{ id: string; paths: string[]; role: string }>;
  git: { baseBranch?: string; branchPrefix: string };
  integration: { profile: 'local' | 'github'; mode: 'prepare' | 'integrate'; github?: { repository: string; requirePullRequest: boolean; requireChecks: boolean; mergeMethod: 'merge' | 'squash' | 'rebase' } };
  tracking: { required: boolean; providers: Array<{ id: string; adapter: 'github'; github: { server: string; repository: string } }> };
  validation: { commands: ValidationCommand[]; extraSourceInputs: string[] };
  policy: { retryLimit: number; crRoundLimit: number; epicConcurrency: number; requireScopedWriteIsolation: boolean };
  extensions: Record<string, unknown>;
}
type Obj = Record<string, unknown>;
function object(value: unknown, label: string, keys: string[]): Obj {
  assert(value !== null && typeof value === 'object' && !Array.isArray(value), 'CONFIG_INVALID', `${label} 必须是对象`);
  const result = value as Obj;
  for (const key of Object.keys(result)) assert(keys.includes(key), 'CONFIG_UNKNOWN_FIELD', `${label}.${key} 是未知字段`);
  return result;
}
function str(value: unknown, label: string, fallback?: string): string {
  if (value === undefined && fallback !== undefined) return fallback;
  assert(typeof value === 'string' && value.length > 0 && !value.includes('\0'), 'CONFIG_INVALID', `${label} 必须是非空字符串`);
  return value;
}
function strings(value: unknown, label: string, fallback?: string[]): string[] {
  if (value === undefined && fallback !== undefined) return [...fallback];
  assert(Array.isArray(value), 'CONFIG_INVALID', `${label} 必须是字符串数组`);
  return value.map((v, i) => str(v, `${label}[${i}]`));
}
function bool(value: unknown, label: string, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  assert(typeof value === 'boolean', 'CONFIG_INVALID', `${label} 必须是 boolean`); return value;
}
function integer(value: unknown, label: string, fallback: number, min = 1): number {
  if (value === undefined) return fallback;
  assert(Number.isSafeInteger(value) && (value as number) >= min, 'CONFIG_INVALID', `${label} 必须是 >= ${min} 的整数`); return value as number;
}
function choice<T extends string>(value: unknown, label: string, choices: readonly T[], fallback?: T): T {
  const result = str(value, label, fallback);
  assert(choices.includes(result as T), 'CONFIG_INVALID', `${label} 不支持 ${result}`); return result as T;
}
function list(value: unknown, label: string): unknown[] {
  assert(Array.isArray(value), 'CONFIG_INVALID', `${label} 必须是数组`); return value;
}
function id(value: unknown, label: string): string {
  const result = str(value, label);
  assert(/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(result), 'CONFIG_INVALID', `${label} 必须为稳定标识符`); return result;
}
function unique(values: string[], label: string): void {
  assert(new Set(values).size === values.length, 'CONFIG_INVALID', `${label} 不允许重复`);
}
function relative(value: string, allowGlob = false): string {
  assert(!path.isAbsolute(value) && !path.win32.isAbsolute(value) && !value.includes('\\') && !value.includes('\0'), 'PATH_UNSAFE', `必须使用项目相对 POSIX 路径: ${value}`);
  const parts = value.split('/');
  assert(!parts.includes('..') && !parts.some(p => p.toLowerCase() === '.git'), 'PATH_UNSAFE', `路径不得穿越父级或 Git 元数据: ${value}`);
  assert(allowGlob || !/[*?\[\]{}!]/.test(value), 'PATH_UNSAFE', `文件路径不能包含 glob: ${value}`);
  assert(!allowGlob || !value.startsWith('!'), 'PATH_UNSAFE', `范围不支持否定 glob: ${value}`);
  return path.posix.normalize(value);
}
function within(root: string, target: string): boolean {
  const rel = path.relative(root, target); return rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel));
}
/** Checks every existing ancestor, including the final symlink. Missing leaves are valid. */
export async function resolveProjectPath(root: string, projectPath: string): Promise<string> {
  const normalized = relative(projectPath);
  const boundary = await realpath(root);
  const resolved = path.resolve(boundary, normalized);
  assert(within(boundary, resolved), 'PATH_UNSAFE', `路径越过项目边界: ${projectPath}`);
  let cursor = boundary;
  for (const component of normalized.split('/').filter(p => p !== '.' && p !== '')) {
    cursor = path.join(cursor, component);
    let exists;
    try { exists = await lstat(cursor); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') break;
      throw error;
    }
    let actual: string;
    try { actual = await realpath(cursor); } catch (error) {
      if (exists.isSymbolicLink()) throw new WorkflowError('PATH_UNSAFE', `无法解析符号链接: ${projectPath}`);
      throw error;
    }
    assert(within(boundary, actual), 'PATH_UNSAFE', `符号链接越过项目边界: ${projectPath}`);
  }
  return resolved;
}
function globPrefix(glob: string): string {
  const parts = relative(glob, true).split('/');
  const first = parts.findIndex(part => /[*?\[\]{}()!+@]/.test(part));
  return (first < 0 ? parts : parts.slice(0, first)).join('/');
}
async function validateGlob(root: string, glob: string): Promise<void> {
  relative(glob, true);
  await resolveProjectPath(root, globPrefix(glob) || '.');
}
export function pathMatches(projectPath: string, scopes: readonly string[]): boolean {
  const normalized = relative(projectPath);
  return scopes.some(scope => picomatch(relative(scope, true), { dot: true })(normalized));
}
// A whitelist is accepted only when its fixed prefix proves it disjoint from sources.
// For broad glob expressions we deliberately fail closed instead of guessing disjointness.
function mayIntersect(a: string, b: string): boolean {
  const pa = globPrefix(a), pb = globPrefix(b);
  return pa === pb || pa === '' || pb === '' || pa.startsWith(`${pb}/`) || pb.startsWith(`${pa}/`);
}
function assertCommand(command: Pick<ValidationCommand, 'executable' | 'args'>): void {
  assert(Array.isArray(command.args) && command.args.every(a => typeof a === 'string' && !a.includes('\0')), 'CONFIG_INVALID', '命令 args 必须是字符串数组');
  const executable = str(command.executable, 'executable');
  const name = path.basename(executable).toLowerCase().replace(/\.(exe|cmd|bat|js|mjs|cjs)$/, '');
  const agents = /^(codex|claude|claude-code|opencode|pi|sdk[-_]?runner|agent[-_]?runner)$/;
  assert(!agents.test(name), 'COMMAND_FORBIDDEN', `验证命令不能启动 Agent: ${name}`);
  assert(!['sh','bash','zsh','fish','dash','cmd','powershell','pwsh','env'].includes(name), 'COMMAND_FORBIDDEN', '验证命令不能使用 shell 或环境包装器');
  if (['node', 'npx', 'npm', 'pnpm', 'yarn', 'bun', 'deno', 'python', 'python3', 'uv'].includes(name)) {
    for (const arg of command.args) {
      const base = path.basename(arg).toLowerCase().replace(/\.(js|mjs|cjs|py)$/, '');
      assert(!agents.test(base) && !/@(openai\/codex|anthropic-ai\/claude-code|mariozechner\/pi)/i.test(arg) && !/(codex-sdk|claude-agent-sdk|sdk[-_]?runner|agent[-_]?runner)/i.test(arg), 'COMMAND_FORBIDDEN', '验证命令不得使用 Agent CLI/SDK runner');
    }
  }
  assert(!/\.(cmd|bat)$/i.test(executable), 'COMMAND_UNSUPPORTED', 'shell:false 执行器不支持 cmd/bat；请配置真实可执行文件');
}

export async function loadConfig(root: string): Promise<ProjectConfig> {
  const file = await resolveProjectPath(root, '.workflow/config.yaml');
  let raw: unknown;
  try {
    const doc = parseDocument(await readFile(file, 'utf8'), { uniqueKeys: true });
    assert(doc.errors.length === 0, 'CONFIG_INVALID', doc.errors.map(e => e.message).join('; '));
    raw = doc.toJS({ maxAliasCount: 50 });
  } catch (error) {
    if (error instanceof WorkflowError) throw error;
    throw new WorkflowError('CONFIG_INVALID', `无法读取项目配置: ${(error as Error).message}`);
  }
  const c = object(raw, 'config', ['formatVersion','project','modules','hosts','git','integration','tracking','validation','policy','extensions']);
  assert(c.formatVersion === 1, 'CONFIG_VERSION_UNSUPPORTED', '只支持 formatVersion: 1');
  const p = object(c.project, 'project', ['id','name','authoritativeDocs','rules']);
  const modules = list(c.modules, 'modules').map((value, i) => {
    const m = object(value, `modules[${i}]`, ['id','paths','role']);
    const paths = strings(m.paths, 'module.paths'); assert(paths.length > 0, 'CONFIG_INVALID', '模块范围不能为空');
    assert(typeof m.id === 'string' && /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(m.id), 'CONFIG_INVALID', 'module.id 必须为小写 kebab-case');
    return { id: id(m.id, 'module.id'), paths, role: str(m.role, 'module.role', 'developer') };
  });
  unique(modules.map(m => m.id), 'module.id');
  const hosts = strings(c.hosts, 'hosts').map(h => choice(h, 'host', ['codex','claude','opencode','pi'] as const)); unique(hosts, 'hosts');
  assert(hosts.length > 0, 'CONFIG_INVALID', 'hosts 不能为空');
  const g = object(c.git ?? {}, 'git', ['baseBranch','branchPrefix']);
  const integ = object(c.integration ?? {}, 'integration', ['profile','mode','github']);
  const profile = choice(integ.profile, 'integration.profile', ['local','github'] as const, 'local');
  let github: ProjectConfig['integration']['github'];
  if (integ.github !== undefined || profile === 'github') {
    const gh = object(integ.github, 'integration.github', ['repository','requirePullRequest','requireChecks','mergeMethod']);
    github = { repository: repository(gh.repository), requirePullRequest: bool(gh.requirePullRequest,'requirePullRequest',true), requireChecks: bool(gh.requireChecks,'requireChecks',true), mergeMethod: choice(gh.mergeMethod,'mergeMethod',['merge','squash','rebase'] as const,'squash') };
  }
  const t = object(c.tracking ?? {}, 'tracking', ['required','providers']);
  const providers = list(t.providers ?? [], 'tracking.providers').map((value, i) => {
    const provider = object(value, `tracking.providers[${i}]`, ['id','adapter','github']);
    const gh = object(provider.github, 'provider.github', ['server','repository']);
    const server = str(gh.server,'provider.github.server');
    let url: URL; try { url = new URL(server); } catch { throw new WorkflowError('CONFIG_INVALID','github.server 必须是 URL'); }
    assert(url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash, 'CONFIG_INVALID','github.server 必须是无凭据 HTTPS URL');
    return { id: id(provider.id, 'provider.id'), adapter: choice(provider.adapter,'adapter',['github'] as const), github: {server, repository: repository(gh.repository)} };
  });
  unique(providers.map(p => p.id), 'provider.id');
  const required = bool(t.required,'tracking.required',false);
  assert(!required || providers.length > 0, 'CONFIG_INVALID','tracking.required 需要至少一个可用连接');
  const v = object(c.validation ?? {}, 'validation', ['commands','extraSourceInputs']);
  const commands = list(v.commands ?? [], 'validation.commands').map((value, i): ValidationCommand => {
    const command = object(value, `validation.commands[${i}]`, ['id','executable','args','cwd','timeoutSeconds','modules','artifacts','envAllowlist']);
    const args = list(command.args, 'command.args').map(arg => { assert(typeof arg === 'string' && !arg.includes('\0'),'CONFIG_INVALID','args 仅支持字符串'); return arg; });
    const result = { id: id(command.id,'command.id'), executable: str(command.executable,'command.executable'), args, cwd: str(command.cwd,'command.cwd','.'), timeoutSeconds: integer(command.timeoutSeconds,'timeoutSeconds',300), modules: strings(command.modules,'command.modules',['*']), artifacts: strings(command.artifacts,'command.artifacts',[]), envAllowlist: strings(command.envAllowlist,'envAllowlist',[]) };
    assert(result.modules.length > 0 && result.modules.every(m => m === '*' || modules.some(mod => mod.id === m)), 'CONFIG_INVALID','命令引用未知模块或模块列表为空');
    unique(result.modules,'command.modules'); unique(result.envAllowlist,'envAllowlist');
    assert(result.envAllowlist.every(e => /^[A-Za-z_][A-Za-z0-9_]*$/.test(e)), 'CONFIG_INVALID','环境变量名无效');
    assertCommand(result); return result;
  });
  unique(commands.map(command => command.id), 'command.id');
  const pol = object(c.policy ?? {}, 'policy', ['retryLimit','crRoundLimit','epicConcurrency','requireScopedWriteIsolation']);
  const extensions = c.extensions === undefined ? {} : object(c.extensions,'extensions',Object.keys((c.extensions ?? {}) as object));
  const config: ProjectConfig = {
    formatVersion: 1,
    project: { id: id(p.id,'project.id'), name: str(p.name,'project.name',str(p.id,'project.id')), authoritativeDocs: strings(p.authoritativeDocs,'authoritativeDocs',[]), rules: str(p.rules,'project.rules','.workflow/rules.md') },
    modules, hosts, git: { ...(g.baseBranch === undefined ? {} : {baseBranch: str(g.baseBranch,'git.baseBranch')}), branchPrefix: str(g.branchPrefix,'git.branchPrefix','workflow/') },
    integration: { profile, mode: choice(integ.mode,'integration.mode',['prepare','integrate'] as const,'prepare'), ...(github ? {github} : {}) },
    tracking: {required,providers}, validation: {commands,extraSourceInputs: strings(v.extraSourceInputs,'extraSourceInputs',[])},
    policy: {retryLimit: integer(pol.retryLimit,'retryLimit',2,0),crRoundLimit: integer(pol.crRoundLimit,'crRoundLimit',3),epicConcurrency: integer(pol.epicConcurrency,'epicConcurrency',3),requireScopedWriteIsolation: bool(pol.requireScopedWriteIsolation,'requireScopedWriteIsolation',false)}, extensions,
  };
  for (const value of [...config.project.authoritativeDocs, config.project.rules]) await resolveProjectPath(root,value);
  const sources = [...modules.flatMap(m => m.paths), ...config.validation.extraSourceInputs];
  for (const glob of sources) await validateGlob(root,glob);
  for (const command of commands) {
    await resolveProjectPath(root, command.cwd);
    if (command.executable.includes('/') || command.executable.includes('\\')) await resolveProjectPath(root,command.executable);
    for (const glob of command.artifacts) {
      await validateGlob(root,glob);
      assert(globPrefix(glob) !== '' && glob !== '.', 'CONFIG_INVALID','产物范围不能覆盖整个项目');
      assert(!sources.some(source => mayIntersect(source,glob)), 'CONFIG_ARTIFACT_SOURCE_OVERLAP', `产物范围无法证明与源码分离: ${glob}`);
    }
  }
  return config;
}
function repository(value: unknown): string {
  const result = str(value,'github.repository');
  assert(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(result) && !result.split('/').some(p => p === '.' || p === '..'), 'CONFIG_INVALID','repository 必须为 owner/repo'); return result;
}
export function selectCommands(config: ProjectConfig, modules: readonly string[]): ValidationCommand[] {
  assert(modules.every(id => config.modules.some(m => m.id === id)), 'CONFIG_INVALID','选择了未知模块');
  return config.validation.commands.filter(command => command.modules.includes('*') || command.modules.some(m => modules.includes(m)));
}

export interface ExecuteOptions { env?: NodeJS.ProcessEnv; envAllowlist?: string[]; maxOutputBytes?: number }
export interface CommandResult {
  commandId: string; executable: string; args: string[]; cwd: string;
  startedAt: string; finishedAt: string; exitCode: number | null; signal: NodeJS.Signals | null;
  timedOut: boolean; stdout: string; stderr: string; stdoutSha256: string; stderrSha256: string;
  stdoutBytes: number; stderrBytes: number; stdoutTruncated: boolean; stderrTruncated: boolean;
  environmentNames: string[];
}
/** Executes configured argv directly. This is not a filesystem or process sandbox. */
export async function executeCommand(root: string, command: ValidationCommand, options: ExecuteOptions = {}): Promise<CommandResult> {
  assertCommand(command);
  assert(Number.isSafeInteger(command.timeoutSeconds) && command.timeoutSeconds > 0 && command.timeoutSeconds <= 2147483, 'CONFIG_INVALID','命令 timeoutSeconds 超出安全计时范围');
  const cwd = await resolveProjectPath(root, command.cwd);
  assert((await stat(cwd)).isDirectory(),'COMMAND_CWD_INVALID','命令 cwd 必须为目录');
  const executable = command.executable.includes('/') || command.executable.includes('\\') ? await resolveProjectPath(root,command.executable) : command.executable;
  const max = options.maxOutputBytes ?? 1024 * 1024;
  assert(Number.isSafeInteger(max) && max >= 0 && max <= 64 * 1024 * 1024, 'CONFIG_INVALID','maxOutputBytes 必须在 0 到 64 MiB 之间');
  const allowlist = options.envAllowlist ?? command.envAllowlist ?? [];
  assert(allowlist.every(name => /^[A-Za-z_][A-Za-z0-9_]*$/.test(name)), 'CONFIG_INVALID','环境变量名无效');
  const source = options.env ?? process.env;
  const env: NodeJS.ProcessEnv = {};
  for (const name of allowlist) if (source[name] !== undefined) env[name] = source[name];
  const redact = (value: string): string => {
    for (const name of Object.keys(env)) {
      const secret = env[name];
      if (secret && /TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|CREDENTIAL|PRIVATE_KEY/i.test(name)) {
        value = value.split(secret).join('[REDACTED]');
        // Retention can cut an output stream in the middle of a sensitive value.
        for (let length = Math.min(secret.length - 1,value.length); length > 0; length--) {
          if (value.endsWith(secret.slice(0,length))) { value = value.slice(0,-length) + '[REDACTED]'; break; }
        }
      }
    }
    return value;
  };
  const startedAt = new Date().toISOString();
  const out = {chunks: [] as Buffer[], bytes: 0, kept: 0, hash: createHash('sha256')};
  const err = {chunks: [] as Buffer[], bytes: 0, kept: 0, hash: createHash('sha256')};
  const capture = (target: typeof out, value: Buffer) => {
    target.hash.update(value); target.bytes += value.length;
    const chunk = value.subarray(0,Math.max(0,max - target.kept));
    if (chunk.length) { target.chunks.push(Buffer.from(chunk)); target.kept += chunk.length; }
  };
  return await new Promise<CommandResult>((resolve, reject) => {
    let timedOut = false;
    const child = spawn(executable,command.args,{cwd,env,shell:false,stdio:['ignore','pipe','pipe'],detached: process.platform !== 'win32'});
    const terminate = () => {
      if (child.pid) {
        try { if (process.platform !== 'win32') process.kill(-child.pid,'SIGKILL'); else child.kill('SIGKILL'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') child.kill('SIGKILL'); }
      }
    };
    const timer = setTimeout(() => { timedOut = true; terminate(); },command.timeoutSeconds * 1000);
    child.stdout.on('data',(chunk: Buffer) => capture(out,chunk));
    child.stderr.on('data',(chunk: Buffer) => capture(err,chunk));
    child.once('error',error => { clearTimeout(timer); reject(new WorkflowError('COMMAND_START_FAILED',`无法启动命令 ${command.id}: ${error.message}`,6)); });
    child.once('close',(exitCode,signal) => {
      clearTimeout(timer);
      resolve({commandId:command.id,executable:command.executable,args:[...command.args],cwd:command.cwd,startedAt,finishedAt:new Date().toISOString(),exitCode,signal,timedOut,stdout:redact(Buffer.concat(out.chunks).toString('utf8')),stderr:redact(Buffer.concat(err.chunks).toString('utf8')),stdoutSha256:out.hash.digest('hex'),stderrSha256:err.hash.digest('hex'),stdoutBytes:out.bytes,stderrBytes:err.bytes,stdoutTruncated:out.bytes > out.kept,stderrTruncated:err.bytes > err.kept,environmentNames:Object.keys(env).sort()});
    });
  });
}
