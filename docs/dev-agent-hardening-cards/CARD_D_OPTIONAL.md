<!-- Read docs/dev-agent-hardening-cards/README.md first. This card is subordinate to ENGINEERING_PROCESS_GUARDRAILS, improving-agent, and preflight. -->

# CARD D — OPTIONAL host-side public wait surface

**Default:** DO NOT RUN.  
**Run only when:** measured post-C behavior proves Supervisor-level graph/pool status polling remains a material problem.

## Prompt

```text
Repository: rhgrive3/hex
CARD: D (OPTIONAL)
BRANCH: dev-agent-hardening/d-host-wait

PRECONDITION
Human explicitly authorized CARD D after evidence showed remaining Supervisor polling.

MISSION
Add the smallest host-side wait API that removes the measured polling. Prefer graph-level wait over exposing every pooled Worker event.

DECISION IS ALREADY MADE
If the evidence is graph-status polling, implement graph wait.
If the human did not provide the exact measured polling path, STOP with BLOCKED. Do not choose a new architecture yourself.

PREFERRED GRAPH WAIT CONTRACT
- DynamicTaskGraphHost.wait({graphId}, {signal})
- terminal graph => return status immediately
- active graph => await the graph's existing completion promise/state transition, cancellation-aware
- no polling
- optional public tool only if needed by the measured caller

DO NOT
- create another event queue
- create generic pub/sub
- expose Pool wait_result just because it exists internally
- allow an old wait to attach to a newer Worker turn on the same lease
- combine with timeout, trace, prompt, or context work

ALLOWED FILES
Only the exact Graph/RPC/Admin surface/test files required by the measured path. Before editing, list them. If more than the minimal path is required, stop and report BLOCKED.

REQUIRED TESTS
- terminal-before-wait returns immediately
- wait-then-terminal settles once
- cancel signal aborts wait
- no periodic status scan
- existing Graph tests remain green

DELIVERY
Ready-to-merge PR, no merge. NEXT_CARD=E.
```
