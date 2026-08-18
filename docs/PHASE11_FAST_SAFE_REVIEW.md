# Phase 11 Managed Frontends — Fast/Safe Execution Review

Status: **review complete**  
Review: **4 — critical-path / throughput / safe-delivery review**  
Reviewed branch: `docs/phase11-managed-frontends-playbook`  
Reviewed planning baseline: `main` at `e90c5107f9c77d73687ee452d5042dcbe9e79ece`  
Primary playbook: [`PHASE11_MANAGED_FRONTENDS_PLAYBOOK.md`](./PHASE11_MANAGED_FRONTENDS_PLAYBOOK.md)  
Prior three-pass review: [`PHASE11_MANAGED_FRONTENDS_REVIEW.md`](./PHASE11_MANAGED_FRONTENDS_REVIEW.md)  
Normative process rules: [`ENGINEERING_PROCESS_GUARDRAILS.md`](./ENGINEERING_PROCESS_GUARDRAILS.md)

This review has one objective:

> Finish Phase 11 as fast as possible without weakening semantic correctness, exact-head proof, capability truth, hostile-input safety, iPad/WebKit product truth, or repository process guardrails.

This is an operational refinement. It does not weaken the Master Architecture or the existing Phase 11 semantic contracts.

---

# 1. Verdict

The current Phase 11 playbook is architecturally safe, but it can be executed faster.

The main speed risk is **over-serialization**:

```text
freeze many contracts
→ finish WASM shared path
→ wait for stability
→ only then begin DEX/CIL/JVM production work
```

That sequence minimizes conflict, but it leaves useful independent work idle.

The recommended fast-safe sequence is:

```text
P11-F0  live audit + exit contract + ownership + verifier entrypoint
   ↓
P11-F1  freeze only the small cross-lane envelope
   ↓
P11-W0  immediate WASM vertical skeleton
   ├──────────────┬──────────────┬──────────────┐
   │              │              │              │
DEX prep/M0-M1  CIL prep/M0-M1  JVM prep/M0-M1  verifier/corpus/iPad prep
   │              │              │              │
   └──────────────┴──────────────┴──────────────┘
                     ↓
P11-S  freeze semantics proven by the real WASM path
                     ↓
DEX/CIL/JVM M2-M3 implementation in parallel
                     ↓
shared M4/M5 only when cross-frontend evidence proves common need
                     ↓
exact candidate/release proof
```

The key rule is:

> Parallelize target-owned work early. Serialize only shared semantic-contract mutation.

This preserves safety while removing unnecessary waiting.

---

# 2. Findings

## FS-F1 — Too much can be frozen before the first real vertical slice

### Risk

The playbook currently asks the foundation to freeze many contracts before broad fanout. That is safe, but if every field and semantic vocabulary is treated as final before one real VM path runs through the system, engineers can spend time perfecting abstractions that WASM immediately disproves.

### Fast-safe correction

Split contracts into two classes.

### Hard-freeze at foundation

Freeze only things whose churn is expensive across all lanes:

```text
identity authority rules
ManagedTargetProfile identity/version rules
artifact-key/version/invalidation rules
completeness vocabulary
unknown-effect policy
origin/provenance requirements
cancellation/budget contract
validation-result status vocabulary
support/maturity promotion rules
shared ownership boundaries
exact-SHA verifier invocation path
```

### Provisional until the first real WASM vertical path

Keep these versioned and reviewable, but do not over-design them before real evidence:

```text
exact VMEffects operation field layout
target-specific intrinsic payload details
exact managed memory-region taxonomy beyond required first slice
exact call-resolution subfields
exact exception metadata extension fields
exact shared helper module split
```

At `P11-S`, freeze the parts proven by the real walking skeleton.

Safety is preserved because provisional contracts remain explicit, versioned, tested, and owned by the foundation/integration lane. They are not uncontrolled component-local APIs.

---

## FS-F2 — DEX/CIL/JVM useful work does not need to wait for WASM M3

### Risk

Waiting for the full WASM shared-contract stability checkpoint before any production work on the other three targets wastes wall-clock time.

### Fast-safe correction

Before `P11-S`, DEX/CIL/JVM may perform **target-owned, low-coupling work** that does not mutate shared semantic contracts.

Allowed early work:

```text
official-spec/profile pinning
fixture/corpus manifest construction
negative/malformed corpus
container/member probing
M0 detection
M1 metadata parsing/indexing
stable target-local entity identity tests using the frozen common identity envelope
bytecode decode tables/decoders
raw source-range/provenance tests
resource-budget parser tests
target-specific validation research/test vectors
```

Blocked until `P11-S` unless integration explicitly approves:

```text
shared VMEffects contract mutation
shared Semantic IR changes
shared CFG/SSA changes
shared MemorySSA region changes
shared query/API changes
shared M4/M5 changes
support promotion above proven stages
```

This gives three frontend lanes useful work without letting them fork the shared semantic architecture.

---

## FS-F3 — Test cadence needs tiers

### Risk

Running every expensive repository/managed/iPad gate after every small edit would be safe but slow. The guardrails require exact candidate/integration/release proof; they do not require the full release suite for every local change.

### Fast-safe correction

Use four validation tiers.

### T0 — edit loop

Run immediately for the changed semantic unit:

```text
schema/unit tests
decoder/VMEffects golden tests
negative case for the bug being fixed
lint/type/format relevant to touched files
```

Goal: first deterministic divergence in the shortest loop.

### T1 — lane checkpoint

Before a component head is offered for integration:

```text
all owned lane tests
managed shared contract tests touched by the lane
malformed/negative subset for the lane
artifact/cancellation/provenance tests affected by the change
canonical Phase 11 runner for the lane-visible surface
```

### T2 — candidate integration transaction

Before component merge into living integration:

```text
actual changed-file ownership check
candidate merge-tree tests
rolling managed vertical gate
independent shadow verifier
native regression set affected by shared changes
generated-output transaction when applicable
```

This tier remains mandatory under `ENGINEERING_PROCESS_GUARDRAILS.md`.

### T3 — release/cutover

Run the full exact-head proof:

```text
all frontend corpora
full malformed corpus
full independent verifier
support/maturity consistency
resource/performance release gates
real iPadOS/WebKit product proof
current-main reconciliation
exact merged-product proof
runtime/deployment identity where applicable
```

Do not weaken T2/T3. Speed comes from keeping T0/T1 focused.

---

## FS-F4 — Shared M4/M5 does not need an all-four-frontends barrier

### Risk

Waiting until all four frontends reach M3 before beginning every shared type/interprocedural/decompiler improvement can create idle time and a large late integration block.

### Fast-safe correction

Start a shared M4/M5 change when **cross-frontend evidence** proves it is genuinely common.

Preferred proof:

```text
one stack VM path
+
one register VM path
+
same shared downstream deficiency
```

For example:

```text
WASM or CIL/JVM demonstrates stack-value requirement
+
DEX demonstrates register-value requirement
→ shared variable/value abstraction change is likely truly generic
```

Rules:

- one target alone does not justify a generic rewrite unless the Master Architecture already requires it;
- shared changes remain integration-owned;
- affected frontend evidence is invalidated and rerun;
- per-frontend M4/M5 maturity remains independently gated.

This starts useful common hardening earlier without letting the first frontend dictate all later architecture.

---

## FS-F5 — Shared-contract handoffs can become a serial queue

### Risk

If every target discovery immediately interrupts all work for a shared-contract revision, Phase 11 can thrash.

### Fast-safe correction

Use bounded integration windows.

Default:

```text
lane discovers shared gap
→ record typed handoff
→ continue target-local work that remains valid
→ integration batches compatible handoffs at the next contract window
→ one shared version bump
→ affected lanes revalidate once
```

Immediate shared repair is required only when:

- current contract is semantically wrong;
- continuing would create invalid artifacts or false support claims;
- a security/integrity bug exists;
- multiple lanes are blocked on the same gap.

This reduces repeated evidence invalidation.

---

## FS-F6 — iPad proof should be early, targeted, and final

### Risk

Waiting until release for the first real-device check is unsafe. Re-running the full real-device suite for every parser-only change is slow.

### Fast-safe correction

Use three device checkpoints.

### Device smoke A — first WASM vertical path

Prove early:

```text
open representative module
first useful method result
selected-function decode/analysis
cancel
navigation/evidence
basic memory observation
```

If the architecture fails on iPad here, fix it before three more frontends depend on it.

### Device targeted B — shared runtime-path changes

Repeat affected checks after changes to:

```text
scheduler
ArtifactStore
query/navigation
shared UI projection
container paging
memory representation
worker/runtime boundary
```

Target-only parser semantics with no device-path effect do not require the full device suite each time.

### Device release C

Run the complete agreed iPadOS/WebKit proof on the exact release candidate.

---

## FS-F7 — Performance limits need two stages

### Risk

Freezing detailed UX thresholds before real managed code exists can waste time tuning arbitrary numbers.

### Fast-safe correction

At foundation, freeze only **safety caps** needed to prevent hangs/OOM behavior:

```text
bounded allocations
bounded parser nesting/counts
cancellation responsiveness class
artifact publication limits
no eager whole-package decode/decompile
```

After the first real WASM vertical path and representative package measurements, freeze product UX thresholds for:

```text
TTFUA
selected-method latency
warm reopen
search
peak memory
UI responsiveness
```

This avoids both unbounded behavior and premature optimization.

---

## FS-F8 — Keep one shared-contract mutation in flight

### Risk

Parallel workers editing different parts of the shared semantic plane can create merge conflicts that are cheap individually but expensive to reconcile semantically.

### Fast-safe correction

Use this WIP rule:

```text
max concurrent target-owned lanes: as useful
max concurrent shared semantic-contract mutation: 1
```

Research, fixtures, verifier work, performance work, and target-private code can run in parallel.

Shared identity/VMEffects/Semantic IR/CFG/SSA/query contract changes have one active integration owner at a time.

This is a throughput optimization, not conservative under-utilization: it prevents the most expensive class of conflict.

---

# 3. Recommended fast critical path

## Stage A — F0: one short preflight transaction

Do only what prevents invalid parallel work:

1. refetch live `main` and Phase 10 evidence;
2. ratify Phase 11 minimum exit contract;
3. classify hard prerequisites as PASS/BLOCKING;
4. create living integration;
5. create ownership manifest + negative tests;
6. create exact-SHA verifier entrypoint;
7. define corpus manifest and target profiles;
8. define target-device smoke plan.

Do not implement a mature release verifier here. Create the permanent invocation/evidence path and grow it in shadow mode.

## Stage B — F1/W0: smallest real contract + immediate WASM

Freeze the expensive-to-change common envelope, then immediately pass one real WASM function through:

```text
bytes
→ detect
→ metadata
→ decode
→ validate
→ VMEffects
→ Semantic IR
→ CFG/SSA
→ provenance query
```

Do not broaden WASM opcode coverage until this path works.

## Stage C — parallel preparation while WASM stabilizes

Start DEX/CIL/JVM M0/M1 and corpus/decoder work under target ownership.

In parallel:

```text
verifier lane grows shadow evidence
negative corpus lane grows malformed coverage
iPad/performance lane measures the first real path
```

## Stage D — P11-S: one deliberate shared freeze

Use evidence from:

- the real WASM path;
- early DEX/CIL/JVM metadata/decode work;
- verifier feedback;
- first iPad smoke.

Freeze the shared semantic contract needed for M2/M3 fanout.

## Stage E — DEX/CIL/JVM M2/M3 fanout

Run target lanes concurrently.

Each lane should reach a **thin vertical slice first**, then expand opcode/profile coverage.

Do not finish an entire parser before proving shared lowering.

## Stage F — shared hardening by demonstrated common need

Start M4/M5 changes when at least two different execution-model families prove the same shared deficiency.

Keep maturity claims per frontend independent.

## Stage G — integration/release

Use the existing candidate merge-tree and checkpoint-lock model.

Final verification should be boring: the same verifier and corpus already exercised continuously, now run on one exact candidate.

---

# 4. Worker allocation for high throughput

After the shared foundation exists, a useful six-worker shape is:

```text
1  DEX target lane
2  CIL target lane
3  JVM target lane
4  independent verifier/corpus
5  performance/iPad/resource lane
6  integration/shared-hardening support
```

During the first WASM vertical slice, replace one target slot with the WASM implementation owner and keep DEX/CIL/JVM early work limited to target-owned M0/M1/corpus/decode preparation.

Do not fill six slots merely because six exist.

The Supervisor/integration owner should keep shared semantic ownership centralized.

---

# 5. Stop doing these if speed matters

Do not spend critical-path time on:

- complete opcode coverage before the first vertical M2/M3 path;
- language-pretty Java/C# rendering before semantic M5 gates;
- speculative M6 runtime work unless Phase 11 exit requires it;
- full dependency resolution over Maven/NuGet/internet ecosystems;
- broad archive/package features unrelated to required managed members;
- a second frontend-private CFG/SSA because the shared one needs one fix;
- repeated rebase of every component onto moving `main`;
- full release CI after every local edit;
- full iPad suite after target-only semantic changes that do not affect the runtime path;
- repeated shared schema churn for one-lane convenience;
- CI job explosion before profiling the actual slow path.

---

# 6. Safety gates that must never be traded for speed

The following remain non-negotiable:

```text
no fake native VM model
no silent preserve/no-op fallback
unknown remains explicit
invalid bytecode is never repaired into claimed exact semantics
origin/provenance survives every canonical transformation
capability maturity never skips prerequisites
malformed input remains bounded/cancellable
partial artifacts are never published as complete
candidate merge tree is verified before integration
integration checkpoint lock is honored
generated output is owned and rebuilt transactionally
real iPad/WebKit proof exists before release
exact-head verifier evidence exists
live main is refetched after final merge
```

If a speed optimization weakens one of these, reject the optimization.

---

# 7. Fast decision rules for the Supervisor

Use these rules during Phase 11.

### A task changes only target-owned parser/fixture code

Run target lane tests first. Do not block unrelated lanes.

### A task changes shared semantic contracts

Serialize through integration ownership. Invalidate affected evidence explicitly.

### One frontend requests a generic abstraction

Prefer a target-local explicit intrinsic/handoff until another target or the Master Architecture proves the abstraction is common.

### Two different VM execution models expose the same shared gap

Promote it to shared hardening work.

### CI is slow

Profile the production/verification hot path before adding more GitHub jobs.

### A component branch is green but candidate integration is red

The component is not mergeable. Diagnose first divergence on the candidate tree.

### `main` moves

Integration owner reconciles centrally. Do not make every lane chase `main`.

### iPad fails but desktop is green

Treat iPad as product truth. Fix before expanding dependent architecture.

### A feature is difficult and outside the declared target profile

Mark it explicit unsupported/partial. Do not hold the entire phase hostage to unratified scope.

---

# 8. Review conclusion

## Blocking correctness findings

**0** in the existing semantic plan after the prior three-pass review.

## Throughput findings

**8** operational speed risks identified in this review.

They are not reasons to redesign Phase 11. They are execution refinements:

1. hard-freeze less before the first real vertical slice;
2. start target-owned DEX/CIL/JVM M0/M1 work earlier;
3. use tiered validation cadence;
4. begin shared M4/M5 from cross-frontend proof, not an all-four barrier;
5. batch compatible shared-contract handoffs;
6. use early/targeted/final iPad proof instead of late-only or full-every-time proof;
7. separate early safety caps from measured UX thresholds;
8. keep one shared semantic-contract mutation in flight while parallelizing target lanes aggressively.

## Final verdict

**PASS — ready for fast-safe execution.**

The fastest safe strategy is not “maximum parallelism everywhere.” It is:

> **Maximum parallelism on target-owned work, minimum concurrency on shared semantic truth, and expensive proof only at the boundaries where it is actually authoritative.**

That should reduce Phase 11 wall-clock time substantially without weakening the correctness standards that protect Hex from shipping a convincing but semantically wrong analyzer.
