# Phase 10 — Fast + Safe Execution Policy

> **Purpose:** finish Phase 10 as fast as possible without weakening runtime identity, evidence, replay, protocol, or compatibility guarantees.  
> **Companion:** `docs/PHASE10_RUNTIME_PROVIDERS_IMPLEMENTATION_GUIDE.md`  
> **Normative authority:** `docs/HEX_MASTER_ARCHITECTURE.md`  
> **Reviewed baseline:** `e90c5107f9c77d73687ee452d5042dcbe9e79ece`  
> **Review:** fourth pass, optimized specifically for execution speed + safety.

This document does not replace the full implementation guide. It defines the shortest safe execution path through it.

---

## 1. Optimization target

The goal is not the fewest commits or the fewest tests.

The goal is:

```text
minimum wall-clock completion time
subject to:
  no identity regression
  no evidence/truth regression
  no stale-session publication
  no silent event loss
  no protocol-v1 safety regression
  no cross-version ambiguity regression
  no big-bang cutover
```

The main avoidable cost is **serial waiting**: PR review, CI queueing, rebases, and workers waiting for contracts that do not actually block their work.

---

## 2. Fourth-review finding

The full guide is intentionally conservative and serializes P10.0 through P10.4.

That is safe, but it is slower than necessary.

The provider contract and the minimal `RuntimeEvent` envelope are tightly coupled: a provider session needs to expose events, and an event needs provider/session identity. Keeping their contract definitions in separate serial PRs creates placeholder APIs and another CI/merge boundary without buying much isolation.

The evidence bridge, however, can remain a separate implementation because it owns the critical static/runtime trust boundary.

### Revised critical path

```text
P10.0  baseline oracle
  |
  v
P10.1  runtime target/module binding + address resolution
  |
  v
P10.2C provider/session + minimal RuntimeEvent CONTRACT
  |
  +-------------------+-------------------+-------------------+
  |                   |                   |                   |
  v                   v                   v                   v
Evidence bridge    TraceProvider      Provider protocol   Debugger compat
  |                   |                   |                   |
  |                   +---------+---------+                   |
  |                             |                             |
  +-----------------------------+-----------------------------+
                                |
                     Instrumentation / Emulator
                                |
                                v
                         integration/final gates
```

`P10.2C` combines only the **contract surface** of the old P10.2/P10.3 plan. It does not combine all implementations into a large PR.

---

## 3. What must remain serial

Only the contracts with high fan-out stay on the critical path.

### Serial 1 — P10.0 baseline oracle

Freeze current behavior before refactoring:

- canonical identity;
- canonical evidence semantics;
- runtime adapter/session behavior;
- protocol v1 epoch/cancel/backpressure behavior;
- cross-version replay rejection;
- cross-binary/slice stale-state rejection.

No provider production implementation is required here.

### Serial 2 — P10.1 identity/mapping

Freeze:

- canonical `RuntimeSessionId` use;
- `RuntimeTargetBinding`;
- session-scoped `RuntimeModuleBinding`;
- load/unload generation;
- typed `RuntimeAddressResolution`;
- exact/resolved/ambiguous/unresolved/mismatch semantics.

This must land before runtime/static mapping work fans out.

### Serial 3 — P10.2C provider + event contract

Freeze only:

- provider descriptor/version shape;
- provider session ownership;
- facet discovery vocabulary;
- minimal `RuntimeEvent` envelope;
- session/epoch/stream/sequence fields;
- module-binding-generation reference;
- observation mode;
- canonical completeness mapping input;
- explicit gap/drop representation;
- cancellation/resource-budget hooks.

Do not put real LLDB/Frida/device integration into this PR.

**After P10.2C merges, parallel work begins.**

---

## 4. What can start in parallel after P10.2C

### Lane A — Evidence bridge

Owns:

- RuntimeEvent -> runtime evidence conversion;
- validated static entity attachment;
- canonical `EvidenceId` / `EvidenceGraph` convergence;
- support/contradict/refine edges;
- intervention lineage;
- completeness propagation;
- unresolved runtime-only evidence.

**Safety rule:** until Lane A lands, other lanes may emit normalized runtime events but MUST NOT invent their own static-attachment logic.

### Lane B — TraceProvider

Can proceed independently because it is read-only and deterministic.

Owns:

- trace import validation;
- immutable event streaming;
- order/gap/completeness preservation;
- module-binding replay;
- deterministic normalized replay.

Static linking waits for Lane A.

### Lane C — provider remote protocol

Owns:

- provider handshake;
- facet/capability negotiation;
- generic session lifecycle;
- event batches;
- cancellation/deadlines;
- malformed/downgrade/method-confusion rejection;
- v1 compatibility route.

Use a fake provider. Do not wait for a real debugger backend.

### Lane D — Debugger compatibility provider

Wrap existing `DebugAdapter`/LLDB-compatible behavior behind the new provider contract.

Do not rewrite backend functionality unless a contract mismatch proves it necessary.

### Lane E — Instrumentation compatibility scaffold

Map current Frida-compatible capabilities into the provider/session/event model.

Keep first-class probe/intercept/replacement semantics additive. Do not make this lane block Trace/Protocol/Debugger work.

### Lane F — Emulator scaffold

Wrap current local/emulator/symbolic execution paths behind the provider contract.

Static evidence integration waits for Lane A.

---

## 5. Fast-safe CI policy

Do not run the entire repository suite after every tiny edit locally. Run the smallest gate that can detect the class of regression being introduced, then run broader gates at integration boundaries.

This does **not** disable GitHub-required CI. It prevents workers from redundantly spending time on unrelated full-suite runs before pushing a narrow change.

### Tier 0 — inner loop

Run the exact changed contract/provider test(s).

Examples:

```text
identity/mapping edit
  -> phase10 identity + address-resolution tests

RuntimeEvent edit
  -> phase10 runtime-event + session-lifecycle tests

protocol edit
  -> protocol-specific phase10 tests + existing remote protocol cases

evidence edit
  -> evidence-bridge + existing runtime evidence fusion/core evidence tests
```

No claim of merge readiness at Tier 0.

### Tier 1 — narrow PR gate

For additive Phase 10 contract/provider PRs, require the relevant subset plus existing oracles.

Core runtime-contract default:

```bash
npm run core:test
npm run runtime:test
npm run migration:test
```

Also run the new Phase 10 aggregate/subsuite for the changed area.

### Tier 2 — cross-boundary PR gate

Required when a change crosses identity/evidence/static/protocol/public-facade boundaries:

```bash
npm run core:test
npm run runtime:test
npm run migration:test
npm run invariants:test
npm run integration:test
```

Examples:

- RuntimeEvent -> EvidenceGraph bridge;
- RuntimeAnalysisPlatform cutover;
- provider protocol public routing;
- static entity attachment;
- compatibility facade migration.

### Tier 3 — integration checkpoint / final gate

Run the broad repository gate at deliberate integration checkpoints and before final Phase 10 completion:

```bash
npm run check
```

Do not require every leaf provider PR to repeat a local full `npm run check` when GitHub CI and a later integration checkpoint will cover the untouched repository surface.

### Never skip these due to speed

Any change touching the corresponding contract must run its negative oracle for:

- wrong binary/slice/module generation;
- stale epoch/session;
- cancellation race;
- event gap/truncation;
- cross-version ambiguity;
- protocol malformed/downgrade handling;
- runtime evidence -> static mutation guardrail.

These are correctness tests, not optional soak tests.

---

## 6. Merge/branch policy for low conflict

### Critical-path PRs

Use a short dependency chain only for:

```text
P10.0 -> P10.1 -> P10.2C
```

Prefer merging each before the next contract becomes authoritative.

### Fan-out PRs

After P10.2C:

- branch each lane from the same merged contract baseline;
- avoid editing another lane's provider implementation;
- keep shared contract changes in dedicated small contract PRs;
- if a lane discovers a contract defect, fix the contract once, then rebase all affected lanes;
- do not independently patch the same contract in multiple lanes.

### Avoid long stacked implementation chains

Do not stack Trace -> Protocol -> Debugger -> Instrumentation simply to keep workers busy. That converts independent work into serial conflict debt.

---

## 7. Fake-provider-first rule

The fastest safe path must not depend on a real device, LLDB daemon, Frida installation, signing state, JIT availability, or remote network target for core correctness.

P10.0/P10.1/P10.2C and the core of Evidence/Trace/Protocol must be testable with:

- deterministic fake provider;
- deterministic module maps;
- deterministic event batches;
- deterministic malformed payloads;
- deterministic trace fixtures.

Real backends validate integration. They do not define the core contract.

This removes external setup from the critical path.

---

## 8. Minimum contract: freeze less, not more

To move fast, only freeze fields whose churn would fan out across lanes.

Freeze early:

```text
RuntimeSessionId ownership
provider id/version
facet identity
session/epoch
RuntimeModuleBindingKey + generation
RuntimeEvent envelope
address-resolution states
completeness/gap semantics
intervention reference semantics
failure categories
```

Defer:

```text
final directory layout
provider protocol marketing/name
nonessential metadata fields
UI presentation fields
backend-private options
transport choice
real-device deployment details
```

Do not turn documentation examples into accidental ABI unless tests/ADR explicitly make them contractual.

---

## 9. Change-budget rule

A Phase 10 PR should have one primary trust boundary.

Examples of good boundaries:

```text
identity/mapping
provider/event contract
canonical evidence bridge
trace import/replay
provider protocol
Debugger compatibility
Instrumentation semantics
Emulator semantics
```

If a PR changes two unrelated trust boundaries, split it unless splitting would require a temporary unsafe state.

Do not combine:

- identity redesign + UI redesign;
- protocol replacement + debugger backend rewrite;
- evidence migration + static IR changes;
- provider abstraction + mass file moves.

---

## 10. Stop-the-line conditions

Speed work stops immediately for these findings:

1. wrong binary/slice/module generation can attach to static entity;
2. stale event/response can publish after close/new epoch;
3. dropped events can still produce complete evidence;
4. runtime observation can mutate static semantic truth directly;
5. cross-version match can bypass confidence/ambiguity gate;
6. intervention ancestry is lost;
7. protocol v1 loses an existing validation/backpressure/cancellation bound;
8. provider-controlled identity assertion is accepted without verification;
9. a new uncancellable/unbounded stream enters browser/UI path;
10. compatibility path is removed before differential replacement is green.

These are blockers because continuing would make later parallel work build on an unsafe contract.

---

## 11. Non-blocking findings

Do not stall the whole Phase 10 campaign for:

- UI polish;
- provider-specific optional metadata;
- real-backend feature parity not required by the current lane;
- performance tuning before a measured regression exists;
- file/directory cleanup;
- naming bikeshedding that does not affect serialized/public contracts;
- one unavailable external backend while fake-provider contract tests are green.

Track them, but keep the critical path moving.

Final Phase 10 completion still requires the canonical real-provider deliverables and exit gates; this rule only prevents optional integration details from blocking unrelated contract work.

---

## 12. Evidence/static attachment ownership

To prevent parallel lanes from implementing subtly different trust rules:

```text
ONLY the evidence/mapping layer owns:
RuntimeEvent -> RuntimeEvidence -> static entity attachment
```

Providers may report:

- addresses;
- module bindings;
- provider evidence;
- events;
- capabilities.

Providers may not independently declare:

```text
this runtime PC definitively equals FunctionId X
```

without passing through the shared resolver/evidence route.

This single ownership rule is what makes early parallelization safe.

---

## 13. RuntimeEvent compatibility rule

`RuntimeEvent` should be additive and versionable.

During migration:

- preserve unknown provider-specific payload under a bounded inert-data field when policy permits;
- reject malformed required envelope fields;
- do not execute or reinterpret unknown fields;
- do not require all providers to support every event kind;
- allow compatibility adapters to project legacy events into the new envelope;
- keep event transport separate from durable canonical evidence.

This avoids blocking one provider because another provider has richer events.

---

## 14. Worker/task ownership model

After P10.2C, parallel workers should receive **non-overlapping primary ownership**.

Recommended ownership:

```text
Worker A: evidence bridge + static attachment
Worker B: TraceProvider + replay fixtures
Worker C: provider remote protocol
Worker D: Debugger compatibility provider
Worker E: Instrumentation provider
Worker F: Emulator provider
```

Shared-contract changes are not casually edited by all workers. Route them through one small contract change.

Each worker reports:

```text
contract consumed
files changed
negative case added
compatibility behavior preserved
commands run
known unsupported behavior
whether shared contract change is required
```

---

## 15. PR completion packet

A Phase 10 PR is review-ready when its description answers these seven items:

1. **Trust boundary changed:** what contract changed?
2. **Old behavior preserved:** which compatibility route remains?
3. **Identity rule:** what proves runtime/static identity?
4. **Negative counterexample:** smallest case that would fail if the implementation is wrong.
5. **Completeness/loss behavior:** what happens on partial/truncated input?
6. **Cancellation/lifecycle:** what happens on abort/close/epoch change?
7. **Tests actually run:** exact commands and result.

This reduces reviewer rediscovery time and prevents “looks fine” merges on correctness-critical runtime code.

---

## 16. Smallest counterexamples to require early

Use minimal deterministic cases instead of large integration traces wherever possible.

### Identity

```text
module A: base 0x1000, generation 1, BinaryId A
unload A
module B: base 0x1000, generation 2, BinaryId B
runtime PC = 0x1010
```

Expected: no stale attachment to A.

### Cross-version

```text
old FunctionId @ 0x2000
new unrelated function @ 0x2000
```

Expected: same VA gives zero identity authority.

### Event loss

```text
seq 10
seq 12
```

When provider semantics claim contiguous sequence, expected: explicit gap/partial state.

### Stale epoch

```text
request epoch 4
session advances to epoch 5
old success arrives
```

Expected: old success cannot publish.

### Intervention

```text
write x0 = 7
observe branch B
```

Expected: branch observation retains intervention ancestry.

### Protocol confusion

```text
facet = trace
method = debugger.writeMemory
```

Expected: reject, never reinterpret.

These tests are cheap and catch high-severity mistakes early.

---

## 17. Fast integration order

Recommended merge order after fan-out:

```text
1. Evidence bridge
2. TraceProvider
3. provider protocol
4. Debugger compatibility provider
5. Instrumentation provider
6. Emulator provider
7. RuntimeAnalysisPlatform/public-facade cutover
8. final adversarial + browser budget gate
```

This is a default, not an artificial dependency chain. Independent green lanes may merge earlier if they are additive and do not claim static attachment before the evidence bridge.

Trace is useful early because deterministic replay becomes a common fixture source for later lanes.

---

## 18. Cutover policy

No big switch.

For each migrated route:

```text
legacy route
  + new provider route
  + differential fixture
  -> compare
  -> make new route default only after equivalence/safety passes
  -> retain rollback path until next integration checkpoint
```

Remove a compatibility path only when:

- all known consumers migrated;
- differential tests are green;
- no open blocker depends on it;
- rollback no longer requires it;
- removal is a separate reviewable change when practical.

---

## 19. CI queue discipline

Do not create meaningless commits just to restart queued CI.

When CI is queued/in progress:

- continue independent local/branch work;
- do not mutate a green candidate solely to obtain a new run;
- distinguish infrastructure cancellation from test failure;
- rerun/change code only after a concrete failure is observed;
- use the exact head SHA when deciding whether a result belongs to the candidate being reviewed.

This prevents CI churn from becoming a self-inflicted critical path.

---

## 20. Final fast-safe checklist

Before starting a Phase 10 implementation lane:

- [ ] branch baseline is current enough for the contract being consumed;
- [ ] P10.0 oracle exists;
- [ ] P10.1 identity/mapping contract is available;
- [ ] P10.2C provider/event contract is available for fan-out lanes;
- [ ] worker owns one primary trust boundary;
- [ ] smallest negative counterexample is known before coding;
- [ ] fake-provider/fixture path exists where possible;
- [ ] test tier for this PR is known;
- [ ] rollback/compatibility route is known;
- [ ] no other lane is independently changing the same shared contract.

Before merge:

- [ ] applicable stop-the-line cases are green;
- [ ] relevant existing oracle tests are green;
- [ ] Phase 10 targeted tests are green;
- [ ] broader Tier 2/3 gate was run when boundary scope requires it;
- [ ] no static attachment bypasses shared evidence/mapping layer;
- [ ] no event loss is hidden;
- [ ] no stale lifecycle result can publish;
- [ ] PR completion packet is filled with exact evidence.

---

## 21. Fourth review conclusion

The Phase 10 architecture itself does not need another conceptual redesign.

The fastest safe change is execution strategy:

```text
OLD conservative critical path:
P10.0 -> P10.1 -> P10.2 -> P10.3 -> P10.4 -> fan out

RECOMMENDED fast-safe critical path:
P10.0 -> P10.1 -> P10.2C(provider + event contract) -> fan out
                                                |
                                                +-> shared evidence bridge remains sole static-attachment authority
```

This removes unnecessary serial merge/CI boundaries while keeping the highest-risk runtime/static trust boundary centralized.

The campaign should optimize for **small deterministic counterexamples, additive compatibility, fake-provider-first tests, risk-tiered CI, and one owner per shared contract**. That is the shortest path to completing Phase 10 quickly without turning runtime evidence into an unreviewable second truth system.
