# Phase 8 — Decompiler Quality: living checkpoint record

> **Status:** live. Updated at every externally visible checkpoint transition (EP-030).
> **Integration branch:** `phase8/decompiler-quality`
> **Phase 8 base commit:** `bd03d1a860863814dbdcc00559709794d460189d`
> **Ownership:** single owner, lane `p8`, manifest `tools/validation/phase-ownership/phase8.json`
> **Verifier:** `node tools/validation/phase8/verify.mjs` (`npm run phase8:verify`)

This file records what was accepted and what proved it. It never relaxes an exit
gate. Where it disagrees with `PHASE8_CHECKPOINT_CONTRACTS.md`, the contract wins.

---

## Current state

| checkpoint | state | evidence |
|---|---|---|
| P8-0 Foundation / baseline / verifier | **accepted** | see below |
| P8-1 Transactional pass substrate | not started | — |
| P8-2 SCCP + wrapped range/value set | not started | — |
| P8-3 GVN/CSE + effect-aware DCE | not started | — |
| P8-4 Induction / loop facts | not started | — |
| P8-5 Irreducible / exception structuring | not started | — |
| P8-6 Aggregate / array / union recovery | not started | — |
| P8-7 Language / compiler providers | not started | — |
| P8-I Final integration / cutover | not started | — |

Verifier verdict on this head: **NOT-INTEGRATED** — correct, and the point. The
verifier exists and reports the truth from the first checkpoint instead of being
assembled at the end (EP-011).

---

## P8-0 — what was frozen

- **Live main observed:** `bd03d1a8`, clean, identical to `origin/main`. The
  prepared baseline named in the planning documents (`e90c5107`) is historical
  and was not used as current truth.
- **Ownership:** `tools/validation/phase-ownership/phase8.json` +
  `tools/validation/phase8-ownership.mjs`, with negative tests and a workflow
  step that proves the gate still rejects.
- **Canonical runner:** `tests/phase8/run.mjs`, recursive, with a sentinel test
  proving every owned subtree is discoverable (EP-005).
- **Exact-SHA verifier:** `tools/validation/phase8/verify.mjs`, plus a permanent
  `workflow_dispatch` route in `.github/workflows/phase8-release-validation.yml`
  (EP-012).
- **Corpus:** `tests/phase8/corpus/functions.json` — 45 functions (15 sources ×
  `-O0`/`-O1`/`-O2`), real clang 18.1.3 AArch64 output, frozen with its toolchain
  identity. Every function exists because a named checkpoint has to be measurable
  on it.
- **Frozen baseline:** `tests/phase8/corpus/pre-phase8-observations.json`,
  captured from the product at the base commit before any optimizer existed.
- **Readiness matrix:** `tools/validation/phase8/readiness.json`, 36 capabilities,
  every one classified, every cited evidence path asserted to exist.
- **Pass contract + no-op vertical:** `js/decompiler/phase8/`, wired into the real
  production `enhanceSemanticDecompilation` path.

### Baseline numbers (frozen, corpus digest `37c049e8ed51a7f0d46538a894be3c7b`)

| metric | value |
|---|---|
| functions | 45 |
| on the shared semantic path | 35 (77.8 %) |
| raw assembly fallbacks | 12 |
| gotos | 39 |
| temporaries | 40 |
| redundant casts | 30 |
| structured functions | 29 |
| source-mapped nodes | 322 |

10 of 45 functions fall back to the legacy decompiler today: the `-O0` loops,
`dce_volatile_read` at `-O1`/`-O2`, `gvn_call_barrier` at every level, and
`aggregate_array_stride` at `-O0`. That is the honest current state and the
headroom Phase 8 is aimed at.

### Required proof, and what actually proved it

| P8-0 required proof | evidence |
|---|---|
| no-op path is semantically/output/provenance equivalent to the pre-Phase-8 path | `tests/phase8/corpus/no-op-equivalence.test.mjs` — full-corpus differential against output captured from the base commit |
| canonical runner discovers all lane test subtrees | `tests/phase8/foundation/discovery.test.mjs` |
| ownership negative tests reject cross-lane paths | `tests/phase8/ownership/manifest.test.mjs` |
| exact-SHA verifier can run against a supplied product SHA | `tests/phase8/verifier/exact-head.test.mjs` |
| evidence binds product, verifier, corpus, toolchain, registry identity | same file |
| current decompiler debt is recorded | `tools/validation/phase8/readiness.json` |
| no production quality feature is claimed | quality vector is byte-identical to the baseline |

### Findings recorded at P8-0

1. **The rewrite engine's fixed point was wall-clock dependent.** `DEFAULT_REWRITE_BUDGET.timeBudgetMs = 18`
   bounded the rewrite fixed point by time, so the same input reached different
   fixed points on different runs — visible as `redundantCasts` moving between 0
   and 13 on `loop_decrement_step`. A quality baseline could not be frozen at
   all until this was addressed. P8-0 added an opt-in work-bounded mode
   (`deterministicTransforms`) used by measurement; production defaults are
   unchanged. **Making the production degradation itself deterministic is P8-1's
   work** and is the concrete content of `transformDeterminismFailureCount = 0`.
2. **A Phase 8 stage inside the existing `PassManager` deadline is not a no-op.**
   Registering the identity pass in the shared pass list took time from the
   rewrite allowance and measurably changed the rewrite fixed point on
   budget-saturated functions. Phase 8 therefore runs as its own stage with its
   own declared budget, before the representation passes.
3. **x86-64 and RISC-V64 are mandatory lanes with no Phase 8 evidence yet.** Live
   capability truth reports the shared decompiler as supported on both, so the
   verifier lists them and reports them as missing evidence. They are not dropped
   from the denominator. P8-2 owns adding architecture-neutral Semantic IR
   fixtures for them.
4. **`lostCfgEdgeCount` and `forcedTypeContradictionCount` are not measurable yet.**
   They report `null`, never `0`, and the verifier treats `null` as a blocking
   coverage failure. P8-5 and P8-6 own them.

### Process-failure prevention active from P8-0

| historical class | Phase 8 mechanism |
|---|---|
| EP-001 late integration | living branch + no-op vertical through the production path at P8-0 |
| EP-002 cross-scope contamination | actual changed-file inventory gate |
| EP-004 contradictory ownership | manifest self-validation, including forbidden-reachable-through-owned |
| EP-005 undiscovered nested tests | sentinel discovery test per subtree |
| EP-009 skipped checkpoint sync | verifier treats a checkpoint with no accepted ledger entry as missing |
| EP-011 late verifier | verifier shipped at P8-0, shadow mode from the first checkpoint |
| EP-012 validation-only PRs | permanent `workflow_dispatch` exact-SHA route |
| EP-015 partial artifact publication | evidence validated against its own schema, written atomically, empty output refused |
| EP-016 CI topology before profiling | performance budget measured per stage from P8-0 |
| EP-018 dirty tree attested as clean | verifier fails closed on a dirty tree outside its own output |

---

## Next allowed action

P8-1 — transactional pass substrate. Its first owned repair is finding 1 above:
make the production rewrite/pass degradation deterministic, with a regression
that fails on the old behaviour.
