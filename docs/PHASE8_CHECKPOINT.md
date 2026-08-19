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
| P8-1 Transactional pass substrate | **accepted** | see below |
| P8-2 SCCP + wrapped range/value set | not started | — |
| P8-3 GVN/CSE + effect-aware DCE | not started | — |
| P8-4 Induction / loop facts | not started | — |
| P8-5 Irreducible / exception structuring | not started | — |
| P8-6 Aggregate / array / union recovery | not started | — |
| P8-7 Language / compiler providers | not started | — |
| P8-I Final integration / cutover | not started | — |

Verifier verdict on this head: **BLOCKING** — correct, and the point. P8-0 and
P8-1 are accepted; the remaining checkpoints have no evidence and two hard-zero
counters are not measurable yet. The verifier exists and reports the truth from
the first checkpoint instead of being assembled at the end (EP-011).

Acceptance profile is now **v2**. The bump added `completeResultDivergenceCount`,
which changes what acceptance means, so P8-0's evidence was re-verified under the
new profile at the P8-1 head rather than being grandfathered (§5).

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

## P8-1 — transactional pass substrate

### What it delivers

- **`js/decompiler/phase8/transaction.js`** — the authoritative analysis state
  and the only thing that commits. A pass reads its declared inputs, stages what
  it produces, and returns; the transaction commits everything or nothing.
- **Fail-closed invalidation.** A pass that changed something invalidates every
  analysis it did not explicitly promise to preserve. `invalidates` is still
  declared and checked, but correctness does not depend on the declaration being
  complete — the analysis an author forgets is exactly the one that goes stale.
- **`produces` on the pass contract** (contract version 1 → 2). A staged write to
  an undeclared analysis is refused, so an undeclared production cannot become an
  undeclared dependency downstream.
- **Refusal on missing input.** A pass whose declared inputs are absent does not
  run at all. That is the mechanism that stops a decompiler pass from inventing a
  private substitute for a missing upstream fact.
- **Seeding from upstream facts only.** `seedAnalysisState` reads CFG, dominance,
  loops, SSA and origins off the IR the pipeline already holds. An absent fact
  stays at version 0 rather than being approximated. All 35 semantic corpus
  functions supply cfg + dominators + loops + ssa + origins.
- **One completeness answer.** `ctx.decompilerPipeline.completeness` is the
  weakest of the pass deadline, the rewrite budget and the Phase 8 ledger.

### The repair P8-0 handed over

P8-0 recorded that the rewrite fixed point was wall-clock dependent. Investigating
it at P8-1 found the sharper defect: `rewriteStats.budgetExceeded` could be true
while the pipeline reported `degraded: false` and no completeness at all, so a
consumer reading the pipeline's own flag was told a truncated result was
complete. Measured over 25 production-mode runs of `loop_decrement_step` at `-O1`,
three distinct outputs appeared and two of them were mislabelled.

The repair propagates truncation into a single completeness answer, and the
determinism requirement is now stated in the form that is both honest and
achievable while an interactive clock valve exists:

> Any result marked `complete` is the canonical result. Anything else is marked
> `partial`.

`completeResultDivergenceCount` measures exactly that, in **production mode**, and
is a hard-zero gate from profile v2. A determinism property proved only in the
work-bounded measurement mode would not be a property of the product.

### Required proof, and what proved it

| P8-1 required proof | evidence |
|---|---|
| abort before start leaves authoritative input unchanged | `invalidation.test.mjs` "a cancelled pass leaves the state byte-identical" |
| abort mid-pass publishes no half result | `vertical.test.mjs` cancellation cases |
| failure at the publication boundary is deterministic and residue-free | `vertical.test.mjs` "a pass that throws is not committed" |
| repeated identical input yields identical output and transform metadata | `invalidation.test.mjs` deterministic replay; `completeness.test.mjs` "every result marked complete is the same result" |
| targeted mutations invalidate exactly the required dependent analyses | `invalidation.test.mjs` over-invalidation case |
| under-invalidation blocked | `invalidation.test.mjs` under-invalidation case, which fails against the obvious "invalidate only what is declared" implementation |
| over-invalidation measured | same file; every preserved analysis keeps version 1 |
| existing decompiler output remains compatible | `no-op-equivalence.test.mjs` still byte-identical to the pre-Phase-8 baseline |

### Stop condition

P8-1 stops here. The substrate expresses consumes / preserves / invalidates /
produces, commits atomically, refuses on missing input, and propagates
completeness. It is not extended further for elegance; the next work is P8-2.

---

## Next allowed action

P8-2 — SCCP and the wrapped range/value-set domain, on top of the substrate.
