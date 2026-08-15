import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const [wranglerText, workerEntry, entry, bridge, network, workerAssets, buildScript, template, platformWorker] = await Promise.all([
  readFile(new URL('../wrangler.jsonc', import.meta.url), 'utf8'),
  readFile(new URL('../worker-entry.js', import.meta.url), 'utf8'),
  readFile(new URL('../js/userscript/entry.js', import.meta.url), 'utf8'),
  readFile(new URL('../js/userscript/chatgpt-bridge.js', import.meta.url), 'utf8'),
  readFile(new URL('../js/userscript/network.js', import.meta.url), 'utf8'),
  readFile(new URL('../js/userscript/worker-assets.js', import.meta.url), 'utf8'),
  readFile(new URL('../scripts/build-userscript.mjs', import.meta.url), 'utf8'),
  readFile(new URL('../userscript/hex.user.template.js', import.meta.url), 'utf8'),
  readFile(new URL('../userscript/platform-worker.bundle.js', import.meta.url), 'utf8'),
]);

const wrangler = JSON.parse(wranglerText.replace(/^\s*\/\/.*$/gm, ''));
assert.equal(wrangler.name, 'ida');
assert.ok(wrangler.assets.run_worker_first.includes('/api/*'));
assert.ok(wrangler.assets.run_worker_first.includes('/hex.user.js'));
assert.ok(wrangler.assets.run_worker_first.includes('/hex.meta.js'));
assert.ok(wrangler.assets.run_worker_first.includes('/userscript-assets/*'));

assert.match(workerEntry, /CHATGPT_ORIGINS/);
assert.match(workerEntry, /https:\/\/chatgpt\.com/);
assert.match(workerEntry, /USER_SCRIPT_TEMPLATE/);
assert.match(workerEntry, /USER_SCRIPT_META_PATH/);
assert.match(workerEntry, /cross-origin-resource-policy/);
assert.match(workerEntry, /access-control-allow-origin/);

assert.match(entry, /installChatGPTWebBridge/);
assert.match(entry, /installUserscriptNetworkBridge/);
assert.match(entry, /prepareUserscriptWorkers/);
assert.match(entry, /ChatGPT Web/);
assert.match(entry, /Gemini 3\.7 Flash/);
assert.match(entry, /globalThis\.__HEX_AI_PROVIDER__/);

assert.match(bridge, /#prompt-textarea/);
assert.match(bridge, /data-testid="send-button"/);
assert.match(bridge, /data-message-author-role="assistant"/);
assert.doesNotMatch(bridge, /document\.cookie|backend-api|sentinel|turnstile/i);

assert.match(network, /GM\?\.xmlHttpRequest/);
assert.match(network, /globalThis\.fetch = bridgedFetch/);
assert.match(network, /responseType: 'arraybuffer'/);
assert.match(workerAssets, /prepareUserscriptWorkers/);
assert.match(workerAssets, /URL\.createObjectURL\(new Blob/);
assert.match(workerAssets, /rewriteImportScripts/);
assert.match(workerAssets, /capstone\.wasm/);
assert.doesNotMatch(workerAssets, /import\(remote\)|importScripts\(remote\)/);

assert.match(buildScript, /@scope \(#hex-userscript-host\)/);
assert.match(buildScript, /collectClassicManifest/);
assert.match(buildScript, /platform-worker\.bundle\.js/);
assert.match(buildScript, /@inject-into  content/);
assert.match(buildScript, /@grant        GM\.xmlHttpRequest/);
assert.match(buildScript, /esbuild/);

assert.match(template, /^\/\/ ==UserScript==/);
assert.match(template, /@match\s+https:\/\/chatgpt\.com\/\*/);
assert.match(template, /@inject-into\s+content/);
assert.match(template, /@grant\s+GM\.xmlHttpRequest/);
assert.match(template, /__HEX_ORIGIN__\/hex\.meta\.js/);
assert.match(template, /__HEX_ORIGIN__\/hex\.user\.js/);
assert.match(template, /__HEX_WORKER_MANIFEST__/);
assert.match(template, /hex-userscript-host/);
assert.match(template, /userscript-assets/);
assert.match(platformWorker, /self\.onmessage/);
assert.doesNotMatch(platformWorker, /^\s*import\s/m);

/* The static index entrypoints must be removed before the DOM is embedded;
   app.js/ux.js are bundled and started by js/userscript/entry.js instead. */
assert.doesNotMatch(template, /<script[^>]+src=["']\.\/js\/app\.js/i);
assert.doesNotMatch(template, /<script[^>]+src=["']\.\/js\/ux\.js/i);

console.log('userscript-host: ok');
