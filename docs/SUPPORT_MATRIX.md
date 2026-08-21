# Hex Support Matrix

This document is a human projection of the machine-readable capability truth in `js/platform/capability-maturity.js`.

Do not infer support from the presence of a parser, decoder, adapter, menu item, legacy analysis pipeline, or third-party engine. UI code should consume `supportTruthForImage()` and render it through `supportDisplayForTruth()` instead of inventing support labels.

Status values:

- **Supported** — this stage satisfies the Master Architecture contract for the stated target.
- **Partial** — useful implementation exists, but one or more required parts are incomplete.
- **Unsupported** — the implementation does not provide this stage.
- **Unavailable** — the implementation exists, but a required runtime dependency is unavailable.

`level` is the highest **cumulative fully satisfied** maturity level. `implementedLevel` is the furthest stage with current implementation, including compatibility or partial implementation. A target never receives a higher maturity level by skipping an incomplete prerequisite.

## Architecture maturity

| Architecture | Detect | Decode | Exact low-level effects | CFG + Semantic IR | SSA + MemorySSA | Types / interproc | Decompile | Runtime/debug/patch | Maturity level | Implemented through |
|---|---|---|---|---|---|---|---|---|---|---|
| `arm64` | Supported | Supported | **Partial** | Supported | Supported | Supported | Supported | Partial | **A1** | **A6 legacy/partial** |
| `arm64e` | Supported | Supported | **Partial** | Partial | Partial | Partial | Partial | Partial | **A1** | **A6 partial** |
| `x86_64` | Supported | Supported | **Partial** | Supported | Supported | **Partial** | Supported | Unsupported | **A1** | **A6** |
| `riscv64` | Supported | Supported | **Partial** | Supported | Supported | **Partial** | Supported | Unsupported | **A1** | **A6** |
| unknown | Unsupported | Unsupported | Unsupported | Unsupported | Unsupported | Unsupported | Unsupported | Unsupported | none | none |

Important limitations:

- `arm64`: current Semantic IR/SSA/dataflow/decompiler capability remains available through the compatibility facade, with the legacy ARM64 path retained as an explicit oracle. Master Architecture A2 specifically requires **Exact Low-Level Effects / MachineEffects**. `MachineEffectBundle`, the ARM64 exact lifter, and compatibility lowering are present, but their instruction coverage is incomplete, so A2 is **Partial**, not Supported, and cumulative maturity remains **A1**.
- `arm64e`: the same incomplete exact MachineEffects contract applies, with additional partial pointer-authentication semantics. Its cumulative maturity remains **A1**.
- `x86_64`: Phase 5 takes all 144 mandatory compiler-corpus tuples through exact MachineEffects, Semantic IR, CFG, SSA, MemorySSA and the shared decompiler, so the implemented depth is **A6**. Exactness is proven for that corpus, not for the whole instruction set, so A2 remains **Partial** and cumulative maturity remains **A1**.
- `riscv64`: Phase 6 takes 264 mandatory tuples — two ELF targets (`ET_EXEC` and PIE `ET_DYN`) across six optimization levels — through the same generic middle-end, with an independent LLVM disassembly oracle and a Capstone structured-operand differential. The frozen profile is **RV64IMC / LP64 (soft float), little-endian, ELFCLASS64**. The A, F, D, Q and V extensions, Zicsr, and the privileged architecture are explicitly outside it and are **Unsupported**; `lp64f`/`lp64d` are recognized from ELF `e_flags` but classify only integer arguments exactly. Cumulative maturity is therefore **A1**, with implemented depth **A6**. Hex emits the canonical id `riscv64`; a width-ambiguous `riscv` is deliberately not an alias, and RV32 is not supported.
- No architecture reaches A2 cumulatively yet. `Implemented through` is the furthest stage with a working implementation; `Maturity level` is the highest **cumulative fully satisfied** level, and it never skips an incomplete prerequisite.
- If the decoder is unavailable at runtime, a recognized architecture is downgraded to effective **A0 Detect** and decoder-dependent implemented stages become `unavailable`.

## Native format maturity

| Format | Detect | Parse | Load / mapping | Imports / exports / relocations | Function / debug / unwind | Runtime / language metadata | Validated rebuild / patch | Maturity level | Implemented through |
|---|---|---|---|---|---|---|---|---|---|
| Mach-O | Supported | Supported | Supported | **Partial** | Partial | Partial | Unsupported | **F2** | **F5 partial** |
| ELF | Supported | Supported | Supported | **Partial** | Partial | Unsupported | Unsupported | **F2** | **F4 partial** |
| PE/PE+ | Supported | Supported | Supported | **Partial** | Partial | Unsupported | Unsupported | **F2** | **F4 partial** |

F3 is intentionally conservative. Current loaders do parse substantial import/export/relocation metadata, but source/tests retain incomplete or unsupported cases, so the full Master Architecture F3 contract is not claimed. Mach-O regression tests explicitly exercise incomplete classic binding, export-trie cycles, unsupported chained pointer formats, and incomplete chained symbols. ELF regression tests preserve partial dynamic-metadata paths. PE parses imports, exports, delay imports, and base relocations, but there is no source/test basis for claiming complete relocation/import/export coverage across the PE contract. F4/F5 remain partial where useful evidence exists without complete debug/unwind or runtime/language coverage. F6 is unsupported.

## Managed / VM frontends

| Frontend | Detect container | Metadata | VMEffects | CFG + SSA | Types / interproc | Decompiler | Runtime / debug | Maturity level | Implemented through |
|---|---|---|---|---|---|---|---|---|---|
| `wasm` | Supported | Supported | Supported | Supported | Supported | Supported | Unsupported | **M5** | **M5** |
| `dex` | Supported | Supported | Supported | Supported | Supported | Supported | Unsupported | **M5** | **M5** |
| `cil` | Supported | Supported | Supported | Supported | Supported | Supported | Unsupported | **M5** | **M5** |
| `jvm` | Supported | Supported | Supported | Supported | Supported | Supported | Unsupported | **M5** | **M5** |

Phase 11 implements first-class managed frontends for WASM, DEX, CLR/CIL, and JVM. Each frontend decodes VM operations, produces exact low-level `VMEffects`, lowers to shared Semantic IR/CFG/SSA, and performs type/interprocedural analysis and decompilation via the shared middle-end. M6 (runtime debugging and live provider integration) is deferred pending Phase 10 provider contracts and evidence-bound runtime module bindings.


## Phase 12 maturity

Phase 12 currently exposes only bounded, low-authority paths. Package-derived
knowledge remains suggestion-level until explicit local promotion; capability
rules produce deterministic evidence rather than verified authority; local
ChangeLog replay is canonical only on the local project and has no remote
transport claim; patterns are read-only; and rebuild remains an R0 shadow path.
No Phase 12 row below claims general remote collaboration, arbitrary pattern
execution, or format-wide validated rebuilding.

| Capability | Current state | Authority | Known limitation |
|---|---|---|---|
| Knowledge packages / recognition | Partial | Suggestion only | `hex-knowledge-pack` v2 compatibility and local evidence precedence are required |
| Capability rules | Partial | Deterministic evidence only | Partial upstream analysis remains partial; AI cannot mint facts |
| Collaboration / ChangeLog | Partial | Local canonical only | Remote security gate and derived-artifact exclusion remain required |
| Declarative patterns | Partial | Bounded read-only evidence | No arbitrary JavaScript or loader-semantic mutation |
| Rebuild | Partial | R0 shadow plan | Operation/profile validators and explicit atomic publication are required |

These Phase 12 values are projected from `phase12Maturity()` in
`js/platform/capability-maturity.js`; they are intentionally conservative and
must not be rounded up to `supported` by UI or release evidence.

## Evidence used for current claims

The values above are tied to the Master Architecture definitions plus current source and regression behavior, especially:

- Master Architecture A2 requires complete exact Low-Level Effects / MachineEffects coverage. MachineEffects implementations now exist, but incomplete ISA coverage means legacy or corpus-proven later-stage functionality cannot by itself satisfy cumulative A2;
- `js/architecture/index.js` — current architecture adapters and compatibility analysis capability;
- `js/platform/capstone-capability.js` + `tests/capstone-capability.mjs` — deployed decoder truth for ARM64 and x86-64;
- `tools/validation/phase6/profile.json` — the frozen Phase 6 RISC-V ISA/ABI/toolchain/decoder/corpus identities, including the deployed `capstone.js`/`capstone.wasm` hashes the RISC-V claim is bound to;
- `tests/phase5/verification/compiler-corpus-pipeline.test.mjs` and `tests/phase6/verification/compiler-corpus-pipeline.test.mjs` — the mandatory compiler-corpus gates behind the x86-64 and RISC-V claims;
- `tests/phase6/foundation/capability-truth.test.mjs` — pins these declarations to that evidence, so a stale claim fails instead of going unnoticed;
- current ARM64 Semantic IR / SSA / decompiler regression suites — evidence for implemented A3–A6 functionality, not proof of cumulative A2+ maturity;
- `js/binary/*`, `tests/universal-binary*.mjs`, and `tests/binary-platform.mjs` — mapping, link metadata, function/unwind evidence, plus explicit partial/incomplete parsing cases;
- Objective-C / Swift regression suites — basis for partial Mach-O runtime/language metadata.

When implementation maturity changes, update the machine-readable profile and its tests first. This document is secondary and must never be used as an independent source of support truth.
