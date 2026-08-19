# Phase 7 release evidence — NOT-INTEGRATED

- product: `bdf90569ed037a3d30e4439dcde970aad9352e21` (tree `fffaafaf60353fa749b0fa763af45288ba3c0f2e`, branch `phase7/static-analysis-depth`, clean: false)
- verifier: phase7.verifier 1.0.0 (source sha256 `0da9e1f444afa126`)
- profile version: 1
- corpus: phase7-alias-memory-corpus v1, digest `f97d8b40b5298824df6f77ea23f923b3`, frozen match: true
- scoring: phase7.scoring 1.0.0; truth: phase7.corpus.declared-truth 1.0.0

## Alias precision (same frozen query set, same denominator)

| metric | baseline | candidate |
|---|---|---|
| exact relations proven | 1/2 | 2/2 |
| strong proven rate | 0.091 | 0.182 |
| may rate | 0.909 | 0.818 |
| unknown rate | 0.000 | 0.000 |
| false NoAlias | 0 | 0 |
| false MustAlias | 0 | 0 |

## Memory links

| metric | baseline | candidate |
|---|---|---|
| exact links | 2 | 2 |
| barriers correctly held | 2 | 2 |
| barrier bypasses | 0 | 0 |

## Checkpoints

-   P7-0
-   P7-1
-   P7-2
-   P7-3a
-   P7-3b
-   P7-3c
-   P7-4
-   P7-5a
-   P7-5b
-   P7-6
-   P7-I

## Failures

| category | first divergence | expected | actual | blocking |
|---|---|---|---|---|
| soundness | a type conclusion was reported certain against exact truth | 0 | Infinity | true |
| soundness | function discovery produced a start with no supporting evidence | 0 | Infinity | true |
| debug | required debug ecosystem is missing: dwarf | present | missing | true |
| debug | required debug ecosystem is missing: pdb | present | missing | true |
| architecture | metamorphic middle-end laws failed on lane: arm64 | laws hold | violated | true |
| architecture | metamorphic middle-end laws failed on lane: riscv64 | laws hold | violated | true |
| architecture | metamorphic middle-end laws failed on lane: x86_64 | laws hold | violated | true |
| integration | a required checkpoint has no evidence on this head | P7-0,P7-1,P7-2,P7-3a,P7-3b,P7-3c,P7-4,P7-5a,P7-5b,P7-6,P7-I | missing: P7-0,P7-1,P7-2,P7-3a,P7-3b,P7-3c,P7-4,P7-5a,P7-5b,P7-6,P7-I | true |
