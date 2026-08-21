# Hex Master Architecture Specification

> **Status:** Canonical target architecture amendment  
> **Version:** 1.1  
> **Repository:** `rhgrive3/hex`  
> **Primary product constraint:** Browser/iPad-first, universal binary analysis, beginner-to-expert, evidence-first  
> **Normative body:** [`archive/architecture/HEX_MASTER_ARCHITECTURE-v1.0-574429289786c9d3d8998c8240b67d56c8029b1b.md`](archive/architecture/HEX_MASTER_ARCHITECTURE-v1.0-574429289786c9d3d8998c8240b67d56c8029b1b.md)  
> **Current capability truth:** [`SUPPORT_MATRIX.md`](SUPPORT_MATRIX.md), projected from `js/platform/capability-maturity.js`  
> **Research evidence:** [`SOURCES.md`](SOURCES.md) and the historical research snapshot

## 0. How this specification is composed

The archived v1.0 document remains the full normative architecture body and is incorporated here by reference. This v1.1 amendment exists so that durable architecture invariants are not mixed with stale observational statements about a rapidly moving implementation.

Unless this file explicitly overrides a v1.0 statement, the corresponding v1.0 requirement remains normative. If an archived sentence describes what Hex **currently** implements, what a current module **currently** owns, which route is **currently** the default, or which stage is **currently** unsupported, that observational statement is historical and MUST be revalidated against current source/tests and the machine-readable capability truth before being used.

Normative architecture changes still require an accepted ADR or an update to this specification. Historical implementation snapshots never outrank live source/tests for present behavior.

## 1. Authority and source-of-truth order

Use the following order when documents disagree:

1. This v1.1 amendment together with the incorporated v1.0 normative body.
2. An accepted Architecture Decision Record merged after the relevant specification text.
3. Versioned public API/schema contracts.
4. Current source code and tests, for what Hex actually does today.
5. `js/platform/capability-maturity.js` and `docs/SUPPORT_MATRIX.md`, for graded support claims.
6. `docs/SOURCES.md`, for durable external research evidence.
7. Historical research/checkpoint documents, for context only.

`REFERENCES.md` is not a current repository authority. Older references to it mean `SOURCES.md` unless a future reviewed document explicitly introduces a new durable reference index.

## 2. Non-negotiable architectural invariants

All invariants in the incorporated v1.0 body remain normative, including in particular:

- one semantic truth with inspectable provenance;
- explicit unknown/unsupported states;
- conservative alias, call, control-flow and memory reasoning;
- architecture, ABI, platform and language separation;
- parser/loader separation;
- runtime evidence never silently overwriting static truth;
- no semantic authority for model prose;
- one analysis truth for beginner and expert projections;
- graded capability rather than boolean support;
- demand-driven, cancellable and budgeted work;
- separation of user/project facts from derived analysis artifacts;
- no big-bang semantic rewrite;
- performance work must not trade correctness for confidence.

The archived text is retained precisely so these detailed contracts, schemas, phases and rationale remain reviewable without rewriting history.

## 3. Current implementation state

This section is an observational summary, not a frozen release promise. When exact current state matters, inspect the current source/test evidence and `js/platform/capability-maturity.js`.

The following statements supersede stale v1.0 current-state/debt descriptions:

1. `js/ir-core.js` is now a **compatibility facade**. Semantic IR v2 compatibility is the production default; the legacy ARM64 implementation remains an explicit compatibility/oracle mode. It is no longer correct to describe the current file as one monolithic mixed core that itself owns ARM64 lifting, AAPCS64 interpretation and SSA/MemorySSA as the only production path.
2. x86-64 is not decode-only. Current capability truth carries x86-64 through implemented depth **A6** (Semantic IR/CFG, SSA/MemorySSA and shared decompiler are present for the proven corpus), while cumulative maturity remains **A1** because complete A2 exact MachineEffects coverage is not yet proven for the whole ISA contract.
3. RISC-V64 has a first-class Phase 6 vertical for the frozen RV64IMC/LP64 profile and likewise reaches implemented depth **A6**, with cumulative maturity **A1** for the same conservative A2 reason.
4. ARM64/ARM64e retain substantial semantic/decompiler capability, but incomplete exact MachineEffects coverage keeps cumulative maturity at A1. No architecture may be promoted past an incomplete prerequisite merely because later-stage implementation exists.
5. The canonical product UI default route is **Code** (`/code`), not Investigate. Investigate remains a primary one-tap workflow.
6. Current plugin contribution truth comes from `js/platform/plugin-api.js`; the registry includes format, architecture, analyzer, knowledge, signature, recognition, view and goal contribution categories. Future categories must be added explicitly rather than inferred from prose.

## 4. Current architectural debt

The highest-value remaining debt is boundary completeness and proof coverage, not the absence of an analysis stack.

The two-stage execution sequence for closing the remaining Phase 1–12 debt is consolidated in [`POST_PHASE_COMPLETION_TWO_STAGE_PLAYBOOK.md`](./POST_PHASE_COMPLETION_TWO_STAGE_PLAYBOOK.md). Its mandatory proof-hardening amendment is [`POST_PHASE_COMPLETION_100_PERCENT_HARDENING.md`](./POST_PHASE_COMPLETION_100_PERCENT_HARDENING.md). Completion work MUST read both. Within that planning set, the hardening amendment wins over weaker execution wording and specifically forbids scope reduction, denominator shrinkage, skipped validators, optional physical-iPad proof, hidden fallback, or head-only release proof as routes to a `100%` verdict. Both documents are subordinate to this specification and current source/test/capability truth; neither defines a Phase 13/14 architecture extension.

- Complete architecture-wide exact MachineEffects coverage sufficiently to satisfy A2 cumulatively, while retaining explicit unsupported/partial semantics.
- Continue removing architecture/ABI assumptions from generic semantic, type-recovery and decompiler code without creating a second semantic engine.
- Improve points-to/alias precision, region reasoning, interprocedural summaries and global type/prototype constraints conservatively.
- Finish variable-length architecture viewer/product integration rather than treating working semantic pipelines as if they were decode-only.
- Scale project/artifact persistence beyond `.hexproj` v1 while preserving the v1 exchange contract.
- Expand stable plugin contracts only where ownership, isolation, budgets and versioning are defined.
- Increase symbolic/runtime/debugger/emulation depth without allowing observations to mutate static truth silently.
- Add managed/VM frontends only through the same graded capability and evidence model.
- Keep iOS/WebKit memory, DOM, cancellation and target-platform behavior as release constraints rather than desktop-only afterthoughts.

## 5. Current-state maintenance rule

A document that records an old branch, phase, commit, corpus or research snapshot MAY remain historical, but it MUST identify itself as historical and MUST NOT use unqualified words such as `current`, `next`, `unsupported`, `not started`, or `default` to override live evidence.

When implementation maturity changes:

1. update the owning source/schema and tests first;
2. update `js/platform/capability-maturity.js` when support truth changes;
3. update `SUPPORT_MATRIX.md` as its human projection;
4. update any current-facing architecture/UI/platform/AI document in the same change;
5. retain old checkpoints under `docs/archive/` or clearly label them historical rather than rewriting their evidence.

This amendment deliberately separates durable architecture from moving implementation truth so that the same stale-document failure does not recur.
