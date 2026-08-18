# Phase 8 Fast Path — 高速・安全な実行ルート

> **目的:** Phase 8 を最短のクリティカルパスで完了させるための operator entrypoint  
> **Scope:** 速度最適化のみ。`HEX_MASTER_ARCHITECTURE.md` / `ENGINEERING_PROCESS_GUARDRAILS.md` / `MIGRATION_GUARDRAILS.md` の安全要件を弱めない。  
> **詳細仕様:** `PHASE8_IMPLEMENTATION_GUIDE*.md`, `PHASE8_EXECUTION_BLUEPRINT*.md`, `PHASE8_CHECKPOINT_CONTRACTS*.md`  
> **重要:** Phase 8 開始時の current truth は P8-0 で live repository から再取得する。この文書の prepared-baseline 情報を current fact とみなさない。

この文書だけを通常作業の入口にします。詳細文書は **該当 checkpoint で必要になった section だけ読む** ものとし、毎回 5,000 行超の planning set 全体を読み直さないでください。

Phase 8 を速くする基本式は次です。

```text
speed
= critical-path shortest
+ safe prework parallelism
+ small inner-loop tests
+ exact evidence only at required boundaries
- duplicate frameworks
- repeated moving-main work
- repeated generated sync in component lanes
- downstream symptom debugging
- unnecessary whole-product reruns
```

安全要件は削りません。削るのは **重複作業** です。

---

## 1. 絶対に省略しない hard gates

以下は速くする対象ではありません。

1. P8-0 preflight が green になる前の parallel component fanout。
2. actual changed-file ownership。
3. candidate merge-tree proof。
4. candidate tree の rolling product gate + independent shadow verification。
5. component merge 後の integration checkpoint lock。
6. generated output が applicable な場合の canonical rebuild + zero diff。
7. exact-head evidence。
8. verifier/corpus/toolchain identity binding。
9. semantic mismatch / provenance loss / false certainty / CFG edge loss の hard-zero gate。
10. moving `main` の integration-owner reconciliation。
11. final exact release candidate verification。
12. target iOS/iPad/WebKit proof が release claim に必要な場合の実機/production-faithful evidence。

これらを省略して短縮した時間は、後で再検証・再PR・再統合としてより大きく返ってきます。

---

## 2. 通常はこの順番だけ見る

```text
P8-0  foundation + current-truth audit + verifier + ownership
  ↓
P8-1  transactional pass substrate
  ↓
P8-2  SCCP + wrapped range/value-set
  ↓             ↘
P8-3  GVN/CSE + DCE    P8-4 induction
  ↓                       ↓
  └──────────────┬────────┘
                 ↓
P8-5 structuring   +   P8-6 aggregate/array/union
                 ↓
P8-7 language/compiler providers
                 ↓
P8-I final integration/cutover
```

実装依存だけを見ると P8-2 以降に並列余地がありますが、**integration merge は normative checkpoint lock に従って1件ずつ受け入れます**。

---

## 3. P8-0 を最速で抜ける方法

P8-0 で設計を増やし続けないこと。

### 最初に freeze するもの

- live `main` exact SHA
- Phase 6/7 completion/blocker state
- ownership manifest
- shared write points
- generated-output relationship
- pass/result version contract
- mandatory corpus identity
- baseline metric schema
- permanent exact-SHA verifier route
- living integration lane
- moving-main owner
- evidence invalidation rules

### readiness matrix の扱い

各 capability は必ず次のどれかへ即分類します。

```text
PROVEN_EXISTING
PARTIAL_EXISTING
PHASE8_IMPLEMENT
UPSTREAM_BLOCKED
INTEGRATION_ONLY
NOT_REQUIRED_FOR_P8_EXIT
```

**UNKNOWN のまま会議・調査を長引かせない。** 不明なら explicit audit task または `UPSTREAM_BLOCKED` にし、owner を決めます。

### P8-0 でやらないこと

- SCCP/GVN/DCE 本体の実装
- decompiler 全面再配置
- folder layout を理想形へ一括移動
- generic optimizer に ABI workaround を先入れ
- final readability tuning
- release-only provider polishing

P8-0 は **後続が迷わず並列化できる contract を作ったら終了**です。

---

## 4. P8-1 がクリティカルパスの最重要点

P8-1 を雑にすると、全 optimizer が別々に cancellation/invalidation を実装して後で統合作業が爆発します。

ここだけは先に一度きっちり作ります。

Minimum contract:

```text
PassDescriptor:
  id/version/stage
  consumes
  preserves
  invalidates
  budget class

PassResult:
  unchanged/changed/degraded/unsupported
  staged output
  transforms
  diagnostics
  completeness
  preserved analyses
  invalidated analyses
```

P8-1 exit で以下だけ証明すればよいです。

- abort before start → input authority unchanged
- abort mid-pass → half result unpublished
- deterministic replay
- targeted invalidation
- under-invalidation blocked
- over-invalidation measured
- existing decompiler compatibility retained

**この contract が green になったら、それ以上 framework を磨かず algorithm lanes へ進む。**

---

## 5. 安全に先行並列化してよい作業

P8-0 green 後、production integration dependency がまだ無くても以下は先行できます。

### P8-2 SCCP/range と並行可能

- P8-3 の adversarial CSE/DCE corpus 準備
- unknown call/store/volatile/atomic/mayThrow test matrix
- P8-5 irreducible/exception CFG fixtures
- P8-6 aggregate ambiguity/union/padding fixtures
- P8-7 provider inventory / existing idiom classification
- benchmark/pathological-function fixture selection

### P8-2 accepted 後

- P8-3 production implementation
- P8-4 production implementation

は shared pipeline wiring を integration owner に集中させれば並行可能です。

### P8-4 facts が安定後

- P8-5 loop-aware structuring integration
- P8-6 induction/stride-aware aggregate recovery

を並行できます。

### 禁止

- sibling lane の private implementation を直接 import
- production pipeline shared write point を複数 lane が同時編集
- dependency 未確定の API を各 lane が勝手に作る
- integration head を component worker が直接整理

**並列化するのは leaf implementation/test。shared contract と integration は1 owner。**

---

## 6. 3段階の検証で無駄な再実行を防ぐ

### Tier A — Inner loop

目的: 実装ミスを数秒〜短時間で落とす。

各 edit では原則:

- owned unit tests
- adversarial/near-miss tests
- deterministic test
- provenance assertion
- relevant budget/cancellation case
- affected lint/static checks

だけを先に回します。

全 Ghidra / 全 compiler corpus / full release verification を edit ごとに回す必要はありません。

### Tier B — Candidate merge tree

component を integration へ入れる直前。

Normative guardrail に従い:

- live main / integration / component exact head refetch
- candidate changed-file union
- ownership/governance
- rolling product gates
- independent shadow verification
- applicable semantic/decompiler/cross-architecture evidence

を **candidate tree 自体** に対して実行します。

ここは省略しません。

### Tier C — Accepted integration checkpoint

merge 後の exact integration head で:

- cross-lane reconcile
- version/invalidation update
- applicable canonical generated sync
- rebuild zero diff
- rolling vertical gate
- independent verifier
- checkpoint evidence

を行います。

**Tier C が green になるまで次 component を merge しない。**

### 原則

Tier A で重い full-product proof を乱発しない。
Tier B/C の exact evidence を Tier A の古い green で代用しない。

---

## 7. Failure 時は最初の divergence だけ直す

失敗したら downstream red を全部追わない。

順番:

```text
1. exact failing head を固定
2. 最初に deterministic に壊れた gate/test を特定
3. owner analysis/pass を特定
4. 最小反例を作る/既存 fixture を縮小
5. owner layer を修正
6. regression を追加
7. affected evidence だけ再実行
8. candidate/checkpoint boundary で required full proof
```

典型例:

- Ghidra output が悪い → まず semantic/CFG divergence が前に無いか確認
- aggregate が変 → range/induction/type contradiction を先に確認
- DCE で壊れた → effect proof / MemorySSA invalidation を先に確認
- structuring が変 → lost edge / dominance / exception edge を先に確認

**pretty-printer で症状を隠す修正は禁止。**

---

## 8. Algorithm lane ごとの最小 success condition

### P8-2 SCCP/range

- executable-edge correct
- exact-width wrap correct
- unknown remains unknown
- provenance retained
- bounded convergence

これ以上の fancy domain は exit metric が必要と示すまで作らない。

### P8-3 GVN/CSE/DCE

- scalar equivalence exact
- memory reuse = MemorySSA/alias/effect proof only
- dead op removal = result dead AND observable effect none
- unknown call/store is barrier

Global superoptimizer は作らない。

### P8-4 induction

- reusable summary 1つ
- exact/partial distinction
- multiple-backedge/wrap/early-exit conservative

consumer ごとの second loop analyzer を作らない。

### P8-5 structuring

- lost CFG edge zero
- exception/irreducible safe
- unsupported は goto

`goto = 0` を目標にしない。

### P8-6 aggregate

- candidate + contradiction model
- array/struct/union ambiguity preserved
- induction/type/alias/provenance reused

source-like type を強制しない。

### P8-7 providers

- provider-off semantics correct
- provider-on readability improves
- generic semantic authority remains below provider

provider を second decoder にしない。

---

## 9. 性能最適化の順番

遅い時に最初から CI を分割しない。

```text
1. pathological production function を profile
2. algorithmic complexity / repeated traversal / allocation を確認
3. demand-driven scope を縮める
4. cache/invalidation reuse を確認
5. local worker parallelism
6. それでも必要なら CI topology を変更
```

見る metric:

- per-pass time
- visited nodes/edges
- iteration count
- allocation/retained state
- cancellation latency
- warm reuse
- active-function latency
- browser/iPad responsiveness

Whole-binary eager optimization は default にしません。

---

## 10. Moving main を全 lane に払わせない

component lane は frozen foundation base を基本に維持します。

`main` が動くたびに全 component を rebase しない。

Reconciliation は:

- component acceptance 直前
- final cutover 直前

を中心に **integration owner 1つ** が行います。

Shared contract が本当に変わった場合だけ affected component へ explicit rebase/revalidation を要求します。

---

## 11. Generated output を component の仕事にしない

Applicable な場合:

- component: source + tests
- component CI: ephemeral canonical build/test
- integration: committed generated output owner
- checkpoint: canonical regenerate + zero diff

generated file を component ごとに commit/rebase/hand-merge すると速度も安全性も悪化します。

---

## 12. 作業開始時の operator checklist

毎回読むのはこれだけでよいです。

### 新 checkpoint 開始

- [ ] current allowed predecessor checkpoint は green か
- [ ] exact base/integration SHA は分かるか
- [ ] owned paths は machine-readable か
- [ ] required input artifact/version は固定済みか
- [ ] blocker/unknown は explicit か

### 実装中

- [ ] owner layer を直しているか
- [ ] private workaround を作っていないか
- [ ] Tier A の最小反例があるか
- [ ] provenance/unknown/cancellation を壊していないか
- [ ] shared write point を勝手に触っていないか

### integration 前

- [ ] component exact head refetch
- [ ] candidate tree 作成
- [ ] actual file ownership green
- [ ] Tier B green

### merge 後

- [ ] checkpoint lock
- [ ] generated sync applicableなら完了
- [ ] Tier C green
- [ ] exact evidence 記録
- [ ] 次 component merge unlock

---

## 13. 最短クリティカルパス

Phase 8 を急ぐ場合でも優先順位は次です。

```text
1. P8-0 contract freeze
2. P8-1 transactional substrate
3. P8-2 SCCP/range
4. P8-3 + P8-4 を可能な範囲で並行
5. P8-5 + P8-6 を可能な範囲で並行
6. P8-7 は late
7. P8-I は mature verifier の再実行
```

P8-3/P8-4、P8-5/P8-6 の **開発並行** は可能でも、accepted integration は checkpoint transaction に従います。

---

## 14. 速度のためにやってはいけない短縮

- verifier を最後に作る
- component merge-tree proof を省く
- checkpoint lock を複数 component の batch merge で飛ばす
- unknown を optimistic に扱う
- generated output を hand merge
- full-product failure を downstream patch で隠す
- generic pass に architecture shortcut
- stale green CI を reuse
- old main baseline を current truth 扱い
- 性能問題を job fanout だけで隠す

これは fast path ではなく、後で最も時間を失う path です。

---

## 15. Fast Path の終了条件

この文書の目的は process を増やすことではありません。

P8-0 で exact commands / ownership / corpus / verifier が確定したら、通常の operator は:

```text
FAST_PATH
→ current checkpoint contract
→ owned implementation/tests
→ Tier A
→ candidate Tier B
→ checkpoint Tier C
```

だけを辿ればよい状態にします。

詳細 guide/blueprint は **設計判断が必要になった時だけ** 開きます。

最終原則:

> **安全ゲートは削らない。重複する思考・テスト・rebase・generated sync・downstream debugging を削る。**
