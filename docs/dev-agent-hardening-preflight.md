# Dev Agent Hardening Preflight — Difficulty-Reduction Implementation Map

**Status:** implementation preflight; non-normative where it conflicts with `docs/ENGINEERING_PROCESS_GUARDRAILS.md` or `docs/improving-agent.md`  
**Repository:** `rhgrive3/hex`  
**Primary platform:** iOS / iPadOS WebKit  
**Baseline reviewed:** `291b91192b07bcd8b1995d7b1b5aba5734cde902`  
**Goal:** make the v2.3 Dev-Agent hardening materially easier to implement without weakening any final invariant, evidence requirement, or target-device behavior.

---

## 0. Executive decision

Do **not** implement the v2.3 hardening as one subsystem rewrite.

The key discovery is that the hardest-looking primitive already exists in **two** useful forms:

- `IframeWorkerPool.start()` already retains the active Worker turn as `slot.pending`;
- when that Promise settles, the Pool retains the terminal value as `slot.lastResult`;
- therefore a caller that begins waiting **after** completion can still read the retained result;
- `DedicatedWorkerCoordinator` also owns a bounded event queue (`EVENT_QUEUE_LIMIT = 128`) and queued-first `waitEvent()`, which remains useful for explicit `wait(events)`/notification surfaces;
- `IframeWorkerPool` already gives every claim a fresh `leaseId`, `runId`, and `workerId`;
- `DynamicTaskGraph` is already the single scheduler and already owns task attempt counts, cancellation, dependency state, and lease cleanup.

Therefore the Graph completion work does **not** require a new event system and does not even require the Coordinator event queue on the hot path. The minimal production primitive is a cancellation-aware Pool wait over the already-owned `slot.pending` Promise with `lastResult` fallback and post-wait lease revalidation.

The lowest-risk implementation path is:

```text
contract/parity tests
-> add Pool waitResult() over pending + retained lastResult
-> switch DynamicTaskGraph from 50 ms result polling to Pool waitResult()
-> optionally expose graph/pool wait tools for Supervisor-level yielding
-> harden timeout semantics
-> add bounded identity-aware trace
-> compact Supervisor prompt/context
-> converge tool metadata onto one registry
-> proceed with Project Automation
```

No new scheduler, Worker runtime, iframe layer, background Memory Agent, Context service, vector database, or additional model call is required.

---

## 1. Preserve these final outcomes

Every slice below is constrained by the following migration laws.

### 1.1 Behavior laws

- Existing public tool names remain valid unless an explicit later migration replaces them.
- Existing graph states remain valid.
- `activeWorkers <= 6` remains invariant.
- Worker nesting remains forbidden.
- Existing cancellation/lease cleanup remains fail-closed.
- Generated/runtime identity and activation gates are unchanged.
- Standard Agent behavior remains isolated.
- Worker execution success remains distinct from Supervisor acceptance.
- Project identity remains distinct from conversation identity.
- No new polling loop may be introduced to compensate for a missing event.
- No final implementation may depend on desktop-only browser behavior.

### 1.2 Migration law

Every slice must be either:

1. **representation-only / no behavioral change**, or
2. protected by a minimal regression that fails on the old behavior and passes on the new behavior.

Do not combine completion delivery, timeout redesign, context compaction, tool-registry refactoring, and Project DOM automation in one PR.

### 1.3 Performance law

A lower token count, fewer DOM calls, or more Worker slots is not success by itself.

The final path must preserve or improve:

- task success;
- exact evidence;
- cancellation correctness;
- lease ownership;
- retry correctness;
- target-device responsiveness;
- total makespan or observed critical-path latency.

---

## 2. Current implementation map

### 2.1 Existing completion primitive in the Pool

`js/userscript/dev/frame-mesh/iframe-worker-pool.js`

`start()` already creates and retains the exact Promise representing the active Worker turn:

```text
slot.pending = Promise<WorkerResult>
```

and its settlement handler writes:

```text
slot.lastResult = terminal result
slot.pending = null
```

This means the Pool already has both sides required for lossless in-runtime completion:

```text
before completion -> pending Promise
after completion  -> retained lastResult
```

A wait registered late does not need an event replay if it can observe the same lease and read `lastResult`.

### 2.2 Existing event primitive

`js/userscript/dev/frame-mesh/dedicated-worker-coordinator.js`

Already provides:

```text
events[]                  bounded queue
waiters                   pending waits
waitEvent()               queued-first, then wait
lastResult                retained coordinator result
pendingTerminal           one active terminal wait
worker.completed
worker.failed
worker.cancelled
```

This is valuable for explicit event APIs, but **do not route Graph completion through an extra event layer unless needed**. The Pool's own `pending + lastResult` state is a smaller hot-path dependency.

### 2.3 Current polling point

`js/userscript/dev/task-graph/dynamic-task-graph.js`

Current graph waiting:

```text
while true:
    workerPool.result()
    if terminal -> return
    if elapsed >= task.timeoutMs -> timeout
    sleep(50 ms default)
```

This is the principal long-turn polling debt.

### 2.4 Existing identity

The pool already has enough authority to prevent most stale-result mistakes:

```text
leaseId       fresh pool lease
runId         fresh Worker claim identity
workerId      fresh Worker identity
taskId        logical task association
slot          physical/logical pool slot
```

The graph already has:

```text
graphId
task.id
task.attempts
```

Do not invent another global identity layer.

For completion authority:

```text
authoritative attempt identity =
    leaseId + pool runId + workerId
```

For diagnostics/handoff:

```text
graphId + taskId + attempt
```

The graph metadata is useful context; the lease/claim identity is the stale-delivery authority.

### 2.5 Important microtask/settlement rule

Do not implement:

```text
wait for coordinator event
-> immediately call workerPool.result()
```

as the only Graph path.

The coordinator can emit its terminal event immediately before the Pool's `slot.pending` settlement handler clears `pending` and copies `lastResult`. A higher layer that wakes on that event and calls the current `workerPool.result()` can transiently see `working`.

The Pool-level wait primitive must therefore own settlement ordering itself. Waiting on the captured `slot.pending` Promise avoids this race by construction.

---

## 3. Slice A — Contract and parity harness only

**Difficulty:** 2/10  
**Behavior change:** none  
**Purpose:** make later changes mechanically safer.

### 3.1 Add invariant fixtures before code changes

Add focused fixtures for:

1. completion before `waitResult()` registration;
2. completion while `waitResult()` is waiting;
3. multiple Worker completions concurrently;
4. release/reclaim makes an old wait/result fail closed against the new lease;
5. retained result is readable after completion until release;
6. cancellation remains distinguishable;
7. aborting a wait does not silently release/reuse the Worker;
8. graph `SUCCEEDED` is not represented as Supervisor acceptance anywhere in the new handoff type.

For the explicit Coordinator event surface, retain direct fixtures for:

- completed-before-`waitEvent`;
- wait-then-complete;
- stale old `runId` not matching a new claim.

These tests protect the event API without forcing Graph to depend on it.

### 3.2 Test one boundary at a time

First prove Pool `pending + lastResult` semantics directly. Then modify Graph.

Do not start with an end-to-end chain involving:

```text
DOM -> WorkerChatController -> Coordinator -> Pool -> Graph -> RPC -> Supervisor
```

when the first production change only needs:

```text
Pool -> Graph
```

### 3.3 Defer tool parity until the known prompt drift is fixed

Do not add a merge-blocking parity test that is known to fail current `main` and then carry it as an expected failure.

Before the later registry refactor, make one small compatibility PR that **simultaneously**:

- fills the currently missing `worker.graph.*` prompt argument contracts;
- removes stale fixed-single-slot wording where active tool inventory is authoritative;
- changes the fixed `size: 6` example into capacity/effective-concurrency wording;
- adds a parity regression comparing public Dev/Admin tool names, RPC/client mappings, prompt argument-contract coverage, and operation-class coverage.

That PR establishes a green safety net before metadata is moved.

**Exit condition:** completion-state fixtures green with production behavior unchanged; tool-parity work is explicitly deferred to its own green compatibility PR.

---

## 4. Slice B — Add one Pool wait primitive

**Difficulty after preflight:** 2–3/10  
**Behavior change:** additive only.

### 4.1 Preferred internal API

Add a narrow method such as:

```text
workerPool.waitResult({ leaseId }, { signal })
```

Do not add a general event bus.

### 4.2 Algorithm

```text
1. resolve leaseId -> current slot
2. snapshot:
      leaseId
      runId
      workerId
      taskId
      slot
3. capture pending = slot.pending

4. if pending exists:
      await Promise.race(
        pending,
        abort signal
      )

5. revalidate that leaseId still owns the same
      slot/runId/workerId

6. return slot.lastResult
   or, only if needed, the coordinator's retained result
```

If `pending` is already null because completion happened before the wait, return retained `lastResult` after identity validation.

### 4.3 Cancellation semantics

Aborting `waitResult()` stops **the wait**, not ownership by itself.

The caller (Graph cleanup/cancellation path) remains responsible for:

```text
stop active Worker if needed
-> release
-> discard on ambiguous cleanup
```

This preserves the existing ownership transaction instead of hiding cleanup inside the wait helper.

### 4.4 Why this is stronger than polling

It handles all normal orderings without repeated reads:

```text
wait before completion -> await the same Promise
wait after completion  -> read retained lastResult
```

No scanning cadence exists, so iOS work during a long model turn approaches zero at the Graph layer.

### 4.5 Identity revalidation is mandatory

A concurrent release/reclaim must not let the old wait return as the new owner.

After await, verify:

```text
current leaseId == expected leaseId
current runId   == expected runId
current workerId == expected workerId
```

Otherwise fail with a typed stale/lease error.

### 4.6 Optional external surfaces

Only after the internal primitive is green, consider additive wait tools:

```text
worker.pool.wait_result   // one lease
worker.graph.wait         // one graph
```

A blocking host-side wait tool is acceptable because the LLM is not sleeping; the host is awaiting a cancellable Promise.

Do not expose these merely to increase tool count. Add them when they remove Supervisor polling or repair an actual resume path.

**Exit condition:** Pool completion can be awaited once with zero long-turn polling and with completed-before-wait covered by retained state.

---

## 5. Slice C — Replace Graph result polling with `waitResult()`

**Difficulty after Slice B:** 2–3/10  
**Behavior change:** same terminal outcomes, different waiting mechanism.

### 5.1 Replace only `waitForWorkerResult`

Do not modify dependency scheduling, retry logic, graph state transitions, or cleanup in the same change.

New conceptual flow:

```text
claim
-> create chat
-> start
-> waitResult(lease)
-> existing workerSucceeded()/failure mapping
-> existing cleanup
```

### 5.2 Multiple completion behavior

Each active `executeTask()` awaits its own lease Promise.

The Graph's existing:

```text
Promise.race(this.active.values())
```

already wakes the scheduler when any active task finishes.

Six Workers completing together therefore require no central completion scan and no new scheduler primitive.

### 5.3 Retry behavior

The next attempt receives a new lease/run identity.

An old attempt cannot satisfy the new attempt because `waitResult()` is bound to the captured lease identity and revalidates after await.

### 5.4 Keep retained result semantics

Do not consume/delete `lastResult` merely because `waitResult()` returned.

The existing release transaction remains the cleanup boundary.

This preserves audit/debug access and makes repeated read-only observation idempotent.

### 5.5 Public graph wait is separate

The internal Graph loop can become event/Promise-driven without changing the Supervisor protocol.

If the Supervisor itself currently needs to poll `worker.graph.status`, add `DynamicTaskGraphHost.wait({graphId}, {signal})` in a later additive change:

```text
if graph terminal -> return status immediately
else await graph.loopPromise
-> return final status
```

Then optionally expose `worker.graph.wait`.

Do **not** entangle that public-tool addition with the first Graph polling-removal diff.

**Exit condition:** existing Dynamic Task Graph behavior remains green, and long Worker generation causes no periodic Graph `result()` calls.

---

## 6. Slice D — Explicit event/resume bridge only where actually required

**Difficulty:** 3–4/10  
**Default:** skip if `waitResult()` / `graph.wait()` fully satisfy the production workflow.

The existing Coordinator queue already supports `wait(events)` semantics. Use it only for a caller that genuinely needs event selection rather than completion awaiting.

### 6.1 Reuse, do not rebuild

If an external Supervisor flow specifically needs:

```text
wait(["worker.completed", ...])
```

for pooled Workers, adapt the existing Coordinator `waitEvent()` through the Pool with lease/run filtering.

Do not create a second event store.

### 6.2 Pool event envelope

If this surface is needed, keep it small:

```text
PoolWorkerEvent {
  type
  observedAt

  leaseId
  slot
  taskId

  poolRunId
  workerId

  data
}
```

No prompt or response text belongs in the event.

### 6.3 Avoid the settlement race

The event is a wakeup, not the Pool-result authority.

After an event wakes the Pool adapter, await/verify the same Pool turn settlement before returning a terminal result to a caller.

### 6.4 Stale event behavior

The existing Coordinator filters by `runId`; a reclaimed slot gets a new Pool run ID.

The Pool wrapper must additionally validate the lease after await.

**Exit condition:** only if required, explicit event waiting works before/after registration without continuous polling. Otherwise leave this slice unimplemented.

---

## 7. Slice E — Timeout semantics without liveness reinvention

**Difficulty:** 4–5/10  
**Do not combine with the first Graph wait conversion.**

The first Promise-driven Graph PR should preserve existing explicit timeout behavior so completion transport can be reviewed independently.

Then fix timeout semantics.

### 7.1 Separate explicit deadline from default model-turn waiting

Desired representation:

```text
timeoutMs = null     // no generic model-turn deadline
timeoutMs = N        // explicit caller-owned deadline
```

Do not silently interpret a default three-minute wall clock as proof of stall.

### 7.2 Keep cancellation mechanics

For an explicit deadline:

```text
deadline expires
-> abort waitResult()
-> existing stop
-> existing cleanup
-> task-timeout
```

For no explicit deadline:

```text
wait Promise-driven until terminal/cancel/recovery policy acts
```

### 7.3 Do not build Phase-5 liveness here

No new `ACTIVE/QUIET/SUSPECTED_STALL/...` state machine is needed merely to remove the generic timeout.

Phase-5 recovery may later add multi-signal liveness on top of the new wait primitive.

**Exit condition:** a normal long model turn is not failed merely because a default wall clock elapsed; explicit task deadlines still work and clean leases.

---

## 8. Slice F — Lightweight critical-path trace

**Difficulty:** 3/10  
**Purpose:** tune iOS without guessing.

Only after completion transport is event-driven, add IDs/status/timestamps:

```text
TaskTrace {
  orchestrationRunId?
  graphId
  taskId
  attempt

  leaseId
  workerId
  slot

  graphReadyAt
  leaseClaimedAt
  promptSubmitAt
  completionDetectedAt
  resultParsedAt
  leaseReleasedAt

  outcome
}
```

Rules:

- bounded ring buffer;
- disabled or minimal by default;
- no full prompts;
- no full responses;
- no DOM snapshots;
- no extra polling;
- failure/benchmark runs may retain a bounded expanded trace.

This trace determines whether `effectiveConcurrency` should be 3, 4, 5, or 6 on real iPadOS.

---

## 9. Slice G — Supervisor prompt/context compaction

**Difficulty after decomposition:** 4/10

Do not begin by designing a new Context service.

### 9.1 Current safe starting point

The current prompt already bounds local history with:

```text
history.slice(-12)
```

Keep that as a compatibility baseline until the new representation is proven.

### 9.2 Two prompt modes

Use:

```text
BOOTSTRAP
CONTINUATION
```

**BOOTSTRAP**

Contains:

- full decision protocol;
- safety/trust boundary;
- current goal;
- current available tools + contracts;
- current runtime/campaign facts needed for the run;
- compact current context.

**CONTINUATION**

Contains:

- short protocol reminder;
- current goal/status;
- current available tool names;
- changed/new tool contracts only if the inventory changed;
- fresh history/context delta;
- unresolved blockers/required evidence.

Do not resend the entire fixed protocol prose every decision.

### 9.3 Safe continuity rule

Do not infer continuity merely from confidence.

Maintain an in-runtime set/map keyed by `supervisorSessionKey`.

Mark a key bootstrapped only after a successful request/response using the full bootstrap prompt.

Use CONTINUATION only while the same runtime still owns that proven session key.

Use BOOTSTRAP again when:

- runtime reinitializes/reloads;
- session key changes;
- bridge reports continuity loss;
- a recovery path cannot prove prior session continuity.

This is fail-safe: uncertainty costs tokens, not correctness.

### 9.4 ContextPacket migration in two stages

**F1 — representation-only**

Wrap the same information already sent today into a typed logical packet without more aggressive pruning.

**F2 — deterministic selection**

Then remove repetition using:

- refs instead of bulk evidence;
- deduplication;
- freshness;
- authority;
- covered evidence refs for summaries/compaction;
- explicit unknowns/negative evidence.

Do not use an LLM summarizer on the hot path.

### 9.5 Budget measurement

Use a cheap byte/character budget first.

Do not add a tokenizer dependency merely for context accounting on iOS.

Measure representative task success before tightening the budget.

---

## 10. Slice H — Tool contract single source of truth

**Difficulty:** 4–5/10 if done after parity tests; higher if done first.

### 10.1 First fix the failure mode, then refactor

The current failure mode is drift:

```text
public tool name
RPC method
client method
prompt argument contract
dispatch/handler
timeout behavior
```

are maintained separately.

The parity test from Slice A should fail before any future omission can silently ship.

### 10.2 Canonical registry shape

A minimal registry can carry:

```text
DevToolContract {
  publicName
  rpcName?
  clientMethod
  operationClass
  argumentContract
}
```

Suggested operation classes:

```text
control
observation
wait
full-turn
mutation
```

Operation class may drive timeout policy, but it must not silently grant permission.

### 10.3 Generate projections

From the registry, derive where technically practical:

- available tool names;
- prompt argument-contract lines;
- client mapping;
- public Admin surface mapping;
- operation-class timeout behavior;
- parity validation.

Do not create a dynamic plugin framework. This is static metadata.

### 10.4 Preserve implementation-specific handlers

If a handler needs custom logic, the registry points to the method/handler but does not force generic dispatch where generic dispatch would obscure security behavior.

"One source of truth" means one canonical identity/schema classification, not one giant function.

---

## 11. Slice I — Context/memory hardening only as needed

**Difficulty:** 3–4/10 with the v2.3 constraints.

No vector DB, Memory Agent, or background persistence service is required.

Implement only the pieces the current Dev flow can use:

```text
ContextPacket
WorkerResult
artifact/evidence refs
provenance
freshness
scope
coveredEvidenceRefs
retention metadata when durable storage exists
```

Promotion rule:

```text
Worker/DOM/tool output
-> evidence
-> owning-system verification when possible
-> optional durable fact
```

Never:

```text
Worker says X
-> permanent trusted instruction
```

For iOS, deterministic selection and refs are the default.

---

## 12. Exact regression matrix

### Completion transport

| Case | Required result |
|---|---|
| completion before waitResult | retained terminal result returned |
| completion while waitResult waits | same pending Promise settles once |
| failure before waitResult | retained failure result readable |
| cancellation while waiting | cancellation remains distinct |
| six simultaneous completions | six lease waits settle independently; no scan loop |
| repeated result observation | idempotent read; graph task transitions once |
| release then reclaim | old run event cannot satisfy new lease |
| retry after failed attempt | old attempt cannot satisfy new attempt |
| result after event | retained until release |
| release during active generation | refused |
| ambiguous cleanup | discard/quarantine behavior preserved |

### Graph

| Case | Required result |
|---|---|
| ready-only dispatch | unchanged |
| max concurrency | <= 6 |
| dependency failure | dependent BLOCKED |
| retry | exactly bounded attempts |
| cancel | active + pending tasks cancelled correctly |
| explicit timeout | timeout + stop/cleanup |
| no explicit timeout | no generic wall-clock failure |
| graph execution success | not represented as Supervisor acceptance |

### Prompt/context

| Case | Required result |
|---|---|
| first session turn | BOOTSTRAP |
| second proven same-session turn | CONTINUATION |
| new session key | BOOTSTRAP |
| runtime reload | BOOTSTRAP |
| continuity unknown | BOOTSTRAP |
| tool inventory changed | changed contracts supplied |
| untrusted Worker output | remains data |
| large evidence | ref/bounded excerpt |
| summary/compaction | covered evidence refs retained |

### Tool registry

| Case | Required result |
|---|---|
| public tool exposed | canonical contract exists |
| prompt lists tool | argument contract exists |
| RPC-backed tool | RPC/client mapping exists |
| full-turn tool | generic short transport timeout disabled |
| unknown tool | rejected |
| registry drift | test fails |

---

## 13. Recommended PR sequence

Use small mergeable PRs. Do not create a long-lived mega-branch.

### PR A — completion-state fixtures only

Likely paths:

```text
tests/dev-agent/*
```

No product behavior change. Do not introduce a known-failing tool-parity test here.

### PR B — Pool `waitResult()` adapter

Likely paths:

```text
js/userscript/dev/frame-mesh/iframe-worker-pool.js
tests/dev-agent/iframe-worker-pool.mjs
tests/dev-agent/iframe-worker-pool-cancellation.mjs
```

No new RPC/event surface required.

### PR C — Graph Promise-driven wait

Likely paths:

```text
js/userscript/dev/task-graph/dynamic-task-graph.js
tests/dev-agent/dynamic-task-graph.mjs
```

Do not change timeout defaults here unless required to keep the code coherent.

### PR D — Optional Graph/Pool public wait surface

Only if Supervisor-level polling remains after PR C. Prefer `worker.graph.wait` over wiring every pooled Worker event into the Supervisor.

### PR E — Full-turn timeout semantics

Likely paths:

```text
js/userscript/dev/task-graph/dynamic-task-graph.js
tests/dev-agent/dynamic-task-graph.mjs
```

### PR F — trace + measured concurrency support

Keep trace bounded and inert unless enabled.

### PR G — Supervisor prompt bootstrap/continuation

Likely paths:

```text
js/ai/dev/protocol/dev-supervisor-prompt.js
js/ai/dev/supervisor/dev-supervisor-engine-v0.js
tests/dev-agent/*
```

### PR H0 — prompt/tool compatibility + parity gate

Fix the already-known prompt/tool drift and add the green parity regression in the same change.

### PR H1 — canonical tool registry

Only after H0 is green. Move metadata under the parity safety net rather than changing behavior and structure at once.

### PR I — ContextPacket / WorkerResult representation

Begin representation-only; optimize selection in a later PR.

### Then Phase 4

Start Project read-only observation once the relevant runtime is activated. Do not wait for an elaborate memory subsystem.

---

## 14. Worker allocation for implementation

Do not fill six slots automatically.

For the hardest completion change:

```text
Worker 1  Pool event adapter implementation
Worker 2  completion-race fixture owner
Worker 3  Graph integration implementation
Worker 4  independent real-time reviewer
Worker 5  integration / moving-main owner
Worker 6  reserve / investigator
```

But **Worker 3 must not modify Graph until Pool contract/fixtures are frozen**.

For prompt/tool work, use a separate wave after completion transport merges; otherwise review causality becomes muddy.

---

## 15. What must NOT be built

The following would raise implementation difficulty without improving the required final product:

- a second event bus;
- a second task scheduler;
- a new Worker Pool;
- a general distributed consensus protocol;
- IndexedDB solely to deliver in-page Worker completion;
- a vector database for Dev memory;
- an always-on ContextBroker service;
- a Memory Agent;
- an LLM summarizer on every turn;
- more than six iframe Workers;
- a polling watchdog that scans all Workers continuously;
- a generic "stalled after N seconds" rule for full model turns;
- a Project-specific identity system that duplicates existing conversation/runtime identities;
- a large tool-plugin framework merely to deduplicate metadata.

---

## 16. Revised difficulty after this preflight

Before code inspection, completion durability looked like a new race-free event subsystem.

After mapping the current implementation:

| Work | Previous perceived difficulty | Preflight difficulty |
|---|---:|---:|
| completion delivery | 8/10 | **2–3/10** |
| Graph polling removal | 7/10 | **2–3/10** |
| timeout semantics | 6/10 | **4–5/10** |
| prompt delta mode | 5–6/10 | **4/10** |
| tool contract convergence | 5/10 | **4–5/10** |
| ContextPacket/WorkerResult | 5/10 | **3–4/10** |
| iOS trace/tuning | 5/10 | **3/10** |

The remaining risk is not algorithmic novelty. It is **migration correctness across existing identities and cleanup boundaries**.

That is precisely why the work is split into small contract-preserving slices.

---

## 17. Definition of ready for implementation

Implementation may begin when all are true:

- current `main` is refetched;
- v2.3 remains the canonical Dev-Agent contract;
- existing relevant PRs/issues are checked for overlap;
- completion fixture ownership is assigned;
- Pool event envelope is frozen;
- no public tool rename is required;
- no new scheduler/event subsystem is planned;
- exact changed-path expectations are written for the first PR;
- first PR is tests/parity or the smallest Pool adapter, not a mega-refactor.

---

## 18. Final target

The final architecture remains stronger than today's implementation while being simpler in the hot path:

```text
WorkerChatController
    emits terminal state
        |
DedicatedWorkerCoordinator
    Worker turn semantics / optional explicit event queue
        |
IframeWorkerPool
    pending Promise + retained result + lease-aware waitResult()
        |
DynamicTaskGraph
    awaits each lease Promise; no result scan loop
        |
Supervisor
    receives compact structured result
        |
Context assembly
    sends only fresh delta / refs
```

The final improvement should remove work rather than add background machinery:

```text
remove 50 ms long-turn polling
remove repeated fixed prompt text
remove duplicated tool metadata
remove broad transcript replay
keep exact evidence and identity checks
```

That is the implementation strategy that lowers difficulty **without lowering the final bar**.
