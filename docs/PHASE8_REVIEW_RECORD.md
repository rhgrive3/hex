# Phase 8 Pre-Implementation Review Record

> **Review target:** Phase 8 implementation planning docs on `docs/phase8-decompiler-quality-playbook`  
> **Prepared baseline:** `main` = `e90c5107f9c77d73687ee452d5042dcbe9e79ece`  
> **Reviews performed:** 3  
> **Scope:** design/process review only; no Phase 8 production implementation is claimed

This record exists so the three requested review passes and their corrections are durable rather than only conversational.

---

## Review 1 — Architecture / Scope / Dependency Review

### Reviewed against

- `docs/HEX_MASTER_ARCHITECTURE.md` Phase 7/8/9 migration ordering;
- Master Architecture §18 decompiler pipeline/middle-end/structuring/pass-contract requirements;
- architecture/ABI/type/MemorySSA/alias invariants;
- `docs/MIGRATION_GUARDRAILS.md` semantic decompiler boundary.

### Findings

1. The first implementation guide covered the eight explicit Phase 8 migration deliverables but did not fully account for the broader mandatory mature middle-end inventory in Master Architecture §18.2.
2. Existing capabilities such as copy propagation-like behavior, MemorySSA reaching-store substitution, prototype recovery, variable coalescing, switch/loop recovery, and aggregate layout recovery needed an explicit **audit-before-reimplement** rule.
3. Prepared-baseline source still showed AAPCS64 assumptions in `types/prototype.js` and `types/high-variables.js`. Phase 8 planning needed a hard cross-architecture re-audit after Phase 5/6/7 rather than assuming those files would already be generic.
4. Phase 7 facts needed to be identified as upstream authority. The decompiler must not compensate for missing alias/effect/type/summary facts with private heuristics.
5. Phase 9 solver work needed an explicit boundary so Phase 8 would not accidentally expand into an SMT project.

### Corrections made

- Added a complete P8-0 readiness matrix covering the broader §18.2 middle-end inventory.
- Added explicit states: `PROVEN_EXISTING`, `PARTIAL_EXISTING`, `PHASE8_IMPLEMENT`, `UPSTREAM_BLOCKED`, `INTEGRATION_ONLY`, `NOT_REQUIRED_FOR_P8_EXIT`.
- Added live-main re-audit of ABI/prototype/high-variable architecture assumptions.
- Added the rule that missing upstream facts are repaired at their owner layer.
- Kept solver-backed verification in Phase 9 scope while preparing Phase 8 transform contracts for future stronger proof.

### Review 1 result

**PASS after correction.** Scope is now dependency-driven instead of feature-list-driven.

---

## Review 2 — Implementation / Failure Semantics / Correctness Review

### Reviewed against

- `js/decompiler/passes/manager.js`;
- `js/decompiler/pipeline-core.js`;
- `js/decompiler/pipeline.js`;
- `js/decompiler/rewrite/engine.js`;
- `js/decompiler/types/layout.js`;
- `js/decompiler/types/high-variables.js`;
- `js/decompiler/types/prototype.js`;
- existing Ghidra/compiler-truth verification path.

### Findings

1. Current `PassManager` uses a global deadline and may skip optional passes. Heavy Phase 8 fixed-point work therefore creates a real risk of **partial mutation becoming authoritative** unless publication semantics are strengthened.
2. Current pipeline is a flat ordered pass list. Phase 8 analyses have real dependencies and invalidation relationships that should not be represented only by incidental array order.
3. Current rewrite engine already has strong reusable properties: named phases, preconditions, proof records, deterministic structural keys, fixed-point limits, and multiple budgets. Creating a second rewrite framework would be unnecessary architecture drift.
4. Current MemorySSA reaching-store substitution demonstrates the correct memory-proof direction. GVN/CSE/DCE must consume MemorySSA/alias/effect proof, not duplicate address heuristics.
5. Phase 8 needed explicit analysis-preservation/invalidation rules for CFG, dominators, loop facts, SSA, MemorySSA, ranges, value numbers, types, summaries, and origin maps.
6. Budget/degraded output needed to remain a completeness state, not silently become equivalent to complete analysis.

### Corrections made

- Added a staged/atomic pass transaction contract.
- Prohibited decompiler-readability work from mutating canonical Semantic IR/SSA/MemorySSA in place.
- Added `consumes / preserves / invalidates` analysis declarations.
- Added deterministic safe-publication behavior for cancellation/deadline/exception paths.
- Added a staged pipeline model from canonical semantic facts through scalar optimization, memory optimization, loop facts, high-level recovery, structuring, providers, and rendering.
- Added explicit SCCP, wrapped-range, memory-GVN, effect-aware DCE, induction, structuring, aggregate, provider, provenance, invalidation, and browser-budget contracts.
- Added under-invalidation and over-invalidation as separate required regressions.

### Review 2 result

**PASS after correction.** The plan now defines what happens when a pass succeeds, skips, times out, cancels, changes control flow, or invalidates downstream facts.

---

## Review 3 — Execution / Integration / Release Review

### Reviewed against

- `docs/ENGINEERING_PROCESS_GUARDRAILS.md` phase preflight, candidate merge-tree proof, checkpoint transaction, verifier maturity, moving-main, generated-output, iOS/browser truth, and completion requirements;
- historical process failure classes from Phase 3/4/5;
- the revised Phase 8 execution blueprint;
- final branch diff against prepared `main`.

### Findings

1. The execution blueprint defined the dependency DAG and final release gate, but each P8 checkpoint still needed a single explicit contract for **inputs / deliverables / required proof / merge blockers / handoff**.
2. Without those contracts, implementers could still reinterpret “done” per lane and recreate late integration.
3. The plan needed a durable mapping from known historical process failures to Phase 8 prevention mechanisms.
4. The first-deterministic-divergence rule needed to be explicit for rolling-gate failures.
5. Final docs needed to remain planning-only and avoid claiming current Phase 8 infrastructure that does not exist yet.

### Corrections made

Added `PHASE8_CHECKPOINT_CONTRACTS.md` and `.ja.md` with explicit contracts for global start blockers, P8-0 through P8-7, and P8-I integration/cutover. Also added candidate merge-tree proof, checkpoint locking, generated-output ownership/synchronization, moving-main single-owner behavior, a process-failure recurrence map, first-divergence debugging, and exact hard-zero release gates.

The final branch diff remains docs-only. Proposed Phase 8 files/commands/infrastructure are explicitly labeled as proposals to be generated/revalidated at P8-0 rather than present-tense implementation claims.

### Review 3 result

**PASS after correction.** A future implementation owner can now determine when each checkpoint may start, what it owns, what evidence it must produce, what blocks merge, and exactly what it hands to the next dependency.

---

# Final review conclusion

No unresolved architecture/process contradiction was found in the planning set against the prepared baseline after the three correction passes.

The remaining unknowns are deliberately future-sensitive and must be resolved from live evidence at P8-0:

- actual `main` SHA when Phase 8 begins;
- exact Phase 6 and Phase 7 completion state;
- then-current decompiler/ABI architecture debt;
- actual Phase 8 ownership paths;
- exact mandatory corpus/toolchain availability;
- exact generated-output/build relationship;
- exact baseline quality/performance numbers;
- exact verifier/workflow identities.

Those are **not gaps to guess now**. The planning docs turn each one into a mandatory P8-0 observation/gate.

The Phase 8 planning set is therefore ready for pre-implementation merge as documentation, without claiming that Phase 8 itself has started or passed any production exit gate.
