# Phase 8 Fast Path — Opus 5向け高速・安全実行ルート

> **目的:** Phase 8 を最短のクリティカルパスで完了させる operator entrypoint。  
> **対象:** 実装担当（Opus 5を含む）。通常はこの文書から開始する。  
> **絶対制約:** `HEX_MASTER_ARCHITECTURE.md` / `ENGINEERING_PROCESS_GUARDRAILS.md` / `MIGRATION_GUARDRAILS.md`。  
> **受入条件:** `PHASE8_CHECKPOINT_CONTRACTS*.md`。  
> **設計詳細:** `PHASE8_IMPLEMENTATION_GUIDE*.md` / `PHASE8_EXECUTION_BLUEPRINT*.md`。  
> **重要:** Phase 8 開始時の current truth は P8-0 で live repository から再取得する。prepared baseline を current fact とみなさない。

この文書は詳細仕様の代替ではなく、**実装時に毎回読む情報を最小化する入口**です。詳細文書は現在 checkpoint の判断に必要な section だけ参照してください。

```text
fast + safe
= shortest dependency path
+ parallel prework while dependencies run
+ narrow inner-loop tests
+ exact proof at acceptance boundaries
- duplicate frameworks
- unnecessary rebases
- component-owned generated sync
- downstream symptom fixes
- repeated full-product reruns
```

安全ゲートは削りません。削るのは重複作業です。

---

## 1. Opus 5への実装原則

実装担当は次を守ります。

1. 既存実装を最初に監査し、**再実装より再利用**を優先する。
2. Master Architecture / Guardrails を絶対制約として扱う。
3. 現在 checkpoint の DoD を満たす **最小変更**を行う。
4. sibling lane の private workaround や second framework を作らない。
5. dependency が未受入なら production integration を進めず、fixture/test/research/API skeleton の先行作業だけ行う。
6. 最初の deterministic divergence を直す。downstream の見た目で隠さない。
7. checkpoint の minimum success condition を満たしたら止める。不要な superoptimizer / framework rewrite / speculative polishing をしない。
8. unknown / partial / unsupported / degraded を成功に丸めない。

---

## 2. 省略禁止 hard gates

以下は高速化対象ではありません。

- P8-0 preflight green 前の production component fanout
- actual changed-file ownership
- candidate merge-tree proof
- candidate tree の rolling product gate + independent shadow verification
- component merge 後の checkpoint lock
- applicable な generated output の canonical rebuild + zero diff
- exact-head evidence
- verifier/corpus/toolchain identity binding
- semantic mismatch / provenance loss / false certainty / lost CFG edge の hard-zero gate
- moving `main` の integration-owner reconciliation
- final exact release candidate verification
- release claim に必要な target iOS/iPadOS/WebKit proof

古い green、component 単体の green、PR prose は exact product proof の代用になりません。

---

## 3. 正しい dependency DAG

**production acceptance の依存は次です。**

```text
P8-0  Foundation / current-truth / ownership / verifier
  ↓
P8-1  Transactional pass substrate
  ↓
P8-2  SCCP + wrapped range/value-set
  ↓
P8-3  GVN/CSE + effect-aware DCE
  ↓
P8-4  Induction + loop facts
  ├───────────────┐
  ↓               ↓
P8-5 Structuring  P8-6 Aggregate/array/union recovery
  └───────┬───────┘
          ↓
P8-7 Language/compiler providers
          ↓
P8-I Final integration/cutover
```

### 重要な解釈

- **P8-3 と P8-4 は production acceptance 上の完全並列ではない。** P8-4 は P8-2 facts を使い、proved-useful な P8-3 canonical expression を利用できるため、P8-3 acceptance を先に閉じる。
- **P8-5 と P8-6 は P8-4 の accepted induction/loop facts に依存する。** P8-4 前に本番統合しない。
- P8-5 と P8-6 は P8-4 accepted 後に開発を並行できるが、integration acceptance は checkpoint transaction に従って1件ずつ行う。
- P8-7 は generic semantics/recovery が安定してから入れる。

**並列化するのは準備・leaf implementation・tests。production acceptance の依存は守る。**

---

## 4. 依存待ち中に先行してよい作業

待ち時間は fixture / negative test / research / review に使います。

### P8-1〜P8-2進行中

並行して準備してよいもの:

- P8-3 pure scalar CSE / memory version / alias barrier / unknown-call / volatile / atomic / mayThrow corpus
- P8-4 canonical/decrement/non-unit/wrapping/pointer/multiple-backedge/early-exit induction corpus
- P8-5 irreducible SCC / exception edge / multi-exit / necessary-goto fixtures
- P8-6 struct-vs-array / union / padding / flexible-array / contradictory-type fixtures
- P8-7 existing idiom/provider inventory
- pathological-function benchmark fixture

### P8-2 accepted 後

- P8-3 production implementation を開始
- P8-4 は test harness、query contract、non-invasive skeleton を先行可能
- P8-4 production acceptance は P8-3 acceptance 後

### P8-4 accepted 後

- P8-5 と P8-6 の implementation/test は並行可能
- shared pipeline wiring は integration owner に集中
- candidate acceptance/merge/checkpoint は1件ずつ

### 常時禁止

- sibling private implementation import
- shared pipeline write point の複数 lane 同時所有
- dependency 未確定 API の独自確定
- component lane による integration head 整理
- component lane による committed generated output の所有（明示割当がある場合を除く）

---

## 5. P8-0 — 設計を増やさず current truth を freeze

P8-0 で確定するもの:

- live `main` exact SHA
- Phase 6/7 completion/blocker state
- ownership manifest + governance regression
- shared write points
- generated-output relationship/owner
- pass/result version contract
- mandatory corpus identity/provenance
- baseline quality/performance vector
- permanent exact-SHA verifier route
- living integration lane
- moving-main owner
- evidence invalidation rules
- current decompiler/ABI/provider debt

各 readiness row は即座に次へ分類:

```text
PROVEN_EXISTING
PARTIAL_EXISTING
PHASE8_IMPLEMENT
UPSTREAM_BLOCKED
INTEGRATION_ONLY
NOT_REQUIRED_FOR_P8_EXIT
```

不明なものは audit task または `UPSTREAM_BLOCKED` にして owner を持たせます。

P8-0 では SCCP/GVN/DCE 本体、全面 folder rewrite、readability polishing を始めません。

---

## 6. P8-1 — 一度だけ正しい substrate を作る

全後続 pass が共有する minimum contract:

```text
PassDescriptor
  id / version / stage / required
  consumes / preserves / invalidates
  budgetClass

PassResult
  unchanged / changed / degraded / unsupported
  staged output
  transforms / diagnostics / stats
  completeness
  preservedAnalyses / invalidatedAnalyses
```

最低証明:

- abort-before-start → authoritative input unchanged
- abort-mid-pass → half result unpublished
- deterministic replay
- targeted invalidation
- under-invalidation blocked
- over-invalidation measured
- existing decompiler compatibility retained

これが green になったら framework を磨き続けず P8-2 へ進みます。

---

## 7. Algorithm lane の minimum success condition

### P8-2 — SCCP/range

- executable-edge correctness
- exact-width modular wrap
- signed/unsigned distinction
- unknown remains unknown
- bounded convergence/widening
- provenance retained

Fancy domain は exit metric が必要と示すまで追加しない。

### P8-3 — GVN/CSE/DCE

- scalar equivalence exact
- memory reuse は MemorySSA/alias/effect proof のみ
- changed memory version / may-alias store / unknown call は unsafe reuse を block
- dead op removal は result dead **かつ** observable effect none
- volatile/atomic/ordered/mayThrow/mayTrap/state/control effects retained
- provenance union complete

Global superoptimizer や private pure-call whitelist は作らない。

### P8-4 — induction/loop facts

- reusable `InductionSummary` 相当を1つ
- init/step/guard/bound/signedness/exits/evidence/completeness
- exact/partial distinction
- wrap/pointer/early-exit/multiple-backedge conservative
- deterministic bounded convergence

consumer ごとの second loop analyzer を作らない。

### P8-5 — structuring

- `lostCfgEdgeCount = 0`
- reducible/irreducible/exception/multi-exit safety
- necessary goto preserved
- controlled node splitting は effect/provenance safe
- unsupported/unsafe は goto/explicit unknown

`goto = 0` を correctness objective にしない。

### P8-6 — aggregate/array/union

- contradiction-aware candidate model
- struct/array/union ambiguity retained
- field/stride/extent evidence retained
- P8-4 induction、Phase 7 type/alias/provenance を再利用
- `forcedTypeContradictionCount = 0`

highest score を certainty にしない。

### P8-7 — providers

- provider-off でも generic semantics correct
- provider-on で measured readability/recovery improvement
- hard contradiction override 不可
- decode/SSA/MemorySSA bypass 不可
- provider provenance/version/evidence retained

provider を second semantic engine にしない。

---

## 8. 3段階 validation

### Tier A — inner loop

通常 edit ごと:

- owned focused unit/regression
- minimal adversarial/near-miss case
- determinism
- provenance assertion
- relevant cancellation/budget case
- affected static/lint checks

全 corpus / 全 Ghidra / full release verification を毎 edit 回さない。

### Tier B — candidate merge tree

integration へ入れる直前:

1. live `main` / integration / component exact heads refetch
2. candidate changed-file union
3. ownership/governance
4. rolling product gates
5. independent shadow verification
6. applicable semantic/decompiler/cross-arch evidence

**component head ではなく candidate tree 自体を証明する。**

### Tier C — accepted checkpoint

component merge 後の exact integration head:

1. cross-lane reconciliation
2. semantic/cache/schema/invalidation version update if required
3. canonical generated-output sync if applicable
4. rebuild zero diff
5. rolling vertical gate
6. independent verifier
7. exact checkpoint evidence

Tier C green 前に次 component を merge しない。

---

## 9. Failure triage

失敗時は downstream red を順番に全部直さない。

```text
exact failing head
→ first deterministic divergence
→ owner analysis/pass
→ minimal counterexample
→ owner-layer fix
→ permanent regression
→ affected evidence rerun
→ boundary Tier B/C proof
```

例:

- bad pseudocode → semantic/CFG/type divergence を先に探す
- bad aggregate → range/induction/type contradiction を先に探す
- DCE regression → effect proof / MemorySSA / invalidation を先に探す
- bad structuring → CFG edge / dominance / exception edge を先に探す

pretty-printer patch で意味の問題を隠さない。

---

## 10. 性能最適化の順番

遅い時:

```text
1. representative pathological production fixture を profile
2. algorithmic complexity / repeated traversal / allocation を確認
3. demand-driven scope を縮める
4. cache/invalidation reuse を確認
5. local worker parallelism
6. 必要なら最後に CI topology
```

優先 metric:

- per-pass time
- visited nodes/edges
- iteration count
- allocation/retained state
- cancellation latency
- warm reuse
- active-function latency
- browser/iPad responsiveness

CI job fanout で production complexity を隠さない。

---

## 11. Moving main / generated output

### Moving main

component は frozen foundation を基本に維持する。

`main` reconciliation は integration owner 1つが主に:

- component acceptance 直前
- final cutover 直前

に行う。shared contract が本当に変わった時だけ affected component を revalidate する。

### Generated output

applicable な場合:

```text
component       source + tests
component CI    ephemeral canonical build/test
integration     committed generated output owner
checkpoint      regenerate + zero diff
```

生成物を component ごとに commit/rebase/hand-merge しない。

---

## 12. Operator checklist

### checkpoint 開始

- [ ] predecessor checkpoint accepted/green
- [ ] exact base/integration SHA known
- [ ] owned paths machine-readable
- [ ] required input artifact/version known
- [ ] blockers/unknown explicit

### 実装中

- [ ] owner layer を直している
- [ ] second framework/private workaround を作っていない
- [ ] minimal counterexample がある
- [ ] provenance/unknown/cancellation を保持
- [ ] shared write point ownership を守る

### integration 前

- [ ] exact component head refetched
- [ ] candidate merge tree built
- [ ] actual file ownership green
- [ ] Tier B green

### merge 後

- [ ] checkpoint lock active
- [ ] generated sync complete if applicable
- [ ] Tier C green
- [ ] exact evidence recorded
- [ ] next merge unlocked

---

## 13. Opus 5向け停止条件

次の状態になったら、その checkpoint で追加設計を続けず handoff/acceptance へ進みます。

```text
required behavior implemented
+ minimal positive/negative corpus green
+ semantic/provenance/unknown-safety invariants green
+ performance within checkpoint budget
+ no unresolved merge blocker
```

次を理由に作業を膨らませない:

- 「もっと一般化できる」
- 「将来 Phase 9 で使えそう」
- 「framework を綺麗にしたい」
- 「goto をもっと減らせる」
- 「range domain をもっと精密にできる」
- 「provider をもっと賢くできる」

必要性は exit metric / failing corpus / accepted requirement で証明します。

---

## 14. 最終ルート

通常の実行はこれだけ辿ります。

```text
FAST_PATH
  ↓
current checkpoint contract
  ↓
owned implementation + prepared fixtures
  ↓
Tier A
  ↓
candidate Tier B
  ↓
merge + checkpoint Tier C
  ↓
next dependency-ready checkpoint
```

P8-I では mature verifier を新規設計せず、rolling checkpoints で使ってきた verifier を exact final candidate に再実行します。

最終原則:

> **安全ゲートは削らない。依存待ち・重複思考・重複テスト・重複rebase・component generated sync・downstream debugging を削る。**