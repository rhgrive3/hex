/*
 * 検証 — 「そう書いてある」を「本当にそう動く」に上げる層。
 *
 * このツールのこれまでの弱点は、名前を読んだだけで終わっていたことだった。
 * クラス表に「_hp は先頭から 0x20 の位置にある 4 バイトの整数」と書いてあっても、
 * それは**表にそう書いてある**というだけで、コードが本当にそこを HP として
 * 使っている保証にはならない。表が古い、別のクラスと位置が同じ、という話は普通にある。
 *
 * ここでやるのは、その仮説を **実際に逆アセンブルして確かめる** こと。
 *
 *     仮説: BattleManager の hp は、self の +0x20 にある
 *       ↓
 *     -[BattleManager hp] を逆アセンブルする
 *       ↓
 *     ldr  w0, [x0, #0x20]
 *     ret
 *       ↓
 *     確認できた。名前と位置の対応は、表ではなく命令で裏が取れた。
 *
 * ここまで来れば「たぶん」ではなく「そうです」と言える。ツールが一発で
 * 確定させられるかどうかは、この層があるかないかで決まる。
 *
 * きまり:
 *   - 確かめられなかったものは false を返す。「たぶん合っている」は返さない。
 *   - self（x0）を持ち回っているレジスタを追い、それ以外のベースは self とみなさない。
 *     よそのオブジェクトの同じ位置を、self の値として数えないため。
 *
 * 日本語は作らない。
 */
import { findValueUpdates, locationKey, regKeyOf } from './dataflow.js';

/* 引数レジスタ。Objective-C のメソッドは x0=self, x1=_cmd, x2 以降が引数。 */
const ARG0 = 'x0';
const ARG2 = 'x2';

/**
 * self（＝ x0 で渡されたオブジェクト）を持ち回っているレジスタを求める。
 *
 * -[C hp] のように 2 命令で終わる関数なら x0 のままだが、少し長い関数では
 *
 *     mov  x19, x0        ← ここから x19 が self
 *     ...
 *     ldr  w8, [x19, #0x20]
 *
 * という形になる。x19 を self と認めないと、ほとんどの読み書きを取りこぼす。
 * 逆に、self でないものを self と数えると、よそのクラスの値が混ざる。
 * だからコピーの連鎖だけを追い、上書きされたら即座に外す。
 *
 * @returns {{set:Set<string>, at:Map<string,number>}} レジスタ名と、self になった行
 */
export function selfRegisters(model) {
  const set = new Set([ARG0]);
  const at = new Map([[ARG0, -1]]);
  const insns = (model && model.instructions) || [];

  for (const insn of insns) {
    const mn = String(insn.mnemonic || '').toLowerCase();

    // mov xd, xs / orr xd, xzr, xs — 素直なコピー
    if ((mn === 'mov' || mn === 'orr') && insn.writes.length === 1) {
      const dst = insn.writes[0];
      const src = insn.reads.find((r) => set.has(r));
      if (src && dst) {
        // 64 ビット幅のコピーだけを認める（w レジスタへのコピーは値の切り出し）
        const wide = /^x\d+$/.test(dst) || dst === 'sp';
        if (wide) { set.add(dst); at.set(dst, insn.row); continue; }
      }
    }

    // str x0, [sp, #N] → あとで ldr x19, [sp, #N] で戻す形も追う
    if (insn.memory && insn.memory.kind === 'store' && insn.memory.stack) {
      const src = regKeyOf(insn.ops[0]);
      const key = locationKey(insn.memory);
      if (src && set.has(src) && key) { set.add('@' + key); at.set('@' + key, insn.row); }
    }
    if (insn.memory && insn.memory.kind === 'load' && insn.memory.stack) {
      const key = locationKey(insn.memory);
      const dst = regKeyOf(insn.ops[0]);
      if (dst && key && set.has('@' + key)) { set.add(dst); at.set(dst, insn.row); continue; }
    }

    // 上書きされたら self ではなくなる
    for (const w of insn.writes) {
      if (w === ARG0 && insn.row >= 0) { set.delete(ARG0); at.delete(ARG0); continue; }
      if (set.has(w)) { set.delete(w); at.delete(w); }
    }
  }
  // x0 は関数の入口では必ず self。上書きされても「入口では self だった」は残す。
  set.add(ARG0);
  if (!at.has(ARG0)) at.set(ARG0, -1);
  return { set, at };
}

/** その命令が、self の +offset を触っているか。 */
function touches(insn, selfSet, offset) {
  const m = insn.memory;
  if (!m || m.indexed || m.disp == null || m.stack) return false;
  if (!selfSet.has(m.base)) return false;
  return m.disp === offset;
}

/**
 * アクセサ（getter / setter）が、本当にその位置を読み書きしているかを確かめる。
 *
 * これがこのファイルでいちばん価値のある関数。
 * クラス表の「名前 ↔ 位置」の対応を、命令で裏付けることになる。
 *
 * @param {object} model    buildSemanticModel の結果
 * @param {object} hyp      {offset: BigInt|number, size: number|null, kind: '-'|'+'}
 * @param {object} [opts]   {maxInstructions: 既定 40}
 * @returns {{getter:boolean, setter:boolean, offset:BigInt, size:number|null,
 *            row:number|null, address:BigInt|null, exclusive:boolean, instructions:number}}
 */
export function verifyAccessor(model, hyp, opts) {
  const o = opts || {};
  const max = o.maxInstructions || 40;
  const out = {
    getter: false, setter: false,
    offset: null, size: null, row: null, address: null,
    exclusive: false, instructions: 0, otherOffsets: 0,
  };
  if (!model || !hyp || hyp.offset == null) return out;
  const offset = typeof hyp.offset === 'bigint' ? hyp.offset : BigInt(hyp.offset);
  out.offset = offset;

  const insns = model.instructions || [];
  out.instructions = insns.length;
  // アクセサは短い。長い関数を「アクセサだった」と言い張らない。
  if (!insns.length || insns.length > max) return out;

  const { set } = selfRegisters(model);
  let others = 0;
  let hit = null;

  for (const insn of insns) {
    const m = insn.memory;
    if (!m || m.stack || m.indexed || m.disp == null) continue;
    if (!set.has(m.base)) continue;
    if (m.disp === offset) {
      if (!hit) hit = { insn, kind: m.kind, size: m.size };
      if (m.kind === 'load') out.getter = true;
      else out.setter = true;
    } else {
      others++;
    }
  }
  if (!hit) return out;

  out.size = hit.size;
  out.row = hit.insn.row;
  out.address = hit.insn.address;
  out.otherOffsets = others;
  // ほかの位置を触っていないなら、この関数はこの値だけのためのもの＝アクセサそのもの
  out.exclusive = others === 0;

  /*
   * setter は、書き込んでいる値が引数（x2）から来ていることまで確かめる。
   * self の別の値をコピーしているだけの関数を setter と呼ばないため。
   */
  if (out.setter) {
    const store = insns.find((i) => touches(i, set, offset) && i.memory.kind === 'store');
    if (store) {
      const src = regKeyOf(store.ops[0]);
      out.fromArgument = !!src && (src === ARG2 || src === 'w2' || wideOf(src) === ARG2 ||
        tracesToArgument(insns, store.row, src));
    }
  }
  return out;
}

function wideOf(reg) {
  const m = /^[wx](\d+)$/.exec(String(reg || ''));
  return m ? 'x' + m[1] : null;
}

/** その行の値が、引数レジスタ（x2..x7）から来ているか。短い関数だけを追う。 */
function tracesToArgument(insns, row, reg) {
  let want = reg;
  for (let i = insns.findIndex((x) => x.row === row) - 1; i >= 0; i--) {
    const insn = insns[i];
    if (!insn.writes.includes(want)) continue;
    if (insn.memory) return false;
    const next = insn.reads.find((r) => /^[wx][2-7]$/.test(r)) || insn.reads[0];
    if (!next) return false;
    if (/^[wx][2-7]$/.test(next)) return true;
    want = next;
  }
  return false;
}

/**
 * ある位置（self の +offset）が、この関数の中でどう使われているかを数える。
 *
 * 「読んで、計算して、書き戻している」が見つかれば、そこが値を変えている場所。
 * 名前から探すのではなく、命令の形から探しているので、名前が消されていても効く。
 *
 * @returns {{loads, stores, rmw:Array, compares:Array, sites:Array, self:boolean}}
 */
export function fieldUse(model, offset, opts) {
  const o = opts || {};
  const want = typeof offset === 'bigint' ? offset : BigInt(offset);
  const out = { loads: 0, stores: 0, rmw: [], compares: [], sites: [], self: false };
  if (!model) return out;
  const insns = model.instructions || [];
  const { set } = selfRegisters(model);
  const selfOnly = o.selfOnly !== false;

  for (const insn of insns) {
    const m = insn.memory;
    if (!m || m.stack || m.indexed || m.disp == null) continue;
    if (m.disp !== want) continue;
    const isSelf = set.has(m.base);
    if (selfOnly && !isSelf) continue;
    if (isSelf) out.self = true;
    if (m.kind === 'load') out.loads++; else out.stores++;
    out.sites.push({
      row: insn.row, address: insn.address, kind: m.kind,
      base: m.base, size: m.size, self: isSelf,
    });
  }
  if (!out.sites.length) return out;

  /* 読んで → 計算して → 同じ場所へ書き戻す形（＝値の増減）を拾う */
  for (const u of findValueUpdates(model)) {
    if (u.kind !== 'read-modify-write') continue;
    if (u.location.disp !== want) continue;
    if (selfOnly && !set.has(u.location.base)) continue;
    out.rmw.push(u);
  }

  /* この位置の値が、定数と比べられているか（しきい値の判定） */
  const byRow = new Map(insns.map((i) => [i.row, i]));
  for (const site of out.sites) {
    if (site.kind !== 'load') continue;
    const insn = byRow.get(site.row);
    if (!insn) continue;
    const reg = regKeyOf(insn.ops[0]);
    if (!reg) continue;
    for (let r = site.row + 1; r <= site.row + 8; r++) {
      const next = byRow.get(r);
      if (!next) continue;
      const mn = String(next.mnemonic || '').toLowerCase();
      if (!/^(cmp|cmn|subs|adds|ccmp|fcmp|tst)$/.test(mn)) {
        /*
         * 値が入れ替わったら追跡をやめる。ただし
         *
         *     ldr w8, [x19, #0x20]
         *     sub w8, w8, w2        ← 同じレジスタを読んで書いている
         *     cmp w8, #0            ← これも「HP を 0 と比べている」
         *
         * のように、自分自身から作った値はまだ同じ値の続きなので追い続ける。
         * ここで切ると「HP が 0 以下なら死亡」の判定を丸ごと取りこぼす。
         */
        if (next.writes.includes(reg) && !next.reads.includes(reg)) break;
        continue;
      }
      if (!next.reads.includes(reg)) continue;
      const imm = next.ops.find((op) => op.k === 'imm' && (op.value != null || op.float != null));
      out.compares.push({
        row: next.row, address: next.address, mnemonic: mn,
        value: imm && imm.value != null ? imm.value : null,
        float: imm && imm.float != null ? imm.float : null,
      });
      break;
    }
  }
  return out;
}

/**
 * しきい値の見張り（「HP が 0 以下なら死亡」「所持金が足りなければ買えない」）を探す。
 * 変えると挙動が変わる定数の在り処になるので、見つかったら必ず見せる。
 */
export function verifyGuard(model, offset) {
  const use = fieldUse(model, offset);
  const guards = [];
  for (const c of use.compares) {
    guards.push({
      row: c.row, address: c.address,
      value: c.value, float: c.float, mnemonic: c.mnemonic,
    });
  }
  return { guards, loads: use.loads, stores: use.stores };
}

/**
 * 「この関数は、この値を扱う処理か」を命令で判定する。
 * 名前に頼らないので、名前が消されたバイナリでも使える。
 *
 * @returns {{touches:boolean, writes:boolean, rmw:boolean, guard:boolean, use:object}}
 */
export function verifyFunctionHandlesField(model, offset) {
  const use = fieldUse(model, offset);
  return {
    touches: use.sites.length > 0,
    writes: use.stores > 0,
    rmw: use.rmw.length > 0,
    guard: use.compares.length > 0,
    use,
  };
}

/**
 * セレクタ（Objective-C のメソッド名）を、この関数が実際に呼んでいるか。
 * 名前の一致ではなく、呼び出しの実在で確かめたいときに使う。
 */
export function callsSelector(model, re) {
  const out = [];
  for (const c of (model && model.calls) || []) {
    if (!c || !c.selector) continue;
    if (re.test(c.selector)) out.push({ selector: c.selector, row: c.row != null ? c.row : null });
  }
  return out;
}
