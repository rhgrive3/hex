const DEFAULT_SELECTORS = Object.freeze([
  'nav', 'aside', 'main', '[role="dialog"]', '[role="menu"]',
  'button', 'a[href]', 'input', 'textarea', '[contenteditable="true"]', '[data-testid]',
]);
const MAX_SELECTORS = 16;
const MAX_NODES = 128;
const MAX_NODE_TEXT = 320;
const MAX_HTML_CHARS = 48 * 1024;
const MAX_SCRIPT_CHARS = 64 * 1024;
const MAX_SCRIPT_OFFSET = 8 * 1024 * 1024;
const MAX_SCRIPT_MATCHES = 8;
const MAX_CONTEXT_CHARS = 2048;
const SENSITIVE_ATTRIBUTE = /(?:token|auth|session|csrf|nonce|secret|password|credential|cookie)/i;
const SAFE_HTML_ATTRIBUTE = /^(?:id|class|role|title|name|type|placeholder|href|for|tabindex|disabled|checked|selected|aria-[\w-]+|data-[\w-]+)$/i;

export class ParentPageInspector {
  constructor({ document = globalThis.document, location = globalThis.location, fetchRef = globalThis.fetch?.bind(globalThis) } = {}) {
    this.document = document || null;
    this.location = location || null;
    this.fetchRef = fetchRef || null;
  }

  snapshot(args = {}) {
    const documentRef = this.requireDocument();
    const selectors = normalizeSelectors(args.selectors);
    const maxNodes = boundedInteger(args.maxNodes, 1, MAX_NODES, 96);
    const seen = new Set();
    const nodes = [];
    const selectorErrors = [];
    for (const selector of selectors) {
      let matches = [];
      try { matches = [...(documentRef.querySelectorAll?.(selector) || [])]; }
      catch (error) {
        selectorErrors.push({ selector, error: String(error?.message || 'invalid selector').slice(0, 160) });
        continue;
      }
      for (const node of matches) {
        if (seen.has(node)) continue;
        seen.add(node);
        nodes.push(describeNode(node));
        if (nodes.length >= maxNodes) break;
      }
      if (nodes.length >= maxNodes) break;
    }

    let html = null;
    if (args.includeHtml === true) {
      const htmlSelector = normalizeSingleSelector(args.htmlSelector || 'body');
      let root = null;
      try { root = documentRef.querySelector?.(htmlSelector) || null; }
      catch (error) { selectorErrors.push({ selector: htmlSelector, error: String(error?.message || 'invalid selector').slice(0, 160) }); }
      if (root) html = sanitizeOuterHtml(root, boundedInteger(args.maxHtmlChars, 256, MAX_HTML_CHARS, 16 * 1024));
    }

    return {
      kind: 'chatgpt-page-snapshot',
      location: describeLocation(this.location || documentRef.location),
      title: boundedText(documentRef.title, 240),
      selectors,
      nodeCount: nodes.length,
      truncated: nodes.length >= maxNodes,
      nodes,
      html,
      selectorErrors,
    };
  }

  scripts() {
    const documentRef = this.requireDocument();
    const currentOrigin = safeUrl(this.location || documentRef.location)?.origin || null;
    const scripts = [...(documentRef.scripts || documentRef.querySelectorAll?.('script') || [])]
      .slice(0, 128)
      .map((node, index) => describeScript(node, index, currentOrigin));
    return {
      kind: 'chatgpt-page-scripts',
      location: describeLocation(this.location || documentRef.location),
      scripts,
    };
  }

  async scriptSource(args = {}, options = {}) {
    const documentRef = this.requireDocument();
    if (typeof this.fetchRef !== 'function') throw inspectorError('fetch-unavailable', 'Page script fetch is unavailable.');
    const scripts = [...(documentRef.scripts || documentRef.querySelectorAll?.('script') || [])];
    const selected = selectLoadedExternalScript(scripts, args);
    if (!selected) throw inspectorError('script-not-loaded', 'Requested script is not a currently loaded external page script.');
    const url = safeUrl(selected.src);
    if (!url || url.protocol !== 'https:') throw inspectorError('script-url-invalid', 'Loaded script URL is not HTTPS.');
    const response = await this.fetchRef(url.href, {
      method: 'GET',
      credentials: 'omit',
      cache: 'no-store',
      referrerPolicy: 'no-referrer',
      signal: options.signal,
    });
    if (!response || response.ok === false || Number(response.status || 0) >= 400) {
      throw inspectorError('script-fetch-failed', `Loaded script fetch failed (${response?.status || 'unknown'}).`);
    }
    const source = String(await response.text());
    const needle = args.needle == null ? '' : boundedText(args.needle, 160);
    if (needle) {
      const contextChars = boundedInteger(args.contextChars, 64, MAX_CONTEXT_CHARS, 768);
      const maxMatches = boundedInteger(args.maxMatches, 1, MAX_SCRIPT_MATCHES, 5);
      return {
        kind: 'chatgpt-page-script-source',
        src: publicScriptUrl(url),
        totalChars: source.length,
        needle,
        excerpts: literalExcerpts(source, needle, contextChars, maxMatches),
      };
    }
    const offset = boundedInteger(args.offset, 0, MAX_SCRIPT_OFFSET, 0);
    const maxChars = boundedInteger(args.maxChars, 256, MAX_SCRIPT_CHARS, 24 * 1024);
    const text = source.slice(offset, offset + maxChars);
    return {
      kind: 'chatgpt-page-script-source',
      src: publicScriptUrl(url),
      totalChars: source.length,
      offset,
      nextOffset: offset + text.length < source.length ? offset + text.length : null,
      text,
    };
  }

  requireDocument() {
    if (!this.document || typeof this.document.querySelectorAll !== 'function') {
      throw inspectorError('document-unavailable', 'ChatGPT parent document is unavailable.');
    }
    return this.document;
  }
}

function normalizeSelectors(value) {
  const raw = value == null ? DEFAULT_SELECTORS : value;
  if (!Array.isArray(raw)) throw new TypeError('selectors must be an array of CSS selectors.');
  const selectors = raw.map(normalizeSingleSelector).filter(Boolean);
  if (!selectors.length) return [...DEFAULT_SELECTORS];
  if (selectors.length > MAX_SELECTORS) throw new TypeError(`At most ${MAX_SELECTORS} selectors may be inspected at once.`);
  return selectors;
}

function normalizeSingleSelector(value) {
  const text = String(value || '').trim();
  if (!text || text.length > 256) throw new TypeError('CSS selector must be 1-256 characters.');
  return text;
}

function describeNode(node) {
  const editable = isEditable(node);
  return {
    tag: String(node?.tagName || node?.nodeName || '').toLowerCase() || null,
    id: safeAttribute(node, 'id'),
    classes: classTokens(node).slice(0, 8),
    role: safeAttribute(node, 'role'),
    testId: safeAttribute(node, 'data-testid'),
    ariaLabel: safeAttribute(node, 'aria-label'),
    title: safeAttribute(node, 'title'),
    name: safeAttribute(node, 'name'),
    type: safeAttribute(node, 'type'),
    placeholder: safeAttribute(node, 'placeholder'),
    href: safeNodeHref(node),
    text: editable ? null : boundedText(node?.textContent, MAX_NODE_TEXT),
    editable,
    disabled: !!node?.disabled || safeAttribute(node, 'aria-disabled') === 'true',
    checked: typeof node?.checked === 'boolean' ? node.checked : null,
    selected: typeof node?.selected === 'boolean' ? node.selected : null,
    hidden: !!node?.hidden || safeAttribute(node, 'aria-hidden') === 'true',
  };
}

function describeScript(node, index, currentOrigin) {
  const url = safeUrl(node?.src || safeAttribute(node, 'src'));
  return {
    index,
    external: !!url,
    src: url ? publicScriptUrl(url) : null,
    sameOrigin: !!url && !!currentOrigin && url.origin === currentOrigin,
    type: boundedText(node?.type || safeAttribute(node, 'type'), 80) || null,
    async: !!node?.async,
    defer: !!node?.defer,
    integrity: boundedText(safeAttribute(node, 'integrity'), 160) || null,
    noncePresent: !!(node?.nonce || safeAttribute(node, 'nonce')),
    inlineChars: url ? 0 : String(node?.textContent || '').length,
  };
}

function selectLoadedExternalScript(scripts, args) {
  if (args.index != null) {
    const index = boundedInteger(args.index, 0, Math.max(0, scripts.length - 1), 0);
    const node = scripts[index];
    return node?.src ? node : null;
  }
  const requested = String(args.src || '').trim();
  if (!requested) throw new TypeError('script_source requires a loaded script index or src.');
  const wanted = safeUrl(requested)?.href;
  if (!wanted) return null;
  return scripts.find((node) => safeUrl(node?.src)?.href === wanted) || null;
}

function literalExcerpts(source, needle, contextChars, maxMatches) {
  const out = [];
  let from = 0;
  while (out.length < maxMatches) {
    const index = source.indexOf(needle, from);
    if (index < 0) break;
    const start = Math.max(0, index - contextChars);
    const end = Math.min(source.length, index + needle.length + contextChars);
    out.push({ index, start, end, text: source.slice(start, end) });
    from = index + Math.max(1, needle.length);
  }
  return out;
}

function sanitizeOuterHtml(node, maxChars) {
  let clone = null;
  try { clone = node.cloneNode?.(true) || null; } catch {}
  if (clone) {
    const all = [clone, ...(clone.querySelectorAll?.('*') || [])];
    for (const element of all) {
      const tag = String(element?.tagName || '').toLowerCase();
      if (['script', 'style', 'noscript', 'template', 'iframe', 'object', 'embed'].includes(tag)) {
        try { element.remove(); } catch {}
        continue;
      }
      for (const attribute of [...(element?.attributes || [])]) {
        const name = String(attribute?.name || '');
        if (!SAFE_HTML_ATTRIBUTE.test(name) || SENSITIVE_ATTRIBUTE.test(name)) {
          try { element.removeAttribute?.(name); } catch {}
          continue;
        }
        if (name.toLowerCase() === 'href') {
          const href = safeUrl(attribute?.value);
          try { element.setAttribute?.(name, href ? publicScriptUrl(href) : ''); } catch {}
        } else if (SENSITIVE_ATTRIBUTE.test(String(attribute?.value || ''))) {
          try { element.setAttribute?.(name, '[redacted]'); } catch {}
        }
      }
      if (isEditable(element)) {
        try { element.removeAttribute?.('value'); } catch {}
        try { element.textContent = ''; } catch {}
      }
    }
    return String(clone.outerHTML || '').slice(0, maxChars);
  }
  return fallbackSanitizeHtml(String(node?.outerHTML || ''), maxChars);
}

function fallbackSanitizeHtml(value, maxChars) {
  return String(value)
    .replace(/<(script|style|noscript|template|iframe|object|embed)\b[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/\s(?:value|nonce|srcdoc|on\w+|style)=(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .slice(0, maxChars);
}

function describeLocation(value) {
  const url = safeUrl(value?.href || value);
  if (!url) return { origin: null, pathname: null, searchKeys: [] };
  return {
    origin: url.origin,
    pathname: url.pathname,
    searchKeys: [...new Set([...url.searchParams.keys()])].slice(0, 32),
  };
}

function safeNodeHref(node) {
  const raw = node?.href || safeAttribute(node, 'href');
  const url = safeUrl(raw);
  return url ? publicScriptUrl(url) : null;
}

function publicScriptUrl(url) {
  return `${url.origin}${url.pathname}`;
}

function safeUrl(value) {
  try {
    const text = String(value?.href || value || '').trim();
    if (!text) return null;
    return new URL(text, 'https://chatgpt.com/');
  } catch { return null; }
}

function safeAttribute(node, name) {
  if (SENSITIVE_ATTRIBUTE.test(name)) return null;
  let value = null;
  try { value = node?.getAttribute?.(name); } catch {}
  if (value == null && name === 'id') value = node?.id;
  const text = boundedText(value, 240);
  return text || null;
}

function classTokens(node) {
  try { return [...(node?.classList || [])].map((value) => boundedText(value, 80)).filter(Boolean); }
  catch { return []; }
}

function isEditable(node) {
  const tag = String(node?.tagName || '').toLowerCase();
  if (['input', 'textarea'].includes(tag)) return true;
  const editable = safeAttribute(node, 'contenteditable');
  return editable === '' || editable === 'true' || node?.isContentEditable === true;
}

function boundedText(value, max) {
  if (value == null) return '';
  return String(value).replace(/\s+/g, ' ').trim().slice(0, max);
}

function boundedInteger(value, min, max, fallback) {
  if (value == null || value === '') return fallback;
  const number = Number(value);
  if (!Number.isFinite(number)) throw new TypeError('Expected a finite numeric bound.');
  return Math.min(max, Math.max(min, Math.floor(number)));
}

function inspectorError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}
