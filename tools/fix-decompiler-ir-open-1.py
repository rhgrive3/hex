from pathlib import Path
import re

def replace(path, old, new, count=1):
    p=Path(path); s=p.read_text()
    if old not in s: raise SystemExit(f'anchor missing: {path}: {old[:80]!r}')
    p.write_text(s.replace(old,new,count))

# #575: MNEG metadata lives under inst.extra after SSA emission.
replace('js/decompiler/pipeline-core.js', 'if (d.negate) out = expr.unary(\'neg\', out, d.dst?.bits || out.bits, signedFor(state, d.dst), origin(d, d.dst));', "if (d.extra?.negate) out = expr.unary('neg', out, d.dst?.bits || out.bits, signedFor(state, d.dst), origin(d, d.dst));")

# #139: never infer taken/fallthrough identity from successor array order.
replace('js/decompiler/pipeline-core.js', """function branchSucc(ir, block, term, state) {
  const succ = block?.succ || [];
  if (term?.op !== 'cbr' || succ.length < 2) return { yes: succ[0] ?? null, no: succ[1] ?? null };
  const yes = targetBlock(ir, term, state.opts?.rowOfAddress);
  if (yes == null || !succ.includes(yes)) return { yes: succ[0] ?? null, no: succ[1] ?? null };
  return { yes, no: succ.find((x) => x !== yes) ?? null };
}
""", """function branchSucc(ir, block, term, state) {
  const succ = block?.succ || [];
  if (term?.op !== 'cbr' || succ.length !== 2) return { yes: null, no: null };
  const yes = targetBlock(ir, term, state.opts?.rowOfAddress);
  if (yes == null || !succ.includes(yes)) return { yes: null, no: null };
  const no = succ.find((x) => x !== yes) ?? null;
  return no == null ? { yes: null, no: null } : { yes, no };
}
""")

# #140: require actual control-dependence proof; row order is never evidence.
p=Path('js/decompiler/pipeline-core.js'); s=p.read_text()
old="""function controllingBranchForMemoryPhi(phi, state) {
  const incoming = phi?.incoming || [];
  if (incoming.length !== 2) return null;
  const candidates = [];
  for (const block of state.ir.blocks || []) {
    const term = blockTerm(block);
    if (term?.op !== 'cbr' || block.succ.length < 2) continue;
    const { yes, no } = branchSucc(state.ir, block, term, state);
    const yesIndex = incoming.findIndex((x) => canReach(state.ir, yes, x.from, phi.block));
    const noIndex = incoming.findIndex((x) => canReach(state.ir, no, x.from, phi.block));
    if (yesIndex >= 0 && noIndex >= 0 && yesIndex !== noIndex) candidates.push({ term, yesIndex, noIndex, row: term.row ?? -1 });
  }
  candidates.sort((a, b) => b.row - a.row);
  return candidates[0] || null;
}
"""
new="""function postDominators(ir) {
  const blocks = ir?.blocks || [];
  const all = new Set(blocks.map((b) => b.index));
  const sets = blocks.map((b) => (b.succ || []).length ? new Set(all) : new Set([b.index]));
  let changed = true, rounds = blocks.length + 2;
  while (changed && rounds-- > 0) {
    changed = false;
    for (const b of blocks) {
      const succ = b.succ || [];
      if (!succ.length) continue;
      let next = new Set(sets[succ[0]] || []);
      for (const si of succ.slice(1)) next = new Set([...next].filter((x) => sets[si]?.has(x)));
      next.add(b.index);
      const cur = sets[b.index] || new Set();
      if (cur.size !== next.size || [...cur].some((x) => !next.has(x))) { sets[b.index] = next; changed = true; }
    }
  }
  return sets;
}

function controllingBranchForMemoryPhi(phi, state) {
  const incoming = phi?.incoming || [];
  if (incoming.length !== 2 || phi?.block == null) return null;
  const pdom = postDominators(state.ir);
  const candidates = [];
  for (const block of state.ir.blocks || []) {
    const term = blockTerm(block);
    if (term?.op !== 'cbr' || block.succ.length !== 2) continue;
    const { yes, no } = branchSucc(state.ir, block, term, state);
    if (yes == null || no == null) continue;
    const phiDom = state.ir.dominators?.[phi.block];
    if (phiDom && !phiDom.has(block.index)) continue;
    if (!pdom[yes]?.has(phi.block) || !pdom[no]?.has(phi.block)) continue;
    const yr = incoming.map((x) => canReach(state.ir, yes, x.from, phi.block));
    const nr = incoming.map((x) => canReach(state.ir, no, x.from, phi.block));
    const yesIndex = yr.findIndex(Boolean), noIndex = nr.findIndex(Boolean);
    if (yesIndex < 0 || noIndex < 0 || yesIndex === noIndex) continue;
    if (yr.filter(Boolean).length !== 1 || nr.filter(Boolean).length !== 1) continue;
    if (yr[noIndex] || nr[yesIndex]) continue;
    candidates.push({ term, yesIndex, noIndex, block:block.index });
  }
  return candidates.length === 1 ? candidates[0] : null;
}
"""
if old not in s: raise SystemExit('controlling branch anchor missing')
p.write_text(s.replace(old,new,1))

# #317: address displacement and writeback displacement are distinct.
p=Path('js/ir-core.js'); s=p.read_text()
old="""    const addr = {
      base: mem ? regKeyOf(mem.base) : null,
      disp: mem && mem.disp && mem.disp.value != null ? mem.disp.value : null,
      index: mem && mem.index ? regKeyOf(mem.index) : null,"""
new="""    const addressDispOp = mem ? (mem.addressDisp ?? mem.disp ?? null) : null;
    const writebackDispOp = mem ? (mem.writebackDisp ?? (mem.mode === 'pre' ? addressDispOp : null)) : null;
    const addr = {
      base: mem ? regKeyOf(mem.base) : null,
      disp: addressDispOp && addressDispOp.value != null ? addressDispOp.value : (mem?.mode === 'post' ? 0n : null),
      index: mem && mem.index ? regKeyOf(mem.index) : null,"""
if old not in s: raise SystemExit('memory address anchor missing')
s=s.replace(old,new,1)
old2="""    if (mem && (mem.mode === 'pre' || mem.mode === 'post') && addr.base && addr.disp != null) {
      push({ op: OP.BIN, sub: 'add', dstReg: addr.base, dstBits: 64,
        srcs: [{ t: 'reg', reg: addr.base, bits: 64 }, { t: 'imm', value: addr.disp }] });
    }"""
new2="""    const writebackDisp = writebackDispOp && writebackDispOp.value != null ? writebackDispOp.value : null;
    if (mem && (mem.mode === 'pre' || mem.mode === 'post') && addr.base && writebackDisp != null) {
      push({ op: OP.BIN, sub: 'add', dstReg: addr.base, dstBits: 64,
        srcs: [{ t: 'reg', reg: addr.base, bits: 64 }, { t: 'imm', value: writebackDisp }] });
    }"""
if old2 not in s: raise SystemExit('writeback anchor missing')
s=s.replace(old2,new2,1)
p.write_text(s)

# #573: opts-sensitive IR must not share a model-only cache entry.
p=Path('js/ir-core.js'); s=p.read_text()
old="""const irCache = new WeakMap();

/**
 * モデルから IR を得る（作れなければ null）。落ちない。
 * ここが panels.js / role.js / pinpoint.js から呼ぶ唯一の入口。
 */
export function irFor(model, opts) {
  if (!model || !model.instructions || !model.instructions.length) return null;
  if (irCache.has(model)) return irCache.get(model);
  let ir = null;
  try { ir = buildIR(model, opts); } catch { ir = null; }
  irCache.set(model, ir);
  return ir;
}"""
new="""const irCache = new WeakMap();
const irCacheIds = new WeakMap();
let nextIrCacheId = 1;
function irIdentity(value) {
  if (value == null) return '-';
  if ((typeof value !== 'object' && typeof value !== 'function')) return `${typeof value}:${String(value)}`;
  if (!irCacheIds.has(value)) irCacheIds.set(value, nextIrCacheId++);
  return `@${irCacheIds.get(value)}`;
}
function prototypeSignature(proto) {
  if (!proto) return '-';
  const args = Array.isArray(proto.args || proto.parameters || proto.params) ? (proto.args || proto.parameters || proto.params) : [];
  return [irIdentity(proto), proto.returnType || proto.resultType || '', proto.returnClass || '', proto.returnsValue ?? '',
    ...args.map((a) => `${a?.type || ''}:${a?.abiClass || a?.class || ''}:${a?.bits || ''}`)].join('|');
}
function irConfigurationKey(opts) {
  if (!opts) return 'default';
  return [
    prototypeSignature(opts.functionPrototype || opts.prototype),
    opts.returnType || '', opts.returnClass || '', opts.returnsValue ?? '', opts.returnBits || '',
    irIdentity(opts.callPrototypeFor), irIdentity(opts.cfg), irIdentity(opts.rowOfAddress),
    opts.prototypeRevision ?? '', opts.evidenceGeneration ?? '', opts.analysisGeneration ?? '', opts.cacheRevision ?? '',
  ].join('~');
}

/**
 * モデルから IR を得る（作れなければ null）。落ちない。
 * semantic-affecting opts are part of cache identity; failed builds are not sticky.
 */
export function irFor(model, opts) {
  if (!model || !model.instructions || !model.instructions.length) return null;
  let entries = irCache.get(model);
  if (!entries) { entries = new Map(); irCache.set(model, entries); }
  const key = irConfigurationKey(opts);
  if (entries.has(key)) return entries.get(key);
  let ir = null;
  try { ir = buildIR(model, opts); } catch { ir = null; }
  if (ir != null) entries.set(key, ir);
  return ir;
}"""
if old not in s: raise SystemExit('ir cache anchor missing')
p.write_text(s.replace(old,new,1))

# #347: make the already-correct wide C formatter canonical for Semantic output too.
replace('js/decompiler/pretty/c.js', 'function integerText(v, bits = 64, signed = null) {', 'export function integerText(v, bits = 64, signed = null) {')
p=Path('js/decompiler/semantic.js'); s=p.read_text()
anchor="import { renderIndexedMemory } from './address-semantics.js';"
if anchor not in s: raise SystemExit('semantic import anchor missing')
s=s.replace(anchor, anchor+"\nimport { integerText } from './pretty/c.js';",1)
old="""function formatConst(v, bits = 64) {
  if (v == null) return 'unknown';
  const n = BigInt(v);
  const signed = BigInt.asIntN(Math.min(64, Number(bits) || 64), n);
  if (signed >= -9n && signed <= 99n) return signed.toString();
  if (n <= 0xffffn) return '0x' + n.toString(16).toUpperCase();
  return signed < 0n ? signed.toString() : '0x' + n.toString(16).toUpperCase();
}"""
new="""function formatConst(v, bits = 64, signed = null) {
  if (v == null) return 'unknown';
  return integerText(v, bits, signed);
}"""
if old not in s: raise SystemExit('formatConst anchor missing')
s=s.replace(old,new,1)
s=s.replace("formatConst(value.const ?? d.extra?.value ?? 0n, value.bits);", "formatConst(value.const ?? d.extra?.value ?? 0n, value.bits, value.signed ?? null);",1)

# #130: only explicit IR RET operands or trusted return type choose a return register.
old="""function returnValueAt(ret, ctx) {
  const explicit=valueOf(ret?.args?.[0]);
  if (explicit) return explicit;
  const reg=returnRegisterForContext(ctx);
  if (reg) return reachingRegisterValue(ctx.ir, ret, reg);
  const candidate=reachingRegisterValue(ctx.ir, ret, 'x0');
  return candidate?.def && candidate.def.block === ret?.block ? candidate : null;
}"""
new="""function returnValueAt(ret, ctx) {
  const explicit=valueOf(ret?.args?.[0]);
  if (explicit) return explicit;
  const reg=returnRegisterForContext(ctx);
  return reg ? reachingRegisterValue(ctx.ir, ret, reg) : null;
}"""
if old not in s: raise SystemExit('returnValueAt anchor missing')
s=s.replace(old,new,1)
old="""    if (term.op === OP.RET) {
      const rv = reachingRegisterValue(ctx.ir, term, 'x0') || valueOf(term.args?.[0]);
      out.push(line('stmt', indent + 1, rv ? `return ${renderValue(rv, ctx)};` : 'return;', term.row, term.address, { source: mergeSource(dependencySource(rv, ctx), sourceForInst(term, 'return')) }));"""
new="""    if (term.op === OP.RET) {
      const rv = returnValueAt(term, ctx);
      out.push(line('stmt', indent + 1, rv ? `return ${renderValue(rv, ctx)};` : 'return;', term.row, term.address, { source: mergeSource(dependencySource(rv, ctx), sourceForInst(term, 'return')) }));"""
if old not in s: raise SystemExit('faithful return anchor missing')
s=s.replace(old,new,1)

# #353/#417/#418: preserve widening and bitfield identity in the Semantic renderer.
old="""    else if (d.op === OP.MAC) {
      const a = renderValue(valueOf(d.args?.[0]), ctx), b = renderValue(valueOf(d.args?.[1]), ctx), c = renderValue(valueOf(d.args?.[2]), ctx);
      out = d.sub === 'msub' ? `${paren(a)} - ${paren(b)} * ${paren(c)}` : `${paren(a)} + ${paren(b)} * ${paren(c)}`;
    } else if (d.op === OP.BFX) {
      const a = renderValue(valueOf(d.args?.[0]), ctx); out = `bit_extract(${a}, ${d.extra?.lsb ?? 0}, ${d.extra?.width ?? '?'})`;
    } else if (d.op === OP.BFI) {
      const a = renderValue(valueOf(d.args?.[0]), ctx), b = renderValue(valueOf(d.args?.[1]), ctx); out = `bit_insert(${a}, ${b}, ${d.extra?.lsb ?? 0}, ${d.extra?.width ?? '?'})`;
"""
new="""    else if (d.op === OP.MAC) {
      const a = renderValue(valueOf(d.args?.[0]), ctx), b0 = renderValue(valueOf(d.args?.[1]), ctx), c0 = renderValue(valueOf(d.args?.[2]), ctx);
      const widen=d.extra?.widen;
      const b=widen==='signed'?`(int64_t)(int32_t)${paren(b0)}`:widen==='unsigned'?`(uint64_t)(uint32_t)${paren(b0)}`:b0;
      const c=widen==='signed'?`(int64_t)(int32_t)${paren(c0)}`:widen==='unsigned'?`(uint64_t)(uint32_t)${paren(c0)}`:c0;
      out = d.sub === 'msub' ? `${paren(a)} - ${paren(b)} * ${paren(c)}` : `${paren(a)} + ${paren(b)} * ${paren(c)}`;
    } else if (d.op === OP.BFX) {
      const a = renderValue(valueOf(d.args?.[0]), ctx), l=d.extra?.lsb ?? 0, w=d.extra?.width ?? '?';
      if (d.extra?.toward === 'left') out = `${d.extra?.signed?'__arm64_sbfiz':'__arm64_ubfiz'}(${a}, ${l}, ${w})`;
      else out = `${d.extra?.signed?'__arm64_sbfx':'bit_extract'}(${a}, ${l}, ${w})`;
    } else if (d.op === OP.BFI) {
      const a = renderValue(valueOf(d.args?.[0]), ctx), b = renderValue(valueOf(d.args?.[1]), ctx), l=d.extra?.lsb ?? 0, w=d.extra?.width ?? '?';
      out = d.extra?.bitfieldKind === 'bfxil' ? `bit_insert(${a}, bit_extract(${b}, ${l}, ${w}), 0, ${w})` : `bit_insert(${a}, ${b}, ${l}, ${w})`;
"""
if old not in s: raise SystemExit('semantic MAC/bitfield anchor missing')
s=s.replace(old,new,1)

# #401: min/max fold is valid only for canonical subtraction compare, never CMN/TST/etc.
old="""  const cmp = cmpFromFlags(flags);
  if (!cmp || cmp.args.length < 2) return null;
  const a = valueOf(cmp.args[0]), b = valueOf(cmp.args[1]);"""
new="""  const cmp = cmpFromFlags(flags);
  if (!cmp || cmp.args.length < 2 || cmp.sub !== 'sub' || cmp.extra?.conditional) return null;
  const a = valueOf(cmp.args[0]), b = valueOf(cmp.args[1]);"""
# only first occurrence after selectAsMinMax; use split around function
idx=s.find('function selectAsMinMax')
if idx<0: raise SystemExit('selectAsMinMax missing')
pre,tail=s[:idx],s[idx:]
if old not in tail: raise SystemExit('select minmax cmp anchor missing')
tail=tail.replace(old,new,1); s=pre+tail
p.write_text(s)

# #401 loop repair: canonical NZCV renderer is the sole condition source.
p=Path('js/decompiler/loop-repair.js'); s=p.read_text()
if "import { COND, inverseCondition, OP } from '../ir.js';" not in s: raise SystemExit('loop import anchor missing')
s=s.replace("import { COND, inverseCondition, OP } from '../ir.js';", "import { COND, inverseCondition, OP } from '../ir.js';\nimport { renderNZCVCondition } from './flag-semantics.js';",1)
old="""  const info = COND[cond];
  if (!info) return null;

  const flags = valueOf(term.args?.[term.args.length - 1]);
  const cmp = flags?.def;
  if (!cmp || cmp.op !== OP.CMP || cmp.args.length < 2) return null;"""
new="""  if (!COND[cond]) return null;

  const flags = valueOf(term.args?.[term.args.length - 1]);
  const cmp = flags?.def;
  if (!cmp || cmp.op !== OP.CMP || cmp.args.length < 2) return null;"""
if old not in s: raise SystemExit('loop condition anchor1 missing')
s=s.replace(old,new,1)
old="""  const a = render(valueOf(cmp.args[0]));
  const b = render(valueOf(cmp.args[1]));
  if (!a || (!info.vsZero && !b)) return null;
  return info.vsZero ? `${a} ${info.op} 0` : `${a} ${info.op} ${b}`;"""
new="""  const a = render(valueOf(cmp.args[0]));
  const b = render(valueOf(cmp.args[1]));
  if (!a || !b) return null;
  return renderNZCVCondition(cmp.sub || 'sub', cond, a, b, Number(cmp.bits || valueOf(cmp.args[0])?.bits || 64));"""
if old not in s: raise SystemExit('loop condition anchor2 missing')
p.write_text(s.replace(old,new,1))

print('patched decompiler/IR open issues batch 1')
