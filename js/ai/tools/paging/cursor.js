function fnv1a(text, seed = 0x811c9dc5) {
  let h = seed >>> 0;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

function randomSecret() {
  try {
    if (globalThis.crypto?.getRandomValues) {
      const bytes = new Uint32Array(4);
      globalThis.crypto.getRandomValues(bytes);
      return Array.from(bytes, (n) => n.toString(36)).join('-');
    }
  } catch {}
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
}

function macFor(secret, body) {
  const a = fnv1a(`${secret}\u0000${body}`, 0x811c9dc5);
  const b = fnv1a(`${body}\u0000${secret}`, 0x9e3779b9);
  return `${a.toString(36)}${b.toString(36)}`;
}

function encodeBody(value) {
  return encodeURIComponent(JSON.stringify(value));
}

function decodeBody(value) {
  return JSON.parse(decodeURIComponent(value));
}

export class CursorCodec {
  constructor({ secret = randomSecret(), maxAgeMs = 30 * 60 * 1000 } = {}) {
    this.secret = String(secret);
    this.maxAgeMs = Math.max(1000, Number(maxAgeMs) || 30 * 60 * 1000);
  }

  encode(payload) {
    const body = encodeBody({ ...payload, issuedAt: Date.now() });
    return `c1.${body}.${macFor(this.secret, body)}`;
  }

  decode(cursor, { bindingKey = null, kind = null } = {}) {
    const text = String(cursor || '');
    const first = text.indexOf('.');
    const last = text.lastIndexOf('.');
    if (!text.startsWith('c1.') || first !== 2 || last <= first + 1) throw new Error('invalid-cursor');
    const body = text.slice(first + 1, last);
    const mac = text.slice(last + 1);
    if (!mac || mac !== macFor(this.secret, body)) throw new Error('invalid-cursor');
    let payload;
    try { payload = decodeBody(body); } catch { throw new Error('invalid-cursor'); }
    if (!payload || typeof payload !== 'object') throw new Error('invalid-cursor');
    if (kind != null && payload.kind !== kind) throw new Error('cursor-kind-mismatch');
    if (bindingKey != null && payload.bindingKey !== bindingKey) throw new Error('stale-cursor');
    const issuedAt = Number(payload.issuedAt || 0);
    if (!Number.isFinite(issuedAt) || Date.now() - issuedAt > this.maxAgeMs || issuedAt - Date.now() > 60_000) {
      throw new Error('stale-cursor');
    }
    return payload;
  }
}

export function stableSerialize(value, depth = 0) {
  if (depth > 8) return '"[depth]"';
  if (typeof value === 'bigint') return JSON.stringify(`0x${value.toString(16)}`);
  if (value == null || typeof value === 'number' || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableSerialize(item, depth + 1)).join(',')}]`;
  if (typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${stableSerialize(value[key], depth + 1)}`).join(',')}}`;
  }
  return JSON.stringify(String(value));
}

export function shortHash(value) {
  const text = typeof value === 'string' ? value : stableSerialize(value);
  const a = fnv1a(text, 0x811c9dc5);
  const b = fnv1a(text, 0x9e3779b9);
  return `${a.toString(36)}${b.toString(36)}`;
}
