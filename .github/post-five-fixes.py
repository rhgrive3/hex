from pathlib import Path

p = Path('js/architecture/compat/ir-core-arm64-aapcs64-v1.js')
s = p.read_text()

needle = "/** 2 つの場所が同じ番地を指しうるか。「別」と言い切れるときだけ false。 */\nexport function mayAlias(a, b) {"
helper = """function fieldProvenDisjointFromCurrentStack(fieldLoc) {
  if (!fieldLoc || fieldLoc.kind !== MK.FIELD) return false;
  const provenance = fieldLoc.provenance;
  if (provenance?.must !== false && ['arg','entry-register'].includes(provenance?.kind)) return true;
  const base = fieldLoc.rawBase || fieldLoc.base;
  const reg = String(base?.reg || '');
  return base?.kind === VK.ARG && /^(?:x[0-9]|x[12][0-9]|x30)$/.test(reg) && reg !== 'sp' && reg !== 'x29';
}

function differentKindsProvenDistinct(a, b) {
  if (!a || !b || a.kind === b.kind) return false;
  const fieldLoc = a.kind === MK.FIELD ? a : (b.kind === MK.FIELD ? b : null);
  if (!fieldLoc) return true; // STACK and GLOBAL are distinct storage classes.
  const otherLoc = fieldLoc === a ? b : a;
  return otherLoc.kind === MK.STACK && fieldProvenDisjointFromCurrentStack(fieldLoc);
}

/** 2 つの場所が同じ番地を指しうるか。「別」と言い切れるときだけ false。 */
export function mayAlias(a, b) {"""
if s.count(needle) != 1:
    raise SystemExit(f'expected mayAlias insertion point once, got {s.count(needle)}')
s = s.replace(needle, helper, 1)

old_public = """  if (a.kind !== b.kind) {
    // stack と global は決して重ならない。field は何にでも化けうる。
    if (a.kind === MK.FIELD || b.kind === MK.FIELD) return true;
    return false;
  }"""
new_public = """  if (a.kind !== b.kind) return !differentKindsProvenDistinct(a, b);"""
if s.count(old_public) != 1:
    raise SystemExit(f'expected public cross-kind alias block once, got {s.count(old_public)}')
s = s.replace(old_public, new_public, 1)

old_store = """  if (storeLoc.kind !== otherLoc.kind) {
    const fieldLoc = storeLoc.kind === MK.FIELD ? storeLoc : otherLoc;
    const concreteLoc = storeLoc.kind === MK.FIELD ? otherLoc : storeLoc;
    if (fieldLoc.kind !== MK.FIELD) return false;
    if (concreteLoc.kind === MK.GLOBAL) return true;
    if (concreteLoc.kind === MK.STACK) {
      const provenance = fieldLoc.provenance;
      const entryDistinct = provenance?.must !== false && ['arg','entry-register'].includes(provenance?.kind);
      return !entryDistinct;
    }
    return true;
  }"""
new_store = """  if (storeLoc.kind !== otherLoc.kind) return !differentKindsProvenDistinct(storeLoc, otherLoc);"""
if s.count(old_store) != 1:
    raise SystemExit(f'expected store cross-kind alias block once, got {s.count(old_store)}')
s = s.replace(old_store, new_store, 1)
p.write_text(s)

# Align the generated focused regression with the shared invariant.
t = Path('tests/semantic-v2/issues-828-832-860-867-880.test.mjs')
ts = t.read_text()
old_assert = "assert.match(legacy, /storeLoc\\.kind !== otherLoc\\.kind[\\s\\S]*concreteLoc\\.kind === MK\\.GLOBAL\\) return true[\\s\\S]*concreteLoc\\.kind === MK\\.STACK[\\s\\S]*entryDistinct/);"
new_assert = "assert.match(legacy, /fieldProvenDisjointFromCurrentStack[\\s\\S]*differentKindsProvenDistinct[\\s\\S]*mayAlias\\(a, b\\)[\\s\\S]*!differentKindsProvenDistinct\\(a, b\\)[\\s\\S]*storeOverlapsRange[\\s\\S]*!differentKindsProvenDistinct\\(storeLoc, otherLoc\\)/);"
if ts.count(old_assert) != 1:
    raise SystemExit(f'expected issue 832 focused assertion once, got {ts.count(old_assert)}')
t.write_text(ts.replace(old_assert, new_assert, 1))
