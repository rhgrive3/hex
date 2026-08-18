# Phase 9 — Worker 実行プロンプト / Ownership Map

> **Purpose:** `PHASE9_SOLVER_BACKED_VERIFICATION_IMPLEMENTATION_GUIDE.ja.md` を実作業へ落とすための ready-to-use 分担テンプレート。  
> **Status:** Planning only. この文書は Phase 9 実装済みの証拠ではない。  
> **Base rule:** 実装開始時の最新 `main` exact SHA を各 Worker に渡し、検証も exact head SHA で行う。

---

## 0. 共通ルール

全 Worker に必ず渡す条件:

```text
Repository: rhgrive3/hex
Target: Master Architecture Phase 9 — Solver-backed verification
Canonical guide: docs/PHASE9_SOLVER_BACKED_VERIFICATION_IMPLEMENTATION_GUIDE.ja.md

Do not:
- replace the current bounded symbolic evaluator wholesale
- treat timeout/unsupported/unknown as UNSAT
- reinterpret machine instructions in generic symbolic code
- turn UnknownSemantic into an unconstrained input automatically
- expose backend-native solver ASTs through public APIs
- ignore memory/control/call side effects in equivalence
- let AI prose create verified facts
- invent tests, CI state, or repository state

Required:
- preserve provenance/evidence
- preserve conservative unknown behavior
- make all expensive work budgeted/cancellable
- report exact files changed
- report exact tests actually run
- report unresolved unsupported semantics
```

---

# 1. Integration Owner

## Mission

Phase 9 全体の semantic contract と shared seams を所有する。

## Exclusive/shared ownership

原則として Integration Owner が最終編集する:

```text
js/symbolic/executor.js
js/symbolic/function-sandbox.js
js/agent/tools.js
js/ai/tools/registry.js
js/ai/tools/names.js
package.json
shared evidence/public schemas
Phase 9 gate wiring
```

Feature Worker はこれらへ直接大変更を入れず、必要な integration request を report する。

## Responsibilities

- exact base SHA を固定
- Phase9 result taxonomy を固定
- Worker branch ownership を配布
- shared schema conflicts を解決
- feature branches/commits を integration branch へ取り込む
- exact integrated SHA で full gate を走らせる
- Phase9 completion checklist を満たすまで完了扱いにしない

## Exit

```text
branch reachability E2E
bounded equivalence E2E
patch verification E2E
budget/cancel E2E
evidence chain E2E
existing regressions green
```

---

# 2. Worker A — Expr DAG / Bitvector Semantics

## Mission

Solver や Semantic IR に依存しない Hex-owned expression core を作る。

## Preferred ownership

```text
js/symbolic/expr/**
tests/...phase9-expr...
```

## Deliverables

- immutable DAG nodes
- `Bool` / `BV(width)` sorts
- exact wraparound semantics
- signed/unsigned comparisons
- logical/arithmetic shifts
- trunc/zext/sext
- ITE
- structural hash/hash-consing
- deterministic serialization
- clear separation of `UnknownSemantic` and fresh symbolic input
- pure evaluator used by tests where useful

## Must prove

```text
BV8(255) + BV8(1) == BV8(0)
BV8(0xff) != BV32(0xff) as typed nodes
signed LT != unsigned LT when values differ by sign interpretation
same normalized DAG serializes identically
UnknownSemantic never becomes proof-producing fresh input implicitly
```

## Non-goals

- real solver integration
- Semantic IR traversal
- memory arrays
- AI tool integration

## Review questions

1. Width is semantic or metadata?
2. Does any helper accidentally use unbounded BigInt semantics?
3. Are signed operations explicit?
4. Can serializer depend on insertion order/random IDs?
5. Is provenance accidentally part of structural hash?

---

# 3. Worker B — Semantic IR Translator / Slicing

## Mission

Semantic IR / SSA から solver-neutral DAG への conservative translator を作る。

## Preferred ownership

```text
js/symbolic/translate/**
tests/...phase9-translate...
```

## Dependencies

Consumes Worker A public expression contract.

If A is not merged yet, work against an agreed interface stub; do not create a competing Expr model.

## Deliverables

- backward dependency slicing for targeted query
- explicit support matrix
- translation status: complete / partial / unsupported
- assumptions list
- unsupported entity list
- origin map
- integer/boolean subset first

## Critical rules

- never parse/reinterpret mnemonic text
- never decode instructions inside translator
- consume Semantic IR/SSA/MSSA only
- unknown call/store/effect must stay conservative
- unsupported op cannot silently turn into unconstrained symbolic value

## Initial supported subset

Prefer:

```text
CONST/COPY
integer arithmetic
bitwise
signed/unsigned compares
casts/extensions/truncation
SELECT/ITE
simple exact scalar values
known reaching memory values only where proof exists
```

Explicitly defer complex FP/SIMD/atomics/full memory if contracts are not ready.

## Must prove

- same Semantic IR fixture gives deterministic normalized query
- unsupported dependency produces incomplete/unsupported result
- origin mapping survives slicing
- no architecture name/register convention appears in generic translation logic

---

# 4. Worker C — SolverBackend / Provider Lifecycle

## Mission

Backend-independent session/result contract と最初の real solver adapter を作る。

## Preferred ownership

```text
js/symbolic/solver/**
tests/...phase9-solver...
```

## Deliverables

- `SolverBackend`
- `SolverSession`
- solver registry
- normalized `SolverResult`
- timeout
- cancellation
- dispose/cleanup
- model normalization
- test/fake backend where useful
- first real backend after dependency ADR is accepted

## Required statuses

```text
sat
unsat
unknown
timeout
unsupported
cancelled
provider-failure
```

No boolean-only API.

## Backend selection checklist

Before import:

- exact version
- license
- WASM/native/remote deployment mode
- binary footprint
- worker compatibility
- startup time
- memory behavior
- cancellation API
- model extraction
- deterministic options

## Must prove

- known SAT corpus
- known UNSAT corpus
- timeout remains timeout
- abort remains cancelled
- backend missing remains typed failure
- repeated create/dispose does not leave obvious leaked sessions

## Non-goals

- branch/equivalence semantics
- AI integration
- whole-binary path explorer

---

# 5. Worker D — Verification Queries

## Mission

Expr/translator/backend を用いて targeted proof APIs を作る。

## Preferred ownership

```text
js/symbolic/verify/**
tests/...phase9-verify...
```

## Dependency order

1. Branch reachability
2. Bounded equivalence
3. Reusable query/result facade

Patch integrationは Worker E / Integration Owner と接続する。

## Branch Reachability deliverable

Input:

```text
function/block/edge identity
path/preconditions
budgets
```

Output:

```text
proved unreachable
refuted by reachable model
unknown
```

with explicit underlying solver status.

## Bounded Equivalence deliverable

Must compare explicit scope:

```text
outputs
selected memory regions
terminal control effect
selected side effects
preconditions
```

Do not use return-only equivalence as default proof.

## Counterexample

When SAT refutes a claim, return Hex-normalized symbolic input/state differences sufficient to reproduce/inspect the counterexample.

## Must prove

- always-false branch → unreachable proof
- symbolic reachable branch → model
- unsupported dependency → unknown
- identical local transform → equivalent proof
- semantically different transform → counterexample
- return-same/memory-different → not falsely equivalent

---

# 6. Worker E — Evidence / Patch / AI Query Integration

## Mission

Deterministic verifier result を Hex evidence/data plane に接続する。

## Preferred ownership

Feature files under:

```text
js/symbolic/evidence/**
phase9-specific patch verification modules
phase9-specific AI/query adapters where new files can be used
```

Shared registries are Integration Owner territory unless explicitly delegated.

## Deliverables

### SymbolicEvidence

At minimum:

```text
query kind
claim/proof statement
target entity IDs
query hash
expr schema version
translator/semantic versions
backend/version
solver status
assumptions
limits
completeness
model/counterexample when appropriate
origin entity IDs
```

### Patch verification integration

Flow:

```text
original projection → SemIR
patched projection  → SemIR
shared input/state correspondence
bounded verifier
result + evidence
```

Keep binary-format patch validation separate.

### AI/query surface

AI receives structured verifier result/evidence IDs.

AI must not promote an unknown result into verified prose truth.

## Must prove

- incomplete translation cannot mint confirmed evidence
- SAT counterexample links back to target/origin
- UNSAT proof records query/backend/version
- patch byte-valid but semantically-different case is surfaced
- prompt/AI layer does not become proof authority

---

# 7. Worker F — Phase9 Corpus / Browser & iPad Budgets

## Mission

Phase9 の correctness gate と resource gate を独立に作る。

## Preferred ownership

```text
tests/phase9-*/**
tools/phase9-* where needed
benchmark fixtures
```

Package/CI wiring is coordinated with Integration Owner.

## Corpus categories

### Expr

- overflow
- signedness
- shifts
- casts
- ITE
- unknown semantics

### Query classification

- SAT
- UNSAT
- UNKNOWN
- TIMEOUT
- UNSUPPORTED
- CANCELLED
- PROVIDER_FAILURE

### Verification

- branch reachable/unreachable
- equivalence positive/negative
- memory-side-effect mismatch
- patch counterexample

### Replay

Store normalized query + expected classification + relevant semantic/backend version metadata.

### Resource

- max expression nodes
- max constraints
- wall timeout
- solver timeout
- cancellation latency
- repeated session cleanup
- peak memory delta

## iPad/browser measurements

At minimum record:

```text
cold backend initialization
warm small query
peak memory
cancel latency
repeated session behavior
```

If automated iPad measurement is unavailable, do not fabricate it. Mark unverified and provide reproducible browser procedure.

---

# 8. Suggested branch topology

Example only; use actual run conventions if different.

```text
phase9/integration
  ├─ phase9/expr-dag
  ├─ phase9/translator
  ├─ phase9/solver-backend
  ├─ phase9/verifiers
  ├─ phase9/evidence-patch
  └─ phase9/corpus-budgets
```

All coding branches start from the exact integration/base SHA chosen for the run.

Do not casually rebase independent semantic work onto moving branches without recording the new tested SHA.

---

# 9. Dependency graph

```text
        [A Expr DAG]
          /      \
         v        v
[B Translator] [C SolverBackend]
         \        /
          v      v
       [D Verifiers]
             |
             v
 [E Evidence/Patch/AI]
             |
             v
    [Integration Owner]
             ^
             |
    [F Corpus/Budgets]
      validates all layers
```

Worker F can start early with fixtures/contracts, then update against integrated APIs.

---

# 10. Recommended merge order

```text
1. contract/ADR decisions
2. A Expr DAG
3. B Translator core
4. C SolverBackend
5. D Branch reachability
6. E Evidence integration for branch proof
7. D bounded equivalence
8. E patch verification
9. F hardening corpus
10. Integration shared registries/tool names/package/CI
11. exact-SHA full verification
```

B and C may proceed in parallel after A contract is stable.

D should not implement a private expression/backend stack to unblock itself.

---

# 11. Review Worker prompt

Significant Phase9 integration should receive an independent review focused on soundness, not formatting.

```text
You are the independent Phase 9 soundness reviewer for rhgrive3/hex.

Review the exact supplied integration SHA against:
- HEX_MASTER_ARCHITECTURE.md Phase 9
- docs/PHASE9_SOLVER_BACKED_VERIFICATION_IMPLEMENTATION_GUIDE.ja.md

Prioritize finding false-proof bugs.

Audit specifically:
1. Any path where UNKNOWN/TIMEOUT/UNSUPPORTED becomes UNSAT/proved.
2. Any path where UnknownSemantic becomes a fresh unconstrained input.
3. Bitvector width, wraparound, signed comparison, shifts, casts.
4. Any generic translator logic that reinterprets instruction mnemonics or architecture registers.
5. Unknown memory stores/calls being treated as pure/no-alias.
6. Equivalence comparing only return values while ignoring declared side effects.
7. Missing provenance/evidence or partial translation minting confirmed claims.
8. Solver-specific objects leaking into public API.
9. Missing timeout/cancellation/session cleanup.
10. Browser/iPad resource assumptions that are not measured.

Run available targeted and regression tests on the exact reviewed SHA.
Do not report green tests you did not execute.
Return concrete findings with path/line/symbol, severity, proof scenario, and minimal repair.
```

---

# 12. Integration Owner final checklist

Do not merge/declare Phase9 complete until:

```text
[ ] exact integration SHA recorded
[ ] Expr DAG width/signedness suite green
[ ] deterministic serialization suite green
[ ] translator support/unsupported suite green
[ ] solver SAT/UNSAT/UNKNOWN replay green
[ ] cancellation/timeout tests green
[ ] branch reachability E2E green
[ ] bounded equivalence positive/negative E2E green
[ ] memory/control side-effect mismatch covered
[ ] patch verification E2E green
[ ] SymbolicEvidence provenance tests green
[ ] current FastSymbolicEvaluator behavior preserved where contract requires
[ ] semantic/decompiler/current global regressions green
[ ] browser/iPad budget evidence recorded or explicit blocker documented
[ ] independent soundness review resolved
```

The key question is not:

> Does the solver return an answer?

It is:

> Can Hex distinguish a real proof, a counterexample, and a failure to prove — without losing semantic truth or evidence?

That is the Phase 9 release criterion.
