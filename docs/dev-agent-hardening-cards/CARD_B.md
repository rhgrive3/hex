<!-- Read docs/dev-agent-hardening-cards/README.md first. This card is subordinate to ENGINEERING_PROCESS_GUARDRAILS, improving-agent, and preflight. -->

# CARD B — Internal Pool `waitResult()` over existing completion state

**Purpose:** create one cancellation-aware, lease-aware Promise-driven completion primitive.  
**Expected difficulty:** 2–3/10.  
**Behavior change:** additive internal Pool API only.

## ALLOWED FILES

```text
js/userscript/dev/frame-mesh/iframe-worker-pool.js
tests/dev-agent/iframe-worker-pool.mjs
tests/dev-agent/iframe-worker-pool-cancellation.mjs
```

## Prompt

```text
Repository: rhgrive3/hex
CARD: B
BRANCH: dev-agent-hardening/b-pool-wait-result

PRECONDITION
CARD A is merged or its exact changes are present in the current branch base.

MISSION
Add an internal IframeWorkerPool.waitResult({leaseId}, {signal}) that waits on the already-owned slot.pending Promise and returns the retained terminal result. Do not create a new event system.

ALLOWED FILES
- js/userscript/dev/frame-mesh/iframe-worker-pool.js
- tests/dev-agent/iframe-worker-pool.mjs
- tests/dev-agent/iframe-worker-pool-cancellation.mjs

DO NOT
- modify DynamicTaskGraph
- modify parent RPC or Admin tool surface
- expose worker.pool.wait_result yet
- change timeout defaults
- change release/discard ownership semantics
- add polling
- add IndexedDB, event bus, scheduler, turn manager, or background service

REQUIRED CONTRACT
Implement a narrow internal method equivalent to:

  waitResult({ leaseId }, { signal } = {})

Algorithm:
1. Resolve leaseId with the existing lease authority.
2. Snapshot the current slot index, leaseId, runId and workerId.
3. Capture the current slot.pending reference exactly once.
4. If signal is already aborted, reject as cancelled without changing Worker ownership.
5. If captured pending exists, await its settlement without polling.
   - Convert both resolve and reject settlement into a wakeup; the Pool's canonical retained lastResult remains the returned authority.
   - Do not return the raw Promise rejection as a second failure representation.
6. After settlement/wakeup, revalidate that the same leaseId still owns the same slot/runId/workerId.
7. Return the retained terminal slot.lastResult.
8. If pending was already null because the turn completed before waitResult registration, validate identity and return retained lastResult immediately.
9. If neither an active captured pending nor a retained terminal result exists, fail with a typed Pool error instead of returning a fabricated terminal state.
10. Aborting waitResult aborts only the wait. It MUST NOT release, stop, discard, or reassign the Worker.
11. Pool close/runtime reinitialization invalidates the old ownership domain. A captured Promise that settles after close/reinitialize MUST NOT become authority for a new pool, lease, slot owner, or task.

IMPORTANT IDENTITY LIMIT
For this card, waitResult is internal and supports the Graph's existing one-start-per-lease/attempt path. Do not claim leaseId/runId/workerId is a universal multi-turn token. Do not add a public wait tool or a new identity subsystem.

REQUIRED TESTS
Add new API regressions for:
1. completion before waitResult registration returns retained terminal result;
2. waitResult registered while Worker is active settles once;
3. Worker send rejection returns canonical retained failed result;
4. aborted wait rejects/cancels the wait but leaves lease ownership intact;
5. release/reclaim invalidates an old lease; an old wait/result cannot become authority for the new lease;
6. repeated read-only wait/result after completion is idempotent until release;
7. no polling/sleep loop is introduced;
8. close/reinitialize while an old wait is pending cannot let the old settlement satisfy a later pool/lease/task.

RUN
- node tests/dev-agent/iframe-worker-pool.mjs
- node tests/dev-agent/iframe-worker-pool-cancellation.mjs
- npm run dev-agent:test

DIFF CHECK
Only ALLOWED FILES may change.

STOP CONDITIONS
- If correct implementation requires changing Graph, RPC, Supervisor, or Coordinator architecture, stop and report BLOCKED. Do not broaden scope.
- If the current Pool no longer owns pending + lastResult as assumed, report BASELINE_DRIFT.

DELIVERY
Create a small ready-to-merge PR. Do not merge main.
Use the required CARD report format. NEXT_CARD=C only on PASS.
```
