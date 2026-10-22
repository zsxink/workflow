import { readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const templateRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../assets/templates');

function collect(directory: string, result: Record<string, string>): void {
  const entries = readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) collect(path, result);
    else if (entry.isFile() && entry.name.endsWith('.md')) {
      const key = relative(templateRoot, path).split(sep).join('/').slice(0, -3);
      result[key] = readFileSync(path, 'utf8');
    }
  }
}

export const templates: Readonly<Record<string, string>> = (() => {
  const result: Record<string, string> = {};
  collect(templateRoot, result);
  return Object.freeze(result);
})();
