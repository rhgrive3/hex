<!-- Read docs/dev-agent-hardening-cards/README.md first. This card is subordinate to ENGINEERING_PROCESS_GUARDRAILS, improving-agent, and preflight. -->

# CARD H2 — Bounded deterministic observation batch

**Purpose:** reduce expensive Supervisor model round-trips by allowing one bounded call to gather several already-authorized read-only observations without creating a second scheduler or arbitrary code-execution surface.  
**Expected difficulty:** 4–5/10.

## Prompt

```text
Repository: rhgrive3/hex
CARD: H2
BRANCH: dev-agent-hardening/h2-observation-batch

PRECONDITION
CARD H1 is merged/present and the canonical tool-contract parity gate is green.

MISSION
Add one narrowly-scoped Dev Admin observation-batch tool, using the canonical H1 registry as the only eligibility authority. The first implementation should collapse Supervisor↔host round-trips, not introduce general workflow execution or parallel scheduling.

PUBLIC CONTRACT
Use the public tool name:

  dev.batch.observe

Accept a JSON-safe request equivalent to:

  { calls: [{ tool, arguments? }, ...] }

with a hard maximum of 6 calls per batch.

ELIGIBILITY
A target may execute through this batch only when its canonical H1 metadata says:
- operationClass === `observation`
- batchPolicy === `observation`

Everything else is forbidden. Missing/unknown metadata fails closed.

EXECUTION MODEL
1. Validate the entire batch before executing any target.
2. Reject empty batches, more than 6 calls, nested `dev.batch.observe`, unknown tools, malformed entries, or any target not explicitly batch-eligible.
3. Execute eligible targets through the same normal validated handler/client/RPC path used by a direct call. Do not create a second implementation of an observation.
4. Execute targets sequentially in request order for this first card. The primary optimization is fewer Supervisor model turns; do not add a parallel scheduler yet.
5. Return one bounded ordered result entry per requested call, preserving the request index/tool identity and either the normal observation result or a normalized bounded error.
6. A target failure does not fabricate success. Continue to later independently validated observation targets unless the existing host/runtime boundary is no longer safe to invoke; preserve each failure distinctly.
7. The batch tool itself must have batchPolicy=never so nesting is impossible.

EXPECTED ALLOWED FILES
Before editing, inspect current H1 output and list the smallest exact set needed from:
- js/ai/dev/protocol/dev-tool-contracts.js
- js/ai/dev/admin/tool-surface.js
- the existing Admin client/RPC file(s) that own direct observation dispatch
- tests/dev-agent/tool-contract-parity.mjs
- one focused new batch regression file under tests/dev-agent/
- package.json only if needed to add the focused regression to dev-agent:test

If the existing H1 design can implement the batch entirely above parent RPC without changing parent-rpc.js, prefer that smaller path. If an additional production file is required, state why before editing it.

DO NOT
- add arbitrary JavaScript/eval/code mode
- add a generic workflow language
- batch mutation/control/wait/full-turn tools
- infer safety from the tool name
- bypass direct-call validation, authentication, permission, or RPC boundaries
- create a second tool registry
- create a second scheduler/event bus
- add background model calls or hidden iframes
- parallelize calls in this card
- expose raw unbounded exceptions/logs in the batch result

REQUIRED TESTS
Prove at minimum:
1. two eligible observations execute once each and results preserve request order;
2. one failing eligible observation produces a failure entry without becoming success;
3. a later eligible observation can still complete after an independent earlier observation failure;
4. mutation/control/wait/full-turn targets are rejected before any target executes;
5. unknown/missing metadata is rejected before execution;
6. nested dev.batch.observe is rejected;
7. more than 6 calls and empty/malformed batches reject deterministically;
8. direct and batched execution of the same eligible observation use the same underlying normal handler path and preserve equivalent result semantics;
9. canonical parity remains green and the batch tool itself is batchPolicy=never;
10. no eval, arbitrary model-authored program, extra scheduler, or parallel dispatch is introduced.

MEASUREMENT
Use a deterministic fixture to demonstrate that a representative sequence of 3 independent observations can be requested through one public Supervisor tool decision instead of 3 separate tool decisions. Do not claim model/backend latency improvement from unit tests; the required proof here is reduction in public round-trip count while preserving result semantics.

RUN
- focused H2 regression
- node tests/dev-agent/tool-contract-parity.mjs
- npm run dev-agent:test

STOP CONDITIONS
- If H1 cannot identify eligibility from one canonical registry, stop and repair H1 rather than creating a second allowlist.
- If the only implementation path requires arbitrary code execution or a new scheduler, report BLOCKED; do not broaden scope.
- If an observation has uncertain side effects or ownership behavior, keep batchPolicy=never and omit it from batching.

DELIVERY
Ready-to-merge PR, no merge. NEXT_CARD=I1.
```
