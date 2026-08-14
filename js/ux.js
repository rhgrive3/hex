/* Compatibility bootstrap only. Canonical product UI lives under js/ui/*. */
import { installProductUI } from './ui/product.js';

function boot() {
  if (!window.__app) return;
  installProductUI(window.__app);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => requestAnimationFrame(boot), { once: true });
} else {
  requestAnimationFrame(boot);
}
