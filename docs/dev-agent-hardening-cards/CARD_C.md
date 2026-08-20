<!-- Read docs/dev-agent-hardening-cards/README.md first. This card is subordinate to ENGINEERING_PROCESS_GUARDRAILS, improving-agent, and preflight. -->

# CARD C — Replace long-turn Graph polling with `waitResult()`

**Purpose:** remove the 50 ms long-generation result scan while preserving graph behavior.  
**Expected difficulty:** 2–3/10 after CARD B.

## ALLOWED FILES

```text
js/userscript/dev/task-graph/dynamic-task-graph.js
tests/dev-agent/dynamic-task-graph.mjs
```

## Prompt

```text
Repository: rhgrive3/hex
CARD: C
BRANCH: dev-agent-hardening/c-graph-promise-wait

PRECONDITION
CARD B is merged/present and IframeWorkerPool.waitResult() is green.

MISSION
Change only DynamicTaskGraph's long-turn completion wait to use workerPool.waitResult(). Preserve dependency scheduling, retries, graph states and cleanup behavior.

ALLOWED FILES
- js/userscript/dev/task-graph/dynamic-task-graph.js
- tests/dev-agent/dynamic-task-graph.mjs

DO NOT
- change timeout default semantics in this card
- change cleanupLease bounded cleanup polling unless strictly required for compile/test correctness
- change dependency scheduling
- change retry count semantics
- change graph/public task states
- add public wait tools
- add event bus logic
- refactor Worker Pool
- add trace yet

IMPLEMENT
Keep executeTask conceptual order:
  claim
  -> createChat
  -> start
  -> wait for same lease result
  -> existing workerSucceeded()/workerResultError mapping
  -> existing cleanup

Modify waitForWorkerResult so that:
1. Graph cancellation is still respected.
2. It waits via workerPool.waitResult({leaseId}, {signal}) rather than repeated workerPool.result() calls during the model turn.
3. Preserve the existing explicit task timeout behavior for this card. Use a cancellable deadline race if necessary, but do not change which tasks have a timeout or the default value yet.
4. A timeout remains task-timeout; graph cancellation remains cancelled.
5. The one-attempt/one-lease/one-start rule remains true.

IMPORTANT
cleanupLease currently performs short bounded cleanup observation. That is not the long-generation polling target. Do not expand CARD C into cleanup redesign.

TESTS
Add/adjust graph tests to prove:
1. ready-only dispatch unchanged;
2. max concurrency <= 6 unchanged;
3. dependency failure still blocks dependents;
4. retry still uses bounded attempts and fresh leases;
5. cancellation still cleans the active lease;
6. explicit timeout still yields task-timeout and cleanup;
7. during an active long Worker turn, Graph does not periodically call workerPool.result();
8. multiple simultaneous task completions settle independently through their own waits;
9. task transitions to a terminal graph state once only.

RUN
- node tests/dev-agent/dynamic-task-graph.mjs
- node tests/dev-agent/iframe-worker-pool.mjs
- node tests/dev-agent/iframe-worker-pool-cancellation.mjs
- npm run dev-agent:test

DIFF CHECK
Only ALLOWED FILES may change.

STOP CONDITIONS
- If CARD B's waitResult contract is insufficient, stop and report the exact missing contract. Do not patch Pool from this card.
- Do not change timeout defaults to make tests easier.

DELIVERY
Create a small ready-to-merge PR. Do not merge main.
Use required report format. NEXT_CARD=E on PASS, unless the human explicitly selects optional CARD D.
```
