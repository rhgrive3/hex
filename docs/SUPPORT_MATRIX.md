# Hex Support Matrix

This document is a human projection of the machine-readable capability truth in `js/platform/capability-maturity.js`.

Do not infer support from the presence of a parser, decoder, adapter, menu item, legacy analysis pipeline, or third-party engine. UI code should consume `supportTruthForImage()` and render it through `supportDisplayForTruth()` instead of inventing support labels.

Status values:

- **Supported** — this stage satisfies the Master Architecture contract for the stated target.
- **Partial** — useful implementation exists, but one or more required parts are incomplete.
- **Unsupported** — the implementation does not provide this stage.
- **Unavailable** — the implementation exists, but a required runtime dependency is unavailable.

`level` is the highest **cumulative fully satisfied** maturity level. `implementedLevel` is the furthest stage with current implementation, including legacy or partial implementation. A target never receives a higher maturity level by skipping an incomplete prerequisite.

## Architecture maturity

| Architecture | Detect | Decode | Exact low-level effects | CFG + Semantic IR | SSA + MemorySSA | Types / interproc | Decompile | Runtime/debug/patch | Maturity level | Implemented through |
|---|---|---|---|---|---|---|---|---|---|---|
| `arm64` | Supported | Supported | **Partial** | Supported | Supported | Supported | Supported | Partial | **A1** | **A6 legacy/partial** |
| `arm64e` | Supported | Supported | **Partial** | Partial | Partial | Partial | Partial | Partial | **A1** | **A6 partial** |
| `x86_64` | Supported | Supported | Unsupported | Unsupported | Unsupported | Unsupported | Unsupported | Unsupported | **A1** | **A1** |
| unknown | Unsupported | Unsupported | Unsupported | Unsupported | Unsupported | Unsupported | Unsupported | Unsupported | none | none |

Important limitations:

- `arm64`: current legacy Semantic IR, SSA/dataflow, and decompiler capability remains available, but Master Architecture A2 specifically requires **Exact Low-Level Effects / MachineEffects**. Phase 2 introduces `MachineEffectBundle`, the ARM64 exact lifter, explicit flags/memory effects, and compatibility lowering. Those contracts are not present in current main, so A2 is **Partial**, not Supported, and cumulative maturity remains **A1**.
- `arm64e`: the same missing exact MachineEffects contract applies, with additional partial pointer-authentication semantics. Its cumulative maturity remains **A1**.
- `x86_64`: the deployed Capstone build can decode it, but Hex does **not** claim semantic lifting, CFG/Semantic IR, SSA/dataflow, or decompiler maturity for x86-64.
- If the decoder is unavailable at runtime, a recognized architecture is downgraded to effective **A0 Detect** and decoder-dependent implemented stages become `unavailable`.

## Native format maturity

| Format | Detect | Parse | Load / mapping | Imports / exports / relocations | Function / debug / unwind | Runtime / language metadata | Validated rebuild / patch | Maturity level | Implemented through |
|---|---|---|---|---|---|---|---|---|---|
| Mach-O | Supported | Supported | Supported | **Partial** | Partial | Partial | Unsupported | **F2** | **F5 partial** |
| ELF | Supported | Supported | Supported | **Partial** | Partial | Unsupported | Unsupported | **F2** | **F4 partial** |
| PE/PE+ | Supported | Supported | Supported | **Partial** | Partial | Unsupported | Unsupported | **F2** | **F4 partial** |

F3 is intentionally conservative. Current loaders do parse substantial import/export/relocation metadata, but source/tests also retain incomplete or unsupported cases, so the full Master Architecture F3 contract is not claimed. Examples include incomplete Mach-O classic/chained binding and export-trie states, ELF partial dynamic metadata paths, and format-specific relocation coverage. F4/F5 remain partial where useful evidence exists without complete debug/unwind or runtime/language coverage. F6 is unsupported.

## Managed / VM frontends

The maturity schema exposes **M0–M6**, but the current support matrix contains no managed frontend entry. DEX/JVM/CIL/WASM must not appear as supported until a real managed frontend is registered and tested.

## Evidence used for current claims

The values above are tied to the Master Architecture definitions plus current source and regression behavior, especially:

- Master Architecture Phase 2 — MachineEffects are a future deliverable, so legacy ARM64 Semantic IR cannot satisfy A2 by itself;
- `js/architecture/index.js` — current architecture adapters and legacy analysis capability;
- `js/platform/capstone-capability.js` + `tests/capstone-capability.mjs` — deployed decoder truth for ARM64 and x86-64;
- current ARM64 Semantic IR / SSA / decompiler regression suites — evidence for implemented legacy A3–A6 functionality, not proof of cumulative A2+ maturity;
- `js/binary/*`, `tests/universal-binary*.mjs`, and `tests/binary-platform.mjs` — mapping, link metadata, function/unwind evidence, plus explicit partial/incomplete parsing cases;
- Objective-C / Swift regression suites — basis for partial Mach-O runtime/language metadata.

When implementation maturity changes, update the machine-readable profile and its tests first. This document is secondary and must never be used as an independent source of support truth.
