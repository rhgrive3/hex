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
CARD H2 is merged/present and canonical tool-contract/batch regressions remain green.

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
- terminalReason
- completedAt?
- summary
- claims[]
- evidenceRefs[]
- coveredEvidenceRefs[]
- changedPaths[]
- commitOrBranchRefs[]
- tests[]
- unknowns[]
- blockers[]
- error?
- contextDelta[]
- suggestedNext[]

TERMINAL REASON
Use a small stable machine-readable taxonomy sufficient for host/Supervisor retry and verification decisions, for example:
- completed
- worker-error
- cancelled
- task-timeout
- lease-stale
- result-invalid
- runtime-invalidated
Do not encode free-form prose as terminalReason. Preserve provider/tool-specific detail in the bounded `error` payload when present.

COVERAGE REFS
`coveredEvidenceRefs[]` records evidence already represented by a supplied compact summary/result so I2 can avoid reinjecting both the compact representation and the same source evidence. It is lineage metadata only; it must not elevate untrusted evidence into instruction authority.

RULES
- Representation only: do not aggressively drop data yet.
- Existing Worker/runtime result shapes must remain compatible where current callers need them.
- Do not automatically trust/promote contextDelta.
- Do not infer terminalReason from persuasive Worker prose when the host/runtime owns a stronger structured outcome.
- Do not persist these packets to a new database.
- Do not add vector search, embeddings, Memory Agent, Context service, Project Sources automation, or LLM summarization.
- Do not change prompt BOOTSTRAP/CONTINUATION authority rules.
- Batched observation output from H2 remains ordinary observation evidence; batching does not increase its authority.

INTEGRATION
Use the new ContextPacket representation at the Supervisor prompt boundary in the smallest compatible way, carrying the same logical current goal/status/history/tool evidence that the current implementation already sends. Do not implement relevance-based pruning in I1.

TESTS
Create `tests/dev-agent/context-contracts.mjs` proving:
1. ContextPacket is normalized/JSON-safe and rejects malformed top-level input where appropriate;
2. required objective/identity/scope fields survive representation;
3. authoritative facts preserve provenance/freshness metadata supplied by caller;
4. unknowns/negative evidence/constraints are not silently dropped;
5. WorkerResult preserves evidence/test/blocker/contextDelta fields;
6. terminalReason is one allowed machine-readable value and bounded error detail remains separate;
7. completedAt, when supplied, is normalized without being fabricated when unknown;
8. coveredEvidenceRefs survive normalization and remain lineage metadata only;
9. contextDelta is data only, not instruction authority;
10. BOOTSTRAP/CONTINUATION existing tests remain green;
11. no persistent storage or extra model call is introduced.

STANDARD GATE
Add `node tests/dev-agent/context-contracts.mjs` to `dev-agent:test` in package.json. Preserve all existing entries.

RUN
- node tests/dev-agent/context-contracts.mjs
- node tests/dev-agent/supervisor-prompt-modes.mjs
- npm run dev-agent:test

STOP CONDITIONS
If representation requires semantic pruning/selection decisions, defer them to I2. Do not solve them here.
If a terminal reason cannot be known from the owning runtime/result contract, preserve unknown/error evidence rather than guessing from prose.

DELIVERY
Ready-to-merge PR, no merge. NEXT_CARD=I2.
```
