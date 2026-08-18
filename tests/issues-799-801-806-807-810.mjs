import assert from 'node:assert/strict';
import fs from 'node:fs';
import { expr } from '../js/decompiler/ast/nodes.js';
import { DEFAULT_RULES } from '../js/decompiler/rewrite/rules.js';
import { bin, constNode, regNode } from '../js/expr.js';
import { sanitizePointer } from '../js/objc-legacy.js';
import { readVtable } from '../js/rtti.js';

// #799: select-to-abs is valid only for an explicitly signed comparison.
const absRule = DEFAULT_RULES.find((r) => r.name === 'select-abs');
assert.ok(absRule);
for (const bits of [32, 64]) {
  const zero = expr.constant(0n, bits, false);
  const ux = expr.variable(`u${bits}`, bits, false);
  const uneg = expr.unary('neg', ux, bits, false);
  const unsignedSel = expr.select(expr.compare('lt', ux, zero, false), uneg, ux, bits, false);
  assert.equal(absRule.match(unsignedSel, {}), null, `unsigned ${bits}-bit select must not become abs`);

  const sx = expr.variable(`s${bits}`, bits, true);
  const sneg = expr.unary('neg', sx, bits, true);
  const signedSel = expr.select(expr.compare('lt', sx, zero, true), sneg, sx, bits, true);
  const match = absRule.match(signedSel, {});
  assert.ok(match, `signed ${bits}-bit abs idiom should remain recognized`);
  const rewritten = absRule.rewrite(signedSel, match, {});
  assert.equal(rewritten.name, 'abs');
  assert.equal(absRule.proof(signedSel, rewritten, match).precondition, 'signed-comparison');
}

// The unsigned sign-bit counterexample demonstrates why the guard is required.
assert.equal((0x80000000n < 0n), false);
assert.equal(BigInt.asIntN(32, 0x80000000n) < 0n, true);
assert.equal((0x8000000000000000n < 0n), false);
assert.equal(BigInt.asIntN(64, 0x8000000000000000n) < 0n, true);

// #801: preserve both fixed-width divisions; reassociation can erase architectural wrap.
for (const bits of [32, 64]) {
  const source = regNode(bits === 32 ? 'w0' : 'x0', 0);
  for (const second of [2n, -1n]) {
    const inner = bin('sdiv', source, constNode(-1n), bits);
    const outer = bin('sdiv', inner, constNode(second), bits);
    assert.equal(outer.k, 'bin');
    assert.equal(outer.op, 'sdiv');
    assert.equal(outer.a, inner, `${bits}-bit SDIV must keep the intermediate operation`);
  }
  const umax = (1n << BigInt(bits)) - 1n;
  const uinner = bin('udiv', source, constNode(umax), bits);
  const uouter = bin('udiv', uinner, constNode(umax), bits);
  assert.equal(uouter.a, uinner, `${bits}-bit UDIV must keep the intermediate operation`);
}
const min32 = -(1n << 31n);
const wrappedIntermediate32 = BigInt.asIntN(32, min32 / -1n);
assert.equal(wrappedIntermediate32 / 2n, -(1n << 30n));
assert.equal(min32 / (-2n), 1n << 30n);
const min64 = -(1n << 63n);
const wrappedIntermediate64 = BigInt.asIntN(64, min64 / -1n);
assert.equal(wrappedIntermediate64 / 2n, -(1n << 62n));
assert.equal(min64 / (-2n), 1n << 62n);

// #806: both return-summary paths use the same width/subtype guarded transparency helper.
const interproc = fs.readFileSync(new URL('../js/interproc.js', import.meta.url), 'utf8');
const transparent = interproc.slice(interproc.indexOf('function transparentMoveSource'), interproc.indexOf('function returnArgumentIndex'));
assert.match(transparent, /def\.sub != null/);
assert.match(transparent, /Number\(source\.bits \|\| 0\) !== Number\(current\.bits \|\| 0\)/);
const simple = interproc.slice(interproc.indexOf('function simpleReturnExpression'), interproc.indexOf('function argumentRoles'));
assert.match(simple, /const v = transparentMoveSource\(value\)/);
assert.doesNotMatch(simple, /const pass = new Set\(\[OP\.MOV\]\)/);

// #807: format-aware DYLD_CHAINED_PTR_64 / _64_OFFSET decoding, including next=0.
const target = 0x123456789n;
const high8 = 0xabn;
const encodedNextZero = target | (high8 << 36n);
const encodedWithNext = encodedNextZero | (0x12n << 51n);
assert.equal(sanitizePointer(encodedNextZero, null, 2), 0xab00000123456789n);
assert.equal(sanitizePointer(encodedWithNext, null, 2), 0xab00000123456789n);
const base = 0x100000000n;
const offsetNextZero = 0x12345n;
assert.equal(sanitizePointer(offsetNextZero, base, 6), base + 0x12345n);
assert.equal(sanitizePointer(encodedNextZero | (1n << 63n), base, 2), null);
assert.equal(sanitizePointer(offsetNextZero, null, 6), null);
assert.equal(sanitizePointer(encodedNextZero, base, 999), null);
const objcSource = fs.readFileSync(new URL('../js/objc-legacy.js', import.meta.url), 'utf8');
assert.match(objcSource, /cleanPointer\(get, value\).*get\.pointerFormat/);
assert.match(objcSource, /pointerFormat \?\? classList\.pointerFormat \?\? classList\.pointer_format/);

// #810: legal null virtual slots preserve their index and following entries.
const words = [0n, 0x1000n, 0x2000n, 0n, 0x3000n];
const bytes = new Uint8Array(words.length * 8);
const dv = new DataView(bytes.buffer);
words.forEach((v, i) => dv.setBigUint64(i * 8, v, true));
const read = async (_addr, len) => bytes.subarray(0, Math.min(len, bytes.length));
const symbols = { nameAt: () => null, label: () => null };
const table = await readVtable(read, 0x4000n, symbols, 3);
assert.equal(table.slots.length, 3);
assert.equal(table.slots[0].addr, 0x2000n);
assert.equal(table.slots[1].addr, 0n);
assert.equal(table.slots[2].addr, 0x3000n);

console.log('issues #799 #801 #806 #807 #810 regression: PASS');
