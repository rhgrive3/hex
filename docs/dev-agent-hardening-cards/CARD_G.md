<!-- Read docs/dev-agent-hardening-cards/README.md first. This card is subordinate to ENGINEERING_PROCESS_GUARDRAILS, improving-agent, and preflight. -->

# CARD G — Supervisor prompt BOOTSTRAP/CONTINUATION transport only

**Purpose:** stop resending unchanged protocol prose every decision while preserving exactly the same authority/meaning.  
**Expected difficulty:** 4/10.

## ALLOWED FILES

```text
js/ai/dev/protocol/dev-supervisor-prompt.js
js/ai/dev/supervisor/dev-supervisor-engine-v0.js
tests/dev-agent/supervisor-prompt-modes.mjs
package.json
```

Do not introduce ContextPacket here.

## Prompt

```text
Repository: rhgrive3/hex
CARD: G
BRANCH: dev-agent-hardening/g-prompt-modes

PRECONDITION
CARD H0 parity/compatibility gate is merged/present and green.

MISSION
Add two prompt transport modes, BOOTSTRAP and CONTINUATION, while preserving the same logical payload, safety rules, tool authority and decision protocol. This card is transport compaction only.

ALLOWED FILES
- js/ai/dev/protocol/dev-supervisor-prompt.js
- js/ai/dev/supervisor/dev-supervisor-engine-v0.js
- tests/dev-agent/supervisor-prompt-modes.mjs
- package.json

DO NOT
- introduce ContextPacket or WorkerResult types
- prune evidence based on semantic relevance yet
- add LLM summarization
- add persistent memory
- change decision JSON shapes
- change tool names or permissions
- change runtime activation behavior

BOOTSTRAP MODE MUST INCLUDE
- full hex-dev-supervisor-v1 decision contract
- trust/safety boundaries
- current run goal/status/policy/scope
- current available tools and their current contracts
- runtime/self-update rules needed by the run
- current bounded history/context payload

CONTINUATION MODE MUST INCLUDE
- short protocol reminder sufficient to require exactly one valid decision object
- current run goal/status
- current available tool names
- fresh history delta / unresolved blockers / required evidence
- no redundant replay of the full fixed bootstrap prose

For this first implementation, do NOT build contract-delta diffing. Store a deterministic signature of the available tool inventory for the bootstrapped session. If that signature changes, use a full BOOTSTRAP again so the complete current contracts are resent safely.

CONTINUITY AUTHORITY
Use the existing supervisorSessionKey and runtime ownership, but do not assume continuity merely because a string matches.
Maintain in-runtime bootstrap state keyed by session key.
Mark a session bootstrapped only after a successful full BOOTSTRAP request/response cycle.
Fallback to BOOTSTRAP when:
- runtime reload/reinitialize occurs or in-memory state is absent;
- session key changes;
- bridge reports/indicates continuity loss;
- recovery cannot prove the prior session context remains valid.
Uncertainty must cost tokens, not correctness.

TESTS
1. first request for a session => BOOTSTRAP;
2. next proven same-runtime/same-session decision => CONTINUATION;
3. new session key => BOOTSTRAP;
4. new engine/runtime instance => BOOTSTRAP;
5. failed/invalid first response must not falsely mark bootstrap complete;
6. unchanged available-tool inventory signature allows CONTINUATION;
7. available-tool inventory signature change => BOOTSTRAP safe fallback;
8. CONTINUATION still produces a prompt that enforces exact decision shape and untrusted Worker/DOM data boundaries;
9. existing human/tool/wait/final engine behavior remains green.

MEASUREMENT
Add a deterministic test assertion that a representative CONTINUATION prompt is materially smaller than the equivalent BOOTSTRAP prompt. Do not use tokenizers; character/byte length is sufficient.

STANDARD GATE
Add `node tests/dev-agent/supervisor-prompt-modes.mjs` to `dev-agent:test` in package.json. Preserve all existing entries.

RUN
- node tests/dev-agent/supervisor-prompt-modes.mjs
- npm run dev-agent:test

STOP CONDITIONS
If bridge continuity cannot be safely distinguished, use BOOTSTRAP fallback. Do not weaken protocol to force CONTINUATION.

DELIVERY
Ready-to-merge PR, no merge. NEXT_CARD=H1.
```
