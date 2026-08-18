# Phase 9 — Solver-backed Verification 実装ガイド

> **Status:** Planning / implementation reference — Phase 9 の実装完了を示す文書ではない  
> **Target:** Hex Master Architecture Phase 9 — Solver-backed verification  
> **Source of truth:** 実装時点の `main` + `HEX_MASTER_ARCHITECTURE.md` + accepted ADR + regression tests  
> **Planning baseline:** `e90c5107f9c77d73687ee452d5042dcbe9e79ece`  
> **Primary product constraint:** Browser / iPad-first, evidence-first, conservative, cancellable  
> **Primary implementation principle:** 現行 bounded symbolic executor を壊さず、solver-neutral verification stack を横に追加する

---

## 0. この文書の目的

Phase 9 で最も危険なのは、「SMT solver をつなげば symbolic execution が完成する」と考えて実装を始めることです。

Hex に必要なのは solver そのものではなく、次の **検証ループ** です。

```text
Targeted verification question
        ↓
Semantic IR / SSA / MemorySSA slice
        ↓
solver-neutral expression DAG
        ↓
SolverBackend
        ↓
SAT / UNSAT / UNKNOWN + model/reason
        ↓
SymbolicEvidence
        ↓
caller / UI / AI
```

Phase 9 の目的は、このループを **狭い問いに対して再現可能・保守的・証拠付きで成立させること** です。

Phase 9 は whole-binary symbolic executor を作るフェーズではありません。

---

# 1. Phase 9 の契約

Master Architecture が Phase 9 に要求している deliverable は次の4点です。

1. solver-neutral DAG
2. 最初の `SolverBackend`
3. targeted symbolic APIs
4. patch / branch / equivalence verification

Exit gate は次です。

- solver test が deterministic / replayable である
- time / state / memory budget が厳格に効く
- unsupported semantics が explicit のままである

この文書では、これを実装可能な work units に分解します。

---

# 2. Phase 9 で守る不変条件

Phase 9 は次を絶対に破ってはいけません。

## 2.1 Unknown は unknown のまま

以下はすべて異なります。

```text
SAT
UNSAT
UNKNOWN
TIMEOUT
UNSUPPORTED
CANCELLED
PROVIDER_FAILURE
```

特に禁止:

```text
timeout      → UNSAT
unsupported  → UNSAT
unknown op   → fresh unconstrained symbol として無条件に続行
unknown call → pure call とみなす
unknown store→ no-alias とみなす
```

「証明できなかった」と「反例が存在しない」は別物です。

## 2.2 Solver は semantic authority ではない

Solver が解くのは Hex が生成した制約です。

したがって:

```text
bad translation + correct SMT solver = wrong proof
```

最重要なのは solver のブランドではなく、`Semantic IR -> expression DAG` の意味保存です。

## 2.3 Fast path を捨てない

現行 `js/symbolic/executor.js` は bounded / deterministic / conservative な evaluator として既に価値があります。

Phase 9 はこれを unbounded SMT executor に作り替えません。

最終形は二層です。

```text
FastSymbolicEvaluator
  - cheap
  - local
  - deterministic
  - solver不要
  - unsupportedは明示

Solver-backed Verification
  - targeted
  - sliced
  - budgeted
  - proof/modelを返す
  - expensive workは明示的に要求
```

## 2.4 Provenance を失わない

Proof は boolean だけでは不十分です。

最低でも次を追跡します。

```text
query
  ↓
constraints
  ↓
expression nodes
  ↓
Semantic IR / SSA values
  ↓
instructions / origins
```

## 2.5 iPad/browser を correctness requirement にしない

Solver backend が local WASM、native/remote compute、将来の別 backend のどれであっても、公開 contract は同じにします。

特定 solver の内部 object を semantic layer や UI に漏らしてはいけません。

---

# 3. 現行実装の読み方

Planning baseline では symbolic 周辺の中心は次です。

```text
js/symbolic/executor.js
js/symbolic/function-sandbox.js
js/agent/tools.js
js/ai/tools/names.js
js/ai/tools/registry.js
```

現行 `executor.js` は既に:

- `CONST / SYM / OP / ITE / UNKNOWN`
- structural hash / hash-consing
- small constant folding
- value map
- memory map
- path constraints
- bounded branch fork
- `maxSteps / maxForks / maxStates`
- unsupported operation stop

を持ちます。

これは捨てる対象ではなく、Phase 9 の differential oracle / fast evaluator として使える資産です。

一方で solver-backed verification に不足しているものは明確です。

- exact bit-width semantics
- signed / unsigned distinction
- stable solver-neutral serialization
- solver result taxonomy
- backend abstraction
- cancellation / timeout protocol
- proof query schema
- model normalization
- counterexample reporting
- evidence integration
- replay corpus
- patch/equivalence semantics

---

# 4. 最初に固定する設計判断

実装開始前に以下を固定します。

## D1 — 最初の vertical slice は Branch Reachability

最初から patch equivalence をやりません。

Phase 9 の最初の end-to-end success は:

```text
branch condition
   ↓ dependency slice
Expr DAG
   ↓
SolverBackend
   ↓
SAT / UNSAT / UNKNOWN
   ↓
SymbolicEvidence
```

とします。

理由:

- expression DAG が必要
- translator が必要
- solver backend が必要
- result taxonomy が必要
- evidence が必要
- budget/cancellation が必要
- しかし patch equivalence より memory side effect の比較が少ない

つまり Phase 9 全層を最小の難易度で通せます。

## D2 — Phase 9 初期は integer bitvector + boolean を主対象にする

初期必須:

```text
BV const / symbol
add/sub/mul
bitwise
shift
concat/extract where required
zext/sext/trunc
comparison
ite
boolean connectives
```

初期非目標:

```text
full IEEE754 FP
large SIMD semantics
atomics memory model
exception semantics
full heap SMT arrays
whole-program concolic execution
```

非対応は `unsupported` / `unknown` で止めます。

## D3 — Unknown と fresh symbol を別概念にする

これは最重要です。

```text
FreshSymbol
= 「入力値は不明だが、任意値として数学的に扱ってよい」

UnknownSemantic
= 「Hex がこの操作の意味を十分にモデル化できていない」
```

`UnknownSemantic` を fresh unconstrained symbol に自動変換すると unsound proof が発生します。

## D4 — Public API に backend-specific AST を出さない

禁止例:

```text
Z3.BitVecRef
Z3.Ast
backend-native model object
```

公開層は Hex-owned schema のみを使います。

## D5 — Proof failure と proof false を分離する

例:

「branch が到達不能か？」

```text
UNSAT
→ 到達不能を証明

SAT
→ 到達可能な反例/modelを取得

UNKNOWN/TIMEOUT/UNSUPPORTED
→ 判定不能
```

---

# 5. 推奨モジュール境界

大規模 rename は不要です。

既存 facade を維持しながら、必要な境界だけ追加します。

```text
js/symbolic/
  executor.js                 # legacy/public fast evaluator facade
  function-sandbox.js         # existing compatibility surface

  expr/
    kinds.js
    factory.js
    hash.js
    serialize.js
    evaluate.js

  translate/
    semantic-ir.js
    support-matrix.js

  solver/
    backend.js
    registry.js
    result.js
    session.js
    <first-backend>.js

  verify/
    branch.js
    equivalence.js
    patch.js
    query.js

  evidence/
    symbolic-evidence.js
```

名前は実装時に current tree に合わせて調整してよいですが、責務は混ぜないでください。

特に:

```text
Expr DAG        != Solver backend
Translator      != Solver backend
Verifier        != Translator
Evidence        != Solver model
Fast evaluator  != Solver-backed executor
```

---

# 6. Solver-neutral Expression DAG

## 6.1 Node の必須情報

概念例:

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

`sort` は最低でも:

```text
Bool
BV(width)
```

を持ちます。

Bit width を metadata 扱いにしてはいけません。

```text
0xff : BV8
0xff : BV32
```

は別の値です。

## 6.2 Structural hash と provenance を分離する

同じ式:

```text
x + 1
```

が別 origin から来ても solver 上の構造は同じです。

したがって:

```text
Expr identity/hash
→ semantic structure

Origin/evidence mapping
→ side table / immutable association
```

とするのが安全です。

provenance を hash に混ぜると canonicalization が壊れます。

逆に provenance を捨てると evidence chain が壊れます。

## 6.3 Deterministic serialization

Replay の中心です。

同じ query は同じ normalized representation へ serialize できなければなりません。

最低限記録:

```text
schemaVersion
expressionDagVersion
queryKind
variables + sorts
constraints
assertion
assumptions
requestedOutputs
```

Object insertion order や random internal IDs に結果を依存させません。

## 6.4 Canonicalization は semantics-preserving のみ

安全な例:

```text
x + 0 → x
x & all_ones → x
ite(true,a,b) → a
```

危険:

- signedness を無視した comparison rewrite
- overflow を mathematical integer として扱う
- JS BigInt の無限精度を machine integer と同一視する
- shift amount rules を ISA/SemIR contract から勝手に推測する

---

# 7. Bitvector semantics — Phase 9 最大の correctness trap

JavaScript `BigInt` と machine bitvector は違います。

例:

```text
BV8(255) + BV8(1) = BV8(0)
```

ですが JavaScript `255n + 1n = 256n` です。

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

比較も明示します。

```text
ult / ule / ugt / uge
slt / sle / sgt / sge
```

`LT` 一個に符号意味を埋め込む設計は Phase 9 では不十分です。

同様に:

- logical right shift
- arithmetic right shift
- division
- remainder

も signed/unsigned を区別します。

---

# 8. Semantic IR → Expr DAG Translator

Translator は instruction mnemonic を見てはいけません。

入力は Semantic IR / SSA / MemorySSA です。

```text
instruction bytes
  ↓ low-level effects
Semantic IR
  ↓ SSA/MSSA
Translator
  ↓
Expr DAG
```

Phase 9 が architecture-neutral であるための必須条件です。

## 8.1 Support matrix を first-class にする

例:

```text
Semantic op        Status
CONST              exact
COPY               exact
ADD/SUB/...        exact
CMP signed/unsigned exact
SELECT             exact
CAST               exact
LOAD stack-known   exact/bounded
LOAD unknown       unsupported/unknown
STORE known region modeled as state update
CALL summarized    supported if summary fits model
CALL unknown       unsupported/unknown
INTRINSIC          effect-specific
FLOAT              initially unsupported
```

この matrix は docs だけでなく machine-readable test data にできると良いです。

## 8.2 Unsupported translation は途中で隠さない

Result 例:

```ts
TranslationResult {
  status: "complete" | "partial" | "unsupported"
  expression
  assumptions
  unsupportedEntities
  originMap
}
```

部分翻訳なのに完全 proof を返してはいけません。

---

# 9. Memory modelling

Phase 9 で full SMT Array memory を最初から実装しないことを推奨します。

まず Phase 7/8 までに得られる SSA / MemorySSA / alias proof を最大限利用して slice します。

## 9.1 初期戦略

```text
proven exact scalar load
→ symbolic scalar valueに落とせる

known region + known reaching def
→ state relationとして表現可能

unknown store barrier
→ proofを継続しない / completenessを落とす

unknown call memory effect
→ affected stateをunknownにする
```

つまり solver に alias analysis を丸投げしません。

Alias truth は Hex semantic analysis が供給し、solver はその制約を検証します。

## 9.2 Patch equivalence では return value だけ比較しない

危険な誤判定:

```text
before return == after return
→ equivalent
```

実際には:

- memory write
- register side effect
- branch/control flow
- exception/trap
- call side effect

が変わっている可能性があります。

Phase 9 の equivalence scope は明示的にします。

```ts
EquivalenceScope {
  outputs
  memoryRegions
  controlEffect
  sideEffects
  preconditions
}
```

---

# 10. SolverBackend contract

概念 contract:

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
    | "unsupported"
    | "cancelled"
    | "provider-failure"

  model?
  reason?
  stats
  backend
  backendVersion
  queryHash
  completeness
}
```

## 10.1 Solver session は必ず disposable

Browser/iPad では WASM/native resource を永続的に保持し続ける前提を置きません。

- abort
- timeout
- memory pressure
- route change
- worker termination

に耐える必要があります。

## 10.2 Backend selection は registry 経由

Verifier が直接 `new Z3()` してはいけません。

```text
Verifier
  ↓
SolverRegistry
  ↓
selected backend
```

これにより local/remote/native/WASM の切り替えとテスト backend を分離できます。

## 10.3 First backend の選定は ADR 化する

実装前に最低限確認:

- license
- pinned version
- browser/WASM footprint
- startup latency
- cancellation mechanism
- memory behavior on iPad
- deterministic options
- model extraction
- supported bitvector operations
- worker compatibility

「有名だから」で dependency を決めないこと。

---

# 11. Query API

Phase 9 は「万能 symbolic_execute」を巨大化するより、目的別 API を先に作る方が安全です。

推奨:

```text
verify_branch_reachability
verify_bounded_equivalence
verify_patch_invariant
symbolic_query          # later/general facade
```

Public result は共通 shape を持ちます。

```ts
VerificationResult {
  verdict:
    | "proved"
    | "refuted"
    | "unknown"

  solverStatus
  assumptions
  counterexample?
  evidenceIds
  completeness
  limits
  queryHash
}
```

注意:

`proved` の意味は query kind によって明示します。

例:

- reachability query で UNSAT → unreachable proved
- equivalence query で `before != after` が UNSAT → equivalent proved

API 内部で assertion の極性を隠しすぎると UI/AI が逆解釈するため、`claimKind` / `proofStatement` も保存します。

---

# 12. Vertical Slice 1 — Branch Reachability

最初に完成させる実装です。

## 12.1 Flow

```text
selected conditional edge
     ↓
resolve branch condition SSA value
     ↓
backward slice
     ↓
translate supported expressions
     ↓
add path/precondition constraints
     ↓
assert target edge condition
     ↓
solver.check
```

## 12.2 Result semantics

```text
SAT
→ edge reachable under returned model

UNSAT
→ edge unreachable under modeled assumptions

UNKNOWN/TIMEOUT/UNSUPPORTED
→ no proof
```

## 12.3 Required evidence

- function / block / edge identity
- branch condition origin
- input symbols
- assumptions
- query hash
- solver/backend version
- status
- counterexample model if SAT
- translation completeness
- resource limits used

## 12.4 Why first

これが通れば Phase 9 の基盤:

- query schema
- slicing
- DAG
- translation
- backend
- budgets
- evidence
- AI/UI-safe result

を全部一度に検証できます。

---

# 13. Vertical Slice 2 — Bounded Equivalence

次に行います。

## 13.1 Basic proof form

同じ symbolic inputs のもとで:

```text
assert(before_outputs != after_outputs)
```

を solver に与えます。

```text
UNSAT → outputs equivalent within scope/preconditions
SAT   → counterexample exists
other → unknown
```

## 13.2 必須比較対象

最低限 scope で選べるようにします。

- return/output values
- selected memory regions
- selected state values
- terminal control effect
- side-effect summary

## 13.3 最初から arbitrary whole-function equivalence を狙わない

最初は:

- bounded straight-line region
- bounded local transform
- decompiler rewrite check
- patch-local basic block/function slice

から始めます。

Loops/recursion/unknown calls が出たら completeness を落とします。

---

# 14. Vertical Slice 3 — Patch Verification

Patch subsystem の「byteとして書ける」と Phase 9 の「semantic invariant を守る」は別です。

推奨 flow:

```text
original bytes
   ↓ decode/lift/SemIR
before slice

patched projection
   ↓ decode/lift/SemIR
after slice

shared input relation
   ↓
Equivalence / invariant query
   ↓
proof / counterexample / unknown
```

Patch verification は必ず existing patch validation と併用します。

Solver が証明しても:

- format integrity
- branch encoding range
- code signing
- relocation consistency
- unwind metadata

などは別 subsystem の責任です。

---

# 15. SymbolicEvidence

Solver result を直接 UI badge にしません。

Evidence node を作ります。

概念例:

```ts
SymbolicEvidence {
  id
  queryKind
  claim
  targetEntityIds
  queryHash
  expressionSchemaVersion
  translatorVersion
  semanticVersions
  backendId
  backendVersion
  resultStatus
  model?
  assumptions
  limits
  completeness
  originEntityIds
}
```

`confirmed` に昇格できるのは query contract に従って deterministic verifier が proof を成立させた場合のみです。

AI prose だけで `confirmed` にしてはいけません。

---

# 16. Resource budgets

Phase 9 は state explosion を「後で考える」設計にしてはいけません。

最初から limit を query schema に入れます。

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
  maxMemoryBytes?
  maxModelValues
}
```

最低限:

- all loops bounded
- all forks bounded
- all solver calls timed
- cancellation propagated
- backend worker terminate path exists
- budget hit is typed result

Budget exceeded は `unknown/resource-limit` であり、証明失敗ではありません。

---

# 17. Determinism / Replay

Solver の内部探索順が完全 deterministic でなくても、Hex query は replay 可能でなければなりません。

保存対象:

```text
normalized query
query hash
solver id/version
solver options
semantic schema versions
translator version
limits
expected classification
```

Replay corpus では最低限:

```text
SAT stays SAT
UNSAT stays UNSAT
unsupported stays unsupported unless intentionally promoted
```

を gate します。

Model の exact variable assignment は backend/version で複数解があり得るため、必要な場合のみ canonical model constraints を設けます。

---

# 18. Test strategy

## T0 — Expr DAG unit tests

- width-distinct constants
- structural hashing
- canonical serialization
- commutative canonicalization if implemented
- wraparound
- signed/unsigned comparison
- logical/arithmetic shift
- trunc/zext/sext
- ITE
- unknown vs fresh symbol

## T1 — Translator tests

Semantic IR fixture ごとに:

```text
supported exact
supported with assumptions
partial
unsupported
```

を固定します。

## T2 — Fast evaluator differential

現行 evaluator が正しく処理できる subset について:

```text
same expression/input
FastSymbolicEvaluator
vs
Solver-backed query
```

を比較します。

目的は old implementation を semantic authority にすることではなく、移行時の accidental behavior change を早く検出することです。

## T3 — Solver replay corpus

- known SAT
- known UNSAT
- timeout
- unsupported
- cancellation
- malformed query rejection

## T4 — Branch verification

- always true branch
- always false branch
- symbolic reachable branch
- constrained unreachable branch
- unsupported dependency
- loop budget hit

## T5 — Equivalence

- identical expressions → proved
- algebraically equivalent bitvector expressions → proved
- wraparound-sensitive difference
- signedness-sensitive difference
- intentional semantic difference → counterexample
- memory side-effect mismatch

## T6 — Patch verification

- no-op-equivalent patch
- condition inversion finds counterexample
- return-preserving but memory-changing patch is not declared equivalent
- unsupported instruction produces unknown

## T7 — Evidence

- every proof links target + origins
- query hash stable
- backend/version recorded
- incomplete translation cannot create confirmed evidence

## T8 — Budgets / cancellation

- max nodes
- max constraints
- timeout
- abort signal
- worker termination
- repeated query cleanup

## T9 — Browser / iPad

Track at minimum:

- cold solver load latency
- warm query latency
- peak memory delta
- cancellation latency
- repeated session leak
- background worker behavior where testable

---

# 19. 推奨 Wave 分割

## Wave 0 — Contract freeze / baseline

Deliver:

- Phase 9 query/result taxonomy
- expression sort/version contract
- initial supported-op matrix
- baseline current symbolic fixtures
- budget schema
- backend ADR template / decision

Exit:

- implementation worker 間で SAT/UNSAT/UNKNOWN の意味が一致
- no code migration yet

## Wave 1 — Solver-neutral Expr DAG

Deliver:

- immutable nodes
- Bool/BV sorts
- exact bitvector helpers
- structural hash
- deterministic serializer
- pure evaluator for tests

Exit:

- width/signedness corpus green
- deterministic serialization green

## Wave 2 — Semantic IR translator + slicing

Deliver:

- narrow supported subset
- backward dependency slice
- support matrix
- partial/unsupported reporting
- origin map

Exit:

- translator never re-decodes instruction text
- unsupported op cannot silently become solvable

## Wave 3 — SolverBackend + first real backend

Deliver:

- backend/session/result contract
- registry
- cancellation
- timeouts
- normalized models
- first backend
- test backend/fakes where useful

Exit:

- SAT/UNSAT/UNKNOWN replay corpus green
- backend unavailable has typed failure

## Wave 4 — Branch Reachability vertical slice

Deliver:

- branch query
- solver invocation
- counterexample/model
- SymbolicEvidence
- AI/query API integration

Exit:

- first full end-to-end proof loop green
- deterministic evidence replay

## Wave 5 — Bounded Equivalence

Deliver:

- before/after state correspondence
- explicit equivalence scope
- counterexample extraction
- local rewrite verification hook

Exit:

- positive/negative equivalence corpus green
- memory/control side effects are not ignored

## Wave 6 — Patch verification

Deliver:

- patched projection comparison
- invariant/equivalence query
- integration with existing patch validation
- evidence and user-facing explanation

Exit:

- unsafe semantic changes produce counterexample or unknown, never false confirmation

## Wave 7 — Hardening / Phase gate

Deliver:

- browser worker isolation if required
- iPad resource measurements
- cache/replay strategy
- backend failure recovery
- plugin/AI integration review
- full regression matrix

Exit:

- Master Architecture Phase 9 exit gate satisfied

---

# 20. Worker ownership plan

Phase 9 は parallelize できますが、integration seams を明示します。

推奨 ownership:

```text
Worker A — Expr DAG + serialization
Worker B — Semantic IR translator + support matrix
Worker C — SolverBackend + provider lifecycle
Worker D — Branch/equivalence verifier
Worker E — Evidence + AI/query integration
Worker F — test corpus + browser/iPad budgets
```

ただし以下は integration hotspot です。

```text
js/symbolic/executor.js
js/agent/tools.js
js/ai/tools/registry.js
package.json
shared evidence schemas
```

これらを複数 Worker が無秩序に編集しないこと。

Integration owner が shared seams をまとめます。

---

# 21. Dependency / sequencing guidance

Phase 9 は Phase 7/8 の成果を利用します。

特に:

- SSA/MemorySSA stability
- alias proof
- function summaries
- type/width information
- decompiler transform provenance

が強いほど Phase 9 は簡単になります。

ただし solver-neutral DAG / backend contract 自体は独立して先行できます。

したがって効率のよい順序は:

```text
Phase7/8 semantic contracts stable
       │
       ├── parallel: Expr DAG / Backend contract
       │
       └── then: translator integration
                     ↓
              Branch reachability
                     ↓
              Equivalence
                     ↓
              Patch verification
```

Phase 8 の途中で `HighIR` 表現が変わっても Phase 9 が壊れないよう、Phase 9 は HighIR ではなく Semantic IR / SSA を proof input の中心にします。

---

# 22. 失敗しやすい実装パターン

## Anti-pattern 1 — Current AST に Z3 handle を生やす

短期は速いが backend abstraction が消滅します。

## Anti-pattern 2 — JS BigInt の演算をそのまま machine arithmetic とする

Overflow / signedness で silent wrong proof が出ます。

## Anti-pattern 3 — Unknown を unconstrained input にする

未知の「入力」と未知の「意味」を混同しています。

## Anti-pattern 4 — Whole binary symbolic execution を background で開始する

Browser/iPad-first 方針と state explosion の両方に反します。

## Anti-pattern 5 — Solver timeout を false として扱う

最悪クラスの correctness bug です。

## Anti-pattern 6 — Equivalence が return value だけ

Memory/control/call side effect を失います。

## Anti-pattern 7 — Solver が alias を勝手に補う

Hex の conservative MemorySSA/alias truth と二重 truth になります。

## Anti-pattern 8 — AI が solver query の欠落を prose で補う

AI は planner/explainer であり proof authority ではありません。

## Anti-pattern 9 — Solver dependency を先に import してから contract を考える

Deployment/license/worker/cancellation の都合で architecture が solver-specific になります。

## Anti-pattern 10 — Existing fast evaluator を一気に置換する

Regression oracle と cheap path を同時に失います。

---

# 23. Phase 9 完了条件

Master exit gate に加え、以下を満たすことを推奨します。

## Architecture

- [ ] solver-neutral Expr DAG が backend-specific object を公開しない
- [ ] `Semantic IR -> Expr` は architecture-neutral
- [ ] fast evaluator が引き続き利用可能
- [ ] unknown semantics が explicit
- [ ] result taxonomy が typed

## Correctness

- [ ] bitvector overflow / signedness tests green
- [ ] known SAT/UNSAT corpus green
- [ ] timeout/unsupported/cancel cannot become proof
- [ ] branch reachability E2E green
- [ ] equivalence positive/negative corpus green
- [ ] patch return-equal/memory-different caseを誤認しない

## Evidence

- [ ] proof has query hash
- [ ] backend/version captured
- [ ] semantic/translator versions captured
- [ ] origin/evidence chain preserved
- [ ] partial translation cannot generate `confirmed`

## Performance / safety

- [ ] strict wall/solver/state budgets
- [ ] cancellation works
- [ ] repeated sessions do not leak materially
- [ ] iPad/browser measurements recorded
- [ ] backend unavailable/failure is recoverable

## Regression

- [ ] current symbolic tests green
- [ ] semantic regression green
- [ ] decompiler regression green
- [ ] compiler-truth / differential gates remain green as applicable
- [ ] AI evidence/security boundaries green
- [ ] exact tested SHA recorded

---

# 24. 最短で進めるための実装順

実作業で迷ったらこの順で進めます。

```text
1. Result taxonomy を固定
2. Bool/BV Expr DAG を作る
3. deterministic serializer/hash を作る
4. tiny evaluator + unit corpus で意味を固定
5. Semantic IR translator の narrow subset を作る
6. test backend で query orchestration を完成
7. first real SolverBackend を接続
8. Branch Reachability を E2E 完成
9. Evidence を固定
10. Equivalence を追加
11. Patch verification を追加
12. iPad/browser budgets と failure recovery を詰める
13. full gate
```

solver dependency の選定を 1番目にしないことが重要です。

---

# 25. 実装開始前の ADR / decision checklist

最低限、以下は明示的 decision を残します。

- [ ] first solver backend と version/license
- [ ] local WASM / native / remote の deployment policy
- [ ] expression sort/version schema
- [ ] supported op matrix
- [ ] `UnknownSemantic` と symbolic input の区別
- [ ] SolverResult taxonomy
- [ ] timeout/cancellation mechanics
- [ ] SymbolicEvidence schema
- [ ] equivalence scope semantics
- [ ] patch verifier が比較する state surface
- [ ] replay artifact format

---

# 26. Phase 9 の成功イメージ

Beginner-facing UI では solver 名を前面に出す必要はありません。

理想:

```text
この分岐は到達できる？

→ 到達できません（検証済み）

理由:
- 条件 A が成立するには x < 10 が必要
- 直前の path constraint では x >= 10
- 両方を満たす入力は存在しない

[証拠を見る]
  ↓
SymbolicEvidence
  ↓
constraint / solver result
  ↓
SSA / MemorySSA
  ↓
Semantic IR
  ↓
instruction / bytes
```

Expert-facing view では:

```text
Query hash
Normalized constraints
Backend/version
SAT/UNSAT/UNKNOWN
Model / unsat proof metadata where available
Budget
Completeness
Origin mapping
```

まで降りられます。

これは Hex の evidence-first architecture と完全に同じ方向です。

---

# 27. 結論

Phase 9 の本質は「強い solver を積むこと」ではありません。

本質は:

```text
Semantic truth
  → bounded query
  → exact translation
  → backend-neutral proof request
  → typed solver result
  → evidence
```

という信頼できる verification boundary を作ることです。

最初の勝ち筋は **Branch Reachability**。

そこから **Bounded Equivalence**、最後に **Patch Verification** へ進みます。

現行 FastSymbolicEvaluator は残し、cheap path と solver-backed proof path を分離します。

この順序なら、Phase 9 で最も危険な bitvector、unknown semantics、memory side effects、state explosion、browser resource 問題を一つずつ隔離して解けます。
