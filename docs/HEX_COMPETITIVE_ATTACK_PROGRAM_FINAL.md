# Hex Competitive Attack Program — Flash-Safe Execution Specification

**Status:** canonical execution design for post-Phase-1–12 competitive closure  
**Target executor:** fast implementation agents such as Gemini Flash 3.7  
**Repository:** `rhgrive3/ida-245`  
**Objective:** make Hex measurably stronger than major reverse-engineering tools without weakening semantic truth, conservative safety, provenance, determinism, iPad viability, or support honesty.

> This is not a new Phase 13. It is a precision-and-closure program over the existing architecture.
>
> Start only from freshly fetched live `main` after the separate correctness/hardening lane is merged and required gates are green.

---

## 0. Authority and execution rule

Read and obey, in this order:

1. `AGENTS.md`
2. `GEMINI.md`
3. `docs/ENGINEERING_PROCESS_GUARDRAILS.md`
4. `docs/MIGRATION_GUARDRAILS.md`
5. `docs/HEX_MASTER_ARCHITECTURE.md`
6. `docs/POST_PHASE_COMPLETION_TWO_STAGE_PLAYBOOK.md`
7. `docs/POST_PHASE_COMPLETION_100_PERCENT_HARDENING.md`
8. `docs/SUPPORT_MATRIX.md`
9. `js/platform/capability-maturity.js`
10. current source, tests, open issues, open PRs

Authority is hierarchical, not merely chronological. `POST_PHASE_COMPLETION_100_PERCENT_HARDENING.md` strengthens weaker completion wording but does **not** override Master Architecture, accepted later ADRs, versioned public contracts, current source/tests, Engineering Guardrails, or Migration Guardrails. Do not invent a new architecture when the repository already has a canonical implementation.

### Flash operating protocol

Before editing any subsystem:

```bash
git fetch origin
git status --short
git rev-parse HEAD
git rev-parse origin/main
graft map
graft ask "<exact subsystem/question>" --source
graft callers <symbol> --depth 2
```

Use `graft grep "<literal>"` for exhaustive occurrence checks. If Graft is unavailable, use exact `rg`/`grep` and record that fallback. Never guess a file path, symbol, caller, ownership boundary, test runner, or support claim.

If the working tree is not clean, do **not** stash, reset, clean, overwrite, or absorb unknown work. Identify its owner and move the lane to an isolated worktree/branch. Each writer uses a separate worktree; never switch branches in another worker's worktree. W5 owns a separate integration worktree.

Never force-push `main`, destructively reset a shared integration branch, or use destructive cleanup to resolve a proof failure. Reconcile by reviewed commits/merges/reverts on owned branches.

After **big code changes**, or before handoff when the dependency graph materially changed:

```bash
graft build
```

`graft/` is a local regenerable cache and is never committed merely to prove a change. Do not ask a human for non-semantic implementation choices that can be resolved from repository contracts. Stop and escalate only when authority, semantic ownership, required external proof, or locked scope cannot be resolved safely.

---

## 1. Non-negotiable laws

Every implementation decision follows this order:

**semantic correctness > conservative safety > provenance > precision > readability > performance > coverage breadth**

Hard invariants on the **locked denominators plus every known/minimized reproducible counterexample at the candidate tree**:

- false `NoAlias` = 0
- false `MustAlias` = 0
- false exact indirect-call target = 0
- false exact recovered type = 0
- semantic mismatch = 0
- provenance loss = 0
- promoted hidden fallback = 0
- stale result publication = 0
- unsupported/partial/unknown is never promoted to exact to improve a score

These are release gates over the evidence set, not a claim that unknown future inputs can never reveal a bug.

A prettier or faster wrong answer is a regression.


## 1.1 Code design standard

Flash must prefer explicit, boring, composable code over clever shortcuts. These rules apply to **new or modified semantic paths**; do not mass-refactor unrelated legacy code to satisfy style. An unrelated violation discovered during work becomes owned debt.

- Analysis functions are pure with explicit inputs whenever practical; IO/UI/network stay at boundaries.
- New/modified semantic results are immutable or treated as immutable and identity-bound.
- Use stable semantic IDs, never rendered names/text, as semantic keys.
- Semantic addresses/offsets/file positions that can exceed JS safe-integer range use checked `BigInt` or an existing checked bitvector helper. Explicitly bounded small counters/array indices may remain `Number`.
- Numeric options are validated explicitly; do not use truthiness for valid `0`.
- `catch {}` must not convert an error into silent success. Convert expected failure into explicit partial/unknown status with a reason; rethrow programmer/invariant errors.
- Sort sets/maps before serialization or hashing when order is not semantic.
- Budgets and cancellation are parameters, not hidden globals.
- No mutable singleton analysis state. Cache keys include every identity that can change the result.
- No opaque confidence score may outrank deterministic evidence.
- Comments explain invariants and proof boundaries, not obvious syntax.
- Split modules by semantic ownership, not arbitrary line count. Avoid generic `utils` dumping grounds.
- Public/result schema changes are versioned and migration-tested. Existing versioned exports/contracts are not renamed or deleted inside a component lane; add a versioned path, migrate consumers, then retire only through reviewed integration.
- Prefer one explicit result object over boolean + side-channel diagnostics.

### Single-truth rule

There is one canonical truth per layer:

```text
MachineEffects
→ Semantic IR
→ CFG
→ SSA
→ MemorySSA
→ alias / points-to / summaries
→ type/value facts
→ decompiler projection
→ query/UI/AI
```

Never create a second alias engine, second MemorySSA truth, decompiler-only semantic inference, UI-side mnemonic inference, or AI-generated fact authority.

### Production wiring rule

A capability is not implemented until this path is proven:

```text
producer
→ canonical artifact/fact
→ stable identity + provenance
→ query/API
→ production consumer
→ UI/AI navigation where exposed
```

A new file or passing unit test alone is not completion.

---

## 2. Reuse the existing completion infrastructure

Current repository already contains canonical completion machinery. Extend it; do not duplicate it.

Canonical files include:

- `tools/validation/stage1/verify.mjs`
- `tools/validation/stage2/completion-scope.lock.json`
- `tools/validation/stage2/closure-ledger.json`
- `tools/validation/stage2/verify.mjs`
- `js/platform/capability-maturity.js`
- `js/platform/stage2-capability-maturity.js`
- `js/platform/stage2-profile-evidence.js`

Rules:

1. Do not create a second completion scope lock.
2. Do not create a second closure ledger.
3. Do not create a competing Stage 1/Stage 2 verifier.
4. If current canonical files are structurally insufficient, extend them with a versioned schema migration and backward-compatible tests.
5. Support docs/UI remain projections of machine truth; they never independently promote capability.

---

## 3. Program topology

```text
fresh live main
    │
    ▼
C0  Measurement / denominator / verifier truth
    │
    ├──────────── precision backbone ────────────┐
    │                                            │
    ▼                                            │
C1 Alias/points-to → C2 MemorySSA/value → C3 Types/calls → C4 Decompiler
    │                                            │
    ├────────── parallel closure lanes ──────────┤
    │                 │                │         │
    ▼                 ▼                ▼         │
C-ME MachineEffects  C-SYM Solver    C-X Format/managed/persistence/plugin
    │                 │                │         │
    └─────────────────┴────────────────┴─────────┘
                              │
                              ▼
                    Stage 1 exact cutover
                              │
                              ▼
                    Stage 2 authority closure
              runtime / rebuild / knowledge / remote
                              │
                              ▼
                    competitive victory gate
```

The precision backbone `C1 → C2 → C3 → C4` is sequential. Independent ownership lanes can run in parallel. Do not reorder the backbone to improve visible pseudocode before its proof sources exist.

`C*` labels are **campaign wave IDs only**. They intentionally do not reuse the repository's existing Stage 1 verifier gate IDs `A1..A9` or ledger IDs such as `S1-A2-NATIVE`. Never rename existing repository gate/ledger IDs to match this document.

---

## 4. Worker topology

Use six fixed **logical roles**. If the execution harness has fewer/no parallel workers, run the same roles sequentially; do not collapse writer/reviewer/oracle authority merely for speed.

| Worker | Role | Write permission |
|---|---|---|
| W1 | precision backbone | assigned C1→C4 paths only |
| W2 | MachineEffects closure | assigned architecture/effects paths only |
| W3 | disjoint closure | one of solver/format/managed/persistence/plugin at a time |
| W4 | adversarial reviewer | **read-only** |
| W5 | sole integration owner | integration-owned shared files/generated output |
| W6 | independent oracle/benchmark/fuzz/profiling/competitor research | predeclared non-production oracle paths (`tests/**`, `tools/validation/**`, `tools/decompiler/**` adapters/corpus manifests); no `js/**` production semantics unless explicitly reassigned |

Rules:

- One writer per shared semantic contract.
- W4 does not repair its own findings; it reports minimal counterexamples.
- W6 must not implement the production logic it benchmarks. If explicitly reassigned to production `js/**`, it cannot author/score the benchmark for that same logic. This reduces common-mode bias.
- Competitor research uses public source/API/documentation or properly licensed local tools only. Never use leaked/private code or copy license-incompatible implementation. Record tool/version/source identity for every external oracle.
- W5 alone reconciles moving `main`, regenerates shared artifacts, edits shared release/support truth, and accepts components.
- Worker reports are not proof. W5/W4 re-open the diff, run commands, and verify identities.

---

## 5. Branch and PR topology

Use one authoritative integration branch for the current stage.

```text
main
└─ completion/stage1-integration
   ├─ stage1/attack-foundation
   ├─ stage1/precision-alias
   ├─ stage1/precision-memory
   ├─ stage1/precision-types
   ├─ stage1/precision-decompiler
   ├─ stage1/effects-<arch>
   └─ stage1/closure-<domain>
```

Component PRs target `completion/stage1-integration`, not `main`.

Integration-owned by default:

- `package.json`
- shared workflows
- completion scope/ledger
- support/capability projection
- generated userscript/output
- release/build identity
- shared public entrypoints with cross-lane conflicts

Do not hand-merge generated output. Regenerate it from reconciled source.

---

## 6. Definition of Ready — required before coding

Each lane must record exactly these ten items:

1. `baseSha`
2. owner
3. changed-file allowlist
4. canonical producer
5. canonical consumers
6. positive fixture
7. minimal negative counterexample
8. frozen metric + denominator + regression tolerance from C0
9. partial/unknown fallback behavior
10. canonical focused runner + integration dependency

If semantic ownership or denominator is unresolved, the lane is not ready.

### 6.1 Flash implementation loop

For each owned change, use this exact loop:

```text
1. reproduce the missing precision/bug with the smallest test
2. prove the current test fails for the intended reason
3. trace canonical producer → consumers with Graft/callers
4. make the smallest source change that fixes the proof boundary
5. run the new focused test
6. run nearest negative/property/metamorphic tests
7. inspect actual diff and changed-file ownership
8. run the lane canonical runner
9. rebuild Graft only after big dependency-changing edits or before handoff
10. hand exact SHA + commands + evidence to W4/W5
11. W5 proves the candidate integration tree before acceptance
```

Do not combine unrelated cleanup/refactors with a precision change. If a prerequisite refactor is required, land it first as behavior-preserving evidence with its own tests.

Component lanes may add focused tests but do not edit integration-owned `package.json` merely to register them. Run the test directly on the component; W5 wires it into the canonical runner at integration after ownership review.

---

# C0 — Attack Foundation / Measurement Truth

## 7. Goal

Create trustworthy measurement before changing production semantics. C0 must not intentionally change analysis answers.

## 8. Existing infrastructure to preserve

Inspect before editing:

- `tools/validation/stage1/verify.mjs`
- `tools/validation/stage2/completion-scope.lock.json`
- `tools/validation/stage2/closure-ledger.json`
- `tools/validation/phase7/scoring.mjs`
- `tools/validation/phase7/metrics.mjs`
- `tools/validation/phase8/metrics.mjs`
- `tests/phase7/corpus/**`
- `tests/phase8/corpus/**`
- `tools/validation/machine-effects/**`
- existing Ghidra differential workflow/tests

Do not replace existing historical Phase 7/8 baselines. New scoring is additive and versioned.

## 9. Deliverables

### C0.1 Freeze identities

Record:

- live baseline commit/tree
- toolchain versions
- architecture decoder identities
- compiler corpus generator versions
- fixture SHA-256
- Ghidra/reference tool versions
- runtime/hardware class for performance results

Use the existing completion scope lock for **Phase 1–12 completion/support scope only**. Competitive metrics/workloads live in the versioned competitive profile from C0.4; that profile is benchmark configuration, not a second completion scope lock. Extend the completion lock only when proving an existing locked capability genuinely requires a new denominator field, and only through reviewed schema/version migration.

### C0.2 Alias scoring v2

Keep `tools/validation/phase7/scoring.mjs` v1 behavior intact for historical regression evidence.

Add a versioned v2 scorer with these fields:

```text
queryCount
exactAvailable
exactClaimed
exactCorrect
exactPrecision = exactCorrect / exactClaimed
exactRecall    = exactCorrect / exactAvailable
mustAvailable / mustCorrect
noAliasAvailable / noAliasCorrect
mayAvailable / mayCorrect
unknownCount
falseMustAlias
falseNoAlias
unknownReasonCounts
```

Division-by-zero is represented as `null`, never fake `0` or `1`.

The old `3/16 = 0.1875` metric remains historical; it is not a target because only three old queries contain exact truth.

### C0.3 Alias v2 ground-truth corpus

Add growth-only cases covering at minimum:

- same stack object / same field
- same stack object / disjoint fields
- different stack objects
- same global / different globals
- exact absolute addresses
- same/different allocation sites
- overlapping/disjoint offset intervals
- PHI same-root merge
- PHI different-root merge
- loop-carried pointer
- escaped object
- non-escaped object
- pointer stored then loaded
- pointer returned by direct callee
- recursive return-pointer summary
- exhaustive indirect candidate set
- incomplete indirect candidate set
- unknown store barrier
- unknown call barrier
- TLS identities

Every query explicitly declares truth as `must`, `no`, or `may` and records `truthSource`. Accepted truth sources are deterministic fixture construction, source-level object/layout truth, authoritative debug metadata used only as oracle, or a manually reviewed mathematical relation encoded independently from the Hex solver. A query without independent authoritative truth is not included in exact recall. The production alias solver must never be used to generate its own expected answer.

Reference-tool disagreement is diagnostic only. Ghidra/IDA/BN output never becomes alias ground truth.

W6 may inspect Ghidra/Rizin/angr/Triton public source and Binary Ninja/IDA/Frida/JADX/ILSpy/ImHex/capa/BinDiff/Diaphora public APIs/source where legally available. External architecture/algorithms may inform Hex design; implementation is independently written against Hex contracts.

### C0.4 Competitive scorecard pipeline

Create one validation namespace, not a hand-written result file:

```text
tools/validation/competitive/profile.json
tools/validation/competitive/score.mjs
tools/validation/competitive/verify.mjs
tools/validation/competitive/report.mjs
reports/competitive/scorecard.json
reports/competitive/scorecard.md
```

If equivalent files already exist, extend them instead. W5 owns ignore/artifact policy for generated reports; do not commit exact-run evidence merely to make it discoverable.

Pipeline:

```text
frozen profile
→ Hex runner
→ independent reference runner
→ normalized metrics
→ scorecard.json
→ verifier
→ scorecard.md projection
```

Each metric stores:

```text
metricId
corpusId
inputIdentity
functionIdentity or null
hexVersion
referenceTool
referenceVersion
configuration
runtimeClass
runPolicy / repetitionCount
hexValue
referenceValue
comparison: WIN | TIE | LOSS | UNMEASURED
evidenceRefs
```

`UNMEASURED` is not failure for Hex's own release. It blocks a competitor-surpassed claim.

**Committed truth:** profile/schema/metric definitions and any intentionally versioned thresholds.  
**Run evidence:** `scorecard.json`/`.md`, exact candidate identity, wall-clock samples, and reference-tool outputs are generated CI/local artifacts and must not dirty the exact head they prove. W5 ensures their output location follows repository ignore/artifact policy and CI uploads them when required.

Deterministic semantic evidence may be canonical-hashed. Wall-clock/peak-memory evidence is compared against frozen budgets for its runtime/device class; it is never required to be byte-for-byte identical across machines.

A competitive row is comparable only when binary SHA-256, function identity set, ground-truth definition, configuration, and required runtime/hardware class match. Otherwise emit `UNMEASURED`.

### C0.5 Canonical Stage 1 verifier strengthening

Extend `tools/validation/stage1/verify.mjs`; do not create a second Stage 1 verifier. Preserve its existing `A1..A9` gate identity unless a reviewed versioned migration changes that public evidence vocabulary. It must validate the Stage 1 subset of the canonical scope/ledger in addition to running product gates.

It must enforce bidirectional completeness for the locked Stage 1 subset and fail when any of these lacks an owned mapping:

1. capability truth that is `Partial`/`Unsupported`/`Unavailable` or carries a closure-relevant limitation;
2. Master Architecture debt in locked Stage 1 scope;
3. in-scope decoder opcode/effect family;
4. in-scope native-format feature/version/relocation family;
5. in-scope managed opcode/metadata family;
6. Phase 12 capability/authority row that Stage 1 depends on;
7. reproducible open correctness issue contradicting a locked claim;
8. implementation/test/evidence reference required by a ledger item.

It also fails when:

- a promoted support claim has no matching `PROVEN` ledger item;
- `PROVEN` evidence does not bind candidate commit/tree/input identities;
- a locked denominator shrinks;
- `unmappedCount != 0`.

Reuse the canonical `tools/validation/stage2/completion-scope.lock.json` and `closure-ledger.json` for Phase 1–12 completion truth. Do not place competitive score/performance targets into the completion ledger merely because this campaign measures them; those belong to `tools/validation/competitive/profile.json`. Version-migrate the completion lock only for missing denominators required to prove an existing locked capability. Never add a second completion lock/ledger. Do not overwrite the frozen baseline merely because `main` advanced. Scope reset follows H1 only.

The current Stage 1 workflow verifies PR HEAD and has narrow path filters; that is insufficient for this campaign. Strengthen `.github/workflows/stage1-release-validation.yml` in the W5 integration lane so Stage 1 proof cannot be bypassed:
- add a candidate-merge-tree job analogous to Stage 2 and verify the synthetic integration tree, not only PR HEAD;
- make trigger coverage complete for every Stage 1-owned semantic/analysis/decompiler/format/managed/platform path, or replace fragile path filtering with an integration-branch gate that cannot silently skip;
- add a workflow/verifier self-test proving a required-path change cannot bypass Stage 1 verification.

Repository verifiers remain deterministic/offline. W5 obtains the live open-issue inventory outside the verifier at integration/cutover, records repository/query/capture identity as external evidence, and maps every reproducible correctness issue contradicting a locked claim. The verifier validates supplied evidence/mappings; it does not perform unbounded live network discovery.

### C0.6 Frozen quality/performance policy

Before C1–C4 source changes, freeze in `tools/validation/competitive/profile.json`:

- metric direction (`higher`/`lower`/exact-zero);
- corpus/workload IDs;
- regression tolerance;
- runtime/device class;
- repetition/cold-warm policy;
- which deterministic metrics block generic CI;
- which wall-clock/memory metrics require the dedicated/device-class runner.

A tolerance or workload change is a separate reviewed baseline-policy change and cannot be bundled with the implementation that benefits from it.

### C0.7 Verifier self-tests

Mutation tests must prove red when at least these protections are removed:

- corpus item deleted
- ledger item/owner removed
- false `NoAlias` accepted
- false `MustAlias` accepted
- exact claim loses evidence identity
- score denominator shrinks
- support claim exceeds machine truth
- legacy/fallback path supplies a promoted result
- required Stage 1 source path bypasses the Stage 1 workflow
- exact-run report is accidentally required as a committed dirty-head artifact

## 10. C0 acceptance

Run focused validation, then current canonical stage verifier. C0 passes only when:

- no production semantic answer intentionally changes
- v1 historical metrics remain reproducible
- v2 denominator is fixed and growth-only
- scorecard is generated by code and verified
- mutation tests prove guards turn red
- exact identities are recorded
- metric directions and regression tolerances are frozen before C1–C4 production changes
- Stage 1 workflow proves the candidate merge tree and cannot be skipped by a required-path change

---

# C1 — Alias / Points-to / Interprocedural Precision

## 11. Canonical source map

Primary implementation:

- `js/analysis/alias/**`
- `js/analysis/pointsto/lattice.js`
- `js/analysis/pointsto/local.js`
- `js/analysis/pointsto/alias.js`
- `js/analysis/summary/contract.js`
- `js/analysis/summary/local.js`
- `js/analysis/summary/escape.js`
- `js/analysis/summary/interprocedural.js`
- `js/semantics/compat/index.js` — canonical Semantic-v2 orchestration owner for bounded refinement

Primary proof/tests:

- `tests/phase7/alias/**`
- `tests/phase7/pointsto/**`
- `tests/phase7/summary/**`
- `tests/phase7/negative/**`
- `tests/phase7/crossarch/**`
- `tools/validation/phase7/**`

Do not create a parallel alias or points-to engine.

## 12. Architectural design

The existing local points-to analysis deliberately treats loads and calls as unresolved boundaries. Preserve that safety model and refine it with **proven boundary facts**, not heuristics.

### C1.1 Boundary fact contract

Introduce or extend one canonical boundary-fact contract. A boundary fact must contain:

```text
valueId
pointsToSet
proofKind
completeness
evidenceIds
producerIdentity
```

Allowed exact `proofKind` sources:

- canonical address/root proof
- exact MemorySSA reaching store
- complete callee return summary
- authoritative allocation/global/TLS identity

A missing, stale, partial, contradictory, budget-limited, non-exhaustive, or cancelled producer yields no exact boundary fact.

### C1.2 Points-to identity classes

A static allocation site is **not** a dynamic object identity. If the points-to target schema is extended, version the target/lattice/analyzer/artifact contract and represent identity multiplicity explicitly, e.g.:

```text
singleton          stable one-object identity in the current proof context
fresh-instance-class  instances created by one allocation site
summary-class      merged/unknown multiplicity
```

`MustAlias` eligibility requires proof of the same dynamic identity or a stable singleton root. Equal allocation-site classes across independent calls cannot prove `MustAlias`.

`NoAlias` is not obtained from different names/site IDs alone:
- allocation roots need freshness/lifetime/non-escape/context proof sufficient to establish distinct live storage;
- globals need exact non-overlapping storage/mapping identity;
- TLS needs the required thread/module identity, otherwise stay conservative.

### C1.3 Load boundary

A pointer load can be refined only when all are true:

1. MemorySSA identifies one `reachingConcreteStore` (`must` alias + `memory-def`).
2. The store's value has a non-top points-to set.
3. width/cast semantics preserve the pointer representation required by the current profile.
4. no volatile/atomic/device/ordering rule invalidates substitution.
5. proof identities bind the same analysis snapshot.

Otherwise retain `unresolved-load`/partiality.

### C1.4 Call-return boundary

Extend function summaries with pointer-return facts only when proven.

Use a small parametric vocabulary:

```text
argument-root(argIndex, offsetRange)
allocation-site-class(functionId, siteId, offsetRange)
global-root(rootIdentity, offsetRange)
tls-root(rootIdentity, offsetRange)
absolute(address, offsetRange)
unknown
```

Rules:

- all reachable returns must be accounted for;
- contradictory return roots collapse to safe union/unknown, never arbitrary selection;
- an incomplete indirect call candidate set is `join(candidate facts, unknown)`;
- a complete candidate set may be joined without the extra unknown only when exhaustiveness is proven;
- recursive SCC summaries use deterministic fixed point and widening/budget rules already used by the summary subsystem.

Current `functionSummaryDigest()` does not hash `returnValues`/allocation facts. Therefore any new return-points-to semantics **must not** be added without invalidation changes.

If structured return-pointer facts change the summary schema:
- bump `FUNCTION_SUMMARY_SCHEMA_VERSION` / contract/analyzer versions;
- make `functionSummaryDigest()` cover every summary field that can change downstream semantics, including new return-pointer facts and any existing return/allocation/escape/call fact actually consumed downstream;
- add mutation tests proving each semantically consumed field changes the digest and invalidates dependent caller artifacts;
- migrate old schema explicitly or invalidate/recompute it; never silently reinterpret old summaries.

### C1.5 Bounded refinement rounds

Do not create an uncontrolled cycle:

`points-to → alias → MemorySSA → loaded-pointer facts → points-to`.

Refinement orchestration belongs in the current Semantic-v2 integration owner (`js/semantics/compat/index.js` or its reviewed successor), **not** in circular imports between points-to and MemorySSA.

Use immutable numbered rounds:

```text
R0:
  canonical addresses
  → local points-to/alias with no MemorySSA boundary facts
  → MemorySSA0
  → summaries0

R1:
  derive exact boundary facts from R0
  → points-to/alias1
  → MemorySSA1
  → summaries1

R2:
  run only if R1 produced a strict superset of exact facts
  and contradicted no prior exact fact
```

Hard cap: two refinement rounds after R0 unless a later reviewed contract changes it. Intermediate R0/R1 artifacts do not escape as final truth unless explicitly marked partial/provisional. Boundary-fact snapshot identity uses the repository's canonical artifact/snapshot identity mechanism, not ad-hoc unversioned fields. If not converged, publish partial/truncated with a deterministic reason.

### C1.6 Context sensitivity

Add context sensitivity only after context-insensitive v2 scoring is stable.

Use bounded demand-driven contexts keyed by stable semantic identity, not rendered names. A context must include only information needed to distinguish proven pointer roots/ABI behavior. Cap context count and merge excess contexts conservatively.

Do not clone entire concrete caller state.

## 13. C1 proof requirements

For every new exact result add:

- positive fixture
- closest aliasing counterexample
- incomplete-evidence counterexample
- cancellation/budget case
- deterministic replay

Required targeted negatives include:
- two dynamic objects from the same static allocation site across independent calls cannot become `MustAlias`;
- different allocation-site names alone cannot become `NoAlias`;
- TLS without sufficient thread/module identity stays conservative;
- return-summary digest/schema change invalidates caller analysis.

Required metamorphic laws:

- variable renaming does not change alias result
- block order serialization does not change result
- equivalent constant address arithmetic preserves result
- adding unknown provenance cannot make a result more exact
- widening/budget exhaustion cannot create `NoAlias` or `MustAlias`

## 14. C1 acceptance

Hard gates:

```text
falseNoAlias = 0
falseMustAlias = 0
semantic mismatch = 0
unknown-to-exact without proof = 0
```

Quality is evaluated against the C0-frozen metric vector and tolerances. C1 is accepted only when:
- at least one frozen quality metric strictly improves **or** a locked owned debt reaches its required terminal proof;
- no frozen regression budget is violated;
- exact precision remains 1.0 on the locked evidence set.

W4/W5 cannot waive a frozen numerical gate. Changing a denominator/tolerance requires a separate baseline-change review before the production change.

---

# C2 — MemorySSA / Load-Store Forwarding / Value Reasoning

## 15. Canonical source map

Memory truth:

- `js/semantics/memoryssa/build.js`
- `js/semantics/memoryssa/contract.js`
- `js/semantics/memoryssa/queries.js`
- `js/semantics/memoryssa/validate.js`

Integration/consumer surface:

- `js/decompiler/semantic.js`
- `js/decompiler/pipeline-core.js`
- `js/decompiler/phase8/valuenumber.js`
- `js/decompiler/phase8/sccp.js`
- `js/decompiler/phase8/range.js`
- `js/decompiler/phase8/dce.js`

Never recompute alias or reaching-memory truth inside a decompiler pass.

### C2.0 Canonical fact seeding prerequisite

Current Semantic-v2→v1 compatibility already projects canonical MemorySSA into `memUse`, but Phase 8 analysis state does not seed `memorySsa` and value-numbering's descriptor does not declare that memory dependency. Fix this **dependency/authority visibility**, not the semantics by inventing a second memory representation.

Before adding forwarding:

- the semantic-function pipeline makes the canonical Semantic-v2 `memorySsa` (or a formally versioned, validated read-only projection of it) available through Phase 8's analysis-state/dependency mechanism;
- Phase 8 passes consume memory proof through that one declared authority;
- any pass using memory proof declares `memorySsa` in `consumes` (and alias/effects only if directly read);
- existing projected `memUse` may remain as a compatibility/view of the same canonical MemorySSA, but must never diverge or be independently inferred.

Prefer extending the existing value-number/reuse result if its versioned contract cleanly represents store-forward candidates. Create a new analysis key/pass only when the existing contract cannot represent the fact without ambiguity. Pass order follows stage + declared dependencies, never accidental list order.

## 16. Memory forwarding design

`reachingConcreteStore()` is the canonical starting proof. Extend MemorySSA queries only when the existing query lacks a required semantic condition.

A load may forward a stored value only when:

1. the load has one exact reaching concrete store;
2. location identity and access width are compatible;
3. ordering/volatile/atomic/device semantics permit substitution;
4. no unknown call/store barrier invalidates the relation;
5. source value dominates or is represented through valid SSA use-def;
6. type presentation is not used as proof of memory equality.

Expose a proof object rather than a boolean when consumers need an explanation:

```text
loadId
storeId
valueId
memoryUseId
memoryDefinitionId
aliasRelation = must
proofKind
origin/evidence IDs
```

The query can return `null`; consumers must treat `null` as no forwarding permission.

## 17. Value domain design

Extend the existing Phase 8 domain instead of creating another optimizer.

### C2.1 Wrapped range

Keep `js/decompiler/phase8/range.js` as the canonical wrapped bitvector range implementation.

Add precision only through sound operators. If an operator cannot be represented safely, return full range + reason.

Priority operators:

1. constant shifts
2. constant multiply with overflow-aware wrapped result
3. unsigned/signed comparison refinement
4. mask-derived facts
5. remainder/congruence facts

### C2.2 Congruence

Extend the existing Phase 8 scalar-fact result with a small product-domain component; do not introduce a second independent value-analysis pipeline. Add a congruence fact:

```text
x ≡ remainder (mod modulus)
```

Use `modulus = 1` for no useful congruence. Normalize deterministically. Join/widen must over-approximate.

### C2.3 Branch refinement

Represent branch facts per CFG edge or block-entry fact set. Do not mutate the global value truth to a path-specific answer.

Examples:

```text
if (x != 0) true-edge → excludes zero
if (x < 10) true-edge → signed/unsigned range refinement according to operator
if ((x & 3) == 0) → congruence when mathematically valid
```

A merge joins incoming facts conservatively.

### C2.4 Relational facts

Start with bounded difference relations only when directly derived:

```text
y = x + c
y = x - c
```

Do not build an unrestricted theorem prover in the decompiler. If relational closure exceeds the fixed budget, discard the extra relation rather than invent certainty.

## 18. C2 pass ordering

Keep the Phase 8 staged architecture:

```text
SCCP/range facts
→ alias-proved load forwarding
→ GVN/CSE
→ effect-aware DCE
→ loop/induction consumers
```

Cross-stage feedback is explicit and bounded. No uncontrolled `range → induction → types → range` loop.

C-SYM is not a prerequisite for ordinary C4 decompiler quality. Solver results may authorize a specific proof-backed transformation when available, but C1→C4 must remain valid without production-solver completion.

## 19. C2 acceptance

Required negatives:

- unknown store between store/load
- unknown call between store/load
- may-alias store
- mismatched width
- volatile/atomic/device memory
- non-dominating value
- loop-carried ambiguous memory

All must block unsafe forwarding.

Quality metrics:

- exact reaching-memory-definition correctness
- newly proven forwardable loads
- reduced redundant loads/temporaries downstream
- no semantic-equivalence regression

---

# C3 — Types / Prototypes / Aggregates / Function Discovery

## 20. Canonical source map

Type truth:

- `js/analysis/types/constraints.js`
- `js/analysis/types/graph.js`
- `js/decompiler/type-recovery.js`
- `js/decompiler/types/high-variables.js`
- `js/decompiler/types/layout.js`
- `js/decompiler/types/prototype.js`
- `js/decompiler/call-prototypes.js`

Discovery:

- `js/analysis/discovery/candidates.js`
- `js/analysis/discovery/producers.js`
- `js/analysis/discovery/fusion.js`

Debug authority:

- `js/analysis/debug/dwarf.js`
- `js/analysis/debug/pdb.js`
- `js/analysis/debug/provider.js`

## 21. Type authority model

Keep these domains separate:

```text
MachineType
ABIType
RecoveredStructuralType
NominalLanguageType
```

Rules:

- hard constraints can establish `certain` only when non-contradictory and analysis status is complete;
- soft evidence ranks candidates but cannot create certainty;
- contradictory hard constraints withhold selection;
- rendering preferences never become type evidence.

### C3.1 New hard constraints

Add only facts with deterministic authority, for example:

- access width
- ABI location
- authoritative DWARF/PDB type
- complete call prototype
- runtime metadata with verified binary/module identity
- pointer stride where the arithmetic proof is exact
- user-approved declaration

Do not convert aggregate heuristics, naming, common compiler patterns, or AI output into hard constraints.

### C3.2 Prototype propagation

Interprocedural prototype propagation requires:

- complete/known callee identity or explicit candidate set semantics;
- ABI-specific argument/return mapping through `js/targets/abi/**`;
- contradiction preservation;
- recursive SCC fixed point with deterministic cap.

Unknown callees do not inherit the most common prototype.

## 22. Aggregate recovery design

Current aggregate recovery is intentionally candidate-based. Preserve ambiguity.

Ground-truth corpus uses paired artifacts from the same source/configuration:

```text
source declarations
+ one debug-rich binary per compiler/arch/opt configuration
+ stripped twin derived from that exact binary
+ preserved pre-strip function/address mapping identity
```

If tooling forces separate outputs, executable code-section hashes must prove code identity before the pair is accepted. Debug/source truth is oracle-only and is never passed into stripped recovery.

Candidate evidence can include:

- exact offsets/widths
- MemorySSA access patterns
- pointer root/field provenance
- induction stride
- range facts
- complete prototypes
- authoritative nominal metadata

Conflicting widths/nominal types remain contradictions. Never choose one candidate merely because it scores highest.

Metrics:

- field offset precision/recall
- field width precision/recall
- aggregate kind precision/recall
- false confirmed layout = 0

## 23. Function discovery and indirect targets

Fuse evidence; do not replace one producer with heuristics.

Sources include:

- symbols
- unwind/function metadata
- exports
- direct call targets
- relocation targets
- debug metadata
- runtime/language metadata
- validated instruction/CFG heuristics

Measure separately:

```text
function-start precision/recall
function-extent precision/recall
indirect-target precision/recall
```

An indirect target set is exact only when completeness is proven. Otherwise retain candidate-set + unknown semantics.

## 24. C3 acceptance

Hard gates:

- false exact type = 0
- forced hard contradiction selection = 0
- false exact indirect target set = 0
- debug/runtime identity mismatch cannot promote authority

Quality must improve on held-out type/aggregate/discovery corpora without degrading exact precision.

---

# C4 — Decompiler Quality

## 25. Canonical source map

- `js/decompiler/pipeline.js`
- `js/decompiler/pipeline-core.js`
- `js/decompiler/phase8/**`
- `js/decompiler/rewrite/**`
- `js/decompiler/types/**`
- `js/decompiler/pretty/c.js`
- `js/decompiler/provenance.js`
- `js/decompiler/verify/equivalence.js`

Existing Phase 8 passes are the implementation surface. Do not create a second decompiler pipeline.

## 26. Transformation contract

Every semantics-changing or structure-changing pass must:

1. declare consumed facts;
2. declare preserved/invalidated facts;
3. stage changes transactionally;
4. publish only after validation;
5. preserve provenance mapping;
6. fail closed on cancellation/budget/exception;
7. replay deterministically.

Canonical Semantic IR/SSA/MemorySSA are not mutated merely to make pseudocode prettier.

## 27. Improvement order

Improve consumers in this order:

1. alias-proved load/store forwarding
2. scalar constant/copy propagation
3. GVN/CSE precision
4. effect-aware DCE
5. high-variable/coalescing quality
6. prototype/call rendering
7. aggregate/array/union projection
8. loop/induction simplification
9. switch recovery
10. tail-call/thunk normalization
11. exception/irreducible structuring
12. compiler/language idioms

Do not implement a later heuristic to hide missing earlier proof.

## 28. Semantic vs presentation scoring

Keep two verdict classes.

### Hard semantic gate

- semantic mismatch
- provenance loss
- unknown→exact promotion
- incorrect side-effect removal
- incorrect memory reuse

Any nonzero count rejects the change.

### Quality vector

Track without turning it into unsound hard targets:

- semantic coverage
- raw assembly fallback
- structured functions
- unnecessary temporaries
- unnecessary casts
- avoidable gotos
- recovered prototypes
- recovered aggregate fields
- first-useful-result latency

A goto is not a failure when it is the safest faithful structure.

Decompiler correctness is never scored by pseudocode text similarity. Use semantic equivalence/ground truth for correctness; presentation metrics are separate.

## 29. C4 acceptance

Compare before/after on the same frozen and held-out corpora. Accept only when semantic gates remain perfect, at least one frozen quality metric strictly improves or a locked owned debt closes, and no C0-frozen regression budget is violated.

---

# C-ME — Exact MachineEffects Closure

## 30. Scope

Only current locked profiles:

- ARM64
- ARM64e
- x86-64
- RISC-V64 locked profile

No new ISA until these profiles close their locked A2 denominator.

Primary files:

- `js/targets/architecture/coverage.js`
- `js/targets/architecture/**`
- architecture effect modules used by those plugins
- `js/semantics/effects/**`
- `js/semantics/ir/from-machine-effects.js`
- `tests/machine-effects/**`
- `tests/stage1/a2-machine-effects-coverage.test.mjs`
- `tools/validation/machine-effects/**`

## 31. Denominator rule

Current `machineEffectsCoverageDescriptor()` reports observed decoded instructions. H3 requires a locked declared-profile denominator. Do not confuse observed corpus coverage with whole-profile completion.

For each locked instruction/effect family there are only two valid terminal states:

```text
EXACT_IMPLEMENTATION + proof
PREEXISTING_NORMATIVE_EXCLUSION
```

No generic fallback, post-lock scope deletion, or compiler-corpus absence counts as coverage.

A `PREEXISTING_NORMATIVE_EXCLUSION` must already be present in the frozen authority/scope before implementation begins. Creating a new exclusion to make a failing family disappear requires the formal H1 scope-reset review and is never part of the same implementation PR.

## 32. Proof per family

Exercise every category that exists in the locked family/profile; record non-applicable categories explicitly in the denominator evidence:

- encoding variants
- implicit reads/writes
- flags/condition state
- partial register semantics
- memory address/width
- ordering/barriers/atomics
- traps/control flow
- FP/SIMD
- system state
- malformed/invalid negatives

Use independent oracles in `tools/validation/machine-effects/**` where common-mode risk exists. Differential disagreement blocks exact promotion until explained.

---

# C-SYM — Solver / Symbolic Proof Closure

## 33. Canonical source map

Preserve the Phase 9 architecture:

- `js/symbolic/expr/**`
- `js/symbolic/translate/**`
- `js/symbolic/solver/backend.js`
- `js/symbolic/solver/registry.js`
- `js/symbolic/solver/session.js`
- `js/symbolic/solver/result.js`
- `js/symbolic/solver/exhaustive-backend.js`
- `js/symbolic/solver/worker-backend.js`
- `js/symbolic/verify/**`
- `tests/phase9/**`
- `tools/validation/phase9/**`

The existing exhaustive backend remains the exact small-domain reference. Do not replace the symbolic DAG, result taxonomy, proof-authority boundary, or model validator.

## 34. Production backend adapter

A new production backend plugs into the existing backend/registry contract. It does not bypass `SolverSession` or return tool-native objects to consumers.

Required normalized outcomes:

```text
SAT
UNSAT
UNKNOWN
TIMEOUT
CANCELLED
UNSUPPORTED
ERROR
```

Proof authority rules:

- `SAT` is proof-bearing only after the returned model passes Hex's independent model validation for the translated query.
- `UNSAT` is proof-bearing only from a backend explicitly classified as proof-authoritative for that query class and after all translator/precondition checks pass.
- `UNKNOWN`, `TIMEOUT`, `CANCELLED`, `UNSUPPORTED`, and `ERROR` never become proof.
- heuristic/fake backends never acquire proof authority.
- late worker results cannot publish into a newer session/snapshot.

## 35. Backend capability matrix

Each backend declares deterministic capability metadata:

```text
bitvector widths
arrays / symbolic memory
supported operations
model production
incremental sessions if present
cancellation/timeout behavior
browser/worker availability
deployment/license identity
```

The translator checks capability before dispatch. Unsupported expressions return explicit unsupported/unknown status; they are not rewritten into easier expressions unless the rewrite is equivalence-proven.

A backend adapter cannot claim semantics the canonical symbolic DAG/translator cannot express. If arrays or symbolic memory are added, version and test the full chain:
- expression sort/kind schema;
- factory/hash/serialization/evaluation;
- translator;
- byte-addressed memory model with explicit target endianness;
- artifact/schema migration or invalidation.

Unsupported FP/memory operations remain `UNKNOWN`/`UNSUPPORTED` until exact DAG + translator semantics exist.

For browser/iPad deployment, choose a backend only after confirming package/license/WASM/worker feasibility. External unavailability does not block unrelated Stage 1 lanes and does not justify a false support promotion.

## 36. Cross-proof strategy

For the domain where the exhaustive backend is tractable, run the same query through both backends and require agreement on SAT/UNSAT. For SAT, validate both models. Retain disagreement as a release-blocking minimized counterexample.

Use the production backend for:

- edge feasibility
- bounded equivalence
- patch verification
- targeted alias disambiguation only where translator semantics are complete
- later deobfuscation proofs

Do not turn whole-program symbolic exploration into a hidden dependency of normal static analysis. Every query has fixed node/path/time/resource budgets.

## 37. C-SYM acceptance

- Phase 9 existing tests stay green.
- exact exhaustive-vs-production differential has zero unexplained disagreement on the shared domain.
- timeout/cancel/late-result tests prove no authority leak.
- model validation rejects deliberately corrupted SAT models.
- proof consumers preserve `UNKNOWN` rather than treating it as false.
- performance budget prevents symbolic requests from blocking interactive analysis.

---

# C-X — Disjoint Stage 1 Closure

## 38. Native formats

Use current loader/parser architecture. Freeze denominator matrices for Mach-O, ELF, PE/PE+ across F3–F5:

- imports/exports
- relocation/binding families
- unwind/function metadata
- DWARF/PDB
- runtime/language metadata
- malformed/truncated/cyclic variants

Every locked matrix cell needs positive + negative proof.

Do not work on F6 rebuild inside Stage 1.

## 39. Managed frontends

Freeze version/opcode/metadata denominators for:

- WASM
- DEX
- CIL
- JVM

M0–M5 completion requires every locked family to be implemented and adversarially tested. Unsupported/newer input fails closed. “Pipeline reaches decompiler” is not equivalent to full locked-profile coverage.

## 40. Persistence / plugin trust

Before Stage 2 durable authority, prove:

- deterministic artifact identity/invalidation
- project migration and round-trip
- OPFS/IndexedDB quota/eviction behavior
- old-or-new crash consistency, never torn state
- cancellation/late-result exclusion
- plugin/provider ownership
- sandbox/isolation
- resource budgets
- schema validation
- versioning
- provenance
- generated-output interruption recovery

Use deterministic replay and H12 fault injection.

---

# 41. Proof stack — mandatory per meaningful change

For each lane, W4 freezes a proof-applicability row before implementation: every layer below is `REQUIRED` or `N/A` with a concrete contract-based reason. `N/A` cannot be chosen merely because a test is difficult.

1. **minimal regression** — smallest reproducer
2. **property test** — invariant over generated cases
3. **metamorphic test** — semantics-preserving transformation
4. **seeded fuzz** — deterministic and bounded
5. **differential oracle** — independent implementation/tool
6. **mutation test** — deliberately remove protection; verifier must fail
7. **real fixture** — required locked real classes
8. **determinism** — repeated clean output identity/hash
9. **fault matrix** — cancellation/crash/late completion/provider disconnect when the owned path has asynchronous, persistent, or external-provider state
10. **performance** — latency/memory/read-work/cancellation
11. **production-path identity** — which implementation/provider produced the claim

Every newly found deterministic counterexample is minimized and permanently added before the fix is accepted. The protected corpus is growth-only.

---

# 42. Performance discipline

Freeze budgets before the implementation that tries to satisfy them.

Required workload classes:

- initial open / metadata parse
- paged byte access
- distant navigation
- first decode window
- IR/CFG/SSA/MemorySSA functions listed in the frozen C0 performance workload profile
- function discovery
- decompiler first useful result
- project save/load
- cancellation settlement
- large logical source without whole-file read

Freeze runtime/device class, cold/warm policy, repetitions, and metric direction in C0.

- deterministic work metrics (bytes read, operations, bounded work counters) may gate generic CI;
- wall-clock and peak-memory budgets gate only on the frozen runtime/device class or dedicated benchmark runner;
- generic GitHub CI may record wall-clock samples but does not substitute for device-class latency proof;
- final verification consumes exact identity-bound performance evidence for every required runtime/device class.

Optimize only measured hot paths. Never relax a failing threshold in the same fix PR.

---

# 43. Integration transaction

For every component:

```text
1. fetch live main + stage integration + component head
2. W5 reconciles stage integration with moving main if needed
3. validate changed-file ownership
4. construct candidate merge tree: integration + component
5. run governance/invariants
6. run focused regression/property/fuzz/differential gates
7. run affected canonical phase runner/verifier
8. W4 adversarial review
9. accept component only if all are green
10. W5 regenerates shared outputs
11. run rolling exact-head stage verifier
12. record checkpoint SHA/tree/metrics/blockers
13. unlock next dependent merge
```

A green component PR head is not integration proof.

---

# 44. Test command policy

Discover actual commands from current `package.json`; never invent commands.

Common current runners include:

```bash
npm run effects:test
npm run semantic-v2:test
npm run phase7:test
npm run phase7:verify
npm run phase8:test
npm run phase8:verify
npm run phase9:test
npm run phase9:verify
npm run phase10:test
npm run phase10:verify
npm run phase11:test
npm run phase11:verify
npm run phase12:test
npm run phase12:verify
npm run integration:test
npm run binary:test
npm run runtime:test
npm run userscript:test
npm run benchmark:baseline
npm run check
```

Use this cadence:

```text
edit
→ focused test
→ counterexample/property
→ lane runner
→ candidate merge tree
→ affected verifier
→ checkpoint full gate
```

For an exact clean Stage 1 integration head, the current direct verifier entry point is:

```bash
node tools/validation/stage1/verify.mjs --expect-sha "$(git rev-parse HEAD)"
```

For Stage 2, use the current CLI accepted by `tools/validation/stage2/verify.mjs` and supply the exact required physical/profile evidence in final mode; do not fabricate missing evidence files.

Do not run `npm run check` after every edit. Do run it on required integration checkpoints and cutover candidates.

---

# 45. Stop / rollback rules

Stop the lane immediately on:

- false exactness
- semantic mismatch
- provenance loss
- stale/current identity confusion
- hidden fallback
- denominator shrink
- ownership breach
- unexplained nondeterminism
- required corpus deletion/weakening
- violation of a C0-frozen performance/resource regression budget
- moving `main` invalidating the proof base

Quarantine the failing lane at the last proven integration checkpoint, then reconcile forward on an owned branch. Do not force-reset shared history, revert unrelated live-main work, or patch around a red invariant.

---

# 46. Stage 1 cutover

One exact integration head must satisfy all of the following:

- canonical scope lock remains growth-only
- closure ledger `unmappedCount = 0`
- all Stage 1 locked denominator rows covered
- four current native profiles have truthful A2 closure for their locked scope
- alias/points-to exact precision remains 1.0 with improved held-out exact recall
- MemorySSA/value/type/function/decompiler gates green
- native F3–F5 and managed M0–M5 support claims match proof
- persistence/plugin trust required by Stage 2 is proven
- fuzz/property/metamorphic/differential gates green
- mutation/fault self-tests green
- real fixtures green
- performance budgets green
- promoted fallback count = 0
- full exact-head Stage 1 verification green
- current live `main` reconciled and affected evidence rerun
- no reproducible open issue contradicts a promoted Stage 1 claim

Only then begin Stage 2 authority promotion.

---

# 47. Stage 2 execution

After Stage 1 cutover is merged and verified on `main`, create/refresh the authoritative `completion/stage2-integration` branch. Stage 2 component PRs target that branch; they do not bypass it to `main`.

Stage 2 follows the existing Two-Stage Playbook and current canonical Stage 2 files. Do not redesign Stage 2 from scratch.

Before Stage 2 work:

```text
refetch live main
→ reconcile exact Stage 1 product
→ rerun Stage 1 verifier
→ freeze Stage 2 authority identities/security boundaries
```

Any Stage 1 regression returns to its Stage 1 owner.

## 48. Native runtime/debug/emulation A7

Canonical source includes:

- `js/runtime/authority.js`
- `js/runtime/stage2.js`
- `js/runtime/session.js`
- `js/runtime/module-binding.js`
- `js/runtime/provider-identity.js`
- `js/runtime/provider-protocol.js`
- debugger/instrumentation/emulator/trace providers
- `tests/stage2/runtime-authority.test.mjs`
- `tests/runtime-*.mjs`

Authority tuple must bind at least provider/session/target/module/binary/build identity. A runtime observation cannot overwrite static truth; it is a separate observation with explicit provenance.

Required safety:

- stale session event rejected
- disconnect/reconnect does not reuse stale authority
- cancellation settles
- bounded memory/register writes require explicit mutation authority
- provider failure does not silently select a weaker provider as equivalent proof
- trace/debugger/emulator results identify the provider that produced them

## 49. Managed runtime/debug M6

Use the existing managed frontend identity and runtime binding. A frontend reaching M5 does not imply M6. Runtime proof must bind module/method/runtime/provider identity and preserve unsupported VM/version behavior explicitly.

## 50. Validated rebuild F6

Canonical implementation includes `js/rebuild/transaction-v2.js` and Stage 2 rebuild tests.

Transaction:

```text
immutable input identity
→ requested edits
→ deterministic RebuildPlan
→ temporary output
→ structural validation
→ independent validation
→ signing/authority consequences
→ atomic publication
→ reopen/reparse/platform check
```

Never raw-write on validator failure. Hex self-reparse is necessary but not sufficient for common-mode-risk properties. Each promoted format requires an independent validator strategy.

Freeze an F6 operation matrix per format before promotion. Where the locked profile claims them, prove independently:
- in-place replacement;
- section/segment growth or new-region layout;
- relocation/binding updates;
- import/export edits;
- branch-range repair/trampolines;
- unwind/exception metadata;
- signing/authentication consequences;
- reopen/reparse and executable-structure integrity.

Same-size byte replacement alone cannot satisfy a broader locked F6 claim.

## 51. Knowledge / rules / patterns / collaboration

Canonical source includes:

- `js/knowledge/phase12-recognition.js`
- `js/knowledge/phase12-rules.js`
- `js/phase12/package-envelope.js`
- `js/phase12/provider-boundary.js`
- `js/pattern/index.js`
- `js/collaboration/remote-authority.js`
- `js/collaboration/remote-delivery.js`

Rules:

- package/rule/pattern evaluation is deterministic and budgeted;
- external package text/metadata never mints local semantic authority;
- every recognition/capability result carries explicit evidence completeness;
- remote operations bind actor/project/binary identities;
- duplicate/out-of-order delivery is idempotent or explicitly rejected;
- local collaboration support and remote-secure collaboration support remain separate claims.

---

# 52. Physical iPad/WebKit gate

Final product-complete proof requires an exact-build physical iPad/WebKit run containing at least:

- runtime/build identity
- real binary open/analyze
- function navigation
- every decompiler scenario ID listed in the frozen physical-iPad evidence profile
- cancellation/restart
- worker lifecycle/recovery
- project persistence round-trip
- variable-length navigation where exposed
- memory-pressure-sensitive behavior

Node, jsdom, Chromium, or simulated UA does not substitute for this final gate.

---

# 53. ADR-gated competitive extensions

These are not allowed to hide unfinished Phase 1–12 debt. Begin them only after the existing Stage 1/Stage 2 requirement that they depend on is proven. Each extension requires an ADR, locked denominator, ownership, production wiring, tests, and support-truth entry.

### 53.1 First-class taint analysis

Build on Semantic IR/SSA/MemorySSA/summaries; never decompiler text or symbol names.

Canonical taint fact shape:

```text
subjectId        value or memory-region identity
labels           deterministic taint labels
sourceEvidenceIds
propagationPathIds
completeness
producerIdentity
```

Propagation:

- SSA value use-def
- MemorySSA store/load only through proven memory links
- call/return through function summaries
- explicit source/sink/sanitizer rules

Unknown call/memory effects preserve uncertainty. AI may explain a taint path but cannot create a taint fact.

### 53.2 Deobfuscation

Decompiler/analysis transformations are proof consumers:

- opaque predicate elimination requires solver-backed edge proof;
- flattened dispatcher recovery starts as a candidate and rewrites only with CFG/state-machine proof;
- state-variable simplification uses value/range facts;
- trivial virtualization-pattern lifting requires bounded semantic equivalence.

If equivalence cannot be proven, expose a suggestion/evidence view instead of mutating canonical output.

### 53.3 New architecture/language breadth

Only after existing locked native profiles are proven should ADRs add ARM32/Thumb, x86-32, MIPS, PowerPC or additional language intelligence such as Itanium/MSVC C++, Rust, and Go. Every new architecture must enter the same canonical MachineEffects→Semantic IR pipeline; decoder-only support is forbidden.

### 53.4 Assembler / patch authoring

Do not build a UI-only assembler. Encoding support belongs to the architecture plugin contract and must round-trip through decode + exact MachineEffects.

For every supported patch instruction:

```text
source instruction
→ exact bytes
→ decode
→ exact MachineEffects
→ compare intended semantic contract
```

Range expansion/trampolines/code caves belong to rebuild planning, not the assembler. An architecture without a proven encoder remains explicitly unsupported for free-form assembly.

### 53.5 Runtime instrumentation / replay depth

After A7 provider authority is proven, add richer trace capabilities through the existing instrumentation/trace provider contracts:

- call trace
- basic-block trace
- instruction trace
- bounded memory/register observations
- explicit sampling/loss metadata

A dropped/incomplete trace is partial evidence. Frida/Stalker-compatible providers remain external providers with exact provider identity; they do not become Hex-native truth by naming convention.

Time-travel/replay capability requires immutable event ordering, snapshot/checkpoint identity, deterministic replay rules, and explicit gaps. Do not market ordinary trace history as reverse execution.

### 53.6 Emulator / OS-environment depth

CPU semantic emulation and OS personality are separate layers. Reuse MachineEffects for CPU truth; model syscalls, loader state, filesystem/network stubs, and runtime libraries as explicit environment providers. Missing environment behavior returns unsupported/partial rather than guessed host behavior.

### 53.7 Application-level managed workflows

After core DEX/CIL/JVM profiles are sound, add application containers as separate layers:

- APK/AAB + AndroidManifest/resources around DEX
- richer .NET metadata/PDB/ReadyToRun around CIL
- JAR/container/runtime metadata around JVM

Container/resource metadata may enrich navigation and nominal types but never bypass the managed instruction semantics pipeline.

### 53.8 Plugin/API and knowledge ecosystem expansion

Expand public contribution surfaces only after ownership/security contracts exist. Prefer versioned contributions for ABI, decompiler pass, type provider, debugger, instrumentation, emulator, trace, symbolic solver, signature, recognition, diff feature, knowledge, capability rule, view, AI tool, and exporter.

Ecosystem scale is not faked by copying third-party databases. Freeze a versioned first-party package/corpus profile with explicit package IDs and coverage classes, then build deterministic import/update/version/license/provenance machinery against that profile. Public APIs expose canonical analysis facts and identities; they do not expose mutable internal maps as authority.

### 53.9 Binary diff / version matching

Extend the existing `js/diff/index.js` pipeline rather than adding an opaque matcher. Keep match reasons decomposable into exact/normalized/structural/Semantic-IR/callgraph features. Ground truth uses known source-version pairs and injected edits. Measure match precision/recall and ambiguity separately. A high score never upgrades an ambiguous match to exact without an exact identity/proof rule.

### 53.10 New native format breadth

After Mach-O/ELF/PE locked profiles close F3–F6, ADRs can add archives/COFF/UEFI/TE/firmware or other formats. Every new format must define a versioned denominator, bounded parser, malformed-input corpus, mapping identity, and the same F-level support truth. Opening a header is not format support.

---

# 54. Competitive victory gate

Hex release completion and competitor victory are separate verdicts.

For every frozen competitive target metric:

- `WIN` — Hex is better under equivalent conditions
- `TIE` — equivalent within the frozen comparison rule
- `LOSS` — remains an owned competitive improvement item in the frozen scorecard/profile and, when actionable, links to an issue/work item; it does not create a second completion ledger
- `UNMEASURED` — no victory claim allowed for that metric

A tool/domain is marked **surpassed** only when its frozen required metric set contains:

```text
LOSS = 0
UNMEASURED = 0
```

Do not delete a losing metric after freeze. Competitor output is **never ground truth**: correctness comes from source/compiler truth, semantic equivalence, authoritative spec/debug/metadata, or another independent oracle. Decompiler pseudocode string similarity is not a correctness oracle.

Comparisons require the same binary SHA-256, function identity set, frozen configuration, and runtime/hardware class. If equivalent conditions cannot be established, record `UNMEASURED`.

---

# 55. Mandatory adversarial review before every lane completion

W4 answers these questions using source and tests, not the implementer's summary:

1. Can any incomplete/unknown path now produce exact authority?
2. Is there a second semantic truth hidden in a consumer?
3. Can cancellation/budget exhaustion publish partial state as complete?
4. Can stale identity or moving main invalidate evidence?
5. Can the denominator/corpus be shrunk without the verifier failing?
6. Does the production UI/API actually use the new path?
7. Is any support claim stronger than machine truth?
8. Can one minimal counterexample falsify the claimed improvement?
9. Does repeated execution produce deterministic canonical output?
10. Does any C0-frozen performance/resource budget regress?

Any unresolved `yes` blocks acceptance.

---

# 56. Final H16 cutover

Use the mandatory hardening sequence exactly:

```text
1. freeze final scope + denominators
2. ledger unmappedCount = 0
3. all Stage 1 items terminal/proven
4. all Stage 2 items terminal/proven
5. fuzz/property/metamorphic/differential green
6. mutation/fault self-tests green
7. real-fixture matrix green
8. performance/memory green
9. physical iPad/WebKit exact-build proof green
10. npm run check + focused suites green
11. permanent exact-SHA verifiers green
12. repository-wide duplicate/issue/source audit clean
13. derive support truth from proof
14. resolve live main
15. construct candidate merge tree
16. rerun affected proof on candidate merge tree
17. committed generated product output zero-diff; exact-run reports remain external/ignored evidence
18. merge only the proven expected head
19. verify post-merge main identity/equivalence
20. archive immutable evidence
```

Any identity change during steps 14–19 invalidates affected proof.

---

# 57. The shortest path

Do not chase feature count first.

The highest-leverage objective is:

> Convert cases Hex currently leaves as `May / Candidate / Unknown` into sound, evidence-backed exact facts.

The compounding path is:

```text
Alias precision
→ MemorySSA precision
→ value recovery
→ type/aggregate/prototype recovery
→ decompiler quality
→ AI explanation and causal navigation
```

Only after this backbone is materially stronger should the project spend major effort on new ISA/format breadth.

**Success is measured superiority on the same inputs with evidence strong enough to state exactly where Hex wins, ties, loses, or remains unmeasured.**
