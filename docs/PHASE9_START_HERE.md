# Phase 9 — Start Here

> Status: **P9-0 foundation / Wave 0 ready**. This document does not claim solver-backed verification is implemented.

## Exact starting point

The living Phase 9 integration branch is reconciled onto live `main`:

- commit: `b9728ded0913d39b9886df7e66a7e07bb6153ab9`
- tree: `10a14553c15a499c14b611efb336dc536bf758e2`
- Phase 8 production candidate: `e88c45791ed7f294d0df865ae7001cc45212d0bb`
- Phase 8 P8-I: accepted / `READY`
- Phase 8 evidence digest: `a021e9dec2818c2e3efc56ec51d2d567`

The Phase 8 final handoff identity remains recorded in `reports/phase9/preflight.json` as historical evidence. The live-main commit/tree above are the authoritative implementation base after subsequent correctness and runtime integrations.

The old planning baseline in the Phase 9 guide is historical. Current source/tests and this exact main identity are authoritative for implementation work.

## Read first

1. `docs/HEX_MASTER_ARCHITECTURE.md`
2. `docs/PHASE9_SOLVER_BACKED_VERIFICATION_IMPLEMENTATION_GUIDE.ja.md`
3. `docs/PHASE9_WORKER_PROMPTS.ja.md`
4. `reports/phase9/preflight.json`

## What is ready now

Wave 0 may begin in parallel on:

- contract + adversarial false-proof corpus
- solver-neutral Bool/BV expression DAG and pure evaluator
- translator/slicing scaffolding against the frozen public contracts
- `SolverBackend` lifecycle + fake backend
- real-solver provider ADR investigation

The existing bounded symbolic evaluator remains the fast path and is not replaced.

## Fail-closed decisions

Until the relevant contract is frozen:

- no proof-producing public API
- no local edge-infeasibility result may be presented as global unreachability
- no automatic cache reuse for Phase 9 proof tools
- no remote solver data egress

Current `ToolRegistry` defaults deterministic tools to cacheable, and current `ObservationStore` keys cache entries by analysis binding + tool + serialized args. Phase 9 must therefore include verifier/backend/query/Expr/translator/semantic versions in the effective identity before proof caching is enabled. Until then, proof tools use the documented no-auto-cache fallback.

The first real solver provider is deliberately unselected at P9-0. That does not block Wave 0; it must be resolved before the first real backend is promoted.

## First vertical slice

The first product proof is **Conditional Edge Feasibility**:

> Given explicit, satisfiable source-block-entry preconditions, does an input/state exist that takes the selected conditional edge?

It must not be labeled global reachability. An UNSAT solver result alone is never sufficient for `proved`; translation/scope completeness, explicit assumptions, satisfiable preconditions, supported semantics, exact backend capability, and clean budget/cancellation state are required.

## Definition of Ready for Wave 1

Freeze and test all of the following before proof-producing integration work expands:

- `SolverResult` taxonomy
- `VerificationResult` taxonomy
- proof-eligibility predicate
- precondition consistency / vacuous-proof policy
- claim/query polarity
- Bool/BV expression schema and serialization identity
- assumption taxonomy
- completeness dimensions
- budget/cancellation schema
- initial support matrix
- proof-cache policy / verifier fingerprint
- remote-provider policy criteria
- golden/adversarial corpus format

## Canonical P9-0 check

```sh
node tests/phase9/run.mjs
```

The dedicated `Phase 9 preflight` workflow additionally reruns the Phase 8 handoff, migration guardrails, and Semantic IR v2 contracts on the exact Phase 9 integration head.
