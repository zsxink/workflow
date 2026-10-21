import { mkdir, open, rm, readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { assert, WorkflowError } from '../shared/errors.js';
import { atomicWrite, readJson, safeId, assertNoSymlinkPath } from './io.js';
import { locateRepository } from '../repository/git.js';

export interface LockRecord { formatVersion: 1; owner: string; sessionId: string; machine: string; pid: number; startedAt: string; heartbeatAt: string; }
export async function acquireLock(lockPath: string, options: {owner?: string; sessionId?: string} = {}): Promise<LockRecord> {
  await assertNoSymlinkPath(lockPath);
  await mkdir(path.dirname(lockPath), { recursive: true });
  return withLockGuard(lockPath, async () => {
  const now = new Date().toISOString();
  const record: LockRecord = { formatVersion: 1, owner: options.owner ?? randomUUID(), sessionId: options.sessionId ?? 'unknown', machine: os.hostname(), pid: process.pid, startedAt: now, heartbeatAt: now };
  let handle;
  try { handle = await open(lockPath, 'wx', 0o600); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new WorkflowError('LOCKED', '已存在独占锁；过期 heartbeat 不授权接管', 4, { lockPath }); throw error; }
  try { await handle.writeFile(JSON.stringify(record)); await handle.sync(); } finally { await handle.close(); }
  return record;
  });
}
export async function requireLock(lockPath: string, owner: string): Promise<LockRecord> {
  const value = await readJson<unknown>(lockPath);
  assert(!!value && typeof value === 'object' && !Array.isArray(value), 'LOCK_CORRUPT', '锁记录必须为对象');
  const lock = value as LockRecord;
  assert(lock.formatVersion === 1, 'UNSUPPORTED_VERSION', '未知锁格式，只允许诊断');
  assert(typeof lock.owner === 'string' && lock.owner.length > 0 && typeof lock.sessionId === 'string' && typeof lock.machine === 'string' && Number.isSafeInteger(lock.pid) && lock.pid > 0 && typeof lock.startedAt === 'string' && Number.isFinite(Date.parse(lock.startedAt)) && typeof lock.heartbeatAt === 'string' && Number.isFinite(Date.parse(lock.heartbeatAt)), 'LOCK_CORRUPT', '锁记录字段损坏，不能证明 owner 或写入者状态');
  assert(lock.owner === owner, 'OWNER_CONFLICT', '写入者不是当前锁 owner', 4);
  return lock;
}
// A separate mutex prevents heartbeat/release from racing on the owner file.
export async function withLockGuard<T>(lockPath: string, action: () => Promise<T>): Promise<T> {
  const guard = `${lockPath}.guard`;
  await assertNoSymlinkPath(guard);
  try { await mkdir(guard); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new WorkflowError('STATE_CONFLICT', '另一个状态写入正在进行', 4); throw error; }
  try { return await action(); } finally { await rm(guard, { recursive: true }); }
}
export async function heartbeatLock(lockPath: string, owner: string): Promise<LockRecord> {
  return withLockGuard(lockPath, async () => { const lock = await requireLock(lockPath, owner); lock.heartbeatAt = new Date().toISOString(); await atomicWrite(lockPath, JSON.stringify(lock)); return lock; });
}
export async function releaseLock(lockPath: string, owner: string): Promise<void> {
  await withLockGuard(lockPath, async () => { await requireLock(lockPath, owner); await rm(lockPath); });
}
export async function changeLockPath(project: string, changeId: string): Promise<string> { const repo = await locateRepository(project); return path.join(repo.runtimeRoot, 'locks', `${safeId(changeId)}.lock`); }
export async function acquireChangeLock(project: string, changeId: string, options: { owner?: string; sessionId?: string } = {}): Promise<LockRecord> { return acquireLock(await changeLockPath(project, changeId), options); }
export async function heartbeatChangeLock(project: string, changeId: string, owner: string): Promise<LockRecord> { return heartbeatLock(await changeLockPath(project, changeId), owner); }
export async function releaseChangeLock(project: string, changeId: string, owner: string): Promise<void> { return releaseLock(await changeLockPath(project, changeId), owner); }
export async function takeoverLock(): Promise<never> { throw new WorkflowError('UNSUPPORTED_TAKEOVER', '尚未实现可信宿主停止证据核验；保持挂起，不可删除或超时抢占锁', 5); }
