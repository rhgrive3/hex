# Dev Agent self-improvement campaign — resume checkpoint

The campaign target is ChatGPT Project automation, reached evidence-first in
this order (the order the Supervisor prompt carries):

```
versioned DOM Skill system -> max-6 multi-Worker iframe Pool -> dynamic task graph -> ChatGPT Project automation
```

This file records where the campaign actually stands so it can be resumed from
the current checkpoint rather than restarted.

## Why the campaign stalled

Two defects in the Supervisor loop, not the campaign work itself:

1. Any Dev tool that threw ended the whole run as `FAILED`. One recoverable
   tool failure — a refused inline read, an RPC timeout, a busy Worker — killed
   the run instead of being handed back as evidence.
2. A merged source change was treated as live. The parent userscript runtime
   keeps executing the build it was loaded with, so a "new" capability could be
   proved against stale code and the proof meant nothing.

Both are fixed and merged (PR #777). See
`js/ai/dev/supervisor/tool-error-recovery.js` and
`js/ai/dev/bootstrap/self-update-gate.js`.

## Runtime identity at this checkpoint

| field | value |
| --- | --- |
| source commit | `a540448ce799f60cae1369d21beb9efdfa7a4785` |
| runtime buildId | `1cdb4d2e748cdf26bdaffeca` |
| userscript version | `2.0.2322241722` |

Confirmed live from the deployed origin through the runtime bootstrap
handshake, not from the repository: the served ciphertext and plaintext match
their published hashes, the buildId is the sha256 prefix of the served bundle,
and the bundle carries the merged Supervisor code.

**A later merge does not change this table on its own.** Re-read the live
identity before trusting it (see "Resume procedure").

## Stage status

| stage | status | evidence |
| --- | --- | --- |
| Versioned DOM Skill system | implemented | `js/userscript/dev/skills/dom-skill-registry.js`, `js/userscript/dev/skills/automation-program.js`, `chatgpt.skill.*` tools, `tests/dev-agent/dom-skill-system.mjs` |
| Max-6 multi-Worker iframe Pool | implemented, activation constrained | `js/userscript/dev/frame-mesh/iframe-worker-pool.js`, `worker.pool.*` tools, `tests/dev-agent/iframe-worker-pool.mjs` |
| Dynamic task graph | not started | named only in the Supervisor prompt roadmap; no implementation |
| ChatGPT Project automation | not started | only `projectUrl` plumbing exists in the Worker pool |

The Worker pool no longer opens browser tabs. Safari on iOS/iPadOS requires a
human tap for every `GM.openInTab` / `window.open`, so a tab pool could never be
provisioned from automation. ChatGPT answers with `x-frame-options: SAMEORIGIN`,
so each Worker is now a same-origin ChatGPT **iframe** inside the single
Supervisor tab (`js/userscript/dev/frame-mesh/iframe-worker-pool.js`). The
parent drives each Worker document directly through `ChatGPTDOMAdapter`, so
there is no popup, no cross-tab transport, and no per-frame userscript boot (the
loader still skips nested frames).

Treat "pool implemented" and "pool usable in production on iOS" as separate
claims; the second is still unproven on a real device. The Supervisor prompt
states that the active Worker runtime is single-tab until a separately verified
multi-Worker capability is installed.

## Resume procedure

The next run picks up at the dynamic task graph stage. Before proving anything
that depends on newly merged source:

1. Read the live runtime identity with `dev.runtime.identity`. It returns the
   commit, buildId and userscript version that are **actually executing**,
   preferring the parent userscript runtime and falling back to the runtime
   globals when the parent build predates that RPC method.
2. If source has been merged since that runtime loaded, declare the expectation
   with `dev.runtime.require_activation`
   (`expectedCommit`, `expectedBuildId`, optional `expectedUserscriptVersion`,
   optional `capabilities` to gate, `reason`).
3. Reload and reinitialize, then read the identity again and confirm it matches.
   Until it matches, any gated capability decision comes back as
   `kind="runtime-activation-required"` with `action: "reload-and-reinitialize"`.
   That is a refusal to prove on a stale runtime, not a transient error.
4. Only then run the E2E proof for the new capability.

A wrong expectation can be withdrawn with
`dev.runtime.require_activation` and `{"clear": true, "reason": "..."}`, so a
mistyped commit cannot strand the session. Reading the identity, withdrawing an
expectation, and winding a Worker down (`worker.stop` / `worker.release` and
their `worker.pool.*` equivalents) are never gated.

## What changed for the loop itself

A failing tool now returns `kind="tool-error"` history to the same Supervisor
session — tool name, sanitized arguments, error code, message — and the next
decision is requested immediately. The Supervisor chooses retry, a different
tool, or re-observation. Recoveries are bounded (`remainingRecoveries` in the
history entry); cancellation and explicitly fatal
invariant/security/runtime-corruption failures remain terminal. Worker
ownership survives a failure: an ambiguous claim keeps its cleanup obligation
and a failed release keeps the claim owned, so a slot is never leaked and never
released twice.
