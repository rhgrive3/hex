# Phase 7 Industrial Static Analysis Execution Plan

Status: **implementation runbook / pre-Phase-7 planning**  
Repository: `rhgrive3/hex`  
Planning baseline: `main` at `e90c5107f9c77d73687ee452d5042dcbe9e79ece`  
Canonical architecture: `docs/HEX_MASTER_ARCHITECTURE.md`  
Process contract: `docs/ENGINEERING_PROCESS_GUARDRAILS.md`  
Migration contract: `docs/MIGRATION_GUARDRAILS.md`

This document turns Master Architecture Phase 7 — **Industrial static-analysis depth** — into an executable engineering plan.

It is deliberately written before implementation. The goal is to settle semantic contracts, dependency order, evidence rules, invalidation, verification, and integration mechanics before implementation pressure creates shortcuts.

If this runbook conflicts with the current `HEX_MASTER_ARCHITECTURE.md`, a later accepted ADR, or another higher-authority versioned contract, the higher-authority contract wins and this runbook must be updated.

---

# 1. Phase goal and exact success condition

Phase 7 must improve precision without weakening Hex's conservative semantic floor.

Required outcomes from the Master Architecture are:

- alias analysis A1 / A2 / A3;
- escape analysis;
- interprocedural function summaries;
- hard type constraints;
- DWARF / PDB ingestion through the common debug-info boundary;
- cross-architecture function discovery.

Phase 7 succeeds only when both are true:

1. the exact integrated product proves fewer memory/data/type/function-boundary relationships as unresolved where evidence permits a stronger answer;
2. false certainty does not increase.

A stronger answer is valuable only when Hex can explain why it is stronger and can identify the exact snapshot, analyzer version, evidence, assumptions, and completeness under which the answer was produced.

The phase is not a contest to maximize `MustAlias`, `NoAlias`, recovered types, discovered functions, or decompiler prettiness.

---

# 2. Non-goals

Phase 7 must not expand into Phase 8 or later work merely because the new analyses expose opportunities.

Not Phase 7:

- SCCP, GVN/CSE, broad DCE, loop-induction recovery, or broad readability rewrites;
- A4 unrestricted whole-program context sensitivity;
- solver-backed symbolic execution;
- debugger/instrumentation provider implementation;
- managed-runtime frontends;
- repository-wide namespace churn;
- a second semantic engine;
- replacing the public semantic facade before differential cutover proof exists.

Phase 7 may publish proof/query APIs that Phase 8 consumes. Phase 8 must not depend on private Phase 7 solver state.

---

# 3. Merge-blocking Phase 7 invariants

## P7-INV-001 — Unknown stays explicit

An unresolved pointer, call effect, function extent, type relation, debug identity, or analysis scope remains explicit as `unknown`, `may`, `partial`, `bounded`, `unsupported`, or another contract-defined conservative state.

Absence of evidence is never proof.

## P7-INV-002 — Alias relation and analysis completeness are different dimensions

Do not model alias refinement as a simplistic total order such as `unknown -> may -> must/no`.

The public semantic question has at least two independent dimensions:

```text
relation: must | may | no | unknown
completeness: complete | bounded | partial | truncated | unsupported
```

`must` and `no` require positive proof appropriate to the relation. `may` and `unknown` both block any transform that requires `NoAlias`.

A budget-limited or unsupported analysis may return a weaker relation or an incomplete status. It must never convert incompleteness into a stronger relation.

## P7-INV-003 — Unknown stores remain barriers

An unknown pointer store must clobber every memory region it may alias. If region precision is insufficient, broad clobbering is correct.

Phase 7 must never retain a reaching-store/load-forwarding proof merely because doing so produces cleaner pseudocode.

The current `js/ir.js` compatibility behavior protected by `MIGRATION_GUARDRAILS.md` is the minimum safety floor.

## P7-INV-004 — Unknown calls remain conservative

Call effects use, in order:

1. proven function summary;
2. versioned imported/library model;
3. ABI/runtime rule;
4. conservative unknown-call fallback.

A missing, stale, partial, cancelled, or identity-mismatched summary is never equivalent to purity.

## P7-INV-005 — Hard and soft type evidence stay separate

Weighted evidence cannot silently become a hard constraint. Contradictory hard constraints remain first-class conflicts; Hex must not select the highest score and call it certain.

## P7-INV-006 — Function start and extent are separate facts

A precise start with unknown extent is valid. Phase 7 must not invent one contiguous body to simplify downstream analysis.

## P7-INV-007 — Architecture / ABI / debug / language boundaries remain separate

Generic alias, points-to, summary, type, and function-discovery code must not decode architecture-specific instruction text or embed ABI register assumptions.

Target-specific evidence producers are allowed. The central solver owns the generic contract and evidence fusion.

## P7-INV-008 — Evidence survives every refinement

Every stronger alias, memory, summary, type, debug, and function-discovery conclusion must retain stable evidence/origin links and analyzer identity.

## P7-INV-009 — Precision is demand-driven

Opening a large binary must not require a whole-program points-to/type/function solve. Expensive analysis expands from the active request or runs explicitly as background/indexing work.

## P7-INV-010 — Cancellation and budget exhaustion fail closed

A cancelled, timed-out, memory-limited, or budget-exhausted analysis must not publish a result as `complete`.

If partial results are useful and contractually safe, publish them with explicit incomplete status and budget/cancellation reason. Otherwise publish no new artifact.

## P7-INV-011 — Derived artifact publication is atomic

An analyzer writes a candidate artifact, validates schema/content/identity/dependencies, and only then publishes it as the current immutable artifact.

A failed or cancelled producer must not leave a zero-byte, half-written, partially merged, or falsely current artifact visible to consumers.

## P7-INV-012 — One snapshot per query

A single query must not combine an old MemorySSA graph with a new alias result or old callee summary with a new caller graph. UI, AI, decompiler, verifier, and plugins consume one consistent `AnalysisSnapshot` or an explicitly versioned dependency set.

---

# 4. Main sequencing decision

Do not implement A1, A2, A3, escape, summaries, debug types, and function discovery as independent parallel engines and integrate them at the end.

Acceptance order:

```text
P7-0 measurement + proof/status contracts + verifier + negative corpus
  ↓
P7-1 A1 region analysis
  ↓
P7-2 A2 field-sensitive/local points-to
  ↓
P7-3a local FunctionSummary artifact
  ↓
P7-3b escape + call-effect semantics
  ↓
P7-3c A3 interprocedural SCC fixed point
  ↓
P7-4 hard TypeConstraintGraph
  ↓
P7-5 DWARF/PDB identity-bound ingestion
  ↓
P7-6 cross-architecture function discovery
  ↓
P7-I exact integrated proof
  ↓
P7-X Phase 8 handoff
```

Implementation research can overlap where contracts do not compete. Acceptance must respect dependency order.

In particular:

- A1 must not depend on a future escape result to satisfy its own exit gate;
- A3 must not invent region, points-to, escape, and summary semantics inside one monolithic solver;
- debug ingestion must not bypass the TypeConstraintGraph;
- function discovery must not become one prologue scanner per architecture.

---

# 5. P7-0 — Foundation before precision changes

P7-0 is the main efficiency investment. If it is weak, later checkpoints will spend time arguing about what counts as proof.

## 5.1 Readiness inputs

Before P7 implementation begins in earnest:

- identify the exact Phase 6 integrated/release baseline;
- run the mandatory exact-head suites on that baseline;
- snapshot the machine-readable capability truth for the architectures/formats that Phase 7 is required to exercise;
- create Phase 7 ownership/contract ownership rules;
- establish the living integration lane;
- establish the permanent exact-head Phase 7 verifier path.

Do not hard-code a stale architecture matrix from an earlier planning baseline. The P7 corpus manifest is generated/frozen from capability truth at the actual Phase 7 start.

## 5.2 Baseline evidence schema

Record at least:

- alias queries by relation and analysis level;
- result completeness/status;
- memory links proven / blocked / unresolved;
- summary completeness and unknown-call incidence;
- type accuracy and false-certainty count;
- function-start and function-extent metrics separately;
- false split / false merge;
- cold/warm active-function latency;
- representative pathological latency;
- peak/resident analysis memory where measurable;
- analyzer/pass/schema versions;
- exact product SHA / snapshot / corpus manifest identity.

## 5.3 Negative soundness corpus

Create before precision changes. Include at minimum:

- overlapping stack intervals;
- same root with uncertain offset;
- integer-to-pointer provenance loss;
- unknown pointer store between source and load;
- unknown call between source and load;
- pointer phi/select joining distinct or unresolved roots;
- cyclic pointer phi with range growth;
- pointer escape through return/global/argument/unknown call;
- recursive/mutually recursive calls;
- unresolved indirect call;
- overlapping fields / unions;
- debug build-identity mismatch;
- debug data with missing external companion;
- shared epilogue;
- tail call;
- thunk;
- non-contiguous function ownership;
- precise function start with unknown extent;
- cancellation/budget exhaustion during analysis;
- stale callee summary after semantic-version/input change.

The corpus must include tests that demonstrate the verifier rejects intentionally unsound mutants/test doubles. A verifier that only proves the current implementation passes is not proven to detect the targeted failure class.

## 5.4 Stable query boundaries

Consumers ask the analysis layer rather than rebuilding logic:

```ts
alias(a, b, options): AliasResult
reachingMemoryDef(load): MemoryDefResult
memoryEffects(callOrFunction): MemoryEffectResult
explainMemoryPath(source, sink): EvidencePath
functionSummary(functionId): FunctionSummaryResult
explainType(entityId): TypeResult
functionCandidate(address): FunctionCandidateResult
```

Exact naming follows repository conventions and higher-authority schemas.

Where completeness/budget/snapshot information is not already part of a canonical result type, expose it through one common analysis-status envelope rather than inventing incompatible status fields per subsystem.

Conceptually:

```ts
AnalysisStatus {
  snapshotId
  analyzerId
  analyzerVersion
  schemaVersion
  completeness
  budgetClass?
  stopReason?
  evidenceIds
}
```

## 5.5 P7-0 exit gate

- current semantic/decompiler/migration/compiler-truth suites remain green;
- negative corpus passes on the conservative product baseline;
- unsound mutants are rejected by the relevant negative/verifier tests;
- exact-head verifier runs before precision implementation lands;
- baseline metrics are captured from the actual product path;
- ownership and contract ownership are machine-checkable;
- result/status/evidence semantics are frozen or covered by a narrowly scoped ADR.

---

# 6. Shared artifact identity and invalidation contract

Phase 7 creates highly reusable derived artifacts. Incorrect reuse is a semantic correctness defect.

Every reusable artifact key must identify all inputs that can change its meaning. At minimum, as applicable:

```text
BinaryId / SliceId / ImageId
FunctionId or analysis scope
ArchitectureId
AbiId / PlatformId when semantically relevant
AnalysisSnapshot / project revision
Semantic IR / CFG / SSA / MemorySSA semantic versions
analyzer/pass/schema version
analysis options that affect semantics
budget class when it affects completeness
input artifact IDs/digests
callee summary IDs/digests for interprocedural results
debug provider version + matched build identity for debug-derived results
```

Rules:

1. Do not key semantic artifacts by filename, UI tab, address string, or mutable object identity.
2. A caller summary depending on a callee summary must identify that exact dependency.
3. A change in semantic acceptance rules invalidates historical release evidence affected by that rule.
4. `partial`/`bounded` artifacts must never satisfy a lookup requiring `complete`.
5. A cancelled/failed producer must not advance the published artifact identity.
6. Dependency invalidation is transitive through artifact identity; avoid ad-hoc global cache clearing as the correctness mechanism.

---

# 7. P7-1 — A1 region alias analysis

A1 introduces coarse regions without pretending to solve points-to globally.

Master-architecture initial regions:

```text
StackRegion(function/frame)
GlobalRegion(image/module)
ObjectRegion(root identity)
AllocationRegion(site/summary)
TLSRegion(module/thread model)
UnknownRegion
```

## 7.1 Canonical location model

A location retains, when known:

```text
region identity
root provenance
offset / interval
access width
address space
origin/evidence
analysis status/completeness
```

Alias and MemorySSA use one canonical root/region identity service. A UI/decompiler/plugin must not create a stronger private root equivalence rule.

## 7.2 Safe A1 `NoAlias` examples

P7-1 itself may prove separation from evidence available at P7-1, for example:

- distinct proven physical address spaces;
- disjoint fixed stack intervals in the same proven frame;
- non-overlapping exact globals.

Do **not** make P7-1 completion depend on "distinct proven non-escaping allocations" because the Phase 7 escape proof is delivered later in P7-3. Once P7-3 exists, A1/A2 may consume its proven non-escape evidence as an additional refinement without creating a backwards phase dependency.

Remain `MayAlias`/`Unknown` when appropriate:

- unresolved pointer root;
- uncertain phi root;
- unknown/wrapped offset;
- unresolved address space;
- allocation/object relation whose required escape proof is unavailable.

## 7.3 Hard parts

### Canonical root identity

Syntactically different expressions can identify one root; syntactically similar expressions can identify different roots. Use semantic provenance, not pretty-printed equality.

### Interval arithmetic

Use checked arithmetic. Wrapped, overflowed, unknown, or architecture-width-ambiguous intervals must not create a `NoAlias` proof.

### Region clobbering

Unknown stores/calls clobber all regions they may affect. Precision failure becomes broad clobbering, not stale memory facts.

## 7.4 Exit gate

- every A1 `NoAlias` has a machine-readable proof reason/evidence path;
- zero false `NoAlias` in the mandatory negative corpus;
- existing unknown-store/call barriers do not regress;
- representative broad `UnknownRegion` usage is reduced or the checkpoint explicitly documents why the corpus cannot yet show reduction;
- no A1 exit criterion requires a P7-3 escape result;
- latency stays inside the P7-0 machine-readable regression budget.

---

# 8. P7-2 — A2 field-sensitive/local points-to

Required modeled operations:

- pointer copies;
- root + constant/ranged offset;
- phi/select merges;
- stack/global/object/allocation roots;
- field intervals;
- load-derived pointers;
- pointer arguments/returns as unresolved boundaries until summary evidence exists;
- provenance loss through unsupported or ambiguous integer/pointer conversions.

Recommended compact fact shape:

```ts
PointsToSet {
  targets: Array<{
    regionId,
    rootId,
    offsetRange,
    width?,
    evidenceIds
  }>
  completeness
}
```

The expression/provenance graph remains referenced by stable IDs rather than duplicated into every answer.

## 8.1 Fixed-point contract

Before implementation, define:

- lattice elements;
- join;
- bottom/top meanings;
- range representation;
- widening condition;
- deterministic worklist ordering requirements if observable;
- budget/cancellation behavior.

Iteration count is a termination mechanism, never semantic proof.

## 8.2 Hard parts

### Phi cycles

Loop pointer phis require finite convergence or widening. A growing range eventually loses precision conservatively; it must not wrap into a falsely small range.

### Pointer arithmetic

Constant field offsets are different from arbitrary integer-derived pointers. When provenance is lost, record the loss explicitly.

### Overlapping fields/unions

Different recovered field labels do not prove separation when byte intervals overlap.

### Load-derived pointers

Points-to precision is bounded by the reaching-memory proof. Multiple possible definitions require a conservative merge.

## 8.3 Exit gate

- deterministic result for a fixed snapshot/options/analyzer version;
- cyclic fixtures terminate under documented widening/budget rules;
- field-sensitive precision improves the frozen representative query set;
- union/overlap/phi/integer-cast/unknown-store negative cases remain conservative;
- no consumer bypasses the canonical alias/query boundary for a stronger result;
- latency/memory stay inside P7-0 regression budgets.

---

# 9. P7-3 — Function summaries, escape analysis, A3 interprocedural solving

Treat P7-3a/3b/3c as one dependency chain, not three independent semantic systems.

## 9.1 P7-3a local FunctionSummary

Canonical minimum shape follows the Master Architecture:

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

A summary is immutable derived analysis. Its artifact key includes the semantic dependencies defined in section 6.

A local summary does not pretend unresolved callees are pure; unresolved call effects remain explicit.

## 9.2 P7-3b escape taxonomy

At minimum preserve why and across which boundary a root escaped:

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

Escape is not one boolean when later analysis needs the boundary/reason to know which separation proof remains valid.

Generic escape analysis exposes provider/evidence hooks for language/runtime captures. It does not embed Swift/ObjC/C++/Rust/Go-specific decoding in the generic solver.

## 9.3 P7-3c interprocedural order

1. build validated local summaries;
2. build direct-call dependencies;
3. classify indirect-call evidence;
4. condense recursive components into SCCs;
5. solve acyclic SCC DAG bottom-up where possible;
6. solve recursive SCCs to fixed point;
7. widen to guarantee termination where required;
8. include conservative unknown-call effects for unresolved targets;
9. validate dependency identities and completeness;
10. atomically publish stabilized immutable summary artifacts.

## 9.4 Hard parts

### Recursion and summary growth

Define finite effect/range lattices and widening before implementation. Mutual recursion must terminate deterministically.

### Indirect calls

A finite proven candidate set may merge candidate summaries. An incomplete target set includes unknown-call effects. Never "average away" unresolved behavior.

### Escape-induced refinement/invalidation

When escape evidence changes, any `NoAlias` proof that depended on non-escape must be invalidated through artifact dependencies.

### Summary invalidation

Callee changes invalidate dependent callers transitively by identity/digest, not by manually clearing an unrelated global cache.

### Cancellation

A cancelled SCC solve cannot publish a complete interprocedural summary. If bounded partial summaries are exposed, they remain explicitly incomplete and cannot satisfy a complete-summary consumer.

## 9.5 Exit gate

- recursive SCC corpus terminates deterministically;
- unknown/partial call effects remain explicit;
- known callees measurably improve caller memory precision on the frozen query set;
- unresolved/indirect calls never become accidentally pure;
- escape cases invalidate exactly the separation proofs that depended on non-escape;
- transitive summary invalidation is artifact/version driven;
- cancelled/budgeted runs fail closed;
- exact-head negative corpus remains green.

---

# 10. P7-4 — Hard TypeConstraintGraph

The final type architecture has four distinct layers:

```text
MachineType
ABIType
RecoveredStructuralType
NominalLanguageType
```

Do not collapse these merely because representations are compatible.

## 10.1 Hard constraints

Examples aligned with the Master Architecture:

- load/store width;
- ABI argument/return location;
- exact debug-info type bound to the matched build;
- verified runtime metadata;
- pointer arithmetic width/stride where exact;
- authoritative call prototype constraints.

## 10.2 Soft evidence

Examples:

- selector/name patterns;
- symbol spelling;
- runtime-library patterns;
- inferred use shape;
- heuristic array stride;
- signature candidate;
- decompiler presentation hints.

Soft evidence ranks candidates. It cannot erase a hard contradiction.

## 10.3 Result contract

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

Use graph identities for recursive types. Keep ABI passing shape distinct from recovered source layout.

## 10.4 Hard parts

- equality vs representational compatibility;
- casts and opaque handles;
- unions/overlapping storage;
- recursive type cycles;
- forward declarations;
- signedness ambiguity;
- ABI aggregate classification vs structural layout;
- localized contradiction handling without poisoning unrelated graph components.

## 10.5 Exit gate

- public result cannot confuse hard and soft evidence;
- deliberate contradiction fixtures remain conflicted/ambiguous rather than certain;
- paired truth benchmark improves under the frozen scoring definition;
- false-certainty count does not increase;
- debug evidence can only become authoritative after identity verification;
- decompiler consumes canonical `TypeResult`, not private solver state.

---

# 11. P7-5 — DWARF / PDB ingestion

Debug information enters as evidence through the common provider boundary; it does not bypass type/evidence identity.

Canonical provider contract from the Master Architecture:

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

## 11.1 Implementation order

1. freeze provider/result/status schemas and identity policy;
2. implement one ecosystem sufficiently to prove the boundary;
3. prove exact identity binding and fail-closed mismatch behavior;
4. feed authoritative results into canonical symbol/type/evidence systems;
5. implement the second required ecosystem through the same boundary;
6. prove neither backend has a private type-application path.

Phase 7's deliverable is DWARF **and** PDB ingestion. The first-backend-first sequence is an implementation tactic, not permission to finish the phase with only one ecosystem.

## 11.2 Identity states

Do not use filename/path equality as authority.

Provider output must distinguish at least:

```text
matched-authoritative
matched-partial
identity-unavailable
identity-mismatch
companion-missing
unsupported
```

Record:

```text
expected binary/build identity
observed debug identity
provider/version
match verdict
completeness
evidence IDs
```

Only a contract-approved matched identity may create authoritative debug facts. Other states may be surfaced diagnostically but must not silently create authoritative types/symbols.

## 11.3 Hard parts

- split/external debug information;
- missing companion files;
- relocation/image-base normalization;
- inline frames vs physical function identity;
- typedef/qualifier/forward-declaration cycles;
- PDB/DWARF representation differences behind one provider contract;
- huge debug databases and paged/lazy reads;
- valid debug info whose optimized/inlined source shape differs from physical machine layout.

## 11.4 Exit gate

- both required debug ecosystems use the common provider boundary;
- authoritative application requires approved identity match;
- mismatched-debug fixtures fail closed;
- missing-companion state is explicit;
- provider outputs are paged/budgeted for large inputs;
- symbols/types/lines retain debug-source provenance;
- type accuracy is reported separately with and without debug evidence.

---

# 12. P7-6 — Cross-architecture function discovery

Function discovery is evidence fusion, not a side effect of disassembly.

Evidence producers may include:

- loader function starts;
- unwind data;
- symbols/debug info;
- exports/entrypoints;
- direct-call targets;
- relocation targets;
- vtables/witness/runtime metadata;
- exception metadata;
- compiler/runtime tables;
- validated architecture-specific prologue/epilogue candidates;
- runtime observations where available.

Central result contract follows the Master Architecture:

```ts
FunctionCandidate {
  start
  regions
  startEvidence
  extentEvidence
  confidence
  conflicts
  state: exact | probable | heuristic | contradicted
}
```

## 12.1 Key rule

**Evidence producers may be target-specific; evidence fusion is generic.**

The central solver must not parse architecture mnemonic text or embed target-specific register conventions.

## 12.2 Start vs extent

Track independently:

- start precision;
- start recall;
- extent precision;
- extent recall;
- false split;
- false merge.

One good start score cannot hide bad extent ownership.

## 12.3 Hard parts

- shared epilogues;
- tail calls;
- thunks;
- non-contiguous regions;
- exception/landing-pad ownership;
- overlapping evidence;
- contradictory symbols/unwind/heuristics;
- architecture-specific producer quality without architecture leakage into the central solver.

## 12.4 Corpus scope

At actual Phase 7 start, freeze a machine-readable target/corpus manifest from the capability truth produced by the completed prerequisite phases.

Do not infer cross-architecture coverage from the stale planning baseline. Every architecture admitted to the Phase 7 mandatory corpus must have enough prerequisite semantic maturity to exercise the same middle-end contracts; unsupported combinations remain explicit rather than silently skipped green.

## 12.5 Exit gate

- start/extent metrics are reported independently;
- stripped fixtures are scored against paired truth where possible;
- mandatory architecture lanes are explicit in the corpus manifest;
- no mandatory lane is skipped green because a provider is missing;
- generic discovery contains no decoder/ABI-specific semantics.

---

# 13. P7-I — Living integration and checkpoint protocol

P7-I exists from P7-0. It is not a final cleanup branch.

Each accepted checkpoint follows this protocol:

1. component PR proves its owned semantics and negative cases on its exact head;
2. changed-file inventory is checked against ownership/contract ownership;
3. candidate integration incorporates the component without unrelated scope;
4. P7-I enters **checkpoint-locked** state;
5. required shared contract/invalidation wiring is completed by the integration owner;
6. generated outputs are rebuilt/synchronized **if the repository ownership policy says this integration lane owns affected generated output**;
7. canonical Phase 7 runner discovers the new component tests;
8. rolling product gates run on the exact P7-I head;
9. independent Phase 7 verifier runs on that same exact head;
10. evidence records product SHA, verifier/schema version, corpus manifest, and analyzer versions;
11. only then does the checkpoint unlock for the next dependent acceptance.

Independent future work may continue while P7-I is locked, but the next dependent component must not be accepted on top of an unproven integration checkpoint.

## 13.1 Moving `main`

One integration/reconciliation lane owns moving-main reconciliation.

Component branches do not repeatedly rebase merely because unrelated `main` moved. Reconcile at defined acceptance/release boundaries and whenever a shared semantic contract actually changed.

If a reconciliation changes the candidate merge tree, exact-head evidence from the old tree is obsolete.

## 13.2 Verifier rule

A verifier change that changes acceptance semantics, corpus provenance, oracle selection, exact-head binding, or completeness rules invalidates affected older evidence.

Prefer verifier-semantic changes as separately reviewable changes before the implementation they will judge. Do not repair a failing implementation by silently weakening the verifier in the same change.

---

# 14. Work decomposition

| Checkpoint | Primary ownership | Dependency | Main proof |
|---|---|---|---|
| P7-0 | metrics + status/proof contracts + verifier + negative corpus | exact Phase 6 baseline | baseline + mutation/exact-head proof |
| P7-1 | canonical regions + A1 | P7-0 | zero false `NoAlias` |
| P7-2 | A2 local/field points-to | P7-1 | precision + cyclic/union/cast safety |
| P7-3a | local FunctionSummary artifact | P7-2 | deterministic local summaries |
| P7-3b | escape taxonomy/effects | P7-3a | escape invalidation corpus |
| P7-3c | A3 SCC interprocedural solver | P7-3b | termination + unknown-call safety |
| P7-4 | TypeConstraintGraph | stable P7-3 contracts | accuracy + no false certainty |
| P7-5a | DebugInfoProvider contract + first ecosystem | P7-4 | identity-bound ingestion |
| P7-5b | second required debug ecosystem | P7-5a | provider portability |
| P7-6 | cross-arch function discovery | P7-3 + loader/target evidence | start/extent truth |
| P7-I | rolling integration | P7-0 onward | exact integrated proof |
| P7-X | Phase 8 handoff | all accepted checkpoints | master exit gates |

---

# 15. Parallelism policy

Useful parallel work:

- corpus/benchmark construction while A1 starts;
- verifier implementation/review against already frozen result schemas;
- DWARF/PDB fixture preparation while TypeConstraintGraph stabilizes;
- function-discovery corpus preparation while summaries mature;
- profiling/hot-path instrumentation while semantic implementation proceeds;
- independent component work that does not require an unproven downstream contract.

Do not parallelize competing semantic truths:

- two canonical alias solvers;
- two root-identity implementations;
- architecture-specific summary schemas;
- debug providers applying types outside TypeConstraintGraph;
- independent function-discovery solvers embedded in decoders.

---

# 16. Performance and resource strategy

Phase 7 can create expensive analyses. Do not hide production complexity behind CI fanout.

Rules:

1. profile a representative slow production fixture before increasing CI/job fanout;
2. keep A0/A1/A2 current-function work demand-driven and bounded;
3. compute summaries demand-first and expand along required call dependencies;
4. persist/version reusable artifacts where the existing artifact architecture permits;
5. solve only relevant SCCs for active requests unless explicit background/indexing work requests broader coverage;
6. reserve A4/context sensitivity for targeted questions;
7. page/bound debug reads and indexes;
8. prefer compact IDs/sets/intervals over duplicated object graphs;
9. publish `partial`/`bounded` or no result when budgets stop analysis;
10. never change a conservative semantic answer solely to meet a latency target.

P7-0 captures baseline measurements and creates machine-readable regression budgets. A later budget change requires recorded measurement/rationale; "explained and accepted" prose alone is not a merge gate.

At minimum measure:

- cold current-function analysis;
- warm current-function analysis;
- caller/callee summary expansion;
- recursive SCC fixture;
- pathological pointer-phi fixture;
- large debug lookup;
- stripped large-binary function discovery;
- peak working set/artifact footprint where measurable.

---

# 17. Test pyramid

## L0 — lattice/unit laws

- alias symmetry where applicable;
- interval/set join monotonicity;
- widening termination;
- points-to merge determinism;
- summary merge monotonicity;
- contradiction preservation;
- artifact identity/invalidation laws;
- cancellation cannot publish `complete`.

## L1 — synthetic semantic fixtures

Tiny CFG/SSA/MemorySSA fixtures for exact edge cases.

## L2 — compiler-truth micro corpus

Paired source/build truth, optimization variants, stripped/debug pairs, and relevant C/C++/ObjC/Swift/Rust/Go cases.

## L3 — architecture/format capability matrix

Use the P7-start machine-readable corpus manifest. Missing mandatory capability is blocking, not skip-green.

## L4 — differential/oracle diagnostics

External/reference tooling may diagnose differences where repository policy allows it. External output is not automatically Hex truth.

## L5 — real-binary/pathological performance corpus

Stripped binaries, large functions, recursion, pointer-heavy code, and large debug metadata.

## L6 — exact integrated candidate

Run the permanent exact-head verifier against the actual P7-I candidate.

---

# 18. Failure modes to prevent

## FM-1 — Optimistic aliasing

Unknown store/call is ignored because pseudocode becomes cleaner.

**Block with:** negative barriers + proof required for every `NoAlias`.

## FM-2 — A3 big-bang solver

One solver invents regions, points-to, escape, call effects, and recursion semantics.

**Block with:** accepted A1/A2/local-summary/escape contracts first.

## FM-3 — Boolean escape

Everything collapses to `escaped=true/false`.

**Block with:** reason + boundary taxonomy.

## FM-4 — Summary cache poisoning

Caller remains precise after callee semantics/options change.

**Block with:** exact dependency identity + transitive invalidation.

## FM-5 — Partial result treated as complete

A timed-out/cancelled result is reused as authoritative.

**Block with:** common analysis status + artifact lookup completeness requirement.

## FM-6 — Type confidence hides contradiction

High score masks incompatible hard constraints.

**Block with:** first-class contradictions that prevent certainty.

## FM-7 — Debug filename trust

Wrong PDB/DWARF applies plausible but false facts.

**Block with:** build identity verdict before authoritative application.

## FM-8 — Function discovery conflates start/extent

Good start detection hides bad merging/splitting.

**Block with:** separate truth/metrics/evidence.

## FM-9 — Architecture leakage

Generic solver checks architecture registers/mnemonics.

**Block with:** dependency guardrails + target-provider boundary tests.

## FM-10 — Verifier matures at release

P7-X becomes verifier development.

**Block with:** P7-0 shadow verifier + frozen acceptance semantics.

## FM-11 — Performance hidden by CI parallelism

CI gets faster while product stays pathological.

**Block with:** production profiling and regression budgets.

## FM-12 — Moving-main PR churn

Repeated replacement PRs are created solely because `main` moved.

**Block with:** one reconciliation lane + defined reconciliation boundaries.

## FM-13 — Atomicity failure

Failed analysis leaves a current-looking partial artifact.

**Block with:** validate-then-publish immutable artifact transaction.

---

# 19. Review checklist for every Phase 7 PR

## Semantics

- What stronger facts can this change now prove?
- What positive proof permits each new `NoAlias`, `MustAlias`, type, or function conclusion?
- Which cases deliberately remain unknown/may/partial?
- Does an unknown store/call still invalidate every proof it should?
- Can cancelled/budgeted work ever appear complete?

## Architecture

- Is generic logic free of architecture/ABI/debug-format semantics?
- Is there one canonical identity/root/effect/result schema?
- Are reusable outputs immutable/versioned artifacts rather than hidden mutable caches?
- Does the query observe one consistent snapshot/dependency set?

## Evidence

- Can UI/AI/decompiler explain the result through stable evidence IDs?
- Is completeness explicit?
- Is analyzer/schema version explicit?
- Did verifier acceptance semantics change? If yes, was older evidence invalidated and rerun?

## Performance

- Did asymptotic behavior or hot-path allocation change?
- Was the representative production/pathological fixture profiled?
- Is resource-stop behavior conservative?
- Does the exact head stay inside machine-readable regression budgets?

## Integration

- Is changed-file inventory inside ownership scope?
- Does canonical Phase 7 test discovery include the new tests?
- Is the accepted component present on P7-I?
- Is P7-I checkpoint evidence exact-head and current?
- If generated output is owned by P7-I for this change, is canonical generated diff zero?

---

# 20. Decisions to freeze before writing dependent code

Freeze semantic contracts, not internal class/file names.

1. canonical region/root identity;
2. canonical `AliasResult` minimum schema and common analysis-status envelope;
3. points-to lattice/join/widening/provenance-loss rules;
4. unknown store/call clobber semantics;
5. FunctionSummary effect/completeness schema;
6. summary artifact identity/dependency rules;
7. escape reason/boundary taxonomy;
8. recursive SCC convergence/widening rules;
9. hard-vs-soft TypeConstraintGraph boundary and contradiction semantics;
10. DebugInfoProvider identity verdict/application policy;
11. FunctionCandidate start-vs-extent evidence model;
12. corpus manifest identity and truth-generation process;
13. Phase 7 verifier schema/exact-head invocation;
14. cancellation/partial-result publication semantics;
15. machine-readable performance regression budgets.

---

# 21. Phase 8 handoff contract

Phase 8 consumes only evidence-bearing public analysis boundaries such as:

```text
alias relation + proof + status
reaching memory def + proof + status
call/function memory effects + completeness
FunctionSummary + dependency identity
escape reason/boundary
TypeResult + contradictions
FunctionCandidate regions/start/extent evidence
```

Phase 8 transformations must not reach into private A1/A2/A3 solver state.

This permits SCCP/GVN/DCE/load-store forwarding/aggregate recovery to improve without coupling decompiler correctness to a particular Phase 7 solver implementation.

---

# 22. Readiness and completion checklists

## Before Phase 7 implementation

- [ ] exact Phase 6 integrated baseline identified;
- [ ] mandatory baseline gates green on that exact head;
- [ ] P7-start machine-readable capability/corpus manifest frozen;
- [ ] living P7-I lane defined;
- [ ] changed-file and contract ownership machine-checkable;
- [ ] negative soundness + unsound-mutant tests exist;
- [ ] baseline alias/type/function/performance metrics captured;
- [ ] permanent exact-head Phase 7 verifier runs in shadow mode;
- [ ] root identity + alias/status contracts agreed;
- [ ] FunctionSummary completeness/effect/invalidation contract agreed before A3;
- [ ] hard/soft type boundary agreed before debug authoritative application;
- [ ] debug build-identity policy agreed;
- [ ] start/extent truth metrics separate;
- [ ] cancellation/atomic publication semantics tested.

## Phase 7 final completion

- [ ] every required checkpoint accepted into P7-I through checkpoint lock;
- [ ] exact integrated semantic/decompiler/compiler-truth/migration suites green;
- [ ] negative soundness corpus green;
- [ ] unsound-mutant verifier self-tests green;
- [ ] exact-head Phase 7 verifier green on the release candidate;
- [ ] unknown memory links measurably reduced under the frozen metric definition;
- [ ] zero unsound alias regression in mandatory truth/negative corpus;
- [ ] type accuracy improved without increased false certainty;
- [ ] DWARF and PDB both use identity-bound common provider path;
- [ ] function discovery reports independent start/extent metrics across mandatory P7 corpus lanes;
- [ ] production/pathological performance inside current approved budgets;
- [ ] no mandatory whole-program solve on file open/current-function path;
- [ ] Phase 8 consumers use only the public handoff contract.

The desired implementation posture is:

```text
prove the safety floor
  ↓
introduce the smallest stronger fact
  ↓
measure the precision gain on a frozen query set
  ↓
prove no false certainty
  ↓
publish an immutable evidence-bearing artifact
  ↓
let the next layer consume only that contract
```

A good Phase 7 change makes Hex answer more questions exactly while leaving every unanswered question explicitly unanswered.
