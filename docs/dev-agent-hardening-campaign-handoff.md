# Dev Agent Hardening campaign — durable resume handoff

> **Status:** `PAUSED_FOR_CODESPACE_HANDOFF` — this is a resume checkpoint, not
> a completion declaration. The campaign is complete only after the accepted
> result is green, reviewed, and verified on live `main`.

This checkpoint is maintained under EP-030. It records the exact state at the
Codespaces handoff so the next Supervisor can continue from the canonical lane
rather than create replacement implementations.

## Exact checkpoint

| item | value |
| --- | --- |
| repository | `rhgrive3/hex` |
| canonical branch | `dev-agent-hardening/claim-quarantine` |
| code checkpoint | `4e41bdf5` (`fix(dev-agent): fence closed Worker ownership and continuity`) |
| base `main` used for checkpoint | `1dad48d49234e8f26e9a61e0fdc6b5a73a8d6be3` |
| open canonical PR | #1207 |
| initial campaign `main` | `ccb472477322ff3447e78e637ec66a06636bd7e0` |
| latest observed `main` before this checkpoint | `1dad48d49234e8f26e9a61e0fdc6b5a73a8d6be3` |
| generated userscript version | `2.0.2322241785` |
| generated release identity | `284db3fa68a807fa65b1c31523ef3340940f60bed9439b502b073389ca4949b1` |
| protected runtime build ID | `58763b1643bd230ce4b11115` |

The code checkpoint is committed locally. The handoff document is the next
commit and must be pushed together with the code checkpoint.

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

## Resume procedure

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

## Remaining blockers / next allowed actions

- #1207 has not been merged yet. Its new exact-head checks are required.
- Final main validation and the three final review waves are still required.
- Active deployed/runtime identity and target iPad/WebKit evidence must be
  evaluated separately; source merge alone is not activation proof.
- Do not close #1207 while it contains unique work. After merge, close only
  obsolete campaign PRs whose unique work is already in `main`.

Until those items are complete, the correct campaign status is `PARTIAL`, not
`PASS`.
