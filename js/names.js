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
 * （内容fingerprint・active slice UUID/archで見分ける）。どこにも送信しません。
 */

const PREFIX = 'hex.notes.';
const MAX_BYTES = 2 * 1024 * 1024;   // 1 ファイルぶんの上限（保存が壊れないように）

/** BigInt でも Number でも同じ鍵になるように、10 進の文字列にそろえる。 */
function key(addr) {
  if (addr == null) return '';
  return typeof addr === 'bigint' ? addr.toString() : String(BigInt(Math.trunc(Number(addr))));
}

/**
 * 旧版（fingerprint導入前）が使っていた鍵。
 * 2026-08-13以前の版は active slice を区別せず、
 * name|size|最初に見つかったUUID だけで保存していた。
 * 新形式へ一度だけコピーするために正確な旧式を残しておく。
 */
export function legacyNoteKeyFor(file, fileInfo) {
  const parts = [];
  if (file && file.name) parts.push(file.name);
  if (file && file.size != null) parts.push(String(file.size));
  const slice = fileInfo && fileInfo.slices
    ? fileInfo.slices.find((s) => s.info && s.info.uuid)
    : null;
  if (slice) parts.push(slice.info.uuid);
  return parts.length ? parts.join('|') : null;
}

export async function noteKeyFor(file, fileInfo, sliceIndex) {
  if (!file) return null;
  const slices = fileInfo && fileInfo.slices || [];
  const slice = Number.isInteger(sliceIndex) && sliceIndex >= 0 ? slices[sliceIndex] : null;
  const info = slice && slice.info;
  const identity = [
    'v2', String(file.size == null ? 0 : file.size),
    info && info.uuid || '', info && info.cpu || '', info && info.cpuSub || '',
    slice && slice.offset != null ? slice.offset.toString() : '',
  ].join('|');
  const chunk = 64 * 1024;
  const size = Number(file.size || 0);
  const starts = Array.from(new Set([0, Math.max(0, Math.floor(size / 2) - Math.floor(chunk / 2)), Math.max(0, size - chunk)]));
  const pieces = [new TextEncoder().encode(identity)];
  for (const start of starts) {
    const bytes = new Uint8Array(await file.slice(start, Math.min(size, start + chunk)).arrayBuffer());
    pieces.push(bytes);
  }
  const total = pieces.reduce((n, p) => n + p.length, 0);
  const input = new Uint8Array(total);
  let at = 0;
  for (const p of pieces) { input.set(p, at); at += p.length; }
  let digest;
  if (globalThis.crypto && globalThis.crypto.subtle) {
    digest = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', input));
  } else {
    let h = 2166136261;
    for (const b of input) { h ^= b; h = Math.imul(h, 16777619); }
    digest = Uint8Array.from([(h >>> 24) & 255, (h >>> 16) & 255, (h >>> 8) & 255, h & 255]);
  }
  return identity + '|sha256:' + Array.from(digest).map((b) => b.toString(16).padStart(2, '0')).join('');
}

export class NoteStore {
  constructor(id, legacyIds = []) {
    this.id = id || null;
    this.legacyIds = Array.from(new Set((legacyIds || []).filter((x) => x && x !== this.id)));
    this.migratedFrom = null;
    this.names = new Map();
    this.comments = new Map();
    this.vars = new Map();
    this.types = new Map();
    this.structs = [];
    this.dirty = false;
    this.load();
  }

  load() {
    if (!this.id) return;
    let raw = null;
    let sourceId = this.id;
    try {
      raw = localStorage.getItem(PREFIX + this.id);
      if (!raw) {
        for (const old of this.legacyIds) {
          raw = localStorage.getItem(PREFIX + old);
          if (raw) { sourceId = old; break; }
        }
      }
    } catch { return; }
    if (!raw) return;
    try {
      const o = JSON.parse(raw);
      for (const [k, v] of Object.entries(o.names || {})) this.names.set(k, v);
      for (const [k, v] of Object.entries(o.comments || {})) this.comments.set(k, v);
      for (const [k, v] of Object.entries(o.vars || {})) this.vars.set(k, v);
      for (const [k, v] of Object.entries(o.types || {})) this.types.set(k, v);
      this.structs = Array.isArray(o.structs) ? o.structs : [];
      if (sourceId !== this.id) {
        if (this.save()) this.migratedFrom = sourceId;
      }
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
    catch { return false; }
  }

  /** Apply one map mutation transactionally with persistence as the commit point. */
  mutate(map, k, value, { remove = false } = {}) {
    if (!k) return false;
    const had = map.has(k);
    const before = map.get(k);
    const dirtyBefore = this.dirty;
    if (remove) map.delete(k); else map.set(k, value);
    this.dirty = true;
    if (this.save()) return true;
    if (had) map.set(k, before); else map.delete(k);
    this.dirty = dirtyBefore;
    return false;
  }

  nameOf(addr) { return this.names.get(key(addr)) || null; }

  setName(addr, name) {
    const k = key(addr);
    if (!k) return false;
    const clean = cleanName(name);
    return this.mutate(this.names, k, clean, { remove: !clean });
  }

  nameEntries() {
    const out = [];
    for (const [k, v] of this.names) {
      try { out.push({ addr: BigInt(k), name: v }); } catch { /* skip */ }
    }
    return out;
  }

  comment(addr) { return this.comments.get(key(addr)) || null; }

  setComment(addr, text) {
    const k = key(addr);
    if (!k) return false;
    const clean = (text || '').toString().slice(0, 500).trim();
    return this.mutate(this.comments, k, clean, { remove: !clean });
  }

  commentCount() { return this.comments.size; }

  varName(func, k) { return this.vars.get(key(func) + ':' + k) || null; }

  setVarName(func, k, name) {
    const kk = key(func) + ':' + k;
    if (!key(func)) return false;
    const clean = cleanName(name);
    return this.mutate(this.vars, kk, clean, { remove: !clean });
  }

  typeOf(func, k) { return this.types.get(key(func) + ':' + k) || null; }

  setType(func, k, type) {
    const kk = key(func) + ':' + k;
    if (!key(func)) return false;
    const clean = (type || '').toString().slice(0, 80).trim();
    return this.mutate(this.types, kk, clean, { remove: !clean });
  }

  get count() { return this.names.size + this.comments.size + this.vars.size + this.types.size; }

  clear() {
    this.names.clear(); this.comments.clear(); this.vars.clear(); this.types.clear();
    this.structs = [];
    if (this.id) { try { localStorage.removeItem(PREFIX + this.id); } catch { /* ignore */ } }
  }

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
    if (!o || typeof o !== 'object') throw new Error('invalid-notes-import');
    if (o.id != null && this.id != null && String(o.id) !== String(this.id)) throw new Error('notes-file-mismatch');

    const before = {
      names: new Map(this.names), comments: new Map(this.comments), vars: new Map(this.vars), types: new Map(this.types),
      structs: this.structs.slice(), dirty: this.dirty,
    };
    let n = 0;
    try {
      for (const [k, v] of Object.entries(o.names || {})) { this.names.set(k, v); n++; }
      for (const [k, v] of Object.entries(o.comments || {})) { this.comments.set(k, v); n++; }
      for (const [k, v] of Object.entries(o.vars || {})) { this.vars.set(k, v); n++; }
      for (const [k, v] of Object.entries(o.types || {})) { this.types.set(k, v); n++; }
      if (Array.isArray(o.structs)) this.structs = this.structs.concat(o.structs);
      this.dirty = true;
      if (!this.save()) throw new Error('notes-save-failed');
      return n;
    } catch (error) {
      this.names = before.names; this.comments = before.comments; this.vars = before.vars; this.types = before.types;
      this.structs = before.structs; this.dirty = before.dirty;
      throw error;
    }
  }
}

export function cleanName(name) {
  if (name == null) return '';
  let s = String(name).replace(/[\r\n\t]/g, ' ').trim();
  if (!s) return '';
  if (s.length > 120) s = s.slice(0, 120);
  return s;
}

export const EMPTY_NOTES = new NoteStore(null);
