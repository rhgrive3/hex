from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def replace_one(path, old, new):
    p = ROOT / path
    s = p.read_text()
    if new in s:
        return
    count = s.count(old)
    if count != 1:
        raise SystemExit(f"{path}: expected exactly one match, got {count}")
    p.write_text(s.replace(old, new, 1))


# Complete #807 exactly at the Objective-C reader boundary. The first PR #884
# overlay fixes the legacy high8/bind heuristic; these edits preserve the
# explicit dyld pointer_format contract throughout the reader.
replace_one(
    'js/objc-legacy.js',
    """export function sanitizePointer(v, base) {
  if (v === 0n) return null;""",
    """export function sanitizePointer(v, base, pointerFormat = null) {
  if (v === 0n) return null;
  const format = pointerFormat == null ? null : Number(pointerFormat);
  if (format === 2 || format === 6) {
    const bind = !!((v >> 63n) & 1n);
    if (bind) return null;
    const target = v & 0xfffffffffn;
    if (format === 6) return base == null ? null : BigInt(base) + target;
    const high8 = (v >> 36n) & 0xffn;
    return target | (high8 << 56n);
  }
  if (format != null) return null;""",
)

replace_one(
    'js/objc-legacy.js',
    """async function pointer(get, addr) {
  const b = await get(addr, PTR);
  return b ? sanitizePointer(u64(b, 0), get.base) : null;
}""",
    """function cleanPointer(get, value) { return sanitizePointer(value, get.base, get.pointerFormat); }

async function pointer(get, addr) {
  const b = await get(addr, PTR);
  return b ? cleanPointer(get, u64(b, 0)) : null;
}""",
)

repls = [
    ("nameAddr = sanitizePointer(u64(b, 0), get.base);", "nameAddr = cleanPointer(get, u64(b, 0));"),
    ("imp = sanitizePointer(u64(b, 16), get.base);", "imp = cleanPointer(get, u64(b, 16));"),
    ("const offsetVar = sanitizePointer(u64(b, 0), get.base);", "const offsetVar = cleanPointer(get, u64(b, 0));"),
    ("const name = await cstring(get, sanitizePointer(u64(b, 8), get.base));", "const name = await cstring(get, cleanPointer(get, u64(b, 8)));"),
    ("const typeEnc = await cstring(get, sanitizePointer(u64(b, 16), get.base));", "const typeEnc = await cstring(get, cleanPointer(get, u64(b, 16)));"),
    ("const name = await cstring(get, sanitizePointer(u64(b, 0), get.base));", "const name = await cstring(get, cleanPointer(get, u64(b, 0)));"),
    ("const attrText = await cstring(get, sanitizePointer(u64(b, 8), get.base));", "const attrText = await cstring(get, cleanPointer(get, u64(b, 8)));"),
    ("const roAddr = sanitizePointer(u64(cls, CLASS_DATA) & ~7n, get.base);", "const roAddr = cleanPointer(get, u64(cls, CLASS_DATA) & ~7n);"),
    ("const name = await cstring(get, sanitizePointer(u64(ro, RO_NAME), get.base));", "const name = await cstring(get, cleanPointer(get, u64(ro, RO_NAME)));"),
    ("await readMethods(get, sanitizePointer(u64(ro, RO_METHODS), get.base), out, name,", "await readMethods(get, cleanPointer(get, u64(ro, RO_METHODS)), out, name,"),
    ("superAddr: sanitizePointer(u64(cls, CLASS_SUPER), get.base),", "superAddr: cleanPointer(get, u64(cls, CLASS_SUPER)),"),
    ("info.ivars = await readIvars(get, sanitizePointer(u64(ro, RO_IVARS), get.base));", "info.ivars = await readIvars(get, cleanPointer(get, u64(ro, RO_IVARS)));"),
    ("info.properties = await readProperties(get, sanitizePointer(u64(ro, RO_PROPS), get.base));", "info.properties = await readProperties(get, cleanPointer(get, u64(ro, RO_PROPS)));"),
    ("const isa = sanitizePointer(u64(cls, CLASS_ISA), get.base);", "const isa = cleanPointer(get, u64(cls, CLASS_ISA));"),
]
for old, new in repls:
    replace_one('js/objc-legacy.js', old, new)

replace_one(
    'js/objc-legacy.js',
    """export async function buildObjcModel(read, classList, onProgress, imageBase) {""",
    """export async function buildObjcModel(read, classList, onProgress, imageBase, pointerFormat) {""",
)
replace_one(
    'js/objc-legacy.js',
    """  get.base = imageBase != null
    ? BigInt(imageBase)
    : (classList.vmAddr / 0x100000000n) * 0x100000000n;
  const total = Math.min(Number(classList.size) / PTR, MAX_CLASSES);""",
    """  get.base = imageBase != null
    ? BigInt(imageBase)
    : (classList.vmAddr / 0x100000000n) * 0x100000000n;
  get.pointerFormat = pointerFormat ?? classList.pointerFormat ?? classList.pointer_format ?? null;
  const total = Math.min(Number(classList.size) / PTR, MAX_CLASSES);""",
)
replace_one(
    'js/objc-legacy.js',
    """export async function buildObjcNames(read, classList, onProgress) {
  const model = await buildObjcModel(read, classList, onProgress);""",
    """export async function buildObjcNames(read, classList, onProgress, imageBase, pointerFormat) {
  const model = await buildObjcModel(read, classList, onProgress, imageBase, pointerFormat);""",
)

# Strengthen the consolidated regression to the reviewed PR #884 boundary,
# including explicit pointer-format behavior rather than only the legacy path.
(ROOT / 'tests/issues-799-801-806-807-810.mjs').write_text(r'''import assert from 'node:assert/strict';
import fs from 'node:fs';
import { expr } from '../js/decompiler/ast/nodes.js';
import { DEFAULT_RULES } from '../js/decompiler/rewrite/rules.js';
import { bin, constNode, regNode } from '../js/expr.js';
import { sanitizePointer } from '../js/objc-legacy.js';
import { readVtable } from '../js/rtti.js';

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
assert.equal((0x80000000n < 0n), false);
assert.equal(BigInt.asIntN(32, 0x80000000n) < 0n, true);
assert.equal((0x8000000000000000n < 0n), false);
assert.equal(BigInt.asIntN(64, 0x8000000000000000n) < 0n, true);

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

const interproc = fs.readFileSync(new URL('../js/interproc.js', import.meta.url), 'utf8');
const transparent = interproc.slice(interproc.indexOf('function transparentMoveSource'), interproc.indexOf('function returnArgumentIndex'));
assert.match(transparent, /def\.sub != null/);
assert.match(transparent, /Number\(source\.bits \|\| 0\) !== Number\(current\.bits \|\| 0\)/);
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
const objcSource = fs.readFileSync(new URL('../js/objc-legacy.js', import.meta.url), 'utf8');
assert.match(objcSource, /cleanPointer\(get, value\).*get\.pointerFormat/);
assert.match(objcSource, /pointerFormat \?\? classList\.pointerFormat \?\? classList\.pointer_format/);

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
''')

print('PR #884 pointer-format integration completed')