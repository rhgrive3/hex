/*
 * High-level semantic decompiler pipeline.
 * It consumes the existing Semantic IR/SSA/Memory-SSA and deliberately does not
 * re-interpret ARM64 instruction text. The legacy decompiler remains an isolated
 * fallback at the public facade.
 */
import { expr, mergeSource, sourceOf, mapChildren, structuralKey } from './ast/nodes.js';
import { RewriteEngine } from './rewrite/engine.js';
import { DEFAULT_RULES } from './rewrite/rules.js';
import { recoverArm64ClangIdiom, recognizeClamp, recognizeDivisionByConstant } from './idioms/arm64-clang.js';
import { recoverHighVariables } from './types/high-variables.js';
import { recoverFunctionPrototype } from './types/prototype.js';
import { recoverAggregateLayouts } from './types/layout.js';
import { PassManager } from './passes/manager.js';
import { printExpression, printProgram, expressionReadability } from './pretty/c.js';
import { explainSemanticFacts } from './explain.js';

const PURE_OPS = new Set(['const','mov','bin','un','mac','bfx','bfi','sel','addr','phi']);
const BARRIER_OPS = new Set(['call','store','clobber','unknown']);

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
  return m ? state.opts?.argNames?.[Number(m[1])] || `arg${Number(m[1]) + 1}` : safeIdent(v?.reg || `value_${v?.id}`);
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

function hasBarrierBetween(from, to, state) {
  if (!from || !to || from.block !== to.block || from.row == null || to.row == null) return true;
  const lo = Math.min(from.row, to.row), hi = Math.max(from.row, to.row);
  return (state.ir.instructions || []).some((i) => i.block === from.block && i.row > lo && i.row < hi && BARRIER_OPS.has(i.op));
}

function compareFromFlags(flagValue, cond, state) {
  const d = flagValue?.def;
  if (!d || d.op !== 'cmp') return expr.variable(`condition_${cond || 'flags'}`, 1, false, origin(d, flagValue));
  const a = buildValue(valueOf(d.args?.[0]), state), b = buildValue(valueOf(d.args?.[1]), state);
  const map = { eq:'eq', ne:'ne', hs:'ge', cs:'ge', lo:'lt', cc:'lt', hi:'gt', ls:'le', ge:'ge', lt:'lt', gt:'gt', le:'le' };
  const op = map[cond] || (d.sub === 'sub' ? 'ne' : 'ne');
  const signed = ['ge','lt','gt','le'].includes(cond) ? true : ['hs','cs','lo','cc','hi','ls'].includes(cond) ? false : null;
  return expr.compare(op, a, b, signed, origin(d, d.dst, 'condition flags'));
}

function selectExpression(d, state) {
  const t = buildValue(valueOf(d.args?.[0]), state), f = buildValue(valueOf(d.args?.[1]), state), flags = valueOf(d.args?.[2]);
  let condition = compareFromFlags(flags, d.cond, state);
  if (d.sub === 'inc') return expr.select(condition, t, expr.binary('add', f, expr.constant(1, f.bits), f.bits, f.signed), d.dst?.bits || t.bits, signedFor(state, d.dst), origin(d, d.dst));
  if (d.sub === 'inv') return expr.select(condition, t, expr.unary('not', f, f.bits, f.signed), d.dst?.bits || t.bits, signedFor(state, d.dst), origin(d, d.dst));
  if (d.sub === 'neg') return expr.select(condition, t, expr.unary('neg', f, f.bits, f.signed), d.dst?.bits || t.bits, signedFor(state, d.dst), origin(d, d.dst));
  if (d.sub === 'set' || d.sub === 'setm') return expr.select(condition, t, f, d.dst?.bits || 1, false, origin(d, d.dst));
  return expr.select(condition, t, f, d.dst?.bits || t.bits, signedFor(state, d.dst), origin(d, d.dst));
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
    const args = (d.args || []).map(valueOf);
    if (d.op === 'const') out = constNode(v, v.const ?? d.extra?.value ?? 0n);
    else if (d.op === 'mov') out = buildValue(args[0], state, flags);
    else if (d.op === 'bin') {
      const a = buildValue(args[0], state), b = args[1] ? buildValue(args[1], state) : expr.constant(0, v.bits || 64);
      out = expr.binary(d.sub, a, b, v.bits || 64, signedFor(state, v), origin(d, v));
      if (d.negate) out = expr.unary('neg', out, v.bits || 64, signedFor(state, v), origin(d, v));
    } else if (d.op === 'un') {
      const a = buildValue(args[0], state);
      const sub = String(d.sub || '');
      if (/^sxt/.test(sub)) out = expr.unary('sext', a, v.bits || 64, true, origin(d, v), { fromBits: Number(sub.slice(3)) || a.bits });
      else if (/^uxt/.test(sub)) out = expr.unary('zext', a, v.bits || 64, false, origin(d, v), { fromBits: Number(sub.slice(3)) || a.bits });
      else out = expr.unary(sub, a, v.bits || 64, signedFor(state, v), origin(d, v));
    } else if (d.op === 'mac') {
      const addend = buildValue(args[0], state), a = buildValue(args[1], state), b = buildValue(args[2], state);
      const mult = expr.binary('mul', a, b, v.bits || 64, d.widen === 'unsigned' ? false : d.widen === 'signed' ? true : signedFor(state, v), origin(d, v));
      out = expr.binary(d.sub === 'msub' ? 'sub' : 'add', addend, mult, v.bits || 64, signedFor(state, v), origin(d, v));
    } else if (d.op === 'bfx') {
      out = expr.intrinsic('bit_extract', [buildValue(args[0], state), expr.constant(d.extra?.lsb ?? 0, 64), expr.constant(d.extra?.width ?? v.bits ?? 64, 64)], v.bits || 64, d.extra?.signed ?? d.signed ?? false, origin(d, v));
    } else if (d.op === 'bfi') {
      out = expr.intrinsic('bit_insert', [buildValue(args[0], state), buildValue(args[1], state), expr.constant(d.extra?.lsb ?? 0, 64), expr.constant(d.extra?.width ?? 16, 64)], v.bits || 64, signedFor(state, v), origin(d, v));
    } else if (d.op === 'sel') out = selectExpression(d, state);
    else if (d.op === 'addr') {
      const address = v.const ?? d.extra?.value ?? d.extra?.target;
      const name = address != null ? state.opts?.symbolFor?.(address) : null;
      out = expr.variable(name ? safeIdent(name) : `global_${BigInt(address || 0).toString(16).toUpperCase()}`, 64, false, origin(d, v), { address });
    } else if (d.op === 'load') {
      const loc = memoryLocation(d, state);
      if (d.reachingStore && !hasBarrierBetween(d.reachingStore, d, state)) out = buildValue(valueOf(d.reachingStore.args?.[0]), state);
      else out = expr.load(loc, v.bits || Number((d.size || 8) * 8), origin(d, v), { signed: d.signed ?? signedFor(state, v), volatile: !!d.volatile });
    } else if (d.op === 'call') {
      out = expr.variable(`call_${d.id}`, v.bits || 64, signedFor(state, v), origin(d, v), { materializedCall: true });
    } else if (d.op === 'phi') {
      const incoming = (d.incoming || []).map((x) => buildValue(x.value, state));
      const unique = new Map(incoming.map((x) => [structuralKey(x), x]));
      out = unique.size === 1 ? incoming[0] : expr.variable(`local_phi_${v.id}`, v.bits || 64, signedFor(state, v), origin(d, v), { phi: true });
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
    const r = engine.rewrite(root, state);
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

function expressionFor(v, state) { return state.expressions?.get(v?.id) || buildValue(v, state); }

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
      const kind = inst.extra?.kind || inst.sub || '';
      let e = null;
      if (kind === 'cbz' || kind === 'cbnz') e = expr.compare(kind === 'cbz' ? 'eq' : 'ne', expressionFor(valueOf(inst.args?.[0]), state), expr.constant(0, valueOf(inst.args?.[0])?.bits || 64), null, origin(inst));
      else if (kind === 'tbz' || kind === 'tbnz') e = expr.compare(kind === 'tbz' ? 'eq' : 'ne', expr.binary('and', expr.binary('lshr', expressionFor(valueOf(inst.args?.[0]), state), expr.constant(inst.extra?.bit ?? 0, 64), valueOf(inst.args?.[0])?.bits || 64, false), expr.constant(1, 64), 64, false), expr.constant(0, 64), false, origin(inst));
      else e = compareFromFlags(valueOf(inst.args?.at?.(-1)), inst.cond || inst.extra?.cond, state);
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
    return { text, semantic: { op: 'store', location, expression: e, ir: store.id }, source: origin(store, store.dst) };
  }
  const ret = insts.find((i) => i.op === 'ret');
  if (ret && /^return\b/.test(String(line.text || ''))) {
    const rv = valueOf(ret.args?.[0]) || reachingRegisterValue(state.ir, ret, 'x0');
    if (rv) return { text: `return ${printExpression(expressionFor(rv, state))};`, semantic: { op: 'return', expression: expressionFor(rv, state), ir: ret.id }, source: origin(ret, rv) };
  }
  return null;
}

function cAstFromLines(result, state) {
  const body = [];
  for (const line of result.lines || []) {
    const known = knownStatementForLine(line, state);
    const source = known?.source || sourceOf({ address: line.addr, row: line.row, evidence: line.note ? [{ reason: line.note }] : [] });
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
