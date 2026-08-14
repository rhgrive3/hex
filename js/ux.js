/* Compatibility bootstrap only. Canonical product UI lives under js/ui/*. */
import { installProductUI } from './ui/product.js';

const LEGACY_ACTION_IDS = [
  'btn-help', 'btn-more',
  'btn-investigate', 'btn-tools', 'btn-functions',
  'btn-search', 'btn-jump', 'btn-overflow',
  'btn-strings', 'btn-sections', 'btn-struct', 'btn-select',
];

function retireLegacyActionDom() {
  /* app.js has already bound its compatibility handlers by the time this module boots.
     Canonical UI never delegates through these nodes, so remove them from the live DOM
     instead of leaving invisible source buttons behind. The ASM/Hex segmented control
     and Explain toggle are intentionally retained as contextual Code controls. */
  for (const id of LEGACY_ACTION_IDS) document.getElementById(id)?.remove();
  document.querySelector('.toolbar .workspace-nav')?.remove();
  document.querySelector('.toolbar .offscreen')?.remove();
  document.getElementById('nav-history')?.remove();
}

function boot() {
  if (!window.__app) return;
  retireLegacyActionDom();
  installProductUI(window.__app);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => requestAnimationFrame(boot), { once: true });
} else {
  requestAnimationFrame(boot);
}
