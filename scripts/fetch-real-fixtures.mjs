#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';

const root = fileURLToPath(new URL('../', import.meta.url));
const manifest = JSON.parse(await (await import('node:fs/promises')).readFile(join(root, 'tests/fixtures/real-binaries.json'), 'utf8'));
const outputDir = join(root, 'tests/.real-fixtures');
const args = process.argv.slice(2);
const checkOnly = args.includes('--check');
const requested = args.filter((arg) => arg !== '--check');
const names = requested.length && !requested.includes('all') ? requested : Object.keys(manifest.fixtures);

function fixture(name) {
  const spec = manifest.fixtures[name];
  if (!spec) throw new Error(`unknown fixture: ${name}`);
  return spec;
}

async function digestFile(path) {
  const hash = createHash('sha256');
  let size = 0;
  for await (const chunk of createReadStream(path)) {
    size += chunk.length;
    hash.update(chunk);
  }
  return { size, sha256: hash.digest('hex') };
}

async function verify(name, path, spec) {
  let info;
  try { info = await stat(path); } catch { throw new Error(`${name}: fixture is missing at ${path}`); }
  if (!info.isFile()) throw new Error(`${name}: fixture path is not a file`);
  if (info.size !== spec.size) throw new Error(`${name}: size mismatch (${info.size} != ${spec.size})`);
  const digest = await digestFile(path);
  if (digest.sha256 !== spec.sha256) throw new Error(`${name}: SHA-256 mismatch`);
  return digest;
}

async function fetchFixture(name, spec) {
  const target = join(outputDir, spec.file);
  try {
    await verify(name, target, spec);
    console.log(`${name}: verified existing fixture`);
    return;
  } catch (error) {
    if (checkOnly) throw error;
  }

  const url = process.env[spec.urlEnv];
  if (!url) throw new Error(`${name}: set ${spec.urlEnv} to the fixture download URL`);
  if (!/^https:\/\//i.test(url)) throw new Error(`${name}: fixture URL must use HTTPS`);

  await mkdir(dirname(target), { recursive:true });
  const temp = `${target}.partial-${process.pid}`;
  await rm(temp, { force:true });
  const response = await fetch(url, { redirect:'follow' });
  if (!response.ok || !response.body) throw new Error(`${name}: download failed with HTTP ${response.status}`);

  const hash = createHash('sha256');
  const output = createWriteStream(temp, { flags:'wx', mode:0o600 });
  let size = 0;
  try {
    for await (const chunk of response.body) {
      const bytes = Buffer.from(chunk);
      size += bytes.length;
      if (size > spec.size) throw new Error(`${name}: download exceeded pinned size`);
      hash.update(bytes);
      if (!output.write(bytes)) await once(output, 'drain');
    }
    output.end();
    await once(output, 'finish');
    const sha256 = hash.digest('hex');
    if (size !== spec.size) throw new Error(`${name}: size mismatch (${size} != ${spec.size})`);
    if (sha256 !== spec.sha256) throw new Error(`${name}: SHA-256 mismatch`);
    await rename(temp, target);
    console.log(`${name}: downloaded and verified`);
  } catch (error) {
    output.destroy();
    await rm(temp, { force:true });
    throw error;
  }
}

try {
  for (const name of names) await fetchFixture(name, fixture(name));
} catch (error) {
  console.error(error && error.message ? error.message : String(error));
  process.exitCode = 1;
}
