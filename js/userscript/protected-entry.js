import { PROTECTED_HOST } from '../../.runtime-build/embedded-assets.js';
import { setUiRoot } from '../ui-root.js';
import { installProtectedWorkers } from './protected-workers.js';
import {
  EMBED_PATH,
  PROTECTED_RUNTIME_CONTEXT,
  classifyProtectedRuntime,
  startEmbedChildRuntime,
} from './embed-child.js';

const apiOrigin = new URL(globalThis.__HEX_RUNTIME_ORIGIN__ || location.origin, location.href).origin;
const context = classifyProtectedRuntime({ location, apiOrigin, window });
const embedRoute = location.origin === apiOrigin && location.pathname === EMBED_PATH;

if (context !== PROTECTED_RUNTIME_CONTEXT.LEGACY_CHATGPT && location.origin !== apiOrigin) {
  throw new Error('Hex protected runtime origin mismatch.');
}

globalThis.__HEX_API_BASE__ = apiOrigin;

if (context === PROTECTED_RUNTIME_CONTEXT.LEGACY_CHATGPT) {
  let host = document.getElementById('hex-userscript-host');
  if (!host) {
    host = document.createElement('div');
    host.id = 'hex-userscript-host';
    host.style.cssText = 'position:fixed;inset:0;z-index:2147483646;visibility:hidden;pointer-events:none;background:#fff;';
    host.setAttribute('aria-hidden', 'true');
    host.innerHTML = PROTECTED_HOST.html;
    document.documentElement.append(host);
  }
  setUiRoot(host);
  host.lang = navigator.language || 'ja';
  installStyle(PROTECTED_HOST.scopedCss);
  installProtectedWorkers();
  await import('./entry.js');
} else if (context === PROTECTED_RUNTIME_CONTEXT.EMBED_CHATGPT || embedRoute) {
  await startEmbedChildRuntime({ cssText: PROTECTED_HOST.css });
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
