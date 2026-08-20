<!-- Read docs/dev-agent-hardening-cards/README.md first. This card is subordinate to ENGINEERING_PROCESS_GUARDRAILS, improving-agent, and preflight. -->

# CARD 0 — Baseline and drift gate

**Purpose:** verify that the assumptions behind the cards are still true.  
**Code changes:** forbidden.  
**PR:** none.

## Prompt to give the implementation model

```text
Repository: rhgrive3/hex

You are performing CARD 0 only. Do not edit any file.

MISSION
Verify that the Dev Agent hardening execution cards still match current main before implementation begins.

READ FIRST
- AGENTS.md
- docs/ENGINEERING_PROCESS_GUARDRAILS.md
- docs/improving-agent.md (only sections relevant to Worker completion, Graph, context, tool contracts)
- docs/dev-agent-hardening-preflight.md

VERIFY CURRENT MAIN
Record the current main SHA.

VERIFY THESE FILES EXIST
- js/userscript/dev/frame-mesh/iframe-worker-pool.js
- js/userscript/dev/frame-mesh/dedicated-worker-coordinator.js
- js/userscript/dev/task-graph/dynamic-task-graph.js
- js/userscript/dev/parent-rpc.js
- js/userscript/dev/parent-worker-runtime.js
- js/ai/dev/admin/tool-surface.js
- js/ai/dev/protocol/dev-supervisor-prompt.js
- js/ai/dev/supervisor/dev-supervisor-engine-v0.js
- js/ai/dev/workers/contracts.js
- tests/dev-agent/iframe-worker-pool.mjs
- tests/dev-agent/iframe-worker-pool-cancellation.mjs
- tests/dev-agent/dynamic-task-graph.mjs
- package.json

VERIFY SOURCE ASSUMPTIONS
1. IframeWorkerPool.start() stores the active turn in slot.pending.
2. After settlement, Pool retains a terminal slot.lastResult and clears pending.
3. release() refuses while slot.pending is active and clears lease/result on successful release.
4. claim() creates fresh leaseId/runId/workerId.
5. DynamicTaskGraph still has long-turn result polling in waitForWorkerResult(), with workerPool.result() + sleep/poll cadence.
6. cleanupLease() may still use bounded cleanup polling; do not classify that as the long-turn polling target.
7. DedicatedWorkerCoordinator still has queued-first waitEvent() and a bounded event queue.
8. DevSupervisorEngineV0 still calls buildDevSupervisorPrompt() inside the decision loop with the same supervisorSessionKey.
9. dev-supervisor-prompt.js still contains hand-maintained tool argument-contract lines.
10. public Admin tool names, parent RPC mappings and prompt contracts are still separate representations.
11. npm run dev-agent:test still does not automatically cover all Phase-2/3 Pool/Graph regression files, unless this has changed since the card was written.

STOP CONDITIONS
- If waitResult() or equivalent Pool Promise-driven completion already exists and Graph already uses it: STATUS=BASELINE_DRIFT.
- If relevant Worker Pool/Graph/prompt architecture materially changed: STATUS=BASELINE_DRIFT.
- Do not propose a redesign. State exactly what changed.

OUTPUT
Use the required CARD report format.
CARD must be 0.
NEXT_CARD=A only if all assumptions needed by CARD A-C remain valid.
```
