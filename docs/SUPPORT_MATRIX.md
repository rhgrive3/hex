# Hex Support Matrix

This document is a human projection of the machine-readable capability truth in `js/platform/capability-maturity.js`.

Do not infer support from the presence of a parser, decoder, adapter, menu item, or third-party engine. UI code should consume `supportTruthForImage()` and render it through `supportDisplayForTruth()` instead of inventing support labels.

Status values:

- **Supported** — this stage is implemented for the stated target.
- **Partial** — useful implementation exists, but the listed limitation prevents a full claim.
- **Unsupported** — the implementation does not provide this stage.
- **Unavailable** — the implementation exists, but a required runtime dependency such as the deployed decoder is unavailable.

`level` is the furthest implemented stage. `fullySatisfiedLevel` is the highest cumulative stage with no known gap. This distinction is important for `arm64e` and partially mature formats.

## Architecture maturity

| Architecture | Detect | Decode | Lift / exact effects | CFG + Semantic IR | SSA + MemorySSA | Types / interproc | Decompile | Runtime/debug/patch | Level | Fully satisfied |
|---|---|---|---|---|---|---|---|---|---|---|
| `arm64` | Supported | Supported | Supported | Supported | Supported | Supported | Supported | Partial | **A6** | **A6** |
| `arm64e` | Supported | Supported | Partial | Partial | Partial | Partial | Partial | Partial | **A6 Partial** | **A1** |
| `x86_64` | Supported | Supported | Unsupported | Unsupported | Unsupported | Unsupported | Unsupported | Unsupported | **A1** | **A1** |
| unknown | Unsupported | Unsupported | Unsupported | Unsupported | Unsupported | Unsupported | Unsupported | Unsupported | none | none |

Important limitations:

- `arm64e`: pointer-authentication data semantics remain partial. Downstream analysis therefore stays explicitly partial even though the ARM64 pipeline can process many functions.
- `x86_64`: the deployed Capstone build can decode it, but Hex does **not** claim semantic lifting, CFG/Semantic IR, SSA/dataflow, or decompiler maturity for x86-64.
- If the decoder is unavailable at runtime, a recognized architecture is downgraded to effective **A0 Detect** and all decoder-dependent implemented stages become `unavailable`.
- `arm64` does not claim A7; runtime/debug/patch validation is only partial.

## Native format maturity

| Format | Detect | Parse | Load / mapping | Imports / exports / relocations | Function / debug / unwind | Runtime / language metadata | Validated rebuild / patch | Level | Fully satisfied |
|---|---|---|---|---|---|---|---|---|---|
| Mach-O | Supported | Supported | Supported | Supported | Partial | Partial | Unsupported | **F5 Partial** | **F3** |
| ELF | Supported | Supported | Supported | Supported | Partial | Unsupported | Unsupported | **F4 Partial** | **F3** |
| PE/PE+ | Supported | Supported | Supported | Supported | Partial | Unsupported | Unsupported | **F4 Partial** | **F3** |

The F4 rows are deliberately conservative. Current loaders/tests cover function-boundary and unwind/debug-related evidence to varying degrees, but this matrix does not claim complete universal DWARF/PDB/debug ingestion. F6 is unsupported because Hex does not yet provide validated format rebuild/patch semantics as defined by the Master Architecture.

## Managed / VM frontends

The maturity schema exposes **M0–M6**, but the current support matrix contains no managed frontend entry. DEX/JVM/CIL/WASM must not appear as supported until a real managed frontend is registered and tested. Container parsing elsewhere in the product is not sufficient to mint M0+ support.

## Evidence used for current claims

The values above are tied to current source and regression behavior, especially:

- `js/architecture/index.js` — current architecture adapters and legacy decode/dataflow capability behavior;
- `js/platform/capstone-capability.js` + `tests/capstone-capability.mjs` — deployed decoder truth for ARM64 and x86-64;
- ARM64 Semantic IR / SSA / decompiler regression suites invoked by `npm run check`;
- `js/binary/*`, `tests/universal-binary*.mjs`, and `tests/binary-platform.mjs` — Mach-O/ELF/PE mapping, link metadata, function/unwind evidence, and source-backed loading;
- Objective-C / Swift regression suites — basis for the intentionally partial Mach-O runtime/language metadata claim.

When implementation maturity changes, update the machine-readable profile and its tests first. This document is secondary and must never be used as an independent source of support truth.
