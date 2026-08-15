import { DurableObject } from 'cloudflare:workers';
import worker from './worker.js';
import { AI_QUOTA, acquireQuotaState, releaseQuotaState } from './js/ai/quota.js';
import { RUNTIME_BUILD } from './.runtime-build/runtime-secrets.js';
import {
  decodeBase64URL, encodeBase64URL, publicRuntimeManifest,
  signRuntimeSession, validateRuntimeBootstrap, verifyRuntimeSession,
} from './js/userscript/runtime-security.js';

const QUOTA_STATE_KEY = 'quota';
const CHATGPT_ORIGINS = new Set(['https://chatgpt.com', 'https://chat.openai.com']);
const USER_SCRIPT_TEMPLATE = '/userscript/hex.user.template.js';
const BOOTSTRAP_MAX_BYTES = 16 * 1024;
const SESSION_TTL_MS = 2 * 60 * 1000;
const PRIVATE_PREFIXES = ['/.runtime/', '/userscript-assets/', '/js/', '/css/', '/scripts/', '/tests/', '/.github/', '/userscript/'];
const PRIVATE_FILES = new Set(['/package.json', '/package-lock.json', '/worker-entry.js', '/worker.js', '/wrangler.jsonc']);

export class AIQuota extends DurableObject {
  constructor(ctx, env) { super(ctx, env); this.ctx = ctx; }
  async acquire(input = {}) {
    const token = crypto.randomUUID();
    const previous = await this.ctx.storage.get(QUOTA_STATE_KEY);
    const { state, result } = acquireQuotaState(previous, { now: Date.now(), token, sessionId: input.sessionId }, AI_QUOTA);
    await this.ctx.storage.put(QUOTA_STATE_KEY, state); return result;
  }
  async release(token) {
    const previous = await this.ctx.storage.get(QUOTA_STATE_KEY);
    const { state, released } = releaseQuotaState(previous, token, Date.now(), AI_QUOTA);
    await this.ctx.storage.put(QUOTA_STATE_KEY, state); return { released };
  }
}

export class RuntimeBootstrap extends DurableObject {
  constructor(ctx, env) { super(ctx, env); this.ctx = ctx; }
  async issue({ nonce, sessionId, expiry, requestId }) {
    await this.prune();
    const key = `nonce:${nonce}`;
    return this.ctx.storage.transaction(async (tx) => {
      const previous = await tx.get(key);
      if (previous && previous.expiry > Date.now()) return { ok: false, reason: 'replayed-nonce' };
      await tx.put(key, { expiry, requestId }); await tx.put(`session:${sessionId}`, { expiry, requestId, consumed: false });
      return { ok: true };
    });
  }
  async consume({ sessionId, requestId }) {
    return this.ctx.storage.transaction(async (tx) => {
      const key = `session:${sessionId}`, state = await tx.get(key);
      if (!state || state.expiry <= Date.now()) return { ok: false, reason: 'expired-session' };
      if (state.consumed || state.requestId !== requestId) return { ok: false, reason: 'replayed-session' };
      await tx.put(key, { ...state, consumed: true }); return { ok: true };
    });
  }
  async prune() {
    const now = Date.now();
    for (const prefix of ['nonce:', 'session:']) {
      const values = await this.ctx.storage.list({ prefix, limit: 256 });
      const expired = [...values].filter(([, value]) => !value || value.expiry <= now).map(([key]) => key);
      if (expired.length) await this.ctx.storage.delete(expired);
    }
  }
}

export default {
  async fetch(request, env, executionCtx) {
    const url = new URL(request.url);
    if (url.pathname === '/hex.user.js') return serveUserscript(request, env, url, false);
    if (url.pathname === '/hex.meta.js') return serveUserscript(request, env, url, true);
    if (url.pathname === '/runtime/bootstrap') return runtimeBootstrap(request, env, url);
    if (url.pathname.startsWith('/_runtime/')) return protectedRuntime(request, env, url);
    if (isPrivatePath(url.pathname)) return new Response('Not Found', { status: 404, headers: securityHeaders() });
    if (url.pathname.startsWith('/api/')) {
      const origin = request.headers.get('origin');
      if (request.method === 'OPTIONS') return apiPreflight(origin);
      return withApiCors(await worker.fetch(request, env, executionCtx), origin);
    }
    return worker.fetch(request, env, executionCtx);
  },
};

async function serveUserscript(request, env, url, metadataOnly) {
  if (!['GET', 'HEAD'].includes(request.method)) return methodNotAllowed('GET, HEAD');
  const source = await asset(env, url, USER_SCRIPT_TEMPLATE);
  if (!source.ok) return new Response('Hex userscript has not been built.', { status: 503 });
  let body = (await source.text()).replaceAll('__HEX_ORIGIN__', url.origin);
  if (metadataOnly) { const marker = '// ==/UserScript=='; const end = body.indexOf(marker); if (end < 0) return new Response('Invalid userscript metadata.', { status: 500 }); body = body.slice(0, end + marker.length) + '\n'; }
  return new Response(request.method === 'HEAD' ? null : body, { headers: { ...securityHeaders(), 'content-type': 'application/javascript; charset=utf-8', 'cache-control': 'no-cache, no-store, must-revalidate' } });
}

async function runtimeBootstrap(request, env, url) {
  if (request.method === 'OPTIONS') return runtimePreflight(request.headers.get('origin'));
  if (request.method !== 'POST') return methodNotAllowed('POST, OPTIONS');
  const origin = request.headers.get('origin');
  if (origin && origin !== url.origin && !CHATGPT_ORIGINS.has(origin)) return json({ error: 'origin-not-allowed' }, 403);
  const length = Number(request.headers.get('content-length') || 0);
  if (length > BOOTSTRAP_MAX_BYTES) return json({ error: 'request-too-large' }, 413);
  let input;
  try { const text = await request.text(); if (new TextEncoder().encode(text).length > BOOTSTRAP_MAX_BYTES) throw new Error('large'); input = JSON.parse(text); } catch { return json({ error: 'invalid-bootstrap-request' }, 400); }
  const validation = validateRuntimeBootstrap(input, { buildId: RUNTIME_BUILD.manifest.buildId });
  if (validation) return json({ error: validation }, validation === 'wrong-build' ? 409 : 400);

  const sessionId = crypto.randomUUID(), expiryMs = Date.now() + SESSION_TTL_MS;
  const replay = runtimeState(env);
  const issued = await replay.issue({ nonce: input.nonce, sessionId, expiry: expiryMs, requestId: input.requestId });
  if (!issued.ok) return json({ error: issued.reason }, 403);
  try {
    const envelope = await wrapContentKey(input.clientPublicKey, sessionId);
    const payload = { v: 1, sid: sessionId, bid: RUNTIME_BUILD.manifest.buildId, exp: Math.floor(expiryMs / 1000), rid: input.requestId, cid: await shortHash(input.sessionIdentity) };
    const session = await signRuntimeSession(payload, decodeBase64URL(RUNTIME_BUILD.signingKey));
    return json({
      session, sessionId, expiry: new Date(expiryMs).toISOString(), buildId: RUNTIME_BUILD.manifest.buildId,
      manifest: publicRuntimeManifest(RUNTIME_BUILD.manifest), runtimeLocator: `/_runtime/${RUNTIME_BUILD.manifest.buildId}`,
      serverPublicKey: envelope.serverPublicKey, keyEnvelope: envelope.keyEnvelope,
    }, 200, origin, { 'cache-control': 'no-store, private' });
  } catch { return json({ error: 'key-envelope-failed' }, 400); }
}

async function protectedRuntime(request, env, url) {
  if (request.method !== 'GET') return methodNotAllowed('GET');
  const buildId = decodeURIComponent(url.pathname.slice('/_runtime/'.length));
  if (buildId !== RUNTIME_BUILD.manifest.buildId) return json({ error: 'wrong-build' }, 403);
  const raw = request.headers.get('authorization') || '';
  const token = raw.startsWith('Bearer ') ? raw.slice(7) : '';
  const payload = await verifyRuntimeSession(token, decodeBase64URL(RUNTIME_BUILD.signingKey));
  if (!payload || payload.bid !== buildId) return json({ error: 'invalid-or-expired-session' }, 403);
  const consumed = await runtimeState(env).consume({ sessionId: payload.sid, requestId: payload.rid });
  if (!consumed.ok) return json({ error: consumed.reason }, 403);
  const response = await asset(env, url, RUNTIME_BUILD.manifest.assetPath);
  if (!response.ok) return json({ error: 'runtime-unavailable' }, 503);
  const headers = new Headers(securityHeaders()); headers.set('content-type', 'application/octet-stream'); headers.set('content-length', String(RUNTIME_BUILD.manifest.byteLength)); headers.set('cache-control', 'private, max-age=120'); headers.set('x-hex-runtime-build', buildId);
  return new Response(response.body, { status: 200, headers });
}

async function wrapContentKey(clientJwk, sessionId) {
  const clientKey = await crypto.subtle.importKey('jwk', clientJwk, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const serverKeys = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const shared = await crypto.subtle.deriveBits({ name: 'ECDH', public: clientKey }, serverKeys.privateKey, 256);
  const salt = crypto.getRandomValues(new Uint8Array(32)), iv = crypto.getRandomValues(new Uint8Array(12));
  const material = await crypto.subtle.importKey('raw', shared, 'HKDF', false, ['deriveKey']);
  const wrappingKey = await crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt, info: utf8(`hex-runtime-wrap:${RUNTIME_BUILD.manifest.buildId}`) }, material, { name: 'AES-GCM', length: 256 }, false, ['encrypt']);
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: utf8(`${RUNTIME_BUILD.manifest.buildId}:${sessionId}`), tagLength: 128 }, wrappingKey, decodeBase64URL(RUNTIME_BUILD.contentKey));
  new Uint8Array(shared).fill(0);
  return { serverPublicKey: await crypto.subtle.exportKey('jwk', serverKeys.publicKey), keyEnvelope: { algorithm: 'ECDH-P256+HKDF-SHA256+A256GCM', salt: encodeBase64URL(salt), iv: encodeBase64URL(iv), ciphertext: encodeBase64URL(new Uint8Array(ciphertext)) } };
}

function runtimeState(env) { if (!env.RUNTIME_BOOTSTRAP) throw new Error('RUNTIME_BOOTSTRAP binding is unavailable'); return env.RUNTIME_BOOTSTRAP.get(env.RUNTIME_BOOTSTRAP.idFromName('runtime-v1')); }
function isPrivatePath(path) { return PRIVATE_FILES.has(path) || PRIVATE_PREFIXES.some((prefix) => path.startsWith(prefix)); }
async function asset(env, url, path) { if (!env.ASSETS?.fetch) return new Response(null, { status: 503 }); return env.ASSETS.fetch(new Request(new URL(path, url.origin), { method: 'GET' })); }
function methodNotAllowed(allow) { return new Response('Method Not Allowed', { status: 405, headers: { ...securityHeaders(), allow } }); }
function securityHeaders() { return { 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'cross-origin-resource-policy': 'same-site' }; }
function utf8(value) { return new TextEncoder().encode(String(value)); }
async function shortHash(value) { const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', utf8(value))); return encodeBase64URL(digest.slice(0, 12)); }

function runtimePreflight(origin) {
  if (origin && !CHATGPT_ORIGINS.has(origin) && origin !== 'https://ida.rhgrive.workers.dev') return new Response(null, { status: 403 });
  return new Response(null, { status: 204, headers: { 'access-control-allow-origin': origin || 'https://ida.rhgrive.workers.dev', 'access-control-allow-methods': 'POST, OPTIONS', 'access-control-allow-headers': 'Content-Type', 'access-control-max-age': '600', vary: 'Origin' } });
}
function apiPreflight(origin) { if (!CHATGPT_ORIGINS.has(origin)) return new Response(null, { status: 403 }); return new Response(null, { status: 204, headers: { 'access-control-allow-origin': origin, 'access-control-allow-methods': 'POST, OPTIONS', 'access-control-allow-headers': 'Content-Type, X-Hex-Session', 'access-control-max-age': '86400', vary: 'Origin' } }); }
function withApiCors(response, origin) { if (!CHATGPT_ORIGINS.has(origin)) return response; const headers = new Headers(response.headers); headers.set('access-control-allow-origin', origin); headers.set('access-control-allow-methods', 'POST, OPTIONS'); headers.set('access-control-allow-headers', 'Content-Type, X-Hex-Session'); headers.set('vary', appendVary(headers.get('vary'), 'Origin')); return new Response(response.body, { status: response.status, statusText: response.statusText, headers }); }
function appendVary(current, value) { const parts = String(current || '').split(',').map((item) => item.trim()).filter(Boolean); if (!parts.some((item) => item.toLowerCase() === value.toLowerCase())) parts.push(value); return parts.join(', '); }
function json(body, status = 200, origin = null, extra = {}) { const headers = new Headers({ ...securityHeaders(), 'content-type': 'application/json; charset=utf-8', ...extra }); if (origin && CHATGPT_ORIGINS.has(origin)) { headers.set('access-control-allow-origin', origin); headers.set('vary', 'Origin'); } return new Response(JSON.stringify(body), { status, headers }); }

export const __runtimeTest = { isPrivatePath };
