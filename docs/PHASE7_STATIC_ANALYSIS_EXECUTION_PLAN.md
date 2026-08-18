# Phase 7 Industrial Static Analysis Execution Plan

Status: **implementation runbook / pre-Phase-7 planning**  
Repository: `rhgrive3/hex`  
Planning baseline: `main` at `e90c5107f9c77d73687ee452d5042dcbe9e79ece`  
Canonical architecture: `docs/HEX_MASTER_ARCHITECTURE.md`  
Process contract: `docs/ENGINEERING_PROCESS_GUARDRAILS.md`  
Migration contract: `docs/MIGRATION_GUARDRAILS.md`

This document turns Master Architecture Phase 7 — **Industrial static-analysis depth** — into an executable engineering plan.

It is intentionally written before Phase 7 begins so that the difficult semantic decisions, dependency order, evidence requirements, and failure modes are settled before implementation pressure encourages shortcuts.

If this runbook conflicts with the current `HEX_MASTER_ARCHITECTURE.md` or a later accepted ADR, the canonical architecture / later ADR wins and this document must be updated.

---

## 1. Phase goal

Phase 7 must improve precision without weakening Hex's existing conservative semantic floor.

Required Phase 7 outcomes from the master architecture are:

- alias analysis A1 / A2 / A3;
- escape analysis;
- interprocedural function summaries;
- hard type constraints;
- DWARF / PDB ingestion through a common debug-info boundary;
- cross-architecture function discovery.

The phase is successful only if it produces both of these outcomes:

1. **fewer `unknown` memory/data/type/function-boundary relationships where evidence permits a stronger answer;**
2. **no increase in false certainty or unsound optimization/decompiler transforms.**

Phase 7 is therefore not a contest to maximize the number of `MustAlias`, `NoAlias`, recovered types, or discovered functions. A stronger answer is useful only when Hex can explain why it is stronger.

---

## 2. Non-goals

Phase 7 must not expand into Phase 8 or later work merely because the new analyses expose opportunities.

Not Phase 7:

- SCCP, GVN/CSE, broad DCE, loop-induction recovery, or large decompiler readability rewrites;
- A4 whole-program context-sensitive points-to analysis;
- solver-backed symbolic execution;
- debugger/instrumentation provider implementation;
- managed-runtime frontends;
- repository-wide namespace churn;
- replacing the current semantic facade or deleting migration compatibility before its replacement has differential proof.

Phase 7 may expose proof/query APIs that Phase 8 consumes. It should not prematurely couple those APIs to a specific Phase 8 optimization.

---

## 3. Safety floor that cannot regress

The following are merge-blocking Phase 7 invariants.

### P7-INV-001 — Unknown remains explicit

An unresolved pointer, call effect, function extent, or type relation remains `unknown` / `may` / partial as appropriate. Absence of evidence never becomes proof.

### P7-INV-002 — Alias monotonicity is proof-driven

An analysis refinement may move a relationship from:

```text
unknown -> may
may     -> must
may     -> no
```

only when the stronger result carries a valid proof reason/evidence path.

A weaker result may always be returned when budget/completeness is insufficient.

### P7-INV-003 — Unknown stores remain barriers

An unknown store must clobber every memory region it may alias. Phase 7 must never retain a reaching-store/load-forwarding proof merely because the resulting pseudocode is cleaner.

The existing `js/ir.js` compatibility behavior documented by `MIGRATION_GUARDRAILS.md` is the minimum safety floor.

### P7-INV-004 — Unknown calls remain conservative

Call effects use, in order:

1. proven function summary;
2. versioned imported/library model;
3. ABI/runtime rule;
4. conservative unknown-call fallback.

A missing summary is never equivalent to purity.

### P7-INV-005 — Hard and soft type evidence stay separate

A weighted hint cannot silently become a hard constraint. Contradictory hard constraints remain visible conflicts; Hex must not choose the highest score and call it certain.

### P7-INV-006 — Function start and extent are separate facts

A precise start with unknown extent is valid. Phase 7 must not invent a contiguous function body to make later analysis easier.

### P7-INV-007 — Architecture / ABI / debug / language boundaries remain separate

No Phase 7 generic analysis may re-introduce architecture-specific decoding or calling-convention assumptions into generic alias, summary, type, or function-discovery code.

### P7-INV-008 — Evidence survives refinement

Every stronger alias, summary, type, debug, and function-discovery conclusion must remain explainable through stable evidence/origin links.

### P7-INV-009 — Precision work is demand-driven

Phase 7 must not make opening a large binary require a whole-program points-to/type solve. Expensive context sensitivity remains targeted.

---

## 4. The main sequencing decision

Do **not** implement A1, A2, A3, escape, summaries, debug types, and function discovery as parallel independent features and integrate them at the end.

They depend on each other:

```text
measurement + proof contracts
          ↓
A1 regions
          ↓
A2 local/field points-to
          ↓
local function summaries
          ↓
escape + call effects
          ↓
A3 interprocedural fixed point
          ↓
hard type constraints
          ↓
DWARF/PDB authoritative evidence
          ↓
cross-architecture function discovery
          ↓
Phase 7 integration / Phase 8 handoff
```

Some implementation can overlap, but the **acceptance order** should follow this dependency chain. In particular, A3 should not be built as a monolithic solver before A1/A2 and summary semantics are proven.

---

# 5. P7.0 — Foundation: measurements, proof APIs, and negative corpus

This checkpoint is the most important efficiency investment in Phase 7.

## Deliverables

1. A Phase 7 benchmark/evidence schema that records at least:
   - alias relation counts by analysis level (`must`, `may`, `no`, `unknown`);
   - memory links proven / blocked / unresolved;
   - summary completeness;
   - type accuracy and false-certainty counts;
   - function-start and function-extent metrics separately;
   - false split / false merge;
   - active-function latency and representative pathological latency;
   - peak/resident analysis memory where the existing harness can measure it.

2. A **negative soundness corpus before precision changes**. It must include cases where the tempting answer is wrong:
   - overlapping stack intervals;
   - same root with uncertain offset;
   - unknown pointer store between store and load;
   - pointer phi joining distinct roots;
   - pointer escape through return/global/call;
   - recursive/mutually recursive calls;
   - unknown indirect call;
   - union/overlapping fields;
   - debug-info identity mismatch;
   - shared epilogue/tail-call/thunk/function-extent ambiguity.

3. Stable proof/query contracts, conceptually:

```ts
alias(a, b, options): AliasResult
reachingMemoryDef(load): MemoryDefResult
memoryEffects(callOrFunction): MemoryEffectResult
explainMemoryPath(source, sink): EvidencePath
functionSummary(functionId): FunctionSummaryResult
explainType(entityId): TypeResult
functionCandidate(address): FunctionCandidateResult
```

Exact naming may follow current repository conventions. The important requirement is that consumers ask the analysis layer for proof instead of rebuilding alias/type/function logic themselves.

4. A permanent exact-head verifier path established early enough to run in shadow mode throughout Phase 7.

## Hard part

The difficult decision is the **evidence schema**, not the counters. If a later Phase 7 algorithm changes acceptance semantics, old evidence may no longer prove the current head. Record algorithm/pass/schema versions and completeness from the beginning.

## Exit gate

- current semantic/decompiler/migration suites remain green;
- negative corpus fails on intentionally unsound test doubles and passes on the production baseline;
- exact-head verifier can run before any precision implementation lands;
- baseline metrics are captured from the actual product path.

---

# 6. P7.1 — A1 region alias analysis

A1 introduces coarse analysis regions without pretending to solve points-to globally.

Canonical initial regions:

```text
StackRegion(function/frame)
GlobalRegion(image/module)
ObjectRegion(root identity)
AllocationRegion(site/summary)
TLSRegion(module/thread model)
UnknownRegion
```

## Recommended model

Use one canonical region/root identity service shared by alias and MemorySSA. Do not let separate consumers invent their own object-root equivalence rules.

A location should retain, as available:

```text
region identity
root provenance
offset / interval
width
address space
completeness
origin/evidence
```

A1 should primarily answer obvious region separation and preserve uncertainty elsewhere.

Examples of defensible `NoAlias` proofs:

- distinct physical address spaces;
- disjoint fixed stack intervals in the same proven frame;
- non-overlapping exact globals;
- distinct proven non-escaping allocation roots.

Examples that remain `MayAlias`/`Unknown`:

- unresolved pointer root;
- root joined through uncertain phi;
- unknown offset where ranges can overlap;
- allocation that escaped through an unknown call.

## Difficult parts

### Canonical root identity

Two syntactically different address expressions may refer to the same object. Conversely, similar expressions may have different roots. Root identity must be based on semantic provenance, not pretty-printed expression equality.

### Interval arithmetic

Offsets and widths must use checked arithmetic and preserve wrapped/unknown ranges. A `NoAlias` proof from an overflowed interval is a correctness bug.

### Region clobbering

Region precision is useful only if unknown stores/calls clobber every reachable region they may affect. The default failure mode must be lost precision, not preserved stale memory facts.

## Exit gate

- every A1 `NoAlias` has a machine-readable reason code/evidence path;
- no existing unknown-store barrier regression;
- mandatory negative corpus reports zero false `NoAlias`;
- measurable reduction in broad `UnknownRegion` usage on representative fixtures;
- active-function latency regression is explained and accepted, or fixed before merge.

---

# 7. P7.2 — A2 field-sensitive points-to

A2 adds useful local pointer precision without becoming an unrestricted whole-program solver.

Required modeled operations:

- pointer copies;
- root + constant/ranged offset;
- phi/select merges;
- stack/global/object/allocation roots;
- field intervals;
- pointer arguments/returns as unresolved boundaries until summaries exist.

## Recommended representation

Prefer compact canonical points-to facts such as:

```ts
PointsToSet {
  targets: Array<{
    regionId,
    rootId,
    offsetRange,
    width?,
    evidenceIds
  }>
  completeness: "complete" | "bounded" | "partial" | "unknown"
}
```

Do not encode a large arbitrary expression DAG into every alias answer. The expression/provenance graph can stay referenced by stable IDs.

## Difficult parts

### Phi cycles

Loops create cyclic pointer phis. The solver needs a terminating lattice/fixed point and widening where ranges grow. Iteration count alone must not be used as semantic proof.

### Pointer arithmetic

Treat constant field offsets differently from arbitrary integer-to-pointer arithmetic. When provenance is lost, say so explicitly.

### Overlapping fields / unions

Field sensitivity must not turn overlapping union-like accesses into `NoAlias` merely because recovered field labels differ.

### Load-derived pointers

A pointer loaded from memory is only as precise as the reaching-memory proof. If the load may observe multiple definitions, its points-to set must merge them conservatively.

## Exit gate

- A2 is deterministic for a fixed snapshot/options/version;
- cyclic fixtures terminate under a documented widening/budget policy;
- field-sensitive precision improves representative local memory links;
- union/overlap/phi/unknown-store negative cases remain conservative;
- no consumer bypasses the canonical alias API to obtain a stronger answer.

---

# 8. P7.3 — Function summaries, escape analysis, and A3 interprocedural solving

Do these as one dependency chain, not three disconnected features.

## 8.1 Local summary first

Every analyzed function should produce a local, versioned summary before interprocedural propagation:

```ts
FunctionSummary {
  functionId
  inputs
  returnValues
  registerEffects
  memoryReadRegions
  memoryWriteRegions
  escapes
  allocations
  frees
  directCalls
  indirectCallSets
  noreturn
  mayThrow
  stackDelta
  semanticFacts
  completeness
}
```

A summary is a derived artifact. Its key must include semantic/pass/options/input versions so stale summaries cannot survive semantic changes.

## 8.2 Escape taxonomy

At minimum distinguish why a root escaped:

```text
returned
stored-to-global
stored-through-argument
passed-to-known-call
passed-to-unknown-call
captured-by-closure/runtime object
published-to-thread/runtime boundary
unknown
```

Escape is not a single boolean if later reasoning needs to know what became unsafe.

## 8.3 Interprocedural order

Recommended solver:

1. build local summaries;
2. build direct-call dependency graph;
3. condense recursive components into SCCs;
4. solve acyclic SCC DAG bottom-up where possible;
5. solve recursive SCCs to fixed point;
6. widen when needed to guarantee termination;
7. represent unresolved indirect calls conservatively;
8. publish a new immutable summary artifact when stabilized.

## Difficult parts

### Recursion and summary oscillation

Mutual recursion can continually grow effect sets/ranges. Define a finite lattice and widening rules before implementation, not after a non-terminating fixture appears.

### Indirect calls

A finite candidate set can merge summaries when the candidate evidence is sufficient. An unresolved target must include unknown-call effects; do not average away the uncertainty.

### Escape-induced alias invalidation

When an allocation/object root escapes, previously safe local `NoAlias` proofs may no longer be valid across calls. The invalidation boundary must be explicit.

### Summary invalidation

A callee summary change can invalidate callers transitively. Use artifact dependency identity rather than hand-clearing caches.

### Closures and runtime captures

Swift/ObjC/C++/Rust/Go providers may identify captures later. Generic escape analysis should expose an extension/evidence hook, not embed language-runtime pattern matching.

## Exit gate

- recursive SCC corpus terminates deterministically;
- summary completeness and unknown call effects are explicit;
- known callees improve caller memory precision measurably;
- unknown/indirect calls never become accidentally pure;
- escape cases correctly invalidate unsafe allocation/object separation;
- transitive summary invalidation is version/artifact driven.

---

# 9. P7.4 — Hard TypeConstraintGraph

The goal is to make type recovery more logically constrained without destroying Hex's existing evidence-weighted strengths.

## Required separation

```text
Hard constraints
  exact machine width
  load/store width
  ABI argument/return location constraints
  authoritative debug type bound to exact build
  verified runtime metadata
  authoritative prototype

Soft evidence
  symbol spelling
  selector/name patterns
  inferred use shape
  signature candidate
  heuristic array stride
  decompiler presentation hints
```

A soft score can rank candidates. It cannot erase a hard contradiction.

## Recommended solver shape

Use a graph of type variables and typed constraints, not one mutable guessed type per value.

Constraint families should be individually versioned/testable:

```text
same-representation / compatible
pointer-to
field-at-offset
array-stride
call-argument
call-return
integer-width/signedness
float/vector
nominal candidate
nullability
```

The result remains evidence-bearing:

```ts
TypeResult {
  candidates
  selected?
  hardConstraints
  softEvidence
  contradictions
  confidence
  origin
}
```

## Difficult parts

### Equality vs compatibility

A machine-compatible representation does not imply identical nominal/structural type. Avoid collapsing casts/unions/opaque handles into one type merely because widths match.

### Contradiction propagation

One bad imported/debug constraint must not poison an entire graph silently. Preserve the conflict, source, and affected component.

### Recursive types

Struct/class pointer cycles require graph identities; naive recursive materialization will loop or duplicate nominal types.

### ABI aggregates

ABI passing shape is not the same as recovered source layout. Keep `ABIType` distinct from recovered structural/nominal types.

## Exit gate

- hard/soft evidence cannot be confused through the public result schema;
- deliberate contradiction fixtures remain ambiguous/conflicted rather than falsely certain;
- paired compiler/debug truth benchmark improves type accuracy;
- false-certainty count does not increase;
- decompiler consumes recovered types through the canonical type result, not private solver state.

---

# 10. P7.5 — DWARF / PDB ingestion

Debug information should enter as high-quality evidence, not as a special bypass around the type/evidence architecture.

Canonical provider boundary:

```ts
interface DebugInfoProvider {
  probe(image, refs)
  symbols(scope, page)
  types(scope, page)
  lines(scope, page)
  inlineFrames(scope, page)
  unwindInfo?(scope)
}
```

## Recommended order

1. define provider/result schemas and identity rules;
2. implement minimal symbol/type/line ingestion for one debug ecosystem;
3. bind results to exact binary/build identity;
4. feed authoritative type/symbol facts into existing canonical systems;
5. add second ecosystem only after the boundary proves portable.

This avoids building two independent one-off parsers that later need reconciliation.

## Identity rules

Debug data must not be applied because a filename or path matches.

Use the strongest available build identity for the format/ecosystem and record:

```text
binary/build identity expected
identity observed in debug data
provider/version
match verdict
evidence/completeness
```

Mismatch is a first-class refusal/partial state.

## Difficult parts

- split/external debug information and missing companions;
- address relocation/image-base normalization;
- inline frames vs physical function identity;
- typedef/qualifier/forward-declaration cycles;
- PDB/DWARF representation differences behind one provider contract;
- huge debug databases and paging/lazy loading;
- authoritative debug info that is technically valid but refers to a different optimized/inlined source shape.

## Exit gate

- exact identity match is required before authoritative application;
- intentional mismatched-debug fixtures fail closed;
- provider outputs are paged/budgeted for large inputs;
- symbols/types/lines retain debug-source provenance;
- type benchmark improvement is measured separately with and without debug evidence.

---

# 11. P7.6 — Cross-architecture function discovery

Function discovery must become a first-class evidence fusion analysis, not architecture-specific prologue scanning.

Evidence sources include:

- loader function starts;
- unwind data;
- symbols/debug info;
- exports/entrypoints;
- direct-call targets;
- relocation targets;
- vtables/witness/runtime metadata;
- exception metadata;
- compiler/runtime tables;
- validated prologue/epilogue heuristics;
- runtime observations where available.

## Result contract

```ts
FunctionCandidate {
  start
  regions
  startEvidence
  extentEvidence
  confidence
  conflicts
  state: "exact" | "probable" | "heuristic" | "contradicted"
}
```

## Key design rule

**Discovery evidence is generic; evidence producers may be target-specific.**

For example, an architecture/provider may contribute a validated prologue candidate, but the central discovery solver owns evidence fusion/conflict handling. Generic discovery must not decode architecture text itself.

## Difficult parts

### Start vs extent

Never optimize one combined “function accuracy” number. Track start and extent independently.

### Shared epilogues / tail calls / thunks

A function may own multiple non-contiguous regions or share control-flow structure. Do not force every candidate into one contiguous interval.

### Exception/unwind regions

Landing pads and unwind metadata can establish code ownership that simple call-target discovery misses.

### Architecture differences

x86 variable-length decode/prologue heuristics and RISC-V/AArch64 fixed-width properties must remain target providers, not assumptions in the central solver.

## Exit gate

Track separately:

- function-start precision;
- function-start recall;
- extent precision;
- extent recall;
- false split;
- false merge.

The mandatory compiler corpus must include stripped and debug-paired binaries across every architecture that has reached the prerequisite maturity level.

---

# 12. P7.7 — Integration, performance, and Phase 8 handoff

Phase 7 completion is not “all component PRs merged.” The exact integrated product must prove the new precision and the old safety floor together.

## Required integrated proofs

1. mandatory current semantic/decompiler/compiler-truth/migration suites green;
2. Phase 7 negative soundness corpus green;
3. exact-head Phase 7 verifier green;
4. alias unknown/may reduction measured without false-`NoAlias` regression;
5. summary recursion/unknown-call corpus green;
6. type accuracy improved without increased false certainty;
7. debug identity mismatch fails closed;
8. function discovery start/extent metrics reported independently;
9. active-function latency and pathological fixtures profiled;
10. no whole-program mandatory solve introduced into file open/current-function analysis.

## Phase 8 handoff contract

Phase 8 should be able to consume proof APIs such as:

```text
alias relation + proof
reaching memory def + proof
call/function memory effects + completeness
function summary
escape state/reason
resolved type + contradictions
function regions/candidate evidence
```

Phase 8 transforms must not reach into private A1/A2/A3 solver state.

This boundary lets Phase 8 improve SCCP/GVN/DCE/load-store forwarding/aggregate recovery without making decompiler correctness depend on an implementation detail of the Phase 7 solver.

---

# 13. Phase 7 work decomposition / PR sequence

Use small checkpoints with one living integration lane. Exact branch names can follow the phase tooling, but the logical decomposition should be approximately:

| Checkpoint | Primary ownership | Dependency | Main proof |
|---|---|---|---|
| P7-0 | metrics + proof contracts + verifier + negative corpus | Phase 6 integrated baseline | baseline/exact-head proof |
| P7-1 | canonical regions + A1 | P7-0 | zero false NoAlias |
| P7-2 | A2 local/field points-to | P7-1 | precision + cyclic/union safety |
| P7-3a | local FunctionSummary artifact | P7-2 | deterministic local summaries |
| P7-3b | escape taxonomy/effects | P7-3a | escape invalidation corpus |
| P7-3c | A3 SCC interprocedural solver | P7-3b | fixed-point termination + unknown-call safety |
| P7-4 | TypeConstraintGraph | stable P7-3 contracts | accuracy/no false certainty |
| P7-5a | DebugInfoProvider contract + first backend | P7-4 | identity-bound ingestion |
| P7-5b | second debug ecosystem | P7-5a | provider portability |
| P7-6 | cross-arch function discovery | P7-3 + loader/target maturity | start/extent metrics |
| P7-I | rolling integration and exact-head verifier | all accepted checkpoints | integrated proof |
| P7-X | release/Phase-8 handoff | P7-I | master exit gates |

Important: `P7-I` is **not** a final clean-up branch. It exists at P7-0 and absorbs accepted components continuously.

---

# 14. Parallelism policy

Useful parallel work:

- corpus/benchmark construction while A1 implementation starts;
- independent review/verifier work against already frozen result schemas;
- DWARF/PDB format research/fixtures while TypeConstraintGraph stabilizes;
- function-discovery fixture/corpus preparation while summaries mature.

Avoid parallel work that creates competing truths:

- two independent canonical alias solvers;
- two root-identity implementations;
- separate summary effect schemas per architecture;
- debug provider applying types outside TypeConstraintGraph;
- function discovery embedded independently in each decoder.

When ownership overlaps intentionally, the integration owner must know before implementation begins.

---

# 15. Performance strategy

Phase 7 analyses can become the first genuinely expensive whole-program analyses in Hex. Performance must be designed in, not recovered by CI sharding later.

## Rules

1. **Profile a representative slow production fixture before increasing CI/job fanout.**
2. Keep A0/A1/A2 local work cheap enough for active-function analysis.
3. Compute summaries demand-first, then expand along relevant call graph/frontier.
4. Persist/version stable summaries and points-to artifacts where the existing artifact architecture supports it.
5. Use SCC solving only on reachable dependency components for the active request unless a background/indexing task explicitly requests broader coverage.
6. Use A4/context sensitivity only for targeted questions.
7. Bound debug-info reads/indexes; page large collections.
8. Prefer compact IDs/sets/intervals over giant per-node duplicated object graphs.
9. Expose `partial`/`bounded` when a resource budget stops analysis; never produce a stronger semantic result to save time.

## Performance measurements

Do not invent arbitrary universal millisecond targets before baseline evidence exists. Record baseline, then ratchet regression budgets from measured production behavior.

At minimum compare:

- cold current-function analysis;
- warm current-function analysis;
- caller/callee summary expansion;
- recursive SCC fixture;
- pathological pointer-phi fixture;
- large debug-info lookup;
- stripped large-binary function discovery;
- peak working set / artifact footprint where measurable.

---

# 16. Failure modes to prevent explicitly

## FM-1 — “More precision” by optimistic aliasing

Symptom: decompiler gets cleaner and tests look nicer because an unknown store/call is ignored.

Response: add/keep the negative barrier corpus; require proof reason for every `NoAlias`.

## FM-2 — A3 big-bang solver

Symptom: one large solver simultaneously invents regions, points-to, escape, call effects, and recursion rules.

Response: accept A1/A2/local-summary/escape contracts before interprocedural fixed-point work.

## FM-3 — Boolean escape

Symptom: everything becomes `escaped=true`, destroying precision, or `false`, creating unsoundness.

Response: preserve escape reason and boundary; distinguish local, returned, global, known-call, unknown-call, runtime capture.

## FM-4 — Summary cache poisoning

Symptom: caller remains “precise” after callee semantics/options change.

Response: summary artifacts are version/input keyed and dependency invalidation is transitive.

## FM-5 — Type confidence hides contradiction

Symptom: a high weighted score masks an incompatible hard width/debug/call constraint.

Response: contradictions are first-class result data and block certainty.

## FM-6 — Debug filename trust

Symptom: wrong PDB/DWARF applies plausible but false symbols/types.

Response: exact build/binary identity gate; mismatch is explicit.

## FM-7 — Function discovery conflates start and extent

Symptom: good start detection hides bad function merging/splitting.

Response: separate metrics and separate evidence fields.

## FM-8 — Architecture leakage

Symptom: generic solver branches on `x0`, x86 mnemonics, RISC-V opcode names, or ABI-specific registers.

Response: migration dependency guardrails + provider/effect/ABI boundary tests.

## FM-9 — Verifier matures at release time

Symptom: P7-X needs weeks of verifier changes before the exact product can be trusted.

Response: freeze evidence schema early and run verifier in shadow mode from P7-0/P7-1.

## FM-10 — Performance hidden by CI parallelism

Symptom: tests become green faster but production active-function latency remains pathological.

Response: profile/fix algorithmic path first; CI topology is secondary.

## FM-11 — Moving-main replacement-PR churn

Symptom: Phase 7 keeps cloning stale repair PRs while Phase 6/other work moves `main`.

Response: one living integration/reconciliation lane; components keep frozen ownership unless shared contract changes; reconcile once at defined checkpoints.

---

# 17. Test pyramid

Every Phase 7 component should have all applicable layers.

## L0 — lattice/unit laws

Examples:

- alias relation symmetry where applicable;
- set/interval join monotonicity;
- widening termination;
- points-to merge determinism;
- summary merge monotonicity;
- type contradiction preservation.

## L1 — synthetic semantic fixtures

Tiny hand-controlled CFG/SSA/MemorySSA fixtures for exact edge cases.

## L2 — compiler-truth micro corpus

C/C++/ObjC/Swift/Rust/Go where relevant, paired with debug/stripped builds and optimization variants.

## L3 — architecture/format matrix

At least every architecture that has reached the Phase 7 prerequisites. Do not claim cross-architecture behavior from ARM64-only evidence.

## L4 — differential/oracle diagnostics

Use suitable external/open reference tooling where already allowed by repository research policy. Differences are diagnostic; external tool output is not automatically Hex truth.

## L5 — real-binary / pathological performance corpus

Representative stripped binaries, large functions, recursion, pointer-heavy code, and large debug metadata.

## L6 — exact integrated candidate

Run the permanent exact-head verifier against the actual candidate merge tree/integration head.

---

# 18. Review checklist for every Phase 7 PR

Before merge, reviewer/Supervisor should answer:

### Semantics

- What stronger facts can this change now prove?
- What exact proof permits each new `NoAlias`/`MustAlias`/type/function conclusion?
- Which cases deliberately remain unknown?
- Does an unknown store/call still invalidate every proof it should?

### Architecture

- Is generic logic free of architecture/ABI/debug-format special cases?
- Is there one canonical identity/root/effect schema rather than another parallel one?
- Are new outputs versioned artifacts/results rather than hidden mutable caches?

### Evidence

- Can a UI/AI/decompiler consumer explain the result through stable evidence IDs?
- Is completeness (`complete`, `bounded`, `partial`, `unknown`) represented?
- Did any verifier acceptance semantics change? If yes, was evidence invalidated/re-run?

### Performance

- Did this change alter asymptotic behavior or hot-path allocations?
- Was a representative production/pathological fixture profiled?
- Is cancellation/budget behavior still conservative?

### Integration

- Does the living Phase 7 integration head contain the accepted component?
- Are canonical phase tests discovering the component tests?
- Is exact-head evidence for the current integration head green?
- Does changed-file inventory stay inside the intended ownership scope?

---

# 19. What to decide before writing code

The following decisions should be frozen in P7-0/P7-1 or via narrowly scoped ADRs. Deferring them creates expensive rewrites:

1. canonical region/root identity shape;
2. exact `AliasResult` proof/completeness schema;
3. points-to set lattice and widening rules;
4. memory-region clobber semantics for unknown stores/calls;
5. FunctionSummary effect/completeness schema;
6. escape reason taxonomy;
7. recursive SCC convergence/widening rules;
8. TypeConstraintGraph hard-vs-soft boundary and contradiction semantics;
9. DebugInfoProvider identity-binding contract;
10. FunctionCandidate start-vs-extent evidence schema;
11. artifact/pass/schema version fields used for invalidation;
12. Phase 7 verifier evidence schema and exact-head invocation.

Do not freeze internal class/file names prematurely. Freeze semantic contracts first.

---

# 20. Suggested implementation posture

The efficient path through Phase 7 is:

```text
prove the safety floor
        ↓
introduce the smallest stronger fact
        ↓
measure precision gain
        ↓
prove no false certainty
        ↓
publish stable evidence-bearing contract
        ↓
let the next layer consume only that contract
```

This deliberately prefers a sequence of small, monotonic precision improvements over one impressive but opaque whole-program engine.

A Phase 7 change is good when it makes Hex answer **more questions exactly**, while making every unanswered question remain explicitly unanswered.

---

# 21. Readiness checklist

Phase 7 implementation should not begin in earnest until:

- [ ] Phase 6 integrated baseline is identified and exact-head tests are green.
- [ ] Phase 7 living integration/reconciliation lane is defined.
- [ ] Phase 7 changed-file ownership / contract ownership is machine-checkable.
- [ ] P7-0 negative soundness corpus exists.
- [ ] baseline alias/type/function-discovery/performance metrics are captured.
- [ ] permanent exact-head Phase 7 verifier can run in shadow mode.
- [ ] region/root identity and `AliasResult` schema are agreed.
- [ ] FunctionSummary completeness/effect schema is agreed before A3.
- [ ] hard/soft type evidence boundary is agreed before debug ingestion.
- [ ] build-identity matching policy is agreed before PDB/DWARF facts become authoritative.
- [ ] start/extent metrics are separate before function-discovery tuning.
- [ ] Phase 8 consumers are expected to use public proof/query contracts only.

When these are true, Phase 7 should be difficult for the right reasons — analysis quality — rather than because core semantics, proof contracts, integration rules, or acceptance criteria are still moving underneath the implementation.