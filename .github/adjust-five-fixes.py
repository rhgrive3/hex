from pathlib import Path

p = Path('.github/apply-five-fixes.py')
s = p.read_text()
old = 'start = text.index("  if (sub === \'fsub\') {")'
new = 'start = text.index("  if (sub === \'fsub\') {", text.index("export function buildNZCVConditionExpression"))'
if s.count(old) != 1:
    raise SystemExit(f'expected one fsub locator, got {s.count(old)}')
s = s.replace(old, new, 1)

old_alias = "    if (storeLoc.kind === MK.FIELD || otherLoc.kind === MK.FIELD) return true;\n    return false;"
new_alias = "    const fieldLoc = storeLoc.kind === MK.FIELD ? storeLoc : otherLoc;\n    const concreteLoc = storeLoc.kind === MK.FIELD ? otherLoc : storeLoc;\n    if (fieldLoc.kind !== MK.FIELD) return false;\n    if (concreteLoc.kind === MK.GLOBAL) return true;\n    if (concreteLoc.kind === MK.STACK) {\n      const provenance = fieldLoc.provenance;\n      const entryDistinct = provenance?.must !== false && ['arg','entry-register'].includes(provenance?.kind);\n      return !entryDistinct;\n    }\n    return true;"
if s.count(old_alias) != 1:
    raise SystemExit(f'expected one cross-kind alias patch body, got {s.count(old_alias)}')
p.write_text(s.replace(old_alias, new_alias, 1))
