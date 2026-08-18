# Phase 10 — Runtime Providers Implementation Guide

> **Status:** Implementation planning guide  
> **Scope:** Phase 10 only  
> **Normative authority:** `docs/HEX_MASTER_ARCHITECTURE.md`  
> **Current-state baseline reviewed:** `e90c5107f9c77d73687ee452d5042dcbe9e79ece`  
> **Primary constraint:** Browser/iPad-first, evidence-first, compatibility-first  
> **Purpose:** Remove expensive design uncertainty before Phase 10 implementation/hardening begins.

This document is deliberately non-normative. If it conflicts with `docs/HEX_MASTER_ARCHITECTURE.md` or a later accepted ADR, the master architecture/ADR wins.

The baseline SHA above is the repository state reviewed while writing this guide. Revalidate the small set of runtime files listed below when Phase 10 work actually starts; the repository is moving quickly.

---

## 1. Phase 10 in one sentence

Phase 10 turns Hex's already substantial debugger/runtime/replay foundations into a **first-class, versioned Runtime Provider plane** where Debugger, Instrumentation, Emulator, and Trace capabilities share one session/identity/evidence model and can never become a second static semantic truth.

The canonical Phase 10 deliverables are:

- mature debugger provider;
- Frida-compatible instrumentation provider;
- trace provider;
- emulator provider interface;
- remote protocol.

The canonical exit gates are:

- runtime evidence identity binding;
- static/runtime fusion tests;
- replay/cross-version ambiguity gates.

The important correction to keep in mind is that Phase 10 is **not greenfield**. Current `main` already has debugger abstractions, remote protocol hardening, LLDB/Frida-compatible adapters, replay support, event backpressure, runtime evidence, trace-to-fact extraction, and cross-version replay gates. Phase 10 should consolidate and finish those pieces rather than recreate them.

---

## 2. What is already implemented and must be preserved

### 2.1 `js/debug/adapter.js`

Current implementation already provides a meaningful debugger contract:

- protocol version constant (`DEBUG_PROTOCOL_VERSION = 1`);
- normalized capability vocabulary;
- attach/launch/pause/resume/step operations;
- address/function/conditional breakpoints;
- memory watchpoints;
- register and memory read/write;
- thread/module/backtrace access;
- evaluation;
- function/call/return/branch/memory tracing capability flags;
- Objective-C/Swift runtime capability flags;
- cancellation and replay capabilities;
- strict address/integer validation;
- capability negotiation and typed `DebugAdapterError` failures.

**Preserve:** the capability discipline and strict validation.  
**Do not assume:** a debugger-shaped capability list is the final universal Runtime Provider model.

### 2.2 `js/adapters/index.js`

Current implementation is significantly ahead of a minimal skeleton. It already includes:

- `LocalFunctionSandboxAdapter`;
- `RemoteDebugAdapter`;
- `LLDBCompatibleAdapter`;
- `FridaCompatibleAdapter`;
- `ReplayAdapter`;
- emulator/symbolic-related adapter paths;
- bounded remote arrays and trace sizes;
- runtime memory mapping;
- trace ring buffers;
- remote-response validation.

The LLDB/Frida adapters are currently **compatibility adapters over the debugger/remote-adapter vocabulary**, not yet proof that Debugger and Instrumentation are clean first-class provider facets. That distinction matters.

**Preserve:** the existing concrete compatibility behavior and fixtures.  
**Refactor toward:** provider/facet composition without forcing all runtime backends through a debugger-shaped interface forever.

### 2.3 `js/runtime/index.js`

Current `RuntimeAnalysisPlatform` already does real orchestration:

- adapter registration/selection;
- local and symbolic runtime paths;
- remote adapter creation, including LLDB/Frida-compatible variants;
- replay adapter creation;
- runtime session creation;
- cancellation propagation through operation controllers;
- experiments and hypothesis verification;
- function tracing;
- trace-to-semantic-fact extraction;
- runtime evidence creation;
- static/dynamic fusion;
- replay shape production;
- cross-binary replay re-resolution with confidence and ambiguity gates.

Current cross-version replay already rejects unsafe automatic reuse unless re-resolution is explicitly accepted with strong enough identity confidence and ambiguity margin. **Do not weaken this while generalizing the provider plane.**

### 2.4 `js/runtime/session.js`

Current `DebugSession` / `DebugSessionManager` already provide:

- bounded concurrent session count;
- one-adapter-per-live-session protection;
- binary hash binding;
- adapter event subscription;
- module/thread refresh;
- session epochs;
- stale-event rejection by epoch;
- cancellation of operations on epoch changes;
- bounded trace/observation state;
- serializable versioned session/replay shapes;
- deterministic close/disconnect handling.

This is a strong seed, but the session still thinks primarily in terms of a `DebugAdapter`. Phase 10 should evolve it toward a provider session without discarding its lifecycle/epoch protections.

### 2.5 `js/debug/remote-protocol.js`

Remote protocol v1 is already hardened substantially:

- versioned packet validation;
- bounded packet/array/object/string sizes;
- plain-data-only wire values;
- BigInt and byte-array wire encodings;
- blocked host-command methods;
- request IDs;
- epochs;
- stale request invalidation;
- timeout and cancellation;
- bounded pending requests;
- event-rate and event-byte backpressure;
- explicit stream truncation signal;
- listener isolation.

This means Phase 10 should **extend/compose** the protocol, not throw away working hardening.

### 2.6 `js/runtime-evidence/index.js`

Current runtime evidence already has important semantics:

- runtime provenance group;
- backend, binary hash, slice identity, session identity;
- timestamp and reproducibility metadata;
- experiment evidence;
- trace-to-semantic-fact conversion;
- trace completeness/truncation metadata;
- Objective-C/Swift dispatch comparisons;
- runtime type annotations that remain non-permanent;
- static/dynamic fusion that filters by binary hash, slice, and function identity;
- support/contradiction handling without directly overwriting static analysis;
- runtime tools that require evidence-bearing results.

This is a core safety foundation. Generalization must not regress its identity filtering or conservative fusion behavior.

---

## 3. Current-state gap: what Phase 10 is actually finishing

| Area | Current state | Remaining Phase 10 work |
|---|---|---|
| Debugger | strong adapter contract + LLDB-compatible remote adapter | promote to mature provider facet/session semantics; backend-neutral event/state contract |
| Instrumentation | Frida-compatible adapter capabilities exist | first-class instrumentation operations/events/intervention semantics, not merely debugger-shaped tracing |
| Replay/Trace | ReplayAdapter, trace ring buffer, trace facts, replay gates exist | first-class immutable `TraceProvider`, normalized replay event model, module-aware identity |
| Emulator | local sandbox/emulator adapter paths exist | explicit backend-neutral `EmulatorProvider` facet and evidence semantics |
| Runtime identity | binary hash/slice/session checks exist | module identity, build identity, runtime load mapping, ASLR/JIT/unload/reload-safe resolution |
| Remote protocol | robust v1 debugger RPC/event protocol | provider/facet negotiation and generic runtime session/event envelope while retaining v1 compatibility |
| Events | adapter events + traces exist | one normalized `RuntimeEvent` envelope across debugger/instrumentation/emulator/trace |
| Evidence | strong runtime evidence/fusion foundation | module-aware static links, intervention lineage, normalized provider provenance |
| Cross-version | replay confidence/ambiguity gate already exists | generalize from function replay to all runtime/static attachments and module/entity mapping |
| Browser performance | bounded traces/protocol backpressure already exists | end-to-end stream batching/paging/persistence and explicit gap semantics across providers |

The biggest missing abstraction is therefore not “LLDB support” or “Frida support”. It is **a provider-level identity/event contract above existing adapters**.

---

## 4. Non-goals

Phase 10 should not:

- rewrite Semantic IR/SSA/MemorySSA;
- make runtime analysis required for static analysis;
- turn `FridaCompatibleAdapter` into semantic authority;
- replace current safe replay gates with address-only heuristics;
- expose native debugger APIs directly to browser UI code;
- require one particular debugger/instrumentation/emulator implementation forever;
- store unlimited live trace objects on the main thread;
- mark a runtime observation as globally confirmed when only one path/input was observed;
- treat “not observed” as “impossible” without a completeness proof;
- mass-move runtime files just to match the target directory tree;
- remove remote protocol v1 in the same PR that introduces the new provider abstraction.

---

## 5. Hard invariants for every Phase 10 PR

### P10-INV-001 — Runtime evidence never rewrites static truth

Required flow:

```text
runtime observation
  -> normalized runtime event
  -> runtime evidence
  -> identity/address resolution
  -> supports / contradicts / refines static claim
```

Forbidden flow:

```text
runtime observation
  -> silently mutate Semantic IR / SSA / recovered type
```

### P10-INV-002 — Static attachment requires validated identity

A runtime address alone is never enough.

A static link needs validated binary/module/address resolution. If identity is insufficient, retain runtime evidence as unresolved runtime-only evidence.

### P10-INV-003 — Existing binary/slice/replay safety is the minimum floor

Current binary hash/slice filtering and cross-version confidence/ambiguity gates must remain equally strict or become stricter.

### P10-INV-004 — Same VA does not mean same entity across builds

```text
old VA == new VA
```

is never a sufficient cross-version match.

### P10-INV-005 — Unknown/partial/truncated remain distinct

Provider unavailable, unsupported capability, identity mismatch, event drop, incomplete trace, transport disconnect, and analysis failure must not collapse into one generic failure.

### P10-INV-006 — Mutations leave intervention lineage

Memory/register writes, hook replacements, injected probes, emulator state edits, and similar actions change the experiment. Later evidence must retain that lineage.

### P10-INV-007 — Event loss is explicit

Current remote protocol already exposes stream truncation under backpressure. Provider-level normalization must preserve or improve that behavior. Never silently drop events and report complete evidence.

### P10-INV-008 — All long work remains cancellable/budgeted

Current abort/epoch/backpressure mechanisms are assets. Provider generalization must not introduce uncancellable streams or unbounded queues.

### P10-INV-009 — Compatibility adapters survive staged migration

Current adapter APIs remain usable until their consumers have migrated and differential tests prove the provider path.

---

## 6. Target architecture: provider + optional facets

A provider is the owner of target/session identity and may expose one or more runtime facets.

```text
RuntimeProviderRegistry
        |
        +-- Provider A
        |     +-- DebuggerFacet
        |     +-- InstrumentationFacet
        |
        +-- Provider B
        |     +-- TraceFacet
        |
        +-- Provider C
              +-- EmulatorFacet
```

Do not create four unrelated session systems.

A target shape can be:

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

The concrete API can evolve, but it should preserve these properties:

- provider ID + semantic/protocol version;
- session ID;
- target identity;
- module map;
- capability negotiation;
- facet-specific operations;
- normalized events;
- evidence provenance;
- cancellation/resource budget.

### 6.1 Migration relationship with current adapters

```text
DebugAdapter / RemoteDebugAdapter
          |
          v
Debugger compatibility facet
          |
          v
RuntimeProvider session
```

`LLDBCompatibleAdapter` can become one debugger-provider implementation path.

`FridaCompatibleAdapter` should not simply be renamed to InstrumentationProvider. It can remain a compatibility route while first-class instrumentation operations are added separately.

`ReplayAdapter` is a strong seed for TraceProvider/replay compatibility, but imported traces should eventually have a trace-native contract rather than pretending they are always live debuggers.

---

## 7. Hardest problem #1: runtime module identity and address mapping

Current code has binary hash and slice checks, but Phase 10 needs **module-aware runtime identity**.

A useful target identity shape:

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

Loaded modules need independent identity:

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

`buildIdentity` may represent format/platform-native identifiers such as Mach-O UUID, ELF build-id, or PDB identity. Those are identity evidence, not automatically equivalent to a content hash.

### 7.1 Address resolution must return a state, not just a slide

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

### 7.2 Resolution preference

Prefer stronger evidence:

1. exact binary/content identity;
2. exact slice + verified build identity;
3. validated module mapping inside the same binary identity;
4. explicit cross-version entity/function match artifact;
5. otherwise ambiguous/unresolved.

Path/name similarity may rank candidates but cannot promote them to exact identity.

### 7.3 Cases to support explicitly

- ASLR/rebasing;
- multiple loaded modules;
- FAT Mach-O slices;
- module unload/reload;
- same filename, different binary;
- copied/renamed binary;
- JIT code;
- anonymous executable memory;
- shared-cache-style mappings;
- imported trace with incomplete identity;
- emulator-generated/transformed images.

Runtime-only code is valid. Hex does not need to invent a static address for every runtime PC.

---

## 8. Hardest problem #2: normalized RuntimeEvent

Current adapters and traces already emit events, but each backend should converge on one provider-level envelope.

```ts
RuntimeEvent {
  eventId
  runtimeSessionId
  providerId
  providerVersion
  sequence?
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

Suggested event families:

```text
session-start / session-stop
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
emulator-checkpoint
trace-marker
gap / dropped-events
provider-warning / provider-error
```

### 8.1 Ordering

Do not infer a global order only from wall-clock timestamps.

Where possible, providers should expose a monotonic session-local sequence. If an imported/remote source only gives partial ordering, preserve that fact.

### 8.2 Backpressure

Current protocol already has event-rate/byte budgets and stream-truncation notification. Generalize this rather than reimplementing it independently per provider.

Required end-to-end properties:

- bounded queue;
- batches/pages;
- cancellation;
- explicit gap/drop event;
- completeness downgrade;
- no unbounded UI array;
- no “complete” evidence after silent loss.

---

## 9. Hardest problem #3: event -> evidence -> static fusion

Keep event transport separate from durable evidence.

```text
backend callback / imported record
          |
          v
     RuntimeEvent
          |
          v
identity + module/address resolution
          |
          v
    RuntimeEvidence
          |
          +--> staticEntityLinks only if resolved
          +--> supports / contradicts / refines claims
```

Why this separation matters:

- raw events can be high-volume and short-lived;
- evidence is selected and provenance-bearing;
- replay can regenerate evidence deterministically;
- provider-specific payload does not leak into static analyzers;
- runtime-only unresolved evidence remains representable.

### 9.1 Preserve current fusion strengths

Current `fuseStaticDynamic()` already filters by binary hash, slice identity, and function address, groups correlated runtime evidence, and distinguishes support/contradiction.

Phase 10 should generalize this toward module/entity identity rather than replace it with a weaker generic confidence combiner.

### 9.2 Intervention semantics

Add explicit lineage for:

- register write;
- memory write;
- hook install/remove;
- function replacement;
- emulator state mutation;
- synthetic input injection.

Evidence observed after an intervention is still valuable but must carry the experiment lineage.

---

## 10. Remote protocol strategy

Current v1 is already robust enough that a replacement must justify itself.

Recommended architecture:

```text
DEBUG_PROTOCOL_VERSION = 1
  -> preserved debugger compatibility protocol

Runtime provider protocol v2 (or equivalent negotiated envelope)
  -> provider/session negotiation
  -> facet discovery
  -> generic RuntimeEvent stream
  -> can host debugger compatibility operations
```

Do not silently redefine v1 semantics.

### 10.1 Reuse v1 mechanisms

Preserve/reuse:

- checked wire encoding;
- BigInt/bytes serialization;
- packet size/depth limits;
- request IDs;
- epoch invalidation;
- timeout/cancellation;
- pending-request backpressure;
- event backpressure;
- blocked command execution;
- listener isolation.

### 10.2 New handshake should negotiate

- protocol version(s);
- provider ID/version;
- available facets;
- capabilities per facet;
- target architecture/platform;
- maximum request/event payloads;
- streaming/batching support;
- cancellation/deadline support;
- authentication/authorization requirements where applicable.

### 10.3 Suggested namespaces

```text
runtime.session.*
runtime.target.*
runtime.events.*
debugger.*
instrumentation.*
emulator.*
trace.*
```

### 10.4 Typed failures

Keep/debug-normalize at least:

```text
unsupported
unavailable
invalid-input
identity-mismatch
resource-limit
backpressure
cancelled
timeout
disconnected
permission-denied
provider-failure
protocol-mismatch
```

Transport remains abstract. WebSocket/native bridge/local service is deployment detail, not provider semantics.

---

## 11. Recommended implementation order

This order now assumes the existing runtime/adapters/replay work on current `main`.

### P10.0 — Baseline and contract freeze

Before refactoring:

- pin tests around `DebugAdapter` capability negotiation;
- pin current `RemoteProtocolClient` epoch/cancel/backpressure behavior;
- pin `DebugSession` lifecycle/serialization/replay behavior;
- pin LLDB/Frida/Replay compatibility adapter behavior;
- pin `traceToSemanticFacts()` completeness/truncation behavior;
- pin `fuseStaticDynamic()` identity rejection;
- pin current cross-version replay confidence/ambiguity gate.

**Exit:** migration cannot accidentally make current runtime safety weaker.

### P10.1 — Module-aware runtime identity

Add the missing identity layer:

- runtime target identity;
- runtime module identity;
- build/slice identity;
- loaded/unloaded module map;
- runtime address resolution state;
- explicit mismatch/ambiguity states.

Keep existing binaryHash behavior as a compatibility input.

**Exit:** tests cover ASLR, wrong binary, wrong slice, module unload/reload, same-name/different-build, JIT/unresolved address.

### P10.2 — RuntimeProvider registry and facets

Introduce:

- provider descriptor/version;
- provider registry;
- provider session;
- facet discovery/capability sets;
- DebugAdapter -> DebuggerFacet compatibility wrapper;
- ReplayAdapter -> Trace/Replay compatibility wrapper;
- emulator compatibility wrapper.

Do not delete `DebugAdapter`.

**Exit:** existing local/remote/LLDB/Frida/replay paths can still run through compatibility layers.

### P10.3 — Normalize RuntimeEvent

Create provider-level events and adapters from current trace/remote event shapes.

Implement:

- event identity;
- sequence/ordering metadata;
- observation mode;
- completeness;
- gap/drop normalization;
- module load/unload events;
- event batching.

**Exit:** current adapter traces can be projected into normalized events without losing truncation/epoch information.

### P10.4 — Evidence bridge and intervention lineage

Generalize current runtime evidence:

- provider/session/module provenance;
- module-aware static links;
- intervention parentage;
- unresolved runtime-only evidence;
- contradiction/refinement edges;
- completeness propagation.

**Exit:** static/dynamic fusion is at least as conservative as today, with richer identity.

### P10.5 — First-class TraceProvider

Current `ReplayAdapter` proves replay is already useful. The next step is a trace-native provider rather than treating every recording as a debugger.

Why TraceProvider first:

- deterministic and read-only;
- exercises new identity/event/evidence contracts;
- no live-process timing instability;
- easy negative fixtures for wrong binary/cross-version cases;
- makes replay semantics testable before more live backends depend on them.

Minimum imported trace model should preserve when available:

- source/provider/tool identity;
- binary/module identity;
- module load/unload;
- coverage;
- call/branch sequence;
- memory observations;
- thread/process identity;
- timestamp/order metadata;
- gaps/truncation/completeness.

**Exit:** import -> normalize -> replay -> evidence is deterministic on fixtures.

### P10.6 — Provider remote protocol

Build provider/facet negotiation on top of the hardened v1 concepts.

Required:

- provider handshake;
- facet/capability negotiation;
- generic session lifecycle;
- async normalized event stream;
- cancellation/deadlines;
- protocol limits;
- v1 debugger compatibility path.

**Exit:** v1 tests stay green; a fake provider can negotiate and stream events through the new protocol.

### P10.7 — Mature DebuggerProvider

Promote current debugger behavior into the first-class Debugger facet.

Core operations:

- launch/attach/detach;
- pause/resume/step;
- breakpoints/watchpoints;
- threads/registers;
- memory read/write;
- modules;
- stack frames;
- target-state events;
- remote transport.

`LLDBCompatibleAdapter` is a strong compatibility seed, not the final abstraction boundary.

**Exit:** mock/local and at least one remote debugger path satisfy the same provider contract and identity/event rules.

### P10.8 — First-class InstrumentationProvider

Evolve beyond the current `FridaCompatibleAdapter` capability wrapper.

Required concepts:

- attach/instrument target;
- intercept/probe;
- optional replacement when backend allows it;
- call/block tracing;
- memory/process observations;
- module/runtime metadata observation;
- high-volume batching/backpressure;
- intervention lineage;
- permission/capability reporting.

“Frida-compatible” means Hex can express the needed instrumentation model. It does not require Frida to become the semantic core or mandatory dependency.

**Exit:** instrumentation uses the same provider/session/module/event/evidence contracts as debugger/trace.

### P10.9 — EmulatorProvider + final replay/fusion gates

Generalize local/emulator paths into a backend-neutral Emulator facet.

Evidence must record:

- provider/engine ID and version;
- binary identity;
- architecture/platform model;
- initial state/input;
- relevant environment/configuration;
- budget/termination reason;
- completeness;
- synthetic observation mode.

Then close the canonical exit gates across all provider types.

**Exit:** runtime identity, static/runtime fusion, replay, and cross-version ambiguity tests are green with positive and negative cases.

---

## 12. Why this order is efficient

Critical dependency chain:

```text
freeze current safety
        |
        v
module-aware identity
        |
        v
provider/facet contract
        |
        v
normalized RuntimeEvent
        |
        v
evidence bridge
        |
        +-------------------+
        |                   |
        v                   v
TraceProvider        provider protocol
        |                   |
        |              DebuggerProvider
        |           InstrumentationProvider
        |              EmulatorProvider
        +---------+---------+
                  |
                  v
        replay/fusion exit gates
```

The current repository already proved many individual runtime mechanisms. The most efficient Phase 10 path is therefore to **extract the common contract from working code**, not rebuild backend features from zero.

After P10.4 stabilizes, TraceProvider, provider protocol, debugger hardening, instrumentation, and emulator work can run in parallel with much less merge churn.

Do not parallelize identity/event schema design across several workers before the contracts settle.

---

## 13. Provider-specific difficult points

### 13.1 Debugger

Hard problems:

- asynchronous target state;
- pause/resume races;
- stale register/frame snapshots;
- module load/unload;
- multi-thread state;
- breakpoint/watchpoint lifecycle;
- remote disconnect/reconnect;
- writes are interventions.

Rule: target state changes should be backed by provider events/acknowledged operations, not UI assumptions.

### 13.2 Instrumentation

Hard problems:

- event volume;
- hooks can perturb execution;
- JIT code;
- module churn;
- injection/permission failure;
- dropped events;
- high-level runtime observations may not map to one static instruction.

Rule: backpressure and intervention lineage are correctness features.

### 13.3 Trace/replay

Hard problems:

- source tools have different identity quality;
- trace may be incomplete;
- order may be partial;
- addresses may lack module identity;
- trace may belong to another build.

Rule: successful import does not imply successful static attachment.

### 13.4 Emulator

Hard problems:

- synthetic state is not real target state;
- environment modeling affects behavior;
- unsupported syscalls/instructions;
- replay depends on controlled initial state;
- backend configuration affects reproducibility.

Rule: emulator observations stay explicitly synthetic/experimental evidence.

---

## 14. Replay and cross-version model

Current `replayExperiment()` already has a strong safety direction:

- source and target binary identity required by default;
- mismatch requires explicit function re-resolution;
- resolved candidate must be explicitly accepted;
- identity confidence threshold is enforced;
- ambiguity is rejected;
- low ambiguity margin is rejected.

Phase 10 should generalize this principle to all runtime/static mapping.

### 14.1 Replay record should include

```text
provider id/version
protocol/schema version
runtime session identity
binary identity
module identities/map changes
inputs/configuration where relevant
events and ordering information
gap/drop markers
intervention markers
completeness
```

### 14.2 Replay modes

**Exact replay**  
Same verified binary identity and compatible runtime schema. Static links can be reconstructed deterministically.

**Re-resolution**  
Identity is sufficient to reconstruct module/static mapping without assuming old addresses.

**Cross-version candidate replay**  
Different binary identity. Static attachments require explicit match artifacts with confidence and ambiguity information.

### 14.3 Never allow

```text
old runtime address == new runtime address
=> same static entity
```

---

## 15. Static/runtime contradiction semantics

Example:

```text
Static claim:
  branch B is unreachable under current assumptions

Verified same-binary runtime evidence:
  branch B executed
```

Correct result:

```text
RuntimeEvidence
  -> contradicts static Claim
  -> inspect static assumptions/analysis
```

Incorrect result:

```text
runtime event
  -> mutate static IR until contradiction disappears
```

Likewise, a branch not observed in one trace is not globally unreachable.

---

## 16. Browser/iPad performance rules

Current code already uses trace ring buffers, protocol limits, event backpressure, bounded evidence, and cancellation. Phase 10 should extend those principles end-to-end.

Required:

- no unbounded event arrays on main thread;
- batches/transferable compact data where useful;
- paged history/evidence queries;
- virtualized trace UI;
- small hot live state;
- persisted cold artifacts where appropriate;
- explicit event budgets;
- explicit reconnect/provider-loss state;
- correctness without SharedArrayBuffer;
- high-frequency instrumentation filters/sampling before UI projection;
- dropped events downgrade completeness.

Performance optimizations may defer/store/page work. They must not turn partial runtime data into unjustified confidence.

---

## 17. Security model

Runtime providers and traces are untrusted external inputs even when they run with privileged target access.

Threats:

- malformed wire values;
- oversized packets/events;
- invalid addresses;
- malicious module/symbol/path strings;
- event floods;
- stale/cross-binary sessions;
- protocol downgrade/confusion;
- provider impersonation;
- remote attempts to invoke shell/host commands;
- injected code/callback payloads;
- unauthorized runtime mutation;
- compromised backend output.

Preserve current protocol hardening:

- plain-data wire values;
- bounded nesting/arrays/objects/messages;
- blocked command execution;
- strict BigInt/byte validation;
- cancellation/timeouts;
- epochs;
- backpressure.

Add provider-level:

- provider/session identity validation;
- facet capability authorization;
- mutation capability distinction;
- module/binary identity validation;
- explicit remote authentication/authorization where the chosen transport supports it.

No provider text/data becomes system/AI instruction authority.

---

## 18. Candidate module boundaries

Do not mass-move immediately. Target shape only:

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

Compatibility policy:

- `js/debug/adapter.js` remains until debugger consumers migrate;
- `js/adapters/index.js` concrete adapters continue to work;
- remote protocol v1 remains supported through a debugger compatibility route;
- `RuntimeAnalysisPlatform` remains the public composition facade while internals migrate;
- `runtime-evidence` behavior is extended, not replaced by a weaker store.

File movement is not an exit criterion.

---

## 19. Test plan

### 19.1 Baseline compatibility tests

Pin current behavior before refactor:

- capability negotiation;
- strict address/integer validation;
- session limit and adapter-in-use gate;
- epoch/stale-event rejection;
- cancellation propagation;
- wire BigInt/bytes roundtrip;
- protocol packet limits;
- blocked host methods;
- pending-request backpressure;
- event backpressure/truncation signal;
- trace fact completeness/truncation;
- runtime evidence binary/slice filtering;
- cross-version replay confidence/ambiguity rejection.

### 19.2 Module identity tests

- same binary + ASLR resolves;
- wrong content hash rejects;
- same path/name + wrong hash rejects;
- correct build ID + correct slice resolves as policy allows;
- wrong FAT slice rejects;
- module unload invalidates mapping;
- reload gets new runtime module identity;
- anonymous/JIT code remains runtime-only if unresolved;
- same VA in different build never auto-links.

### 19.3 Provider contract tests

- provider ID/version required;
- facets negotiated;
- unsupported and unavailable distinct;
- session cannot cross provider ownership;
- cancellation propagates;
- provider close invalidates active operations;
- compatibility DebugAdapter path still works.

### 19.4 RuntimeEvent tests

- provider/session identity required;
- ordering preserved when known;
- partial ordering not fabricated;
- event batches equal logical individual stream;
- overflow generates gap/truncated signal;
- completeness propagates;
- stale epoch events ignored;
- malformed event cannot corrupt session.

### 19.5 TraceProvider tests

- deterministic fixture import;
- replay yields stable normalized evidence;
- wrong binary remains detached;
- missing module identity remains unresolved;
- gaps downgrade completeness;
- source thread/process/order metadata preserved.

### 19.6 DebuggerProvider tests

- launch/attach/detach;
- pause/resume/step;
- break/watchpoint lifecycle;
- module events;
- thread/register/frame freshness;
- memory read;
- register/memory write marked intervention;
- disconnect/target exit transitions.

### 19.7 InstrumentationProvider tests

- attach/instrument;
- probe/intercept observation;
- replacement marked intervention;
- high-volume batching;
- backpressure/gap event;
- dynamic module/JIT events;
- permission failure distinct from unsupported.

### 19.8 EmulatorProvider tests

- provider/engine version captured;
- config/input captured;
- deterministic fixture replay;
- budget termination => partial;
- unsupported semantics explicit;
- observation mode synthetic.

### 19.9 Fusion tests

- runtime cannot directly mutate static IR;
- exact identity links to correct static entity;
- mismatch stores runtime evidence but no static link;
- contradiction preserved;
- intervention lineage preserved;
- partial evidence cannot produce completeness-dependent confirmation.

### 19.10 Cross-version negative corpus

At minimum:

- same VA, different function;
- same filename, different content;
- function moved to new address;
- function split/merged by optimization;
- top two matches too close;
- trace references missing module;
- source/target slice mismatch.

Default outcome is unresolved/ambiguous until explicit matching evidence is sufficient.

---

## 20. Measurable exit gates

### Gate A — Runtime evidence identity binding

Pass only if:

- every durable runtime evidence item has provider/session provenance;
- static-linked runtime evidence has validated binary/module/address resolution;
- mismatched identity cannot produce a static link;
- unresolved evidence remains inspectable;
- unload/reload cannot reuse stale mapping;
- existing binary/slice filters are not weakened.

### Gate B — Static/runtime fusion

Pass only if:

- runtime observations cannot directly mutate static Semantic IR/SSA/types;
- support/contradiction/refinement is evidence-based;
- intervention lineage is visible;
- partial/truncated observations preserve completeness limits;
- correlated runtime observations are not double-counted as independent proof.

### Gate C — Replay/cross-version ambiguity

Pass only if:

- deterministic replay reproduces equivalent normalized evidence;
- wrong binary is blocked;
- same-address cross-build shortcut is impossible;
- cross-version static attachment requires explicit match evidence;
- ambiguous match remains ambiguous;
- provider/schema versions and gaps are retained.

### Gate D — Compatibility and operational safety

Pass only if:

- current DebugAdapter paths still work through migration adapters;
- v1 protocol safety/compatibility tests remain green;
- epoch/cancellation/backpressure behavior remains green;
- high-volume event tests remain bounded;
- provider failure cannot corrupt static project state.

---

## 21. Suggested PR breakdown

| PR | Scope | Avoid mixing in |
|---|---|---|
| P10.0 | baseline contract/negative tests | new backend features |
| P10.1 | target/module/address identity | debugger UI work |
| P10.2 | provider registry/facets + compatibility adapters | protocol rewrite |
| P10.3 | normalized RuntimeEvent | concrete Frida integration |
| P10.4 | evidence bridge/intervention lineage | unrelated static analysis |
| P10.5 | first-class TraceProvider + replay fixtures | debugger mutation features |
| P10.6 | provider remote protocol + v1 compatibility | UI redesign |
| P10.7 | mature DebuggerProvider | instrumentation-only operations |
| P10.8 | InstrumentationProvider | static IR changes |
| P10.9 | EmulatorProvider + final fusion/replay gates | broad repository cleanup |

This PR sequence is intentionally conservative. If current main advances further before Phase 10 begins, collapse already-completed slices rather than reimplementing them.

---

## 22. What to serialize vs parallelize

### Serialize until stable

Give one owner to:

- module identity schema;
- address resolution rules;
- provider/session identity;
- RuntimeEvent envelope;
- capability/facet vocabulary;
- fusion semantics;
- provider protocol negotiation.

These are high fan-out contracts. Competing parallel edits create expensive churn.

### Parallelize after P10.4

Good independent tracks:

- TraceProvider + fixtures;
- provider protocol implementation;
- debugger provider hardening;
- instrumentation provider;
- emulator provider;
- cross-version negative corpus;
- runtime query/UI projection.

Each track consumes the same frozen identity/event/evidence contracts.

---

## 23. Decisions worth freezing now

### Decision 1 — Provider owns session identity; capabilities are facets

**Recommendation:** yes.

Avoid four incompatible session models.

### Decision 2 — Existing DebugAdapter becomes compatibility surface, not universal final abstraction

**Recommendation:** yes.

It is strong and useful, but instrumentation/trace should not be forced to pretend to be debuggers forever.

### Decision 3 — Keep protocol v1 and negotiate a provider-level extension/new version

**Recommendation:** yes.

Reuse its hardening and preserve compatibility.

### Decision 4 — Module-aware address mapping, not one global slide

**Recommendation:** mandatory.

Needed for multi-module ASLR, unload/reload, shared caches, JIT, and cross-version safety.

### Decision 5 — TraceProvider is the first new first-class facet

**Recommendation:** yes.

Replay already exists; trace-native abstraction is the lowest-risk way to validate provider identity/event/evidence contracts.

### Decision 6 — Frida-compatible is an interface/backend strategy, not mandatory semantic dependency

**Recommendation:** yes.

The current adapter remains useful while first-class instrumentation semantics are introduced.

### Decision 7 — Emulator observations are explicitly synthetic

**Recommendation:** yes.

Do not conflate emulator execution with direct real-device observation.

### Decision 8 — Current cross-version replay gate is a minimum safety floor

**Recommendation:** mandatory.

Generalize it; do not simplify it away.

### Decision 9 — No big-bang runtime rewrite

**Recommendation:** yes.

Current runtime code already contains useful, tested behavior. Extract common contracts incrementally.

---

## 24. Preparation that can happen before Phase 10 coding

1. **Build a deterministic runtime/trace fixture corpus.**
   - same-binary ASLR;
   - wrong binary;
   - wrong slice;
   - module load/unload;
   - truncated stream;
   - intervention;
   - same-VA cross-version mismatch;
   - ambiguous re-resolution.

2. **Freeze identity vocabulary.**
   - binary/content identity;
   - runtime session ID;
   - runtime module ID;
   - build identity;
   - slice identity;
   - runtime/static address resolution state.

3. **Freeze normalized event envelope.**
   Backend payload can evolve; provider/session/order/completeness/intervention fields should not churn.

4. **Create a fake provider harness.**
   Provider/protocol/fusion tests should not require a real device, LLDB, or Frida.

5. **Inventory existing runtime tests before adding new files.**
   Reuse current adapter/protocol/session/replay fixtures instead of duplicating them under new names.

6. **Keep backend choice behind the contract.**
   Concrete LLDB/Frida/native-service work can proceed independently once provider boundaries stabilize.

---

## 25. Common traps

### Trap 1 — “LLDBCompatibleAdapter exists, so debugger provider is done”

No. It proves useful capability coverage, not final provider/session/module identity architecture.

### Trap 2 — “FridaCompatibleAdapter exists, so instrumentation provider is done”

No. Current compatibility is still debugger/trace-capability shaped. First-class instrumentation needs intercept/probe/intervention/event semantics.

### Trap 3 — “ReplayAdapter exists, so TraceProvider is unnecessary”

No. Imported immutable traces deserve a trace-native facet; they should not need to masquerade as a live debugger.

### Trap 4 — “binaryHash is enough for every runtime mapping”

Not by itself. Multi-module sessions, build identities, slices, JIT, unload/reload, and cross-version mapping need module-level identity.

### Trap 5 — “ASLR is just one slide”

Unsafe for multi-module/JIT/shared-cache/unload-reload scenarios.

### Trap 6 — “observed at runtime = globally confirmed”

A runtime run confirms only the observation under its binary/session/input/path/completeness assumptions.

### Trap 7 — “not observed = impossible”

Only if coverage/completeness evidence justifies that conclusion.

### Trap 8 — “dropped events are only a performance issue”

They change proof strength. The current protocol already signals truncation; preserve it through all layers.

### Trap 9 — “remote backend is trusted because it is privileged”

Privilege is not truth. Validate all provider data and identity.

### Trap 10 — “rename/restructure first, then implement”

Avoid. Use compatibility facades and move files only when a functional slice benefits.

---

## 26. Definition of done

Phase 10 is not done merely because a remote debugger can attach.

- [ ] Provider/session identity is versioned and explicit.
- [ ] Debugger, Instrumentation, Emulator, and Trace are first-class facets of one runtime model.
- [ ] Existing DebugAdapter/LLDB/Frida/Replay compatibility paths still work during migration.
- [ ] Runtime module identity and module-aware address resolution exist.
- [ ] ASLR/multi-module/unload-reload/JIT unresolved cases are represented safely.
- [ ] Runtime events are normalized, bounded, cancellable, and gap-aware.
- [ ] Current protocol epoch/cancel/backpressure protections are preserved.
- [ ] Runtime evidence may remain runtime-only when static mapping is unresolved.
- [ ] Static links require validated identity.
- [ ] Intervention lineage is preserved.
- [ ] TraceProvider has deterministic import/replay fixtures.
- [ ] Mature DebuggerProvider uses the common provider/session/event model.
- [ ] First-class InstrumentationProvider uses the same model.
- [ ] EmulatorProvider is backend-neutral and marks synthetic evidence explicitly.
- [ ] Runtime observations support/contradict/refine static claims without directly rewriting static truth.
- [ ] Existing cross-version confidence/ambiguity safety is preserved/generalized.
- [ ] Same-VA cross-build automatic linking is impossible.
- [ ] Negative identity/replay corpus is green.
- [ ] High-volume event ingestion remains inside explicit budgets.
- [ ] Provider failure/disconnect cannot corrupt static project state.

---

## 27. Recommended first coding move when Phase 10 starts

Do **not** begin by adding another LLDB or Frida method.

The current repository already has substantial LLDB/Frida/replay/runtime functionality. Start with the missing high-leverage foundation:

1. `RuntimeTargetIdentity`;
2. `RuntimeModuleIdentity`;
3. module load/unload mapping;
4. module-aware runtime/static address resolution;
5. explicit exact/resolved/ambiguous/unresolved/mismatch states;
6. differential tests proving existing binaryHash/slice/replay gates remain at least as strict.

Then layer `RuntimeProvider` and normalized `RuntimeEvent` over the existing adapters.

That gives every later backend one identity and evidence model instead of allowing debugger, instrumentation, replay, and emulator paths to diverge.

---

## 28. Phase 10 review mental model

```text
Existing adapter / live backend / imported trace
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
        normalized RuntimeEvent
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
RuntimeProvider -> silently rewrite static semantic truth
```

If Phase 10 reviews keep that boundary and preserve the strong runtime safety already present on `main`, implementation can move quickly without accumulating a second runtime-specific semantic architecture.