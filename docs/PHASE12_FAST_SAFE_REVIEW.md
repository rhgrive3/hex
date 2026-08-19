# Phase 12 — Fast + Safe Review

Status: **pre-implementation review / execution accelerator**  
Companion: [`PHASE12_KNOWLEDGE_COLLAB_REWRITE_PLAYBOOK.md`](./PHASE12_KNOWLEDGE_COLLAB_REWRITE_PLAYBOOK.md)  
Normative authority: [`HEX_MASTER_ARCHITECTURE.md`](./HEX_MASTER_ARCHITECTURE.md) and [`ENGINEERING_PROCESS_GUARDRAILS.md`](./ENGINEERING_PROCESS_GUARDRAILS.md)  
Planning baseline: **`main` at `4e03ea8a8b3be36e61f91ac4aa6657fd95f382b9` (2026-08-19)**

> The purpose of this review is to remove predictable Phase 12 design stalls before implementation starts. It intentionally favors the shortest safe critical path and leaves non-blocking product decisions out of the dependency chain.

---

# 1. Review conclusion

Phase 12 should **not** have five serial subphases and should **not** start by designing collaboration networking or a universal binary re-linker.

The shortest safe critical path is:

```text
P12.0 baseline + permanent verifier
  ↓
P12.1 common package/provenance envelope
  ↓
P12.2 current knowledge-pack compatibility + one staged recognition vertical slice
  ↓
CHECKPOINT LOCK
  ↓
parallel:
  K capability rules
  C local ChangeLog/merge
  P read-only pattern engine
  R RebuildPlan + same-size compatibility
  I living integration/reconciliation
  ↓
expand lanes independently
  ↓
rebuild write/export promotion last
  ↓
exact-head + iPad/WebKit release proof
```

The central design decision is:

> **Only the package/evidence identity contract is shared enough to justify early serialization. Collaboration operations, rule evaluation, pattern execution, and rebuild internals should not be forced into one common framework.**

---

# 2. Hard part #1 — “Package” can become a second truth system

## Failure mode

A reusable pack contains a name/type/semantic role and Hex simply applies it when a fuzzy match is “good enough.”

This creates a hidden authority path outside EvidenceGraph and ProjectStore.

## Resolution

Separate three stages:

```text
package claim
  ↓
recognition evidence
  ↓
KnowledgeSuggestion
  ↓
explicit deterministic/user application policy
  ↓
ProjectStore fact
```

Package integrity proves payload identity, not semantic correctness.

### Gate

A strong local/user fact must survive import of a contradictory high-confidence package unchanged, with the contradiction/suggestion still inspectable.

---

# 3. Hard part #2 — recognition scalability vs correctness

## Failure mode

To improve recognition quality, every function is compared semantically against every package entry.

This is both too slow for iPad and prone to ranking noise.

## Resolution

Use progressive candidate narrowing:

```text
exact/normalized hash
  → structural bucket
  → semantic/dataflow comparison
  → high-level capability/type features only for bounded candidates
```

Never hide candidate truncation.

### Gate

The recognizer must report `truncated/partial` when the search budget prevents uniqueness proof.

### Metric

Track candidate count before/after each tier, lookup p95, peak memory, precision/recall, and false-certainty rate.

---

# 4. Hard part #3 — confidence is not uniqueness

## Failure mode

Best score = 0.94, so the UI calls the function identified even though the second candidate is 0.93 or unseen due to budget truncation.

## Resolution

Match acceptance depends on:

- tier;
- confidence;
- ambiguity margin;
- candidate-search completeness;
- contradictory features;
- package/algorithm version;
- evidence provenance.

### Gate

Create a fixture with two deliberately near-identical candidates and require ambiguous output even when both individually score above the ordinary acceptance threshold.

---

# 5. Hard part #4 — capability rules can degrade into an LLM labeler

## Failure mode

A rule is implemented as “ask AI whether this pseudocode encrypts data.”

That destroys deterministic verification and makes capability facts non-reproducible.

## Resolution

Rules consume typed deterministic features and return evidence-linked facts. AI is a reader/explainer/search interface over those facts.

### Gate

The exact same snapshot + rule package + semantic versions must produce the same capability result independent of model availability.

### Negative oracle

A near-miss fixture must not match merely because strings/names resemble the capability.

---

# 6. Hard part #5 — collaboration conflict semantics

## Failure mode

Use generic last-writer-wins because it is easy to synchronize.

That is unacceptable for meaningful competing types, names, structs, and overlapping patches.

## Resolution

Build local deterministic operation replay first and define conflict policy per fact family.

Do not choose the network/server architecture until these properties are green:

```text
idempotent duplicate delivery
reordered independent operation equivalence
binary/project identity rejection
conflict preservation
checkpoint + replay equivalence
```

### Fast path

Comments/bookmarks/set-like facts can establish the initial operation engine while names/types/patches exercise conflict states next.

### Do not block on

WebSocket provider, account model, hosted database, live presence, cursor sharing, or cloud deployment.

---

# 7. Hard part #6 — ChangeLog size and auditability

## Failure mode

Every project query replays the complete history from zero, or compaction deletes evidence needed to understand conflicts.

## Resolution

Use:

```text
append-only operations
+ indexed materialized project state
+ versioned checkpoints
+ replay/audit metadata
```

Checkpointing is an optimization; it cannot silently change semantic history.

### Gate

State reconstructed from checkpoint + remaining operations must equal state reconstructed from the full accepted history for the test corpus.

---

# 8. Hard part #7 — pattern language safety

## Failure mode

Reuse JavaScript because it is expressive and easy.

That immediately imports arbitrary execution, unbounded loops, host access, nondeterminism, and hard-to-audit permissions into hostile-file parsing.

## Resolution

Use a declarative AST with bounded evaluation and pure allowlisted intrinsics.

Initial language scope should remain intentionally small:

```text
primitives + endian
struct/union/enum/bitfields
arrays
explicit pointers/offsets
conditions
constants/modules
lazy fields
```

### Gate

A malicious pattern attempting giant allocation, recursive expansion, out-of-range pointer traversal, or forbidden intrinsic access must terminate as a typed resource/permission error without freezing UI.

---

# 9. Hard part #8 — pointer/address semantics in patterns

## Failure mode

A numeric pointer is assumed to be a virtual address everywhere.

This breaks archives, raw files, file-relative formats, managed metadata, and nested containers.

## Resolution

Pattern references explicitly name the addressing domain:

```text
file/source offset
structure-relative offset
specific BinaryImage virtual address
explicit named space/provider
```

### Gate

The same numeric value interpreted under two different explicit spaces must resolve differently and preserve source provenance correctly.

---

# 10. Hard part #9 — generalized rebuild can accidentally become a linker project

## Failure mode

Phase 12 begins with “support arbitrary section insertion/import addition/code caves for Mach-O/ELF/PE.”

This creates a huge cross-format critical path involving layout, relocation, unwind, signatures, dynamic linking, branch ranges, and format-specific constraints.

## Resolution

Promote rewrite capability by explicit levels:

```text
R0 current same-size PatchSet through RebuildPlan
R1 no-semantic-change format round trip
R2 controlled layout-aware data/section operations
R3 relocation-aware address-moving operations
R4 import/export/code-cave operations where proven
```

Format backends own format-specific semantics; the shared layer owns plan/precondition/evidence/validation contracts.

### Fastest useful first slice

Current PatchSet → RebuildPlan → same output → owning loader reparses → validation evidence.

This proves the new pipeline without changing output semantics.

---

# 11. Hard part #10 — “export succeeded” is not validation

## Failure mode

A Blob/file is produced, so the rewrite is marked successful.

## Resolution

Separate:

```text
materialization succeeded
format validation succeeded
semantic validation status
signature/checksum consequence
export publication
```

### Gate

If the rebuilt binary cannot be reopened by the owning Hex loader, publication fails.

If code signing/AuthentiCode becomes invalid, that may be an expected consequence but must be explicit in validation evidence.

---

# 12. Hard part #11 — package ecosystem supply chain

## Failure mode

A package name/version is trusted without content identity, or package update silently changes prior recognition/rule results.

## Resolution

Every durable result binds to package content hash + package version + relevant semantic/rule algorithm versions.

Keep license/provenance metadata first-class.

Do not block Phase 12 on a final package-signing PKI. Content integrity and deterministic identity are required now; distribution trust services are replaceable policy.

### Gate

Changing package bytes without changing the logical display name must invalidate derived package indexes/results through artifact identity.

---

# 13. Hard part #12 — derived analysis must not enter collaboration truth

## Failure mode

One collaborator sends cached SSA/decompiler/recognition objects to another and they become project state.

This creates stale cross-version analysis and conflicts with ArtifactStore invalidation.

## Resolution

Collaborate only durable human/project facts and references to immutable evidence where valid.

Derived analysis is recomputed/retrieved through versioned ArtifactStore keys.

### Gate

A collaboration merge containing unknown/opaque analysis cache payload must not mutate canonical analysis state.

---

# 14. What must be serialized

Keep the serial critical path very small.

## Serial A — P12.0 verifier/ownership

Freeze:

- exact baseline;
- phase manifest;
- test discovery;
- permanent exact-SHA verifier;
- living integration lane;
- release evidence schema.

## Serial B — P12.1 shared package identity/provenance

Freeze only:

- package envelope/version identity;
- content hash;
- kind;
- target compatibility metadata;
- provenance/license;
- API/semantic compatibility metadata;
- payload index/dependency vocabulary;
- bounded validation rules.

Do not freeze marketplace/server/UI choices.

## Serial C — P12.2 vertical slice

Prove current pack compatibility and staged recognition through the shared envelope.

Then checkpoint-lock the shared contract.

Everything else should fan out.

---

# 15. What should run in parallel

After P12.2:

| Lane | Can proceed independently with | Must wait for |
|---|---|---|
| Capability rules | typed feature API, evaluator, fixtures, rule packages | shared package envelope only |
| Collaboration | ProjectOperation, replay, local merge, conflicts | stable entity/project identity |
| Patterns | parser/compiler/evaluator, ByteSource sandbox | shared package envelope for packaged patterns only |
| Rebuild | plan model, current PatchSet adapter, validators | stable binary/loader/patch identities |
| Integration | moving main, facade wiring, exact verifier | nothing; remains live continuously |
| Reviewer | negative fixtures, scope/ownership/evidence audit | can run continuously |

Do not stack these lanes behind one another merely to simplify branch management.

---

# 16. PR shape

One PR should own one primary trust boundary.

Good Phase 12 PR boundaries:

```text
foundation manifest/verifier
common package manifest
knowledge-pack compatibility adapter
recognition tier result contract
capability rule evaluator
capability package adapter
ProjectOperation schema
local ChangeLog replay
conflict engine
pattern parser/type checker
pattern bounded evaluator
RebuildPlan model
Mach-O rebuild provider operation X
ELF rebuild provider operation X
PE rebuild provider operation X
rebuild validation pipeline
```

Bad PR shapes:

```text
knowledge + collaboration + rewrite all-in-one
package manager + UI redesign
pattern engine + arbitrary plugin API refactor
rebuild architecture + mass loader rewrite
collaboration + hosted backend + auth
```

Small contract PRs reduce the blast radius of moving-main reconciliation and independent review.

---

# 17. Worker allocation for fastest execution

When the Dev Agent runs Phase 12 with max-6 workers, the default useful topology after the shared checkpoint is:

```text
Worker 1  Capability rules implementation
Worker 2  Collaboration/ChangeLog implementation
Worker 3  Pattern engine implementation
Worker 4  Rebuild plan/provider implementation
Worker 5  Real-time independent reviewer / negative fixtures
Worker 6  Integration/reconciliation/general unblocker
Supervisor contract owner + final verification
```

During P12.0–P12.2, do not fill all six slots merely because they exist. Use extra workers for read-only audits, corpus/fixture design, and independent review rather than competing edits to the same shared contracts.

---

# 18. Integration rhythm

Follow the permanent guardrail pattern:

```text
component accepted
  ↓
integrate immediately
  ↓
canonical generated output if owned
  ↓
rolling phase verifier
  ↓
independent shadow verification
  ↓
checkpoint lock released
  ↓
next dependent acceptance
```

Do not wait for all four lanes to finish before testing them together.

The integration lane alone owns moving-main reconciliation. Component workers do not repeatedly rebase/recreate PRs simply because `main` moves.

---

# 19. CI strategy

## Inner loop

Run only the narrow test that proves the current counterexample.

## Lane PR

Run the lane aggregate plus affected existing subsystem tests.

## Cross-boundary PR

Escalate whenever EvidenceGraph, ProjectStore, plugin isolation, public query/command APIs, loader/rebuild, or migration compatibility is touched.

## Checkpoint/final

Run the broad repository gate and permanent exact-SHA Phase 12 verifier.

Do not increase GitHub job fan-out before profiling the real slow fixture. Prefer local worker parallelism and indexed/bounded algorithms first.

---

# 20. Review-derived minimal counterexamples to create before implementation

These fixtures should exist at or near foundation time because they encode the hardest boundaries cheaply.

1. **Knowledge contradiction:** package says type/name A; stronger local/user evidence says B; B remains authoritative.
2. **Recognition ambiguity:** two candidates differ by less than ambiguity window; no auto-accept.
3. **Recognition truncation:** best visible candidate high confidence but search truncated; result cannot be unique-confirmed.
4. **Capability near miss:** semantic shape resembles a capability but lacks one necessary dataflow/effect edge; no match.
5. **Capability partial:** upstream analysis incomplete; result preserves partial/unknown.
6. **Change duplicate:** same operation delivered twice; one effect.
7. **Change reorder:** independent A/B operations reordered; same semantic state.
8. **Type conflict:** collaborators assign incompatible meaningful types; both preserved in conflict.
9. **Patch conflict:** overlapping patch operations cannot silently merge.
10. **Pattern bomb:** dynamic count requests huge array; evaluator stops at resource limit.
11. **Pattern cycle:** self-reference renders lazily without recursion explosion.
12. **Pattern provenance:** nested field maps exactly back to source byte range.
13. **Rebuild stale source:** one expected original byte differs; plan refuses to publish.
14. **Rebuild round trip:** same-size current patch path reparses and preserves all untouched bytes.
15. **Rebuild consequence:** signature/checksum invalidation is explicit rather than success-hidden.

These minimal counterexamples are cheap enough to run constantly and high-value enough to prevent whole-lane redesigns later.

---

# 21. Decisions intentionally deferred

Do not block implementation while debating:

- official cloud collaboration provider;
- package marketplace UX;
- central reputation service;
- final package signing PKI;
- live cursor/presence collaboration;
- every future capability taxonomy;
- full code-signing/re-signing automation;
- arbitrary native linker functionality;
- Turing-complete pattern scripting;
- support for every historical/niche object format.

If a deferred decision becomes necessary to satisfy an accepted exit criterion, promote it with an ADR at that time.

---

# 22. Three-pass self-review record

## Review pass 1 — architecture integrity

Checked the plan against the Master Architecture invariants.

Result:

- no second semantic truth introduced;
- knowledge remains suggestive/evidence-backed;
- capability facts remain deterministic;
- collaboration remains user-fact-only;
- rewrite remains non-destructive/planned/validated;
- pattern results remain evidence, not loader authority;
- iPad/browser constraints remain explicit.

## Review pass 2 — implementation speed

Looked for unnecessary serial dependencies.

Result:

- only verifier/ownership, package envelope, and first vertical slice remain serial;
- collaboration networking removed from critical path;
- pattern engine can progress read-only in parallel;
- rebuild planning can progress in parallel while write/export promotion stays late;
- moving-main reconciliation stays with one integration owner;
- narrow tests precede broad checkpoint gates.

## Review pass 3 — failure containment

Looked for failure classes that could invalidate multiple lanes late.

Result:

- package identity/provenance frozen before fan-out;
- candidate truncation/ambiguity explicit;
- ChangeLog conflict semantics tested locally before transport;
- pattern sandbox/resource model precedes ecosystem expansion;
- current PatchSet becomes a compatibility oracle before address-moving rebuild;
- exact-head verifier exists from foundation rather than final cutover.

No blocker was found that requires serializing all Phase 12 work.

---

# 23. Final recommendation

When Phase 12 starts, spend the first implementation effort on **contracts and negative oracles, not features**.

The most expensive Phase 12 mistakes would be discovered late if the team begins with a marketplace, live collaboration, a rich pattern language, or arbitrary binary layout mutation.

The fastest safe sequence is instead:

```text
prove package identity
→ prove recognition ambiguity
→ fan out read-mostly independent systems
→ prove local collaboration semantics
→ prove pattern sandbox
→ prove rebuild plan on current patch behavior
→ expand capabilities independently
→ promote mutation/export last
```

That order maximizes parallelism while keeping every high-blast-radius boundary behind a deterministic gate.