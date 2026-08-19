# Phase 12 — Knowledge, Collaboration, Advanced Rewrite Implementation Playbook

Status: **planning / preflight guidance**  
Phase: **12 — Knowledge, collaboration, advanced rewrite**  
Planning baseline: **`main` at `4e03ea8a8b3be36e61f91ac4aa6657fd95f382b9` (2026-08-19)**  
Canonical architecture: [`HEX_MASTER_ARCHITECTURE.md`](./HEX_MASTER_ARCHITECTURE.md)  
Engineering process: [`ENGINEERING_PROCESS_GUARDRAILS.md`](./ENGINEERING_PROCESS_GUARDRAILS.md)  
Migration rules: [`MIGRATION_GUARDRAILS.md`](./MIGRATION_GUARDRAILS.md)  
Research index: [`SOURCES.md`](./SOURCES.md)  
Companion review: [`PHASE12_FAST_SAFE_REVIEW.md`](./PHASE12_FAST_SAFE_REVIEW.md)

> This playbook is deliberately implementation-oriented, but it does not override the Master Architecture, later accepted ADRs, or Engineering Process Guardrails. Phase 12 is far enough ahead that every current-source observation in this file MUST be revalidated at P12.0 against the live Phase 11 product. Historical paths are migration hints, not permanent ownership claims.

---

# 0. Executive decision

Phase 12 MUST NOT be implemented as one giant “final platform” project.

The Master Architecture groups five deliverables under Phase 12:

1. scalable signature / knowledge packages;
2. deterministic capability-rule ecosystem;
3. collaboration / change log;
4. generalized relocation-aware rebuilding;
5. declarative data-pattern language.

These are related by identity, provenance, package distribution, persistence, and trust boundaries, but they have very different failure modes. The fastest safe shape is therefore:

```text
live Phase 11 product
      ↓
P12.0  re-observe baseline + freeze exit criteria + permanent verifier
      ↓
P12.1  minimal shared package/provenance contract
      ↓
P12.2  knowledge/signature package vertical slice
      ↓
shared package checkpoint
      ↓
      ├───────────────┬──────────────────┬──────────────────┐
      ↓               ↓                  ↓                  ↓
P12.K capability  P12.C collaboration  P12.P patterns   P12.R rebuild
rules             + ChangeLog          read-only first   plan/validate first
      │               │                  │                  │
      └───────────────┴──────────────────┴──────────────────┘
                              ↓
                    integration + iPad proof
                              ↓
                       exact-head exit gate
```

The key optimization is to serialize only the contracts whose churn would invalidate multiple lanes. Everything else should fan out after one thin end-to-end knowledge-package slice proves the shared substrate.

The key safety rule is equally important:

> **Phase 12 adds reusable knowledge and mutation workflows around Hex’s semantic truth. It does not create a second semantic truth.**

---

# 1. Why Phase 12 is unusually difficult

Phase 12 looks like a collection of “platform polish” features. In practice it crosses four of the highest-risk boundaries in Hex at once:

- external or reusable knowledge can influence names, types, roles, and user decisions;
- collaboration introduces concurrent mutation and conflict semantics;
- binary rebuild changes executable bytes and format metadata;
- a pattern language executes user/provider supplied structure descriptions over hostile binary data.

The hard problem is not implementing parsers or UI panels. It is deciding **what is allowed to become authority**.

A weak implementation can look impressive while violating core Hex invariants:

```text
fuzzy match              -> silently renames function
rule result               -> treated as verified fact without evidence
remote collaborator       -> overwrites local type/name
project merge             -> mixes stale derived cache into current analysis
pattern script            -> gets arbitrary host access
rebuild                   -> writes bytes but leaves relocation/unwind/signature invalid
knowledge package update  -> changes prior answers without visible version/provenance
```

Every one of these is a correctness bug even if the UI remains usable.

---

# 2. Authority and Phase 12 invariants

## P12-INV-001 — Knowledge suggests; stronger local evidence wins

Knowledge packages MAY provide names, prototypes, types, roles, semantic labels, signatures, and known identities.

They MUST NOT silently overwrite stronger binary-local, debug, runtime, deterministic analysis, or user-confirmed evidence.

A package match and application of a user/project fact are separate operations.

## P12-INV-002 — No opaque recognition authority

No function/library identity may be accepted solely because one score crossed a threshold.

Every accepted or suggested match exposes:

- matching tier;
- contributing features;
- conflicting features;
- confidence;
- ambiguity margin / candidate competition;
- algorithm and package version;
- evidence IDs;
- completeness / truncation state.

A truncated candidate search cannot be called unambiguous merely because the visible best score is high.

## P12-INV-003 — Capability rules are deterministic analysis

A `CapabilityFact` is produced by a deterministic rule evaluator over typed Hex facts/evidence.

AI MAY explain or search capability matches. AI MUST NOT mint a verified capability merely from prose or pseudocode.

Every capability match retains constituent evidence IDs down to source semantic entities.

## P12-INV-004 — Collaboration merges user facts, never opaque derived analysis

Collaboration / ChangeLog applies to user/project facts such as names, comments, types, structs, bookmarks, patches, confirmations, rejected hypotheses, pinned evidence, and investigation decisions.

CFG, SSA, MemorySSA, decompiler ASTs, search indexes, fingerprints, and other derived artifacts are reproduced or invalidated through ArtifactStore identity. They are not merged as collaborative truth.

## P12-INV-005 — Conflicts remain conflicts

Competing meaningful names/types/struct definitions/patches MUST NOT be silently reduced to last-writer-wins.

The merge engine must preserve semantic conflict state and enough operation provenance for a human or deterministic policy to resolve it.

## P12-INV-006 — Change replay is identity-bound and idempotent

A collaborative operation must bind to the correct project/binary/entity identity and have a stable operation ID.

Duplicate delivery MUST NOT duplicate the effect.

Operations targeting the wrong binary/build/entity state fail closed or enter explicit unresolved/conflict state.

## P12-INV-007 — Rebuild is a plan, not a byte-write shortcut

Generalized rewriting is:

```text
Original Binary
  -> PatchSet
  -> Patched Projection
  -> Rebuild Plan
  -> Format-specific realization
  -> Validation
  -> Export
```

A byte write that succeeds is not proof that the rebuilt executable is valid.

## P12-INV-008 — Original-state preconditions are mandatory

Every mutation or rebuild operation that depends on existing bytes/metadata carries an expected-original fingerprint/precondition.

An old patch/rebuild plan MUST NOT apply silently to another binary revision.

## P12-INV-009 — Pattern definitions are untrusted data

The pattern language MUST NOT expose arbitrary JavaScript/eval, network, unrestricted filesystem, DOM, project mutation, or runtime control.

Evaluation is bounded, cancellable, lazy where appropriate, and every produced field preserves source byte provenance.

## P12-INV-010 — Pattern interpretation does not replace loader semantics

Pattern results MAY create typed-data evidence and type hints.

They MUST NOT redefine executable mapping, relocation, import/export, instruction, or runtime semantics owned by loaders/semantic analysis.

## P12-INV-011 — Package identity is content/version bound

A package name is not sufficient identity.

Any result depending on a reusable package must be reproducible against a package content identity + schema/engine compatibility version.

## P12-INV-012 — No mandatory cloud/service dependency

Collaboration transport, package registries, and remote corpora may gain hosted implementations later.

Phase 12 core contracts MUST remain usable/testable locally. The Master Architecture intentionally leaves the hosted collaboration service as an open product decision.

## P12-INV-013 — iPad remains a release target

Million-entry knowledge corpora, large ChangeLogs, pattern evaluation, and rebuild planning must remain paged/bounded/demand-driven.

Desktop success alone does not close Phase 12.

---

# 3. Current planning baseline — what already exists

This section is intentionally descriptive, not normative. Revalidate it at P12.0.

At the 2026-08-19 planning baseline, Hex already contains meaningful Phase-12 foundations:

### Knowledge

`js/knowledge/index.js` already provides a versioned `KnowledgeDB`, IndexedDB/memory operation, confirmed/inferred levels, negative knowledge, candidate limits, ambiguity handling, search, and propagation. Existing behavior should become a compatibility oracle rather than being replaced wholesale.

### Signature / packages

`js/signature/index.js` already defines:

```text
SIGNATURE_PACK_FORMAT = "hex-knowledge-pack"
SIGNATURE_PACK_VERSION = 2
```

and validates signature/mapping arrays, provenance, license, architecture, confidence, and size bounds.

This is important: Phase 12 already has a seed package format. The job is to harden/generalize it, not invent an unrelated second package family.

### Recognition

`js/recognition/` already contains bounded matching, match budgets, matcher/classifier logic, and a registry facade.

Phase 12 should preserve bounded candidate generation and strengthen tier/evidence/version/ambiguity contracts.

### Diff

`js/diff/index.js` already provides a compact diff surface. Phase 12 can reuse recognition/diff features rather than building package matching independently.

### Project

`js/project/index.js` already preserves `.hexproj` v1, rejects embedded binaries, enforces a 16 MiB safety limit, distinguishes user/findings/analysis/navigation data, and sanitizes cache references.

This remains the portable exchange compatibility oracle. Collaboration must not mutate `.hexproj` into an unbounded replicated analysis database.

### Patching

`js/patch.js` already provides expected-before / after same-length byte patches, overlap checks, source-byte verification before application, a small ARM64 assembler, and range validation.

Phase 12 generalized rebuilding should wrap/extend this safely rather than bypassing the existing precondition discipline.

### Plugin API

The current plugin API already includes `knowledgeProvider`, `signatureProvider`, and `recognitionProvider`, with immutable snapshots, read permissions, read budgets, timeouts, cancellation, and failure isolation.

The target Plugin API v2 adds first-class `CapabilityRulePlugin`, `DiffFeaturePlugin`, `ExporterPlugin`, and the wider final contribution taxonomy. Phase 12 should reuse the isolation model instead of allowing package/rule code privileged direct access.

---

# 4. P12.0 — live preflight and permanent verifier

Do not begin production changes from this planning snapshot.

At Phase 12 start, record the exact live Phase 11 product and classify every row as PASS / FOUNDATION TASK / BLOCKING.

| Dependency | Phase 12 requirement |
|---|---|
| EvidenceGraph | typed immutable evidence IDs usable by recognition, capability rules, patterns, rebuild validation |
| Stable entity identity | knowledge/collaboration can target entities without address-only cross-version authority |
| ArtifactStore | derived package indexes/rule indexes/pattern results are version-keyed and disposable |
| ProjectStore | user facts separated from derived analysis |
| AnalysisSnapshot / Query API | packages/rules/patterns query immutable bounded analysis views |
| Scheduler/BudgetManager | package indexing and pattern/rule evaluation are cancellable and prioritized |
| Recognition / fingerprint | current tier/features/ambiguity semantics measured and reproducible |
| Plugin isolation | package/rule/provider code cannot bypass permissions |
| Patch model | before-state precondition survives migration |
| Native loaders | enough format metadata exists to plan relocation-aware rebuild safely |
| Phase 9 symbolic verification | available where useful, but not required for every rebuild operation |
| Phase 10 runtime providers | optional validation evidence, never required for static correctness |
| Phase 11 managed identities | collaboration/knowledge APIs are not native-address-only |

## 4.1 Freeze a machine-readable Phase 12 manifest

Before parallel implementation, define one versioned manifest containing:

- allowed component lanes / path ownership;
- shared contract paths;
- exact current baseline SHA;
- required tests per lane;
- canonical Phase 12 runner discovery roots;
- permanent exact-SHA verifier invocation;
- required corpus/fixture IDs;
- release evidence schema;
- package/ChangeLog/rebuild/pattern schema versions.

Engineering Process Guardrails require the living integration product and permanent verifier from the foundation checkpoint. Do not postpone verifier wiring to the final PR.

## 4.2 Sentinel discovery gate

Place/discover a sentinel test in every allowed nested Phase 12 test subtree and prove the canonical Phase 12 runner executes all of them before freezing the runner.

This avoids repeating the prior nested-test discovery failure class.

---

# 5. P12.1 — minimal shared package/provenance substrate

Only freeze fields that truly have cross-lane fan-out.

## 5.1 One reusable package envelope

Knowledge, signatures, capability rules, and patterns SHOULD share a common outer envelope even when payload schemas differ.

Recommended conceptual contract:

```ts
PackageManifest {
  format
  manifestVersion
  packageId
  packageVersion
  contentHash
  kind                // knowledge | signatures | capability-rules | patterns | mixed
  createdAt
  producer?
  provenance
  license
  supportedTargets?
  requiredHexApi
  requiredSemanticVersions?
  dependencies?
  payloadIndex
  integrity?
}
```

Do not freeze a network registry URL or signing PKI into the core contract. Content hash/version/provenance are core; distribution and trust-service policy can remain replaceable.

## 5.2 Package trust is not semantic truth

Package trust answers “where did this payload come from / is it the expected payload?”

It does NOT answer “is every semantic claim in it true for this binary?”

A trusted package still goes through target compatibility, recognition evidence, ambiguity, and local contradiction checks.

## 5.3 Compatibility path

Existing `hex-knowledge-pack` v2 input must have an explicit migration/compatibility route.

Do not remove current import/export until:

- old pack fixtures migrate deterministically;
- output equivalence is measured;
- negative/malformed fixtures remain fail-closed;
- current knowledge/signature tests pass through the compatibility route.

## 5.4 Package artifact separation

Persist separately:

```text
Package source bytes / manifest
Package index artifacts
Recognition candidate indexes
Rule compilation artifacts
Pattern compilation artifacts
```

The derived indexes are disposable ArtifactStore content. They do not become user/project facts.

---

# 6. P12.2 — knowledge/signature package vertical slice

This is the first full Phase 12 vertical slice because it is mostly read-only and current Hex already has strong foundations.

Target path:

```text
package bytes
  ↓ validate/budget/hash
PackageManifest + payload
  ↓ compile/index
ArtifactStore package index
  ↓ query active AnalysisSnapshot
bounded candidate generation
  ↓ staged MatchResult
KnowledgeSuggestion
  ↓ explicit apply/proposal when mutation is desired
ProjectStore user fact
```

## 6.1 Recognition tiers

Keep the Master Architecture tiers explicit:

```text
Tier 0 — exact content/debug identity
Tier 1 — relocation-normalized identity
Tier 2 — structural features
Tier 3 — normalized Semantic IR/dataflow
Tier 4 — high-level semantic/capability/type-use similarity
```

Candidate generation should use the cheapest selective tier first and escalate only as needed.

Do not run O(functions × packageEntries) semantic comparisons on open.

## 6.2 Match acceptance

A canonical match result should include at least:

```ts
MatchResult {
  sourceEntityId
  packageEntryId
  tier
  score
  confidence
  ambiguityMargin
  featuresUsed
  conflictingFeatures
  algorithmVersion
  packageContentHash
  evidenceIds
  completeness
  candidateSearchTruncated
}
```

Rules:

- exact identity may justify stronger automation than fuzzy semantic similarity;
- fuzzy matches remain suggestions unless the owning policy explicitly proves a safe promotion;
- truncated candidate search blocks “unique best match” claims;
- negative/rejected knowledge participates in candidate suppression with provenance;
- cross-version identity never reuses a local `FunctionId`.

## 6.3 Scalability strategy

For large corpora:

```text
content/normalized hash index
   ↓ small candidate set
cheap structural index
   ↓ smaller candidate set
semantic/dataflow comparison
   ↓ ranked evidence-rich matches
high-level capability/type features only when needed
```

Persist indexes in compact/pageable form. Do not deserialize the full corpus into one giant JS object graph on iPad.

## 6.4 Vertical-slice exit

The slice is accepted when:

- an existing v2 pack migrates/imports;
- package identity/provenance/version are retained;
- one exact match and one ambiguous fuzzy match are correctly distinguished;
- a package suggestion cannot overwrite stronger local evidence;
- a rejection survives reopen;
- candidate budget/truncation is observable;
- warm reopen reuses derived index artifacts;
- iPad/browser memory stays bounded on the designated large-pack fixture.

After this checkpoint, the remaining lanes may fan out.

---

# 7. P12.K — deterministic capability-rule ecosystem

Capability rules translate typed low-level facts into deterministic higher-level facts.

They are not natural-language prompts.

## 7.1 Rule input boundary

Rules should consume a narrow typed feature API, for example:

```text
instruction/semantic features
CFG/block facts
calls/imports
SSA/dataflow facts
MemorySSA/alias facts
types/runtime metadata
strings/constants
function summaries
existing deterministic facts
```

A rule must not scrape UI pseudocode text when the equivalent typed fact exists.

## 7.2 Scoped evaluation

Adopt explicit scopes:

```text
instruction
basic-block
function/method
module/file
runtime span/session when supported
```

Cross-scope promotion must be explicit. A function-level hit is not automatically a file-level capability.

## 7.3 Capability result

```ts
CapabilityFact {
  id
  capabilityId
  scope
  targetEntityIds
  ruleId
  ruleVersion
  packageContentHash
  evidenceIds
  contradictingEvidenceIds
  assumptions
  completeness
  verdict
}
```

A confidence number alone does not make a capability `confirmed`.

## 7.4 Rule safety

Rule definitions are treated like untrusted package content:

- no arbitrary JS/eval;
- bounded feature queries;
- bounded recursion/dependencies;
- cycle detection;
- cancellation;
- deterministic ordering;
- explicit unsupported feature state;
- no project mutation.

## 7.5 Negative fixtures are mandatory

For every high-value capability rule, create:

- a minimal positive fixture;
- a near-miss negative fixture;
- an incomplete-analysis fixture;
- a contradictory-evidence fixture where relevant.

The near-miss fixture is often more important than the positive fixture because false semantic certainty is the product risk.

---

# 8. P12.C — collaboration and ChangeLog

Do not begin with a hosted collaboration server.

First build a deterministic local change model that can merge two independently edited project histories. If local replay/merge semantics are not correct, adding networking only makes the bug distributed.

## 8.1 Change operation envelope

Recommended conceptual contract:

```ts
ProjectOperation {
  operationId
  schemaVersion
  projectIdentity
  binaryIdentity?
  authorIdentity?
  device/sessionIdentity?
  timestampHint?
  causalParents?
  targetEntityId
  factKind
  action
  beforeFingerprint?
  payload
  provenance
}
```

The exact causal-clock representation may be chosen at P12.C design time. Do not encode a server/vendor assumption into it.

## 8.2 Required replay properties

The operation engine must prove:

```text
same op applied twice        -> same final state (idempotence)
reordered independent ops    -> same semantic result
missing parent/dependency    -> explicit unresolved state
wrong binary identity        -> reject / explicit mismatch
conflicting meaningful edits -> conflict preserved
```

## 8.3 Conflict semantics by fact family

Do not use one generic merge rule for everything.

Suggested defaults:

| Fact | Default merge behavior |
|---|---|
| comments/notes | preserve distinct contributions |
| bookmarks | set-like add/remove with operation identity |
| confirmations/rejections | preserve provenance; contradictory state visible |
| names | preserve competing meaningful candidates until resolved |
| types/structs | structural conflict; never silent LWW |
| patches | overlap/precondition conflict is blocking |
| pinned evidence | set-like, evidence identity bound |
| navigation | local/session state; generally not semantic collaboration authority |

## 8.4 ProjectStore vs `.hexproj`

The ChangeLog belongs to scalable ProjectStore state.

`.hexproj` remains a portable exchange format. A future v2 may include a bounded manifest/change history, but:

- v1 import remains supported;
- migration is deterministic;
- analyzed binary remains external by default;
- giant derived analysis artifacts remain outside the project exchange file.

## 8.5 Collaboration transport

Only after local merge/replay is proven should a transport be added.

Any later sync layer should transport operations/checkpoints, not arbitrary mutable project objects.

---

# 9. P12.P — declarative data-pattern language

This lane should remain read-only until its evaluator, provenance, and resource model are proven.

## 9.1 Language scope

Initial useful feature set:

```text
primitive integers/floats/strings with explicit endian
structs / unions / enums / bitfields
fixed arrays
bounded dynamic arrays
explicit pointers / offsets
conditional fields
named constants
reusable modules
lazy fields
pure allowlisted helper intrinsics
```

Avoid a general-purpose scripting language in v1.

## 9.2 Execution architecture

```text
Pattern source
  ↓ parse
Pattern AST
  ↓ validate/type-check/static bounds where possible
Compiled Pattern Artifact
  ↓ evaluate against ByteSource capability
Lazy Typed Data Tree
  ↓
DataEvidence + optional type hints + UI projection
```

## 9.3 Addressing must be explicit

A pattern pointer/offset must state enough context to know whether it is:

- source/file offset;
- current-structure-relative offset;
- virtual address through a specific BinaryImage mapping;
- another explicitly named address space.

Do not silently treat all integers as virtual addresses.

## 9.4 Safety budget

At minimum bound:

- source bytes read;
- number of materialized nodes;
- array element count;
- string length;
- recursion/nesting depth;
- pointer dereference depth;
- helper calls;
- evaluator CPU/wall-clock budget;
- retained result size.

Cancellation must be observed inside loops and lazy expansion.

## 9.5 Cycle handling

Self-referential pointers and recursive types are normal in binary structures.

The evaluator must distinguish a valid graph cycle from an unbounded recursive expansion. Use stable source-location/type identities and lazy references rather than recursively materializing forever.

## 9.6 Evidence boundary

Each materialized field carries source range(s) and pattern/rule identity.

Pattern-produced type hints are evidence. They do not mutate Semantic IR or loader mappings directly.

---

# 10. P12.R — generalized relocation-aware rebuilding

This is the highest-blast-radius Phase 12 lane. It should start in parallel after the shared checkpoint, but its **write/export cutover remains last**.

## 10.1 Do not build a linker accidentally

The first release does not need arbitrary executable re-linking.

Grow capability in explicit levels:

```text
R0  represent/validate current same-size PatchSet as RebuildPlan
R1  round-trip format metadata without semantic change
R2  controlled section/data replacement with layout accounting
R3  relocation-aware address-moving operations
R4  import/export/code-cave operations where format support is proven
R5  advanced format-specific rebuild operations
```

Never claim a higher level because one happy-path file exported successfully.

## 10.2 RebuildPlan

Conceptual contract:

```ts
RebuildPlan {
  planId
  binaryId
  sourceHash
  loaderVersion
  operations
  expectedOriginalState
  layoutEffects
  relocationEffects
  branchRangeEffects
  unwindEffects
  signatureEffects
  unresolvedRisks
  requiredValidators
}
```

Planning should be deterministic and inspectable before bytes are emitted.

## 10.3 Format backends own format semantics

The generic planner should not contain Mach-O/ELF/PE special cases hidden in one giant switch.

Format-specific rebuild providers own:

- section/segment layout rules;
- relocation encoding/updates;
- import/export structures;
- dynamic loader metadata;
- unwind/exception metadata;
- alignment;
- checksum/signature implications;
- format-specific rebuild constraints.

The shared layer owns plan identity, operation contracts, preconditions, validation orchestration, provenance, and failure states.

## 10.4 Validation pipeline

A rebuild is publishable only after all applicable validators report explicit results:

```text
before-state preconditions
  ↓
format structure validation
  ↓
reparse rebuilt bytes
  ↓
address/relocation/import/export validation
  ↓
decode + branch range validation
  ↓
CFG / unwind / exception checks where affected
  ↓
signature/checksum consequence report
  ↓
optional semantic equivalence / emulator / runtime verification
  ↓
export result + validation evidence
```

A format signature becoming invalid may be a valid outcome, but it must be reported explicitly; it cannot be hidden as “export succeeded.”

## 10.5 Independent differential oracle

Where a permissively usable external parser/rebuilder is available in the CI environment, use it as an additional oracle, not as Hex’s semantic authority.

The Hex loader must always be able to re-open and validate its own output.

## 10.6 First production vertical slice

The safest first slice is:

1. adapt current same-size `PatchSet` into `RebuildPlan`;
2. verify expected original bytes;
3. produce output identical to current patch application;
4. reparse it through the owning loader;
5. attach validation evidence;
6. prove unchanged regions remain unchanged;
7. retain the old path as a differential compatibility oracle until stable.

Only then introduce address-moving operations.

---

# 11. Parallel execution plan

After P12.2 freezes the shared package/evidence envelope, use independent lanes.

## Wave 0 — single integration/foundation owner

Owns:

- live baseline audit;
- Phase 12 manifest;
- canonical test runner;
- permanent exact-SHA verifier;
- shared package envelope;
- package content identity/provenance;
- living integration branch.

No other lane edits the shared envelope without an explicit contract change.

## Wave 1 — vertical slice

One implementation lane owns knowledge/signature package migration and staged recognition.

One independent review lane attacks:

- ambiguous matches;
- candidate truncation;
- conflicting evidence;
- wrong-target package application;
- large-corpus memory behavior.

Do not fan out production package consumers until this checkpoint is stable.

## Wave 2 — parallel lanes

```text
Lane K — capability rules
Lane C — ChangeLog/local collaboration merge
Lane P — pattern parser/evaluator read-only path
Lane R — RebuildPlan + same-size compatibility path
Lane I — integration + moving-main reconciliation + exact verifier
```

A separate real-time reviewer may inspect shared-boundary changes without editing lane-owned files.

## Wave 3 — controlled expansions

After each lane has one vertical slice:

- K: package ecosystem + indexes + search/UI/AI query exposure;
- C: checkpoint/compaction + bounded exchange + optional transport adapter;
- P: reusable modules + lazy UI + package distribution;
- R: format-specific address-moving operations one format at a time.

Do not expand all formats and all package kinds simultaneously.

## Wave 4 — exact product cutover

Reconcile once to current `main`, regenerate any owned generated output, run the permanent verifier on the exact candidate, then run required iOS/iPadOS/WebKit proof.

---

# 12. Ownership rules that prevent Phase 12 merge debt

The exact paths are frozen only at P12.0, but the conceptual ownership should be:

```text
Foundation owner
  package manifest/schema
  common identity/provenance
  phase verifier/manifest

Knowledge lane
  knowledge/signature/recognition package consumption

Capability lane
  capability feature API + deterministic rule evaluator

Collaboration lane
  ProjectOperation / ChangeLog / merge/conflict engine

Pattern lane
  pattern parser/compiler/evaluator

Rebuild lane
  patch/rebuild plan + format rebuild providers

Integration lane
  public facade wiring
  canonical generated outputs
  moving-main reconciliation
  exact product proof
```

Shared files are not “everyone may edit.” Contract write ownership must be explicit per path.

---

# 13. Fast-safe test strategy

Use narrow inner-loop tests and broad exact-product tests at deliberate checkpoints.

## T0 — local contract/minimal counterexample

Examples:

```text
package parser change
  -> malformed/version/hash/provenance fixture

recognition change
  -> exact + near-collision + truncated candidate fixture

rule engine change
  -> minimal positive + near-miss negative

ChangeLog change
  -> duplicate/reorder/conflict property case

pattern evaluator change
  -> resource-limit/cycle/malformed case

rebuild change
  -> exact before-state mismatch / round-trip fixture
```

## T1 — lane runner

Each lane gets a canonical aggregate test command discovered by the Phase 12 runner.

## T2 — cross-boundary integration

Required when changing:

- EvidenceGraph integration;
- ProjectStore mutation semantics;
- package public APIs;
- plugin permissions;
- rebuild/export public path;
- AI tool exposure;
- compatibility/migration behavior.

## T3 — checkpoint / release

At shared checkpoint and final cutover:

```bash
npm run check
```

plus Phase 12 exact-SHA verifier / production-faithful browser tests required by the live repository.

The exact command set MUST be captured from live `package.json` / workflows at P12.0 rather than copied blindly from this planning document.

---

# 14. Required adversarial/property test matrix

## Knowledge / recognition

- exact match;
- relocation-normalized match;
- same-size unrelated function;
- near-collision structural match;
- two candidates inside ambiguity window;
- candidate set truncated before full search;
- stale package semantic version;
- incompatible target architecture/platform;
- package claim contradicted by local evidence;
- negative/rejected prior knowledge;
- million-entry synthetic index under memory budget.

Track precision/recall and **false certainty** separately.

## Capability rules

- positive;
- near-miss negative;
- missing required evidence;
- conflicting evidence;
- bounded/partial upstream analysis;
- cyclic rule dependency;
- pathological fan-out;
- deterministic replay across worker scheduling order.

## Collaboration

Property-style tests should prove, where semantics permit:

- idempotence;
- deterministic replay;
- commutativity of independent operations;
- conflict preservation;
- tombstone/remove correctness;
- checkpoint + replay equivalence;
- wrong binary/project rejection;
- stale before-fingerprint behavior;
- v1 project import/export compatibility;
- malicious oversized project/change payload rejection.

## Pattern language

- malformed syntax/type errors;
- hostile offsets/overflow;
- endian correctness;
- conditional branches;
- bounded dynamic arrays;
- self-referential pointers;
- recursive types;
- deep nesting;
- giant claimed string/array;
- cancellation during expansion;
- pointer outside permitted source range;
- helper intrinsic permission failure;
- exact source provenance for every materialized field.

## Rebuild

Per supported format/operation:

- before-state mismatch;
- overlapping operations;
- unchanged-byte preservation;
- parse -> rebuild -> parse round trip;
- relocation rebasing;
- branch range overflow;
- alignment constraints;
- import/export consistency;
- unwind/exception metadata impact;
- code-signature/checksum consequence;
- cancelled rebuild;
- malformed source input;
- independent parser differential where available.

---

# 15. Performance design

## 15.1 Knowledge

Never require the entire corpus resident in memory.

Track:

- package-open latency;
- index-build latency;
- warm reopen;
- candidate lookup p50/p95;
- peak JS heap / worker memory;
- ArtifactStore footprint;
- candidate truncation rate.

## 15.2 Rules

Rules are demand-driven. Whole-binary capability scans are background P4/P5 scheduler work, not a blocker for opening the current function.

Track evaluated entities, feature-query count, cache hit rate, cancellation latency, and false-positive rate.

## 15.3 Collaboration

ChangeLog growth must not make every mutation O(history length).

Use indexed materialized project state + append-only operations/checkpoints. Compaction/checkpointing may optimize storage but must preserve replay/audit semantics.

## 15.4 Patterns

Lazy expansion is a product requirement, not an optimization. Opening a structure with a million-element array must not create a million UI/JS objects.

## 15.5 Rebuild

Stream/page large source bytes. Do not require a 1 GB binary to become one browser `ArrayBuffer` merely to export a small metadata change.

---

# 16. Stop-the-line conditions

Immediately stop integration if any of these is observed:

1. package knowledge silently overwrites stronger local/user evidence;
2. a fuzzy match is accepted without exposed candidate ambiguity/features;
3. truncated recognition search is reported as complete/unambiguous;
4. AI prose creates a verified capability fact without deterministic rule evidence;
5. a collaborative merge silently drops a meaningful competing type/name/patch;
6. derived analysis artifacts are replicated/merged as user truth;
7. duplicate ChangeLog delivery creates duplicate state mutation;
8. operation targeted to the wrong binary/build can apply;
9. pattern code obtains eval/network/DOM/unbounded read authority;
10. pattern interpretation changes loader/semantic truth directly;
11. rebuild can publish despite failed expected-original precondition;
12. address-moving rebuild skips relocation/branch/unwind/signature impact analysis;
13. an exported binary cannot be re-opened/validated by the owning Hex loader;
14. a new package/rule/pattern path is uncancellable or unbudgeted;
15. compatibility with current knowledge packs / `.hexproj` / PatchSet is removed before differential replacement is green.

These are architecture blockers, not polish bugs.

---

# 17. Non-blocking work — do not stall the phase for these

Do not serialize the entire campaign for:

- hosted package marketplace design;
- final collaboration server/provider selection;
- package signing PKI beyond required content integrity/provenance;
- perfect UI for every conflict type;
- every optional capability rule pack;
- every binary format rebuild operation;
- a Turing-complete pattern language;
- automatic code-signing/re-signing workflows not required by the current release contract;
- corpus-cloud search before local indexed packages are correct;
- speculative micro-optimizations without a measured bottleneck.

Track these separately and keep the critical path moving.

---

# 18. Proposed Phase 12 exit contract

The exact release contract is ratified at P12.0 against the live product. A strong default is:

## Knowledge/signatures

- one versioned common package envelope exists;
- current knowledge-pack compatibility is preserved;
- scalable paged indexing is proven;
- staged MatchResult exposes features/ambiguity/evidence/version/completeness;
- knowledge cannot silently override stronger local evidence;
- package provenance/license/content identity survive import/export/reopen.

## Capability rules

- deterministic scoped rule engine exists;
- capability packages use the shared envelope;
- constituent evidence survives into `CapabilityFact`;
- partial/unknown upstream analysis cannot become false certainty;
- rule execution is bounded/cancellable/isolated.

## Collaboration

- ProjectOperation/ChangeLog is versioned and binary/project identity bound;
- duplicate/reordered independent operation tests pass;
- meaningful conflicts remain explicit;
- derived artifacts are excluded from collaborative truth;
- `.hexproj` v1 migration/compatibility remains green;
- local replay/merge works without requiring a hosted service.

## Rebuild

- current PatchSet behavior is preserved through the new plan path;
- at least the explicitly claimed generalized operations are relocation/layout aware;
- rebuilt output is reparsed and validated;
- applicable relocation/branch/unwind/import/export/signature consequences are explicit;
- unsupported format/operation combinations fail closed;
- no arbitrary “successful byte write = valid rebuild” path remains.

## Pattern language

- safe parser/compiler/evaluator exists;
- core typed structures, explicit addressing, conditionals, bounded arrays, pointers, modules, and lazy evaluation work for the declared v1 profile;
- hostile/resource-exhaustion fixtures are bounded;
- every field retains source provenance;
- results contribute evidence without overriding loader semantics.

## Product proof

- living integration product has remained green through component acceptance;
- exact-head verifier is green on current candidate;
- required general/semantic/security/project/plugin/patch/browser gates are green;
- real iOS/iPadOS/WebKit proof covers large-package browsing, collaboration/local replay UI, lazy pattern browsing, and the supported rebuild/export flow;
- generated output is owned/rebuilt/synchronized according to current guardrails;
- unresolved limitations are listed explicitly rather than rounded up to “supported.”

---

# 19. Recommended first implementation sequence when Phase 12 starts

Use this order unless the live P12.0 audit produces evidence to change it:

```text
1. Observe live Phase 11 exact product.
2. Freeze P12 manifest, runner, ownership and permanent verifier.
3. Inventory current knowledge/signature/recognition/project/patch/plugin contracts.
4. Define minimal common package manifest + content identity/provenance.
5. Migrate current knowledge-pack v2 through compatibility adapter.
6. Prove exact + ambiguous recognition vertical slice with bounded index.
7. Checkpoint-lock shared package contract.
8. Fan out K/C/P/R lanes.
9. Integrate each accepted vertical slice immediately into living product.
10. Expand one risk dimension at a time.
11. Keep rebuild write/export promotion last.
12. Reconcile once to current main and regenerate owned output.
13. Run exact-head verifier + production-faithful iPad/WebKit proof.
14. Record remaining unsupported operations/packages/transports explicitly.
```

This sequence minimizes the amount of work that can be invalidated by a bad shared contract while still exposing maximum useful parallelism after the first vertical slice.

---

# 20. Final engineering rule

Phase 12 is complete when Hex can safely **reuse knowledge, share human work, interpret structured bytes, and rewrite binaries without weakening its evidence model**.

It is not complete merely because:

- a large signature file imports;
- two browser tabs appear synchronized;
- a rule prints a high-level label;
- a pattern renders a struct;
- a modified file downloads successfully.

The product-level definition is:

```text
reusable knowledge
+ deterministic semantic facts
+ conflict-preserving collaboration
+ provenance-preserving typed data interpretation
+ relocation-aware validated rewriting
+ exact product evidence
```

with the existing Hex semantic/evidence system remaining the single source of truth.