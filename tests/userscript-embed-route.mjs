import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';

const port = Number(process.env.HEX_EMBED_ROUTE_TEST_PORT || 8795);
const base = `http://127.0.0.1:${port}`;
const wrangler = new URL('../node_modules/.bin/wrangler', import.meta.url).pathname;
const child = spawn(wrangler, ['dev', '--local', '--port', String(port), '--ip', '127.0.0.1'], {
  cwd: new URL('../', import.meta.url),
  env: { ...process.env, NO_COLOR: '1', WRANGLER_SEND_METRICS: 'false' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let output = '';
child.stdout.on('data', (chunk) => { output = (output + chunk).slice(-20000); });
child.stderr.on('data', (chunk) => { output = (output + chunk).slice(-20000); });

try {
  await waitForServer();

  const root = await fetch(base + '/');
  assert.equal(root.status, 200, 'normal root route');
  const rootBody = await root.text();
  assert.match(rootBody, /<div class="app" id="app">/, 'root still serves the standalone Hex shell');

  const embed = await fetch(base + '/embed/chatgpt');
  assert.equal(embed.status, 200, 'GET /embed/chatgpt');
  const embedBody = await embed.text();
  assert.equal(embedBody, rootBody, 'embed route reuses canonical /index.html shell');
  assert.match(embed.headers.get('content-type') || '', /^text\/html;\s*charset=utf-8$/i);

  const csp = embed.headers.get('content-security-policy');
  assert.ok(csp, 'embed CSP exists');
  assert.match(csp, /(?:^|;)\s*frame-ancestors\s+[^;]*https:\/\/chatgpt\.com(?:\s|;|$)/i);
  assert.match(csp, /(?:^|;)\s*frame-ancestors\s+[^;]*https:\/\/chat\.openai\.com(?:\s|;|$)/i);
  assert.doesNotMatch(csp, /(?:^|;)\s*frame-ancestors\s+[^;]*\*/i, 'no wildcard frame ancestor');
  assert.equal(embed.headers.get('x-frame-options'), null, 'embed must not use X-Frame-Options');
  assert.equal(embed.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(embed.headers.get('referrer-policy'), 'no-referrer');
  assert.equal(embed.headers.get('cross-origin-resource-policy'), null, 'embed must not inherit CORP same-site');
  assert.match(embed.headers.get('cache-control') || '', /(?:^|,)\s*no-store\s*(?:,|$)/i, 'embed shell must not stick in cache');
  assert.equal(embed.headers.get('access-control-allow-origin'), null, 'iframe navigation does not require CORS');

  const head = await fetch(base + '/embed/chatgpt', { method: 'HEAD' });
  assert.equal(head.status, embed.status, 'HEAD status matches GET');
  for (const name of ['content-type', 'content-security-policy', 'cache-control', 'x-content-type-options', 'referrer-policy']) {
    assert.equal(head.headers.get(name), embed.headers.get(name), `HEAD ${name} matches GET`);
  }
  assert.equal(await head.text(), '', 'HEAD has no body');

  for (const method of ['POST', 'PUT']) {
    const response = await fetch(base + '/embed/chatgpt', { method });
    assert.equal(response.status, 405, `${method} /embed/chatgpt`);
    assert.equal(response.headers.get('allow'), 'GET, HEAD');
  }

  const hostileOrigin = await fetch(base + '/embed/chatgpt', { headers: { origin: 'https://evil.example' } });
  assert.equal(hostileOrigin.status, 200, 'navigation is not Origin-authenticated');
  assert.notEqual(hostileOrigin.headers.get('access-control-allow-origin'), '*', 'no arbitrary CORS wildcard');
  await hostileOrigin.body?.cancel();

  for (const path of ['/js/app.js', '/css/app.css', '/userscript/hex.user.template.js', '/.runtime/runtime.bin']) {
    assert.equal((await fetch(base + path)).status, 404, `${path} stays private`);
  }

  const manifest = JSON.parse(await readFile(new URL('../dist/runtime-manifest.json', import.meta.url), 'utf8'));
  assert.equal((await fetch(base + `/_runtime/${manifest.buildId}`)).status, 403, 'protected runtime still requires Bearer session');
  assert.equal((await fetch(base + '/_runtime/wrong-build')).status, 403, 'wrong protected runtime build rejected');

  const bootstrapMethod = await fetch(base + '/runtime/bootstrap');
  assert.equal(bootstrapMethod.status, 405, 'bootstrap GET remains rejected');
  assert.equal(bootstrapMethod.headers.get('allow'), 'POST, OPTIONS');

  const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const bootstrapInput = {
    nonce: 'nonce_embed_route_0123456789abcdef',
    loaderVersion: `2.0.${Number.parseInt(manifest.buildId.slice(0, 8), 16)}`,
    buildId: 'wrong-build',
    requestId: 'request_embed_route_012345',
    sessionIdentity: 'session_embed_route_012345',
    clientPublicKey: await crypto.subtle.exportKey('jwk', pair.publicKey),
  };
  const wrongBuild = await fetch(base + '/runtime/bootstrap', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'https://chatgpt.com' },
    body: JSON.stringify(bootstrapInput),
  });
  assert.equal(wrongBuild.status, 409, 'bootstrap wrong build rejection remains intact');

  console.log('userscript-embed-route: ok');
} finally {
  child.kill('SIGTERM');
  await Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    new Promise((resolve) => setTimeout(resolve, 3000)),
  ]);
}

async function waitForServer() {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (child.exitCode != null) throw new Error(`wrangler exited before ready:\n${output}`);
    try {
      const response = await fetch(base + '/embed/chatgpt');
      if (response.status === 200) { await response.body?.cancel(); return; }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`wrangler did not become ready:\n${output}`);
}
