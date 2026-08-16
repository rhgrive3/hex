import { PROTECTED_HOST } from '../../.runtime-build/embedded-assets.js';
import { setUiRoot } from '../ui-root.js';
import { installProtectedWorkers } from './protected-workers.js';
import { runtimeLocationFromSnapshot } from './runtime-host-location.js';
import {
  PROTECTED_RUNTIME_CONTEXT,
  classifyProtectedRuntime,
  startEmbedChildRuntime,
} from './embed-child.js';

const runtimeLocation = runtimeLocationFromSnapshot(globalThis.__HEX_RUNTIME_HOST_LOCATION__, globalThis.document?.location || globalThis.location);
const apiOrigin = new URL(globalThis.__HEX_RUNTIME_ORIGIN__ || runtimeLocation.origin || globalThis.location?.origin, runtimeLocation.href || globalThis.location?.href).origin;
const context = classifyProtectedRuntime({ location: runtimeLocation, apiOrigin, window });
if (context !== PROTECTED_RUNTIME_CONTEXT.LEGACY_CHATGPT && runtimeLocation.origin !== apiOrigin) {
  throw new Error(`Hex protected runtime origin mismatch (${runtimeLocation.origin || 'unknown'} != ${apiOrigin}).`);
}
globalThis.__HEX_API_BASE__ = apiOrigin;

if (context === PROTECTED_RUNTIME_CONTEXT.LEGACY_CHATGPT) {
  /* The parent coordinator decides iframe-v1 vs the legacy light-DOM fallback.
     Do not create Hex app DOM, CSS or workers in the ChatGPT realm before that
     decision: successful iframe mode must keep the parent privilege-only. */
  await import('./entry.js');
} else if (context === PROTECTED_RUNTIME_CONTEXT.EMBED_CHATGPT) {
  await startEmbedChildRuntime({ cssText: PROTECTED_HOST.css, location: runtimeLocation });
} else {
  const host = document.documentElement;
  setUiRoot(host);
  host.lang = navigator.language || 'ja';
  installStyle(PROTECTED_HOST.css);
  installProtectedWorkers();
  await import('../app.js');
  await import('../ux.js');
}

function installStyle(cssText) {
  if (document.getElementById('hex-userscript-style')) return;
  const style = document.createElement('style');
  style.id = 'hex-userscript-style';
  style.textContent = cssText;
  document.head.append(style);
}
