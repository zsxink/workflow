import { git } from './git.js';
import { assert, WorkflowError } from '../shared/errors.js';

/** Resolves only branch refs and rejects ambiguous local/remote short names. */
export async function resolveBaseRef(root: string, value: string | undefined): Promise<string> {
  assert(value && !/[\0-\x20\x7f]/.test(value), 'GIT_BASE_UNKNOWN', 'git.baseBranch must identify a verified branch ref');
  const candidates = value.startsWith('refs/') ? [value] : [`refs/heads/${value}`, `refs/remotes/${value}`];
  const matches: string[] = [];
  for (const ref of candidates) {
    assert(ref.startsWith('refs/heads/') || ref.startsWith('refs/remotes/'), 'GIT_BASE_INVALID', 'Base must be a local or remote branch ref');
    try {
      await git(root, ['check-ref-format', ref]);
      await git(root, ['show-ref', '--verify', ref]);
      await git(root, ['rev-parse', '--verify', `${ref}^{commit}`]);
      matches.push(ref);
    } catch (error) { if (!(error instanceof WorkflowError) || error.code !== 'GIT_ERROR') throw error; }
  }
  assert(matches.length === 1, 'GIT_BASE_AMBIGUOUS', 'Configured base branch is missing or ambiguous; configure its complete refs/heads/... or refs/remotes/... ref');
  return matches[0];
}

/** A remote base also protects its tracking and conventional local branch. */
export async function assertChangeBranch(root: string, baseRef: string, code: string): Promise<string> {
  const branch = (await git(root, ['symbolic-ref', '-q', 'HEAD'])).trim();
  let isBase = branch === baseRef;
  if (baseRef.startsWith('refs/remotes/')) {
    const upstream = (await git(root, ['for-each-ref', '--format=%(upstream)', branch])).trim();
    isBase ||= upstream === baseRef;
    const remotePath = baseRef.slice('refs/remotes/'.length);
    const configuredRemotes = (await git(root, ['remote'])).trim().split('\n').filter(Boolean).sort((a, b) => b.length - a.length);
    const remote = configuredRemotes.find(name => remotePath.startsWith(`${name}/`));
    // Even a locally constructed remote ref protects its matching local name.
    const branchName = remote ? remotePath.slice(remote.length + 1) : remotePath.slice(remotePath.indexOf('/') + 1);
    assert(branchName && remotePath.includes('/'), 'GIT_BASE_AMBIGUOUS', 'Cannot establish the local counterpart of the remote base');
    isBase ||= branch === `refs/heads/${branchName}`;
  }
  assert(!isBase, code, 'Prepare a separate change branch before writing Workflow change or run data', 3);
  return branch;
}
