import { lstat, readFile } from 'node:fs/promises';
import { assert, WorkflowError } from '../shared/errors.js';
import { resolveProjectPath } from '../project/index.js';
import { CAPABILITIES, type HostId } from './index.js';

export type CapabilityStatus = 'supported' | 'unsupported' | 'unknown';
export interface CapabilityEvidence { status: CapabilityStatus; basis: string; references: string[] }
export interface HostEvidence {
  id: HostId;
  clientVersion: string;
  verifiedAt: string;
  nativeDispatch: string;
  identityAndResult: string;
  capabilities: Record<string, CapabilityEvidence>;
}

const FILE = '.workflow/host-evidence.json';
const STATUSES = new Set<CapabilityStatus>(['supported', 'unsupported', 'unknown']);
const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

function parseHost(value: unknown): HostEvidence {
  assert(isObject(value), 'HOST_EVIDENCE_INVALID', '每个宿主证据必须是对象。');
  assert(['codex', 'claude', 'opencode', 'pi'].includes(String(value.id)), 'HOST_EVIDENCE_INVALID', '宿主证据包含未知宿主 ID。');
  assert(typeof value.clientVersion === 'string' && value.clientVersion.trim(), 'HOST_EVIDENCE_INVALID', '宿主证据缺少客户端版本。');
  assert(typeof value.verifiedAt === 'string' && Number.isFinite(Date.parse(value.verifiedAt)), 'HOST_EVIDENCE_INVALID', '宿主证据 verifiedAt 必须是有效时间。');
  assert(typeof value.nativeDispatch === 'string' && value.nativeDispatch.trim(), 'HOST_EVIDENCE_INVALID', '宿主证据缺少原生派发机制。');
  assert(typeof value.identityAndResult === 'string' && value.identityAndResult.trim(), 'HOST_EVIDENCE_INVALID', '宿主证据缺少身份及结果关联方式。');
  assert(isObject(value.capabilities), 'HOST_EVIDENCE_INVALID', '宿主证据缺少 capabilities 对象。');
  for (const name of Object.keys(value.capabilities)) assert((CAPABILITIES as readonly string[]).includes(name), 'HOST_EVIDENCE_INVALID', `未知宿主能力 ${name}。`);
  const capabilities: Record<string, CapabilityEvidence> = {};
  for (const name of CAPABILITIES) {
    const raw = value.capabilities[name];
    assert(isObject(raw) && STATUSES.has(raw.status as CapabilityStatus), 'HOST_EVIDENCE_INVALID', `能力 ${name} 缺少有效状态。`);
    assert(typeof raw.basis === 'string' && raw.basis.trim(), 'HOST_EVIDENCE_INVALID', `能力 ${name} 缺少核查依据。`);
    assert(Array.isArray(raw.references) && raw.references.every(ref => typeof ref === 'string' && ref.trim()), 'HOST_EVIDENCE_INVALID', `能力 ${name} 的 references 必须是字符串数组。`);
    assert(raw.status === 'unknown' || raw.references.length > 0, 'HOST_EVIDENCE_INVALID', `能力 ${name} 已判为支持或不支持，必须附证据引用。`);
    capabilities[name] = { status: raw.status as CapabilityStatus, basis: raw.basis, references: raw.references as string[] };
  }
  return { id: value.id as HostId, clientVersion: value.clientVersion, verifiedAt: value.verifiedAt, nativeDispatch: value.nativeDispatch, identityAndResult: value.identityAndResult, capabilities };
}

/** Reads leader-reviewed, version-bound observations; this parser does not itself prove a host capability. */
export async function readHostEvidence(root: string, requestedHosts: readonly HostId[]): Promise<{ hosts: Partial<Record<HostId, HostEvidence>>; diagnostics: { code: string; message: string }[] }> {
  const file = await resolveProjectPath(root, FILE);
  let raw: Buffer;
  try {
    const info = await lstat(file);
    assert(info.isFile() && !info.isSymbolicLink() && info.size <= 128 * 1024, 'HOST_EVIDENCE_INVALID', '宿主证据必须是小于 128 KiB 的普通文件。');
    raw = await readFile(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { hosts: {}, diagnostics: [] };
    if (error instanceof WorkflowError) return { hosts: {}, diagnostics: [{ code: error.code, message: error.message }] };
    throw error;
  }
  let document: unknown;
  try { document = JSON.parse(raw.toString('utf8')); } catch { return { hosts: {}, diagnostics: [{ code: 'HOST_EVIDENCE_INVALID', message: `${FILE} 不是有效 JSON。` }] }; }
  try {
    assert(isObject(document) && document.formatVersion === 1 && Array.isArray(document.hosts), 'HOST_EVIDENCE_INVALID', `${FILE} 须使用 formatVersion 1 和 hosts 数组。`);
    const hosts: Partial<Record<HostId, HostEvidence>> = {};
    for (const item of document.hosts) {
      const host = parseHost(item);
      assert(!hosts[host.id], 'HOST_EVIDENCE_INVALID', `宿主 ${host.id} 的证据重复。`);
      assert(requestedHosts.includes(host.id), 'HOST_EVIDENCE_INVALID', `宿主 ${host.id} 未在安装清单中启用。`);
      hosts[host.id] = host;
    }
    return { hosts, diagnostics: [] };
  } catch (error) {
    if (error instanceof WorkflowError) return { hosts: {}, diagnostics: [{ code: error.code, message: error.message }] };
    throw error;
  }
}

