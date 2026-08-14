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
  variable(name, bits = 64, signed = null, source = null, extra = {}) { return node('var', { name, bits: Number(bits || 64), signed, effect: 'pure', ...extra }, source); },
  unary(op, arg, bits = arg?.bits || 64, signed = arg?.signed ?? null, source = null, extra = {}) { return node('unary', { op, arg, bits, signed, effect: effectOf(arg), ...extra }, mergeSource(source, arg?.source)); },
  binary(op, left, right, bits = left?.bits || right?.bits || 64, signed = null, source = null, extra = {}) { return node('binary', { op, left, right, bits, signed, effect: maxEffect(effectOf(left), effectOf(right)), ...extra }, mergeSource(source, left?.source, right?.source)); },
  compare(op, left, right, signed = null, source = null) { return node('compare', { op, left, right, bits: 1, signed: false, compareSigned: signed, effect: maxEffect(effectOf(left), effectOf(right)) }, mergeSource(source, left?.source, right?.source)); },
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
export function nodeCount(n, seen = new Set()) { if (!n || seen.has(n)) return 0; seen.add(n); return 1 + children(n).reduce((sum, c) => sum + nodeCount(c, seen), 0); }
function scalar(v) { return typeof v === 'bigint' ? `${v}n` : JSON.stringify(v); }
export function structuralKey(n) {
  if (!n) return 'null';
  switch (n.kind) {
    case 'const': return `c:${n.bits}:${n.signed}:${n.value}`;
    case 'var': return `v:${n.name}:${n.bits}:${n.signed}`;
    case 'unary': return `u:${n.op}:${n.bits}:${structuralKey(n.arg)}`;
    case 'binary': return `b:${n.op}:${n.bits}:${n.signed}:${structuralKey(n.left)}:${structuralKey(n.right)}`;
    case 'compare': return `cmp:${n.op}:${n.compareSigned}:${structuralKey(n.left)}:${structuralKey(n.right)}`;
    case 'select': return `sel:${structuralKey(n.condition)}:${structuralKey(n.whenTrue)}:${structuralKey(n.whenFalse)}`;
    case 'field': return `field:${structuralKey(n.base)}:${n.name}:${n.offset}`;
    case 'index': return `idx:${structuralKey(n.base)}:${structuralKey(n.index)}:${n.scale}`;
    case 'load': return `load:${scalar(n.location?.key || n.location?.name || n.location)}:${n.bits}`;
    case 'call': return `call:${n.callee}:${(n.args || []).map(structuralKey).join(',')}`;
    case 'intrinsic': return `intr:${n.name}:${(n.args || []).map(structuralKey).join(',')}`;
    default: return `${n.kind}:${scalar(n.name || '')}`;
  }
}
export function sameExpr(a, b) { return structuralKey(a) === structuralKey(b); }
