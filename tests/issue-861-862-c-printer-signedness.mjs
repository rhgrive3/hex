import assert from 'node:assert/strict';
import { expr } from '../js/decompiler/ast/nodes.js';
import { printExpression } from '../js/decompiler/pretty/c.js';
import { buildExpressionForTesting } from '../js/decompiler/pipeline-core.js';

function view(bits, signed) { return `${signed ? 'int' : 'uint'}${bits}_t`; }

// #861: the same value can be consumed by signed and unsigned comparisons.
for (const bits of [8, 16, 32, 64]) {
  const x = expr.variable('x', bits, null);
  const zero = expr.constant(0n, bits, false);
  const one = expr.constant(1n, bits, false);
  const signed = printExpression(expr.compare('lt', x, zero, true));
  const unsigned = printExpression(expr.compare('lt', x, one, false));
  assert.equal(signed, `(${view(bits, true)})x < (${view(bits, true)})0`);
  assert.equal(unsigned, `(${view(bits, false)})x < 1`);
  assert.notEqual(signed, unsigned);

  // A recovered view that already proves the exact site contract needs no cast.
  const sx = expr.variable('sx', bits, true);
  const ux = expr.variable('ux', bits, false);
  assert.equal(printExpression(expr.compare('lt', sx, expr.constant(0n, bits, true), true)), 'sx < 0');
  assert.equal(printExpression(expr.compare('lt', ux, expr.constant(1n, bits, false), false)), 'ux < 1');
}

// Signed and unsigned ARM condition families remain distinct at the C boundary.
{
  const x = expr.variable('x', 32, null);
  const y = expr.variable('y', 32, null);
  for (const op of ['lt', 'le', 'gt', 'ge']) {
    const s = printExpression(expr.compare(op, x, y, true));
    const u = printExpression(expr.compare(op, x, y, false));
    assert.match(s, /\(int32_t\)x/);
    assert.match(u, /\(uint32_t\)x/);
    assert.notEqual(s, u, op);
  }
}

// #862: exact site signedness for shifts/division/remainder.
for (const bits of [8, 16, 32, 64]) {
  const x = expr.variable('x', bits, null);
  const one = expr.constant(1n, bits, false);
  const two = expr.constant(2n, bits, false);
  assert.equal(printExpression(expr.binary('lshr', x, one, bits, false)), `(${view(bits, false)})x >> 1`);
  assert.equal(printExpression(expr.binary('ashr', x, one, bits, true)), `(${view(bits, true)})x >> 1`);
  assert.equal(printExpression(expr.binary('udiv', x, two, bits, false)), `(${view(bits, false)})x / 2`);
  assert.equal(printExpression(expr.binary('sdiv', x, two, bits, true)), `(${view(bits, true)})x / (${view(bits, true)})2`);
  assert.equal(printExpression(expr.binary('umod', x, two, bits, false)), `(${view(bits, false)})x % 2`);
  assert.equal(printExpression(expr.binary('smod', x, two, bits, true)), `(${view(bits, true)})x % (${view(bits, true)})2`);
}

// Existing matching recovered views stay readable.
{
  const sx = expr.variable('sx', 32, true);
  const ux = expr.variable('ux', 32, false);
  const s2 = expr.constant(2n, 32, true);
  const u2 = expr.constant(2n, 32, false);
  assert.equal(printExpression(expr.binary('ashr', sx, u2, 32, true)), 'sx >> 2');
  assert.equal(printExpression(expr.binary('lshr', ux, u2, 32, false)), 'ux >> 2');
  assert.equal(printExpression(expr.binary('sdiv', sx, s2, 32, true)), 'sx / 2');
  assert.equal(printExpression(expr.binary('udiv', ux, u2, 32, false)), 'ux / 2');
}

// Semantic-IR-style SSA definitions -> AST -> C: signedness-sensitive binary ops.
function arg(id, reg, bits, signed = null) { return { id, reg, bits, signed, kind: 'arg', uses: [], def: null, const: null }; }
function constant(id, bits, value) {
  const v = { id, reg: `c${id}`, bits, signed: false, kind: 'def', uses: [], const: BigInt(value), def: null };
  v.def = { id: 1000 + id, op: 'const', dst: v, args: [], extra: { value: BigInt(value) } };
  return v;
}
function av(value, bits = value.bits) { return { value, bits }; }
function binaryValue(id, sub, left, right, bits, signed = null) {
  const v = { id, reg: `x${id % 8}`, bits, signed, kind: 'def', uses: [], const: null, def: null };
  v.def = { id: 2000 + id, op: 'bin', sub, dst: v, bits, args: [av(left, bits), av(right, bits)] };
  return v;
}
function state() { return { types: { values: new Map() }, highVariables: null, opts: {} }; }

{
  const x = arg(1, 'x0', 32, null);
  const two = constant(2, 32, 2n);
  const udiv = buildExpressionForTesting(binaryValue(3, 'udiv', x, two, 32, false), state());
  const sdiv = buildExpressionForTesting(binaryValue(4, 'sdiv', x, two, 32, true), state());
  assert.equal(udiv.op, 'udiv');
  assert.equal(sdiv.op, 'sdiv');
  assert.match(printExpression(udiv), /\(uint32_t\)x0 \/ 2/);
  assert.match(printExpression(sdiv), /\(int32_t\)x0 \/ \(int32_t\)2/);
}

// Semantic flags -> compare AST -> C: the same SSA input keeps signed/unsigned
// branch meaning at the final rendering boundary.
function compareSelect(id, cond, x, rhs, bits) {
  const flags = { id: id + 10, reg: 'nzcv', bits: 4, signed: false, kind: 'def', uses: [], const: null, def: null };
  flags.def = { id: 3000 + id, op: 'cmp', sub: 'sub', bits, dst: flags, args: [av(x, bits), av(rhs, bits)] };
  const yes = constant(id + 20, bits, 1n);
  const no = constant(id + 21, bits, 0n);
  const out = { id: id + 30, reg: `x${id % 8}`, bits, signed: false, kind: 'def', uses: [], const: null, def: null };
  out.def = { id: 4000 + id, op: 'sel', sub: 'sel', cond, dst: out, args: [av(yes, bits), av(no, bits), av(flags, 4)] };
  return out;
}

{
  const x = arg(50, 'x0', 32, null);
  const zero = constant(51, 32, 0n);
  const one = constant(52, 32, 1n);
  const signedAst = buildExpressionForTesting(compareSelect(60, 'lt', x, zero, 32), state());
  const unsignedAst = buildExpressionForTesting(compareSelect(70, 'lo', x, one, 32), state());
  const signedText = printExpression(signedAst);
  const unsignedText = printExpression(unsignedAst);
  assert.match(signedText, /\(int32_t\)x0 < \(int32_t\)0/);
  assert.match(unsignedText, /\(uint32_t\)x0 < 1/);
}

console.log('issues 861-862 C printer signedness regressions: ok');
