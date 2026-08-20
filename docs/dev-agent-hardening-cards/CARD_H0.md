<!-- Read docs/dev-agent-hardening-cards/README.md first. This card is subordinate to ENGINEERING_PROCESS_GUARDRAILS, improving-agent, and preflight. -->

# CARD H0 — Fix prompt/tool compatibility and add a parity gate

**Purpose:** remove known prompt drift before splitting prompt modes or refactoring metadata.  
**Expected difficulty:** 3–4/10.

## EXPECTED ALLOWED FILES

```text
js/ai/dev/protocol/dev-supervisor-prompt.js
js/ai/dev/admin/tool-surface.js
js/userscript/dev/parent-rpc.js
tests/dev-agent/tool-contract-parity.mjs
package.json
```

Do not refactor into a registry yet.

## Prompt

```text
Repository: rhgrive3/hex
CARD: H0
BRANCH: dev-agent-hardening/h0-tool-parity

PRECONDITION
Completion/timeout/trace cards are merged/present.

MISSION
Fix the already-known drift between the Supervisor prompt and the current tool inventory, then add a regression that prevents silent drift. Do not perform the registry refactor yet.

READ EXACTLY
- js/ai/dev/admin/tool-surface.js
- js/userscript/dev/parent-rpc.js
- js/ai/dev/protocol/dev-supervisor-prompt.js
- relevant existing tests

KNOWN CURRENT DRIFT TO VERIFY BEFORE EDITING
- worker.graph.* can be exposed by the Admin surface
- prompt tool argument-contract lines omit graph contracts
- prompt still contains stale fixed-single-slot language despite installed pool/graph capability being represented by availableTools
- pool provision example hard-codes size:6 even though max-6 is capacity, not an always-optimal target

IF ANY OF THESE ARE ALREADY FIXED
Do not re-fix them. Adapt the parity test to current source and report baseline drift only if the architecture materially changed.

IMPLEMENT COMPATIBILITY FIX
1. Add argument-contract descriptions for all currently exposed worker.graph.* tools.
2. Remove/replace stale unconditional single-slot statements so wording is conditional on actual available tool inventory.
3. Keep maxWorkers=6 as a capacity statement, not a requirement to provision/use six for every task.
4. Do not change runtime tool names or RPC methods.

ADD PARITY REGRESSION
Create `tests/dev-agent/tool-contract-parity.mjs`. It must fail if an exposed public Dev/Admin tool silently loses required name/mapping/prompt coverage. At minimum check, where applicable:
- public Admin tool name exists
- corresponding client/dispatch path exists for RPC-backed tools
- prompt argument contract exists for tools that need arguments

Do not invent a temporary production operation-class table in H0. Operation-class metadata becomes canonical in H1. H0 only builds the green name/mapping/prompt parity safety net.

STANDARD GATE
Add `node tests/dev-agent/tool-contract-parity.mjs` to the existing `dev-agent:test` script in package.json. Preserve all existing entries.

IMPORTANT
H0 establishes a green safety net. Do NOT create the canonical registry in this card.

TESTS
- node tests/dev-agent/tool-contract-parity.mjs
- npm run dev-agent:test
- any direct parent-RPC/Admin-surface test affected by the change

DIFF CHECK
Only listed compatibility/test files may change.

STOP CONDITIONS
If parity reveals a real missing runtime dispatch rather than metadata drift, report it explicitly. Do not silently invent the handler.

DELIVERY
Ready-to-merge PR, no merge. NEXT_CARD=G.
```
