# Phase 9 — Solver-backed Verification 実装ガイド

> **Status:** Planning / implementation reference — Phase 9 の実装完了を示す文書ではない  
> **Target:** Hex Master Architecture Phase 9 — Solver-backed verification  
> **Source of truth:** 実装時点の `main` + `docs/HEX_MASTER_ARCHITECTURE.md` + accepted ADR + regression tests  
> **Planning baseline:** `e90c5107f9c77d73687ee452d5042dcbe9e79ece`  
> **Primary product constraint:** Browser / iPad-first, evidence-first, conservative, cancellable  
> **Primary implementation principle:** 現行 bounded symbolic executor を壊さず、solver-neutral verification stack を横に追加する  
> **Review hardening:** 4-pass review 済み。false-proof、不要な直列化、exit-gate、現行 registry/cache 接続事故を優先して補強した。

---

# 0. この文書の目的

Phase 9 で最も危険なのは「SMT solver を接続したから symbolic verification ができた」と扱うことです。

Hex に必要なのは solver そのものではなく、次の検証境界です。

```text
Targeted verification question
        ↓
explicit scope / preconditions / completeness
        ↓
Semantic IR / SSA / MemorySSA slice
        ↓
solver-neutral expression DAG
        ↓
SolverBackend
        ↓
SAT / UNSAT / UNKNOWN / typed failure
        ↓
result validation + proof eligibility
        ↓
SymbolicEvidence
        ↓
caller / UI / AI
```

Phase 9 は whole-binary symbolic executor を作るフェーズではありません。

狭い問いについて、**何を仮定し、どの範囲をモデル化し、何が証明され、何が証明されていないか**を再現可能な形で返すフェーズです。

---

# 1. Phase 9 の契約

Master Architecture が要求する deliverable:

1. solver-neutral DAG
2. 最初の `SolverBackend`
3. targeted symbolic APIs
4. patch / branch / equivalence verification

Master exit gate:

- solver test が deterministic / replayable
- time / state / memory budget が厳格に効く
- unsupported semantics が explicit

このガイドではさらに、false-proof を防ぐため次を Phase 9 必須条件にします。

- proof eligibility が機械的に判定できる
- edge feasibility と global reachability を混同しない
- **矛盾した precondition による vacuous proof を `proved` にしない**
- SAT model を可能な範囲で独立再評価する
- query/hash/cache が version-safe
- 現行 `ToolRegistry` / `ObservationStore` の自動cacheに verifier version を取りこぼさない
- remote backend は binary-derived data の外送境界を明示する
- browser 上で enforce 不能な budget を「enforced」と記録しない

---

# 2. 最重要不変条件

## 2.1 Unknown は unknown のまま

以下は別状態です。

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

禁止:

```text
timeout          → UNSAT
resource limit   → UNSAT
unsupported      → UNSAT
unknown semantic → fresh unconstrained symbol
unknown call     → pure call
unknown store    → no-alias
provider failure → refuted/proved
```

「証明できなかった」と「反例が存在しない」は別物です。

## 2.2 Solver は semantic authority ではない

```text
bad translation + correct solver = wrong proof
```

solver が解くのは Hex が生成した制約だけです。

Semantic IR、SSA、MemorySSA、alias、effect summary が truth source で、solver は verification backend です。

## 2.3 Fast path を捨てない

現行 `js/symbolic/executor.js` は bounded / deterministic / conservative evaluator として残します。

```text
FastSymbolicEvaluator
  - cheap
  - local
  - deterministic
  - solver不要
  - unsupported明示

Solver-backed Verification
  - targeted
  - sliced
  - budgeted
  - proof/model
  - explicit scope
```

Phase 9 で fast path を unbounded SMT engine に置換しません。

## 2.4 Provenance を失わない

最低限:

```text
claim
  ↓
query
  ↓
constraints
  ↓
expression nodes
  ↓
SSA / MemorySSA values
  ↓
Semantic IR
  ↓
instruction / origin bytes
```

まで降りられること。

## 2.5 Browser/iPad は contract を歪めないが、resource safety は correctness

local WASM / native / remote backend のどれでも public contract は同じです。

ただし timeout、worker termination、memory pressure、route change、abort で誤証明・resource leak が起きないことは correctness requirement です。

---

# 3. 現行実装の読み方

Planning baseline の中心:

```text
js/symbolic/executor.js
js/symbolic/function-sandbox.js
js/agent/tools.js
js/ai/tools/names.js
js/ai/tools/registry.js
js/ai/tools/storage/observation-store.js
```

現行 executor の資産:

- `CONST / SYM / OP / ITE / UNKNOWN`
- structural hash / hash-consing
- constant folding
- value map / memory map
- path constraints
- bounded branch fork
- `maxSteps / maxForks / maxStates`
- unsupported operation stop

不足する Phase 9 contract:

- exact fixed-width bitvector semantics
- signed/unsigned distinction
- stable solver-neutral schema
- result taxonomy
- backend abstraction
- timeout/cancel/dispose
- query scope/preconditions/completeness
- precondition consistency / vacuous-proof handling
- normalized model
- counterexample validation
- evidence/replay
- bounded equivalence semantics
- patch verification semantics
- cache/version/privacy policy

### 3.1 現行 AI tool cache の具体的注意

Planning baseline の `ToolRegistry.execute()` は、`tool.storeResult !== false && tool.deterministic !== false` の tool について `ObservationStore.getCached(name, args)` を先に参照します。

`ObservationStore.cacheKey()` は概念的に:

```text
analysis binding + tool name + stableSerialize(args)
```

であり、Phase 9 の backend/version、Expr schema、translator version、solver options は **tool args または binding に明示的に入らなければ cache identity に含まれません**。

したがって solver-backed verifier を既存 registry に登録するとき、default `deterministic: true` を無検討で継承してはいけません。

安全な初期選択肢:

```text
A. verifier fingerprint を cache identity に含める専用 cache policy を実装する

or

B. version-safe cache contract が入るまで
   storeResult: true
   deterministic: false
   として observation/evidence は保存するが automatic cache hit は禁止する
```

ここで `deterministic: false` は「solver の意味が非決定的でよい」という意味ではなく、**現行 ToolRegistry の cacheability switch として一時的に false にする**という実装上の措置です。

Phase 9 の replay/determinism gate 自体は別途必須です。

---

# 4. 実装前 preflight — ここを飛ばさない

Phase 9 coding を始める exact `main` SHA で次を確認します。

```text
[ ] Semantic IR op schema/version
[ ] SSA value identity/version
[ ] MemorySSA reaching-def contract
[ ] alias result taxonomy
[ ] function/effect summary contract
[ ] origin/provenance identity
[ ] patch projection/validation API
[ ] EvidenceGraph / evidence schema
[ ] cancellation/budget primitives
[ ] ToolRegistry / ObservationStore cache contract
[ ] current FastSymbolicEvaluator tests
```

Phase 7/8 の成果が未統合・契約変動中なら、Phase 9 側で competing semantic model を作って穴埋めしません。

独立して進めてよいもの:

- result/query schema
- Bool/BV Expr DAG
- serialization/hash
- pure evaluator
- SolverBackend contract
- solver ADR / deployment investigation
- golden corpus

依存契約が安定してからつなぐもの:

- Semantic IR translator
- MemorySSA/alias slice
- branch/global reachability
- equivalence
- patch verification

---

# 5. 最初に固定する設計判断

## D1 — 最初の vertical slice は **Conditional Edge Feasibility**

旧称の `Branch Reachability` だけでは意味が強すぎます。

最初に証明するのは:

> **source block に到達したという明示的 precondition のもとで、selected conditional edge を通る入力/state が存在するか。**

Flow:

```text
selected edge
  ↓
source-block-entry state / explicit preconditions P
  ↓
branch condition backward slice
  ↓
Expr DAG
  ↓
SolverBackend
  ↓
SAT / UNSAT / unknown/failure
```

結果:

```text
SAT + validated model
→ edge is feasible under P

UNSAT + P is known satisfiable + proof eligibility
→ edge is infeasible under P

UNSAT + P itself is UNSAT
→ inconsistent-preconditions / vacuous result; NOT an edge-infeasibility proof

other
→ no proof
```

**Global edge reachability** は別 query です。

Global unreachable を `proved` にできるのは、source block 自体への到達条件・loops・incoming paths を query contract が complete に扱えている場合だけです。

名前例:

```text
verify_edge_feasibility
verify_global_edge_reachability   # later / stronger
```

これにより局所 feasibility を global unreachable と誤表示する false-proof を防ぎます。

## D2 — 初期 sort は Bool + fixed-width BV

初期必須:

```text
Bool
BV(width)
const / symbol
add/sub/mul
and/or/xor/not
logical/arithmetic shifts
concat/extract where SemIR requires
trunc/zext/sext
signed/unsigned compare
equality
ite
boolean connectives
```

初期非目標:

```text
full IEEE754 FP
large SIMD
atomics memory model
full heap SMT arrays
whole-program concolic execution
unbounded recursion/loops
```

## D3 — Fresh input と UnknownSemantic を分離

```text
FreshSymbol
= 値は未知だが意味は既知。任意値として数学的に扱える。

UnknownSemantic
= 操作/effect の意味を Hex が安全にモデル化できていない。
```

`UnknownSemantic -> FreshSymbol` 自動変換は禁止。

## D4 — backend-native AST は public API に出さない

禁止:

```text
Z3.BitVecRef
backend AstRef
native model object
```

Hex-owned schema のみを公開します。

## D5 — proof false と proof failure を分離

Query polarity は metadata として残します。

```text
claimKind
proofStatement
negatedAssertionMeaning
```

UI/AI が SAT/UNSAT を逆解釈しないこと。

## D6 — Vacuous proof を verified fact にしない

Precondition `P` が矛盾していると:

```text
P ∧ edgeCondition = UNSAT
P ∧ (before != after) = UNSAT
```

はどちらも trivially 成立します。

しかしこれは edge infeasibility や equivalence の実質的証明ではありません。

Hex は claim を証明する `UNSAT` を採用する前に、`P` が satisfiable であることを要求します。

---

# 6. Proof eligibility — UNSAT だけでは proved ではない

Phase 9 で最重要の gate です。

`solverStatus == unsat` だけを見て `verdict = proved` にしてはいけません。

概念条件:

```ts
ProofEligibility {
  queryValid: true
  translationStatus: "complete"
  scopeCompleteness: "complete"
  semanticUnknowns: 0
  unsupportedEntities: 0
  assumptionsExplicit: true
  preconditionsConsistent: true
  backendCapabilityExact: true
  resultStatus: "unsat"
  cancelled: false
  budgetExceeded: false
}
```

少なくとも一つ欠ければ:

```text
verdict = unknown
```

とします。

### 6.1 Assumption classification

Assumption は単なる string 配列にしません。

最低限:

```ts
Assumption {
  id
  kind
  statement
  source
  originIds
  trust:
    | "semantic-fact"
    | "user-precondition"
    | "query-scope"
    | "bounded-unroll"
}
```

「user が x != 0 と仮定した」「MemorySSA が reaching def を証明した」は同じ種類ではありません。

### 6.2 Preconditions consistency

Claim proof の前提集合を `P` とします。

速度のため、毎回 solver を2回必ず呼ぶ必要はありません。

```text
1. まず claim query Q を解く

2. Q が SAT + validated model
   → その model が P も満たすため P satisfiable は同時に確認できる

3. Q が UNSAT で proved に昇格しそうな場合だけ
   → P 単体の satisfiability を確認
      または同一 canonical P artifact に対する既存の validated SAT evidence を再利用

4. P == SAT
   → 他の proof eligibility が満たされれば proof 可

5. P == UNSAT
   → verdict=unknown
      reasonCode="inconsistent-preconditions"
      vacuous proof として診断

6. P == UNKNOWN/TIMEOUT/RESOURCE_LIMIT/UNSUPPORTED/CANCELLED
   → verdict=unknown
```

これにより soundness を維持しつつ、SAT query では余計な solver call を増やしません。

### 6.3 Completeness dimensions

一個の boolean に潰さず、最低限次を区別できるようにします。

```text
translation
control-flow
memory/effects
path coverage
query scope
```

強い claim は必要 dimension がすべて complete のときだけ confirmed に昇格できます。

---

# 7. 推奨モジュール境界

```text
js/symbolic/
  executor.js
  function-sandbox.js

  expr/
    kinds.js
    factory.js
    hash.js
    serialize.js
    evaluate.js

  translate/
    semantic-ir.js
    support-matrix.js
    slice.js

  solver/
    backend.js
    registry.js
    result.js
    session.js
    <first-backend>.js

  verify/
    edge-feasibility.js
    global-reachability.js      # stronger/later
    equivalence.js
    patch.js
    query.js
    eligibility.js
    preconditions.js
    validate-model.js

  evidence/
    symbolic-evidence.js
```

責務:

```text
Expr DAG        != Solver backend
Translator      != Solver backend
Verifier        != Translator
Evidence        != Solver model
Fast evaluator  != Solver-backed executor
Hash            != semantic identity proof
```

---

# 8. Solver-neutral Expression DAG

## 8.1 Node

```ts
ExprNode {
  id
  kind
  sort
  op?
  args
  literal?
  symbol?
  structuralHash
}
```

Sort:

```text
Bool
BV(width)
```

`BV8(0xff)` と `BV32(0xff)` は別。

width は semantic field です。

## 8.2 Structural hash と provenance

```text
Expr structural identity
→ pure semantic structure

Origin/evidence mapping
→ immutable side mapping
```

provenance を hash に混ぜず、捨てもしません。

## 8.3 Hash collision rule

`structuralHash` / `queryHash` の一致だけで semantic equality を確定してはいけません。

Hash は index/cache lookup の入口です。

Cache hit 時は canonical serialized bytes/schema identity を一致確認するか、衝突安全な content-address contract を使います。

## 8.4 Deterministic serialization

保存:

```text
schemaVersion
expressionDagVersion
queryKind
claimKind
variables + sorts
constraints
assertion
assumptions
scope
completeness requirements
requestedOutputs
```

Object insertion order、random IDs、Map iteration の偶然に依存しないこと。

---

# 9. Bitvector semantics — 最大の correctness trap

JavaScript `BigInt` と machine bitvector は違います。

```text
BV8(255) + BV8(1) = BV8(0)
```

必須 helper:

```text
mask(width)
wrap(value,width)
toUnsigned(value,width)
toSigned(value,width)
trunc(value,width)
zext(value,from,to)
sext(value,from,to)
```

比較:

```text
ult / ule / ugt / uge
slt / sle / sgt / sge
```

shift/div/rem も signed/unsigned を分けます。

### 9.1 必ず決める edge semantics

- width の許容範囲
- zero-width rejection
- shift amount >= width の SemIR 上の意味
- arithmetic shift の sign fill
- signed min / -1 division overflow の意味
- division/remainder by zero の意味
- extract bounds
- extension/truncation direction
- constant literal normalization

これらを solver のデフォルト仕様に合わせてはいけません。

**SemIR contract が未定義なら unsupported。**

### 9.2 Golden oracle

小さい width では exhaustive truth table が可能です。

例:

```text
BV1..BV8
all inputs for unary ops
selected/full pairs for binary ops
```

Pure evaluator と backend translation を照合します。

---

# 10. Semantic IR → Expr DAG Translator

Translator は instruction mnemonic を見ません。

```text
bytes
 ↓
low-level effects
 ↓
Semantic IR
 ↓
SSA / MemorySSA
 ↓
Translator
 ↓
Expr DAG
```

## 10.1 Support matrix を machine-readable にする

最低分類:

```text
exact
exact-with-explicit-assumptions
partial
unsupported
```

例:

```text
CONST/COPY                 exact
integer arithmetic         exact when width semantics known
signed/unsigned CMP        exact
SELECT                     exact
CAST                       exact when cast kind explicit
known scalar load          exact only with proven reaching state
unknown load/store         unsupported/partial
summarized call            exact only inside summary contract
unknown call               unsupported/partial
FP/SIMD/atomic             initially unsupported unless exact semantics exist
```

## 10.2 TranslationResult

```ts
TranslationResult {
  status
  expression
  assumptions
  unsupportedEntities
  semanticUnknowns
  originMap
  completeness
}
```

partial translation は diagnostic/query exploration に使えても proof eligibility を満たしません。

---

# 11. Memory / call modelling

Phase 9 初期で full SMT Array memory に飛びません。

まず SSA/MemorySSA/alias/effect summary を使います。

```text
proven exact scalar load
→ scalar symbolic value

known region + proven reaching def
→ explicit state relation

unknown store barrier
→ affected memory completeness lost

unknown call effect
→ affected state unknown / unsupported
```

Solver に alias analysis をさせて二重 truth を作らないこと。

### 11.1 Equivalence scope

Return equality だけでは equivalence ではありません。

```ts
EquivalenceScope {
  inputs
  outputs
  memoryRegions
  controlEffect
  sideEffects
  trapsOrExceptions
  preconditions
  correspondence
}
```

`trapsOrExceptions` を exact にモデル化できない phase では、その dimension を scope から黙って外さず `unsupported/incomplete` と記録します。

---

# 12. SolverBackend contract

```ts
interface SolverBackend {
  id
  version
  capabilities()
  createSession(options): SolverSession
}

interface SolverSession {
  check(query, options): Promise<SolverResult>
  cancel(): Promise<void> | void
  dispose(): Promise<void> | void
}
```

Result:

```ts
SolverResult {
  status:
    | "sat"
    | "unsat"
    | "unknown"
    | "timeout"
    | "resource-limit"
    | "unsupported"
    | "cancelled"
    | "provider-failure"
    | "invalid-query"
  model?
  reason?
  stats
  backend
  backendVersion
  queryHash
}
```

`completeness` は solver ではなく translator/verifier 側の property として保持する方が責務が明確です。

## 12.1 Session lifecycle

- cancel は idempotent
- dispose は idempotent
- timeout 後の session reuse 可否を backend capability で明示
- worker terminate 後に stale result を publish しない
- route change / abort race で古い query result を別 query に紐づけない

query/session token を持たせ、latest request identity を確認して publish します。

## 12.2 Backend ADR

実装前に確認:

- exact version
- license
- local WASM/native/remote deployment
- footprint/startup
- worker compatibility
- cancellation
- memory behavior
- deterministic seed/options
- model extraction
- Bool/BV support
- CSP/packaging implications
- remote privacy boundary

---

# 13. Remote backend policy

Binary 由来 constraints は project data です。

Remote solver を使う場合:

- default local / explicit opt-in policy を ADR で決める
- 何が送信されるかを明示
- raw bytes / symbols / names / addresses の送信有無を分離
- transport/auth/log retention policy を明示
- local-only project では remote fallback しない
- provider failure 時に別 remote provider へ黙って送らない

Remote を性能都合で hidden fallback にしません。

---

# 14. Query API

推奨:

```text
verify_edge_feasibility
verify_global_edge_reachability     # stronger, only when path coverage complete
verify_bounded_equivalence
verify_patch_invariant
symbolic_query                      # later facade
```

Public result:

```ts
VerificationResult {
  verdict: "proved" | "refuted" | "unknown"
  reasonCode?
  claimKind
  proofStatement
  solverStatus
  preconditionStatus?: "satisfiable" | "inconsistent" | "unknown"
  assumptions
  counterexample?
  counterexampleValidation?
  evidenceIds
  completeness
  limits
  queryHash
}
```

`preconditionStatus="inconsistent"` は claim を proved にしません。

---

# 15. Vertical Slice 1 — Conditional Edge Feasibility

## 15.1 Flow

```text
selected conditional edge
     ↓
resolve source-block entry state + branch condition
     ↓
backward slice
     ↓
translate supported expressions
     ↓
P = explicit source-entry/path/preconditions
     ↓
Q = P ∧ selected-edge-condition
     ↓
solver.check(Q)
     ↓
SAT  → validate model; model itself proves P satisfiable
UNSAT→ lazily check/reuse satisfiability evidence for P
```

## 15.2 Result semantics

```text
Q SAT + model validates
→ refutes "edge infeasible" claim; feasible counterexample exists

Q UNSAT + P SAT + proof eligibility satisfied
→ proves edge infeasible under explicit source-entry preconditions

Q UNSAT + P UNSAT
→ verdict unknown
→ reasonCode = inconsistent-preconditions
→ vacuous result; edge-infeasibility proofを作らない

Q UNSAT + P UNKNOWN/TIMEOUT/RESOURCE_LIMIT/UNSUPPORTED/CANCELLED
→ unknown

Q SAT but model validation fails
→ provider/adapter failure, never refuted/proved

UNKNOWN/TIMEOUT/RESOURCE_LIMIT/UNSUPPORTED/CANCELLED
→ unknown
```

## 15.3 Global reachability promotion

`edge infeasible given source entry` と `edge globally unreachable` は別 claim です。

Global unreachable へ昇格するには、source block の reachability/path-coverage dimension が complete であることを query contract が要求します。

さらに global claim に使う preconditions が satisfiable でなければなりません。

---

# 16. SAT model validation

SAT は counterexample を返すので、可能な subset では solver adapter の出力を独立再評価します。

```text
normalized query
 + normalized model
        ↓
Hex-owned pure Expr evaluator
        ↓
all constraints true?
assertion true?
```

失敗時:

```text
status = provider-failure / invalid-model
verdict = unknown
```

model が複数存在すること自体は問題ではありません。

必要なのは「返された model が claim を本当に反証しているか」です。

UNSAT は一般に同じ方法で再評価できないため、release corpus では differential backend / exhaustive small-BV oracle / known-answer corpus を組み合わせます。

---

# 17. Vertical Slice 2 — Bounded Equivalence

同じ対応付け済み symbolic inputs/state のもとで:

```text
P = explicit equivalence preconditions
Q = P ∧ (before_observable_state != after_observable_state)
```

```text
Q UNSAT + P SAT + eligible
→ equivalent within explicit scope/preconditions/bounds

Q SAT + validated model
→ counterexample; P is satisfiable by that model

Q UNSAT + P UNSAT
→ unknown / inconsistent-preconditions
→ vacuous equivalence proofは禁止

other
→ unknown
```

必須:

- input/state correspondence
- outputs
- selected memory regions
- terminal control effect
- selected side effects
- explicit boundedness
- assumptions
- precondition consistency before any UNSAT-based proof

最初は:

- straight-line region
- local transform
- decompiler rewrite
- patch-local bounded slice

から始めます。

Loops/recursion/unknown effects は completeness を落とします。

---

# 18. Vertical Slice 3 — Patch Verification

```text
original bytes
 ↓ decode/lift
before SemIR slice

patched bytes / patch projection
 ↓ decode/lift
after SemIR slice

shared input/state correspondence
 ↓
explicit invariant/equivalence scope + satisfiable preconditions
 ↓
verification
```

Evidence に最低限:

- original BinaryId/content identity
- PatchSetId / patched projection identity
- before/after semantic versions
- query hash
- assumptions/scope
- precondition status

を含めます。

Solver proof と binary-format patch validation は別 gate です。

- encoding range
- relocation
- signing
- unwind
- format integrity

などは既存 patch validation が担当します。

---

# 19. SymbolicEvidence

```ts
SymbolicEvidence {
  id
  queryKind
  claimKind
  proofStatement
  targetEntityIds
  queryHash
  normalizedQueryArtifactId?
  expressionSchemaVersion
  translatorVersion
  semanticVersions
  backendId
  backendVersion
  solverStatus
  preconditionStatus?
  reasonCode?
  modelArtifactId?
  counterexampleValidation?
  assumptions
  limits
  completeness
  originEntityIds
  originalBinaryId?
  patchSetId?
}
```

`confirmed` は proof eligibility を満たした deterministic verifier result のみ。

矛盾した precondition による vacuous `UNSAT` は `confirmed` を作りません。

AI prose は authority ではありません。

---

# 20. Resource budgets

```ts
SymbolicBudget {
  wallTimeMs
  solverTimeMs
  maxExprNodes
  maxConstraints
  maxStates
  maxForks
  maxDepth
  maxLoopUnroll
  maxModelValues
  maxMemoryBytes?
}
```

必須:

- loops bounded
- forks bounded
- solver calls timed
- abort propagated
- backend worker terminate path
- typed budget hit

### 20.1 Memory budget honesty

Browser JS/WASM で hard `maxMemoryBytes` を直接 enforce できない backend では、設定値があるだけで「memory budget enforced」と扱いません。

許容:

- dedicated Worker isolation
- backend-provided memory cap
- pre-allocation/node limits + worker kill threshold
- measured peak + OS/browser termination handling

Exit gate では、どの mechanism が **hard enforcement / soft guard / measurement only** か記録します。

Master Architecture の memory-budget gate を hard enforcement と解釈するなら、measurement-only backend で Phase 9 完了を宣言してはいけません。

---

# 21. Replay / cache / versioning

保存:

```text
normalized query artifact
query hash
query schema version
expression schema version
semantic versions
translator version
backend id/version
solver options/seed
limits
expected classification
precondition artifact/status
```

Cache key に少なくとも semantic/query versions を含めます。

禁止:

- hash 一致だけで payload equality を省略
- semantic version が変わった proof result を再利用
- timeout/provider-failure を semantic answer として永続 cache
- smaller-budget timeout を larger-budget query の結果として再利用
- precondition consistency result を異なる canonical P に流用

SAT/UNSAT semantic result の cache policy も backend/options compatibility を明示します。

### 21.1 Existing ToolRegistry integration gate

現行 `js/ai/tools/registry.js` / `ObservationStore` に Phase 9 tool を載せる場合:

```text
[ ] tool args だけで cache identity が十分か確認
[ ] backend/version/options を cache identity に含める
[ ] query/expr/translator/semantic schema versions を含める
[ ] analysis binding だけに version invalidation を期待しない
[ ] version-safe でない間は automatic cache を無効化
[ ] observation/evidence 保存自体は維持
```

特に現行 registry の default `deterministic: true` をそのまま使うと cache hit が有効になるため、Phase 9 tool registration は明示的 cache policy を必須とします。

---

# 22. Test strategy

## T0 — Contract/golden corpus（Wave0から）

実装より先に固定:

- result taxonomy
- proof eligibility matrix
- Bool/BV schema
- query polarity
- support matrix
- known SAT/UNSAT/unsupported vectors
- precondition consistency/vacuous-proof vectors
- ToolRegistry cacheability policy

## T1 — Expr DAG

- width-distinct constants
- hash + full canonical equality
- deterministic serialization
- wraparound
- signed/unsigned comparison
- shifts
- div/rem edge semantics
- trunc/zext/sext
- ITE
- UnknownSemantic vs FreshSymbol

## T2 — Exhaustive/metamorphic BV

小 width で:

- pure evaluator truth table
- solver translation result
- algebraic identities valid under bitvector semantics
- identities that are invalid due to overflow are rejected

を比較します。

## T3 — Translator

- exact
- exact-with-assumptions
- partial
- unsupported
- unknown call/store
- origin preservation
- architecture-neutral generic code

## T4 — Solver backend

- known SAT
- known UNSAT
- UNKNOWN
- TIMEOUT
- RESOURCE_LIMIT
- CANCELLED
- PROVIDER_FAILURE
- INVALID_QUERY
- malformed/oversized query rejection
- create/cancel/dispose races

## T5 — SAT model validation

- valid model accepts
- tampered model rejects
- missing required assignment handling
- backend model normalization

## T6 — Preconditions / vacuous proof

- satisfiable P + Q UNSAT → proof eligibility may proceed
- contradictory P + Q UNSAT → unknown/inconsistent-preconditions
- P timeout/unknown → claim remains unknown
- SAT Q model validates P automatically
- cached P consistency cannot cross canonical-P/version boundary

## T7 — Edge feasibility

- always true edge
- always false edge
- symbolic feasible
- constrained infeasible
- unsupported dependency
- source-entry precondition changes result
- local infeasibility is not labeled global unreachable
- contradictory source-entry constraints do not mint local proof

## T8 — Global reachability promotion

- complete incoming path coverage allows strong claim
- incomplete path/loop coverage cannot mint global unreachable
- inconsistent global preconditions cannot mint global unreachable

## T9 — Equivalence

- identical
- bitvector-equivalent
- wrap-sensitive difference
- signedness-sensitive difference
- memory mismatch
- control-effect mismatch
- unknown effect → unknown
- contradictory preconditions do not mint equivalence

## T10 — Patch verification

- no-op equivalent
- condition inversion counterexample
- return same/memory different
- unsupported semantics → unknown
- BinaryId/PatchSetId evidence
- contradictory patch preconditions do not mint proof

## T11 — Evidence/cache

- proof origin chain
- query hash stable
- collision-safe payload check
- version invalidation
- incomplete cannot confirm
- failure result cannot confirm
- ObservationStore automatic cache does not cross verifier/backend/schema fingerprint
- safe no-cache fallback still stores observation/evidence

## T12 — Browser/iPad

- cold init
- warm query
- peak memory delta
- cancel latency
- repeated session leak
- worker termination
- stale result race

---

# 23. 最速かつ安全な Wave 分割

## Wave 0 — Contract + adversarial corpus freeze

Integration Owner + Corpus owner が先に固定:

- query/result taxonomy
- proof eligibility
- precondition consistency policy
- Bool/BV schema
- support matrix
- assumption/completeness schema
- golden SAT/UNSAT/unknown/vacuous vectors
- budget schema
- backend ADR decision criteria
- ToolRegistry cacheability policy

Exit:

- Worker が同じ semantics を実装できる
- false-proof examples が corpus に入っている
- version-safe cache が無い場合の no-cache fallback が決まっている

## Wave 1 — A/B/C を最大限並列

### A — Expr DAG

- Bool/BV
- evaluator
- serializer/hash

### B — Translator scaffolding

A の frozen interface stub に対して:

- slicing contract
- support matrix
- origin/completeness
- fixture translator

A implementation 依存部分だけ後で接続。

### C — SolverBackend

A の内部実装を待たず:

- backend/session/result contract
- lifecycle
- fake backend
- ADR/pinned dependency

real Expr lowering adapter は A contract 完成後に接続。

Exit:

- A/B/C の public seam が contract tests で一致

## Wave 2 — first integration lane

- A + B + C
- known query E2E
- model validation
- precondition consistency helper
- cancellation/resource limits

ここで shared registry/package dependency を Integration Owner が小さく統合します。

**shared seams を最後まで溜めない。**

## Wave 3 — Conditional Edge Feasibility

- selected edge query
- source-entry precondition
- lazy vacuous-proof guard on UNSAT
- evidence
- SAT model validation

Exit:

- local feasibility E2E
- contradictory P does not produce proof
- global reachability と誤表示しない

## Wave 4 — Stronger reachability only if prerequisites complete

- incoming path coverage
- loop bound/completeness
- global claim eligibility

Prerequisite が不足するなら Phase 9 の必須 deliverable を満たす最小範囲を再確認し、偽の global claim を作らない。

## Wave 5 — Bounded Equivalence

- correspondence
- state scope
- precondition consistency
- counterexample

## Wave 6 — Patch Verification

- before/after projection
- PatchSet evidence
- existing patch gate composition

## Wave 7 — Hardening

- exhaustive/metamorphic corpus
- differential backend where feasible
- cache/versioning
- existing ToolRegistry/ObservationStore integration
- remote privacy
- iPad/browser resource evidence
- full regressions

---

# 24. Worker ownership

```text
Integration Owner — contracts/shared seams/gates
Worker A          — Expr DAG/evaluator/serialization
Worker B          — Semantic translator/slicing
Worker C          — SolverBackend/lifecycle
Worker D          — verification queries/model validation/precondition consistency
Worker E          — Evidence/Patch/AI query surface
Worker F          — adversarial corpus/resource/browser/cache gates
```

Hotspots:

```text
js/symbolic/executor.js
js/symbolic/function-sandbox.js
js/agent/tools.js
js/ai/tools/registry.js
js/ai/tools/names.js
js/ai/tools/storage/observation-store.js
package.json
shared evidence schemas
CI/gate wiring
```

Integration Owner が shared files を管理しますが、**dependency/package commit と registry wiring を最後まで保留して bottleneck にしない**こと。

各 vertical slice ごとに小さく integration します。

---

# 25. Anti-patterns

1. Current AST に solver handle を埋め込む
2. JS BigInt を machine arithmetic と同一視
3. UnknownSemantic を unconstrained input 化
4. Whole-binary symbolic を background 起動
5. Timeout/resource-limit を false/UNSAT 化
6. Return-only equivalence
7. Solver に alias truth を作らせる
8. AI prose で unsupported を補う
9. Solver dependency を contract より先に決める
10. Fast evaluator を一気に置換
11. Local edge feasibility を global unreachable と表示
12. `UNSAT` だけで proved にする
13. SAT model を未検証で counterexample として確定
14. Query hash を equality proof として使う
15. Timeout/provider failure を semantic cache する
16. Remote backend へ project-derived constraints を黙って送る
17. Enforce できない memory limit を gate pass と記録
18. Corpus を統合終盤まで待つ
19. Shared registry/package edits を最後に大量統合
20. 矛盾した preconditions の `UNSAT` を実質的 proof として採用する
21. Phase 9 tool が現行 ToolRegistry の default cache を無検討で継承する

---

# 26. Phase 9 完了条件

## Architecture

- [ ] solver-neutral Expr DAG
- [ ] backend-native object leak なし
- [ ] architecture-neutral translator
- [ ] fast evaluator preserved
- [ ] explicit UnknownSemantic
- [ ] typed result taxonomy

## Proof soundness

- [ ] proof eligibility machine-enforced
- [ ] precondition consistency gate machine-enforced
- [ ] contradictory preconditions cannot mint proof
- [ ] local feasibility/global reachability distinction
- [ ] incomplete translation cannot prove
- [ ] incomplete path coverage cannot mint global unreachable
- [ ] timeout/resource/unsupported/cancel cannot prove
- [ ] SAT model validation implemented for supported subset
- [ ] bitvector edge semantics fixed

## Verification features

- [ ] edge feasibility E2E
- [ ] bounded equivalence E2E
- [ ] patch verification E2E
- [ ] strong/global reachability only if completeness contract is actually satisfied

## Evidence

- [ ] query hash + canonical artifact/version
- [ ] backend/version/options
- [ ] semantic/translator versions
- [ ] assumptions/completeness dimensions
- [ ] precondition status/reason recorded
- [ ] origin chain
- [ ] BinaryId/PatchSetId for patch proof

## Resource/security/cache

- [ ] wall/solver/state limits
- [ ] cancellation/dispose races tested
- [ ] memory budget enforcement mechanism classified
- [ ] iPad/browser measurements
- [ ] remote solver privacy policy if applicable
- [ ] stale result cannot publish after cancel/replacement
- [ ] ToolRegistry/ObservationStore cache cannot reuse incompatible verifier/backend/schema result
- [ ] version-safe cache unavailable時の no-cache fallback validated

## Regression

- [ ] FastSymbolicEvaluator regression
- [ ] semantic/decompiler regression
- [ ] compiler-truth/differential gates as applicable
- [ ] adversarial BV corpus
- [ ] model validation corpus
- [ ] vacuous-proof corpus
- [ ] cache/version invalidation tests
- [ ] exact tested SHA
- [ ] independent soundness review resolved

---

# 27. 最短実装順

```text
1. Preflight exact main SHA / prerequisite contracts / existing cache contract
2. Result taxonomy + proof eligibility + query polarity + precondition policy
3. Golden adversarial corpus（vacuous proof含む）
4. Bool/BV Expr contract
5. A Expr implementation | B translator scaffolding | C backend lifecycle を並列
6. First integration: query → backend → model validation + lazy precondition check
7. Conditional Edge Feasibility E2E
8. Evidence/query API integration + safe ToolRegistry cache policy
9. Global reachability は completeness prerequisites がある場合のみ
10. Bounded Equivalence
11. Patch Verification
12. Cache/version/privacy/resource hardening
13. iPad/browser + full gate
```

これが「速いが危険」でも「安全だが直列で遅い」でもない順序です。

---

# 28. 実装開始前 ADR checklist

- [ ] first backend exact version/license
- [ ] deployment local/WASM/native/remote
- [ ] remote data policy
- [ ] Bool/BV schema/version
- [ ] edge semantics for shifts/div/rem/casts
- [ ] UnknownSemantic vs FreshSymbol
- [ ] SolverResult taxonomy
- [ ] proof eligibility
- [ ] precondition consistency/vacuous-proof policy
- [ ] assumption/completeness taxonomy
- [ ] timeout/cancel/dispose
- [ ] memory budget enforcement class
- [ ] SymbolicEvidence
- [ ] equivalence scope/correspondence
- [ ] patch state surface
- [ ] replay/cache format/version policy
- [ ] ToolRegistry/ObservationStore verifier cache policy

---

# 29. 成功イメージ

Beginner-facing:

```text
この分岐は通れる？

→ この地点まで到達した前提では、通れません（検証済み）

前提:
- source block entry が成立
- x >= 10

分岐条件:
- x < 10

両方を満たす値はありません。
```

ただし前提自身が矛盾している場合は:

```text
→ 判定できません
理由: 検証前提どうしが矛盾しています
```

とし、「通れません（検証済み）」にしません。

重要なのは、global unreachable ではない場合に UI が勝手に「このコードは絶対実行されない」と強めないことです。

Expert-facing:

```text
Claim kind
Scope/preconditions
Precondition status
Completeness dimensions
Normalized query/hash
Backend/version/options
SAT/UNSAT/UNKNOWN
Validated model / proof metadata
Budget enforcement class
Origin mapping
```

---

# 30. 結論

Phase 9 の本質は solver の強さではありません。

```text
semantic truth
  → explicit bounded claim
  → exact conservative translation
  → satisfiable preconditions
  → backend-neutral query
  → typed solver result
  → validation / eligibility
  → evidence
```

最初の勝ち筋は **Conditional Edge Feasibility** です。

そこから completeness を満たせる場合のみ strong/global reachability、次に **Bounded Equivalence**、最後に **Patch Verification** へ進みます。

Corpus は最後ではなく最初、A/B/C は contract を固定して並列、shared seams は vertical slice ごとに小さく統合します。

さらに現行 AI tool registry の cache contract を Phase 9 verifier にそのまま適用せず、verifier/backend/schema fingerprint を cache identity に含めるか、安全な no-cache fallback を使います。

これにより Phase 9 の主要事故源である false proof、vacuous proof、bitvector、unknown semantics、memory/call effects、scope overclaim、state explosion、stale proof cache、browser resource、remote privacy、integration bottleneck を早期に隔離できます。
