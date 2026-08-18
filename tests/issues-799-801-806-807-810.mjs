import assert from 'node:assert/strict';
import fs from 'node:fs';
import { expr } from '../js/decompiler/ast/nodes.js';
import { DEFAULT_RULES } from '../js/decompiler/rewrite/rules.js';
import { bin, constNode, regNode } from '../js/expr.js';
import { sanitizePointer } from '../js/objc-legacy.js';
import { readVtable } from '../js/rtti.js';

const absRule = DEFAULT_RULES.find((r) => r.name === 'select-abs');
assert.ok(absRule);
const x = expr.variable('x', 32, false);
const zero = expr.constant(0n, 32, false);
const neg = expr.unary('neg', x, 32, true);
const unsignedSel = expr.select(expr.compare('lt', x, zero, false), neg, x, 32, false);
assert.equal(absRule.match(unsignedSel, {}), null);
const sx = expr.variable('sx', 32, true);
const sneg = expr.unary('neg', sx, 32, true);
const signedSel = expr.select(expr.compare('lt', sx, zero, true), sneg, sx, 32, true);
const match = absRule.match(signedSel, {});
assert.ok(match);
const rewritten = absRule.rewrite(signedSel, match, {});
assert.equal(rewritten.name, 'abs');
assert.equal(absRule.proof(signedSel, rewritten, match).precondition, 'signed-comparison');

const source = regNode('w0', 0);
const inner = bin('sdiv', source, constNode(-1n), 32);
const outer = bin('sdiv', inner, constNode(2n), 32);
assert.equal(outer.k, 'bin');
assert.equal(outer.op, 'sdiv');
assert.equal(outer.a, inner);
const uinner = bin('udiv', source, constNode(0xffffffffn), 32);
const uouter = bin('udiv', uinner, constNode(0xffffffffn), 32);
assert.equal(uouter.a, uinner);

const interproc = fs.readFileSync(new URL('../js/interproc.js', import.meta.url), 'utf8');
const simple = interproc.slice(interproc.indexOf('function simpleReturnExpression'), interproc.indexOf('function argumentRoles'));
assert.match(simple, /const v = transparentMoveSource\(value\)/);
assert.doesNotMatch(simple, /const pass = new Set\(\[OP\.MOV\]\)/);

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
