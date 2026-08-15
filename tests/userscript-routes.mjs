import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { decodeBase64URL, signRuntimeSession } from '../js/userscript/runtime-security.js';

const port = Number(process.env.HEX_ROUTE_TEST_PORT || 8793);
const base = `http://127.0.0.1:${port}`;
const wrangler = new URL('../node_modules/.bin/wrangler', import.meta.url).pathname;
const child = spawn(wrangler, ['dev', '--local', '--port', String(port), '--ip', '127.0.0.1'], { cwd: new URL('../', import.meta.url), env: { ...process.env, NO_COLOR: '1', WRANGLER_SEND_METRICS: 'false' }, stdio: ['ignore', 'pipe', 'pipe'] });
let output = '';
child.stdout.on('data', (chunk) => { output = (output + chunk).slice(-20000); });
child.stderr.on('data', (chunk) => { output = (output + chunk).slice(-20000); });

try {
  await waitForServer();
  const rawPaths = [
    '/js/app.js', '/js/decompile.js', '/js/ir.js', '/js/ir-core.js', '/js/ai/runtime.js', '/css/app.css',
    '/package.json', '/package-lock.json', '/worker-entry.js', '/wrangler.jsonc', '/scripts/build-userscript.mjs',
    '/tests/userscript-host.mjs', '/.github/workflows/userscript-host.yml', '/userscript/hex.user.template.js',
    '/userscript-assets/js/app.js', '/.runtime/runtime.bin',
  ];
  for (const path of rawPaths) assert.ok([403, 404].includes((await fetch(base + path)).status), path);

  const manifest = JSON.parse(await readFile(new URL('../dist/runtime-manifest.json', import.meta.url), 'utf8'));
  const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const input = {
    nonce: 'nonce_route_0123456789abcdef', loaderVersion: `2.0.${Number.parseInt(manifest.buildId.slice(0, 8), 16)}`,
    buildId: manifest.buildId, requestId: 'request_route_012345', sessionIdentity: 'session_route_012345',
    clientPublicKey: await crypto.subtle.exportKey('jwk', pair.publicKey),
  };
  const headers = { 'content-type': 'application/json', origin: 'https://chatgpt.com' };
  assert.equal((await fetch(base + '/runtime/bootstrap', { method: 'POST', headers, body: JSON.stringify({ ...input, buildId: 'wrong-build' }) })).status, 409);
  const bootstrapResponse = await fetch(base + '/runtime/bootstrap', { method: 'POST', headers, body: JSON.stringify(input) });
  assert.equal(bootstrapResponse.status, 200); const bootstrap = await bootstrapResponse.json();
  assert.equal((await fetch(base + '/runtime/bootstrap', { method: 'POST', headers, body: JSON.stringify(input) })).status, 403, 'nonce replay');
  assert.equal((await fetch(base + bootstrap.runtimeLocator, { headers: { authorization: 'Bearer invalid' } })).status, 403);

  const secrets = (await import('../.runtime-build/runtime-secrets.js')).RUNTIME_BUILD;
  const expired = await signRuntimeSession({ v: 1, sid: 'expired-session', bid: manifest.buildId, rid: 'expired-request', exp: Math.floor(Date.now() / 1000) - 1 }, decodeBase64URL(secrets.signingKey));
  assert.equal((await fetch(base + bootstrap.runtimeLocator, { headers: { authorization: `Bearer ${expired}` } })).status, 403);

  const runtime = await fetch(base + bootstrap.runtimeLocator, { headers: { authorization: `Bearer ${bootstrap.session}` } });
  assert.equal(runtime.status, 200); assert.equal(runtime.headers.get('x-hex-runtime-build'), manifest.buildId); await runtime.arrayBuffer();
  assert.equal((await fetch(base + bootstrap.runtimeLocator, { headers: { authorization: `Bearer ${bootstrap.session}` } })).status, 403, 'session replay');
  console.log(`userscript-routes: ok (${rawPaths.length} private paths)`);
} finally {
  child.kill('SIGTERM');
  await Promise.race([new Promise((resolve) => child.once('exit', resolve)), new Promise((resolve) => setTimeout(resolve, 3000))]);
}

async function waitForServer() {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (child.exitCode != null) throw new Error(`wrangler exited before ready:\n${output}`);
    try { const response = await fetch(base + '/hex.meta.js'); if (response.status === 200) return; } catch {}
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`wrangler did not become ready:\n${output}`);
}
