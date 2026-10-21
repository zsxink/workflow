export const INSTALL_HOSTS = ['codex', 'claude'] as const;
export type InstallHost = typeof INSTALL_HOSTS[number];
export type HostId = InstallHost | 'opencode' | 'pi';
export const CAPABILITIES = ['readFiles', 'searchFiles', 'writeFiles', 'shell', 'gitRead', 'nativeSpawn', 'nativeMessage', 'nativeStatus', 'readOnlyIsolation', 'scopedWriteIsolation', 'cancellation'] as const;

/** Entries describe installation only. Native dispatch and isolation need actual host evidence. */
export function diagnoseHost(id: HostId) {
  const installSupported = (INSTALL_HOSTS as readonly string[]).includes(id);
  return {
    id, installSupported, status: installSupported ? 'execution-unverified' : 'unsupported',
    executionReady: false, clientVersion: null, checkedAt: new Date().toISOString(),
    nativeDispatchVerified: false, roleIsolationVerified: false, executionVerified: false,
    capabilities: Object.fromEntries(CAPABILITIES.map(name => [name, { status: 'unknown', basis: 'No version-bound native host execution and permission evidence has been verified.' }])),
  };
}

export function hostEntry(id: InstallHost): { path: string; content: string } {
  const path = id === 'codex' ? '.codex/skills/workflow/SKILL.md' : '.claude/skills/workflow/SKILL.md';
  return { path, content: `---\nname: workflow\ndescription: Use the repository's fixed Workflow protocol with the current host session.\n---\n\nRead .workflow/managed/protocol.md and .agents/skills/workflow/SKILL.md from the repository root.\nUse Node.js to call .workflow/runtime/workflow.js. The current main session remains Leader.\nDispatch roles only with this host's native sub-agent tools after capability evidence passes.\nInstallation alone does not establish execution readiness or read-only role isolation.\n` };
}
