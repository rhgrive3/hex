from pathlib import Path


def replace_once(path, old, new):
    p = Path(path)
    text = p.read_text()
    count = text.count(old)
    if count != 1:
        raise SystemExit(f'{path}: expected exactly one post-batch-A match, got {count}: {old[:180]!r}')
    p.write_text(text.replace(old, new, 1))

# #827 — the compatibility projector must canonicalize every precise,
# non-indexed stack-derived public location, including locations that the v2
# projection already classified as STACK but whose disp still reflects the
# local base displacement. MemorySSA identities remain untouched; this only
# repairs the public location coordinate consumed by alias queries.
replace_once(
    'js/ir-core.js',
    "    if (inst.loc?.kind !== LEGACY_MK.UNKNOWN || inst.addr?.precise !== true || inst.addr.index != null) continue;",
    "    if ((inst.loc?.kind !== LEGACY_MK.UNKNOWN && inst.loc?.kind !== LEGACY_MK.STACK) || inst.addr?.precise !== true || inst.addr.index != null) continue;",
)

# A same canonical stack start may have distinct public location objects for
# distinct access widths, but those objects must remain in one canonical stack
# region. Prefer the region already published at the canonical key when it is
# a matching stack coordinate, even if size forces a size-qualified key.
replace_once(
    'js/ir-core.js',
'''      const existingMatches = !!existing && existing.kind === LEGACY_MK.STACK
        && existing.disp != null && BigInt(existing.disp) === offset
        && (existing.size == null || size == null || Number(existing.size) === Number(size));
      const locKey = existing && !existingMatches ? `${key}:s${size ?? '?'}:compat` : key;
      const loc = existingMatches ? existing : {
        key: locKey,
        kind: LEGACY_MK.STACK,
        disp: offset,
        size,
        regionId: inst.loc?.regionId ?? null,''',
'''      const sameCanonicalCoordinate = !!existing && existing.kind === LEGACY_MK.STACK
        && existing.disp != null && BigInt(existing.disp) === offset;
      const existingMatches = sameCanonicalCoordinate
        && (existing.size == null || size == null || Number(existing.size) === Number(size));
      const locKey = existing && !existingMatches ? `${key}:s${size ?? '?'}:compat` : key;
      const canonicalRegionId = sameCanonicalCoordinate
        ? (existing.regionId ?? inst.loc?.regionId ?? null)
        : (inst.loc?.regionId ?? null);
      const loc = existingMatches ? existing : {
        key: locKey,
        kind: LEGACY_MK.STACK,
        disp: offset,
        size,
        regionId: canonicalRegionId,''')

print('guarded batch A3 public stack-coordinate canonicalization applied')
