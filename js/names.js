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

import { asByteSource } from './binary/source.js';
import { hashByteSource, sha256TreeByteSource } from './platform/hash.js';

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

export async function legacyV2NoteKeyFor(file, fileInfo, sliceIndex) {
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
  for (const sampleStart of starts) {
    const bytes = new Uint8Array(await file.slice(sampleStart, Math.min(size, sampleStart + chunk)).arrayBuffer());
    pieces.push(bytes);
  }
  const total = pieces.reduce((n, piece) => n + piece.length, 0);
  const input = new Uint8Array(total);
  let at = 0;
  for (const piece of pieces) { input.set(piece, at); at += piece.length; }
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

export async function noteKeyFor(file, fileInfo, sliceIndex) {
  if (!file) return null;
  const slices = fileInfo && fileInfo.slices || [];
  const slice = Number.isInteger(sliceIndex) && sliceIndex >= 0 ? slices[sliceIndex] : null;
  const info = slice && slice.info;
  const source = asByteSource(file);
  let content = source;
  let sliceOffset = null;
  let sliceSize = null;
  if (slice && slice.offset != null && slice.size != null) {
    try {
      sliceOffset = BigInt(slice.offset);
      sliceSize = BigInt(slice.size);
      if (sliceOffset >= 0n && sliceSize >= 0n && sliceOffset <= source.size && sliceSize <= source.size - sliceOffset) {
        content = source.subrange(sliceOffset, sliceSize);
      } else {
        sliceOffset = null; sliceSize = null;
      }
    } catch { sliceOffset = null; sliceSize = null; }
  }
  const identity = [
    'v3', source.size.toString(),
    info && info.uuid || '', info && info.cpu || '', info && info.cpuSub || '',
    sliceOffset == null ? '' : sliceOffset.toString(),
    sliceSize == null ? '' : sliceSize.toString(),
  ].join('|');

  let digest;
  try {
    digest = await sha256TreeByteSource(content);
  } catch (error) {
    if (error?.code !== 'SHA256_UNAVAILABLE') throw error;
    // Legacy browser fallback still reads every byte. Modern Safari/iPadOS uses
    // the cryptographic path above; this exists only to avoid making notes unusable.
    digest = await hashByteSource(content);
  }
  return identity + '|' + digest;
}

export class NoteStore {
  constructor(id, legacyIds = []) {
    this.id = id || null;
    this.legacyIds = Array.from(new Set((legacyIds || []).filter((x) => x && x !== this.id)));
    this.migratedFrom = null;
    this.lastSaveError = null;
    this.lastMutationSaved = true;
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
      if (o && o.cleared === true) {
        this.dirty = false;
        this.lastSaveError = null;
        this.lastMutationSaved = true;
        this.migratedFrom = null;
        return;
      }
      for (const [k, v] of Object.entries(o.names || {})) this.names.set(k, v);
      for (const [k, v] of Object.entries(o.comments || {})) this.comments.set(k, v);
      for (const [k, v] of Object.entries(o.vars || {})) this.vars.set(k, v);
      for (const [k, v] of Object.entries(o.types || {})) this.types.set(k, v);
      this.structs = Array.isArray(o.structs) ? o.structs : [];
      if (sourceId !== this.id) {
        /* Copy, do not delete. The old version can still be opened safely, and
           a failed write never destroys the only copy of the user's notes. */
        if (this.save()) this.migratedFrom = sourceId;
      }
    } catch { /* 壊れていたら無かったことにする（消しはしない） */ }
  }

  _saveFailure(code, error = null, detail = {}) {
    this.dirty = true;
    this.lastMutationSaved = false;
    this.lastSaveError = {
      code: code || 'STORAGE_ERROR',
      message: error?.message || String(error || ''),
      ...detail,
    };
    return false;
  }

  save() {
    if (!this.id) return this._saveFailure('NO_ID');
    const o = {
      v: 2,
      names: Object.fromEntries(this.names),
      comments: Object.fromEntries(this.comments),
      vars: Object.fromEntries(this.vars),
      types: Object.fromEntries(this.types),
      structs: this.structs,
    };
    let text;
    try { text = JSON.stringify(o); } catch (error) { return this._saveFailure('SERIALIZE_ERROR', error); }
    const bytes = new TextEncoder().encode(text).byteLength;
    if (bytes > MAX_BYTES) return this._saveFailure('TOO_LARGE', null, { bytes, maxBytes: MAX_BYTES });
    try {
      localStorage.setItem(PREFIX + this.id, text);
      this.dirty = false;
      this.lastSaveError = null;
      this.lastMutationSaved = true;
      return true;
    } catch (error) {
      return this._saveFailure(error?.name || 'STORAGE_ERROR', error);
    }
  }

  /* ── 名前 ─────────────────────────────────────────────── */

  nameOf(addr) { return this.names.get(key(addr)) || null; }

  setName(addr, name) {
    const k = key(addr);
    if (!k) return this._saveFailure('INVALID_KEY');
    const clean = cleanName(name);
    if (clean) this.names.set(k, clean);
    else this.names.delete(k);
    this.dirty = true;
    return this.save();
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
    if (!k) return this._saveFailure('INVALID_KEY');
    const clean = (text || '').toString().slice(0, 500).trim();
    if (clean) this.comments.set(k, clean);
    else this.comments.delete(k);
    this.dirty = true;
    return this.save();
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
    return this.save();
  }

  typeOf(func, k) { return this.types.get(key(func) + ':' + k) || null; }

  setType(func, k, type) {
    const kk = key(func) + ':' + k;
    const clean = (type || '').toString().slice(0, 80).trim();
    if (clean) this.types.set(kk, clean);
    else this.types.delete(kk);
    this.dirty = true;
    return this.save();
  }

  /* ── まとめて ─────────────────────────────────────────── */

  get count() { return this.names.size + this.comments.size + this.vars.size + this.types.size; }

  clear() {
    this.names.clear(); this.comments.clear(); this.vars.clear(); this.types.clear();
    this.structs = [];
    this.dirty = true;
    if (!this.id) return this._saveFailure('NO_ID');
    // Keep the legacy payload intact for old app versions, but atomically write
    // a primary-key tombstone so this version never migrates it again.
    try {
      localStorage.setItem(PREFIX + this.id, JSON.stringify({ v: 2, cleared: true }));
      this.dirty = false;
      this.lastSaveError = null;
      this.lastMutationSaved = true;
      this.migratedFrom = null;
      return true;
    } catch (error) {
      return this._saveFailure(error?.name || 'STORAGE_ERROR', error);
    }
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
    this.dirty = true;
    this.lastMutationSaved = this.save();
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
