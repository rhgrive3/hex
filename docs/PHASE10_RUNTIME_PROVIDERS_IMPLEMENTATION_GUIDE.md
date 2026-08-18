# Phase 10 — Runtime Providers Implementation Guide

> **Status:** implementation planning guide / pre-coding contract  
> **Scope:** Phase 10 only  
> **Normative authority:** `docs/HEX_MASTER_ARCHITECTURE.md`  
> **Repository baseline reviewed:** `e90c5107f9c77d73687ee452d5042dcbe9e79ece`  
> **Review date:** 2026-08-18  
> **Primary constraints:** browser/iPad-first, evidence-first, compatibility-first, no big-bang rewrite  
> **Purpose:** remove the high-cost design ambiguity before Phase 10 implementation starts.

This guide is deliberately **non-normative**. If it conflicts with `docs/HEX_MASTER_ARCHITECTURE.md`, an accepted ADR, or a versioned canonical API/schema, the canonical source wins.

The repository is moving quickly. Before the first Phase 10 code PR, re-read the files in §3 against live `main`. Do not mechanically implement a stale checklist.

---

## 1. Phase 10 in one sentence

Phase 10 turns Hex's existing debugger/runtime/replay machinery into a **first-class Runtime Provider plane** in which Debugger, Instrumentation, Trace, and Emulator capabilities share canonical identity, lifecycle, event, evidence, cancellation, and compatibility rules without becoming a second semantic truth system.

The Master Architecture requires Phase 10 to deliver:

- a mature debugger provider;
- a Frida-compatible instrumentation provider;
- a trace provider;
- an emulator provider interface;
- a remote protocol.

The canonical exit gates are:

- runtime evidence identity binding;
- static/runtime fusion tests;
- replay/cross-version ambiguity gates.

The critical implementation fact is that Phase 10 is **not greenfield**. Current `main` already contains substantial debugger adapters, LLDB/Frida-compatible paths, replay, runtime experiments/evidence, protocol hardening, trace completeness handling, cancellation/epoch logic, and a cross-version replay ambiguity gate. Phase 10 must consolidate and generalize those mechanisms rather than recreate them.

---

## 2. Source-of-truth hierarchy for Phase 10

When implementation choices disagree, use this order:

1. `docs/HEX_MASTER_ARCHITECTURE.md`;
2. accepted ADRs;
3. versioned canonical APIs/schemas;
4. current source + executable tests;
5. this guide;
6. research/reference material.

This matters especially for identity. Phase 10 MUST NOT invent a parallel stable-ID universe merely because runtime data has different shapes.

### 2.1 Canonical IDs already owned by core architecture

Phase 10 reuses the core identity layer for stable cross-subsystem references:

```text
BinaryId
SliceId
ImageId
EntityId
FunctionId
InstructionId
EvidenceId
RuntimeSessionId
```

Current executable contracts already exercise `createBinaryId`, `createSliceId`, `createFunctionId`, `createEvidenceId`, and `createRuntimeSessionId` in `tests/core-identity-contracts.mjs`.

### 2.2 Runtime-specific identifiers are bindings, not competing canonical IDs

A live process needs identities that are meaningful only within a runtime session: process instance, loaded module instance, thread, provider event, mapping generation, and so on.

Treat those as **session-scoped binding keys** unless/until the Master Architecture or an ADR promotes one to a canonical global ID.

Recommended terminology:

```text
RuntimeSessionId          canonical core ID
RuntimeTargetBinding      session-scoped target metadata
RuntimeModuleBinding      session-scoped loaded-module instance
RuntimeModuleBindingKey   unique only inside RuntimeSessionId
ModuleGeneration          distinguishes unload/reload instances
RuntimeAddressResolution  evidence-bearing mapping result
```

Do not introduce a new global `RuntimeModuleId` type that competes with `BinaryId`, `SliceId`, or `ImageId` without an ADR.

### 2.3 Cross-version identity stays separate

`FunctionId` is version/binary bound. A cross-version match MUST use a separate `FunctionMatch` / `FunctionIdentityCandidate`-style artifact containing algorithm version, confidence, ambiguity margin, and evidence.

A runtime provider MUST NOT make this shortcut:

```text
same runtime VA
=> same FunctionId
```

---

## 3. Current implementation baseline — preserve before extending

The following inventory is based on the reviewed `main` SHA above.

### 3.1 `js/debug/adapter.js`

Already provides:

- `DEBUG_PROTOCOL_VERSION = 1`;
- strict address/integer validation;
- normalized debugger capability vocabulary;
- capability negotiation;
- typed `DebugAdapterError` failures;
- attach/launch/pause/resume/step;
- breakpoints/watchpoints;
- registers/memory;
- threads/modules/backtraces;
- evaluate;
- function/call/return/branch/memory trace capabilities;
- Objective-C/Swift runtime capability flags;
- cancellation and replay capabilities.

**Preserve:** validation and capability discipline.  
**Do not assume:** the debugger capability vocabulary is the universal final Runtime Provider vocabulary.

### 3.2 `js/adapters/index.js`

Already contains meaningful concrete paths:

- `LocalFunctionSandboxAdapter`;
- `RemoteDebugAdapter`;
- `LLDBCompatibleAdapter`;
- `FridaCompatibleAdapter`;
- `ReplayAdapter`;
- emulator/symbolic-related adapter paths;
- `RuntimeMemoryMap` use;
- trace ring buffers;
- bounded remote arrays/trace sizes;
- remote response validation.

`LLDBCompatibleAdapter` and `FridaCompatibleAdapter` are valuable compatibility implementations, but both are currently expressed through debugger-shaped adapter semantics. That is not yet proof that Debugger and Instrumentation are clean first-class facets.

### 3.3 `js/runtime/index.js`

`RuntimeAnalysisPlatform` already orchestrates:

- adapter registry/selection;
- local and symbolic paths;
- LLDB/Frida-compatible remote adapters;
- replay adapter creation;
- runtime session lifecycle;
- cancellation propagation;
- experiments/hypothesis verification;
- function tracing;
- trace-to-semantic-fact extraction;
- runtime evidence creation;
- static/dynamic fusion;
- replay shape generation;
- cross-binary replay re-resolution.

The current cross-version replay route already rejects automatic reuse unless re-resolution is explicitly accepted with sufficiently strong identity confidence and ambiguity margin. Phase 10 treats that as a **minimum safety floor**, not temporary friction.

### 3.4 `js/runtime/session.js`

`DebugSession` / `DebugSessionManager` already provide:

- bounded session count;
- one-adapter-per-live-session protection;
- binary-hash binding;
- module/thread refresh;
- adapter event subscription;
- session epochs;
- stale-event rejection by epoch;
- operation cancellation on epoch change;
- bounded trace/observation state;
- versioned serialized/replay shapes;
- deterministic close/disconnect cleanup.

Phase 10 should evolve this lifecycle toward provider sessions, not discard the protections.

### 3.5 `js/debug/remote-protocol.js`

Protocol v1 already has substantial hardening:

- versioned packet validation;
- bounded packet/array/object/string sizes;
- plain-data-only wire values;
- BigInt/byte-array wire encoding;
- blocked host-command methods;
- request IDs;
- epochs;
- stale request invalidation;
- timeouts;
- cancellation;
- pending-request limits;
- event-rate and event-byte backpressure;
- explicit stream-truncation signal;
- listener isolation.

Do not regress this while introducing provider-level negotiation.

### 3.6 `js/runtime-evidence/index.js`

Current runtime evidence already provides useful semantics:

- runtime provenance groups;
- backend, binary hash, slice identity, session identity;
- timestamp/reproducibility;
- experiment evidence;
- trace-to-semantic-fact conversion;
- completeness/truncation metadata;
- Objective-C/Swift runtime comparisons;
- non-permanent runtime type annotations;
- static/dynamic fusion filtered by binary/slice/function identity;
- correlated evidence grouping;
- support/contradiction handling;
- evidence-required runtime agent tools.

### 3.7 `js/core/identity/*` and `js/core/evidence/*`

These are particularly important for Phase 10 because they already own the canonical future-facing contracts:

- content-derived `BinaryId`;
- canonical `SliceId` / `FunctionId` / `EvidenceId` / `RuntimeSessionId`;
- immutable canonical Evidence nodes;
- canonical `RuntimeEvidence` family;
- canonical support/contradiction/refinement vocabulary;
- compatibility conversion from current runtime evidence.

**Phase 10 direction:** runtime provider work converges toward canonical core identity/evidence contracts. It does not create a second evidence graph or replace the current compatibility layer in one big-bang change.

---

## 4. What Phase 10 is actually finishing

| Area | Current foundation | Remaining Phase 10 work |
|---|---|---|
| Debugger | strong `DebugAdapter` + LLDB-compatible remote path | provider facet/session semantics, module-aware identity, normalized state/events |
| Instrumentation | Frida-compatible capabilities | first-class probe/intercept/replacement semantics, mutation lineage, instrumentation-native events |
| Trace/replay | ReplayAdapter + ring buffer + trace facts + replay gates | immutable TraceProvider, canonical identity/event import, deterministic replay contract |
| Emulator | local/symbolic/emulator adapter paths | explicit backend-neutral Emulator facet and synthetic-evidence contract |
| Identity | binary hash/slice/session checks | canonical RuntimeSessionId integration + session-scoped module bindings/generations + address resolution evidence |
| Events | adapter callbacks and trace records | one provider-level RuntimeEvent envelope + ordering/dedupe/gap semantics |
| Evidence | mature compatibility runtime evidence + core EvidenceGraph | module-aware links, canonical RuntimeEvidence bridge, intervention lineage |
| Cross-version | replay re-resolution gate | generalize safe matching to all runtime/static attachments |
| Protocol | hardened debugger v1 | provider/facet negotiation and generic event/session envelope while preserving v1 |
| Browser performance | ring buffers, bounds, cancellation | end-to-end streaming/batching/paging/persistence semantics |

The missing center is **not another backend method**. It is a provider-level identity/lifecycle/event/evidence contract above the working adapters.

---

## 5. Non-goals

Phase 10 is not the place to:

- rewrite Semantic IR, SSA, MemorySSA, decompiler, or loader architecture;
- make runtime analysis mandatory for static analysis;
- make Frida or LLDB a semantic dependency;
- expose native debugger APIs directly to browser UI code;
- replace the canonical core identity/evidence model;
- treat runtime observations as direct mutation authority over static facts;
- remove protocol v1 in the same change that introduces provider negotiation;
- store unlimited trace/event history on the UI thread;
- interpret one observed execution path as complete program behavior;
- infer impossibility from “not observed” without coverage/completeness proof;
- solve cross-version matching with addresses, filenames, paths, or timestamps alone;
- mass-move runtime files merely to match a target directory diagram.

---

## 6. Phase 10 hard invariants

Every Phase 10 PR should be reviewable against these invariants.

### P10-INV-001 — Runtime never rewrites static truth directly

Required flow:

```text
RuntimeEvent
  -> RuntimeEvidence
  -> identity/address resolution
  -> supports / contradicts / refines a static claim
```

Forbidden flow:

```text
RuntimeEvent
  -> silently rewrite Semantic IR / SSA / recovered type / static FunctionId
```

### P10-INV-002 — Canonical IDs remain canonical

Stable cross-subsystem references use core identity contracts. Runtime-local process/module/thread/event keys remain scoped to `RuntimeSessionId` unless an ADR explicitly promotes them.

### P10-INV-003 — Static attachment requires identity evidence

A runtime address is never sufficient. Static attachment requires a validated chain such as:

```text
RuntimeSessionId
  + RuntimeModuleBinding
  + BinaryId/SliceId or explicit cross-version match
  + address resolution evidence
  -> EntityId / FunctionId / InstructionId
```

### P10-INV-004 — Unload/reload creates a new mapping generation

A previously valid runtime mapping cannot survive module unload and silently attach a later mapping at the same VA.

### P10-INV-005 — Unknown is explicit

Keep these states distinguishable:

```text
unsupported
unavailable
unresolved
ambiguous
identity-mismatch
partial
truncated
disconnected
cancelled
provider-failure
```

Empty success is not a substitute for unknown.

### P10-INV-006 — Runtime mutation has intervention lineage

Memory/register writes, hook replacements, injected probes, breakpoint side effects where relevant, and emulator state edits must be represented as interventions. Observations after an intervention retain ancestry to that intervention.

### P10-INV-007 — Event loss is semantic loss

Dropped or missing events produce explicit gap/truncation metadata and downgrade completeness. No downstream layer may silently restore `complete`.

### P10-INV-008 — Ordering is not fabricated

Wall-clock timestamps do not create a global causal order. Preserve total order only when the source proves it; otherwise preserve per-stream/partial ordering.

### P10-INV-009 — Long work is bounded and cancellable

Provider streams, trace import, replay, address resolution, and remote requests must remain cancellable and resource-bounded.

### P10-INV-010 — Compatibility is additive until proven

Current DebugAdapter/RemoteDebugAdapter/Replay behavior and protocol v1 remain available until differential tests prove replacement behavior and consumers migrate.

### P10-INV-011 — Runtime input is untrusted

Remote provider packets, trace files, module metadata, symbols, paths, event payloads, and provider-reported capabilities are untrusted data.

### P10-INV-012 — Replay must be deterministic about what it knows

Replay may reproduce a partial trace deterministically, but must not upgrade the trace's original completeness or identity quality.

---

## 7. Decisions to freeze before coding

These decisions have high fan-out and should not be re-litigated independently in backend PRs.

### LOCK-01 — Provider owns one runtime session; features are facets

A provider may expose zero or more of:

```text
Debugger
Instrumentation
Trace
Emulator
```

Do not create four unrelated session/identity systems.

### LOCK-02 — Canonical `RuntimeSessionId` comes from core identity

Use the canonical core identity mechanism. Existing string `DebugSession.id` can remain a compatibility/session-local handle during migration, but it should not become a competing stable ID.

### LOCK-03 — Loaded modules use session-scoped binding + generation

A loaded module instance should carry a session-scoped key and generation. Its static identity, if proven, points to canonical `BinaryId`/`SliceId`/`ImageId`.

### LOCK-04 — Address resolution returns a typed result

Never expose “slide = X” as the whole identity contract.

### LOCK-05 — TraceProvider is the first new first-class facet

It is deterministic/read-only and exercises identity, events, evidence, completeness, replay, and cross-version rules without live-process timing noise.

### LOCK-06 — Protocol v1 remains a compatibility protocol

Provider protocol work is additive/negotiated. Do not silently redefine v1.

### LOCK-07 — Runtime evidence converges toward canonical EvidenceGraph

Current `runtime-evidence` remains a compatibility surface while new provider evidence can be converted into canonical immutable `RuntimeEvidence` nodes and edges.

### LOCK-08 — Cross-version mapping uses explicit match artifacts

No filename/path/same-VA shortcut.

### LOCK-09 — Numeric performance budgets are measured before becoming normative

Current source limits remain regression floors. New provider-wide hard thresholds should be proposed with benchmark evidence, not invented in design prose.

### LOCK-10 — No big-bang runtime rewrite

Provider abstractions land additively; existing facades remain until migration gates pass.

---

## 8. Decisions intentionally deferred

Do not block P10.0–P10.4 on these unless implementation evidence requires an ADR:

- exact public name of provider protocol v2/extension;
- WebSocket vs native bridge vs other transport;
- whether Frida is bundled, external, or bridge-provided;
- persistence backend for cold trace pages;
- exact long-term provider plugin packaging model;
- hard numerical event/latency/memory targets beyond existing bounds;
- UI layout for runtime timeline/provider chooser.

These are implementation/deployment choices, not reasons to postpone the identity/event/evidence core.

---

## 9. Target architecture

```text
RuntimeAnalysisPlatform (compatibility/public composition facade)
                    |
                    v
          RuntimeProviderRegistry
                    |
          +---------+----------+
          |                    |
   RuntimeProvider A     RuntimeProvider B
          |                    |
     RuntimeSession        RuntimeSession
          |                    |
   +------+------+          Trace facet
   |             |
Debugger      Instrumentation
   |
existing DebugAdapter compatibility wrapper

All provider paths
      |
      v
RuntimeEvent -> RuntimeEvidence -> canonical EvidenceGraph
      |
      +-> static link only after validated resolution
```

### 9.1 Non-normative provider sketch

```ts
interface RuntimeProvider {
  descriptor(): RuntimeProviderDescriptor
  openSession(request, options): Promise<RuntimeProviderSession>
  closeSession(sessionHandle, options): Promise<void>
}

interface RuntimeProviderSession {
  runtimeSessionId: RuntimeSessionId
  target: RuntimeTargetBinding
  facets: RuntimeFacetSet
  events(options): AsyncIterable<RuntimeEventBatch>
}

interface RuntimeFacetSet {
  debugger?: DebuggerProvider
  instrumentation?: InstrumentationProvider
  trace?: TraceProvider
  emulator?: EmulatorProvider
}
```

The exact API can evolve. The ownership rules cannot:

- provider owns provider-specific connection state;
- runtime session owns target/module/event generations;
- canonical core owns stable IDs;
- evidence layer owns durable semantic claims/provenance;
- UI owns presentation, not target truth.

---

## 10. Runtime target and module binding model

### 10.1 RuntimeTargetBinding

Non-normative shape:

```ts
RuntimeTargetBinding {
  runtimeSessionId: RuntimeSessionId
  providerId
  providerVersion
  processKey?
  platform
  architecture
  primaryBinaryId?
  primarySliceId?
  startedAt?
  bindingEvidenceIds
}
```

`processKey` is provider/session scoped. PID alone is not a stable identity across reconnects or process reuse.

### 10.2 RuntimeModuleBinding

```ts
RuntimeModuleBinding {
  runtimeSessionId
  bindingKey
  generation
  runtimeBase
  runtimeSize
  permissions?
  pathHint?

  binaryId?
  sliceId?
  imageId?
  buildIdentity?

  loadedSequence?
  unloadedSequence?
  identityState
  identityEvidenceIds
}
```

`pathHint` is descriptive evidence only.

`buildIdentity` may use platform-native evidence such as Mach-O UUID, ELF build-id, or PDB identity. It is not silently equivalent to a content hash.

### 10.3 Mapping generation rule

The tuple:

```text
(RuntimeSessionId, bindingKey, generation)
```

identifies one loaded-module instance.

If a module unloads and another module later occupies the same address range, the later load gets a new generation even if path/base happen to match.

### 10.4 JIT and anonymous executable mappings

These may have no `BinaryId`.

That is valid:

```text
runtime evidence exists
static attachment = unresolved
```

Do not synthesize a static identity for convenience.

---

## 11. Runtime address resolution

### 11.1 Resolution result

```ts
RuntimeAddressResolution {
  runtimeSessionId
  moduleBindingKey?
  moduleGeneration?
  runtimeAddress

  binaryId?
  sliceId?
  imageId?
  staticAddress?
  targetEntityIds

  state: "exact" | "resolved" | "ambiguous" | "unresolved" | "mismatch"
  method
  evidenceIds
  functionMatchId?
}
```

### 11.2 Same-version preference order

Prefer stronger evidence:

1. exact content-derived `BinaryId` + matching `SliceId`;
2. validated image/module mapping to the same canonical binary/slice;
3. verified platform build identity that is explicitly accepted by the mapping policy;
4. otherwise unresolved/ambiguous/mismatch.

### 11.3 Cross-version rule

Different `BinaryId` means same-version mapping is over.

A static attachment requires an explicit cross-version match artifact. For function-level attachment it must preserve the Master Architecture's `FunctionMatch` semantics: algorithm version, confidence, ambiguity margin, and evidence.

### 11.4 Required edge cases

- ASLR/rebasing;
- multiple modules;
- overlapping historical mappings;
- FAT Mach-O slice mismatch;
- module unload/reload;
- same filename + different bytes;
- copied/renamed binaries;
- PID reuse;
- JIT code;
- anonymous executable memory;
- shared-cache-style images;
- trace records without content identity;
- transformed/emulator images;
- overflow/underflow near address-space limits.

---

## 12. Runtime session lifecycle

A provider session needs an explicit state machine rather than incidental booleans.

Suggested semantic states:

```text
opening
ready
running
paused
degraded
disconnected
closing
closed
failed
```

Not every facet uses every state. The invariant is that transitions are explicit and evidence/event consumers can distinguish them.

### 12.1 Epoch vs sequence vs module generation

These are separate concepts:

```text
session epoch
  invalidates operations/events from an obsolete session generation

event sequence
  orders provider events inside the ordering domain the provider can prove

module generation
  distinguishes unload/reload instances of a mapping
```

Do not overload one counter for all three.

### 12.2 Close behavior

Closing a provider session must:

- cancel outstanding operations;
- stop accepting events for obsolete epochs;
- retire active module bindings;
- unsubscribe listeners;
- release provider resources;
- preserve already-created immutable evidence;
- avoid publishing late async results into a new session.

### 12.3 Reconnect

Reconnect is not automatically “same execution”. The provider must prove whether it is:

- same target/session generation;
- same target but new provider connection;
- new process instance;
- replayed historical stream.

When uncertain, create a new binding/epoch rather than merging silently.

---

## 13. Normalized RuntimeEvent

Backend callbacks, instrumentation records, emulator events, and imported trace records converge into one envelope before durable evidence extraction.

Non-normative shape:

```ts
RuntimeEvent {
  eventId
  runtimeSessionId
  providerId
  providerVersion
  sessionEpoch

  streamId?
  sequence?
  predecessorIds?
  providerEventId?
  timestamp?

  processKey?
  threadKey?
  moduleBindingKey?
  moduleGeneration?

  kind
  payload
  observationMode: "observed" | "intervened" | "synthetic"
  completeness
}
```

### 13.1 Event families

```text
session-open / session-close
process-start / process-exit
thread-start / thread-exit
module-load / module-unload
paused / resumed
breakpoint-hit / watchpoint-hit
exception / signal
call / return / basic-block
memory-read / memory-write
register-snapshot
instrumentation-observation
instrumentation-intervention
emulator-checkpoint
trace-marker
gap / dropped-events
provider-warning / provider-error
```

### 13.2 Ordering rules

- wall-clock timestamp is metadata, not total order;
- a monotonic `sequence` is meaningful only within its declared stream/domain;
- multi-thread sources may have partial order;
- batch transport must not change logical event order;
- imported traces preserve source ordering quality;
- duplicate/replayed events must be detectable where provider IDs/sequence permit it.

### 13.3 Dedupe rules

Provider reconnects or retries can replay events.

A normalized stream should not infer dedupe from payload equality. Prefer a provider event ID or `(streamId, sequence)` within a proven epoch. If no reliable dedupe key exists, preserve both events and mark ordering/duplication uncertainty rather than deleting evidence.

### 13.4 Backpressure and gaps

Current v1 already emits stream truncation under event pressure. Provider normalization must preserve or strengthen this.

Required properties:

- bounded hot queue;
- batch/page delivery;
- cancellation;
- explicit gap/drop metadata;
- completeness downgrade;
- bounded UI projection;
- no silent drop followed by `complete` evidence.

---

## 14. Facet contracts

### 14.1 DebuggerProvider

Responsibilities:

- attach/launch/detach;
- pause/resume/step;
- breakpoints/watchpoints;
- threads/frames/registers;
- memory read/write;
- modules;
- target state events;
- debugger-specific capability negotiation.

Mutation operations such as register/memory writes create intervention records.

Current `DebugAdapter` should initially sit behind a compatibility wrapper.

### 14.2 InstrumentationProvider

Responsibilities:

- attach/instrument target;
- install/remove probes;
- intercept calls/blocks/events;
- optional replacement when backend allows it;
- memory/process/runtime metadata observations;
- ObjC/Swift runtime observations where available;
- high-volume filtering/batching;
- explicit mutation/intervention semantics.

`FridaCompatibleAdapter` is a compatibility seed. Do not merely rename it.

### 14.3 TraceProvider

Responsibilities:

- validate/import trace source;
- expose source/provider/schema identity;
- expose target/module bindings where known;
- stream normalized immutable events;
- preserve gaps/order/completeness;
- replay deterministically;
- never imply live mutation authority.

Current `ReplayAdapter` is a compatibility seed.

### 14.4 EmulatorProvider

Responsibilities:

- declare engine/version/architecture/environment model;
- accept controlled initial state/input;
- execute within budget;
- emit synthetic runtime events;
- expose unsupported/fault/timeout distinctly;
- support deterministic replay when possible.

Emulator evidence is useful but explicitly synthetic/experimental.

---

## 15. Intervention lineage

Runtime observation and runtime intervention are different evidence conditions.

Example:

```text
I0: attach
I1: write register x0 = 7
I2: replace function foo
E3: observe call to bar
```

`E3` must retain ancestry to `I1`/`I2` if those interventions may affect the observation.

Recommended model:

```text
InterventionRecord {
  interventionId
  runtimeSessionId
  providerId
  kind
  target
  requestedChange
  acknowledgedResult
  sequence/order metadata
  parentInterventionIds
  evidenceIds
}
```

A later provider event can carry `interventionIds` or resolve them during evidence construction.

Do not call an instrumented/replaced execution “untouched observed execution”.

---

## 16. RuntimeEvent -> canonical evidence

Raw events and durable evidence have different responsibilities.

```text
provider callback / imported record
          |
          v
      RuntimeEvent
          |
          v
identity + module/address resolution
          |
          v
compat runtime evidence (during migration)
          |
          v
canonical RuntimeEvidence / EvidenceGraph
          |
          +--> supports
          +--> contradicts
          +--> refines
          +--> observed-at / originates-from as applicable
```

### 16.1 Canonical evidence rules

- evidence nodes are immutable;
- new observation creates new evidence, not mutation of old evidence;
- canonical `EvidenceId` is used for stable references;
- evidence records provider/session/module provenance;
- static entity links exist only after validated resolution;
- unresolved runtime evidence remains inspectable;
- contradictions remain contradictions;
- confidence alone does not create deterministic confirmation;
- correlated observations are not counted as independent proof;
- completeness never increases without new evidence.

### 16.2 Compatibility bridge

Current `createRuntimeEvidenceRecord()` and `fuseStaticDynamic()` remain valid migration surfaces.

The core already has runtime-evidence compatibility conversion. Phase 10 should move provider-native evidence toward the canonical graph incrementally, with differential tests between old and new routes during migration.

### 16.3 Completeness mapping

Use the canonical completeness vocabulary from the Master Architecture/core evidence model. Existing runtime booleans such as `complete`/`truncated` are compatibility inputs, not a new competing taxonomy.

At minimum:

```text
source complete + no loss + complete resolution
  -> may remain complete

bounded source / partial capture
  -> bounded or partial

gap/drop/truncation
  -> truncated/partial as canonical policy requires

unsupported provider operation
  -> unsupported
```

Never map `truncated -> complete` merely because replay was deterministic.

---

## 17. Static/runtime fusion semantics

### 17.1 Same verified binary

Runtime evidence may support/contradict/refine a static claim when binary/slice/module/address identity is validated.

### 17.2 Mismatch or unresolved mapping

Store the runtime evidence, but do not attach it to a static entity.

### 17.3 Contradiction

Example:

```text
static claim: branch B unreachable under assumptions A
runtime evidence: verified same-binary execution reaches B
```

Correct:

```text
RuntimeEvidence -> contradicts Claim
```

Incorrect:

```text
RuntimeEvent -> mutate static IR until contradiction disappears
```

### 17.4 Negative observation

“Did not observe X” is not proof that X cannot happen unless scope/coverage/completeness support that claim.

### 17.5 Intervention-aware fusion

Evidence after an intervention may still support a hypothesis about the intervened experiment. It does not automatically support the same claim about untouched production execution.

---

## 18. Replay and cross-version model

Current `replayExperiment()` already has a strong trust direction: source/target identity by default, explicit re-resolution on mismatch, acceptance/confidence/ambiguity checks, and rejection of weak/ambiguous matches.

Generalize that behavior rather than replacing it.

### 18.1 Replay record should preserve

```text
provider id/version
schema/protocol version
RuntimeSessionId or recording identity
binary/slice identities when known
runtime module bindings and generations
inputs/configuration
events and ordering domain
gap/drop metadata
interventions
completeness
source provenance
```

### 18.2 Replay modes

**Exact replay**  
Same verified binary/slice identity and compatible schema.

**Same-version re-resolution**  
Runtime layout changed (for example ASLR), but canonical binary/module identity permits deterministic mapping.

**Cross-version candidate replay**  
Different `BinaryId`; static attachment requires explicit match artifacts.

**Runtime-only replay**  
Trace can be replayed, but identity is insufficient for safe static attachment.

### 18.3 Determinism rule

Deterministic replay means “the same recording yields equivalent normalized events/evidence under the same versioned rules”. It does **not** mean the original capture was complete or semantically exhaustive.

---

## 19. Provider remote protocol strategy

Current debugger protocol v1 is already hardened. The provider protocol should reuse its successful mechanisms while adding provider/session/facet semantics.

Recommended relationship:

```text
DEBUG_PROTOCOL_VERSION = 1
  -> preserved debugger compatibility protocol

provider-level negotiated protocol (name/version deferred)
  -> provider identity
  -> RuntimeSessionId/session binding
  -> facet discovery
  -> generic RuntimeEvent batches
  -> provider lifecycle
  -> can host debugger compatibility operations
```

### 19.1 Handshake must negotiate or reject

- supported protocol versions;
- provider ID/version;
- supported facets;
- capabilities per facet;
- target architecture/platform;
- payload/event bounds;
- event batching/streaming support;
- cancellation/deadline support;
- authn/authz requirements where applicable.

Unknown or incompatible versions fail closed.

### 19.2 Typed failures

Normalize at least these concepts without collapsing them:

```text
unsupported
unavailable
invalid-input
identity-mismatch
ambiguous
resource-limit
backpressure
cancelled
timeout
disconnected
permission-denied
provider-failure
protocol-mismatch
malformed-provider-data
```

### 19.3 Protocol confusion defenses

- version belongs in validated envelope;
- facet/method namespace is explicit;
- method cannot be reinterpreted under another facet;
- capabilities are advisory until operation validation succeeds;
- remote provider cannot promote its own data to trusted static identity without verification;
- no `eval`, shell, spawn, host-command, or executable callback payloads;
- reconnect creates an explicit protocol/session transition.

### 19.4 Suggested namespaces

```text
runtime.session.*
runtime.target.*
runtime.events.*
debugger.*
instrumentation.*
trace.*
emulator.*
```

The exact names are deferred; the separation is not.

---

## 20. Browser/iPad resource model

Phase 10 must stay usable in the constrained browser/iPad environment.

### 20.1 Preserve existing strengths

Current code already has:

- trace ring-buffer bounds;
- remote packet/array bounds;
- pending-request bounds;
- event-rate/event-byte backpressure;
- AbortController propagation;
- session limits;
- bounded evidence/observation history.

### 20.2 Provider-wide rules

- hot live state stays small;
- trace history is paged/streamed;
- UI receives batches or virtualized pages, not unbounded event arrays;
- cold data can be persisted behind an abstract store;
- cancellation is checked at bounded intervals;
- no correctness dependency on SharedArrayBuffer;
- instrumentation filtering happens before expensive UI projection;
- gap/drop state remains visible through persistence/replay;
- query APIs report completeness/cost where relevant.

### 20.3 Performance thresholds

Do not invent arbitrary Phase 10 numbers in advance.

P10.0 should capture current bounds and baseline measurements. Each new hard threshold must include:

```text
measurement fixture
browser/device class or headless environment
metric
observed baseline
target/regression threshold
failure behavior
```

Correctness gates are normative before performance targets are.

---

## 21. Security model

Treat provider and trace input as hostile data.

Threats include:

- malformed wire values;
- excessive nesting/arrays/strings/events;
- integer/address overflow;
- malicious module names/paths/symbol strings;
- event floods;
- provider capability lies;
- stale/cross-binary session data;
- protocol downgrade/confusion;
- provider impersonation;
- duplicate/replayed events;
- unauthorized mutation;
- malicious trace identity metadata;
- injected executable/callback payloads;
- backend compromise.

Required controls:

- schema/version validation;
- strict address/integer parsing;
- bounded payloads and nesting;
- plain-data-only transport;
- blocked host command execution;
- explicit capability authorization;
- mutation vs observation separation;
- provider/session identity validation;
- binary/module identity verification independent of provider claims when possible;
- cancellation/timeouts/backpressure;
- epoch/generation checks;
- fail-closed protocol negotiation.

Provider text is evidence/data, never system or AI instruction authority.

---

## 22. Migration compatibility matrix

| Existing surface | Phase 10 destination | Migration rule |
|---|---|---|
| `DebugAdapter` | Debugger facet compatibility adapter | preserve until consumers migrate |
| `RemoteDebugAdapter` | remote Debugger facet | keep v1 route green while provider protocol lands |
| `LLDBCompatibleAdapter` | concrete debugger-provider path | do not require provider core to know LLDB details |
| `FridaCompatibleAdapter` | compatibility path toward Instrumentation facet | do not rename and declare complete |
| `ReplayAdapter` | compatibility path toward TraceProvider | imported traces become trace-native over time |
| `DebugSession` | provider session compatibility facade | preserve epoch/cancel/close semantics |
| `DebugSession.id` | local compatibility handle | canonical stable reference is `RuntimeSessionId` |
| `binaryHash` | compatibility binary identity input | converge to canonical `BinaryId` without weakening checks |
| runtime evidence records | compatibility evidence format | convert toward canonical immutable RuntimeEvidence |
| `fuseStaticDynamic()` | compatibility fusion route | differential-test against canonical EvidenceGraph semantics |
| debugger protocol v1 | compatibility wire protocol | no silent semantic break |

---

## 23. Implementation sequence

The sequence below minimizes throw-away work and keeps high-fan-out contracts serialized.

### P10.0 — Baseline oracle and migration guardrails

**Goal:** make current runtime safety executable before refactoring.

Do:

- inventory exact current runtime/core identity/evidence tests;
- add a Phase 10 test runner without deleting existing runners;
- pin current protocol v1 epoch/cancel/backpressure behavior;
- pin current DebugSession lifecycle behavior;
- pin LLDB/Frida/Replay compatibility surfaces;
- pin trace completeness/truncation behavior;
- pin runtime fusion mismatch/correlation behavior;
- pin cross-version replay ambiguity rejection;
- pin canonical RuntimeSessionId creation and canonical RuntimeEvidence conversion.

**Exit:** a provider refactor cannot silently reduce current trust guarantees.

### P10.1 — Runtime module binding + address resolution

Add:

- canonical RuntimeSessionId integration;
- RuntimeTargetBinding;
- RuntimeModuleBinding;
- module generation;
- load/unload mapping state;
- typed RuntimeAddressResolution;
- exact/resolved/ambiguous/unresolved/mismatch states;
- same-version and cross-version policy separation.

Keep existing `binaryHash`/slice checks as compatibility inputs.

**Exit:** deterministic tests cover ASLR, wrong binary/slice, unload/reload, same-name/different-content, JIT/unresolved, same-VA/different-build.

### P10.2 — RuntimeProvider registry + compatibility facets

Introduce provider descriptor/registry/session ownership and wrappers for existing adapters.

Do not delete `DebugAdapter` or protocol v1.

**Exit:** current local/remote/LLDB/Frida/replay paths work through compatibility layers with no trust regression.

### P10.3 — Normalize RuntimeEvent

Add:

- provider/session/epoch identity;
- stream/sequence ordering metadata;
- module binding generation;
- observation mode;
- canonical completeness mapping;
- explicit gap/drop event;
- dedupe/retry semantics;
- event batches.

**Exit:** current adapter/trace events project to normalized events without losing epoch/truncation/ordering information.

### P10.4 — Evidence bridge + intervention lineage

Add:

- provider/session/module provenance;
- static-link resolution evidence;
- unresolved runtime-only evidence;
- intervention ancestry;
- canonical RuntimeEvidence conversion;
- support/contradict/refine edges;
- completeness propagation.

**Exit:** canonical and compatibility fusion routes are differentially tested and at least as conservative as current behavior.

### P10.5 — First-class TraceProvider

Use deterministic fixtures to validate the new contracts.

Minimum import model preserves, when available:

- source/provider/schema identity;
- binary/slice/module identity;
- module load/unload generations;
- thread/process metadata;
- call/branch/memory observations;
- event order domain;
- gap/drop metadata;
- interventions if source supports them;
- completeness.

**Exit:** import -> normalize -> replay -> evidence is deterministic and cross-version negative fixtures fail closed.

### P10.6 — Provider remote protocol

Add provider/facet negotiation and normalized event streaming while keeping v1 tests green.

**Exit:** fake provider handshake + session + event batches + cancellation + malformed/downgrade tests pass; v1 remains compatible.

### P10.7 — Mature DebuggerProvider

Move debugger behavior behind the provider/session identity/event model.

**Exit:** local/mock and at least one remote debugger compatibility path satisfy the same contract and lifecycle rules.

### P10.8 — First-class InstrumentationProvider

Add instrumentation-native probe/intercept/replacement semantics, high-volume event behavior, permissions, and intervention lineage.

**Exit:** instrumentation does not depend on pretending every operation is a debugger operation.

### P10.9 — EmulatorProvider + final gates

Generalize emulator paths; capture engine/version/environment/input/budget/termination/completeness as synthetic evidence.

Then close all canonical Phase 10 exit gates across provider types.

---

## 24. Dependency graph and parallelization

```text
P10.0 baseline oracle
        |
        v
P10.1 identity/mapping
        |
        v
P10.2 provider/facets
        |
        v
P10.3 RuntimeEvent
        |
        v
P10.4 evidence/intervention
        |
        +-----------+--------------+--------------+
        |           |              |              |
        v           v              v              v
 P10.5 Trace   P10.6 protocol   P10.7 Debug   P10.8 Instrument
        \           |              |              /
         \          +--------------+-------------+
          \                        |
           +-----------------------+
                         |
                         v
                  P10.9 Emulator/final gates
```

### Serialize through P10.4

One contract owner at a time for:

- canonical/runtime identity boundary;
- module generation rules;
- address resolution states;
- provider session ownership;
- RuntimeEvent envelope;
- completeness mapping;
- evidence/intervention semantics.

### Parallelize after P10.4

Safe tracks:

- TraceProvider fixtures/import;
- provider protocol implementation;
- debugger provider hardening;
- instrumentation provider;
- emulator provider preparation;
- cross-version/adversarial corpus;
- runtime UI/query projection.

---

## 25. Existing executable oracle — exact files to preserve

Do not create duplicate tests without first checking these.

| Existing test | Phase 10 contract it already protects |
|---|---|
| `tests/core-identity-contracts.mjs` | content-derived BinaryId, SliceId/FunctionId determinism, EvidenceId, RuntimeSessionId |
| `tests/core-evidence-contracts.mjs` | immutable evidence, RuntimeEvidence family, contradiction, missing evidence, no confidence-only confirmation |
| `tests/runtime-platform.mjs` | adapter validation, memory bounds, ring buffer, remote protocol behavior, runtime experiments/session/platform behavior |
| `tests/runtime-evidence-fusion.mjs` | correlated evidence grouping, contradiction dominance, function-scoped evidence filtering |
| `tests/issue-433-runtime-replay.mjs` | cross-binary replay confidence/ambiguity rejection |
| `tests/review-cross-binary-state.mjs` | binary/slice transition safety and stale async state rejection |
| `tests/migration-guardrails.mjs` | runtime evidence cannot mutate static candidate; compatibility/dependency guardrails |
| `tests/issue-556-address-provenance.mjs` | address provenance/control-flow boundaries on the static side; useful regression oracle for mapping consumers |

### 25.1 Existing commands

Current package scripts already provide:

```bash
npm run core:test
npm run runtime:test
npm run migration:test
npm run integration:test
npm run invariants:test
npm run check
```

Notably, `npm run runtime:test` currently runs the runtime platform and runtime evidence fusion suites; cross-version replay issue tests live outside that narrow script. P10.0 should make Phase 10's required test set explicit rather than assuming `runtime:test` covers every runtime trust gate.

---

## 26. Proposed Phase 10 test layout

Candidate layout; exact filenames are implementation details but the coverage is required.

```text
tests/phase10/
  run.mjs
  identity-binding.mjs
  address-resolution.mjs
  provider-contract.mjs
  session-lifecycle.mjs
  runtime-event.mjs
  intervention-lineage.mjs
  evidence-bridge.mjs
  trace-provider.mjs
  provider-protocol.mjs
  debugger-provider.mjs
  instrumentation-provider.mjs
  emulator-provider.mjs
  cross-version-negative.mjs
  adversarial-streams.mjs
  browser-budget.mjs
  fixtures/
```

### 26.1 Suggested `phase10:test` gate

P10.0 should consider adding a package script analogous to earlier phases:

```text
phase10:test -> existing required oracles + tests/phase10/run.mjs
```

Do not remove existing runtime/core/migration commands. `phase10:test` is an aggregate migration gate, not a replacement.

---

## 27. Test matrix by contract

### Identity and mapping

- same binary + ASLR resolves;
- same binary + wrong slice rejects;
- same path/name + different content rejects;
- copied/renamed exact content resolves only through content identity;
- unload invalidates old module generation;
- reload at same base uses new generation;
- two modules with overlapping historical ranges do not cross-attach;
- JIT/anonymous code stays runtime-only if unresolved;
- address arithmetic overflow/underflow rejects;
- PID reuse does not reuse target binding;
- same VA across binaries never auto-links.

### Provider/session

- provider ID/version required;
- RuntimeSessionId canonical and stable for its identity inputs;
- provider-local handle cannot substitute for canonical RuntimeSessionId;
- facet availability negotiated;
- unsupported != unavailable != permission denied;
- one session cannot consume another session's events;
- close cancels outstanding work;
- late async result cannot publish after close/new epoch;
- reconnect semantics explicit.

### RuntimeEvent

- epoch mismatch ignored/rejected;
- module generation mismatch does not attach;
- known sequence preserved;
- partial order remains partial;
- batch preserves logical stream;
- duplicate provider event handled according to proven dedupe key;
- no dedupe key => uncertainty preserved;
- overflow produces gap/truncation;
- gap downgrades completeness;
- malformed event cannot mutate session/static state.

### Evidence bridge

- unresolved event yields runtime-only evidence;
- exact same-binary mapping yields correct static EntityId;
- wrong binary/slice/module generation cannot link;
- evidence immutable after insertion;
- support/contradiction/refinement survive serialization;
- confidence alone cannot create confirmed claim;
- correlated observations remain one evidence group where appropriate;
- intervention ancestry survives conversion;
- truncated input never becomes complete evidence.

### Replay/TraceProvider

- deterministic fixture import;
- equivalent replay output under same schema/version;
- wrong binary detached;
- missing identity unresolved;
- module load/unload replayed by generation;
- gap metadata preserved;
- duplicate/reordered source semantics preserved;
- malicious/oversized trace rejected or bounded;
- provider-reported fake binary identity does not bypass verification;
- replay does not upgrade original completeness.

### Debugger

- attach/launch/detach;
- pause/resume/step state transitions;
- stale frame/register snapshots invalidated;
- breakpoint/watchpoint lifecycle;
- memory/register write emits intervention lineage;
- module load/unload updates mapping generation;
- disconnect/target exit distinguishable;
- cancellation race cannot publish stale result.

### Instrumentation

- attach/instrument;
- probe install/remove;
- intercept observation;
- replacement marked intervention;
- event storm bounded;
- gap emitted on loss;
- JIT/module churn represented;
- permission failure distinct from unsupported;
- hook removal does not erase historical intervention provenance.

### Emulator

- engine/version captured;
- architecture/environment captured;
- initial state/input captured;
- budget/timeout explicit;
- unsupported instruction distinct from fault;
- deterministic replay where promised;
- observation mode synthetic;
- synthetic evidence not mislabeled live observation.

---

## 28. Adversarial / destructive review matrix

These cases are release-blocking because happy-path provider tests can pass while these still corrupt evidence identity.

| Attack/failure | Required outcome |
|---|---|
| provider says module filename matches project but content differs | no static attachment |
| unload module A, load B at same VA | old A mapping unusable; new generation required |
| same PID reused after target restart | new target/session binding |
| reconnect replays last 100 events | dedupe only with proven event key; otherwise preserve uncertainty |
| duplicate event with same payload but different sequence | do not payload-dedupe |
| out-of-order events from two threads | do not invent total order |
| sequence jumps | explicit gap/partial state where source semantics imply loss |
| stale old-epoch response arrives after new session starts | ignored/rejected; no state publication |
| cancellation races with provider success response | one terminal result; stale success cannot publish |
| provider advertises capability but returns malformed shape | typed malformed/provider failure; no trust upgrade |
| protocol version downgrade attempt | fail closed unless explicitly negotiated compatible version |
| method/facet confusion | reject; no cross-facet reinterpretation |
| remote sends shell/eval/spawn-like operation | blocked |
| huge nested payload | bounded/rejected before expensive processing |
| trace claims trusted BinaryId without verifiable content evidence | claim remains unverified/unresolved |
| trace omits module identity but includes plausible addresses | runtime-only evidence |
| same VA, different optimized function in new build | cross-version match required |
| top two FunctionMatch candidates too close | ambiguous, no static attachment |
| hook replacement followed by observation | evidence linked to intervention |
| register write followed by observed branch | evidence linked to intervention |
| trace drops events but replay is deterministic | completeness remains degraded |
| provider disconnects mid-batch | partial/gap state, no fabricated complete batch |
| JIT range later reused for different generated code | new binding/generation; no stale link |
| runtime address arithmetic wraps | reject as invalid mapping |
| malformed symbol/path contains control text/instructions | treated as inert data |
| provider sends unknown event kind | preserve/ignore according to versioned policy; never execute |
| close and module-load event race | closed/obsolete epoch wins; no resurrected session |

---

## 29. “Do not land” checklist for every Phase 10 PR

Do not merge if any applicable item is true:

- [ ] introduces a new stable identity without reconciling it with core identity/ADR;
- [ ] links runtime data to static entities using raw address/path/name only;
- [ ] can reuse an unloaded module mapping;
- [ ] turns runtime observation directly into static mutation;
- [ ] drops events without completeness downgrade;
- [ ] turns unsupported/unavailable into empty success;
- [ ] introduces an uncancellable long-running operation;
- [ ] removes an existing v1 safety bound without measured replacement;
- [ ] weakens current cross-version replay ambiguity rejection;
- [ ] treats confidence alone as deterministic confirmation;
- [ ] loses intervention ancestry;
- [ ] accepts provider capability/identity assertions without validation;
- [ ] requires a real LLDB/Frida/device target for the core contract test suite;
- [ ] breaks current DebugAdapter/RuntimeAnalysisPlatform consumers without a migration adapter;
- [ ] changes canonical evidence/identity schema without the required architectural review/ADR;
- [ ] leaves new negative cases untested.

---

## 30. Exact first three coding PRs

This is the recommended opening packet once Phase 10 starts.

### First PR — P10.0 contract freeze

**Primary files:** tests/package scripts/docs only where possible.

Add:

- `tests/phase10/run.mjs`;
- baseline identity/evidence/runtime/protocol/replay oracle aggregation;
- explicit negative fixtures for current cross-binary replay and stream truncation;
- test documentation showing which current source behavior is a compatibility contract.

Do **not** add provider production code yet.

**Required checks:**

```bash
npm run core:test
npm run runtime:test
npm run migration:test
npm run invariants:test
npm run integration:test
```

Then run the new Phase 10 aggregate.

### Second PR — P10.1 identity/mapping

**Primary candidate files:**

```text
js/runtime/identity.js
js/runtime/address-map.js
js/runtime/session.js (additive integration only)
js/core/identity/* only if canonical API extension is genuinely required
```

Add RuntimeTargetBinding, RuntimeModuleBinding/generation, and typed RuntimeAddressResolution.

No debugger UI/protocol redesign.

### Third PR — P10.2 provider skeleton

**Primary candidate files:**

```text
js/runtime/provider.js
js/runtime/registry.js
js/runtime/providers/debugger-compat.js
js/runtime/providers/trace-compat.js
js/runtime/index.js (facade wiring)
```

Keep existing adapter APIs intact.

At the end of these three PRs, Phase 10 has a trustworthy substrate before any expensive backend-specific work begins.

---

## 31. PR-by-PR rollback strategy

### P10.0

Tests-only/guardrail changes. If a baseline test exposes current inconsistency, resolve or document the inconsistency before provider refactor. Do not weaken the oracle to make future code easier.

### P10.1

Identity/mapping code should be additive first. Existing runtime route remains active until differential tests pass. Rollback is removing the unused additive path, not reverting unrelated runtime behavior.

### P10.2–P10.4

Compatibility wrappers allow old and new paths to coexist. Migrate one consumer at a time and compare outputs. No all-at-once switch.

### P10.5+

Concrete facets are independently removable behind the provider registry. A failed Frida/debugger backend must not require reverting identity/evidence core.

### Protocol

Provider protocol is additive. v1 remains available until explicit deprecation criteria exist and compatibility consumers are gone.

---

## 32. Review checklist by discipline

### Architecture review

- canonical IDs reused?
- runtime-local keys properly scoped?
- static/runtime truth boundary preserved?
- no new semantic authority in provider/backend?
- compatibility path clear?
- deferred decisions not accidentally frozen?

### Correctness review

- wrong binary/slice/module generation fails closed?
- unknown/partial/truncated explicit?
- ordering assumptions justified?
- cross-version ambiguity preserved?
- intervention lineage preserved?
- evidence immutable?

### Concurrency/lifecycle review

- epoch checked?
- cancellation race handled?
- close/reconnect race handled?
- event duplicates/reordering handled?
- module unload/reload race handled?

### Security review

- provider input bounded/validated?
- capability assertions verified?
- no host command execution path?
- protocol downgrade/method confusion tested?
- trace metadata treated as untrusted?

### Browser/iPad review

- bounded memory?
- batched/paged event flow?
- cancellation checkpoints?
- no SAB correctness dependency?
- no large synchronous UI projection?

---

## 33. Canonical Phase 10 exit gates expanded into executable criteria

### Gate A — Runtime evidence identity binding

Pass only if:

- every durable runtime evidence item has canonical/session/provider provenance;
- static-linked runtime evidence has validated binary/slice/module/address resolution;
- wrong binary/slice/module generation cannot create a static link;
- unresolved/JIT/runtime-only evidence remains representable;
- unload/reload cannot reuse stale mapping;
- canonical core IDs are used for stable cross-subsystem references.

### Gate B — Static/runtime fusion tests

Pass only if:

- runtime cannot directly mutate static Semantic IR/SSA/type truth;
- support/contradiction/refinement is evidence-based;
- immutable canonical evidence survives serialization;
- confidence alone cannot create confirmed truth;
- intervention ancestry is visible;
- partial/truncated input limits downstream completeness;
- correlated observations are not double-counted as independent proof;
- compatibility fusion and canonical EvidenceGraph behavior agree on covered cases.

### Gate C — Replay/cross-version ambiguity

Pass only if:

- same-version deterministic replay reproduces equivalent normalized evidence;
- replay preserves original gaps/completeness;
- wrong binary is blocked from static attachment;
- same-address cross-build shortcut is impossible;
- cross-version attachment uses explicit match artifacts;
- ambiguous/low-margin candidates remain unresolved;
- module generation/order/source identity survive replay.

### Gate D — Compatibility

Pass only if:

- existing DebugAdapter paths remain operational through migration;
- RuntimeAnalysisPlatform remains usable as compatibility facade;
- protocol v1 validation/epoch/cancel/backpressure tests stay green;
- existing runtime tests stay green;
- old runtime evidence can still be consumed/converted.

### Gate E — Operational safety

Pass only if:

- event ingestion is bounded;
- gap/drop semantics are end-to-end;
- all long operations cancel;
- disconnect/close cannot publish stale state;
- malicious/malformed provider input cannot mutate static project state;
- provider failure remains isolated.

---

## 34. Definition of done

Phase 10 is complete only when all applicable items are true:

- [ ] canonical `RuntimeSessionId` is used as the stable runtime session reference;
- [ ] runtime-local module/process/thread keys are explicitly session-scoped;
- [ ] Debugger, Instrumentation, Trace, and Emulator are first-class facets of one provider/session model;
- [ ] current DebugAdapter/LLDB/Frida/Replay routes have compatibility paths during migration;
- [ ] runtime module bindings have load/unload generations;
- [ ] address resolution is typed and evidence-bearing;
- [ ] ASLR/multi-module/unload-reload/JIT cases are safe;
- [ ] same VA across builds cannot create identity;
- [ ] normalized RuntimeEvent carries session/epoch/order/completeness semantics;
- [ ] duplicate/reordered/reconnected streams are handled conservatively;
- [ ] event loss is explicit and downgrades completeness;
- [ ] runtime evidence converges to canonical immutable EvidenceGraph semantics;
- [ ] unresolved runtime evidence can remain runtime-only;
- [ ] interventions are first-class lineage, not hidden side effects;
- [ ] TraceProvider has deterministic import/replay fixtures;
- [ ] provider protocol is negotiated and v1 compatibility remains tested;
- [ ] mature DebuggerProvider uses common identity/event/evidence contracts;
- [ ] InstrumentationProvider has instrumentation-native operations and mutation lineage;
- [ ] EmulatorProvider marks synthetic observations explicitly;
- [ ] cross-version matching uses explicit match artifacts and ambiguity gates;
- [ ] adversarial identity/stream/protocol corpus is green;
- [ ] browser/iPad ingestion is bounded, cancellable, and pageable;
- [ ] provider failure/disconnect cannot corrupt static project state;
- [ ] canonical Phase 10 gates A–E are green in CI.

---

## 35. Recommended first coding move

Do **not** start by adding another LLDB/Frida method.

Start by making the existing safety model executable and canonical:

```text
P10.0
  freeze current identity/evidence/protocol/replay behavior in tests

P10.1
  RuntimeSessionId integration
  RuntimeTargetBinding
  RuntimeModuleBinding + generation
  RuntimeAddressResolution

P10.2
  RuntimeProvider registry + compatibility facets
```

Only after those contracts stabilize should backend tracks fan out.

This sequence minimizes rework because every later provider consumes one identity/event/evidence model.

---

## 36. Three-pass review record — 2026-08-18

This section records the three self-review passes performed on this guide. It is not a claim of independent human review.

### Review 1 — Architecture / source-of-truth review

Compared the guide against the Master Architecture and canonical identity/evidence direction.

**Findings:**

1. The earlier guide risked making `RuntimeTargetIdentity` / `RuntimeModuleIdentity` look like new canonical ID systems.
2. It did not sharply enough distinguish canonical `RuntimeSessionId` from current `DebugSession.id`.
3. Cross-version mapping needed explicit alignment to `FunctionMatch` semantics.
4. Runtime evidence migration needed explicit convergence toward canonical immutable EvidenceGraph semantics.
5. Session epoch, event sequence, and module unload/reload generation were insufficiently separated.

**Corrections made:**

- defined canonical-vs-session-scoped identity boundary;
- made core IDs authoritative;
- replaced global runtime-module-ID assumption with module binding + generation;
- aligned cross-version rules to explicit match artifacts;
- defined canonical EvidenceGraph bridge;
- separated epoch/sequence/module-generation semantics.

**Result:** no known architecture-level conflict with the reviewed Master Architecture remains in this guide.

### Review 2 — Implementation feasibility / testability review

Compared the plan against the actual current runtime source and executable test/package surfaces.

**Findings:**

1. “Pin current tests” was too vague to execute.
2. Existing `core-identity-contracts`, `core-evidence-contracts`, runtime platform/fusion, replay issue, cross-binary state, and migration guardrails already cover important Phase 10 truths.
3. `npm run runtime:test` alone does not aggregate every Phase 10 trust gate.
4. The plan needed exact first PRs, rollback behavior, and differential migration strategy.
5. Numeric performance goals should not be invented before baseline measurement.

**Corrections made:**

- added exact existing-oracle file matrix;
- added current command matrix;
- proposed a dedicated `tests/phase10/` aggregate;
- specified first three coding PRs;
- added PR-by-PR rollback strategy;
- made performance thresholds measurement-backed rather than arbitrary.

**Result:** the guide is executable as a staged implementation plan rather than only an architecture essay.

### Review 3 — Adversarial / regression review

Reviewed the plan as if a provider were buggy, malicious, delayed, duplicated, reordered, cross-version, or racing lifecycle changes.

**Findings:**

1. unload -> same-VA reload needed an explicit generation rule;
2. reconnect/event replay needed dedupe semantics;
3. out-of-order and duplicate events needed explicit treatment;
4. capability/identity assertions from providers needed to remain untrusted;
5. protocol downgrade/method confusion needed explicit gates;
6. trace imports could lie about binary identity;
7. intervention-followed observations could be accidentally presented as natural execution;
8. cancellation/close races could publish stale results;
9. deterministic replay could accidentally be interpreted as complete evidence.

**Corrections made:**

- added module generation semantics;
- added event dedupe/order/reconnect rules;
- added hostile-provider and hostile-trace rules;
- added protocol confusion/downgrade defenses;
- added intervention lineage model;
- added adversarial release-blocking matrix;
- added “do not land” checklist;
- explicitly separated replay determinism from evidence completeness.

**Result:** the major known happy-path-only failure modes are now represented as negative gates, not implementation footnotes.

---

## 37. Final mental model

```text
existing adapter / live backend / imported trace
                    |
                    v
             RuntimeProvider
                    |
                    v
       canonical RuntimeSessionId
                    |
           RuntimeTargetBinding
                    |
        RuntimeModuleBinding(gen)
                    |
                    v
          normalized RuntimeEvent
                    |
                    v
      identity/address resolution
                    |
                    v
      canonical RuntimeEvidence
                    |
             EvidenceGraph
          /        |        \
     supports  contradicts  refines
          \        |        /
             static Claim

Never:
provider data -> raw address guess -> silently mutate static truth
```

If implementation preserves this model, Phase 10 can add powerful live analysis without creating incompatible identity systems, debugger-specific semantics, or runtime evidence that silently outranks static proof.
