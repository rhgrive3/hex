const TYPES = new Set(['format', 'architecture', 'analyzer', 'knowledgeProvider', 'viewContribution', 'goalProvider']);

function deepFreeze(value, seen = new WeakSet()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return value;
  seen.add(value);
  if (value instanceof Map) {
    for (const [k, v] of value) { deepFreeze(k, seen); deepFreeze(v, seen); }
  } else if (value instanceof Set) {
    for (const v of value) deepFreeze(v, seen);
  } else {
    for (const key of Reflect.ownKeys(value)) {
      const desc = Object.getOwnPropertyDescriptor(value, key);
      if (desc && 'value' in desc) deepFreeze(desc.value, seen);
    }
  }
  try { Object.freeze(value); } catch { /* typed-array views may reject freeze */ }
  return value;
}

function fallbackClone(value, seen = new WeakMap(), depth = 0) {
  if (value == null || typeof value !== 'object') return value;
  if (depth > 32) throw new Error('plugin context nesting exceeds safety limit');
  if (seen.has(value)) return seen.get(value);
  if (value instanceof Date) return new Date(value.getTime());
  if (value instanceof ArrayBuffer) return value.slice(0);
  if (ArrayBuffer.isView(value)) {
    if (value instanceof DataView) return new DataView(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
    return value.slice ? value.slice() : new value.constructor(value);
  }
  if (value instanceof Map) {
    const out = new Map(); seen.set(value, out);
    for (const [k, v] of value) out.set(fallbackClone(k, seen, depth + 1), fallbackClone(v, seen, depth + 1));
    return out;
  }
  if (value instanceof Set) {
    const out = new Set(); seen.set(value, out);
    for (const v of value) out.add(fallbackClone(v, seen, depth + 1));
    return out;
  }
  if (Array.isArray(value)) {
    const out = []; seen.set(value, out);
    for (const v of value) out.push(fallbackClone(v, seen, depth + 1));
    return out;
  }
  const out = Object.create(null); seen.set(value, out);
  for (const [key, v] of Object.entries(value)) {
    if (typeof v === 'function') continue;
    out[key] = fallbackClone(v, seen, depth + 1);
  }
  return out;
}

function safeSnapshot(value) {
  if (value == null) return null;
  let clone;
  if (typeof structuredClone === 'function') {
    try { clone = structuredClone(value); } catch { clone = fallbackClone(value); }
  } else clone = fallbackClone(value);
  return deepFreeze(clone);
}

export class PlatformPluginRegistry {
  constructor() {
    this.entries = new Map([...TYPES].map((type) => [type, new Map()]));
    this.failures = [];
  }

  registerFormat(id, contribution) { return this.#register('format', id, contribution); }
  registerArchitecture(id, contribution) { return this.#register('architecture', id, contribution); }
  registerAnalyzer(id, contribution) { return this.#register('analyzer', id, contribution); }
  registerKnowledgeProvider(id, contribution) { return this.#register('knowledgeProvider', id, contribution); }
  registerViewContribution(id, contribution) { return this.#register('viewContribution', id, contribution); }
  registerGoalProvider(id, contribution) { return this.#register('goalProvider', id, contribution); }

  #register(type, id, contribution) {
    if (!TYPES.has(type)) throw new Error(`unsupported plugin contribution type: ${type}`);
    if (!/^[a-z0-9][a-z0-9._-]{1,127}$/i.test(String(id || ''))) throw new TypeError('plugin contribution id must be stable and non-empty');
    if (!contribution || typeof contribution !== 'object') throw new TypeError('plugin contribution must be an object');
    const bucket = this.entries.get(type);
    if (bucket.has(id)) throw new Error(`plugin contribution already registered: ${type}:${id}`);
    const record = Object.freeze({ id: String(id), type, contribution: Object.freeze({ ...contribution }) });
    bucket.set(id, record);
    return () => bucket.delete(id);
  }

  list(type) {
    if (!TYPES.has(type)) return [];
    return [...this.entries.get(type).values()];
  }

  async invoke(type, id, method, context = {}, ...args) {
    const record = this.entries.get(type)?.get(id);
    if (!record) return { ok: false, error: `unknown contribution ${type}:${id}` };
    const fn = record.contribution[method];
    if (typeof fn !== 'function') return { ok: false, error: `contribution ${type}:${id} has no ${method}()` };
    try {
      // Plugins receive detached snapshots of host-owned state. Freezing a
      // shallow spread is insufficient because project.user, arrays and Maps
      // would still point at live application objects.
      const safeContext = Object.freeze({
        binary: safeSnapshot(context.binary),
        capability: safeSnapshot(context.capability),
        project: safeSnapshot(context.project),
        read: typeof context.read === 'function' ? context.read : undefined,
        reportProgress: typeof context.reportProgress === 'function' ? context.reportProgress : undefined,
      });
      return { ok: true, value: await fn(safeContext, ...args) };
    } catch (error) {
      const failure = { type, id, method, error: error?.message || String(error), at: Date.now() };
      this.failures.push(failure);
      if (this.failures.length > 100) this.failures.shift();
      return { ok: false, error: failure.error, isolated: true };
    }
  }

  async runAnalyzers(context, options = {}) {
    const out = [];
    for (const record of this.list('analyzer')) {
      if (options.signal?.aborted) break;
      const result = await this.invoke('analyzer', record.id, 'analyze', context, options);
      out.push({ id: record.id, ...result });
    }
    return out;
  }
}

export const platformPlugins = new PlatformPluginRegistry();

export const registerFormat = (...args) => platformPlugins.registerFormat(...args);
export const registerArchitecture = (...args) => platformPlugins.registerArchitecture(...args);
export const registerAnalyzer = (...args) => platformPlugins.registerAnalyzer(...args);
export const registerKnowledgeProvider = (...args) => platformPlugins.registerKnowledgeProvider(...args);
export const registerViewContribution = (...args) => platformPlugins.registerViewContribution(...args);
export const registerGoalProvider = (...args) => platformPlugins.registerGoalProvider(...args);
