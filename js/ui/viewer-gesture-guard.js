const DEFAULT_MOVE_TOLERANCE = 10;

export function installViewerDragReturnGuard(viewer, { moveTolerance = DEFAULT_MOVE_TOLERANCE } = {}) {
  const viewport = viewer?.vp;
  if (!viewer || !viewport || typeof viewport.addEventListener !== 'function') return false;
  if (viewer.__dragReturnGuardInstalled) return true;
  const tolerance = Number(moveTolerance);
  if (!Number.isFinite(tolerance) || tolerance < 0) throw new TypeError('viewer-gesture-move-tolerance-invalid');
  let gesture = null;

  const pointerdown = (event) => {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    const row = event.target?.closest?.('.row');
    if (!row || row._row == null || row._row < 0) { gesture = null; return; }
    gesture = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, moved: false };
  };
  const pointermove = (event) => {
    if (!gesture || event.pointerId !== gesture.pointerId || gesture.moved) return;
    if (Math.abs(event.clientX - gesture.x) > tolerance || Math.abs(event.clientY - gesture.y) > tolerance) gesture.moved = true;
  };
  const pointerup = (event) => {
    if (!gesture || event.pointerId !== gesture.pointerId) return;
    const moved = gesture.moved;
    gesture = null;
    if (moved) event.stopImmediatePropagation();
  };
  const pointercancel = (event) => {
    if (!gesture || event?.pointerId == null || event.pointerId === gesture.pointerId) gesture = null;
  };

  viewport.addEventListener('pointerdown', pointerdown, { capture: true, passive: true });
  viewport.addEventListener('pointermove', pointermove, { capture: true, passive: true });
  viewport.addEventListener('pointerup', pointerup, { capture: true, passive: true });
  viewport.addEventListener('pointercancel', pointercancel, { capture: true, passive: true });
  Object.defineProperty(viewer, '__dragReturnGuardInstalled', { value: true });
  return true;
}
