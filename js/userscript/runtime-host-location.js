export function captureRuntimeHostLocation(locationRef = globalThis.document?.location || globalThis.location) {
  return Object.freeze(normalizeRuntimeLocation(locationRef));
}

export function runtimeLocationFromSnapshot(snapshot, fallback = globalThis.document?.location || globalThis.location) {
  const captured = normalizeRuntimeLocation(snapshot);
  if (captured.origin) return Object.freeze(captured);
  return Object.freeze(normalizeRuntimeLocation(fallback));
}

function normalizeRuntimeLocation(value) {
  const origin = normalizeOrigin(value?.origin);
  const pathname = normalizePathname(value?.pathname);
  const search = normalizeSearch(value?.search);
  const href = normalizeHref(value?.href, origin, pathname, search);
  return { origin, pathname, search, href };
}

function normalizeOrigin(value) {
  const raw = String(value || '');
  if (!raw || raw === 'null') return '';
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return '';
    return parsed.origin;
  } catch {
    return '';
  }
}

function normalizePathname(value) {
  const raw = String(value || '/');
  return raw.startsWith('/') ? raw : `/${raw}`;
}

function normalizeSearch(value) {
  const raw = String(value || '');
  if (!raw) return '';
  return raw.startsWith('?') ? raw : `?${raw}`;
}

function normalizeHref(value, origin, pathname, search) {
  const raw = String(value || '');
  if (raw) {
    try {
      const parsed = new URL(raw);
      if ((parsed.protocol === 'https:' || parsed.protocol === 'http:') && (!origin || parsed.origin === origin)) return parsed.href;
    } catch {}
  }
  return origin ? `${origin}${pathname}${search}` : '';
}
