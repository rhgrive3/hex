const TYPES = new Set(['format', 'architecture', 'analyzer', 'knowledgeProvider', 'signatureProvider', 'recognitionProvider', 'viewContribution', 'goalProvider']);
const DEFAULT_TIMEOUT_MS = Object.freeze({ analyzer:30000, knowledgeProvider:15000, signatureProvider:15000, recognitionProvider:15000, format:5000, architecture:5000, viewContribution:5000, goalProvider:10000 });
const DEFAULT_MAX_READ = 1024 * 1024;
const DEFAULT_TOTAL_READ = 16 * 1024 * 1024;

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

function pluginError(message, code) {
  const error = new Error(message); error.code = code; return error;
}

function positiveLimit(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

function permissionRanges(permission) {
  if (permission === true) return null;
  if (!permission || permission.allowed !== true) return [];
  const values = Array.isArray(permission.ranges) ? permission.ranges : (permission.start != null || permission.end != null ? [permission] : []);
  if (!values.length) return null;
  return values.map((range) => {
    const start = BigInt(range.start ?? 0);
    const end = range.end == null ? null : BigInt(range.end);
    if (start < 0n || (end != null && end < start)) throw pluginError('invalid plugin read range', 'PLUGIN_READ_RANGE');
    return { start, end };
  });
}

function readPermission(context) {
  return context?.pluginPermissions?.read ?? context?.capability?.pluginRead ?? context?.capability?.readPermission ?? false;
}

function createReadFacade(context) {
  if (typeof context?.read !== 'function') return undefined;
  const permission = readPermission(context);
  if (permission !== true && (!permission || permission.allowed !== true)) return undefined;
  const ranges = permissionRanges(permission);
  const maxReadBytes = positiveLimit(permission?.maxReadBytes, DEFAULT_MAX_READ);
  const maxTotalBytes = positiveLimit(permission?.maxTotalBytes, DEFAULT_TOTAL_READ);
  let consumed = 0;
  return async (address, length) => {
    let addr;
    try { addr = BigInt(address); } catch { throw pluginError('plugin read address is invalid', 'PLUGIN_READ_RANGE'); }
    const len = Number(length);
    if (addr < 0n || !Number.isSafeInteger(len) || len <= 0 || len > maxReadBytes) throw pluginError('plugin read exceeds per-read limit', 'PLUGIN_READ_BUDGET');
    if (consumed + len > maxTotalBytes) throw pluginError('plugin read exceeds total budget', 'PLUGIN_READ_BUDGET');
    const end = addr + BigInt(len);
    if (ranges && !ranges.some((range) => addr >= range.start && (range.end == null || end <= range.end))) throw pluginError('plugin read is outside the permitted range', 'PLUGIN_READ_RANGE');
    consumed += len;
    const value = await context.read(addr, len);
    return safeSnapshot(value);
  };
}

function invocationControl(type, context, args) {
  const option = [...args].reverse().find((x) => x && typeof x === 'object' && ('timeoutMs' in x || 'signal' in x)) || {};
  const timeoutMs = positiveLimit(context?.pluginTimeoutMs ?? option.timeoutMs, DEFAULT_TIMEOUT_MS[type] || 10000);
  const upstreamSignal = context?.signal || option.signal || null;
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  let abortListener = null;
  if (controller && upstreamSignal?.addEventListener) {
    abortListener = () => controller.abort(upstreamSignal.reason);
    if (upstreamSignal.aborted) abortListener(); else upstreamSignal.addEventListener('abort', abortListener, { once:true });
  }
  return { timeoutMs, upstreamSignal, controller, signal:controller?.signal || upstreamSignal || null, cleanup:() => { if (abortListener) upstreamSignal?.removeEventListener?.('abort', abortListener); } };
}

function snapshotArg(arg, signal) {
  if (!arg || typeof arg !== 'object') return arg;
  if (!('signal' in arg)) return safeSnapshot(arg);
  const copy = {};
  for (const [key,value] of Object.entries(arg)) if (key !== 'signal') copy[key]=value;
  const snapshot = safeSnapshot(copy) || {};
  return Object.freeze({ ...snapshot, signal });
}

async function boundedCall(fn, safeContext, safeArgs, control) {
  if (control.upstreamSignal?.aborted) throw pluginError('plugin invocation aborted', 'PLUGIN_ABORTED');
  let timer = null, abortReject = null;
  const pluginPromise = Promise.resolve().then(() => fn(safeContext, ...safeArgs));
  const contenders = [pluginPromise];
  if (control.timeoutMs > 0) contenders.push(new Promise((_resolve,reject) => {
    timer = setTimeout(() => { control.controller?.abort(pluginError('plugin invocation timed out', 'PLUGIN_TIMEOUT')); reject(pluginError(`plugin invocation timed out after ${control.timeoutMs}ms`, 'PLUGIN_TIMEOUT')); }, control.timeoutMs);
  }));
  if (control.upstreamSignal?.addEventListener) contenders.push(new Promise((_resolve,reject) => {
    abortReject = () => reject(pluginError('plugin invocation aborted', 'PLUGIN_ABORTED'));
    control.upstreamSignal.addEventListener('abort', abortReject, { once:true });
  }));
  try { return await Promise.race(contenders); }
  finally {
    if (timer) clearTimeout(timer);
    if (abortReject) control.upstreamSignal?.removeEventListener?.('abort', abortReject);
  }
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
  registerSignatureProvider(id, contribution) { return this.#register('signatureProvider', id, contribution); }
  registerRecognitionProvider(id, contribution) { return this.#register('recognitionProvider', id, contribution); }
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
    const control = invocationControl(type, context, args);
    try {
      const safeContext = Object.freeze({
        binary: safeSnapshot(context.binary),
        capability: safeSnapshot(context.capability),
        project: safeSnapshot(context.project),
        read: createReadFacade(context),
        reportProgress: typeof context.reportProgress === 'function' ? context.reportProgress : undefined,
        signal: control.signal,
      });
      const safeArgs = args.map((arg) => snapshotArg(arg, control.signal));
      return { ok: true, value: await boundedCall(fn, safeContext, safeArgs, control) };
    } catch (error) {
      const failure = { type, id, method, error: error?.message || String(error), code:error?.code || 'PLUGIN_FAILURE', at: Date.now() };
      this.failures.push(failure);
      if (this.failures.length > 100) this.failures.shift();
      return { ok: false, error: failure.error, code:failure.code, isolated: true, timedOut:failure.code === 'PLUGIN_TIMEOUT', aborted:failure.code === 'PLUGIN_ABORTED' };
    } finally { control.cleanup(); }
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

  async runProviders(type, method, context = {}, options = {}) {
    if (!['knowledgeProvider', 'signatureProvider', 'recognitionProvider'].includes(type)) throw new TypeError('unsupported provider type');
    const out = [];
    for (const record of this.list(type)) {
      if (options.signal?.aborted) break;
      const result = await this.invoke(type, record.id, method, context, options);
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
export const registerSignatureProvider = (...args) => platformPlugins.registerSignatureProvider(...args);
export const registerRecognitionProvider = (...args) => platformPlugins.registerRecognitionProvider(...args);
export const registerViewContribution = (...args) => platformPlugins.registerViewContribution(...args);
export const registerGoalProvider = (...args) => platformPlugins.registerGoalProvider(...args);
