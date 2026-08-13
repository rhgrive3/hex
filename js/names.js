/*
 * 自分で付けた名前とメモ（IDA でいう Rename / Comment）。
 *
 * 解析でいちばん効くのは、じつは高度なアルゴリズムではなく
 * 「分かったことにその場で名前を付ける」ことです。sub_1004A2C0 のままだと
 * 10 分後にはもう何だったか忘れますが、`ダメージ計算` と付けておけば
 * 呼び出し元の一覧を見るだけで流れが読めます。
 *
 * ここに置くもの:
 *   - 関数やアドレスに付けた名前   nameOf(addr) / setName(addr, name)
 *   - 行に書いたメモ               comment(addr) / setComment(addr, text)
 *   - 関数の中の変数の呼び名       varName(func, key) / setVarName(...)
 *   - 引数・戻り値に決めた型       typeOf(func, key) / setType(...)
 *
 * 保存先はブラウザの localStorage で、ファイルごとに分かれています
 * （名前・サイズ・UUID で見分ける）。どこにも送信しません。
 */

const PREFIX = 'hex.notes.';
const MAX_BYTES = 2 * 1024 * 1024;   // 1 ファイルぶんの上限（保存が壊れないように）

/** BigInt でも Number でも同じ鍵になるように、10 進の文字列にそろえる。 */
function key(addr) {
  if (addr == null) return '';
  return typeof addr === 'bigint' ? addr.toString() : String(BigInt(Math.trunc(Number(addr))));
}

/**
 * このファイルを見分けるための鍵。
 * 同じアプリを開き直したら、前に付けた名前がそのまま戻ってくる。
 */
export function noteKeyFor(file, fileInfo) {
  const parts = [];
  if (file && file.name) parts.push(file.name);
  if (file && file.size != null) parts.push(String(file.size));
  const slice = fileInfo && fileInfo.slices ? fileInfo.slices.find((s) => s.info && s.info.uuid) : null;
  if (slice) parts.push(slice.info.uuid);
  if (!parts.length) return null;
  return parts.join('|');
}

export class NoteStore {
  constructor(id) {
    this.id = id || null;
    this.names = new Map();      // addr -> 名前
    this.comments = new Map();   // addr -> メモ
    this.vars = new Map();       // 'func:key' -> 呼び名
    this.types = new Map();      // 'func:key' -> 型
    this.structs = [];           // 自分で作った構造体（types.js が読む）
    this.dirty = false;
    this.load();
  }

  /* ── 読み書き ─────────────────────────────────────────── */

  load() {
    if (!this.id) return;
    let raw = null;
    try { raw = localStorage.getItem(PREFIX + this.id); } catch { return; }
    if (!raw) return;
    try {
      const o = JSON.parse(raw);
      for (const [k, v] of Object.entries(o.names || {})) this.names.set(k, v);
      for (const [k, v] of Object.entries(o.comments || {})) this.comments.set(k, v);
      for (const [k, v] of Object.entries(o.vars || {})) this.vars.set(k, v);
      for (const [k, v] of Object.entries(o.types || {})) this.types.set(k, v);
      this.structs = Array.isArray(o.structs) ? o.structs : [];
    } catch { /* 壊れていたら無かったことにする（消しはしない） */ }
  }

  save() {
    if (!this.id) return false;
    const o = {
      v: 1,
      names: Object.fromEntries(this.names),
      comments: Object.fromEntries(this.comments),
      vars: Object.fromEntries(this.vars),
      types: Object.fromEntries(this.types),
      structs: this.structs,
    };
    let text;
    try { text = JSON.stringify(o); } catch { return false; }
    if (text.length > MAX_BYTES) return false;
    try { localStorage.setItem(PREFIX + this.id, text); this.dirty = false; return true; }
    catch { return false; }   // 容量いっぱい / プライベートモード
  }

  /* ── 名前 ─────────────────────────────────────────────── */

  nameOf(addr) { return this.names.get(key(addr)) || null; }

  setName(addr, name) {
    const k = key(addr);
    if (!k) return;
    const clean = cleanName(name);
    if (clean) this.names.set(k, clean);
    else this.names.delete(k);
    this.dirty = true;
    this.save();
  }

  /** 保存済みの名前をぜんぶ [{addr, name}] で返す（起動時に索引へ流し込む）。 */
  nameEntries() {
    const out = [];
    for (const [k, v] of this.names) {
      try { out.push({ addr: BigInt(k), name: v }); } catch { /* skip */ }
    }
    return out;
  }

  /* ── メモ ─────────────────────────────────────────────── */

  comment(addr) { return this.comments.get(key(addr)) || null; }

  setComment(addr, text) {
    const k = key(addr);
    if (!k) return;
    const clean = (text || '').toString().slice(0, 500).trim();
    if (clean) this.comments.set(k, clean);
    else this.comments.delete(k);
    this.dirty = true;
    this.save();
  }

  commentCount() { return this.comments.size; }

  /* ── 変数と型 ─────────────────────────────────────────── */

  varName(func, k) { return this.vars.get(key(func) + ':' + k) || null; }

  setVarName(func, k, name) {
    const kk = key(func) + ':' + k;
    const clean = cleanName(name);
    if (clean) this.vars.set(kk, clean);
    else this.vars.delete(kk);
    this.dirty = true;
    this.save();
  }

  typeOf(func, k) { return this.types.get(key(func) + ':' + k) || null; }

  setType(func, k, type) {
    const kk = key(func) + ':' + k;
    const clean = (type || '').toString().slice(0, 80).trim();
    if (clean) this.types.set(kk, clean);
    else this.types.delete(kk);
    this.dirty = true;
    this.save();
  }

  /* ── まとめて ─────────────────────────────────────────── */

  get count() { return this.names.size + this.comments.size + this.vars.size + this.types.size; }

  clear() {
    this.names.clear(); this.comments.clear(); this.vars.clear(); this.types.clear();
    this.structs = [];
    if (this.id) { try { localStorage.removeItem(PREFIX + this.id); } catch { /* ignore */ } }
  }

  /** 書き出し（バックアップ・共有用）。 */
  toJSON() {
    return JSON.stringify({
      v: 1, id: this.id,
      names: Object.fromEntries(this.names),
      comments: Object.fromEntries(this.comments),
      vars: Object.fromEntries(this.vars),
      types: Object.fromEntries(this.types),
      structs: this.structs,
    }, null, 1);
  }

  /** 読み込み（書き出したものを戻す）。既存の内容とまぜる。 */
  fromJSON(text) {
    const o = JSON.parse(text);
    let n = 0;
    for (const [k, v] of Object.entries(o.names || {})) { this.names.set(k, v); n++; }
    for (const [k, v] of Object.entries(o.comments || {})) { this.comments.set(k, v); n++; }
    for (const [k, v] of Object.entries(o.vars || {})) { this.vars.set(k, v); n++; }
    for (const [k, v] of Object.entries(o.types || {})) { this.types.set(k, v); n++; }
    if (Array.isArray(o.structs)) this.structs = this.structs.concat(o.structs);
    this.save();
    return n;
  }
}

/**
 * 名前として使える形に整える。
 * 記号だらけの名前は、あとで検索やスクリプトから引けなくなるので落とす。
 */
export function cleanName(name) {
  if (name == null) return '';
  let s = String(name).replace(/[\r\n\t]/g, ' ').trim();
  if (!s) return '';
  if (s.length > 120) s = s.slice(0, 120);
  return s;
}

/** 何も保存しない置き場（ファイル未選択のとき）。 */
export const EMPTY_NOTES = new NoteStore(null);
