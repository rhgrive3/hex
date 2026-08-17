import assert from 'node:assert/strict';
import { createHash, webcrypto } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import {
  buildSandboxSrcdoc,
  createSandboxIframe,
  findChatGPTCspNonce,
} from '../js/userscript/chatgpt-sandbox-host.js';

const worker = 'https://ida.rhgrive.workers.dev';
const token = 'ab'.repeat(32);
const nonce = 'chatgpt-nonce-123';
const trustedRuntimeSource = 'globalThis.__HEX_TEST_RUNTIME__=true;';
const runtimeContentHash = createHash('sha256').update(trustedRuntimeSource).digest('hex');
const config = {
  hostHtml: '<main id="app"><button id="btn-open">Open</button></main>',
  cspNonce: nonce,
  generation: 7,
  sandboxToken: token,
  apiOrigin: worker,
  virtualSrc: `${worker}/embed/chatgpt?__hex_ai_provider=chatgpt&__hex_embed_generation=7`,
  loaderVersion: '2.0.test',
  buildId: '0123456789abcdef01234567',
  runtimeContentHash,
};

const html = buildSandboxSrcdoc(config);
assert.match(html, /<main id="app">/, 'canonical Hex host HTML must be placed inside srcdoc');
assert.match(html, new RegExp(`nonce="${nonce}"`), 'sandbox bootstrap must carry the ChatGPT CSP nonce');
assert.match(html, new RegExp(token), 'sandbox bootstrap must bind the per-generation token');
assert.match(html, /hex\.embed\.sandbox-ready/, 'sandbox must announce its bootstrap stage');
assert.match(html, /hex\.embed\.runtime/, 'sandbox must accept only the authenticated runtime-transfer message');
assert.match(html, /SHA-256/, 'sandbox must verify the transferred protected runtime before execution');
assert.match(html, new RegExp(runtimeContentHash), 'sandbox must bind the exact protected runtime content hash');
assert.match(html, /__HEX_PROTECTED_AUTO_START__/, 'transferred runtime must receive an opaque-sandbox-only start marker');
assert.match(html, /\.type='module'/, 'protected runtime must execute as a module inside the sandbox');
assert.doesNotMatch(html, /<iframe[^>]+src=["']https:\/\/ida\.rhgrive\.workers\.dev/i,
  'sandbox document must not navigate a nested frame to the Worker origin');

class FakeElement {
  constructor(tagName) {
    this.tagName = String(tagName).toUpperCase();
    this.attributes = new Map();
    this.dataset = {};
    this.style = { cssText: '' };
    this.srcdoc = '';
  }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
}
const fakeDocument = { createElement: (name) => new FakeElement(name) };
const iframe = createSandboxIframe(fakeDocument, config);
assert.equal(iframe.getAttribute('sandbox'), 'allow-scripts allow-downloads');
assert.equal(iframe.getAttribute('sandbox').includes('allow-same-origin'), false,
  'the ChatGPT sandbox must remain opaque');
assert.equal(iframe.getAttribute('src'), null,
  'CSP-safe sandbox mode must never use an external iframe src');
assert.equal(iframe.srcdoc, html);
assert.equal(iframe.dataset.hexSandboxToken, token);
assert.equal(iframe.dataset.hexGeneration, '7');

const nonceScript = { nonce, getAttribute: () => '' };
assert.equal(findChatGPTCspNonce({ querySelectorAll: () => [nonceScript] }), nonce,
  'the DOM nonce property must be used because browsers can hide the nonce attribute');
assert.equal(findChatGPTCspNonce({ querySelectorAll: () => [] }), '');
assert.throws(() => buildSandboxSrcdoc({ ...config, cspNonce: '' }), /CSP nonce/);
assert.throws(() => buildSandboxSrcdoc({ ...config, sandboxToken: 'bad' }), /sandbox token/i);
assert.throws(() => buildSandboxSrcdoc({ ...config, runtimeContentHash: 'bad' }), /content hash/i);
assert.throws(() => buildSandboxSrcdoc({ ...config, virtualSrc: 'http://ida.rhgrive.workers.dev/embed/chatgpt' }), /HTTPS|virtual embed URL/i);

{
  const bootstrap = html.match(/<script nonce="[^"]+">([\s\S]*)<\/script><\/body>/)?.[1];
  assert.ok(bootstrap, 'sandbox bootstrap source must be extractable for the runtime-integrity regression');
  const listeners = new Map();
  const appended = [];
  const parent = { postMessage() {} };
  const context = {
    parent,
    URL,
    ArrayBuffer,
    Uint8Array,
    TextDecoder,
    crypto: webcrypto,
    globalThis: null,
    document: {
      createElement() {
        return { type: '', nonce: '', textContent: '', addEventListener() {}, remove() {} };
      },
      head: { append(node) { appended.push(node); } },
    },
    addEventListener(type, handler) { listeners.set(type, handler); },
  };
  context.globalThis = context;
  vm.runInNewContext(bootstrap, context);
  const onMessage = listeners.get('message');
  assert.equal(typeof onMessage, 'function');
  const envelope = (runtime) => ({
    source: parent,
    origin: 'https://chatgpt.com',
    data: {
      type: 'hex.embed.runtime', protocol: 'hex-embed-v1', version: 1,
      generation: '7', sandboxToken: token, runtime,
    },
  });

  const injected = new TextEncoder().encode('globalThis.__PAGE_INJECTED__=true;').buffer;
  await onMessage(envelope(injected));
  assert.equal(appended.length, 0,
    'page-origin code with the visible sandbox token must not execute without the protected runtime hash');

  const trusted = new TextEncoder().encode(trustedRuntimeSource).buffer;
  await onMessage(envelope(trusted));
  assert.equal(appended.length, 1, 'the exact protected runtime must still execute after a rejected injection');
  assert.equal(appended[0].textContent, trustedRuntimeSource);
}

const entrySource = await readFile(new URL('../js/userscript/entry.js', import.meta.url), 'utf8');
const protectedEntrySource = await readFile(new URL('../js/userscript/protected-entry.js', import.meta.url), 'utf8');
const loaderSource = await readFile(new URL('../js/userscript/loader.js', import.meta.url), 'utf8');
assert.match(entrySource, /createChatGPTSandboxHost/);
assert.match(loaderSource, /runtimeContentHash:\s*String\(bootstrap\.manifest\.contentHash/,
  'the trusted loader must pass the already-verified full runtime hash into the protected runtime');
assert.match(protectedEntrySource, /runtimeContentHash:\s*String\(options\.runtimeContentHash/,
  'the protected entry must carry the trusted runtime hash into the ChatGPT host');
assert.match(entrySource, /runtimeContentHash:\s*String\(options\.runtimeContentHash/,
  'the ChatGPT entry must bind the trusted runtime hash into the opaque sandbox bootstrap');
assert.doesNotMatch(entrySource, /createChatGPTIframeHost/,
  'production ChatGPT entry must not use the CSP-blocked Worker iframe host');
assert.doesNotMatch(entrySource, /falling back to legacy|startLegacy\(error\)|startLegacy\(cause/,
  'sandbox failure must stay explicit instead of silently entering legacy light DOM');
assert.match(entrySource, /readEmbedMode\(\) === LEGACY_MODE/,
  'legacy light DOM must remain available only as an explicit rollback mode');

console.log('userscript ChatGPT opaque sandbox host: ok');
