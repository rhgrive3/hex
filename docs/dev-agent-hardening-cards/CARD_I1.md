<!-- Read docs/dev-agent-hardening-cards/README.md first. This card is subordinate to ENGINEERING_PROCESS_GUARDRAILS, improving-agent, and preflight. -->

# CARD I1 — ContextPacket / WorkerResult representation only

**Purpose:** introduce typed compact handoff representations without changing context-selection semantics yet.  
**Expected difficulty:** 3/10.

## EXPECTED ALLOWED FILES

```text
js/ai/dev/protocol/context-packet.js
js/ai/dev/workers/contracts.js
js/ai/dev/protocol/dev-supervisor-prompt.js
js/ai/dev/supervisor/dev-supervisor-engine-v0.js
tests/dev-agent/context-contracts.mjs
package.json
```

## Prompt

```text
Repository: rhgrive3/hex
CARD: I1
BRANCH: dev-agent-hardening/i1-context-contracts

PRECONDITION
CARD H1 is merged/present and parity remains green.

MISSION
Introduce explicit ContextPacket and WorkerResult representations, but preserve today's logical information. This is a representation migration, not a pruning/selection optimization.

NEW MODULE
Create exactly `js/ai/dev/protocol/context-packet.js` unless an equivalent canonical module already exists.

CONTEXT PACKET LOGICAL FIELDS
Use the v2.3 contract as the source. Include a JSON-safe normalized representation for:
- schemaVersion
- orchestrationRunId
- taskId
- role
- objective
- successCriteria
- scope
- constraints
- authoritativeFacts[]
- dependencyResults[]
- artifactRefs[]
- knownFailures[]
- unknowns[]
- requiredEvidence[]
- forbiddenActions[]
- stopConditions[]
- budget

WORKER RESULT LOGICAL FIELDS
Extend/create the Worker result contract in the existing Worker contracts layer with JSON-safe normalized fields for:
- schemaVersion
- orchestrationRunId
- graphId?
- taskId
- attempt?
- leaseId?
- workerId
- state
- summary
- claims[]
- evidenceRefs[]
- changedPaths[]
- commitOrBranchRefs[]
- tests[]
- unknowns[]
- blockers[]
- contextDelta[]
- suggestedNext[]

RULES
- Representation only: do not aggressively drop data yet.
- Existing Worker/runtime result shapes must remain compatible where current callers need them.
- Do not automatically trust/promote contextDelta.
- Do not persist these packets to a new database.
- Do not add vector search, embeddings, Memory Agent, Context service, Project Sources automation, or LLM summarization.
- Do not change prompt BOOTSTRAP/CONTINUATION authority rules.

INTEGRATION
Use the new ContextPacket representation at the Supervisor prompt boundary in the smallest compatible way, carrying the same logical current goal/status/history/tool evidence that the current implementation already sends. Do not implement relevance-based pruning in I1.

TESTS
Create `tests/dev-agent/context-contracts.mjs` proving:
1. ContextPacket is normalized/JSON-safe and rejects malformed top-level input where appropriate;
2. required objective/identity/scope fields survive representation;
3. authoritative facts preserve provenance/freshness metadata supplied by caller;
4. unknowns/negative evidence/constraints are not silently dropped;
5. WorkerResult preserves evidence/test/blocker/contextDelta fields;
6. contextDelta is data only, not instruction authority;
7. BOOTSTRAP/CONTINUATION existing tests remain green;
8. no persistent storage or extra model call is introduced.

STANDARD GATE
Add `node tests/dev-agent/context-contracts.mjs` to `dev-agent:test` in package.json. Preserve all existing entries.

RUN
- node tests/dev-agent/context-contracts.mjs
- node tests/dev-agent/supervisor-prompt-modes.mjs
- npm run dev-agent:test

STOP CONDITIONS
If representation requires semantic pruning/selection decisions, defer them to I2. Do not solve them here.

DELIVERY
Ready-to-merge PR, no merge. NEXT_CARD=I2.
```
