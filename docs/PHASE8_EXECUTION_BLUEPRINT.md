# Phase 8 Execution Blueprint — Decompiler Quality

> **Status:** Pre-implementation execution contract  
> **Scope:** Master Architecture Phase 8  
> **Prepared baseline:** `main` = `e90c5107f9c77d73687ee452d5042dcbe9e79ece`  
> **Read with:** `PHASE8_IMPLEMENTATION_GUIDE.md`, `HEX_MASTER_ARCHITECTURE.md`, `ENGINEERING_PROCESS_GUARDRAILS.md`, `MIGRATION_GUARDRAILS.md`

This document turns the Phase 8 implementation guide into a concrete execution contract. It exists to prevent three classes of failure: implementing the right algorithms in the wrong layer, producing prettier but unsound pseudocode, and discovering integration/verifier problems only after all component work is finished.

The baseline is intentionally recorded. **P8-0 MUST refetch live `main` and regenerate the readiness matrix before implementation begins.** Any baseline observation below is a starting point, not permission to ignore changes introduced by Phase 6, Phase 7, or unrelated current-main work.

---

## 1. Phase 8 success definition

Phase 8 is complete only when all four dimensions improve or remain safe:

```text
semantic correctness      hard gate
provenance/evidence       hard gate
readability/recovery      measurable improvement
browser/iPad cost         bounded and acceptable
```

A readability improvement is rejected if it introduces a semantic mismatch, drops provenance, converts unknown into false certainty, crosses an unproved alias/effect boundary, embeds an architecture assumption in a generic pass, or materially violates the product latency/budget contract.

The canonical Phase 8 migration deliverables remain:

- SCCP;
- GVN/CSE;
- effect-aware DCE;
- richer ranges/value sets;
- loop induction;
- irreducible/exception structuring;
- aggregate/array recovery;
- language pattern providers.

The broader decompiler architecture also requires a mature middle-end containing copy propagation, alias-proved load/store forwarding, pointer/address normalization, loop simplification, switch/prototype recovery, aggregate/union recovery, variable coalescing, tail-call/thunk normalization, and exception-aware analysis. Phase 8 MUST audit those capabilities at P8-0. Existing implementations may satisfy some requirements; they are not automatically reimplemented.

---

## 2. Baseline audit that P8-0 must repeat

At the prepared baseline:

### 2.1 Existing pass infrastructure

`js/decompiler/passes/manager.js` already provides a shared pass manager with a global deadline, node budget, iteration cap, optional-pass skipping, degraded-state reporting, and pass metrics. Its defaults are currently 40 ms / 12,000 nodes / 16 iterations. `pipeline-core.js` instantiates it with a 50 ms default total decompiler budget unless overridden.

This is useful infrastructure, but Phase 8 must strengthen the semantics of partial execution before adding heavy fixed-point optimizers.

### 2.2 Existing pipeline order

The current `pipeline-core.js` pass sequence is approximately:

```text
high-variable recovery
prototype recovery
aggregate-layout recovery
canonical expression build
semantic rewrite
semantic facts
semantic AST
C AST
pretty print
```

This flat sequence is not yet a sufficient dependency model for Phase 8. Loop induction, range refinement, GVN, DCE, aggregate recovery, and structuring have analysis dependencies that must be explicit.

### 2.3 Existing rewrite engine

`js/decompiler/rewrite/engine.js` already provides named phases, preconditions, proof records, deterministic structural keys, iteration/application/node/time budgets, and fixed-point behavior.

Phase 8 should reuse its good properties rather than create a second rewrite framework. The new optimizer pass contract must, however, make analysis preservation/invalidation and cancellation atomicity explicit.

### 2.4 Existing memory substitution

`pipeline-core.js` already substitutes a reaching store into a load when the Semantic IR / MemorySSA layer has retained an exact reaching-store relation. That is the correct direction: **MemorySSA is the proof source; the decompiler does not independently guess memory equality.**

Phase 8 GVN/CSE and DCE must preserve this rule and generalize it through typed memory/effect queries rather than duplicate address-pattern heuristics.

### 2.5 Existing recovery is a starting point, not final Phase 8 quality

- `types/high-variables.js` performs conservative SSA coalescing.
- `types/prototype.js` performs prototype recovery.
- `types/layout.js` performs conservative aggregate/array-shaped recovery from MemorySSA access patterns.
- `loop-repair.js` and `switch.js` already contain control-flow recovery logic.

These areas must be **audited before replacement**. Phase 8 should deepen or generalize them only where the exit metrics and cross-architecture contract require it.

### 2.6 Known architecture-neutrality debt to re-audit

At the prepared baseline, `types/high-variables.js` and `types/prototype.js` still contain explicit AAPCS64 register conventions (`x0..x7`, `v0..v7`, `x8`) and `prototype.js` returns `convention: 'AAPCS64'`.

Phase 5/6/7 may change this before Phase 8 begins. P8-0 must recheck it. If it remains, Phase 8 must not build generic optimizer logic on top of that assumption. ABI facts should come through the target/ABI boundary or a compatibility provider.

### 2.7 Existing differential infrastructure

The repository already has a mandatory Ghidra decompiler differential workflow, compiler-truth reporting, cross-binary accuracy, semantic/decompiler regressions, and bounded decompiler equivalence support. At the prepared baseline the Ghidra workflow uses the official pinned Ghidra release and requires a real compiler-truth comparison rather than a skipped result.

Phase 8 must extend this release path; it must not create a separate final-only verifier.

---

## 3. P8-0 readiness matrix

Before any optimizer component starts, create a checked-in readiness report with one row for every mature decompiler capability.

Recommended states:

```text
PROVEN_EXISTING
PARTIAL_EXISTING
PHASE8_IMPLEMENT
UPSTREAM_BLOCKED
INTEGRATION_ONLY
NOT_REQUIRED_FOR_P8_EXIT
```

Minimum rows:

| Capability | P8-0 question | Expected action |
|---|---|---|
| SCCP | Dedicated executable-edge-aware implementation exists? | Usually `PHASE8_IMPLEMENT` unless prior work added it. |
| Copy propagation | Already semantically covered by SSA/expression construction/rewrite? | Prove behavior; do not duplicate blindly. |
| GVN/CSE | Dedicated generic implementation exists? | Implement if absent. |
| Effect-aware DCE | Can unused pure operations be removed without deleting observable effects? | Implement with effect proof. |
| Range/value set | Is machine-width wrapped reasoning available to decompiler consumers? | Strengthen as required. |
| Load/store forwarding | Is forwarding exclusively MemorySSA/alias proved? | Preserve and extend proof API. |
| Pointer/address normalization | Are equivalent address forms canonicalized architecture-neutrally? | Audit rewrite/current semantic layer. |
| Loop induction | Are canonical induction summaries available? | Implement if absent. |
| Loop simplification | Does current loop repair use proved CFG/induction facts? | Deepen only where needed. |
| Switch recovery | Existing `switch.js` coverage sufficient? | Regression-prove before touching. |
| Prototype recovery | Is it ABI-generic after Phase 5/6? | Upstream/compatibility fix if not. |
| Aggregate/array/union | Does recovery preserve ambiguity/contradictions? | Strengthen candidate model. |
| Variable coalescing | Is it SSA/proof-based and architecture-neutral? | Preserve conservative behavior; remove ABI assumptions if still present. |
| Tail-call/thunk normalization | Existing coverage present and generic? | Audit; implement only if Phase 8 exit needs it. |
| Exception-aware analysis | Are exception edges preserved into structuring? | Required blocker for unsafe structuring. |
| Language providers | Are architecture/compiler idioms isolated behind providers? | Introduce/finish provider boundary. |

No row may be silently omitted. Unknown repository status is `UPSTREAM_BLOCKED` or an explicit audit task, never “probably done”.

---

## 4. Dependency graph and pass staging

Do not treat Phase 8 as one flat pass list.

Recommended logical stages:

```text
Stage A — canonical semantic inputs
  Semantic IR + CFG + SSA + MemorySSA
  Phase 7 alias/range/summary/type facts

Stage B — scalar facts
  SCCP
  wrapped range/value-set refinement
  copy/canonical scalar propagation

Stage C — expression/memory optimization
  GVN/CSE
  alias-proved load forwarding
  effect-aware DCE
  pointer/address normalization

Stage D — loop facts
  induction summaries
  loop simplification candidates

Stage E — high-level recovery
  high-variable refinement
  prototype refinement
  aggregate/array/union candidate recovery

Stage F — control-flow structuring
  switch/SESE/if/loop structuring
  exception constraints
  irreducible SCC handling
  goto fallback

Stage G — language/compiler refinement
  ObjC/Swift/C++/Rust/Go/etc providers

Stage H — AST/render
  semantic AST
  C AST / target language projection
  pretty print + source map
```

A stage may iterate internally, but cross-stage cycles must be explicit and bounded. In particular, do not create an uncontrolled `range -> induction -> aggregate -> type -> range` loop. If refinement feedback is useful, define a small numbered refinement round with a deterministic convergence cap and record whether precision was widened/degraded.

---

## 5. Pass transaction contract

The current pass manager allows budget exhaustion and optional skipping. Phase 8 adds heavier transformations, so **partial mutation must become a first-class failure mode**.

A Phase 8 optimizer pass should logically behave like:

```ts
PassDescriptor {
  id
  version
  stage
  required
  consumes
  preserves
  invalidates
  budgetClass
}

PassResult {
  status: "unchanged" | "changed" | "degraded" | "unsupported"
  outputArtifact
  transforms
  diagnostics
  stats
  completeness
  preservedAnalyses
  invalidatedAnalyses
}
```

Required rules:

1. Canonical Semantic IR/SSA/MemorySSA truth is not mutated in place merely to improve decompiler output.
2. A pass computes into a staged result and publishes only at a safe commit point.
3. Cancellation/deadline before publication leaves the previous valid artifact authoritative.
4. A pass that changes CFG invalidates dominance/post-dominance, loop regions, executable-edge state, and any dependent fact not explicitly preserved.
5. A pass that changes value expressions must declare whether ranges/value numbers remain valid.
6. A pass that changes memory-visible operations must invalidate dependent MemorySSA/effect facts unless the transform has a proof-preserving mapping.
7. “Skipped due budget” is not equivalent to “analysis complete”. Completeness/degraded state must flow to metrics/UI/evidence.
8. A required finalization pass may run after the optimization budget, but it may not infer facts that skipped optimizer passes would have produced.

Add regressions for abort-before-start, abort-mid-pass, deadline at publication boundary, exception during staging, repeated execution, and deterministic replay.

---

## 6. Analysis-preservation contract

Every transform must answer: **what facts are still valid after this change?**

Minimum preservation categories:

```text
CFG
DominatorTree
PostDominatorTree
LoopForest
ExecutableEdges
SSA
DefUse
MemorySSA
AliasFacts
RangeFacts
ValueNumbers
TypeConstraints
FunctionSummary
OriginMap
```

Do not use one global “invalidate everything” as the permanent design. It is safe but can destroy iPad performance and ArtifactStore reuse. Conversely, retaining all analyses is unsound.

P8-1 should add tests that deliberately mutate one category and prove exactly the expected dependent analyses are invalidated.

---

## 7. SCCP contract

SCCP must be sparse and executable-edge aware.

Minimum value lattice:

```text
UNDEFINED/UNREACHABLE
CONSTANT(bits, value)
OVERDEFINED/UNKNOWN
```

Rules:

- Phi joins only executable predecessors.
- Edge executability is proved from exact machine-width semantics.
- Constant operations use exact bit width, truncation/extension, modular wrap, and signed/unsigned comparison semantics.
- Unknown/unsupported operations produce `UNKNOWN`, not guessed constants.
- Memory values are not folded across store/call barriers without MemorySSA/effect proof.
- Branch pruning preserves origin and records the consumed condition/evidence.
- Unreachable removal never deletes an unresolved/unknown edge merely for readability.

Negative corpus must include wraparound, signed/unsigned disagreement, partial phi executability, unknown call, unknown store, unsupported operation, unresolved branch, and provenance after edge removal.

---

## 8. Range/value-set contract

The minimum useful Phase 8 domain is machine-width aware. A plain mathematical interval is insufficient.

Required semantics:

- exact bit width;
- wrapped intervals or an equally conservative representation;
- signed and unsigned query views;
- singleton constants;
- unknown/top;
- deterministic widening for loops;
- explicit precision-loss diagnostics.

Optional precision such as known-zero/known-one bits or small finite value sets may be added only if it remains bounded and versioned.

Range facts are proof inputs for branch reasoning, switch recovery, induction, pointer offsets, and aggregate candidates. They must not directly force a source-level type.

---

## 9. GVN/CSE contract

### 9.1 Scalar value numbering

A scalar value key is based on semantic operation identity, exact machine width, canonical operands, and operation-specific semantic flags. It is never based on pretty-printed text.

### 9.2 Memory value numbering

A load may participate only when all relevant identity is represented, conceptually:

```text
load-value-key =
  address-value
  + memory-version
  + access-width
  + volatility/atomic/order semantics
  + relevant type/extension semantics
```

An unknown store, aliasing store, unknown call, volatile/atomic boundary, or changed memory version blocks reuse unless the owning analysis proves otherwise.

### 9.3 Traps and observability

Do not CSE operations where removing one execution changes an observable trap/fault/ordering behavior unless equivalence is explicitly proven under Hex's machine semantics.

---

## 10. Effect-aware DCE contract

DCE requires both:

```text
result is dead
AND
operation has no required observable effect
```

The effect query must account for, at minimum:

- memory reads/writes;
- volatile access;
- atomics/order;
- unknown calls;
- known call summaries;
- mayThrow/unwind;
- mayTrap/fault where relevant;
- control flow;
- live flag/state effects;
- runtime/language intrinsics.

Unknown is blocking. A missed deletion is acceptable; deletion of an observable operation is a semantic regression.

Memory DCE must use MemorySSA/alias/effect proof. “A later store overwrites this location” is insufficient if any intervening operation may observe the first store.

---

## 11. Loop induction and loop simplification contract

Produce reusable facts rather than rendering-specific guesses.

Recommended summary:

```ts
InductionSummary {
  phiValueId
  init
  step
  updateKind
  guard
  bound
  signedness
  tripCountRange
  exits
  evidenceIds
  completeness
}
```

Must handle conservatively:

- multiple backedges;
- variable step;
- wrapping induction;
- pointer induction;
- early exits;
- nested loops;
- casts/copies around updates;
- derived guard values;
- irreducible SCCs.

Consumers include range refinement, array recovery, pointer stride, loop rendering, and simplification. They must share this result rather than rediscover induction independently.

---

## 12. Structuring contract

Structuring quality must never be measured by “zero goto”.

Required inputs/constraints:

- dominance and post-dominance;
- explicit CFG edge kinds;
- natural loops;
- SESE regions;
- switch edges;
- exception/unwind edges;
- unresolved/indirect edges;
- induction/loop facts when available.

Recommended order:

```text
dominance/post-dominance
natural loops
SESE candidates
if/else + switch
break/continue
exception constraints
irreducible SCC handling
safe node splitting where proved
explicit goto fallback
```

Every original relevant CFG edge must be accounted for by a structured construct, an explicit residual edge/goto, or an explicit unknown/unsupported representation. A disappeared edge is a hard failure.

Flattened/state-machine recovery is a recognition layer, not permission for generic structuring to invent semantics.

---

## 13. Aggregate/array/union recovery contract

The current baseline layout recovery is intentionally conservative and useful, but Phase 8 needs a contradiction-aware candidate model.

Recommended result:

```ts
AggregateCandidate {
  kind: "struct" | "array" | "union" | "object" | "unknown"
  rootIdentity
  extent
  fields
  element
  stride
  hardConstraints
  softEvidence
  contradictions
  confidence
  evidenceIds
  completeness
}
```

Inputs may include pointer provenance, alias region, access width, fixed offsets, induction stride, range facts, authoritative debug info, call prototypes, runtime metadata, and language-provider evidence.

Hard conflicts remain conflicts. The decompiler must not collapse `struct-or-array` ambiguity into a prettier single answer without proof.

Special negative cases: overlapping fields, unions, flexible array members, array-of-struct vs struct-of-array, padding, embedded objects, pointer arithmetic crossing region/object boundaries, and unrelated accesses sharing a syntactically similar base.

---

## 14. ABI, prototype, variable, tail-call, and thunk readiness

Phase 8 is architecture-neutral middle-end work. It must not accidentally freeze legacy AAPCS64 assumptions.

At P8-0:

1. Re-audit `types/prototype.js` and `types/high-variables.js` after Phase 5/6/7.
2. Require ABI argument/return facts to come from the target/ABI layer or a compatibility provider.
3. Keep source-variable identity based on SSA/provenance, not physical-register reuse.
4. Audit tail-call/thunk normalization and ensure it consumes generic call/control-flow facts.
5. Treat any remaining architecture-specific naming/presentation rule as a refinement/provider concern, not generic optimizer truth.

If cross-architecture prototype recovery is still incomplete, record it as a Phase 8 prerequisite/blocker rather than hiding it in SCCP/GVN logic.

---

## 15. Language/compiler provider contract

Providers run after generic semantics and may contribute:

- idiom matches;
- nominal type candidates;
- dispatch/vtable/witness interpretation;
- closure/state-machine candidates;
- source-like rendering hints;
- semantic rewrite candidates with named preconditions.

They may not:

- decode instructions;
- reinterpret machine semantics;
- bypass SSA/MemorySSA;
- manufacture alias/effect facts;
- override hard type contradictions;
- erase provenance;
- promote a common pattern to `confirmed` without deterministic evidence.

The baseline direct ARM64/Clang refinement in `pipeline-core.js` should be re-audited. If still present, Phase 8 should move toward a provider boundary with compatibility preserved rather than proliferating direct target imports.

---

## 16. Provenance and transform evidence

Every Phase 8 transform must preserve a path:

```text
rendered/HighIR node
  -> transform record
  -> consumed semantic nodes
  -> SSA/MemorySSA
  -> instruction IDs
  -> binary byte ranges
```

Hard gates on the mandatory corpus:

```text
orphanProducedNodes = 0
danglingConsumedNodeRefs = 0
provenanceLossCount = 0
unexplainedSourceRangeLoss = 0
originDeterminismFailures = 0
```

A rewrite proof should record at least rule/pass identity and version, consumed/produced IDs, preconditions, proof kind, origin union, evidence IDs, and completeness/degraded state.

Do not store model chain-of-thought. This is deterministic transform metadata.

---

## 17. Readability and correctness metrics

Do not collapse Phase 8 into one score.

### Hard gates

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

### Quality vector

Track distributions and selected golden cases for:

- control-structure recovery;
- variable merge/split quality;
- prototype accuracy;
- type accuracy;
- aggregate field/array recovery;
- unnecessary temporaries;
- redundant assignments/expressions;
- goto count where semantics permit reduction;
- expression complexity/depth;
- raw phi leakage;
- unresolved switch count;
- raw pointer-arithmetic count;
- source/provenance coverage.

A metric may regress on an individual function for a correctness reason. Example: restoring a necessary goto is a quality improvement even though `gotoCount` rises. Such exceptions must be explicit in evidence, not hidden by a blended score.

---

## 18. Corpus contract

P8-0 must freeze the mandatory Phase 8 corpus identity and record its provenance.

The long-term architecture requires coverage across:

```text
AArch64 / x86-64 / RISC-V64
Mach-O / ELF / PE
O0 / O1 / O2 / O3 / Os/Oz / LTO where available
C / C++ / Objective-C / Swift / Rust / Go
Clang/LLVM / GCC / MSVC / rustc / Swift / Go where available
paired debug + stripped builds where applicable
```

P8-0 does not need to invent unavailable fixtures. It must enumerate what is mandatory for the Phase 8 release, what is unavailable, and why. Missing required families must fail closed rather than silently reducing the contract.

Golden micro-cases must include both positive and adversarial cases for every transform family.

---

## 19. Existing verifier integration

Phase 8 should preserve and extend these existing proof surfaces:

```bash
npm run semantic:test
npm run decompiler:test
npm run compiler-truth
npm run integration:test
npm run migration:test
npm run check
```

And CI/evidence surfaces including:

- Ghidra decompiler differential;
- cross-binary accuracy;
- invariant/migration gates;
- compiler-truth report;
- decompiler equivalence support;
- architecture-specific semantic gates from earlier phases.

P8-0 must add a permanent exact-SHA Phase 8 verification entry point. Final verification is a re-run of that path on the exact release candidate.

Verifier acceptance-rule changes invalidate affected prior Phase 8 evidence.

---

## 20. Artifact identity and invalidation

Each Phase 8 artifact must be version-keyed by all semantically relevant producers/inputs, as applicable:

- Semantic IR schema/version;
- architecture semantic version;
- ABI semantic version;
- CFG/SSA/MemorySSA version;
- alias/range/summary/type version;
- pass implementation/version;
- pass options;
- provider version;
- metadata/debug-info version;
- relevant corpus/verifier identity for release evidence.

Test both:

- under-invalidation: stale artifact accepted after relevant input changed — correctness failure;
- over-invalidation: unrelated change destroys reusable artifact — performance failure.

Do not use broad cache clearing as the permanent substitute for a correct ArtifactKey.

---

## 21. Budget, cancellation, and iPad/browser performance

The browser/iPad product constraint is architectural, not a late benchmark.

Required metrics:

- per-pass elapsed time;
- iteration count;
- nodes/edges visited;
- value numbers/range states created;
- peak retained analysis memory;
- cancellation latency;
- cold/warm artifact reuse;
- active-function decompilation latency;
- browser p95/p99 responsiveness where available.

Rules:

1. Do not run the complete optimizer over the whole binary by default.
2. Prefer active/queried function and demanded dependencies.
3. Every fixed-point analysis has deterministic convergence/budget behavior.
4. Budget exhaustion produces an explicit degraded/partial result, never unsafe inference.
5. Before increasing CI sharding to hide slowness, profile a representative pathological production function and fix algorithmic hotspots first.
6. Add complexity guards for known pathological structures where practical.

---

## 22. Component DAG for efficient execution

Recommended dependency graph:

```text
P8-0 foundation/verifier
  |
  v
P8-1 pass transaction + preservation substrate
  |
  +--> P8-2 SCCP/range
  |       |
  |       +--> P8-4 loop induction
  |       |       |
  |       |       +--> P8-6 aggregate/array recovery
  |       |
  |       +--> P8-3 GVN/CSE + DCE
  |
  +--> P8-5 structuring foundation
          ^       |
          |       v
          +--- P8-4 loop facts

P8-7 language providers starts only after generic contracts are stable.
P8-I integrates every accepted component through the living integration lane.
```

Useful parallelism:

- P8-0 verifier/ownership and baseline measurement can be split between non-overlapping workers, but one integration owner freezes the contracts.
- After P8-1, SCCP/range implementation and structuring test/corpus preparation may proceed in parallel if they do not share pipeline wiring.
- GVN/DCE design/tests may begin in parallel, but production integration waits for the required alias/effect/range contracts.
- Aggregate recovery corpus/provider research may begin early; production recovery integrates only after induction/type facts are stable.
- Language providers are deliberately late to prevent heuristics from hiding generic gaps.

Do not create parallel lanes merely to fill Worker slots.

---

## 23. Proposed lane ownership

P8-0 must convert this into the actual machine-readable ownership manifest after inspecting the then-current repository.

Suggested conceptual lanes:

```text
p8-0  foundation / runner / ownership / baseline / exact-SHA verifier
p8-1  pass transaction + preservation/invalidation substrate
p8-2  SCCP + wrapped ranges/value sets
p8-3  GVN/CSE + effect-aware DCE
p8-4  loop induction + loop simplification facts
p8-5  irreducible/exception structuring
p8-6  aggregate/array/union recovery
p8-7  language/compiler providers
p8-v  independent verifier/corpus evolution if separation is useful
p8-i  living integration + generated output + cutover
```

Shared high-conflict paths such as `pipeline-core.js`, public decompiler entrypoints, package/workflow wiring, generated runtime artifacts, and capability/support metadata should normally be integration-owned rather than edited concurrently by every component lane.

Actual path ownership must be validated against real changed-file inventories before fanout.

---

## 24. Integration checkpoint transaction

Before accepting a component into living integration:

1. Refetch live `main`, integration head, and exact component head.
2. Reconcile integration with moving `main` if required.
3. Confirm component head did not move after review.
4. Build the candidate merge tree.
5. Run ownership/governance on the candidate tree.
6. Run the rolling Phase 8 vertical gate and independent verifier on that tree.
7. Merge the component only if the candidate is green.

After merge, integration is checkpoint-locked until:

1. cross-pass/shared-contract reconciliation completes;
2. semantic/artifact/pass versions are updated if required;
3. canonical generated output is rebuilt by the correct owner if applicable;
4. generated rebuild produces zero diff;
5. rolling product gates pass;
6. independent shadow verification passes;
7. exact checkpoint SHA, integrated component head, verifier identity, corpus identity, generated identity, metrics, and blockers are recorded.

Only then may the next dependent component merge.

---

## 25. Generated-output rule

Decompiler changes may affect deployable protected/browser runtime artifacts depending on the then-current build graph. P8-0 must determine the exact generated-output relationship.

If Phase 8 source affects committed generated artifacts:

- component lanes build/test generated output ephemerally;
- component lanes do not commit shared generated output unless explicitly assigned ownership;
- integration owns canonical generated synchronization;
- generated files are regenerated from reconciled source, never hand-merged;
- zero generated diff after rebuild is a checkpoint/release requirement;
- release identity must represent the exact deployable content.

---

## 26. Failure taxonomy

Phase 8 tooling/reports should distinguish at least:

```text
semantic-mismatch
provenance-loss
unknown-safety-regression
alias-proof-missing
effect-proof-missing
range-overprecision
cfg-edge-loss
structuring-unsupported
irreducible-unsupported
exception-model-incomplete
type-contradiction
forced-type-certainty
architecture-boundary-violation
pass-budget-exhausted
pass-cancelled
pass-partial-publication
analysis-invalidation-error
artifact-under-invalidation
artifact-over-invalidation
verifier-regression
corpus-incomplete
ghidra-differential-regression
performance-regression
merge-conflict
generated-output-stale
```

Do not collapse these into a generic “decompiler failed”.

---

## 27. Per-component definition of done

A Phase 8 component is not done when its positive examples look better.

Each component must provide:

1. exact base/head identity;
2. actual changed-file inventory within ownership;
3. public or internal contract/version changes;
4. positive transformation cases;
5. near-miss/negative cases;
6. unknown/partial cases;
7. width/signedness cases where relevant;
8. memory/call/effect barriers where relevant;
9. provenance assertions;
10. determinism assertions;
11. cancellation/budget assertions for expensive passes;
12. artifact invalidation tests if it creates a persistent/reusable result;
13. applicable architecture matrix;
14. candidate-merge-tree proof before integration;
15. exact checkpoint evidence after integration.

---

## 28. P8-I release gate

Before declaring Phase 8 complete:

- reconcile living integration with current `main`;
- freeze exact release candidate SHA;
- regenerate committed generated output if applicable and require zero diff;
- run all blocking exact-SHA workflows;
- run the mature Phase 8 verifier with the frozen corpus/oracle/toolchain identity;
- require semantic mismatch count = 0;
- require provenance loss count = 0;
- require unknown-safety regression count = 0;
- require forced type contradiction count = 0;
- require lost CFG edge count = 0;
- require no unexplained Ghidra differential regression;
- require no unexplained cross-binary accuracy regression;
- demonstrate measurable accepted readability/recovery improvement versus P8-0 baseline;
- demonstrate acceptable active-function/browser/iPad cost;
- confirm no generic pass introduced architecture-specific semantic authority;
- confirm capability/support maturity is not promoted beyond evidence;
- merge with expected-head protection;
- refetch `main` and prove the merged product is present;
- if runtime/deployment activation is required for the claim, prove active identity separately.

Final verification should be boring. If P8-I is the first time the real combined product sees the real verifier, P8-0 was incomplete.

---

## 29. What not to do

- Do not rewrite the decompiler from scratch.
- Do not create a second Semantic IR or alias engine for optimizer convenience.
- Do not use pretty text as a semantic key.
- Do not assume unknown calls are pure.
- Do not common loads across a changed/unknown memory version.
- Do not delete operations only because their result is unused.
- Do not use mathematical-integer ranges for fixed-width machine semantics.
- Do not drop exception/indirect/irreducible edges to reduce goto count.
- Do not force one aggregate/type candidate through contradictory evidence.
- Do not embed ARM64/AAPCS64 assumptions in generic Phase 8 passes.
- Do not run unbounded fixed points in the browser.
- Do not let cancellation publish half-transformed state.
- Do not clear all artifacts as a permanent invalidation strategy.
- Do not mature the verifier at final release.
- Do not hand-merge generated outputs.
- Do not use old-head green CI as evidence for a new candidate.

---

## 30. Start sequence

When Phase 8 actually starts, execute in this order:

```text
0. Refetch live main and Phase 6/7 completion evidence.
1. Rebuild the P8-0 readiness matrix from the actual source tree.
2. Freeze ownership, pass contract, corpus identity, baseline metrics, and exact-SHA verifier.
3. Wire one no-op/identity pass through the production path and prove zero output/semantic/provenance change.
4. Make pass publication/cancellation/analysis invalidation transactional and tested.
5. Implement SCCP with executable-edge and exact-width semantics.
6. Add wrapped ranges/value sets and deterministic widening.
7. Implement scalar GVN/CSE; add memory reuse only through MemorySSA/alias/effect proof.
8. Implement effect-aware DCE with exhaustive observable-effect negative cases.
9. Add reusable loop induction summaries and bounded loop refinement.
10. Strengthen exception-aware and irreducible structuring with explicit goto fallback.
11. Deepen aggregate/array/union recovery from shared facts while preserving contradictions.
12. Audit/genericize prototype/variable/tail/thunk behavior where the current tree still needs it.
13. Add language/compiler refinement providers only after generic quality is proven.
14. Run the same rolling exact-SHA verifier after every integration checkpoint.
15. Perform P8-I final exact-product verification and cutover.
```

The optimization rule for Phase 8 is simple:

> **If a prettier result requires a fact Hex cannot prove, keep the uglier truthful result and improve the owning analysis layer instead.**
