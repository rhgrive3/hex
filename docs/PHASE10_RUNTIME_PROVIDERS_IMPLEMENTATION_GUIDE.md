# Phase 10 — Runtime Providers Implementation Guide

> **Status:** Implementation planning guide  
> **Scope:** Phase 10 only  
> **Normative authority:** `docs/HEX_MASTER_ARCHITECTURE.md`  
> **Planning baseline:** `353651ca54fa0c244e3093e7e1f53c2b4840b8bf`  
> **Primary constraint:** Browser/iPad-first, evidence-first, compatibility-first  
> **Purpose:** Remove the expensive design uncertainty before implementation starts.

This document is deliberately non-normative. If it conflicts with `docs/HEX_MASTER_ARCHITECTURE.md` or a later accepted ADR, the master architecture/ADR wins.

---

## 1. Phase 10 in one sentence

Phase 10 turns the existing debugger/emulator/runtime-evidence foundations into a **versioned, identity-bound Runtime Provider plane** where Debugger, Instrumentation, Emulator, and imported Trace backends can feed one evidence model without ever becoming a second static semantic truth.

The canonical Phase 10 deliverables are:

- a mature debugger provider;
- a Frida-compatible instrumentation provider;
- a trace provider;
- an emulator provider interface;
- a versioned remote protocol.

The canonical exit gate is:

- runtime evidence is correctly bound to runtime and binary identity;
- static/runtime fusion is tested without runtime observations mutating static truth;
- replay and cross-version ambiguity are explicitly gated.

The difficult work is therefore **not primarily implementing debugger buttons**. The hard part is getting identity, address mapping, event normalization, replay, and evidence fusion correct enough that all runtime backends can share them safely.

---

## 2. Non-goals

Phase 10 SHOULD NOT become a rewrite of all existing runtime code.

It is explicitly not the phase to:

- replace the static Semantic IR/SSA/MemorySSA model;
- make runtime analysis mandatory for static analysis;
- directly expose OS debugger APIs to the browser UI;
- hard-wire Hex to one debugger, instrumentation engine, emulator, or transport;
- bundle a heavy third-party engine merely to claim support;
- treat an observed runtime value as an authoritative static fact;
- build unrestricted whole-process trace storage in browser memory;
- solve cross-version binary matching by comparing raw addresses;
- mass-rename current modules before the provider contracts are proven.

A successful Phase 10 leaves the existing static pipeline usable when no runtime provider is installed or available.

---

## 3. Current implementation baseline: preserve before extending

The current runtime implementation is not empty. Phase 10 should evolve these foundations instead of replacing them blindly.

### 3.1 `js/runtime/index.js`

Current role:

- runtime subsystem composition;
- debugger facade;
- emulator facade;
- runtime session/evidence coordination;
- capability reporting.

Current defaults include a mock debugger and a null emulator path. This is a useful compatibility boundary and SHOULD remain a facade while provider internals migrate behind it.

### 3.2 `js/runtime/session.js`

Current role:

- runtime session lifecycle;
- debugger/emulator adapter binding;
- binary identity association;
- session history/handoff.

This is the seed for the final `RuntimeSession`, but Phase 10 needs stronger target/module identity and first-class support for provider facets beyond debugger/emulator.

### 3.3 `js/debug/adapter.js`

Current role:

- debugger capability vocabulary;
- attach/detach/pause/resume/step;
- memory/register/module/thread/frame operations;
- breakpoints/watchpoints;
- mock adapter for deterministic testing.

This is valuable and SHOULD become a compatibility facade over a `DebuggerProvider` facet rather than being deleted during the first migration PR.

### 3.4 `js/debug/remote-protocol.js`

Current role:

- `hex-runtime-remote-v1` debugger-oriented RPC;
- handshake;
- request IDs;
- timeout/error behavior;
- remote debugger adapter creation.

Do not overload this protocol until it becomes an unversioned mixture of unrelated runtime features. Preserve v1 compatibility and introduce a negotiated provider protocol for Phase 10.

### 3.5 `js/runtime-evidence/*`

Current role:

- runtime-evidence schema/lifecycle;
- per-binary identity checks;
- availability/attachment/rejection/expiry/error states;
- claim/correction integration.

This is one of the most important things to preserve. Phase 10 should feed normalized provider observations into the existing evidence direction, then converge it with the central evidence architecture. It SHOULD NOT replace immutable evidence history with mutable “latest runtime state”.

### 3.6 Current gap summary

| Area | Current foundation | Phase 10 gap |
|---|---|---|
| Debugger | adapter + mock + remote v1 | mature provider/event/session model |
| Instrumentation | no equal first-class facet | provider contract + normalized observations |
| Trace import | no equal first-class facet | immutable import/replay provider |
| Emulator | adapter/null foundation | backend-neutral provider facet + evidence identity |
| Runtime identity | session/binary binding foundation | module/build/slice/address mapping |
| Remote protocol | debugger RPC v1 | provider/facet negotiation + async events |
| Evidence | good runtime evidence foundation | normalized event bridge + explicit static links |
| Replay | partial concepts | deterministic event-log replay contract |
| Cross-version | must remain conservative | explicit re-resolution + ambiguity gates |

---

## 4. Hard invariants for every Phase 10 PR

These are implementation rules, not optional polish.

### P10-INV-001 — Runtime evidence never rewrites static truth

The forbidden path is:

```text
runtime observation
  -> mutate Semantic IR / SSA / recovered type as if statically proven
```

The required path is:

```text
runtime observation
  -> normalized RuntimeEvent
  -> RuntimeEvidence
  -> identity/address resolution
  -> supports / contradicts / refines static claims
```

### P10-INV-002 — Every static attachment is identity-bound

A runtime address alone is never sufficient to identify static code.

Any runtime-to-static link MUST be justified by a validated runtime module identity and address mapping.

### P10-INV-003 — Same address does not mean same code

`0x100012340` in two builds is not automatically the same instruction/function.

Cross-version evidence MUST be re-resolved through explicit binary/function matching evidence.

### P10-INV-004 — Path/name equality is not binary identity

A module path or filename can be a hint, never sufficient proof of content identity.

### P10-INV-005 — Unknown/partial stays explicit

Provider unavailable, unsupported operation, incomplete trace, unresolved module, dropped events, disconnected transport, and identity mismatch MUST remain distinct states.

### P10-INV-006 — Runtime mutations retain intervention lineage

Memory writes, register writes, breakpoint modifications, hooks, replacements, emulator state edits, and similar interventions MUST be distinguishable from passive observation.

A later observation after an intervention must not be presented as an untouched natural execution trace.

### P10-INV-007 — High-volume providers are bounded

Instrumentation and traces MUST have cancellation, batching, queue limits, and explicit gap/drop markers. Silent event loss is forbidden.

### P10-INV-008 — Browser UI does not own native debugging authority

The browser talks to versioned provider/transport contracts. Native target/process authority remains behind the provider boundary.

### P10-INV-009 — Compatibility before cleanup

Existing debugger/runtime APIs remain available through compatibility adapters until consumers are migrated and regression gates prove replacement behavior.

---

## 5. Target architecture: provider + facets, not one giant interface

One backend may support several runtime capabilities. For example, one native service might expose debugging plus instrumentation. Therefore the recommended shape is **provider composition with optional facets**, not one enormous inheritance tree.

```text
RuntimeProviderRegistry
        |
        +-- RuntimeProvider A
        |     +-- DebuggerFacet
        |     +-- InstrumentationFacet
        |
        +-- RuntimeProvider B
        |     +-- TraceFacet
        |
        +-- RuntimeProvider C
              +-- EmulatorFacet
```

A target contract can evolve toward:

```ts
interface RuntimeProvider {
  descriptor(): RuntimeProviderDescriptor
  openSession(request, options): Promise<RuntimeSessionHandle>
  closeSession(sessionId, options): Promise<void>
  facets(sessionId): RuntimeFacetSet
}

interface RuntimeFacetSet {
  debugger?: DebuggerProvider
  instrumentation?: InstrumentationProvider
  emulator?: EmulatorProvider
  trace?: TraceProvider
}
```

The exact TypeScript/JavaScript surface may differ, but the architectural properties should remain:

- one provider identity/version;
- one session identity;
- one target/module identity model;
- capability negotiation;
- facet-specific operations;
- one normalized event/evidence plane.

### 5.1 Recommended core objects

Phase 10 should converge around these concepts:

```text
RuntimeProviderRegistry
RuntimeProviderDescriptor
RuntimeSession
RuntimeTargetIdentity
RuntimeModuleIdentity
RuntimeAddressResolution
RuntimeEvent
RuntimeTransport
RuntimeCapabilitySet
RuntimeEvidence
```

Do not add provider-specific IDs to random UI state. Stable runtime identity belongs in the runtime plane.

---

## 6. The first hard problem: target, module, and address identity

This should be implemented before a real new live backend because every provider depends on it.

A useful target shape is:

```ts
RuntimeTargetIdentity {
  providerId
  providerVersion
  runtimeSessionId
  binaryId?
  binaryHash?
  architecture
  platform
  processIdentity?
  startedAt
}
```

A loaded module needs its own identity:

```ts
RuntimeModuleIdentity {
  runtimeModuleId
  binaryId?
  contentHash?
  buildIdentity?
  pathHint?
  architecture
  sliceIdentity?
  preferredImageBase?
  runtimeBase
  runtimeSize
  loadedAt
  unloadedAt?
}
```

`buildIdentity` may use format/platform-native evidence where available, for example a Mach-O UUID, ELF build-id, or PDB identity. Those are useful resolution evidence; they must not be silently treated as a content hash when they are not one.

### 6.1 Address resolution result

Never return only an integer slide.

```ts
RuntimeAddressResolution {
  runtimeAddress
  runtimeModuleId?
  staticAddress?
  staticEntityIds
  state: "exact" | "resolved" | "ambiguous" | "unresolved" | "mismatch"
  evidenceIds
}
```

### 6.2 Resolution order

Prefer stronger evidence first:

1. exact content/binary identity;
2. exact slice + verified build identity;
3. validated module mapping inside the same binary identity;
4. explicit cross-version function/entity match artifact;
5. otherwise ambiguous/unresolved.

Filename/path resemblance can rank candidates but MUST NOT upgrade them to exact identity.

### 6.3 Edge cases that must be designed now

- ASLR/rebased images;
- FAT Mach-O / architecture slices;
- dyld/shared-cache style mappings;
- unloaded/reloaded modules;
- JIT-generated code without a static BinaryId;
- anonymous executable memory;
- copied/renamed binaries;
- same module name from a different build;
- trace data with no content hash;
- emulator images created from transformed inputs.

Runtime-only code can remain runtime-only. Hex must not invent a static address merely to make navigation convenient.

---

## 7. The second hard problem: one normalized RuntimeEvent stream

Debugger callbacks, instrumentation events, emulator steps, and imported traces look different at the backend. They should not look different to the evidence layer.

Recommended normalized envelope:

```ts
RuntimeEvent {
  eventId
  runtimeSessionId
  providerId
  providerVersion
  sequence
  providerEventId?
  timestamp?
  processId?
  threadId?
  runtimeModuleId?
  kind
  payload
  observationMode: "observed" | "intervened" | "synthetic"
  completeness
}
```

Possible `kind` families:

```text
session-start / session-stop
process-start / process-exit
thread-start / thread-exit
module-load / module-unload
paused / resumed
breakpoint-hit / watchpoint-hit
exception / signal
call / return / basic-block
memory-observation
register-snapshot
instrumentation-observation
emulator-checkpoint
trace-marker
gap / dropped-events
provider-warning / provider-error
```

### 7.1 Ordering

A timestamp is not necessarily a total order across threads or remote clocks.

The provider SHOULD supply a monotonic session-local sequence where possible. If the source cannot provide total ordering, the normalized event must say so rather than fabricate one.

### 7.2 Backpressure

High-volume providers MUST NOT push an unbounded event array into the UI thread.

Required behavior:

- bounded queues;
- event batches/pages;
- cancellation;
- high-water handling;
- configurable trace budgets;
- explicit `gap`/`dropped-events` event when data is discarded;
- completeness propagated into derived evidence.

A trace with dropped events may still be useful. It must not be represented as complete.

---

## 8. RuntimeEvent -> RuntimeEvidence -> static evidence

The provider event schema and durable evidence schema should stay separate.

```text
Provider callback / imported record
          |
          v
    RuntimeEvent
          |
          v
identity + address resolution
          |
          v
    RuntimeEvidence
          |
          +--> staticEntityLinks (only when resolved)
          |
          +--> Claim supports/contradicts/refines edges
```

Why separate them:

- events can be high-volume/ephemeral;
- evidence is selected, normalized, durable, and provenance-bearing;
- replay can regenerate the same evidence pipeline;
- provider quirks do not leak into static analysis consumers.

### 8.1 Static fusion rules

**Exact same binary + exact mapping**  
Runtime evidence may attach directly to the matching static entity.

**Unresolved/mismatched identity**  
Evidence may still be stored, but it remains runtime-only and MUST NOT be attached to a static instruction/function.

**Contradiction**  
Create contradiction evidence. Do not overwrite the static result.

**Instrumented/modified execution**  
Retain the intervention lineage so downstream claims know the observation happened after a hook/write/replacement.

**Partial trace**  
Derived claims inherit bounded/partial/truncated completeness.

---

## 9. Remote protocol: evolve through negotiation, not by breaking v1

Current `hex-runtime-remote-v1` is debugger-centric and is useful compatibility surface.

Recommended Phase 10 direction:

```text
hex-runtime-remote-v1
   -> Debugger compatibility adapter

hex-runtime-provider-v2
   -> generic session/provider/facet negotiation
   -> async RuntimeEvent stream
```

The exact version name can be chosen during implementation, but a distinct negotiated protocol is preferable to silently expanding v1 with incompatible assumptions.

### 9.1 Handshake should negotiate

- protocol versions;
- provider identity/version;
- available facets;
- capabilities per facet;
- architecture/platform targets;
- maximum message/read/write sizes;
- event streaming/batching support;
- cancellation/deadline support;
- authentication/authorization requirements where applicable.

### 9.2 Namespace operations

Example organization:

```text
runtime.session.*
runtime.target.*
runtime.events.*
debugger.*
instrumentation.*
emulator.*
trace.*
```

### 9.3 Protocol correctness requirements

- request IDs;
- explicit session IDs;
- schema/version validation;
- timeouts/deadlines;
- cancellation;
- bounded payloads;
- typed failures;
- async event framing;
- disconnect/reconnect semantics;
- no executable callbacks or `eval` supplied by a remote peer.

Typed failures should preserve at least:

```text
unsupported
unavailable
identity-mismatch
resource-limit
cancelled
permission-denied
provider-failure
protocol-mismatch
invalid-input
```

The transport itself should remain abstract. WebSocket, native bridge, local service, or another transport must not become part of the semantic provider contract.

---

## 10. Recommended implementation order

The sequence below is designed to minimize throw-away work and let later tasks parallelize safely.

### P10.0 — Freeze current behavior

Before introducing providers:

- add/confirm contract tests around current runtime session behavior;
- add/confirm debugger adapter capability tests;
- add/confirm remote v1 handshake/error tests;
- capture current runtime-evidence identity behavior;
- document compatibility surfaces that must remain during migration.

**Exit:** current behavior has tests strong enough to detect accidental migration regressions.

### P10.1 — Runtime identity + module map

Implement:

- target identity;
- module identity;
- loaded/unloaded module map;
- runtime-to-static resolution result;
- binary/build/slice mismatch handling.

Do not connect a new real provider yet.

**Exit:** deterministic tests cover ASLR, wrong binary, ambiguous module, module unload, and slice mismatch.

### P10.2 — RuntimeProvider registry + facet contracts

Implement:

- provider descriptor/version;
- provider registry;
- capability set;
- facet discovery;
- compatibility wrapper for current debugger adapter;
- compatibility wrapper for current emulator adapter.

**Exit:** current mock debugger can operate through the new provider path without changing first-party consumers.

### P10.3 — RuntimeEvent + evidence bridge

Implement:

- normalized event envelope;
- batching/backpressure;
- gap markers;
- event -> evidence conversion;
- intervention lineage;
- completeness propagation.

**Exit:** deterministic fake-provider streams generate reproducible runtime evidence.

### P10.4 — Remote provider protocol v2

Implement:

- negotiated provider handshake;
- facet/capability discovery;
- generic session lifecycle;
- async event stream;
- cancellation/deadlines;
- v1 debugger compatibility adapter.

**Exit:** v1 debugger fixtures remain green and a fake v2 provider can expose at least one facet plus events.

### P10.5 — TraceProvider first

Implement the first new real facet as an imported trace provider.

Why first:

- it is read-only;
- deterministic fixtures are easy to reproduce;
- it tests module identity and address resolution without a live process;
- it exercises event normalization and evidence fusion;
- it makes replay semantics concrete before live backends add timing/failure complexity.

Minimum trace support should preserve:

- source tool/provider identity;
- module map/load events when available;
- coverage;
- branch/call sequence when available;
- thread/process identity when available;
- timestamps/order information when available;
- memory observations when available;
- explicit completeness/gaps.

**Exit:** import -> normalize -> replay -> evidence produces stable results for deterministic fixtures.

### P10.6 — Mature DebuggerProvider

Build the mature debugger facet on the shared session/identity/event/protocol plane.

Required core operations:

- launch/attach;
- detach/stop;
- pause/resume/step;
- breakpoints/watchpoints;
- threads/registers;
- memory read/write;
- modules;
- stack frames;
- target state events;
- remote transport.

Do not force the core to choose LLDB/GDB/DbgEng forever. A concrete backend can be selected later while the provider contract remains backend-neutral.

**Exit:** deterministic mock + at least one concrete provider path satisfy the same contract, including identity and event tests.

### P10.7 — Frida-compatible InstrumentationProvider

“Frida-compatible” should mean the Hex provider contract can represent the essential instrumentation model. It does **not** mean Frida becomes Hex's semantic core or mandatory bundled dependency.

Required concepts:

- attach/instrument session;
- module/process discovery;
- intercept/probe;
- call/block tracing where backend supports it;
- memory/process observations;
- batch/high-volume events;
- explicit hook/replacement intervention lineage;
- capability/permission reporting.

**Exit:** instrumentation observations use the same identity, event, evidence, backpressure, and replay rules as debugger/trace events.

### P10.8 — EmulatorProvider interface

Generalize the current emulator path behind the provider facet.

Required evidence metadata:

- engine/provider identity and version;
- binary identity;
- architecture/platform model;
- emulator configuration;
- initial input/state;
- budget/termination reason;
- checkpoints/observations;
- completeness.

Emulator evidence is `synthetic`/experimental runtime evidence. It must not be mislabeled as a direct observation from the real device/process.

**Exit:** current emulator compatibility path and a deterministic test provider satisfy the common contract.

### P10.9 — Fusion, replay, cross-version gates, query/UI exposure

Finish:

- static/runtime evidence links;
- support/contradiction/refinement behavior;
- exact replay path;
- cross-version re-resolution path;
- ambiguity thresholds/gates;
- paged/snapshot runtime query APIs;
- UI states for unresolved/partial/mismatched runtime data.

**Exit:** all canonical Phase 10 gates are proven with positive and negative tests.

---

## 11. Why the order matters

The dependency chain is:

```text
identity/module mapping
        |
        v
provider/facet contract
        |
        v
normalized events
        |
        +----------------+
        |                |
        v                v
remote protocol       TraceProvider
        |                |
        v                |
DebuggerProvider         |
InstrumentationProvider  |
EmulatorProvider          |
        +----------------+
                |
                v
       evidence fusion/replay
```

If a live debugger is integrated before identity/event contracts, its backend-specific assumptions will leak into the core and then every later provider will need adapters around debugger-shaped semantics.

After P10.2/P10.3 are stable, several implementation tracks can run in parallel:

- trace fixtures/provider;
- remote provider client/server;
- debugger backend bridge;
- instrumentation bridge;
- fusion/replay tests.

Do **not** parallelize foundational schema design with multiple consumers before the schema contract is frozen enough to avoid repeated churn.

---

## 12. Provider-specific hard parts

### 12.1 DebuggerProvider

Hard parts:

- target state is asynchronous;
- pause/resume races;
- module load/unload during a session;
- breakpoint/watchpoint lifecycle;
- thread-local vs process-global state;
- stale register/frame snapshots;
- remote disconnection/reconnect;
- writes must be marked as interventions.

Design rule: state transitions should be driven by provider events/acknowledged operations, not inferred only from UI button presses.

### 12.2 InstrumentationProvider

Hard parts:

- extremely high event volume;
- hooks can alter target behavior;
- dynamically generated code;
- module churn;
- event drops under pressure;
- backend permissions/injection failures.

Design rule: event volume management and intervention lineage are part of correctness, not later performance polish.

### 12.3 TraceProvider

Hard parts:

- source tools provide different levels of identity;
- incomplete traces are common;
- ordering may be partial;
- some traces have addresses but no module identity;
- imported data may refer to a different binary version.

Design rule: importing a trace successfully does not imply that it can be attached to the currently open binary.

### 12.4 EmulatorProvider

Hard parts:

- emulator state is not real target state;
- engine configuration affects behavior;
- OS/runtime semantics may be incomplete;
- deterministic replay depends on controlled inputs/environment;
- unsupported syscalls/instructions must remain explicit.

Design rule: record enough environment/configuration metadata for the observation to be reproducible or explicitly marked non-reproducible.

---

## 13. Replay model

A Phase 10 event stream should be replayable through the same evidence pipeline where practical.

Replay records need enough information to reconstruct interpretation:

```text
provider id/version
target/binary identity
runtime session identity
module map changes
ordered/partially ordered RuntimeEvents
inputs/configuration when applicable
gap/drop markers
intervention markers
protocol/schema versions
```

### 13.1 Replay modes

**Exact replay**  
Same verified binary identity and compatible schema/provider semantics. Static links may be restored deterministically.

**Re-resolution**  
Same intended target but module/static mapping is reconstructed from recorded identity evidence.

**Cross-version candidate replay**  
Different binary identity. Runtime events remain valid historical evidence, but static attachments require an explicit cross-binary/function/entity match with confidence and ambiguity metadata.

### 13.2 Forbidden shortcut

Never do:

```text
old runtime address == new runtime address
=> same static instruction
```

Even if it appears to work on a small fixture.

---

## 14. Static/runtime contradiction semantics

Example:

```text
Static analysis claim:
  branch B appears unreachable under current proven constraints

Runtime observation:
  verified same binary/session executes B
```

The correct result is not “replace static truth with runtime truth”.

The correct result is:

```text
RuntimeEvidence executes B
  -> contradicts static Claim
  -> investigation points to incomplete/incorrect static assumptions
```

This preserves the evidence chain and makes regressions debuggable.

Similarly, one runtime path cannot prove that a branch is globally unreachable simply because it was not observed.

---

## 15. Browser/iPad performance rules

Phase 10 can become an accidental memory/latency disaster if runtime streams are treated like ordinary UI state.

Required direction:

- no unbounded event arrays in the main thread;
- batch transferable data between workers/transport and runtime core;
- page history/evidence queries;
- persist cold trace/evidence artifacts when appropriate;
- virtualize large event/trace views;
- keep live hot state small;
- use cancellation and explicit budgets;
- avoid one JS object per event for millions of retained events when a compact representation is possible;
- preserve a non-SharedArrayBuffer correctness path;
- make reconnect/provider loss explicit rather than freezing stale state as “live”.

A high-frequency instrumentation provider SHOULD expose configurable event categories/sampling/limits before events reach the UI.

---

## 16. Security and hostile-provider model

Runtime providers, imported traces, remote services, target strings/symbols, and provider metadata are untrusted inputs.

Phase 10 must defend against:

- malformed protocol messages;
- oversized payloads;
- invalid/overflowing addresses;
- malicious module/symbol/path strings;
- event floods;
- stale/cross-binary sessions;
- provider impersonation/identity confusion;
- protocol downgrade mistakes;
- injected executable callback/code data;
- unauthorised mutation operations;
- compromised remote provider output.

Minimum rules:

- strict schema validation;
- bounded message/event sizes;
- checked address arithmetic/BigInt handling;
- explicit capability checks;
- explicit mutation permissions;
- authentication/authorization at remote transport boundaries where supported/required;
- no remote `eval` or arbitrary callback execution;
- no provider output becomes AI/system instruction authority;
- no provider observation becomes a verified static fact merely because it came from a privileged backend.

---

## 17. Candidate file/module boundaries

This is a direction, not a requirement to perform a mass move.

```text
js/runtime/
  provider.js
  registry.js
  identity.js
  address-map.js
  events.js
  session.js
  protocol/
    provider-v2.js
  providers/
    debugger-compat.js
    trace.js
    instrumentation.js
    emulator.js
```

Compatibility strategy:

- keep `js/runtime/index.js` as the public/facade composition point while internals migrate;
- keep `js/debug/adapter.js` as a compatibility API until debugger consumers move;
- preserve `js/debug/remote-protocol.js` v1 and wrap it as a debugger provider path;
- evolve `js/runtime/session.js` rather than replacing all callers at once;
- integrate `js/runtime-evidence/*` into the normalized evidence path without losing existing identity/rejection behavior.

File movement by itself is not a Phase 10 deliverable.

---

## 18. Test strategy

Tests should be built around contracts and negative cases before real-provider complexity.

### 18.1 Provider contract tests

- provider ID/version required;
- facets discoverable by capability;
- unsupported facet is typed `unsupported`;
- unavailable backend is distinct from unsupported;
- session cannot be accidentally used by another provider;
- cancellation propagates;
- capability negotiation is immutable for a negotiated session unless a versioned update event says otherwise.

### 18.2 Identity/address tests

- exact binary attaches;
- wrong content hash rejects static link;
- ASLR mapping resolves correctly;
- module load creates mapping;
- module unload invalidates later mapping;
- same module filename + different hash remains mismatch;
- wrong FAT slice/architecture remains mismatch;
- anonymous/JIT address remains runtime-only when unresolved;
- cross-version same VA does not auto-link.

### 18.3 RuntimeEvent tests

- sequence/order preserved where supplied;
- partial ordering not fabricated;
- batching produces same logical evidence as individual events;
- overflow emits explicit gap/drop marker;
- cancelled stream stops ingestion;
- malformed event is rejected without corrupting session state.

### 18.4 Remote protocol tests

- version negotiation;
- facet negotiation;
- unsupported capability;
- request timeout;
- cancellation;
- disconnect/reconnect;
- oversized message rejection;
- invalid session rejection;
- v1 debugger compatibility through shim;
- async event framing order.

### 18.5 TraceProvider tests

- import deterministic fixture;
- replay yields stable normalized events/evidence;
- missing identity remains unresolved;
- wrong binary does not attach;
- gaps propagate `partial`/`truncated` completeness;
- thread/process identity preserved when source supplies it.

### 18.6 DebuggerProvider tests

- attach/detach;
- pause/resume/step;
- break/watchpoint lifecycle;
- thread/register/frame snapshot invalidation;
- memory read;
- memory write marked as intervention;
- module load/unload events normalized;
- target exit/disconnect transitions session state correctly.

### 18.7 InstrumentationProvider tests

- hook/probe observation normalized;
- hook/replacement marked as intervention;
- high-volume batching;
- backpressure/drop marker;
- dynamic module events;
- provider unavailable/permission failure typed correctly.

### 18.8 EmulatorProvider tests

- engine/provider version recorded;
- config/input identity recorded;
- deterministic fixture replay;
- budget termination produces partial result;
- unsupported operation remains explicit;
- emulator observation marked synthetic, not real-target observation.

### 18.9 Static/runtime fusion tests

- runtime evidence cannot mutate Semantic IR directly;
- exact identity attaches evidence to correct entity;
- mismatched identity stores evidence without static link;
- runtime contradiction creates contradiction state/edge;
- user/project static facts are not silently overwritten;
- corrections preserve immutable evidence history.

### 18.10 Cross-version negative tests

These deserve a dedicated small corpus because they prevent the most dangerous false confidence:

- build A and build B use same VA for different functions;
- same filename but different content;
- same source function moved to a different address;
- one source function split/merged after optimization;
- ambiguous top two function matches;
- trace references module not present in current binary.

Expected default: unresolved/ambiguous until an explicit match artifact proves enough.

---

## 19. Exit gates: turn the master architecture into measurable checks

### Gate A — Runtime evidence identity binding

Pass only if:

- every durable runtime evidence item has provider/session identity;
- static-linked runtime evidence has a validated binary/module/address resolution;
- mismatched identity never produces a static link;
- unresolved evidence remains inspectable rather than discarded;
- module unload/reload cannot accidentally reuse stale mappings.

### Gate B — Static/runtime fusion

Pass only if tests prove:

- runtime observations do not directly mutate static Semantic IR/SSA/types;
- support/refinement/contradiction is represented through evidence/claims;
- intervention lineage is preserved;
- partial/truncated runtime evidence cannot masquerade as complete proof.

### Gate C — Replay/cross-version ambiguity

Pass only if:

- deterministic trace replay reproduces equivalent normalized evidence;
- wrong binary identity is blocked;
- same-address/different-build shortcuts are blocked;
- cross-version attachment requires explicit match evidence;
- ambiguous cross-version matches remain ambiguous;
- replay records provider/schema versions and event gaps.

### Additional compatibility gate

Before removing any legacy path:

- existing debugger adapter behavior remains covered;
- `hex-runtime-remote-v1` supported behavior remains green through compatibility path;
- current runtime-evidence rejection/identity behavior is not weakened.

---

## 20. Suggested PR breakdown

Keep each PR small enough that failures are attributable.

| PR | Scope | Must not include |
|---|---|---|
| P10.0 | baseline/contract tests + docs | new real backend |
| P10.1 | target/module/address identity | debugger feature work |
| P10.2 | provider registry/facets + compat adapters | protocol rewrite |
| P10.3 | RuntimeEvent + evidence bridge | real instrumentation backend |
| P10.4 | remote provider protocol + v1 shim | UI redesign |
| P10.5 | TraceProvider + replay fixtures | debugger mutation operations |
| P10.6 | mature DebuggerProvider | instrumentation-specific tracing |
| P10.7 | InstrumentationProvider | static IR changes |
| P10.8 | EmulatorProvider interface | mandatory third-party engine dependency |
| P10.9 | fusion/replay/cross-version/UI-query gates | unrelated architecture cleanup |

This breakdown is intentionally dependency-shaped. After P10.3, some later PRs can proceed in parallel if they consume frozen contracts.

---

## 21. Decisions worth freezing before implementation starts

These choices remove high-cost ambiguity later.

### Decision 1 — Provider is facet composition

**Recommendation:** yes.

One provider/session can expose debugger, instrumentation, emulator, or trace facets as supported. Avoid separate incompatible session systems.

### Decision 2 — Keep remote v1 compatibility and add negotiated provider protocol

**Recommendation:** yes.

Do not silently mutate `hex-runtime-remote-v1` into a different contract.

### Decision 3 — Implement TraceProvider before the first new live provider

**Recommendation:** yes.

It validates identity, event normalization, replay, and fusion with deterministic fixtures and minimal external instability.

### Decision 4 — Runtime address resolution is module-aware, not a global slide integer

**Recommendation:** mandatory.

This is necessary for ASLR, multiple modules, unload/reload, shared caches, JIT, and cross-version safety.

### Decision 5 — Event log is append-oriented and gap-aware

**Recommendation:** yes.

History/evidence should not depend on mutable “current runtime state” objects.

### Decision 6 — Frida is an optional provider/backend boundary

**Recommendation:** yes.

Adopt the instrumentation model and provider contract; do not make a particular engine the only valid implementation.

### Decision 7 — Emulator evidence has distinct observation semantics

**Recommendation:** yes.

Use `synthetic`/experimental evidence metadata so emulator behavior cannot be confused with direct observation from a real device.

### Decision 8 — Cross-version links default to unresolved

**Recommendation:** mandatory.

Only explicit binary/function/entity matching can promote them.

### Decision 9 — No mass path cleanup in Phase 10 foundation PRs

**Recommendation:** yes.

Compatibility facades reduce conflict and make regression bisection much easier.

---

## 22. Work that can be prepared before Phase 10 coding begins

Doing these early makes the actual Phase 10 implementation substantially faster:

1. **Create a tiny deterministic runtime fixture corpus.**
   - one same-binary ASLR trace;
   - one wrong-binary trace;
   - one module load/unload trace;
   - one event-gap trace;
   - one intervention trace;
   - one cross-version ambiguous trace.

2. **Freeze the identity vocabulary.**
   - BinaryId/content hash;
   - runtime session ID;
   - runtime module ID;
   - build identity;
   - slice identity;
   - runtime/static address resolution state.

3. **Freeze the event envelope.**
   Backend-specific payload can evolve, but session/provider/sequence/completeness/intervention fields should not churn across every provider PR.

4. **Freeze protocol error classes.**
   Do not let every provider invent different strings for unavailable/unsupported/mismatch/cancelled.

5. **Build a fake provider harness.**
   Most contract, transport, replay, and evidence tests should not require LLDB/Frida/a real device.

6. **Keep real backend selection behind the contract.**
   Backend research/integration can proceed independently once the common surface is stable.

---

## 23. What should be parallelized vs serialized

### Serialize

These should have one owner until their contract is stable:

- target/module identity schema;
- address resolution rules;
- RuntimeEvent envelope;
- provider capability vocabulary;
- provider protocol version/handshake;
- static/runtime fusion rules.

Conflicting versions of these create repository-wide churn.

### Parallelize after the foundation freezes

Good independent tracks:

- trace fixture corpus + TraceProvider;
- v2 remote client/server transport implementation;
- debugger backend bridge;
- instrumentation backend bridge;
- emulator compatibility provider;
- evidence/replay negative-test corpus;
- runtime UI/query projection.

Each track should consume the same provider/session/event/identity contracts and avoid editing them casually.

---

## 24. Common implementation traps

### Trap 1 — “Debugger adapter already exists, so Phase 10 is mostly backend wiring”

False. The largest unsolved risks are shared identity/event/evidence contracts.

### Trap 2 — “ASLR is only one slide”

False for multi-module, shared-cache, unload/reload, JIT, and transformed images. Resolve through module identity.

### Trap 3 — “Observed at runtime means confirmed globally”

False. One execution path confirms only the scoped observation it actually made.

### Trap 4 — “No event seen means event cannot happen”

False unless coverage/completeness makes that absence meaningful.

### Trap 5 — “Imported trace belongs to current binary because addresses look right”

Unsafe. Require identity/re-resolution.

### Trap 6 — “Instrumentation is read-only observation”

Not always. Hooks/replacements and even probes can perturb behavior. Preserve intervention lineage.

### Trap 7 — “Dropped trace events are just a performance issue”

No. They change what can be concluded. Emit explicit gaps and downgrade completeness.

### Trap 8 — “Remote backend is trusted because it is privileged”

No. Validate schemas, identities, sizes, permissions, and evidence exactly as with other external inputs.

### Trap 9 — “Implement LLDB/Frida first and abstract later”

Likely to leak one backend’s lifecycle, IDs, errors, and event model into the core. Build the minimum shared contract first, then prove it with a fake/trace provider.

### Trap 10 — “Clean up all old runtime paths while adding providers”

Avoid. Keep compatibility adapters until the new route is proven and consumers have migrated.

---

## 25. Definition of done for Phase 10

Phase 10 is done when all of the following are true, not merely when one debugger can attach:

- [ ] Runtime providers have versioned provider/session identity.
- [ ] Debugger, Instrumentation, Emulator, and Trace are first-class facets of one runtime model.
- [ ] Runtime module identity and address mapping are explicit and tested.
- [ ] Runtime events are normalized, ordered as far as evidence permits, bounded, cancellable, and gap-aware.
- [ ] Runtime evidence can exist without a static mapping.
- [ ] Static links require validated binary/module/address resolution.
- [ ] Runtime intervention lineage is preserved.
- [ ] A negotiated provider remote protocol exists.
- [ ] Existing debugger remote v1 behavior remains available through compatibility support until deliberately retired.
- [ ] A deterministic TraceProvider/replay path proves the shared contracts.
- [ ] A mature DebuggerProvider uses the same contracts.
- [ ] A Frida-compatible InstrumentationProvider uses the same contracts.
- [ ] EmulatorProvider is backend-neutral and records reproducibility/configuration evidence.
- [ ] Static/runtime support/refinement/contradiction is evidence-based, not direct static mutation.
- [ ] Replay is versioned and preserves gaps/interventions.
- [ ] Cross-version same-address auto-linking is impossible by default.
- [ ] Cross-version attachment requires explicit match evidence and ambiguity handling.
- [ ] Negative identity/replay tests are green.
- [ ] High-volume event ingestion stays within explicit resource budgets.
- [ ] Provider/transport failures cannot corrupt static project state.

---

## 26. Recommended first implementation move when Phase 10 starts

Do **not** start by integrating a live debugger.

Start with one focused PR that adds:

1. `RuntimeTargetIdentity`;
2. `RuntimeModuleIdentity`;
3. module-aware runtime/static address resolution;
4. explicit mismatch/ambiguous/unresolved states;
5. deterministic fixtures/tests for ASLR, wrong binary, wrong slice, module unload, and same-address cross-version mismatch.

Once that is stable, build the provider registry and event plane on top of it.

That sequence makes every later backend—debugger, Frida-compatible instrumentation, emulator, trace import, remote device—simpler and safer because they no longer need to solve identity independently.

---

## 27. Phase 10 mental model

Keep this model during review:

```text
Live/imported backend
       |
       v
 RuntimeProvider
       |
       v
 RuntimeSession
       |
       +--> RuntimeModule identities
       |
       v
  RuntimeEvent stream
       |
       v
 identity/address resolution
       |
       v
  RuntimeEvidence
       |
       +--> supports static claim
       +--> contradicts static claim
       +--> refines static claim
       +--> remains runtime-only when unresolved

Never:
RuntimeProvider -> silently rewrite static truth
```

If each implementation PR preserves that boundary, Phase 10 can add powerful live analysis without turning Hex into several incompatible analysis engines.