# Phase 8 Checkpoint Contracts

> **Status:** Pre-implementation merge/exit contract  
> **Scope:** Master Architecture Phase 8  
> **Prepared baseline:** `main` = `e90c5107f9c77d73687ee452d5042dcbe9e79ece`  
> **Operational companion to:** `PHASE8_IMPLEMENTATION_GUIDE.md` and `PHASE8_EXECUTION_BLUEPRINT.md`

This document answers one operational question for every Phase 8 lane:

> **What must be true before this checkpoint may be accepted and the next dependent work may begin?**

The contracts are intentionally stricter than “tests pass on the component branch”. Candidate merge-tree proof and the living integration checkpoint are part of completion.

P8-0 MUST regenerate path ownership, corpus identity, and exact commands from the then-current repository. Proposed paths/commands in this document are plans, not claims that Phase 8 infrastructure already exists.

---

## 1. Global start blockers

Phase 8 implementation MUST NOT fan out until all applicable blockers are resolved or explicitly classified:

1. Live `main` has been refetched and recorded.
2. Phase 6 RISC-V cutover evidence required by the Master Architecture is complete, or any incomplete dependency is explicitly blocking.
3. Phase 7 alias/interprocedural/type/function-discovery exit evidence is complete for the facts Phase 8 intends to consume.
4. The actual current decompiler pipeline and architecture-specific debt have been re-audited; the prepared baseline is not treated as current truth.
5. A living Phase 8 integration branch/PR exists.
6. Machine-readable ownership exists and is regression-tested against expected lane inventories.
7. The canonical Phase 8 runner discovers every allowed test subtree.
8. A permanent exact-SHA Phase 8 verifier invocation exists.
9. Mandatory corpus identity/provenance and P8-0 baseline metrics are frozen.
10. The generated-output relationship of touched decompiler source is known.
11. Moving-main reconciliation has one owner: the integration lane.
12. Evidence invalidation rules are written before first component evidence is accepted.

If any prerequisite fact is unavailable, mark it `BLOCKING`/`UPSTREAM_BLOCKED`; do not replace it with a decompiler heuristic.

---

# P8-0 — Foundation / Baseline / Verifier

## Inputs

- current `main` exact SHA;
- Phase 6/7 completion evidence relevant to Phase 8;
- current `HEX_MASTER_ARCHITECTURE.md`;
- current engineering/migration guardrails;
- current decompiler source/test/workflow inventory.

## Deliverables

- living integration branch/PR;
- Phase 8 ownership manifest + validator + governance regression;
- canonical `tests/phase8/run.mjs`-style runner or equivalent current-repo entry point;
- sentinel discovery test for every owned test subtree;
- permanent exact-SHA verifier path;
- release-evidence schema;
- mandatory corpus manifest with provenance/toolchain expectations;
- frozen baseline quality vector and performance metrics;
- checked-in readiness matrix covering every Master Architecture §18.2 middle-end capability;
- no-op/identity vertical pass wired through the real production decompiler path;
- pass/result versioning skeleton;
- generated-output ownership decision;
- living checkpoint record.

## Required proof

- no-op path is semantically/output/provenance equivalent to the pre-Phase-8 path on the required baseline corpus;
- canonical runner discovers all lane test subtrees;
- ownership negative tests reject cross-lane paths;
- exact-SHA verifier can run against an explicitly supplied product SHA;
- baseline evidence records product SHA, verifier identity, corpus identity, toolchain identity, and completeness;
- current Ghidra/compiler-truth/cross-binary/decompiler/semantic floors remain green where triggered/applicable;
- no production quality feature is claimed yet.

## Merge blockers

- missing readiness row;
- missing corpus/toolchain requirement silently treated as optional;
- no exact-SHA/manual verifier route;
- test subtree not discoverable by canonical runner;
- ownership contradiction;
- no-op path changes semantics/provenance unexpectedly;
- current architecture-specific debt is unrecorded.

## Handoff

P8-1 receives frozen pass contracts, ownership, corpus, baseline metrics, verifier schema, and integration mechanics.

---

# P8-1 — Pass Transaction / Preservation / Invalidation Substrate

## Inputs

- P8-0 frozen contracts;
- current `PassManager` and rewrite engine behavior;
- ArtifactStore/scheduler/versioning contracts from earlier phases.

## Deliverables

- versioned pass descriptor/result contract;
- staged/atomic publication semantics;
- cancellation/deadline behavior with no partial authoritative state;
- analysis `consumes / preserves / invalidates` declarations;
- dependency/stage ordering mechanism sufficient for Phase 8;
- deterministic replay/change detection;
- explicit completeness/degraded propagation;
- artifact invalidation keying for new pass results;
- per-pass diagnostics/performance metrics.

## Required proof

- abort-before-start leaves authoritative input unchanged;
- abort-mid-pass publishes no half result;
- failure at publication boundary is deterministic and residue-free;
- repeated identical input/version yields identical output and transform metadata;
- targeted mutations invalidate exactly the required dependent analyses;
- under-invalidation test fails before the repair and passes after it;
- over-invalidation regression proves unrelated changes retain reuse where designed;
- existing decompiler output remains compatible before semantic optimizer components are enabled.

## Merge blockers

- in-place mutation of canonical Semantic IR/SSA/MemorySSA solely for decompiler prettiness;
- cancellation can expose partial transformed state;
- invalidation rules are implicit;
- broad cache clear is the only invalidation mechanism;
- stage dependencies are encoded only by incidental array order without a tested contract.

## Handoff

P8-2/P8-5 receive a safe substrate. No later optimizer may invent its own publication/invalidation framework.

---

# P8-2 — SCCP + Wrapped Range / Value Set

## Inputs

- P8-1 substrate;
- generic CFG/SSA;
- exact-width semantic operations;
- Phase 7 facts that are explicitly part of range queries.

## Deliverables

- executable-edge-aware SCCP;
- exact-width constant evaluation;
- wrapped range/value-set domain with bounded convergence;
- precision-loss/widening diagnostics;
- branch/phi simplification transform records;
- public/internal query surface reusable by downstream passes.

## Required proof

Positive and negative corpus must cover:

- executable vs non-executable phi predecessors;
- width truncation/extension;
- modular wraparound;
- signed vs unsigned comparisons;
- unknown/unsupported operation;
- unresolved branch;
- unknown store/call barriers where memory facts are involved;
- loop widening termination;
- provenance after branch/phi simplification;
- determinism and budget/cancellation behavior;
- representative AArch64, x86-64, and RISC-V64 semantic shapes available at that point.

## Merge blockers

- mathematical-integer reasoning used as fixed-width truth;
- unreachable edge guessed instead of proved;
- architecture register/flag names introduced into generic SCCP/range code;
- range precision silently exceeds represented proof;
- consumer cannot tell widened/partial result from complete result.

## Handoff

P8-3 receives scalar facts; P8-4 receives range/bound facts. Integration records the exact accepted SCCP/range artifact versions.

---

# P8-3 — GVN/CSE + Effect-Aware DCE

## Inputs

- P8-1 substrate;
- P8-2 scalar/range facts where relevant;
- MemorySSA/alias proof API;
- function/imported call summaries/effect model from earlier phases.

## Deliverables

- scalar GVN/CSE;
- memory-aware reuse only under exact memory/effect proof;
- effect-aware DCE;
- pointer/address canonicalization needed by value numbering, without decoder re-entry;
- explicit missed-optimization diagnostics where proof is insufficient.

## Required proof

- pure scalar CSE positive cases;
- syntactically-same-but-semantically-different negative cases;
- changed MemorySSA version blocks load reuse;
- unknown/may-alias store blocks reuse;
- unknown call blocks unsafe reuse/deletion;
- known narrow effect summary permits only proven-safe optimization;
- volatile/atomic/ordered access retained;
- mayThrow/mayTrap/control/state effects retained where required;
- dead store removed only with MemorySSA/observation proof;
- provenance unions remain complete;
- deterministic/budget/cancellation tests;
- mandatory corpus semantic mismatch remains zero.

## Merge blockers

- pretty text used as value key;
- private pure-call whitelist bypasses function summaries;
- dead-result implies dead-operation;
- memory CSE ignores memory version/effect identity;
- any observable side effect is removed without proof.

## Handoff

P8-4/P8-6 receive simplified but evidence-preserving expressions/memory facts. Integration records quality gains without accepting any semantic regression.

---

# P8-4 — Loop Induction / Loop Simplification Facts

## Inputs

- generic CFG/SSA;
- P8-2 ranges/value sets;
- P8-3 canonicalized expressions where the dependency is proven useful;
- existing loop-repair behavior as compatibility oracle.

## Deliverables

- versioned `InductionSummary`-equivalent artifact;
- init/step/guard/bound/signedness/trip-range/exits/evidence/completeness;
- conservative handling of pointer/wrapping/multi-backedge/early-exit loops;
- reusable loop facts consumed by structuring and aggregate recovery;
- loop simplification candidates with transform proofs where safe.

## Required proof

- canonical integer induction;
- decrementing loop;
- non-unit step;
- wrapping boundary;
- variable/unknown step remains partial;
- pointer induction;
- early exit;
- nested loops;
- cast/copy hidden update;
- multiple backedges;
- irreducible SCC refuses false natural-loop classification;
- deterministic bounded convergence;
- provenance and exact exit-edge preservation.

## Merge blockers

- loop facts inferred from rendering text;
- irreducible SCC forced into a natural loop;
- trip count claimed exact when range/completeness is partial;
- array recovery implements a second induction analyzer instead of consuming this artifact.

## Handoff

P8-5 receives loop facts for structuring. P8-6 receives stride/index/bound facts for aggregate/array recovery.

---

# P8-5 — Irreducible / Exception-Aware Structuring

## Inputs

- authoritative CFG edge kinds;
- dominance/post-dominance/SESE facts;
- P8-4 loop summaries when integrated;
- existing switch/loop structuring as compatibility oracle;
- exception/unwind metadata/facts available from earlier phases.

## Deliverables

- structured-region logic for ordinary reducible cases;
- safe break/continue/switch recovery improvements;
- exception-edge constraints;
- irreducible SCC handling;
- controlled node splitting only with semantic/provenance proof;
- explicit goto/unknown fallback;
- edge-accounting verifier.

## Required proof

- every relevant original CFG edge is accounted for by a structured construct, explicit residual/goto, or explicit unknown;
- `lostCfgEdgeCount = 0`;
- if/else, switch, nested loop, multi-exit, exception path, and irreducible cases;
- false-structuring negative cases;
- necessary goto is preserved;
- node splitting preserves origin/evidence;
- representative cross-architecture CFG shapes;
- Ghidra differential has no unexplained structural regression.

## Merge blockers

- goto reduction used as a correctness objective;
- exception/unknown/indirect edge disappears;
- node splitting duplicates or loses observable effects;
- state-machine/flattening semantics guessed by generic structurer without evidence.

## Handoff

P8-6/P8-7 receive stable high-level regions. Final integration receives edge-accounting evidence.

---

# P8-6 — Aggregate / Array / Union Recovery

## Inputs

- Phase 7 type constraints/provenance/alias facts;
- P8-2 ranges;
- P8-4 induction/stride facts;
- authoritative debug/runtime/call-prototype evidence where available;
- existing conservative layout recovery as compatibility baseline.

## Deliverables

- contradiction-aware aggregate candidate model;
- struct/array/union/object/unknown candidates;
- field/element/stride/extent evidence;
- hard vs soft evidence separation;
- ambiguity/conflict preservation;
- integration with high-variable/prototype/type recovery without creating a second type engine.

## Required proof

- fixed non-overlapping fields;
- indexed arrays;
- struct vs array ambiguity;
- union/overlap;
- padding;
- flexible array member;
- array-of-struct vs struct-of-array;
- embedded object;
- pointer crossing object/region boundary;
- contradictory debug/runtime/type evidence remains contradiction;
- `forcedTypeContradictionCount = 0`;
- type/aggregate accuracy improves without false-certainty increase;
- provenance for every recovered field/element candidate.

## Merge blockers

- highest score automatically becomes certainty;
- source-like type is forced through hard contradiction;
- decompiler creates private pointer/alias/type truth;
- layout inference depends on architecture instruction text.

## Handoff

P8-7 providers may refine nominal/source-language interpretation. Generic candidate facts remain authoritative beneath provider hints.

---

# P8-7 — Language / Compiler Pattern Providers

## Inputs

- stable generic optimizer/recovery/structuring contracts;
- existing ObjC/Swift/architecture/compiler idioms;
- runtime/debug/knowledge evidence surfaces.

## Deliverables

- versioned provider interface;
- migrated/isolated existing target/compiler idioms where appropriate;
- provider-contributed nominal types, idiom candidates, dispatch/state-machine hints, rendering hints, and proved rewrite candidates;
- provider provenance/version/evidence recording;
- conflict behavior against generic/hard evidence.

## Required proof

- provider-off path retains correct generic semantics;
- provider-on improves accepted readability/recovery cases;
- provider never decodes instructions or bypasses Semantic IR/SSA/MemorySSA;
- provider hint cannot override hard contradiction;
- heuristic match is not promoted to confirmed solely by pattern frequency;
- provider version change invalidates only relevant derived artifacts;
- architecture/compiler-specific code remains outside generic pass implementation.

## Merge blockers

- provider becomes second semantic engine;
- provider required for basic instruction meaning;
- provider erases uncertainty/provenance;
- generic pass imports provider-specific target constants.

## Handoff

P8-I receives complete generic + refinement product with provider-off and provider-on evidence.

---

# P8-I — Living Integration / Final Cutover

## Inputs

- every accepted component exact head and checkpoint evidence;
- latest live `main`;
- frozen final verifier/corpus/toolchain acceptance contract;
- generated-output policy/identity.

## Deliverables

- reconciled exact release candidate;
- canonical generated outputs if applicable;
- zero generated diff after rebuild;
- final release-evidence artifact;
- final quality vector and P8-0 baseline comparison;
- capability/support maturity update only where proven;
- merged product and post-merge verification.

## Required proof

Hard zero gates:

```text
semanticMismatchCount = 0
provenanceLossCount = 0
unknownSafetyRegressionCount = 0
forcedTypeContradictionCount = 0
architectureBoundaryViolationCount = 0
transformDeterminismFailureCount = 0
staleArtifactAcceptanceCount = 0
lostCfgEdgeCount = 0
```

And:

- no unexplained Ghidra differential regression;
- no unexplained cross-binary accuracy regression;
- compiler-truth and required semantic/decompiler/migration gates green;
- accepted readability/recovery vector measurably improves from P8-0 baseline;
- active-function/browser/iPad cost is within the accepted release budget;
- all required corpus/toolchain families are present or release is blocked;
- exact candidate SHA, verifier identity, corpus identity, toolchain identity, generated identity, and evidence schema are bound together;
- merge uses expected-head protection;
- post-merge `main` is refetched and the exact product is present;
- active runtime/deployment identity is separately proven if the completion claim depends on it.

## Merge blockers

Any unexplained hard-gate nonzero value, missing required evidence family, stale generated output, stale main reconciliation, verifier semantics changed without re-verification, or unexplained red blocking workflow.

---

## 2. Rolling validation policy

After each component merge into living integration, the next dependent component is blocked until the integration checkpoint transaction completes:

```text
reconcile shared contracts
-> update versions/invalidation
-> canonical generated build if applicable
-> commit generated output by owner
-> rebuild zero diff
-> rolling vertical gate
-> independent verifier
-> exact checkpoint evidence
-> unlock next dependent merge
```

A green component branch is not sufficient evidence.

---

## 3. Process-failure recurrence map

Phase 8 MUST explicitly prevent the applicable historical process failures:

| Historical failure class | Phase 8 prevention |
|---|---|
| Late integration concentration | Living integration and no-op vertical path at P8-0. |
| Cross-scope contamination | Machine-readable ownership + actual changed-file validation. |
| Generated output blocking/misownership | Component ephemeral build; integration-owned canonical sync. |
| Contradictory ownership | P8-0 governance regression against real/expected inventories. |
| Canonical runner misses nested tests | Sentinel discovery test for every allowed subtree. |
| Verifier wired too late | Permanent exact-SHA verifier route at P8-0. |
| Checkpoint sync skipped | Integration checkpoint lock after every component merge. |
| Moving-main churn | One living integration owner reconciles main. |
| Final verifier matures late | Shadow verifier runs from first vertical checkpoint. |
| Validation-only PR chains | Permanent exact-SHA/manual verifier path. |
| CI fanout hides slow algorithm | Profile pathological production function before more sharding. |
| Partial/invalid evidence publication | Validate report schema/content before publication; fail closed. |
| Release identity drift | Generated/release identity tied to exact deployable content where applicable. |
| Browser/iPad assumptions deferred | Browser/iPad cost/cancellation measured throughout, not only final. |

P8-0 should expand this table if newer process failures have been added to `ENGINEERING_PROCESS_GUARDRAILS.md` before Phase 8 starts.

---

## 4. First-divergence rule during Phase 8

When a rolling gate fails:

1. Freeze the exact failing candidate identity.
2. Identify the first deterministic divergence, not the most visible downstream pseudocode symptom.
3. Classify ownership: semantic input, CFG/SSA/MSSA, alias/effect, Phase 8 pass, structuring, provider, artifact invalidation, verifier, generated output, or infrastructure.
4. Reproduce with the smallest valid case without weakening the real corpus gate.
5. Repair the owning layer.
6. Add a regression that fails on the old behavior where feasible.
7. Re-run every evidence class invalidated by the repair.

Do not weaken a semantic, migration, ownership, corpus, or verifier gate merely to make a Phase 8 lane green.

---

## 5. Operator short form

```text
P8-0: freeze truth, ownership, corpus, verifier, baseline.
P8-1: make pass execution transactional and invalidation explicit.
P8-2: prove constants/ranges with exact bitvector semantics.
P8-3: optimize expressions/memory only with alias/effect proof.
P8-4: extract reusable induction facts.
P8-5: structure every edge honestly; goto is allowed.
P8-6: recover aggregates while preserving ambiguity.
P8-7: add language/compiler refinement without semantic authority.
P8-I: prove the exact combined product using the same verifier used all along.
```
