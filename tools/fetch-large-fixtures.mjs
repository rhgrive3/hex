#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(await readFile(path.join(ROOT, 'tests/large-fixtures.json'), 'utf8'));
const requested = process.argv.slice(2);
const names = requested.length ? requested : Object.keys(manifest.fixtures);

for (const name of names) {
  const fixture = manifest.fixtures[name];
  if (!fixture) throw new Error(`unknown fixture: ${name}`);
  await fetchFixture(name, fixture);
}

async function fetchFixture(name, fixture) {
  const target = path.join(ROOT, fixture.path);
  const existing = await verifyFile(target, fixture).catch(() => false);
  if (existing) {
    console.log(`${name}: verified existing ${fixture.path}`);
    return;
  }

  await mkdir(path.dirname(target), { recursive: true });
  const temp = target + `.tmp-${process.pid}`;
  await rm(temp, { force: true });
  const sourcePath = fixture.path.split('/').map(encodeURIComponent).join('/');
  const url = `https://raw.githubusercontent.com/rhgrive3/hex/${manifest.sourceCommit}/${sourcePath}`;
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok || !response.body) throw new Error(`${name}: download failed (${response.status})`);

  const hash = createHash('sha1');
  hash.update(`blob ${fixture.size}\0`);
  let received = 0;
  const verifier = new TransformStream({
    transform(chunk, controller) {
      const bytes = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
      received += bytes.byteLength;
      hash.update(bytes);
      controller.enqueue(bytes);
    },
  });

  try {
    await pipeline(Readable.fromWeb(response.body.pipeThrough(verifier)), createWriteStream(temp, { flags: 'wx' }));
    if (received !== fixture.size) throw new Error(`${name}: size mismatch (${received} != ${fixture.size})`);
    const digest = hash.digest('hex');
    if (digest !== fixture.gitBlobSha1) throw new Error(`${name}: Git blob hash mismatch (${digest})`);
    await rename(temp, target);
    console.log(`${name}: fetched and verified ${fixture.path} (${received} bytes)`);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
}

async function verifyFile(file, fixture) {
  const info = await stat(file);
  if (info.size !== fixture.size) return false;
  const hash = createHash('sha1');
  hash.update(`blob ${fixture.size}\0`);
  const { createReadStream } = await import('node:fs');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex') === fixture.gitBlobSha1;
}
