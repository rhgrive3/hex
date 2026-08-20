<!-- Read docs/dev-agent-hardening-cards/README.md first. This card is subordinate to ENGINEERING_PROCESS_GUARDRAILS, improving-agent, and preflight. -->

# CARD F — Bounded critical-path trace

**Purpose:** make future iPad concurrency/performance decisions evidence-based without adding hot-path load.  
**Expected difficulty:** 3/10.

## ALLOWED FILES

```text
js/userscript/dev/task-graph/dynamic-task-graph.js
tests/dev-agent/dynamic-task-graph.mjs
```

If a tiny dedicated trace helper is objectively required, stop first and report the proposed path; do not create it silently.

## Prompt

```text
Repository: rhgrive3/hex
CARD: F
BRANCH: dev-agent-hardening/f-task-trace

PRECONDITION
CARD E is merged/present.

MISSION
Add bounded, low-cost critical-path timestamps/IDs for Graph attempts. Do not add logging of prompts/responses or a background observer. The trace must make queue/scheduling, model-turn, completion-detection, parse, and release costs distinguishable without changing execution semantics.

ALLOWED FILES
- js/userscript/dev/task-graph/dynamic-task-graph.js
- tests/dev-agent/dynamic-task-graph.mjs

TRACE STORAGE
Keep trace state on the existing logical task: one attempt trace per attempt, capped by the existing `maxAttempts` (already <= 5). Do not add a global log/ring-buffer service. Expose trace details only through taskResult/include-result style output needed for diagnosis; do not bloat routine graph status with full traces.

REQUIRED TRACE DATA
At minimum, where technically observable without extra polling:
- graphId
- taskId
- attempt
- leaseId
- workerId
- slot
- graphReadyAt or equivalent ready timestamp
- leaseClaimedAt
- promptSubmitAt/start-issued timestamp
- completionDetectedAt
- resultParsedAt if distinct
- leaseReleasedAt
- outcome

DERIVED TIMINGS
Do not add more clocks solely for metrics. From the recorded timestamps, make it straightforward for tests/diagnostics to derive when the required endpoints exist:
- readyToLeaseMs = leaseClaimedAt - graphReadyAt
- leaseToSubmitMs = promptSubmitAt - leaseClaimedAt
- submitToCompletionDetectedMs = completionDetectedAt - promptSubmitAt
- completionToParseMs = resultParsedAt - completionDetectedAt
- parseToReleaseMs = leaseReleasedAt - resultParsedAt
These may be computed on demand rather than stored. Missing endpoints must stay explicit/null rather than fabricated.

RULES
- bounded per graph/run; no unbounded global accumulation
- no full prompt
- no full response
- no DOM snapshot
- no new timer/poll loop
- no console spam by default
- failure/benchmark detail may be retained only within the bounded structure
- timestamps must be monotonic in the logical attempt order where both endpoints exist
- do not change scheduling or completion semantics

TESTS
- trace includes required identity/timestamps for success
- retry attempts remain distinguishable
- cancelled/failed attempts carry terminal outcome
- trace storage is bounded
- no responseText/prompt body is persisted in trace
- derived timing endpoints can separate queue/submit/completion/parse/release cost without extra polling
- missing timestamp endpoints remain explicit rather than producing invented zero/negative durations
- existing Graph behavior/tests unchanged

RUN
- node tests/dev-agent/dynamic-task-graph.mjs
- npm run dev-agent:test

DELIVERY
Ready-to-merge PR, no merge. NEXT_CARD=H0.
```
