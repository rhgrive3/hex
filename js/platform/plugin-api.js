const TYPES = new Set(['format', 'architecture', 'analyzer', 'knowledgeProvider', 'viewContribution', 'goalProvider']);

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
      const safeContext = Object.freeze({
        binary: context.binary ? Object.freeze({ ...context.binary }) : null,
        capability: context.capability ? Object.freeze({ ...context.capability }) : null,
        project: context.project ? Object.freeze({ ...context.project }) : null,
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
