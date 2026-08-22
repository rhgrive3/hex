/* Browser-backed navigation for canonical product screens. */

function normalize(path) {
  let value = String(path || '/investigate').trim();
  if (value.startsWith('#')) value = value.slice(1);
  if (!value.startsWith('/')) value = '/' + value;
  return value.replace(/\/{2,}/g, '/');
}

function escapeSegment(value) { return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function compile(pattern) {
  const names = [];
  const parts = normalize(pattern).split('/').filter(Boolean);
  let source = '';
  for (const part of parts) {
    if (!part.startsWith(':')) { source += '/' + escapeSegment(part); continue; }
    const optional = part.endsWith('?');
    names.push(part.slice(1, optional ? -1 : undefined));
    source += optional ? '(?:/([^/]+))?' : '/([^/]+)';
  }
  if (!source) source = '/';
  return { names, re: new RegExp('^' + source + '/?$') };
}

function decodeSegment(value) { try { return decodeURIComponent(value || ''); } catch { return null; } }
export function matchRoute(routes, rawPath) {
  const path = normalize(rawPath).split('?')[0];
  for (const route of routes) {
    const matcher = route._matcher || (route._matcher = compile(route.pattern));
    const hit = matcher.re.exec(path);
    if (!hit) continue;
    const params = {};
    let valid = true;
    matcher.names.forEach((name, index) => { const value = decodeSegment(hit[index + 1]); if (value == null) valid = false; else params[name] = value; });
    if (!valid) continue;
    return { route, params, path };
  }
  return null;
}

function queryOf(rawPath) { const i = String(rawPath || '').indexOf('?'); return new URLSearchParams(i >= 0 ? String(rawPath).slice(i + 1) : ''); }

function ownedState(state) {
  return !!state && state.hexUi === true && Number.isSafeInteger(state.hexDepth) && state.hexDepth >= 0;
}

/* `srcdoc` documents inherit the embedding document's base URL for resolving
   relative URLs even though their own location is `about:srcdoc`. WebKit
   therefore resolves `'# /code'`-style History API URLs against chatgpt.com and
   rejects the cross-origin replaceState/pushState. Always derive the history URL
   from the document's actual location instead of its inherited base URL. */
export function routeHistoryUrl(path, locationRef = globalThis.location) {
  const route = normalize(path);
  try {
    const href = String(locationRef?.href || '');
    if (href) return `${href.split('#')[0]}#${route}`;
  } catch {}
  return '#' + route;
}

export class ProductRouter {
  constructor(routes, { defaultPath = '/investigate', onRoute, onState, onError } = {}) {
    this.routes = routes; this.defaultPath = normalize(defaultPath); this.onRoute = onRoute || (() => null); this.onState = onState || (() => {}); this.onError = onError || (() => {});
    this.current = null; this.view = null; this.serial = 0; this.started = false; this.renderGeneration = 0; this.depth = 0;
    this.onPop = () => { const state = history.state?.hexUi ? history.state : null; if (state) this.depth = Math.max(0, Number(state.depth) || 0); this._render(this.locationPath(), { historyNavigation: true }); };
    this.onHash = () => { const path = this.locationPath(); if (this.current?.fullPath === path) return; this._render(path, { historyNavigation: true, hashNavigation: true }); };
  }

  locationPath() { const hash = window.location.hash.replace(/^#/, ''); return normalize(hash || this.defaultPath); }

  start() {
    if (this.started) return;
    this.started = true;
    window.addEventListener('popstate', this.onPop);
    window.addEventListener('hashchange', this.onHash);
    const path = this.locationPath();
    const state = history.state && history.state.hexUi ? history.state : null;
    if (!state) { this.depth = 0; history.replaceState({ hexUi: true, key: ++this.serial, depth: 0, viewState: null }, '', routeHistoryUrl(path, window.location)); }
    else { this.serial = Math.max(this.serial, Number(state.key) || 0); this.depth = Math.max(0, Number(state.depth) || 0); }
    this._render(path, { replace: true, historyNavigation: true });
  }

  stop() {
    if (!this.started) return;
    this.capture();
    window.removeEventListener('popstate', this.onPop); window.removeEventListener('hashchange', this.onHash);
    this.disposeView(); this.started = false; this.renderGeneration++;
  }

  capture() {
    if (!this.view || typeof this.view.getState !== 'function') return;
    const current = history.state && history.state.hexUi ? history.state : { hexUi: true, key: ++this.serial, depth: this.depth };
    let viewState;
    try { viewState = this.view.getState(); } catch (error) { this._handleError(error, { phase: 'capture', current: this.current }); return; }
    try { history.replaceState({ ...current, depth: this.depth, viewState }, '', window.location.href); } catch { /* Safari private mode */ }
  }

  navigate(rawPath, { replace = false } = {}) {
    const requestedPath = normalize(rawPath);
    const path = matchRoute(this.routes, requestedPath) ? requestedPath : this.defaultPath;
    if (this.current && this.current.fullPath === path) return false;
    this.capture();
    const previousDepth = this.depth;
    const nextDepth = replace ? previousDepth : previousDepth + 1;

    // Build the destination before committing browser history. If the route
    // renderer throws, the current view, URL and history stack must remain one
    // coherent state instead of leaving a dead entry that only looks opened.
    this.depth = nextDepth;
    const rendered = this._render(path, { replace, restoredState: null });
    if (!rendered) {
      this.depth = previousDepth;
      return false;
    }

    const state = { hexUi: true, key: ++this.serial, depth: nextDepth, viewState: null };
    try { history[replace ? 'replaceState' : 'pushState'](state, '', routeHistoryUrl(path, window.location)); }
    catch { window.location.hash = path; }
    return true;
  }

  back() { if (!this.canBack()) return false; this.capture(); history.back(); return true; }
  forward() { this.capture(); history.forward(); return true; }
  canBack() { return this.depth > 0; }

  disposeView(view = this.view) { if (view && typeof view.dispose === 'function') { try { view.dispose(); } catch (error) { this._handleError(error, { phase: 'dispose' }); } } if (view === this.view) this.view = null; }
  _handleError(error, meta = {}) { try { this.onError(error, meta); } catch { /* error boundary must not throw into navigation */ } }

  _render(rawPath, meta = {}) {
    const requestedPath = normalize(rawPath);
    let resolved = matchRoute(this.routes, requestedPath);
    let fullPath = requestedPath;
    if (!resolved) {
      resolved = matchRoute(this.routes, this.defaultPath);
      fullPath = this.defaultPath;
      if (!resolved) { const error = new Error('No route for ' + requestedPath); this._handleError(error, { phase: 'match', requestedPath }); throw error; }
      const state = history.state?.hexUi ? { ...history.state, depth: this.depth } : { hexUi: true, key: ++this.serial, depth: this.depth, viewState: null };
      try { history.replaceState(state, '', routeHistoryUrl(fullPath, window.location)); } catch { /* URL correction is best effort */ }
    }

    const nextCurrent = { ...resolved, fullPath, query: queryOf(fullPath) };
    const state = Object.hasOwn(meta, 'restoredState')
      ? meta.restoredState
      : (history.state && history.state.hexUi ? history.state.viewState : null);
    const previousView = this.view;
    let nextView;
    try { nextView = this.onRoute(nextCurrent, { ...meta, restoredState: state }) || null; }
    catch (error) { this._handleError(error, { phase: 'render', current: nextCurrent }); return false; }

    this.current = nextCurrent;
    this.view = nextView;
    if (previousView && previousView !== nextView) this.disposeView(previousView);
    const generation = ++this.renderGeneration;
    if (state && nextView && typeof nextView.restoreState === 'function') {
      requestAnimationFrame(() => {
        if (generation !== this.renderGeneration || this.view !== nextView) return;
        try { nextView.restoreState(state); } catch (error) { this._handleError(error, { phase: 'restore', current: nextCurrent }); }
      });
    }
    try { this.onState({ current: this.current, canBack: this.canBack() }); } catch (error) { this._handleError(error, { phase: 'state', current: this.current }); }
    return true;
  }
}