/* Canonical UI state owner. Standalone Hex uses <html>; the userscript host
   installs its private root before application modules execute. */
export function uiRoot() {
  return globalThis.__HEX_UI_ROOT__ || globalThis.document?.documentElement || null;
}

export function setUiRoot(root) {
  if (!root?.classList || !root?.style) throw new TypeError('Hex UI root must be an Element');
  globalThis.__HEX_UI_ROOT__ = root;
  return root;
}
