/* Compatibility bootstrap only. Canonical product UI lives under js/ui/*. */
import { installProductUI } from './ui/product.js';
import { closeMenu } from './ui.js';

const LEGACY_ACTION_IDS = [
  'btn-help', 'btn-more',
  'btn-investigate', 'btn-tools', 'btn-functions',
  'btn-search', 'btn-jump', 'btn-overflow',
  'btn-strings', 'btn-sections', 'btn-struct', 'btn-select',
  'btn-open-2',
];

/*
 * Menu positioning listens to resize/orientation/VisualViewport events while a menu is
 * open. Those event targets are Window/VisualViewport rather than DOM Nodes, so the
 * legacy menu dismissal path must not reach Node.contains() with them. Register this
 * guard before any menu is opened: it closes and unregisters the transient menu's own
 * listeners first, which also matches the intended mobile UX (orientation/keyboard
 * geometry changes always dismiss context menus).
 */
function installTransientMenuViewportGuard() {
  const dismiss = () => closeMenu();
  window.addEventListener('resize', dismiss, { passive: true });
  window.addEventListener('orientationchange', dismiss, { passive: true });
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', dismiss, { passive: true });
    window.visualViewport.addEventListener('scroll', dismiss, { passive: true });
  }
}

installTransientMenuViewportGuard();

/*
 * WebKit can report a drag that crosses the viewer's movement threshold and then
 * returns almost exactly to its starting point before pointerup. The viewer cancels
 * its long-press timer when the excursion happens, but final-coordinate-only tap
 * detection could otherwise reinterpret the completed drag as a tap. A capture-phase
 * guard remembers the whole pointer gesture and prevents only that moved pointerup
 * from reaching the viewer. Normal taps, long presses and range selection are untouched.
 */
function installViewerDragReturnGuard(app) {
  const viewer = app?.viewer;
  const viewport = viewer?.vp;
  if (!viewer || !viewport || viewer.__dragReturnGuardInstalled) return;
  const MOVE_TOLERANCE = 10;
  let gesture = null;

  viewport.addEventListener('pointerdown', (event) => {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    const row = event.target?.closest?.('.row');
    if (!row || row._row == null || row._row < 0) { gesture = null; return; }
    gesture = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, moved: false };
  }, { capture: true, passive: true });

  viewport.addEventListener('pointermove', (event) => {
    if (!gesture || event.pointerId !== gesture.pointerId || gesture.moved) return;
    if (Math.abs(event.clientX - gesture.x) > MOVE_TOLERANCE ||
        Math.abs(event.clientY - gesture.y) > MOVE_TOLERANCE) gesture.moved = true;
  }, { capture: true, passive: true });

  viewport.addEventListener('pointerup', (event) => {
    if (!gesture || event.pointerId !== gesture.pointerId) return;
    const moved = gesture.moved;
    gesture = null;
    if (moved) event.stopImmediatePropagation();
  }, { capture: true, passive: true });

  viewport.addEventListener('pointercancel', () => { gesture = null; }, { capture: true, passive: true });
  Object.defineProperty(viewer, '__dragReturnGuardInstalled', { value: true });
}

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

function migrateRootControls(ui) {
  /* Rebind the surviving visible Open control through the action registry. This also
     keeps the old browser-regression selector on a real, visible canonical action. */
  const oldOpen = document.getElementById('btn-open');
  if (oldOpen) {
    const open = oldOpen.cloneNode(true); // clone intentionally drops app.js listeners
    open.id = 'btn-open-2';
    oldOpen.replaceWith(open);
    ui.actions.register('file.open', () => document.getElementById('file-input')?.click());
    open.addEventListener('click', () => ui.actions.run('file.open'));
  }

  const investigate = document.querySelector('.ui-nav-item[data-route-id="investigate"]');
  if (investigate) investigate.id = 'btn-investigate';
}

function boot() {
  if (!window.__app) return;
  installViewerDragReturnGuard(window.__app);
  retireLegacyActionDom();
  const ui = installProductUI(window.__app);
  if (ui) migrateRootControls(ui);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => requestAnimationFrame(boot), { once: true });
} else {
  requestAnimationFrame(boot);
}
