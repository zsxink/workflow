import { assert } from '../shared/errors.js';
import { git, readRun, assertStoreReadable, locateRepository } from '../runtime/index.js';
import { loadChange, parseSpec, planRebaseline, validateHistory, type SpecDocument } from '../spec/index.js';

/** Three-way preview uses a fixed recorded Git object, never guesses missing old content. */
export async function previewRebaseline(project: string, changeId: string, runId: string) {
  const repo = await locateRepository(project);
  await assertStoreReadable(repo.root);
  const run = await readRun(repo.root, runId);
  assert(run.formatVersion === 1 && run.changeId === changeId && run.worktree === repo.root, 'REBASELINE_RUN_MISMATCH', 'Rebaseline preview requires this change and its original worktree');
  const head = (run.checkpoints.bootstrap as { head?: unknown } | undefined)?.head;
  assert(typeof head === 'string' && /^[a-f0-9]{40}([a-f0-9]{24})?$/.test(head), 'REBASELINE_BASE_UNAVAILABLE', 'Run has no verified original Git snapshot', 3);
  assert((await git(repo.root, ['rev-parse', '--verify', `${head}^{commit}`])).trim() === head, 'REBASELINE_BASE_UNAVAILABLE', 'Recorded Git snapshot is unavailable', 3);
  const bundle = await loadChange(repo.root, changeId);
  assert(!bundle.diagnostics.length && !bundle.metadata.diagnostics.length && !validateHistory(bundle.history, bundle.archives).length && [...bundle.deltas, ...bundle.specs].every(delta => !delta.diagnostics.length), 'REBASELINE_INVALID_INPUT', 'Change inputs are malformed');
  const baseSpecs: SpecDocument[] = [];
  for (const delta of bundle.deltas) {
    assert(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(delta.capability), 'REBASELINE_INVALID_CAPABILITY', 'Capability is invalid');
    const specPath = `.workflow/specs/${delta.capability}/spec.md`;
    const tree = await git(repo.root, ['ls-tree', '-z', head, '--', specPath]);
    if (!tree) continue;
    assert(/^(100644|100755) blob [a-f0-9]+\t/.test(tree) && tree.split('\0').filter(Boolean).length === 1, 'REBASELINE_BASE_UNSUPPORTED', 'Original spec must be a regular Git blob', 3);
    baseSpecs.push(parseSpec(await git(repo.root, ['show', `${head}:${specPath}`]), `${head}:${specPath}`));
  }
  const plan = planRebaseline({ baseSpecs, currentSpecs: bundle.specs, deltas: bundle.deltas, history: bundle.history, activeReferences: bundle.activeReferences, changeId, revision: run.revision });
  return { ...plan, runId, originalHead: head, readonly: true, applyAvailable: false };
}
