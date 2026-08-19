# Remaining Cross-binary exactness baseline

Production base: `bdf90569ed037a3d30e4439dcde970aad9352e21` (current `main` when this branch was created).

PR #1001 (`kinds`) is already merged and therefore excluded from this branch's ownership.

Known remaining non-exact metrics before this branch:

- BattleCats `funcs-guess`: `0.9968745131640442`.
- TsumTsum `funcs-guess`: `0.9941073795556256`.
- TsumTsum `refs`: `0.9999984721791462` (one oracle-invalid ADRP chain through `add w4,w8,#0xeeb`).
- TsumTsum `objc`: `0.9995778096766023`.
- TsumTsum `selffield`: `0.9987234042553191` (same invalid Swift runtime ivar-offset oracle family as `objc`).
- TsumTsum `apimeaning`: `0.9984817571914346`.
- TsumTsum `summary`: `0.995` (199/200; short selector `new` scorer bug).
- TsumTsum `pseudoc`: `0.9983017952450267`.
- YWP `funcs-guess`: `0.9747791554692281`.
- YWP `apimeaning`: `0.9983282246187818`.
- YWP `pseudoc`: `0.9991771804717499`.

The branch must not manufacture 100% by lowering thresholds, fixture-specific addresses, generic unknown API fallbacks, or suppressing raw assembly. Oracle/scorer errors are corrected only where the claimed truth is statically invalid; product gaps are fixed in production semantics.
