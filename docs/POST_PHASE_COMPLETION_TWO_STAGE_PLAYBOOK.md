# Hex Phase 1–12 — Two-Stage Completion Playbook

Status: **execution contract for closing all remaining Phase 1–12 debt**  
Scope: **post-phase completion only; this does not define Phase 13 or Phase 14**  
Primary objective: **drive every remaining Phase 1–12 capability gap to a proven completed state without lowering correctness, safety, provenance, or iPad/WebKit requirements**  
Normative authority: [`HEX_MASTER_ARCHITECTURE.md`](./HEX_MASTER_ARCHITECTURE.md), [`ENGINEERING_PROCESS_GUARDRAILS.md`](./ENGINEERING_PROCESS_GUARDRAILS.md), [`MIGRATION_GUARDRAILS.md`](./MIGRATION_GUARDRAILS.md), current source/tests, `js/platform/capability-maturity.js`, [`SUPPORT_MATRIX.md`](./SUPPORT_MATRIX.md)

> This document consolidates the remaining completion debt exposed by the Phase 1–12 implementation, current capability truth, and the Master Architecture debt list. It is deliberately two-stage. It MUST NOT be interpreted as two new numbered Master Architecture phases.

---

## 0. Meaning of “100% complete”

“100%” is not a subjective quality score and does not mean “supports every architecture, file format, runtime, extension, compiler, or operating system in existence.” It means that the **declared Hex Phase 1–12 contract and every capability currently represented as partial/unsupported within that declared product scope have been either**:

1. implemented and proven to the maturity level required by the architecture contract; or
2. explicitly removed from the declared supported scope by a reviewed normative architecture change, with no stale UI/API/support claim left behind.

For this completion program, option 2 is not a shortcut. Existing Phase 1–12 target rows (`arm64`, `arm64e`, `x86_64`, `riscv64`, Mach-O, ELF, PE/PE+, WASM, DEX, CIL, JVM, and Phase 12 capabilities) are presumed in scope unless a later accepted architecture decision explicitly says otherwise.

A capability is **not complete** merely because:

- a parser/decoder/provider exists;
- a happy-path corpus passes;
- a later pipeline stage works through compatibility code;
- a feature is useful in one fixture;
- a PR was merged;
- old release evidence is green;
- a limitation is documented;
- the UI says supported;
- an independent tool agrees on a subset;
- an issue was closed without current-main reproduction/proof.

A capability is complete only when implementation, integration, negative tests, support truth, exact-head verification, required target-platform proof, and release evidence agree.

---

## 1. Why this program exists

The Phase 1–12 roadmap produced a large working analysis stack, but current architecture truth still contains material partial/unsupported states. The remaining work is no longer “build the missing stack.” It is **boundary completeness, exactness, scale, authority, runtime depth, and proof closure**.

Current debt classes that this program MUST close are:

### 1.1 Architecture / semantic debt

- architecture-wide exact `MachineEffects` coverage sufficient to satisfy cumulative A2 for every declared native architecture;
- ARM64/ARM64e uncommon integer/control, memory, FP/SIMD, system, and pointer-authentication semantic tails;
- x86-64 instruction/prefix/vector/system tails beyond the mandatory compiler corpus;
- RISC-V coverage beyond the frozen RV64IMC proof where the declared product contract requires it, without silently treating unsupported extensions as exact;
- architecture/ABI assumptions remaining in generic semantic/type/decompiler code;
- points-to/alias precision, region reasoning, interprocedural summaries, indirect-call recovery, and global type/prototype constraints;
- variable-length architecture viewer/product integration;
- architecture-specific compatibility/oracle paths that still carry production semantics not yet represented by the canonical architecture-neutral contracts.

### 1.2 Native format debt

For Mach-O, ELF, and PE/PE+:

- F3 imports/exports/relocations completeness;
- F4 function/debug/unwind completeness;
- F5 runtime/language metadata where the declared format/product contract requires it;
- F6 validated rebuild/patch;
- malformed/cyclic/truncated metadata behavior;
- relocation and loader edge cases;
- independent differential coverage where common-mode parser risk matters.

### 1.3 Analysis quality debt

- conservative alias precision without unsafe promotion;
- deeper interprocedural/dataflow reasoning;
- stronger function discovery/extent/indirect-target evidence;
- decompiler recovery for complex loops, aggregates, optimized idioms, exceptions, switches, indirect control flow, and compiler-specific lowering patterns;
- solver-backed verification breadth for memory, floating point, large symbolic states, nonlinear/unsupported constructs, timeout/cancellation, and model validation;
- no proof authority from heuristic or incomplete results.

### 1.4 Persistence / platform / plugin debt

- project/artifact persistence scaling beyond `.hexproj` v1 while preserving the v1 exchange contract;
- schema migration, crash/interruption recovery, quota pressure, eviction, and large-project behavior;
- stable plugin contracts only where ownership, isolation, budgets, cancellation, versioning, schema validation, and provenance are defined;
- iOS/iPadOS/WebKit memory, DOM, origin, storage, cancellation, navigation, and runtime behavior as release constraints;
- no desktop-only proof for browser/iPad product claims.

### 1.5 Runtime / managed debt

- native A7 runtime/debug/patch-validation depth;
- first-class provider bindings with exact target/session/module identity;
- stepping, register/memory state, breakpoint/watchpoint behavior where supported by the declared provider contract;
- runtime evidence fusion without overwriting static truth;
- managed M6 runtime/debug integration for WASM, DEX, CIL, and JVM where the product claims M6;
- managed malformed-input and obscure opcode/metadata coverage needed to keep M0–M5 claims exact;
- solver/provider integration limitations that currently keep managed profiles conservatively partial at the overall-profile level.

### 1.6 Phase 12 debt

- knowledge packages / recognition promoted from bounded suggestion-only behavior to the declared final capability contract;
- deterministic capability rules with explicit evidence completeness and no AI-minted facts;
- collaboration beyond local replay, including the required remote transport/security authority gate;
- declarative patterns beyond the current bounded read-only path only where explicitly allowed by the architecture contract;
- validated rebuild beyond R0 shadow planning;
- package dependency/version/provenance handling;
- provider-output validation before persistence/authority;
- package invalidation without deleting explicit user/project facts;
- remote replay/project/binary/actor binding;
- independent rebuild differential strategy;
- no silent fallback from a failed new path to a weaker authority path.

---

# 2. Program shape

Only two execution stages are allowed:

```text
live main
   ↓
STAGE 1 — ANALYSIS TRUTH + COVERAGE CLOSURE
   ↓  [all Stage 1 gates green on exact integration head]
STAGE 2 — AUTHORITY + RUNTIME + REBUILD + PRODUCT CLOSURE
   ↓
FINAL PHASE 1–12 COMPLETION CUTOVER
```

Do not create Phase 13/14 architecture semantics. Branch/PR names MAY use `completion/stage1-*` and `completion/stage2-*`.

A Stage 2 implementation lane MAY prepare private scaffolding early, but **no Stage 2 support promotion or final authority cutover may occur while Stage 1 has unresolved correctness/coverage blockers**.

---

# 3. Shared execution rules

## 3.1 Live baseline, never a stale SHA

At Stage 1.0 and again at Stage 2.0:

```text
resolve live main
record exact commit + tree
read current source/tests
read js/platform/capability-maturity.js
read docs/SUPPORT_MATRIX.md
read open correctness issues and active PRs touching owned paths
record generated-output state
record exact current public compatibility seams
```

Any SHA written in planning/release history is evidence for that historical run only.

## 3.2 Living integration from the start

Create one authoritative integration branch per stage. Component branches feed that branch; they do not become competing implementations.

The integration owner alone owns:

- moving-main reconciliation;
- shared generated outputs;
- cross-lane contract reconciliation;
- current support-truth promotion;
- exact-head evidence assembly;
- final stage cutover PR.

After each accepted component merge, the integration branch is checkpoint-locked until:

1. canonical generated outputs are synchronized;
2. focused gates are green;
3. rolling product gates are green;
4. independent/shadow verification is green where applicable;
5. exact integration SHA is recorded.

## 3.3 Worker allocation

For six available workers, prefer:

```text
3 implementation workers
1 continuous independent reviewer
1 integration/reconciliation/verifier owner
1 flex worker for unblock, fixture construction, profiling, or second-opinion reproduction
```

Do not maximize parallelism across shared semantic contracts. Parallelize independent evidence lanes and architecture/format coverage partitions instead.

## 3.4 Definition of Ready

No implementation task starts without:

```text
owner
allowed changed-file inventory
input/output contract
identity/version binding
supported/partial/unsupported expectation
minimal positive fixture
minimal negative/counterexample fixture
focused test command
canonical runner discovery proof
integration adapter owner
fallback behavior
resource/cancellation budget
```

Unresolved identity, authority, persistence, or canonical semantic ownership is a design blocker, not an invitation to create a second engine.

## 3.5 Mandatory fail-closed rules

Never convert any of the following into green:

- unknown instruction/effect;
- incomplete relocation metadata;
- unsupported provider result;
- truncated pattern/rule evaluation;
- timeout/cancelled solver result;
- stale runtime observation;
- wrong project/binary/session identity;
- missing required rebuild validator;
- absent iPad/WebKit proof where required;
- skipped test due to missing integration;
- unavailable independent oracle when the release profile explicitly requires one.

Use typed `partial`, `unsupported`, `unavailable`, `unknown`, or `BLOCKING` evidence.

---

# 4. STAGE 1 — Analysis Truth + Coverage Closure

## Goal

When Stage 1 finishes, the static-analysis product must have no known Phase 1–9/11 correctness or coverage debt capable of invalidating later runtime/rebuild/Phase12 authority. Native architecture and format truth must be strong enough that Stage 2 can safely mutate/export based on it.

## Stage 1.0 — Baseline + completion manifest + permanent verifier

Deliverables:

1. machine-readable completion manifest containing every debt item in section 1;
2. owner and changed-file allowlist per lane;
3. current `capability-maturity.js` snapshot and expected promotion target;
4. current open-issue inventory mapped to debt IDs; duplicates marked, not re-filed;
5. permanent exact-SHA Stage 1 verifier wired before component work;
6. canonical test discovery proof for every new test subtree;
7. baseline performance/memory measurements on representative large fixtures and iPad/WebKit-equivalent browser lanes where available.

The manifest MUST include a state for every item:

```text
NOT_STARTED
IN_PROGRESS
BLOCKED(reason)
PROVEN(exact evidence identity)
INTENTIONALLY_OUT_OF_SCOPE(normative architecture reference)
```

No free-text “done”.

### Gate S1-0

Stage 1 implementation may fan out only when:

- manifest is exhaustive against current Master Architecture debt + support matrix + current source/tests;
- exact-head verifier invocation path exists;
- ownership manifests self-test positive and negative cases;
- every current partial/unsupported claim relevant to Stage 1 has an owner.

---

## Stage 1.1 — Exact MachineEffects closure

Partition by architecture, not by generic semantic consumer.

### ARM64

Close exact effects for the declared decoder contract, including uncommon integer/control, memory ordering/atomic forms, FP/SIMD tails, system-state effects, flags, exceptional/control outcomes, and explicit unknown cases.

### ARM64e

In addition to ARM64 coverage, close pointer-authentication semantics required by the declared ARM64e contract. Authentication/signing state must never be approximated as ordinary pointer arithmetic when that distinction changes correctness.

### x86-64

Expand beyond compiler-corpus-only proof. Cover instruction classes and prefix/vector/system tails required by the declared decoder/support contract. Instruction length, partial-register semantics, flags, implicit operands, memory ordering, exceptions, vector lanes, and control effects require explicit proof.

### RISC-V64

Preserve the proven RV64IMC profile and close any additional extensions that the declared product support now includes. If an extension remains outside the normative declared scope, capability truth must remain explicit; do not broaden a support label via decoder presence.

### Required test strategy

For each architecture:

- table/encoding coverage audit against the actual decoder contract;
- independent decoder/structured-operand differential where available;
- generated positive fixtures per instruction/effect family;
- minimal negative fixture for unknown/unsupported encodings;
- metamorphic tests for register renaming/address relocation where semantics permit;
- flags/implicit-operand tests;
- memory read/write width and alias-region tests;
- branch/call/return/exception effects;
- exact round-trip from decoder -> MachineEffects -> Semantic IR compatibility projection;
- no silent legacy fallback.

### Gate S1-1

Do not promote an architecture past A1 unless the full A2 contract for its declared support profile is proven. Later A3–A6 functionality cannot bypass A2.

---

## Stage 1.2 — Canonical Semantic IR / alias / interprocedural closure

Objectives:

- remove remaining architecture/ABI assumptions from generic passes;
- make ABI/platform/language interpretation explicit inputs/providers;
- improve points-to/alias precision without unsafe `NoAlias`/`MustAlias` promotion;
- strengthen region identity, object/stack/global separation, provenance through PHI/select/arithmetic, escape tracking, and unknown barriers;
- improve indirect-call target recovery and interprocedural summaries;
- strengthen global type/prototype constraint propagation;
- keep one canonical semantic engine.

Mandatory counterexamples include:

1. two same-root pointers with different proven non-overlapping ranges;
2. unknown offset that must remain `MayAlias`;
3. pointer provenance merged by PHI;
4. unknown call/store barrier invalidating only affected facts;
5. stack/global/heap objects with identical numeric offsets but different identity;
6. ABI-specific register/return rules not leaking into architecture-neutral passes;
7. indirect call with incomplete candidate set remaining incomplete;
8. contradictory type constraints remaining explicit instead of winner-takes-all.

### Gate S1-2

No new precision claim is accepted unless false `NoAlias`, false `MustAlias`, false exact-call target, and false type certainty remain zero on adversarial/regression corpora.

---

## Stage 1.3 — Native format F3/F4/F5 + viewer/product integration

For Mach-O, ELF, PE/PE+:

### F3

Complete the declared imports/exports/relocations contract, including malformed, truncated, cyclic, unknown-format, overflow, and unsupported relocation cases.

### F4

Complete function/debug/unwind evidence required by the contract. Evidence provenance must distinguish symbol, unwind, export, relocation, discovered CFG, and heuristic evidence.

### F5

Complete runtime/language metadata only for the format/product combinations that the normative contract claims. Mach-O Objective-C/Swift paths must preserve partial/unknown states where metadata is incomplete; ELF/PE language/runtime support must not be inferred from file-format parse success.

### Variable-length viewer/product integration

Finish address-first navigation and display for variable-length architectures. Forbidden assumptions include fixed-width `row * instructionSize` indexing outside adapters. Large sources must remain demand-driven and cancellable.

### Required negatives

- malformed export/import graph;
- relocation table truncation;
- relocation arithmetic overflow;
- overlapping/invalid mapped ranges;
- unwind chain cycle;
- missing optional metadata;
- variable-length decode boundary spanning a page/chunk;
- invalid instruction at navigation target;
- 1 TiB logical source must not trigger whole-source decode/read.

### Gate S1-3

Support truth may promote F3/F4/F5 only from exact tests proving the entire declared row contract. “Parses substantial metadata” is not enough.

---

## Stage 1.4 — Analysis quality, decompiler, solver, managed M0–M5 closure

### Static analysis / decompiler

Close known quality gaps in:

- function start/extent conflict handling;
- indirect calls/jumps;
- loops and induction;
- switch recovery;
- aggregates/arrays/structures;
- optimized compiler idioms;
- exception-heavy CFGs;
- multi-return/multi-exit behavior;
- readability transformations that must preserve semantics;
- provider hints that must not promote certainty.

Every readability transform needs a semantic-preservation oracle or an equivalent before/after canonical IR invariant appropriate to the transform.

### Solver-backed verification

Strengthen breadth for:

- memory state;
- floating-point semantics where supported;
- large symbolic states;
- timeout/cancellation;
- unsupported/nonlinear constructs;
- model validation;
- vacuous proof rejection;
- stale/late worker results.

`proved` requires exact verified solver evidence. Heuristic, timeout, partial, unavailable, malformed model, or late result is never proof authority.

### Managed frontends M0–M5

For WASM, DEX, CIL, JVM:

- close malformed-input tails;
- audit opcode/metadata coverage against the declared frontend version/profile;
- preserve explicit unsupported extension/version states;
- adversarially verify VMEffects -> shared IR -> CFG/SSA -> types/interproc -> decompiler;
- ensure no frontend-specific semantic engine bypasses shared middle-end contracts.

### Gate S1-4

M0–M5 remain supported only if coverage audit finds no unrepresented opcode/metadata class inside the declared profile. Unknown/newer versions fail closed.

---

## Stage 1.5 — Persistence scale + plugin contract hardening

Although these are platform concerns, they belong in Stage 1 because Stage 2 authority and rebuild depend on trustworthy project/artifact identity.

### Persistence

Prove:

- large project/artifact counts;
- IndexedDB/browser quota pressure;
- eviction/recovery behavior;
- interrupted write/migration recovery;
- deterministic artifact identity/invalidation;
- `.hexproj` v1 import/export compatibility;
- newer schema migration without silently rewriting semantic facts;
- paging/demand-driven access;
- iPad/WebKit storage behavior where applicable.

### Plugins/providers

For every stable contribution category in scope:

- explicit schema/version;
- stable IDs;
- ownership;
- permission/capability boundary;
- resource budget;
- cancellation;
- output size/count limits;
- provenance;
- malformed-output rejection before persistence;
- isolation and exception handling;
- cache invalidation on plugin/provider version change;
- no provider text becoming AI/system authority.

### Gate S1-5

No Stage 2 durable mutation may depend on a persistence/plugin path still classified as partial in the completion manifest.

---

## Stage 1 final cutover gate

Stage 1 is complete only if all are true on one exact integration head:

1. all S1 manifest items are `PROVEN` or normatively `INTENTIONALLY_OUT_OF_SCOPE`;
2. architecture support truth is updated from implementation/tests, never ahead of them;
3. all declared native architecture A2 prerequisites required by the target contract are satisfied;
4. targeted F3/F4/F5 rows are proven to their declared target;
5. M0–M5 managed claims remain exact after adversarial coverage audit;
6. `npm run check` is green;
7. all focused architecture/format/semantic/decompiler/solver/persistence/plugin suites are green;
8. exact-head Stage 1 verifier is green;
9. generated-output synchronization is zero-diff;
10. no unresolved open issue contradicts a Stage 1 support claim;
11. no hidden compatibility fallback is required for a support label promoted by this stage;
12. moving `main` has been reconciled once into the authoritative integration head and all affected evidence rerun.

Stage 2 MUST NOT claim completion while any item above is false.

---

# 5. STAGE 2 — Authority + Runtime + Rebuild + Product Closure

## Goal

Finish the high-authority capabilities that can mutate, export, execute against live state, collaborate remotely, or publish rebuilt binaries. Stage 2 closes native A7, managed M6, native F6, all Phase 12 partial capabilities, and final iPad/WebKit release proof.

## Stage 2.0 — Reconcile + re-baseline

Before Stage 2 implementation:

- resolve live `main` again;
- reconcile Stage 1 exact product;
- rerun Stage 1 verifier on the new Stage 2 base;
- regenerate the completion manifest;
- map all current issues/PRs touching runtime, rebuild, collaboration, pattern, knowledge, capability rules, persistence, security, WebKit, and generated outputs;
- freeze Stage 2 authority identities and security boundaries.

Any Stage 1 regression returns to Stage 1 ownership immediately; do not patch around it inside runtime/rebuild code.

---

## Stage 2.1 — Native A7 runtime/debug/emulation closure

Complete the declared native runtime provider contract with exact identity binding:

```text
provider identity
runtime instance
process/target identity
module/binary identity
load mapping identity
session identity
timestamp/sequence provenance
capability version
```

Required areas where the product claims support:

- attach/open lifecycle;
- read registers/memory;
- bounded writes/mutations with explicit authority;
- breakpoint/watchpoint/step behavior;
- module load/unload mapping;
- cancellation/disconnect/reconnect;
- stale observation handling;
- emulator/provider equivalence boundaries;
- static/runtime evidence fusion without mutating static facts silently;
- runtime patch validation against the exact binary/module/session.

Runtime observation may refine a runtime-specific evidence view; it cannot rewrite static semantic truth merely because it is newer.

### Gate S2-1

No architecture reaches A7 unless the complete declared A7 provider path is proven for that architecture/provider profile. A provider unavailable on iOS must render unavailable/partial rather than supported.

---

## Stage 2.2 — Managed M6 runtime/debug closure

For WASM, DEX, CIL, JVM, bind managed runtime/debug providers to the same identity/evidence rules as native runtime.

Required:

- module/container identity matches static analysis identity;
- VM/runtime address/index mapping is explicit;
- thread/frame/local/operand-stack state is versioned and bounded;
- runtime metadata disagreement is evidence, not silent static rewrite;
- unsupported runtime implementation/version remains explicit;
- provider cancellation/disconnect and stale events cannot become current state;
- solver/runtime integration never upgrades an unverified result to proof.

### Gate S2-2

M6 is promoted independently per frontend/provider profile. One JVM/Dex/WASM/.NET runtime working does not promote every runtime implementation.

---

## Stage 2.3 — Native F6 validated rebuild/patch closure

Replace R0 shadow-only behavior with a validated rebuild transaction.

A rebuild operation must model and validate, as applicable:

- byte/layout changes;
- section/segment placement;
- alignment;
- imports/exports;
- relocation rewriting;
- branch/displacement ranges;
- symbol/string/table offsets;
- unwind/debug metadata consequences;
- checksums/signatures/codesign consequences;
- file/header size/count fields;
- architecture-specific instruction encoding constraints;
- loader invariants;
- output identity.

### Mandatory transaction model

```text
PatchSet / high-level operation
  -> deterministic RebuildPlan
  -> all required validators execute
  -> produce temporary output
  -> owning Hex loader reparses
  -> independent parser/differential oracle where required/available
  -> semantic/structural postconditions verified
  -> atomic publication
```

A validator listed as required but not actually executed is a hard failure. “No validation failure recorded” is not equivalent to “validated”.

Support size-changing edits where the declared F6 contract permits them; do not define general rebuild as same-size-only byte replacement.

### Minimal counterexamples

1. inserted bytes move a relocation target;
2. branch displacement becomes out of range;
3. section growth changes file/virtual offsets;
4. unwind metadata points into moved code;
5. import/export table offset changes;
6. output reparses in Hex but independent parser rejects it;
7. one required validator is missing/unavailable;
8. atomic publish interrupted before final rename;
9. stale PatchSet targets different binary identity;
10. signing consequence is unknown but export path attempts to claim valid signature.

### Gate S2-3

Mach-O/ELF/PE F6 promotion occurs only per proven rebuild profile. No format-wide F6 claim from a narrow patch class.

---

## Stage 2.4 — Phase 12 knowledge / capability / pattern closure

### Knowledge packages / recognition

Complete:

- exact package identity and resolved dependency set;
- v2 compatibility/migration where required;
- deterministic indexes;
- bounded recognition;
- explicit provenance;
- update/removal invalidation;
- package text as untrusted data;
- externally asserted confirmation never minting local confirmation/verification;
- explicit local promotion policy;
- no network dependency resolution during deterministic analysis execution.

### Capability rules

Complete:

- typed rule schema/version;
- deterministic evaluation;
- completeness/truncation state;
- evidence provenance;
- resource budget/cancellation;
- contradiction handling;
- no AI/model prose as fact authority;
- no partial upstream evidence promoted to exact fact.

### Declarative patterns

Complete the declared pattern-language contract with:

- grammar/version;
- deterministic parsing/evaluation;
- bounded recursion/count/bytes/time;
- typed reads;
- explicit unknown/truncated states;
- no arbitrary JavaScript execution;
- no loader semantic mutation unless a later reviewed contract explicitly grants it;
- stable evidence identities;
- package distribution tied to exact package dependency identities.

### Gate S2-4

Knowledge/rule/pattern capability truth becomes supported only when deterministic execution, invalidation, authority, and negative oracles are all proven. Richer syntax alone is not completion.

---

## Stage 2.5 — Collaboration / remote authority closure

Local ChangeLog/replay is not remote collaboration completion.

Before remote durable effects, define and prove:

- authenticated project/session identity;
- authenticated actor/device identity where supported;
- authorization per operation/fact class;
- operation ID and replay/duplicate protection;
- project + binary scope binding;
- dependency/causal ordering;
- deterministic tie-break only where semantics allow;
- explicit unresolved conflicts for meaningful type/name/patch contradictions;
- bounded message/batch size;
- schema/version negotiation;
- stale/incompatible operation rejection;
- revocation behavior;
- transport confidentiality/integrity appropriate to data sensitivity;
- privacy/user authorization for binary-derived data leaving the device;
- raw binary bytes never uploaded implicitly;
- local user confirmation not minted from collaborator metadata;
- remote wall-clock time never used as semantic authority.

Required reconnect tests include replayed operations, wrong-project payload, wrong-binary payload, revoked actor, stale schema, duplicate delivery, out-of-order dependency delivery, and conflict convergence.

### Gate S2-5

Remote propagation is enabled only after the security gate is independently reviewed and exact-head verified. Local collaboration capability may remain separate from remote capability in support truth; do not merge their claims.

---

## Stage 2.6 — iPad/WebKit + product completion proof

Final completion is a browser/iPad product claim, so desktop Node tests are insufficient.

Required proof classes:

- production-faithful WebKit origin/iframe/navigation model;
- opaque/sandboxed location behavior where used;
- memory pressure and cancellation;
- IndexedDB/storage quota behavior;
- large binary navigation without whole-source reads;
- variable-length viewer behavior;
- worker lifecycle and late-result isolation;
- generated userscript/runtime activation identity where applicable;
- route/navigation/accessibility/mobile-state regressions;
- representative real native binaries, including a heavyweight Mach-O fixture when available;
- representative ELF/PE and managed fixtures;
- runtime/rebuild capabilities only on platforms/providers where they are actually available.

If physical iPad execution is required by the release contract and cannot be automated, record a signed/manual evidence record bound to exact build/commit/runtime identity. Do not silently substitute desktop Chromium.

---

# 6. Final issue/code audit gate

Before the final Phase 1–12 completion claim, perform a new duplicate-aware code audit against the exact candidate head.

The audit MUST:

1. enumerate current open issues that touch Phase 1–12 product correctness/support;
2. independently reproduce or disprove each issue on the candidate head;
3. verify closed issues that materially affected maturity/support claims have current regression evidence;
4. scan current owned source for incomplete branches, unsupported fallbacks, TODO/FIXME markers with semantic impact, and stale capability declarations;
5. check that every support-matrix `Partial`/`Unsupported` cell expected to be completed has an exact implementation/test/evidence link;
6. identify new deterministic defects with minimal counterexamples;
7. fix or block the release on every correctness defect that contradicts the 100% completion claim;
8. avoid filing duplicate issues when an existing issue already owns the same root cause/contract.

A clean issue list is not proof by itself; current code/test evidence wins.

---

# 7. Required final verification

At the final exact candidate head, run at minimum:

```bash
npm run check
npm run effects:test
npm run semantic-v2:test
npm run phase4:test
npm run phase5:test
npm run phase6:test
npm run phase7:test
npm run phase8:test
npm run phase9:test
npm run phase10:test
npm run phase11:test
npm run phase12:test
npm run binary:test
npm run integration:test
npm run runtime:test
npm run ui:test
npm run userscript:test
```

Also run the permanent exact-SHA verifiers relevant to each migrated capability, including the existing Phase 4/6/7/8/9/10/11/12 verifiers plus the new Stage 1/Stage 2 completion verifier.

Where a suite is already transitively included by `npm run check`, repeated focused execution is allowed for evidence clarity but does not replace the final full `npm run check`.

Release evidence MUST bind:

```text
candidate commit SHA
candidate tree SHA
reconciled main/base SHA
verifier source/version/hash
capability-maturity source hash
support-matrix projection hash
fixture/corpus identities
external oracle identities/versions/hashes where used
runtime/provider identities where used
browser/WebKit/iPad build identity where required
generated-output identity
working-tree cleanliness / immutable CI source identity
all required test/verifier results
```

Any acceptance-semantics change to a verifier invalidates earlier evidence.

---

# 8. Final support-truth cutover

Support truth is updated **last**, never first.

Order:

```text
implementation
 -> focused regression
 -> integration regression
 -> adversarial/negative proof
 -> exact-head verifier
 -> target-platform proof
 -> capability-maturity.js promotion
 -> SUPPORT_MATRIX.md projection
 -> current-facing docs/UI claim update
```

No cumulative maturity level may skip a partial prerequisite.

The final support matrix must contain no stale `Partial`/`Unsupported` state for any capability this program claims to have completed. Remaining unsupported states are allowed only when they are outside the declared product scope by explicit normative decision and are rendered honestly everywhere.

---

# 9. Final Definition of Done

The Phase 1–12 product may be called **100% complete under the declared architecture scope** only when all of the following are true:

- [ ] Stage 1 manifest has no unresolved item.
- [ ] Stage 2 manifest has no unresolved item.
- [ ] No architecture maturity claim skips incomplete A2/A7 prerequisites.
- [ ] Native format claims have proven F3/F4/F5/F6 to their declared scope.
- [ ] Managed M0–M6 claims are exact per declared frontend/runtime profile.
- [ ] Phase 12 knowledge, rules, patterns, collaboration, and rebuild claims match proven authority.
- [ ] No compatibility/oracle fallback silently supplies a promoted support claim.
- [ ] Persistence and plugin/provider contracts survive malformed, stale, over-budget, migration, quota, cancellation, and version-change cases.
- [ ] Solver/heuristic/runtime evidence cannot mint proof or static truth without the required authority.
- [ ] Remote collaboration has passed the separate security/privacy gate before remote durable effects are enabled.
- [ ] Rebuild executes every required validator and publishes atomically.
- [ ] Required independent parser/differential checks pass for promoted rebuild profiles.
- [ ] `npm run check` is green on the exact candidate head.
- [ ] focused and exact-SHA verifiers are green on that same head.
- [ ] generated outputs are synchronized and provenance-bound.
- [ ] current-main reconciliation has been performed and affected proof rerun.
- [ ] required iPad/WebKit/production-runtime evidence is green and identity-bound.
- [ ] final duplicate-aware issue/code audit has no unresolved correctness blocker contradicting the completion claim.
- [ ] `js/platform/capability-maturity.js`, `SUPPORT_MATRIX.md`, UI, docs, and actual source/tests agree.
- [ ] release evidence records the exact final commit/tree/build/runtime identities.

If any checkbox is false, the completion verdict is **NOT COMPLETE**.

---

# 10. Forbidden shortcuts

The following are merge/release blockers:

- changing support truth to make a partial implementation look complete;
- narrowing a corpus after a failure without a normative scope decision;
- using legacy fallback silently;
- treating decoder presence as exact MachineEffects proof;
- treating successful parse as F3/F4/F5/F6 proof;
- treating local ChangeLog as remote-collaboration completion;
- treating R0/same-size byte patching as general validated rebuild;
- allowing AI/provider/package/collaborator text to mint authority;
- allowing external `verified`/`user-confirmed` labels to become local verification;
- using timestamps to settle semantic conflicts;
- skipping required validators and reporting success because no failure was recorded;
- claiming iPad/WebKit completion from desktop-only tests;
- reusing green evidence after head/tree/verifier/corpus/provider identity changes;
- closing an issue solely because a PR is linked;
- opening a replacement integration PR merely because `main` moved;
- merging a red/unknown release gate;
- adding a second semantic engine to avoid fixing the canonical one.

---

# 11. Recommended PR topology

Use two long-lived authoritative integration PRs, one per stage, plus bounded component PRs:

```text
completion/stage1-integration
  <- stage1/effects-*
  <- stage1/semantic-alias-*
  <- stage1/formats-viewer-*
  <- stage1/analysis-solver-managed-*
  <- stage1/persistence-plugin-*

completion/stage2-integration
  <- stage2/native-runtime-*
  <- stage2/managed-runtime-*
  <- stage2/rebuild-*
  <- stage2/knowledge-rules-patterns-*
  <- stage2/collaboration-*
  <- stage2/ipad-webkit-proof-*
```

Do not create competing integration branches. Component PRs merge into the current stage integration branch first; the stage integration PR is reconciled to live `main`, fully verified, and only then merged to `main`.

---

# 12. Executor prompt skeleton

A lower-cost implementation agent can be given this compact contract:

```text
Repository: rhgrive3/hex
Read docs/POST_PHASE_COMPLETION_TWO_STAGE_PLAYBOOK.md first.
Treat HEX_MASTER_ARCHITECTURE.md, ENGINEERING_PROCESS_GUARDRAILS.md,
MIGRATION_GUARDRAILS.md, current source/tests, capability-maturity.js and
SUPPORT_MATRIX.md as higher authority.

Work only on the assigned Stage/Lane. Before coding, resolve live main, verify
ownership and the current completion-manifest state, then produce one minimal
positive fixture and one minimal counterexample. Do not create a second semantic
engine, do not silently fallback, do not promote capability truth before proof,
and do not weaken tests/corpora to get green. Integrate through the authoritative
stage integration branch. Done requires focused tests + canonical runner + exact-
head verifier green for the current integration SHA, with no unresolved blocker
for the assigned debt item.
```

The integration/release agent additionally owns moving-main reconciliation, generated outputs, support-truth promotion, full `npm run check`, exact-head evidence, and final stage cutover.

---

# 13. Maintenance rule

This playbook is an execution contract, not current capability truth.

When the repository changes:

1. source/tests remain authoritative for actual behavior;
2. `capability-maturity.js` remains authoritative for machine-readable maturity;
3. `SUPPORT_MATRIX.md` remains its human projection;
4. the completion manifest must be regenerated from current truth at Stage 1.0/Stage 2.0;
5. this document may be updated to improve execution, but MUST NOT preserve a stale “current main”, stale issue count, or stale support claim.

The intended end state is simple:

> **No hidden debt behind a green phase label. Every remaining Phase 1–12 gap is either proven complete on the exact product or explicitly and normatively outside the declared product scope.**
