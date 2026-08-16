# Migration Guardrails

This document records compatibility contracts that protect the current Hex implementation while it migrates toward `HEX_MASTER_ARCHITECTURE.md`.

The guardrails are intentionally narrow. They protect proven public seams and safety properties without freezing the temporary implementation layout.

## Protected compatibility contracts

| Area | Contract | Gate |
|---|---|---|
| Semantic facade | `js/ir.js` remains the public compatibility boundary and keeps the selected legacy semantic query exports | `tests/migration-guardrails.mjs` |
| Alias safety | Unknown memory locations are never `MustAlias`, but remain `MayAlias`; an unknown store between a proof source and sink is a barrier | migration guardrail + `semantic:test` |
| Decompiler | `js/decompiler/pipeline-core.js` consumes semantic analysis and does not read instruction mnemonic/operand text or decoder/backend internals | dependency/static guardrail + `decompiler:test` |
| Project exchange | `.hexproj` v1 import/export remains supported; derived cache state stays referenced rather than owned by the exchange layer | migration guardrail + `project-roundtrip.mjs` |
| Plugin API v1 | Existing registration entry points remain available. New contribution types may be additive | migration guardrail + `plugin-platform.mjs` |
| Runtime evidence | Runtime evidence refines/contradicts a static candidate without mutating the static candidate | migration guardrail + `runtime-evidence-fusion.mjs` |
| AI mutation | Mutation remains evidence-backed proposal -> explicit approval token -> approval-gated `CapabilityExecutor` -> mutation adapter | migration guardrail + `ai:test` |
| Source-backed loader | Native loaders continue to support bounded range reads without retaining a whole-file byte array | `binary:source-test` |
| ARM64 behavior | Current semantic/decompiler/compiler-truth regressions remain mandatory during migration | `semantic:test` + `decompiler:test` |

## Dependency boundary checks

`tests/migration-guardrails.mjs` rejects these new direct dependencies:

- generic semantic facade/dataflow modules -> architecture-specific target implementations;
- `js/project/**` -> derived cache or ArtifactStore implementation;
- UI modules -> `js/ir-core.js` or `js/decompiler/pipeline-core.js` private internals;
- AI modules other than the existing approval-gated `js/ai/capabilities/executor.js` -> direct binary patch implementation;
- semantic decompiler core -> architecture decoder/backend implementation.

The sanctioned AI mutation executor is separately checked for `requiresApproval` and proposal-scoped authorization before execution. These checks inspect narrow module dependencies and concrete authorization behavior instead of broad keywords. This limits false positives.

## Deliberate migration exceptions

These are current debt, not approved patterns for new code:

- `js/ir-core.js` is excluded from the architecture-import boundary because Master Architecture section 35 explicitly defines it as the temporary mixed legacy core. The guardrail must move when that core is split; it must not force Phase 1-3 work into Phase 0.
- Architecture/compiler-specific decompiler idioms may remain refinement providers. They must not become a second instruction-decoding path.
- `analysis.cacheReferences` in `.hexproj` v1 is allowed. It is a reference to derived analysis, not ownership of an ArtifactStore.
- Public API tests assert required exports, not the complete export set. Additive compatibility changes therefore remain possible.

## CI

`npm run migration:test` runs the focused contracts.

`npm run check` includes `migration:test`, so every existing general check also enforces the guardrails.

The `Migration guardrails` workflow additionally runs the migration test, the required semantic/decompiler/platform/runtime/AI suites, and the source-backed binary loader regression on pull requests that touch migration-sensitive paths.

## Review rule

A migration change may update a guardrail only when the old contract has a tested compatibility adapter or a completed differential cutover. Do not delete a failing guardrail only to make a migration PR green.

When a protected public seam is intentionally retired, first add the replacement compatibility test, prove the required corpus on the replacement path, and only then narrow or remove the old guardrail.
