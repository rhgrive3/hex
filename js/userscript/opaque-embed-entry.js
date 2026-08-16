import { PROTECTED_HOST } from '../../.runtime-build/embedded-assets.js';
import { setUiRoot } from '../ui-root.js';
import { createEmbedBridgeProxy } from './embed-bridge-proxy.js';
import { installCanonicalCss, waitForCanonicalAppReady } from './embed-child.js';
import { sendEmbedReady } from './embed-protocol.js';
import { installProtectedWorkers } from './protected-workers.js';

const bootstrap = takeBootstrap();
const apiOrigin = normalizeApiOrigin(bootstrap.apiOrigin);
const provider = bootstrap.provider === 'gemini' ? 'gemini' : 'chatgpt';
stageSync('opaque embed storage shim', () => installOpaqueStorageShims(globalThis));
const bridge = stageSync('opaque embed bridge proxy', () => createEmbedBridgeProxy({ port: bootstrap.port }));

globalThis.__HEX_API_BASE__ = apiOrigin;
globalThis.__HEX_AI_PROVIDER__ = provider;
globalThis.__HEX_CHATGPT_BRIDGE__ = bridge;

await stage('opaque embed bridge cache refresh', () => bridge.refresh?.({ timeoutMs: 2000 }));
stageSync('opaque embed document shell', () => {
  if (!document?.body || !document?.documentElement) throw new Error('opaque embed document is unavailable');
  document.body.innerHTML = PROTECTED_HOST.html;
  setUiRoot(document.documentElement);
  document.documentElement.lang = navigator.language || 'ja';
});
stageSync('opaque embed canonical CSS', () => installCanonicalCss(document, PROTECTED_HOST.css));
await stage('opaque embed protected workers', () => installProtectedWorkers());
await stage('opaque embed app import', () => import('../app.js'));
await stage('opaque embed ux import', () => import('../ux.js'));
await stage('opaque embed app readiness', () => waitForCanonicalAppReady({
  document,
  globalObject: globalThis,
  timeoutMs: 20000,
}));
stageSync('opaque embed ready', () => sendEmbedReady(bootstrap.port, { nonce: bootstrap.nonce }));

globalThis.__HEX_OPAQUE_EMBED_READY__ = Object.freeze({
  generation: bootstrap.generation,
  apiOrigin,
  provider,
});

export function installOpaqueStorageShims(globalObject = globalThis) {
  installStorageShim(globalObject, 'localStorage');
  installStorageShim(globalObject, 'sessionStorage');
  return Object.freeze({ localStorage: globalObject.localStorage, sessionStorage: globalObject.sessionStorage });
}

function installStorageShim(globalObject, name) {
  try {
    const existing = globalObject[name];
    if (existing && typeof existing.getItem === 'function' && typeof existing.setItem === 'function') return existing;
  } catch {}

  const storage = createMemoryStorage();
  let installed = false;
  try {
    Object.defineProperty(globalObject, name, {
      value: storage,
      configurable: true,
      enumerable: true,
      writable: false,
    });
    installed = true;
  } catch {}
  if (!installed) {
    let prototype = null;
    try { prototype = Object.getPrototypeOf(globalObject); } catch {}
    if (prototype) {
      try {
        Object.defineProperty(prototype, name, {
          value: storage,
          configurable: true,
          enumerable: true,
          writable: false,
        });
        installed = true;
      } catch {}
    }
  }
  if (!installed) throw new Error(`${name} is unavailable in the sandbox`);
  try {
    if (globalObject[name] !== storage) throw new Error(`${name} shim did not take effect`);
  } catch (error) {
    throw new Error(`${name} shim did not take effect: ${String(error?.message || error)}`);
  }
  return storage;
}

function createMemoryStorage() {
  const values = new Map();
  return Object.freeze({
    get length() { return values.size; },
    key(index) {
      const number = Number(index);
      if (!Number.isInteger(number) || number < 0) return null;
      return [...values.keys()][number] ?? null;
    },
    getItem(key) {
      const normalized = String(key);
      return values.has(normalized) ? values.get(normalized) : null;
    },
    setItem(key, value) { values.set(String(key), String(value)); },
    removeItem(key) { values.delete(String(key)); },
    clear() { values.clear(); },
  });
}

function takeBootstrap() {
  const value = globalThis.__HEX_OPAQUE_EMBED__;
  try { delete globalThis.__HEX_OPAQUE_EMBED__; } catch {}
  if (!value || typeof value !== 'object') throw new Error('opaque embed bootstrap is missing');
  if (!value.port || typeof value.port.postMessage !== 'function') throw new Error('opaque embed MessagePort is missing');
  const nonce = String(value.nonce || '');
  if (!/^[a-f0-9]{64}$/.test(nonce)) throw new Error('opaque embed nonce is invalid');
  const generation = String(value.generation || '');
  if (!/^[1-9]\d{0,14}$/.test(generation)) throw new Error('opaque embed generation is invalid');
  return Object.freeze({
    port: value.port,
    nonce,
    generation,
    apiOrigin: value.apiOrigin,
    provider: value.provider,
  });
}

function normalizeApiOrigin(value) {
  try {
    const url = new URL(String(value || ''));
    if (url.protocol !== 'https:') throw new Error('HTTPS required');
    return url.origin;
  } catch {
    throw new Error('opaque embed API origin is invalid');
  }
}

async function stage(name, operation) {
  try { return await operation(); }
  catch (error) { throw stageError(name, error); }
}
function stageSync(name, operation) {
  try { return operation(); }
  catch (error) { throw stageError(name, error); }
}
function stageError(name, error) {
  const message = String(error?.message || error || 'failed');
  if (message.startsWith(`${name}:`)) return error;
  return new Error(`${name}: ${message}`);
}
