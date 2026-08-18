import { PROTECTED_HOST } from '../../.runtime-build/embedded-assets.js';
import { setUiRoot } from '../ui-root.js';
import { installProtectedWorkers } from './protected-workers.js';
import { runtimeHostSnapshotFromGlobals, runtimeLocationFromSnapshot } from './runtime-host-location.js';
import { installOpaqueSandboxStorage } from './sandbox-storage.js';
import {
  PROTECTED_RUNTIME_CONTEXT,
  classifyProtectedRuntime,
  startEmbedChildRuntime,
} from './embed-child.js';

export async function startProtectedRuntime(options = {}) {
  const runtimeLocation = runtimeLocationFromSnapshot(options.hostLocation || runtimeHostSnapshotFromGlobals());
  const apiOrigin = normalizeApiOrigin(options.apiOrigin || globalThis.__HEX_RUNTIME_ORIGIN__ || runtimeLocation.origin);
  const context = classifyProtectedRuntime({ location: runtimeLocation, apiOrigin, window });
  if (context !== PROTECTED_RUNTIME_CONTEXT.LEGACY_CHATGPT && runtimeLocation.origin !== apiOrigin) {
    throw new Error(`Hex protected runtime origin mismatch (${runtimeLocation.origin || 'unknown'} != ${apiOrigin}).`);
  }
  globalThis.__HEX_API_BASE__ = apiOrigin;

  if (context === PROTECTED_RUNTIME_CONTEXT.LEGACY_CHATGPT) {
    const entry = await import('./entry.js');
    if (typeof entry?.startChatGPTUserscript !== 'function') throw new Error('ChatGPT userscript entry point is unavailable.');
    return entry.startChatGPTUserscript({
      apiOrigin,
      runtimeLocation,
      runtimeSourceProvider: options.runtimeSourceProvider,
      loaderVersion: String(options.loaderVersion || globalThis.__HEX_SECURE_LOADER__?.version || ''),
      buildId: String(options.buildId || globalThis.__HEX_SECURE_LOADER__?.buildId || ''),
      sourceCommit: normalizeCommit(options.sourceCommit || globalThis.__HEX_DEPLOYMENT_COMMIT__),
      runtimeContentHash: String(options.runtimeContentHash || ''),
    });
  }

  if (context === PROTECTED_RUNTIME_CONTEXT.EMBED_CHATGPT) {
    return startEmbedChildRuntime({ cssText: PROTECTED_HOST.css, location: runtimeLocation });
  }

  const host = document.documentElement;
  setUiRoot(host);
  host.lang = navigator.language || 'ja';
  installStyle(PROTECTED_HOST.css);
  installProtectedWorkers();
  await import('../app.js');
  await import('../ux.js');
  return Object.freeze({ context, runtimeLocation, apiOrigin });
}

const sandboxAutoStart = readSandboxAutoStart();
if (sandboxAutoStart) {
  /* A sandbox without allow-same-origin intentionally has an opaque origin, so
     Web Storage getters throw before app modules can even apply their normal
     try/catch fallbacks. Install an ephemeral Storage-compatible facade before
     any Hex module imports. Persistent project data remains outside this shim. */
  installOpaqueSandboxStorage(globalThis);
  await startProtectedRuntime(sandboxAutoStart);
}

function readSandboxAutoStart() {
  let actualOrigin = '';
  try { actualOrigin = String(globalThis.document?.location?.origin || globalThis.location?.origin || ''); } catch {}
  if (actualOrigin !== 'null') return null;
  const value = globalThis.__HEX_PROTECTED_AUTO_START__;
  if (!value || typeof value !== 'object' || value.sandboxAuto !== true) return null;
  const token = String(globalThis.__HEX_EMBED_SANDBOX_TOKEN__ || '');
  if (!token || String(value.sandboxToken || '') !== token) return null;
  try { delete globalThis.__HEX_PROTECTED_AUTO_START__; } catch { globalThis.__HEX_PROTECTED_AUTO_START__ = null; }
  return value;
}

function normalizeApiOrigin(value) {
  try {
    const parsed = new URL(String(value || ''));
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw new Error('invalid protocol');
    return parsed.origin;
  } catch {
    throw new Error('Hex protected runtime API origin is invalid.');
  }
}

function normalizeCommit(value) {
  const text = String(value || '').trim().toLowerCase();
  return /^[0-9a-f]{40}$/.test(text) ? text : null;
}

function installStyle(cssText) {
  if (document.getElementById('hex-userscript-style')) return;
  const style = document.createElement('style');
  style.id = 'hex-userscript-style';
  style.textContent = cssText;
  document.head.append(style);
}
