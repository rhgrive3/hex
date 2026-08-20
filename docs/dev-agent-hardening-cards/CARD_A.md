<!-- Read docs/dev-agent-hardening-cards/README.md first. This card is subordinate to ENGINEERING_PROCESS_GUARDRAILS, improving-agent, and preflight. -->

# CARD A — Characterization tests and standard Dev-Agent gate

**Purpose:** make the existing Pool/Graph completion contract observable before product behavior changes.  
**Expected difficulty:** 2/10.  
**Behavior change:** tests/test orchestration only.

## ALLOWED FILES

```text
tests/dev-agent/iframe-worker-pool.mjs
tests/dev-agent/iframe-worker-pool-cancellation.mjs
tests/dev-agent/dynamic-task-graph.mjs
package.json
```

Do not modify production JS in this card.

## Prompt

```text
Repository: rhgrive3/hex
CARD: A
BRANCH: dev-agent-hardening/a-characterize

You are an implementation worker, not an architect. Implement only this card.

PRECONDITION
CARD 0 passed on the current or compatible main.

MISSION
Add characterization coverage for the Pool/Graph completion state that exists today, and ensure the standard dev-agent test entry actually runs the relevant Pool/Graph regressions.

ALLOWED FILES
- tests/dev-agent/iframe-worker-pool.mjs
- tests/dev-agent/iframe-worker-pool-cancellation.mjs
- tests/dev-agent/dynamic-task-graph.mjs
- package.json

DO NOT
- modify IframeWorkerPool production code
- add waitResult()
- change DynamicTaskGraph behavior
- change timeout semantics
- add public tools
- add an event bus
- edit Supervisor prompt/context code

IMPLEMENT
Add focused tests that prove current behavior:
1. Pool start marks a slot as actively pending/working.
2. Successful completion becomes a retained terminal result and the active pending state clears.
3. A rejected Worker send is represented by the Pool as a retained failed result; do not leave an unhandled rejection.
4. Multiple Worker completions settle independently.
5. release during active generation is refused.
6. successful release clears old lease ownership and retained result.
7. reclaim after release produces fresh leaseId/runId/workerId ownership.
8. current DynamicTaskGraph uses exactly one Pool start per lease/attempt in the covered execution path.
9. existing graph SUCCEEDED behavior is execution-layer success only; do not add any test or type that claims Supervisor acceptance.

TEST-GATE WIRING
Inspect package.json. If npm run dev-agent:test does not execute these critical Phase-2/3 regressions, add the following direct tests to that script while preserving the existing tests:
- node tests/dev-agent/iframe-worker-pool.mjs
- node tests/dev-agent/iframe-worker-pool-cancellation.mjs
- node tests/dev-agent/dynamic-task-graph.mjs
Do not remove existing dev-agent:test entries.

TESTS REQUIRED
1. node tests/dev-agent/iframe-worker-pool.mjs
2. node tests/dev-agent/iframe-worker-pool-cancellation.mjs
3. node tests/dev-agent/dynamic-task-graph.mjs
4. npm run dev-agent:test

DIFF CHECK
Only ALLOWED FILES may change.

STOP CONDITIONS
- If a characterization assertion contradicts current source, do not alter production to make the test pass. Report BASELINE_DRIFT.
- If adding the standard gate reveals a pre-existing unrelated failing test, report the exact test and failure. Do not weaken the gate.

DELIVERY
Create a small branch and ready-to-merge PR. Do not merge main.
Use the required CARD report format. NEXT_CARD=B only on PASS.
```
