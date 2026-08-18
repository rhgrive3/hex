# Engineering Process Guardrails

Status: **normative**

Audit baseline: `main` at `320b1f97f2ddd20435946724573e298a185bb7e4` (2026-08-18, after Phase 5 production cutover).

This document records the confirmed engineering-process failure classes found in the repository history reviewed through the audit baseline. It is not a changelog of every product bug. A product bug is included when it exposed a repeatable process failure.

The purpose is simple: a failure that has happened once must become harder to repeat. A failure that has happened twice must become a machine-enforced gate, not a reminder.

Normative words in this document use their usual meaning:

- **MUST / MUST NOT**: merge-blocking requirement.
- **SHOULD / SHOULD NOT**: required unless the deviation is explicitly justified in release evidence.
- **MAY**: optional.

If this document conflicts with an ad-hoc phase prompt, temporary workflow, branch convention, or historical PR description, this document wins unless a later reviewed change explicitly updates this contract.

---

## 1. Non-negotiable principles

1. **One semantic truth, many projections.** No phase may create a second semantic engine, scheduler, cache identity, release identity, or hidden fallback to get a gate green.
2. **Unknown stays explicit.** Missing integration or missing evidence is `BLOCKING`, `NOT-INTEGRATED`, `partial`, `unknown`, or another explicit conservative state. It is never skip-green.
3. **The first deterministic divergence is the bug to diagnose.** Do not repair downstream symptoms before the first divergence is known.
4. **A documented invariant that is not mechanically enforced is not an invariant yet.** Repeated process rules MUST be converted into tests, ownership validation, or merge-blocking CI.
5. **Exact-head evidence only.** A green result from an old head, old merge tree, old runtime, old generated artifact, or old verifier does not prove the current product.
6. **Source merge is not runtime activation.** Any capability whose proof depends on deployed/in-memory code MUST prove the active commit/build/version, not only repository state.
7. **Target-platform truth beats desktop assumptions.** iOS/iPadOS and WebKit behavior are first-class product constraints.
8. **Generated output is a transaction boundary.** Ownership, generation, synchronization, release identity, and verification MUST be designed together.
9. **Moving `main` is normal.** Long-running phase work MUST absorb it through one defined reconciliation lane; stale branches are not repaired by endless replacement PR generations.
10. **Done means exact product proof.** Implementation complete, tests complete, integration complete, generated output synchronized, exact-head verification complete, and required cutover complete are separate facts. A phase is done only when all required facts are true.

---

## 2. Historical process-failure registry

### EP-001 — Phase 3 integration was too late and too concentrated

**Evidence:** #661, #669, #679, #680, #682, #683, #685, #690.

Phase 3 component work was followed by substantial late integration, repeated current-main synchronization, repeated final-proof/cutover validation PRs, and a central exit-repair pass. Validation-only PRs were repeatedly used to make ordinary PR-triggered workflows test an exact candidate.

**Process cause:** integration and final-product proof were treated as late activities instead of a continuously exercised product path.

**Permanent rule:** every master phase MUST create its living integration product and permanent exact-SHA verifier at the foundation checkpoint. Every accepted component MUST be integrated and independently shadow-verified before the next dependent checkpoint. Final verification is a re-run of a mature verifier, not the first time the verifier sees the real product.

### EP-002 — Phase 3 allowed cross-scope contamination into an unrelated PR

**Evidence:** #666 records that #663, scoped to ChatGPT Web/userscript work, also merged unrelated still-unvalidated Phase 3 Semantic IR compatibility changes from #665.

**Process cause:** changed-file scope and phase ownership were not sufficiently isolated at the merge boundary.

**Permanent rule:** every nontrivial lane MUST have an actual changed-file inventory checked against an allowlist. Unrelated phase-owned files in a PR are merge-blocking even when tests are green. PR prose is not evidence of scope; the actual diff is.

### EP-003 — Generated userscript synchronization blocked unrelated Phase 3 validation

**Evidence:** #664 and #665 explicitly report `userscript-generated-template-out-of-sync` blocking the wider exact-head validation path.

**Process cause:** generated-output ownership and validation routing were not separated cleanly from component semantics.

**Permanent rule:** component lanes that do not own generated output MUST still build/test it ephemerally, but MUST NOT be required to commit it. The integration/release lane MUST own canonical committed generated output. This distinction MUST be encoded in one machine-readable policy and tested.

### EP-004 — Phase 4 ownership rules contradicted their own lane assignments

**Evidence:** #704 repaired three contradictions: P4-3 owned `js/project/artifact-index.js` while the blanket frozen-contract rule rejected that edit; P4-7 did not own the actual component-union integration surface; and P4-7's blanket contract exemption was too broad.

**Process cause:** ownership rules were designed abstractly and were not validated against real component changed-file inventories before parallel work.

**Permanent rule:** foundation ownership manifests MUST be self-tested against synthetic negative cases **and** the expected/actual union of component inventories. Contract write ownership MUST be explicit per path. Blanket exemptions are forbidden where a narrower owner list is possible.

### EP-005 — Phase 4 canonical test discovery did not include owned nested lane tests

**Evidence:** #701 notes that the frozen `tests/phase4/run.mjs` discovered only top-level tests while P4-1 tests lived under `tests/phase4/store/**`, forcing direct lane execution until integration wiring.

**Process cause:** the canonical phase runner contract was frozen before confirming that every owned lane test path was discoverable.

**Permanent rule:** the foundation exit gate MUST prove that a sentinel test placed in every allowed component test subtree is discovered by the canonical runner. A lane-only direct command is supplemental; it cannot replace canonical discovery.

### EP-006 — Phase 4 independent verification was not fully wired into the release path from the start

**Evidence:** #702 correctly reported `NOT-INTEGRATED / BLOCKING` until P4-7 wired the verifier.

**Process cause:** verifier implementation and verifier release-path wiring were split across phases of the work.

**Permanent rule:** a phase verifier may begin with intentionally missing product coverage, but the permanent exact-SHA invocation path MUST exist at foundation time. Missing product capabilities may be blocking results; missing verifier wiring itself must not be deferred to cutover.

### EP-007 — Shared generated outputs incorrectly triggered old phase ownership

**Evidence:** #717 and post-release #725; #724 was superseded because the ownership workflow required the canonical P4-7 branch name.

**Process cause:** workflow trigger conditions were coupled to shared generated artifacts rather than to actual phase-owned source/governance paths.

**Permanent rule:** shared generated outputs MAY remain validated by a phase workflow when that workflow is already triggered, but shared outputs MUST NOT by themselves force an unrelated post-release change into an old phase lane. Trigger policy and ownership policy are separate contracts and MUST have regression tests.

### EP-008 — Phase 5 generated-output governance contradicted component ownership, then regressed after repair

**Evidence:** #730, #732, #733, #744.

P5 component PRs did not own committed generated userscript files, yet CI required committed loader synchronization. That contradiction was repaired, then the exemption later disappeared and had to be restored with a permanent regression in #744.

**Process cause:** the first governance repair changed behavior without a strong enough regression binding the workflow policy to the ownership manifest.

**Permanent rule:** every governance repair MUST add a permanent regression in the same change. A policy fix without a test that fails on the old behavior is incomplete.

### EP-009 — Phase 5 violated its own post-component integration synchronization invariant

**Evidence:** #728 documented that after every protected-runtime component merge P5-I must canonical-build and commit generated userscript output before accepting the next checkpoint. #742 exists specifically because P5-5 and P5-1 were merged without that intervening synchronization.

**Process cause:** a critical invariant existed only in prose and operator discipline.

**Permanent rule:** after each component merge, the integration branch enters a **checkpoint-locked** state. No next component merge is allowed until all of the following are true on the new integration head:

- required shared-contract/invalidation wiring is complete;
- canonical generated output is rebuilt and committed by the integration owner;
- generated-output diff is zero after rebuild;
- rolling product gates are green;
- independent shadow verification is green;
- checkpoint evidence records the exact integration SHA and verifier version.

This lock MUST be machine-enforced in future phase ownership/release tooling.

### EP-010 — Phase 5 moving-main reconciliation produced repeated manual integration churn

**Evidence:** #749, #756, #758, plus repeated current-main integration work around long-lived branches.

**Process cause:** `main` moved concurrently, but reconciliation was performed as repeated ad-hoc events rather than one stable integration responsibility.

**Permanent rule:** one living integration lane owns moving-main reconciliation. Component lanes remain based on their frozen contract base unless the shared contract explicitly changes. Reconciliation MUST occur before accepting a component merge and before release cutover, not by repeatedly rebasing every component.

### EP-011 — Phase 5's final verifier was still being made release-grade during P5-6

**Evidence:** #760 began as a verification bootstrap and finished after 30 commits. The final lane had to strengthen corpus construction, exact-product evidence, toolchain/provenance recording, and release-verifier behavior before the exact product could be accepted.

**Process cause:** independent verification existed conceptually, but the verifier's own release-quality contract was not frozen and repeatedly proven against rolling integration checkpoints early enough.

**Permanent rule:** the independent verifier MUST run in shadow mode from the first usable vertical integration checkpoint. Its evidence schema and trust rules SHOULD be frozen no later than the first two component integrations. Any later verifier change that changes acceptance semantics, corpus provenance, oracle selection, exact-head binding, or evidence completeness INVALIDATES older release evidence and requires re-verification.

Synthetic fixtures MAY self-test the verifier. They MUST NOT substitute for a release contract that explicitly requires real compiler/real binary/real browser evidence.

### EP-012 — Validation-only and operational probe PRs were used as workflow triggers

**Evidence:** Phase 3 #680/#682/#683/#690 and later temporary operational probes such as #762/#764/#765/#768/#770.

**Process cause:** permanent workflows did not always expose a first-class exact-SHA/manual verification path for the evidence needed.

**Permanent rule:** a mature subsystem MUST provide permanent `workflow_dispatch`/exact-SHA verification where external CI proof is required. Creating a PR solely to trigger validation is a migration fallback, not normal operation. If it happens twice for the same proof class, a permanent trigger MUST be added before the next release.

### EP-013 — Stale-branch repair created replacement-PR chains

**Evidence:** #716 -> #719, #724 -> #725, #774 -> #776, #783 -> #784 -> #785 -> #787.

**Process cause:** repair branches stayed alive while `main` advanced, and reconciliation was performed by creating new PR generations instead of using one authoritative current-main repair lane.

**Permanent rule:** for a narrow current-main repair, keep one authoritative repair branch. Immediately before final verification, reconcile once to current `main`, regenerate owned generated output, and verify the exact head. Superseded branches MUST be closed promptly. Do not create a new PR generation merely because `main` moved unless branch ownership or history makes safe reconciliation impossible.

### EP-014 — CI parallelism was optimized without respecting the account/runner resource model

**Evidence:** #719 expanded cross-binary work to 90 GitHub jobs; #721 replaced that with runner-local parallelism suitable for GitHub Free limits.

**Process cause:** theoretical parallelism was optimized before accounting for real runner-slot limits and per-runner CPU/RAM.

**Permanent rule:** CI optimization MUST measure critical path, queue time, account concurrency, runner CPU/RAM, and setup cost. Prefer local worker parallelism and test deduplication before increasing GitHub-job fanout. Speed work MUST preserve samples, score floors, engines, and fail-closed aggregates.

### EP-015 — Failed CI work could publish invalid artifacts

**Evidence:** #726. A worker shutdown race failed a partition, `tee` had already created a zero-byte result, and `if: always()` uploaded it for the final merger.

**Process cause:** artifact publication was not atomic and the aggregator trusted file presence rather than validated content.

**Permanent rule:** CI artifacts are release evidence. Producers MUST write to temporary paths, validate schema/content/expected IDs, then atomically rename. Failed producers MUST NOT publish. Aggregators MUST validate prerequisites and every downloaded artifact before merge. Empty/partial artifacts are hard failures.

### EP-016 — Performance bottlenecks were attacked at CI topology before profiling the production hot path

**Evidence:** #722 found an O(N^2) Semantic IR validation path responsible for a ~139 s pathological function; the production fix reduced it dramatically, after earlier CI-sharding effort.

**Process cause:** wall-clock symptoms were initially treated primarily as scheduling/fanout problems.

**Permanent rule:** before materially increasing CI fragmentation for a slow analysis workload, profile at least one representative slow production fixture. Performance gates MUST include pathological/large fixtures and complexity guards where practical. Fix algorithmic hot paths before hiding them behind more runners.

### EP-017 — Release identity once failed to move with protected runtime content

**Evidence:** #692.

**Process cause:** userscript release version and runtime content identity were partially manual and could diverge.

**Permanent rule:** release identity MUST be deterministically derived from protected runtime/build inputs and MUST advance monotonically when deployable content changes. A build that changes executable content while leaving the public release identity unchanged is invalid.

### EP-018 — Deployment commit identity could attest a dirty working tree

**Evidence:** #761 added local `git rev-parse HEAD` fallback; #766 hardened it because dirty/staged/untracked source could produce deployed bytes not represented by the advertised commit.

**Process cause:** commit identity was treated as source identity without proving the worktree matched the commit.

**Permanent rule:** exact commit attestation requires a clean applicable source tree, or a CI-provided immutable source identity. If cleanliness cannot be proven, deployment identity MUST fail closed to unknown/null and exact-commit proof MUST be disabled.

### EP-019 — Trust/evidence presentation accepted truthiness instead of exact identity

**Evidence:** #759.

**Process cause:** a proof UI treated any non-empty capability as proof instead of requiring the canonical capability identity.

**Permanent rule:** security/release/proof boundaries MUST compare exact typed identities and versions. Truthy/non-empty/shape-similar values are not authority.

### EP-020 — Privileged bootstrap behavior was activated implicitly

**Evidence:** #753.

**Process cause:** presence of deployment identity was treated as equivalent to explicit Dev bootstrap opt-in.

**Permanent rule:** privileged, diagnostic, migration, bootstrap, and destructive modes require explicit opt-in independent of capability detection or deployment identity. Capability is not consent.

### EP-021 — Browser tests did not initially model the actual iOS opaque-sandbox location model

**Evidence:** #763.

**Process cause:** the test environment used a convenient location model instead of the production `about:srcdoc` / opaque-origin shape and trusted virtual runtime-host location.

**Permanent rule:** security/bootstrap/browser tests MUST model the actual origin, realm, iframe, and navigation semantics of production. Simplified fixtures are allowed only when a production-faithful fixture separately covers the boundary.

### EP-022 — Desktop/browser assumptions produced the wrong Worker architecture for iOS

**Evidence:** #689 initially used a second Worker tab; #691 repaired Round 2 to a single-tab conversation Worker; #772 later introduced a multi-tab pool; #781 replaced it with same-origin iframes because iOS/Safari requires a user gesture for popup/tab creation.

**Process cause:** architecture was allowed to advance before the primary target platform had proven the fundamental browser capability.

**Permanent rule:** any architecture that depends on tabs, windows, background execution, cross-context messaging, storage, JIT, filesystem, or browser embedding MUST prove the primitive on the primary iOS/iPadOS target before the design is promoted beyond a spike. The production Worker model is single-tab, same-origin iframe based unless a future explicitly verified contract replaces it.

### EP-023 — DOM authority used broad selectors and incomplete hydration state

**Evidence:** #706, #708, #709, #711, #723, #731, #735, #736, #767.

Examples include broad `aria-label*="送信"` matching a history-options button, route identity appearing before React hydration, historical turns being virtualized, and global Stop controls being misread as current-conversation generation.

**Process cause:** tests encoded stable desktop DOM snapshots rather than temporal SPA state, realm ownership, scoped control authority, and iPad virtualization.

**Permanent rule:** control-authority selectors MUST prefer stable exact IDs/test IDs and exact accessibility names, scoped to the owning composer/conversation. Broad substring selectors cannot authorize destructive or submission actions. Conversation identity MUST include hydration/continuity evidence where route identity alone is insufficient. Every real-device DOM failure MUST add a production-faithful regression before closure.

### EP-024 — Generic transport timeouts were applied to full model turns

**Evidence:** #718/#720.

**Process cause:** operation classes with different completion semantics shared one generic RPC timeout.

**Permanent rule:** timeout policy MUST be defined by operation class. Short control RPCs remain bounded. Full external model generations are event-driven/cancellable and must not fail merely because they exceed a generic transport timeout. Lack of progress and lack of completion are separate states.

### EP-025 — Async Worker ownership had claim, lease, cancellation, and cleanup races

**Evidence:** #773, #776, #782.

Failures included duplicate lease issuance while a claim was in flight, local RPC close without remote cancellation, and claim cancellation during asynchronous ownership handoff.

**Process cause:** ownership state changed after `await`, and cancellation/transport teardown was not treated as part of the ownership transaction.

**Permanent rule:** async resource acquisition MUST reserve synchronously before awaiting external work. Cancellation MUST propagate end-to-end. Every acquisition path MUST have deterministic release. If cleanup cannot be proven, the resource is quarantined/fail-closed rather than returned to the pool. Duplicate execution and duplicate lease issuance require dedicated concurrent regressions.

### EP-026 — Recoverable Dev tool errors terminated the whole Supervisor run

**Evidence:** #777.

**Process cause:** tool exceptions escaped the decision loop, conflating recoverable tool failure with terminal run failure.

**Permanent rule:** recoverable tool errors return structured, sanitized evidence to the same Supervisor session for replanning. Cancellation, integrity/security failure, and explicit invariant corruption remain terminal. Recovery MUST be bounded.

### EP-027 — Source merge was incorrectly treated as active self-update

**Evidence:** #777 self-update activation gate.

**Process cause:** repository state and currently loaded userscript/runtime identity were conflated.

**Permanent rule:** after a self-update merge, gated capability proof is blocked until reload/reinitialize proves the active commit, build ID, and userscript version match the expected identity.

### EP-028 — Supervisor safety budget counted successful progress as exhaustion

**Evidence:** #780.

**Process cause:** `maxDecisions` was a lifetime counter rather than a no-progress safety window.

**Permanent rule:** safety budgets MUST measure the failure mode they are intended to stop. Successful externally verified progress may extend a progress window; invalid decisions, failed calls, and no-progress loops must remain bounded.

### EP-029 — A wrapper violated JavaScript Proxy invariants on a frozen production bridge

**Evidence:** #787, after #780; intermediate stale repairs #783-#785.

**Process cause:** a progress-budget wrapper substituted a non-configurable/non-writable `request` property through a Proxy `get` trap.

**Permanent rule:** wrappers around frozen/trusted interfaces MUST preserve language/runtime invariants. Prefer a fresh narrow facade that delegates to the original bound method over Proxy substitution. Tests MUST include the real property descriptors of the production interface.

### EP-030 — Long-running autonomous work lacked a durable resume checkpoint

**Evidence:** #779 was added because the Dev Agent campaign stalled and repository state did not record exactly where the campaign had reached.

**Process cause:** progress existed in conversation/runtime state but not in durable repository evidence.

**Permanent rule:** any multi-stage autonomous campaign spanning merges/reloads MUST maintain a durable checkpoint containing completed stages, exact evidence, active runtime identity where relevant, remaining blockers, and the resume procedure. A checkpoint is updated at every externally visible stage transition.

---

## 3. Mandatory workflow for every future master phase

### 3.1 Phase preflight

Before implementation starts, the phase owner MUST:

1. Read this document and the previous phase postmortem/evidence.
2. Write the phase's exit contract in machine-checkable terms where possible.
3. Identify frozen contracts, shared write points, generated artifacts, verifier-owned paths, integration-owned paths, and component-owned paths.
4. Create the living integration branch/PR.
5. Create the permanent exact-SHA verifier invocation path.
6. Create ownership/governance regression tests before parallel components start.
7. Create a real vertical walking skeleton through the production chain.
8. Define the target-device/browser proof needed for release.
9. Define the moving-main reconciliation owner.
10. Define which evidence changes invalidate prior evidence.

No parallel component fanout begins until this preflight is green.

### 3.2 Component lane contract

Every component lane MUST:

- start from the exact frozen foundation unless a reviewed shared-contract change says otherwise;
- change only owned paths;
- target the living integration branch, not `main`;
- avoid importing sibling-lane private implementation;
- keep unsupported/shared-contract gaps explicit as integration handoffs;
- run owned tests plus repository regression gates applicable to its touched surface;
- build generated runtime artifacts ephemerally when needed but not commit them unless it owns them;
- record the exact head SHA, actual changed-file inventory, relevant toolchain identity, test results, and integration handoffs;
- remain unmerged until the integration transaction can accept it.

### 3.3 Candidate merge-tree proof

Before a component is merged into living integration, the integration owner MUST prove the **candidate integration tree**, not only the component head:

1. Refetch live `main`, integration head, and component head.
2. Reconcile living integration with current `main` if required.
3. Reconfirm the component head did not move after review.
4. Compute/inspect the actual candidate changed-file union.
5. Run ownership/governance checks on the candidate tree.
6. Run rolling product gates and independent shadow verification against that candidate tree.

A green component branch with a red candidate merge tree is not mergeable.

### 3.4 Integration checkpoint transaction

After one component merge, integration is locked until all of these complete on one exact head:

1. Cross-lane/shared-contract reconciliation.
2. Semantic/cache/schema/invalidation version update if required.
3. Canonical generated-output build by the integration owner.
4. Commit generated outputs.
5. Rebuild again and require zero generated diff.
6. Run the full rolling vertical gate.
7. Run the independent verifier/shadow differential.
8. Record exact checkpoint evidence.

Only then may the next component merge occur.

### 3.5 Verifier maturity rule

The verifier is a product-quality component of the release process.

- It MUST be exercised continuously, not first assembled at the final lane.
- Self-tests MUST distinguish verifier correctness from product correctness.
- Real release evidence MUST use the real required corpus/oracle/toolchain/browser/device class.
- Required compiler families/targets/optimization levels MUST be enumerated and enforced as sets; one available compiler cannot silently satisfy a multi-family contract.
- Every tool invocation relevant to release evidence SHOULD record command/version/target/status and bounded diagnostics sufficient to audit failure.
- Exact product SHA, verifier version/hash, fixture/corpus identity, and oracle identity MUST be recorded together.
- A verifier acceptance-rule change invalidates prior evidence affected by that rule.

### 3.6 Production cutover

Before declaring a phase complete:

1. Reconcile living integration with the live `main` once more.
2. Freeze the exact release candidate SHA.
3. Canonically rebuild generated output and prove zero diff.
4. Run all blocking exact-SHA workflows.
5. Run full independent verification with zero unexplained blocking divergence.
6. Run required real-binary/compiler/browser/iOS evidence.
7. Confirm capability/maturity promotion is no stronger than the evidence.
8. Merge the canonical integration PR with expected-head protection.
9. Refetch `main` and prove the exact merged product is present.
10. If deployment/runtime activation is part of completion, prove the active deployed/runtime identity separately.

No next master phase starts before these exit conditions are satisfied.

---

## 4. Merge-blocking process gates

Any one of these conditions blocks advancement:

- actual changed files exceed lane ownership;
- ownership manifest contains a contradictory path/contract rule;
- canonical runner does not discover an owned test subtree;
- generated output is stale where the current lane owns committed output;
- a component that does not own generated output is forced to commit it;
- integration checkpoint generated sync is pending;
- living integration is stale relative to a required current-main reconciliation point;
- component head changed after review without re-verification;
- candidate merge tree was not tested;
- required verifier is missing, changed without evidence invalidation, or not run on the exact product;
- required real corpus is replaced by synthetic evidence;
- required compiler/toolchain family is missing;
- required evidence artifact is empty, malformed, partial, or from a failed producer;
- an unexplained red workflow exists on the exact release head;
- runtime/deployment identity does not match the source identity being claimed;
- dirty source is being attested as a clean commit;
- target-platform behavior is unproven for an architecture that depends on it;
- async ownership cleanup is ambiguous;
- capability is promoted beyond measured maturity;
- a process regression has no permanent regression test where automation is feasible.

---

## 5. Evidence validity and invalidation

Evidence is valid only when all relevant identities are bound together:

- product commit SHA or exact candidate merge-tree identity;
- current base/integration relationship;
- verifier implementation/version;
- corpus/fixture hashes or stable IDs;
- compiler/toolchain identity where applicable;
- generated runtime build/release identity where applicable;
- target/browser/runtime identity where applicable;
- workflow run/job status from that exact head.

Evidence MUST be discarded and rerun when a relevant acceptance rule changes. Examples:

- verifier logic or evidence schema changes;
- corpus source/provenance changes;
- compiler-family requirement changes;
- semantic schema/version changes;
- generated protected runtime changes;
- integration reconciles a `main` change touching the verified surface;
- browser/runtime implementation changes at a boundary covered by the proof.

Old green runs are useful history. They are not proof of a new head.

---

## 6. Generated-output transaction contract

Generated release artifacts have caused repeated Phase 3/4/5 process failures. Future phases MUST use this model:

- **Component:** source + tests only unless explicitly assigned generated ownership.
- **Component CI:** canonical build/test is allowed and normally required; generated output remains ephemeral.
- **Integration:** owns committed generated output for the combined tree.
- **Checkpoint:** generated output must be committed before another protected-runtime component merge.
- **Verification:** canonical rebuild must produce zero diff.
- **Release identity:** must reflect deployable content deterministically.
- **Workflow triggers:** shared generated output alone must not impersonate old phase ownership.

Generated files are neither ordinary source nor ignorable noise. They are release evidence with explicit ownership.

---

## 7. Moving-main contract

Parallel unrelated development is allowed. Freezing `main` is not the solution.

Instead:

- one integration lane owns reconciliation;
- components use a frozen contract base and do not repeatedly chase `main`;
- before accepting a component, integration reconciles required current-main changes;
- final cutover reconciles once more;
- source conflicts are resolved by semantic ownership, not by blindly choosing `main` or PR;
- generated artifacts are regenerated from the reconciled source, never hand-merged;
- stale repair branches are reconciled in place when safe instead of generating chains of replacement PRs;
- exact-head review and CI are repeated after reconciliation.

---

## 8. iOS/iPadOS and browser truth contract

Hex is iOS/iPad-first. Therefore:

- platform-dependent architecture assumptions MUST be proven on WebKit/iOS-compatible execution before becoming foundational;
- same-origin iframe Worker execution is the current production constraint for parallel Dev Workers;
- tests for ChatGPT automation MUST model temporal hydration, DOM virtualization, current-realm constructors, opaque sandbox behavior, and scoped control ownership;
- exact selectors are preferred; broad accessibility substring matches cannot authorize submit/stop/navigation actions;
- production-DOM regressions MUST be added for every confirmed real-device failure;
- a successful Chromium-only test cannot close a WebKit/iOS-specific blocker;
- real-device dogfood is required when the release contract names a behavior that synthetic browser automation cannot faithfully prove.

---

## 9. Required engineering behavior

These are the concrete efforts required to prevent recurrence.

1. **Run a pre-mortem before every master phase.** Compare the proposed plan against every EP entry above and state which gates prevent each applicable recurrence.
2. **Turn repeated manual rules into code.** The second occurrence of a process class requires a CI/test/validator enforcement change where technically possible.
3. **Audit first divergence before repair.** Record the earliest deterministic failure, its ownership lane, and why downstream failures are consequences.
4. **Add a regression with every process repair.** Fix + test is one unit of work.
5. **Keep a living checkpoint.** After each component integration, record exact SHA, integrated heads, generated identity, verifier identity, blockers, and next allowed action.
6. **Verify candidate merge trees.** Do not infer integration safety from independently green branches.
7. **Continuously run the independent verifier.** Final verification must be boring: the same mature verifier, one final exact product head.
8. **Treat verifier changes as evidence changes.** Re-run affected proof instead of grandfathering old green results.
9. **Measure CI before optimizing it.** Profile production hot paths and runner resource limits before increasing fanout.
10. **Fail closed on evidence publication.** No partial CI artifact, missing compiler, stale runtime, unknown deployment identity, or malformed report may become green by absence.
11. **Use actual target-platform evidence.** iPad/WebKit behavior is not deferred until after architecture is committed.
12. **Keep ownership machine-readable.** Actual file inventories, not descriptions, decide lane scope.
13. **Reconcile moving `main` centrally.** Do not make every component pay the moving-main cost.
14. **Do not hand-merge generated files.** Rebuild from the reconciled source of truth.
15. **Do not use throwaway validation PRs as normal infrastructure.** Repeated proof needs a permanent exact-SHA invocation path.
16. **Keep autonomous campaigns resumable.** Persist completed stages and exact external evidence before a reload/merge boundary.
17. **Prove active runtime after self-update.** Repository merge is not capability activation.
18. **Close the loop after cutover.** Refetch GitHub `main`, exact workflows, and deployed/runtime identity where applicable before reporting completion.

---

## 10. Phase completion checklist

A future phase may be reported **DONE** only when all applicable boxes are true:

- [ ] frozen foundation and ownership contracts were validated before fanout;
- [ ] living integration existed throughout component work;
- [ ] every component passed actual-inventory ownership;
- [ ] every accepted component passed candidate-merge-tree verification;
- [ ] every integration checkpoint completed its generated-output transaction before the next merge;
- [ ] moving `main` was reconciled through the integration owner;
- [ ] the independent verifier was mature and continuously exercised before final verification;
- [ ] verifier/corpus/toolchain identities are recorded;
- [ ] required real corpus/compiler/binary/browser/device evidence is present;
- [ ] all unexplained blocking failures are zero;
- [ ] generated output rebuild is clean on the exact product SHA;
- [ ] capability/maturity claims match measured evidence;
- [ ] canonical integration was merged with expected-head protection;
- [ ] live `main` was refetched and proven to contain the exact release product;
- [ ] deployed/in-memory runtime identity was separately proven if completion depends on it;
- [ ] no next phase started early.

If one applicable box is false, the phase is not done.

---

## 11. Updating this document

When a new process failure occurs:

1. Add a new `EP-XXX` entry with concrete evidence.
2. State the process cause, not only the product symptom.
3. Add the permanent rule that would have prevented it.
4. Add or strengthen machine enforcement where feasible.
5. Link the regression/gate that proves the old failure is now blocked.
6. Review existing entries for the same failure class and strengthen the shared rule instead of treating recurrence as unrelated.

Do not delete historical failures because the code was fixed. The history is the guardrail.