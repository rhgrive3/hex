# Phase 12 — Safety + Speed Hardening Review

Status: **reviewed planning amendment / execution contract**  
Phase: **12 — Knowledge, collaboration, advanced rewrite**  
Companions: [`PHASE12_KNOWLEDGE_COLLAB_REWRITE_PLAYBOOK.md`](./PHASE12_KNOWLEDGE_COLLAB_REWRITE_PLAYBOOK.md), [`PHASE12_FAST_SAFE_REVIEW.md`](./PHASE12_FAST_SAFE_REVIEW.md)  
Normative authority: [`HEX_MASTER_ARCHITECTURE.md`](./HEX_MASTER_ARCHITECTURE.md), [`ENGINEERING_PROCESS_GUARDRAILS.md`](./ENGINEERING_PROCESS_GUARDRAILS.md), [`MIGRATION_GUARDRAILS.md`](./MIGRATION_GUARDRAILS.md)

> This document is the second hardening pass over the Phase 12 planning set. Where it changes the execution order, baseline interpretation, barrier scope, verifier cadence, or failure-handling rules in the earlier Phase 12 planning documents, **this document wins within the Phase 12 planning set**. It never overrides the Master Architecture, accepted ADRs, Engineering Process Guardrails, Migration Guardrails, current source/tests, or the machine-readable support truth.

---

# 0. Review-time truth correction

The earlier Phase 12 planning documents label `4e03ea8a8b3be36e61f91ac4aa6657fd95f382b9` as `main`.

That wording is no longer safe. It is a **planning/integration snapshot**, not a permanent statement of live-main identity.

At this hardening review, live `main` was observed at:

```text
8c88846488efbecb593ef707e55d36d306c84afc
```

This observed SHA is itself not a future implementation baseline. Phase 12 MUST resolve live `main` again at P12.0.

The current Master Architecture v1.1 also makes the source-of-truth order explicit:

```text
Master Architecture + incorporated normative body
  > accepted later ADRs
  > versioned public contracts
  > current source/tests for present behavior
  > machine-readable capability truth / SUPPORT_MATRIX
  > SOURCES
  > historical checkpoints/plans
```

Therefore:

- this Phase 12 plan MUST NOT be used as present-capability truth;
- P12.0 MUST read live source/tests plus `js/platform/capability-maturity.js`;
- `docs/SUPPORT_MATRIX.md` is a human projection, not an independent authority;
- a parser/module/path existing in source does not by itself prove support;
- all current-source observations in the earlier Phase 12 playbook are migration hints until revalidated.

This removes a high-cost failure mode: beginning a long phase from a stale implementation model.

---

# 1. Hardening objective

The condition for accepting any change to the Phase 12 plan is:

```text
safety does not decrease
AND
expected rework decreases
AND
avoidable serial dependency decreases
AND
failure isolation improves
AND
release proof remains exact-head and fail-closed
```

The result of this review is not “more gates everywhere.” Excessive global gates reduce throughput and encourage bypasses.

The safer/faster design is:

- few global invariants;
- strict lane-local ownership;
- low-risk work starts early;
- risky authority is promoted in stages;
- failures quarantine the smallest affected scope;
- deterministic negative oracles run constantly;
- expensive full-product proof runs at defined checkpoints and final cutover;
- no green result is reused after its identity inputs change.

---

# 2. Revised critical path

The previous Phase 12 plan serialized all major implementation lanes behind the first knowledge-package vertical slice.

That is safer than a free-for-all, but more serial than necessary.

Collaboration replay, the local pattern parser/evaluator core, and the current-PatchSet-to-RebuildPlan path do not fundamentally depend on the common package envelope.

The revised execution graph is:

```text
live Phase 11 product
        ↓
P12.0 — live truth + ownership + test discovery + permanent verifier shell
        ↓
FOUNDATION BARRIER
        ↓
        ├───────────────────────────────────────────────────────┐
        │                                                       │
        ↓                                                       ↓
K0 package/provenance contract                           C0 local ChangeLog kernel
        ↓                                                       │
K1 v2 compatibility + staged recognition                       │
        │                                                       │
        ├───────────────────┐                                   │
        │                   │                                   │
        ↓                   ↓                                   │
K2 capability-rule      P1 packaged patterns                    │
packages/rules          distribution adapter                    │
                                                                │
P0 local pattern parser/evaluator ──────────────────────────────┤
                                                                │
R0 PatchSet -> RebuildPlan shadow/compat path ──────────────────┤
                                                                │
        └─────────────────── living integration ────────────────┘
                                      ↓
                         staged authority promotion
                                      ↓
                     exact-head + production iPad proof
```

## 2.1 What P12.0 globally blocks

Only work that cannot be made safe without these facts:

- exact live baseline;
- current public compatibility seams;
- stable binary/project/entity identity contracts;
- path ownership;
- canonical test discovery;
- permanent exact-SHA verifier invocation path;
- release-evidence schema;
- current support truth.

## 2.2 What K1 blocks

Only package-dependent consumers:

- packaged capability rules;
- packaged pattern distribution;
- package registry/import UX;
- durable package-derived recognition results.

It MUST NOT block:

- local ProjectOperation/ChangeLog replay;
- conflict-engine fixtures;
- local declarative pattern parsing/evaluation;
- RebuildPlan modeling;
- current PatchSet compatibility shadowing;
- negative fixture construction;
- independent review.

This is the main execution-speed improvement from the second review.

---

# 3. Replace “freeze everything” with compatibility locks

A hard freeze is safe only when the frozen contract is already correct. Freezing too early turns a small correction into a migration campaign.

Phase 12 uses **compatibility locks**, not unconditional immutability.

After a shared checkpoint:

```text
allowed without phase-wide reset:
  additive optional fields
  new enum values only where unknown values are already safely handled
  new payload kinds behind capability negotiation
  performance-only internal changes with identical contract output

requires migration + affected re-verification:
  interpretation-changing field semantics
  identity/hash input changes
  authority/promotion rule changes
  evidence completeness changes
  verifier acceptance changes
  conflict-resolution semantic changes

forbidden as an in-place edit:
  silently reinterpreting existing persisted values
  silently weakening identity/precondition checks
  silently treating unknown as supported/verified
```

A compatibility-lock violation is not repaired by editing consumers until they agree. The owning contract is version-bumped or migrated deliberately.

This keeps downstream lanes moving while preserving reproducibility.

---

# 4. Definition of Ready — prevent coding into unresolved contracts

A Phase 12 implementation task is READY only when all applicable fields are known:

```text
owner
allowed changed-file inventory
input contract/version
output contract/version
identity binding
resource-budget source
cancellation model
minimal positive fixture
minimal negative/counterexample fixture
focused test command
integration adapter owner
expected compatibility behavior
unsupported/partial behavior
```

If one of these is missing but implementation can proceed safely behind a private adapter, the task MAY continue locally.

If identity, mutation authority, persistence semantics, or public contract ownership is unresolved, the task remains design/audit work and MUST NOT create a competing public implementation.

This avoids a common speed loss: workers discovering fundamental contract questions halfway through coding.

---

# 5. Staged authority promotion

High-risk Phase 12 features MUST move through explicit authority levels.

```text
L0 parse/compute only
L1 shadow result, no canonical mutation
L2 user-visible suggestion / evidence
L3 explicit proposal requiring owning approval policy
L4 bounded canonical local mutation
L5 export / remote propagation / externally durable effect
```

A lane may implement later-level code early, but it cannot claim or expose that authority until the prior gates are green.

## 5.1 Knowledge

```text
package parse/index
 -> shadow match
 -> visible KnowledgeSuggestion
 -> explicit application policy
 -> ProjectStore fact
```

Fuzzy recognition begins at suggestion authority. It does not jump directly to canonical rename/type mutation.

## 5.2 Capability rules

```text
rule compile
 -> shadow deterministic fact
 -> visible CapabilityFact
 -> AI/search consumption
```

Capability facts do not gain mutation authority merely because confidence is high.

## 5.3 Collaboration

```text
operation parse
 -> shadow replay into disposable state
 -> compare with canonical state
 -> local canonical apply
 -> checkpoint/merge
 -> transport propagation
```

Hosted/live transport is strictly later than deterministic local replay correctness.

## 5.4 Patterns

```text
parse/type-check
 -> bounded shadow evaluation
 -> lazy typed-data view
 -> evidence/type hints
```

Pattern language v1 remains read-only with respect to canonical binary/project mutation.

## 5.5 Rebuild

```text
plan
 -> validate plan
 -> shadow materialize
 -> reparse/validate output
 -> explicit publication/export
```

Materialization and publication are separate authority boundaries.

Staged promotion lets most engineering happen in parallel without exposing unfinished authority to users.

---

# 6. Global blocker vs lane quarantine

The earlier review used broad stop-the-line language. That is correct for shared-truth corruption but too expensive for isolated defects.

Use two scopes.

## 6.1 Phase-global blockers

Stop affected integration acceptance across Phase 12 when any of these occurs:

- shared identity can resolve the wrong binary/project/entity;
- package content identity is nondeterministic or interpretation-ambiguous;
- exact-SHA verifier can report green for the wrong head/product;
- ProjectStore/ArtifactStore truth separation is violated;
- a shared contract silently changes persisted interpretation;
- canonical mutation can occur without its required approval/precondition;
- generated/release evidence can be published from a failed producer;
- migration guardrails must be weakened merely to make new work pass;
- a component contaminates paths owned by another lane;
- a shared verifier change invalidates prior acceptance evidence and is not re-run.

## 6.2 Lane-local blockers

Quarantine only the affected lane when possible:

- one capability rule false-positive;
- one pattern construct violates a resource bound;
- one format-specific rebuild operation fails validation;
- one collaboration fact-family conflict policy is incomplete;
- one package provider is incompatible;
- one performance fixture exceeds its lane budget.

The quarantined lane MUST NOT merge/promote the affected capability, but unrelated lanes may continue if their shared inputs remain valid.

This prevents one experimental format/rewrite feature from stopping safe progress in knowledge or collaboration.

---

# 7. Failure recovery protocol

When a gate fails:

```text
1. record exact failing head/input/version
2. identify the first deterministic divergence
3. quarantine the smallest owning scope
4. reduce to a permanent minimal counterexample
5. repair the owning layer, not downstream symptoms
6. run the focused negative oracle
7. run affected compatibility/migration gate
8. reintegrate through the living integration lane
9. invalidate any evidence whose identity inputs changed
```

Do not stack speculative fixes across multiple layers.

If the same failure class recurs after a repair, the repair is incomplete until a permanent regression or machine-enforced policy prevents the old behavior.

Do not create replacement PR generations solely because `main` moved. The living integration owner performs controlled reconciliation.

---

# 8. Package identity hardening

The package envelope is a critical shared contract and needs stronger requirements than “has a hash.”

## 8.1 Deterministic content identity

Choose one deterministic canonical encoding and test it.

`contentHash` MUST cover every byte/field whose change can alter interpretation or matching/rule/pattern behavior.

It MUST NOT depend on local installation state such as:

- filesystem path;
- download URL;
- installation timestamp;
- UI display ordering;
- local cache location.

Two semantically identical package payloads serialized through the canonical path must derive the same content identity.

Any interpretation-affecting byte change must derive a different content identity.

## 8.2 Dependency pinning

Package dependencies MUST resolve to exact content identities before deterministic analysis begins.

Version ranges may be accepted as an installation-time request, but release/verification evidence records the resolved exact dependency set.

Dependency cycles are rejected or reported explicitly before payload execution/indexing.

No rule/pattern evaluation may fetch an unpinned dependency dynamically in the middle of analysis.

## 8.3 Import before parse

Large/untrusted package input is bounded **before** expensive materialization.

At minimum validate/bound:

- raw input bytes;
- manifest bytes;
- nesting depth;
- string lengths;
- entry count;
- per-entry payload size;
- aggregate declared payload size;
- duplicate entry IDs;
- dependency count/depth;
- decompression expansion where compression exists.

A “1,000,000 entries allowed” check after one giant JSON parse is not sufficient protection on iPad.

Prefer streaming/indexed payload formats for large corpora rather than requiring a single giant object graph.

## 8.4 Artifact identity

Derived package artifacts key at least on:

```text
package content identity
payload schema version
matching/rule/pattern engine semantic version
relevant target/ABI semantic version
options affecting interpretation
```

Changing any of these invalidates affected derived results automatically.

---

# 9. Recognition hardening

Recognition acceptance needs explicit completeness, not only score.

Canonical acceptance dimensions:

```text
match tier
feature evidence
conflicting evidence
score/confidence
best-vs-next ambiguity margin
candidate-search completeness
candidate-search truncation
package content identity
algorithm semantic version
target compatibility
```

Rules:

- `truncated === true` forbids a “unique confirmed best match” claim;
- high confidence does not override a close second candidate;
- exact identity and semantic similarity have different promotion policy;
- a package mismatch in architecture/ABI/platform is not repaired by a high score;
- negative/rejected prior knowledge is versioned evidence, not a hidden filter;
- cross-version reidentification creates a new local entity mapping rather than reusing a foreign local ID.

## 9.1 Fast path

Candidate search should short-circuit on strong selective indexes and only escalate expensive semantic features for bounded candidates.

Measure candidate set size at every tier. If a tier does not reduce the set materially on the benchmark corpus, remove it from the hot path or move it later.

This treats algorithmic complexity as the first optimization target, not CI sharding.

---

# 10. Capability-rule hardening

Rules are deterministic analysis plugins/data, not hidden scripting.

## 10.1 Compiled rule identity

A compiled rule artifact binds to:

```text
rule package content hash
rule ID/version
feature API semantic version
required upstream artifact semantic versions
compile options
```

## 10.2 Dependency graph

Rule dependencies are a DAG or produce an explicit cycle error.

The evaluator MUST bound:

- dependency depth;
- feature query count;
- result fan-out;
- evaluated entity count;
- retained evidence volume;
- CPU/work budget through ResourceBudgetManager.

## 10.3 Determinism

Evaluation order, worker scheduling order, and map/set iteration order must not change the semantic result.

Any ranking/tie-break is deterministic and test-covered.

`partial` upstream analysis propagates as partial/unknown unless the rule has a proof that its conclusion is valid despite the missing dimension.

---

# 11. Collaboration hardening

## 11.1 Wall clock is not authority

Operation timestamps are useful provenance but cannot be the sole ordering/conflict authority.

Network clocks drift and can be adversarial.

Use causal/dependency information plus a deterministic stable tie-break for otherwise concurrent operations.

## 11.2 Stable operation identity

Every operation has a collision-resistant stable identity.

Duplicate delivery must be idempotent even after:

- reconnect/replay;
- checkpoint restore;
- compaction;
- reordered batching.

## 11.3 Preconditions by mutation class

Not every operation needs the same precondition.

Suggested minimum:

```text
additive note/bookmark:
  project/entity identity + operation identity

name/type/struct/confirmation resolution:
  project/entity identity + expected target/fact version or fingerprint

patch/rewrite-related fact:
  binary identity + expected original state + operation identity
```

A stale meaningful mutation becomes conflict/unresolved, not silent overwrite.

## 11.4 Atomic project application

A batch either:

- validates and applies atomically; or
- leaves canonical project state unchanged and reports rejected/unresolved operations.

Partial application of a malformed batch is forbidden.

## 11.5 Tombstones and compaction

Removal semantics must survive replay and compaction.

A checkpoint cannot discard a tombstone/conflict record if doing so would allow an old operation to resurrect deleted state later.

Unresolved conflicts remain audit-visible across checkpointing.

## 11.6 Dual-path migration

During migration, shadow-replay the new ChangeLog into disposable state and compare against the current ProjectStore projection.

Do not maintain two independent canonical write paths indefinitely.

At cutover, one path becomes canonical and the compatibility path becomes a projection/oracle until retirement criteria are met.

---

# 12. Pattern-language hardening

## 12.1 Source snapshot identity

Pattern evaluation binds to an immutable ByteSource/BinaryImage snapshot identity.

A result cannot combine reads from two different binary revisions or mutable source states.

The compiled artifact key includes:

```text
pattern source hash
language semantic version
compiler version
relevant target/address-space contract
compile options
```

## 12.2 Checked integer arithmetic

All offset/size/count arithmetic is checked before conversion/allocation.

Do not rely on JavaScript `Number` when precision can affect source addressing.

Multiplication such as `count * elementSize` is checked before allocation/read scheduling.

## 12.3 Parse budget before evaluate budget

Hostile pattern text itself can be a resource attack.

Bound:

- source text bytes;
- token count;
- AST node count;
- nesting depth;
- identifier/string lengths;
- module/import count.

Then separately enforce runtime read/materialization budgets.

## 12.4 Lazy cycle model

Recursive types and pointer cycles resolve to stable lazy handles.

The evaluator never expands a graph merely because the UI opened its parent node.

A resource-limited result returns explicit partial/resource-limit state rather than pretending the field is absent.

## 12.5 No ambient authority

Pattern code receives only explicit bounded capabilities.

It has no ambient:

- DOM;
- network;
- project mutation;
- runtime debugger control;
- filesystem;
- arbitrary JS/eval;
- unrestricted binary object.

---

# 13. Rebuild hardening

Current support truth marks validated rebuild/patch support as unsupported at the format-maturity level. Phase 12 therefore must promote only specifically proven operations, not claim a whole format because one export worked.

## 13.1 Capability matrix, not boolean “rebuild supported”

Track support per:

```text
format
operation type
architecture where relevant
layout-moving vs same-size
relocation class
unwind/exception impact
signature/checksum consequence
validator coverage
```

Unsupported combinations fail closed.

## 13.2 Rebuild impact declaration

Every plan declares what it may affect:

```text
source byte ranges
sections/segments
virtual-address layout
relocations
imports/exports
branch ranges
unwind/exception metadata
checksums/signatures
loader metadata
```

Validators are selected from this impact set.

This allows focused validation to be fast without skipping mandatory checks.

## 13.3 Mandatory global floor + impacted deep validation

Every materialized output must at least:

- match the expected source identity/preconditions;
- complete structural materialization;
- re-open through the owning Hex loader;
- preserve unchanged regions promised by the plan;
- report signature/checksum consequences;
- report unresolved validation dimensions.

Then run deeper decode/CFG/relocation/unwind/semantic validation for impacted areas.

The final release verifier uses the full corpus/profile required by the declared capability.

## 13.4 Atomic publication

Never write directly to the publishable result path.

```text
temporary materialization
 -> validate expected identity
 -> validate structure/impact
 -> validate evidence schema
 -> atomically promote to publishable output
```

A failed/cancelled producer cannot leave a zero-byte or partial artifact that later stages mistake for evidence.

## 13.5 Same-size compatibility remains the first oracle

R0 remains:

```text
current PatchSet input
 -> RebuildPlan
 -> shadow materialization
 -> byte-for-byte comparison with current PatchSet result
 -> owning-loader reparse
 -> validation evidence
```

The old tested path remains a differential oracle until the replacement exit contract is satisfied.

Only then promote address-moving operations.

---

# 14. Resource-budget unification

Phase 12 MUST NOT create four independent sets of arbitrary limits.

Knowledge indexing, capability rules, ChangeLog replay, pattern evaluation, and rebuild planning/materialization should request budget from the shared resource-budget architecture where available.

Each task declares at least:

```text
estimated/maximum read bytes
resident memory class
CPU/work class
output/evidence bound
priority
cancellable safe points
```

If the live Phase 12 baseline lacks a suitable common budget API, P12.0 records that gap explicitly and uses one narrow Phase 12 budget adapter rather than each lane inventing its own service.

Correctness under resource pressure is:

```text
partial / deferred / resource-limit / cancelled
```

never an unsound shortcut.

---

# 15. Verifier tiering — faster without weakening release proof

Running the full release corpus after every keystroke wastes CI; running only lane tests until final release is unsafe.

Use three verifier tiers.

## V0 — constant local/PR negative oracles

Run on every relevant change:

- ownership/changed-file scope;
- schema/identity invariants;
- minimal counterexamples;
- migration guardrails for touched seams;
- deterministic replay/hash tests;
- focused resource-limit/cancellation tests.

## V1 — living-integration shadow verification

After each accepted component integration:

- exact integration SHA;
- affected subsystem aggregate;
- deterministic stratified corpus slice or impacted corpus;
- shared-boundary regressions;
- generated-output checks if applicable;
- independent verifier evidence.

V1 is acceptance evidence for the rolling integration checkpoint, **not final release proof**.

## V2 — full checkpoint/release verifier

At compatibility-lock checkpoints, authority promotion, and final cutover:

- exact candidate SHA;
- complete required Phase 12 release corpus;
- current general/migration/security/project/plugin/binary gates;
- required iOS/iPadOS/WebKit proof;
- current package/rule/pattern/rebuild content identities;
- generated output synchronized where applicable;
- release evidence atomically published.

A change to verifier acceptance semantics, corpus provenance, identity binding, or evidence completeness invalidates affected older V1/V2 evidence.

---

# 16. CI impact map

P12.0 should define a machine-readable impact map rather than relying on operator memory.

Conceptual classes:

```text
CONTRACT
IDENTITY
PERSISTENCE
KNOWLEDGE
RULES
COLLAB
PATTERN
REBUILD_GENERIC
REBUILD_MACHO
REBUILD_ELF
REBUILD_PE
PLUGIN_PERMISSION
AI_QUERY_SURFACE
UI_ONLY
GENERATED_OUTPUT
```

Each changed file maps to:

- owner;
- required V0 suites;
- required V1 suites;
- whether V2 is required before merge/promotion;
- generated-output ownership;
- target-platform proof requirement.

Do not duplicate the same expensive suite across many GitHub jobs merely because several labels match. Deduplicate test execution after impact resolution.

Prefer runner-local/process parallelism before multiplying job fan-out.

---

# 17. Worker topology

Use six slots dynamically rather than fixing four editors forever.

## Foundation / shared-contract period

```text
Worker 1  package/recognition implementation
Worker 2  collaboration local-replay implementation
Worker 3  pattern core implementation
Worker 4  flex: rebuild R0 OR fixture/perf audit OR current blocker
Worker 5  real-time independent reviewer; read-only by default
Worker 6  integration/reconciliation/ownership/verifier
```

## Rules/package expansion period

Worker 1 may move from package substrate to capability-rule work after the package compatibility lock.

## Flex-worker rule

Worker 4 is the all-purpose capacity reserve.

It may take Rebuild work when that lane is ready, but it must not simultaneously edit another worker’s owned files.

If a lane blocks on an external/shared contract, Worker 4 moves to:

- minimal counterexample construction;
- performance profiling;
- migration adapter work owned by integration;
- corpus preparation;
- another independent lane.

Do not leave a worker spinning on a blocked dependency.

## Reviewer rule

Worker 5 does not “help finish” implementation by editing the same files it is reviewing unless explicitly reassigned after its review evidence is recorded.

This preserves independence.

---

# 18. PR sizing — avoid both giant PRs and micro-PR churn

The earlier Phase 12 review correctly rejects giant cross-trust-boundary PRs.

The second review adds the opposite rule: do not create a new PR for every tiny adapter/test adjustment.

Preferred unit:

```text
one primary trust boundary
+ its compatibility adapter
+ its minimal counterexamples
+ its focused integration wiring when owned by the same lane
```

Create a separate PR when:

- ownership changes;
- a different shared contract is modified;
- mutation authority changes;
- independent rollback is valuable;
- review expertise differs materially.

Do not create validation-only PRs to trigger workflows. Use permanent exact-SHA/manual verification paths.

This reduces merge/rebase churn while keeping review scope clear.

---

# 19. Integration adapter rule

Component lanes should not race on central facades/public registries.

When several lanes need public exposure:

```text
lane owns private/stable contribution contract
integration owner owns central registration/facade wiring
```

If the public facade supports additive isolated registration safely, a lane may own its narrow registration file as declared in the manifest.

Do not let every component edit one giant `index.js` or registry file concurrently.

This converts predictable merge conflicts into deterministic integration work.

---

# 20. Exact evidence schema

Every Phase 12 verifier artifact must carry enough identity to reject stale reuse.

At minimum:

```text
product commit SHA
merge/candidate identity when relevant
verifier version/content identity
input fixture/corpus identities
package content hashes
rule package hashes
pattern source/package hashes
rebuild plan/source hashes where applicable
semantic/API versions affecting interpretation
configuration/options hash
target platform/runtime identity where required
result state
failure/unknown dimensions
```

Timestamps are provenance only. They are never identity proof.

CI evidence producers write temporary outputs, validate them, and publish atomically. Aggregators validate schema and expected IDs before accepting any artifact.

---

# 21. Minimal counterexample set — expanded

The previous 15 fixtures remain required. Add these because they close newly identified high-cost gaps:

16. **Baseline drift:** planning SHA differs from live main; P12.0 records live truth and refuses stale exact-head evidence.
17. **Package canonicalization:** semantically identical canonical package input hashes identically; interpretation-affecting change hashes differently.
18. **Package pre-parse bomb:** oversized/deep input is rejected before giant object materialization.
19. **Package dependency cycle:** cycle is explicit and no evaluator starts.
20. **Rule scheduling determinism:** worker/evaluation order changes but semantic output does not.
21. **Clock skew conflict:** collaboration timestamps disagree wildly; semantic merge does not silently choose wall-clock winner.
22. **Tombstone resurrection:** old replay after checkpoint cannot resurrect removed state.
23. **Atomic batch rejection:** one malformed collaborative operation does not partially mutate canonical state.
24. **Pattern source swap:** source identity changes during/rebetween evaluation; stale result is not accepted for the new source.
25. **Pattern integer overflow:** count/size arithmetic exceeding safe bounds fails before read/allocation.
26. **Rebuild partial artifact:** cancelled/failed materialization cannot be published or aggregated as evidence.
27. **Rebuild impact under-declaration:** operation changes relocation/layout but declares only bytes; validator rejects the plan contract.
28. **Verifier identity mismatch:** green evidence from another SHA/package/rule/pattern identity is rejected.
29. **Ownership contamination:** lane PR touches unowned shared facade; merge-blocking even if tests pass.
30. **Compatibility-lock break:** persisted contract semantics change without version/migration; guard fails.

These fixtures should be cheap, deterministic, and runnable in V0 where technically feasible.

---

# 22. Performance proof before parallelism expansion

Before increasing CI fan-out or adding more analysis workers, profile at least one real/pathological fixture in the affected production algorithm.

Per lane, collect the first useful metrics:

## Knowledge

- candidate counts per tier;
- index build/warm reopen;
- p95 bounded lookup;
- peak memory;
- bytes materialized during import.

## Rules

- entities evaluated;
- feature queries per result;
- cache hit rate;
- worst rule dependency/fan-out;
- cancellation latency.

## Collaboration

- replay operations per mutation/query;
- materialized-state lookup cost;
- checkpoint restore cost;
- conflict set growth;
- duplicate-detection cost.

## Patterns

- bytes read;
- materialized nodes;
- lazy expansion cost;
- peak retained tree size;
- cancellation latency.

## Rebuild

- bytes copied vs source size;
- touched ranges;
- planning latency;
- validator cost by impact class;
- peak memory during materialization.

If a production path is algorithmically pathological, fix it before hiding it behind more runners.

---

# 23. Phase 12 acceptance scoreboard

Maintain one machine-readable or easily machine-checked scoreboard with states:

```text
NOT_STARTED
IN_PROGRESS
SHADOW_GREEN
INTEGRATED
PROMOTION_BLOCKED
RELEASE_PROVEN
```

For each capability record:

- owner;
- exact integration SHA;
- current authority level L0–L5;
- current support claim;
- V0/V1/V2 evidence IDs;
- last compatibility-lock version;
- known partial/unsupported dimensions;
- iPad proof status where required.

Do not infer phase completion from PR merge count.

A capability can be implemented but `PROMOTION_BLOCKED` because its evidence or target-platform proof is incomplete.

---

# 24. Revised entry/exit gates by lane

## K — Knowledge / recognition / rules

Entry:

- live identity/version contracts observed;
- package import compatibility seam known;
- ArtifactStore identity available or adapter defined.

Exit for package substrate:

- canonical content identity deterministic;
- v2 compatibility green;
- malformed/oversized input fail-closed;
- exact + ambiguous + truncated match fixtures green;
- stronger local evidence not overwritten;
- large-pack memory/index behavior bounded;
- exact package/dependency identities in verifier evidence.

Exit for capability rules:

- deterministic compiled rule identity;
- dependency cycles bounded;
- near-miss/partial fixtures green;
- evidence provenance complete;
- no mutation authority from rule fact alone.

## C — Collaboration / ChangeLog

Entry:

- stable project/binary/entity identity observed;
- current ProjectStore compatibility seam known.

Exit:

- duplicate/reorder/checkpoint replay deterministic;
- wall clock not merge authority;
- meaningful conflicts preserved;
- atomic batch semantics green;
- tombstone replay green;
- derived analysis excluded;
- `.hexproj` v1 compatibility preserved;
- local replay/merge proven before remote transport promotion.

## P — Pattern language

Entry:

- ByteSource bounded-read seam and source identity observed.

Exit:

- parser and evaluator independently budgeted;
- checked address/size arithmetic;
- explicit address spaces;
- cycles lazy/bounded;
- source snapshot identity preserved;
- field provenance exact;
- no ambient authority;
- large arrays remain lazy on target browser.

## R — Rebuild

Entry:

- current PatchSet behavior frozen as compatibility oracle;
- loader/source identity/precondition seams observed;
- current format support truth recorded.

Exit per promoted operation:

- impact set explicit;
- source preconditions exact;
- same-size compatibility differential green where applicable;
- output reparses through owning loader;
- unchanged-region invariant green;
- impacted relocation/branch/unwind/import/export validations green;
- signature/checksum consequence explicit;
- failed output cannot publish;
- support claim updated only to the proven operation/profile.

---

# 25. Three-pass review record

This section records the requested second set of three reviews.

## Pass 1 — safety / authority review

### Findings

1. **Baseline wording was unsafe.** `4e03...` was labeled `main`; live main had moved. This can start Phase 12 from stale truth.
2. **The current source-of-truth hierarchy changed.** Master Architecture v1.1 explicitly separates normative archived architecture from moving implementation truth and points current support claims to machine-readable capability truth.
3. **Package hash requirements were underspecified.** A hash without canonical semantic input and dependency pinning does not guarantee reproducibility.
4. **Pre-parse package resource limits were not explicit enough.** Large JSON/object materialization can exhaust iPad memory before entry-count checks fire.
5. **Collaboration wall-clock authority was not explicitly forbidden.** This risks nondeterministic/conflicting merges under clock skew.
6. **Tombstone/checkpoint resurrection was not explicitly covered.** Compaction can reintroduce deleted state if old operations replay.
7. **Pattern evaluation lacked an explicit immutable source-snapshot binding.** Results must not span binary revisions.
8. **Rebuild publication needed an atomic transaction rule.** Failed producers must not leave partial artifacts.
9. **Support promotion needed per-operation granularity.** Current support truth does not justify a whole-format rebuild claim from one successful operation.
10. **Broad phase-wide stop conditions could tempt unnecessary bypasses.** Isolated failures should quarantine their lane, while shared-truth failures remain global blockers.

### Changes made

All ten are now explicit contracts in this document.

### Safety conclusion

The revised plan is stricter at authority boundaries while allowing unrelated safe work to continue.

## Pass 2 — execution-speed / dependency review

### Findings

1. **The original critical path over-serialized C/P/R behind K1.** Collaboration replay, local pattern evaluation, and RebuildPlan shadowing can start after P12.0.
2. **Hard contract freezes can create avoidable migrations.** Compatibility locks preserve downstream progress while permitting additive evolution.
3. **Full release verification on every small component would waste CI.** V0/V1/V2 tiering keeps constant negative coverage and exact release proof without repeating the full corpus unnecessarily.
4. **No explicit Definition of Ready existed.** Workers could discover contract gaps after coding began.
5. **Fixed worker ownership leaves capacity idle when a lane blocks.** One flex worker now performs rebuild or shifts to fixtures/perf/unblock work without violating file ownership.
6. **Very small PRs can become as expensive as giant PRs.** The PR unit is now one trust boundary plus its adapter/tests, not one file/change.
7. **Shared facade edits create predictable merge conflicts.** Integration adapter ownership is now explicit.
8. **Global stop-the-line for lane-local defects wastes unaffected parallelism.** Quarantine scope is now formalized.
9. **CI impact mapping was implicit.** A machine-readable impact map can deduplicate suites and select exact affected gates.
10. **Performance optimization could drift toward runner fan-out.** Production profiling remains mandatory before expanding parallelism.

### Changes made

The critical path, verifier cadence, worker topology, PR sizing, impact map, and failure scope were revised accordingly.

### Speed conclusion

More work can start immediately after P12.0, while high-risk authority still cannot promote early.

## Pass 3 — integration / recovery / release-proof review

### Findings

1. **Evidence reuse rules needed stronger identity binding.** Exact product SHA alone is insufficient when package/rule/pattern inputs change.
2. **Verifier outputs need atomic publication.** A file existing is not evidence that its producer succeeded.
3. **ChangeLog migration can accidentally create dual canonical truth.** Shadow replay then one canonical cutover is required.
4. **Rebuild validators need impact-driven selection plus a mandatory global floor.** Running every deep validator always is slow; running only local checks is unsafe.
5. **No explicit authority scoreboard existed.** “Merged” can be confused with “release proven.”
6. **Moving main must stay with the integration lane.** Component workers should not churn through replacement PRs/rebases.
7. **Compatibility-lock changes must invalidate affected historical evidence.** Otherwise old green runs can falsely prove new semantics.
8. **Lane ownership and generated-output ownership must be machine-checked.** PR descriptions are not evidence of scope.
9. **Target-platform proof remains a separate fact.** Desktop/browser CI cannot substitute for required iOS/iPadOS/WebKit evidence.
10. **Unsupported dimensions need explicit release recording.** Partial capability must not be rounded up at final cutover.

### Changes made

Exact evidence schema, promotion scoreboard, impact-driven validation, migration cutover, and release gates now encode these requirements.

### Integration conclusion

The revised plan makes failure recovery cheaper and stale proof harder to reuse accidentally.

---

# 26. Final execution contract

When Phase 12 begins, the preferred order is now:

```text
1. Resolve live main and current support truth.
2. Freeze only ownership, identity boundaries, test discovery, verifier invocation, and release-evidence schema.
3. Start K0, C0, P0, and R0 concurrently behind low authority.
4. Keep one reviewer and one living-integration owner active from the start.
5. Finish package v2 compatibility + staged recognition; compatibility-lock package identity.
6. Promote packaged rules/pattern distribution only after that package lock.
7. Integrate each lane’s smallest vertical slice immediately.
8. Run V0 continuously and V1 on every accepted integration checkpoint.
9. Quarantine lane-local failures; globally stop only shared-truth/release-proof corruption.
10. Promote authority monotonically: shadow -> suggestion -> proposal -> local mutation -> export/remote.
11. Keep ChangeLog transport and Rebuild publication behind their deterministic local validation gates.
12. Profile production hot paths before adding CI/worker fan-out.
13. Reconcile moving main through the single integration lane.
14. Re-run V2 whenever a compatibility-lock or verifier acceptance identity changes.
15. Final cutover requires exact-head product proof plus required real iPad/WebKit evidence.
16. Record all partial/unsupported dimensions explicitly.
```

The guiding rule is:

> **Parallelize computation and implementation aggressively; serialize only authority, shared identity, and irreversible publication.**

That is the Phase 12 design that maximizes speed without weakening Hex’s correctness or evidence model.
