/*
 * 検証 — 「そう書いてある」を「本当にそう動く」に上げる層。
 * 実際の命令とdataflowで裏取りできないものは確定扱いしない。
 */
import { findValueUpdates, constantComparisons, regKeyOf, selfRegisters } from './dataflow.js';

const ARG2 = 'x2';
export { selfRegisters };

function memoryTouchesSelf(insn, isSelf, offset, kind = null) {
  const m = insn?.memory;
  if (!m || m.indexed || m.disp == null || m.stack) return false;
  if (kind && m.kind !== kind) return false;
  return isSelf(m.base, insn.row) && m.disp === offset;
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

  const { isSelf } = selfRegisters(model);
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
    } else others++;
  }
  if (!hit) return out;

  out.size = hit.size;
  out.row = hit.insn.row;
  out.address = hit.insn.address;
  out.otherOffsets = others;
  out.exclusive = others === 0;

  if (out.setter) {
    // `self` can move between registers and a callee may clobber a previously
    // self-looking register. Resolve the exact store row instead of consulting
    // the summary Set returned by selfRegisters().
    const store = insns.find((i) => memoryTouchesSelf(i, isSelf, offset, 'store'));
    if (store) {
      const src = regKeyOf(store.ops[0]);
      out.fromArgument = !!src && (src === ARG2 || src === 'w2' || wideOf(src) === ARG2 || tracesToArgument(insns, store.row, src));
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
    if (controlBoundary(insn)) return false;
    if (!insn.writes.includes(want)) continue;
    if (insn.memory) return false;
    const next = insn.reads.find((r) => /^[wx][2-7]$/.test(r)) || insn.reads[0];
    if (!next) return false;
    if (/^[wx][2-7]$/.test(next)) return true;
    want = next;
  }
  return false;
}

function controlBoundary(insn) {
  const mn = String(insn?.mnemonic || '').toLowerCase();
  return /^(?:b(?:\.|$)|cbz$|cbnz$|tbz$|tbnz$|br$|blr$|bl$|ret$|retaa$|retab$)/.test(mn);
}

/** Count how self+offset is used, preserving only proven same-control-path guards. */
export function fieldUse(model, offset, opts) {
  const o = opts || {};
  const want = typeof offset === 'bigint' ? offset : BigInt(offset);
  const out = { loads: 0, stores: 0, rmw: [], compares: [], sites: [], self: false };
  if (!model) return out;
  const insns = model.instructions || [];
  const { isSelf: selfAt } = selfRegisters(model);
  const selfOnly = o.selfOnly !== false;

  for (const insn of insns) {
    const m = insn.memory;
    if (!m || m.stack || m.indexed || m.disp == null || m.disp !== want) continue;
    const isSelf = selfAt(m.base, insn.row);
    if (selfOnly && !isSelf) continue;
    if (isSelf) out.self = true;
    if (m.kind === 'load') out.loads++; else out.stores++;
    out.sites.push({ row: insn.row, address: insn.address, kind: m.kind, base: m.base, size: m.size, self: isSelf });
  }
  if (!out.sites.length) return out;

  for (const u of findValueUpdates(model)) {
    if (u.kind !== 'read-modify-write' || u.location.disp !== want) continue;
    if (selfOnly && !u.location.self) continue;
    out.rmw.push(u);
  }

  const byRow = new Map(insns.map((i) => [i.row, i]));
  const comparisonByRow = new Map(constantComparisons(model, { allowUnscopedPropagated: true }).map((c) => [c.row, c]));
  for (const site of out.sites) {
    if (site.kind !== 'load') continue;
    const insn = byRow.get(site.row);
    if (!insn) continue;
    const reg = regKeyOf(insn.ops[0]);
    if (!reg) continue;
    for (let r = site.row + 1; r <= site.row + 8; r++) {
      const next = byRow.get(r);
      if (!next) continue;
      // Never jump across a call/branch/return just because the numeric row is
      // nearby. That was enough to attach guards from a different CFG path.
      if (controlBoundary(next)) break;
      const mn = String(next.mnemonic || '').toLowerCase();
      if (!/^(cmp|cmn|subs|adds|ccmp|fcmp|tst)$/.test(mn)) {
        // An in-place transform such as `sub w8, w8, w2` still carries the
        // loaded field value. A write that does not read the tracked register
        // is a new definition and ends the chain.
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
  return { guards: use.compares.map((c) => ({ row: c.row, address: c.address, value: c.value, float: c.float, mnemonic: c.mnemonic, engine: c.engine || null, propagated: !!c.propagated })), loads: use.loads, stores: use.stores };
}

export function verifyFunctionHandlesField(model, offset) {
  const use = fieldUse(model, offset);
  return { touches: use.sites.length > 0, writes: use.stores > 0, rmw: use.rmw.length > 0, guard: use.compares.length > 0, use };
}

export function callsSelector(model, re) {
  const out = [];
  for (const c of (model && model.calls) || []) if (c?.selector && re.test(c.selector)) out.push({ selector: c.selector, row: c.row != null ? c.row : null });
  return out;
}
