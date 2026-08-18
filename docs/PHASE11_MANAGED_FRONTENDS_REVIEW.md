# Phase 11 Managed Frontends — Three-Pass Review Record

Status: **review complete**  
Reviewed document: [`PHASE11_MANAGED_FRONTENDS_PLAYBOOK.md`](./PHASE11_MANAGED_FRONTENDS_PLAYBOOK.md)  
Planning base: `main` at `e90c5107f9c77d73687ee452d5042dcbe9e79ece`  
Hardened playbook commit: `2428caed7f6044f7d7219ec085b9b4673bbd8b4a`  
Review date: 2026-08-18

This file records three independent review passes requested before treating the Phase 11 playbook as ready for future implementation planning.

It is not Phase 11 release evidence. Phase 11 has not started and no managed frontend capability is claimed by this review.

---

# Review 1 — Architecture and semantic-contract review

## Goal

Check that the playbook is consistent with the Hex Master Architecture and the current low-level semantic contracts, and that it does not create a second semantic truth.

## Inputs checked

- `docs/HEX_MASTER_ARCHITECTURE.md`
- current `js/platform/capability-maturity.js`
- current `js/semantics/effects/index.js`
- current `js/semantics/**` namespace shape
- the initial Phase 11 playbook revision

## Findings in the initial revision

### R1-F1 — VMEffects needed a stricter contract

The first revision named VMEffects operation families but did not make the contract strict enough to match the safety discipline now present in MachineEffects.

### Resolution

The hardened playbook now requires:

- schema and contract versions;
- per-operation identity;
- explicit completeness states;
- explicit unknown effects;
- no silent preserve/no-op fallback;
- source origin;
- cancellation/resource budgets through the frontend contract;
- semantic completeness separated from target-resolution completeness.

See playbook sections 10–12.

### R1-F2 — Value identity and VM storage location were under-specified

Without a hard separation, DEX registers and JVM/CIL local slots could accidentally become recovered source-variable identities.

### Resolution

The playbook now defines separate `VMValue` and `VMLocation` concepts plus `VMFrameState`. Wide/category values remain one logical value even when they occupy multiple VM storage slots.

See sections 10 and 27.

### R1-F3 — Native address/function assumptions could leak into managed consumers

The initial revision said managed identities were needed, but it did not make the shared navigation/query boundary concrete enough.

### Resolution

The hardened playbook adds a `CallableRef` / `CodeLocation` union concept and a native-address detox audit covering navigation, xrefs, decompiler maps, evidence, search, AI tools, bookmarks, and project facts.

See sections 6 and 20.

### R1-F4 — Validation was not a first-class durable artifact

Stack/register verification state cannot be reconstructed safely after lowering.

### Resolution

The hardened playbook introduces `ManagedValidationReport`, four independent completeness axes, handler/join state rules, and invalid-but-inspectable behavior.

See sections 12 and 14.

### R1-F5 — Metadata authority was too broad

The initial guidance risked reading “metadata-first” as “all metadata is hard truth.”

### Resolution

The hardened playbook classifies metadata into execution/validation authoritative, declared nominal/source, debug/projection, and producer/custom classes. Only appropriate valid execution metadata becomes hard constraints.

See section 13.

## Review 1 verdict

**PASS — no blocking architecture contradiction remains in the planning document.**

Important intentional open point: the exact physical common envelope between MachineEffects and VMEffects is deliberately deferred until Phase 11 preflight. The architectural requirement is shared safety discipline and one downstream semantic truth, not identical native/VM schemas.

---

# Review 2 — Engineering-process, CI, integration, and iPad review

## Goal

Check the playbook against `docs/ENGINEERING_PROCESS_GUARDRAILS.md`, especially the failures already observed in earlier master phases.

## Inputs checked

- `docs/ENGINEERING_PROCESS_GUARDRAILS.md`
- current support-maturity implementation
- initial/hardened Phase 11 playbook

## Findings in the initial revision

### R2-F1 — The exit contract was still too prose-heavy

The first revision described M0–M6 but did not define enough machine-checkable release fields.

### Resolution

The hardened version adds:

- a proposed minimum phase exit contract;
- explicit M0–M6 acceptance conditions;
- a per-frontend verifier schema;
- a release evidence schema;
- preflight, component, checkpoint, and final release checklists.

See sections 4, 21, 34, and 46–50.

### R2-F2 — Target-device evidence was optional-looking

The first revision described browser/iPad constraints but used language that could allow desktop proof to substitute for real target behavior.

### Resolution

The hardened playbook makes real iPadOS/WebKit product evidence mandatory for Phase 11 release for representative open, selected-method analysis, cancel, navigation, cache reuse, memory, and responsiveness behavior.

See section 30.5 and the final release checklist.

### R2-F3 — CI artifact publication was not explicit enough

Earlier Hex phases already experienced invalid/empty evidence artifact publication.

### Resolution

The hardened verifier contract requires temporary output, schema/fixture validation, successful producer status, and atomic publish/rename. Aggregators fail closed on missing/empty/partial output.

See section 34.4.

### R2-F4 — Long-running campaign resume state was not concrete enough

Phase 11 is likely to span many component integrations and moving-main reconciliations.

### Resolution

The hardened playbook defines a durable repository-visible Phase 11 checkpoint with exact base/integration/verifier/corpus/support/blocker/next-action identity.

See section 39.

### R2-F5 — Shared-contract changes after fanout needed a controlled handoff

Otherwise a target lane could silently edit shared semantics and invalidate sibling evidence.

### Resolution

The hardened playbook adds a typed integration handoff contract and assigns shared contract changes to foundation/integration ownership with evidence invalidation and revalidation.

See section 37.1.

## Guardrail recurrence audit

The hardened playbook now contains direct prevention for the most relevant historical failure classes:

| Historical class | Phase 11 prevention |
|---|---|
| late integration | living integration + WASM vertical skeleton before fanout |
| cross-scope contamination | lane allowlists + actual changed-file proof |
| ownership contradictions | foundation negative ownership tests |
| nested tests not discovered | sentinel discovery in canonical runner |
| verifier assembled too late | exact-SHA verifier at foundation |
| moving-main churn | one living integration reconciliation owner |
| invalid evidence artifacts | atomic validated publication |
| CI fanout hiding hot paths | profile production hot path first |
| generated-output confusion | integration owner + checkpoint transaction |
| capability overclaim | cumulative M0–M6 registry transaction |
| desktop assumptions | mandatory real iPad/WebKit proof |
| campaign resume loss | durable Phase 11 checkpoint |

## Review 2 verdict

**PASS — no blocking process/CI/iPad omission remains at planning level.**

The exact workflow file names, CI partitions, numeric thresholds, and ownership paths remain intentionally open until the live Phase 10 tree is audited.

---

# Review 3 — Adversarial target-spec and future-debt review

## Goal

Assume each frontend is implemented by a competent engineer who follows the high-level plan but takes the easiest local shortcut. Identify where that shortcut would create false semantics, identity collisions, invalid support claims, or future rewrites.

## Primary references checked

- WebAssembly Core Specification and validation algorithm
- Android/AOSP DEX format, bytecode, instruction-format, and constraint documentation
- ECMA-335 Common Language Infrastructure
- current Java Virtual Machine Specification
- Hex `SOURCES.md` differential references such as JADX and ILSpy

## Findings in the initial revision

### R3-F1 — VM/spec version drift could make artifacts non-reproducible

“WASM”, “DEX”, or “JVM” is not a sufficient semantic version.

### Resolution

The hardened playbook introduces `ManagedTargetProfile` and requires spec/format/version/feature identity in artifact keys and release evidence. Auto-detection must resolve to a concrete profile before artifacts are created.

See section 5.

### R3-F2 — Modern DEX container behavior could break old subfile assumptions

Current Android documentation describes modern DEX container behavior where logical DEX data can share physical container data and offset semantics differ from a naive self-contained subfile model.

### Resolution

The DEX lane now treats this as a container/identity/mapping contract and explicitly forbids assuming every logical DEX is an isolated header-relative byte slice.

See sections 7 and 24.

### R3-F3 — CLR/CIL can coexist with native PE semantics

Treating CIL as an unrelated standalone loader could erase or duplicate native PE identity.

### Resolution

The hardened playbook models one `BinaryId` with associated native `BinaryImage` and managed CLI view, linked by shared source provenance but separate semantic domains.

See section 7.

### R3-F4 — JVM verifier state was not deep enough

Stack height alone is insufficient. JVM analysis needs verification types, StackMap state where applicable, category-2 values, and uninitialized-object state around constructors.

### Resolution

These are now explicit JVM preservation requirements and part of the general validation/frame-state design.

See sections 10, 12, and 26.

### R3-F5 — Dynamic linking/initialization side effects could be erased

Managed runtimes may resolve/link/initialize state as part of operations that look like simple calls/field accesses.

### Resolution

The hardened playbook requires effect-summarized runtime/linkage intrinsics or explicit unknown effects when full modeling is unavailable. It forbids treating unresolved runtime behavior as a pure lookup.

See section 16.3.

### R3-F6 — Invalid code needed an analyst-safe state

Reject-only behavior loses useful reverse-engineering evidence; repair-and-continue behavior invents semantics.

### Resolution

The hardened policy is invalid-but-inspectable: preserve safely decoded evidence, expose verifier failure, and block exact executable-semantic claims where invalidity matters.

See section 12.2.

### R3-F7 — Package-scale object explosion could make a semantically correct design unusable on iPad

A per-instruction heavyweight JS graph for every method in a package would violate the product architecture.

### Resolution

The hardened plan requires lazy method artifacts, compact/columnar representations where practical, paged queries, virtualized UI, and real target memory/performance evidence.

See section 30.

### R3-F8 — Differential decompiler output could be mistaken for truth

JADX/ILSpy are useful references but do not override target specifications or Hex provenance.

### Resolution

The hardened oracle priority is normative spec/tests → official runtime/verifier/toolchain → trusted primary implementation → decompiler differential as diagnostic evidence.

See section 33.3.

## Review 3 verdict

**PASS — no blocking target-spec/future-debt issue remains in the planning document.**

Intentional deferred decisions remain listed in playbook section 44. They are deferred because choosing them now would freeze assumptions about the live Phase 10 product or future upstream versions, not because they were missed.

---

# Final review verdict

The Phase 11 playbook is **READY AS A PRE-PHASE EXECUTION GUIDE**.

This means:

- the architecture is coherent enough to start P11-F0 later;
- the hard problems are identified before frontend implementation;
- the integration and evidence process is defined before fanout;
- known target-specific traps are surfaced;
- open decisions are explicitly separated from fixed architecture decisions.

It does **not** mean Phase 11 implementation is complete, that any M-level has been promoted, or that the planning-time source/spec versions should be used without re-verification when Phase 11 actually starts.
