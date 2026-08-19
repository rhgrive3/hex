# Phase 7 Industrial Static Analysis Execution Plan

Status: **executed** — see [`PHASE7_CHECKPOINT.md`](PHASE7_CHECKPOINT.md) for the live evidence\
Repository: `rhgrive3/hex`  
Initial docs-branch fork: `main` at `e90c5107f9c77d73687ee452d5042dcbe9e79ece`  
Final review live baseline: `main` at `9fb1c3f9327869e83170e75b6f132ad699b82a0e` (Phase 6 integration merged via #852)  
Canonical architecture: `docs/HEX_MASTER_ARCHITECTURE.md`  
Process contract: `docs/ENGINEERING_PROCESS_GUARDRAILS.md`  
Migration contract: `docs/MIGRATION_GUARDRAILS.md`

> **Execution note.** This runbook has been executed. The phase base was live
> `main` at `bdf90569ed037a3d30e4439dcde970aad9352e21`; the accepted checkpoint
> ledger is `reports/phase7/checkpoints.json`, the frozen corpus/query/truth/
> scoring manifest is `tests/phase7/corpus/manifest.json`, and the exact-head
> verifier is `tools/validation/phase7/verify.mjs`. The invariants and exit
> gates below are unchanged; nothing here was relaxed to fit the
> implementation.

This document turns Master Architecture Phase 7 — **Industrial static-analysis depth** — into an executable engineering plan.

It is deliberately written before implementation. The goal is to settle semantic contracts, dependency order, evidence rules, invalidation, verification, measurement, and integration mechanics before implementation pressure creates shortcuts.

The live-baseline SHA above is a review-time observation, not a permanently frozen Phase 7 release base. P7-0 must resolve the then-current exact Phase 6-integrated baseline again before implementation starts.

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

A stronger answer is valuable only when Hex can explain why it is stronger and identify the exact snapshot, analyzer version, evidence, assumptions, completeness, and corpus/query identity under which the answer was produced.

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

The semantic question has at least two independent dimensions:

```text
relation: must | may | no | unknown
completeness: complete | bounded | partial | truncated | unsupported
```

`must` and `no` require positive proof appropriate to the relation. `may` and `unknown` both block any transform that requires `NoAlias`.

A budget-limited or unsupported analysis may return a weaker relation or incomplete status. It must never convert incompleteness into a stronger relation.

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

A library model is versioned, identifies its source, and must not override contradictory binary evidence.

## P7-INV-005 — Hard and soft type evidence stay separate

Weighted evidence cannot silently become a hard constraint. Contradictory hard constraints remain first-class conflicts; Hex must not select the highest score and call it certain.

## P7-INV-006 — Function start and extent are separate facts

A precise start with unknown extent is valid. Phase 7 must not invent one contiguous body to simplify downstream analysis.

## P7-INV-007 — Architecture / ABI / debug / language boundaries remain separate

Generic alias, points-to, summary, type, and function-discovery code must not decode architecture-specific instruction text or embed ABI register assumptions.

Target-specific evidence producers are allowed. The central solver owns generic contracts and evidence fusion.

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

A single query must not combine an old MemorySSA graph with a new alias result or an old callee summary with a new caller graph. UI, AI, decompiler, verifier, and plugins consume one consistent `AnalysisSnapshot` or an explicitly versioned dependency set.

## P7-INV-013 — Static truth and runtime/user evidence remain separated

Runtime evidence may confirm, contradict, or refine a static candidate, but it must not silently mutate the static Phase 7 artifact. User names/comments likewise must not invalidate or rewrite static semantics unless the explicit user edit is itself a semantic input, such as an approved user type constraint.

## P7-INV-014 — Metrics cannot change underneath the candidate

Corpus membership, query selection, truth generation, scoring formulas, exclusion rules, and aggregation rules are versioned evidence inputs. Changing them invalidates affected historical comparison evidence.

A regression cannot be hidden by removing a difficult fixture, changing a denominator, changing a truth source, or replacing a failed exact query with an easier one.

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
- run mandatory exact-head suites on that baseline;
- snapshot machine-readable capability truth for architectures/formats Phase 7 must exercise;
- create Phase 7 changed-file ownership and contract ownership rules;
- establish living integration lane;
- establish permanent exact-head Phase 7 verifier path;
- prove canonical test discovery sees a sentinel from every Phase 7-owned test subtree;
- freeze baseline corpus/query/truth/metric manifest before implementation results are known.

Do not hard-code a stale architecture matrix from an earlier planning baseline. The P7 corpus manifest is generated/frozen from capability truth at actual Phase 7 start.

At the final review baseline (`9fb1c3f...`), live support truth reports shared implemented depth through the generic CFG/SSA/MemorySSA/decompiler path for `arm64`, `x86_64`, and `riscv64`, while cumulative maturity remains conservative because exact low-level effects are still partial. P7-0 must therefore expect those three as the minimum cross-architecture semantic lanes unless the then-current machine-readable capability truth explicitly changes. `arm64e` partial coverage may add evidence but must not substitute for one of those lanes.

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
- exact product SHA / snapshot / corpus manifest identity;
- truth/oracle version and scoring version.

## 5.3 Negative soundness corpus

Create before precision changes. Include at minimum:

- overlapping stack intervals;
- same root with uncertain offset;
- integer-to-pointer provenance loss;
- unknown pointer store between source and load;
- unknown call between source and load;
- false `MustAlias` from similar-looking roots;
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
- stale callee summary after semantic-version/input change;
- stale debug-derived type after provider/build identity change.

The corpus must include tests demonstrating that the verifier rejects intentionally unsound mutants/test doubles. A verifier that only proves current implementation passes is not proven to detect the targeted failure class.

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
- negative corpus passes on conservative product baseline;
- unsound mutants are rejected by relevant negative/verifier tests;
- exact-head verifier runs before precision implementation lands;
- baseline metrics are captured from actual product path;
- ownership and contract ownership are machine-checkable;
- canonical phase runner discovers every owned test subtree;
- result/status/evidence semantics are frozen or covered by narrowly scoped ADR;
- corpus/query/truth/scoring manifest is immutable/versioned for baseline-vs-candidate comparison.

---

# 6. Shared artifact identity and invalidation contract

Phase 7 creates reusable derived artifacts. Incorrect reuse is a semantic correctness defect.

Every reusable artifact key must identify all inputs that can change its meaning. At minimum, as applicable:

```text
BinaryId / SliceId / ImageId
FunctionId or analysis scope
ArchitectureId
AbiId / PlatformId when semantically relevant
AnalysisSnapshot and only semantically relevant project revision inputs
Semantic IR / CFG / SSA / MemorySSA semantic versions
analyzer/pass/schema version
analysis options that affect semantics
budget class when it affects completeness
input artifact IDs/digests
callee summary IDs/digests for interprocedural results
debug provider version + matched build identity for debug-derived results
library-model version/source identity when consumed
```

Do not put unrelated presentation state into semantic cache identity merely because it is convenient. User renames/comments should not invalidate alias analysis.

## 6.1 Required dependency graph

Reusable artifacts must expose enough dependency identity to answer "why is this stale?" without heuristic cache clearing.

Minimum conceptual dependency chain:

```text
Binary/Image identity
  ↓
MachineEffects / Semantic IR
  ↓
CFG
  ↓
SSA + MemorySSA
  ↓
A1/A2 points-to + alias
  ↓
local FunctionSummary
  ↓
escape / A3 interprocedural summaries
  ↓
TypeConstraintGraph results

Debug provider + matched build identity
  ├──→ symbol/debug evidence
  ├──→ TypeConstraintGraph constraints
  └──→ Function discovery evidence

Loader/unwind/reloc/runtime-metadata evidence
  └──→ Function discovery evidence
```

The graph records actual dependencies; this diagram is not permission to invalidate every downstream artifact blindly when a narrower dependency is known.

## 6.2 Change-impact rules

| Changed input | Must invalidate/recompute at minimum | Must not be invalidated solely for this reason |
|---|---|---|
| binary/image identity | all binary-derived Phase 7 artifacts | none |
| MachineEffects/Semantic-IR semantics | dependent CFG/SSA/MSSA/alias/summaries/types and discovery evidence derived from semantics | independent loader/debug evidence |
| CFG/SSA/MSSA semantic version | dependent alias/summary/type results | independent debug symbol pages |
| A1/A2 analyzer semantics/options | dependent alias proofs and summaries/types that consumed them | unrelated debug parsing |
| callee summary identity | dependent caller/interprocedural summaries and consumers | unrelated functions with no dependency edge |
| library model identity | only summaries/results that consumed that model | unrelated callsites |
| approved user type constraint | affected TypeConstraintGraph component and derived consumers | machine semantics/alias unless explicit dependency exists |
| debug provider/build identity | debug-derived evidence/types/discovery results | static alias/MSSA unrelated to debug evidence |
| UI rename/comment/bookmark | presentation/project projection only | static semantic artifacts |
| runtime observation | runtime-evidence fusion products | immutable static artifact itself |

If implementation discovers a dependency not represented here, update the dependency contract before relying on cache reuse.

## 6.3 Publication rules

1. Do not key semantic artifacts by filename, UI tab, address string, or mutable object identity.
2. A caller summary depending on a callee summary identifies that exact dependency.
3. A change in semantic acceptance rules invalidates historical release evidence affected by that rule.
4. `partial`/`bounded` artifacts never satisfy a lookup requiring `complete`.
5. A cancelled/failed producer never advances the published artifact identity.
6. Dependency invalidation is transitive through explicit edges.
7. Validate schema, scope, snapshot, dependencies, and completeness before publication.
8. Consumers never silently fall back to a stale artifact after dependency mismatch; they obtain explicit cache miss/unknown/partial state and schedule recomputation if appropriate.

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

Alias and MemorySSA use one canonical root/region identity service. UI/decompiler/plugin code must not create a stronger private root-equivalence rule.

## 7.2 Safe A1 `NoAlias` examples

P7-1 itself may prove separation from evidence available at P7-1, for example:

- distinct proven physical address spaces;
- disjoint fixed stack intervals in the same proven frame;
- non-overlapping exact globals.

Do **not** make P7-1 completion depend on "distinct proven non-escaping allocations" because Phase 7 escape proof is delivered later in P7-3. Once P7-3 exists, A1/A2 may consume proven non-escape evidence as an additional refinement without a backwards phase dependency.

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

- every A1 `NoAlias` has machine-readable proof reason/evidence path;
- zero false `NoAlias` and zero false `MustAlias` in mandatory exact-truth cases;
- existing unknown-store/call barriers do not regress;
- representative broad `UnknownRegion` usage is reduced or checkpoint explicitly records reduction deferred to A2 without claiming Phase 7 master exit gate;
- no A1 exit criterion requires P7-3 escape;
- latency stays inside P7-0 machine-readable regression budget.

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

Constant field offsets are different from arbitrary integer-derived pointers. When provenance is lost, record loss explicitly.

### Overlapping fields/unions

Different recovered field labels do not prove separation when byte intervals overlap.

### Load-derived pointers

Points-to precision is bounded by reaching-memory proof. Multiple possible definitions require conservative merge.

## 8.3 Exit gate

- deterministic result for fixed snapshot/options/analyzer version;
- cyclic fixtures terminate under documented widening/budget rules;
- field-sensitive precision improves frozen representative query set;
- zero false strong alias conclusions in union/overlap/phi/integer-cast/unknown-store cases;
- no consumer bypasses canonical alias/query boundary for stronger result;
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

A summary is immutable derived analysis. Its artifact key includes semantic dependencies defined in section 6.

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

Escape is not one boolean when later analysis needs boundary/reason to know which separation proof remains valid.

Generic escape analysis exposes provider/evidence hooks for language/runtime captures. It does not embed Swift/ObjC/C++/Rust/Go-specific decoding in generic solver.

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

Callee or library-model changes invalidate dependent callers transitively by identity/digest, not by manually clearing unrelated global cache.

### Cancellation

A cancelled SCC solve cannot publish a complete interprocedural summary. If bounded partial summaries are exposed, they remain explicitly incomplete and cannot satisfy complete-summary consumer.

## 9.5 Exit gate

- recursive SCC corpus terminates deterministically;
- unknown/partial call effects remain explicit;
- known callees measurably improve caller memory precision on frozen query set;
- unresolved/indirect calls never become accidentally pure;
- library models cannot override contradictory binary evidence;
- escape cases invalidate exactly separation proofs that depended on non-escape;
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
- exact debug-info type bound to matched build;
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
- paired truth benchmark improves under frozen scoring definition;
- false-certainty count does not increase;
- debug evidence can only become authoritative after identity verification;
- user-provided type constraints are provenance-tagged and invalidate only dependent type results unless another dependency is explicit;
- decompiler consumes canonical `TypeResult`, not private solver state.

---

# 11. P7-5 — DWARF / PDB ingestion

Debug information enters as evidence through common provider boundary; it does not bypass type/evidence identity.

Canonical provider contract from Master Architecture:

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
2. implement one ecosystem sufficiently to prove boundary;
3. prove exact identity binding and fail-closed mismatch behavior;
4. feed authoritative results into canonical symbol/type/evidence systems;
5. implement second required ecosystem through same boundary;
6. prove neither backend has private type-application path.

Phase 7's deliverable is DWARF **and** PDB ingestion. The first-backend-first sequence is an implementation tactic, not permission to finish phase with only one ecosystem.

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

- both required debug ecosystems use common provider boundary;
- authoritative application requires approved identity match;
- mismatched-debug fixtures fail closed;
- missing-companion state is explicit;
- provider outputs are paged/budgeted for large inputs;
- symbols/types/lines retain debug-source provenance;
- provider/build changes invalidate only dependent debug-derived facts;
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

Central result contract follows Master Architecture:

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

Central solver must not parse architecture mnemonic text or embed target-specific register conventions.

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
- architecture-specific producer quality without architecture leakage into central solver.

## 12.4 Corpus scope

At actual Phase 7 start, freeze machine-readable target/corpus manifest from capability truth produced by completed prerequisite phases.

Do not infer cross-architecture coverage from stale planning baseline. Every architecture admitted to mandatory corpus must have enough prerequisite semantic maturity to exercise same middle-end contracts; unsupported combinations remain explicit rather than silently skipped green.

## 12.5 Exit gate

- start/extent metrics are reported independently;
- stripped fixtures are scored against paired truth where possible;
- mandatory architecture lanes are explicit in corpus manifest;
- no mandatory lane is skipped green because a provider is missing;
- generic discovery contains no decoder/ABI-specific semantics.

---

# 13. P7-I — Living integration and checkpoint protocol

P7-I exists from P7-0. It is not a final cleanup branch.

Exact physical branch/PR topology is chosen by P7-0 repository tooling. Semantic rule is independent of whether component PR targets `main`, integration branch, or another approved staging branch:

> A component is not **accepted** until its exact implementation is represented in P7-I and exact P7-I checkpoint is proven.

## 13.1 Checkpoint acceptance transaction

1. component PR proves owned semantics and negative cases on exact head;
2. changed-file inventory is checked against changed-file and contract ownership;
3. candidate integration incorporates component without unrelated scope;
4. P7-I enters **checkpoint-locked** state;
5. required shared contract/invalidation wiring is completed by integration owner;
6. generated outputs are rebuilt/synchronized **if ownership policy says P7-I owns affected generated output**;
7. canonical Phase 7 runner discovers all new owned tests;
8. rolling product gates run on exact P7-I head;
9. independent Phase 7 verifier runs on same exact head;
10. checkpoint evidence manifest is written;
11. only then does checkpoint unlock for next dependent acceptance.

Independent future work may continue while P7-I is locked, but next dependent component must not be accepted on top of unproven checkpoint.

## 13.2 Checkpoint evidence manifest

Record enough immutable identity to reproduce exactly what was accepted:

```text
checkpoint ID
P7-I exact SHA
merge-base/main SHA used for candidate
component commit/PR identity
changed-file inventory digest
ownership-policy version
corpus/query/truth/scoring manifest ID/digest
verifier ID/version/schema
analyzer/pass/schema versions
required generated-output identity/diff result
workflow/run evidence IDs
performance-budget version
result: accepted | blocking
blocking reason if any
```

Do not record generic "CI green" statement without exact product/verifier/corpus identity.

## 13.3 Moving `main`

One integration/reconciliation lane owns moving-main reconciliation.

Component branches do not repeatedly rebase merely because unrelated `main` moved. Reconcile at defined acceptance/release boundaries and whenever shared semantic contract actually changed.

If reconciliation changes candidate merge tree, exact-head evidence from old tree is obsolete.

## 13.4 Verifier rule

A verifier change that changes acceptance semantics, corpus provenance, query membership, oracle selection, scoring, exact-head binding, or completeness rules invalidates affected older evidence.

Prefer verifier-semantic changes as separately reviewable changes before implementation they will judge. Never repair a failing implementation by weakening verifier in same change.

## 13.5 First-divergence triage

When P7-I fails, diagnose first deterministic semantic divergence before downstream symptoms.

Triage order:

1. product/source identity mismatch;
2. corpus/verifier identity mismatch;
3. changed-file/ownership/generated-output violation;
4. parser/loader/semantic input divergence;
5. MemorySSA/alias first divergence;
6. summary/type/discovery downstream divergence;
7. UI/decompiler projection symptom.

Do not patch downstream decompiler symptom while earlier alias/MSSA divergence remains unexplained.

## 13.6 Source merge vs active runtime

If Phase 7 proof depends on deployed/generated/in-memory runtime rather than repository source alone, source merge is not activation proof. Release evidence must identify active build/runtime identity and prove it contains accepted source. If changed path is source-only and verifier executes directly from exact source tree, no artificial deployment step is required.

---

# 14. Work decomposition

| Checkpoint | Primary ownership | Dependency | Main proof |
|---|---|---|---|
| P7-0 | metrics + status/proof contracts + verifier + negative corpus | exact Phase 6 baseline | baseline + mutation/exact-head proof |
| P7-1 | canonical regions + A1 | P7-0 | zero false strong alias conclusion |
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
- verifier implementation/review against frozen schemas;
- DWARF/PDB fixture preparation while TypeConstraintGraph stabilizes;
- function-discovery corpus preparation while summaries mature;
- profiling/hot-path instrumentation while semantic implementation proceeds;
- independent component work that does not require unproven downstream contract.

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

1. profile representative slow production fixture before increasing CI/job fanout;
2. keep A0/A1/A2 current-function work demand-driven and bounded;
3. compute summaries demand-first and expand along required call dependencies;
4. persist/version reusable artifacts where existing artifact architecture permits;
5. solve only relevant SCCs for active requests unless explicit background/indexing work requests broader coverage;
6. reserve A4/context sensitivity for targeted questions;
7. page/bound debug reads and indexes;
8. prefer compact IDs/sets/intervals over duplicated object graphs;
9. publish `partial`/`bounded` or no result when budgets stop analysis;
10. never change conservative semantic answer solely to meet latency target.

P7-0 captures baseline measurements and creates machine-readable regression budgets. A later budget change requires recorded measurement/rationale; "explained and accepted" prose alone is not merge gate.

At minimum measure:

- cold current-function analysis;
- warm current-function analysis;
- caller/callee summary expansion;
- recursive SCC fixture;
- pathological pointer-phi fixture;
- large debug lookup;
- stripped large-binary function discovery;
- peak working set/artifact footprint where measurable.

Performance measurement procedure itself is versioned: fixture identity, warm/cold definition, repetition count, aggregation statistic, environment class, and tolerated variance are fixed in P7-0 rather than chosen after candidate results are visible.

---

# 17. Truth, corpus, and metric contract

The Phase 7 master exit gate is quantitative. Measurement is part of correctness, not reporting decoration.

## 17.1 Corpus manifest

Every scored run binds to a manifest containing at least:

```text
manifest version/digest
fixture IDs and immutable content/build hashes
source fixture revision where applicable
compiler/toolchain identity + flags
architecture/ABI/format
optimization level
stripped/debug pairing identity
query-set ID/digest
truth-generator ID/version
scoring ID/version
allowed exclusions with reason codes
```

A fixture or query may be excluded only by predeclared rule or explicit versioned manifest change. Changed manifest creates a new comparison series; it must not be presented as direct continuation of old numbers without rerunning baseline under new manifest.

## 17.2 Truth hierarchy

Prefer deterministic truth generated from fixtures designed to make relevant fact knowable.

Examples:

- hand-authored semantic microfixtures with exact expected memory relations;
- compiler-truth fixtures with pinned source/toolchain/flags and explicit addresses/objects where fact survives optimization;
- paired debug/unstripped artifacts used as truth for stripped copy of **same exact build**;
- loader/unwind/compiler tables tied to exact binary identity;
- deterministic repository-owned truth annotations for intentionally ambiguous cases.

Do not treat source-level intent as machine truth when optimization, UB, inlining, tail merging, or ABI lowering can invalidate that interpretation.

External tools are differential diagnostics unless specific repository contract designates a narrow output as oracle. Agreement with one external decompiler is not truth.

## 17.3 Frozen alias query set

Alias precision is scored on frozen set of query pairs, not every pair new analyzer happens to answer.

Each query records:

```text
query ID
snapshot/binary/function scope
location A identity
location B identity
expected relation when exact truth exists
whether exact truth is intentionally unavailable
required proof class if strong result is expected
```

For exact-truth queries:

- false `NoAlias` = analyzer returns `no` when truth is not `no`;
- false `MustAlias` = analyzer returns `must` when truth is not `must`;
- strong-alias soundness gate requires both counts zero on mandatory exact-truth corpus;
- `may`/`unknown` are conservative but less precise and tracked separately.

For precision reporting:

```text
unknown_rate = unknown / all frozen queries
may_rate = may / all frozen queries
strong_proven_rate = (must + no with valid proof) / all frozen queries
```

Do not combine `may` and `unknown` into one success number if analyzer distinguishes them.

A baseline-vs-candidate "unknown reduction" uses exact same query set and denominator.

## 17.4 Memory-link metric

A memory link is scored on frozen load/source questions, not on decompiler text.

For each load query record whether correct reaching definition is:

- exact one definition;
- known set of possible definitions;
- blocked by unknown store/call;
- intentionally unresolved.

Candidate improves precision when it replaces unresolved/broad answer with exact truth **without crossing mandatory barrier**. Forwarding through barrier is soundness failure even if selected value happens to match fixture output.

## 17.5 Summary metric

Function-summary evaluation records per field:

- exact known effect correctly included;
- exact known non-effect correctly excluded only where proof permits;
- unknown effect retained when target/model incomplete;
- completeness status correct;
- recursion convergence result stable;
- dependency identity correct after callee/model mutation.

Do not use one opaque summary score that can hide missing write effect behind accurate register effects.

## 17.6 Type metric

Score type layers separately because one aggregate can hide false certainty:

```text
MachineType exactness
ABIType classification accuracy
RecoveredStructuralType field/layout accuracy
NominalLanguageType exact-match accuracy where exact truth exists
hard-constraint contradiction detection
false-certainty count
```

`false certainty` means selected/certain type conclusion conflicts with exact oracle truth or with an unhandled hard contradiction.

If single aggregate score is required for master "type accuracy improves" gate, weights and eligible entity set are frozen in P7-0. Aggregate cannot override a non-zero mandatory false-certainty regression.

Report debug-assisted and no-debug scores separately so DWARF/PDB does not conceal regression in inference quality.

## 17.7 Function-discovery metric

Function truth represents **starts and owned regions separately**. Region truth may be non-contiguous and may explicitly represent shared/ambiguous ownership.

Start metrics:

```text
start precision = matched predicted starts / predicted starts
start recall = matched truth starts / truth starts
```

Extent metrics operate on truth/predicted region sets after start/candidate matching policy frozen in P7-0. Scoring representation must support multiple ranges and declared shared regions; it must not force every byte to one owner merely to simplify arithmetic.

False split and false merge are counted from candidate-to-truth association, not inferred from single extent score:

- false split: one truth function represented as multiple independent predicted functions without truth justification;
- false merge: multiple truth functions represented as one predicted function without truth justification.

Thunks, aliases, tail-merged blocks, and shared epilogues need explicit truth labels so metric does not punish correct non-simple representation or reward incorrect contiguous one.

## 17.8 Cross-architecture metamorphic tests

For generic middle-end laws, compile or construct semantically equivalent fixtures across mandatory architecture/ABI lanes and assert architecture-independent properties, for example:

- unknown store remains barrier;
- exact disjoint stack intervals yield equivalent `NoAlias` relation/proof class;
- equivalent recursion produces equivalent summary completeness/effect classes;
- type contradiction behavior is independent of register names;
- function-discovery fusion does not require target mnemonic in generic code.

Do not require byte-for-byte identical artifacts across architectures; require equivalent generic semantic conclusions where fixture contract makes them equivalent.

## 17.9 Property/fuzz laws

Where practical, add deterministic seeded property tests for:

- checked interval arithmetic near width boundaries;
- set/join monotonicity;
- widening termination;
- points-to canonicalization/idempotence;
- serialization/deserialization of artifact identities;
- dependency invalidation under one-input mutation;
- cancellation at publication boundaries;
- malformed/truncated debug metadata staying bounded/fail-closed.

A discovered minimal counterexample becomes permanent named regression fixture.

---

# 18. Test pyramid

## L0 — lattice/unit/property laws

- alias symmetry where applicable;
- interval/set join monotonicity;
- widening termination;
- points-to merge determinism;
- summary merge monotonicity;
- contradiction preservation;
- artifact identity/invalidation laws;
- cancellation cannot publish `complete`;
- deterministic seeded boundary properties.

## L1 — synthetic semantic fixtures

Tiny CFG/SSA/MemorySSA fixtures for exact edge cases, including negative barriers.

## L2 — compiler-truth micro corpus

Paired source/build truth, optimization variants, stripped/debug pairs, and relevant C/C++/ObjC/Swift/Rust/Go cases where truth is machine-valid under pinned build.

## L3 — architecture/format capability matrix + metamorphic laws

Use P7-start machine-readable corpus manifest. Missing mandatory capability is blocking, not skip-green.

## L4 — differential/oracle diagnostics

External/reference tooling may diagnose differences where repository policy allows it. External output is not automatically Hex truth.

## L5 — real-binary/pathological performance corpus

Stripped binaries, large functions, recursion, pointer-heavy code, and large debug metadata.

## L6 — verifier mutation/self-test

Run intentionally unsound mutants/test doubles and prove expected verifier/gate failures occur.

## L7 — exact integrated candidate

Run permanent exact-head verifier against actual P7-I candidate with exact corpus/query/truth/scoring manifest identity.

---

# 19. Failure modes to prevent

## FM-1 — Optimistic aliasing

Unknown store/call is ignored because pseudocode becomes cleaner.

**Block with:** negative barriers + positive proof for every strong alias conclusion.

## FM-2 — A3 big-bang solver

One solver invents regions, points-to, escape, call effects, and recursion semantics.

**Block with:** accepted A1/A2/local-summary/escape contracts first.

## FM-3 — Boolean escape

Everything collapses to `escaped=true/false`.

**Block with:** reason + boundary taxonomy.

## FM-4 — Summary cache poisoning

Caller remains precise after callee semantics/options/model change.

**Block with:** exact dependency identity + transitive invalidation.

## FM-5 — Partial result treated as complete

Timed-out/cancelled result is reused as authoritative.

**Block with:** common analysis status + completeness-aware lookup.

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

**Block with:** dependency guardrails + target-provider + metamorphic tests.

## FM-10 — Verifier matures at release

P7-X becomes verifier development.

**Block with:** P7-0 shadow verifier + frozen acceptance semantics.

## FM-11 — Performance hidden by CI parallelism

CI gets faster while product stays pathological.

**Block with:** production profiling and regression budgets.

## FM-12 — Moving-main PR churn

Repeated replacement PRs are created solely because `main` moved.

**Block with:** one reconciliation lane + defined boundaries.

## FM-13 — Atomicity failure

Failed analysis leaves current-looking partial artifact.

**Block with:** validate-then-publish immutable transaction.

## FM-14 — Over-invalidation

Every small project/UI change throws away whole analysis graph.

**Block with:** explicit dependency edges and semantic-input-only invalidation.

## FM-15 — Under-invalidation

Changed callee/model/debug identity leaves stale strong result live.

**Block with:** dependency mismatch is cache miss, never stale fallback.

## FM-16 — Metric gaming

Candidate looks better because difficult queries/fixtures moved out of denominator or scoring changed after results were known.

**Block with:** immutable corpus/query/truth/scoring manifest + baseline rerun on manifest change.

## FM-17 — Source truth mistaken for machine truth

Source-level pointer/type/function assumption is scored as truth even though optimization/ABI lowering changed machine reality.

**Block with:** machine-valid paired truth and explicit ambiguity labels.

## FM-18 — Safety process becomes the bottleneck

Every component reruns every expensive cross-architecture/performance suite despite unchanged exact evidence, or P7-0 attempts to freeze contracts that no current checkpoint consumes.

**Block with:** staged contract freezes, tiered gates, exact-evidence reuse, and checkpoint-level heavy proof described in section 24.

---

# 20. Review checklist for every Phase 7 PR

## Semantics

- What stronger facts can this change now prove?
- What positive proof permits each new `NoAlias`, `MustAlias`, type, or function conclusion?
- Which cases deliberately remain unknown/may/partial?
- Does unknown store/call still invalidate every proof it should?
- Can cancelled/budgeted work ever appear complete?

## Architecture

- Is generic logic free of architecture/ABI/debug-format semantics?
- Is there one canonical identity/root/effect/result schema?
- Are reusable outputs immutable/versioned artifacts rather than hidden mutable caches?
- Does query observe one consistent snapshot/dependency set?
- Is invalidation no broader and no narrower than actual semantic dependencies?

## Evidence and metrics

- Can UI/AI/decompiler explain result through stable evidence IDs?
- Is completeness explicit?
- Is analyzer/schema version explicit?
- Did verifier/corpus/query/truth/scoring semantics change? If yes, was older evidence invalidated and baseline rerun?
- Did this PR add/remove/replace scored fixtures or queries? If yes, is manifest change independently justified?
- Are precision claims using exact same denominator as baseline?

## Performance

- Did asymptotic behavior or hot-path allocation change?
- Was representative production/pathological fixture profiled when this change can affect it?
- Is resource-stop behavior conservative?
- Does exact head stay inside machine-readable regression budgets under frozen procedure?

## Integration

- Is changed-file inventory inside ownership scope?
- Does canonical Phase 7 test discovery include new tests?
- Is accepted component present on P7-I?
- Is P7-I checkpoint evidence exact-head/current?
- If generated output is owned by P7-I for this change, is canonical generated diff zero?
- Did moving-main reconciliation invalidate older evidence?

---

# 21. Decisions to freeze before writing dependent code

Freeze semantic contracts, not internal class/file names, and freeze them **just before their first dependent implementation**, not all at P7-0.

## P7-0 hard freeze

- common analysis status/completeness semantics;
- corpus/query/truth/scoring identity model;
- ownership / P7-I checkpoint evidence contract;
- exact-head verifier identity rules;
- atomic publication + cancellation contract.

## Before P7-1

- canonical region/root identity;
- canonical `AliasResult` minimum contract;
- unknown store/call clobber floor.

## Before P7-2

- points-to lattice/join/widening/provenance-loss rules.

## Before P7-3a/3b/3c

- FunctionSummary effect/completeness contract;
- summary/library-model artifact dependencies;
- escape reason/boundary taxonomy;
- recursive SCC convergence/widening rules.

## Before P7-4

- hard-vs-soft TypeConstraintGraph boundary;
- contradiction semantics;
- user-type provenance/invalidation boundary.

## Before P7-5

- DebugInfoProvider identity verdict/application policy.

## Before P7-6

- FunctionCandidate start-vs-extent evidence model;
- function-discovery matching/shared-region scoring policy.

## P7-X only

- final Phase 8 handoff version/cutover evidence.

A decision that only affects private file/class names, formatting, or non-semantic internal organization does not need an ADR or phase-wide freeze.

---

# 22. Phase 8 handoff contract

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

This permits SCCP/GVN/DCE/load-store forwarding/aggregate recovery to improve without coupling decompiler correctness to particular Phase 7 solver implementation.

---

# 23. Readiness and completion checklists

## Before Phase 7 implementation

- [ ] exact Phase 6 integrated baseline re-resolved at P7-0 start;
- [ ] mandatory baseline gates green on that exact head;
- [ ] P7-start machine-readable capability/corpus manifest frozen;
- [ ] query/truth/scoring manifest frozen before candidate results;
- [ ] living P7-I lane defined;
- [ ] changed-file and contract ownership machine-checkable;
- [ ] canonical runner discovers every Phase 7-owned test subtree;
- [ ] negative soundness + unsound-mutant tests exist;
- [ ] baseline alias/type/function/performance metrics captured;
- [ ] permanent exact-head Phase 7 verifier runs in shadow mode;
- [ ] only P7-0 + P7-1 dependency contracts are frozen initially; later contracts wait until their dependency boundary;
- [ ] cancellation/atomic publication semantics tested.

## Phase 7 final completion

- [ ] every required checkpoint accepted into P7-I through checkpoint lock;
- [ ] exact integrated semantic/decompiler/compiler-truth/migration suites green;
- [ ] negative soundness corpus green;
- [ ] unsound-mutant verifier self-tests green;
- [ ] exact-head Phase 7 verifier green on release candidate;
- [ ] comparison uses exact frozen corpus/query/truth/scoring manifest or reruns baseline under new versioned manifest;
- [ ] unknown memory links measurably reduced under frozen metric definition;
- [ ] zero unsound strong alias regression in mandatory exact-truth corpus;
- [ ] type accuracy improved without increased false certainty in any mandatory hard-truth layer;
- [ ] debug-assisted and no-debug type results reported separately;
- [ ] DWARF and PDB both use identity-bound common provider path;
- [ ] function discovery reports independent start/extent/false-split/false-merge metrics across mandatory P7 lanes;
- [ ] production/pathological performance inside current approved budgets;
- [ ] no mandatory whole-program solve on file open/current-function path;
- [ ] release evidence identifies active runtime/build when activation matters;
- [ ] Phase 8 consumers use only public handoff contract.

---

# 24. Fast-and-safe execution policy

The objective is not maximum ceremony. It is the shortest path that preserves semantic soundness and exact evidence.

## 24.1 Absolute stop-the-line conditions

These block acceptance immediately and outrank schedule pressure:

- any false `NoAlias` or false `MustAlias` on mandatory exact-truth corpus;
- unknown store/call barrier bypass;
- stale artifact accepted after dependency mismatch;
- cancelled/partial result presented as complete;
- verifier mutation/self-test that unexpectedly passes;
- debug identity mismatch applying authoritative facts;
- non-terminating or nondeterministic mandatory fixed-point case;
- architecture-specific semantic logic entering generic solver boundary;
- candidate/verifier/corpus identity mismatch;
- changed-file/contract ownership violation;
- exact product evidence belonging to an older head/merge tree.

When one occurs, stop dependent acceptance, isolate the minimal counterexample, fix the first divergence, add/strengthen permanent regression, and rerun the narrowest gate that proves the fix before re-entering P7-I.

## 24.2 Important but not automatic stop-the-line conditions

These are blocking only when they violate an already frozen contract/budget:

- precision improvement smaller than hoped at an intermediate infrastructure checkpoint;
- formatting/naming preference;
- private class/file layout disagreement;
- optional corpus expansion;
- performance movement inside approved noise/budget;
- a future-checkpoint contract not yet consumed by current work.

Do not stall P7-1 because PDB field naming is undecided. Do not stall P7-3 because final function-discovery matching policy is still unneeded.

## 24.3 Two-tier gate model

### Component exact-head gate — fast, mandatory

Run on every component head:

- owned unit/lattice/property tests;
- relevant negative soundness cases;
- migration/dependency/ownership guardrails touched by diff;
- targeted semantic/compiler-truth microfixtures for affected architecture lanes;
- deterministic cache/invalidation/cancellation regressions when relevant;
- focused performance smoke if hot path changed.

A component head does **not** need to rerun every expensive real-binary/debug/performance matrix merely because it changed one local lattice rule, unless ownership policy or change impact requires it.

### P7-I checkpoint gate — heavy, mandatory before dependent acceptance

Run after integrating an accepted component:

- full canonical Phase 7 runner;
- mandatory cross-architecture truth matrix;
- complete negative corpus;
- verifier mutation/self-test;
- exact-head independent verifier;
- current required semantic/decompiler/compiler-truth/migration suites;
- changed performance/pathological lanes under frozen procedure;
- generated-output sync where applicable.

This preserves full product proof without duplicating the most expensive work on every pre-integration component commit.

## 24.4 Exact evidence reuse

A green result may be reused only when all evidence identity is unchanged:

```text
exact product SHA/merge tree
verifier version/schema
corpus/query/truth/scoring manifest
relevant analyzer/toolchain identity
environment class when the gate depends on it
```

If those are identical, do not rerun solely for ceremony. If any load-bearing identity changes, rerun the affected gate. Never reuse "same branch" or "same PR" as evidence identity.

## 24.5 Critical path vs parallel preparation

Critical acceptance path:

```text
P7-0 → P7-1 → P7-2 → P7-3a → P7-3b → P7-3c → P7-4 → P7-5 → P7-6 → P7-X
```

Safe parallel preparation that should happen early:

```text
P7-0 corpus/verifier infrastructure ──────────────┐
DWARF/PDB fixture research ──────────────────────┤ ready before P7-5
function-discovery truth corpus ─────────────────┤ ready before P7-6
performance/pathological fixtures ───────────────┤ reused throughout
architecture metamorphic fixtures ───────────────┘
```

Preparation may run ahead. Semantic acceptance may not skip dependencies.

## 24.6 PR shaping for fast review and bisectability

Prefer one semantic obligation per PR/checkpoint:

- contract/schema + tests;
- implementation;
- integration wiring if separately owned.

Avoid drive-by refactors, broad renames, unrelated generated changes, or verifier rewrites in implementation PRs.

A reviewer should be able to answer in minutes:

1. what stronger fact is added;
2. what new proof permits it;
3. what minimal counterexample would fail if it were unsound;
4. what artifacts are invalidated;
5. what exact gate proves the change.

If that cannot be answered, the PR is probably too broad.

## 24.7 Failure recovery priority

Use this order to minimize wasted debugging:

```text
soundness / false certainty
  ↓
identity / stale artifact / invalidation
  ↓
integration / ownership / exact-head mismatch
  ↓
termination / determinism
  ↓
precision regression
  ↓
performance regression
  ↓
presentation/readability
```

Do not spend time polishing output produced by an untrusted semantic path.

## 24.8 Minimal rollback boundary

Keep each accepted checkpoint independently identifiable and bisectable. If a later checkpoint breaks soundness, revert/disable the smallest new semantic refinement while retaining earlier proven contracts when repository architecture permits it.

Do not delete the conservative compatibility floor until replacement behavior has exact differential proof and required cutover evidence.

## 24.9 Final operational rule

For speed, prefer:

```text
small contract
+ minimal implementation
+ minimal counterexample
+ focused exact-head gate
+ immediate P7-I integration
+ one heavy checkpoint proof
```

over:

```text
large feature branch
+ broad refactor
+ late verifier
+ late corpus
+ late integration
+ repeated full-matrix reruns on every commit
```

The fastest safe Phase 7 is the one where unsoundness is caught on the smallest fixture, stale state is impossible to reuse silently, and every dependent checkpoint starts from a previously proven exact integration head.
