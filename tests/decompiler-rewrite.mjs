import assert from 'node:assert/strict';
import { expr, structuralKey } from '../js/decompiler/ast/nodes.js';
import { RewriteEngine } from '../js/decompiler/rewrite/engine.js';
import { DEFAULT_RULES } from '../js/decompiler/rewrite/rules.js';
import { evaluateExpression } from '../js/decompiler/verify/equivalence.js';
import { u } from '../js/decompiler/truth/integer.js';
import { printExpression } from '../js/decompiler/pretty/c.js';

const engine = new RewriteEngine(DEFAULT_RULES, { timeBudgetMs: 1000, nodeBudget: 4096, maxIterations: 16 });
const v = (name, bits = 32, signed = true) => expr.variable(name, bits, signed);
const c = (n, bits = 32, signed = true) => expr.constant(BigInt(n), bits, signed);
const rw = (e) => engine.rewrite(e).root;

assert.equal(printExpression(rw(expr.binary('add', v('x'), c(0), 32, true))), 'x');
assert.equal(printExpression(rw(expr.binary('xor', v('x'), v('x'), 32, false))), '0');
assert.equal(printExpression(rw(expr.binary('and', v('x', 8, false), c(255, 8, false), 8, false))), 'x');
const nested = expr.binary('add', expr.binary('add', v('x'), c(5), 32, true), c(7), 32, true);
// #969: a width-exact signed add prints its wrapping machine view.
assert.equal(printExpression(rw(nested)), '(int32_t)((uint32_t)x + (uint32_t)12)');
const maxSel = expr.select(expr.compare('gt', v('a'), v('b'), true), v('a'), v('b'), 32, true);
assert.equal(printExpression(rw(maxSel)), 'max(a, b)');
const minSel = expr.select(expr.compare('lt', v('a'), v('b'), true), v('a'), v('b'), 32, true);
assert.equal(printExpression(rw(minSel)), 'min(a, b)');
const absSel = expr.select(expr.compare('lt', v('x'), c(0), true), expr.unary('neg', v('x'), 32, true), v('x'), 32, true);
assert.equal(printExpression(rw(absSel)), 'abs(x)');

// Ordering semantics belong to the comparison, not the storage type of the
// selected value. Clang -O0 commonly spills signed int arms through stack slots
// whose local recovered signedness is still unknown/unsigned.
const signedA = v('a', 32, false), signedB = v('b', 32, false);
const signedCompareWithUnsignedStorage = expr.select(expr.compare('gt', signedA, signedB, true), signedA, signedB, 32, false);
const signedMinMax = rw(signedCompareWithUnsignedStorage);
assert.equal(signedMinMax.kind, 'intrinsic');
assert.equal(signedMinMax.name, 'max');
assert.equal(signedMinMax.signed, true);
assert.equal(u(evaluateExpression(signedMinMax, { a: 0x7fffffffn, b: 0xffffffffn }), 32), 0x7fffffffn);

// Side effects must prevent x^x/reflexive rewrites when evaluating x twice is observable.
const call = expr.call('f', [], 32);
const sideEffectExpr = expr.binary('xor', call, call, 32, false);
assert.equal(structuralKey(rw(sideEffectExpr)), structuralKey(sideEffectExpr));

let seed = 0x9e3779b9;
function rand32() { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return seed >>> 0; }
const boundaries = [0n, 1n, -1n, 2n, -2n, 0x7fn, 0x80n, 0xffn, 0x7fffn, 0x8000n, 0xffffn, 0x7fffffffn, 0x80000000n, 0xffffffffn, 0x7fffffffffffffffn, 0x8000000000000000n, 0xffffffffffffffffn];
let checks = 0;
for (const bits of [8, 16, 32, 64]) {
  for (const signed of [false, true]) {
    const x = expr.variable('x', bits, signed), y = expr.variable('y', bits, signed);
    const corpus = [
      expr.binary('add', expr.binary('add', x, expr.constant(5, bits, signed), bits, signed), expr.constant(7, bits, signed), bits, signed),
      expr.binary('and', expr.binary('and', x, expr.constant(0xf5, bits, signed), bits, signed), expr.constant(0x3f, bits, signed), bits, signed),
      expr.binary('or', expr.binary('or', x, expr.constant(0x10, bits, signed), bits, signed), expr.constant(0x20, bits, signed), bits, signed),
      expr.select(expr.compare('gt', x, y, signed), x, y, bits, signed),
      expr.binary('mul', x, expr.constant(8, bits, signed), bits, signed),
    ];
    for (const original of corpus) {
      const rewritten = rw(original);
      const values = boundaries.concat(Array.from({ length: 128 }, () => BigInt(rand32())));
      for (let i = 0; i < values.length; i++) {
        const env = { x: u(values[i], bits), y: u(values[(i + 7) % values.length], bits) };
        const a = evaluateExpression(original, env), b = evaluateExpression(rewritten, env);
        assert.notEqual(a, null); assert.notEqual(b, null);
        assert.equal(u(a, bits), u(b, bits), `${bits}-bit ${signed ? 'signed' : 'unsigned'} mismatch ${printExpression(original)} -> ${printExpression(rewritten)}`);
        checks++;
      }
    }
  }
}
assert.ok(checks > 5000);
console.log(`decompiler rewrite property tests: ${checks} signed/unsigned semantic checks PASS`);
