import {
  EMBED_PROTOCOL,
  EMBED_PROTOCOL_VERSION,
  createEmbedNonce,
  waitForEmbedReady,
} from './embed-protocol.js';

const DEFAULT_LOAD_TIMEOUT_MS = 20000;
const DEFAULT_READY_TIMEOUT_MS = 30000;
const HOST_ID = 'hex-userscript-iframe-host';
const LAUNCHER_ID = 'hex-userscript-launcher';

export function createChatGPTIframeHost(options = {}) {
  const {
    src,
    onPort,
    documentRef = globalThis.document,
    windowRef = globalThis.window,
    MessageChannelCtor = globalThis.MessageChannel,
    loadTimeoutMs = DEFAULT_LOAD_TIMEOUT_MS,
    readyTimeoutMs = DEFAULT_READY_TIMEOUT_MS,
  } = options;

  if (typeof onPort !== 'function') throw new TypeError('onPort must be a synchronous function.');
  if (!documentRef?.createElement || !documentRef?.documentElement) throw new TypeError('A document is required.');
  if (typeof MessageChannelCtor !== 'function') throw new TypeError('MessageChannel is required.');

  const parsedSrc = new URL(String(src || ''));
  if (parsedSrc.protocol !== 'https:') throw new TypeError('Hex iframe src must use HTTPS.');
  const iframeSrc = parsedSrc.href;
  const childOrigin = parsedSrc.origin;
  const normalizedLoadTimeoutMs = normalizeTimeout(loadTimeoutMs, DEFAULT_LOAD_TIMEOUT_MS);
  const normalizedReadyTimeoutMs = normalizeTimeout(readyTimeoutMs, DEFAULT_READY_TIMEOUT_MS);
  const setTimer = typeof windowRef?.setTimeout === 'function' ? windowRef.setTimeout.bind(windowRef) : setTimeout;
  const clearTimer = typeof windowRef?.clearTimeout === 'function' ? windowRef.clearTimeout.bind(windowRef) : clearTimeout;

  const wrapper = documentRef.createElement('div');
  wrapper.id = HOST_ID;
  wrapper.setAttribute('aria-hidden', 'true');
  Object.assign(wrapper.style, {
    position: 'fixed',
    inset: '0',
    height: '100dvh',
    zIndex: '2147483646',
    overflow: 'hidden',
    visibility: 'hidden',
    pointerEvents: 'none',
    background: '#fff',
  });

  const iframe = documentRef.createElement('iframe');
  iframe.title = 'Hex';
  iframe.referrerPolicy = 'no-referrer';
  Object.assign(iframe.style, {
    display: 'block',
    width: '100%',
    height: '100%',
    border: '0',
  });

  const closeButton = documentRef.createElement('button');
  closeButton.type = 'button';
  closeButton.textContent = 'Close Hex';
  closeButton.setAttribute('aria-label', 'Close Hex');
  Object.assign(closeButton.style, {
    position: 'absolute',
    top: 'calc(8px + env(safe-area-inset-top, 0px))',
    right: 'calc(8px + env(safe-area-inset-right, 0px))',
    zIndex: '2',
    minWidth: '44px',
    minHeight: '44px',
  });

  const statusBox = documentRef.createElement('div');
  statusBox.setAttribute('role', 'status');
  Object.assign(statusBox.style, {
    position: 'absolute',
    left: '12px',
    bottom: 'calc(12px + env(safe-area-inset-bottom, 0px))',
    zIndex: '2',
    padding: '8px 10px',
    background: 'rgba(17,24,39,.9)',
    color: '#fff',
    font: '600 13px/1.3 -apple-system,BlinkMacSystemFont,system-ui,sans-serif',
    borderRadius: '8px',
  });
  statusBox.textContent = 'Loading Hex…';

  const errorBox = documentRef.createElement('div');
  errorBox.setAttribute('role', 'alert');
  errorBox.hidden = true;
  Object.assign(errorBox.style, {
    position: 'absolute',
    left: '50%',
    top: '50%',
    transform: 'translate(-50%, -50%)',
    zIndex: '3',
    maxWidth: 'min(420px, calc(100% - 32px))',
    padding: '16px',
    background: '#fff',
    color: '#111827',
    border: '1px solid rgba(0,0,0,.18)',
    borderRadius: '12px',
    boxShadow: '0 8px 30px rgba(0,0,0,.25)',
    font: '14px/1.4 -apple-system,BlinkMacSystemFont,system-ui,sans-serif',
  });
  const errorTitle = documentRef.createElement('strong');
  errorTitle.textContent = 'Hex failed';
  const errorStage = documentRef.createElement('div');
  const errorMessage = documentRef.createElement('div');
  const retryButton = documentRef.createElement('button');
  retryButton.type = 'button';
  retryButton.textContent = 'Retry';
  retryButton.style.minWidth = '44px';
  retryButton.style.minHeight = '44px';
  errorBox.append(errorTitle, errorStage, errorMessage, retryButton);

  const launcher = documentRef.createElement('button');
  launcher.id = LAUNCHER_ID;
  launcher.type = 'button';
  launcher.textContent = 'HEX';
  Object.assign(launcher.style, {
    position: 'fixed',
    right: '12px',
    bottom: 'calc(12px + env(safe-area-inset-bottom, 0px))',
    zIndex: '2147483647',
    minWidth: '54px',
    minHeight: '44px',
  });

  wrapper.append(iframe, closeButton, statusBox, errorBox);
  documentRef.documentElement.append(wrapper, launcher);

  let lifecycle = 'idle';
  let generation = 0;
  let desiredVisible = false;
  let previousActiveElement = null;
  let destroyed = false;
  let loadTimer = null;
  let activeGeneration = null;
  let failure = null;

  const onLoad = () => startHandshake();
  const onLauncherClick = () => show();
  const onCloseClick = () => hide();
  const onRetryClick = () => reload();
  iframe.addEventListener('load', onLoad);
  launcher.addEventListener('click', onLauncherClick);
  closeButton.addEventListener('click', onCloseClick);
  retryButton.addEventListener('click', onRetryClick);

  function state() {
    return Object.freeze({
      status: lifecycle,
      generation,
      visible: desiredVisible,
      childOrigin,
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
    if (lifecycle === 'idle') navigate();
    else if (lifecycle === 'ready' || lifecycle === 'hidden') lifecycle = 'visible';
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
    if (destroyed) return state();
    navigate();
    return state();
  }

  function destroy() {
    if (destroyed) return;
    destroyed = true;
    lifecycle = 'destroyed';
    clearLoadTimer();
    cleanupGeneration(activeGeneration);
    iframe.removeEventListener('load', onLoad);
    launcher.removeEventListener('click', onLauncherClick);
    closeButton.removeEventListener('click', onCloseClick);
    retryButton.removeEventListener('click', onRetryClick);
    safeRemove(wrapper);
    safeRemove(launcher);
  }

  function navigate() {
    clearLoadTimer();
    cleanupGeneration(activeGeneration);
    failure = null;
    lifecycle = 'loading';
    statusBox.hidden = false;
    statusBox.textContent = 'Loading Hex…';
    errorBox.hidden = true;
    armLoadTimer();
    iframe.src = iframeSrc;
  }

  function startHandshake() {
    if (destroyed) return;
    clearLoadTimer();
    cleanupGeneration(activeGeneration);
    const currentGeneration = ++generation;
    lifecycle = 'handshaking';
    statusBox.hidden = false;
    statusBox.textContent = 'Starting Hex…';
    errorBox.hidden = true;

    const controller = new AbortController();
    const channel = new MessageChannelCtor();
    const nonce = createEmbedNonce();
    const current = {
      generation: currentGeneration,
      controller,
      parentPort: channel.port1,
      childPort: channel.port2,
      cleanup: null,
      transferred: false,
    };
    activeGeneration = current;

    try {
      const cleanup = onPort(channel.port1, Object.freeze({
        nonce,
        generation: currentGeneration,
        childOrigin,
        iframe,
      }));
      if (cleanup && typeof cleanup.then === 'function') {
        throw new TypeError('onPort must install RPC listeners synchronously.');
      }
      if (cleanup !== undefined && typeof cleanup !== 'function') {
        throw new TypeError('onPort must return a cleanup function or undefined.');
      }
      current.cleanup = cleanup || null;

      const targetWindow = iframe.contentWindow;
      if (!targetWindow || typeof targetWindow.postMessage !== 'function') throw new Error('Hex iframe window is unavailable.');
      targetWindow.postMessage({
        type: 'hex.embed.attach',
        protocol: EMBED_PROTOCOL,
        version: EMBED_PROTOCOL_VERSION,
        nonce,
      }, childOrigin, [channel.port2]);
      current.transferred = true;
    } catch (error) {
      fail(currentGeneration, 'handshake/app-ready', error);
      return;
    }

    waitForEmbedReady(channel.port1, {
      nonce,
      timeoutMs: normalizedReadyTimeoutMs,
      signal: controller.signal,
    }).then(() => {
      if (!isCurrentGeneration(currentGeneration)) return;
      failure = null;
      statusBox.hidden = true;
      errorBox.hidden = true;
      lifecycle = 'ready';
      lifecycle = desiredVisible ? 'visible' : 'hidden';
    }).catch((error) => {
      if (!isCurrentGeneration(currentGeneration) || controller.signal.aborted) return;
      fail(currentGeneration, 'handshake/app-ready', error);
    });
  }

  function fail(failedGeneration, stage, error) {
    if (destroyed) return;
    if (failedGeneration != null && activeGeneration?.generation !== failedGeneration) return;
    clearLoadTimer();
    cleanupGeneration(activeGeneration);
    lifecycle = 'failed';
    failure = { stage, message: safeErrorMessage(error) };
    statusBox.hidden = true;
    errorStage.textContent = `Stage: ${stage}`;
    errorMessage.textContent = failure.message;
    errorBox.hidden = false;
    if (!desiredVisible) launcher.hidden = false;
  }

  function armLoadTimer() {
    if (normalizedLoadTimeoutMs === 0) return;
    loadTimer = setTimer(() => {
      loadTimer = null;
      if (destroyed || lifecycle !== 'loading') return;
      fail(null, 'iframe-load', new Error('Hex iframe load timed out.'));
    }, normalizedLoadTimeoutMs);
  }

  function clearLoadTimer() {
    if (loadTimer === null) return;
    clearTimer(loadTimer);
    loadTimer = null;
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
    if (!target || typeof target.focus !== 'function') return;
    if (!isConnectedToDocument(documentRef, target)) return;
    safeFocus(target);
  }

  return Object.freeze({
    show,
    hide,
    reload,
    destroy,
    state,
    iframe,
    wrapper,
    launcher,
    closeButton,
    retryButton,
  });
}

function normalizeTimeout(value, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) return fallback;
  return Math.floor(number);
}

function safeErrorMessage(error) {
  const message = error?.message;
  if (typeof message === 'string' && message.trim()) return message.slice(0, 240);
  return 'Hex could not start.';
}

function safeClose(port) {
  try { port?.close?.(); } catch {}
}

function safeRemove(node) {
  try { node?.remove?.(); } catch {}
}

function safeFocus(target) {
  try { target?.focus?.(); } catch {}
}

function safeActiveElement(documentRef) {
  try { return documentRef.activeElement || null; } catch { return null; }
}

function isConnectedToDocument(documentRef, node) {
  try {
    if (typeof documentRef.contains === 'function') return documentRef.contains(node);
    return documentRef.documentElement?.contains?.(node) === true;
  } catch {
    return false;
  }
}
