import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const script = resolve(root, 'scripts/write-deployment-identity.mjs');
const temp = await mkdtemp(resolve(tmpdir(), 'hex-deployment-identity-'));

try {
  await mkdir(resolve(temp, 'scripts'), { recursive: true });
  await mkdir(resolve(temp, 'js/userscript'), { recursive: true });
  await cp(script, resolve(temp, 'scripts/write-deployment-identity.mjs'));
  await writeFile(resolve(temp, 'source.js'), 'export const value = 1;\n');
  await writeFile(resolve(temp, 'js/userscript/deployment-identity.generated.js'), '// generated placeholder\n');

  git('init', '-q');
  git('config', 'user.name', 'Hex Test');
  git('config', 'user.email', 'hex-test@example.invalid');
  git('add', '.');
  git('commit', '-qm', 'fixture');
  const head = git('rev-parse', 'HEAD').trim();

  assert.equal(await generate({}), head, 'clean manual deploy must use the exact checkout HEAD');
  assert.equal(await generate({}), head, 'the script-owned generated identity must not make a repeat build dirty');

  await writeFile(resolve(temp, 'source.js'), 'export const value = 2;\n');
  assert.equal(await generate({}), null, 'unstaged tracked source changes must disable commit attestation');

  git('add', 'source.js');
  assert.equal(await generate({}), null, 'staged source changes must disable commit attestation');

  git('reset', '--hard', '-q', 'HEAD');
  await writeFile(resolve(temp, 'untracked-source.js'), 'export const extra = true;\n');
  assert.equal(await generate({}), null, 'untracked deployable source must disable commit attestation');

  const workersCommit = '0123456789abcdef0123456789abcdef01234567';
  assert.equal(await generate({ WORKERS_CI_COMMIT_SHA: workersCommit }), workersCommit, 'Workers CI commit must remain authoritative');

  console.log('userscript deployment identity: ok');
} finally {
  await rm(temp, { recursive: true, force: true });
}

function git(...args) {
  return execFileSync('git', args, { cwd: temp, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

async function generate(extraEnv) {
  execFileSync(process.execPath, ['scripts/write-deployment-identity.mjs'], {
    cwd: temp,
    env: { ...process.env, WORKERS_CI_COMMIT_SHA: '', ...extraEnv },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const source = await readFile(resolve(temp, 'js/userscript/deployment-identity.generated.js'), 'utf8');
  const match = source.match(/DEPLOYMENT_COMMIT=(null|"([0-9a-f]{40})")/);
  assert.ok(match, 'generated deployment identity must have the expected shape');
  return match[1] === 'null' ? null : match[2];
}
