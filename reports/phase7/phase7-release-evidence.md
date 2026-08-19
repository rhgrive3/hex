# Phase 7 release evidence — BLOCKING

- product: `401b41c1ae5270be4e386b9eda49203ed3e0c438` (tree `8a9bbfe6864bc040b309e6a6445f41087a3012b1`, branch `phase7/static-analysis-depth`, clean: false)
- verifier: phase7.verifier 1.0.0 (source sha256 `22616c498e0baabc`)
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
- x P7-6
- x P7-I

## Failures

| category | first divergence | expected | actual | blocking |
|---|---|---|---|---|
| identity | working tree is dirty, so the commit does not describe what was tested | clean tree | M tools/validation/phase7/verify.mjs | true |
