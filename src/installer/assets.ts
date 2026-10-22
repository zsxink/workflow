import { hostEntry, type InstallHost } from '../hosts/index.js';
import { renderTemplate, type TemplateLanguage } from './render-template.js';

export const PACKAGE_VERSION = '0.1.0-preview.2';
export const ASSET_FORMAT_VERSION = 1;
export const BLOCK_START = '<!-- WORKFLOW:MANAGED:START -->';
export const BLOCK_END = '<!-- WORKFLOW:MANAGED:END -->';
function agentBlock(language: TemplateLanguage): string {
  return `${BLOCK_START}\n${renderTemplate(language, 'agents-block', { version: PACKAGE_VERSION })}${BLOCK_END}\n`;
}
export const AGENT_BLOCK = agentBlock('zh-CN');

export interface Asset { path: string; content: string | Buffer; sourceTemplateId: string; mode: 'file' | 'block' }

const roles = ['architect', 'developer', 'tester', 'reviewer', 'verifier'] as const;
export function managedAssets(hosts: InstallHost[], runtime: Buffer, notices = '', language: TemplateLanguage = 'zh-CN'): Asset[] {
  return [
    { path: '.workflow/runtime/workflow.js', content: runtime, sourceTemplateId: `runtime:${PACKAGE_VERSION}`, mode: 'file' },
    { path: '.workflow/runtime/THIRD_PARTY_LICENSES.txt', content: notices, sourceTemplateId: `notices:${PACKAGE_VERSION}`, mode: 'file' },
    { path: '.workflow/managed/protocol.md', content: renderTemplate(language, 'protocol', { version: PACKAGE_VERSION }), sourceTemplateId: 'protocol:v1', mode: 'file' },
    ...roles.map(id => ({ path: `.workflow/managed/roles/${id}.md`, content: renderTemplate(language, `roles/${id}`, { version: PACKAGE_VERSION }), sourceTemplateId: `role:${id}:v1`, mode: 'file' as const })),
    { path: '.agents/skills/workflow/SKILL.md', content: renderTemplate(language, 'shared-skill'), sourceTemplateId: 'skill:shared:v1', mode: 'file' },
    ...hosts.map(id => ({ ...hostEntry(id, language), sourceTemplateId: `host:${id}:v1`, mode: 'file' as const })),
    { path: 'AGENTS.md', content: agentBlock(language), sourceTemplateId: 'entry:agents:v1', mode: 'block' },
  ];
}
