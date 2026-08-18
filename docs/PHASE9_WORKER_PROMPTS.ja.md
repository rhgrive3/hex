# Phase 9 — Worker 実行プロンプト / Ownership Map

> **Purpose:** `PHASE9_SOLVER_BACKED_VERIFICATION_IMPLEMENTATION_GUIDE.ja.md` を高速・安全に実作業へ落とす ready-to-use 分担テンプレート。  
> **Status:** Planning only. Phase 9 実装済みの証拠ではない。  
> **Base rule:** 実装開始時の最新 `main` exact SHA を固定し、最終検証も exact integrated head SHA で行う。  
> **Review hardening:** soundness / parallel efficiency / exit-gate の3観点レビューを反映済み。

---

# 0. 全 Worker 共通ルール

```text
Repository: rhgrive3/hex
Target: Master Architecture Phase 9 — Solver-backed verification
Canonical guide: docs/PHASE9_SOLVER_BACKED_VERIFICATION_IMPLEMENTATION_GUIDE.ja.md

Do not:
- replace the current bounded symbolic evaluator wholesale
- treat timeout/resource-limit/unsupported/unknown as UNSAT
- treat UNSAT alone as sufficient for a proved verdict
- reinterpret machine instruction mnemonics in generic symbolic code
- turn UnknownSemantic into an unconstrained input automatically
- expose backend-native AST/model objects through public APIs
- ignore declared memory/control/call/trap side effects in equivalence
- call local edge infeasibility "globally unreachable"
- trust a SAT model without validation where the supported evaluator can check it
- use query hash equality as semantic equality without payload/version validation
- cache timeout/provider-failure as semantic truth
- silently send project-derived constraints to a remote solver
- claim a memory budget is enforced when it is measurement-only
- let AI prose create verified facts
- invent tests, CI state, repository state, or external results

Required:
- preserve provenance/evidence
- preserve conservative unknown behavior
- keep claim scope/preconditions/completeness explicit
- make expensive work budgeted/cancellable
- report exact files changed
- report exact tests actually run
- report unresolved unsupported semantics
- report exact reviewed/tested SHA
```

---

# 1. Integration Owner

## Mission

Phase 9 semantic contract、proof eligibility、shared seams、integration gate を所有する。

## Initial preflight

Coding 前に exact `main` SHA で確認:

```text
Semantic IR schema/version
SSA identities
MemorySSA reaching-def contract
alias taxonomy
call/effect summaries
origin/provenance
patch projection/validation
EvidenceGraph/evidence schema
cancellation/budget primitives
current symbolic regression suite
```

Prerequisite が未統合なら competing model を作らせない。

## Shared ownership

Integration Owner が最終管理:

```text
js/symbolic/executor.js
js/symbolic/function-sandbox.js
js/agent/tools.js
js/ai/tools/registry.js
js/ai/tools/names.js
package.json
shared evidence/public schemas
CI/gate wiring
```

ただし shared edits を Phase 最後まで溜めない。

各 vertical slice 後に小さい integration commit を入れる。

## Wave0 contract freeze

最初に固定:

```text
SolverResult taxonomy
VerificationResult taxonomy
proof eligibility predicate
claim/query polarity
Bool/BV schema
assumption taxonomy
completeness dimensions
initial support matrix
budget schema
remote solver policy decision criteria
golden/adversarial corpus format
```

## Exit

```text
conditional edge feasibility E2E
bounded equivalence E2E
patch verification E2E
strong/global reachability only if path-completeness contract is satisfied
budget/cancel/dispose E2E
evidence chain E2E
SAT model validation E2E where supported
existing regressions green
independent soundness review resolved
```

---

# 2. Worker F0 — Contract / Adversarial Corpus Owner

Worker F は終盤要員ではなく **Wave0 から開始**する。

## Mission

実装前に false-proof を再現する golden corpus と contract tests を用意する。

## Preferred ownership

```text
tests/phase9-*/**
tools/phase9-* where needed
benchmark/golden fixtures
```

CI/package wiring は Integration Owner と調整。

## Wave0 corpus

最低限:

```text
SAT
UNSAT
UNKNOWN
TIMEOUT
RESOURCE_LIMIT
UNSUPPORTED
CANCELLED
PROVIDER_FAILURE
INVALID_QUERY
```

false-proof fixtures:

```text
partial translation + UNSAT must NOT prove
unsupported dependency + UNSAT-like fake must NOT prove
local edge infeasible must NOT become global unreachable
incomplete incoming path coverage must NOT prove global unreachable
UnknownSemantic must NOT become FreshSymbol
return-same/memory-different must NOT prove equivalent
SAT model that does not satisfy constraints must be rejected
hash collision/equal-hash fake must NOT imply payload equality
stale cancelled query result must NOT publish
```

## Bitvector oracle

Small-width exhaustive/metamorphic vectors:

- overflow
- signedness
- shifts
- div/rem edge cases
- casts
- ITE

## Resource/browser corpus

- max expr nodes
- max constraints
- wall timeout
- solver timeout
- cancellation latency
- repeated session cleanup
- stale-result race
- peak memory delta

If iPad automated measurement is unavailable, mark unverified and provide a reproducible manual/browser procedure. Do not fabricate.

---

# 3. Worker A — Expr DAG / Bitvector Semantics

## Mission

Solver/Semantic IR 非依存の Hex-owned expression core を作る。

## Preferred ownership

```text
js/symbolic/expr/**
tests/...phase9-expr...
```

## Frozen interface

Wave0 で agreed shape を使う。

Worker B/C が待たずに stub/contract を consume できるよう、public schema の変更は Integration Owner と同期する。

## Deliverables

- immutable DAG
- `Bool` / `BV(width)`
- exact wraparound
- signed/unsigned compare
- logical/arithmetic shift
- div/rem semantics where SemIR defines them
- trunc/zext/sext
- ITE
- structural hash/hash-consing
- deterministic serialization
- pure evaluator
- `UnknownSemantic` / FreshSymbol separation

## Critical rules

- width は metadata ではなく semantics
- zero-width reject
- shift/div/rem edge behavior を solver default から借りない
- SemIR contract 不明なら unsupported
- hash equality alone must not establish semantic equality
- provenance is not part of structural hash

## Must prove

```text
BV8(255)+BV8(1) == BV8(0)
BV8(0xff) != BV32(0xff)
signed comparison differs from unsigned where expected
same canonical DAG serializes identically
small-width exhaustive vectors match pure evaluator
UnknownSemantic cannot become proof-producing input
hash collision guard does not alias different canonical payloads
```

## Non-goals

- real solver adapter
- Semantic IR traversal
- full memory arrays
- AI tools

---

# 4. Worker B — Semantic IR Translator / Slicing

## Mission

Semantic IR / SSA / MemorySSA から solver-neutral DAG への conservative translator を作る。

## Preferred ownership

```text
js/symbolic/translate/**
tests/...phase9-translate...
```

## Parallelization rule

Worker A implementation 完成を待ち切らない。

Wave0 で frozen Expr interface stub に対して:

- slicing
- support matrix
- assumption schema
- completeness
- origin mapping
- fixture translation

を先行できる。

A と競合する private Expr model は作らない。

## Deliverables

```text
backward dependency slicing
machine-readable support matrix
complete / exact-with-assumptions / partial / unsupported
semanticUnknowns
unsupportedEntities
assumptions
originMap
completeness dimensions
```

## Critical rules

- mnemonic parsing/re-decoding禁止
- architecture register convention を generic translator に埋め込まない
- unknown call/store/effect は conservative
- exact load は reaching-def/alias proof がある場合のみ
- partial translation must never satisfy proof eligibility

## Must prove

- deterministic normalized translation
- unsupported dependency cannot produce a proof-eligible query
- origin survives slicing
- assumptions carry source/trust class
- no architecture-specific decode truth in generic translator

---

# 5. Worker C — SolverBackend / Provider Lifecycle

## Mission

Backend-independent session/result contract と first real solver adapter を作る。

## Preferred ownership

```text
js/symbolic/solver/**
tests/...phase9-solver...
```

## Parallelization rule

Worker C は A/B 実装を待たずに開始可能。

先に:

- backend/session/result
- fake backend
- lifecycle
- ADR investigation

を作り、Expr lowering adapter だけ frozen Expr schema と接続する。

## Required statuses

```text
sat
unsat
unknown
timeout
resource-limit
unsupported
cancelled
provider-failure
invalid-query
```

Boolean-only API 禁止。

## Deliverables

- `SolverBackend`
- `SolverSession`
- registry
- normalized result/model
- timeout/cancel/dispose
- query/session identity
- stale-result rejection support
- fake backend
- first real backend after ADR

## Lifecycle requirements

- cancel idempotent
- dispose idempotent
- timeout後 reuse 可否 capability 明示
- worker terminate path
- late/stale result が別 query に publish されない

## Backend ADR checklist

- exact version/license
- WASM/native/remote
- footprint/startup
- worker/CSP compatibility
- cancellation
- memory behavior
- seed/deterministic options
- Bool/BV support
- model extraction
- remote data/privacy policy

## Must prove

- known SAT/UNSAT
- every typed failure remains distinct
- malformed/oversized query rejected
- cancel/dispose races safe
- repeated sessions cleanup
- remote backend cannot silently activate when policy disallows it

---

# 6. Worker D — Verification Queries / Model Validation

## Mission

Expr/translator/backend を用いて targeted query と proof eligibility を実装する。

## Preferred ownership

```text
js/symbolic/verify/**
tests/...phase9-verify...
```

## Dependency order

1. shared query/result + proof eligibility
2. SAT model validator
3. Conditional Edge Feasibility
4. strong/global reachability only if prerequisite completeness exists
5. Bounded Equivalence

## Proof eligibility

`UNSAT` alone は proved ではない。

最低条件:

```text
valid query
complete translation
required completeness dimensions complete
no semantic unknowns
no unsupported entities
assumptions explicit
backend exact capability
not cancelled
no budget/resource failure
```

## Conditional Edge Feasibility

Input:

```text
function/block/edge identity
explicit source-entry state/preconditions
budgets
```

Output:

```text
edge infeasible under source-entry preconditions
edge feasible with validated model
unknown
```

**Do not call this global unreachable.**

## Global reachability

Separate query/claim.

Only strong claim when source block/incoming path/loop coverage required by contract is complete.

If not complete:

```text
verdict = unknown
```

for global-unreachable claim.

## SAT model validation

For supported Expr subset:

```text
normalized model
 + normalized query
 ↓
Hex-owned pure evaluator
 ↓
constraints/assertion satisfied?
```

Invalid model -> provider/adapter failure, never counterexample proof.

## Bounded Equivalence

Explicit scope:

```text
input/state correspondence
outputs
memory regions
terminal control effect
side effects
trap/exception dimension where modeled
preconditions
bounds
```

Return-only equivalence は default にしない。

## Must prove

- local false edge -> local infeasibility proof
- same fixture does not mint global unreachable without path completeness
- symbolic feasible edge -> validated model
- tampered model rejected
- incomplete translation -> unknown
- identical bounded transform -> equivalent
- semantic difference -> validated counterexample
- return-same/memory-different -> not falsely equivalent

---

# 7. Worker E — Evidence / Patch / AI Query Integration

## Mission

Deterministic verifier result を Hex evidence/data plane に接続する。

## Preferred ownership

```text
js/symbolic/evidence/**
phase9-specific patch verification modules
phase9-specific query adapters
```

Shared registry は Integration Owner territory unless delegated。

## SymbolicEvidence minimum

```text
queryKind
claimKind
proofStatement
target entity IDs
query hash + normalized query artifact/version
expr schema version
translator/semantic versions
backend/version/options
solver status
counterexample validation status
assumptions
limits
completeness dimensions
origin IDs
BinaryId/PatchSetId when relevant
```

## Patch verification

```text
original BinaryId/projection → SemIR
patched PatchSet/projection  → SemIR
shared input/state correspondence
explicit bounded scope
verifier
result/evidence
```

Keep encoding/relocation/signing/unwind/format integrity in existing patch validation subsystem.

## Cache rules

- hash-only identity禁止
- canonical payload/version validation
- semantic version invalidates stale proof
- timeout/provider-failure not semantic cache
- budget-sensitive failures not reused as semantic answer

## AI/query surface

AI receives typed result/evidence IDs.

It must preserve:

- local feasibility vs global reachability
- assumptions
- completeness
- unknown/failure

AI must not strengthen the claim in prose.

## Remote privacy

If remote backend exists, evidence/query adapter must not bypass deployment policy or silently expose binary-derived metadata.

## Must prove

- incomplete cannot mint confirmed evidence
- local claim is not displayed as global claim
- SAT counterexample links origin and validation status
- cache invalidates on semantic/schema version change
- hash collision guard works
- patch semantic difference surfaces
- AI cannot promote unknown to verified

---

# 8. Fast branch topology

Example:

```text
phase9/integration
  ├─ phase9/corpus-contracts
  ├─ phase9/expr-dag
  ├─ phase9/translator
  ├─ phase9/solver-backend
  ├─ phase9/verifiers
  └─ phase9/evidence-patch
```

全 coding branch は run で固定した exact base/integration SHA から開始。

Moving base に無記録 rebase しない。

---

# 9. Dependency graph — 不要な直列化をしない

```text
             [Wave0 Contracts + Corpus]
                /       |        \
               v        v         v
        [A Expr]   [B Translator] [C Backend]
             \          |         /
              \         |        /
               [First Integration]
                       |
                       v
        [D Edge Feasibility + Model Validation]
                       |
                       v
              [E Evidence Integration]
                       |
                       v
             [D Bounded Equivalence]
                       |
                       v
              [E Patch Verification]
                       |
                       v
                 [Hardening]
```

B は frozen interface stub で先行可能。

C は A の実装完了を待たない。

Corpus は最初から各層を殴る。

---

# 10. Recommended integration order

```text
1. Wave0 contracts + adversarial corpus
2. A/B/C parallel work
3. A public Expr core integration
4. C backend lifecycle/fake integration
5. B translator integration
6. first known-query E2E + model validation
7. shared registry/package minimal wiring
8. Conditional Edge Feasibility E2E + evidence
9. strong/global reachability only if completeness prerequisites exist
10. Bounded Equivalence
11. Patch Verification
12. cache/version/remote/resource hardening
13. exact-SHA full gate
```

C を B の後ろに直列化しない。

F/corpus を終盤まで待たない。

Shared package/registry を最後に一括変更しない。

---

# 11. Independent Soundness Review Prompt

```text
You are the independent Phase 9 soundness reviewer for rhgrive3/hex.

Review the exact supplied integration SHA against:
- docs/HEX_MASTER_ARCHITECTURE.md Phase 9
- docs/PHASE9_SOLVER_BACKED_VERIFICATION_IMPLEMENTATION_GUIDE.ja.md

Prioritize false-proof bugs over style.

Audit:
1. UNKNOWN/TIMEOUT/RESOURCE_LIMIT/UNSUPPORTED/CANCELLED/provider failure becoming UNSAT/proved.
2. Any UNSAT -> proved path that bypasses proof eligibility.
3. UnknownSemantic becoming a fresh unconstrained input.
4. Bitvector width/wrap/signedness/shifts/div/rem/casts edge semantics.
5. Generic translator re-decoding mnemonics/register conventions.
6. Unknown memory/call effects becoming pure/no-alias.
7. Local edge infeasibility being presented as global unreachable.
8. Incomplete incoming path/loop coverage minting a global reachability claim.
9. Equivalence ignoring declared memory/control/side-effect/trap dimensions.
10. SAT model not independently validated where supported.
11. Partial translation minting confirmed evidence.
12. Hash equality used as payload/semantic equality.
13. Stale cache reuse across semantic/schema/backend incompatibility.
14. Timeout/provider failure cached as semantic result.
15. Solver-specific objects leaking into public API.
16. Cancel/dispose/late-result races.
17. Remote backend sending project-derived data without explicit policy.
18. Browser/iPad memory limit claimed as enforced when measurement-only.

Run targeted and available regressions on the exact reviewed SHA.
Do not claim tests you did not execute.
For each finding return path/line/symbol, severity, minimal counterexample, and minimal repair.
```

---

# 12. Integration Owner final checklist

```text
[ ] exact integration SHA recorded
[ ] prerequisite semantic contracts rechecked
[ ] Wave0 adversarial corpus merged
[ ] Expr width/signedness/edge-semantics suite green
[ ] small-BV exhaustive/metamorphic suite green
[ ] deterministic serialization green
[ ] hash collision/payload equality guard green
[ ] translator exact/partial/unsupported suite green
[ ] proof eligibility bypass test green
[ ] solver SAT/UNSAT + typed failure replay green
[ ] cancellation/dispose/stale-result race green
[ ] SAT model validation green
[ ] Conditional Edge Feasibility E2E green
[ ] local infeasibility is not labeled global unreachable
[ ] global reachability claim only exists when path completeness gate passes
[ ] bounded equivalence positive/negative green
[ ] memory/control/side-effect mismatch covered
[ ] patch verification E2E green
[ ] SymbolicEvidence provenance/completeness green
[ ] cache version invalidation green
[ ] timeout/provider failure not semantic cache
[ ] remote privacy policy enforced if remote backend exists
[ ] FastSymbolicEvaluator preserved where contract requires
[ ] semantic/decompiler/current regressions green
[ ] browser/iPad budget evidence recorded
[ ] memory enforcement classified hard/soft/measurement-only
[ ] independent soundness review resolved
```

Release question:

> Can Hex distinguish a real bounded proof, a validated counterexample, a scoped/local result, and a failure to prove — without losing semantic truth, provenance, or resource safety?

Yes と exact-SHA evidence で答えられるまで Phase 9 完了扱いにしない。
