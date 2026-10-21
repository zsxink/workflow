import { open, rename, mkdir, readFile, lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { assert } from '../shared/errors.js';

export async function atomicWrite(filename: string, content: string | Uint8Array): Promise<void> {
  await assertNoSymlinkPath(filename);
  await mkdir(path.dirname(filename), { recursive: true });
  const temporary = `${filename}.${randomUUID()}.tmp`;
  const handle = await open(temporary, 'wx', 0o600);
  try { await handle.writeFile(content); await handle.sync(); } finally { await handle.close(); }
  await rename(temporary, filename);
  const directory = await open(path.dirname(filename), 'r');
  try { await directory.sync(); } finally { await directory.close(); }
}
export async function readJson<T>(filename: string): Promise<T> { await assertNoSymlinkPath(filename); return JSON.parse(await readFile(filename, 'utf8')) as T; }
// Metadata is never accessed through a symlink, including a symlink at the final path.
// Repository roots and common-dir are canonicalized before calling this helper.
export async function assertNoSymlinkPath(filename: string): Promise<void> {
  const absolute = path.resolve(filename);
  const parsed = path.parse(absolute);
  let current = parsed.root;
  for (const component of absolute.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    try { assert(!(await lstat(current)).isSymbolicLink(), 'PATH_ESCAPE', `元数据路径禁止符号链接: ${current}`); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
  }
}
export async function exists(filename: string): Promise<boolean> {
  try { await lstat(filename); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
}
export function safeId(value: string): string { assert(/^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/.test(value) && value !== '..', 'INVALID_ID', `非法标识: ${value}`); return value; }
export function relativePath(value: string): string {
  assert(value.length > 0 && !value.includes('\\') && !value.includes('\0') && !path.isAbsolute(value) && !/^[a-z]:/i.test(value), 'PATH_ESCAPE', `路径必须相对项目根: ${value}`);
  const normalized = path.posix.normalize(value);
  assert(normalized !== '..' && !normalized.startsWith('../') && normalized !== '.', 'PATH_ESCAPE', `路径越界: ${value}`);
  return normalized;
}
export function within(root: string, target: string): boolean { const relative = path.relative(root, target); return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative)); }
export async function boundedPath(root: string, relative: string): Promise<string> {
  const actualRoot = await realpath(root);
  const target = path.join(actualRoot, relativePath(relative));
  let current = path.dirname(target);
  while (!(await exists(current))) current = path.dirname(current);
  assert(within(actualRoot, await realpath(current)), 'PATH_ESCAPE', `符号链接越界: ${relative}`);
  return target;
}
