import {
  CHATGPT_PARENT_ORIGINS,
  EMBED_PROTOCOL,
  EMBED_PROTOCOL_VERSION,
  createEmbedNonce,
  waitForEmbedReady,
} from './embed-protocol.js';
import { waitForEmbedChildBootstrap } from './embed-bootstrap.js';

const DEFAULT_LOAD_TIMEOUT_MS = 20000;
const DEFAULT_READY_TIMEOUT_MS = 30000;
const HOST_ID = 'hex-userscript-iframe-host';
const LAUNCHER_ID = 'hex-userscript-launcher';
const OPAQUE_CHILD_ORIGIN = 'null';

export function createChatGPTIframeHost(options = {}) {
  const {
    src,
    runtimeSource,
    provider = 'chatgpt',
    onPort,
    onReady,
    onFailure,
    documentRef = globalThis.document,
    windowRef = globalThis.window,
    MessageChannelCtor = globalThis.MessageChannel,
    loadTimeoutMs = DEFAULT_LOAD_TIMEOUT_MS,
    readyTimeoutMs = DEFAULT_READY_TIMEOUT_MS,
  } = options;

  if (typeof onPort !== 'function') throw new TypeError('onPort must be a synchronous function.');
  if (onReady != null && typeof onReady !== 'function') throw new TypeError('onReady must be a function.');
  if (onFailure != null && typeof onFailure !== 'function') throw new TypeError('onFailure must be a function.');
  if (!documentRef?.createElement || !documentRef?.documentElement) throw new TypeError('A document is required.');
  if (!windowRef?.addEventListener || !windowRef?.removeEventListener) throw new TypeError('A window event target is required.');
  if (typeof MessageChannelCtor !== 'function') throw new TypeError('MessageChannel is required.');
  if (typeof runtimeSource !== 'string' || !runtimeSource.trim()) throw new TypeError('Protected opaque embed runtime is required.');

  const parsedSrc = new URL(String(src || ''));
  if (parsedSrc.protocol !== 'https:') throw new TypeError('Hex iframe API origin must use HTTPS.');
  const apiOrigin = parsedSrc.origin;
  const normalizedProvider = provider === 'gemini' ? 'gemini' : 'chatgpt';
  const cspNonce = normalizeCspNonce(options.cspNonce ?? discoverCspNonce(documentRef));
  if (!cspNonce) throw new Error('ChatGPT CSP nonce is unavailable; secure opaque iframe bootstrap cannot start.');
  const childOrigin = OPAQUE_CHILD_ORIGIN;
  const bootstrapTimeoutMs = normalizeTimeout(loadTimeoutMs, DEFAULT_LOAD_TIMEOUT_MS);
  const appReadyTimeoutMs = normalizeTimeout(readyTimeoutMs, DEFAULT_READY_TIMEOUT_MS);

  const wrapper = documentRef.createElement('div');
  wrapper.id = HOST_ID;
  wrapper.setAttribute('aria-hidden', 'true');
  Object.assign(wrapper.style, {
    position: 'fixed', inset: '0', height: '100dvh', zIndex: '2147483646',
    overflow: 'hidden', visibility: 'hidden', pointerEvents: 'none', background: '#fff',
  });

  const iframe = documentRef.createElement('iframe');
  iframe.title = 'Hex';
  iframe.referrerPolicy = 'no-referrer';
  iframe.setAttribute('sandbox', 'allow-scripts allow-downloads');
  Object.assign(iframe.style, { display: 'block', width: '100%', height: '100%', border: '0' });

  const closeButton = documentRef.createElement('button');
  closeButton.type = 'button';
  closeButton.textContent = '×';
  closeButton.setAttribute('aria-label', 'Close Hex');
  Object.assign(closeButton.style, {
    position: 'absolute', top: 'calc(8px + env(safe-area-inset-top, 0px))',
    right: 'calc(8px + env(safe-area-inset-right, 0px))', zIndex: '3',
    minWidth: '44px', minHeight: '44px', border: '0', borderRadius: '12px',
    background: 'rgba(17,24,39,.88)', color: '#fff', font: '700 20px/1 system-ui',
  });

  const statusBox = documentRef.createElement('div');
  statusBox.setAttribute('role', 'status');
  Object.assign(statusBox.style, {
    position: 'absolute', left: '12px', bottom: 'calc(12px + env(safe-area-inset-bottom, 0px))',
    zIndex: '2', padding: '8px 10px', background: 'rgba(17,24,39,.9)', color: '#fff',
    font: '600 13px/1.3 -apple-system,BlinkMacSystemFont,system-ui,sans-serif', borderRadius: '8px',
  });
  statusBox.textContent = 'Loading Hex…';

  const errorBox = documentRef.createElement('div');
  errorBox.setAttribute('role', 'alert');
  errorBox.hidden = true;
  Object.assign(errorBox.style, {
    position: 'absolute', left: '50%', top: '50%', transform: 'translate(-50%, -50%)', zIndex: '4',
    maxWidth: 'min(420px, calc(100% - 32px))', padding: '16px', background: '#fff', color: '#111827',
    border: '1px solid rgba(0,0,0,.18)', borderRadius: '12px', boxShadow: '0 8px 30px rgba(0,0,0,.25)',
    font: '14px/1.4 -apple-system,BlinkMacSystemFont,system-ui,sans-serif',
  });
  const errorTitle = documentRef.createElement('strong'); errorTitle.textContent = 'Hex failed';
  const errorStage = documentRef.createElement('div');
  const errorMessage = documentRef.createElement('div');
  const retryButton = documentRef.createElement('button');
  retryButton.type = 'button'; retryButton.textContent = 'Retry';
  Object.assign(retryButton.style, { minWidth: '44px', minHeight: '44px', marginTop: '10px' });
  errorBox.append(errorTitle, errorStage, errorMessage, retryButton);

  const launcher = documentRef.createElement('button');
  launcher.id = LAUNCHER_ID;
  launcher.type = 'button'; launcher.textContent = 'HEX';
  Object.assign(launcher.style, {
    position: 'fixed', right: '12px', bottom: 'calc(12px + env(safe-area-inset-bottom, 0px))',
    zIndex: '2147483647', minWidth: '54px', minHeight: '44px', padding: '8px 12px', border: '0',
    borderRadius: '12px', background: '#111827', color: '#fff',
    font: '600 13px/1.2 -apple-system,BlinkMacSystemFont,system-ui,sans-serif',
    boxShadow: '0 4px 18px rgba(0,0,0,.28)', cursor: 'pointer',
  });

  wrapper.append(iframe, closeButton, statusBox, errorBox);
  documentRef.documentElement.append(wrapper, launcher);

  let lifecycle = 'idle';
  let generation = 0;
  let desiredVisible = false;
  let previousActiveElement = null;
  let destroyed = false;
  let activeGeneration = null;
  let failure = null;

  launcher.addEventListener('click', show);
  closeButton.addEventListener('click', hide);
  retryButton.addEventListener('click', reload);
  beginNavigation();

  function state() {
    return Object.freeze({
      status: lifecycle, generation, visible: desiredVisible, childOrigin, apiOrigin,
      failure: failure ? Object.freeze({ ...failure }) : null,
    });
  }

  function show() {
    if (destroyed) return state();
    if (!desiredVisible) previousActiveElement = safeActiveElement(documentRef);
    desiredVisible = true;
    wrapper.style.visibility = 'visible';
    wrapper.style.pointerEvents = 'auto';
    wrapper.removeAttribute('aria-hidden');
    launcher.hidden = true;
    if (lifecycle === 'ready' || lifecycle === 'hidden') lifecycle = 'visible';
    safeFocus(iframe.contentWindow);
    return state();
  }

  function hide() {
    if (destroyed) return state();
    desiredVisible = false;
    wrapper.style.visibility = 'hidden';
    wrapper.style.pointerEvents = 'none';
    wrapper.setAttribute('aria-hidden', 'true');
    launcher.hidden = false;
    if (lifecycle === 'ready' || lifecycle === 'visible') lifecycle = 'hidden';
    restorePreviousFocus();
    return state();
  }

  function reload() {
    if (!destroyed) beginNavigation();
    return state();
  }

  function destroy() {
    if (destroyed) return;
    destroyed = true;
    lifecycle = 'destroyed';
    cleanupGeneration(activeGeneration);
    launcher.removeEventListener('click', show);
    closeButton.removeEventListener('click', hide);
    retryButton.removeEventListener('click', reload);
    safeRemove(wrapper); safeRemove(launcher);
  }

  function beginNavigation() {
    cleanupGeneration(activeGeneration);
    if (destroyed) return;
    const currentGeneration = ++generation;
    const generationText = String(currentGeneration);
    const controller = new AbortController();
    const targetWindow = iframe.contentWindow;
    failure = null;
    lifecycle = 'loading';
    statusBox.hidden = false; statusBox.textContent = 'Loading Hex…'; errorBox.hidden = true;
    if (!targetWindow || typeof targetWindow.postMessage !== 'function') {
      fail(currentGeneration, 'iframe-bootstrap', new Error('Hex iframe window is unavailable.'));
      return;
    }

    const current = {
      generation: currentGeneration, generationText, controller,
      parentPort: null, childPort: null, cleanup: null, transferred: false,
    };
    activeGeneration = current;

    const bootstrap = waitForEmbedChildBootstrap({
      windowRef,
      expectedSource: targetWindow,
      childOrigin,
      generation: generationText,
      timeoutMs: bootstrapTimeoutMs,
      signal: controller.signal,
    });

    iframe.srcdoc = createOpaqueBootstrapDocument({
      cspNonce,
      generation: generationText,
      apiOrigin,
      allowedParentOrigins: CHATGPT_PARENT_ORIGINS,
    });

    bootstrap.then(() => startChannel(current)).catch((error) => {
      if (!isCurrentGeneration(currentGeneration) || controller.signal.aborted) return;
      fail(currentGeneration, 'iframe-bootstrap', error);
    });
  }

  function startChannel(current) {
    if (!isCurrentGeneration(current.generation)) return;
    lifecycle = 'handshaking';
    statusBox.textContent = 'Starting Hex…';
    const channel = new MessageChannelCtor();
    const nonce = createEmbedNonce();
    current.parentPort = channel.port1;
    current.childPort = channel.port2;

    try {
      const cleanup = onPort(channel.port1, Object.freeze({
        nonce, generation: current.generation, childOrigin, apiOrigin, iframe,
      }));
      if (cleanup && typeof cleanup.then === 'function') throw new TypeError('onPort must install RPC listeners synchronously.');
      if (cleanup !== undefined && typeof cleanup !== 'function') throw new TypeError('onPort must return a cleanup function or undefined.');
      current.cleanup = cleanup || null;

      const readyPromise = waitForEmbedReady(channel.port1, {
        nonce, timeoutMs: appReadyTimeoutMs, signal: current.controller.signal,
      });
      iframe.contentWindow.postMessage({
        type: 'hex.embed.attach',
        protocol: EMBED_PROTOCOL,
        version: EMBED_PROTOCOL_VERSION,
        nonce,
        generation: current.generationText,
        apiOrigin,
        provider: normalizedProvider,
        runtimeSource,
      }, '*', [channel.port2]);
      current.transferred = true;

      readyPromise.then(() => {
        if (!isCurrentGeneration(current.generation)) return;
        failure = null; statusBox.hidden = true; errorBox.hidden = true;
        lifecycle = desiredVisible ? 'visible' : 'hidden';
        try { onReady?.(state()); } catch {}
      }).catch((error) => {
        if (!isCurrentGeneration(current.generation) || current.controller.signal.aborted) return;
        fail(current.generation, 'handshake/app-ready', error);
      });
    } catch (error) {
      fail(current.generation, 'handshake/app-ready', error);
    }
  }

  function fail(failedGeneration, stage, error) {
    if (destroyed || (failedGeneration != null && activeGeneration?.generation !== failedGeneration)) return;
    cleanupGeneration(activeGeneration);
    lifecycle = 'failed';
    failure = { stage, message: safeErrorMessage(error) };
    statusBox.hidden = true;
    errorStage.textContent = `Stage: ${stage}`;
    errorMessage.textContent = failure.message;
    errorBox.hidden = false;
    if (!desiredVisible) launcher.hidden = false;
    try { onFailure?.(Object.freeze({ ...failure, generation: failedGeneration })); } catch {}
  }

  function cleanupGeneration(current) {
    if (!current) return;
    if (activeGeneration === current) activeGeneration = null;
    try { current.controller?.abort('iframe-generation-ended'); } catch {}
    try { current.cleanup?.(); } catch {}
    safeClose(current.parentPort);
    if (!current.transferred) safeClose(current.childPort);
  }

  function isCurrentGeneration(value) {
    return !destroyed && activeGeneration?.generation === value && generation === value;
  }

  function restorePreviousFocus() {
    const target = previousActiveElement;
    previousActiveElement = null;
    if (!target || typeof target.focus !== 'function' || !isConnectedToDocument(documentRef, target)) return;
    safeFocus(target);
  }

  return Object.freeze({ show, hide, reload, destroy, state, iframe, wrapper, launcher, closeButton, retryButton });
}

export function createOpaqueBootstrapDocument(options = {}) {
  const cspNonce = normalizeCspNonce(options.cspNonce);
  const generation = String(options.generation || '');
  const apiOrigin = normalizeHttpsOrigin(options.apiOrigin);
  const allowedParentOrigins = normalizeParentOrigins(options.allowedParentOrigins || CHATGPT_PARENT_ORIGINS);
  if (!cspNonce) throw new Error('A CSP nonce is required for the opaque embed bootstrap.');
  if (!/^[1-9]\d{0,14}$/.test(generation)) throw new Error('Opaque embed generation is invalid.');
  if (!allowedParentOrigins.length) throw new Error('Opaque embed parent origin allowlist is empty.');

  const script = `(()=>{\n` +
    `const P=${JSON.stringify(EMBED_PROTOCOL)},V=${JSON.stringify(EMBED_PROTOCOL_VERSION)},G=${JSON.stringify(generation)},N=${JSON.stringify(cspNonce)},A=${JSON.stringify(allowedParentOrigins)},E=${JSON.stringify(apiOrigin)};\n` +
    `let port=null,attached=false;\n` +
    `const msg=e=>String(e&&e.message||e||'opaque embed failed').slice(0,220);\n` +
    `const close=r=>{if(globalThis.__HEX_OPAQUE_EMBED_READY__)return;try{port&&port.postMessage({protocol:P,version:V,kind:'control',id:'opaque-boot-error',method:'close',reason:msg(r)})}catch{}};\n` +
    `addEventListener('error',e=>close(e&&e.error||e&&e.message||'opaque embed script error'));\n` +
    `addEventListener('unhandledrejection',e=>close(e&&e.reason||'opaque embed rejected'));\n` +
    `addEventListener('message',function on(e){const d=e&&e.data;if(attached||e.source!==parent||!A.includes(e.origin)||!d||d.type!=='hex.embed.attach'||d.protocol!==P||d.version!==V||String(d.generation)!==G||d.apiOrigin!==E||!/^[a-f0-9]{64}$/.test(String(d.nonce||''))||typeof d.runtimeSource!=='string'||!d.runtimeSource)return;const ps=e.ports;if(!ps||ps.length!==1||!ps[0])return;attached=true;removeEventListener('message',on);port=ps[0];try{port.start&&port.start()}catch{}globalThis.__HEX_OPAQUE_EMBED__={port,nonce:d.nonce,generation:G,apiOrigin:E,provider:d.provider==='gemini'?'gemini':'chatgpt'};const s=document.createElement('script');s.type='module';s.nonce=N;s.textContent=d.runtimeSource;s.addEventListener('error',()=>close('opaque embed module was blocked or failed to load'),{once:true});document.head.append(s);});\n` +
    `for(const o of A)parent.postMessage({type:'hex.embed.child-bootstrap-ready',protocol:P,version:V,generation:G},o);\n` +
    `})();`;

  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><script nonce="${escapeHtmlAttribute(cspNonce)}">${script}</script></head><body></body></html>`;
}

export function discoverCspNonce(documentRef = globalThis.document) {
  for (const selector of ['script[nonce]', 'style[nonce]']) {
    let node = null;
    try { node = documentRef?.querySelector?.(selector); } catch {}
    const value = safeNonceValue(node);
    if (value) return value;
  }
  return '';
}

function safeNonceValue(node) {
  if (!node) return '';
  try {
    const value = node.nonce || node.getAttribute?.('nonce') || '';
    return normalizeCspNonce(value);
  } catch { return ''; }
}
function normalizeCspNonce(value) {
  const text = String(value || '').trim();
  return /^[A-Za-z0-9+/_=-]{8,256}$/.test(text) ? text : '';
}
function normalizeHttpsOrigin(value) {
  const url = new URL(String(value || ''));
  if (url.protocol !== 'https:' || url.origin !== String(value || '')) throw new TypeError('Expected an exact HTTPS API origin.');
  return url.origin;
}
function normalizeParentOrigins(values) {
  const out = [];
  for (const value of values || []) {
    try {
      const url = new URL(String(value));
      if (url.protocol === 'https:' && url.origin === String(value) && !out.includes(url.origin)) out.push(url.origin);
    } catch {}
  }
  return out;
}
function escapeHtmlAttribute(value) {
  return String(value).replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}
function normalizeTimeout(value, fallback) {
  if (value == null) return fallback;
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) throw new TypeError('Iframe timeout must be a non-negative finite number.');
  return Math.floor(number);
}
function safeErrorMessage(error) {
  const message = error?.message;
  return typeof message === 'string' && message.trim() ? message.slice(0, 240) : 'Hex could not start.';
}
function safeClose(port) { try { port?.close?.(); } catch {} }
function safeRemove(node) { try { node?.remove?.(); } catch {} }
function safeFocus(target) { try { target?.focus?.(); } catch {} }
function safeActiveElement(documentRef) { try { return documentRef.activeElement || null; } catch { return null; } }
function isConnectedToDocument(documentRef, node) {
  try {
    if (typeof documentRef.contains === 'function') return documentRef.contains(node);
    return documentRef.documentElement?.contains?.(node) === true;
  } catch { return false; }
}
