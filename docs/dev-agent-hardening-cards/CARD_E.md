<!-- Read docs/dev-agent-hardening-cards/README.md first. This card is subordinate to ENGINEERING_PROCESS_GUARDRAILS, improving-agent, and preflight. -->

# CARD E — Separate explicit task deadlines from default model-turn waiting

**Purpose:** stop treating a generic default wall clock as proof that a model turn stalled.  
**Expected difficulty:** 4–5/10.

## ALLOWED FILES

```text
js/userscript/dev/task-graph/dynamic-task-graph.js
tests/dev-agent/dynamic-task-graph.mjs
```

## Prompt

```text
Repository: rhgrive3/hex
CARD: E
BRANCH: dev-agent-hardening/e-explicit-deadlines

PRECONDITION
CARD C is merged/present and Graph long-turn completion is Promise-driven.

MISSION
Change task timeout representation so a normal model turn has no generic default timeout, while an explicitly supplied timeoutMs remains a real caller-owned deadline.

ALLOWED FILES
- js/userscript/dev/task-graph/dynamic-task-graph.js
- tests/dev-agent/dynamic-task-graph.mjs

DO NOT
- build Phase-5 liveness or stall heuristics
- add ACTIVE/QUIET/SUSPECTED_STALL state machines
- modify Pool waitResult
- modify public tools
- add progress polling
- modify retry/dependency semantics

TARGET CONTRACT
- timeoutMs omitted/null => no generic model-turn deadline
- timeoutMs = finite N => explicit deadline bounded by the existing maximum policy
- public task/status output may expose null for no deadline

ERROR SEMANTICS
- graph-wide/user cancellation => cancelled
- the task's explicit deadline expiry => task-timeout
Do not collapse these into one error merely because both may use AbortController internally.

IMPLEMENTATION RULES
1. Replace DEFAULT_TIMEOUT_MS-as-fallback with null/no deadline for ordinary tasks.
2. Normalize explicit timeout only when the caller supplied a value.
3. When no deadline exists, await Promise-driven completion until terminal/cancel/recovery policy acts.
4. When deadline exists, race the wait against that deadline and then use the existing stop/cleanup transaction.
5. Keep MAX_TIMEOUT_MS or equivalent upper safety bound for explicit deadlines.

TESTS
1. task without timeoutMs can exceed the old default-equivalent fixture duration conceptually without being classified task-timeout (use a short deterministic test mechanism; do not actually wait minutes);
2. explicit timeout still produces task-timeout;
3. graph cancel while waiting produces cancelled, not task-timeout;
4. timeout path stops/cleans lease;
5. retry semantics remain bounded;
6. status/public task representation reports null/explicit values correctly.

RUN
- node tests/dev-agent/dynamic-task-graph.mjs
- npm run dev-agent:test

DIFF CHECK
Only ALLOWED FILES may change.

STOP CONDITIONS
If removing the default timeout exposes a separate liveness problem, record it for Phase 5. Do not solve it in this card.

DELIVERY
Ready-to-merge PR, no merge. NEXT_CARD=F.
```
