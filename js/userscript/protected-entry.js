import { PROTECTED_HOST } from '../../.runtime-build/embedded-assets.js';
import { setUiRoot } from '../ui-root.js';
import { installProtectedWorkers } from './protected-workers.js';

const apiOrigin = new URL(globalThis.__HEX_RUNTIME_ORIGIN__ || location.origin, location.href).origin;
const userscriptHost = location.hostname === 'chatgpt.com';
if (!userscriptHost && location.origin !== apiOrigin) throw new Error('Hex protected runtime origin mismatch.');
let host = userscriptHost ? document.getElementById('hex-userscript-host') : document.documentElement;
if (userscriptHost && !host) {
  host = document.createElement('div'); host.id = 'hex-userscript-host'; host.style.cssText = 'position:fixed;inset:0;z-index:2147483646;visibility:hidden;pointer-events:none;background:#fff;';
  host.setAttribute('aria-hidden', 'true'); host.innerHTML = PROTECTED_HOST.html; document.documentElement.append(host);
}
setUiRoot(host); host.lang = navigator.language || 'ja';
if (!document.getElementById('hex-userscript-style')) {
  const style = document.createElement('style'); style.id = 'hex-userscript-style'; style.textContent = userscriptHost ? PROTECTED_HOST.scopedCss : PROTECTED_HOST.css; document.head.append(style);
}
globalThis.__HEX_API_BASE__ = apiOrigin;
installProtectedWorkers();
if (userscriptHost) await import('./entry.js');
else { await import('../app.js'); await import('../ux.js'); }
