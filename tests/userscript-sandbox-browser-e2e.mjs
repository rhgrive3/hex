import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, webcrypto } from 'node:crypto';
import { chromium, webkit } from 'playwright';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CHATGPT = 'https://chatgpt.com';
const WORKER = 'https://ida.rhgrive.workers.dev';
const PARENT = `${CHATGPT}/__hex_sandbox_e2e__`;
const NONCE = 'hex-e2e-nonce';
const TIMEOUT = 45_000;
const CSP = [
  "default-src 'self'",
  `script-src 'nonce-${NONCE}' 'self' blob: 'wasm-unsafe-eval'`,
  `script-src-elem 'nonce-${NONCE}' 'self' blob:`,
  "style-src 'self' 'unsafe-inline' blob:",
  `connect-src 'self' ${WORKER}`,
  "frame-src 'self' https://*.embed.chatgpt.site https://*.web-sandbox.oaiusercontent.com",
  "worker-src 'self' blob:",
  "img-src 'self' data: blob:",
].join('; ');
assert.equal(CSP.includes(WORKER.replace('https://', 'frame-src https://')), false);

const { RUNTIME_BUILD } = await import('../.runtime-build/runtime-secrets.js');
const template = (await readFile(path.join(ROOT, 'userscript/hex.user.template.js'), 'utf8')).replaceAll('__HEX_ORIGIN__', WORKER);
const encryptedRuntime = await readFile(path.join(ROOT, 'dist', RUNTIME_BUILD.manifest.assetPath.slice(1)));

for (const [name, browserType] of [['chromium', chromium], ['webkit', webkit]]) await run(name, browserType);
console.log('userscript sandbox browser e2e: ok');

async function run(name, browserType) {
  const browser = await browserType.launch({ headless: true, args: name === 'chromium' ? ['--no-sandbox'] : [] });
  const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1024, height: 768 }, locale: 'ja-JP' });
  await context.addInitScript({ content: `addEventListener('DOMContentLoaded',()=>{${template}\n},{once:true});` });
  const page = await context.newPage();
  const logs = [];
  let bootCount = 0, runtimeCount = 0, directFrameCount = 0;
  page.on('console', m => logs.push(`console:${m.type()}:${m.text()}`));
  page.on('pageerror', e => logs.push(`pageerror:${e.message}`));
  page.on('requestfailed', r => logs.push(`requestfailed:${r.url()}:${r.failure()?.errorText || ''}`));
  await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin === WORKER && url.pathname === '/runtime/bootstrap') bootCount++;
    if (url.origin === WORKER && url.pathname.startsWith('/_runtime/')) runtimeCount++;
    if (url.origin === WORKER && url.pathname === '/embed/chatgpt') directFrameCount++;
    await serve(route);
  });

  try {
    await page.goto(PARENT, { waitUntil: 'domcontentloaded', timeout: TIMEOUT });
    await page.waitForSelector('#hex-userscript-iframe', { state: 'attached', timeout: TIMEOUT });
    const before = await page.evaluate(() => {
      const f = document.getElementById('hex-userscript-iframe');
      globalThis.__HEX_TEST_FRAME__ = f;
      return { src: f?.getAttribute('src'), hasSrcdoc: !!f?.srcdoc, sandbox: f?.getAttribute('sandbox') || '', legacy: !!document.getElementById('hex-userscript-host') };
    });
    assert.equal(before.src, null, `${name}: no external iframe src`);
    assert.equal(before.hasSrcdoc, true, `${name}: srcdoc is required`);
    assert.equal(before.sandbox.includes('allow-scripts'), true, `${name}: scripts are required`);
    assert.equal(before.sandbox.includes('allow-same-origin'), false, `${name}: sandbox must remain opaque`);
    assert.equal(before.legacy, false, `${name}: no automatic legacy fallback`);

    const child = await waitReady(page);
    const childState = await child.evaluate(() => {
      globalThis.__HEX_TEST_PERSIST__ = 1;
      return {
        origin: location.origin,
        href: location.href,
        app: !!globalThis.__app,
        bridge: !!globalThis.__HEX_CHATGPT_BRIDGE__,
        apiBase: globalThis.__HEX_API_BASE__ || null,
        appNode: !!document.getElementById('app'),
        cssBytes: document.getElementById('hex-userscript-style')?.textContent?.length || 0,
        bodyBg: getComputedStyle(document.body).backgroundColor,
      };
    });
    assert.equal(childState.origin, 'null', `${name}: child origin must be opaque`);
    assert.equal(childState.href.startsWith('about:srcdoc'), true, `${name}: child must stay in srcdoc`);
    assert.equal(childState.apiBase, WORKER, `${name}: verified virtual API origin`);
    assert.equal(childState.app, true, `${name}: app initialized`);
    assert.equal(childState.bridge, true, `${name}: RPC bridge initialized`);
    assert.equal(childState.appNode, true, `${name}: canonical app exists`);
    assert.ok(childState.cssBytes > 10_000, `${name}: canonical CSS missing (${childState.cssBytes})`);
    assert.notEqual(childState.bodyBg, '', `${name}: CSS must compute`);
    assert.equal(directFrameCount, 0, `${name}: old /embed/chatgpt navigation must never happen`);
    assert.equal(bootCount, 1, `${name}: one secure bootstrap`);
    assert.equal(runtimeCount, 1, `${name}: one encrypted runtime fetch`);
    assert.equal(await page.evaluate(() => !!document.getElementById('hex-userscript-host')), false, `${name}: legacy DOM absent after ready`);

    await page.click('#hex-userscript-emergency-close');
    await page.waitForFunction(() => document.getElementById('hex-userscript-iframe-host')?.getAttribute('aria-hidden') === 'true');
    await page.click('#hex-userscript-launcher');
    await page.waitForFunction(() => document.getElementById('hex-userscript-iframe-host')?.getAttribute('aria-hidden') !== 'true');
    assert.equal(await page.evaluate(() => document.getElementById('hex-userscript-iframe') === globalThis.__HEX_TEST_FRAME__), true, `${name}: iframe persisted`);
    assert.equal(await child.evaluate(() => globalThis.__HEX_TEST_PERSIST__), 1, `${name}: app state persisted`);
    console.log(`ok ${name}: crypto -> opaque srcdoc -> RPC -> workers -> app -> CSS`);
  } catch (error) {
    const state = await safePage(page, () => ({
      status: document.getElementById('hex-userscript-iframe-status')?.textContent || null,
      loader: document.getElementById('hex-secure-loader')?.textContent || null,
      legacy: !!document.getElementById('hex-userscript-host'),
      iframe: !!document.getElementById('hex-userscript-iframe'),
    }));
    throw new Error(`${name}: ${error?.message || error}\ncounts=${bootCount}/${runtimeCount}/${directFrameCount}\nstate=${JSON.stringify(state)}\n${logs.slice(-40).join('\n')}`);
  } finally {
    await context.close();
    await browser.close();
  }
}

async function waitReady(page) {
  const until = Date.now() + TIMEOUT;
  while (Date.now() < until) {
    const parentState = await safePage(page, () => ({ status: document.getElementById('hex-userscript-iframe-status')?.textContent || '', loader: document.getElementById('hex-secure-loader')?.textContent || '', legacy: !!document.getElementById('hex-userscript-host') }));
    if (parentState?.legacy) throw new Error('legacy fallback appeared');
    if (parentState?.status?.startsWith('Hex failed')) throw new Error(parentState.status);
    if (parentState?.loader?.includes(' failed ')) throw new Error(parentState.loader);
    const handle = await page.$('#hex-userscript-iframe');
    const frame = handle ? await handle.contentFrame() : null;
    if (frame && await safeFrame(frame, () => !!globalThis.__app && !!globalThis.__HEX_CHATGPT_BRIDGE__ && !!document.getElementById('app') && !!document.getElementById('hex-userscript-style'))) return frame;
    await page.waitForTimeout(50);
  }
  throw new Error(`sandbox readiness timeout; frames=${page.frames().map(f => f.url()).join('|')}`);
}

async function serve(route) {
  const request = route.request();
  const url = new URL(request.url());
  if (['blob:', 'data:', 'about:'].includes(url.protocol)) return route.continue();
  if (request.url() === PARENT) return route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', headers: { 'content-security-policy': CSP, 'cache-control': 'no-store' }, body: `<!doctype html><html><head><meta charset="utf-8"><script nonce="${NONCE}">globalThis.__CHATGPT_TEST__=1<\/script></head><body><div id="prompt-textarea" role="textbox" contenteditable="true"></div><button data-testid="send-button">Send</button></body></html>` });
  if (url.origin !== WORKER) return route.abort('blockedbyclient');
  if (url.pathname === '/embed/chatgpt') return route.fulfill({ status: 451, body: 'forbidden old frame path' });
  const origin = request.headers().origin || CHATGPT;
  if (request.method() === 'OPTIONS') {
    const asset = url.pathname.startsWith('/_runtime/');
    return route.fulfill({ status: 204, headers: { 'access-control-allow-origin': origin, 'access-control-allow-methods': asset ? 'GET, OPTIONS' : 'POST, OPTIONS', 'access-control-allow-headers': asset ? 'Authorization' : 'Content-Type', vary: 'Origin' }, body: '' });
  }
  if (url.pathname === '/runtime/bootstrap' && request.method() === 'POST') return route.fulfill({ status: 200, contentType: 'application/json', headers: cors(origin), body: JSON.stringify(await issue(JSON.parse(request.postData() || '{}'))) });
  if (url.pathname === `/_runtime/${RUNTIME_BUILD.manifest.buildId}` && request.method() === 'GET') return route.fulfill({ status: 200, contentType: 'application/octet-stream', headers: cors(origin), body: encryptedRuntime });
  return route.fulfill({ status: 404, body: 'not found' });
}

async function issue(input) {
  assert.equal(input.buildId, RUNTIME_BUILD.manifest.buildId);
  const subtle = webcrypto.subtle;
  const client = await subtle.importKey('jwk', input.clientPublicKey, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const server = await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const shared = await subtle.deriveBits({ name: 'ECDH', public: client }, server.privateKey, 256);
  const salt = randomBytes(32), iv = randomBytes(12);
  const material = await subtle.importKey('raw', shared, 'HKDF', false, ['deriveKey']);
  const wrap = await subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt, info: new TextEncoder().encode(`hex-runtime-wrap:${RUNTIME_BUILD.manifest.buildId}`) }, material, { name: 'AES-GCM', length: 256 }, false, ['encrypt']);
  const sid = `e2e-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const ciphertext = await subtle.encrypt({ name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(`${RUNTIME_BUILD.manifest.buildId}:${sid}`), tagLength: 128 }, wrap, Buffer.from(RUNTIME_BUILD.contentKey, 'base64url'));
  new Uint8Array(shared).fill(0);
  const { assetPath: _private, ...manifest } = RUNTIME_BUILD.manifest;
  return { session: sid, sessionId: sid, expiry: new Date(Date.now() + 120_000).toISOString(), buildId: RUNTIME_BUILD.manifest.buildId, manifest, runtimeLocator: `/_runtime/${RUNTIME_BUILD.manifest.buildId}`, serverPublicKey: await subtle.exportKey('jwk', server.publicKey), keyEnvelope: { algorithm: 'ECDH-P256+HKDF-SHA256+A256GCM', salt: b64(salt), iv: b64(iv), ciphertext: b64(new Uint8Array(ciphertext)) } };
}
function cors(origin) { return { 'access-control-allow-origin': origin, 'cache-control': 'no-store', vary: 'Origin' }; }
function b64(value) { return Buffer.from(value).toString('base64url'); }
async function safePage(page, fn) { try { return await page.evaluate(fn); } catch { return null; } }
async function safeFrame(frame, fn) { try { return await frame.evaluate(fn); } catch { return false; } }
