from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

def rep(path, old, new, count=1):
    p = ROOT / path
    s = p.read_text()
    if old not in s:
        raise RuntimeError(f'missing {path}: {old[:140]!r}')
    p.write_text(s.replace(old, new, count))

# #323: make the helper ABI explicit instead of encoding it in two ternaries.
# This script runs after fix_issues_300_349.py, so its input already has the
# corrected x2/x3 register assignment.
rep('js/dataflow-semantic.js',
"""function propertyHelperUpdates(model, ir) {
  const out = [];
  const callMeta = new Map((model.calls || []).map((c) => [c.row, c]));""",
"""const PROPERTY_HELPER_ABI = Object.freeze({
  getProperty: Object.freeze({ kind: 'read', offsetReg: 'x2', valueReg: 'x0' }),
  setProperty: Object.freeze({ kind: 'write', offsetReg: 'x2', valueReg: 'x3' }),
});

function propertyHelperUpdates(model, ir) {
  const out = [];
  const callMeta = new Map((model.calls || []).map((c) => [c.row, c]));""")
rep('js/dataflow-semantic.js',
"""    const read = /objc_getProperty/.test(name);
    const offsetReg = 'x2';
    const offsetValue = valueBefore(ir, inst, offsetReg);""",
"""    const family = /objc_getProperty/.test(name) ? 'getProperty' : 'setProperty';
    const abi = PROPERTY_HELPER_ABI[family];
    const read = abi.kind === 'read';
    const offsetValue = valueBefore(ir, inst, abi.offsetReg);""")
rep('js/dataflow-semantic.js',
"""      store: { row: inst.row, address: inst.address, reg: read ? 'x0' : 'x3' },
      register: read ? 'x0' : 'x3',""",
"""      store: { row: inst.row, address: inst.address, reg: abi.valueReg },
      register: abi.valueReg,""")

# Existing regression fixture encoded the buggy ABI. Keep it as a real dynamic
# test, but make x2 carry the ivar offset as objc_setProperty actually requires.
rep('tests/run.js',
"""    'ldrsw x3, [x8, #0x20]',
    'b #0x100000100',""",
"""    'ldrsw x2, [x8, #0x20]',
    'b #0x100000100',""", 1)
rep('tests/run.js',
"""  eq(ups[0].kind, 'write', 'objc_setProperty* を getter と逆判定している');
  ok(ups[0].location.indexAddr != null, 'ivar offset variable の場所を失っている');""",
"""  eq(ups[0].kind, 'write', 'objc_setProperty* を getter と逆判定している');
  eq(ups[0].register, 'x3', 'setter の newValue register は x3 でなければならない');
  ok(ups[0].location.indexAddr != null, 'ivar offset variable の場所を失っている');""", 1)

# #306/#308: explicit W-register truncations are semantically necessary, but
# compiler-idiom recognition must be allowed to look through them. The matcher
# uses this only as a view; the actual AST retains the uxt32 node.
rep('js/expr.js',
"""/** `(X >> s) + (X >>> 63)` の形なら、X を割り算として読み直す。 */
function signFix(shifted, signBit) {
  if (!shifted || !signBit) return null;""",
"""function stripPatternUxt32(n) {
  let cur = n;
  while (cur && cur.k === 'un' && cur.op === 'uxt32') cur = cur.a;
  return cur;
}

/** `(X >> s) + (X >>> 63)` の形なら、X を割り算として読み直す。 */
function signFix(shifted, signBit) {
  shifted = stripPatternUxt32(shifted);
  signBit = stripPatternUxt32(signBit);
  if (!shifted || !signBit) return null;""")
rep('js/expr.js',
"""    inner = shifted.a; shift = s;""",
"""    inner = stripPatternUxt32(shifted.a); shift = s;""", 1)

print('full-suite regressions fixed')
