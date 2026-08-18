# Phase 8 実行ブループリント — Decompiler Quality

> **Status:** 実装前の execution contract  
> **Scope:** Master Architecture Phase 8  
> **Prepared baseline:** `main` = `e90c5107f9c77d73687ee452d5042dcbe9e79ece`  
> **併読:** `PHASE8_IMPLEMENTATION_GUIDE.ja.md`, `HEX_MASTER_ARCHITECTURE.md`, `ENGINEERING_PROCESS_GUARDRAILS.md`, `MIGRATION_GUARDRAILS.md`

この文書は Phase 8 の実装ガイドを、実際に lane/checkpoint に分けて進められる execution contract まで具体化したものです。

防ぎたい失敗は主に3つです。

1. 正しいアルゴリズムを間違った layer に実装する。
2. Pseudocode は綺麗になったが semantic/provenance が壊れる。
3. 全 component が終わってから integration/verifier の問題を初めて発見する。

Baseline は意図的に固定して記録しています。**Phase 8 を実際に開始する P8-0 では、必ず live `main` を再取得し、この readiness matrix を現物から作り直してください。** Phase 6 / Phase 7 / unrelated main の変更を無視して、この文書の baseline をそのまま事実扱いしてはいけません。

---

## 1. Phase 8 の成功条件

Phase 8 は次の4軸を同時に満たした時だけ完了です。

```text
semantic correctness      hard gate
provenance / evidence     hard gate
readability / recovery    measurable improvement
browser / iPad cost       bounded and acceptable
```

Readable になっても以下のどれかが起きたら reject です。

- semantic mismatch
- provenance loss
- unknown を false certainty に変更
- alias/effect proof のない最適化
- generic pass に architecture assumption を混入
- target browser/iPad budget を重大に悪化

Master Architecture の Phase 8 deliverable は次の8項目です。

- SCCP
- GVN / CSE
- effect-aware DCE
- richer ranges / value sets
- loop induction
- irreducible / exception structuring
- aggregate / array recovery
- language pattern providers

一方、Master Architecture §18.2 の mature middle-end にはさらに以下があります。

- copy propagation
- alias-proof load/store forwarding
- pointer/address normalization
- loop simplification
- switch recovery
- prototype recovery
- aggregate/union recovery
- stack/register variable coalescing
- tail-call/thunk normalization
- exception-aware analysis

ここを「全部 Phase 8 で新規実装」と決め打ちしません。**P8-0 で既存実装を棚卸しし、既に十分なものは regression-prove、足りないものだけ Phase 8 で強化**します。

---

## 2. P8-0 で再確認する現状

Prepared baseline 時点では次が観測されています。

### 2.1 Pass infrastructure は既にある

`js/decompiler/passes/manager.js` には既に以下があります。

- global deadline
- node budget
- iteration cap
- optional pass skip
- degraded state
- pass metrics

現在の default は 40 ms / 12,000 nodes / 16 iterations です。

`pipeline-core.js` 側は default total decompiler budget を 50 ms にしています。

つまり Phase 8 は pass manager をゼロから作る必要はありません。ただし重い fixed-point optimizer を追加する前に、**partial execution / cancellation / publication atomicity** の意味を強化する必要があります。

### 2.2 現在の pipeline order

Prepared baseline の `pipeline-core.js` は概ね以下です。

```text
high-variable recovery
prototype recovery
aggregate-layout recovery
canonical expression build
semantic rewrite
semantic facts
semantic AST
C AST
pretty print
```

Phase 8 の dependency を扱うには、この flat list だけでは足りません。

- SCCP
- range
- GVN
- DCE
- induction
- aggregate
- structuring

の依存関係を explicit にする必要があります。

### 2.3 Rewrite engine は再利用する

`js/decompiler/rewrite/engine.js` には既に以下があります。

- named phase
- precondition
- proof record
- deterministic structural key
- time/node/iteration/application budget
- fixed-point

したがって Phase 8 で別の rewrite framework を作るのは避けます。

不足しているのは主に:

- analysis preservation
- invalidation
- pass publication atomicity
- cancellation 時の authority

です。

### 2.4 Memory substitution の方向性は正しい

`pipeline-core.js` は、Semantic IR / MemorySSA に exact reaching-store relation が残っている場合に load を reaching store value へ置換しています。

この方向は維持します。

> **Decompiler が「同じアドレスに見えるから同じ値」と推測するのではなく、MemorySSA を proof source にする。**

Phase 8 の GVN/CSE/DCE も同じ principle を使います。

### 2.5 Recovery は既存を捨てずに強化する

Prepared baseline では既に:

- `types/high-variables.js` — conservative SSA coalescing
- `types/prototype.js` — prototype recovery
- `types/layout.js` — MemorySSA access pattern からの conservative aggregate/array recovery
- `loop-repair.js` — loop recovery
- `switch.js` — switch recovery

があります。

Phase 8 で全面書き換えせず、exit metric を満たすために必要な箇所だけ深くします。

### 2.6 Cross-architecture debt を P8-0 で必ず再監査する

Prepared baseline では `types/high-variables.js` と `types/prototype.js` に明示的な AAPCS64 前提が残っています。

例:

- `x0..x7`
- `v0..v7`
- `x8`
- `convention: 'AAPCS64'`

Phase 5/6/7 が Phase 8 前にここを変える可能性があります。

したがって P8-0 で必ず再確認します。

もし残っていれば:

- SCCP/GVN/DCE にこの assumption を持ち込まない
- ABI facts は target/ABI layer または compatibility provider から供給
- naming/presentation rule は refinement/provider に隔離

とします。

### 2.7 Differential infrastructure は既存を使う

Repository には既に:

- Ghidra decompiler differential
- compiler-truth
- cross-binary accuracy
- semantic/decompiler regressions
- bounded equivalence support

があります。

Prepared baseline の Ghidra workflow は official pinned Ghidra を使い、real compiler-truth comparison が skip された場合は fail する contract です。

Phase 8 はこれを final release だけの別 verifier に置き換えません。

---

## 3. P8-0 Readiness Matrix

Optimizer component を始める前に、mature middle-end の全 requirement を checked-in report にします。

推奨 state:

```text
PROVEN_EXISTING
PARTIAL_EXISTING
PHASE8_IMPLEMENT
UPSTREAM_BLOCKED
INTEGRATION_ONLY
NOT_REQUIRED_FOR_P8_EXIT
```

最低限、以下の row を持ちます。

| Capability | P8-0 で確認すること | Action |
|---|---|---|
| SCCP | executable-edge-aware dedicated implementation があるか | 無ければ Phase 8 実装 |
| Copy propagation | SSA/expression/rewrite ですでに semantic に満たしているか | prove。重複実装しない |
| GVN/CSE | generic implementation があるか | 無ければ実装 |
| Effect-aware DCE | unused + no-observable-effect を proof できるか | effect proof 付きで実装 |
| Range/value set | machine-width wrap を扱えるか | 必要分強化 |
| Load/store forwarding | MemorySSA/alias proof 限定か | proof API を維持/拡張 |
| Pointer normalization | architecture-neutral canonical form があるか | existing rewrite/semantic を audit |
| Loop induction | reusable induction summary があるか | 無ければ実装 |
| Loop simplification | proved CFG/induction facts を使うか | 必要分強化 |
| Switch recovery | `switch.js` が release corpus を満たすか | 先に regression-prove |
| Prototype recovery | ABI-generic になっているか | 未完なら prerequisite/blocker |
| Aggregate/array/union | ambiguity/contradiction を保持するか | candidate model 強化 |
| Variable coalescing | SSA/provenance based か、ABI hardcode が残るか | conservative behavior 維持/一般化 |
| Tail-call/thunk | generic normalization があるか | audit 後必要時のみ実装 |
| Exception-aware | exception edge が structuring まで保持されるか | unsafe structuring の blocker |
| Language providers | idiom が provider boundary に隔離されているか | provider 化 |

Row を黙って消してはいけません。

Status が不明なら `UPSTREAM_BLOCKED` または explicit audit task にします。

---

## 4. Dependency graph と pass staging

Phase 8 を1本の flat pass list として扱いません。

推奨 logical stage:

```text
Stage A — canonical semantic inputs
  Semantic IR + CFG + SSA + MemorySSA
  Phase 7 alias/range/summary/type facts

Stage B — scalar facts
  SCCP
  wrapped range/value-set
  copy/canonical scalar propagation

Stage C — expression/memory optimization
  GVN/CSE
  alias-proved load forwarding
  effect-aware DCE
  pointer/address normalization

Stage D — loop facts
  induction summaries
  loop simplification candidates

Stage E — high-level recovery
  high-variable refinement
  prototype refinement
  aggregate/array/union candidates

Stage F — control-flow structuring
  switch/SESE/if/loop
  exception constraints
  irreducible SCC
  goto fallback

Stage G — language/compiler refinement
  ObjC / Swift / C++ / Rust / Go / etc

Stage H — AST/render
  semantic AST
  C AST / language projection
  pretty print + source map
```

Stage 内部の fixed-point は許可します。

しかし:

```text
range -> induction -> aggregate -> type -> range -> ...
```

のような uncontrolled cycle は禁止です。

Feedback refinement が必要なら:

- numbered refinement round
- deterministic cap
- precision loss/degraded diagnostic

を明示します。

---

## 5. Pass Transaction Contract

現在の pass manager は budget exhaustion と optional skip を許容します。

Phase 8 は重い optimizer を追加するため、**half-mutated state の publication を禁止する contract** が必要です。

論理 contract 例:

```ts
PassDescriptor {
  id
  version
  stage
  required
  consumes
  preserves
  invalidates
  budgetClass
}

PassResult {
  status: "unchanged" | "changed" | "degraded" | "unsupported"
  outputArtifact
  transforms
  diagnostics
  stats
  completeness
  preservedAnalyses
  invalidatedAnalyses
}
```

必須 rule:

1. Readability のために canonical Semantic IR / SSA / MemorySSA を in-place mutate しない。
2. Pass は staged result を作り、安全な publication point でのみ commit。
3. Publication 前に cancellation/deadline/error が来たら、直前の valid artifact が authority のまま。
4. CFG を変えたら dominance/post-dominance/loop/executable-edge 等を必要に応じて invalidate。
5. Value expression を変えたら range/value-number preservation を明示。
6. Memory-visible op を変えたら MemorySSA/effect preservation が証明できない限り dependent analysis を invalidate。
7. `skipped due budget` は `complete` と同義ではない。degraded/completeness を UI/evidence/metric に流す。
8. Optimization budget 後に required finalization を走らせてもよいが、skip された optimizer fact を finalizer が勝手に作らない。

Regression:

- abort-before-start
- abort-mid-pass
- publication boundary cancellation
- staging exception
- repeated execution
- deterministic replay

を含めます。

---

## 6. Analysis Preservation / Invalidation Contract

各 transform は必ず「この変更後も何が valid か」を答えます。

最低限の category:

```text
CFG
DominatorTree
PostDominatorTree
LoopForest
ExecutableEdges
SSA
DefUse
MemorySSA
AliasFacts
RangeFacts
ValueNumbers
TypeConstraints
FunctionSummary
OriginMap
```

永久設計として `invalidate everything` に逃げないこと。

- correctness 的には安全でも iPad performance / ArtifactStore reuse を壊す
- 逆に全部 preserve は unsound

P8-1 で category ごとの invalidation regression を入れます。

---

## 7. SCCP Contract

SCCP は sparse + executable-edge-aware が必須です。

Minimum lattice:

```text
UNDEFINED / UNREACHABLE
CONSTANT(bits, value)
OVERDEFINED / UNKNOWN
```

Rule:

- Phi は executable predecessor のみ join
- Edge executability は exact machine-width semantics で proof
- exact width / trunc / extend / modular wrap / signed/unsigned compare を守る
- unsupported は UNKNOWN
- call/store barrier を MemorySSA/effect proof 無しで跨がない
- branch pruning は consumed condition/origin/evidence を残す
- unresolved/unknown edge を readability のためだけに消さない

Negative corpus:

- wraparound
- signed/unsigned disagreement
- partial executable phi
- unknown call
- unknown store
- unsupported operation
- unresolved branch
- edge removal 後 provenance

---

## 8. Range / Value Set Contract

最低限 machine-width aware である必要があります。

Plain mathematical interval だけでは不足です。

必須 semantics:

- exact bit width
- wrapped interval または同等に conservative な表現
- signed/unsigned query view
- singleton constant
- unknown/top
- deterministic loop widening
- precision loss diagnostic

Optional:

- known-zero/known-one bits
- small finite value set

は bounded/versioned にできる場合のみ追加します。

Range fact は branch/switch/induction/pointer/aggregate の proof input ですが、source-level type を直接強制しません。

---

## 9. GVN / CSE Contract

### 9.1 Scalar

Value key は:

- semantic op identity
- exact width
- canonical operands
- operation-specific semantic flags

で作ります。

Pretty text は key にしません。

### 9.2 Memory

Load の commoning は概念的に最低でも:

```text
address-value
+ memory-version
+ access-width
+ volatile/atomic/order semantics
+ relevant extension/type semantics
```

を含む proof が必要です。

以下は原則 barrier:

- unknown store
- may-alias store
- unknown call
- changed memory version
- volatile
- atomic/ordered boundary

Owner analysis が安全と証明した時だけ突破できます。

### 9.3 Trap / Observability

1回の実行を消すことで trap/fault/order behavior が変わる可能性がある operation は、明示的 equivalence proof がない限り CSE しません。

---

## 10. Effect-aware DCE Contract

削除条件は必ず:

```text
result dead
AND
required observable effect = none
```

です。

Effect query が最低限見るもの:

- memory read/write
- volatile
- atomic/order
- unknown call
- known call summary
- mayThrow/unwind
- mayTrap/fault
- control-flow
- live flag/state effect
- runtime/language intrinsic

Unknown は blocker です。

Memory DCE は MemorySSA / alias / effect proof を使います。

「後で同じ場所を上書きする」だけでは、途中で read/call が観測し得るため proof になりません。

---

## 11. Loop Induction / Simplification Contract

Rendering heuristic ではなく reusable fact を作ります。

推奨 summary:

```ts
InductionSummary {
  phiValueId
  init
  step
  updateKind
  guard
  bound
  signedness
  tripCountRange
  exits
  evidenceIds
  completeness
}
```

Conservative に扱う難所:

- multiple backedges
- variable step
- wrapping induction
- pointer induction
- early exits
- nested loops
- cast/copy 経由 update
- derived guard value
- irreducible SCC

Consumer:

- range refinement
- array recovery
- pointer stride
- loop rendering
- simplification

各 consumer が induction を独自再実装しないようにします。

---

## 12. Structuring Contract

`goto = 0` は success condition ではありません。

Required input:

- dominance/post-dominance
- explicit edge kind
- natural loop
- SESE
- switch edge
- exception/unwind edge
- unresolved/indirect edge
- induction fact

推奨順序:

```text
dominance/post-dominance
natural loops
SESE
if/else + switch
break/continue
exception constraints
irreducible SCC
safe node splitting
explicit goto fallback
```

Original relevant CFG edge は必ず:

- structured construct
- explicit residual edge/goto
- explicit unknown/unsupported

のどれかに対応します。

**消えた edge は hard failure** です。

Control-flow flattening/state-machine は generic structurer が勝手に意味を作るのではなく recognition layer で扱います。

---

## 13. Aggregate / Array / Union Recovery Contract

Prepared baseline の `types/layout.js` は conservative starting point として有用ですが、Phase 8 では contradiction-aware candidate model が必要です。

推奨:

```ts
AggregateCandidate {
  kind: "struct" | "array" | "union" | "object" | "unknown"
  rootIdentity
  extent
  fields
  element
  stride
  hardConstraints
  softEvidence
  contradictions
  confidence
  evidenceIds
  completeness
}
```

Input:

- pointer provenance
- alias region
- access width
- fixed offset
- induction stride
- range
- authoritative debug info
- call prototype
- runtime metadata
- language provider evidence

Hard conflict は conflict のままです。

`struct-or-array` ambiguity を readability のためだけに1つへ潰しません。

Negative case:

- overlapping field
- union
- flexible array member
- array-of-struct vs struct-of-array
- padding
- embedded object
- object boundary を跨ぐ pointer arithmetic
- unrelated access の syntactic-base collision

---

## 14. ABI / Prototype / Variable / Tail-call / Thunk Readiness

Phase 8 は generic middle-end なので、legacy AAPCS64 assumption を固定化してはいけません。

P8-0 で:

1. `types/prototype.js` / `types/high-variables.js` を Phase 5/6/7 後の live main で再監査。
2. Argument/return location は ABI layer または compatibility provider から取得。
3. Source-variable identity は physical register reuse ではなく SSA/provenance based。
4. Tail-call/thunk normalization が generic call/control-flow fact を使うか audit。
5. Architecture-specific naming/presentation は provider/refinement に隔離。

Cross-architecture prototype recovery が未完成なら SCCP/GVN 内に workaround を入れず、Phase 8 prerequisite/blocker として明示します。

---

## 15. Language / Compiler Provider Contract

Provider がしてよいこと:

- idiom match
- nominal type candidate
- vtable/witness/dispatch interpretation
- closure/state-machine candidate
- source-like render hint
- named precondition 付き rewrite candidate

してはいけないこと:

- instruction decode
- machine semantics reinterpretation
- SSA/MemorySSA bypass
- alias/effect fact の捏造
- hard type contradiction override
- provenance erase
- common pattern だけで `confirmed` 昇格

Prepared baseline では `pipeline-core.js` に ARM64/Clang refinement が直接見えます。

Phase 8 開始時にも残っているなら、compatibility を守りつつ provider boundary 側へ寄せます。

---

## 16. Provenance / Transform Evidence

Phase 8 後も必ず辿れる必要があります。

```text
rendered / HighIR node
  -> transform record
  -> consumed semantic nodes
  -> SSA / MemorySSA
  -> instruction IDs
  -> binary byte ranges
```

Mandatory corpus hard gate:

```text
orphanProducedNodes = 0
danglingConsumedNodeRefs = 0
provenanceLossCount = 0
unexplainedSourceRangeLoss = 0
originDeterminismFailures = 0
```

Rewrite proof には最低限:

- pass/rule id + version
- consumed/produced IDs
- preconditions
- proof kind
- origin union
- evidence IDs
- completeness/degraded state

を残します。

これは deterministic transform metadata であり、model chain-of-thought ではありません。

---

## 17. Readability / Correctness Metric

単一 score にしません。

### Hard gate

```text
semanticMismatchCount = 0
provenanceLossCount = 0
unknownSafetyRegressionCount = 0
forcedTypeContradictionCount = 0
architectureBoundaryViolationCount = 0
transformDeterminismFailureCount = 0
staleArtifactAcceptanceCount = 0
lostCfgEdgeCount = 0
```

### Quality vector

- control-structure recovery
- variable merge/split accuracy
- prototype accuracy
- type accuracy
- aggregate field/array recovery
- unnecessary temporaries
- redundant assignment/expression
- goto count where semantics permit
- expression complexity/depth
- raw phi leak
- unresolved switch
- raw pointer arithmetic
- source/provenance coverage

個別 function で metric が悪化しても correctness のためなら許容されます。

例: false loop を修正して necessary goto を復元した場合、`gotoCount` は増えても正しい improvement です。

その場合は blended score に隠さず、evidence に理由を残します。

---

## 18. Corpus Contract

P8-0 で mandatory Phase 8 corpus identity と provenance を freeze します。

Long-term architecture が要求する dimension:

```text
AArch64 / x86-64 / RISC-V64
Mach-O / ELF / PE
O0 / O1 / O2 / O3 / Os/Oz / LTO where available
C / C++ / Objective-C / Swift / Rust / Go
Clang/LLVM / GCC / MSVC / rustc / Swift / Go where available
paired debug + stripped builds where applicable
```

P8-0 は存在しない fixture を捏造しません。

ただし:

- release mandatory
- unavailable
- not required

を明示します。

Required family が欠けた場合は silently contract を縮小せず fail closed にします。

各 transform family に positive + adversarial micro-case を持たせます。

---

## 19. Existing Verifier Integration

最低限 preserve/extend する local command:

```bash
npm run semantic:test
npm run decompiler:test
npm run compiler-truth
npm run integration:test
npm run migration:test
npm run check
```

CI/evidence:

- Ghidra decompiler differential
- cross-binary accuracy
- invariant/migration gates
- compiler-truth report
- decompiler equivalence support
- earlier-phase architecture semantic gates

P8-0 で permanent exact-SHA Phase 8 verifier entry point を作ります。

P8-I はその同じ verifier を exact release candidate に再実行するだけの状態にします。

Verifier acceptance semantics が変わったら affected prior evidence を invalidate します。

---

## 20. Artifact Identity / Invalidation

Phase 8 artifact key は、該当する semantic input/version をすべて含みます。

例:

- Semantic IR schema/version
- architecture semantic version
- ABI semantic version
- CFG/SSA/MemorySSA version
- alias/range/summary/type version
- pass implementation/version
- pass option
- provider version
- debug/runtime metadata version
- release evidence の corpus/verifier identity

両方 test:

### Under-invalidation

Relevant input が変わったのに stale artifact が hit。

→ correctness failure。

### Over-invalidation

Unrelated change で reusable artifact が全部捨てられる。

→ performance failure。

永久対策として broad cache clear に逃げません。

---

## 21. Budget / Cancellation / iPad Performance

Browser/iPad constraint は final benchmark ではなく architecture contract です。

Metric:

- per-pass time
- iteration count
- visited nodes/edges
- value-number/range-state count
- peak retained analysis memory
- cancellation latency
- cold/warm reuse
- active-function decompilation latency
- browser p95/p99 responsiveness where available

Rule:

1. Whole-binary full optimizer を default にしない。
2. active/queried function + demanded dependency を優先。
3. fixed-point は deterministic convergence/budget。
4. budget exhaustion は explicit degraded/partial。unsafe inference にしない。
5. CI sharding を増やす前に pathological production function を profile。
6. 可能なら known pathological structure に complexity guard を追加。

---

## 22. 効率よく進める Component DAG

推奨 dependency:

```text
P8-0 foundation/verifier
  |
  v
P8-1 transaction + preservation substrate
  |
  +--> P8-2 SCCP/range
  |       |
  |       +--> P8-4 loop induction
  |       |       |
  |       |       +--> P8-6 aggregate/array recovery
  |       |
  |       +--> P8-3 GVN/CSE + DCE
  |
  +--> P8-5 structuring foundation
          ^       |
          |       v
          +--- P8-4 loop facts

P8-7 language providers は generic contract が安定してから。
P8-I は living integration で全 component を統合。
```

Safe な parallelism:

- P8-0 の verifier/ownership と baseline measurement は non-overlap なら並列可。ただし contract freeze は1 integration owner。
- P8-1 後、SCCP/range 実装と structuring corpus/test 準備は shared pipeline wiring を触らなければ並列可。
- GVN/DCE の design/test は先行可。ただし production integration は alias/effect/range contract が揃ってから。
- Aggregate corpus/provider research は早期開始可。Production recovery integration は induction/type facts が安定してから。
- Language provider は deliberately late。

Worker slot を埋めるためだけに lane を作りません。

---

## 23. Proposed Lane Ownership

P8-0 で live repository を見て machine-readable manifest に変換します。

Conceptual lane:

```text
p8-0  foundation / runner / ownership / baseline / exact-SHA verifier
p8-1  pass transaction + preservation/invalidation
p8-2  SCCP + wrapped ranges/value sets
p8-3  GVN/CSE + effect-aware DCE
p8-4  loop induction + loop simplification facts
p8-5  irreducible/exception structuring
p8-6  aggregate/array/union recovery
p8-7  language/compiler providers
p8-v  independent verifier/corpus if useful
p8-i  living integration + generated output + cutover
```

High-conflict shared path は原則 integration owner に寄せます。

例:

- `pipeline-core.js`
- public decompiler entrypoints
- package/workflow wiring
- generated runtime artifacts
- support/capability metadata

Actual ownership は fanout 前に real changed-file inventory と照合して validator test を入れます。

---

## 24. Integration Checkpoint Transaction

Component を living integration に入れる前:

1. live `main` / integration head / component exact head を refetch。
2. 必要なら integration が moving main を reconcile。
3. Review 後 component head が動いていないことを確認。
4. candidate merge tree を作る。
5. candidate tree で ownership/governance。
6. rolling Phase 8 vertical gate + independent verifier。
7. candidate green の時だけ component merge。

Merge 後は checkpoint lock:

1. cross-pass/shared contract reconcile
2. semantic/artifact/pass version update
3. applicable generated output canonical rebuild
4. rebuild zero diff
5. rolling product gate
6. independent shadow verification
7. exact checkpoint SHA / component head / verifier / corpus / generated identity / metrics / blockers 記録

これが終わるまで次の dependent component を入れません。

---

## 25. Generated Output Rule

Decompiler source が deployable protected/browser runtime artifact に入るかは P8-0 時点の build graph で exact に確認します。

該当する場合:

- component lane は generated output を ephemeral build/test
- shared generated file を component が勝手に commit しない
- integration が canonical generated sync owner
- generated file は source から regenerate。hand merge 禁止
- rebuild zero diff を checkpoint/release gate
- release identity は exact deployable content を表す

---

## 26. Failure Taxonomy

Phase 8 report/tool は最低限以下を区別します。

```text
semantic-mismatch
provenance-loss
unknown-safety-regression
alias-proof-missing
effect-proof-missing
range-overprecision
cfg-edge-loss
structuring-unsupported
irreducible-unsupported
exception-model-incomplete
type-contradiction
forced-type-certainty
architecture-boundary-violation
pass-budget-exhausted
pass-cancelled
pass-partial-publication
analysis-invalidation-error
artifact-under-invalidation
artifact-over-invalidation
verifier-regression
corpus-incomplete
ghidra-differential-regression
performance-regression
merge-conflict
generated-output-stale
```

全部を `decompiler failed` に潰しません。

---

## 27. Component ごとの Definition of Done

Positive case が綺麗になっただけでは DONE ではありません。

各 component は最低限:

1. exact base/head identity
2. ownership 内の actual changed-file inventory
3. contract/version change
4. positive transformation case
5. near-miss negative case
6. unknown/partial case
7. width/signedness case
8. memory/call/effect barrier case
9. provenance assertion
10. determinism assertion
11. cancellation/budget assertion
12. artifact invalidation test
13. applicable architecture matrix
14. candidate-merge-tree proof
15. integration 後 exact checkpoint evidence

を持ちます。

---

## 28. P8-I Final Release Gate

Phase 8 DONE 宣言前:

- living integration を current main と reconcile
- exact release candidate SHA freeze
- applicable generated output を canonical regenerate + zero diff
- blocking exact-SHA workflows 全実行
- frozen corpus/oracle/toolchain identity で mature Phase 8 verifier
- `semanticMismatchCount = 0`
- `provenanceLossCount = 0`
- `unknownSafetyRegressionCount = 0`
- `forcedTypeContradictionCount = 0`
- `lostCfgEdgeCount = 0`
- unexplained Ghidra differential regression = 0
- unexplained cross-binary accuracy regression = 0
- P8-0 baseline 比で accepted readability/recovery improvement
- active-function/browser/iPad cost acceptable
- generic pass に architecture-specific semantic authority がない
- capability/support maturity が evidence を超えていない
- expected-head protection 付き merge
- merged `main` を refetch して exact product を確認
- runtime/deployment activation が completion claim に必要なら active identity を別途証明

Final verification が初めて real combined product を見るなら P8-0 設計失敗です。

---

## 29. やってはいけないこと

- Decompiler 全面書き換え
- optimizer 用 second Semantic IR / alias engine
- pretty text を semantic key にする
- unknown call を pure 扱い
- changed/unknown MemorySSA version を跨ぐ load commoning
- result unused だけで operation 削除
- machine bitvector を mathematical integer range で近似して確定
- goto count を減らすため exception/indirect/irreducible edge 削除
- contradiction がある aggregate/type を1候補に強制
- generic pass に ARM64/AAPCS64 semantic assumption
- browser で unbounded fixed point
- cancellation 時 half-transformed state publish
- permanent cache invalidation を全消しで済ませる
- final release で初めて verifier を完成させる
- generated output の hand merge
- old-head green CI を new head evidence 扱い

---

## 30. Phase 8 開始時の実行順

```text
0. live main と Phase 6/7 completion evidence を再取得。
1. actual source tree から P8-0 readiness matrix 再作成。
2. ownership / pass contract / corpus / baseline metrics / exact-SHA verifier freeze。
3. no-op identity pass を production path に通し、output/semantic/provenance zero-change を証明。
4. pass publication / cancellation / invalidation を transactional 化して regression。
5. executable-edge + exact-width SCCP。
6. wrapped range/value-set + deterministic widening。
7. scalar GVN/CSE。Memory reuse は MemorySSA/alias/effect proof 後のみ。
8. observable-effect negative corpus 付き effect-aware DCE。
9. reusable induction summary + bounded loop refinement。
10. exception-aware / irreducible structuring + explicit goto fallback。
11. shared facts から aggregate/array/union recovery。contradiction 保持。
12. live tree に残る prototype/variable/tail/thunk architecture debt を audit/generalize。
13. generic quality が proven 後に language/compiler provider。
14. 各 integration checkpoint で同じ rolling exact-SHA verifier。
15. P8-I exact-product verification + cutover。
```

Phase 8 で覚える原則はこれだけです。

> **綺麗な出力を作るために Hex が証明できない事実が必要なら、汚くても正しい出力を残し、その事実を所有する analysis layer を改善する。**
