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
    const seen = {
      bootstrap: false,
      module: false,
      origin: null,
      nativeStorageBlocked: false,
      storageShim: false,
    };
    const timer = setTimeout(() => finish(), 7000);
    let iframe;
    const onMessage = (event) => {
      if (event.data?.marker !== marker) return;
      seen.origin = event.data.origin;
      if (event.data.stage === 'bootstrap') {
        seen.bootstrap = true;
        seen.nativeStorageBlocked = event.data.nativeStorageBlocked === true;
        seen.storageShim = event.data.storageShim === true;
      }
      if (event.data.stage === 'module') seen.module = true;
      if (seen.bootstrap && seen.module) finish();
    };
    function finish() {
      clearTimeout(timer);
      removeEventListener('message', onMessage);
      iframe?.remove();
      resolve(seen);
    }
    addEventListener('message', onMessage);
    iframe = document.createElement('iframe');
    iframe.sandbox = 'allow-scripts';
    iframe.srcdoc = `<!doctype html><meta charset="utf-8"><script nonce="${nonce}">
      let nativeStorageBlocked=false;
      try { void localStorage.length; } catch { nativeStorageBlocked=true; }
      const makeStorage=()=>{const m=new Map;return {get length(){return m.size},key(i){return [...m.keys()][i]??null},getItem(k){k=String(k);return m.has(k)?m.get(k):null},setItem(k,v){m.set(String(k),String(v))},removeItem(k){m.delete(String(k))},clear(){m.clear()}}};
      let storageShim=false;
      try {
        const s=makeStorage();
        Object.defineProperty(window,'localStorage',{value:s,configurable:true});
        localStorage.setItem('hex','ok');
        storageShim=localStorage.getItem('hex')==='ok'&&localStorage.length===1&&localStorage.key(0)==='hex';
        localStorage.removeItem('hex');
        storageShim=storageShim&&localStorage.getItem('hex')===null&&localStorage.length===0;
      } catch {}
      parent.postMessage({marker:${JSON.stringify(marker)},stage:'bootstrap',origin:location.origin,nativeStorageBlocked,storageShim},'*');
      const s=document.createElement('script');
      s.type='module';
      s.nonce=${JSON.stringify(nonce)};
      s.textContent=${JSON.stringify(`parent.postMessage({marker:${JSON.stringify(marker)},stage:'module',origin:location.origin},'*')`)};
      document.head.append(s);
    <\/script>`;
    document.documentElement.append(iframe);
  }), { nonce: NONCE });
  console.log(`srcdoc-probe ${name}: ${JSON.stringify(result)}`);
  assert.deepEqual(result, {
    bootstrap: true,
    module: true,
    origin: 'null',
    nativeStorageBlocked: true,
    storageShim: true,
  }, `${name} must support nonce-authorized opaque srcdoc, dynamic modules, and an in-memory storage shim under ChatGPT-like frame-src`);
  await context.close();
  await browser.close();
}

console.log('userscript srcdoc probe: ok');
