import { PROTECTED_HOST } from '../../.runtime-build/embedded-assets.js';
import { setUiRoot } from '../ui-root.js';
import { installChatGPTWebBridge } from './chatgpt-bridge.js';
import { createChatGPTParentRpc } from './chatgpt-parent-rpc.js';
import { createChatGPTSandboxHost, findChatGPTCspNonce } from './chatgpt-sandbox-host.js';
import { LEGACY_MODE, SANDBOX_MODE, readTrustedEmbedMode } from './embed-mode.js';
import { DEV_BOOTSTRAP_PARAM, readDevBootstrapRequested, setEmbedProvider } from './embed-bootstrap.js';
import { installProtectedWorkers } from './protected-workers.js';
import { installUserscriptNetworkBridge } from './network.js';
import { startParentDevWorkerRuntime } from './dev/parent-worker-runtime.js';
import { createDevWorkerParentRpc } from './dev/parent-rpc.js';
import { installDevBootstrapHost } from './dev/bootstrap-host.js';

const PROVIDER_KEY = 'hex.ai.provider';
const SESSION_CLEANUP_KEY = '__HEX_CHATGPT_EMBED_CLEANUP__';
const SANDBOX_BOOTSTRAP_TIMEOUT_MS = 60000;
const SANDBOX_READY_TIMEOUT_MS = 60000;

export async function startChatGPTUserscript(options = {}) {
  const apiOrigin = normalizeApiOrigin(options.apiOrigin || globalThis.__HEX_API_BASE__ || globalThis.__HEX_RUNTIME_ORIGIN__ || location.origin);
  globalThis.__HEX_API_BASE__ = apiOrigin;

  cleanupPreviousSession();

  const devWorkerRuntime = await startParentDevWorkerRuntime({
    ...(options.devWorkerOptions || {}),
  });

  const bridge = installChatGPTWebBridge();
  globalThis.__HEX_AI_PROVIDER__ = readProvider();

  if (readEmbedMode() === LEGACY_MODE) {
    globalThis.__HEX_DEV_WORKER_CLIENT__ = devWorkerRuntime;
    const result = await startLegacy({ bridge, devWorkerRuntime });
    return Object.freeze({ mode: LEGACY_MODE, ...result, devWorkerRuntime });
  }

  try {
    const result = await startSandbox({
      apiOrigin,
      bridge,
      devWorkerRuntime,
      runtimeSourceProvider: options.runtimeSourceProvider,
      loaderVersion: options.loaderVersion,
      buildId: options.buildId,
      sourceCommit: options.sourceCommit,
      runtimeContentHash: options.runtimeContentHash,
    });
    return Object.freeze({ mode: SANDBOX_MODE, ...result, devWorkerRuntime });
  } catch (error) {
    devWorkerRuntime.close();
    throw error;
  }
}

async function startSandbox(options) {
  if (typeof options.runtimeSourceProvider !== 'function') {
    throw new Error('Protected runtime source is unavailable for the ChatGPT sandbox.');
  }
  const cspNonce = findChatGPTCspNonce(document);
  if (!cspNonce) throw new Error('ChatGPT CSP nonce is unavailable for the Hex sandbox.');

  const sourceCommit = normalizeCommit(options.sourceCommit);
  const buildId = normalizeBuildId(options.buildId);
  const bootstrapEnabled = !!sourceCommit && !!buildId && readDevBootstrapRequested(globalThis.location);
  const virtualUrl = new URL(setEmbedProvider(new URL('/embed/chatgpt', options.apiOrigin).href, globalThis.__HEX_AI_PROVIDER__));
  if (bootstrapEnabled) virtualUrl.searchParams.set(DEV_BOOTSTRAP_PARAM, '1');
  let resolveReady;
  let rejectReady;
  let settled = false;
  const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });

  const host = createChatGPTSandboxHost({
    hostHtml: PROTECTED_HOST.html,
    cspNonce,
    virtualSrc: virtualUrl.href,
    loaderVersion: String(options.loaderVersion || ''),
    buildId: String(options.buildId || ''),
    runtimeContentHash: String(options.runtimeContentHash || ''),
    runtimeSourceProvider: options.runtimeSourceProvider,
    bootstrapTimeoutMs: SANDBOX_BOOTSTRAP_TIMEOUT_MS,
    readyTimeoutMs: SANDBOX_READY_TIMEOUT_MS,
    onPort(port) {
      const parentRpc = createChatGPTParentRpc({
        port,
        bridge: options.bridge,
        onUiClose: () => host.hide(),
      });
      const devRpc = createDevWorkerParentRpc({ port, runtime: options.devWorkerRuntime });
      return () => {
        devRpc.close();
        parentRpc.close();
      };
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

  const bootstrapHost = bootstrapEnabled
    ? installDevBootstrapHost({ host, runtimeIdentity: { commit: sourceCommit, buildId } })
    : null;

  // The protected Hex panel already owns its own visibility controls. The
  // full-screen host's extra floating emergency close button obscures ChatGPT
  // on iPad and is not needed for normal operation.
  try { document.getElementById('hex-userscript-emergency-close')?.remove(); } catch {}

  installSessionCleanup(() => {
    bootstrapHost?.close();
    host.destroy();
    options.devWorkerRuntime.close();
  });
  const info = await ready;
  host.show();
  return Object.freeze({ host, bridge: options.bridge, info, bootstrapHost });
}

async function startLegacy({ bridge, devWorkerRuntime }) {
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
    devWorkerRuntime.close();
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
  const style = document.createElement('style');
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

function normalizeCommit(value) {
  const text = String(value || '').trim().toLowerCase();
  return /^[0-9a-f]{40}$/.test(text) ? text : null;
}

function normalizeBuildId(value) {
  const text = String(value || '').trim().toLowerCase();
  return /^[0-9a-f]{24}$/.test(text) ? text : null;
}

function readProvider() {
  try { return localStorage.getItem(PROVIDER_KEY) === 'gemini' ? 'gemini' : 'chatgpt'; }
  catch { return 'chatgpt'; }
}

function readEmbedMode() { return readTrustedEmbedMode(); }

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

export default startChatGPTUserscript;