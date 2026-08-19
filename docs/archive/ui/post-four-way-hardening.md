# Post-four-way hardening

This pass audits the merged Decompiler, Runtime, Recognition/Knowledge and canonical UI work as one product rather than as four isolated branches.

## Correctness fixes

- Canonical Investigate now calls the Goal Compiler directly. It no longer opens a legacy Sheet, scrapes its search input, and synthesizes an Enter key event.
- Function Runtime now uses `RuntimeAnalysisPlatform` through a narrow App I/O bridge for local observations; the old debugger remains an explicit advanced fallback.
- Function Evidence now surfaces deterministic analysis evidence, runtime evidence, rewrite proofs and warnings instead of three synthetic summary rows only.
- Function Overview exposes conservative Recognition classification/subsystem evidence without presenting uncalibrated scores as probabilities.
- ARM64-only fixed-row mappings are capability-gated so non-ARM64 binaries are not silently treated as four-byte instruction streams.

## Scale fixes

- Explorer no longer truncates functions to 600/1000 rows.
- `VirtualList` accepts a lazy `{ length, itemAt(index) }` source, so all ~100k–300k functions remain reachable without allocating a JS object for every function up front.
- String search no longer hard-caps matches at 1000 after strings are already materialized by the analysis cache.

## UI regression reliability

The merged UI PR had one red browser-matrix job caused by generic Chromium `Failed to load resource` console messages with no URL. The test now:

- ignores only that URL-less generic console form;
- independently fails on every same-origin HTTP >=400 response, with the exact URL;
- fails on same-origin request failures, also with the URL.

External font/CDN failures can therefore no longer create opaque false failures, while missing Hex assets remain hard failures.

## Regression contract

`tests/ui/integration-hardening.mjs` protects the important integration boundaries: no legacy Investigate DOM injection, Runtime Platform wiring, runtime evidence exposure, Recognition wiring, and removal of the old Explorer caps.
