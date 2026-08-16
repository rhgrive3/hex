import {
  CHATGPT_PARENT_ORIGINS,
  EMBED_PROTOCOL,
  EMBED_PROTOCOL_VERSION,
  sendEmbedReady,
  validateAttachEvent,
} from './embed-protocol.js';
import {
  announceEmbedChildBootstrapReady,
  normalizeEmbedProvider,
  normalizeSandboxToken,
  readEmbedGeneration,
  readEmbedProvider,
} from './embed-bootstrap.js';
import { createEmbedBridgeProxy } from './embed-bridge-proxy.js';
import { setUiRoot } from '../ui-root.js';

export const EMBED_PATH = '/embed/chatgpt';
export const EMBED_ATTACH_TIMEOUT_MS = 15000;
export const EMBED_APP_READY_TIMEOUT_MS = 15000;
export const PROTECTED_RUNTIME_CONTEXT = Object.freeze({
  LEGACY_CHATGPT: 'legacy-chatgpt-parent',
  EMBED_CHATGPT: 'worker-chatgpt-iframe',
  STANDALONE: 'worker-standalone',
});

export function classifyProtectedRuntime(options = {}) {
  const locationRef = options.location || globalThis.location;
  const apiOrigin = String(options.apiOrigin || '');
  const currentWindow = options.window || globalThis.window;
  if (CHATGPT_PARENT_ORIGINS.includes(locationRef?.origin)) return PROTECTED_RUNTIME_CONTEXT.LEGACY_CHATGPT;
  if (locationRef?.origin === apiOrigin && locationRef?.pathname === EMBED_PATH && isIframeWindow(currentWindow)) {
    return PROTECTED_RUNTIME_CONTEXT.EMBED_CHATGPT;
  }
  return PROTECTED_RUNTIME_CONTEXT.STANDALONE;
}

export function isIframeWindow(currentWindow = globalThis.window) {
  try { return !!currentWindow && !!currentWindow.parent && currentWindow.parent !== currentWindow; }
  catch { return false; }
}

export function waitForEmbedParentAttach(options = {}) {
  const currentWindow = options.window || globalThis.window;
  const locationRef = options.location || globalThis.location;
  const expectedParent = options.expectedParent || currentWindow?.parent;
  const allowedOrigins = options.allowedOrigins || CHATGPT_PARENT_ORIGINS;
  const timeoutMs = normalizeTimeout(options.timeoutMs, EMBED_ATTACH_TIMEOUT_MS);
  const validate = options.validateAttachEvent || validateAttachEvent;
  const generation = String(options.generation || readEmbedGeneration(locationRef) || '');
  const announce = options.announceEmbedChildBootstrapReady || announceEmbedChildBootstrapReady;
  const sandboxToken = readSandboxToken(options.globalObject || globalThis);
  if (!generation) return Promise.reject(new Error('embed navigation generation is missing'));

  return new Promise((resolve, reject) => {
    let settled = false;
    let timer = null;
    const cleanup = () => {
      currentWindow?.removeEventListener?.('message', onMessage);
      if (timer !== null) clearTimeout(timer);
    };
    const settle = (error, value) => {
      if (settled) return;
      settled = true; cleanup();
      if (error) reject(error); else resolve(value);
    };
    function onMessage(event) {
      if (event?.source !== expectedParent) return;
      if (!originAllowed(allowedOrigins, event?.origin)) return;
      const data = event?.data;
      if (!isAttachLike(data)) return;
      if (String(data.generation || '') !== generation) return;
      if (sandboxToken && String(data.sandboxToken || '').toLowerCase() !== sandboxToken) return;
      if (data.protocol !== EMBED_PROTOCOL || data.version !== EMBED_PROTOCOL_VERSION) {
        settle(new Error('embed parent attach protocol/version mismatch'));
        return;
      }
      const result = validate(event, { expectedSource: expectedParent, allowedOrigins });
      if (!result?.ok) return;
      settle(null, Object.freeze({ ...result, generation, sandboxToken }));
    }

    currentWindow?.addEventListener?.('message', onMessage);
    try {
      announce({ windowRef: currentWindow, parent: expectedParent, generation, targetOrigins: allowedOrigins, sandboxToken });
    } catch (error) {
      settle(error);
      return;
    }
    if (timeoutMs > 0) timer = setTimeout(() => settle(new Error('embed parent attach timeout')), timeoutMs);
  });
}

export async function startEmbedChildRuntime(options = {}) {
  const currentWindow = options.window || globalThis.window;
  const documentRef = options.document || globalThis.document;
  const locationRef = options.location || globalThis.location;
  const globalObject = options.globalObject || globalThis;
  const cssText = String(options.cssText || '');
  const setRoot = options.setUiRoot || setUiRoot;
  const installWorkers = options.installProtectedWorkers || (async () => {
    const module = await import('./protected-workers.js');
    return module.installProtectedWorkers();
  });
  const createBridge = options.createEmbedBridgeProxy || createEmbedBridgeProxy;
  const importApp = options.importApp || (() => import('../app.js'));
  const importUx = options.importUx || (() => import('../ux.js'));
  const sendReady = options.sendEmbedReady || sendEmbedReady;
  const waitAttach = options.waitForEmbedParentAttach || waitForEmbedParentAttach;
  const waitReady = options.waitForAppReady || waitForCanonicalAppReady;

  if (locationRef?.pathname !== EMBED_PATH) throw new Error('embed child route mismatch');
  if (!isIframeWindow(currentWindow)) throw new Error('embed child requires an iframe');

  const generation = readEmbedGeneration(locationRef);
  if (!generation) throw new Error('embed child navigation generation is missing');
  const attach = await stage('embed parent attach', () => waitAttach({
    window: currentWindow,
    location: locationRef,
    globalObject,
    expectedParent: currentWindow.parent,
    generation,
    timeoutMs: options.attachTimeoutMs,
    allowedOrigins: options.allowedOrigins,
  }));
  const bridge = stageSync('embed bridge proxy', () => createBridge({ port: attach.port }));
  globalObject.__HEX_CHATGPT_BRIDGE__ = bridge;
  globalObject.__HEX_API_BASE__ = locationRef.origin;
  globalObject.__HEX_AI_PROVIDER__ = readInitialProvider(locationRef, globalObject);

  await stage('embed bridge cache refresh', () => bridge.refresh?.({ timeoutMs: options.refreshTimeoutMs }));
  stageSync('embed UI root', () => {
    setRoot(documentRef.documentElement);
    if (documentRef?.documentElement && globalObject.navigator?.language) documentRef.documentElement.lang = globalObject.navigator.language;
  });
  stageSync('embed canonical CSS', () => installCanonicalCss(documentRef, cssText));
  await stage('embed protected workers', () => installWorkers());
  await stage('embed app import', () => importApp());
  await stage('embed ux import', () => importUx());
  await stage('embed app readiness', () => waitReady({
    document: documentRef,
    globalObject,
    timeoutMs: options.appReadyTimeoutMs,
    requiredSelectors: options.requiredSelectors,
  }));
  stageSync('embed ready', () => sendReady(attach.port, { nonce: attach.nonce }));
  return Object.freeze({ bridge, nonce: attach.nonce, port: attach.port, generation, sandboxToken: attach.sandboxToken || null });
}

export function installCanonicalCss(documentRef, cssText) {
  if (!documentRef?.head) throw new Error('canonical document head is unavailable');
  let style = documentRef.getElementById?.('hex-userscript-style');
  if (!style) {
    style = documentRef.createElement('style');
    style.id = 'hex-userscript-style';
    documentRef.head.append(style);
  }
  style.textContent = String(cssText || '');
  return style;
}

export function waitForCanonicalAppReady(options = {}) {
  const documentRef = options.document || globalThis.document;
  const globalObject = options.globalObject || globalThis;
  const timeoutMs = normalizeTimeout(options.timeoutMs, EMBED_APP_READY_TIMEOUT_MS);
  const requiredSelectors = options.requiredSelectors || ['#app', '#btn-open'];
  const pollMs = normalizeTimeout(options.pollMs, 25);
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const poll = () => {
      const appReady = !!globalObject.__app;
      const domReady = requiredSelectors.every((selector) => !!documentRef?.querySelector?.(selector));
      if (appReady && domReady) { resolve(true); return; }
      if (Date.now() - started >= timeoutMs) { reject(new Error('embed app readiness timeout')); return; }
      setTimeout(poll, pollMs);
    };
    poll();
  });
}

function readSandboxToken(globalObject) {
  const value = globalObject?.__HEX_EMBED_SANDBOX_TOKEN__;
  if (!value) return null;
  try { return normalizeSandboxToken(value); } catch { return null; }
}
function readInitialProvider(locationRef, globalObject) {
  let stored = null;
  try { stored = normalizeEmbedProvider(globalObject.localStorage?.getItem?.('hex.ai.provider')); } catch {}
  return stored || readEmbedProvider(locationRef) || 'chatgpt';
}
function originAllowed(allowedOrigins, origin) {
  if (allowedOrigins && typeof allowedOrigins.has === 'function') return allowedOrigins.has(origin);
  if (allowedOrigins && typeof allowedOrigins.includes === 'function') return allowedOrigins.includes(origin);
  try { return new Set(allowedOrigins || []).has(origin); } catch { return false; }
}
function isAttachLike(value) { return !!value && typeof value === 'object' && value.type === 'hex.embed.attach'; }
function normalizeTimeout(value, fallback) {
  if (value == null) return fallback;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : fallback;
}
async function stage(name, operation) {
  try { return await operation(); } catch (error) { throw stageError(name, error); }
}
function stageSync(name, operation) {
  try { return operation(); } catch (error) { throw stageError(name, error); }
}
function stageError(name, error) {
  const message = String(error?.message || error || 'failed');
  if (message.startsWith(`${name}:`)) return error;
  const wrapped = new Error(`${name}: ${message}`);
  if (error?.code) wrapped.code = error.code;
  return wrapped;
}

export default startEmbedChildRuntime;
