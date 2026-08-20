# Phase 8 release evidence — BLOCKING

- product: `7799ec6e7f3e6fbd51d821512bb3757de7471da3` (tree `a23bab53602d47309215d18519b78f473b9b3b27`, branch `phase8/decompiler-quality`, clean: true)
- verifier: phase8.verifier 1.0.0 (source sha256 `524b1e3ce071f4d8`)
- profile version: 2
- corpus: phase8-decompiler-quality-corpus v1, digest `37c049e8ed51a7f0d46538a894be3c7b`
- toolchain: Ubuntu clang version 18.1.3 (1ubuntu1) (aarch64-unknown-linux-gnu)
- baseline: `4f287eb84c083c404474e0cfd8d97a17` captured at `bd03d1a860863814dbdcc00559709794d460189d`
- pass registry: `68e46693c0b45a082ff09d0625ab59e9` (phase8.identity@1.0.0, phase8.sccp@1.0.0, phase8.dce@1.0.0, phase8.gvn@1.0.0, phase8.induction@1.0.0, phase8.aggregates@1.0.0, phase8.structuring@1.0.0, phase8.providers@1.0.0)

## Hard-zero safety counters

| counter | value |
|---|---|
| semanticMismatchCount | 0 |
| provenanceLossCount | 0 |
| unknownSafetyRegressionCount | 0 |
| architectureBoundaryViolationCount | 0 |
| staleArtifactAcceptanceCount | 0 |
| transformDeterminismFailureCount | 0 |
| completeResultDivergenceCount | 0 |
| lostCfgEdgeCount | 0 |
| forcedTypeContradictionCount | 0 |

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
- x P8-3
- x P8-4
- x P8-5
- x P8-6
- x P8-7
-   P8-I

## Failures

| category | first divergence | expected | actual | blocking |
|---|---|---|---|---|
| architecture | mandatory architecture lane has no Phase 8 evidence: riscv64 | corpus evidence | missing | true |
| architecture | mandatory architecture lane has no Phase 8 evidence: x86_64 | corpus evidence | missing | true |
| integration | a required checkpoint has no accepted evidence on this head | P8-0,P8-1,P8-2,P8-3,P8-4,P8-5,P8-6,P8-7,P8-I | missing: P8-I | true |
