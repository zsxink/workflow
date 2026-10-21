import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { WorkflowError } from '../shared/errors.js';

const execute = promisify(execFile);
export interface Repository { root: string; gitDir: string; commonDir: string; runtimeRoot: string; }
export async function git(project: string, args: string[]): Promise<string> {
  try {
    const result = await execute('git', ['-C', project, '-c', 'core.fsmonitor=false', ...args], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' } });
    return result.stdout;
  } catch (error) { throw new WorkflowError('GIT_ERROR', `Git 读取失败: git ${args.join(' ')}`, 2, String(error)); }
}
export async function locateRepository(project: string): Promise<Repository> {
  const actual = await realpath(project);
  const root = await realpath((await git(actual, ['rev-parse', '--show-toplevel'])).trim());
  const gitDir = await realpath((await git(root, ['rev-parse', '--absolute-git-dir'])).trim());
  const common = (await git(root, ['rev-parse', '--git-common-dir'])).trim();
  const commonDir = await realpath(path.resolve(root, common));
  return { root, gitDir, commonDir, runtimeRoot: path.join(commonDir, 'workflow') };
}
