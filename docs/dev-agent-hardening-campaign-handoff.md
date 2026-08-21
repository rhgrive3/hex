# Dev Agent Hardening campaign — durable resume handoff

> **Status:** `HISTORICAL_RESUME_CHECKPOINT` — captured while Codespaces was
> expiring, before the checkpoint PR was integrated. This document is an audit
> record, not the current campaign state; live `main` and GitHub are authoritative.

This checkpoint is maintained under EP-030. It records the exact state at the
Codespaces handoff so the next Supervisor can continue from the canonical lane
rather than create replacement implementations.

## Exact checkpoint at capture (before #1207 merge)

| item | value |
| --- | --- |
| repository | `rhgrive3/hex` |
| canonical branch | `dev-agent-hardening/claim-quarantine` |
| code checkpoint | `4e41bdf5` (`fix(dev-agent): fence closed Worker ownership and continuity`) |
| base `main` used for checkpoint | `1dad48d49234e8f26e9a61e0fdc6b5a73a8d6be3` |
| canonical PR at capture | #1207 |
| initial campaign `main` | `ccb472477322ff3447e78e637ec66a06636bd7e0` |
| latest observed `main` before this checkpoint | `1dad48d49234e8f26e9a61e0fdc6b5a73a8d6be3` |
| generated userscript version | `2.0.2322241785` |
| generated release identity | `284db3fa68a807fa65b1c31523ef3340940f60bed9439b502b073389ca4949b1` |
| protected runtime build ID | `58763b1643bd230ce4b11115` |

At capture, the code checkpoint and this handoff were the two commits that had
to be pushed together. That handoff was completed before the checkpoint PR was
integrated.

## Accepted campaign lineage already on `main`

The default sequence through I2 has already been accepted and merged:

```
CARD 0
→ A #1047
→ B #1054
→ C #1059
→ E #1060
→ F #1061
→ H0 #1062
→ G #1063
→ H1 #1064
→ H2 #1199
→ I1 #1065
→ I2 #1070
```

H2 is between H1 and I1. D was measured and is
`SKIPPED_NOT_NEEDED`: the actual Supervisor path uses one Promise-driven
`waitResult` per lease and has no materially wasteful repeated Supervisor-level
graph/pool status polling requiring a graph-level host wait.

After the campaign sequence, live `main` advanced through #1204. The
current-main reconciliation PR #1206 was then merged as `1dad48d4`; it fixed
portable Phase 10/11 workflow expressions, removed hard-coded workspace paths
from shared verifiers, and assigned the shared verification files in both
ownership manifests. Its exact-head checks were green before merge.

## Work in #1207 at this checkpoint

The canonical branch contains the original claim-quarantine repair plus the
following reviewed correctness repairs. No second implementation lane exists.

- `IframeWorkerPool` uses an ownership generation/close fence. A late claim
  cannot publish a lease after close; ambiguous remote acceptance is cleaned up
  and the pool is fail-closed. Explicit `provision()` is the reinitialization
  boundary for a new generation.
- Dedicated and single-tab Worker coordinators settle an in-flight initial send
  when the coordinator closes, instead of leaving the public Promise pending.
- Worker result metadata cannot overwrite the runtime-owned DevRun `workerId`.
- A human response resumed after prior tool history is explicitly included in
  the next CONTINUATION delta.
- Each of these has a focused regression in the Dev Agent test surface.

The performance review claim about a generic 110-second full-turn abort was not
adopted: the Dev Worker full-turn surface passes `timeoutMs: 0`, the ChatGPT
Worker controller drives the ChatGPT turn with `timeoutMs: Infinity`, and the
110-second value belongs to the separate ordinary Gemini/WorkerAI provider
request path. Reconfirm this distinction during the final independent review.

## Evidence at the checkpoint

Passed locally on the code checkpoint:

- `npm run dev-agent:test`
- `node tests/dev-agent/generated-output-policy.mjs`
- `node tests/userscript-release-version.mjs`
- `node tests/userscript-dev-worker-runtime.mjs`
- `node --check userscript/hex.user.template.js`
- `npm run userscript:build` (zero generated diff expected after the build)
- focused regressions for pool close/late claim, Dedicated/Single close, Worker
  identity, human CONTINUATION, prompt modes, and conversation continuity

GitHub evidence before this code checkpoint:

- #1206 exact head `03bb0fb0` passed required Phase 10/11, Invariant Gates, and
  accuracy checks and merged to `1dad48d4`.
- The old #1207 head was green for userscript/generated/accuracy checks but had
  stale-base failures before #1206 merged. Those results are invalid for the
  new head and must not be reused.

## Resume procedure at capture (historical)

Run from `/tmp/hex-worker-claim-fix` (the dirty shared worktree at
`/workspaces/hex` is not the integration worktree):

1. `git status --short --branch`; confirm only the handoff commit is pending.
2. Commit this handoff file, then push the canonical branch with
   `git push origin dev-agent-hardening/claim-quarantine`.
3. Confirm PR #1207 base is `main`, its exact head is the pushed commit, and
   `git ls-remote origin refs/heads/main` still equals the recorded base. If
   `main` moved, merge the new `origin/main` into this one branch, regenerate
   userscript output, rerun all focused tests, and push one new exact head.
4. Wait for and inspect `gh pr checks 1207 --repo rhgrive3/hex`. Classify any red
   job from its exact log before changing code. Do not use the old head result.
5. Before merge, personally verify current `main`, PR head, intended changed
   files, mergeability, generated sync, and all required exact-head checks.
   Merge only with expected-head protection:

   ```sh
   gh pr merge 1207 --repo rhgrive3/hex --merge --match-head-commit <exact-head>
   ```

6. Refetch and verify the resulting exact `main` tree. Run the final three
   independent review waves on that exact main (at least two correctness, one
   performance/simplicity, one integration), then rerun the final campaign
   tests and exact-main CI checks.
7. Evaluate the Phase 4 gate in
   `docs/dev-agent-hardening-cards/README.md` on final `main` only. Do not begin
   Phase 4. Report `READY` only with every required proof; otherwise report
   `NOT_READY` with the exact missing proof.

## Remaining blockers / next allowed actions at capture (historical)

- #1207 has not been merged yet. Its new exact-head checks are required.
- Final main validation and the three final review waves are still required.
- Active deployed/runtime identity and target iPad/WebKit evidence must be
  evaluated separately; source merge alone is not activation proof.
- Do not close #1207 while it contains unique work. After merge, close only
  obsolete campaign PRs whose unique work is already in `main`.

Those statements describe the state at capture only. Do not use them to infer
the current campaign status; re-read live `main`, exact-head CI, and current
review evidence before making an acceptance decision.

## Final closeout after #1207–#1211 — 2026-08-21

This section completes the unfinished work recorded above. It is a closeout of
the hardening campaign and a Phase 4 handoff decision; it does **not** start or
claim completion of Phase 4.

### Final observed source baseline

| item | final closeout evidence |
| --- | --- |
| pre-closeout `main` | `25f65d75d60f211051574562b4265ac504581afa` |
| #1207 | merged as `5682c936bc00a8c15f026e5c0f186de05c8d82f1` |
| #1209 | merged as `e2548f64f764fc8f96aca65c5464b8d5e4c14507` |
| #1210 | merged as `191f84ea4046033752000dd70711c76a5f7c1ed1` |
| #1211 | merged as `25f65d75d60f211051574562b4265ac504581afa` |
| software handoff verdict | `READY_FOR_PHASE_4_P4.0` |
| active runtime verdict | `NOT_CLAIMED_BY_SOURCE_CLOSEOUT` |

The source baseline above is the exact `main` observed before this documentation-only
closeout change. The closeout PR changes no runtime/source implementation, so it
does not invalidate the reviewed software behavior. Its own exact-head CI is the
final repository-level validation for the resulting tree.

### Final review waves

**Wave 1 — correctness / ownership lifecycle:** #1209 independently reconciled
the post-#1207 tree and closed late-claim, close-generation, stale terminal-event,
Worker identity, human CONTINUATION, and ContextPacket-loss gaps. The final code
keeps ownership generation fenced and treats ambiguous ownership as fail-closed.

**Wave 2 — cancellation correctness + performance/simplicity:** #1210 closed the
remaining aborted-claim race. Aborting a pending claim now settles the caller
without making the slot reusable: the slot stays reserved until the remote claim
settles and rollback completes, and rollback failure leaves it quarantined. The
current task-graph full-turn path performs one Promise-driven `waitResult()` per
lease; the `50ms` polling that remains is confined to bounded post-cancel/cleanup
observation, not normal model-turn completion. Task deadlines are opt-in: a task
with no `timeoutMs` has no generic full-turn wall clock. No second scheduler,
event bus, or polling service was introduced.

**Wave 3 — integration / release:** #1211 regenerated only the canonical userscript
loader and release-version identity after the final integration merge. Its exact
head `725e498c5c15e7e09dd2109a33e3e36c2f0bc0af` passed Invariant Gates, Generated
userscript sync, Generated userscript autofix, and ChatGPT userscript host. This
closed the stale generated-identity failures left by the #1209/#1210 integration.

No additional source defect was found by this closeout review that requires a
new hardening implementation PR.

### Exact-head CI evidence used for closeout

The final repair heads were not accepted from PR prose alone:

- #1209 head `321f0a5926e32f2a8b00b7084623fb4a05260536`: Invariant Gates,
  Generated userscript sync/autofix, AI evaluation contract, Migration guardrails,
  ChatGPT userscript host, and Cross-binary accuracy all completed successfully.
- #1210 head `dfed3fc66a6bac59f5fc93bc26f2147677d68ced`: Invariant Gates,
  Generated userscript sync/autofix, ChatGPT userscript host, and Cross-binary
  accuracy all completed successfully.
- #1211 head `725e498c5c15e7e09dd2109a33e3e36c2f0bc0af`: Invariant Gates,
  Generated userscript sync/autofix, and ChatGPT userscript host all completed
  successfully.

The closeout documentation PR MUST itself be green at its exact head before
merge. Its merge result then becomes the final repository state for this report.

### Phase 4 handoff gate

The `docs/dev-agent-hardening-cards/README.md` readiness contract was re-read on
the final software baseline. The required hardening surfaces are present on
`main`: Promise-driven long-turn completion, close/reinitialize ownership fencing,
explicit/no-default task deadlines, fail-closed cancellation cleanup, bounded
critical-path trace, prompt/tool and bootstrap/continuation contracts, canonical
tool metadata/batch policy, bounded observation batching, ContextPacket/
WorkerResult representation, deterministic context selection, and the existing
Standard-Agent isolation contract.

**Decision: `READY_FOR_PHASE_4_P4.0`.** The next allowed product work is the
read-only Project observation/baseline step. This is deliberately narrower than
`RUNTIME_READY` or `PHASE_4_COMPLETE`.

Before any live Phase 4 proof, P4.0 MUST read `dev.runtime.identity`, compare the
active userscript/runtime identity with the required source/build, activate or
reload if stale, and only then perform target iOS/iPadOS/WebKit observation. No
active runtime identity or iPad/WebKit execution was observed during this
source/GitHub closeout, so this report makes no such claim.

### Historical blockers disposition

The blockers recorded at capture are now resolved as follows:

- #1207 merge: **resolved**.
- final-main software validation: **resolved by the final repair sequence and
  exact-head CI evidence above; the documentation closeout is separately gated
  on its own exact head**.
- final independent review waves: **resolved by Waves 1–3 above**.
- Phase 4 source-readiness decision: **resolved as `READY_FOR_PHASE_4_P4.0`**.
- active deployed/runtime identity and target iPad/WebKit proof: **not a source
  closeout claim; it remains the mandatory first live-proof gate in P4.0**.

Accordingly, there is no remaining hardening-campaign source blocker that
requires another repair before starting Phase 4 at its read-only P4.0 boundary.
