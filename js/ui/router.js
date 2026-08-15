/* Browser-backed navigation for canonical product screens. */

function normalize(path) {
  let value = String(path || '/investigate').trim();
  if (value.startsWith('#')) value = value.slice(1);
  if (!value.startsWith('/')) value = '/' + value;
  return value.replace(/\/{2,}/g, '/');
}

function escapeSegment(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function compile(pattern) {
  const names = [];
  const parts = normalize(pattern).split('/').filter(Boolean);
  let source = '';
  for (const part of parts) {
    if (!part.startsWith(':')) {
      source += '/' + escapeSegment(part);
      continue;
    }
    const optional = part.endsWith('?');
    names.push(part.slice(1, optional ? -1 : undefined));
    source += optional ? '(?:/([^/]+))?' : '/([^/]+)';
  }
  if (!source) source = '/';
  return { names, re: new RegExp('^' + source + '/?$') };
}

export function matchRoute(routes, rawPath) {
  const path = normalize(rawPath).split('?')[0];
  for (const route of routes) {
    const matcher = route._matcher || (route._matcher = compile(route.pattern));
    const hit = matcher.re.exec(path);
    if (!hit) continue;
    const params = {};
    matcher.names.forEach((name, index) => { params[name] = decodeURIComponent(hit[index + 1] || ''); });
    return { route, params, path };
  }
  return null;
}

function queryOf(rawPath) {
  const i = String(rawPath || '').indexOf('?');
  return new URLSearchParams(i >= 0 ? String(rawPath).slice(i + 1) : '');
}

function ownedState(state) {
  return !!state && state.hexUi === true && Number.isSafeInteger(state.hexDepth) && state.hexDepth >= 0;
}

export class ProductRouter {
  constructor(routes, { defaultPath = '/investigate', onRoute, onState } = {}) {
    this.routes = routes;
    this.defaultPath = defaultPath;
    this.onRoute = onRoute || (() => null);
    this.onState = onState || (() => {});
    this.current = null;
    this.view = null;
    this.serial = 0;
    this.depth = 0;
    this.started = false;
    this.onPop = () => {
      const state = ownedState(history.state) ? history.state : null;
      this.depth = state ? state.hexDepth : 0;
      this._render(this.locationPath(), { historyNavigation: true });
    };
  }

  locationPath() {
    const hash = window.location.hash.replace(/^#/, '');
    return normalize(hash || this.defaultPath);
  }

  start() {
    if (this.started) return;
    this.started = true;
    window.addEventListener('popstate', this.onPop);
    const path = this.locationPath();
    const state = ownedState(history.state) ? history.state : null;
    if (!state) {
      // The browser may already have an external referrer in its global history.
      // Mark this document as the app-owned root instead of inheriting that depth.
      this.depth = 0;
      history.replaceState({ hexUi: true, hexDepth: 0, key: ++this.serial, viewState: null }, '', '#' + path);
    } else {
      this.depth = state.hexDepth;
      this.serial = Math.max(this.serial, Number(state.key) || 0);
    }
    this._render(path, { replace: true, historyNavigation: true });
  }

  stop() {
    if (!this.started) return;
    this.capture();
    window.removeEventListener('popstate', this.onPop);
    this.disposeView();
    this.started = false;
  }

  capture() {
    if (!this.view || typeof this.view.getState !== 'function') return;
    const current = ownedState(history.state)
      ? history.state
      : { hexUi: true, hexDepth: this.depth, key: ++this.serial };
    const viewState = this.view.getState();
    try { history.replaceState({ ...current, hexUi: true, hexDepth: this.depth, viewState }, '', window.location.href); } catch { /* Safari private mode */ }
  }

  navigate(rawPath, { replace = false } = {}) {
    const path = normalize(rawPath);
    if (this.current && this.current.fullPath === path) return false;
    this.capture();
    const nextDepth = replace ? this.depth : this.depth + 1;
    const state = { hexUi: true, hexDepth: nextDepth, key: ++this.serial, viewState: null };
    try {
      history[replace ? 'replaceState' : 'pushState'](state, '', '#' + path);
    } catch {
      // Hash fallback cannot provide trustworthy app-owned history semantics.
      // Keep the conservative depth so Back is never advertised into an external page.
      window.location.hash = path;
    }
    this.depth = nextDepth;
    this._render(path, { replace });
    return true;
  }

  back() {
    if (this.depth <= 0) return false;
    this.capture();
    history.back();
    return true;
  }
  forward() { this.capture(); history.forward(); }

  disposeView() {
    if (this.view && typeof this.view.dispose === 'function') this.view.dispose();
    this.view = null;
  }

  _render(rawPath, meta = {}) {
    const fullPath = normalize(rawPath);
    const match = matchRoute(this.routes, fullPath);
    const resolved = match || matchRoute(this.routes, this.defaultPath);
    if (!resolved) throw new Error('No route for ' + fullPath);
    this.disposeView();
    this.current = { ...resolved, fullPath, query: queryOf(fullPath) };
    const state = ownedState(history.state) ? history.state.viewState : null;
    this.view = this.onRoute(this.current, { ...meta, restoredState: state }) || null;
    if (state && this.view && typeof this.view.restoreState === 'function') {
      requestAnimationFrame(() => this.view && this.view.restoreState(state));
    }
    this.onState({ current: this.current, canBack: this.depth > 0 });
  }
}