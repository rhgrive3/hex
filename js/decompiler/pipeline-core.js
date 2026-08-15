/*
 * High-level semantic decompiler pipeline.
 * It consumes the existing Semantic IR/SSA/Memory-SSA and deliberately does not
 * re-interpret ARM64 instruction text. The legacy decompiler remains an isolated
 * fallback at the public facade.
 */
import { expr, mergeSource, sourceOf, mapChildren, structuralKey, sameExpr } from './ast/nodes.js';
import { RewriteEngine } from './rewrite/engine.js';
import { DEFAULT_RULES } from './rewrite/rules.js';
import { recoverArm64ClangIdiom, recognizeClamp, recognizeDivisionByConstant } from './idioms/arm64-clang.js';
import { recoverHighVariables } from './types/high-variables.js';
import { recoverFunctionPrototype } from './types/prototype.js';
import { recoverAggregateLayouts } from './types/layout.js';
import { PassManager } from './passes/manager.js';
import { printExpression, printProgram, expressionReadability } from './pretty/c.js';
import { explainSemanticFacts } from './explain.js';

function valueOf(a) { return a?.value || null; }
function safeIdent(s, fallback = 'value') {
  const x = String(s || '').replace(/^_+/, '').replace(/[^A-Za-z0-9_$]/g, '_').replace(/^([0-9])/, '_$1');
  return x || fallback;
}
function constNode(v, value = v?.const ?? 0n) { return expr.constant(value, v?.bits || 64, v?.signed ?? null, origin(v?.def, v)); }
function typeFor(state, v) { return state.types?.values?.get?.(v?.id) || null; }
function signedFor(state, v) { const t = typeFor(state, v); return t?.signed ?? v?.signed ?? null; }
function origin(inst, v = null, reason = null) {
  return sourceOf({ address: inst?.address ?? null, row: inst?.row ?? null, ir: inst?.id ?? null, ssaDef: v?.id ?? inst?.dst?.id ?? null,
    ssaUses: (inst?.args || []).map(valueOf).filter(Boolean).map((x) => x.id), evidence: reason ? [{ reason }] : [] });
}

function argumentName(v, state) {
  const groupId = state.highVariables?.valueToGroup?.get(v?.id);
  const group = state.highVariables?.groups?.find((g) => g.id === groupId);
  if (group?.name) return group.name;
  const m = /^x([0-7])$/.exec(v?.reg || '');
  if (!m) return safeIdent(v?.reg || `value_${v?.id}`);
  const n = Number(m[1]);
  if (n === 0 && (state.opts?.receiverType || state.opts?.methodKind === 'objc')) return 'self';
  return state.opts?.argNames?.[n] || `a${n + 1}`;
}

function memoryLocation(inst, state) {
  const loc = inst?.loc || {};
  const addr = inst?.addr || {};
  if (loc.kind === 'stack') {
    const disp = BigInt(loc.disp ?? addr.disp ?? 0);
    return { kind: 'stack', key: loc.key, name: `local_${(disp < 0n ? -disp : disp).toString(16).toUpperCase()}`, text: `local_${(disp < 0n ? -disp : disp).toString(16).toUpperCase()}` };
  }
  if (loc.kind === 'global') {
    const name = state.opts?.symbolFor?.(loc.address);
    return { kind: 'global', key: loc.key, address: loc.address, name: name ? safeIdent(name) : `global_${BigInt(loc.address || 0).toString(16).toUpperCase()}`, text: name ? safeIdent(name) : `global_${BigInt(loc.address || 0).toString(16).toUpperCase()}` };
  }
  if (loc.kind === 'field') {
    const off = BigInt(loc.disp ?? addr.disp ?? 0);
    let known = null;
    try { known = state.opts?.fieldFor?.(addr.baseReg || loc.base?.reg || null, off, inst?.row) || null; } catch { known = null; }
    const base = buildValue(loc.base || addr.base, state, { forAddress: true });
    const name = safeIdent(known?.name || `field_${off.toString(16).toUpperCase()}`);
    return { kind: 'field', key: loc.key, offset: off, base, name, text: `${printExpression(base)}->${name}` };
  }
  if (addr.base && addr.index) {
    const base = buildValue(addr.base, state, { forAddress: true });
    const index = buildValue(addr.index, state, { forAddress: true });
    const scale = 1 << Number(addr.scale || 0);
    if (Number(addr.size || inst?.size || 0) === scale) return { kind: 'index', key: loc.key, base, index, scale, text: `${printExpression(base)}[${printExpression(index)}]` };
  }
  return { kind: 'unknown', key: loc.key || `memory:${inst?.id || '?'}`, name: 'memory_unknown', text: 'memory_unknown' };
}

function nzcvCondition(value, cond) {
  if (value == null) return null;
  const f = Number(value) & 15;
  const n=!!(f&8), z=!!(f&4), c=!!(f&2), v=!!(f&1);
  switch (cond) {
    case 'eq': return z; case 'ne': return !z;
    case 'cs': case 'hs': return c; case 'cc': case 'lo': return !c;
    case 'mi': return n; case 'pl': return !n; case 'vs': return v; case 'vc': return !v;
    case 'hi': return c && !z; case 'ls': return !c || z;
    case 'ge': return n === v; case 'lt': return n !== v;
    case 'gt': return !z && n === v; case 'le': return z || n !== v;
    case 'al': case 'nv': return true; default: return null;
  }
}

function compareFromFlags(flagValue, cond, state) {
  const d = flagValue?.def;
  if (!d || d.op !== 'cmp') return expr.variable('condition_' + (cond || 'flags'), 1, false);
  const a = buildArg(d.args?.[0], state);
  let b = buildArg(d.args?.[1], state);
  // ARM compare immediates inherit the register operand width. The IR wrapper
  // does not need to duplicate that width on the immediate itself, so canonicalize
  // the constant here before structural min/max matching (#356).
  if (b?.kind === 'const' && a?.bits && b.bits !== a.bits) b = expr.constant(BigInt.asUintN(Number(a.bits), b.value), Number(a.bits), false, b.source);
  const map = { eq:['eq',null], ne:['ne',null], hs:['ge',false], cs:['ge',false], lo:['lt',false], cc:['lt',false], hi:['gt',false], ls:['le',false], ge:['ge',true], lt:['lt',true], gt:['gt',true], le:['le',true] };
  const info = map[cond] || null;
  let normal;
  // CMP/CCMP are subtraction flags, so the standard relational conditions map
  // directly to a comparison. CCMN is addition flags; do not lie by rendering
  // it as lhs<rhs. Preserve the exact condition as a semantic intrinsic when it
  // cannot be losslessly expressed by one ordinary C comparison.
  if (d.sub !== 'add' && info) normal = expr.compare(info[0], a, b, info[1], origin(d));
  else if (d.sub === 'add' && (cond === 'eq' || cond === 'ne')) {
    const sum = expr.binary('add', a, b, a.bits || b.bits || 64, null, origin(d));
    normal = expr.compare(cond, sum, expr.constant(0, sum.bits || 64), null, origin(d));
  } else if (cond === 'al' || cond === 'nv') normal = expr.constant(1, 1, false, origin(d));
  else normal = expr.intrinsic((d.sub === 'add' ? 'ccmn_' : 'cmp_') + (cond || 'flags'), [a,b], 1, false, origin(d), { nzcvCondition:true });
  if (!d.extra?.conditional) return normal;
  const previousFlags = valueOf(d.args?.[2]);
  const gate = compareFromFlags(previousFlags, d.extra?.cond, state);
  const fallbackTruth = nzcvCondition(d.extra?.fallbackNzcv, cond);
  const fallback = fallbackTruth == null ? expr.variable('fallback_' + (cond || 'flags'), 1, false, origin(d))
    : expr.constant(fallbackTruth ? 1 : 0, 1, false, origin(d));
  return expr.select(gate, normal, fallback, 1, false, origin(d));
}

function applyShift(base, shift) {
  if (!base || !shift?.op) return base;
  const bits = Number(base.bits || 64);
  const amount = expr.constant(BigInt(shift.amount || 0), bits, false, base.source);
  switch (shift.op) {
    case 'lsl': return expr.binary('shl', base, amount, bits, base.signed, base.source);
    case 'lsr': return expr.binary('lshr', base, amount, bits, false, base.source);
    case 'asr': return expr.binary('ashr', base, amount, bits, true, base.source);
    case 'uxtb': return expr.unary('zext', expr.unary('trunc', base, 8, false, base.source), bits, false, base.source, { fromBits: 8 });
    case 'uxth': return expr.unary('zext', expr.unary('trunc', base, 16, false, base.source), bits, false, base.source, { fromBits: 16 });
    case 'uxtw': return expr.unary('zext', expr.unary('trunc', base, 32, false, base.source), bits, false, base.source, { fromBits: 32 });
    case 'sxtb': return expr.unary('sext', expr.unary('trunc', base, 8, true, base.source), bits, true, base.source, { fromBits: 8 });
    case 'sxth': return expr.unary('sext', expr.unary('trunc', base, 16, true, base.source), bits, true, base.source, { fromBits: 16 });
    case 'sxtw': return expr.unary('sext', expr.unary('trunc', base, 32, true, base.source), bits, true, base.source, { fromBits: 32 });
    default: return base;
  }
}

function buildArg(arg, state, flags = {}) {
  if (!arg) return expr.unknown('missing-arg');
  let out = buildValue(valueOf(arg), state, flags);
  const operandBits = Number(arg.bits || 0);
  const valueBits = Number(out?.bits || valueOf(arg)?.bits || 0);
  if (operandBits > 0 && out?.kind === 'const') {
    // Constants have no inherent signedness at the machine level. Canonicalize
    // every operand-width constant, even when the SSA constant already happens
    // to have that width, so cmp #0 and wzr are structurally identical.
    out = expr.constant(BigInt.asUintN(operandBits, out.value), operandBits, false, out.source);
  } else if (operandBits > 0 && valueBits > operandBits) {
    out = expr.unary('trunc', out, operandBits, false, sourceOf(out), { fromBits:valueBits });
  }
  return applyShift(out, arg.shift);
}

function selectExpression(d, state) {
  const t = buildArg(d.args?.[0], state), f = buildArg(d.args?.[1], state), flags = valueOf(d.args?.[2]);
  const condition = compareFromFlags(flags, d.cond, state);
  if (d.sub === 'inc') return expr.select(condition, t, expr.binary('add', f, expr.constant(1, f.bits), f.bits, f.signed), d.dst?.bits || t.bits, signedFor(state, d.dst), origin(d, d.dst));
  if (d.sub === 'inv') return expr.select(condition, t, expr.unary('not', f, f.bits, f.signed), d.dst?.bits || t.bits, signedFor(state, d.dst), origin(d, d.dst));
  if (d.sub === 'neg') return expr.select(condition, t, expr.unary('neg', f, f.bits, f.signed), d.dst?.bits || t.bits, signedFor(state, d.dst), origin(d, d.dst));
  // CINC/CINV/CNEG aliases carry one source. The operation applies when the
  // alias condition is true; treating them as ordinary CS* false arms reverses semantics.
  if (d.sub === 'cinc') return expr.select(condition, expr.binary('add', t, expr.constant(1, t.bits), t.bits, t.signed), t, d.dst?.bits || t.bits, signedFor(state, d.dst), origin(d, d.dst));
  if (d.sub === 'cinv') return expr.select(condition, expr.unary('not', t, t.bits, t.signed), t, d.dst?.bits || t.bits, signedFor(state, d.dst), origin(d, d.dst));
  if (d.sub === 'cneg') return expr.select(condition, expr.unary('neg', t, t.bits, t.signed), t, d.dst?.bits || t.bits, signedFor(state, d.dst), origin(d, d.dst));
  if (d.sub === 'set' || d.sub === 'setm') return expr.select(condition, t, f, d.dst?.bits || 1, false, origin(d, d.dst));
  return expr.select(condition, t, f, d.dst?.bits || t.bits, signedFor(state, d.dst), origin(d, d.dst));
}

function targetBlock(ir, cbr, rowOfAddress) {
  const addr = cbr?.extra?.target;
  if (addr == null) return null;
  const row = rowOfAddress?.(addr);
  if (row == null) return null;
  return ir.blocks.find((b) => row >= b.startRow && row <= b.endRow)?.index ?? null;
}

function blockTerm(block) {
  const xs = block?.insts || [];
  for (let i = xs.length - 1; i >= 0; i--) if (['cbr','br','ret'].includes(xs[i].op)) return xs[i];
  return null;
}

function branchSucc(ir, block, term, state) {
  const succ = block?.succ || [];
  if (term?.op !== 'cbr' || succ.length < 2) return { yes: succ[0] ?? null, no: succ[1] ?? null };
  const yes = targetBlock(ir, term, state.opts?.rowOfAddress);
  if (yes == null || !succ.includes(yes)) return { yes: succ[0] ?? null, no: succ[1] ?? null };
  return { yes, no: succ.find((x) => x !== yes) ?? null };
}

function branchCondition(inst, state) {
  const kind = inst?.extra?.kind || inst?.sub || '';
  const v = valueOf(inst?.args?.[0]);
  if (kind === 'cbz' || kind === 'cbnz') return expr.compare(kind === 'cbz' ? 'eq' : 'ne', expressionFor(v, state), expr.constant(0, v?.bits || 64), null, origin(inst));
  if (kind === 'tbz' || kind === 'tbnz') {
    const value = expressionFor(v, state);
    const bit = Number(inst.extra?.bit ?? 0);
    if (bit === Number(v?.bits || value.bits || 64) - 1) return expr.compare(kind === 'tbz' ? 'ge' : 'lt', value, expr.constant(0, v?.bits || value.bits || 64, true), true, origin(inst));
    const tested = expr.binary('and', expr.binary('lshr', value, expr.constant(bit, value.bits || 64), value.bits || 64, false), expr.constant(1, value.bits || 64), value.bits || 64, false);
    return expr.compare(kind === 'tbz' ? 'eq' : 'ne', tested, expr.constant(0, value.bits || 64), false, origin(inst));
  }
  return compareFromFlags(valueOf(inst?.args?.at?.(-1)), inst?.cond || inst?.extra?.cond, state);
}

function canReach(ir, start, target, blocked, cap = 256) {
  if (start == null || target == null) return false;
  const q = [start], seen = new Set();
  while (q.length && cap-- > 0) {
    const b = q.shift();
    if (b === target) return true;
    if (b === blocked || seen.has(b)) continue;
    seen.add(b);
    for (const s of ir.blocks?.[b]?.succ || []) if (!seen.has(s)) q.push(s);
  }
  return false;
}

function controllingBranchForMemoryPhi(phi, state) {
  const incoming = phi?.incoming || [];
  if (incoming.length !== 2) return null;
  const candidates = [];
  for (const block of state.ir.blocks || []) {
    const term = blockTerm(block);
    if (term?.op !== 'cbr' || (block.succ || []).length < 2) continue;
    const { yes, no } = branchSucc(state.ir, block, term, state);
    const yesIndex = incoming.findIndex((x) => canReach(state.ir, yes, x.from, phi.block));
    const noIndex = incoming.findIndex((x) => canReach(state.ir, no, x.from, phi.block));
    if (yesIndex >= 0 && noIndex >= 0 && yesIndex !== noIndex) candidates.push({ term, yesIndex, noIndex, row: term.row ?? -1 });
  }
  candidates.sort((a, b) => b.row - a.row);
  return candidates[0] || null;
}

function memoryNodeExpression(node, loadInst, state, seen = new Set()) {
  if (!node || seen.has(node)) return null;
  seen.add(node);
  if (node.kind === 'store' && node.inst) return buildArg(node.inst.args?.[0], state);
  if (node.kind !== 'phi') return null;
  const incoming = (node.incoming || []).filter((x) => x?.node);
  if (!incoming.length) return null;
  const values = incoming.map((x) => memoryNodeExpression(x.node, loadInst, state, new Set(seen)));
  if (values.some((x) => !x)) return null;
  const unique = new Map(values.map((x) => [structuralKey(x), x]));
  if (unique.size === 1) return values[0];
  if (incoming.length !== 2) return null;
  const control = controllingBranchForMemoryPhi(node, state);
  if (!control) return null;
  return expr.select(branchCondition(control.term, state), values[control.yesIndex], values[control.noIndex], loadInst?.dst?.bits || values[0].bits || 64, loadInst?.dst?.signed ?? null, origin(loadInst, loadInst?.dst, 'Memory SSA phi'));
}

function buildValue(v, state, flags = {}) {
  if (!v) return expr.variable('unknown', 64, null);
  const memoKey = `${v.id}:${flags.forAddress ? 'a' : 'v'}`;
  if (state.expressionMemo.has(memoKey)) return state.expressionMemo.get(memoKey);
  if (state.expressionActive.has(v.id)) return expr.variable(argumentName(v, state), v.bits || 64, signedFor(state, v), origin(v.def, v), { ssaId: v.id, range: v.range ? { ...v.range } : null });
  state.expressionActive.add(v.id);
  let out = null;
  const d = v.def;
  if (v.const != null && d?.op !== 'addr') out = constNode(v);
  if (!out && (v.kind === 'arg' || !d)) out = expr.variable(argumentName(v, state), v.bits || 64, signedFor(state, v), origin(d, v), { ssaId: v.id, range: v.range ? { ...v.range } : null });
  if (!out && d) {
    if (d.op === 'const') out = constNode(v, v.const ?? d.extra?.value ?? 0n);
    else if (d.op === 'mov') out = buildArg(d.args?.[0], state, flags);
    else if (d.op === 'bin') {
      const a = buildArg(d.args?.[0], state), b = d.args?.[1] ? buildArg(d.args[1], state) : expr.constant(0, v.bits || 64);
      if (d.sub === 'bic') out = expr.binary('and', a, expr.unary('not', b, v.bits || b.bits || 64, b.signed), v.bits || 64, signedFor(state, v), origin(d, v));
      else if (d.sub === 'orn') out = expr.binary('or', a, expr.unary('not', b, v.bits || b.bits || 64, b.signed), v.bits || 64, signedFor(state, v), origin(d, v));
      else if (d.sub === 'eon') out = expr.unary('not', expr.binary('xor', a, b, v.bits || 64, signedFor(state, v)), v.bits || 64, signedFor(state, v), origin(d, v));
      else out = expr.binary(d.sub, a, b, v.bits || 64, signedFor(state, v), origin(d, v));
      if (d.negate) out = expr.unary('neg', out, v.bits || 64, signedFor(state, v), origin(d, v));
    } else if (d.op === 'un') {
      const a = buildArg(d.args?.[0], state);
      const sub = String(d.sub || '');
      if (/^sxt/.test(sub)) out = expr.unary('sext', a, v.bits || 64, true, origin(d, v), { fromBits: Number(sub.slice(3)) || a.bits });
      else if (/^uxt/.test(sub)) out = expr.unary('zext', a, v.bits || 64, false, origin(d, v), { fromBits: Number(sub.slice(3)) || a.bits });
      else out = expr.unary(sub, a, v.bits || 64, signedFor(state, v), origin(d, v));
    } else if (d.op === 'mac') {
      const addend = buildArg(d.args?.[0], state);
      let a = buildArg(d.args?.[1], state), b = buildArg(d.args?.[2], state);
      if (d.extra?.widen === 'signed' || d.extra?.widen === 'unsigned') {
        const signed = d.extra.widen === 'signed';
        const op = signed ? 'sext' : 'zext';
        a = expr.unary(op, a, v.bits || 64, signed, origin(d, v), { fromBits:32 });
        b = expr.unary(op, b, v.bits || 64, signed, origin(d, v), { fromBits:32 });
      }
      const mult = expr.binary('mul', a, b, v.bits || 64, d.extra?.widen === 'unsigned' ? false : d.extra?.widen === 'signed' ? true : signedFor(state, v), origin(d, v));
      out = expr.binary(d.sub === 'msub' ? 'sub' : 'add', addend, mult, v.bits || 64, signedFor(state, v), origin(d, v));
    } else if (d.op === 'bfx') {
      out = expr.intrinsic('bit_extract', [buildArg(d.args?.[0], state), expr.constant(d.extra?.lsb ?? 0, 64), expr.constant(d.extra?.width ?? v.bits ?? 64, 64)], v.bits || 64, d.extra?.signed ?? d.signed ?? false, origin(d, v));
    } else if (d.op === 'bfi') {
      out = expr.intrinsic('bit_insert', [buildArg(d.args?.[0], state), buildArg(d.args?.[1], state), expr.constant(d.extra?.lsb ?? 0, 64), expr.constant(d.extra?.width ?? 16, 64)], v.bits || 64, signedFor(state, v), origin(d, v));
    } else if (d.op === 'sel') out = selectExpression(d, state);
    else if (d.op === 'addr') {
      const address = v.const ?? d.extra?.value ?? d.extra?.target;
      const name = address != null ? state.opts?.symbolFor?.(address) : null;
      out = expr.variable(name ? safeIdent(name) : `global_${BigInt(address || 0).toString(16).toUpperCase()}`, 64, false, origin(d, v), { address });
    } else if (d.op === 'load') {
      const loc = memoryLocation(d, state);
      // Memory SSA itself is the alias proof. If a reaching store survives to this
      // load, unrelated intervening stores/calls did not kill this location version.
      if (d.reachingStore && d.reachingStore !== d) out = buildArg(d.reachingStore.args?.[0], state);
      else out = memoryNodeExpression(d.memUse, d, state) || expr.load(loc, v.bits || Number((d.size || 8) * 8), origin(d, v), { signed: d.signed ?? signedFor(state, v), volatile: !!d.volatile });
    } else if (d.op === 'call') {
      out = expr.variable(`call_${d.id}`, v.bits || 64, signedFor(state, v), origin(d, v), { materializedCall: true });
    } else if (d.op === 'phi') {
      const incoming = (d.incoming || []).map((x) => buildValue(x.value, state));
      const unique = new Map(incoming.map((x) => [structuralKey(x), x]));
      out = unique.size === 1 ? incoming[0] : expr.variable(`local_phi_${v.id}`, v.bits || 64, signedFor(state, v), origin(d, v), { phi: true, incoming });
    }
  }
  if (!out) out = expr.variable(argumentName(v, state), v.bits || 64, signedFor(state, v), origin(d, v), { ssaId: v.id, range: v.range ? { ...v.range } : null });
  state.expressionActive.delete(v.id);
  state.expressionMemo.set(memoKey, out);
  return out;
}

function rewriteAll(state, budget) {
  const engine = new RewriteEngine(DEFAULT_RULES, { timeBudgetMs: Math.max(4, Math.min(22, budget.timeBudgetMs / 2)), nodeBudget: Math.min(4096, budget.nodeBudget) });
  state.expressions = new Map();
  state.rewriteProof = [];
  state.rewriteStats = { applications: 0, budgetExceeded: false, byRule: {} };
  for (const v of state.ir.values || []) {
    let root = buildValue(v, state);
    root = walkIdiom(root);
    const r = engine.rewrite(root, { state });
    state.expressions.set(v.id, r.root);
    state.rewriteProof.push(...r.proof.map((p) => ({ ...p, valueId: v.id })));
    state.rewriteStats.applications += r.stats.applications;
    state.rewriteStats.budgetExceeded ||= r.stats.budgetExceeded;
    for (const [k, n] of Object.entries(r.stats.byRule)) state.rewriteStats.byRule[k] = (state.rewriteStats.byRule[k] || 0) + n;
  }
  return state;
}

function walkIdiom(n) {
  if (!n) return n;
  const mapped = mapChildren(n, walkIdiom);
  return recoverArm64ClangIdiom(mapped);
}

function reachingRegisterValue(ir, atInst, reg) {
  let best = ir.args?.get?.(reg) || null;
  let bestRow = -Infinity;
  for (const v of ir.values || []) {
    if (v.reg !== reg || !v.def || v.clobbered) continue;
    const d = v.def;
    if (d.block === atInst.block && d.row < atInst.row && d.row > bestRow) { best = v; bestRow = d.row; }
  }
  return best;
}

function expressionFor(v, state) { return state.expressions?.get(v?.id) || walkIdiom(buildValue(v, state)); }

function semanticFacts(state, result) {
  const facts = { inputs: [], outputs: [], stores: [], calls: [], conditions: [], evidence: [], warnings: [] };
  for (const [reg, v] of state.ir.args || []) {
    if (/^x[0-7]$/.test(reg) && (v.uses || []).length) facts.inputs.push({ name: argumentName(v, state), reg, type: typeFor(state, v), valueId: v.id });
  }
  for (const inst of state.ir.instructions || []) {
    if (inst.op === 'store') {
      const location = memoryLocation(inst, state), value = valueOf(inst.args?.[0]), expression = expressionFor(value, state);
      const store = { location, lhsText: location.text, expression, source: origin(inst, inst.dst, 'Memory SSA store') };
      if (expression?.kind === 'intrinsic' && expression.name === 'max' && expression.args?.[1]?.kind === 'const' && expression.args[1].value === 0n && expression.args[0]?.kind === 'binary' && expression.args[0].op === 'sub') {
        store.readModifyWrite = { kind: 'clamp-zero-sub', operand: printExpression(expression.args[0].right) };
      } else if (expression?.kind === 'binary' && expression.op === 'add') store.readModifyWrite = { kind: 'add', operand: printExpression(expression.right) };
      facts.stores.push(store); facts.outputs.push({ name: location.text, type: state.types?.locations?.get?.(inst.loc?.key) || null });
      facts.evidence.push({ row: inst.row, address: inst.address, ir: inst.id, reason: 'Memory SSA store' });
    } else if (inst.op === 'call') {
      const modelCall = (state.model.calls || []).find((c) => c.row === inst.row) || null;
      const name = modelCall?.name || inst.extra?.name || (inst.extra?.target != null ? state.opts?.symbolFor?.(inst.extra.target) : null) || 'unknown_call';
      const runtime = /objc_msgSend/.test(name) ? 'objc' : /^_?swift_/.test(name) ? 'swift' : null;
      facts.calls.push({ name, runtime, row: inst.row, address: inst.address, ir: inst.id });
    } else if (inst.op === 'cbr') {
      const e = branchCondition(inst, state);
      facts.conditions.push({ expression: e, text: printExpression(e), row: inst.row, address: inst.address, ir: inst.id });
    } else if (inst.op === 'ret') {
      const rv = valueOf(inst.args?.[0]) || reachingRegisterValue(state.ir, inst, 'x0');
      if (rv) facts.outputs.push({ name: 'return', type: typeFor(state, rv), expression: expressionFor(rv, state) });
    }
  }
  facts.warnings.push(...(result.warnings || []));
  return facts;
}

function knownStatementForLine(line, state) {
  if (line?.row == null || line.kind !== 'stmt') return null;
  const insts = (state.ir.instructions || []).filter((i) => i.row === line.row);
  const store = insts.find((i) => i.op === 'store');
  if (store) {
    const location = memoryLocation(store, state), value = valueOf(store.args?.[0]), e = expressionFor(value, state);
    let text = `${location.text} = ${printExpression(e)};`;
    if (e?.kind === 'binary' && ['add','sub','mul'].includes(e.op) && e.left?.kind === 'load' && e.left.location?.key === location.key) {
      const rhs = printExpression(e.right);
      if (e.op === 'add' && e.right?.kind === 'const' && e.right.value === 1n) text = `${location.text}++;`;
      else if (e.op === 'sub' && e.right?.kind === 'const' && e.right.value === 1n) text = `${location.text}--;`;
      else text = `${location.text} ${{add:'+=',sub:'-=',mul:'*='}[e.op]} ${rhs};`;
    }
    return { text, semantic: { op: 'store', location, expression: e, ir: store.id }, source: mergeSource(line.source, e?.source, origin(store, store.dst)) };
  }
  const ret = insts.find((i) => i.op === 'ret');
  if (ret && /^return\b/.test(String(line.text || ''))) {
    const rv = valueOf(ret.args?.[0]) || reachingRegisterValue(state.ir, ret, 'x0');
    if (rv) { const e = expressionFor(rv, state); return { text: `return ${printExpression(e)};`, semantic: { op: 'return', expression: e, ir: ret.id }, source: mergeSource(line.source, e?.source, origin(ret, rv)) }; }
  }
  return null;
}

function cAstFromLines(result, state) {
  const body = [];
  for (const line of result.lines || []) {
    const known = knownStatementForLine(line, state);
    const carried = line.source || { address: line.addr, row: line.row };
    const source = known?.source || sourceOf({
      ...carried,
      evidence: [...(carried.evidence || []), ...(line.note ? [{ reason: line.note }] : [])],
    });
    body.push({ kind: line.kind || 'raw', indent: line.indent || 0, text: known?.text ?? line.text ?? '', source, semantic: known?.semantic || null });
  }
  return { kind: 'CProgram', body, source: mergeSource(...body.map((x) => x.source)) };
}

function semanticAstOf(state, facts) {
  return {
    kind: 'SemanticFunction',
    values: [...state.expressions.entries()].map(([valueId, expression]) => ({ kind: 'SemanticValue', valueId, expression, type: state.types?.values?.get?.(valueId) || null, source: expression.source })),
    stores: facts.stores.map((s) => ({ kind: 'SemanticStore', ...s })),
    calls: facts.calls.map((c) => ({ kind: 'SemanticCall', ...c })),
    conditions: facts.conditions.map((c) => ({ kind: 'SemanticCondition', ...c })),
    inputs: facts.inputs,
    outputs: facts.outputs,
  };
}

function metricsOf(result, state, printed) {
  const text = printed.text;
  const exprMetrics = [...state.expressions.values()].map(expressionReadability);
  return {
    rawAssemblyFallbacks: (text.match(/__asm\(/g) || []).length,
    gotos: (text.match(/\bgoto\b/g) || []).length,
    temporaries: (text.match(/\b(?:v|tmp|call_)\d+\b/g) || []).length,
    redundantCasts: exprMetrics.reduce((a, x) => a + x.casts, 0),
    rewrittenExpressions: state.rewriteStats?.applications || 0,
    rewriteBudgetExceeded: !!state.rewriteStats?.budgetExceeded,
    structured: result.coverage?.mode === 'structured',
    sourceMappedNodes: printed.mapping.length,
    passElapsedMs: state.passElapsedMs || 0,
  };
}

export function enhanceSemanticDecompilation(result, model, opts = {}) {
  if (!result?.semantic || !result.ir) return result;
  const state = {
    ir: result.ir, model, opts, types: result.types || null,
    expressionMemo: new Map(), expressionActive: new Set(),
    warnings: [],
  };
  const manager = new PassManager([
    { name: 'high-variable-recovery', run(s) { s.highVariables = recoverHighVariables(s.ir, s.types, opts); return s; } },
    { name: 'prototype-recovery', run(s) { s.prototype = recoverFunctionPrototype(s.ir, s.types, opts); return s; } },
    { name: 'aggregate-layout-recovery', run(s) { s.aggregateLayouts = recoverAggregateLayouts(s.ir, s.types, opts); return s; } },
    { name: 'canonical-expression-build', run(s) { for (const v of s.ir.values || []) buildValue(v, s); return s; } },
    { name: 'semantic-rewrite', run: rewriteAll },
    { name: 'semantic-facts', run(s) { s.facts = semanticFacts(s, result); return s; } },
    { name: 'typed-semantic-ast', run(s) { s.semanticAst = semanticAstOf(s, s.facts); return s; } },
    { name: 'c-ast', run(s) { s.cAst = cAstFromLines(result, s); return s; } },
    { name: 'pretty-print', run(s) { s.printed = printProgram(s.cAst, { columnWidth: opts.columnWidth || opts.prettyColumnWidth || 88 }); return s; } },
  ], { timeBudgetMs: Number(opts.decompilerTimeBudgetMs || 50), nodeBudget: Number(opts.decompilerNodeBudget || 12000), maxIterations: Number(opts.decompilerIterationCap || 16) });
  const advanced = manager.run(state);
  // Budgets are a degradation boundary, not a validity boundary. If a large function
  // exhausts the optional pass budget, finish the mandatory representation layers
  // once without additional fixed-point work so callers always receive a coherent AST.
  advanced.expressions ||= new Map([...advanced.expressionMemo.entries()]
    .filter(([key]) => String(key).endsWith(':v'))
    .map(([key, value]) => [Number(String(key).split(':')[0]), value]));
  advanced.rewriteProof ||= [];
  advanced.rewriteStats ||= { iterations: 0, applications: 0, budgetExceeded: true, elapsedMs: 0, byRule: {} };
  advanced.highVariables ||= recoverHighVariables(advanced.ir, advanced.types, opts);
  advanced.prototype ||= recoverFunctionPrototype(advanced.ir, advanced.types, opts);
  advanced.aggregateLayouts ||= recoverAggregateLayouts(advanced.ir, advanced.types, opts);
  advanced.facts ||= semanticFacts(advanced, result);
  advanced.semanticAst ||= semanticAstOf(advanced, advanced.facts);
  advanced.cAst ||= cAstFromLines(result, advanced);
  advanced.printed ||= printProgram(advanced.cAst, { columnWidth: opts.columnWidth || opts.prettyColumnWidth || 88 });
  const explanation = explainSemanticFacts(advanced.facts, result.summary);
  const lines = advanced.cAst.body.map((n) => ({ kind: n.kind, indent: n.indent, text: n.text, row: n.source.rows[0] ?? null, addr: n.source.addresses[0] ?? null, note: null, source: n.source }));
  return {
    ...result,
    lines,
    pseudocode: advanced.printed.text,
    semanticAst: advanced.semanticAst,
    cAst: advanced.cAst,
    semanticFacts: advanced.facts,
    sourceMap: advanced.printed.mapping,
    highVariables: advanced.highVariables,
    prototype: advanced.prototype,
    aggregateLayouts: advanced.aggregateLayouts,
    rewriteProof: advanced.rewriteProof,
    rewriteStats: advanced.rewriteStats,
    passMetrics: advanced.passMetrics,
    summary: explanation.summary,
    importantInputs: explanation.importantInputs,
    importantOutputs: explanation.importantOutputs,
    sideEffects: explanation.sideEffects,
    conditions: explanation.conditions,
    evidence: [...(result.evidence || []), ...(advanced.facts?.evidence || [])],
    warnings: [...new Set([...(result.warnings || []), ...(advanced.warnings || []), ...(advanced.rewriteStats?.budgetExceeded ? ['Decompiler rewrite budget reached; output was conservatively degraded.'] : [])])],
    metrics: metricsOf(result, advanced, advanced.printed),
    ctx: { ...(result.ctx || {}), decompilerPipeline: { phases: advanced.passMetrics, degraded: !!advanced.degraded, rewriteStats: advanced.rewriteStats } },
  };
}

export function buildExpressionForTesting(value, state) {
  const s = { expressionMemo: new Map(), expressionActive: new Set(), opts: {}, types: { values: new Map() }, highVariables: null, ...state };
  return buildValue(value, s);
}
