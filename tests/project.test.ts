import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { loadConfig, pathMatches, resolveProjectPath, selectCommands, executeCommand, type ValidationCommand } from '../src/project/index.js';

async function fixture(t: { after: (fn: () => Promise<void>) => void }, text?: string): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(),'workflow-project-'));
  t.after(() => rm(root,{recursive:true,force:true}));
  await mkdir(path.join(root,'.workflow'));
  await writeFile(path.join(root,'.workflow/config.yaml'),text ?? await readFile(new URL('../examples/config/minimal.yaml',import.meta.url),'utf8'));
  return root;
}
function command(args: string[], patch: Partial<ValidationCommand> = {}): ValidationCommand {
  return {id:'test',executable:'node',args,cwd:'.',timeoutSeconds:3,modules:['*'],artifacts:[],envAllowlist:['PATH'],...patch};
}

test('loads shipped minimal and GitHub configuration and selects in declaration order', async t => {
  const root = await fixture(t);
  const config = await loadConfig(root);
  assert.equal(config.project.id,'sample-app');
  assert.deepEqual(selectCommands(config,['app']).map(c => c.id),['app-session-test','app-test','app-build']);
  assert.deepEqual(selectCommands(config,['docs']),[]);
  assert.throws(() => selectCommands(config,['unknown']),{code:'CONFIG_INVALID'});
  await writeFile(path.join(root,'.workflow/config.yaml'),await readFile(new URL('../examples/config/github.yaml',import.meta.url),'utf8'));
  assert.equal((await loadConfig(root)).tracking.providers[0].github.repository,'example/planning');
});

test('strict unknown/version/duplicate/YAML/command and artifact validation', async t => {
  const root = await fixture(t);
  const file = path.join(root,'.workflow/config.yaml');
  const original = await readFile(file,'utf8');
  for (const changed of [
    original + '\nunknown: true\n',
    original.replace('formatVersion: 1','formatVersion: 2'),
    original.replace('retryLimit: 2','requireIssue: true'),
    original + '\nformatVersion: 1\n',
    original.replace('id: docs','id: app'),
    original.replace('id: docs','id: Bad_Module'),
    original.replace('modules: [app]','modules: [unknown]'),
    original.replace('artifacts: [dist/**]','artifacts: [src/**]'),
    original.replace('artifacts: [dist/**]','artifacts: [**]'),
    original.replace('executable: npm','executable: codex'),
    original.replace('executable: npm','executable: bash'),
    original.replace('args: [run, build]','args: [exec, "@openai/codex", exec]'),
    original.replace('timeoutSeconds: 300','timeoutSeconds: 0'),
    original.replace('required: false','required: true'),
    original.replace('cwd: .','cwd: ../escape'),
  ]) {
    await writeFile(file,changed);
    await assert.rejects(loadConfig(root));
  }
});

test('relative paths reject POSIX/Windows escapes, Git metadata, and symlinks outside root', async t => {
  const root = await fixture(t);
  const outside = await mkdtemp(path.join(os.tmpdir(),'workflow-outside-'));
  t.after(() => rm(outside,{recursive:true,force:true}));
  await symlink(outside,path.join(root,'escape'));
  await symlink(path.join(outside,'nonexistent'),path.join(root,'dangling'));
  await mkdir(path.join(root,'inside'));
  await symlink(path.join(root,'inside'),path.join(root,'link'));
  for (const unsafe of ['../outside','/etc/passwd','C:\\Windows\\x','a/../../x','.git/config','escape/missing/file','dangling/file']) {
    await assert.rejects(resolveProjectPath(root,unsafe),{code:'PATH_UNSAFE'});
  }
  assert.equal(await resolveProjectPath(root,'link/new'),path.join(await realpath(root),'link/new'));
  assert.equal(await resolveProjectPath(root,'new/nested'),path.join(await realpath(root),'new/nested'));
  assert.equal(pathMatches('src/.hidden.ts',['src/**']),true);
  assert.equal(pathMatches('docs/design.md',['src/**']),false);
  assert.throws(() => pathMatches('../src/a',['**']),{code:'PATH_UNSAFE'});
});

test('executor passes literal argv, limits retained output and hashes full streams', async t => {
  const root = await fixture(t);
  const expected = 'x'.repeat(10000);
  const result = await executeCommand(root,command(['-e',`process.stdout.write('x'.repeat(10000));process.stderr.write(process.argv[1])`,';echo shell']),{maxOutputBytes:100});
  assert.equal(result.exitCode,0);
  assert.equal(result.stdout,'x'.repeat(100));
  assert.equal(result.stdoutBytes,10000);
  assert.equal(result.stdoutTruncated,true);
  assert.equal(result.stderr,';echo shell');
  assert.equal(result.stdoutSha256,createHash('sha256').update(expected).digest('hex'));
  assert.equal(result.timedOut,false);
});

test('executor only forwards allowlisted environment and redacts known secret values', async t => {
  const root = await fixture(t);
  const result = await executeCommand(root,command(['-e',`process.stdout.write(JSON.stringify({token:process.env.API_TOKEN,hidden:process.env.HIDDEN}));`],{envAllowlist:['PATH','API_TOKEN']}),{env:{PATH:process.env.PATH,API_TOKEN:'super-secret-value',HIDDEN:'unwanted'}});
  assert.equal(result.exitCode,0);
  assert.equal(result.stdout,'{"token":"[REDACTED]"}');
  assert.deepEqual(result.environmentNames,['API_TOKEN','PATH']);
  assert.equal(result.stdout.includes('super-secret'),false);
  const cut = await executeCommand(root,command(['-e',`process.stdout.write(process.env.API_TOKEN)`],{envAllowlist:['PATH','API_TOKEN']}),{env:{PATH:process.env.PATH,API_TOKEN:'super-secret-value'},maxOutputBytes:6});
  assert.equal(cut.stdout,'[REDACTED]');
});

test('executor reports nonzero exits, timeout and missing executable distinctly', async t => {
  const root = await fixture(t);
  const failed = await executeCommand(root,command(['-e','process.exit(7)']));
  assert.equal(failed.exitCode,7);
  assert.equal(failed.timedOut,false);
  const timeout = await executeCommand(root,command(['-e','setInterval(()=>{},1000)'],{timeoutSeconds:1}));
  assert.equal(timeout.timedOut,true);
  assert.equal(timeout.signal,'SIGKILL');
  assert.equal(timeout.exitCode,null);
  await assert.rejects(executeCommand(root,command([],{executable:'workflow-missing-executable'})),{code:'COMMAND_START_FAILED',exitCode:6});
});
