from pathlib import Path

# Core RMW must use the memory version immediately preceding the final store.
p = Path('js/ir-core.js')
s = p.read_text()
guard = "if (!store.memDef || !load.memUse || load.memUse !== store.memDef.prev) continue;"
if guard not in s:
    start = s.index('export function readModifyWrite')
    pos = s.index('    if (!load) continue;', start)
    insert = pos + len('    if (!load) continue;')
    s = s[:insert] + "\n    // Same-location is not enough: reject stale loads across intervening writes.\n    " + guard + s[insert:]
    p.write_text(s)

# The public provenance-aware RMW fallback must enforce the same Memory-SSA proof.
p = Path('js/ir.js')
s = p.read_text()
needle = 'const currentMemoryVersion = !!(store.memDef && def.memUse && def.memUse === store.memDef.prev);'
if needle not in s:
    old = """      if (def.op === OP.LOAD) {
        if (mustAlias(def.loc, store.loc) && !unknownStoreBetween(ir, def, store)) load = def;
        continue;
      }"""
    new = """      if (def.op === OP.LOAD) {
        // Proven aliasing is insufficient for RMW: the load must observe the
        // exact memory version immediately preceding this store (#407).
        const currentMemoryVersion = !!(store.memDef && def.memUse && def.memUse === store.memDef.prev);
        if (currentMemoryVersion && mustAlias(def.loc, store.loc) && !unknownStoreBetween(ir, def, store)) load = def;
        continue;
      }"""
    if old not in s:
        raise SystemExit('public RMW anchor missing')
    p.write_text(s.replace(old, new, 1))
