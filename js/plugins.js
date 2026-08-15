/*
 * User-installed sandbox plugins plus the stable platform contribution API.
 * User plugins never receive core parser objects directly; platform plugins
 * use the isolated registry exported at the bottom of this module.
 */
import { createApi } from './script.js';
import { runInSandbox } from './sandbox.js';

const STORE_KEY = 'hex.plugins';
const MAX_SOURCE = 512 * 1024;
let fallbackInstallSeq = 1;

function newInstallId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `install_${Date.now().toString(36)}_${(fallbackInstallSeq++).toString(36)}_${Math.random().toString(36).slice(2)}`;
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
        // v1 stored one copy of the same source for every definition discovered
        // from that source. Deduplicate only those legacy rows; v2 has a stable
        // installationId and intentionally permits installing equal source twice.
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
    const groups = new Map();
    for (const p of this.plugins) {
      let row = groups.get(p.installationId);
      if (!row) {
        row = { v: 2, installationId: p.installationId, source: p.source, origin: p.origin, enabledIndexes: [] };
        groups.set(p.installationId, row);
      }
      row.enabledIndexes.push(p.index);
    }
    const list = Array.from(groups.values());
    try { localStorage.setItem(STORE_KEY, JSON.stringify(list)); return true; }
    catch { return false; }
  }

  async install(source, origin, opts = {}) {
    if (typeof source !== 'string' || !source.trim()) return { error: '中身が空です。' };
    if (source.length > MAX_SOURCE) return { error: 'プラグインが大きすぎます（512 KB まで）。' };
    const discovered = await runInSandbox({
      source, mode: 'discover', api: Object.create(null), out: () => {}, timeout: 10000,
    });
    if (discovered.error) return { error: '読み込めませんでした: ' + discovered.error };
    const installationId = String(opts.installationId || newInstallId());
    const enabled = Array.isArray(opts.enabledIndexes) ? new Set(opts.enabledIndexes.map(Number)) : null;
    const added = (discovered.value || []).map((def, index) => ({
      id: `${installationId}:${index}`,
      installationId,
      name: def.name,
      description: def.description,
      index,
      source,
      origin: origin || '不明',
    })).filter((plugin) => !enabled || enabled.has(plugin.index));
    if (!added.length && !enabled) return { error: 'プラグインが 1 つも登録されませんでした（hex.plugin({…}) を呼んでください）。' };
    this.plugins.push(...added);
    if (!opts.silent) this.save();
    return { ok: true, added };
  }

  async installFromUrl(url) {
    let text;
    try {
      const res = await fetch(url, { credentials: 'omit', referrerPolicy: 'no-referrer' });
      if (!res.ok) return { error: '取り寄せられませんでした（' + res.status + '）。' };
      text = await res.text();
    } catch (err) {
      return { error: '取り寄せに失敗しました: ' + ((err && err.message) || err) };
    }
    if (text.length > MAX_SOURCE) return { error: 'プラグインが大きすぎます（512 KB まで）。' };
    return { ok: true, source: text, origin: url, needsConfirmation: true };
  }

  remove(id) {
    const before = this.plugins.length;
    this.plugins = this.plugins.filter((p) => p.id !== id);
    if (this.plugins.length !== before) this.save();
  }
  clear() { this.plugins = []; this.save(); }

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
