import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CAPABILITIES, diagnoseHost } from '../src/hosts/index.js';
import { readHostEvidence } from '../src/hosts/evidence.js';

function record(overrides: Record<string, unknown> = {}) {
  const capabilities = Object.fromEntries(CAPABILITIES.map(name => [name, {
    status: 'supported', basis: `probe ${name}`, references: [`codex-probe-${name}`],
  }]));
  return {
    id: 'codex', clientVersion: 'Codex Desktop 1.2.3', verifiedAt: '2026-10-22T00:00:00.000Z',
    nativeDispatch: 'Host-native subagent tool verified in the current Codex session.',
    identityAndResult: 'Native task ID and completion result observed in the host interface.',
    capabilities, ...overrides,
  };
}

test('host diagnosis reads version-bound observations and keeps workflow lifecycle distinct', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'workflow-host-evidence-'));
  try {
    await mkdir(path.join(root, '.workflow'));
    const absent = await readHostEvidence(root, ['codex']);
    assert.deepEqual(absent.diagnostics, []);
    assert.equal(diagnoseHost('codex', absent.hosts.codex).executionReady, false);

    const codex = record();
    (codex.capabilities as Record<string, { status: string; basis: string; references: string[] }>).readOnlyIsolation = { status: 'unknown', basis: 'Not exercised in this host session.', references: [] };
    await writeFile(path.join(root, '.workflow/host-evidence.json'), JSON.stringify({ formatVersion: 1, hosts: [codex] }));
    const loaded = await readHostEvidence(root, ['codex']);
    assert.deepEqual(loaded.diagnostics, []);
    const diagnosis = diagnoseHost('codex', loaded.hosts.codex, false, Date.parse('2026-10-22T12:00:00.000Z'));
    assert.equal(diagnosis.executionReady, true);
    assert.equal(diagnosis.roleIsolationVerified, false);
    assert.equal(diagnosis.status, 'role-isolation-unverified');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('host evidence rejects unsupported shape and stale evidence is not trusted', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'workflow-host-evidence-'));
  try {
    await mkdir(path.join(root, '.workflow'));
    await writeFile(path.join(root, '.workflow/host-evidence.json'), '{bad json');
    const invalid = await readHostEvidence(root, ['codex']);
    assert.equal(invalid.hosts.codex, undefined);
    assert.equal(invalid.diagnostics[0]?.code, 'HOST_EVIDENCE_INVALID');

    const evidence = record({ verifiedAt: '2026-08-01T00:00:00.000Z' });
    await writeFile(path.join(root, '.workflow/host-evidence.json'), JSON.stringify({ formatVersion: 1, hosts: [evidence] }));
    const loaded = await readHostEvidence(root, ['codex']);
    const stale = diagnoseHost('codex', loaded.hosts.codex, false, Date.parse('2026-10-22T00:00:00.000Z'));
    assert.equal(stale.executionReady, false);
    assert.equal(stale.clientVersion, null);
    assert.match(stale.capabilities.readFiles.basis, /older than 30 days/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
