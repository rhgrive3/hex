/* Browser-backed navigation for canonical product screens. */

function normalize(path) {
  let value = String(path || '/investigate').trim();
  if (value.startsWith('#')) value = value.slice(1);
  if (!value.startsWith('/')) value = '/' + value;
  return value.replace(/\/{2,}/g, '/');
}

function compile(pattern) {
  const names = [];
  const source = normalize(pattern).split('/').map((part) => {
    if (!part) return '';
    if (part.startsWith(':')) {
      const optional = part.endsWith('?');
      names.push(part.slice(1, optional ? -1 : undefined));
      return optional ? '([^/]*)' : '([^/]+)';
    }
    return part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }).join('/');
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

export class ProductRouter {
  constructor(routes, { defaultPath = '/investigate', onRoute, onState } = {}) {
    this.routes = routes;
    this.defaultPath = defaultPath;
    this.onRoute = onRoute || (() => null);
    this.onState = onState || (() => {});
    this.current = null;
    this.view = null;
    this.serial = 0;
    this.started = false;
    this.onPop = () => this._render(this.locationPath(), { historyNavigation: true });
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
    const state = history.state && history.state.hexUi ? history.state : null;
    if (!state) history.replaceState({ hexUi: true, key: ++this.serial, viewState: null }, '', '#' + path);
    else this.serial = Math.max(this.serial, Number(state.key) || 0);
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
    const current = history.state && history.state.hexUi ? history.state : { hexUi: true, key: ++this.serial };
    const viewState = this.view.getState();
    try { history.replaceState({ ...current, viewState }, '', window.location.href); } catch { /* Safari private mode */ }
  }

  navigate(rawPath, { replace = false } = {}) {
    const path = normalize(rawPath);
    if (this.current && this.current.fullPath === path) return false;
    this.capture();
    const state = { hexUi: true, key: ++this.serial, viewState: null };
    try {
      history[replace ? 'replaceState' : 'pushState'](state, '', '#' + path);
    } catch {
      window.location.hash = path;
    }
    this._render(path, { replace });
    return true;
  }

  back() { this.capture(); history.back(); }
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
    const state = history.state && history.state.hexUi ? history.state.viewState : null;
    this.view = this.onRoute(this.current, { ...meta, restoredState: state }) || null;
    if (state && this.view && typeof this.view.restoreState === 'function') {
      requestAnimationFrame(() => this.view && this.view.restoreState(state));
    }
    this.onState({ current: this.current, canBack: history.length > 1 });
  }
}
