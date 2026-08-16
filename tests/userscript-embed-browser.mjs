import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { webcrypto, randomBytes } from 'node:crypto';
import { chromium, webkit } from 'playwright';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CHATGPT_ORIGIN = 'https://chatgpt.com';
const WORKER_ORIGIN = 'https://ida.rhgrive.workers.dev';
const PARENT_URL = `${CHATGPT_ORIGIN}/__hex_embed_e2e__`;
const TIMEOUT_MS = 60_000;
const TEST_NONCE = 'hex-e2e-nonce';
const CHATGPT_LIKE_CSP = [
  "default-src 'self'",
  `script-src 'nonce-${TEST_NONCE}' 'self' 'wasm-unsafe-eval'`,
  `script-src-elem 'nonce-${TEST_NONCE}' 'self' blob:`,
  "style-src 'self' 'unsafe-inline' blob:",
  `connect-src 'self' ${WORKER_ORIGIN}`,
  "frame-src 'self' https://*.embed.chatgpt.site https://*.web-sandbox.oaiusercontent.com",
  "worker-src 'self' blob:",
  "img-src 'self' data: blob:",
].join('; ');

assert.equal(CHATGPT_LIKE_CSP.includes(`frame-src 'self' ${WORKER_ORIGIN}`), false,
  'the browser gate must not accidentally permit the old Worker iframe origin');

const buildModule = await import('../.runtime-build/runtime-secrets.js');
const { RUNTIME_BUILD } = buildModule;
const template = (await readFile(path.join(ROOT, 'userscript/hex.user.template.js'), 'utf8'))
  .replaceAll('__HEX_ORIGIN__', WORKER_ORIGIN);
const runtimeBytes = await readFile(path.join(ROOT, 'dist', RUNTIME_BUILD.manifest.assetPath.slice(1)));

for (const [name, browserType] of [['chromium', chromium], ['webkit', webkit]]) {
  await runBrowser(name, browserType);
}

console.log('userscript secure sandbox browser e2e: ok');

async function runBrowser(name, browserType) {
  const browser = await browserType.launch({ headless: true, args: name === 'chromium' ? ['--no-sandbox'] : [] });
  const context = await browser.newContext({
    viewport: { width: 1024, height: 768 },
    locale: 'ja-JP',
    ignoreHTTPSErrors: true,
  });
  await context.addInitScript({ content: `addEventListener('DOMContentLoaded',()=>{${template}\n},{once:true});` });
  const page = await context.newPage();
  const diagnostics = [];
  let externalEmbedRequests = 0;
  let bootstrapRequests = 0;
  let runtimeRequests = 0;

  page.on('console', (message) => diagnostics.push(`console:${message.type()}: ${message.text()}`));
  page.on('pageerror', (error) => diagnostics.push(`pageerror: ${error.message}`));
  page.on('requestfailed', (request) => diagnostics.push(`requestfailed: ${request.method()} ${request.url()} ${request.failure()?.errorText || ''}`));

  await context.route('**/*', async (route) => {
    try {
      const request = route.request();
      const url = new URL(request.url());
      if (url.origin === WORKER_ORIGIN && url.pathname === '/embed/chatgpt') externalEmbedRequests += 1;
      if (url.origin === WORKER_ORIGIN && url.pathname === '/runtime/bootstrap') bootstrapRequests += 1;
      if (url.origin === WORKER_ORIGIN && url.pathname.startsWith('/_runtime/')) runtimeRequests += 1;
      await routeRequest(route);
    } catch (error) {
      diagnostics.push(`route-error: ${route.request().method()} ${route.request().url()} ${error?.stack || error}`);
      await route.abort('failed');
    }
  });

  try {
    await page.goto(PARENT_URL, { waitUntil: 'domcontentloaded', timeout: TIMEOUT_MS });
    const iframeLocator = page.locator('#hex-userscript-iframe-host iframe').first();
    await iframeLocator.waitFor({ state: 'attached', timeout: TIMEOUT_MS });

    const parentBefore = await page.evaluate(() => {
      const iframe = document.querySelector('#hex-userscript-iframe-host iframe');
      globalThis.__HEX_E2E_FRAME_REF__ = iframe;
      return {
        sandbox: iframe?.getAttribute('sandbox') || '',
        src: iframe?.getAttribute('src'),
        hasSrcdoc: !!iframe?.srcdoc,
        legacy: !!document.getElementById('hex-userscript-host'),
      };
    });
    assert.equal(parentBefore.src, null, `${name}: production embed must not navigate to the Worker origin`);
    assert.equal(parentBefore.hasSrcdoc, true, `${name}: production embed must use srcdoc`);
    assert.equal(parentBefore.sandbox.includes('allow-scripts'), true, `${name}: sandbox needs script execution`);
    assert.equal(parentBefore.sandbox.includes('allow-same-origin'), false, `${name}: sandbox must remain opaque`);
    assert.equal(parentBefore.legacy, false, `${name}: legacy light DOM must not appear during sandbox startup`);

    const childFrame = await waitForIframeContentFrame(iframeLocator);
    assert.ok(childFrame, `${name}: opaque srcdoc child was not created`);

    await childFrame.waitForFunction(() => {
      return !!globalThis.__app
        && !!globalThis.__HEX_CHATGPT_BRIDGE__
        && !!document.querySelector('#app')
        && !!document.getElementById('hex-userscript-style');
    }, null, { timeout: TIMEOUT_MS });

    await page.waitForFunction(() => {
      const status = document.getElementById('hex-userscript-iframe-status');
      const iframe = document.querySelector('#hex-userscript-iframe-host iframe');
      return iframe && iframe.style.visibility === 'visible' && (!status || status.hidden);
    }, null, { timeout: TIMEOUT_MS });

    const parentReady = await page.evaluate(() => ({
      legacy: !!document.getElementById('hex-userscript-host'),
      iframeHost: !!document.getElementById('hex-userscript-iframe-host'),
      loader: globalThis.__HEX_SECURE_LOADER__ || null,
      status: document.getElementById('hex-userscript-iframe-status')?.textContent || '',
    }));
    const childReady = await childFrame.evaluate(() => {
      globalThis.__HEX_E2E_PERSIST__ = 'kept';
      const style = document.getElementById('hex-userscript-style');
      return {
        actualOrigin: location.origin,
        actualHref: location.href,
        routeHash: location.hash,
        apiBase: globalThis.__HEX_API_BASE__ || null,
        app: !!globalThis.__app,
        bridge: !!globalThis.__HEX_CHATGPT_BRIDGE__,
        appNode: !!document.querySelector('#app'),
        openButton: !!document.getElementById('btn-open'),
        cssBytes: style?.textContent?.length || 0,
        bodyBackground: getComputedStyle(document.body).backgroundColor,
      };
    });

    assert.equal(parentReady.legacy, false, `${name}: successful sandbox startup must not create legacy light DOM`);
    assert.equal(parentReady.iframeHost, true, `${name}: persistent sandbox host must remain mounted`);
    assert.equal(childReady.actualOrigin, 'null', `${name}: sandbox child must have an opaque origin`);
    assert.equal(childReady.actualHref.startsWith('about:srcdoc'), true, `${name}: child must stay inside srcdoc instead of Worker navigation`);
    assert.equal(childReady.routeHash, '#/code', `${name}: canonical router must keep its route inside the srcdoc document`);
    assert.equal(childReady.apiBase, WORKER_ORIGIN, `${name}: child must use the verified virtual Worker API origin`);
    assert.equal(childReady.app, true, `${name}: Hex app must finish startup`);
    assert.equal(childReady.bridge, true, `${name}: ChatGPT RPC bridge must exist in the child`);
    assert.equal(childReady.appNode, true, `${name}: canonical app shell must exist`);
    assert.equal(childReady.openButton, true, `${name}: canonical controls must exist`);
    assert.ok(childReady.cssBytes > 10_000, `${name}: full canonical CSS must be installed, got ${childReady.cssBytes} bytes`);
    assert.notEqual(childReady.bodyBackground, '', `${name}: canonical CSS must compute in the child`);
    assert.equal(externalEmbedRequests, 0, `${name}: ChatGPT CSP-blocked /embed/chatgpt navigation must never be requested`);
    assert.equal(bootstrapRequests, 1, `${name}: secure runtime bootstrap must run exactly once`);
    assert.equal(runtimeRequests, 1, `${name}: encrypted protected runtime must be fetched exactly once`);

    await page.click('#hex-userscript-emergency-close');
    await page.waitForFunction(() => {
      const wrapper = document.getElementById('hex-userscript-iframe-host');
      const launcher = document.getElementById('hex-userscript-launcher');
      return wrapper?.getAttribute('aria-hidden') === 'true' && launcher && !launcher.hidden;
    }, null, { timeout: 5000 });
    await page.click('#hex-userscript-launcher');
    await page.waitForFunction(() => document.getElementById('hex-userscript-iframe-host')?.getAttribute('aria-hidden') !== 'true', null, { timeout: 5000 });

    const persisted = await page.evaluate(() => document.querySelector('#hex-userscript-iframe-host iframe') === globalThis.__HEX_E2E_FRAME_REF__);
    const childPersisted = await childFrame.evaluate(() => globalThis.__HEX_E2E_PERSIST__);
    assert.equal(persisted, true, `${name}: hide/show must reuse the same iframe`);
    assert.equal(childPersisted, 'kept', `${name}: hide/show must preserve child app state`);

    console.log(`ok  ${name}: secure loader -> opaque srcdoc -> protected runtime -> RPC -> workers -> app/CSS`);
  } catch (error) {
    const parentState = await safeEvaluate(page, () => ({
      legacy: !!document.getElementById('hex-userscript-host'),
      iframeHost: !!document.getElementById('hex-userscript-iframe-host'),
      launcher: document.getElementById('hex-userscript-launcher')?.textContent || null,
      status: document.getElementById('hex-userscript-iframe-status')?.textContent || null,
      secureLoader: globalThis.__HEX_SECURE_LOADER__ || null,
    }));
    throw new Error(`${name} secure sandbox E2E failed: ${error?.message || error}\nexternalEmbedRequests=${externalEmbedRequests}\nbootstrapRequests=${bootstrapRequests}\nruntimeRequests=${runtimeRequests}\n${formatDiagnostics(diagnostics, parentState)}`);
  } finally {
    await context.close();
    await browser.close();
  }
}

async function routeRequest(route) {
  const request = route.request();
  const url = new URL(request.url());
  const method = request.method();

  if (url.protocol === 'blob:' || url.protocol === 'data:' || url.protocol === 'about:') {
    await route.continue();
    return;
  }

  if (request.url() === PARENT_URL) {
    await route.fulfill({
      status: 200,
      contentType: 'text/html; charset=utf-8',
      headers: { 'cache-control': 'no-store', 'content-security-policy': CHATGPT_LIKE_CSP },
      body: `<!doctype html><html><head><meta charset="utf-8"><title>Fake ChatGPT</title><script nonce="${TEST_NONCE}">globalThis.__FAKE_CHATGPT__=true<\/script></head><body><main><div id="prompt-textarea" role="textbox" contenteditable="true"></div><button data-testid="send-button" type="button">Send</button></main></body></html>`,
    });
    return;
  }

  if (url.origin === WORKER_ORIGIN) {
    const corsOrigin = request.headers().origin || CHATGPT_ORIGIN;
    if (url.pathname === '/embed/chatgpt') {
      await route.fulfill({ status: 451, body: 'old external embed path must not be used' });
      return;
    }
    if (method === 'OPTIONS') {
      const runtimeAsset = url.pathname.startsWith('/_runtime/');
      await route.fulfill({
        status: 204,
        headers: {
          'access-control-allow-origin': corsOrigin,
          'access-control-allow-methods': runtimeAsset ? 'GET, OPTIONS' : 'POST, OPTIONS',
          'access-control-allow-headers': runtimeAsset ? 'Authorization' : 'Content-Type',
          'access-control-max-age': '600',
          vary: 'Origin',
        },
        body: '',
      });
      return;
    }

    if (url.pathname === '/runtime/bootstrap' && method === 'POST') {
      const input = JSON.parse(request.postData() || '{}');
      const payload = await createBootstrap(input);
      await route.fulfill({
        status: 200,
        contentType: 'application/json; charset=utf-8',
        headers: corsHeaders(corsOrigin),
        body: JSON.stringify(payload),
      });
      return;
    }

    if (url.pathname === `/_runtime/${RUNTIME_BUILD.manifest.buildId}` && method === 'GET') {
      await route.fulfill({
        status: 200,
        contentType: 'application/octet-stream',
        headers: { ...corsHeaders(corsOrigin), 'cache-control': 'no-store' },
        body: runtimeBytes,
      });
      return;
    }

    await route.fulfill({ status: 404, body: 'not found' });
    return;
  }

  await route.abort('blockedbyclient');
}

async function createBootstrap(input) {
  assert.equal(input.buildId, RUNTIME_BUILD.manifest.buildId, 'loader must request the built runtime id');
  const subtle = webcrypto.subtle;
  const clientKey = await subtle.importKey('jwk', input.clientPublicKey, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const serverKeys = await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const shared = await subtle.deriveBits({ name: 'ECDH', public: clientKey }, serverKeys.privateKey, 256);
  const salt = randomBytes(32);
  const iv = randomBytes(12);
  const material = await subtle.importKey('raw', shared, 'HKDF', false, ['deriveKey']);
  const wrappingKey = await subtle.deriveKey({
    name: 'HKDF', hash: 'SHA-256', salt,
    info: new TextEncoder().encode(`hex-runtime-wrap:${RUNTIME_BUILD.manifest.buildId}`),
  }, material, { name: 'AES-GCM', length: 256 }, false, ['encrypt']);
  const sessionId = `e2e-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const ciphertext = await subtle.encrypt({
    name: 'AES-GCM', iv,
    additionalData: new TextEncoder().encode(`${RUNTIME_BUILD.manifest.buildId}:${sessionId}`),
    tagLength: 128,
  }, wrappingKey, fromB64(RUNTIME_BUILD.contentKey));
  new Uint8Array(shared).fill(0);
  const { assetPath: _assetPath, ...manifest } = RUNTIME_BUILD.manifest;
  return {
    session: `e2e-session-${sessionId}`,
    sessionId,
    expiry: new Date(Date.now() + 120_000).toISOString(),
    buildId: RUNTIME_BUILD.manifest.buildId,
    manifest,
    runtimeLocator: `/_runtime/${RUNTIME_BUILD.manifest.buildId}`,
    serverPublicKey: await subtle.exportKey('jwk', serverKeys.publicKey),
    keyEnvelope: {
      algorithm: 'ECDH-P256+HKDF-SHA256+A256GCM',
      salt: b64(salt),
      iv: b64(iv),
      ciphertext: b64(new Uint8Array(ciphertext)),
    },
  };
}

async function waitForIframeContentFrame(iframeLocator) {
  const deadline = Date.now() + TIMEOUT_MS;
  while (Date.now() < deadline) {
    const frame = await iframeLocator.contentFrame();
    if (frame) return frame;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return null;
}

function corsHeaders(origin) {
  return {
    'access-control-allow-origin': origin,
    'cache-control': 'no-store',
    vary: 'Origin',
  };
}
function b64(value) { return Buffer.from(value).toString('base64url'); }
function fromB64(value) { return Buffer.from(value, 'base64url'); }
async function safeEvaluate(page, fn) { try { return await page.evaluate(fn); } catch { return null; } }
function formatDiagnostics(lines, parentState) {
  return `parent=${JSON.stringify(parentState)}\n${lines.slice(-50).join('\n')}`;
}
