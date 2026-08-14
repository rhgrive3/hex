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

function safeDecode(value) {
  const text = String(value || '');
  try { return decodeURIComponent(text); }
  catch { return text; }
}

export function matchRoute(routes, rawPath) {
  const path = normalize(rawPath).split('?')[0];
  for (const route of routes) {
    const matcher = route._matcher || (route._matcher = compile(route.pattern));
    const hit = matcher.re.exec(path);
    if (!hit) continue;
    const params = {};
    matcher.names.forEach((name, index) => { params[name] = safeDecode(hit[index + 1] || ''); });
    return { route, params, path };
  }
  return null;
}

function queryOf(rawPath) {
  const i = String(rawPath || '').indexOf('?');
  return new URLSearchParams(i >= 0 ? String(rawPath).slice(i + 1) : '');
}

export class ProductRouter {
  constructor(routes, { defaultPath = '/investigate', onRoute, onState, onDiagnostic } = {}) {
    this.routes = routes;
    this.defaultPath = normalize(defaultPath);
    this.onRoute = onRoute || (() => null);
    this.onState = onState || (() => {});
    this.onDiagnostic = onDiagnostic || (() => {});
    this.current = null;
    this.view = null;
    this.serial = 0;
    this.started = false;
    this.renderGeneration = 0;
    this.onPop = () => this._render(this.locationPath(), { historyNavigation: true, source: 'popstate' });
    this.onHash = () => {
      const path = this.locationPath();
      if (this.current?.fullPath === path) return;
      this._render(path, { historyNavigation: true, source: 'hashchange' });
    };
  }

  _diagnostic(code, error, details = null) {
    const entry = {
      code,
      message: error?.message || String(error || code),
      error: error || null,
      details,
      at: Date.now(),
    };
    try { this.onDiagnostic(entry); } catch { /* diagnostics must never break navigation */ }
    return entry;
  }

  locationPath() {
    const hash = window.location.hash.replace(/^#/, '');
    return normalize(hash || this.defaultPath);
  }

  start() {
    if (this.started) return;
    this.started = true;
    window.addEventListener('popstate', this.onPop);
    window.addEventListener('hashchange', this.onHash);
    const path = this.locationPath();
    const state = history.state && history.state.hexUi ? history.state : null;
    if (!state) {
      try { history.replaceState({ hexUi: true, key: ++this.serial, viewState: null }, '', '#' + path); }
      catch (error) { this._diagnostic('ROUTER_HISTORY_REPLACE', error, { path }); }
    } else {
      this.serial = Math.max(this.serial, Number(state.key) || 0);
    }
    this._render(path, { replace: true, historyNavigation: true, source: 'start' });
  }

  stop() {
    if (!this.started) return;
    this.capture();
    window.removeEventListener('popstate', this.onPop);
    window.removeEventListener('hashchange', this.onHash);
    this.renderGeneration++;
    this.disposeView();
    this.started = false;
  }

  capture() {
    if (!this.view || typeof this.view.getState !== 'function') return null;
    const current = history.state && history.state.hexUi ? history.state : { hexUi: true, key: ++this.serial };
    let viewState;
    try {
      viewState = this.view.getState();
    } catch (error) {
      this._diagnostic('ROUTER_CAPTURE_FAILED', error, { fullPath: this.current?.fullPath || null });
      return null;
    }
    try {
      history.replaceState({ ...current, viewState }, '', window.location.href);
    } catch (error) {
      this._diagnostic('ROUTER_HISTORY_REPLACE', error, { fullPath: this.current?.fullPath || null });
    }
    return viewState;
  }

  navigate(rawPath, { replace = false } = {}) {
    const path = normalize(rawPath);
    if (this.current && this.current.fullPath === path) return false;
    this.capture();

    const previousPath = this.current?.fullPath || this.locationPath();
    const previousState = history.state && history.state.hexUi ? history.state : null;
    const state = { hexUi: true, key: ++this.serial, viewState: null };
    let usedHashFallback = false;
    try {
      history[replace ? 'replaceState' : 'pushState'](state, '', '#' + path);
    } catch (error) {
      this._diagnostic('ROUTER_HISTORY_WRITE', error, { path, replace });
      try {
        window.location.hash = path;
        usedHashFallback = true;
      } catch (hashError) {
        this._diagnostic('ROUTER_HASH_WRITE', hashError, { path });
        return false;
      }
    }

    const rendered = this._render(path, { replace, source: 'navigate' });
    if (rendered) return true;

    if (!usedHashFallback) {
      try {
        history.replaceState(
          previousState || { hexUi: true, key: ++this.serial, viewState: null },
          '',
          '#' + previousPath,
        );
      } catch (error) {
        this._diagnostic('ROUTER_ROLLBACK_FAILED', error, { previousPath, failedPath: path });
      }
    }
    return false;
  }

  back() { this.capture(); history.back(); }
  forward() { this.capture(); history.forward(); }

  disposeView(view = this.view) {
    if (view && typeof view.dispose === 'function') {
      try { view.dispose(); }
      catch (error) { this._diagnostic('ROUTER_DISPOSE_FAILED', error, { fullPath: this.current?.fullPath || null }); }
    }
    if (view === this.view) this.view = null;
  }

  _canonicalize(fullPath, state) {
    try {
      history.replaceState(
        state || (history.state && history.state.hexUi ? history.state : { hexUi: true, key: ++this.serial, viewState: null }),
        '',
        '#' + fullPath,
      );
    } catch (error) {
      this._diagnostic('ROUTER_CANONICALIZE_FAILED', error, { fullPath });
    }
  }

  _render(rawPath, meta = {}) {
    const requestedFullPath = normalize(rawPath);
    const direct = matchRoute(this.routes, requestedFullPath);
    const fallback = direct ? null : matchRoute(this.routes, this.defaultPath);
    const resolved = direct || fallback;
    if (!resolved) {
      this._diagnostic('ROUTER_NO_ROUTE', new Error('No route for ' + requestedFullPath), { requestedFullPath });
      return false;
    }

    const fullPath = direct ? requestedFullPath : this.defaultPath;
    const historyState = history.state && history.state.hexUi ? history.state : null;
    const restoredState = historyState?.viewState ?? null;
    const candidateCurrent = { ...resolved, fullPath, query: queryOf(fullPath) };
    const previousView = this.view;
    const previousCurrent = this.current;
    const generation = ++this.renderGeneration;

    let candidateView;
    try {
      candidateView = this.onRoute(candidateCurrent, { ...meta, restoredState }) || null;
    } catch (error) {
      this.renderGeneration++;
      this._diagnostic('ROUTER_RENDER_FAILED', error, { requestedFullPath, fullPath });
      this.current = previousCurrent;
      this.view = previousView;
      return false;
    }

    this.current = candidateCurrent;
    this.view = candidateView;
    if (previousView && previousView !== candidateView) this.disposeView(previousView);

    if (!direct) this._canonicalize(fullPath, historyState);

    if (restoredState && candidateView && typeof candidateView.restoreState === 'function') {
      requestAnimationFrame(() => {
        if (generation !== this.renderGeneration || this.view !== candidateView || this.current !== candidateCurrent) return;
        try {
          candidateView.restoreState(restoredState);
        } catch (error) {
          this._diagnostic('ROUTER_RESTORE_FAILED', error, { fullPath, generation });
        }
      });
    }

    try {
      this.onState({ current: this.current, canBack: history.length > 1 });
    } catch (error) {
      this._diagnostic('ROUTER_STATE_CALLBACK_FAILED', error, { fullPath });
    }
    return true;
  }
}
