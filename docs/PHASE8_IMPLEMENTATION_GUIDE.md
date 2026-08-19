# Phase 8 Implementation Guide — Decompiler Quality

> **Status:** Pre-implementation planning guide  
> **Scope:** Master Architecture Phase 8 only  
> **Prepared against:** `main` at `e90c5107f9c77d73687ee452d5042dcbe9e79ece`  
> **Canonical architecture:** `docs/HEX_MASTER_ARCHITECTURE.md`  
> **Normative process:** `docs/ENGINEERING_PROCESS_GUARDRAILS.md` and `docs/MIGRATION_GUARDRAILS.md`

This document is intentionally written before Phase 8 starts. Its purpose is to remove design ambiguity and expose the difficult parts early so implementation can proceed as a sequence of small, independently provable upgrades rather than one large decompiler rewrite.

It is not a substitute for the Master Architecture. If this guide conflicts with the canonical architecture or a later accepted ADR, the canonical contract wins.

---

## 1. What Phase 8 actually is

Phase 8 is **not** “build a decompiler”. Hex already has a substantial decompiler stack:

- `js/decompiler/semantic-core.js`
- `js/decompiler/semantic.js`
- `js/decompiler/pipeline-core.js`
- `js/decompiler/pipeline.js`
- `js/decompiler/passes/manager.js`
- `js/decompiler/rewrite/engine.js`
- `js/decompiler/rewrite/rules.js`
- `js/decompiler/loop-repair.js`
- `js/decompiler/switch.js`
- `js/decompiler/type-recovery.js`
- `js/decompiler/provenance.js`
- `js/decompiler/verify/equivalence.js`

There are already dedicated stack-phi and stack-return recovery passes, architecture/compiler idiom refinements, AST/pretty-printing code, semantic tests, compiler-truth tests, and Ghidra differential infrastructure.

Phase 8 therefore has one job:

> Make the existing architecture-neutral semantic/decompiler pipeline materially more precise and readable **without weakening semantics, alias safety, uncertainty, provenance, or cross-architecture behavior**.

The Master Architecture names the Phase 8 deliverables as:

- SCCP;
- GVN/CSE;
- effect-aware DCE;
- richer ranges/value sets;
- loop induction;
- irreducible/exception structuring;
- aggregate/array recovery;
- language pattern providers.

The exit contract is equally important:

- zero semantic regressions on the mandatory corpus;
- readability improves measurably;
- Ghidra differential diagnostics do not regress;
- provenance coverage remains complete.

---

## 2. Phase 8 must not compensate for unfinished Phase 7

Phase 8 depends heavily on Phase 7. Do not paper over missing static-analysis depth with decompiler heuristics.

Before Phase 8 implementation begins, Phase 7 should have delivered and cut over the required foundations:

- region/field-aware alias improvements at the planned A1/A2/A3 levels;
- escape analysis;
- versioned function summaries;
- hard type constraints;
- debug-information ingestion needed by the type pipeline;
- cross-architecture function discovery improvements.

The key rule is:

> If a transformation needs a fact that belongs to alias, effects, type constraints, function summaries, or function discovery, fix the producer of that fact. Do not teach the decompiler to guess it privately.

Examples:

- Do **not** let CSE assume two loads are equal because their pretty-printed addresses look equal. Use MemorySSA/alias proof.
- Do **not** let DCE delete a call because its return value is unused. Use the call effect summary.
- Do **not** make aggregate recovery silently force a struct when Phase 7 type constraints still conflict.
- Do **not** reconstruct loops by ignoring unresolved exceptional edges.

If Phase 7 leaves a capability explicitly partial, Phase 8 should preserve that partial/unknown state and structure around it conservatively.

---

## 3. The mental model: improve projections, never invent a second truth

The safe Phase 8 pipeline is:

```text
Low-Level Effects
    ↓
Semantic IR
    ↓
CFG
    ↓
SSA + MemorySSA
    ↓
Alias / ranges / summaries / type constraints
    ↓
Decompiler optimization passes
    ↓
High-level variable/type recovery
    ↓
Control-flow structuring
    ↓
Language/runtime refinement providers
    ↓
Structured AST
    ↓
Pretty printer
```

Three consequences follow.

### 3.1 The decompiler must not decode instructions again

`js/decompiler/pipeline-core.js` is already protected by migration guardrails: it consumes semantic analysis and must not become a second decoder/backend path.

Phase 8 must preserve that contract.

### 3.2 Pretty output is never an optimization proof

A rewrite is valid because its preconditions are proved in Semantic IR/SSA/MemorySSA/effect analysis, not because the result “looks like C”.

### 3.3 Goto is preferable to a lie

If an irreducible or exceptional CFG cannot be structured safely, controlled `goto`/partial structuring is the correct output. “No goto” is not a correctness target.

---

## 4. Recommended Phase 8 execution shape

Follow the engineering guardrails: build a living integration lane, ownership rules, exact-SHA verifier path, and vertical skeleton before parallel component work.

The checkpoints below are logical checkpoints. They do not require exactly one PR each, but ownership and dependencies should follow this order.

### P8-0 — Foundation, baseline, and verifier

Deliver before optimizer work fans out:

1. A living Phase 8 integration branch/PR.
2. A machine-readable Phase 8 ownership manifest.
3. A canonical Phase 8 test runner that discovers every owned test subtree.
4. A permanent exact-SHA Phase 8 verifier invocation path.
5. Baseline quality/evidence artifacts for the mandatory corpus.
6. A pass contract that preserves provenance and records transform diagnostics.
7. A “no semantic change” vertical pass wired through the production decompiler pipeline.

The no-op vertical pass matters. It proves the final wiring, artifact/version/invalidation path, diagnostics, cancellation behavior, and provenance accounting before SCCP/GVN/DCE are introduced.

Do not freeze lane contracts until this walking skeleton is green.

### P8-1 — Shared optimizer substrate

Deliver the reusable machinery needed by later passes:

- stable pass input/output contract;
- pass ordering and dependency declaration;
- deterministic fixed-point iteration where required;
- change detection;
- bounded iteration/fail-closed behavior;
- transform/provenance records;
- per-pass stats/diagnostics;
- invalidation rules for derived analyses.

Do not build eight independent pass frameworks.

### P8-2 — SCCP + richer ranges/value sets

Implement sparse executable-edge-aware constant propagation first because later passes benefit from cleaner constants, branches, and reachability.

Then extend the integer/value domain conservatively.

### P8-3 — GVN/CSE + effect-aware DCE

Only after SCCP/range information and Phase 7 memory/effect facts are available.

The important work here is not hash tables. It is proving when expressions are equivalent and when operations are removable.

### P8-4 — Loop induction reasoning

Use the existing CFG/loop recovery as input and add canonical induction summaries rather than another loop detector.

### P8-5 — Irreducible and exception-aware structuring

Strengthen region structuring after the CFG and loop facts are stable.

### P8-6 — Aggregate/array recovery

Build on Phase 7 type constraints, pointer provenance, alias regions, ranges, and induction facts.

### P8-7 — Language pattern providers

Run language/compiler refinement after architecture-neutral semantics and generic decompiler passes. Providers must improve presentation/recovery without becoming semantic foundations.

### P8-I — Final integration/cutover

Re-run the already-mature exact-SHA verifier on the exact candidate integration product. Final verification should be a repeat of the same proof process used after each checkpoint, not a new test architecture assembled at the end.

---

## 5. Pass contract: the first thing to get right

Phase 8 will become hard to reason about if each optimization mutates AST/IR ad hoc.

A recommended logical contract is:

```ts
OptimizationPassResult {
  changed: boolean
  output
  transforms: TransformResult[]
  diagnostics
  stats
  completeness
}

TransformResult {
  ruleId
  consumedNodeIds
  producedNodeIds
  preconditions
  proofKind
  originUnion
  evidenceIds
  confidence
}
```

The exact public shape may differ, but the following properties are mandatory:

- deterministic result for the same versioned input;
- no hidden architecture decoding;
- explicit unknown/unsupported behavior;
- no transform may drop provenance;
- every semantics-affecting rewrite has named preconditions;
- pass iteration is bounded;
- pass failure does not silently fall back to an unsafe rewrite path.

A rewrite that only changes formatting may have lighter proof requirements, but it still must preserve origin mapping.

---

## 6. SCCP: simple algorithm, difficult semantics

SCCP is often described as “constant propagation + dead branch removal”. The difficult part in Hex is respecting executable edges, SSA, bit widths, unknown values, calls, and provenance.

### 6.1 Use a real lattice

At minimum, the value domain needs the equivalent of:

```text
UNREACHABLE / UNDEFINED
CONSTANT(value, width)
OVERDEFINED / UNKNOWN
```

Do not use JavaScript truthiness or `null` to represent semantic states.

### 6.2 Executable-edge tracking is essential

A phi value may become constant only from executable predecessors.

Incorrect pattern:

```text
phi(7 from live edge, 9 from impossible edge) -> unknown
```

Correct SCCP can keep `7` if the second edge is proven non-executable.

The opposite error is worse: deleting an edge because a condition merely looks constant without proving the condition under correct bitvector semantics.

### 6.3 Bitvector semantics, not JavaScript number semantics

SCCP/range work must respect:

- width;
- truncation/extension;
- modular wraparound;
- signed vs unsigned comparison;
- shifts/rotates;
- architecture-neutral flag results already represented semantically.

Do not import C undefined-behavior assumptions into binary analysis. The machine executed concrete bitvector behavior.

### 6.4 Calls and memory

SCCP may fold pure scalar expressions. It must not infer memory stability across calls/stores without MemorySSA/effect proof.

### 6.5 Required negative tests

For every positive fold, add adversarial cases such as:

- wraparound at width boundary;
- unknown call between memory operations;
- unknown store barrier;
- unreachable-vs-unknown predecessor distinction;
- signed/unsigned branch disagreement;
- phi with partially executable predecessors;
- provenance survives branch simplification.

---

## 7. Richer ranges/value sets: avoid a false-precision trap

Ranges are useful for:

- branch simplification;
- switch reasoning;
- array index recovery;
- loop induction;
- pointer offset bounds;
- type/aggregate evidence.

They are also easy to make unsound.

### 7.1 Prefer wrapped integer domains

A binary-level range domain should model machine-width wrapping explicitly. A plain mathematical interval is insufficient for values such as:

```text
uint8_t x in [250, 255]
x + 10 -> [4, 9] modulo 256
```

If the current domain cannot express a precise wrapped result, return a wider/unknown result rather than a mathematically convenient but false interval.

### 7.2 Separate facts from hints

A proven range is a semantic fact. A likely array bound inferred from a loop shape is a higher-level candidate.

Do not store them in the same certainty channel.

### 7.3 Widening and termination

Loop-carried range analysis needs deterministic widening or another bounded convergence rule. An analysis that occasionally needs hundreds of iterations will become a browser/iPad latency problem.

Record when widening reduced precision.

---

## 8. GVN/CSE: memory is the hard part

Scalar GVN/CSE is straightforward only for proven-pure expressions.

### 8.1 Safe value key

A pure scalar expression key should include at least semantic opcode, exact width/type-relevant machine semantics, canonical operands, and operation-specific flags.

Do not key by pretty-printed text.

### 8.2 Loads require memory identity

Two loads are common only if the reaching memory state proves them equivalent.

Conceptually:

```text
load(addr, M12) == load(addr, M12)
```

may be reusable when alias/effect rules allow it.

But:

```text
load(addr, M12)
unknown_store(...)
load(addr, M13)
```

must not be commoned merely because `addr` is syntactically identical.

### 8.3 Calls are barriers unless summaries prove otherwise

An unknown call is not pure. Known imported/library/function summaries may enable narrower effects, but the decompiler must consume those summaries rather than maintain a private whitelist.

### 8.4 Avoid CSE across traps/observable operations

Operations that can trap, are volatile, atomic, ordered, or otherwise observable require effect-aware handling.

When unsure, keep the operation.

---

## 9. Effect-aware DCE: deletion is a proof obligation

DCE must answer two separate questions:

1. Is the produced value unused?
2. Is executing the operation itself unobservable?

Only when both answers are proven may the operation be removed.

### 9.1 Operations that normally block removal

Examples include:

- stores that may be observable;
- volatile memory access;
- atomics;
- calls with unknown or non-empty effects;
- traps/fault-capable operations where preserving fault behavior matters;
- throw/unwind behavior;
- control flow;
- operations whose flag/result side effects remain live;
- runtime/language intrinsics with effect summaries.

### 9.2 Memory DCE needs MemorySSA

A store may be dead only when later memory behavior proves it cannot be observed. “Overwritten later” is insufficient if an intervening call/read may observe it.

### 9.3 Prefer missed cleanup over wrong deletion

A redundant assignment in pseudocode is a readability issue. Removing a real side effect is a semantic defect. Bias conservatively.

---

## 10. Loop induction: summarize loops, do not rewrite them blindly

The purpose of induction analysis is to recover facts such as:

```text
i = 0
while (i < n) {
    ...
    i += 1
}
```

from SSA/CFG, including less canonical compiler forms.

A useful logical result is:

```ts
InductionSummary {
  phiValue
  init
  step
  updateKind
  guard
  bound
  signedness
  tripCountRange
  evidenceIds
  completeness
}
```

### 10.1 Difficult cases

- multiple backedges;
- variable step;
- wrapping induction variables;
- pointer induction;
- early exits;
- nested loops;
- irreducible SCCs;
- induction hidden through copies/casts;
- post-increment vs pre-increment forms;
- loop condition uses a derived value instead of the phi directly.

### 10.2 Main consumers

Induction facts should be reusable by:

- array recovery;
- range/value-set analysis;
- pointer stride detection;
- loop rendering;
- decompiler simplification.

Do not make array recovery rediscover induction separately.

---

## 11. Irreducible and exception-aware structuring: correctness over aesthetics

This is likely one of the hardest Phase 8 areas because it combines graph theory, exception edges, compiler lowering patterns, and human-readable output.

### 11.1 Keep edge kinds authoritative

Normal control-flow edges and exception/unwind edges must not be mixed or dropped for convenience.

### 11.2 Recommended structuring order

1. dominance/post-dominance facts;
2. natural loops;
3. SESE/region candidates;
4. if/else and switch regions;
5. break/continue synthesis;
6. exception-region constraints;
7. irreducible SCC handling;
8. safe node splitting only when semantics/provenance remain valid;
9. explicit goto fallback.

### 11.3 Never measure success as “goto count = 0”

Goto count is a useful diagnostic but a dangerous primary objective. A correct goto is better than a fabricated loop/if.

Readability metrics must always be subordinate to semantic correctness.

### 11.4 Flattened/state-machine CFGs

Treat flattened control flow as a separate recognition problem. Do not force generic structuring to aggressively guess state-machine semantics.

If later work recognizes the dispatch/state variable with sufficient evidence, it can supply a structured candidate with proof/evidence.

---

## 12. Aggregate and array recovery: preserve ambiguity

Aggregate recovery sits at the intersection of:

- pointer provenance;
- alias regions;
- hard type constraints;
- load/store widths;
- constant offsets;
- induction/stride facts;
- call prototypes;
- debug/runtime metadata;
- language providers.

### 12.1 Candidate model

Prefer candidate sets over immediate commitment:

```ts
AggregateCandidate {
  kind: "struct" | "array" | "union" | "unknown"
  extent
  fieldsOrElement
  stride
  constraints
  supportingEvidence
  contradictions
  confidence
}
```

### 12.2 Difficult distinctions

- struct fields vs array elements;
- array-of-struct vs struct-of-array;
- union overlays vs conflicting guesses;
- padding vs unknown field;
- variable index vs unrelated pointer arithmetic;
- flexible array members;
- embedded objects;
- pointer arithmetic crossing object/region boundaries.

### 12.3 Hard rule

A conflict must remain a conflict. Phase 8 must not improve readability by replacing a type ambiguity with false certainty.

---

## 13. Language pattern providers: refinement only

Objective-C/Swift support already demonstrates why language metadata is valuable. Phase 8 should generalize the pattern-provider discipline rather than embed more special cases into generic passes.

A language/compiler provider may contribute:

- idiom recognition;
- nominal type candidates;
- closure/state-machine patterns;
- dispatch/vtable/witness interpretation;
- source-like render hints;
- semantic rewrite candidates with explicit preconditions.

It must not:

- decode instructions;
- reinterpret architecture semantics;
- bypass Semantic IR/SSA;
- force a type against hard contradictions;
- erase provenance;
- mark a heuristic pattern as confirmed solely because it is common for a compiler/runtime.

Architecture/compiler-specific logic is allowed as an optional refinement provider after exact/generic semantics are established.

---

## 14. Provenance: Phase 8 cannot trade explainability for prettiness

Every optimization/structuring/recovery pass should be testable in both directions:

```text
high-level node
    ↓ origin/evidence
input semantic nodes
    ↓
SSA/MemorySSA
    ↓
instructions
    ↓
bytes
```

Useful Phase 8 provenance metrics:

- percentage of emitted semantic AST nodes with non-empty origin sets;
- percentage of rewrite-produced nodes with transform records;
- orphan produced-node count;
- dangling consumed-node reference count;
- source-range loss count;
- origin determinism across repeated runs.

For the mandatory corpus, the intended exit gate is effectively **zero provenance loss**, not “high average coverage”.

---

## 15. Readability measurement without gaming the metric

The Master Architecture requires readability to improve measurably. Do not use one opaque score.

Use a quality vector with semantic correctness as a hard prerequisite.

Possible diagnostics per function/corpus:

```text
semanticMismatchCount              hard gate: 0
provenanceLossCount                hard gate: 0
unknownSafetyRegressionCount       hard gate: 0
ghidraDifferentialRegressionCount  hard gate: 0

rawPhiLeakCount
generatedTemporaryCount
redundantAssignmentCount
redundantExpressionCount
structuredRegionRatio
gotoCount
unresolvedSwitchCount
rawPointerArithmeticCount
recoveredArrayCount
recoveredAggregateFieldCount
ambiguousTypeForcedCount           hard gate: 0
astNodeCount
expressionDepthDistribution
```

Not every metric must monotonically decrease on every function. For example, a correct explicit goto can increase `gotoCount` while fixing a false loop. Therefore:

- define a mandatory corpus baseline at P8-0;
- compare distributions and known-case expectations;
- maintain hand-audited golden cases for difficult structures;
- require no semantic/provenance regression before considering readability wins;
- record why a metric regression is acceptable instead of hiding it in a blended score.

---

## 16. Verification strategy

Phase 8 should reuse and strengthen current verification instead of inventing a new release path at the end.

### 16.1 Existing local regression floor

Relevant existing commands include:

```bash
npm run semantic:test
npm run decompiler:test
npm run compiler-truth
npm run integration:test
npm run migration:test
npm run check
```

`decompiler:test` already includes semantic decompiler tests, CFG decompilation, switch recovery, rewrite tests, pipeline tests, compiler-truth, Objective-C/Swift integration, and regression suites.

### 16.2 Existing differential/proof assets to preserve

- Ghidra decompiler differential workflow;
- compiler-truth corpus;
- cross-binary accuracy workflow;
- `js/decompiler/verify/equivalence.js` bounded equivalence support;
- semantic/migration guardrails;
- real binary fixtures used by current accuracy and differential gates.

Phase 8 should extend these where needed, not replace them.

### 16.3 Solver-backed proof is Phase 9

Do not make Phase 8 completion depend on an unplanned SMT implementation. Phase 9 owns solver-backed verification.

Phase 8 may use existing deterministic/bounded equivalence checks and should make its pass contracts ready for stronger Phase 9 proof later.

### 16.4 Every transform needs positive and negative cases

For each new rewrite/optimization rule, include:

1. case where transformation must apply;
2. near-miss where it must not apply;
3. unknown/partial evidence case;
4. width/signedness edge case where relevant;
5. memory/call barrier case where relevant;
6. provenance assertion;
7. determinism assertion.

The negative corpus is at least as important as the positive corpus.

---

## 17. Suggested architecture of Phase 8 code

Do not mass-rename the repository merely to match the target namespace. Use the current tree and move files only when a concrete boundary improves.

Likely safe evolution:

```text
js/decompiler/
  passes/
    manager.js
    sccp.js
    range-refine.js
    gvn.js
    dce.js
    loop-induction.js

  structuring/
    ... only if a new boundary is justified

  types/
    ... aggregate/array recovery helpers where appropriate

  idioms/
    ... language/compiler refinement providers

  verify/
    equivalence.js
    ... Phase 8 pass/provenance verification helpers
```

The names are suggestions, not a contract.

Important boundary rules:

- generic passes consume semantic/SSA/MemorySSA analysis only;
- architecture/compiler-specific patterns stay outside the generic optimizer;
- `pipeline-core.js` remains the semantic consumer boundary;
- existing public behavior remains behind compatibility facades until the differential cutover is proven;
- no new hidden fallback path is introduced.

---

## 18. Artifact, versioning, and invalidation rules

Because Phase 4 established versioned ArtifactStore/scheduler behavior, Phase 8 passes must participate cleanly in artifact identity/invalidation.

A pass output should be invalidated when any semantically relevant input changes, including as applicable:

- Semantic IR schema/version;
- architecture semantic version;
- ABI semantic version;
- CFG/SSA/MemorySSA artifact version;
- alias/range/summary/type-analysis version;
- pass implementation/version;
- pass options;
- language-provider version;
- target/runtime metadata version used by the pass.

Do not solve stale output by broad “clear all caches” behavior if the ArtifactKey can express the dependency.

Over-invalidation is a performance regression; under-invalidation is a correctness regression. Both should be tested.

---

## 19. Performance rules for iPad/browser

Decompiler quality improvements can become expensive quickly. Phase 8 should preserve demand-driven analysis.

### 19.1 Do not run the full optimizer over the whole binary by default

Priority should remain focused on the visible/queried function and dependencies.

### 19.2 Bound fixed-point passes

SCCP, range propagation, summary refinement, and rewrite fixpoints must have deterministic convergence/budget behavior.

### 19.3 Measure pathological functions

Before adding CI fanout to hide slowness, profile a representative slow function. The engineering guardrails explicitly require algorithmic bottlenecks to be attacked before scheduler/runner fragmentation.

### 19.4 Track useful metrics

At minimum:

- per-pass time;
- iteration count;
- nodes visited;
- expressions/value numbers created;
- peak retained analysis size;
- cancellation latency;
- cache hit/reuse behavior;
- decompiler latency on selected real functions.

A readability win that makes the active function take seconds longer on iPad may not be a product win.

---

## 20. Main failure modes to guard against

### F1 — Optimizing text instead of semantics

Symptom: pretty output improves while Semantic IR/SSA proof is missing.

Prevention: transformations operate on semantic entities and preserve origin/evidence.

### F2 — CSE/load forwarding across an alias barrier

Symptom: two equal-looking loads collapse across unknown store/call.

Prevention: memory-version/effect proof required.

### F3 — DCE removes an observable side effect

Symptom: unused return => call/store deleted.

Prevention: effect summary is a hard precondition.

### F4 — Range analysis assumes mathematical integers

Symptom: wraparound branch is incorrectly folded.

Prevention: exact-width wrapped domain or explicit unknown.

### F5 — Structurer deletes difficult edges

Symptom: cleaner if/loop output but unresolved/exception edge vanished.

Prevention: all CFG edge classes are accounted for; goto fallback allowed.

### F6 — Aggregate recovery forces a type

Symptom: one pretty struct replaces conflicting evidence.

Prevention: candidate/conflict model and hard-vs-soft constraint separation.

### F7 — Language provider becomes a second semantic engine

Symptom: ObjC/Swift/C++ provider decodes or reinterprets instructions.

Prevention: provider only consumes canonical semantic facts and returns refinements.

### F8 — Provenance is lost during rewrite chains

Symptom: final pseudocode cannot descend to source instructions/bytes.

Prevention: transform/origin accounting is a merge-blocking gate.

### F9 — A pass improves ARM64 but encodes ARM64 assumptions in generic code

Symptom: x86-64/RISC-V regressions or generic code imports target-specific constants.

Prevention: cross-architecture contract tests + migration dependency checks.

### F10 — Final verifier matures too late

Symptom: most integration time is spent fixing the verifier instead of the product.

Prevention: P8-0 exact-SHA verifier and shadow run after every integration checkpoint.

---

## 21. Cross-architecture rule

By Phase 8, the generic decompiler middle-end must be written for the architecture set produced by earlier phases, not for ARM64 with adapters bolted on.

At minimum, every generic pass should be tested against representative semantic shapes from:

- AArch64/arm64e;
- x86-64;
- RISC-V64 once the Phase 6 cutover is complete.

The RISC-V target is particularly valuable because it exposes hidden assumptions about condition flags. x86-64 exposes variable-width operations, explicit/implicit flag use, and memory-heavy idioms. ARM64 remains the existing regression floor.

The pass must consume generic Semantic IR facts; architecture-specific idioms are separate refinement providers.

---

## 22. Integration/ownership strategy

Phase 8 should follow the post-Phase-5 process model from day one.

### Foundation owns

- Phase 8 ownership manifest;
- runner discovery;
- pass contract;
- exact-SHA verifier path;
- baseline quality/evidence schema;
- living integration wiring.

### Component lanes own

Narrow pass/provider/test areas. They target the living integration branch, not `main`.

### Integration owns

- shared pipeline ordering;
- cross-pass reconciliation;
- artifact/pass-version wiring;
- any shared generated output if touched;
- moving-main reconciliation;
- rolling product proof;
- final cutover.

After every accepted component merge, integration is checkpoint-locked until:

1. shared contracts/invalidation are reconciled;
2. canonical generated output is synchronized if applicable;
3. rebuild produces zero generated diff;
4. rolling vertical gates pass;
5. independent shadow verification passes;
6. exact checkpoint SHA/evidence is recorded.

---

## 23. Proposed Phase 8 exit evidence

A final Phase 8 completion report should be able to state, with exact identities:

### Correctness

- semantic mismatch count on mandatory corpus: `0`;
- provenance loss count: `0`;
- unknown-store/unknown-call safety regressions: `0`;
- architecture-boundary violations in generic passes: `0`;
- transform determinism failures: `0`;
- stale-artifact/invalidation failures: `0`.

### Decompiler quality

- SCCP active and proven on compiler-truth/real cases;
- GVN/CSE active only under effect/memory proof;
- effect-aware DCE active with side-effect negative corpus;
- richer range/value-set diagnostics active;
- loop induction summaries active;
- irreducible/exception structuring improved with safe goto fallback;
- aggregate/array recovery improved without forced-type regressions;
- language providers improve output without semantic authority.

### Differential quality

- Ghidra differential has no unexplained regression on exact release head;
- cross-binary accuracy has no unexplained regression;
- compiler-truth gates are green;
- readability quality vector improves against the frozen P8-0 baseline on the accepted corpus.

### Product/performance

- active-function latency remains within the accepted browser/iPad budget;
- no required whole-binary eager decompilation was introduced;
- cancellation remains bounded;
- artifact reuse/invalidation is correct.

### Process

- exact release SHA frozen;
- verifier version/evidence schema bound to that SHA;
- candidate merge tree proved before each component integration;
- living integration reconciled with live `main`;
- all blocking exact-SHA workflows green;
- no unexplained red workflow;
- capability maturity is not promoted beyond observed evidence.

---

## 24. The implementation order to remember

When Phase 8 starts, the safest short version is:

```text
1. Freeze proof/ownership/integration contracts.
2. Wire a no-op pass through the real product and prove provenance.
3. Add SCCP.
4. Strengthen wrapped ranges/value sets.
5. Add scalar GVN/CSE.
6. Add memory-aware reuse only through MemorySSA/alias/effect proof.
7. Add effect-aware DCE.
8. Add loop induction summaries.
9. Strengthen irreducible + exception structuring.
10. Recover aggregates/arrays from shared facts.
11. Add language/compiler refinement providers last.
12. Re-run the same exact-SHA verifier used throughout the phase.
```

If a later step needs an unproven fact, go back to the owning analysis layer instead of adding a heuristic shortcut.

---

## 25. Final principle

The desired Phase 8 result is not “pseudocode that looks nicer”.

It is:

```text
better readability
×
better recovered structure/types
×
zero semantic regression
×
complete provenance
×
architecture neutrality
×
acceptable iPad/browser latency
```

A transformation that improves one factor by breaking another is not a Phase 8 improvement.
