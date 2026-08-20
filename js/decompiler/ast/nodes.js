/* Typed decompiler AST. Nodes retain proof/evidence and source-origin metadata. */
function freezeArray(v) { return Array.isArray(v) ? v.slice() : []; }
export function sourceOf(source = null) {
  if (!source) return { addresses: [], rows: [], ir: [], ssaDefs: [], ssaUses: [], evidence: [] };
  const one = (v) => v == null ? [] : Array.isArray(v) ? v.slice() : [v];
  return { addresses: one(source.addresses ?? source.address), rows: one(source.rows ?? source.row), ir: one(source.ir ?? source.irId), ssaDefs: one(source.ssaDefs ?? source.ssaDef), ssaUses: one(source.ssaUses ?? source.ssaUse), evidence: freezeArray(source.evidence) };
}
export function mergeSource(...sources) {
  const out = sourceOf();
  for (const s of sources) {
    const x = sourceOf(s);
    for (const k of ['addresses', 'rows', 'ir', 'ssaDefs', 'ssaUses']) for (const v of x[k]) if (!out[k].some((z) => String(z) === String(v))) out[k].push(v);
    out.evidence.push(...x.evidence);
  }
  return out;
}
export function node(kind, props = {}, source = null) { return { kind, ...props, source: sourceOf(source || props.source) }; }
export const expr = {
  constant(value, bits = 64, signed = null, source = null) { return node('const', { value: BigInt(value), bits: Number(bits || 64), signed, effect: 'pure' }, source); },
  floatConstant(value, bits = 64, source = null) { return node('float-const', { value:Number(value), bits:Number(bits || 64), signed:null, floating:true, effect:'pure' }, source); },
  variable(name, bits = 64, signed = null, source = null, extra = {}) { return node('var', { name, bits: Number(bits || 64), signed, effect: 'pure', ...extra }, source); },
  unary(op, arg, bits = arg?.bits || 64, signed = arg?.signed ?? null, source = null, extra = {}) { return node('unary', { op, arg, bits, signed, effect: effectOf(arg), ...extra }, mergeSource(source, arg?.source)); },
  binary(op, left, right, bits = left?.bits || right?.bits || 64, signed = null, source = null, extra = {}) { return node('binary', { op, left, right, bits, signed, effect: maxEffect(effectOf(left), effectOf(right)), ...extra }, mergeSource(source, left?.source, right?.source)); },
  compare(op, left, right, signed = null, source = null, extra = {}) {
    const comparisonDomain = extra.comparisonDomain ?? ((left?.floating === true || right?.floating === true || left?.kind === 'float-const' || right?.kind === 'float-const') ? 'floating' : 'integer');
    return node('compare', { op, left, right, bits: 1, signed: false, compareSigned: signed, comparisonDomain, effect: maxEffect(effectOf(left), effectOf(right)), ...extra }, mergeSource(source, left?.source, right?.source));
  },
  select(condition, whenTrue, whenFalse, bits = whenTrue?.bits || whenFalse?.bits || 64, signed = null, source = null) { return node('select', { condition, whenTrue, whenFalse, bits, signed, effect: maxEffect(effectOf(condition), effectOf(whenTrue), effectOf(whenFalse)) }, mergeSource(source, condition?.source, whenTrue?.source, whenFalse?.source)); },
  call(callee, args = [], bits = 64, source = null, extra = {}) { return node('call', { callee, args: args.slice(), bits, signed: null, effect: 'call', ...extra }, mergeSource(source, ...args.map((a) => a?.source))); },
  load(location, bits = 64, source = null, extra = {}) { return node('load', { location, bits, signed: extra.signed ?? null, effect: extra.volatile ? 'volatile' : 'read', ...extra }, source); },
  field(base, name, offset = 0n, bits = 64, source = null, extra = {}) { return node('field', { base, name, offset: BigInt(offset || 0), bits, signed: extra.signed ?? null, effect: effectOf(base), ...extra }, mergeSource(source, base?.source)); },
  index(base, index, scale = 1, bits = 64, source = null, extra = {}) { return node('index', { base, index, scale, bits, signed: extra.signed ?? null, effect: maxEffect(effectOf(base), effectOf(index)), ...extra }, mergeSource(source, base?.source, index?.source)); },
  intrinsic(name, args = [], bits = 64, signed = null, source = null, extra = {}) { return node('intrinsic', { name, args: args.slice(), bits, signed, effect: maxEffect(...args.map(effectOf)), ...extra }, mergeSource(source, ...args.map((a) => a?.source))); },
};
const EFFECT_RANK = { pure: 0, read: 1, call: 2, write: 3, volatile: 4, unknown: 5 };
export function maxEffect(...effects) { let best = 'pure'; for (const effect of effects.flat()) if ((EFFECT_RANK[effect] ?? 5) > (EFFECT_RANK[best] ?? 0)) best = effect || 'unknown'; return best; }
export function effectOf(n) { return n?.effect || 'pure'; }
export function isPure(n) { return effectOf(n) === 'pure'; }
export function mayDuplicate(n) { return isPure(n); }
export function mayReorder(a, b) { return isPure(a) && isPure(b); }
export function children(n) {
  if (!n) return [];
  if (n.kind === 'unary') return [n.arg];
  if (n.kind === 'binary' || n.kind === 'compare') return [n.left, n.right];
  if (n.kind === 'select') return [n.condition, n.whenTrue, n.whenFalse];
  if (n.kind === 'call' || n.kind === 'intrinsic') return n.args || [];
  if (n.kind === 'field') return [n.base];
  if (n.kind === 'index') return [n.base, n.index];
  return [];
}
export function mapChildren(n, fn) {
  if (!n) return n;
  if (n.kind === 'unary') return { ...n, arg: fn(n.arg) };
  if (n.kind === 'binary' || n.kind === 'compare') return { ...n, left: fn(n.left), right: fn(n.right) };
  if (n.kind === 'select') return { ...n, condition: fn(n.condition), whenTrue: fn(n.whenTrue), whenFalse: fn(n.whenFalse) };
  if (n.kind === 'call' || n.kind === 'intrinsic') return { ...n, args: (n.args || []).map(fn) };
  if (n.kind === 'field') return { ...n, base: fn(n.base) };
  if (n.kind === 'index') return { ...n, base: fn(n.base), index: fn(n.index) };
  return n;
}

// Iterative and limit-aware: the budget check itself must never overflow the JS stack.
export function nodeCount(n, seen = new Set(), limit = Infinity) {
  if (!n) return 0;
  if (typeof seen === 'number') { limit = seen; seen = new Set(); }
  const stack = [n];
  let total = 0;
  while (stack.length) {
    const cur = stack.pop();
    if (!cur || seen.has(cur)) continue;
    seen.add(cur);
    total++;
    if (total > limit) return total;
    const kids = children(cur);
    for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i]);
  }
  return total;
}
function scalar(v) { return typeof v === 'bigint' ? `${v}n` : JSON.stringify(v); }
function semanticTag(n) {
  return `${n.bits ?? ''}:${n.signed ?? ''}:${n.volatile === true}:${n.extension ?? n.extend ?? ''}:${n.returnType ?? n.type ?? ''}:${n.returnClass ?? n.abiReturnClass ?? ''}`;
}

// A memory location is not a value identity. Two reads of the same address can
// observe different values after a clobber. Prefer an explicit MemorySSA identity
// when a caller provides one; the production decompiler already carries the SSA
// result-def identity in source metadata, which is the authoritative fallback.
const anonymousLoadIds = new WeakMap();
let nextAnonymousLoadId = 1;
function loadValueIdentity(n) {
  if (n?.memoryVersion != null) return `mem:${scalar(n.memoryVersion)}`;
  if (n?.loadIdentity != null) return `load:${scalar(n.loadIdentity)}`;
  const source = sourceOf(n?.source);
  if (source.ssaDefs.length) return `ssa:${source.ssaDefs.map(String).sort().join(',')}`;
  if (source.ir.length) return `ir:${source.ir.map(String).sort().join(',')}`;
  if (source.rows.length) return `row:${source.rows.map(String).sort().join(',')}`;
  let id = anonymousLoadIds.get(n);
  if (id == null) { id = nextAnonymousLoadId++; anonymousLoadIds.set(n, id); }
  return `anon:${id}`;
}

// Post-order canonicalization without recursion. This handles deeply skewed ASTs safely.
export function structuralKey(root) {
  if (!root) return 'null';
  const keys = new Map();
  const active = new Set();
  const stack = [{ n: root, exit: false }];
  while (stack.length) {
    const frame = stack.pop();
    const n = frame.n;
    if (!n || keys.has(n)) continue;
    if (!frame.exit) {
      if (active.has(n)) { keys.set(n, `cycle:${n.kind}`); continue; }
      active.add(n);
      stack.push({ n, exit: true });
      const kids = children(n);
      for (let i = kids.length - 1; i >= 0; i--) if (kids[i] && !keys.has(kids[i])) stack.push({ n: kids[i], exit: false });
      continue;
    }
    const k = (x) => x ? (keys.get(x) || `cycle:${x.kind}`) : 'null';
    let value;
    switch (n.kind) {
      case 'const': value = `c:${semanticTag(n)}:${n.value}`; break;
      case 'float-const': { const fv=Number.isNaN(n.value)?'NaN':n.value===Infinity?'Infinity':n.value===-Infinity?'-Infinity':Object.is(n.value,-0)?'-0':String(n.value); value=`fc:${semanticTag(n)}:${fv}`; break; }
      case 'var': value = `v:${n.name}:${semanticTag(n)}`; break;
      case 'unary': value = `u:${n.op}:${semanticTag(n)}:${k(n.arg)}`; break;
      case 'binary': value = `b:${n.op}:${semanticTag(n)}:${k(n.left)}:${k(n.right)}`; break;
      case 'compare': value = `cmp:${n.op}:${n.compareSigned}:${n.comparisonDomain ?? 'unknown'}:${k(n.left)}:${k(n.right)}`; break;
      case 'select': value = `sel:${semanticTag(n)}:${k(n.condition)}:${k(n.whenTrue)}:${k(n.whenFalse)}`; break;
      case 'field': value = `field:${k(n.base)}:${n.name}:${n.offset}:${semanticTag(n)}`; break;
      case 'index': value = `idx:${k(n.base)}:${k(n.index)}:${n.scale}:${semanticTag(n)}`; break;
      case 'load': value = `load:${scalar(n.location?.key || n.location?.name || n.location)}:${semanticTag(n)}:${loadValueIdentity(n)}`; break;
      case 'call': value = `call:${n.callee}:${semanticTag(n)}:${(n.args || []).map(k).join(',')}`; break;
      case 'intrinsic': value = `intr:${n.name}:${semanticTag(n)}:${(n.args || []).map(k).join(',')}`; break;
      default: value = `${n.kind}:${scalar(n.name || '')}:${semanticTag(n)}`; break;
    }
    keys.set(n, value);
    active.delete(n);
  }
  return keys.get(root) || 'unknown';
}
export function sameExpr(a, b) { return structuralKey(a) === structuralKey(b); }
