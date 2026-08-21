# Hex Phase 1–12 — 100% Completion Hardening Amendment

Status: **mandatory execution hardening for `POST_PHASE_COMPLETION_TWO_STAGE_PLAYBOOK.md`**  
Scope: **proof closure only; no Phase 13/14 architecture extension**  
Primary objective: **remove every remaining loophole by which the two-stage program could report 100% while scope, coverage, evidence, performance, target-platform behavior, or authority is still incomplete**

This amendment is subordinate to `HEX_MASTER_ARCHITECTURE.md`, accepted later ADRs, versioned public contracts, current source/tests, `ENGINEERING_PROCESS_GUARDRAILS.md`, and `MIGRATION_GUARDRAILS.md`.

Within the two-stage completion planning set, **this amendment wins whenever the base playbook contains weaker wording** such as `where available`, `where required`, `representative`, `may`, or a scope rule that could allow a completion claim without a fixed denominator and exact proof.

The base playbook remains the detailed lane-by-lane execution plan. Read this amendment immediately after it and apply these gates to both Stage 1 and Stage 2.

---

# 0. What this amendment can and cannot guarantee

No finite software test plan can mathematically prove that no undiscovered defect exists for every possible future input or environment.

Therefore Hex MUST NOT use `100%` to mean “omnisciently bug-free forever”.

For this program, `100% complete` has one mechanically checkable meaning:

> **Every item in a frozen, exhaustive declared Phase 1–12 scope has a fixed denominator, an owning implementation, adversarial proof, exact-head and candidate-merge-tree evidence, required target-platform evidence, and no contradictory live issue or support claim. The verifier has no unresolved or unmapped item and cannot be made green by shrinking scope, weakening a corpus, skipping a validator, or silently falling back.**

If that statement is not mechanically true, verdict = `NOT_COMPLETE`.

---

# 1. H1 — Freeze the completion scope; no scope laundering

The base playbook allows an item to become `INTENTIONALLY_OUT_OF_SCOPE` with normative authority. That is necessary for genuinely pre-existing exclusions, but it creates a potential escape hatch if scope is reduced merely because implementation is difficult.

## Mandatory rule

At Stage 1.0 create `completion-scope.lock.json` (exact path may differ, but one machine-readable lock is required) containing:

```text
scopeVersion
baselineCommit
baselineTree
architectureProfiles
architectureInstructionProfiles
formatProfiles
formatVersionFamilies
managedFrontendProfiles
runtimeProviderProfiles
phase12CapabilityProfiles
requiredTargetPlatforms
requiredRealFixtureClasses
requiredIndependentOracleClasses
performanceBudgetVersion
```

After S1-0 passes:

- the completion scope is **growth-only** until final cutover;
- a failure MUST NOT be repaired by deleting an in-scope item;
- a corpus MUST NOT be narrowed;
- an ISA/format/runtime/profile MUST NOT be silently reclassified out of scope;
- `INTENTIONALLY_OUT_OF_SCOPE` is allowed only for exclusions already supported by normative architecture **before the scope lock was frozen**;
- any proposed post-lock scope reduction invalidates the 100% program and requires an explicit architecture/product decision outside this completion campaign, after which the entire scope lock and affected evidence are regenerated and reviewed from scratch.

Examples:

- RV64 A/F/D/Q/V/Zicsr can remain excluded only if the locked normative profile already excludes them;
- an x86 instruction class discovered to be hard cannot be removed from the locked x86 profile;
- a Mach-O relocation class already inside the locked F3/F6 profile cannot be relabeled unsupported to obtain green;
- physical iPad/WebKit cannot be deleted from `requiredTargetPlatforms` because automation is inconvenient.

### Gate H1

Final verifier fails if current scope is a strict subset of the S1-0 locked scope without a full externally reviewed scope-reset event.

---

# 2. H2 — Build a bidirectional, machine-generated closure ledger

A hand-written manifest can still forget an item. The completion manifest must be generated/validated against the repository truth in both directions.

Create a machine-readable ledger with unique stable debt IDs. Each record must include at least:

```text
id
stage
lane
scopeProfile
sourceOfRequirement
owner
changedFileAllowlist
status
blockingDependencies
positiveFixtureIds
negativeFixtureIds
propertyOrFuzzSuiteIds
implementationRefs
testRefs
verifierRefs
supportTruthRefs
runtimeOrPlatformEvidenceRefs
externalOracleRefs
performanceBudgetRefs
issueRefs
proofIdentity
```

Allowed terminal states:

```text
PROVEN
PREEXISTING_NORMATIVE_EXCLUSION
```

`DONE`, `FIXED`, `PASS`, or prose-only terminal states are forbidden.

## Bidirectional completeness checks

The ledger validator MUST fail for:

1. a `Partial`, `Unsupported`, `Unavailable`, limitation code, or incomplete prerequisite in `capability-maturity.js`/support truth that has no ledger owner when the locked completion scope requires closure;
2. a Master Architecture debt item with no ledger mapping;
3. an in-scope decoder opcode/effect family with no ledger mapping;
4. an in-scope native-format feature/version/relocation family with no ledger mapping;
5. an in-scope managed opcode/metadata family with no ledger mapping;
6. a Phase 12 capability/authority level with no ledger mapping;
7. a reproducible open correctness issue with no ledger mapping;
8. a ledger item whose implementation/test/evidence references no longer exist;
9. a promoted support claim with no `PROVEN` ledger item;
10. a `PROVEN` item whose evidence identity does not bind the candidate commit/tree and required inputs.

### Zero-unowned-debt invariant

`unmappedCount === 0` is merge-blocking for Stage 1, Stage 2, and final cutover.

---

# 3. H3 — Freeze the real coverage denominators

A corpus is evidence, not the denominator. Each domain requires a machine-readable denominator derived from the declared profile.

## 3.1 Native instruction semantics

For each native architecture profile, generate/freeze an inventory keyed by decoder/toolchain identity containing every in-scope instruction/effect family.

Each entry must resolve to exactly one state:

```text
EXACT_IMPLEMENTATION + proof
EXPLICIT_PREEXISTING_EXCLUSION
```

There is no third `generic fallback succeeded` state.

The verifier MUST detect:

- decoder recognizes instruction but effects table has no exact owner;
- generic/default effect handler hides an unimplemented instruction;
- alias mnemonic/encoding reaches a different semantic path without proof;
- decoder upgrade expands recognized instruction space without expanding the denominator and invalidating evidence.

For x86-64, the denominator must include locked prefix/implicit-operand/partial-register/vector/system families in the declared profile, not only compiler-emitted corpus samples.

For ARM64/ARM64e, system/atomic/FP-SIMD/PAC families inside the locked profile require explicit effect ownership.

For RISC-V64, only the locked normative extension set is required, but every encoding family inside it is part of the denominator.

## 3.2 Native formats

Freeze a profile matrix for Mach-O, ELF, and PE/PE+ covering all in-scope:

- container/header variants;
- load/section/segment structures;
- import/export forms;
- relocation kinds;
- unwind/debug families;
- runtime/language metadata families;
- rebuild operation classes.

A format row is not complete while an in-scope matrix cell lacks a positive and negative proof.

## 3.3 Managed frontends

Freeze opcode/metadata/version-profile tables for WASM, DEX, CIL, JVM. Every in-scope opcode/metadata family must be implemented and adversarially exercised, or the profile is not 100%.

## 3.4 Phase 12

Freeze schema/authority matrices for:

- package envelope/dependencies;
- recognition outcomes;
- capability-rule result classes;
- pattern grammar/value classes;
- ChangeLog operation/conflict classes;
- rebuild operation/validator classes.

### Gate H3

Every denominator must report `covered == total` at final cutover. A smaller denominator than the scope lock is a hard failure.

---

# 4. H4 — Mandatory fuzz, property, metamorphic, and differential testing

Examples and regressions alone are not sufficient for parser/decoder/semantic/rebuild completion.

For every safety-critical input boundary, add deterministic seeded fuzz/property suites with retained minimized counterexamples.

Required targets:

```text
native decoders/effect lowering
Mach-O / ELF / PE parsers and mapping
relocation/import/export/unwind parsing
Semantic IR construction/validation
alias/points-to invariants
managed container/opcode parsing
pattern parser/evaluator
knowledge/package parser
capability-rule parser/evaluator
ChangeLog/replay/conflict handling
RebuildPlan construction/validation/publication
runtime/provider message parsing
remote collaboration envelopes
project/artifact migration/import
```

Minimum invariant classes:

- no crash;
- no hang/unbounded loop;
- bounded memory/resource use according to declared budgets;
- malformed input never becomes exact/verified authority;
- integer/address arithmetic is checked;
- cancellation settles and late results cannot mutate current state;
- parse/replay/evaluation is deterministic for identical identities;
- serialize/deserialize/reparse round trips preserve the declared canonical meaning;
- differential disagreement blocks exact promotion when the oracle is part of the profile.

Fuzz seeds, generator version, iteration/budget configuration, minimized repro corpus, and external oracle versions must be identity-bound release evidence.

A newly found deterministic counterexample is added permanently to the regression corpus before its fix is accepted.

### Corpus monotonicity

The protected regression/adversarial corpus is growth-only during the campaign. Deleting, weakening, filtering, or changing expected outcomes to obtain green is release-blocking unless the old expectation is independently proven incorrect and the change is explicitly reviewed.

---

# 5. H5 — Prove that the verifier itself fails when protection is removed

A green verifier is weak evidence if nobody proves it can detect the exact failure classes it claims to guard.

For critical gates, add mutation/fault-injection self-tests. At minimum deliberately simulate:

1. one required rebuild validator not executed;
2. one MachineEffects family falling through to default/unknown while support still claims exact;
3. one support-matrix promotion without capability-maturity proof;
4. one stale evidence SHA/tree;
5. one corpus member removed;
6. one hidden legacy fallback activated;
7. one runtime event from a stale/wrong session;
8. one wrong-project/wrong-binary collaboration operation;
9. one interrupted persistence/rebuild atomic publication;
10. one physical-iPad evidence record bound to a different build;
11. one external `verified`/`user-confirmed` string attempting authority promotion;
12. one timeout/partial solver result mislabeled proved.

For each mutation, expected verdict = nonzero failure / `NOT_COMPLETE`.

A verifier that survives its own protection being removed is not release-grade.

---

# 6. H6 — Exact head is necessary but not sufficient: verify the candidate merge tree

Moving `main` can make a PR head green while the merged product is different.

At every stage cutover and final cutover, evidence must bind both:

```text
component/integration HEAD SHA + tree
candidate merge-tree SHA + tree against current live main
```

Required sequence immediately before merge:

```text
resolve current live main
construct/obtain candidate merge tree
verify no ownership/generated-output conflict
run completion verifier on candidate merge tree
run required full product gates on candidate merge tree
record exact identities
merge only that proven candidate
post-merge verify resulting main identity/equivalence
```

If main moves after candidate-merge-tree proof, the proof is stale and must be rerun.

A green old PR head is never final release evidence.

---

# 7. H7 — Physical iPad/WebKit evidence is mandatory for 100%

The base playbook contains conditional wording around physical iPad execution. For a browser/iPad-first product, that is too weak for a final 100% claim.

Final completion MUST include at least one physical iPad/iPadOS/WebKit production-faithful evidence run bound to the exact candidate build/runtime identity.

It must exercise, at minimum:

- app/userscript/runtime activation identity as applicable;
- opening/analyzing a nontrivial binary;
- demand-driven navigation and cancellation;
- worker lifecycle and recovery;
- IndexedDB/project persistence round trip;
- variable-length viewer path where applicable;
- a representative semantic/decompiler workflow;
- memory-pressure-sensitive behavior within the declared product budget;
- any Phase 12 UI path promoted for the release;
- rebuild/runtime capability only if that capability is actually exposed on the tested iPad provider/profile.

Desktop Chromium, jsdom, Node, or simulated UA strings do not replace this gate.

If physical iPad proof cannot be produced for the exact candidate, verdict = `NOT_COMPLETE`, not `SKIPPED`.

The evidence record must include device class, OS/WebKit version, exact app/userscript/build identity, candidate commit/tree, fixture identity, executed scenario IDs, and pass/failure output.

---

# 8. H8 — Real-fixture matrix is mandatory, not “when available”

Synthetic fixtures prove controlled boundaries; they do not prove product behavior on complex real binaries.

Freeze a real-fixture matrix at S1-0 containing at least:

- heavyweight real Mach-O;
- real ELF executable/shared-object cases;
- real PE/PE+ executable/DLL cases;
- WASM;
- DEX;
- CIL/.NET;
- JVM class/JAR;
- stripped and symbol-rich cases where relevant;
- malformed/adversarial generated fixtures remain separate from this real-fixture matrix.

The repository's BattleCats fixture/oracle path should be used when legally/operationally available; if that exact fixture cannot be part of durable CI evidence, substitute another heavyweight real Mach-O but record the reason and fixture identity. The heavyweight Mach-O class itself is not optional.

Every locked real fixture must run through the highest applicable declared pipeline and be retained by stable identity/hash.

A fixture disappearing from storage or becoming unfetchable invalidates release evidence until replaced by an explicitly reviewed equivalent class and the scope lock is updated without reducing coverage.

---

# 9. H9 — Performance and memory are release contracts

The product goal includes speed and iPad viability. Functional correctness alone cannot produce a 100% completion claim.

At S1-0 create a machine-readable performance budget table for representative workload classes, including at least:

```text
initial open / metadata parse
paged byte access
first decode window
navigation to distant address
Semantic IR / CFG / SSA on representative functions
function discovery
Decompiler first useful result
project save/load
worker cancellation settlement
large logical source no-whole-read behavior
pattern/rule evaluation budgets
rebuild validation/publish for promoted profiles
```

For each class record:

- fixture/input identity;
- device/runtime class;
- latency budget;
- peak-memory budget where measurable;
- bytes/read-work budget where relevant;
- cancellation-settlement budget;
- warm/cold-cache policy;
- repetition/statistical policy;
- baseline and target.

Rules:

- thresholds are fixed before the implementation lane attempting to satisfy them;
- a regression cannot be hidden by relaxing the threshold in the same fix PR;
- correctness cannot be traded for speed;
- desktop speed does not substitute for required iPad budgets;
- pathological/large fixtures must remain in benchmark gates;
- CI topology optimization does not count as a production performance fix.

Final verdict fails on any required performance/memory budget miss.

---

# 10. H10 — Prove canonical production-path usage; no hidden fallback

Tests must prove not only output equality but which implementation produced the result.

For every capability promoted from partial/compatibility state, release evidence must record the production path/provider/version that executed.

Add negative/path-identity assertions so that:

- promoted MachineEffects cannot be supplied by a legacy semantic engine;
- generic decompiler does not decode instructions through architecture-private shortcuts;
- provider failure cannot silently invoke a weaker provider;
- rule/pattern failure cannot silently invoke AI guessing;
- rebuild validator failure cannot silently raw-write bytes;
- runtime disconnect cannot silently reuse stale observations;
- Phase 12 package/remote metadata cannot silently mint local authority.

Compatibility/oracle paths may exist, but when used they must produce an explicit compatibility/partial result unless the locked contract explicitly accepts that path.

Final `fallbackCountForPromotedClaims` must equal zero.

---

# 11. H11 — Determinism and flake closure

Critical proof must be repeatable.

For all deterministic components, identical input identities must produce byte-for-byte or canonically equivalent evidence across repeated clean executions.

Before final cutover:

- run critical exact-head verifiers repeatedly from clean state;
- run deterministic replay/rule/pattern/rebuild-plan generation repeatedly;
- ensure ordering does not depend on wall-clock time, worker completion order, object/map iteration accidents, or remote timestamp;
- fail on unexplained flaky pass/fail behavior;
- record deterministic output hashes where appropriate.

A flaky required gate is red, not “probably green”.

---

# 12. H12 — Concurrency, interruption, and crash-consistency fault matrix

Stage 1/2 include several asynchronous/durable systems. Add explicit stress/fault matrices for:

- ArtifactStore/project writes;
- migrations;
- worker cancellation and late completion;
- runtime attach/disconnect/reconnect;
- collaboration duplicate/out-of-order/reconnect delivery;
- package update/removal during analysis;
- rebuild temporary-output validation/publication;
- generated-output build/sync;
- cache invalidation while readers are active.

Fault points must include process/task interruption before and after durable boundaries. After recovery:

- canonical state is either old or new, never torn;
- derived artifacts may be recomputed but cannot masquerade as current if identity changed;
- user/project facts preserve provenance;
- duplicate replay remains idempotent;
- stale results cannot become current.

---

# 13. H13 — Independent proof strategy is mandatory for promoted F6 and other common-mode-risk boundaries

`where available` is too weak for validated rebuild.

For every rebuild profile promoted to F6, require at least one verification path that does not reuse the exact producer implementation for the property being checked.

Preferred order:

1. independent third-party parser/loader/oracle pinned by version/hash;
2. separately implemented internal structural validator with independent code path;
3. platform loader/runtime validation where safe and reproducible.

Hex reparsing its own output with the same producer assumptions is necessary but not sufficient.

If no independent strategy exists for a required property, that rebuild profile cannot be promoted to F6.

The same principle applies to exact instruction semantics, format parsing, and solver/model claims when common-mode risk is material.

---

# 14. H14 — Support-truth projection must be mechanically consistent

At final cutover add a consistency verifier that derives or validates every human/UI support claim from the machine-readable truth.

It must fail when:

- `SUPPORT_MATRIX.md` differs from `capability-maturity.js`;
- UI labels exceed machine truth;
- docs claim support for a partial/unsupported profile;
- a limitation code remains while the UI suppresses it;
- a cumulative level skips an incomplete prerequisite;
- a profile is promoted without matching ledger/evidence identity.

Support docs are projections, never an independent promotion mechanism.

---

# 15. H15 — Final source inventory audit is repository-wide and identity-bound

The final audit is not limited to known owned source paths.

Hash and enumerate the candidate repository file inventory, then audit all semantically relevant current files, including:

```text
js/**
worker/runtime entrypoints
userscript sources/templates/generators
scripts/**
tools/validation/**
tests/**
.github/workflows/**
current capability/support schemas
generated-output policies
```

Required scans/review targets include:

- TODO/FIXME/HACK markers with semantic or release impact;
- `partial`, `unsupported`, `unknown`, `fallback`, `legacy`, `compat`, `skip`, `allowFailure`, `continue-on-error` paths;
- catch-all exception paths that may convert failure to success;
- stale feature flags;
- duplicate semantic implementations;
- unchecked integer/address conversions;
- validator lists whose entries are not actually executed;
- tests excluded from canonical runners;
- workflow path filters that can bypass required gates;
- stale generated artifacts;
- capability declarations without matching tests.

Every hit is either mapped to a `PROVEN` ledger item, justified as a pre-existing normative exclusion, or release-blocking.

---

# 16. H16 — Strengthened final cutover sequence

Final completion requires this exact ordering:

```text
1. freeze final locked scope + denominators
2. ledger unmappedCount == 0
3. all Stage 1 ledger items terminal and proven
4. all Stage 2 ledger items terminal and proven
5. deterministic fuzz/property/metamorphic/differential suites green
6. mutation/fault-injection self-tests prove gates fail when protections are removed
7. real-fixture matrix green
8. performance/memory budgets green
9. physical iPad/WebKit exact-build run green
10. full npm run check + focused suites green
11. all permanent exact-SHA verifiers green
12. final duplicate-aware issue/code/source-inventory audit clean
13. generate support truth from proof; no manual inflation
14. resolve current live main
15. construct candidate merge tree
16. rerun all affected required gates/verifiers on candidate merge tree
17. verify generated outputs zero-diff
18. merge only the proven candidate
19. verify post-merge main identity/equivalence
20. archive immutable release evidence bundle
```

Any identity change between steps 14–19 invalidates the affected proof and returns to the earliest impacted step.

---

# 17. Final machine verdict

The completion verifier MUST emit a single machine-readable verdict with at least:

```json
{
  "verdict": "COMPLETE | NOT_COMPLETE",
  "scopeLockHash": "...",
  "candidateCommit": "...",
  "candidateTree": "...",
  "candidateMergeTree": "...",
  "unmappedCount": 0,
  "unprovenCount": 0,
  "scopeReductionCount": 0,
  "promotedFallbackCount": 0,
  "coverageDenominatorMisses": 0,
  "requiredValidatorMisses": 0,
  "fuzzOrPropertyFailures": 0,
  "mutationSelfTestFailures": 0,
  "realFixtureFailures": 0,
  "performanceBudgetFailures": 0,
  "requiredTargetPlatformFailures": 0,
  "supportProjectionMismatches": 0,
  "releaseBlockingIssueCount": 0,
  "staleEvidenceCount": 0
}
```

`COMPLETE` is legal only when every numeric failure/miss count is zero and every required evidence identity matches the exact candidate/merge product.

There is no `COMPLETE_WITH_WARNINGS` for Phase 1–12 100% cutover.

---

# 18. Additional forbidden shortcuts

In addition to the base playbook, these are release blockers:

- reducing the locked scope after a failure;
- allowing a hand-maintained manifest to omit machine-discoverable debt;
- using line/code coverage percentage as a substitute for semantic-domain denominators;
- calling a compiler corpus “whole ISA coverage”;
- shrinking a fuzz/regression corpus;
- accepting a verifier that has not been mutation/fault self-tested;
- verifying only the PR head when the candidate merge tree differs;
- making physical iPad evidence optional for the final browser/iPad-first product claim;
- marking real heavy fixtures optional;
- relaxing performance/memory budgets in the same change that fails them;
- proving output only while ignoring which fallback implementation produced it;
- treating flaky required tests as green after rerun;
- accepting Hex self-reparse as the only F6 independent validation;
- manually editing UI/docs support above machine-readable proof;
- declaring repository audit complete without a candidate-file inventory and unmapped-hit accounting.

---

# 19. Review checklist for implementation agents

Before an agent says its lane is complete, it must answer **yes** to all applicable questions:

```text
Is the item inside the locked scope?
Is its denominator fixed and complete?
Does the closure ledger own it?
Is the canonical production path proven, not a fallback?
Are positive + minimal negative fixtures present?
Are property/fuzz/metamorphic tests present where applicable?
Does an independent differential/oracle exist where common-mode risk requires it?
Did mutation/fault injection prove the gate catches missing protection?
Are performance/resource budgets met?
Are durable/concurrent interruption cases proven where applicable?
Are exact source/tool/provider/fixture identities recorded?
Does support truth still remain conservative until proof is complete?
Is the exact integration head green?
Will the candidate merge tree be re-proven before merge?
```

Any `no` means the lane is not complete.

---

# 20. End condition

After this amendment, the two-stage program's target is not a subjective percentage.

The only acceptable final state is:

```text
frozen declared scope
+ frozen complete denominators
+ zero unmapped debt
+ zero unproven debt
+ zero hidden promoted fallback
+ zero skipped required validator
+ zero contradictory support claim
+ adversarial/fuzz/property/differential proof
+ verifier mutation/fault proof
+ real fixtures
+ performance/resource proof
+ physical iPad/WebKit proof
+ exact candidate merge-tree proof
+ immutable release evidence
= COMPLETE
```

Anything less is `NOT_COMPLETE`.