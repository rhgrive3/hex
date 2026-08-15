export function validateRuntimeBootstrap(input, { buildId } = {}) {
  if (!input || typeof input !== 'object') return 'invalid-bootstrap-request';
  if (!tokenString(input.nonce, 16, 128) || !tokenString(input.requestId, 12, 128) || !tokenString(input.sessionIdentity, 12, 128)) return 'invalid-identity';
  if (!/^2\.0\.\d{1,10}$/.test(String(input.loaderVersion || ''))) return 'unsupported-loader';
  if (input.buildId !== buildId) return 'wrong-build';
  const jwk = input.clientPublicKey;
  if (!jwk || jwk.kty !== 'EC' || jwk.crv !== 'P-256' || !tokenString(jwk.x, 20, 128) || !tokenString(jwk.y, 20, 128)) return 'invalid-client-key';
  return null;
}

export async function signRuntimeSession(payload, signingKey) {
  const encoded = encodeBase64URL(utf8(JSON.stringify(payload)));
  const signature = await hmac(encoded, signingKey, 'sign');
  return `${encoded}.${encodeBase64URL(signature)}`;
}

export async function verifyRuntimeSession(value, signingKey, { now = Date.now(), requireUnexpired = true } = {}) {
  const parts = String(value).split('.'); if (parts.length !== 2) return null;
  const expected = await hmac(parts[0], signingKey, 'sign'), actual = decodeBase64URL(parts[1]);
  if (!constantTimeBytes(expected, actual)) return null;
  try {
    const payload = JSON.parse(new TextDecoder().decode(decodeBase64URL(parts[0])));
    if (payload?.v !== 1 || !tokenString(payload.sid, 8, 128) || !tokenString(payload.bid, 8, 128) || !tokenString(payload.rid, 8, 128)) return null;
    if (requireUnexpired && Number(payload.exp) <= Math.floor(now / 1000)) return null;
    return payload;
  } catch { return null; }
}

export function publicRuntimeManifest(value) { const { assetPath: _private, ...safe } = value || {}; return safe; }
export function encodeBase64URL(bytes) { let binary = ''; for (const value of bytes) binary += String.fromCharCode(value); return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/g, ''); }
export function decodeBase64URL(value) { const raw = String(value).replaceAll('-', '+').replaceAll('_', '/'); const binary = atob(raw + '='.repeat((4 - raw.length % 4) % 4)); return Uint8Array.from(binary, (char) => char.charCodeAt(0)); }
export function constantTimeBytes(a, b) { if (a.length !== b.length) return false; let diff = 0; for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i]; return diff === 0; }

async function hmac(value, rawKey) {
  const key = await crypto.subtle.importKey('raw', rawKey, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, utf8(value)));
}
function tokenString(value, min, max) { return typeof value === 'string' && value.length >= min && value.length <= max && /^[A-Za-z0-9._~-]+$/.test(value); }
function utf8(value) { return new TextEncoder().encode(String(value)); }
