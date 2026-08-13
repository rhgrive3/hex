/*
 * プラグイン（機能の追加）。
 *
 * このツールに無い調べ方が欲しくなったら、JavaScript を 1 ファイル書いて
 * 読み込ませれば、メニューに項目が増えます。IDA のプラグインと同じ考え方です。
 *
 * プラグインの形はとても簡単で、こう書きます:
 *
 *   hex.plugin({
 *     name: 'ぜんぶの文字列を数える',
 *     description: '同じ文字列が何回使われているかを並べます',
 *     async run(hex, print) {
 *       await hex.loadStrings();
 *       print('文字列の数:', hex.strings().length);
 *     },
 *   });
 *
 * 読み込み方は 2 つ:
 *   - 端末の中のファイルを選ぶ
 *   - URL を入れて取り寄せる（ネットにつながっているときだけ）
 *
 * 安全のために:
 *   - プラグインは、あなたが選んだものだけが動きます。
 *   - 中身は実行前に画面で確認できます（読まずに動かさないでください）。
 *   - 解析中のファイルの中身が外へ送られることはありません
 *     （プラグインから通信の道具は渡していません）。
 */

import { createApi } from './script.js';

const STORE_KEY = 'hex.plugins';
const MAX_SOURCE = 512 * 1024;

export class PluginHost {
  constructor(app) {
    this.app = app;
    this.plugins = [];          // {id, name, description, run, source, origin}
    this.load();
  }

  /* ── 保存 ─────────────────────────────────────────── */

  load() {
    let raw = null;
    try { raw = localStorage.getItem(STORE_KEY); } catch { return; }
    if (!raw) return;
    try {
      const list = JSON.parse(raw);
      for (const p of list) {
        if (!p || typeof p.source !== 'string') continue;
        this.install(p.source, p.origin || '保存されたもの', { silent: true });
      }
    } catch { /* 壊れていたら読まない */ }
  }

  save() {
    const list = this.plugins.map((p) => ({ source: p.source, origin: p.origin }));
    try { localStorage.setItem(STORE_KEY, JSON.stringify(list)); } catch { /* 容量いっぱい */ }
  }

  /* ── 読み込み ─────────────────────────────────────── */

  /**
   * プラグインの中身（JavaScript のソース）を取り込む。
   * @returns {{ok:true, added:Array}|{error:string}}
   */
  install(source, origin, opts) {
    if (typeof source !== 'string' || !source.trim()) return { error: '中身が空です。' };
    if (source.length > MAX_SOURCE) return { error: 'プラグインが大きすぎます（512 KB まで）。' };

    const added = [];
    const registrar = {
      plugin: (def) => {
        if (!def || typeof def.run !== 'function') throw new Error('run（実行する処理）がありません。');
        const entry = {
          id: 'p' + (this.plugins.length + added.length + 1),
          name: String(def.name || '名前のないプラグイン').slice(0, 80),
          description: String(def.description || '').slice(0, 200),
          run: def.run,
          source,
          origin: origin || '不明',
        };
        added.push(entry);
      },
    };

    try {
      // eslint-disable-next-line no-new-func
      const fn = new Function('hex', 'module', 'exports', source);
      const module = { exports: {} };
      fn(registrar, module, module.exports);
      // module.exports 形式にも対応
      const def = module.exports && typeof module.exports.run === 'function' ? module.exports : null;
      if (def) registrar.plugin(def);
    } catch (err) {
      return { error: '読み込めませんでした: ' + ((err && err.message) || err) };
    }
    if (!added.length) return { error: 'プラグインが 1 つも登録されませんでした（hex.plugin({…}) を呼んでください）。' };

    this.plugins.push(...added);
    if (!opts || !opts.silent) this.save();
    return { ok: true, added };
  }

  /** URL から取り寄せる。 */
  async installFromUrl(url) {
    let text;
    try {
      const res = await fetch(url, { credentials: 'omit', referrerPolicy: 'no-referrer' });
      if (!res.ok) return { error: '取り寄せられませんでした（' + res.status + '）。' };
      text = await res.text();
    } catch (err) {
      return { error: '取り寄せに失敗しました: ' + ((err && err.message) || err) };
    }
    return this.install(text, url);
  }

  remove(id) {
    this.plugins = this.plugins.filter((p) => p.id !== id);
    this.save();
  }

  clear() {
    this.plugins = [];
    this.save();
  }

  /** プラグインを動かす。 */
  async run(id, out) {
    const p = this.plugins.find((x) => x.id === id);
    if (!p) return { error: 'そのプラグインが見つかりません。' };
    const { api, print } = createApi(this.app, out);
    try {
      const value = await p.run(api, print, this.app);
      if (value !== undefined) print(value);
      return { ok: true };
    } catch (err) {
      return { error: (err && err.message) || String(err) };
    }
  }
}

/* ── お手本 ─────────────────────────────────────────────── */

export const EXAMPLE_PLUGIN = `hex.plugin({
  name: '大きい関数を並べる',
  description: '命令数の多い関数から順に 30 個。処理の中心を探すときに。',
  async run(hex, print) {
    const list = hex.functions()
      .filter((f) => f.size)
      .sort((a, b) => Number(b.size - a.size))
      .slice(0, 30);
    for (const f of list) {
      print(hex.hex(f.addr), String(Number(f.size) / 4) + ' 命令', f.name || '');
    }
  },
});`;
