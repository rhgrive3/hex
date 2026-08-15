import { DurableObject } from 'cloudflare:workers';
import worker from './worker.js';
import { AI_QUOTA, acquireQuotaState, releaseQuotaState } from './js/ai/quota.js';

const STATE_KEY = 'quota';
const CHATGPT_ORIGINS = new Set(['https://chatgpt.com', 'https://chat.openai.com']);
const USER_SCRIPT_PATH = '/hex.user.js';
const USER_SCRIPT_TEMPLATE = '/userscript/hex.user.template.js';
const USER_SCRIPT_ASSET_PREFIX = '/userscript-assets/';

export class AIQuota extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx = ctx;
  }

  async acquire(input = {}) {
    const now = Date.now();
    const token = crypto.randomUUID();
    const previous = await this.ctx.storage.get(STATE_KEY);
    const { state, result } = acquireQuotaState(previous, {
      now,
      token,
      sessionId: input.sessionId,
    }, AI_QUOTA);
    await this.ctx.storage.put(STATE_KEY, state);
    return result;
  }

  async release(token) {
    const previous = await this.ctx.storage.get(STATE_KEY);
    const { state, released } = releaseQuotaState(previous, token, Date.now(), AI_QUOTA);
    await this.ctx.storage.put(STATE_KEY, state);
    return { released };
  }
}

export default {
  async fetch(request, env, executionCtx) {
    const url = new URL(request.url);

    if (url.pathname === USER_SCRIPT_PATH) return serveUserscript(request, env, url);
    if (url.pathname.startsWith(USER_SCRIPT_ASSET_PREFIX)) return serveUserscriptAsset(request, env, url);

    if (url.pathname.startsWith('/api/')) {
      const origin = request.headers.get('origin');
      if (request.method === 'OPTIONS') return apiPreflight(origin);
      const response = await worker.fetch(request, env, executionCtx);
      return withApiCors(response, origin);
    }

    return worker.fetch(request, env, executionCtx);
  },
};

async function serveUserscript(request, env, url) {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response('Method Not Allowed', { status: 405, headers: { Allow: 'GET, HEAD' } });
  }
  if (!env.ASSETS || typeof env.ASSETS.fetch !== 'function') return new Response('Static assets unavailable.', { status: 503 });

  const templateUrl = new URL(USER_SCRIPT_TEMPLATE, url.origin);
  const source = await env.ASSETS.fetch(new Request(templateUrl, { method: 'GET' }));
  if (!source.ok) return new Response('Hex userscript has not been built.', { status: 503 });
  const text = (await source.text()).split('__HEX_ORIGIN__').join(url.origin);
  const headers = new Headers({
    'content-type': 'application/javascript; charset=utf-8',
    'cache-control': 'no-cache, no-store, must-revalidate',
    'x-content-type-options': 'nosniff',
  });
  return new Response(request.method === 'HEAD' ? null : text, { status: 200, headers });
}

async function serveUserscriptAsset(request, env, url) {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response('Method Not Allowed', { status: 405, headers: { Allow: 'GET, HEAD' } });
  }
  if (!env.ASSETS || typeof env.ASSETS.fetch !== 'function') return new Response('Static assets unavailable.', { status: 503 });

  const suffix = url.pathname.slice(USER_SCRIPT_ASSET_PREFIX.length);
  if (!suffix || suffix.split('/').some((part) => part === '..')) return new Response('Invalid asset path.', { status: 400 });
  const assetUrl = new URL('/' + suffix, url.origin);
  const assetRequest = new Request(assetUrl, { method: request.method, headers: request.headers });
  const response = await env.ASSETS.fetch(assetRequest);
  const headers = new Headers(response.headers);
  headers.set('access-control-allow-origin', '*');
  headers.set('cross-origin-resource-policy', 'cross-origin');
  headers.set('timing-allow-origin', '*');
  headers.set('vary', appendVary(headers.get('vary'), 'Origin'));
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function apiPreflight(origin) {
  if (!CHATGPT_ORIGINS.has(origin)) return new Response(null, { status: 403 });
  return new Response(null, {
    status: 204,
    headers: {
      'access-control-allow-origin': origin,
      'access-control-allow-methods': 'POST, OPTIONS',
      'access-control-allow-headers': 'Content-Type, X-Hex-Session',
      'access-control-max-age': '86400',
      'vary': 'Origin',
    },
  });
}

function withApiCors(response, origin) {
  if (!CHATGPT_ORIGINS.has(origin)) return response;
  const headers = new Headers(response.headers);
  headers.set('access-control-allow-origin', origin);
  headers.set('access-control-allow-methods', 'POST, OPTIONS');
  headers.set('access-control-allow-headers', 'Content-Type, X-Hex-Session');
  headers.set('vary', appendVary(headers.get('vary'), 'Origin'));
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function appendVary(current, value) {
  const parts = String(current || '').split(',').map((part) => part.trim()).filter(Boolean);
  if (!parts.some((part) => part.toLowerCase() === value.toLowerCase())) parts.push(value);
  return parts.join(', ');
}
