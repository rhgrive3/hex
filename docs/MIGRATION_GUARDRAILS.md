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

These are current debt or compatibility seams, not approved patterns for new code:

- `js/ir-core.js` is now a **compatibility facade** whose production default is Semantic IR v2 compatibility. The legacy ARM64/AAPCS64 implementation remains available only as an explicit compatibility/oracle path through `js/architecture/compat/ir-core-arm64-aapcs64-v1.js`. The old exception that treated `js/ir-core.js` itself as the temporary mixed legacy core is retired. New generic code MUST NOT import the architecture-specific compatibility implementation directly; compatibility exports may remain at the public facade until their tested consumers are migrated.
- Architecture/compiler-specific decompiler idioms may remain refinement providers. They must not become a second instruction-decoding path.
- `analysis.cacheReferences` in `.hexproj` v1 is allowed. It is a reference to derived analysis, not ownership of an ArtifactStore.
- Public API tests assert required exports, not the complete export set. Additive compatibility changes therefore remain possible.

## CI

`npm run migration:test` runs the focused contracts.

`npm run check` includes `migration:test`, so every existing general check also enforces the guardrails.

The `Migration guardrails` workflow additionally runs the migration test, the required semantic/decompiler/platform/runtime/AI suites, and the source-backed binary loader regression on pull requests that touch migration-sensitive paths.

## Engineering-process guardrails

Architecture compatibility is not sufficient by itself. Phase 3, Phase 4, and Phase 5 showed that a correct implementation can still lose large amounts of time through late integration, contradictory ownership, stale generated output, weak exact-head evidence, moving-main churn, target-platform assumptions, or a verifier that matures only at final release.

`docs/ENGINEERING_PROCESS_GUARDRAILS.md` is therefore a second normative migration contract. Master-phase, integration, release, generated-output, exact-SHA verification, Dev Supervisor, and iOS/browser work MUST follow it.

In particular:

- a migration guardrail MUST NOT be weakened to work around an ownership, generated-output, workflow-trigger, or integration-process defect;
- repeated process defects MUST gain permanent automated regressions where technically possible;
- component correctness does not substitute for candidate-merge-tree and living-integration correctness;
- a final verifier change that changes acceptance semantics invalidates affected historical evidence;
- a source merge is not proof that the deployed/in-memory runtime has activated that source.

## Review rule

A migration change may update a guardrail only when the old contract has a tested compatibility adapter or a completed differential cutover. Do not delete a failing guardrail only to make a migration PR green.

When a protected public seam is intentionally retired, first add the replacement compatibility test, prove the required corpus on the replacement path, and only then narrow or remove the old guardrail.
