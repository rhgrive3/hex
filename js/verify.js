/*
 * 検証 — 「そう書いてある」を「本当にそう動く」に上げる層。
 *
 * このツールのこれまでの弱点は、名前を読んだだけで終わっていたことだった。
 * クラス表に「_hp は先頭から 0x20 の位置にある 4 バイトの整数」と書いてあっても、
 * それは**表にそう書いてある**というだけで、コードが本当にそこを HP として
 * 使っている保証にはならない。表が古い、別のクラスと位置が同じ、という話は普通にある。
 *
 * ここでやるのは、その仮説を **実際に逆アセンブルして確かめる** こと。
 * 日本語は作らない。
 */
import { findValueUpdates, constantComparisons, locationKey, regKeyOf, selfRegisters } from './dataflow.js';

const ARG0 = 'x0';
const ARG2 = 'x2';

export { selfRegisters };

function touches(insn, selfSet, offset) {
  const m = insn.memory;
  if (!m || m.indexed || m.disp == null || m.stack) return false;
  if (!selfSet.has(m.base)) return false;
  return m.disp === offset;
}

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
  if (!insns.length || insns.length > max) return out;

  const { set, isSelf } = selfRegisters(model);
  void set;
  let others = 0;
  let hit = null;

  for (const insn of insns) {
    const m = insn.memory;
    if (!m || m.stack || m.indexed || m.disp == null) continue;
    if (!isSelf(m.base, insn.row)) continue;
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
  out.exclusive = others === 0;

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
 * RMW は dataflow facade を通るため、SSA/Memory-SSAで証明できる場合はその結果を使う。
 */
export function fieldUse(model, offset, opts) {
  const o = opts || {};
  const want = typeof offset === 'bigint' ? offset : BigInt(offset);
  const out = { loads: 0, stores: 0, rmw: [], compares: [], sites: [], self: false };
  if (!model) return out;
  const insns = model.instructions || [];
  const { set, isSelf: selfAt } = selfRegisters(model);
  const selfOnly = o.selfOnly !== false;

  for (const insn of insns) {
    const m = insn.memory;
    if (!m || m.stack || m.indexed || m.disp == null) continue;
    if (m.disp !== want) continue;
    const isSelf = selfAt(m.base, insn.row);
    if (selfOnly && !isSelf) continue;
    if (isSelf) out.self = true;
    if (m.kind === 'load') out.loads++; else out.stores++;
    out.sites.push({
      row: insn.row, address: insn.address, kind: m.kind,
      base: m.base, size: m.size, self: isSelf,
    });
  }
  if (!out.sites.length) return out;

  for (const u of findValueUpdates(model)) {
    if (u.kind !== 'read-modify-write') continue;
    if (u.location.disp !== want) continue;
    if (selfOnly && !u.location.self) continue;
    out.rmw.push(u);
  }

  /*
   * しきい値は「このフィールドをloadしたレジスタ」を最大8行だけ追う既存の局所条件を
   * 維持する。その比較命令が即値を直接持たない場合だけ、SSAが同じcompare行で
   * 証明した定数を補う。SSA側の variable register が追跡中のregと一致するときに
   * 限るので、比較の反対側（フィールド自身）が定数化されたケースを閾値と誤認しない。
   */
  const byRow = new Map(insns.map((i) => [i.row, i]));
  const comparisonByRow = new Map(constantComparisons(model).map((c) => [c.row, c]));
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
        if (next.writes.includes(reg) && !next.reads.includes(reg)) break;
        continue;
      }
      if (!next.reads.includes(reg)) continue;
      const imm = next.ops.find((op) => op.k === 'imm' && (op.value != null || op.float != null));
      const fact = comparisonByRow.get(next.row) || null;
      const ssaFact = fact && fact.register === reg ? fact : null;
      out.compares.push({
        row: next.row, address: next.address, mnemonic: mn,
        value: imm && imm.value != null ? imm.value : (ssaFact ? ssaFact.value : null),
        float: imm && imm.float != null ? imm.float : (ssaFact ? ssaFact.float : null),
        engine: ssaFact ? ssaFact.engine : null,
        propagated: !!(ssaFact && ssaFact.propagated),
      });
      break;
    }
  }
  return out;
}

export function verifyGuard(model, offset) {
  const use = fieldUse(model, offset);
  const guards = [];
  for (const c of use.compares) {
    guards.push({
      row: c.row, address: c.address,
      value: c.value, float: c.float, mnemonic: c.mnemonic,
      engine: c.engine || null, propagated: !!c.propagated,
    });
  }
  return { guards, loads: use.loads, stores: use.stores };
}

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

export function callsSelector(model, re) {
  const out = [];
  for (const c of (model && model.calls) || []) {
    if (!c || !c.selector) continue;
    if (re.test(c.selector)) out.push({ selector: c.selector, row: c.row != null ? c.row : null });
  }
  return out;
}
