/*
 * Typed Semantic IR recovery for the decompiler.
 *
 * This module deliberately treats type recovery as evidence fusion rather than
 * a size lookup. A 64-bit value is not a pointer until pointer use is observed;
 * signedness comes from signed operations/branches; Objective-C/Swift/runtime
 * metadata may strengthen (but never fabricate) a type.
 */

import { OP, MK, COND } from '../ir.js';

const INTEGER_NAMES = new Map([
  ['8:s', 'int8'], ['8:u', 'uint8'],
  ['16:s', 'int16'], ['16:u', 'uint16'],
  ['32:s', 'int32'], ['32:u', 'uint32'],
  ['64:s', 'int64'], ['64:u', 'uint64'],
]);

function evidence() {
  return {
    widths: new Map(), signed: 0, unsigned: 0, bool: 0, floating: 0,
    pointer: 0, object: 0, objc: 0, swift: 0, fnptr: 0, closure: 0,
    array: 0, nullable: null, nominal: null, enumName: null, structName: null,
    sources: [],
  };
}

function addSource(e, source, weight = 1) {
  if (!e || !source) return;
  if (e.sources.length < 16) e.sources.push({ source, weight });
}

function width(e, bits, weight = 1, source = null) {
  bits = Number(bits || 0);
  if (![8, 16, 32, 64, 128].includes(bits)) return;
  e.widths.set(bits, (e.widths.get(bits) || 0) + weight);
  addSource(e, source || `width:${bits}`, weight);
}

function score(e, key, weight, source) {
  e[key] = (e[key] || 0) + weight;
  addSource(e, source, weight);
}

function valueOf(arg) { return arg && arg.value ? arg.value : null; }

function bestWidth(e, fallback = 64) {
  let bits = fallback, best = -1;
  for (const [b, s] of e.widths) if (s > best) { bits = b; best = s; }
  return bits;
}

function confidence(top, second, base = 0.5) {
  if (!(top > 0)) return 0.25;
  const margin = Math.max(0, top - Math.max(0, second));
  return Math.min(0.98, base + Math.min(0.42, margin / Math.max(3, top + 2)));
}

export function typeNameOf(t) {
  if (!t) return 'unknown';
  if (typeof t === 'string') return t;
  if (t.name) return t.name;
  if (t.kind === 'pointer') return (t.pointee || 'void') + ' *';
  if (t.kind === 'objc') return (t.className || 'id') + (t.className ? ' *' : '');
  if (t.kind === 'swift') return t.nominal || 'SwiftObject *';
  return 'unknown';
}

export function mergeRecoveredTypes(a, b) {
  if (!a || a.name === 'unknown') return b || a;
  if (!b || b.name === 'unknown') return a;
  if (a.name === b.name) return { ...a, confidence: Math.max(a.confidence || 0, b.confidence || 0) };
  const ac = a.confidence || 0, bc = b.confidence || 0;
  if (Math.abs(ac - bc) < 0.12) {
    return {
      name: 'unknown', kind: 'ambiguous', confidence: Math.max(ac, bc) * 0.7,
      candidates: [a, b], warning: `conflicting type evidence: ${a.name} vs ${b.name}`,
    };
  }
  return ac > bc ? a : b;
}

function decide(e, fallbackBits = 64) {
  const bits = bestWidth(e, fallbackBits);
  const signed = e.signed;
  const unsigned = e.unsigned;
  const candidates = [];
  const push = (name, kind, s, extra = {}) => candidates.push({ name, kind, score: s, ...extra });

  if (e.nominal) {
    const k = e.objc >= e.swift ? 'objc' : 'swift';
    push(k === 'objc' ? `${e.nominal} *` : e.nominal, k, 12 + e.objc + e.swift,
      k === 'objc' ? { className: e.nominal } : { nominal: e.nominal });
  }
  if (e.closure) push('closure', 'closure', e.closure + e.pointer + 2);
  if (e.fnptr) push('function *', 'function-pointer', e.fnptr + e.pointer + 1);
  if (e.objc) push('id', 'objc', e.objc + e.object + e.pointer + 1);
  if (e.swift) push('SwiftObject *', 'swift', e.swift + e.object + e.pointer + 1);
  if (e.pointer || e.object) push('void *', 'pointer', e.pointer + e.object);
  if (e.floating) push(bits <= 32 ? 'float' : 'double', 'float', e.floating + 1);
  if (e.bool) push('bool', 'bool', e.bool + Math.max(0, 2 - Math.max(signed, unsigned)));
  if (e.enumName) push(e.enumName, 'enum', 7, { enumName: e.enumName });
  if (e.structName) push(e.structName, 'struct', 7, { structName: e.structName });

  const signKnown = Math.max(signed, unsigned) >= 2 || Math.abs(signed - unsigned) >= 2;
  const isSigned = signKnown ? signed > unsigned : null;
  const intName = INTEGER_NAMES.get(`${bits}:${isSigned === false ? 'u' : 's'}`) || (bits > 32 ? 'int64' : 'int32');
  push(intName, 'integer', Math.max(1, signed, unsigned), { bits, signed: isSigned });

  candidates.sort((x, y) => y.score - x.score);
  const top = candidates[0];
  const next = candidates[1];
  if (!top) return { name: 'unknown', kind: 'unknown', bits, confidence: 0.2, evidence: e.sources };

  /* A lone width observation must never turn a 64-bit quantity into a pointer. */
  if (top.kind === 'integer' && signed === 0 && unsigned === 0 && e.bool === 0 && e.floating === 0) {
    top.name = 'unknown';
    top.kind = 'unknown';
  }

  return {
    ...top,
    bits,
    nullable: e.nullable,
    confidence: confidence(top.score, next ? next.score : 0, top.kind === 'unknown' ? 0.25 : 0.5),
    evidence: e.sources.slice(),
    candidates: candidates.slice(0, 4).map(({ score: _score, ...c }) => c),
  };
}

// Derive comparison signedness from Semantic IR flags def-use. Re-scanning raw
// ARM64 rows here would make type recovery depend on instruction adjacency and
// would violate the IR-as-semantic-truth boundary.
function branchSignedness(ir) {
  const signedCmpIds = new Set(), unsignedCmpIds = new Set();
  for (const inst of (ir && ir.instructions) || []) {
    if (inst.op !== OP.CBR || !inst.cond) continue;
    const info = COND[inst.cond];
    if (!info || info.signed == null) continue;
    const flagsArg = (inst.args || []).find((a) => a && a.value && a.value.reg === 'nzcv');
    const cmp = flagsArg && flagsArg.value && flagsArg.value.def;
    if (!cmp || cmp.op !== OP.CMP) continue;
    (info.signed ? signedCmpIds : unsignedCmpIds).add(cmp.id);
  }
  return { signedCmpIds, unsignedCmpIds };
}

function applyRuntimeHints(ir, evidences, runtime) {
  if (!runtime) return;
  const hints = runtime.valueTypes || runtime.typesByValue || null;
  if (hints && typeof hints.get === 'function') {
    for (const v of ir.values || []) {
      const h = hints.get(v.id) || hints.get(v.vid) || hints.get(v);
      if (!h) continue;
      const e = evidences.get(v.id);
      if (!e) continue;
      const origin = h.runtime || h.origin || h.kind;
      if (origin === 'objc') score(e, 'objc', 8, 'Objective-C runtime metadata');
      if (origin === 'swift') score(e, 'swift', 8, 'Swift runtime metadata');
      if (h.className || h.nominal || h.name) e.nominal = h.className || h.nominal || h.name;
      if (h.nullable != null) e.nullable = !!h.nullable;
    }
  }
}

/**
 * Infer types directly from Semantic IR/SSA/Memory SSA.
 * The return shape intentionally extends (rather than replaces) inferTypes():
 * {args, locals, ret, values, locations, warnings}.
 */
export function inferSemanticTypes(ir, model, opts = {}) {
  if (!ir) return { args: [], locals: [], ret: { type: 'void', conf: 0.2 }, values: new Map(), locations: new Map(), warnings: ['Semantic IR unavailable'] };
  const ev = new Map();
  const locEv = new Map();
  const eFor = (v) => {
    if (!v) return null;
    if (!ev.has(v.id)) ev.set(v.id, evidence());
    return ev.get(v.id);
  };
  const lFor = (loc) => {
    if (!loc) return null;
    if (!locEv.has(loc.key)) locEv.set(loc.key, evidence());
    return locEv.get(loc.key);
  };
  for (const v of ir.values || []) {
    const e = eFor(v);
    width(e, v.bits || 64, 0.5, 'SSA value width');
    if (v.signed === true) score(e, 'signed', 3, 'IR signedness');
    if (v.signed === false) score(e, 'unsigned', 3, 'IR unsignedness');
    if (v.nullable != null) e.nullable = !!v.nullable;
  }

  const branches = branchSignedness(ir);
  for (const inst of ir.instructions || []) {
    const dst = eFor(inst.dst);
    if (dst && inst.dst) width(dst, inst.dst.bits || 64, 1, `row ${inst.row}: result width`);

    if (inst.op === OP.LOAD || inst.op === OP.STORE) {
      const le = lFor(inst.loc);
      const bits = Number(((inst.loc && inst.loc.size) || (inst.addr && inst.addr.size) || 8) * 8);
      width(le, bits, 3, `row ${inst.row}: memory access width`);
      if (inst.op === OP.LOAD && dst) width(dst, bits, 3, `row ${inst.row}: load width`);
      if (inst.op === OP.STORE) {
        const ve = eFor(valueOf(inst.args && inst.args[0]));
        if (ve) width(ve, bits, 2, `row ${inst.row}: store width`);
      }
      const base = inst.addr && inst.addr.base;
      const be = eFor(base);
      if (be && !(inst.loc && inst.loc.kind === MK.STACK)) score(be, 'pointer', 5, `row ${inst.row}: used as memory base`);
      if (inst.addr && inst.addr.index) {
        const ie = eFor(inst.addr.index);
        if (ie) score(ie, 'unsigned', 1, `row ${inst.row}: address index`);
        if (le) score(le, 'array', 2, `row ${inst.row}: indexed access`);
      }
    }

    if (inst.op === OP.BIN) {
      const args = (inst.args || []).map(valueOf).filter(Boolean);
      if (/^s(div|mul)|ashr/.test(inst.sub || '')) for (const a of args) score(eFor(a), 'signed', 4, `row ${inst.row}: ${inst.sub}`);
      if (/^u(div|mul)|lshr/.test(inst.sub || '')) for (const a of args) score(eFor(a), 'unsigned', 4, `row ${inst.row}: ${inst.sub}`);
      if (/^f(add|sub|mul|div)/.test(inst.sub || '')) {
        for (const a of args) score(eFor(a), 'floating', 5, `row ${inst.row}: ${inst.sub}`);
        if (dst) score(dst, 'floating', 5, `row ${inst.row}: ${inst.sub}`);
      }
      if (/^(and|or|xor|bic)$/.test(inst.sub || '') && inst.dst && inst.dst.bits === 1) score(dst, 'bool', 3, `row ${inst.row}: bitwise boolean`);
    }

    if (inst.op === OP.UN) {
      const a = eFor(valueOf(inst.args && inst.args[0]));
      if (/^sxt/.test(inst.sub || '')) score(a, 'signed', 5, `row ${inst.row}: sign extension`);
      if (/^uxt/.test(inst.sub || '')) score(a, 'unsigned', 5, `row ${inst.row}: zero extension`);
      if (/^(i2f|f2i)/.test(inst.sub || '')) { if (a) score(a, 'signed', 3, `row ${inst.row}: numeric conversion`); if (dst && inst.sub === 'i2f') score(dst, 'floating', 5, `row ${inst.row}: float conversion`); }
      if (/^(u2f|f2u)/.test(inst.sub || '')) { if (a) score(a, 'unsigned', 3, `row ${inst.row}: numeric conversion`); if (dst && inst.sub === 'u2f') score(dst, 'floating', 5, `row ${inst.row}: float conversion`); }
    }

    if (inst.op === OP.CMP) {
      const args = (inst.args || []).map(valueOf).filter(Boolean);
      const signedBranch = branches.signedCmpIds.has(inst.id);
      const unsignedBranch = branches.unsignedCmpIds.has(inst.id);
      for (const a of args) {
        if (signedBranch) score(eFor(a), 'signed', 5, `row ${inst.row}: signed conditional branch`);
        if (unsignedBranch) score(eFor(a), 'unsigned', 5, `row ${inst.row}: unsigned conditional branch`);
      }
    }

    if (inst.op === OP.CBR) {
      const kind = inst.extra && inst.extra.kind;
      const a = eFor(valueOf(inst.args && inst.args[0]));
      if ((kind === 'tbz' || kind === 'tbnz') && a) score(a, 'unsigned', 2, `row ${inst.row}: bit test`);
      if ((kind === 'cbz' || kind === 'cbnz') && a && a.pointer > 0) a.nullable = true;
    }

    if (inst.op === OP.CALL) {
      const name = String((inst.extra && inst.extra.name) || (inst.insn && inst.insn.callName) || '');
      if (/objc_msgSend/.test(name)) {
        const recv = ir.args && ir.args.get ? ir.args.get('x0') : null;
        const re = eFor(recv); if (re) score(re, 'objc', 6, `row ${inst.row}: Objective-C message receiver`);
      }
      if (/^_?swift_/.test(name) && dst) score(dst, 'swift', 2, `row ${inst.row}: Swift runtime call`);
      if (/Block_copy|_Block_copy|_Block_release/.test(name)) {
        const a0 = ir.args && ir.args.get ? ir.args.get('x0') : null;
        const ce = eFor(a0); if (ce) score(ce, 'closure', 7, `row ${inst.row}: Objective-C block runtime`);
      }
    }
  }

  applyRuntimeHints(ir, ev, opts.runtime || opts.appleRuntime);

  const values = new Map();
  for (const v of ir.values || []) values.set(v.id, decide(eFor(v), v.bits || 64));
  const locations = new Map();
  for (const [key, e] of locEv) locations.set(key, decide(e, 64));

  const args = [];
  for (let i = 0; i < 8; i++) {
    const v = ir.args && ir.args.get ? ir.args.get('x' + i) : null;
    if (!v) continue;
    const t = values.get(v.id) || { name: 'unknown', confidence: 0.2 };
    const used = (v.uses || []).length > 0 || ((model && model.argRegs) || []).includes(i);
    if (!used) continue;
    args.push({ reg: 'x' + i, index: i, type: t.name, conf: t.confidence, why: t.evidence || [], semanticType: t });
  }

  const locals = [];
  for (const slot of ir.stackSlots || []) {
    const key = slot.key || [...(ir.locations || new Map()).keys()].find((k) => k === slot.key);
    const t = (key && locations.get(key)) || { name: 'unknown', confidence: 0.25, evidence: [] };
    locals.push({ slot: slot.name || key || 'var', offset: Number(slot.offset || slot.disp || 0), type: t.name, conf: t.confidence, why: t.evidence || [], semanticType: t });
  }

  let ret = { type: 'void', conf: 0.55, why: [] };
  const rets = (ir.instructions || []).filter((i) => i.op === OP.RET);
  if (rets.length) {
    const vals = rets.map((r) => valueOf(r.args && r.args[0])).filter(Boolean);
    if (vals.length) {
      let picked = null;
      for (const v of vals) picked = mergeRecoveredTypes(picked, values.get(v.id));
      if (picked) ret = { type: picked.name, conf: picked.confidence, why: picked.evidence || [], semanticType: picked };
    }
  }

  const warnings = [];
  for (const t of values.values()) if (t.kind === 'ambiguous' && t.warning) warnings.push(t.warning);
  return { args, locals, ret, values, locations, warnings };
}

export function semanticSignature(name, recovered, notes = null, funcAddr = null) {
  const rt = (notes && notes.typeOf && notes.typeOf(funcAddr, 'ret')) || (recovered.ret && recovered.ret.type) || 'void';
  const args = (recovered.args || []).map((a) => {
    const t = (notes && notes.typeOf && notes.typeOf(funcAddr, 'a' + a.index)) || (a.type === 'unknown' ? 'uint64' : a.type);
    const n = (notes && notes.varName && notes.varName(funcAddr, 'a' + a.index)) || `a${a.index + 1}`;
    return `${t} ${n}`;
  });
  return `${rt === 'unknown' ? 'uint64' : rt} ${name || 'sub'}(${args.length ? args.join(', ') : 'void'})`;
}
