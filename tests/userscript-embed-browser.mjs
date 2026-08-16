import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, webcrypto } from 'node:crypto';
import { chromium, webkit } from 'playwright';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CHATGPT_ORIGIN = 'https://chatgpt.com';
const WORKER_ORIGIN = 'https://ida.rhgrive.workers.dev';
const PARENT_URL = `${CHATGPT_ORIGIN}/__hex_embed_e2e__`;
const NONCE = 'hex-e2e-nonce';
const TIMEOUT_MS = 45_000;
const CSP = [
  "default-src 'self'",
  `script-src 'nonce-${NONCE}' 'self' blob: 'wasm-unsafe-eval'`,
  `script-src-elem 'nonce-${NONCE}' 'self' blob:`,
  "style-src 'self' 'unsafe-inline' blob:",
  `connect-src 'self' ${WORKER_ORIGIN}`,
  "frame-src 'self' https://*.embed.chatgpt.site https://*.web-sandbox.oaiusercontent.com",
  "worker-src 'self' blob:",
  "img-src 'self' data: blob:",
].join('; ');

assert.equal(CSP.includes(`frame-src 'self' ${WORKER_ORIGIN}`), false,
  'the E2E must model ChatGPT blocking the old direct Worker iframe');

const { RUNTIME_BUILD } = await import('../.runtime-build/runtime-secrets.js');
const template = (await readFile(path.join(ROOT, 'userscript/hex.user.template.js'), 'utf8'))
  .replaceAll('__HEX_ORIGIN__', WORKER_ORIGIN);
const runtimeBytes = await readFile(path.join(ROOT, 'dist', RUNTIME_BUILD.manifest.assetPath.slice(1)));

for (const [name, browserType] of [['chromium', chromium], ['webkit', webkit]]) {
  await run(name, browserType);
}
console.log('userscript secure sandbox browser e2e: ok');

async function run(name, browserType) {
  const browser = await browserType.launch({ headless: true, args: name === 'chromium' ? ['--no-sandbox'] : [] });
  const context = await browser.newContext({ viewport: { width: 1024, height: 768 }, locale: 'ja-JP', ignoreHTTPSErrors: true });
  await context.addInitScript({ content: `addEventListener('DOMContentLoaded',()=>{${template}\n},{once:true});` });
  const page = await context.newPage();
  const diagnostic = [];
  let bootstrapRequests = 0;
  let runtimeRequests = 0;
  let externalEmbedRequests = 0;

  page.on('console', (message) => diagnostic.push(`console:${message.type()}: ${message.text()}`));
  page.on('pageerror', (error) => diagnostic.push(`pageerror: ${error.message}`));
  page.on('requestfailed', (request) => diagnostic.push(`requestfailed: ${request.method()} ${request.url()} ${request.failure()?.errorText || ''}`));

  await context.route('**/*', async (route) => {
    const request = route.request();
    try {
      const url = new URL(request.url());
      if (url.origin === WORKER_ORIGIN && url.pathname === '/runtime/bootstrap') bootstrapRequests += 1;
      if (url.origin === WORKER_ORIGIN && url.pathname.startsWith('/_runtime/')) runtimeRequests += 1;
      if (url.origin === WORKER_ORIGIN && url.pathname === '/embed/chatgpt') externalEmbedRequests += 1;
      await routeRequest(route);
    } catch (error) {
      diagnostic.push(`route-error: ${request.method()} ${request.url()} ${error?.message || error}`);
      await route.abort('failed');
    }
  });

  try {
    await page.goto(PARENT_URL, { waitUntil: 'domcontentloaded', timeout: TIMEOUT_MS });
    await page.waitForSelector('#hex-userscript-iframe', { state: 'attached', timeout: TIMEOUT_MS });

    const initial = await page.evaluate(() => {
      const iframe = document.getElementById('hex-userscript-iframe');
      globalThis.__HEX_E2E_IFRAME__ = iframe;
      return {
        src: iframe?.getAttribute('src'),
        srcdoc: !!iframe?.srcdoc,
        sandbox: iframe?.getAttribute('sandbox') || '',
        legacy: !!document.getElementById('hex-userscript-host'),
      };
    });
    assert.equal(initial.src, null, `${name}: sandbox must not have a Worker URL src`);
    assert.equal(initial.srcdoc, true, `${name}: sandbox must use srcdoc`);
    assert.equal(initial.sandbox.includes('allow-scripts'), true, `${name}: sandbox scripts are required`);
    assert.equal(initial.sandbox.includes('allow-same-origin'), false, `${name}: sandbox must stay opaque`);
    assert.equal(initial.legacy, false, `${name}: legacy light DOM must not start automatically`);

    const child = await waitForReadyChild(page, diagnostic);
    const parent = await page.evaluate(() => ({
      legacy: !!document.getElementById('hex-userscript-host'),
      host: !!document.getElementById('hex-userscript-iframe-host'),
      status: document.getElementById('hex-userscript-iframe-status')?.textContent || '',
      loader: globalThis.__HEX_SECURE_LOADER__ || null,
    }));
    const childState = await child.evaluate(() => {
      globalThis.__HEX_E2E_PERSIST__ = 'kept';
      const css = document.getElementById('hex-userscript-style')?.textContent || '';
      return {
        origin: location.origin,
        href: location.href,
        apiBase: globalThis.__HEX_API_BASE__ || null,
        app: !!globalThis.__app,
        bridge: !!globalThis.__HEX_CHATGPT_BRIDGE__,
        appNode: !!document.getElementById('app'),
        open: !!document.getElementById('btn-open'),
        cssBytes: css.length,
        bodyBackground: getComputedStyle(document.body).backgroundColor,
      };
    });

    assert.equal(parent.legacy, false, `${name}: successful startup must not create legacy light DOM`);
    assert.equal(parent.host, true, `${name}: persistent sandbox host must remain mounted`);
    assert.equal(childState.origin, 'null', `${name}: child must have opaque origin`);
    assert.equal(childState.href.startsWith('about:srcdoc'), true, `${name}: child must remain srcdoc`);
    assert.equal(childState.apiBase, WORKER_ORIGIN, `${name}: virtual API origin must be the verified Worker origin`);
    assert.equal(childState.app, true, `${name}: app must initialize`);
    assert.equal(childState.bridge, true, `${name}: parent RPC proxy must initialize`);
    assert.equal(childState.appNode, true, `${name}: canonical app shell must exist`);
    assert.equal(childState.open, true, `${name}: canonical open control must exist`);
    assert.ok(childState.cssBytes > 10_000, `${name}: full canonical CSS missing (${childState.cssBytes} bytes)`);
    assert.notEqual(childState.bodyBackground, '', `${name}: CSS must compute`);
    assert.equal(externalEmbedRequests, 0, `${name}: direct /embed/chatgpt navigation is forbidden`);
    assert.equal(bootstrapRequests, 1, `${name}: secure bootstrap must occur exactly once`);
    assert.equal(runtimeRequests, 1, `${name}: encrypted runtime fetch must occur exactly once`);

    await page.click('#hex-userscript-emergency-close');
    await page.waitForFunction(() => document.getElementById('hex-userscript-iframe-host')?.getAttribute('aria-hidden') === 'true');
    await page.click('#hex-userscript-launcher');
    await page.waitForFunction(() => document.getElementById('hex-userscript-iframe-host')?.getAttribute('aria-hidden') !== 'true');
    const sameIframe = await page.evaluate(() => document.getElementById('hex-userscript-iframe') === globalThis.__HEX_E2E_IFRAME__);
    assert.equal(sameIframe, true, `${name}: hide/show must preserve the iframe`);
    assert.equal(await child.evaluate(() => globalThis.__HEX_E2E_PERSIST__), 'kept', `${name}: hide/show must preserve app state`);

    console.log(`ok  ${name}: secure loader -> opaque srcdoc -> runtime -> RPC -> workers -> app/CSS`);
  } catch (error) {
    const state = await safeEval(page, () => ({
      legacy: !!document.getElementById('hex-userscript-host'),
      iframe: !!document.getElementById('hex-userscript-iframe'),
      status: document.getElementById('hex-userscript-iframe-status')?.textContent || null,
      loaderText: document.getElementById('hex-secure-loader')?.textContent || null,
      loader: globalThis.__HEX_SECURE_LOADER__ || null,
      frames: [...document.querySelectorAll('iframe')].map((node) => ({ id: node.id, src: node.getAttribute('src'), sandbox: node.getAttribute('sandbox'), srcdoc: !!node.srcdoc })),
    }));
    throw new Error(`${name} secure sandbox E2E failed: ${error?.message || error}\nbootstrap=${bootstrapRequests} runtime=${runtimeRequests} externalEmbed=${externalEmbedRequests}\nparent=${JSON.stringify(state)}\n${diagnostic.slice(-50).join('\n')}`);
  } finally {
    await context.close();
    await browser.close();
  }
}

async function waitForReadyChild(page, diagnostic) {
  const deadline = Date.now() + TIMEOUT_MS;
  while (Date.now() < deadline) {
    const failure = await safeEval(page, () => ({
      status: document.getElementById('hex-userscript-iframe-status')?.textContent || '',
      loader: document.getElementById('hex-secure-loader')?.textContent || '',
      legacy: !!document.getElementById('hex-userscript-host'),
    }));
    if (failure?.legacy) throw new Error('unexpected legacy fallback');
    if (failure?.status?.startsWith('Hex failed')) throw new Error(failure.status);
    if (failure?.loader?.includes(' failed ')) throw new Error(failure.loader);

    const handle = await page.$('#hex-userscript-iframe');
    const frame = handle ? await handle.contentFrame() : null;
    if (frame) {
      const ready = await safeFrameEval(frame, () => !!globalThis.__app
        && !!globalThis.__HEX_CHATGPT_BRIDGE__
        && !!document.getElementById('app')
        && !!document.getElementById('hex-userscript-style'));
      if (ready) return frame;
    }
    await page.waitForTimeout(50);
  }
  diagnostic.push(`frame-urls: ${page.frames().map((frame) => frame.url()).join(' | ')}`);
  throw new Error('sandbox child did not reach canonical app readiness');
}

async function routeRequest(route) {
  const request = route.request();
  const url = new URL(request.url());
  if (['blob:', 'data:', 'about:'].includes(url.protocol)) return route.continue();
  if (request.url() === PARENT_URL) {
    return route.fulfill({
      status: 200,
      contentType: 'text/html; charset=utf-8',
      headers: { 'cache-control': 'no-store', 'content-security-policy': CSP },
      body: `<!doctype html><html><head><meta charset="utf-8"><script nonce="${NONCE}">globalThis.__FAKE_CHATGPT__=true<\/script></head><body><main><div id="prompt-textarea" role="textbox" contenteditable="true"></div><button data-testid="send-button" type="button">Send</button></main></body></html>`,
    });
  }
  if (url.origin !== WORKER_ORIGIN) return route.abort('blockedbyclient');
  if (url.pathname === '/embed/chatgpt') return route.fulfill({ status: 451, body: 'direct iframe path forbidden in sandbox-v2' });

  const origin = request.headers().origin || CHATGPT_ORIGIN;
  if (request.method() === 'OPTIONS') {
    const asset = url.pathname.startsWith('/_runtime/');
    return route.fulfill({ status: 204, headers: {
      'access-control-allow-origin': origin,
      'access-control-allow-methods': asset ? 'GET, OPTIONS' : 'POST, OPTIONS',
      'access-control-allow-headers': asset ? 'Authorization' : 'Content-Type',
      vary: 'Origin',
    }, body: '' });
  }
  if (url.pathname === '/runtime/bootstrap' && request.method() === 'POST') {
    return route.fulfill({ status: 200, contentType: 'application/json', headers: cors(origin), body: JSON.stringify(await bootstrap(JSON.parse(request.postData() || '{}'))) });
  }
  if (url.pathname === `/_runtime/${RUNTIME_BUILD.manifest.buildId}` && request.method() === 'GET') {
    return route.fulfill({ status: 200, contentType: 'application/octet-stream', headers: cors(origin), body: runtimeBytes });
  }
  return route.fulfill({ status: 404, body: 'not found' });
}

async function bootstrap(input) {
  assert.equal(input.buildId, RUNTIME_BUILD.manifest.buildId);
  const subtle = webcrypto.subtle;
  const client = await subtle.importKey('jwk', input.clientPublicKey, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const server = await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const shared = await subtle.deriveBits({ name: 'ECDH', public: client }, server.privateKey, 256);
  const salt = randomBytes(32), iv = randomBytes(12);
  const material = await subtle.importKey('raw', shared, 'HKDF', false, ['deriveKey']);
  const wrap = await subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt, info: new TextEncoder().encode(`hex-runtime-wrap:${RUNTIME_BUILD.manifest.buildId}`) }, material, { name: 'AES-GCM', length: 256 }, false, ['encrypt']);
  const sessionId = `e2e-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const encrypted = await subtle.encrypt({ name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(`${RUNTIME_BUILD.manifest.buildId}:${sessionId}`), tagLength: 128 }, wrap, Buffer.from(RUNTIME_BUILD.contentKey, 'base64url'));
  new Uint8Array(shared).fill(0);
  const { assetPath: _assetPath, ...manifest } = RUNTIME_BUILD.manifest;
  return {
    session: `e2e-${sessionId}`,
    sessionId,
    expiry: new Date(Date.now() + 120_000).toISOString(),
    buildId: RUNTIME_BUILD.manifest.buildId,
    manifest,
    runtimeLocator: `/_runtime/${RUNTIME_BUILD.manifest.buildId}`,
    serverPublicKey: await subtle.exportKey('jwk', server.publicKey),
    keyEnvelope: { algorithm: 'ECDH-P256+HKDF-SHA256+A256GCM', salt: b64(salt), iv: b64(iv), ciphertext: b64(new Uint8Array(encrypted)) },
  };
}

function cors(origin) { return { 'access-control-allow-origin': origin, 'cache-control': 'no-store', vary: 'Origin' }; }
function b64(value) { return Buffer.from(value).toString('base64url'); }
async function safeEval(page, fn) { try { return await page.evaluate(fn); } catch { return null; } }
async function safeFrameEval(frame, fn) { try { return await frame.evaluate(fn); } catch { return false; } }
