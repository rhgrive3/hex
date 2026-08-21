# Phase 9 — Start Here

> Status: **Phase 9 solver-backed verification is implemented for the bounded exact Bool/BV scope described below.**

## Exact starting point

The historical Phase 9 handoff was reconciled onto live `main`:

- commit: `b9728ded0913d39b9886df7e66a7e07bb6153ab9`
- tree: `10a14553c15a499c14b611efb336dc536bf758e2`
- Phase 8 production candidate: `e88c45791ed7f294d0df865ae7001cc45212d0bb`
- Phase 8 P8-I: accepted / `READY`
- Phase 8 evidence digest: `a021e9dec2818c2e3efc56ec51d2d567`

The Phase 8 final handoff identity remains recorded in `reports/phase9/preflight.json` as historical evidence. The current commit/tree recorded by the canonical Phase 9 verifier are authoritative after subsequent correctness and runtime integrations.

The old planning baseline in the Phase 9 guide is historical. Current source/tests and this exact main identity are authoritative for implementation work.

## Read first

1. `docs/HEX_MASTER_ARCHITECTURE.md`
2. `docs/PHASE9_SOLVER_BACKED_VERIFICATION_IMPLEMENTATION_GUIDE.ja.md`
3. `docs/PHASE9_WORKER_PROMPTS.ja.md`
4. `reports/phase9/preflight.json`

## What is ready now

The implemented bounded exact path includes:

- `hex-exhaustive-bv` exact finite-domain backend plus isolated browser Worker transport
- explicit proof authority, independent SAT-model validation, lifecycle invalidation, and versioned evidence/cache identity
- fail-closed Semantic IR translation, global path certificates, and vacuous-proof guards

The existing bounded symbolic evaluator remains the fast path and is not replaced.

## Fail-closed decisions

Outside the explicitly supported contract:

- no proof-producing result for unsupported/incomplete semantics, stale lifecycle state, or non-exact providers
- no local edge-infeasibility result may be presented as global unreachability
- no automatic cache reuse for Phase 9 proof tools
- no remote solver data egress

`ToolRegistry` keeps proof tools on the no-auto-cache fallback; any future proof
cache must retain the verifier/backend/query/Expr/translator/semantic identity
contract implemented by `cache-policy.js`.

The initial real provider is `hex-exhaustive-bv`. It is exact only after complete
finite-domain enumeration; width/assignment limits fail closed. Browser builds
use the dedicated Worker transport and userscript builds include the worker as
a protected module asset.

## First vertical slice

The first product proof is **Conditional Edge Feasibility**:

> Given explicit, satisfiable source-block-entry preconditions, does an input/state exist that takes the selected conditional edge?

It must not be labeled global reachability. An UNSAT solver result alone is never sufficient for `proved`; translation/scope completeness, explicit assumptions, satisfiable preconditions, supported semantics, exact backend capability, and clean budget/cancellation state are required.

## Boundary for future solver expansion

Any expansion beyond the bounded exact scope must first preserve and extend:

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
