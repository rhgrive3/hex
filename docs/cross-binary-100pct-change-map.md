# Cross-binary 100% change map

Base: `main` at `bdf90569ed037a3d30e4439dcde970aad9352e21`.

This branch is intentionally split by accuracy feature so a future rebase/conflict can be repaired by re-applying one narrow change at a time. PR #1001 already owns `kinds`; this branch does not duplicate it.

## Change ownership

| Metric | Production/oracle owner | Intended change | Conflict repair recipe |
|---|---|---|---|
| `refs` | `tests/oracle-cfg-normalize.py` | Keep ADRP provenance 64-bit only, clear on skipdata/undecodable barriers, and retain only mapped Mach-O targets. | Re-apply only the provenance width/barrier/mapped-target checks in the oracle normalizer. Do not touch worker xref routing. |
| `objc`, `selffield` | oracle normalization | Drop impossible static ivar offsets (`offset >= instanceSize` or sanity-cap breach); dynamic Swift offsets remain unknown, not exact truth. | Re-apply the ivar trust predicate where the generated oracle is normalized. Do not weaken `js/objc-legacy.js`. |
| `summary` | `tests/accuracy.mjs` scorer | Preserve >=4 loose substring matching; add boundary/quoted exact matching for short selectors such as `new`. | Re-apply only the short-selector predicate in summary scoring. Product narration is already correct. |
| `apimeaning` | API semantic table | Add truthful ABI-aware OpenGL ES, POSIX/libc/stdio/math and nanopb entries observed as unknown in the pinned fixtures. No generic unknown fallback. | Re-apply table entries; no control-flow/decompiler changes required. |
| `pseudoc` | decompiler semantic coverage | Add semantic lowering for FCSEL, REV, FCVTAS, vector MOVI and FCCMP so supported instructions no longer fall through to raw `__asm`. | Re-apply handlers by mnemonic in the semantic/decompiler extension point. Never suppress unknown assembly globally. |
| `funcs-guess` | new isolated worker override | Preserve provenance of broad `__DATA_CONST,__const` image-relative candidates and prevent `raw-u32 + immediately-after-BR` from becoming independent strong evidence without a second source. | Re-apply only the late `__functionEvidence` wrapper/import. Do not use the rejected blanket post-BR filter. |
| `kinds` | PR #1001 (already merged) | No change in this branch. | Keep `worker-kind-fix.js` from main. |

## funcs-guess invariant

The key invariant is **independent evidence, not evidence count**. A raw 32-bit word from `__DATA_CONST,__const` that lands in `__text` and is also immediately after an indirect branch is one physical fact chain, not two independent signals. Exact metadata, unwind, direct-call target, recognized prologue, validated thunk/repeated-thunk evidence, or another separately-derived boundary may corroborate it.

Rejected and must not be reintroduced:

- dropping every function start after `b`/`br`/`ret`;
- rejecting all `data + structured + indirectTerminalStart` candidates globally;
- lowering accuracy thresholds;
- generic `apiInfo()` fallback for all imports;
- hiding `__asm` without implementing instruction semantics.

## Validation target

Run only the Cross-binary accuracy gate for BattleCats, TsumTsum and YWP while this draft is being developed. Each changed metric must report exact score `1.0` before the draft is considered mergeable; unchanged metrics must not regress.
