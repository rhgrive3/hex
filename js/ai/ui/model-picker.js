/*
 * What the UI is allowed to say about providers and models.
 *
 * The list is never hardcoded here. The engine advertises it — `aiCapabilities()`
 * for what exists, `aiStatus()` for what is reachable right now, and
 * `getAISelection()` / `setAISelection()` for the current choice — and this
 * module only normalizes whatever shape comes back. When none of those exist
 * yet the picker still works: it shows the two providers Hex can host, marks
 * them unreachable, and keeps the choice as conversation metadata so the
 * engine receives it once it starts listening.
 *
 * Rule: never rewrite a selection just to make the chip look valid. A model
 * the engine no longer advertises reads as unavailable, with its own name.
 *
 * Pure module — no DOM. Tested by tests/ai-ui-conversations.mjs.
 */

export const FALLBACK_PROVIDERS = Object.freeze([
  { id: 'chatgpt-web', label: 'ChatGPT Web' },
  { id: 'gemini', label: 'Gemini' },
]);

const text = (value) => (value == null ? '' : String(value));

function normalizeProviderId(value) {
  const id = text(value).trim();
  const key = id.toLowerCase();
  if (key === 'chatgpt' || key === 'chatgpt-web') return 'chatgpt-web';
  if (key === 'worker' || key === 'gemini') return 'gemini';
  return id;
}

function normalizeEntry(raw, fallbackLabel) {
  if (raw == null) return null;
  if (typeof raw === 'string') return { id: raw, label: fallbackLabel || raw, available: true };
  const id = text(raw.id || raw.value || raw.name || raw.model || raw.slug);
  if (!id) return null;
  return {
    id,
    label: text(raw.label || raw.displayName || raw.title || raw.name || id) || id,
    available: raw.available === undefined ? true : !!raw.available,
    detail: text(raw.detail || raw.description || ''),
  };
}

function normalizeList(raw, mapper) {
  if (!raw) return [];
  const items = Array.isArray(raw) ? raw : Object.entries(raw).map(([id, value]) => (
    value && typeof value === 'object' ? { id, ...value } : { id, label: text(value) || id }
  ));
  return items.map(mapper).filter(Boolean);
}

/**
 * Accepts the shapes an engine may reasonably advertise: an array of provider
 * objects, a map keyed by provider id, or bare id strings, with models and
 * reasoning levels in the same three shapes.
 */
export function normalizeCapabilities(raw) {
  const source = raw && typeof raw === 'object' ? raw : null;
  const providersRaw = source ? (source.providers || source.provider || source) : null;
  const providers = normalizeList(providersRaw, (item) => {
    const base = normalizeEntry(item, null);
    if (!base) return null;
    const providerId = normalizeProviderId(base.id);
    if (!providerId) return null;
    const models = normalizeList(item && typeof item === 'object' ? (item.models || item.model) : null, (m) => {
      const model = normalizeEntry(m);
      if (!model) return null;
      /* A model may advertise its own reasoning levels; otherwise the
         provider's list applies to all of them. */
      const levels = m && typeof m === 'object' ? (m.reasoning || m.reasoningLevels || m.effort) : null;
      return { ...model, reasoning: normalizeList(levels, (r) => normalizeEntry(r)) };
    });
    const reasoning = normalizeList(item && typeof item === 'object' ? (item.reasoning || item.reasoningLevels || item.effort) : null, (r) => normalizeEntry(r));
    const defaultModel = item && typeof item === 'object' ? text(item.defaultModel || item.default) : '';
    return { ...base, id: providerId, models, reasoning, defaultModel: defaultModel || null };
  });
  if (!providers.length) {
    return { known: false, providers: FALLBACK_PROVIDERS.map((item) => ({ ...item, available: false, models: [], reasoning: [], defaultModel: null })) };
  }
  return { known: true, providers };
}

/**
 * Fold `aiStatus()` into what `aiCapabilities()` advertised.
 *
 * `available` is provider reachability. `ready` is deliberately not the same
 * thing: the userscript proxy can briefly cache ready=false while the parent
 * page/composer is still settling. That transient state must not downgrade a
 * bridge that capabilities already proved exists. An explicit available=false
 * remains authoritative; ready=true may positively confirm availability.
 */
export function applyStatus(capabilities, status) {
  if (!status || typeof status !== 'object') return capabilities;
  const byId = new Map();
  const collect = (raw) => {
    if (!raw) return;
    if (typeof raw === 'string') {
      const id = normalizeProviderId(raw);
      if (id) byId.set(id, true);
      return;
    }
    for (const entry of normalizeList(raw, (item) => normalizeEntry(item))) {
      const id = normalizeProviderId(entry.id);
      if (id) byId.set(id, entry.available);
    }
  };
  collect(status.providers || (typeof status.provider === 'object' ? status.provider : null));
  const active = normalizeProviderId(status.providerId || (typeof status.provider === 'string' ? status.provider : ''));
  if (active) {
    if (status.available !== undefined) byId.set(active, !!status.available);
    else if (status.ready === true) byId.set(active, true);
  }
  if (!byId.size) return capabilities;
  return {
    ...capabilities,
    providers: capabilities.providers.map((provider) => (
      byId.has(provider.id) ? { ...provider, available: byId.get(provider.id) } : provider
    )),
  };
}

export function findProvider(capabilities, id) {
  if (!capabilities || !id) return null;
  const normalized = normalizeProviderId(id);
  return capabilities.providers.find((item) => item.id === normalized) || null;
}

export function findModel(provider, id) {
  if (!provider || !id) return null;
  return provider.models.find((item) => item.id === String(id)) || null;
}

export function findReasoning(provider, model, id) {
  if (!id) return null;
  const pools = [model && model.reasoning, provider && provider.reasoning];
  for (const pool of pools) {
    if (!Array.isArray(pool)) continue;
    const hit = pool.find((item) => item.id === String(id));
    if (hit) return hit;
  }
  return null;
}

/** Everything the chip needs: what to print, and whether it is reachable. */
export function selectionLabel(capabilities, selection = {}, ja = true) {
  const unknownLabel = ja ? '利用不可' : 'Unavailable';
  const provider = findProvider(capabilities, selection.provider);
  if (selection.provider && !provider) return { text: String(selection.provider), unavailable: true, note: unknownLabel };
  if (!provider) {
    return capabilities && capabilities.known
      ? { text: ja ? 'モデルを選ぶ' : 'Choose model', unavailable: false, note: '' }
      : { text: ja ? 'モデル未接続' : 'No model', unavailable: true, note: unknownLabel };
  }
  const model = findModel(provider, selection.model);
  if (selection.model && !model) return { text: String(selection.model), unavailable: true, note: unknownLabel };
  const parts = [model ? model.label : provider.label];
  if (selection.reasoning) {
    const reasoning = findReasoning(provider, model, selection.reasoning);
    parts.push(reasoning ? reasoning.label : String(selection.reasoning));
  }
  const unavailable = provider.available === false || !!(model && model.available === false);
  return { text: parts.join(' · '), unavailable, note: unavailable ? unknownLabel : '' };
}

/**
 * The selection after picking a provider.
 *
 * A model from the previous provider is dropped rather than carried over, and
 * a provider's advertised default is taken only when it advertises one.
 */
export function selectionForProvider(capabilities, providerId, previous = {}) {
  const normalizedProvider = normalizeProviderId(providerId);
  const provider = findProvider(capabilities, normalizedProvider);
  if (!provider) return { provider: normalizedProvider || null, model: null, reasoning: null };
  const sameProvider = normalizeProviderId(previous.provider) === provider.id;
  const keptModel = sameProvider ? findModel(provider, previous.model) : null;
  const model = keptModel || findModel(provider, provider.defaultModel);
  const keptReasoning = sameProvider ? findReasoning(provider, model, previous.reasoning) : null;
  return { provider: provider.id, model: model ? model.id : null, reasoning: keptReasoning ? keptReasoning.id : null };
}

/**
 * Feature detection for the engine-side API.
 *
 * Everything is optional and may be sync or async; nothing here throws into
 * the UI. Absent APIs simply return null and the picker degrades to metadata.
 */
export function capabilityApi(engine) {
  const scope = typeof globalThis === 'undefined' ? {} : globalThis;
  const lookup = (name) => {
    for (const host of [engine, scope, scope.__HEX_AI__]) {
      if (host && typeof host[name] === 'function') return host[name].bind(host);
    }
    return null;
  };
  return {
    capabilities: lookup('aiCapabilities'),
    status: lookup('aiStatus'),
    get: lookup('getAISelection'),
    set: lookup('setAISelection'),
  };
}

/** Call an optional capability function without ever rejecting. */
export async function callSafely(fn, ...args) {
  if (typeof fn !== 'function') return null;
  try { return await fn(...args); } catch { return null; }
}

export default { normalizeCapabilities, selectionLabel, selectionForProvider, capabilityApi };
