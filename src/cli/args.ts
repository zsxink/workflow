import { resolve } from 'node:path';
import { WorkflowError } from '../shared/errors.js';

const valueFlags = new Set(['project', 'gate', 'hosts', 'language', 'profile', 'run', 'owner', 'expected-revision', 'operation-id', 'transaction', 'reason', 'stage', 'task', 'role', 'dispatch', 'attempt', 'agent-id', 'report', 'evidence', 'phase', 'status', 'checkpoint', 'plan-id', 'plan-digest', 'to', 'commit', 'previous-owner', 'resolution', 'step', 'command', 'baseline', 'mode']);
const booleanFlags = new Set(['json', 'help', 'version', 'dry-run', 'apply']);

export interface Arguments {
  words: string[];
  flags: Record<string, string | boolean>;
  project: string;
  json: boolean;
}

export function parseArguments(argv: string[]): Arguments {
  const words: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('-')) { words.push(arg); continue; }
    if (arg === '-h') { flags.help = true; continue; }
    if (arg === '-v') { flags.version = true; continue; }
    if (!arg.startsWith('--')) throw new WorkflowError('CLI_ARGUMENT', `Unknown argument: ${arg}`);
    const equal = arg.indexOf('=');
    const key = arg.slice(2, equal < 0 ? undefined : equal);
    if (key in flags) throw new WorkflowError('CLI_ARGUMENT', `Repeated flag: --${key}`);
    if (booleanFlags.has(key)) {
      if (equal >= 0) throw new WorkflowError('CLI_ARGUMENT', `--${key} takes no value`);
      flags[key] = true;
    } else if (valueFlags.has(key)) {
      const value = equal < 0 ? argv[++i] : arg.slice(equal + 1);
      if (!value || value.startsWith('--')) throw new WorkflowError('CLI_ARGUMENT', `--${key} requires a value`);
      flags[key] = value;
    } else throw new WorkflowError('CLI_ARGUMENT', `Unknown flag: --${key}`);
  }
  return { words, flags, project: resolve(String(flags.project ?? process.cwd())), json: flags.json === true };
}

export function requireFlag(args: Arguments, key: string): string {
  const value = args.flags[key];
  if (typeof value !== 'string' || !value.trim()) throw new WorkflowError('CLI_ARGUMENT', `--${key} is required`);
  return value;
}

export function allowFlags(args: Arguments, flags: string[]): void {
  const allowed = new Set(['project', 'json', 'help', ...flags]);
  for (const key of Object.keys(args.flags)) if (!allowed.has(key)) throw new WorkflowError('CLI_ARGUMENT', `--${key} is not valid for this command`);
}

export function requireWords(args: Arguments, count: number): void {
  if (args.words.length !== count) throw new WorkflowError('CLI_ARGUMENT', 'Invalid number of command arguments; use workflow --help');
}
