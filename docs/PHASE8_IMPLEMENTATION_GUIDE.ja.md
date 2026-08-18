# Phase 8 実装ガイド — Decompiler Quality

> **Status:** 実装前の設計・進行ガイド  
> **Scope:** Master Architecture Phase 8 のみ  
> **Prepared against:** `main` at `e90c5107f9c77d73687ee452d5042dcbe9e79ece`  
> **Canonical architecture:** `docs/HEX_MASTER_ARCHITECTURE.md`  
> **Normative process:** `docs/ENGINEERING_PROCESS_GUARDRAILS.md` / `docs/MIGRATION_GUARDRAILS.md`

この文書は Phase 8 を始める前に、実装順・依存関係・難所・失敗パターン・検証方法を先に固定するためのものです。

目的は「実装中に考えながら大改造する」ことを避け、Phase 8 を小さな検証可能な checkpoint に分解することです。

`HEX_MASTER_ARCHITECTURE.md` と矛盾した場合は Master Architecture が優先されます。後から accepted ADR が入った場合も ADR / 更新後の Master Architecture が優先です。

---

## 1. Phase 8 は何をする Phase なのか

Phase 8 は **Decompiler を新規に作る Phase ではありません**。

現時点ですでに Hex には次の土台があります。

- `js/decompiler/semantic-core.js`
- `js/decompiler/semantic.js`
- `js/decompiler/pipeline-core.js`
- `js/decompiler/pipeline.js`
- `js/decompiler/passes/manager.js`
- `js/decompiler/passes/stack-phi-recovery.js`
- `js/decompiler/passes/stack-return-recovery.js`
- `js/decompiler/rewrite/engine.js`
- `js/decompiler/rewrite/rules.js`
- `js/decompiler/loop-repair.js`
- `js/decompiler/switch.js`
- `js/decompiler/type-recovery.js`
- `js/decompiler/provenance.js`
- `js/decompiler/verify/equivalence.js`
- AST / pretty-printer / idiom / truth / type recovery 周辺
- compiler-truth / Ghidra differential / decompiler regression

したがって Phase 8 の本質は次です。

> **既存の Semantic IR → SSA / MemorySSA → High-level Decompiler pipeline を壊さず、最適化・構造化・型/aggregate recovery の精度を一段上げる。**

Master Architecture 上の deliverable は以下です。

- SCCP
- GVN / CSE
- effect-aware DCE
- richer ranges / value sets
- loop induction
- irreducible / exception structuring
- aggregate / array recovery
- language pattern providers

そして exit gate は単なる「機能追加完了」ではありません。

- mandatory corpus で semantic regression = 0
- readability が測定可能に改善
- Ghidra differential diagnostics が悪化しない
- provenance coverage が完全に維持される

ここが Phase 8 の最重要条件です。

---

## 2. Phase 7 の不足を Phase 8 の heuristic で埋めない

Phase 8 は Phase 7 の出力をかなり強く使います。

Phase 7 側で想定される基盤は次です。

- alias A1 / A2 / A3
- escape analysis
- versioned function summaries
- hard type constraints
- DWARF / PDB 等の debug-info ingestion
- cross-architecture function discovery

Phase 8 で最もやってはいけないのは、上流の解析事実が足りないから Decompiler 側で推測して辻褄を合わせることです。

原則はこれです。

> **必要な事実の owner が Alias / MemorySSA / Summary / Type / CFG なら、その owner を直す。Decompiler が private heuristic で事実を作らない。**

具体例:

- CSE が「見た目が同じアドレスだから同じ load」と判断しない。MemorySSA / alias proof を使う。
- DCE が「返り値が未使用だから call は消せる」と判断しない。FunctionSummary / call effects を使う。
- Aggregate recovery が hard type conflict を無視して `struct` に決め打ちしない。
- Structurer が unresolved exception edge を落として綺麗な `if/while` を作らない。

Phase 7 の結果が `partial` / `unknown` なら、Phase 8 もその不確実性を保持したまま出力を組み立てます。

---

## 3. 基本の考え方 — 1つの semantic truth を読みやすく投影する

Phase 8 の安全な流れは次です。

```text
Low-Level Effects
    ↓
Semantic IR
    ↓
CFG
    ↓
SSA + MemorySSA
    ↓
Alias / Range / Summary / Type Constraints
    ↓
Decompiler optimization passes
    ↓
Variable / Type recovery
    ↓
Control-flow structuring
    ↓
Language / Runtime refinement
    ↓
Structured AST
    ↓
Pretty printer
```

この流れから3つの強いルールが出ます。

### 3.1 Decompiler は命令を再 decode しない

`js/decompiler/pipeline-core.js` は migration guardrail で Semantic Analysis の consumer として保護されています。

Phase 8 でも generic decompiler pass が mnemonic / operand text / decoder backend を直接読み始めてはいけません。

### 3.2 「Cっぽく見える」は proof ではない

rewrite が正しい理由は、Semantic IR / SSA / MemorySSA / Alias / Effects 上の precondition が成立するからです。

出力が綺麗だから正しい、は逆です。

### 3.3 嘘の structured code より正しい goto

Irreducible CFG や exception edge を安全に構造化できない場合は、`goto` を残す方が正しいです。

Phase 8 の KPI を「goto をゼロにする」にしてはいけません。

---

## 4. 推奨 checkpoint 構成

Phase 8 は最初から living integration + verifier を作り、後からまとめて統合しない方が効率的です。

### P8-0 — Foundation / Baseline / Verifier

最初に作るもの:

1. living Phase 8 integration branch / PR
2. machine-readable ownership manifest
3. 全 component test subtree を発見できる canonical Phase 8 runner
4. permanent exact-SHA verifier invocation path
5. mandatory corpus の baseline quality/evidence artifact
6. provenance を保持する pass contract
7. **semantic change が何もない no-op vertical pass** を production pipeline に通す

No-op pass は重要です。

これで SCCP 等を入れる前に、以下を先に証明できます。

- pipeline wiring
- ArtifactStore identity / invalidation
- pass diagnostics
- cancellation
- provenance accounting
- exact-SHA verifier
- integration flow

この vertical skeleton が green になる前に component fanout しない方が安全です。

### P8-1 — Shared Optimizer Substrate

後続 pass が共通利用する仕組みを作ります。

- pass input/output contract
- pass ordering
- dependency declaration
- deterministic fixed-point
- change detection
- iteration budget
- fail-closed behavior
- transform record
- stats / diagnostics
- invalidation rules

SCCP / GVN / DCE がそれぞれ独自の pass framework を持つ状態は避けます。

### P8-2 — SCCP + Richer Range / Value Set

先に SCCP を入れます。

理由は、定数・dead edge・phi・branch が整理されると後続 pass の入力が大幅に良くなるからです。

その後、bit-width aware な range / value-set を強化します。

### P8-3 — GVN/CSE + Effect-aware DCE

SCCP / Range と Phase 7 の alias/effect facts が揃ってから入れます。

難しいのは value numbering の実装そのものではなく、

- 何が同値か
- memory が変わっていないか
- call が何を壊すか
- operation を消して副作用が消えないか

を証明する部分です。

### P8-4 — Loop Induction

既存 CFG / loop recovery を使い、別の loop detector を作らず induction summary を追加します。

### P8-5 — Irreducible / Exception Structuring

CFG / induction facts が安定した後で control-flow structuring を強化します。

### P8-6 — Aggregate / Array Recovery

Phase 7 type constraints + provenance + alias + range + induction facts の consumer として作ります。

### P8-7 — Language Pattern Providers

Generic semantics が完成した後に ObjC / Swift / C++ / Rust / Go 等の refinement provider を乗せます。

Language provider を先に入れると generic pipeline の不足を language heuristic で隠しやすいので最後です。

### P8-I — Integration / Cutover

最後は「新しい verifier を作る」のではなく、Phase 中ずっと回してきた exact-SHA verifier を exact candidate product に対して再実行します。

Final verification が初めて本番 integration を見る状態にしないことが重要です。

---

## 5. Pass Contract を最初に固める

Phase 8 は rewrite が多いため、各 pass が AST / IR を好き勝手に mutate すると後で追えなくなります。

論理的には次のような contract を持たせるのが安全です。

```ts
OptimizationPassResult {
  changed: boolean
  output
  transforms: TransformResult[]
  diagnostics
  stats
  completeness
}

TransformResult {
  ruleId
  consumedNodeIds
  producedNodeIds
  preconditions
  proofKind
  originUnion
  evidenceIds
  confidence
}
```

具体的な型名は変わって構いません。

ただし必須なのは以下です。

- 同じ versioned input なら deterministic
- architecture decoder を裏で読まない
- unknown / unsupported を明示
- provenance を落とさない
- semantics に関わる rewrite は precondition を持つ
- fixed-point iteration は bounded
- pass failure で unsafe fallback に落ちない

Formatting-only rewrite でも origin mapping は残します。

---

## 6. SCCP — アルゴリズムより semantic edge case が難しい

SCCP は単純化すると「constant propagation + dead branch removal」ですが、Hex では以下を正しく扱う必要があります。

- executable edge
- SSA phi
- bit width
- signed / unsigned
- wraparound
- unknown value
- call / memory effects
- provenance

### 6.1 値は lattice で持つ

最低限、概念としては次の区別が必要です。

```text
UNREACHABLE / UNDEFINED
CONSTANT(value, width)
OVERDEFINED / UNKNOWN
```

JavaScript の `null` や truthiness で semantic state を兼用しない方が安全です。

### 6.2 Phi は executable predecessor だけを見る

例えば:

```text
live edge       -> 7
impossible edge -> 9
phi             -> ?
```

通常の単純 constant propagation だと `7 vs 9` で unknown にしがちですが、SCCP は edge 2 が non-executable と証明できるなら `7` にできます。

逆に、edge が「たぶん unreachable」に見えるだけで削るのは危険です。

### 6.3 Machine bitvector semantics を使う

Binary analysis では C の整数としてではなく machine width で考えます。

必須:

- truncation
- zext / sext
- modular wraparound
- signed compare
- unsigned compare
- shift / rotate
- exact-width constant

例:

```text
uint8 255 + 1 = 0
```

を数学的整数 `256` と扱って branch を fold すると破綻します。

### 6.4 Memory は SCCP が勝手に安定とみなさない

Pure scalar expression は fold できますが、call/store を跨いだ load の同一性は MemorySSA / effects に任せます。

### 6.5 Positive test より negative test が重要

最低でも以下を毎回入れます。

- width wraparound
- unknown call barrier
- unknown store barrier
- unreachable と unknown predecessor の違い
- signed/unsigned 条件の違い
- partial executable phi
- branch simplification 後の provenance

---

## 7. Richer Range / Value Set — false precision が一番危険

Range は以下の改善に効きます。

- branch simplification
- switch recovery
- array index
- induction
- pointer offset bound
- type/aggregate evidence

しかし、間違った range は後続 pass 全部を壊します。

### 7.1 Wrapped range を前提にする

単なる数学的 `[min,max]` では不十分です。

```text
uint8 x ∈ [250,255]
x + 10
```

実際には modulo 256 で `[4,9]` 側に wrap します。

Domain が正確に表せないなら広げる / unknown にする方が正しいです。

### 7.2 Proven fact と high-level hint を混ぜない

- `x ∈ [0,15]` が dataflow で証明された
- 「この loop は 16要素 array を回していそう」

は同じ certainty ではありません。

Array candidate は上位の evidence として扱います。

### 7.3 Loop では widening / convergence rule が必要

Range propagation が loop で無限に細かく更新されないよう、deterministic widening か bounded convergence が必要です。

Widening で precision を落とした場合は diagnostic に残すべきです。

---

## 8. GVN / CSE — Memory が難所

Pure scalar expression の CSE は比較的簡単です。

### 8.1 Value key は semantic で作る

最低限:

- opcode
- exact width
- canonical operands
- operation-specific semantic flags

を含めます。

Pretty-printed string を hash key にしない方が安全です。

### 8.2 Load は memory version が同じ時だけ再利用候補

概念的に:

```text
load(addr, M12)
load(addr, M12)
```

は alias/effect 条件が成立するなら common にできます。

しかし:

```text
load(addr, M12)
unknown_store(...)
load(addr, M13)
```

は `addr` の式が同じでも同じ値とは限りません。

### 8.3 Unknown call は barrier

Unknown call を pure とみなさないこと。

Known library / imported model / function summary がある場合だけ、その effect summary に従って狭めます。

Decompiler 側に private pure-call whitelist を作らない方が良いです。

### 8.4 Trap / volatile / atomic / ordered operation

見た目が同値でも observable behavior がある operation は CSE 対象にしない、または非常に厳格な proof を要求します。

迷ったら残します。

---

## 9. Effect-aware DCE — 「値が未使用」と「消してよい」は別

DCE は必ず2つを分けて考えます。

1. 結果 value が unused か
2. operation 実行自体が observable か

両方が安全な時だけ削除します。

### 9.1 基本的に削除を止めるもの

例:

- observable store
- volatile memory access
- atomic
- unknown / impure call
- trap/fault
- throw / unwind
- control-flow op
- live flag side effect
- effect summary を持つ intrinsic

### 9.2 Store DCE は MemorySSA が必要

```text
store A = 1
store A = 2
```

だけを見て最初の store を消してはいけません。

間に call/read があり `1` を観測する可能性があるなら dead ではありません。

### 9.3 Conservative bias

Pseudocode に redundant assignment が1個残るのは readability 問題です。

本物の side effect を消すのは semantic defect です。

Phase 8 は後者を絶対に避ける側に倒します。

---

## 10. Loop Induction — loop を書き換える前に summary を作る

目的は、SSA/CFG から以下のような事実を抽出することです。

```text
i = 0
while (i < n) {
    ...
    i += 1
}
```

推奨する論理結果:

```ts
InductionSummary {
  phiValue
  init
  step
  updateKind
  guard
  bound
  signedness
  tripCountRange
  evidenceIds
  completeness
}
```

### 10.1 難しい case

- multiple backedges
- variable step
- wraparound induction
- pointer induction
- early exit
- nested loop
- irreducible SCC
- copy/cast を挟んだ update
- pre/post increment lowering
- phi そのものではなく derived value を guard が使う case

### 10.2 Summary の consumer

一度作った induction fact は以下で共有します。

- array recovery
- range/value-set
- pointer stride
- loop rendering
- simplification

Array recovery が独自に loop induction を再実装しない方が保守しやすいです。

---

## 11. Irreducible / Exception Structuring — Phase 8 最大級の難所

ここは graph theory + exception edges + compiler lowering + readability が全部ぶつかります。

### 11.1 CFG edge kind を落とさない

Normal edge と exception/unwind edge は別の意味を持ちます。

Structurer が扱いづらいから exception edge を消すのは禁止です。

### 11.2 推奨順序

1. dominator / post-dominator
2. natural loop
3. SESE / region candidate
4. if/else + switch
5. break / continue synthesis
6. exception-region constraint
7. irreducible SCC
8. semantics-preserving node split が可能なら限定利用
9. goto fallback

### 11.3 Goto count を primary KPI にしない

`gotoCount` は diagnostic としては有用です。

しかし primary KPI にすると、無理に `if/while` を捏造する圧力になります。

### 11.4 Flattened CFG は別 recognition problem

Control-flow flattening / state-machine lowering は generic structurer が aggressive に当てにいくより、state variable / dispatch relation が十分に証明できた時だけ specialized recognition する方が安全です。

---

## 12. Aggregate / Array Recovery — Ambiguity を保持する

Aggregate recovery は以下の情報を統合します。

- pointer provenance
- alias region
- hard type constraint
- load/store width
- constant offset
- induction / stride
- call prototype
- debug/runtime metadata
- language provider

### 12.1 Candidate で持つ

いきなり1つに決めるより、概念的には次の形が安全です。

```ts
AggregateCandidate {
  kind: "struct" | "array" | "union" | "unknown"
  extent
  fieldsOrElement
  stride
  constraints
  supportingEvidence
  contradictions
  confidence
}
```

### 12.2 特に難しい区別

- struct field vs array element
- array-of-struct vs struct-of-array
- union overlay vs conflicting inference
- padding vs unknown field
- variable index vs unrelated pointer arithmetic
- flexible array member
- embedded object
- object/region boundary を跨ぐ pointer arithmetic

### 12.3 Conflict は conflict のまま

Readable にするために false certainty を作らないこと。

`struct` と `array` の候補が衝突しているなら、曖昧さを UI / analysis result に残します。

---

## 13. Language Pattern Provider — Generic semantics の後ろに置く

ObjC / Swift の既存 intelligence は language metadata の価値を示しています。

Phase 8 では同じ考え方を provider 境界として一般化します。

Provider がしてよいこと:

- idiom recognition
- nominal type candidate
- closure / async state machine pattern
- vtable / witness / dispatch interpretation
- source-like render hint
- explicit precondition 付き semantic rewrite candidate

Provider がしてはいけないこと:

- instruction decode
- architecture semantics の再解釈
- Semantic IR / SSA bypass
- hard type contradiction の強制上書き
- provenance の削除
- compiler でよくあるだけの heuristic を `confirmed` にする

Architecture/compiler-specific logic は refinement であり semantic foundation ではありません。

---

## 14. Provenance — 読みやすさと引き換えに失わない

Phase 8 の rewrite chain 後も必ず逆に辿れる必要があります。

```text
High-level AST node
    ↓
Transform / Origin / Evidence
    ↓
Semantic IR / SSA / MemorySSA
    ↓
Instruction
    ↓
Binary byte range
```

有用な provenance metric:

- emitted AST node の origin coverage
- rewrite-produced node の transform record coverage
- orphan produced node count
- dangling consumed-node reference
- source-range loss count
- repeated run 間の origin determinism

Mandatory corpus では「平均99%」ではなく、原則 **provenance loss = 0** を exit gate にします。

---

## 15. Readability を 1つのスコアで測らない

Master Architecture は readability 改善を要求していますが、単一 score にすると metric gaming しやすいです。

Semantic correctness を hard gate にした quality vector が適しています。

例:

```text
semanticMismatchCount              hard gate: 0
provenanceLossCount                hard gate: 0
unknownSafetyRegressionCount       hard gate: 0
ghidraDifferentialRegressionCount  hard gate: 0

rawPhiLeakCount
generatedTemporaryCount
redundantAssignmentCount
redundantExpressionCount
structuredRegionRatio
gotoCount
unresolvedSwitchCount
rawPointerArithmeticCount
recoveredArrayCount
recoveredAggregateFieldCount
ambiguousTypeForcedCount           hard gate: 0
astNodeCount
expressionDepthDistribution
```

全 metric が全 function で単調改善する必要はありません。

例えば false loop を直して正しい goto に戻した場合、`gotoCount` は増えても正しい改善です。

したがって:

- P8-0 で baseline を固定
- corpus 分布を見る
- 難しい case は hand-audited golden case を持つ
- semantic/provenance hard gate を先に満たす
- readability regression に正当な理由がある場合は理由を evidence に残す

という運用が安全です。

---

## 16. Verification Strategy

Phase 8 は既存 verifier を強化して使い、最後に別の validation system を作らない方が良いです。

### 16.1 現在の regression floor

```bash
npm run semantic:test
npm run decompiler:test
npm run compiler-truth
npm run integration:test
npm run migration:test
npm run check
```

`decompiler:test` には既に以下が含まれています。

- semantic decompiler
- CFG decompile
- switch recovery
- rewrite
- pipeline
- compiler-truth
- ObjC / Swift integration
- 各種 decompiler regression

### 16.2 既存 differential / proof asset

- Ghidra decompiler differential
- compiler-truth corpus
- cross-binary accuracy
- `js/decompiler/verify/equivalence.js`
- semantic / migration guardrails
- real binary fixtures

Phase 8 はこれらを置き換えるのではなく拡張します。

### 16.3 Solver-backed proof は Phase 9

Phase 8 の完了条件を新規 SMT engine に依存させないこと。

Phase 9 が solver-backed verification を担当します。

Phase 8 は existing bounded/deterministic equivalence を利用しつつ、後で solver proof を差し込める pass contract にしておくのが良いです。

### 16.4 各 transform は negative test まで1セット

最低限:

1. apply すべき case
2. 似ているが apply してはいけない case
3. unknown / partial case
4. width / signedness edge case
5. memory / call barrier case
6. provenance assertion
7. determinism assertion

を1単位にします。

---

## 17. 推奨 code layout

Master Architecture の target tree に合わせるためだけの mass rename は不要です。

現行 tree を活かし、必要な boundary だけ増やします。

候補:

```text
js/decompiler/
  passes/
    manager.js
    sccp.js
    range-refine.js
    gvn.js
    dce.js
    loop-induction.js

  structuring/
    ... boundary が本当に必要な場合のみ

  types/
    ... aggregate/array recovery helpers

  idioms/
    ... language/compiler providers

  verify/
    equivalence.js
    ... Phase 8 pass/provenance verifier helpers
```

重要なのはファイル名より境界です。

- generic pass は Semantic IR / SSA / MemorySSA consumer
- architecture/compiler-specific logic は generic optimizer 外
- `pipeline-core.js` は semantic consumer boundary のまま
- differential cutover 前に existing public path を消さない
- hidden fallback を作らない

---

## 18. Artifact / Version / Invalidation

Phase 4 で ArtifactStore / scheduler が入っているため、Phase 8 output も artifact dependency を正確に持つ必要があります。

Pass output が invalidate される条件の例:

- Semantic IR schema/version
- architecture semantic version
- ABI semantic version
- CFG / SSA / MemorySSA artifact version
- alias / range / summary / type-analysis version
- pass implementation/version
- pass option
- language-provider version
- runtime/metadata input version

Stale output 対策を毎回「cache 全消し」で済ませない方が良いです。

- under-invalidation = correctness bug
- over-invalidation = performance bug

両方を test します。

---

## 19. iPad / Browser Performance

Decompiler quality pass は CPU / memory を食いやすいです。

### 19.1 Whole-binary optimizer を default にしない

Visible / queried function とその dependency を優先し、demand-driven を維持します。

### 19.2 Fixed-point pass は bounded

- SCCP
- range
- rewrite
- summary refinement

などの iteration は deterministic に terminate させます。

### 19.3 Slow CI を見てすぐ sharding しない

Representative pathological function を profile して、algorithmic hotspot を先に直します。

これは Engineering Process Guardrails の既存 failure lesson と一致します。

### 19.4 最低限の performance metric

- pass time
- iteration count
- visited node count
- value number count
- peak retained analysis size
- cancellation latency
- cache reuse
- selected real function の decompile latency

「少し綺麗になったが iPad で数秒遅くなった」は必ずしも product improvement ではありません。

---

## 20. 主要 Failure Mode

### F1 — Text を最適化してしまう

**症状:** Pseudocode は綺麗だが semantic proof がない。

**防止:** Semantic entity に対して transform し、origin/evidence を保持。

### F2 — Alias barrier を跨いで CSE / load forwarding

**症状:** unknown store/call 前後の load を同じ値にする。

**防止:** Memory version + alias/effect proof 必須。

### F3 — DCE が side effect を消す

**症状:** return value unused だけで call/store を削除。

**防止:** effect summary を hard precondition にする。

### F4 — Range が数学的整数を仮定

**症状:** wraparound branch を誤 fold。

**防止:** width-aware wrapped domain。無理なら unknown。

### F5 — Structurer が難しい edge を消す

**症状:** output は綺麗だが exception / indirect / irreducible edge が消える。

**防止:** edge accounting + goto fallback。

### F6 — Aggregate recovery が型を決め打ち

**症状:** conflict があるのに綺麗な struct に強制。

**防止:** candidate + contradiction model。

### F7 — Language provider が第二の semantic engine 化

**症状:** ObjC/Swift/C++ provider が命令を再解釈。

**防止:** canonical semantic facts の consumer に限定。

### F8 — Rewrite chain で provenance loss

**症状:** 最終 pseudocode から instruction / byte に戻れない。

**防止:** transform/origin accounting を merge-blocking gate にする。

### F9 — Generic pass に ARM64 assumption が混入

**症状:** ARM64 では綺麗だが x86-64/RISC-V で壊れる。

**防止:** cross-architecture tests + migration dependency guard。

### F10 — Final verifier が最後に育つ

**症状:** Integration 終盤で verifier 自体の修正に大量時間がかかる。

**防止:** P8-0 から exact-SHA verifier を shadow run。

---

## 21. Cross-Architecture Rule

Phase 8 の generic middle-end は ARM64 固有の optimizer ではありません。

少なくとも、earlier phase の cutover 状態に応じて representative semantic shape を以下で確認します。

- AArch64 / arm64e
- x86-64
- RISC-V64（Phase 6 cutover 後）

RISC-V は flag register がないため hidden ARM assumption の検出に向いています。

x86-64 は variable-width operations / flag semantics / memory-heavy idiom の検出に向いています。

ARM64 は既存 correctness regression floor として維持します。

Generic pass は architecture-independent Semantic IR facts のみを読み、architecture/compiler idiom は refinement provider に分離します。

---

## 22. Integration / Ownership Strategy

Phase 8 は Phase 3〜5 の失敗を繰り返さないよう、最初から integration-centric に進めます。

### Foundation owner

- ownership manifest
- canonical runner discovery
- pass contract
- exact-SHA verifier
- baseline quality/evidence schema
- living integration wiring

### Component lane

- narrow pass/provider/test scope
- frozen foundation から開始
- living integration を target
- sibling private implementation に依存しない

### Integration owner

- pass ordering
- cross-pass reconciliation
- artifact/version wiring
- shared generated output
- moving-main reconciliation
- rolling proof
- final cutover

Component を1つ統合したら、次の component を入れる前に checkpoint lock をかけます。

1. shared contract / invalidation reconcile
2. generated output sync（該当時）
3. rebuild zero diff
4. rolling vertical gate
5. independent shadow verifier
6. exact SHA/evidence 記録

これが全部通ってから次へ進みます。

---

## 23. Phase 8 Exit Evidence の形

Phase 8 DONE 時に、最低でも以下を exact identity 付きで言える状態が理想です。

### Correctness

- semantic mismatch count = `0`
- provenance loss = `0`
- unknown-store / unknown-call safety regression = `0`
- generic pass architecture boundary violation = `0`
- transform determinism failure = `0`
- stale artifact / invalidation failure = `0`

### Decompiler Quality

- SCCP が compiler-truth / real case で有効
- GVN/CSE は memory/effect proof 条件付きで有効
- DCE は side-effect negative corpus を通過
- richer range/value-set diagnostics が有効
- induction summary が有効
- irreducible/exception structuring が safe goto fallback 付きで改善
- aggregate/array recovery が forced-type regression なしで改善
- language provider が semantic authority を持たず readability を改善

### Differential

- Ghidra differential に unexplained regression なし
- cross-binary accuracy に unexplained regression なし
- compiler-truth green
- P8-0 baseline 比で accepted readability vector が改善

### Product / Performance

- active-function latency が accepted browser/iPad budget 内
- whole-binary eager decompilation を新規必須化していない
- cancellation bounded
- artifact reuse / invalidation correct

### Process

- exact release SHA fixed
- verifier version/evidence schema bound
- candidate merge tree proof 済み
- live main reconciliation 済み
- blocking exact-SHA workflow green
- unexplained red workflow = 0
- capability maturity を evidence 以上に昇格していない

---

## 24. 実装開始時に見る短縮版

```text
1. Proof / ownership / integration contract を先に固定。
2. No-op pass を production pipeline に通して provenance を証明。
3. SCCP。
4. Wrapped range / value set。
5. Scalar GVN / CSE。
6. Memory-aware reuse は MemorySSA / alias / effect proof 後だけ。
7. Effect-aware DCE。
8. Loop induction summary。
9. Irreducible + exception structuring。
10. Shared facts から aggregate / array recovery。
11. Language/compiler refinement provider は最後。
12. Phase 中ずっと使った exact-SHA verifier を final head で再実行。
```

途中で必要な fact が足りなければ、Decompiler に heuristic shortcut を足すのではなく、その fact の owner layer に戻ります。

---

## 25. 最終原則

Phase 8 の成功は「pseudocode が綺麗になった」だけではありません。

```text
better readability
×
better recovered structure/types
×
zero semantic regression
×
complete provenance
×
architecture neutrality
×
acceptable iPad/browser latency
```

このどれかを壊して別の1つを改善しただけなら、Phase 8 の improvement とは扱いません。
