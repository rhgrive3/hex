from pathlib import Path


def replace_one(path, old, new):
    p = Path(path)
    s = p.read_text()
    count = s.count(old)
    if count != 1:
        raise SystemExit(f"{path}: expected exactly one match, got {count}")
    p.write_text(s.replace(old, new, 1))


# #799: signed abs is only valid when the guarding comparison is signed.
replace_one('js/decompiler/rewrite/rules.js',
"""    const q = n.condition;
    if (!isConst(q.right, 0) || !isStable(q.left)) return null;
    const neg = (x) => x?.kind === 'unary' && x.op === 'neg' && sameExpr(x.arg, q.left);""",
"""    const q = n.condition;
    if (q.compareSigned !== true || !isConst(q.right, 0) || !isStable(q.left)) return null;
    const neg = (x) => x?.kind === 'unary' && x.op === 'neg' && sameExpr(x.arg, q.left);""")
replace_one('js/decompiler/rewrite/rules.js',
"""  proof: proof('select-comparison-equivalence', 'two-arm signed absolute value'), cost,""",
"""  proof: () => ({ kind:'select-comparison-equivalence', detail:'two-arm signed absolute value', signed:true, precondition:'signed-comparison' }), cost,""")

# #801: do not reassociate fixed-width divisions without a width-exact proof.
replace_one('js/expr.js',
"""  /* ── (a / c1) / c2 → a / (c1*c2) ── */
  if ((op === 'sdiv' || op === 'udiv') && cb != null && a.k === 'bin' && a.op === op) {
    const inner = constOf(a.b);
    if (inner != null) return bin(op, a.a, constNode(inner * cb), bits);
  }

""",
"""  /* Nested fixed-width division is intentionally not reassociated. Intermediate
     rounding/wrap is architecturally observable (notably SDIV INT_MIN / -1), and
     unsigned divisor products also require width-exact proof before reassociation. */

""")

# #806: use the shared semantics-preserving MOV transparency helper.
replace_one('js/interproc.js',
"""  let v = value;
  const pass = new Set([OP.MOV]);
  for (let guard = 0; guard < 6 && v && v.def && pass.has(v.def.op); guard++) v = v.def.args[0] && v.def.args[0].value;""",
"""  const v = transparentMoveSource(value);""")

# #807: reconstruct DYLD_CHAINED_PTR_64 high8 and fail closed on binds.
replace_one('js/objc-legacy.js',
"""  const low = v & 0x0000000fffffffffn;
  if (low === 0n) return null;

  /*
   * 最上位ビットは「他のライブラリの記号を入れる」印（bind）。
   * そこに書いてあるのはアドレスではなく取り込み表の番号なので、
   * このファイルの中を指しているようには見えないなら、読めたことにしない。
   * （親クラスが NSObject のときにここへ来る。番号をアドレスと取り違えると、
   *   たまたま同じ値だった別のクラスを親として拾ってしまう。）
   */
  if (v & 0x8000000000000000n) {
    return (base == null || low >= base) ? low : null;
  }

  /*
   * 形式が 2 つある。target にアドレスそのものが入っているもの（DYLD_CHAINED_PTR_64）と、
   * イメージ先頭からの距離が入っているもの（同 _64_OFFSET）。
   * 距離のほうは必ずイメージ先頭より小さいので、そこで見分けられる。
   */
  if (base != null && low < base) return base + low;
  return low;""",
"""  const target = v & 0x0000000fffffffffn;
  const high8 = (v >> 36n) & 0xffn;
  if (target === 0n) return null;

  /* A bind stores an import ordinal, not a VM address. Without the fixup import
     table this legacy reader cannot resolve it safely, so fail closed. */
  if (v & 0x8000000000000000n) return null;

  /* DYLD_CHAINED_PTR_64 stores high8 in raw bits 36..43 but reconstructs it at
     canonical pointer bits 56..63. The OFFSET form instead adds the 36-bit
     target to imageBase. This bounded legacy heuristic distinguishes the two
     by whether target is image-relative; format-aware callers should remain
     authoritative when pointer_format metadata is available. */
  if (base != null && target < BigInt(base)) return BigInt(base) + target;
  return target | (high8 << 56n);""")

# #810: null virtual entries are legal slots, not table terminators.
replace_one('js/rtti.js',
"""    const raw=dv.getBigUint64(i*8,true);
    if(raw===0n)break;
    const resolved=await resolveVtablePointer(raw,BigInt(vtableAddr)+BigInt(i*8),opts||{});""",
"""    const raw=dv.getBigUint64(i*8,true);
    const resolved=await resolveVtablePointer(raw,BigInt(vtableAddr)+BigInt(i*8),opts||{});""")

Path('tests/issues-799-801-806-807-810.mjs').write_text(r'''import assert from 'node:assert/strict';
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
const encoded = target | (high8 << 36n) | (1n << 51n);
assert.equal(sanitizePointer(encoded), 0xab00000123456789n);
const base = 0x100000000n;
const offsetEncoded = 0x12345n | (1n << 51n);
assert.equal(sanitizePointer(offsetEncoded, base), base + 0x12345n);
assert.equal(sanitizePointer(encoded | (1n << 63n), base), null);

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
