import { PROTECTED_HOST } from '../../.runtime-build/embedded-assets.js';
import { setUiRoot } from '../ui-root.js';
import { installChatGPTWebBridge } from './chatgpt-bridge.js';
import { createChatGPTParentRpc } from './chatgpt-parent-rpc.js';
import { createChatGPTSandboxHost, findChatGPTCspNonce } from './chatgpt-sandbox-host.js';
import { setEmbedProvider } from './embed-bootstrap.js';
import { installProtectedWorkers } from './protected-workers.js';
import { installUserscriptNetworkBridge } from './network.js';

const PROVIDER_KEY = 'hex.ai.provider';
const EMBED_MODE_KEY = 'hex.embed.mode';
const SANDBOX_MODE = 'sandbox-v2';
const OLD_IFRAME_MODE = 'iframe-v1';
const LEGACY_MODE = 'legacy-light-dom';
const SESSION_CLEANUP_KEY = '__HEX_CHATGPT_EMBED_CLEANUP__';
const SANDBOX_BOOTSTRAP_TIMEOUT_MS = 60000;
const SANDBOX_READY_TIMEOUT_MS = 60000;

export async function startChatGPTUserscript(options = {}) {
  const apiOrigin = normalizeApiOrigin(options.apiOrigin || globalThis.__HEX_API_BASE__ || globalThis.__HEX_RUNTIME_ORIGIN__ || location.origin);
  const bridge = installChatGPTWebBridge();
  globalThis.__HEX_API_BASE__ = apiOrigin;
  globalThis.__HEX_AI_PROVIDER__ = readProvider();

  cleanupPreviousSession();

  if (readEmbedMode() === LEGACY_MODE) {
    const result = await startLegacy({ bridge });
    return Object.freeze({ mode: LEGACY_MODE, ...result });
  }

  const result = await startSandbox({
    apiOrigin,
    bridge,
    runtimeSourceProvider: options.runtimeSourceProvider,
    loaderVersion: options.loaderVersion,
    buildId: options.buildId,
  });
  return Object.freeze({ mode: SANDBOX_MODE, ...result });
}

async function startSandbox(options) {
  if (typeof options.runtimeSourceProvider !== 'function') {
    throw new Error('Protected runtime source is unavailable for the ChatGPT sandbox.');
  }
  const cspNonce = findChatGPTCspNonce(document);
  if (!cspNonce) throw new Error('ChatGPT CSP nonce is unavailable for the Hex sandbox.');

  const virtualSrc = setEmbedProvider(new URL('/embed/chatgpt', options.apiOrigin).href, globalThis.__HEX_AI_PROVIDER__);
  let resolveReady;
  let rejectReady;
  let settled = false;
  const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });

  const host = createChatGPTSandboxHost({
    hostHtml: PROTECTED_HOST.html,
    cspNonce,
    virtualSrc,
    loaderVersion: String(options.loaderVersion || ''),
    buildId: String(options.buildId || ''),
    runtimeSourceProvider: options.runtimeSourceProvider,
    bootstrapTimeoutMs: SANDBOX_BOOTSTRAP_TIMEOUT_MS,
    readyTimeoutMs: SANDBOX_READY_TIMEOUT_MS,
    onPort(port) {
      const parentRpc = createChatGPTParentRpc({
        port,
        bridge: options.bridge,
        onUiClose: () => host.hide(),
      });
      return () => parentRpc.close();
    },
    onReady(info) {
      if (settled) return;
      settled = true;
      resolveReady(info);
    },
    onFailure(failure) {
      if (settled) return;
      settled = true;
      const error = new Error(`${failure.stage}: ${failure.message}`);
      error.stage = failure.stage;
      rejectReady(error);
    },
  });

  installSessionCleanup(() => host.destroy());
  const info = await ready;
  host.show();
  return Object.freeze({ host, bridge: options.bridge, info });
}

async function startLegacy({ bridge }) {
  const host = ensureLegacyHost();
  setUiRoot(host);
  host.lang = navigator.language || 'ja';
  ensureLegacyStyle();
  installUserscriptNetworkBridge();
  installProtectedWorkers();
  const launcher = installLegacyLauncher(host);
  installSessionCleanup(() => {
    try { host.remove(); } catch {}
    try { launcher.remove(); } catch {}
    try { document.getElementById('hex-userscript-style')?.remove(); } catch {}
  });
  try {
    setLegacyLauncherState(launcher, 'Preparing Hex…', true);
    await import('../app.js');
    await import('../ux.js');
    setLegacyLauncherState(launcher, 'HEX', false);
    await revealLegacyWhenReady(host, launcher, bridge);
    return Object.freeze({ host, launcher, bridge });
  } catch (error) {
    showLegacyFailure(launcher, error);
    throw error;
  }
}

function ensureLegacyHost() {
  let host = document.getElementById('hex-userscript-host');
  if (host) return host;
  host = document.createElement('div');
  host.id = 'hex-userscript-host';
  host.style.cssText = 'position:fixed;inset:0;z-index:2147483646;visibility:hidden;pointer-events:none;background:#fff;';
  host.setAttribute('aria-hidden', 'true');
  host.innerHTML = PROTECTED_HOST.html;
  document.documentElement.append(host);
  return host;
}

function ensureLegacyStyle() {
  let style = document.getElementById('hex-userscript-style');
  if (style) return style;
  style = document.createElement('style');
  style.id = 'hex-userscript-style';
  style.textContent = PROTECTED_HOST.scopedCss;
  document.head.append(style);
  return style;
}

function installLegacyLauncher(host) {
  let button = document.getElementById('hex-userscript-launcher');
  if (button) return button;
  button = document.createElement('button');
  button.id = 'hex-userscript-launcher';
  button.type = 'button';
  button.textContent = 'HEX';
  Object.assign(button.style, {
    position: 'fixed', right: '12px', bottom: '12px', zIndex: '2147483647',
    minWidth: '54px', minHeight: '44px', padding: '8px 12px', border: '0',
    borderRadius: '12px', background: '#111827', color: '#fff',
    font: '600 13px/1.2 -apple-system,BlinkMacSystemFont,system-ui,sans-serif',
    boxShadow: '0 4px 18px rgba(0,0,0,.28)', cursor: 'pointer',
  });
  button.hidden = true;
  button.addEventListener('click', () => showLegacy(host, button));
  document.documentElement.append(button);
  return button;
}

async function revealLegacyWhenReady(host, launcher, bridge) {
  if (bridge.status().ready) { showLegacy(host, launcher); return; }
  launcher.hidden = false;
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    await sleep(200);
    if (bridge.status().ready) { showLegacy(host, launcher); return; }
  }
}

function showLegacy(host, launcher) {
  if (!host || launcher.disabled) return;
  host.style.visibility = 'visible';
  host.style.pointerEvents = 'auto';
  host.removeAttribute('aria-hidden');
  launcher.hidden = true;
}

function setLegacyLauncherState(launcher, text, busy) {
  launcher.textContent = text;
  launcher.disabled = !!busy;
  launcher.style.opacity = busy ? '0.72' : '1';
}

function showLegacyFailure(launcher, error) {
  const message = String(error?.message || error || 'Unknown startup error.');
  launcher.hidden = false;
  launcher.disabled = false;
  launcher.textContent = 'Hex failed — tap for details';
  launcher.onclick = () => alert(`Hex failed to start:\n${message}`);
}

function cleanupPreviousSession() {
  try {
    const cleanup = globalThis[SESSION_CLEANUP_KEY];
    if (typeof cleanup === 'function') cleanup();
  } catch {}
  try { delete globalThis[SESSION_CLEANUP_KEY]; } catch { globalThis[SESSION_CLEANUP_KEY] = null; }
  for (const id of ['hex-userscript-iframe-host', 'hex-userscript-iframe', 'hex-userscript-launcher', 'hex-userscript-emergency-close', 'hex-userscript-host']) {
    try { document.getElementById(id)?.remove(); } catch {}
  }
}

function installSessionCleanup(cleanup) {
  globalThis[SESSION_CLEANUP_KEY] = () => {
    try { cleanup(); } finally {
      try { delete globalThis[SESSION_CLEANUP_KEY]; } catch { globalThis[SESSION_CLEANUP_KEY] = null; }
    }
  };
}

function normalizeApiOrigin(value) {
  const url = new URL(String(value || ''));
  if (url.protocol !== 'https:' || url.origin !== String(value || '')) throw new Error('Hex API origin is invalid.');
  return url.origin;
}

function readProvider() {
  try { return localStorage.getItem(PROVIDER_KEY) === 'gemini' ? 'gemini' : 'chatgpt'; }
  catch { return 'chatgpt'; }
}

function readEmbedMode() {
  const forced = globalThis.__HEX_EMBED_MODE__;
  if (forced === LEGACY_MODE) return LEGACY_MODE;
  if (forced === SANDBOX_MODE || forced === OLD_IFRAME_MODE) return SANDBOX_MODE;
  try {
    const stored = localStorage.getItem(EMBED_MODE_KEY);
    return stored === LEGACY_MODE ? LEGACY_MODE : SANDBOX_MODE;
  } catch {
    return SANDBOX_MODE;
  }
}

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

export default startChatGPTUserscript;
