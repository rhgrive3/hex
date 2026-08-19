# Phase 7 release evidence — BLOCKING

- product: `ee17547478b1cbedc69f504c03cf6e421b97f940` (tree `7d60ac7ab2de6b852d877597668984c48ce92e2c`, branch `phase7/static-analysis-depth`, clean: false)
- verifier: phase7.verifier 1.0.0 (source sha256 `0da9e1f444afa126`)
- profile version: 1
- corpus: phase7-alias-memory-corpus v1, digest `004acbb071160218a8ad023dbf653a65`, frozen match: true
- scoring: phase7.scoring 1.0.0; truth: phase7.corpus.declared-truth 1.0.0

## Alias precision (same frozen query set, same denominator)

| metric | baseline | candidate |
|---|---|---|
| exact relations proven | 1/3 | 3/3 |
| strong proven rate | 0.077 | 0.231 |
| may rate | 0.923 | 0.769 |
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

- x P7-0
- x P7-1
- x P7-2
- x P7-3a
- x P7-3b
- x P7-3c
- x P7-4
- x P7-5a
- x P7-5b
-   P7-6
-   P7-I

## Failures

| category | first divergence | expected | actual | blocking |
|---|---|---|---|---|
| integration | a required checkpoint has no evidence on this head | P7-0,P7-1,P7-2,P7-3a,P7-3b,P7-3c,P7-4,P7-5a,P7-5b,P7-6,P7-I | missing: P7-6,P7-I | true |
