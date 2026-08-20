# Phase 8 — Decompiler Quality: handoff

> **State:** P8-0 … P8-7 accepted. **P8-I not started.**
> **Branch:** `phase8/decompiler-quality` — PR [#1013](https://github.com/rhgrive3/hex/pull/1013)
> **Verified head:** `225aa33f331ca5bc287f4875c6c0b18ef29199c8`, working tree clean
> **Phase 8 base commit:** `bd03d1a860863814dbdcc00559709794d460189d`
> **Verifier verdict at that head:** `BLOCKING` — correctly, for two real reasons, both listed in §3.

This file is for whoever picks Phase 8 up next. It says what exists, what is
proved, what is deliberately not proved, and exactly what P8-I still needs. Where
it disagrees with `PHASE8_CHECKPOINT_CONTRACTS.md`, the contract wins.

`PHASE8_CHECKPOINT.md` is the long-form record of each checkpoint and why it was
accepted. This is the short form plus the open work.

---

## 1. What is on the branch

Eight passes, all of them **fact producers**. Not one of them rewrites the
program, which is why the corpus differential against the pre-Phase-8 baseline is
still byte-exact after seven checkpoints, and why each checkpoint could land on
its own.

| stage | pass | publishes |
|---|---|---|
| canonical-facts | `phase8.identity` | — (wiring, provenance, artifact identity) |
| scalar-optimization | `phase8.sccp` | `ranges` |
| memory-optimization | `phase8.dce` | `deadCode` |
| memory-optimization | `phase8.gvn` | `valueNumbers` |
| loop-facts | `phase8.induction` | `induction` |
| high-level-recovery | `phase8.aggregates` | `aggregates` |
| structuring | `phase8.structuring` | `structuredRegions` |
| providers | `phase8.providers` | `providerHints` |

Everything lives under `js/decompiler/phase8/`, is owned by lane `p8`
(`tools/validation/phase-ownership/phase8.json`), and is tested by
`tests/phase8/` — 260 tests across 22 files, discovered by `tests/phase8/run.mjs`.

### Accepted checkpoints

| checkpoint | integration SHA | profile |
|---|---|---|
| P8-0 foundation, corpus, baseline, verifier | `bed4daca` | v1 |
| P8-1 transactional pass substrate | `0d51657a` | v2 |
| P8-2 SCCP + wrapped ranges | `22aa1a03` | v2 |
| P8-3 GVN/CSE + effect-aware DCE | `82372507` | v2 |
| P8-4 induction / loop facts | `57bcd9cb` | v2 |
| P8-5 edge-accounted structuring | `c2616dee` | v2 |
| P8-6 aggregate candidates | `7799ec6e` | v2 |
| P8-7 provider refinement | `7799ec6e` | v2 |

Ledger: `reports/phase8/checkpoints.json`. Evidence:
`reports/phase8/phase8-release-evidence.{json,md}`.

---

## 2. Hard-zero gates: all eight measured

None of these is inferred from absence. Each is recomputed from the raw facts by
an independent check, because a pass does not get to mark its own work.

| counter | value | recomputed by |
|---|---|---|
| `semanticMismatchCount` | 0 | corpus differential vs the frozen pre-Phase-8 baseline |
| `provenanceLossCount` | 0 | corpus differential |
| `unknownSafetyRegressionCount` | 0 | corpus differential |
| `forcedTypeContradictionCount` | 0 | `forcedContradictions()` over published candidates |
| `architectureBoundaryViolationCount` | 0 | source scan of the generic passes |
| `transformDeterminismFailureCount` | 0 | two corpus runs at one shared budget |
| `staleArtifactAcceptanceCount` | 0 | artifact identity |
| `lostCfgEdgeCount` | 0 | `edgeAccountingFailures()` recount from each CFG |

Performance on the frozen corpus: worst demand-driven optimize stage **31.5 ms**
against a 120 ms budget, across all eight passes. Interactive decompiles run only
the `canonical-facts` stage.

---

## 3. What blocks P8-I

Two things, and both are real work rather than paperwork.

### 3.1 `x86_64` and `riscv64` have no Phase 8 corpus — **the big one**

`mandatoryArchitectureLanes()` in `tools/validation/phase8/verify.mjs` reads live
capability truth (`js/platform/capability-maturity.js`). Three architectures
report `supported` for cfgSemanticIR, ssaMemoryDataflow *and* decompiler:

```
arm64      supported / supported / supported   <- has a corpus
x86_64     supported / supported / supported   <- no corpus
riscv64    supported / supported / supported   <- no corpus
```

So both are mandatory lanes and both are missing. This is not a gate to relax:
if the lanes are genuinely supported they need evidence, and if they are not the
capability matrix is wrong — and that is a different lane's decision, not
Phase 8's.

**What the work actually is.** clang 18.1.3 in this environment cross-compiles
both targets (verified: `--target=x86_64-unknown-linux-gnu` and
`--target=riscv64-unknown-linux-gnu` both produce objects). The builder is
`tools/validation/phase8/build-corpus.mjs`; it currently hard-codes
`--target=aarch64-unknown-linux-gnu` and `architectureId: 'arm64'`.

The trap is the baseline. `tests/phase8/corpus/pre-phase8-observations.json` is
real product output captured **at `bd03d1a8`, before any optimizer existed**. New
corpus functions need their baseline captured the same way — check out
`bd03d1a8`, run the observer there, commit the result. A baseline regenerated at
the current head would compare Phase 8 against itself and prove nothing. This is
written down in `PHASE8_CHECKPOINT.md` §P8-0 and it is the single easiest thing
to get wrong here.

Also expect the sources themselves to need attention: `quality.c` declares its
own `int8_t`/`int32_t`/`uint32_t` against the LP64 ABI because no aarch64 sysroot
is installed. The same trick will be needed per target, and RISC-V64 is also
LP64 while any 32-bit lane would not be.

### 3.2 P8-I's own evidence

Per `PHASE8_CHECKPOINT_CONTRACTS.md` §P8-I:

- reconcile against **live** `main` (refetch; do not trust this branch's base),
- the generated-output transaction (see §5 — there is a known pre-existing snag),
- final release evidence bound to an exact candidate SHA, verifier identity,
  corpus identity, toolchain identity and generated identity together,
- merge with expected-head protection, then refetch `main` and prove the exact
  product is present.

---

## 4. Invariants a successor must not quietly break

These are the decisions that took the longest to get right. Each has tests that
will fail if it is undone, but the reasoning is worth having.

**Phase 8 runs as its own budgeted stage, not inside `PassManager`.** Registering
it in the pass list changed the rewrite fixed point on two budget-saturated
functions — the same pseudocode, a measurably different result. A middle end that
degrades existing output merely by being present is not a no-op.

**`gotoCount = 0` is not a goal and not a gate.** A correct jump beats a false
`while`. Nothing in the structuring artifact rewards removing one, and a run with
jumps reports the same completeness as one without.

**Certainty is never reached on repetition.** `certaintyOf()` in `aggregates.js`
is the only place the ladder is climbed: `confirmed` needs a hard fact and zero
conflicts. Fifty soft facts reach `supported` and stop. A test walks exactly that.

**A conflict caps certainty; it is never resolved.** Overlapping accesses, two
shapes that both fit, disagreeing names — all recorded, all holding the region at
`candidate`.

**Providers cannot decode.** The view in `providerView()` is built field by field
from published facts. There is no `insts`, no text, no register, no address. If
that view is ever replaced by "pass the analysis state, it's frozen anyway", the
guarantee becomes a promise. A test walks the view's keys.

**Unknown stays explicit everywhere.** `null` in a counter means *not measured*
and is a blocking coverage failure. It never means zero.

**Upstream facts are read, never recomputed.** CFG, dominance, post-dominance,
loops, SSA, origins and recovered types are seeded in
`js/decompiler/phase8/transaction.js` from what the pipeline already holds. P8-5
consumes P8-4's loop facts; P8-6 consumes P8-4's strides. There is deliberately
no second loop detector and no second type engine.

---

## 5. Known snags worth knowing before you start

**`js/userscript/deployment-identity.generated.js` drifts on every build.**
`scripts/build-userscript.mjs` rewrites it to the local form, but `543dceb6` on
`main` committed the Cloudflare Workers build's form. So `npm run userscript:build`
always dirties it. It is **outside lane `p8`**, so every Phase 8 commit here
reverts it (`git checkout` that one path) after rebuilding. P8-I owns the
generated-output transaction and should decide properly: either main's copy is
wrong and gets fixed in its owning lane, or the build should stop rewriting it.
Do not let a Phase 8 commit silently carry it.

**Load reuse is blocked upstream and is not Phase 8's to unblock.**
`js/targets/architecture/arm64/effects/memory.js:279` sets
`atomic = BASE_ONLY.has(mnemonic) ? true : null`, so an ordinary `LDR` reports
`unknown` atomicity — a fact the decoder holds and discards. All 59 corpus loads
are blocked by exactly that. `tests/machine-effects/arm64-memory-addressing.test.mjs:29`
asserts this deliberately ("ordinary LDR atomicity is not inferred"), so it is an
accepted contract decision in another lane. Recorded as `UPSTREAM_BLOCKED` in
`tools/validation/phase8/readiness.json` with the owner and the one-line change.
Changing it needs machine-effects and Phase 6/7 evidence re-run.

**`grep` is shadowed by a shell function** wrapping a `claude` binary that is not
installed in this Codespace. Use `command grep`. This cost real time; it looks
like a test failure and is not one.

**The frozen corpus must not be re-frozen casually.** Changing
`tests/phase8/corpus/functions.json` changes `corpusDigest`, which invalidates the
baseline it is compared against. Switch and exception shapes are proved on
architecture-neutral fixtures precisely to avoid touching it.

---

## 6. Running things

```bash
npm run phase8:test        # 260 tests, ~70 s
npm run phase8:verify      # release evidence; add --expect-sha <sha>
npm run phase8:ownership -- --check-manifest
npm run phase8:checkpoint -- --id P8-I --base <previous-head-sha>
npm run phase8:corpus      # rebuild the corpus (needs clang cross targets)
npm run phase8:baseline    # capture a baseline — ONLY at bd03d1a8
```

The full gate set a Phase 8 commit should pass: `npm run phase8:test`,
`npm run lint`, `npm run migration:test`, `npm run decompiler:test`, `npm test`,
plus `npm run userscript:build` with a zero diff (see §5) and the ownership check
over the actual changed files.

---

## 7. If you only read one paragraph

Eight passes are in, all analysis-only, all eight hard-zero gates measured at
zero, product output byte-identical to before Phase 8 started. The remaining work
is P8-I, and the bulk of it is building x86-64 and RISC-V64 corpora **with their
pre-Phase-8 baselines captured at `bd03d1a8`, not at the current head**. Get that
one detail wrong and the evidence proves nothing.
