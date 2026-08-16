import assert from 'node:assert/strict';
import { chromium, webkit } from 'playwright';

const NONCE = 'hex-e2e-nonce';
const PARENT_URL = 'https://chatgpt.com/__hex_srcdoc_probe__';
const CSP = [
  "default-src 'self'",
  `script-src 'nonce-${NONCE}' 'self' 'wasm-unsafe-eval'`,
  `script-src-elem 'nonce-${NONCE}' 'self' blob:`,
  "style-src 'self' 'unsafe-inline' blob:",
  "frame-src 'self' https://*.embed.chatgpt.site https://*.web-sandbox.oaiusercontent.com",
  "worker-src 'self' blob:",
].join('; ');

for (const [name, browserType] of [['chromium', chromium], ['webkit', webkit]]) {
  const browser = await browserType.launch({ headless: true, args: name === 'chromium' ? ['--no-sandbox'] : [] });
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();
  await context.route(PARENT_URL, (route) => route.fulfill({
    status: 200,
    contentType: 'text/html; charset=utf-8',
    headers: { 'content-security-policy': CSP, 'cache-control': 'no-store' },
    body: `<!doctype html><meta charset="utf-8"><script nonce="${NONCE}"><\/script>`,
  }));
  await page.goto(PARENT_URL, { waitUntil: 'domcontentloaded' });
  const result = await page.evaluate(({ nonce }) => new Promise((resolve) => {
    const marker = `probe-${Math.random().toString(16).slice(2)}`;
    const timer = setTimeout(() => finish({ ready: false, origin: null }), 5000);
    let iframe;
    const onMessage = (event) => {
      if (event.data?.marker !== marker) return;
      finish({ ready: true, origin: event.data.origin });
    };
    function finish(value) {
      clearTimeout(timer);
      removeEventListener('message', onMessage);
      iframe?.remove();
      resolve(value);
    }
    addEventListener('message', onMessage);
    iframe = document.createElement('iframe');
    iframe.sandbox = 'allow-scripts';
    iframe.srcdoc = `<!doctype html><meta charset="utf-8"><script nonce="${nonce}">parent.postMessage({marker:${JSON.stringify(marker)},origin:location.origin},'*')<\/script>`;
    document.documentElement.append(iframe);
  }), { nonce: NONCE });
  console.log(`srcdoc-probe ${name}: ${JSON.stringify(result)}`);
  assert.deepEqual(result, { ready: true, origin: 'null' }, `${name} must support nonce-authorized opaque srcdoc under ChatGPT-like frame-src`);
  await context.close();
  await browser.close();
}

console.log('userscript srcdoc probe: ok');
