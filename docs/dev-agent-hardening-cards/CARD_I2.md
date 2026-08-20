<!-- Read docs/dev-agent-hardening-cards/README.md first. This card is subordinate to ENGINEERING_PROCESS_GUARDRAILS, improving-agent, and preflight. -->

# CARD I2 — Deterministic context selection and budget

**Purpose:** reduce repeated context without reducing task correctness or evidence authority.  
**Expected difficulty:** 4/10 with strong independent review recommended.

## EXPECTED ALLOWED FILES

```text
js/ai/dev/protocol/context-selection.js
js/ai/dev/protocol/context-packet.js
js/ai/dev/workers/contracts.js
js/ai/dev/protocol/dev-supervisor-prompt.js
js/ai/dev/supervisor/dev-supervisor-engine-v0.js
tests/dev-agent/context-selection.mjs
package.json
```

## Prompt

```text
Repository: rhgrive3/hex
CARD: I2
BRANCH: dev-agent-hardening/i2-context-selection

PRECONDITION
CARD I1 is merged/present and context-contract tests are green.

MISSION
Add deterministic, host-side context selection so each Supervisor/Worker receives the smallest sufficient fresh authoritative context. Preserve correctness first. No model call may be added for selection, summarization, retrieval or reranking.

NEW MODULE
Create exactly `js/ai/dev/protocol/context-selection.js` unless an equivalent deterministic selector already exists.

DO NOT
- use an LLM summarizer
- use embeddings/vector DB
- add Memory Agent/Context service
- add background iframe/model calls
- remove required constraints/unknowns/negative evidence to hit a byte target
- make token count the success criterion
- modify Project automation

SELECTION ORDER
Build ContextPacket content deterministically in this priority order:
1. objective and success criteria;
2. hard constraints, forbidden actions and stop conditions;
3. fresh owning-system authoritative facts required by the current decision;
4. unresolved blockers, unknowns and relevant negative evidence;
5. dependency WorkerResult summaries/evidence refs needed by the current task;
6. artifact/evidence refs and only the bounded excerpts needed now;
7. recent context delta needed for continuity.

PROVENANCE/FRESHNESS
- Cached facts must retain source/authority and observation/freshness metadata.
- A newer owning-system observation supersedes a stale conflicting snapshot without erasing the conflict from audit evidence.
- Tool/DOM/runtime/CI observations are snapshots, not timeless memory.
- H2 batching changes transport only; each observation keeps the same owner/provenance/authority it would have had as a direct call.

DEDUPLICATION/COMPACTION
- remove exact/redundant repeated facts deterministically;
- prefer refs over bulk logs/documents;
- if a compacted summary/result carries coveredEvidenceRefs, do not inject those covered source artifacts again unless the current task explicitly requires expanding them;
- preserve coveredEvidenceRefs when the compact representation survives selection so the audit expansion path remains available;
- never invent coveredEvidenceRefs or a summary with an extra LLM call here.

BUDGET
Use a simple byte/character budget at the prompt boundary. Do not add a tokenizer dependency for iOS.
When over budget:
- drop lower-priority redundant excerpts first;
- keep objective/criteria/constraints/unknowns/negative evidence/required authoritative facts;
- preserve refs to omitted large artifacts;
- if the required context cannot fit safely, surface an explicit budget/selection blocker rather than silently deleting correctness-critical information.

QUALITY GATE
Smaller context alone is not PASS. Representative deterministic fixtures must preserve or improve the decisions/evidence needed to complete the tasks.

TESTS
Create `tests/dev-agent/context-selection.mjs` with deterministic fixtures proving:
1. required constraints survive tight budgets;
2. unknowns and negative evidence survive;
3. stale duplicate fact loses to fresher owning-system fact while provenance remains inspectable;
4. irrelevant bulk evidence becomes ref/omitted excerpt before critical facts are removed;
5. duplicate facts are not injected repeatedly;
6. WorkerResult/context summaries with coveredEvidenceRefs prevent compact-summary + covered-original double injection in the same packet;
7. covered evidence can still be expanded by ref when explicitly required by the task;
8. H2 batched observations retain per-observation provenance/owner metadata rather than becoming one synthetic higher-authority fact;
9. budget overflow that cannot be made safe becomes explicit failure/blocker;
10. selected context is materially smaller for a repeated-history fixture while all assertions needed for the correct decision remain present;
11. no additional model request occurs during selection.

STANDARD GATE
Add `node tests/dev-agent/context-selection.mjs` to `dev-agent:test` in package.json. Preserve all existing entries.

RUN
- node tests/dev-agent/context-selection.mjs
- node tests/dev-agent/context-contracts.mjs
- node tests/dev-agent/supervisor-prompt-modes.mjs
- npm run dev-agent:test

REVIEW
Request/perform an independent review focused on accidental information loss, provenance, unknown/negative-evidence retention, covered-evidence lineage, batched-observation authority preservation, and iOS hot-path cost.

STOP CONDITIONS
If a fixture needs semantic interpretation that cannot be deterministic, preserve the context instead of adding an LLM selector. Report the optimization as deferred.
If deduplication cannot prove that one compact item covers a source ref, keep both rather than guessing coverage.

DELIVERY
Ready-to-merge PR, no merge. NEXT_CARD=NONE. Return to the strong reviewer for the Phase-4 readiness gate.
```
