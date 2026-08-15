/*
 * User-installed sandbox plugins plus the stable platform contribution API.
 * User plugins never receive core parser objects directly; platform plugins
 * use the isolated registry exported at the bottom of this module.
 */
import { createApi } from './script.js';
import { runInSandbox } from './sandbox.js';

const STORE_KEY = 'hex.plugins';
export const MAX_PLUGIN_SOURCE_BYTES = 512 * 1024;
const sourceBytes = (source) => new TextEncoder().encode(String(source || '')).byteLength;
let fallbackInstallSeq = 1;

function newInstallId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `install_${Date.now().toString(36)}_${(fallbackInstallSeq++).toString(36)}_${Math.random().toString(36).slice(2)}`;
}

async function boundedResponseText(res, maxBytes = MAX_PLUGIN_SOURCE_BYTES) {
  const rawLength = res.headers?.get?.('content-length');
  if (rawLength != null && rawLength !== '') {
    const n = Number(rawLength);
    if (Number.isFinite(n) && n > maxBytes) throw new Error('PLUGIN_TOO_LARGE');
  }
  if (!res.body?.getReader) {
    const n = Number(rawLength);
    if (!Number.isFinite(n) || n < 0 || n > maxBytes) throw new Error('PLUGIN_UNBOUNDED_RESPONSE');
    const text = await res.text();
    if (sourceBytes(text) > maxBytes) throw new Error('PLUGIN_TOO_LARGE');
    return text;
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let text = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value?.byteLength || 0;
      if (total > maxBytes) {
        try { await reader.cancel('plugin source exceeds limit'); } catch {}
        throw new Error('PLUGIN_TOO_LARGE');
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
  } finally {
    try { reader.releaseLock?.(); } catch {}
  }
  if (sourceBytes(text) > maxBytes) throw new Error('PLUGIN_TOO_LARGE');
  return text;
}

export class PluginHost {
  constructor(app) {
    this.app = app;
    this.plugins = [];
    this.ready = this.load();
  }

  async load() {
    let raw = null;
    try { raw = localStorage.getItem(STORE_KEY); } catch { return; }
    if (!raw) return;
    try {
      const list = JSON.parse(raw);
      if (!Array.isArray(list)) return;
      const legacySeen = new Set();
      for (const p of list) {
        if (!p || typeof p.source !== 'string') continue;
        /* v1 stored the same source once per discovered definition. Collapse
           those legacy duplicates only; v2 deliberately permits installing the
           same source twice because each installation has a distinct UUID. */
        if (!p.installationId) {
          const legacyKey = `${p.origin || ''}\u0000${p.source}`;
          if (legacySeen.has(legacyKey)) continue;
          legacySeen.add(legacyKey);
        }
        await this.install(p.source, p.origin || '保存されたもの', {
          silent: true,
          installationId: p.installationId || newInstallId(),
          enabledIndexes: Array.isArray(p.enabledIndexes) ? p.enabledIndexes : null,
        });
      }
    } catch { /* corrupted plugin storage is isolated */ }
  }

  save() {
    /* Persist source/package state once per installation rather than duplicating
       the entire source for every definition discovered from that source. */
    const groups = new Map();
    for (const p of this.plugins) {
      let row = groups.get(p.installationId);
      if (!row) {
        row = {
          v: 2,
          installationId: p.installationId,
          source: p.source,
          origin: p.origin,
          enabledIndexes: [],
        };
        groups.set(p.installationId, row);
      }
      row.enabledIndexes.push(p.index);
    }
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(Array.from(groups.values())));
      return { ok: true };
    } catch (error) {
      return { ok: false, error: (error && error.message) || 'plugin storage failed' };
    }
  }

  async install(source, origin, opts = {}) {
    if (typeof source !== 'string' || !source.trim()) return { error: '中身が空です。' };
    if (sourceBytes(source) > MAX_PLUGIN_SOURCE_BYTES) return { error: 'プラグインが大きすぎます（512 KB まで）。' };
    const discovered = await runInSandbox({
      source, mode: 'discover', api: Object.create(null), out: () => {}, timeout: 10000,
    });
    if (discovered.error) return { error: '読み込めませんでした: ' + discovered.error };

    const installationId = String(opts.installationId || newInstallId());
    const enabled = Array.isArray(opts.enabledIndexes)
      ? new Set(opts.enabledIndexes.map(Number).filter(Number.isInteger))
      : null;
    const all = (discovered.value || []).map((def, index) => ({
      id: `${installationId}:${index}`,
      installationId,
      name: def.name,
      description: def.description,
      index,
      source,
      origin: origin || '不明',
    }));
    if (!all.length) return { error: 'プラグインが 1 つも登録されませんでした（hex.plugin({…}) を呼んでください）。' };
    const added = enabled ? all.filter((plugin) => enabled.has(plugin.index)) : all;
    /* A persisted installation may intentionally have no enabled definitions;
       a fresh installation may not. */
    if (!added.length && !enabled) return { error: 'プラグインが 1 つも登録されませんでした（hex.plugin({…}) を呼んでください）。' };

    const before = this.plugins.slice();
    this.plugins.push(...added);
    if (!opts.silent) {
      const saved = this.save();
      if (!saved.ok) {
        this.plugins = before;
        return { error: 'プラグインを保存できませんでした: ' + saved.error, persistenceError: true };
      }
    }
    return { ok: true, added, installationId };
  }

  async installFromUrl(url) {
    let text;
    try {
      const res = await fetch(url, { credentials: 'omit', referrerPolicy: 'no-referrer' });
      if (!res.ok) return { error: '取り寄せられませんでした（' + res.status + '）。' };
      text = await boundedResponseText(res);
    } catch (err) {
      if (err?.message === 'PLUGIN_TOO_LARGE') return { error: 'プラグインが大きすぎます（512 KB まで）。' };
      if (err?.message === 'PLUGIN_UNBOUNDED_RESPONSE') return { error: 'サイズを安全に確認できない応答だったため読み込みませんでした。' };
      return { error: '取り寄せに失敗しました: ' + ((err && err.message) || err) };
    }
    return { ok: true, source: text, origin: url, needsConfirmation: true };
  }

  remove(id) {
    const before = this.plugins.slice();
    this.plugins = this.plugins.filter((p) => p.id !== id);
    const saved = this.save();
    if (!saved.ok) {
      this.plugins = before;
      return { ok: false, error: saved.error, persistenceError: true };
    }
    return { ok: true };
  }

  clear() {
    const before = this.plugins.slice();
    this.plugins = [];
    const saved = this.save();
    if (!saved.ok) {
      this.plugins = before;
      return { ok: false, error: saved.error, persistenceError: true };
    }
    return { ok: true };
  }

  async run(id, out) {
    const p = this.plugins.find((x) => x.id === id);
    if (!p) return { error: 'そのプラグインが見つかりません。' };
    const { api, print } = createApi(this.app, out);
    return runInSandbox({ source: p.source, mode: 'plugin', index: p.index, api,
      out: (...args) => print(...args) });
  }
}

export const EXAMPLE_PLUGIN = `hex.plugin({
  name: '大きい関数を並べる',
  description: '命令数の多い関数から順に 30 個。処理の中心を探すときに。',
  async run(hex, print) {
    const list = (await hex.functions())
      .filter((f) => f.size)
      .sort((a, b) => Number(b.size - a.size))
      .slice(0, 30);
    for (const f of list) {
      print(hex.hex(f.addr), String(Number(f.size) / 4) + ' 命令', f.name || '');
    }
  },
});`;

export {
  PlatformPluginRegistry, platformPlugins,
  registerFormat, registerArchitecture, registerAnalyzer, registerKnowledgeProvider,
  registerSignatureProvider, registerRecognitionProvider,
  registerViewContribution, registerGoalProvider,
} from './platform/plugin-api.js';
