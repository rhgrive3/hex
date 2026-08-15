import assert from 'node:assert/strict';
import { OP, VK } from '../js/ir.js';
import { FACT, canonicalThresholdComparison, proveClampSelect, semanticFacts } from '../js/semantic.js';
import { compactFact } from '../js/agent/tools.js';

let nextId = 1;
const value = (name, opts = {}) => ({
  id: nextId++, reg: name, bits: opts.bits || 32,
  kind: opts.constant == null ? (opts.kind || VK.DEF) : VK.CONST,
  const: opts.constant == null ? null : BigInt(opts.constant),
  signed: opts.signed ?? null, def: opts.def || null, uses: [],
});
const cmp = (left, right, row = 1) => {
  const flags = value('nzcv', { bits:4 });
  const inst = { id:nextId++, op:OP.CMP, sub:'sub', row, address:0x1000n + BigInt(row * 4), args:[{ value:left }, { value:right }], dst:flags };
  flags.def = inst;
  return { inst, flags };
};
const select = (left, right, whenTrue, whenFalse, cond = 'gt', sub = 'sel') => {
  const { inst:compare, flags } = cmp(left, right);
  const dst = value('x8');
  const sel = {
    id:nextId++, op:OP.SEL, sub, cond, row:2, address:0x1008n,
    args:[{ value:whenTrue }, { value:whenFalse }, { value:flags }], dst,
  };
  dst.def = sel;
  return { compare, sel };
};

// #427: arbitrary/select-like operations are not clamps merely because CSEL exists.
{
  const x = value('x');
  const y = value('y');
  const zero = value(null, { constant:0n });

  assert.equal(proveClampSelect(select(x, zero, x, y, 'gt').sel), null, 'x > 0 ? x : y is not a clamp');

  const lower = proveClampSelect(select(x, zero, x, zero, 'gt').sel);
  assert.equal(lower?.kind, 'max');
  assert.equal(lower?.bound?.id, zero.id);
  assert.equal(lower?.candidate?.id, x.id);

  const upper = value(null, { constant:100n });
  const upperProof = proveClampSelect(select(x, upper, x, upper, 'lt').sel);
  assert.equal(upperProof?.kind, 'min');
  assert.equal(upperProof?.bound?.id, upper.id);

  const a = value('a');
  const b = value('b');
  assert.equal(proveClampSelect(select(x, y, a, b, 'gt').sel), null, 'unrelated ternary arms are not a clamp');
  assert.equal(proveClampSelect(select(x, zero, x, zero, 'gt', 'inc').sel), null, 'CSINC/CINC-style select is not CSEL min/max');
}

const thresholdIR = (left, right, condition) => {
  const { inst:compare, flags } = cmp(left, right, 10);
  const branch = {
    id:nextId++, op:OP.CBR, cond:condition, row:11, address:0x1100n,
    args:[{ value:flags }], extra:{ target:0x1200n },
  };
  return { instructions:[compare, branch], values:[left, right, flags] };
};
const thresholdFact = (left, right, condition) => {
  const facts = semanticFacts(thresholdIR(left, right, condition));
  return facts.find((f) => f.kind === FACT.THRESHOLD);
};

// #426: all four orientations become canonical `subject operator threshold`.
for (const tc of [
  { leftConst:false, cond:'lt', expected:'<' },
  { leftConst:true,  cond:'lt', expected:'>' },
  { leftConst:false, cond:'ge', expected:'>=' },
  { leftConst:true,  cond:'ge', expected:'<=' },
]) {
  const x = value('x');
  const ten = value(null, { constant:10n });
  const left = tc.leftConst ? ten : x;
  const right = tc.leftConst ? x : ten;
  const canonical = canonicalThresholdComparison({ value:left, other:right, cond:tc.cond });
  assert.equal(canonical?.subject?.id, x.id);
  assert.equal(canonical?.threshold, 10n);
  assert.equal(canonical?.operator, tc.expected);

  const fact = thresholdFact(left, right, tc.cond);
  assert.ok(fact, `missing threshold for ${tc.leftConst ? '10 op x' : 'x op 10'}`);
  assert.equal(fact.subject?.id, x.id);
  assert.equal(fact.value?.id, x.id, 'compat value must be canonical subject');
  assert.equal(fact.threshold, 10n);
  assert.equal(fact.operator, tc.expected);
  assert.equal(fact.originalCondition, tc.cond);
  assert.equal(fact.swapped, tc.leftConst);
  assert.equal(fact.operands?.left?.id, left.id);
  assert.equal(fact.operands?.right?.id, right.id);

  const compact = compactFact(fact);
  assert.equal(compact.subject?.id, x.id);
  assert.equal(compact.other?.constant, 10n);
  assert.equal(compact.operator, tc.expected);
  assert.equal(compact.originalCondition, tc.cond);
  assert.equal(compact.swapped, tc.leftConst);
  assert.equal(compact.operands?.left?.id, left.id);
  assert.equal(compact.operands?.right?.id, right.id);
}

// Two constants do not define a useful subject threshold fact.
assert.equal(canonicalThresholdComparison({ value:value(null,{constant:1n}), other:value(null,{constant:2n}), cond:'lt' }), null);

console.log('issues #426/#427 semantic fact regressions passed');
