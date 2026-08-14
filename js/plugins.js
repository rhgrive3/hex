/*
 * User-installed sandbox plugins plus the stable platform contribution API.
 * User plugins never receive core parser objects directly; platform plugins
 * use the isolated registry exported at the bottom of this module.
 */
import { createApi } from './script.js';
import { runInSandbox } from './sandbox.js';

const STORE_KEY = 'hex.plugins';
const MAX_SOURCE = 512 * 1024;

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
      for (const p of list) {
        if (!p || typeof p.source !== 'string') continue;
        await this.install(p.source, p.origin || '保存されたもの', { silent: true });
      }
    } catch { /* corrupted plugin storage is isolated */ }
  }

  save() {
    const list = this.plugins.map((p) => ({ source: p.source, origin: p.origin }));
    try { localStorage.setItem(STORE_KEY, JSON.stringify(list)); } catch { /* quota */ }
  }

  async install(source, origin, opts) {
    if (typeof source !== 'string' || !source.trim()) return { error: '中身が空です。' };
    if (source.length > MAX_SOURCE) return { error: 'プラグインが大きすぎます（512 KB まで）。' };
    const discovered = await runInSandbox({
      source, mode: 'discover', api: Object.create(null), out: () => {}, timeout: 10000,
    });
    if (discovered.error) return { error: '読み込めませんでした: ' + discovered.error };
    const added = (discovered.value || []).map((def, index) => ({
      id: 'p' + (this.plugins.length + index + 1),
      name: def.name,
      description: def.description,
      index,
      source,
      origin: origin || '不明',
    }));
    if (!added.length) return { error: 'プラグインが 1 つも登録されませんでした（hex.plugin({…}) を呼んでください）。' };
    this.plugins.push(...added);
    if (!opts || !opts.silent) this.save();
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

  remove(id) { this.plugins = this.plugins.filter((p) => p.id !== id); this.save(); }
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
