<!-- Read docs/dev-agent-hardening-cards/README.md first. This card is subordinate to ENGINEERING_PROCESS_GUARDRAILS, improving-agent, and preflight. -->

# CARD H1 — Canonical static tool metadata registry

**Purpose:** remove future drift between public names, prompt contracts, RPC/client mapping and operation classification without building a plugin framework.  
**Expected difficulty:** 4–5/10.

## Prompt

```text
Repository: rhgrive3/hex
CARD: H1
BRANCH: dev-agent-hardening/h1-tool-registry

PRECONDITION
CARD H0 parity gate is merged and green. CARD G is merged/present.

MISSION
Move duplicated Dev tool identity/schema/classification metadata into one small static registry, then derive existing projections where practical. Preserve all existing public tool names and behavior. The registry must also identify the owning capability/runtime boundary and whether a tool is explicitly eligible for the later bounded observation-batch card.

FIRST
Use the H0 parity test as the migration safety net. Run it before editing and confirm PASS.

REGISTRY LOCATION
Create exactly `js/ai/dev/protocol/dev-tool-contracts.js` unless that path already exists on current main with an equivalent canonical registry. Do not choose another location silently.

MINIMAL REGISTRY FIELDS
Each tool entry should carry only what current code actually needs:
- publicName
- rpcName? (only when RPC-backed)
- clientMethod / handler method identifier
- operationClass
- argumentContract representation used by the prompt/parity layer
- owner: stable identifier for the capability/runtime boundary that owns the observation or mutation
- batchPolicy: exactly `never` or `observation`

OWNER RULE
`owner` records where authority/evidence comes from; it is not a permission grant. Do not infer ownership from prose at call time if the canonical registry can state it directly.

OPERATION CLASSES
Use a small fixed set such as:
- control
- observation
- wait
- full-turn
- mutation
Operation class is metadata only in this card. It never grants permission, and H1 MUST NOT change current RPC/runtime timeout behavior.

BATCH POLICY
This card does NOT add a batch tool. It only makes eligibility explicit for CARD H2.
- default/fallback is `never`;
- `observation` may be assigned only to a read-only/idempotent observation whose normal handler can be invoked without changing repository/runtime/DOM ownership state;
- operationClass other than `observation` MUST use `never`;
- uncertainty => `never`;
- do not infer batch eligibility merely because a tool name sounds read-only.

MIGRATION TARGETS
Derive from the registry where technically safe:
- available public Admin tool names
- prompt argument-contract lines
- public Admin client mapping
- RPC/client mapping metadata or parity source
- operation-class metadata projection
- owner/batch-policy parity projection for tests

DO NOT
- create dynamic plugin loading
- create reflection/eval dispatch
- rewrite custom security-sensitive handlers into one giant generic handler
- rename tools
- alter tool permissions
- change RPC timeout behavior
- add new tools
- execute batched calls in this card

ALLOWED FILES
Before editing, list the smallest exact set needed from:
- js/ai/dev/admin/tool-surface.js
- js/ai/dev/protocol/dev-supervisor-prompt.js
- js/userscript/dev/parent-rpc.js
- js/ai/dev/protocol/dev-tool-contracts.js (new canonical static registry)
- tests/dev-agent/tool-contract-parity.mjs
If additional production files are required, stop and report why before editing them.

TESTS
- node tests/dev-agent/tool-contract-parity.mjs stays green
- unknown tool still rejected
- every exposed tool has canonical metadata
- every exposed tool has non-empty owner metadata
- prompt contracts still generated correctly
- RPC-backed mappings unchanged
- operation class tests prove every canonical entry uses one allowed class; H1 does not change runtime timeout behavior
- every non-observation entry has batchPolicy=never
- batchPolicy=observation is opt-in only; missing/unknown metadata fails closed to never
- npm run dev-agent:test

DELIVERY
Ready-to-merge PR, no merge. NEXT_CARD=H2.
```
