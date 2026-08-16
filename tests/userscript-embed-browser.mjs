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
const TIMEOUT_MS = 45_000;
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
const buildModule = await import('../.runtime-build/runtime-secrets.js');
const { RUNTIME_BUILD } = buildModule;
const template = (await readFile(path.join(ROOT, 'userscript/hex.user.template.js'), 'utf8'))
  .replaceAll('__HEX_ORIGIN__', WORKER_ORIGIN);
const indexHtml = await readFile(path.join(ROOT, 'dist/index.html'), 'utf8');
const runtimeBytes = await readFile(path.join(ROOT, 'dist', RUNTIME_BUILD.manifest.assetPath.slice(1)));

for (const [name, browserType] of [['chromium', chromium], ['webkit', webkit]]) {
  await runBrowser(name, browserType);
}

console.log('userscript embed browser e2e: ok');

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
  page.on('console', (message) => diagnostics.push(`console:${message.type()}: ${message.text()}`));
  page.on('pageerror', (error) => diagnostics.push(`pageerror: ${error.message}`));
  page.on('requestfailed', (request) => diagnostics.push(`requestfailed: ${request.method()} ${request.url()} ${request.failure()?.errorText || ''}`));

  await context.route('**/*', async (route) => {
    try {
      await routeRequest(route);
    } catch (error) {
      diagnostics.push(`route-error: ${route.request().method()} ${route.request().url()} ${error?.stack || error}`);
      await route.abort('failed');
    }
  });

  try {
    await page.goto(PARENT_URL, { waitUntil: 'domcontentloaded', timeout: TIMEOUT_MS });
    const probe = await probeSandboxBootPaths(page);
    diagnostics.push(`sandbox-probe: ${JSON.stringify(probe)}`);
    assert.equal(probe.srcdocNonce.ready || probe.srcdocBlobScript.ready, true,
      `${name}: ChatGPT-like CSP must expose at least one executable opaque srcdoc bootstrap path`);
    assert.equal(probe.srcdocNonce.ready ? probe.srcdocNonce.origin : probe.srcdocBlobScript.origin, 'null',
      `${name}: CSP-compatible sandbox bootstrap must stay opaque`);

    await page.waitForSelector('#hex-userscript-iframe-host iframe', { state: 'attached', timeout: TIMEOUT_MS });
    const iframeElement = await page.$('#hex-userscript-iframe-host iframe');
    assert.ok(iframeElement, `${name}: iframe host was not created`);

    const childFrame = await waitForHexFrame(page);
    assert.ok(childFrame, `${name}: Hex iframe never became available`);

    const outcome = await Promise.race([
      childFrame.waitForFunction(() => !!globalThis.__app && !!document.querySelector('#app') && !!document.getElementById('hex-userscript-style'), null, { timeout: TIMEOUT_MS }).then(() => 'ready'),
      page.waitForSelector('#hex-userscript-host', { state: 'attached', timeout: TIMEOUT_MS }).then(() => 'fallback'),
    ]);

    const parentState = await page.evaluate(() => ({
      legacy: !!document.getElementById('hex-userscript-host'),
      iframeHost: !!document.getElementById('hex-userscript-iframe-host'),
      launcher: document.getElementById('hex-userscript-launcher')?.textContent || null,
      secureLoader: globalThis.__HEX_SECURE_LOADER__ || null,
    }));
    const childState = await childFrame.evaluate(() => ({
      href: location.href,
      origin: location.origin,
      app: !!globalThis.__app,
      apiBase: globalThis.__HEX_API_BASE__ || null,
      bridge: !!globalThis.__HEX_CHATGPT_BRIDGE__,
      style: !!document.getElementById('hex-userscript-style'),
      appNode: !!document.querySelector('#app'),
      secureLoader: globalThis.__HEX_SECURE_LOADER__ || null,
    }));

    assert.equal(outcome, 'ready', `${name}: canonical iframe fell back before the child app became ready\n${formatDiagnostics(diagnostics, parentState, childState)}`);
    assert.equal(parentState.legacy, false, `${name}: legacy light-DOM fallback must not be created`);
    assert.equal(parentState.iframeHost, true, `${name}: persistent iframe host must remain mounted`);
    assert.equal(childState.apiBase, WORKER_ORIGIN, `${name}: child API base must stay on Worker origin`);
    assert.equal(childState.bridge, true, `${name}: child ChatGPT RPC bridge must be installed`);
    assert.equal(childState.style, true, `${name}: canonical child CSS must be installed`);
    assert.equal(childState.appNode, true, `${name}: canonical app shell must remain present`);

    const bodyBg = await childFrame.evaluate(() => getComputedStyle(document.body).backgroundColor);
    assert.notEqual(bodyBg, '', `${name}: canonical CSS must be computed in the iframe`);
    console.log(`ok  ${name}: secure loader -> sandbox iframe -> RPC attach -> app ready`);
  } catch (error) {
    const parentState = await safeEvaluate(page, () => ({
      legacy: !!document.getElementById('hex-userscript-host'),
      iframeHost: !!document.getElementById('hex-userscript-iframe-host'),
      launcher: document.getElementById('hex-userscript-launcher')?.textContent || null,
      secureLoader: globalThis.__HEX_SECURE_LOADER__ || null,
    }));
    throw new Error(`${name} userscript embed E2E failed: ${error?.message || error}\n${formatDiagnostics(diagnostics, parentState, null)}`);
  } finally {
    await context.close();
    await browser.close();
  }
}

async function probeSandboxBootPaths(page) {
  return page.evaluate(async ({ nonce }) => {
    async function probe(kind) {
      return new Promise((resolve) => {
        const marker = `${kind}-${Math.random().toString(16).slice(2)}`;
        const timer = setTimeout(() => finish({ ready: false, origin: null }), 3000);
        let iframe = null;
        let blobUrl = null;
        const onMessage = (event) => {
          if (event.data?.marker !== marker) return;
          finish({ ready: true, origin: event.data.origin });
        };
        function finish(result) {
          clearTimeout(timer);
          removeEventListener('message', onMessage);
          try { iframe?.remove(); } catch {}
          try { if (blobUrl) URL.revokeObjectURL(blobUrl); } catch {}
          resolve(result);
        }
        addEventListener('message', onMessage);
        iframe = document.createElement('iframe');
        iframe.sandbox = 'allow-scripts';
        iframe.hidden = true;
        if (kind === 'srcdocNonce') {
          iframe.srcdoc = `<!doctype html><meta charset="utf-8"><script nonce="${nonce}">parent.postMessage({marker:${JSON.stringify(marker)},origin:location.origin},'*')<\/script>`;
        } else {
          blobUrl = URL.createObjectURL(new Blob([
            `parent.postMessage({marker:${JSON.stringify(marker)},origin:location.origin},'*')`,
          ], { type: 'text/javascript' }));
          iframe.srcdoc = `<!doctype html><meta charset="utf-8"><script src="${blobUrl}"><\/script>`;
        }
        document.documentElement.append(iframe);
      });
    }
    return {
      srcdocNonce: await probe('srcdocNonce'),
      srcdocBlobScript: await probe('srcdocBlobScript'),
    };
  }, { nonce: TEST_NONCE });
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
      body: `<!doctype html><html><head><meta charset="utf-8"><title>Fake ChatGPT</title><script nonce="${TEST_NONCE}"><\/script></head><body><main><div id="prompt-textarea" role="textbox" contenteditable="true"></div><button data-testid="send-button" type="button">Send</button></main></body></html>`,
    });
    return;
  }

  if (url.origin === WORKER_ORIGIN) {
    const corsOrigin = request.headers().origin || CHATGPT_ORIGIN;
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

    if (url.pathname === '/embed/chatgpt' && method === 'GET') {
      await route.fulfill({
        status: 200,
        contentType: 'text/html; charset=utf-8',
        headers: {
          'content-security-policy': 'frame-ancestors https://chatgpt.com https://chat.openai.com',
          'cache-control': 'no-store',
          'referrer-policy': 'no-referrer',
          'x-content-type-options': 'nosniff',
        },
        body: indexHtml,
      });
      return;
    }

    if (url.pathname.startsWith('/assets/') && method === 'GET') {
      const relative = url.pathname.replace(/^\/+/, '');
      const absolute = path.resolve(ROOT, 'dist', relative);
      const distRoot = path.resolve(ROOT, 'dist') + path.sep;
      if (!absolute.startsWith(distRoot)) throw new Error(`asset path escaped dist: ${url.pathname}`);
      const body = await readFile(absolute);
      const contentType = absolute.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'application/octet-stream';
      await route.fulfill({ status: 200, contentType, headers: { 'cache-control': 'no-store' }, body });
      return;
    }

    await route.fulfill({ status: 404, body: 'not found' });
    return;
  }

  if (url.hostname === 'fonts.googleapis.com') {
    await route.fulfill({ status: 200, contentType: 'text/css; charset=utf-8', body: '' });
    return;
  }
  if (url.hostname === 'fonts.gstatic.com') {
    await route.fulfill({ status: 204, body: '' });
    return;
  }

  await route.abort('blockedbyclient');
}

async function createBootstrap(input) {
  assert.equal(input.buildId, RUNTIME_BUILD.manifest.buildId, 'loader requested the built runtime id');
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

async function waitForHexFrame(page) {
  const deadline = Date.now() + TIMEOUT_MS;
  while (Date.now() < deadline) {
    const frames = page.frames().filter((frame) => frame !== page.mainFrame());
    const found = frames.find((frame) => frame.url().startsWith(`${WORKER_ORIGIN}/embed/chatgpt`))
      || frames.find((frame) => frame.url() === 'about:srcdoc' || frame.url() === 'about:blank');
    if (found) return found;
    await page.waitForTimeout(50);
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
function formatDiagnostics(lines, parentState, childState) {
  const tail = lines.slice(-30).join('\n');
  return `parent=${JSON.stringify(parentState)}\nchild=${JSON.stringify(childState)}\n${tail}`;
}
