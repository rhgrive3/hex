<!-- Read docs/dev-agent-hardening-cards/README.md first. This card is subordinate to ENGINEERING_PROCESS_GUARDRAILS, improving-agent, and preflight. -->

# CARD F1 — OPTIONAL target-device concurrency tuning

**Default:** DO NOT RUN as part of ordinary implementation.  
**Run only when:** CARD F trace is merged/active and a target iOS/iPadOS runtime is available for comparable live measurements.  
**Code changes:** forbidden unless a later separately-reviewed tuning card is authorized.

## Prompt

```text
Repository: rhgrive3/hex
CARD: F1 (OPTIONAL EVIDENCE ONLY)

MISSION
Use the bounded CARD F trace to measure effective Worker concurrency on the real target runtime. Determine whether higher fan-out actually reduces end-to-end makespan without increasing queueing, retries, iframe churn, or WebKit instability. Do not change code or configuration in this card.

PRECONDITIONS
- CARD F is merged and the executing userscript/runtime identity proves that trace support is active.
- The same-origin iframe Worker pool is healthy enough to run the comparison.
- Comparable independent tasks/fixtures are available.
- Measurements can be taken on the target iOS/iPadOS/WebKit environment; desktop-only data is not sufficient for a production concurrency recommendation.

MEASURE
For effectiveConcurrency N=1..6 where the runtime remains stable, collect comparable runs and record at minimum:
- total makespan
- ready-to-lease / slot wait
- lease-to-submit
- submit-to-completion-detected
- completion-to-parse
- parse-to-release
- retry/failure count
- discard/reprovision count
- visible iframe/UI instability or memory-pressure symptoms that are observable without inventing telemetry

RULES
- 6 is a capacity ceiling, not the presumed winner.
- Use the same or equivalently controlled independent task set for each N.
- Do not claim backend generation overlap from aggregate wall time alone.
- Do not increase polling or add instrumentation to make the benchmark easier.
- If background iOS throttling makes a run incomparable, mark it invalid/unknown instead of forcing a ranking.
- Prefer the smallest N whose measured makespan/stability is not materially worse than a larger N when the larger N adds pressure or variance.

OUTPUT
Report:
- active runtime identity
- fixture/task set
- run table for each valid N
- invalid/incomparable runs and why
- recommended effectiveConcurrency or UNKNOWN
- evidence for the recommendation
- whether a separate implementation/tuning change is justified

STOP CONDITIONS
- If CARD F trace is not active, stop with RUNTIME_ACTIVATION_REQUIRED/BLOCKED.
- If target-device conditions cannot be made comparable, return UNKNOWN rather than a desktop-derived or intuition-derived value.
- Do not edit code, open a tuning PR, or change the production default from this evidence-only card.

DELIVERY
No PR. Return to the strong reviewer/human with the measurement report.
```
