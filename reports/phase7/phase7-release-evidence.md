# Phase 7 release evidence — BLOCKING

- product: `6b7052272f17cfeec62530c0eee413b79a88af6b` (tree `06b03486f241566b3e4d405a0b25f0f4dc6815a9`, branch `phase7/static-analysis-depth`, clean: false)
- verifier: phase7.verifier 1.0.0 (source sha256 `49b9d618389b364b`)
- profile version: 1
- corpus: phase7-alias-memory-corpus v1, digest `519bd15f3a918dbc2b436aca4870455d`, frozen match: true
- scoring: phase7.scoring 1.0.0; truth: phase7.corpus.declared-truth 1.0.0

## Alias precision (same frozen query set, same denominator)

| metric | baseline | candidate |
|---|---|---|
| exact relations proven | 1/3 | 3/3 |
| strong proven rate | 0.063 | 0.188 |
| may rate | 0.938 | 0.813 |
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
| identity | working tree is dirty, so the commit does not describe what was tested | clean tree | M tests/phase7/verifier/exact-head.test.mjs; M tools/validation/phase7/verify.mjs | true |
