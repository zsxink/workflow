import { build } from 'esbuild';
import { mkdir, readFile, writeFile, chmod } from 'node:fs/promises';
const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const assets = await readFile(new URL('../src/installer/assets.ts', import.meta.url), 'utf8');
if (!assets.includes(`export const PACKAGE_VERSION = '${pkg.version}';`)) throw new Error('Installer assets and package.json versions must match');
await mkdir(new URL('../dist', import.meta.url), { recursive: true });
await build({
  entryPoints: ['src/cli/main.ts'],
  outfile: 'dist/workflow.js',
  bundle: true,
  platform: 'node',
  target: 'node22.12',
  format: 'esm',
  banner: { js: "#!/usr/bin/env node\nimport { createRequire as __wfCreateRequire } from 'node:module'; const require = __wfCreateRequire(import.meta.url);" },
  define: { __WORKFLOW_VERSION__: JSON.stringify(pkg.version) },
  metafile: true,
  legalComments: 'linked'
});
await chmod(new URL('../dist/workflow.js', import.meta.url), 0o755);
await chmod(new URL('../bin/workflow.js', import.meta.url), 0o755);
await writeFile(new URL('../dist/version.json', import.meta.url), JSON.stringify({ formatVersion: 1, version: pkg.version }) + '\n');
const notices = [];
for (const dependency of Object.keys(pkg.dependencies)) {
  const base = new URL(`../node_modules/${dependency}/`, import.meta.url);
  let license;
  for (const filename of ['LICENSE', 'LICENSE.txt', 'LICENSE.md', 'LICENSE-MIT']) {
    try { license = await readFile(new URL(filename, base), 'utf8'); break; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  if (!license) throw new Error(`Missing license for ${dependency}`);
  notices.push(`${dependency}\n${license}`);
}
await writeFile(new URL('../dist/THIRD_PARTY_LICENSES.txt', import.meta.url), notices.join('\n\n'));
