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

/* ── 書き換えの置き場 ───────────────────────────────────── */

export class PatchSet {
  constructor() {
    this.items = new Map();   // ファイル内位置(10進文字列) → {offset, addr, before, after, note}
  }

  get size() { return this.items.size; }

  /**
   * @param {BigInt} fileOffset ファイルの中の位置
   * @param {Uint8Array} before 元のバイト
   * @param {Uint8Array} after  置き換えるバイト
   */
  add(fileOffset, before, after, meta) {
    const key = fileOffset.toString();
    this.items.set(key, Object.assign({
      offset: fileOffset,
      before: Uint8Array.from(before),
      after: Uint8Array.from(after),
    }, meta || {}));
  }

  remove(fileOffset) { this.items.delete(fileOffset.toString()); }

  clear() { this.items.clear(); }

  list() {
    return Array.from(this.items.values()).sort((a, b) => (a.offset < b.offset ? -1 : 1));
  }

  /** その位置に書き換えがあるか。 */
  at(fileOffset) { return this.items.get(fileOffset.toString()) || null; }

  /** アドレスから探す（表示用）。 */
  byAddress(addr) {
    for (const it of this.items.values()) if (it.addr != null && it.addr === addr) return it;
    return null;
  }

  /**
   * 元のファイルに書き換えを当てて、新しい Blob を作る。
   * @param {File|Blob} file
   */
  async apply(file) {
    const buf = new Uint8Array(await file.arrayBuffer());
    for (const it of this.items.values()) {
      const at = Number(it.offset);
      if (at < 0 || at + it.after.length > buf.length) continue;
      buf.set(it.after, at);
    }
    return new Blob([buf], { type: 'application/octet-stream' });
  }
}

/* ── 小さなアセンブラ ───────────────────────────────────── */

/*
 * ARM64 の命令はすべて 4 バイトで、ビットの並びが決まっています。
 * ここでは「書き換えでよく使うもの」だけを組み立てます。
 * 対応していない書き方は、はっきり「作れません」と返します（黙って違う命令を作らない）。
 */

const CONDS = ['eq', 'ne', 'cs', 'cc', 'mi', 'pl', 'vs', 'vc', 'hi', 'ls', 'ge', 'lt', 'gt', 'le', 'al', 'nv'];

/**
 * 1 命令をバイト列（4 バイト、リトルエンディアン）にする。
 * @param {string} text  例 'nop' / 'mov w0, #1' / 'b 0x100004000' / 'ret'
 * @param {BigInt} at    その命令が置かれるアドレス（分岐の距離の計算に要る）
 * @returns {{bytes:Uint8Array}|{error:string}}
 */
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

  /* mov Xd, #imm （movz の形。0〜65535 のみ） */
  if (mn === 'mov' || mn === 'movz') {
    const d = regNum(ops[0]);
    const imm = immOf(ops[1]);
    if (d == null) return { error: '書き込み先のレジスタが読めません。' };
    if (imm != null) {
      if (imm < 0n || imm > 0xFFFFn) return { error: 'この簡易アセンブラでは 0〜65535 の値だけ書けます。' };
      const sf = is64(ops[0]) ? 1 : 0;
      return word((sf << 31) | (0xA5 << 23) | (Number(imm) << 5) | d);
    }
    /* mov Xd, Xn は orr Xd, xzr, Xn */
    const m = regNum(ops[1]);
    if (m == null) return { error: 'mov の右側が読めません。' };
    const sf = is64(ops[0]) ? 1 : 0;
    return word((sf << 31) | (0x150 << 21) | (m << 16) | (31 << 5) | d);
  }

  /* 分岐 */
  if (mn === 'b' || mn === 'bl') {
    const target = immOf(ops[0]);
    if (target == null) return { error: '飛び先のアドレスが読めません（0x… の形で書いてください）。' };
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

function is64(op) { return !op || op.bits !== 32; }

function immOf(op) {
  if (!op) return null;
  if (op.k === 'imm') return op.value;
  if (op.k === 'other' && /^0x[0-9a-f]+$/.test(op.text)) return BigInt(op.text);
  return null;
}

/* ── よく使う書き換え ───────────────────────────────────── */

/**
 * その命令に対して選べる書き換えの候補を作る。
 * @param {string} mn
 * @param {string} opsStr
 * @param {BigInt} addr
 */
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

/** 16 進の文字列（"1f 20 03 d5" など）をバイト列にする。 */
export function parseHexBytes(text) {
  const clean = String(text || '').replace(/0x/gi, '').replace(/[^0-9a-f]/gi, '');
  if (!clean.length || clean.length % 2) return null;
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** バイト列を "1F 20 03 D5" の形にする。 */
export function hexOf(bytes) {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0').toUpperCase()).join(' ');
}
