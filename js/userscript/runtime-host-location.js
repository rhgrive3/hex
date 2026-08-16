export function captureRuntimeHostLocation(locationRef, documentRef) {
  const resolvedLocation = locationRef === undefined ? readCurrentLocation(globalThis) : locationRef;
  const resolvedDocument = documentRef === undefined ? readDocument(globalThis) : documentRef;
  return Object.freeze(normalizeRuntimeLocation(resolvedLocation, resolvedDocument));
}

export function runtimeLocationFromSnapshot(snapshot, fallback, documentRef) {
  const captured = normalizeRuntimeLocation(snapshot, null);
  if (captured.origin) return Object.freeze(captured);
  const resolvedFallback = fallback === undefined ? readCurrentLocation(globalThis) : fallback;
  const resolvedDocument = documentRef === undefined ? readDocument(globalThis) : documentRef;
  return Object.freeze(normalizeRuntimeLocation(resolvedFallback, resolvedDocument));
}

export function runtimeHostSnapshotFromGlobals(globalObject = globalThis) {
  const primitive = {
    href: safeString(safeRead(globalObject, '__HEX_RUNTIME_HOST_HREF__')),
    origin: safeString(safeRead(globalObject, '__HEX_RUNTIME_HOST_ORIGIN__')),
    pathname: safeString(safeRead(globalObject, '__HEX_RUNTIME_HOST_PATHNAME__')),
    search: safeString(safeRead(globalObject, '__HEX_RUNTIME_HOST_SEARCH__')),
  };
  if (primitive.href || primitive.origin) return primitive;
  return safeRead(globalObject, '__HEX_RUNTIME_HOST_LOCATION__');
}

function normalizeRuntimeLocation(value, documentRef) {
  const href = firstHttpUrl([
    typeof value === 'string' ? value : safeRead(value, 'href'),
    safeRead(documentRef, 'URL'),
    safeRead(documentRef, 'baseURI'),
    safeLocationString(value),
  ]);
  if (href) return locationParts(href);

  const origin = normalizeOrigin(safeRead(value, 'origin'));
  const pathname = normalizePathname(safeRead(value, 'pathname'));
  const search = normalizeSearch(safeRead(value, 'search'));
  return {
    origin,
    pathname,
    search,
    href: origin ? `${origin}${pathname}${search}` : '',
  };
}

function locationParts(url) {
  return {
    origin: url.origin,
    pathname: url.pathname || '/',
    search: url.search || '',
    href: url.href,
  };
}

function firstHttpUrl(values) {
  for (const value of values) {
    const parsed = parseHttpUrl(value);
    if (parsed) return parsed;
  }
  return null;
}

function parseHttpUrl(value) {
  const raw = safeString(value);
  if (!raw) return null;
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
    return parsed;
  } catch {
    return null;
  }
}

function normalizeOrigin(value) {
  return parseHttpUrl(value)?.origin || '';
}

function normalizePathname(value) {
  const raw = safeString(value) || '/';
  return raw.startsWith('/') ? raw : `/${raw}`;
}

function normalizeSearch(value) {
  const raw = safeString(value);
  if (!raw) return '';
  return raw.startsWith('?') ? raw : `?${raw}`;
}

function safeRead(value, key) {
  try { return value?.[key]; } catch { return undefined; }
}

function safeLocationString(value) {
  try {
    if (!value || typeof value === 'string') return value || '';
    if (typeof value.toString !== 'function') return '';
    const text = String(value.toString());
    return text === '[object Location]' || text === '[object Object]' ? '' : text;
  } catch {
    return '';
  }
}

function safeString(value) {
  try { return value == null ? '' : String(value); } catch { return ''; }
}

function readDocument(globalObject) {
  try { return globalObject?.document || null; } catch { return null; }
}

function readCurrentLocation(globalObject) {
  const documentRef = readDocument(globalObject);
  const documentLocation = safeRead(documentRef, 'location');
  if (documentLocation) return documentLocation;
  return safeRead(globalObject, 'location') || null;
}
