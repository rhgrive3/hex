# Phase 8 release evidence — BLOCKING

- product: `baecce647833e43a9bbf7024ca903d6e99cccf33` (tree `c9ed566d39f2344e7c6b1534f4b93d7a2fe07274`, branch `phase8/decompiler-quality`, clean: false)
- verifier: phase8.verifier 1.0.0 (source sha256 `524b1e3ce071f4d8`)
- profile version: 2
- corpus: phase8-decompiler-quality-corpus v1, digest `37c049e8ed51a7f0d46538a894be3c7b`
- toolchain: Ubuntu clang version 18.1.3 (1ubuntu1) (aarch64-unknown-linux-gnu)
- baseline: `4f287eb84c083c404474e0cfd8d97a17` captured at `bd03d1a860863814dbdcc00559709794d460189d`
- pass registry: `ae6a20556477af22d93d8a34ab8e2249` (phase8.identity@1.0.0, phase8.sccp@1.0.0)

## Hard-zero safety counters

| counter | value |
|---|---|
| semanticMismatchCount | 0 |
| provenanceLossCount | 0 |
| unknownSafetyRegressionCount | 0 |
| architectureBoundaryViolationCount | 0 |
| staleArtifactAcceptanceCount | 0 |
| transformDeterminismFailureCount | 1 |
| completeResultDivergenceCount | 0 |
| lostCfgEdgeCount | not measured |
| forcedTypeContradictionCount | not measured |

## Readability / recovery vector

| metric | baseline | candidate |
|---|---|---|
| functions | 45 | 45 |
| failures | 0 | 0 |
| semanticCoverage | 0.7777777777777778 | 0.7777777777777778 |
| semanticFunctions | 35 | 35 |
| rawAssemblyFallbacks | 12 | 12 |
| gotos | 39 | 39 |
| temporaries | 40 | 40 |
| redundantCasts | 30 | 30 |
| structuredFunctions | 29 | 29 |
| sourceMappedNodes | 322 | 322 |
| aggregateLayouts | 30 | 30 |
| highVariableGroups | 3013 | 3013 |

## Architecture lanes

- x arm64
-   riscv64
-   x86_64

## Checkpoints

- x P8-0
- x P8-1
- x P8-2
-   P8-3
-   P8-4
-   P8-5
-   P8-6
-   P8-7
-   P8-I

## Failures

| category | first divergence | expected | actual | blocking |
|---|---|---|---|---|
| coverage | forcedTypeContradictionCount is not measurable on this head | measured from P8-6 | null (not measured) | true |
| safety | transformDeterminismFailureCount exceeded its hard-zero limit | 0 | 1 | true |
| coverage | lostCfgEdgeCount is not measurable on this head | measured from P8-5 | null (not measured) | true |
| architecture | mandatory architecture lane has no Phase 8 evidence: riscv64 | corpus evidence | missing | true |
| architecture | mandatory architecture lane has no Phase 8 evidence: x86_64 | corpus evidence | missing | true |
| integration | a required checkpoint has no accepted evidence on this head | P8-0,P8-1,P8-2,P8-3,P8-4,P8-5,P8-6,P8-7,P8-I | missing: P8-3,P8-4,P8-5,P8-6,P8-7,P8-I | true |
