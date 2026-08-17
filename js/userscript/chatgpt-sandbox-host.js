import {
  CHATGPT_PARENT_ORIGINS,
  EMBED_PROTOCOL,
  EMBED_PROTOCOL_VERSION,
  createEmbedNonce,
  waitForEmbedReady,
} from './embed-protocol.js';
import {
  normalizeEmbedGeneration,
  normalizeSandboxToken,
  waitForEmbedChildBootstrap,
  withEmbedGeneration,
} from './embed-bootstrap.js';

const HOST_ID = 'hex-userscript-iframe-host';
const IFRAME_ID = 'hex-userscript-iframe';
const LAUNCHER_ID = 'hex-userscript-launcher';
const CLOSE_ID = 'hex-userscript-emergency-close';
const STATUS_ID = 'hex-userscript-iframe-status';
const SANDBOX_READY = 'hex.embed.sandbox-ready';
const SANDBOX_RUNTIME = 'hex.embed.runtime';
const SANDBOX_FAILURE = 'hex.embed.sandbox-failure';
const DEFAULT_BOOTSTRAP_TIMEOUT_MS = 8000;
const DEFAULT_READY_TIMEOUT_MS = 30000;
const MAX_RUNTIME_BYTES = 32 * 1024 * 1024;

export function createChatGPTSandboxHost(options = {}) {
  const documentRef = options.documentRef || globalThis.document;
  const windowRef = options.windowRef || globalThis.window;
  const MessageChannelCtor = options.MessageChannelCtor || globalThis.MessageChannel;
  const hostHtml = String(options.hostHtml || '');
  const cspNonce = normalizeNonce(options.cspNonce);
  const virtualSrc = normalizeVirtualSrc(options.virtualSrc);
  const apiOrigin = new URL(virtualSrc).origin;
  const loaderVersion = String(options.loaderVersion || '');
  const buildId = String(options.buildId || '');
  const runtimeContentHash = normalizeRuntimeContentHash(options.runtimeContentHash);
  const runtimeSourceProvider = options.runtimeSourceProvider;
  const onPort = typeof options.onPort === 'function' ? options.onPort : () => null;
  const onReady = typeof options.onReady === 'function' ? options.onReady : () => {};
  const onFailure = typeof options.onFailure === 'function' ? options.onFailure : () => {};
  const bootstrapTimeoutMs = normalizeTimeout(options.bootstrapTimeoutMs, DEFAULT_BOOTSTRAP_TIMEOUT_MS);
  const readyTimeoutMs = normalizeTimeout(options.readyTimeoutMs, DEFAULT_READY_TIMEOUT_MS);
  if (!documentRef?.createElement || !documentRef?.documentElement) throw new TypeError('A document is required.');
  if (typeof MessageChannelCtor !== 'function') throw new TypeError('MessageChannel is required.');
  if (typeof runtimeSourceProvider !== 'function') throw new TypeError('A protected runtime source provider is required.');

  const protectedRuntimeSource = normalizeRuntimeSource(runtimeSourceProvider());
  let destroyed = false;
  let generation = 0;
  let iframe = null;
  let port = null;
  let portCleanup = null;
  let generationAbort = null;
  let sandboxMonitor = null;
  let wantedVisible = true;
  let state = 'idle';
  let failure = null;
  const previousActive = safeActiveElement(documentRef);

  const wrapper = ensureWrapper(documentRef);
  const launcher = ensureLauncher(documentRef);
  const close = ensureClose(documentRef);
  const status = ensureStatus(documentRef, wrapper);
  close.onclick = () => hide();
  launcher.onclick = () => show();
  status.onclick = () => { if (state === 'failed') void startGeneration(); };
  wrapper.style.visibility = 'visible';
  wrapper.style.pointerEvents = 'auto';
  launcher.hidden = true;
  close.hidden = false;

  void startGeneration();

  return Object.freeze({
    show,
    hide,
    destroy,
    reload: startGeneration,
    state: () => Object.freeze({ status: state, generation, failure }),
    get iframe() { return iframe; },
    wrapper,
    launcher,
  });

  async function startGeneration() {
    if (destroyed) throw new Error('Hex iframe host is destroyed.');
    cleanupGeneration();
    generation += 1;
    const currentGeneration = generation;
    generationAbort = new AbortController();
    failure = null;
    state = 'sandbox-loading';
    setStatus(status, 'Loading Hex…', false);

    try { documentRef.getElementById?.(IFRAME_ID)?.remove(); } catch {}
    iframe = createSandboxIframe(documentRef, {
      hostHtml,
      cspNonce,
      generation: currentGeneration,
      sandboxToken: createEmbedNonce(),
      apiOrigin,
      virtualSrc: withEmbedGeneration(virtualSrc, currentGeneration),
      loaderVersion,
      buildId,
      runtimeContentHash,
    });
    const token = normalizeSandboxToken(iframe.dataset.hexSandboxToken);

    sandboxMonitor = createSandboxMonitor({
      windowRef,
      iframe,
      generation: currentGeneration,
      sandboxToken: token,
      timeoutMs: bootstrapTimeoutMs,
      signal: generationAbort.signal,
    });
    wrapper.insertBefore(iframe, status);

    try {
      await sandboxMonitor.ready;
      if (!isCurrent(currentGeneration)) return;

      state = 'runtime-transfer';
      setStatus(status, 'Starting Hex…', false);
      const childBootstrapPromise = waitForEmbedChildBootstrap({
        windowRef,
        expectedSource: iframe.contentWindow,
        opaque: true,
        sandboxToken: token,
        generation: currentGeneration,
        timeoutMs: bootstrapTimeoutMs,
        signal: generationAbort.signal,
      });
      const transfer = protectedRuntimeSource.slice(0);
      iframe.contentWindow.postMessage({
        type: SANDBOX_RUNTIME,
        protocol: EMBED_PROTOCOL,
        version: EMBED_PROTOCOL_VERSION,
        generation: normalizeEmbedGeneration(currentGeneration),
        sandboxToken: token,
        runtime: transfer,
      }, '*', [transfer]);

      state = 'handshaking';
      const childBootstrap = await raceSandboxFailure(childBootstrapPromise, sandboxMonitor.failure);
      if (!isCurrent(currentGeneration)) return;

      const channel = new MessageChannelCtor();
      port = channel.port1;
      const nonce = createEmbedNonce();
      portCleanup = onPort(port, { nonce, generation: currentGeneration, sandboxToken: token }) || null;
      if (!isCurrent(currentGeneration)) { closePort(channel.port1); closePort(channel.port2); return; }

      const readyPromise = waitForEmbedReady(port, { nonce, timeoutMs: readyTimeoutMs, signal: generationAbort.signal });
      iframe.contentWindow.postMessage({
        type: 'hex.embed.attach',
        protocol: EMBED_PROTOCOL,
        version: EMBED_PROTOCOL_VERSION,
        nonce,
        generation: normalizeEmbedGeneration(currentGeneration),
        sandboxToken: token,
      }, '*', [channel.port2]);
      await raceSandboxFailure(readyPromise, sandboxMonitor.failure);
      if (!isCurrent(currentGeneration)) return;

      sandboxMonitor.close();
      sandboxMonitor = null;
      state = wantedVisible ? 'visible' : 'hidden';
      setStatus(status, '', true);
      iframe.style.visibility = 'visible';
      if (wantedVisible) show(); else hide();
      onReady(Object.freeze({ generation: currentGeneration, nonce, sandboxToken: token, childBootstrap }));
    } catch (error) {
      if (!isCurrent(currentGeneration) || isAbortError(error)) return;
      fail(currentGeneration, stageFor(error), error);
    }
  }

  function show() {
    if (destroyed) return;
    wantedVisible = true;
    wrapper.style.visibility = 'visible';
    wrapper.style.pointerEvents = 'auto';
    wrapper.removeAttribute('aria-hidden');
    launcher.hidden = true;
    close.hidden = false;
    if (state === 'ready' || state === 'hidden') state = 'visible';
    try { iframe?.contentWindow?.focus?.(); } catch {}
  }

  function hide() {
    if (destroyed) return;
    wantedVisible = false;
    wrapper.style.visibility = 'hidden';
    wrapper.style.pointerEvents = 'none';
    wrapper.setAttribute('aria-hidden', 'true');
    launcher.hidden = false;
    close.hidden = true;
    if (state === 'visible' || state === 'ready') state = 'hidden';
    restoreFocus(previousActive, documentRef);
  }

  function fail(failedGeneration, stage, error) {
    if (!isCurrent(failedGeneration)) return;
    const message = String(error?.message || error || 'Hex iframe failed.');
    cleanupGeneration();
    state = 'failed';
    failure = Object.freeze({ stage, message, generation: failedGeneration });
    setStatus(status, `Hex failed · ${stage}\n${message}\nTap here to retry.`, false, true);
    wrapper.style.visibility = 'visible';
    wrapper.style.pointerEvents = 'auto';
    launcher.hidden = true;
    close.hidden = false;
    onFailure(failure);
  }

  function destroy() {
    if (destroyed) return;
    destroyed = true;
    state = 'destroyed';
    cleanupGeneration();
    new Uint8Array(protectedRuntimeSource).fill(0);
    try { iframe?.remove(); } catch {}
    iframe = null;
    try { wrapper.remove(); } catch {}
    try { launcher.remove(); } catch {}
    try { close.remove(); } catch {}
    restoreFocus(previousActive, documentRef);
  }

  function cleanupGeneration() {
    try { generationAbort?.abort('superseded'); } catch {}
    generationAbort = null;
    try { sandboxMonitor?.close?.(); } catch {}
    sandboxMonitor = null;
    try { if (typeof portCleanup === 'function') portCleanup(); } catch {}
    portCleanup = null;
    closePort(port);
    port = null;
  }

  function isCurrent(value) { return !destroyed && value === generation; }
}

export function findChatGPTCspNonce(documentRef = globalThis.document) {
  const nodes = documentRef?.querySelectorAll?.('script[nonce]') || [];
  for (const node of nodes) {
    const value = normalizeNonce(node?.nonce || node?.getAttribute?.('nonce'), false);
    if (value) return value;
  }
  return '';
}

export function createSandboxIframe(documentRef, config) {
  const iframe = documentRef.createElement('iframe');
  iframe.id = IFRAME_ID;
  iframe.title = 'Hex binary workbench';
  iframe.referrerPolicy = 'no-referrer';
  iframe.setAttribute('sandbox', 'allow-scripts allow-downloads');
  iframe.setAttribute('aria-label', 'Hex');
  iframe.dataset.hexGeneration = normalizeEmbedGeneration(config.generation);
  iframe.dataset.hexSandboxToken = normalizeSandboxToken(config.sandboxToken);
  iframe.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;border:0;display:block;background:#fff;visibility:hidden;';
  iframe.srcdoc = buildSandboxSrcdoc(config);
  return iframe;
}

export function buildSandboxSrcdoc(config) {
  const nonce = normalizeNonce(config.cspNonce);
  const generation = normalizeEmbedGeneration(config.generation);
  const sandboxToken = normalizeSandboxToken(config.sandboxToken);
  const apiOrigin = normalizeHttpsOrigin(config.apiOrigin);
  const runtimeContentHash = normalizeRuntimeContentHash(config.runtimeContentHash);
  const virtualUrl = new URL(String(config.virtualSrc || ''));
  if (virtualUrl.protocol !== 'https:' || virtualUrl.origin !== apiOrigin) throw new TypeError('Invalid Hex virtual embed URL.');
  const bootstrap = sandboxBootstrapSource({
    nonce,
    generation,
    sandboxToken,
    apiOrigin,
    virtualHref: virtualUrl.href,
    loaderVersion: String(config.loaderVersion || ''),
    buildId: String(config.buildId || ''),
    runtimeContentHash,
  });
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="referrer" content="no-referrer"><title>Hex</title></head><body>${String(config.hostHtml || '')}<script nonce="${escapeAttribute(nonce)}">${bootstrap}<\/script></body></html>`;
}

function sandboxBootstrapSource(config) {
  const literal = JSON.stringify(config).replaceAll('<', '\\u003c');
  return `(()=>{const c=${literal},P=${JSON.stringify(CHATGPT_PARENT_ORIGINS)};let used=false;function post(type,extra={}){parent.postMessage({type,protocol:${JSON.stringify(EMBED_PROTOCOL)},version:${EMBED_PROTOCOL_VERSION},generation:c.generation,sandboxToken:c.sandboxToken,...extra},'*')}function fail(message){post(${JSON.stringify(SANDBOX_FAILURE)},{message:String(message||'sandbox runtime failed')})}function hex(bytes){let out='';for(const value of bytes)out+=value.toString(16).padStart(2,'0');return out}function same(a,b){if(a.length!==b.length)return false;let diff=0;for(let i=0;i<a.length;i++)diff|=a.charCodeAt(i)^b.charCodeAt(i);return diff===0}addEventListener('error',e=>fail(e&&e.message||'sandbox script error'));addEventListener('unhandledrejection',e=>fail(e&&e.reason&&e.reason.message||e&&e.reason||'sandbox promise rejection'));addEventListener('message',async e=>{if(used||e.source!==parent||!P.includes(e.origin))return;const d=e.data;if(!d||d.type!==${JSON.stringify(SANDBOX_RUNTIME)}||d.protocol!==${JSON.stringify(EMBED_PROTOCOL)}||d.version!==${EMBED_PROTOCOL_VERSION}||String(d.generation)!==c.generation||String(d.sandboxToken||'').toLowerCase()!==c.sandboxToken||!(d.runtime instanceof ArrayBuffer))return;try{const digest=hex(new Uint8Array(await crypto.subtle.digest('SHA-256',d.runtime)));if(used)return;if(!same(digest,c.runtimeContentHash)){new Uint8Array(d.runtime).fill(0);return}used=true;globalThis.__HEX_EMBED_SANDBOX_TOKEN__=c.sandboxToken;globalThis.__HEX_RUNTIME_ORIGIN__=c.apiOrigin;const u=new URL(c.virtualHref);const host={origin:u.origin,pathname:u.pathname,search:u.search,href:u.href};globalThis.__HEX_RUNTIME_HOST_HREF__=host.href;globalThis.__HEX_RUNTIME_HOST_ORIGIN__=host.origin;globalThis.__HEX_RUNTIME_HOST_PATHNAME__=host.pathname;globalThis.__HEX_RUNTIME_HOST_SEARCH__=host.search;globalThis.__HEX_RUNTIME_HOST_LOCATION__=host;globalThis.__HEX_SECURE_LOADER__={version:c.loaderVersion,buildId:c.buildId};globalThis.__HEX_PROTECTED_AUTO_START__={sandboxAuto:true,sandboxToken:c.sandboxToken,hostLocation:host,apiOrigin:c.apiOrigin,loaderVersion:c.loaderVersion,buildId:c.buildId};const b=new Uint8Array(d.runtime),source=new TextDecoder().decode(b);b.fill(0);const s=document.createElement('script');s.type='module';s.nonce=c.nonce;s.textContent=source;s.addEventListener('load',()=>{try{s.textContent='';s.remove()}catch{}},{once:true});s.addEventListener('error',()=>fail('protected runtime module execution failed'),{once:true});document.head.append(s)}catch(err){if(!used)fail(err&&err.message||err)}},{capture:false});post(${JSON.stringify(SANDBOX_READY)})})()`;
}

function createSandboxMonitor(options) {
  const { windowRef, iframe, generation, sandboxToken, timeoutMs, signal } = options;
  const expectedGeneration = normalizeEmbedGeneration(generation);
  const token = normalizeSandboxToken(sandboxToken);
  let closed = false;
  let readyResolve;
  let readyReject;
  let failureResolve;
  let timer = null;
  const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  const failure = new Promise((resolve) => { failureResolve = resolve; });
  const cleanup = () => {
    if (closed) return;
    closed = true;
    windowRef.removeEventListener('message', onMessage);
    signal?.removeEventListener?.('abort', onAbort);
    if (timer !== null) clearTimeout(timer);
  };
  const onAbort = () => {
    const error = abortError(signal?.reason);
    readyReject(error);
    failureResolve(error);
    cleanup();
  };
  function onMessage(event) {
    if (event?.source !== iframe?.contentWindow || event?.origin !== 'null') return;
    const data = event?.data;
    if (!data || typeof data !== 'object') return;
    if (data.protocol !== EMBED_PROTOCOL || data.version !== EMBED_PROTOCOL_VERSION) return;
    if (String(data.generation) !== expectedGeneration) return;
    if (String(data.sandboxToken || '').toLowerCase() !== token) return;
    if (data.type === SANDBOX_FAILURE) {
      const error = stageError('sandbox-runtime', data.message || 'Hex sandbox runtime failed.');
      failureResolve(error);
      readyReject(error);
      return;
    }
    if (data.type === SANDBOX_READY) readyResolve(Object.freeze({ generation: expectedGeneration, sandboxToken: token }));
  }
  windowRef.addEventListener('message', onMessage);
  signal?.addEventListener?.('abort', onAbort, { once: true });
  if (timeoutMs > 0) {
    timer = setTimeout(() => {
      const error = stageError('sandbox-bootstrap', 'Hex sandbox bootstrap timed out.');
      readyReject(error);
      failureResolve(error);
      cleanup();
    }, timeoutMs);
  }
  return Object.freeze({ ready, failure, close: cleanup });
}

async function raceSandboxFailure(operation, failure) {
  return Promise.race([operation, failure.then((error) => Promise.reject(error))]);
}

function normalizeRuntimeSource(value) {
  if (!(value instanceof ArrayBuffer)) throw stageError('runtime-source', 'Protected runtime source must be an ArrayBuffer.');
  if (!value.byteLength || value.byteLength > MAX_RUNTIME_BYTES) throw stageError('runtime-source', 'Protected runtime source has an invalid size.');
  return value;
}
function normalizeRuntimeContentHash(value) {
  const text = String(value || '').trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(text)) throw stageError('runtime-source', 'Protected runtime content hash is invalid.');
  return text;
}
function normalizeVirtualSrc(value) {
  const url = new URL(String(value || ''));
  if (url.protocol !== 'https:') throw new TypeError('Hex virtual embed URL must use HTTPS.');
  return url.href;
}
function normalizeHttpsOrigin(value) {
  const text = String(value || '');
  const url = new URL(text);
  if (url.protocol !== 'https:' || url.origin !== text) throw new TypeError('Expected an exact HTTPS origin.');
  return url.origin;
}
function normalizeNonce(value, required = true) {
  const text = String(value || '').trim();
  if (!text) {
    if (required) throw new Error('ChatGPT CSP nonce is unavailable.');
    return '';
  }
  if (text.length > 512 || /[\s"'<>]/.test(text)) throw new Error('ChatGPT CSP nonce is invalid.');
  return text;
}
function normalizeTimeout(value, fallback) {
  if (value == null) return fallback;
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) throw new TypeError('Embed timeout must be a non-negative finite number.');
  return Math.floor(number);
}
function stageFor(error) { return String(error?.stage || error?.code || 'sandbox-startup').toLowerCase(); }
function stageError(stage, message) { const error = new Error(String(message || 'failed')); error.stage = stage; return error; }
function abortError(reason) { const error = new Error(typeof reason === 'string' && reason ? reason : 'Hex sandbox startup was aborted.'); error.name = 'AbortError'; return error; }
function isAbortError(error) { return error?.name === 'AbortError'; }
function closePort(value) { try { value?.close?.(); } catch {} }
function escapeAttribute(value) { return String(value).replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;'); }
function safeActiveElement(documentRef) { try { return documentRef.activeElement || null; } catch { return null; } }
function restoreFocus(element, documentRef) { try { if (element && documentRef?.contains?.(element) && typeof element.focus === 'function') element.focus(); } catch {} }

function ensureWrapper(documentRef) {
  let wrapper = documentRef.getElementById?.(HOST_ID);
  if (wrapper) return wrapper;
  wrapper = documentRef.createElement('div');
  wrapper.id = HOST_ID;
  wrapper.style.cssText = 'position:fixed;inset:0;width:100vw;height:100dvh;z-index:2147483646;overflow:hidden;background:#fff;visibility:hidden;pointer-events:none;';
  documentRef.documentElement.append(wrapper);
  return wrapper;
}
function ensureLauncher(documentRef) {
  let button = documentRef.getElementById?.(LAUNCHER_ID);
  if (button) return button;
  button = documentRef.createElement('button');
  button.id = LAUNCHER_ID;
  button.type = 'button';
  button.textContent = 'HEX';
  button.style.cssText = 'position:fixed;right:12px;bottom:max(12px,env(safe-area-inset-bottom));z-index:2147483647;min-width:54px;min-height:44px;padding:8px 12px;border:0;border-radius:12px;background:#111827;color:#fff;font:600 13px/1.2 -apple-system,BlinkMacSystemFont,system-ui,sans-serif;box-shadow:0 4px 18px rgba(0,0,0,.28);';
  documentRef.documentElement.append(button);
  return button;
}
function ensureClose(documentRef) {
  let button = documentRef.getElementById?.(CLOSE_ID);
  if (button) return button;
  button = documentRef.createElement('button');
  button.id = CLOSE_ID;
  button.type = 'button';
  button.textContent = '×';
  button.setAttribute('aria-label', 'Close Hex');
  button.style.cssText = 'position:fixed;right:max(12px,env(safe-area-inset-right));top:max(12px,env(safe-area-inset-top));z-index:2147483647;width:48px;height:48px;border:0;border-radius:14px;background:#111827;color:#fff;font:700 26px/1 system-ui;box-shadow:0 4px 18px rgba(0,0,0,.22);';
  documentRef.documentElement.append(button);
  return button;
}
function ensureStatus(documentRef, wrapper) {
  let node = documentRef.getElementById?.(STATUS_ID);
  if (node) return node;
  node = documentRef.createElement('div');
  node.id = STATUS_ID;
  node.setAttribute('role', 'status');
  node.style.cssText = 'position:absolute;left:16px;bottom:max(16px,env(safe-area-inset-bottom));z-index:2;max-width:min(88vw,620px);padding:10px 14px;border-radius:12px;background:#111827;color:#fff;font:600 13px/1.35 system-ui;white-space:pre-wrap;box-shadow:0 4px 18px rgba(0,0,0,.22);cursor:default;';
  wrapper.append(node);
  return node;
}
function setStatus(node, text, hidden, failed = false) {
  if (!node) return;
  node.textContent = text;
  node.hidden = !!hidden;
  node.dataset.failed = failed ? 'true' : 'false';
  node.style.cursor = failed ? 'pointer' : 'default';
}
