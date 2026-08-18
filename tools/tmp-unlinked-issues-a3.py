from pathlib import Path


def replace_once(path, old, new):
    p = Path(path)
    text = p.read_text()
    count = text.count(old)
    if count != 1:
        raise SystemExit(f'{path}: expected exactly one post-batch-A match, got {count}: {old[:180]!r}')
    p.write_text(text.replace(old, new, 1))

# #827 — canonicalize every precise non-indexed stack-derived public location,
# including locations already classified as STACK by v2. This changes only the
# public SP-relative coordinate; MemorySSA/region identities remain untouched.
replace_once(
    'js/ir-core.js',
    "    if (inst.loc?.kind !== LEGACY_MK.UNKNOWN || inst.addr?.precise !== true || inst.addr.index != null) continue;",
    "    if ((inst.loc?.kind !== LEGACY_MK.UNKNOWN && inst.loc?.kind !== LEGACY_MK.STACK) || inst.addr?.precise !== true || inst.addr.index != null) continue;",
)

print('guarded batch A3 public stack-coordinate canonicalization applied')
