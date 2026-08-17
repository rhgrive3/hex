import { toExactArrayBuffer } from './array-buffer.js';
import { decompressGzipExact } from './decompress.js';
import { captureRuntimeHostLocation } from './runtime-host-location.js';

const HEX_ORIGIN = '__HEX_ORIGIN__';
const LOADER_VERSION = '__HEX_LOADER_VERSION__';
const EXPECTED_BUILD = '__HEX_BUILD_ID__';
const RETRIES = 2;
const RUNTIME_HOST_LOCATION = captureRuntimeHostLocation();
const stopSmartAppBannerSuppression = suppressSmartAppBanner();

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', stopSmartAppBannerSuppression, { once: true });
} else {
  stopSmartAppBannerSuppression();
}

if (isTopLevelWindow()) boot().catch(showFailure);
else globalThis.__HEX_SECURE_LOADER_SKIPPED__ = 'nested-frame';

function isTopLevelWindow() {
  try { return globalThis.self === globalThis.top; }
  catch { return false; }
}

async function boot() {
  await waitForDocumentElement();
  if (!globalThis.crypto?.subtle) throw new Error('WebCrypto is required to start Hex.');
  const status = launcher(`Loading Hex ${LOADER_VERSION}…`, true);
  let error = null;
  for (let attempt = 0; attempt <= RETRIES; attempt++) {
    try { await loadRuntime(); status.remove(); return; }
    catch (value) { error = value; if (attempt < RETRIES) await delay(400 * (attempt + 1)); }
  }
  throw error;
}

async function loadRuntime() {
  globalThis.__HEX_RUNTIME_ORIGIN__ = HEX_ORIGIN;
  globalThis.__HEX_RUNTIME_HOST_HREF__ = RUNTIME_HOST_LOCATION.href;
  globalThis.__HEX_RUNTIME_HOST_ORIGIN__ = RUNTIME_HOST_LOCATION.origin;
  globalThis.__HEX_RUNTIME_HOST_PATHNAME__ = RUNTIME_HOST_LOCATION.pathname;
  globalThis.__HEX_RUNTIME_HOST_SEARCH__ = RUNTIME_HOST_LOCATION.search;
  globalThis.__HEX_RUNTIME_HOST_LOCATION__ = RUNTIME_HOST_LOCATION;
  globalThis.__HEX_SECURE_LOADER__ = { version: LOADER_VERSION, buildId: EXPECTED_BUILD };
  const keyPair = await cryptoStage('ECDH key generation', () => crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']));
  const clientPublicKey = await cryptoStage('ECDH public-key export', () => crypto.subtle.exportKey('jwk', keyPair.publicKey));
  const nonce = randomToken(24), requestId = randomToken(18), sessionIdentity = randomToken(18);
  const bootstrap = await runtimeStage('runtime bootstrap fetch', () => fetchJson(`${HEX_ORIGIN}/runtime/bootstrap`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ nonce, loaderVersion: LOADER_VERSION, buildId: EXPECTED_BUILD, requestId, sessionIdentity, clientPublicKey }),
  }));
  if (!bootstrap || bootstrap.buildId !== EXPECTED_BUILD || Date.parse(bootstrap.expiry) <= Date.now()) throw new Error('Runtime bootstrap identity or expiry could not be verified.');
  const serverPublicKey = await cryptoStage('ECDH server-key import', () => crypto.subtle.importKey('jwk', bootstrap.serverPublicKey, { name: 'ECDH', namedCurve: 'P-256' }, false, []));
  const shared = await cryptoStage('ECDH shared-secret derivation', () => crypto.subtle.deriveBits({ name: 'ECDH', public: serverPublicKey }, keyPair.privateKey, 256));
  const material = await cryptoStage('HKDF material import', () => crypto.subtle.importKey('raw', toExactArrayBuffer(shared), 'HKDF', false, ['deriveKey']));
  const wrappingKey = await cryptoStage('HKDF wrapping-key derivation', () => crypto.subtle.deriveKey({
    name: 'HKDF', hash: 'SHA-256',
    salt: toExactArrayBuffer(fromB64(bootstrap.keyEnvelope.salt)),
    info: toExactArrayBuffer(utf8(`hex-runtime-wrap:${bootstrap.buildId}`)),
  }, material, { name: 'AES-GCM', length: 256 }, false, ['decrypt']));
  const contentKeyRaw = await cryptoStage('AES-GCM content-key unwrap', () => crypto.subtle.decrypt({
    name: 'AES-GCM',
    iv: toExactArrayBuffer(fromB64(bootstrap.keyEnvelope.iv)),
    additionalData: toExactArrayBuffer(utf8(`${bootstrap.buildId}:${bootstrap.sessionId}`)),
    tagLength: 128,
  }, wrappingKey, toExactArrayBuffer(fromB64(bootstrap.keyEnvelope.ciphertext))));
  const contentKey = await cryptoStage('AES-GCM content-key import', () => crypto.subtle.importKey('raw', toExactArrayBuffer(contentKeyRaw), { name: 'AES-GCM' }, false, ['decrypt']));
  const ciphertext = new Uint8Array(await runtimeStage('protected runtime fetch', () => fetchBytes(new URL(bootstrap.runtimeLocator, HEX_ORIGIN).href, { headers: { authorization: `Bearer ${bootstrap.session}` } })));
  await assertHash(ciphertext, bootstrap.manifest.ciphertextHash);
  const compressed = new Uint8Array(await cryptoStage('AES-GCM runtime decrypt', () => crypto.subtle.decrypt({
    name: 'AES-GCM',
    iv: toExactArrayBuffer(fromB64(bootstrap.manifest.iv)),
    additionalData: toExactArrayBuffer(utf8(bootstrap.manifest.aad)),
    tagLength: 128,
  }, contentKey, toExactArrayBuffer(ciphertext))));
  if (bootstrap.manifest.compression !== 'gzip') throw new Error('The protected runtime compression format is unsupported.');
  const plaintext = await runtimeStage('protected runtime decompress', () => decompressGzipExact(compressed));
  await assertHash(plaintext, bootstrap.manifest.contentHash);
  const blobUrl = await runtimeStage('protected runtime Blob creation', () => URL.createObjectURL(new Blob([toExactArrayBuffer(plaintext)], { type: 'text/javascript' })));
  try {
    const runtimeModule = await runtimeStage('protected runtime import', () => import(blobUrl));
    if (typeof runtimeModule?.startProtectedRuntime !== 'function') throw new Error('Protected runtime entry point is unavailable.');
    let sourceCopies = 0;
    await runtimeStage('protected runtime start', () => runtimeModule.startProtectedRuntime({
      hostLocation: RUNTIME_HOST_LOCATION,
      apiOrigin: HEX_ORIGIN,
      loaderVersion: LOADER_VERSION,
      buildId: EXPECTED_BUILD,
      runtimeContentHash: String(bootstrap.manifest.contentHash || '').toLowerCase(),
      runtimeSourceProvider() {
        sourceCopies += 1;
        if (sourceCopies > 1) throw new Error('Protected runtime source was requested more than once.');
        return toExactArrayBuffer(plaintext);
      },
    }));
  } finally {
    URL.revokeObjectURL(blobUrl); ciphertext.fill(0); compressed.fill(0); plaintext.fill(0); new Uint8Array(contentKeyRaw).fill(0); new Uint8Array(shared).fill(0);
  }
}

async function cryptoStage(stage, operation) {
  try { return await operation(); }
  catch (error) { throw new Error(`${stage}: ${String(error?.message || error || 'WebCrypto failed.')}`); }
}
async function runtimeStage(stage, operation) {
  try { return await operation(); }
  catch (error) { throw new Error(`${stage}: ${String(error?.message || error || 'runtime failed.')}`); }
}
async function assertHash(bytes, expected) {
  const digest = await cryptoStage('SHA-256 integrity digest', () => crypto.subtle.digest('SHA-256', toExactArrayBuffer(bytes)));
  const actual = toHex(new Uint8Array(digest));
  if (!constantTimeEqual(actual, String(expected || '').toLowerCase())) throw new Error('Protected runtime integrity verification failed.');
}
function constantTimeEqual(a, b) { if (a.length !== b.length) return false; let diff = 0; for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i); return diff === 0; }

async function fetchJson(url, init = {}) {
  const response = await fetch(url, { ...init, method: init.method || 'GET', credentials: 'omit', mode: 'cors', cache: 'no-store' });
  if (response.status !== 200) throw new Error(`Hex runtime bootstrap failed (${response.status}).`);
  return response.json();
}
async function fetchBytes(url, init = {}) {
  const response = await fetch(url, { ...init, method: init.method || 'GET', credentials: 'omit', mode: 'cors', cache: 'no-store' });
  if (response.status !== 200) throw new Error(`Hex protected runtime fetch failed (${response.status}).`);
  return response.arrayBuffer();
}

function suppressSmartAppBanner() {
  const remove = () => {
    let nodes = [];
    try { nodes = document.querySelectorAll?.('meta[name="apple-itunes-app"]') || []; } catch { nodes = []; }
    for (const node of nodes) {
      try { node.remove(); } catch { /* best effort */ }
    }
  };
  remove();
  const Observer = globalThis.MutationObserver;
  if (typeof Observer !== 'function') return () => {};
  const observer = new Observer(remove);
  try { observer.observe(document, { childList: true, subtree: true }); }
  catch { return () => {}; }
  return () => { remove(); observer.disconnect(); };
}

function waitForDocumentElement() {
  if (document.documentElement) return Promise.resolve(document.documentElement);
  return new Promise((resolve) => {
    const Observer = globalThis.MutationObserver;
    if (typeof Observer !== 'function') {
      const poll = () => document.documentElement ? resolve(document.documentElement) : setTimeout(poll, 0);
      poll();
      return;
    }
    const observer = new Observer(() => {
      if (!document.documentElement) return;
      observer.disconnect();
      resolve(document.documentElement);
    });
    observer.observe(document, { childList: true });
  });
}

function launcher(text, busy) {
  let button = document.getElementById('hex-secure-loader');
  if (!button) { button = document.createElement('button'); button.id = 'hex-secure-loader'; Object.assign(button.style, { position:'fixed',right:'12px',bottom:'12px',zIndex:'2147483647',minHeight:'44px',maxWidth:'min(92vw,520px)',padding:'8px 12px',border:'0',borderRadius:'12px',background:'#111827',color:'#fff',font:'600 13px system-ui',boxShadow:'0 4px 18px rgba(0,0,0,.28)' }); document.documentElement.append(button); }
  button.textContent = text; button.disabled = !!busy; button.dataset.hexLoaderVersion = LOADER_VERSION; return button;
}
function showFailure(error) { const message = String(error?.message || error || 'Unknown startup error.'); const button = launcher(`Hex ${LOADER_VERSION} failed — retry · ${message.slice(0, 120)}`, false); button.title = message; button.onclick = () => { button.remove(); boot().catch(showFailure); }; }
function randomToken(size) { const bytes = crypto.getRandomValues(new Uint8Array(size)); return b64(bytes); }
function b64(bytes) { let binary = ''; for (const value of bytes) binary += String.fromCharCode(value); return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/g, ''); }
function fromB64(value) { const raw = String(value).replaceAll('-', '+').replaceAll('_', '/'); const binary = atob(raw + '='.repeat((4 - raw.length % 4) % 4)); return Uint8Array.from(binary, (char) => char.charCodeAt(0)); }
function toHex(bytes) { return Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join(''); }
function utf8(value) { return new TextEncoder().encode(String(value)); }
function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
