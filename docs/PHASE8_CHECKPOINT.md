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
| P8-2 SCCP + wrapped range/value set | **accepted** | see below |
| P8-3 GVN/CSE + effect-aware DCE | **accepted** | see below |
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

## P8-2 — SCCP and the wrapped range/value-set domain

### What it delivers

- **`bitvector.js`** — exact-width machine integer semantics. Every fold wraps at
  the declared width, signed and unsigned readings of the same bits are both
  available, and anything the machine leaves target-defined is refused rather
  than picked: a shift at or past the width, a division that traps, `INT_MIN / -1`,
  a mixed-width operand pair.
- **`range.js`** — a wrapped interval domain on Z/2^n. `[0xFFFFFFF0, 0x0F]` at 32
  bits is the 32 values around zero, not the empty set. Operations that cannot be
  represented exactly widen to full and record why; none of them invent a tighter
  answer.
- **`sccp.js`** — executable-edge-aware constant propagation. A phi meets only
  its proved-reachable predecessors, so a value stays constant even when a dead
  path assigns something else. Values with no producer are overdefined from the
  start, and an undecided branch marks nothing rather than permanently marking
  both arms.
- **Demand-driven optimizer stages.** The interactive decompile publishes
  canonical facts only (~1.3 ms worst case in the corpus). A caller that wants
  the middle-end facts asks for them and gets a budget sized for the work.
- **Producing a fact is not transforming the program** (contract version 2 → 3).
  SCCP changes the state without rewriting anything; requiring it to file a
  transform record with no target would have made provenance a formality.

### Results on the frozen corpus

| measure | value |
|---|---|
| newly proven constants (beyond what the IR already carried) | 20 |
| provably unreachable blocks | 1 |
| ranges widened to reach a fixed point | 30 |
| worst-case work items | 7,861 (bound 50,000) |
| functions reporting `partial` | 0 of 35 |
| worst-case optimizer stage | 16.7 ms cold, 250 ms budget |
| worst-case interactive stage | 1.3 ms |

Output is still byte-identical to the pre-Phase-8 baseline: nothing consumes the
facts yet, which is what makes them safe to land on their own.

### Three defects found and repaired here

1. **Non-terminating worklist.** `sameBitvector(null, null)` is false by design —
   a missing constant is not a constant — so comparing two overdefined cells
   through it alone reported a change on every revisit. A five-block function
   burned 200,000 work items and reported `partial`. Cells now compare states and
   constants separately, and both cells and ranges move monotonically.
2. **O(edges) reachability check per phi edge.** Scanning the executable-edge set
   for every incoming value on every revisit dominated the pass on a 300-value
   function. An executable-predecessor index and re-running only the terminators a
   value actually decides cut the worst case from 20 ms to 14 ms warm, before the
   demand-driven change removed it from the interactive path entirely (EP-016:
   profile the production hot path).
3. **Values with no producer were never evaluated.** A branch on a function
   argument left its condition at top forever, so every block behind it looked
   unreachable — an unsound answer, not merely an imprecise one. Definition-less
   values are now overdefined at initialization.

### Minimum success condition, and where it stops

`PHASE8_FAST_PATH` §8 asks for executable-edge correctness, exact-width wrap
correctness, unknown staying unknown, retained provenance and bounded
convergence. All five are proved in `tests/phase8/scalar/`, on
architecture-neutral IR fixtures: a fixture assembled from one target's assembly
would prove things about that target as much as about the optimizer.

The domain is deliberately not richer than that. No congruence information, no
relational facts, no per-branch refinement — those are precision features and the
exit metrics do not yet ask for them.

### Still open after P8-2

x86-64 and RISC-V64 remain mandatory lanes with no product corpus. The scalar
lane is now proved on architecture-neutral IR, which is the algorithm half of
that gap; the product half needs real binaries and is still reported as missing
evidence rather than being counted as covered.

---

## P8-3 — GVN/CSE and effect-aware DCE

### What it delivers

- **`valuenumber.js`** — congruence by semantic identity: operator, sub-kind,
  exact width, and the numbers of the operands. Never by rendered text.
  `printExpression` output normalises casts, hides widths and reorders for
  readability, so two expressions that print identically can compute different
  things.
- **Memory reuse gated on the IR's own proof.** A load is congruent to an earlier
  load only with the same canonical location, the same width, the same reaching
  memory definitions, no unknown-store barrier, a precise address, and proved
  non-volatile / non-atomic / unordered access. Phase 8 re-derives none of that —
  a second opinion computed here would be a second memory truth.
- **`dce.js`** — the two halves asked separately: is every use gone, and is
  executing the operation unobservable. Only an operation that fails both is a
  candidate. Everything else is kept with the reason recorded.
- **Intra-stage dependency ordering.** Passes in one stage are now ordered so a
  producer runs before its consumers, with a deterministic id tie-break and a
  cycle error. Stage order alone was the "dependencies encoded by incidental
  array order" the P8-1 merge blockers reject.

Both passes publish facts. Neither rewrites the program, so output remains
byte-identical to the pre-Phase-8 baseline.

### Results on the frozen corpus

| measure | value |
|---|---|
| congruent value classes | 219 |
| scalar reuse candidates | 216 |
| load reuse candidates | **0** — see below |
| dead-operation candidates | 818 |
| dead but kept, with a recorded reason | 332 |

The 332 are the interesting number: every one is an operation with no live result
that a naive "unused means removable" pass would have deleted. 245 write
architectural state this analysis does not track, 54 are opaque clobbers, 32 are
operations the semantic IR could not represent, 1 is a comparison.

### An upstream gap, reported rather than worked around

**Zero loads were reused, and none can be.** All 59 loads in the corpus carry
`volatility: unknown`, because nothing upstream ever proves an access is
non-volatile. Unknown is not permission: a volatile read must execute exactly as
many times as it is written. The gate is therefore correct and the capability is
unreachable until the loader/semantic layers produce that fact.

This is an upstream fact, not a decompiler heuristic to invent (P8-INV-003). It
is recorded here as a blocking limitation on memory reuse rather than being
softened into "probably fine".

### Three defects found and repaired here

1. **DCE read definitions from block instruction lists.** A value whose defining
   operation was not in the list it was expected to be in simply vanished from
   the analysis, and the pass reported there was nothing to remove. Across the
   corpus that was 818 candidates reported as 0. Definitions are now read from
   the value itself.
2. **GVN never numbered definition-less values.** Function arguments and incoming
   state are not in any instruction list, so every expression built on them was a
   singleton — the pass was silently disabled on exactly the operands real code
   is made of. This is the same structural gap SCCP had at P8-2; both are now
   pre-numbered.
3. **Over-invalidation, caught in production by the fail-closed rule.** GVN never
   declared it preserves `deadCode`, so it discarded the DCE facts produced
   moments earlier and the whole analysis looked empty. The invalidation rule
   behaved exactly as designed; the declaration was wrong.

### The soundness premise, checked directly

DCE decides liveness from `value.uses`. If the IR ever stops maintaining that
list completely the pass does not fail — it silently starts calling live values
dead. So `tests/phase8/memory/dce.test.mjs` reconstructs the use map
independently across the whole corpus and asserts it agrees: 3,511 values, zero
uses the IR did not declare.

### Stop condition

`PHASE8_FAST_PATH` §8 asks for exact scalar equivalence, memory reuse only under
MemorySSA/alias/effect proof, dead-operation removal only when the result is dead
*and* execution is unobservable, and unknown call/store as a barrier. All four are
proved. No global superoptimizer, no partial redundancy elimination, no
speculative motion.

---

## Next allowed action

P8-4 — induction and loop facts, consuming the P8-2 ranges.
