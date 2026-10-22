import { renderTemplate, type TemplateLanguage } from '../installer/render-template.js';

export const INSTALL_HOSTS = ['codex', 'claude'] as const;
export type InstallHost = typeof INSTALL_HOSTS[number];
export type HostId = InstallHost | 'opencode' | 'pi';
export const CAPABILITIES = ['readFiles', 'searchFiles', 'writeFiles', 'shell', 'gitRead', 'nativeSpawn', 'nativeMessage', 'nativeStatus', 'readOnlyIsolation', 'scopedWriteIsolation', 'cancellation'] as const;

const REQUIRED_EXECUTION_CAPABILITIES = ['readFiles', 'searchFiles', 'writeFiles', 'shell', 'gitRead', 'nativeSpawn', 'nativeMessage', 'nativeStatus'] as const;

/** Host evidence is an audited observation, never inferred from installed skills or templates. */
export function diagnoseHost(id: HostId, evidence?: import('./evidence.js').HostEvidence, requireScopedWriteIsolation = false, now = Date.now()) {
  const installSupported = (INSTALL_HOSTS as readonly string[]).includes(id);
  const fresh = evidence ? now >= Date.parse(evidence.verifiedAt) && now - Date.parse(evidence.verifiedAt) <= 30 * 24 * 60 * 60 * 1000 : false;
  const capabilities = Object.fromEntries(CAPABILITIES.map(name => {
    const record = fresh ? evidence?.capabilities[name] : undefined;
    return [name, record ? { status: record.status, basis: record.basis, references: record.references } : { status: 'unknown', basis: fresh ? 'No observation has been recorded.' : evidence ? 'Host evidence is future-dated or older than 30 days.' : 'No version-bound native host execution and permission evidence has been verified.', references: [] }];
  }));
  const executionReady = installSupported && fresh && REQUIRED_EXECUTION_CAPABILITIES.every(name => evidence?.capabilities[name].status === 'supported');
  const roleIsolationVerified = executionReady && evidence?.capabilities.readOnlyIsolation.status === 'supported' && (!requireScopedWriteIsolation || evidence?.capabilities.scopedWriteIsolation.status === 'supported');
  return {
    id, installSupported, status: !installSupported ? 'unsupported' : roleIsolationVerified ? 'execution-ready' : executionReady ? 'role-isolation-unverified' : 'execution-unverified',
    executionReady, clientVersion: fresh ? evidence!.clientVersion : null, checkedAt: new Date(now).toISOString(),
    verifiedAt: fresh ? evidence!.verifiedAt : null, nativeDispatchVerified: executionReady,
    roleIsolationVerified, executionVerified: executionReady,
    nativeDispatch: fresh ? evidence!.nativeDispatch : null, identityAndResult: fresh ? evidence!.identityAndResult : null,
    capabilities,
  };
}

export function hostEntry(id: InstallHost, language: TemplateLanguage = 'zh-CN'): { path: string; content: string } {
  const path = id === 'codex' ? '.codex/skills/workflow/SKILL.md' : '.claude/skills/workflow/SKILL.md';
  return { path, content: renderTemplate(language, 'host-skill') };
}
