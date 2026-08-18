import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = resolve(root, '.runtime-build/deployment-identity.js');
const raw = String(process.env.WORKERS_CI_COMMIT_SHA || '').trim().toLowerCase();
const commit = /^[0-9a-f]{40}$/.test(raw) ? raw : null;

await mkdir(dirname(out), { recursive: true });
await writeFile(out, `export const DEPLOYMENT_COMMIT=${JSON.stringify(commit)};\n`);
console.log(`deployment source commit ${commit || 'unavailable'}`);
