from pathlib import Path

p = Path('tools/apply-latest-issue-fixes.py')
s = p.read_text()

# findXrefs does not currently propagate ADD-produced provenance to pair.rd, so the
# original patcher tried to replace a block that does not exist. The preceding
# replacement already converts its ADRP state to the shared path-aware contract.
needle = "replace_once('js/worker-legacy.js', \"\"\"        if (!pair.load && !pair.store) {"
start = s.find(needle)
if start < 0:
    raise SystemExit('hotfix: stale xref propagation patch not found')
end_marker = "\n\n# String scan result metadata for both engines."
end = s.find(end_marker, start)
if end < 0:
    raise SystemExit('hotfix: xref patch end marker not found')
s = s[:start] + s[end:]

# Keep the prefix bucket as the fast first pass, but preserve substring semantics
# by falling back to the full pre-normalized index only when needed.
s = s.replace(
    "  const source = q.length >= 3 ? (index.prefix.get(q.slice(0, 3)) || index.records) : index.records;\n",
    "  const prefixSource = q.length >= 3 ? (index.prefix.get(q.slice(0, 3)) || []) : index.records;\n",
    1,
)
s = s.replace(
    "  const collect = async (prefixOnly) => {\n    for (let i = 0; i < source.length && out.length < limit; i++) {\n      if ((i & (YIELD_EVERY - 1)) === 0) await yieldControl(signal);\n      const row = source[i];\n",
    "  const collect = async (source, prefixOnly) => {\n    for (let i = 0; i < source.length && out.length < limit; i++) {\n      if ((i & (YIELD_EVERY - 1)) === 0) await yieldControl(signal);\n      const row = source[i];\n",
    1,
)
s = s.replace(
    "  await collect(true);\n  if (out.length < limit) await collect(false);\n",
    "  await collect(prefixSource, true);\n  if (out.length < limit) await collect(index.records, false);\n",
    1,
)

# A stale ADRP value must not survive a long straight-line gap into an adjacent
# function. Keep the shared path-aware contract fail-closed even when metadata
# does not expose an explicit function boundary to the worker scan.
s = s.replace(
    "function addressProvenanceBase(state, reg, index, window = PAIR_WINDOW) {",
    "function addressProvenanceBase(state, reg, index, window = 16) {",
    1,
)

# Ambiguous Objective-C ownership remains visible even when a separate recovered
# summary exists; the summary's certainty and the owner candidates are independent.
s = s.replace(
    "    if (!recovered && ownerFact.candidates.length > 1) {",
    "    if (ownerFact.candidates.length > 1) {",
    1,
)

# The old UX check hard-coded the unsafe rule that every displayed function name
# is Confirmed. #558 intentionally replaces that with provenance-aware semantics,
# so update the architecture assertion to guard the new contract instead.
marker = "# ---------------------------------------------------------------------------\n# Regression tests and test-suite registration"
injection = r'''# #558: the UX architecture test must assert provenance semantics, not the old
# unconditional Confirmed-name source string.
replace_once('tests/ux.mjs',
  "check('evidence semantic state is separate from ranking', product.includes(\"evidenceBadge('confirmed'\") && product.includes(\"evidenceBadge(name ? 'confirmed' : 'unverified')\"));",
  "check('evidence semantic state is separate from ranking', product.includes('functionEvidence?.(addr)') && product.includes('nameEvidence?.(addr)') && product.includes('provenanceStatus(nameEvidence)'));",
)

'''
if marker not in s:
    raise SystemExit('hotfix: regression-test marker not found')
s = s.replace(marker, injection + marker, 1)

p.write_text(s)
print('hotfixed issue patcher')
