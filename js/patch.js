/*
 * パッチ（命令の書き換え）。
 *
 * 「この if を通らないようにしたらどうなるか」を確かめたいとき、
 * 命令を 1 つ書き換えます。IDA の Patch program にあたる機能です。
 *
 * ここでできること:
 *   - 命令を nop（何もしない）にする
 *   - 条件分岐を反対にする / いつも飛ぶようにする / 飛ばないようにする
 *   - `mov w0, #1` のような簡単な命令を書く（小さなアセンブラを内蔵）
 *   - 16 進で直接バイトを置く
 *   - 書き換えた結果をファイルとして保存する
 *
 * 大事なこと:
 *   - 元のファイルには一切書き込みません。書き換えは「上書きメモ」として持ち、
 *     保存を選んだときだけ、新しいファイルとして書き出します。
 *   - iOS の実行ファイルは署名されています。書き換えたものを実機で動かすには
 *     再署名が必要で、このツールはそこまでは行いません（解析と実験のための機能です）。
 */

import { parseOperands } from './arm64.js';

function canonicalOffset(value, name = 'offset') {
  try {
    if (typeof value === 'number' && !Number.isSafeInteger(value)) throw new Error('unsafe');
    if (typeof value === 'boolean' || value == null) throw new Error('missing');
    const out = typeof value === 'bigint' ? value : BigInt(value);
    if (out < 0n) throw new Error('negative');
    return out;
  } catch {
    throw new TypeError(`${name} must be a non-negative integer`);
  }
}

function canonicalAddress(value) {
  if (value == null) return null;
  return canonicalOffset(value, 'address');
}

function patchRange(item) {
  return { start:item.offset, end:item.offset + BigInt(item.before.length) };
}

function rangesOverlap(a, b) {
  return a.start < b.end && b.start < a.end;
}

async function readBlobRange(file, start, length) {
  const at = Number(start);
  if (!Number.isSafeInteger(at) || at < 0) throw new RangeError('patch offset exceeds Blob addressability');
  const end = at + length;
  if (!Number.isSafeInteger(end)) throw new RangeError('patch range exceeds Blob addressability');
  return new Uint8Array(await file.slice(at, end).arrayBuffer());
}

/* ── 書き換えの置き場 ───────────────────────────────────── */

export class PatchSet {
  constructor() {
    this.items = new Map();
  }

  get size() { return this.items.size; }

  /**
   * `before` is both the stale-source precondition and the source range that is
   * replaced. `after` may have a different length; insertion without an
   * expected source range is deliberately rejected because it cannot prove the
   * offset is still current.
   */
  add(fileOffset, before, after, meta) {
    const offset = canonicalOffset(fileOffset, 'fileOffset');
    const expected = Uint8Array.from(before || []);
    const replacement = Uint8Array.from(after || []);
    if (!expected.length) throw new Error('patch requires non-empty expected source bytes');
    const candidate = {
      ...(meta || {}),
      offset,
      addr: meta && meta.addr != null ? canonicalAddress(meta.addr) : null,
      before: expected,
      after: replacement,
    };
    const range = patchRange(candidate);
    for (const existing of this.items.values()) {
      if (!rangesOverlap(range, patchRange(existing))) continue;
      throw new Error(`patch range conflicts with existing patch at +${existing.offset.toString(16)}`);
    }
    const key = offset.toString();
    this.items.set(key, candidate);
    return candidate;
  }

  remove(fileOffset) { return this.items.delete(canonicalOffset(fileOffset, 'fileOffset').toString()); }

  clear() { this.items.clear(); }

  list() {
    return Array.from(this.items.values()).sort((a, b) => (a.offset < b.offset ? -1 : a.offset > b.offset ? 1 : 0));
  }

  at(fileOffset) { return this.items.get(canonicalOffset(fileOffset, 'fileOffset').toString()) || null; }

  byAddress(addr) {
    const wanted = canonicalAddress(addr);
    for (const it of this.items.values()) if (it.addr != null && canonicalAddress(it.addr) === wanted) return it;
    return null;
  }

  async validateSource(file) {
    if (!file || typeof file.slice !== 'function' || !Number.isSafeInteger(Number(file.size)) || Number(file.size) < 0) {
      throw new TypeError('PatchSet.apply requires a Blob/File-compatible source');
    }
    const fileSize = BigInt(file.size);
    const items = this.list();
    for (const it of items) {
      const end = it.offset + BigInt(it.before.length);
      if (end > fileSize) throw new Error('書き換え位置がファイルの範囲外です: +' + it.offset.toString(16));
      const actual = await readBlobRange(file, it.offset, it.before.length);
      if (actual.length !== it.before.length) throw new Error('元のバイト範囲を読み出せません: +' + it.offset.toString(16));
      for (let i = 0; i < it.before.length; i++) {
        if (actual[i] !== it.before[i]) throw new Error('元のバイトが変わっています: +' + it.offset.toString(16));
      }
    }
    return items;
  }

  /**
   * Validate only patch-sized source ranges, then build the output from Blob
   * slices plus replacement bytes. Unchanged GB-scale ranges are never loaded
   * into a JS ArrayBuffer, keeping peak JS memory bounded by patch data.
   */
  async apply(file) {
    const items = await this.validateSource(file);
    if (!items.length) return file.slice(0, file.size, 'application/octet-stream');
    const parts = [];
    let cursor = 0n;
    const fileSize = BigInt(file.size);
    for (const it of items) {
      const start = Number(cursor), end = Number(it.offset);
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) throw new RangeError('Blob range exceeds safe integer addressability');
      if (it.offset > cursor) parts.push(file.slice(start, end));
      if (it.after.length) parts.push(it.after);
      cursor = it.offset + BigInt(it.before.length);
    }
    if (cursor < fileSize) {
      const start = Number(cursor);
      if (!Number.isSafeInteger(start)) throw new RangeError('Blob range exceeds safe integer addressability');
      parts.push(file.slice(start, file.size));
    }
    return new Blob(parts, { type: 'application/octet-stream' });
  }
}

/* ── 小さなアセンブラ ───────────────────────────────────── */

const CONDS = ['eq', 'ne', 'cs', 'cc', 'mi', 'pl', 'vs', 'vc', 'hi', 'ls', 'ge', 'lt', 'gt', 'le', 'al', 'nv'];

export function assemble(text, at) {
  const src = String(text || '').trim().toLowerCase().replace(/\s+/g, ' ');
  if (!src) return { error: '命令が空です。' };
  const sp = src.indexOf(' ');
  const mn = sp < 0 ? src : src.slice(0, sp);
  const rest = sp < 0 ? '' : src.slice(sp + 1);
  const ops = parseOperands(rest);

  if (mn === 'nop') return word(0xD503201F);
  if (mn === 'ret') return word(0xD65F03C0);
  if (mn === 'brk') {
    const imm = immOf(ops[0]);
    if (imm == null || imm < 0n || imm > 0xFFFFn) return { error: 'brk の値は 0〜0xFFFF です。' };
    return word(0xD4200000 | (Number(imm) << 5));
  }

  if (mn === 'mov' || mn === 'movz') {
    const dst = regInfo(ops[0]);
    const d = dst && dst.num;
    const imm = immOf(ops[1]);
    if (d == null) return { error: '書き込み先のレジスタが読めません。' };
    if (imm != null) {
      if (imm < 0n || imm > 0xFFFFn) return { error: 'この簡易アセンブラでは 0〜65535 の値だけ書けます。' };
      if (dst.sp) return { error: 'SP へ即値を直接 mov することはできません。' };
      const sf = dst.bits === 64 ? 1 : 0;
      return word((sf << 31) | (0xA5 << 23) | (Number(imm) << 5) | d);
    }
    const srcReg = regInfo(ops[1]);
    const m = srcReg && srcReg.num;
    if (m == null) return { error: 'mov の右側が読めません。' };
    if (dst.bits !== srcReg.bits) return { error: 'mov の左右は同じ幅（w同士 / x同士）で指定してください。' };
    const sf = dst.bits === 64 ? 1 : 0;
    if (dst.sp || srcReg.sp) {
      if (dst.zr || srcReg.zr) return { error: 'SP と ZR の間は mov できません。' };
      return word((sf << 31) | 0x11000000 | (m << 5) | d);
    }
    return word((sf << 31) | (0x150 << 21) | (m << 16) | (31 << 5) | d);
  }

  if (mn === 'b' || mn === 'bl') {
    const target = immOf(ops[0]);
    if (target == null) return { error: '飛び先のアドレスが読めません（0x… の形で書いてください）。' };
    if ((target - at) % 4n !== 0n) return { error: '飛び先は 4 バイト境界で指定してください。' };
    const delta = (target - at) / 4n;
    if (delta < -(1n << 25n) || delta >= (1n << 25n)) return { error: '飛び先が遠すぎます（±128 MB まで）。' };
    const imm26 = Number(BigInt.asUintN(26, delta));
    return word(((mn === 'bl' ? 1 : 0) << 31) | (0x05 << 26) | imm26);
  }
  const bc = /^b\.(\w+)$/.exec(mn);
  if (bc) {
    const cond = CONDS.indexOf(bc[1]);
    if (cond < 0) return { error: '知らない条件です: ' + bc[1] };
    const target = immOf(ops[0]);
    if (target == null) return { error: '飛び先のアドレスが読めません。' };
    if ((target - at) % 4n !== 0n) return { error: '飛び先は 4 バイト境界で指定してください。' };
    const delta = (target - at) / 4n;
    if (delta < -(1n << 18n) || delta >= (1n << 18n)) return { error: '条件分岐の飛び先が遠すぎます（±1 MB まで）。' };
    const imm19 = Number(BigInt.asUintN(19, delta));
    return word((0x54 << 24) | (imm19 << 5) | cond);
  }

  return { error: 'この簡易アセンブラは ' + mn + ' に対応していません。16 進で直接指定してください。' };
}

function word(v) {
  const out = new Uint8Array(4);
  out[0] = v & 0xff; out[1] = (v >>> 8) & 0xff; out[2] = (v >>> 16) & 0xff; out[3] = (v >>> 24) & 0xff;
  return { bytes: out };
}

function regNum(op) {
  if (!op || op.k !== 'reg') return null;
  if (op.cls === 'zr') return 31;
  if (op.cls === 'sp') return 31;
  if (op.cls !== 'gp') return null;
  return op.num;
}

function regInfo(op) {
  const num = regNum(op);
  if (num == null) return null;
  return { num, bits: op.bits === 32 ? 32 : 64, sp: op.cls === 'sp', zr: op.cls === 'zr' };
}

function immOf(op) {
  if (!op) return null;
  if (op.k === 'imm') return op.value;
  if (op.k === 'other' && /^0x[0-9a-f]+$/.test(op.text)) return BigInt(op.text);
  return null;
}

export function suggestPatches(mn, opsStr, addr) {
  const base = (mn || '').toLowerCase();
  const out = [];
  out.push({
    id: 'nop', label: 'この命令を何もしない（nop）にする',
    why: '呼び出しやチェックを 1 つ飛ばして、どう変わるか試すときに使います。',
    text: 'nop',
  });

  const cond = /^b\.(\w+)$/.exec(base);
  if (cond) {
    const inv = { eq: 'ne', ne: 'eq', lt: 'ge', ge: 'lt', gt: 'le', le: 'gt', hi: 'ls', ls: 'hi', hs: 'lo', lo: 'hs', cs: 'cc', cc: 'cs', mi: 'pl', pl: 'mi', vs: 'vc', vc: 'vs' }[cond[1]];
    const target = targetOf(opsStr);
    if (inv && target != null) {
      out.push({
        id: 'invert', label: '条件を反対にする（b.' + cond[1] + ' → b.' + inv + '）',
        why: '「合っていたら通す」を「間違っていたら通す」に入れ替えます。判定の効き目を確かめられます。',
        text: 'b.' + inv + ' 0x' + target.toString(16),
      });
      out.push({
        id: 'always', label: 'いつも飛ぶようにする（b）',
        why: '条件を無視して、必ず飛び先へ進みます。',
        text: 'b 0x' + target.toString(16),
      });
    }
  }
  if (base === 'bl' || base === 'blr') {
    out.push({
      id: 'ret0', label: '呼び出しをやめて 0 を返す（mov w0, #0）',
      why: 'その関数を呼ばずに「失敗（0）」を返させます。チェック関数を無効にするときの定番です。',
      text: 'mov w0, #0',
    });
    out.push({
      id: 'ret1', label: '呼び出しをやめて 1 を返す（mov w0, #1）',
      why: 'その関数を呼ばずに「成功（1）」を返させます。',
      text: 'mov w0, #1',
    });
  }
  if (base === 'ret') {
    out.push({ id: 'brk', label: 'ここで止める（brk #0）', why: '通ったかどうかを確かめるための印です。', text: 'brk #0' });
  }
  void addr;
  return out;
}

function targetOf(opsStr) {
  const m = /#?(0x[0-9a-f]+)/i.exec(opsStr || '');
  return m ? BigInt(m[1]) : null;
}

export function parseHexBytes(text) {
  const raw = String(text || '').trim();
  if (!isHexBytes(raw)) return null;
  const clean = raw.replace(/0x/gi, '').replace(/[\s,]+/g, '');
  if (!clean.length || clean.length % 2) return null;
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function isHexBytes(text) {
  const raw = String(text || '').trim();
  if (!raw) return false;
  if (/^(?:0x)?[0-9a-f]+$/i.test(raw)) {
    const s = raw.replace(/^0x/i, '');
    return s.length > 0 && s.length % 2 === 0;
  }
  return /^(?:0x)?[0-9a-f]{2}(?:[\s,]+(?:0x)?[0-9a-f]{2})+$/i.test(raw);
}

export function validatePatchRange(region, addr, length, fileSize, instruction = true) {
  if (!region) return { error: 'コードのセクションが見つかりません。' };
  const a = BigInt(addr);
  const n = Number(length);
  if (!Number.isSafeInteger(n) || n <= 0) return { error: '書き換える長さが不正です。' };
  if (instruction && ((a - region.vmAddr) % 4n !== 0n || n !== 4)) {
    return { error: '命令の位置と長さは 4 バイト境界で指定してください。' };
  }
  const rel = a - region.vmAddr;
  if (rel < 0n || rel + BigInt(n) > region.size) return { error: 'アドレスがコードのセクション範囲外です。' };
  const offset = region.fileOffset + rel;
  if (offset < 0n || (fileSize != null && offset + BigInt(n) > BigInt(fileSize))) {
    return { error: '書き換え位置がファイル範囲外です。' };
  }
  return { ok: true, fileOffset: offset };
}

export function hexOf(bytes) {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0').toUpperCase()).join(' ');
}