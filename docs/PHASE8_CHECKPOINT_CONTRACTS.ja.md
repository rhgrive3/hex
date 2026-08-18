# Phase 8 Checkpoint Contracts — 日本語版

> **Status:** 実装前 merge/exit contract  
> **Scope:** Master Architecture Phase 8  
> **Prepared baseline:** `main` = `e90c5107f9c77d73687ee452d5042dcbe9e79ece`  
> **Operational companion:** `PHASE8_IMPLEMENTATION_GUIDE.ja.md` / `PHASE8_EXECUTION_BLUEPRINT.ja.md`

この文書は Phase 8 の各 lane について、次の1点を明確にします。

> **「何が成立すれば、この checkpoint を受け入れて次の dependent work に進んでよいか」**

Component branch の test が green というだけでは完了ではありません。Candidate merge-tree proof と living integration checkpoint まで含めて completion です。

P8-0 では、当時の live repository から path ownership / corpus identity / exact command を再生成してください。この文書の path/command は計画であり、Phase 8 infrastructure が既に存在するという主張ではありません。

---

## 1. Global Start Blocker

Phase 8 component fanout 前に、少なくとも以下を解決または explicit classification します。

1. live `main` exact SHA を再取得して記録。
2. Master Architecture が Phase 8 前提とする Phase 6 RISC-V cutover evidence が完了、または不足を blocking として明示。
3. Phase 8 が使う Phase 7 alias/interproc/type/function-discovery の exit evidence が完了。
4. actual current decompiler pipeline と architecture-specific debt を再監査。Prepared baseline を current truth 扱いしない。
5. living Phase 8 integration branch/PR が存在。
6. machine-readable ownership + expected lane inventory に対する governance regression が存在。
7. canonical Phase 8 runner が全 owned test subtree を発見。
8. permanent exact-SHA Phase 8 verifier invocation が存在。
9. mandatory corpus identity/provenance と P8-0 baseline metrics が freeze。
10. touched decompiler source と generated output の関係が判明。
11. moving-main reconciliation owner は integration lane 1つ。
12. evidence invalidation rule が first component evidence より先に定義済み。

前提 fact が無いなら `BLOCKING` / `UPSTREAM_BLOCKED` にします。Decompiler heuristic で埋めません。

---

# P8-0 — Foundation / Baseline / Verifier

## Inputs

- current `main` exact SHA
- Phase 6/7 completion evidence
- current `HEX_MASTER_ARCHITECTURE.md`
- current engineering/migration guardrails
- current decompiler source/test/workflow inventory

## Deliverables

- living integration branch/PR
- Phase 8 ownership manifest + validator + governance regression
- `tests/phase8/run.mjs` 相当の canonical runner
- 各 owned test subtree の sentinel discovery test
- permanent exact-SHA verifier path
- release-evidence schema
- corpus manifest + provenance/toolchain requirements
- frozen baseline quality vector / performance metrics
- Master Architecture §18.2 全項目を含む readiness matrix
- real production path を通る no-op/identity vertical pass
- pass/result versioning skeleton
- generated-output ownership decision
- living checkpoint record

## Required proof

- no-op path が baseline corpus で pre-Phase-8 path と semantic/output/provenance equivalent
- canonical runner が全 lane test subtree を発見
- ownership negative test が cross-lane path を reject
- exact-SHA verifier が explicit product SHA に対して実行可能
- baseline evidence が product SHA / verifier / corpus / toolchain / completeness を記録
- applicable な Ghidra/compiler-truth/cross-binary/decompiler/semantic floor が green
- production quality capability をまだ過大 claim しない

## Merge blockers

- readiness row 欠落
- required corpus/toolchain が黙って optional 化
- exact-SHA/manual verifier route 不在
- canonical runner が owned subtree を見落とす
- ownership contradiction
- no-op path が semantic/provenance を予期せず変える
- architecture-specific debt が未記録

## Handoff

P8-1 に frozen pass contract / ownership / corpus / baseline / verifier schema / integration mechanics を渡します。

---

# P8-1 — Pass Transaction / Preservation / Invalidation Substrate

## Inputs

- P8-0 frozen contracts
- current `PassManager` / rewrite engine
- earlier-phase ArtifactStore/scheduler/versioning contracts

## Deliverables

- versioned pass descriptor/result contract
- staged/atomic publication semantics
- cancellation/deadline 時に partial authoritative state を残さない behavior
- analysis `consumes / preserves / invalidates`
- Phase 8 に十分な dependency/stage ordering
- deterministic replay/change detection
- completeness/degraded propagation
- new pass artifact invalidation keying
- per-pass diagnostics/performance metrics

## Required proof

- abort-before-start で authoritative input unchanged
- abort-mid-pass で half result publish なし
- publication boundary failure が deterministic/residue-free
- same input/version → same output + same transform metadata
- targeted mutation → expected dependent analysis のみ invalidate
- under-invalidation regression
- over-invalidation regression
- semantic optimizer 有効化前の existing decompiler compatibility 維持

## Merge blockers

- decompiler prettiness のため canonical Semantic IR/SSA/MemorySSA を in-place mutate
- cancellation で partial transformed state が visible
- invalidation rule が暗黙
- broad cache clear が唯一の invalidation
- stage dependency が偶然の array order だけ

## Handoff

P8-2/P8-5 は同じ safe substrate を使います。後続 optimizer が独自 publication/invalidation framework を作るのは禁止です。

---

# P8-2 — SCCP + Wrapped Range / Value Set

## Inputs

- P8-1 substrate
- generic CFG/SSA
- exact-width semantic operations
- explicitly consumed Phase 7 facts

## Deliverables

- executable-edge-aware SCCP
- exact-width constant evaluation
- wrapped range/value-set + bounded convergence
- widening/precision-loss diagnostics
- branch/phi transform record
- downstream reusable query surface

## Required proof

- executable vs non-executable phi predecessor
- truncation/extension
- modular wraparound
- signed vs unsigned compare
- unknown/unsupported operation
- unresolved branch
- memory fact を使う場合 unknown store/call barrier
- loop widening termination
- branch/phi simplification 後 provenance
- deterministic + budget/cancellation
- 当時 available な AArch64/x86-64/RISC-V64 representative semantic shape

## Merge blockers

- mathematical integer を fixed-width truth にする
- unreachable edge を guess
- generic SCCP/range に architecture register/flag name
- represented proof を超えた range certainty
- widened/partial と complete を consumer が区別不能

## Handoff

P8-3 に scalar facts、P8-4 に range/bound facts。Integration は accepted artifact version を exact 記録します。

---

# P8-3 — GVN/CSE + Effect-Aware DCE

## Inputs

- P8-1 substrate
- P8-2 scalar/range facts where relevant
- MemorySSA/alias proof API
- function/imported call summary/effect model

## Deliverables

- scalar GVN/CSE
- exact memory/effect proof 条件付き memory reuse
- effect-aware DCE
- decoder re-entry なしの pointer/address canonicalization
- proof 不足時の missed-optimization diagnostics

## Required proof

- pure scalar CSE positive
- syntactically same / semantically different negative
- changed MemorySSA version blocks load reuse
- unknown/may-alias store blocks reuse
- unknown call blocks unsafe reuse/deletion
- known narrow effect summary は proven-safe 範囲のみ許可
- volatile/atomic/ordered retained
- mayThrow/mayTrap/control/state effect retained
- dead store は MemorySSA/observation proof 時のみ削除
- provenance union complete
- deterministic/budget/cancellation
- mandatory corpus semantic mismatch = 0

## Merge blockers

- pretty text を value key
- private pure-call whitelist
- dead-result => dead-operation
- memory CSE が memory version/effect identity を無視
- observable side effect を proof 無しで削除

## Handoff

P8-4/P8-6 は evidence-preserving simplified facts を使います。Quality gain と semantic safety は分けて記録します。

---

# P8-4 — Loop Induction / Loop Simplification Facts

## Inputs

- generic CFG/SSA
- P8-2 range/value set
- proved-useful な P8-3 canonical expression
- existing loop-repair behavior as compatibility oracle

## Deliverables

- versioned `InductionSummary` 相当 artifact
- init/step/guard/bound/signedness/trip-range/exits/evidence/completeness
- pointer/wrapping/multi-backedge/early-exit の conservative handling
- structuring/aggregate が共有する loop facts
- safe loop simplification candidates + transform proof

## Required proof

- canonical integer induction
- decrement loop
- non-unit step
- wrapping boundary
- variable/unknown step remains partial
- pointer induction
- early exit
- nested loop
- cast/copy hidden update
- multiple backedges
- irreducible SCC は false natural-loop classification を拒否
- deterministic bounded convergence
- provenance + exact exit-edge preservation

## Merge blockers

- rendering text から loop fact inference
- irreducible SCC を natural loop に強制
- partial range から exact trip count claim
- array recovery が second induction analyzer を持つ

## Handoff

P8-5 に structuring 用 loop facts。P8-6 に stride/index/bound facts。

---

# P8-5 — Irreducible / Exception-Aware Structuring

## Inputs

- authoritative CFG edge kinds
- dominance/post-dominance/SESE
- integrated P8-4 loop summary
- existing switch/loop structuring compatibility oracle
- available exception/unwind facts

## Deliverables

- ordinary reducible region improvements
- safe break/continue/switch recovery
- exception-edge constraints
- irreducible SCC handling
- proved controlled node splitting
- explicit goto/unknown fallback
- edge-accounting verifier

## Required proof

- every relevant original CFG edge が structured construct / residual goto / explicit unknown のどれかに対応
- `lostCfgEdgeCount = 0`
- if/else / switch / nested loop / multi-exit / exception / irreducible cases
- false-structuring negative cases
- necessary goto preserved
- node splitting origin/evidence preserved
- representative cross-architecture CFG shapes
- unexplained Ghidra structural regression = 0

## Merge blockers

- goto reduction を correctness objective にする
- exception/unknown/indirect edge が消える
- node splitting で observable effect duplication/loss
- generic structurer が evidence 無しで state-machine semantics を guess

## Handoff

P8-6/P8-7 に stable high-level region。Final integration に edge-accounting evidence。

---

# P8-6 — Aggregate / Array / Union Recovery

## Inputs

- Phase 7 type/provenance/alias facts
- P8-2 ranges
- P8-4 induction/stride
- authoritative debug/runtime/prototype evidence
- existing layout recovery baseline

## Deliverables

- contradiction-aware candidate model
- struct/array/union/object/unknown candidates
- field/element/stride/extent evidence
- hard/soft evidence separation
- ambiguity/conflict preservation
- existing type/high-variable/prototype system と統合し second type engine を作らない

## Required proof

- fixed non-overlap field
- indexed array
- struct vs array ambiguity
- union/overlap
- padding
- flexible array member
- array-of-struct vs struct-of-array
- embedded object
- object/region boundary crossing pointer
- contradictory debug/runtime/type evidence remains contradiction
- `forcedTypeContradictionCount = 0`
- false-certainty 増加無しで type/aggregate accuracy improve
- every field/element candidate provenance

## Merge blockers

- highest score = certainty
- hard contradiction を source-like type で上書き
- private pointer/alias/type truth
- architecture instruction text dependency

## Handoff

P8-7 provider は nominal/source-language refinement のみ。Generic candidate facts が下層 authority のままです。

---

# P8-7 — Language / Compiler Pattern Providers

## Inputs

- stable generic optimizer/recovery/structuring contract
- existing ObjC/Swift/architecture/compiler idioms
- runtime/debug/knowledge evidence

## Deliverables

- versioned provider interface
- appropriate existing target/compiler idiom の migration/isolation
- nominal type / idiom / dispatch / state-machine / rendering / proved rewrite candidates
- provider provenance/version/evidence
- generic/hard evidence との conflict rule

## Required proof

- provider-off でも generic semantics correct
- provider-on で accepted readability/recovery case improve
- provider は decode/SSA/MemorySSA bypass しない
- hard contradiction override 不可
- common pattern frequency だけで confirmed 不可
- provider version change が relevant artifact のみ invalidate
- architecture/compiler-specific code が generic pass 外

## Merge blockers

- provider が second semantic engine
- basic instruction meaning に provider 必須
- uncertainty/provenance erase
- generic pass が provider-specific target constant import

## Handoff

P8-I に provider-off/on 両方の evidence を渡します。

---

# P8-I — Living Integration / Final Cutover

## Inputs

- accepted component exact heads + checkpoint evidence
- latest live `main`
- frozen final verifier/corpus/toolchain contract
- generated-output policy/identity

## Deliverables

- reconciled exact release candidate
- canonical generated output if applicable
- rebuild zero diff
- final release-evidence artifact
- final quality vector vs P8-0 baseline
- evidence 範囲内の capability/support maturity update
- merged product + post-merge verification

## Required proof

Hard zero gate:

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

さらに:

- unexplained Ghidra differential regression = 0
- unexplained cross-binary accuracy regression = 0
- compiler-truth + required semantic/decompiler/migration gate green
- accepted readability/recovery vector が P8-0 baseline より measurable improvement
- active-function/browser/iPad cost within accepted release budget
- required corpus/toolchain family が present、欠ければ release block
- candidate SHA / verifier / corpus / toolchain / generated identity / evidence schema を bind
- expected-head protection merge
- post-merge `main` refetch + exact product presence proof
- completion claim が runtime/deployment に依存する場合 active identity を別証明

## Merge blockers

Hard gate nonzero、required evidence family 欠落、stale generated output、stale main reconciliation、verifier semantics change 後未再検証、unexplained red blocking workflow のいずれか。

---

## 2. Rolling Validation Policy

Component merge 後、次の dependent merge は以下が完了するまで block です。

```text
shared contract reconcile
-> version/invalidation update
-> canonical generated build if applicable
-> generated output commit by owner
-> rebuild zero diff
-> rolling vertical gate
-> independent verifier
-> exact checkpoint evidence
-> unlock next dependent merge
```

Green component branch だけでは evidence 不足です。

---

## 3. Process Failure 再発防止対応表

| 過去 failure class | Phase 8 prevention |
|---|---|
| Late integration concentration | P8-0 living integration + no-op vertical path |
| Cross-scope contamination | machine-readable ownership + actual changed-file validation |
| Generated output misownership | component ephemeral / integration canonical sync |
| Ownership contradiction | real/expected inventory governance regression |
| Canonical runner が nested test を見落とす | every allowed subtree sentinel discovery |
| Verifier wiring late | P8-0 permanent exact-SHA route |
| Checkpoint sync skip | every component merge 後 checkpoint lock |
| Moving-main churn | one living integration owner |
| Final verifier late maturity | first vertical checkpoint から shadow verifier |
| Validation-only PR chain | permanent exact-SHA/manual verifier |
| CI fanout で slow algorithm を隠す | sharding 前 production pathological profiling |
| Partial/invalid evidence publish | schema/content validate + fail closed |
| Release identity drift | exact deployable content と generated/release identity bind |
| Browser/iPad assumption deferred | cost/cancellation を phase 全体で測定 |

P8-0 時点で `ENGINEERING_PROCESS_GUARDRAILS.md` に新しい failure class が増えていれば、この表も拡張します。

---

## 4. First Divergence Rule

Rolling gate failure時:

1. exact failing candidate identity freeze
2. visible pseudocode symptom ではなく first deterministic divergence を特定
3. owner classification: semantic input / CFG-SSA-MSSA / alias-effect / Phase 8 pass / structuring / provider / artifact invalidation / verifier / generated output / infra
4. real corpus gate を弱めず smallest valid reproduction
5. owning layer 修正
6. old behavior で fail する regression を追加可能なら追加
7. repair により invalidated された evidence を全 rerun

Phase 8 lane を green にするため semantic/migration/ownership/corpus/verifier gate を弱めません。

---

## 5. Operator Short Form

```text
P8-0: truth / ownership / corpus / verifier / baseline を freeze。
P8-1: pass execution を transactional、invalidation を explicit。
P8-2: exact bitvector semantics で constants/ranges を proof。
P8-3: alias/effect proof 付きで expression/memory optimize。
P8-4: reusable induction facts。
P8-5: 全 edge を正直に structure。goto 可。
P8-6: ambiguity を保持して aggregate recovery。
P8-7: semantic authority を持たない language/compiler refinement。
P8-I: phase 中ずっと使った verifier で exact combined product を proof。
```
