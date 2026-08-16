import { PROTECTED_HOST, PROTECTED_OPAQUE_EMBED_RUNTIME } from '../../.runtime-build/embedded-assets.js';
import { setUiRoot } from '../ui-root.js';
import { installChatGPTWebBridge } from './chatgpt-bridge.js';
import { createChatGPTParentRpc } from './chatgpt-parent-rpc.js';
import { createChatGPTIframeHost } from './chatgpt-iframe-host.js';
import { setEmbedProvider } from './embed-bootstrap.js';
import { installProtectedWorkers } from './protected-workers.js';
import { installUserscriptNetworkBridge } from './network.js';

const PROVIDER_KEY = 'hex.ai.provider';
const EMBED_MODE_KEY = 'hex.embed.mode';
const IFRAME_MODE = 'iframe-v1';
const LEGACY_MODE = 'legacy-light-dom';
const apiOrigin = new URL(globalThis.__HEX_API_BASE__ || globalThis.__HEX_RUNTIME_ORIGIN__ || location.origin, location.href).origin;
const bridge = installChatGPTWebBridge();

globalThis.__HEX_API_BASE__ = apiOrigin;
globalThis.__HEX_AI_PROVIDER__ = readProvider();

let iframeHost = null;
let legacyPromise = null;

boot().catch((error) => showFatal(error));

async function boot() {
  if (readEmbedMode() === LEGACY_MODE) {
    await startLegacy();
    return;
  }
  /* iframe-v1 is the production path. Never silently replace a failed canonical
     iframe with the old scoped light-DOM renderer: that hid startup defects and
     produced a visibly incomplete UI on iOS. Legacy remains an explicit opt-in
     escape hatch only. */
  await startIframe();
}

async function startIframe() {
  let resolveReady;
  let rejectReady;
  const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  const src = setEmbedProvider(new URL('/embed/chatgpt', apiOrigin).href, globalThis.__HEX_AI_PROVIDER__);
  if (!PROTECTED_OPAQUE_EMBED_RUNTIME) throw new Error('Protected opaque embed runtime is unavailable.');

  iframeHost = createChatGPTIframeHost({
    src,
    runtimeSource: PROTECTED_OPAQUE_EMBED_RUNTIME,
    provider: globalThis.__HEX_AI_PROVIDER__,
    onPort(port) {
      const parentRpc = createChatGPTParentRpc({
        port,
        bridge,
        onUiClose: () => iframeHost?.hide(),
      });
      return () => parentRpc.close();
    },
    onReady: () => resolveReady(),
    onFailure: (failure) => {
      const error = new Error(`${failure.stage}: ${failure.message}`);
      error.stage = failure.stage;
      rejectReady(error);
    },
  });

  await ready;
  await revealIframeWhenReady(iframeHost);
}

async function revealIframeWhenReady(host) {
  if (!host) return;
  if (bridge.status().ready) { host.show(); return; }
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline && host.state().status !== 'destroyed') {
    await sleep(200);
    if (bridge.status().ready) { host.show(); return; }
  }
  /* The host launcher remains visible. This preserves manual access for Gemini
     and for ChatGPT pages whose composer is intentionally not ready yet. */
}

function startLegacy(cause = null) {
  if (legacyPromise) return legacyPromise;
  legacyPromise = (async () => {
    const host = ensureLegacyHost();
    setUiRoot(host);
    host.lang = navigator.language || 'ja';
    ensureLegacyStyle();
    installUserscriptNetworkBridge();
    installProtectedWorkers();
    const launcher = installLegacyLauncher(host);
    try {
      setLegacyLauncherState(launcher, 'Preparing Hex…', true);
      await import('../app.js');
      await import('../ux.js');
      setLegacyLauncherState(launcher, 'HEX', false);
      await revealLegacyWhenReady(host, launcher);
    } catch (error) {
      showLegacyFailure(launcher, error, cause);
      throw error;
    }
  })();
  return legacyPromise;
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

async function revealLegacyWhenReady(host, launcher) {
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

function showLegacyFailure(launcher, error, iframeCause) {
  const message = String(error?.message || error || 'Unknown startup error.');
  const prefix = iframeCause ? 'iframe fallback failed; ' : '';
  launcher.hidden = false;
  launcher.disabled = false;
  launcher.textContent = 'Hex failed — tap for details';
  launcher.onclick = () => alert(`Hex failed to start:\n${prefix}${message}`);
}

function showFatal(error) {
  console.error('[hex userscript] boot failed', error);
  let button = document.getElementById('hex-userscript-launcher');
  if (!button) {
    button = document.createElement('button');
    button.id = 'hex-userscript-launcher';
    document.documentElement.append(button);
  }
  button.hidden = false;
  button.disabled = false;
  button.textContent = 'Hex failed — tap for details';
  button.onclick = () => alert(`Hex failed to start:\n${error?.message || error}`);
}

function readProvider() {
  try { return localStorage.getItem(PROVIDER_KEY) === 'gemini' ? 'gemini' : 'chatgpt'; }
  catch { return 'chatgpt'; }
}

function readEmbedMode() {
  const forced = globalThis.__HEX_EMBED_MODE__;
  if (forced === LEGACY_MODE || forced === IFRAME_MODE) return forced;
  try { return localStorage.getItem(EMBED_MODE_KEY) === LEGACY_MODE ? LEGACY_MODE : IFRAME_MODE; }
  catch { return IFRAME_MODE; }
}

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
