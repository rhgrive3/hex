# Phase 8 release evidence — READY

- product: `e88c45791ed7f294d0df865ae7001cc45212d0bb` (tree `8588dbae75e6b41a2a2a0eae5f83bfaab8a166b7`, branch `HEAD`, clean: true)
- verifier: phase8.verifier 1.0.0 (source sha256 `524b1e3ce071f4d8`)
- profile version: 2
- corpus: phase8-decompiler-quality-corpus v2, digest `94094f7e9487f640e871e46b19c86c69`
- toolchain: Ubuntu clang version 18.1.3 (1ubuntu1) (undefined)
- baseline: `82d81a28f7b6f0e5b83c9bcb07e1418a` captured at `bd03d1a860863814dbdcc00559709794d460189d`
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
| functions | 135 | 135 |
| failures | 0 | 0 |
| semanticCoverage | 0.9259259259259259 | 0.9259259259259259 |
| semanticFunctions | 125 | 125 |
| rawAssemblyFallbacks | 1050 | 1050 |
| gotos | 146 | 146 |
| temporaries | 1097 | 1074 |
| redundantCasts | 1407 | 1383 |
| structuredFunctions | 102 | 102 |
| sourceMappedNodes | 2114 | 2114 |
| aggregateLayouts | 85 | 85 |
| highVariableGroups | 9950 | 9950 |

## Architecture lanes

- x arm64
- x riscv64
- x x86_64

## Checkpoints

- x P8-0
- x P8-1
- x P8-2
- x P8-3
- x P8-4
- x P8-5
- x P8-6
- x P8-7
- x P8-I

## Failures

None.
