/*
 * ir.js — public facade for the Semantic IR engine.
 *
 * ir-core.js contains the current lifter/SSA/Memory-SSA implementation. This
 * facade supplies the address->row resolver that CFG reconstruction requires.
 * Previously irFor(model) called buildIR without rowOfAddress, so conditional
 * branch targets were treated as outside the function and phi placement could be
 * incomplete even though direct buildIR(model, { rowOfAddress }) worked.
 */

export * from './ir-core.js';

import { buildIR as buildCoreIR } from './ir-core.js';

function inferredRowResolver(model) {
  const byAddress = new Map();
  for (const insn of (model && model.instructions) || []) {
    if (insn && insn.address != null && insn.row != null) {
      byAddress.set(insn.address.toString(), insn.row);
    }
  }
  if (!byAddress.size) return () => null;
  return (addr) => {
    if (addr == null) return null;
    const row = byAddress.get(addr.toString());
    return row == null ? null : row;
  };
}

function normalizedOptions(model, opts) {
  const o = opts ? { ...opts } : {};
  if (!o.cfg && !o.rowOfAddress) o.rowOfAddress = inferredRowResolver(model);
  return o;
}

/** Build IR with a usable CFG even when callers only have the Semantic Model. */
export function buildIR(model, opts) {
  return buildCoreIR(model, normalizedOptions(model, opts));
}

/*
 * Keep the normal UI path cached by model identity. Custom CFG/resolver calls are
 * not cached because callers may intentionally be testing a different graph.
 */
const irCache = new WeakMap();

export function irFor(model, opts) {
  if (!model || !model.instructions || !model.instructions.length) return null;
  const custom = !!(opts && (opts.cfg || opts.rowOfAddress));
  if (!custom && irCache.has(model)) return irCache.get(model);
  let ir = null;
  try { ir = buildIR(model, opts); } catch { ir = null; }
  if (!custom) irCache.set(model, ir);
  return ir;
}
