import { expr, effectOf, isPure, mayDuplicate, mayReorder, sameExpr, nodeCount } from '../ast/nodes.js';
import { evalBinary, evalUnary, fullMask, isPowerOfTwo, log2Exact, u } from '../truth/integer.js';
import { normalizeIntegerValue, normalizeRangeDomain } from '../../range-domain.js';

const isStable = (n) => ['pure', 'read'].includes(effectOf(n));
const isConst = (n, v = null) => n?.kind === 'const' && (v == null || n.value === BigInt(v));
const c = (v, like, bits = like?.bits || 64) => expr.constant(v, bits, like?.signed ?? null, like?.source);
const cost = (n) => nodeCount(n);
const proof = (kind, detail) => () => ({ kind, detail });

function binRule(name, phase, op, match, rewrite, precondition = null, extra = {}) {
  return { name, phase, match: (n, ctx) => n?.kind === 'binary' && n.op === op ? match(n, ctx) : null,
    precondition, rewrite, proof: proof('integer-algebra', name), cost, ...extra };
}

const identityRules = [
  binRule('add-zero-right', 'canonical', 'add', (n) => isConst(n.right, 0) ? {} : null, (n) => n.left),
  binRule('add-zero-left', 'canonical', 'add', (n) => isConst(n.left, 0) ? {} : null, (n) => n.right),
  binRule('sub-zero', 'canonical', 'sub', (n) => isConst(n.right, 0) ? {} : null, (n) => n.left),
  binRule('mul-one-right', 'canonical', 'mul', (n) => isConst(n.right, 1) ? {} : null, (n) => n.left),
  binRule('mul-one-left', 'canonical', 'mul', (n) => isConst(n.left, 1) ? {} : null, (n) => n.right),
  binRule('mul-zero-right', 'canonical', 'mul', (n) => isConst(n.right, 0) && isPure(n.left) ? {} : null, (n) => c(0, n)),
  binRule('mul-zero-left', 'canonical', 'mul', (n) => isConst(n.left, 0) && isPure(n.right) ? {} : null, (n) => c(0, n)),
  binRule('and-zero-right', 'canonical', 'and', (n) => isConst(n.right, 0) && isPure(n.left) ? {} : null, (n) => c(0, n)),
  binRule('and-zero-left', 'canonical', 'and', (n) => isConst(n.left, 0) && isPure(n.right) ? {} : null, (n) => c(0, n)),
  binRule('or-zero-right', 'canonical', 'or', (n) => isConst(n.right, 0) ? {} : null, (n) => n.left),
  binRule('or-zero-left', 'canonical', 'or', (n) => isConst(n.left, 0) ? {} : null, (n) => n.right),
  binRule('xor-zero-right', 'canonical', 'xor', (n) => isConst(n.right, 0) ? {} : null, (n) => n.left),
  binRule('xor-zero-left', 'canonical', 'xor', (n) => isConst(n.left, 0) ? {} : null, (n) => n.right),
  binRule('xor-self', 'canonical', 'xor', (n) => sameExpr(n.left, n.right) && isPure(n.left) ? {} : null, (n) => c(0, n)),
  binRule('sub-self', 'canonical', 'sub', (n) => sameExpr(n.left, n.right) && isPure(n.left) ? {} : null, (n) => c(0, n)),
  binRule('and-full-mask', 'canonical', 'and', (n) => isConst(n.right) && n.right.value === fullMask(n.bits) ? {} : null, (n) => n.left),
  binRule('shift-zero-shl', 'canonical', 'shl', (n) => isConst(n.right, 0) ? {} : null, (n) => n.left),
  binRule('shift-zero-lshr', 'canonical', 'lshr', (n) => isConst(n.right, 0) ? {} : null, (n) => n.left),
  binRule('shift-zero-ashr', 'canonical', 'ashr', (n) => isConst(n.right, 0) ? {} : null, (n) => n.left),
  binRule('and-self', 'canonical', 'and', (n) => sameExpr(n.left, n.right) && isStable(n.left) ? {} : null, (n) => n.left),
  binRule('or-self', 'canonical', 'or', (n) => sameExpr(n.left, n.right) && isStable(n.left) ? {} : null, (n) => n.left),
  binRule('udiv-one', 'canonical', 'udiv', (n) => isConst(n.right, 1) ? {} : null, (n) => n.left),
  binRule('sdiv-one', 'canonical', 'sdiv', (n) => isConst(n.right, 1) ? {} : null, (n) => n.left),
  binRule('umod-one', 'canonical', 'umod', (n) => isConst(n.right, 1) && isPure(n.left) ? {} : null, (n) => c(0, n)),
  binRule('smod-one', 'canonical', 'smod', (n) => isConst(n.right, 1) && isPure(n.left) ? {} : null, (n) => c(0, n)),
  {
    name: 'neg-zero', phase: 'canonical', match: (n) => n?.kind === 'unary' && n.op === 'neg' && isConst(n.arg, 0) ? {} : null,
    rewrite: (n) => c(0, n), proof: proof('integer-algebra', '-0 == 0'), cost,
  },
  {
    name: 'not-zero', phase: 'canonical', match: (n) => n?.kind === 'unary' && n.op === 'not' && isConst(n.arg, 0) ? {} : null,
    rewrite: (n) => c(fullMask(n.bits), n), proof: proof('bitvector-identity', '~0 == full mask'), cost,
  },
];

const constFoldOps = new Set(['add','sub','mul','and','or','xor','shl','lshr','ashr','ror','sdiv','udiv','smod','umod']);
const constantRules = [{
  name: 'constant-fold-binary', phase: 'fold',
  match: (n) => n?.kind === 'binary' && constFoldOps.has(n.op) && isConst(n.left) && isConst(n.right) ? {} : null,
  precondition: () => true,
  rewrite: (n) => { const v = evalBinary(n.op, n.left.value, n.right.value, n.bits, n.signed); return v == null ? null : c(v, n); },
  proof: (before, after) => ({ kind: 'width-exact-evaluation', bits: before.bits, result: after.value.toString() }),
  cost,
}, {
  name: 'constant-fold-unary', phase: 'fold',
  match: (n) => n?.kind === 'unary' && isConst(n.arg) ? {} : null,
  precondition: () => true,
  rewrite: (n) => { const v = evalUnary(n.op, n.arg.value, n.bits, n.arg.bits); return v == null ? null : c(v, n); },
  proof: (before, after) => ({ kind: 'width-exact-evaluation', bits: before.bits, result: after.value.toString() }),
  cost,
}];

function nestedConst(op, n) {
  if (n?.kind !== 'binary' || n.op !== op || !isConst(n.right)) return null;
  const x = n.left;
  if (x?.kind !== 'binary' || x.op !== op || !isConst(x.right)) return null;
  return { inner: x, a: x.right.value, b: n.right.value };
}

const associativeRules = [
  binRule('collect-add-constants', 'algebra', 'add', (n) => nestedConst('add', n), (n, m) =>
    expr.binary('add', m.inner.left, c(u(m.a + m.b, n.bits), n), n.bits, n.signed, n.source),
    (n, m) => mayReorder(m.inner.left, n.right)),
  binRule('collect-mul-constants', 'algebra', 'mul', (n) => nestedConst('mul', n), (n, m) =>
    expr.binary('mul', m.inner.left, c(u(m.a * m.b, n.bits), n), n.bits, n.signed, n.source),
    (n, m) => mayReorder(m.inner.left, n.right)),
  binRule('double-term', 'algebra', 'add', (n) => sameExpr(n.left, n.right) && mayDuplicate(n.left) ? {} : null,
    (n) => expr.binary('mul', n.left, c(2, n), n.bits, n.signed, n.source)),
  binRule('strength-mul-power-two', 'idiom', 'mul', (n) => isConst(n.right) && isPowerOfTwo(n.right.value) ? { sh: log2Exact(n.right.value) } : null,
    (n, m) => expr.binary('shl', n.left, c(m.sh, n), n.bits, n.signed, n.source),
    (n) => isPure(n.left)),
];

const arithmeticRules = [
  binRule('collect-add-sub-constants', 'algebra', 'sub', (n) => n.left?.kind === 'binary' && n.left.op === 'add' && isConst(n.left.right) && isConst(n.right) ? { inner:n.left } : null,
    (n,m) => expr.binary('add', m.inner.left, c(u(m.inner.right.value - n.right.value, n.bits), n), n.bits, n.signed, n.source),
    (n,m) => isStable(m.inner.left)),
  binRule('collect-sub-add-constants', 'algebra', 'add', (n) => n.left?.kind === 'binary' && n.left.op === 'sub' && isConst(n.left.right) && isConst(n.right) ? { inner:n.left } : null,
    (n,m) => expr.binary('add', m.inner.left, c(u(n.right.value - m.inner.right.value, n.bits), n), n.bits, n.signed, n.source),
    (n,m) => isStable(m.inner.left)),
  binRule('collect-sub-sub-constants', 'algebra', 'sub', (n) => n.left?.kind === 'binary' && n.left.op === 'sub' && isConst(n.left.right) && isConst(n.right) ? { inner:n.left } : null,
    (n,m) => expr.binary('sub', m.inner.left, c(u(m.inner.right.value + n.right.value, n.bits), n), n.bits, n.signed, n.source),
    (n,m) => isStable(m.inner.left)),
  binRule('factor-common-left-add', 'algebra', 'add', (n) => {
    const a=n.left,b=n.right;
    if (a?.kind!=='binary'||b?.kind!=='binary'||a.op!=='mul'||b.op!=='mul') return null;
    if (sameExpr(a.left,b.left) && isStable(a.left) && isPure(a.right) && isPure(b.right)) return { common:a.left, x:a.right, y:b.right };
    return null;
  }, (n,m) => expr.binary('mul', m.common, expr.binary('add',m.x,m.y,n.bits,n.signed,n.source), n.bits,n.signed,n.source)),
  binRule('factor-common-left-sub', 'algebra', 'sub', (n) => {
    const a=n.left,b=n.right;
    if (a?.kind!=='binary'||b?.kind!=='binary'||a.op!=='mul'||b.op!=='mul') return null;
    if (sameExpr(a.left,b.left) && isStable(a.left) && isPure(a.right) && isPure(b.right)) return { common:a.left, x:a.right, y:b.right };
    return null;
  }, (n,m) => expr.binary('mul', m.common, expr.binary('sub',m.x,m.y,n.bits,n.signed,n.source), n.bits,n.signed,n.source)),
];

const intrinsicRules = [{
  name:'idempotent-minmax', phase:'select',
  match:(n)=>n?.kind==='intrinsic' && ['min','max'].includes(n.name) && n.args?.length===2 && sameExpr(n.args[0],n.args[1]) && isStable(n.args[0]) ? {} : null,
  rewrite:(n)=>n.args[0], proof:proof('order-identity','min/max(x,x) == x'), cost,
}, {
  name:'nested-minmax-idempotent', phase:'select',
  match:(n)=>n?.kind==='intrinsic' && ['min','max'].includes(n.name) && n.args?.length===2 && n.args[0]?.kind==='intrinsic' && n.args[0].name===n.name
    && n.args[0].args?.some((a)=>sameExpr(a,n.args[1])) && isStable(n.args[1]) ? { inner:n.args[0] } : null,
  rewrite:(n,m)=>m.inner, proof:proof('order-idempotence','min/max(min/max(x,y),y)'), cost,
}];

const bitRules = [
  binRule('merge-and-masks', 'bits', 'and', (n) => n.left?.kind === 'binary' && n.left.op === 'and' && isConst(n.left.right) && isConst(n.right)
    ? { inner: n.left } : null,
    (n, m) => expr.binary('and', m.inner.left, c(m.inner.right.value & n.right.value, n), n.bits, n.signed, n.source),
    (n, m) => isPure(m.inner.left)),
  binRule('merge-or-masks', 'bits', 'or', (n) => n.left?.kind === 'binary' && n.left.op === 'or' && isConst(n.left.right) && isConst(n.right)
    ? { inner: n.left } : null,
    (n, m) => expr.binary('or', m.inner.left, c(m.inner.right.value | n.right.value, n), n.bits, n.signed, n.source),
    (n, m) => isPure(m.inner.left)),
  {
    name: 'double-bitwise-not', phase: 'bits',
    match: (n) => n?.kind === 'unary' && n.op === 'not' && n.arg?.kind === 'unary' && n.arg.op === 'not' ? {} : null,
    precondition: (n) => isPure(n.arg.arg), rewrite: (n) => n.arg.arg,
    proof: proof('bitvector-identity', '~~x == x'), cost,
  },
  {
    name: 'collapse-nested-extract', phase: 'bits',
    match: (n) => n?.kind === 'intrinsic' && n.name === 'bit_extract' && n.args?.[0]?.kind === 'intrinsic' && n.args[0].name === 'bit_extract'
      && isConst(n.args[1]) && isConst(n.args[2]) && isConst(n.args[0].args?.[1]) && isConst(n.args[0].args?.[2]) ? { inner: n.args[0] } : null,
    precondition: (n, m) => n.args[1].value + n.args[2].value <= m.inner.args[2].value,
    rewrite: (n, m) => expr.intrinsic('bit_extract', [m.inner.args[0], c(m.inner.args[1].value + n.args[1].value, n), n.args[2]], n.bits, n.signed, n.source),
    proof: proof('bit-slice-composition', 'nested fixed-width extraction'), cost,
  },
];

const compareRules = [{
  name: 'compare-self-eq-ne', phase: 'boolean',
  match: (n) => n?.kind === 'compare' && n.comparisonDomain !== 'floating' && ['eq','ne'].includes(n.op) && sameExpr(n.left, n.right) && isPure(n.left) ? {} : null,
  rewrite: (n) => c(n.op === 'eq' ? 1 : 0, n, 1),
  proof: proof('comparison-reflexivity', 'pure expression compared with itself'), cost,
}, {
  name: 'boolean-eq-zero', phase: 'boolean',
  match: (n) => n?.kind === 'compare' && n.op === 'eq' && isConst(n.right, 0) && n.left?.bits === 1 ? {} : null,
  rewrite: (n) => expr.unary('lnot', n.left, 1, false, n.source), proof: proof('boolean-normalization', 'bool == 0'), cost,
}, {
  name: 'boolean-ne-zero', phase: 'boolean',
  match: (n) => n?.kind === 'compare' && n.op === 'ne' && isConst(n.right, 0) && n.left?.bits === 1 ? {} : null,
  rewrite: (n) => n.left, proof: proof('boolean-normalization', 'bool != 0'), cost,
}, {
  name: 'double-logical-not', phase: 'boolean',
  match: (n) => n?.kind === 'unary' && n.op === 'lnot' && n.arg?.kind === 'unary' && n.arg.op === 'lnot' ? {} : null,
  precondition: (n) => isPure(n.arg.arg), rewrite: (n) => n.arg.arg, proof: proof('boolean-identity', '!!bool'), cost,
}];

const compareCanonicalRules = [{
  name:'compare-constant-right', phase:'boolean',
  match:(n)=>n?.kind==='compare' && isConst(n.left) && !isConst(n.right) && ['eq','ne','lt','le','gt','ge'].includes(n.op) ? {} : null,
  precondition:(n)=>isStable(n.right),
  rewrite:(n)=>expr.compare(({eq:'eq',ne:'ne',lt:'gt',le:'ge',gt:'lt',ge:'le'})[n.op], n.right, n.left, n.compareSigned, n.source),
  proof:proof('comparison-symmetry','swap operands and invert ordering'), cost,
}, {
  name:'bool-eq-one', phase:'boolean',
  match:(n)=>n?.kind==='compare' && n.op==='eq' && isConst(n.right,1) && n.left?.bits===1 ? {} : null,
  rewrite:(n)=>n.left, proof:proof('boolean-normalization','bool == 1'), cost,
}, {
  name:'bool-ne-one', phase:'boolean',
  match:(n)=>n?.kind==='compare' && n.op==='ne' && isConst(n.right,1) && n.left?.bits===1 ? {} : null,
  rewrite:(n)=>expr.unary('lnot',n.left,1,false,n.source), proof:proof('boolean-normalization','bool != 1'), cost,
}];

const rangeRules = [{
  name:'range-proven-compare', phase:'range',
  match:(n)=>{
    if (n?.kind!=='compare' || !n.left?.range || !isConst(n.right)) return null;
    const source=n.left.range;
    const bits=Number(n.left.bits || source.bits || 64);
    const relational=!['eq','ne'].includes(n.op);
    const compareSigned=relational ? n.compareSigned : (source.signed ?? n.compareSigned);
    if (relational && compareSigned == null) return null;
    const r=normalizeRangeDomain(source,bits,compareSigned);
    if (!r) return null;
    const c=normalizeIntegerValue(n.right.value,bits,compareSigned);
    let value=null;
    if (n.op==='eq' && (c<r.min || c>r.max)) value=0;
    else if (n.op==='ne' && (c<r.min || c>r.max)) value=1;
    else if (n.op==='lt' && r.max<c) value=1;
    else if (n.op==='lt' && r.min>=c) value=0;
    else if (n.op==='le' && r.max<=c) value=1;
    else if (n.op==='le' && r.min>c) value=0;
    else if (n.op==='gt' && r.min>c) value=1;
    else if (n.op==='gt' && r.max<=c) value=0;
    else if (n.op==='ge' && r.min>=c) value=1;
    else if (n.op==='ge' && r.max<c) value=0;
    return value==null ? null : {
      value,
      range:{min:String(r.min),max:String(r.max),bits:r.bits,signed:r.signed},
      constant:String(c),
    };
  },
  precondition:(n)=>isStable(n.left),
  rewrite:(n,m)=>c(m.value,n,1),
  proof:(before,after,m)=>({kind:'range-proof',relation:before.op,range:m.range,constant:m.constant,result:m.value}),
  cost,
}];

const selectRules = [{
  name: 'select-identical-arms', phase: 'select',
  match: (n) => n?.kind === 'select' && sameExpr(n.whenTrue, n.whenFalse) && isPure(n.condition) && mayDuplicate(n.whenTrue) ? {} : null,
  rewrite: (n) => n.whenTrue, proof: proof('conditional-identity', 'both select arms identical'), cost,
}, {
  name: 'select-bool-materialize', phase: 'select',
  match: (n) => n?.kind === 'select' && isConst(n.whenTrue, 1) && isConst(n.whenFalse, 0) ? {} : null,
  rewrite: (n) => n.condition, proof: proof('conditional-identity', 'cond ? 1 : 0'), cost,
}, {
  name: 'select-bool-invert', phase: 'select',
  match: (n) => n?.kind === 'select' && isConst(n.whenTrue, 0) && isConst(n.whenFalse, 1) ? {} : null,
  rewrite: (n) => expr.unary('lnot', n.condition, 1, false, n.source), proof: proof('conditional-identity', 'cond ? 0 : 1'), cost,
}, {
  name: 'select-min-max', phase: 'select',
  match: (n) => {
    if (n?.kind !== 'select' || n.condition?.kind !== 'compare') return null;
    const q = n.condition;
    // Constant signedness/nominal width is metadata; select equivalence is over
    // the result bitvector. This keeps WZR and #0 equivalent after width-aware
    // operand reconstruction while retaining strict structural matching for
    // non-constant expressions.
    const sameArm = (a,b) => sameExpr(a,b) || (isConst(a) && isConst(b)
      && BigInt.asUintN(Number(n.bits || q.left?.bits || 64), a.value) === BigInt.asUintN(Number(n.bits || q.left?.bits || 64), b.value));
    const ta = sameArm(n.whenTrue, q.left), tb = sameArm(n.whenTrue, q.right);
    const fa = sameArm(n.whenFalse, q.left), fb = sameArm(n.whenFalse, q.right);
    if (!(isStable(q.left) && isStable(q.right))) return null;
    if ((q.op === 'gt' || q.op === 'ge') && ta && fb) return { name: 'max' };
    if ((q.op === 'gt' || q.op === 'ge') && tb && fa) return { name: 'min' };
    if ((q.op === 'lt' || q.op === 'le') && ta && fb) return { name: 'min' };
    if ((q.op === 'lt' || q.op === 'le') && tb && fa) return { name: 'max' };
    return null;
  },
  // The ordering semantics come from the compare that guards the select, not
  // from the result storage type. This matters at -O0 where Clang spills both
  // arms to stack slots whose recovered value type can remain unsigned/unknown.
  rewrite: (n, m) => expr.intrinsic(m.name, [n.condition.left, n.condition.right], n.bits, n.condition.compareSigned ?? n.signed, n.source, { compareSigned: n.condition.compareSigned }),
  proof: (before, after, m) => ({ kind: 'select-comparison-equivalence', operation: m.name, signed: before.condition.compareSigned }), cost,
}, {
  name: 'select-abs', phase: 'select',
  match: (n) => {
    if (n?.kind !== 'select' || n.condition?.kind !== 'compare') return null;
    const q = n.condition;
    if (!isConst(q.right, 0) || !isStable(q.left)) return null;
    const neg = (x) => x?.kind === 'unary' && x.op === 'neg' && sameExpr(x.arg, q.left);
    if ((q.op === 'lt' || q.op === 'le') && neg(n.whenTrue) && sameExpr(n.whenFalse, q.left)) return {};
    if ((q.op === 'ge' || q.op === 'gt') && sameExpr(n.whenTrue, q.left) && neg(n.whenFalse)) return {};
    return null;
  },
  rewrite: (n) => expr.intrinsic('abs', [n.condition.left], n.bits, true, n.source),
  proof: proof('select-comparison-equivalence', 'two-arm signed absolute value'), cost,
}];

const extensionRules = [{
  name: 'redundant-trunc', phase: 'width',
  match: (n) => n?.kind === 'unary' && n.op === 'trunc' && Number(n.arg?.bits) === Number(n.bits) ? {} : null,
  rewrite: (n) => n.arg, proof: proof('width-identity', 'same-width truncation'), cost,
}, {
  name: 'redundant-zext', phase: 'width',
  match: (n) => n?.kind === 'unary' && n.op === 'zext' && Number(n.arg?.bits) === Number(n.bits) ? {} : null,
  rewrite: (n) => n.arg, proof: proof('width-identity', 'same-width zero extension'), cost,
}, {
  name: 'redundant-sext', phase: 'width',
  match: (n) => n?.kind === 'unary' && n.op === 'sext' && Number(n.arg?.bits) === Number(n.bits) ? {} : null,
  rewrite: (n) => n.arg, proof: proof('width-identity', 'same-width sign extension'), cost,
}, {
  name: 'collapse-zext-chain', phase: 'width',
  match: (n) => n?.kind === 'unary' && n.op === 'zext' && n.arg?.kind === 'unary' && n.arg.op === 'zext' && n.bits >= n.arg.bits ? {} : null,
  rewrite: (n) => expr.unary('zext', n.arg.arg, n.bits, false, n.source), proof: proof('extension-composition', 'zext(zext(x))'), cost,
}, {
  name: 'trunc-after-zext-to-source-width', phase: 'width',
  match: (n) => n?.kind === 'unary' && n.op === 'trunc' && n.arg?.kind === 'unary' && n.arg.op === 'zext' && Number(n.bits) === Number(n.arg.arg?.bits) ? {} : null,
  rewrite: (n) => n.arg.arg, proof: proof('extension-truncation-cancel', 'trunc(zext(x)) to original width'), cost,
}, {
  name: 'trunc-after-sext-to-source-width', phase: 'width',
  match: (n) => n?.kind === 'unary' && n.op === 'trunc' && n.arg?.kind === 'unary' && n.arg.op === 'sext' && Number(n.bits) === Number(n.arg.arg?.bits) ? {} : null,
  rewrite: (n) => n.arg.arg, proof: proof('extension-truncation-cancel', 'trunc(sext(x)) to original width'), cost,
}, {
  name: 'collapse-sext-chain', phase: 'width',
  match: (n) => n?.kind === 'unary' && n.op === 'sext' && n.arg?.kind === 'unary' && n.arg.op === 'sext' && n.bits >= n.arg.bits ? {} : null,
  rewrite: (n) => expr.unary('sext', n.arg.arg, n.bits, true, n.source), proof: proof('extension-composition', 'sext(sext(x))'), cost,
}];

export const DEFAULT_RULES = Object.freeze([
  ...identityRules,
  ...constantRules,
  ...associativeRules,
  ...arithmeticRules,
  ...bitRules,
  ...compareRules,
  ...compareCanonicalRules,
  ...rangeRules,
  ...selectRules,
  ...intrinsicRules,
  ...extensionRules,
]);
