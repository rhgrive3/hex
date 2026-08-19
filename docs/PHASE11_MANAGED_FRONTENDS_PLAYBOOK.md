# Phase 11 Managed Frontends — Implementation Playbook

Status: **planning / preflight guidance**  
Phase: **11 — Managed frontends**  
Scope: **WASM → DEX → CLR/CIL → JVM**  
Planning baseline: **`main` at `e90c5107f9c77d73687ee452d5042dcbe9e79ece` (2026-08-18)**  
Canonical architecture: [`HEX_MASTER_ARCHITECTURE.md`](./HEX_MASTER_ARCHITECTURE.md)  
Engineering process: [`ENGINEERING_PROCESS_GUARDRAILS.md`](./ENGINEERING_PROCESS_GUARDRAILS.md)  
Support truth: [`SUPPORT_MATRIX.md`](./SUPPORT_MATRIX.md) and `js/platform/capability-maturity.js`  
Research index: [`SOURCES.md`](./SOURCES.md)  
Review record: [`PHASE11_MANAGED_FRONTENDS_REVIEW.md`](./PHASE11_MANAGED_FRONTENDS_REVIEW.md)

> This playbook is intentionally more concrete than the Master Architecture, but it is not allowed to override it. If this document conflicts with the live Master Architecture, a later accepted ADR, or `ENGINEERING_PROCESS_GUARDRAILS.md`, the higher-authority contract wins. Any intentional architecture change must update the canonical contract in the same reviewed change.

---

# 0. Executive decision

Phase 11 must **not** be executed as four unrelated parser/decompiler projects.

The efficient path is:

```text
live Phase 10 product
      ↓
P11-F: freeze managed contracts + verifier + ownership
      ↓
P11-W: WASM proves the complete shared vertical path
      ↓
shared contract stability checkpoint
      ↓
P11-D / P11-C / P11-J can fan out safely
      ↓
shared M4/M5 hardening
      ↓
exact-head release proof
```

The core engineering objective is to introduce one production managed-code semantic path:

```text
target bytes + authoritative metadata
        ↓
container/member identity
        ↓
ManagedFrontend
        ↓
decoded VM operations
        ↓
exact VM-native state transition
        ↓
VMEffects
        ↓
shared Semantic IR
        ↓
shared CFG / SSA / dataflow / types / summaries
        ↓
shared HighIR / decompiler
        ↓
EvidenceGraph / AnalysisQueryAPI / UI / AI
```

The frontend may preserve richer target semantics than shared Semantic IR can currently express. In that case Hex must preserve the richer fact and report the shared lowering as `partial`, `intrinsic`, `unsupported`, or `unknown`. It must never erase the difference merely to make a downstream pass succeed.

---

# 1. Why Phase 11 is difficult

The visible task is “support WASM, DEX, CLR/CIL, and JVM.” The actual task is the first major test of whether Hex truly has **one semantic architecture** rather than a native-only architecture with adapters attached around it.

The four initial targets deliberately stress different execution models:

| Frontend | Execution model | State that must survive |
|---|---|---|
| WASM | typed stack machine with structured control | operand stack, locals, globals, memories, tables, references, traps/exceptions according to feature profile |
| DEX | register machine | method registers, wide logical values, typed references, fields, arrays, exception handlers, invoke kind |
| CLR/CIL | typed evaluation stack + locals/args | stack types, locals/args, metadata tokens, managed pointers, generics context, exception clauses, prefixes |
| JVM | operand stack + local slots | verification types, stack-map state, constant-pool refs, uninitialized-object state, exception table, invocation kind |

A design that works only by pretending these are all CPU register files has failed the phase.

The Master Architecture already makes the governing decision: native instructions use `MachineEffects`; managed/VM operations use `VMEffects`; both feed the shared semantic plane. The current support registry already defines M0–M6 but has no registered managed frontend. Phase 11 therefore creates a new first-class frontend family rather than polishing an existing one.

---

# 2. Authority and non-negotiable invariants

Every Phase 11 lane inherits the repository invariants. The following are the most important for managed code.

## P11-INV-001 — VMEffects is a sibling of MachineEffects, not fake MachineEffects

Do not add `architectureId = "jvm"` and fabricate registers to reuse a native contract.

The two low-level domains may share conventions such as:

- schema/contract versioning;
- completeness states;
- explicit unknown effects;
- origin/provenance;
- cancellation;
- resource budgets;
- strict serialization;
- immutable validated results.

They do not need identical operation vocabulary or state models.

## P11-INV-002 — One downstream truth

A frontend must not create a private CFG, private SSA, private decompiler, private type database, or private AI answer path as the canonical result.

Target-specific pre-analysis is allowed when required to decode/validate VM state. Once VMEffects exists, shared analysis owns the canonical downstream projection.

## P11-INV-003 — Invalid is inspectable, not silently valid

Reverse engineers need to inspect malformed, obfuscated, hand-crafted, and runtime-rejected code.

Hex may expose safely decoded metadata/operations from invalid input, but must keep validity explicit. It must not “repair” invalid stack/register state and then claim exact executable semantics.

## P11-INV-004 — Metadata authority is typed

“Metadata” is not one trust class.

Execution-defining metadata, declared type metadata, debug metadata, names, custom annotations, and producer hints have different authority. The frontend must classify them rather than feeding all metadata into the same confidence bucket.

## P11-INV-005 — Managed/native duality is preserved

A physical file/container may contain both managed and native code. One view must not erase the other.

Examples:

- PE/CLI with native stubs or mixed-mode content;
- APK/AAB with DEX plus native `.so` libraries;
- JVM/DEX native methods linked through JNI;
- WASM imports backed by host/native functions.

Cross-domain links are evidence edges, not identity shortcuts.

## P11-INV-006 — Exactness is version/profile bound

No release artifact may mean “latest WASM,” “current JVM,” or “whatever DEX version the parser accepted.”

A VM semantic artifact is bound to a concrete target profile/spec/version/feature set.

## P11-INV-007 — Phase 11 remains browser/iPad-first

Opening or analyzing a managed package must remain demand-driven, cancellable, bounded, and usable on the real primary device.

Desktop-only success cannot close the phase.

---

# 3. Current baseline and prerequisites

At the planning baseline:

- `MANAGED_LEVELS` M0–M6 exist in `js/platform/capability-maturity.js`;
- `managedMaturity()` is intentionally unsupported for all managed targets;
- `currentSupportMatrix().managed` is empty;
- native low-level effects now have a strict `MachineEffects` contract in `js/semantics/effects/index.js` with schema/contract versions, explicit completeness, unknown effects, budgets, cancellation, strict serialization, and origin requirements;
- generic semantic namespaces exist under `js/semantics/{effects,ir,cfg,ssa,memoryssa,...}`;
- Phase 11 has no production `js/managed/**` implementation yet.

This matters because VMEffects should copy the **discipline** of the current MachineEffects contract without forcing managed semantics into its native value/register model.

## 3.1 Mandatory live preflight dependency audit

Before Phase 11 implementation starts, inspect the actual Phase 10 product and record PASS / BLOCKING for these dependencies.

| Dependency | Required Phase 11 property |
|---|---|
| Phase 3 Semantic IR v2 | accepts non-native source entities and does not require instruction addresses everywhere |
| Phase 3 generic CFG/SSA | can consume method-level semantic blocks without architecture register naming |
| Phase 4 ArtifactStore | artifact keys can include managed module/method/profile identity |
| Phase 4 scheduler | method-level demand scheduling, cancellation, coalescing, and persistence work for managed entities |
| Phase 7 TypeConstraintGraph | distinguishes hard constraints from weighted evidence and can represent managed nominal/generic/reference types |
| Phase 7 interprocedural summaries | callable identity is not native-address-only |
| Phase 8 decompiler | consumes shared semantic artifacts and preserves exception/provenance data |
| Phase 9 symbolic layer | optional; must not be required to claim basic M2/M3 support |
| Phase 10 RuntimeProvider | can represent managed runtime locations/events without assuming native register/PC-only identity |
| AnalysisQueryAPI | can query a managed callable by stable entity ID rather than only native `FunctionId/address` |
| UI/navigation | can navigate a bytecode location without inventing a virtual native address |

A missing prerequisite becomes an explicit foundation task. Do not work around it by creating a frontend-private subsystem.

---

# 4. Phase success contract

The Master Architecture requires the four frontends in this order and requires VMEffects before shared decompiler claims.

This playbook recommends the following **default Phase 11 exit contract**. It must be ratified or deliberately changed at Phase 11 preflight against the live product.

## 4.1 Proposed minimum product exit

All four frontends:

- exist as registered first-class managed frontends;
- satisfy M0 and M1 on their declared supported profiles;
- have measured M2 VMEffects coverage with no silent semantic fallback;
- can enter the shared M3 path for the mandatory corpus;
- expose complete provenance from shared semantic nodes back to VM operation and source bytes;
- satisfy target-specific malformed-input and resource-budget gates;
- report unsupported profile/features explicitly.

Shared Phase 11 work:

- M4 type/interprocedural support is integrated wherever authoritative metadata permits it;
- at least the frontends for which M5 is claimed pass the common semantic decompiler gate;
- M6 is promoted only where Phase 10 runtime providers and real evidence justify it;
- no frontend is forced to M5/M6 merely to make the phase look symmetrical.

If the team chooses a stronger release contract, encode it in the Phase 11 foundation manifest and verifier. Do not leave it as prose.

## 4.2 What “Phase 11 done” does not mean

It does not mean:

- every optional WASM proposal is supported;
- every Android runtime artifact such as OAT/VDEX is supported;
- ReadyToRun/native AOT .NET images are fully decompiled;
- every JVM classfile ever emitted is supported without version limits;
- managed debugging works for every runtime;
- language-perfect Java/C# source is reconstructed;
- external libraries/classes/assemblies are resolved from the internet;
- invalid bytecode is guessed into a valid program.

---

# 5. Target profile: version and feature identity

A frontend ID alone is insufficient semantic identity.

Define a target-profile object before real artifacts are cached.

```ts
ManagedTargetProfile {
  frontendId
  frontendSemanticVersion
  formatVersion
  vmSpecEdition
  featureSet
  runtimeVersionHint?
  validationPolicy
  decodingOptionsHash
}
```

Examples:

```text
WASM:
  core spec edition + enabled proposal/features/profile

DEX:
  dex version + container form + Android/runtime compatibility profile if relevant

CIL:
  CLI/CIL contract edition + module metadata/runtime header facts + supported prefixes/features

JVM:
  class-file major/minor version + preview-feature policy + verifier policy
```

Rules:

1. Release verification uses a pinned profile.
2. UI may offer an “auto” mode, but `auto` resolves to a concrete profile before artifacts are created.
3. The resolved profile is in the ArtifactKey.
4. Changing profile semantics invalidates dependent artifacts.
5. Unsupported features are not accepted by accident because the decoder recognized their byte pattern.

### Planning note, not permanent support policy

At the time of this planning revision:

- the published WebAssembly Core Specification is 3.0 (2026-07-28);
- Android documentation describes DEX versions through the current Android era and documents v41 container semantics, with its deployment status requiring re-verification when Phase 11 starts;
- ECMA-335 6th edition remains the canonical CLI standard publication;
- Java SE 26 is the current published JVMS edition.

Phase 11 must re-check the live official specifications and pin its declared support set. This document must not turn those planning-time versions into eternal defaults.

---

# 6. Identity model

Stable managed identity is required before parser fanout because cache keys, xrefs, evidence, UI navigation, diffing, and runtime fusion all depend on it.

## 6.1 Required identities

At minimum:

```text
ManagedImageId
ManagedModuleId
ManagedTypeId
ManagedMethodId
ManagedFieldId
MetadataEntityId
VMOperationId
VMValueId
VMFrameStateId
ManagedCallSiteId
ManagedExceptionRegionId
ManagedTargetProfileId
```

## 6.2 Identity rules

Identity uses authoritative structural identity, not display text.

Conceptual examples:

```text
WASM function:
  BinaryId + ContainerMemberId + module identity + function index

DEX method:
  BinaryId + logical DEX identity + method_idx

CIL method definition:
  BinaryId + CLI module identity + MethodDef token

JVM declared method:
  BinaryId + exact class member identity + name_index/descriptor identity
```

The final implementation should reuse existing Hex core identity primitives where possible.

## 6.3 Never use these as sole authority

Do not use only:

- file name;
- ZIP entry path;
- class/type display name;
- method display name;
- source line;
- native export name;
- JNI/PInvoke textual name;
- bytecode offset without method/module identity.

ZIP-family containers may contain duplicate entry names. Obfuscators may create confusing names. Cross-version builds reuse names. Identity must survive these cases without collision.

## 6.4 Callable and code-location union

Shared consumers need a domain-neutral callable/location abstraction rather than coercing managed methods into `FunctionId` or virtual addresses.

Recommended concept:

```ts
CallableRef =
  | { kind: 'native-function', functionId }
  | { kind: 'managed-method', methodId }

CodeLocation =
  | { kind: 'native', imageId, instructionId, address }
  | { kind: 'managed', moduleId, methodId, vmOperationId, bytecodeOffset }
```

Do not rename existing stable native identities merely for symmetry. Add a union/facade at the shared query boundary.

---

# 7. Container and module model

Managed code often arrives through nested containers. The frontend should not own ad-hoc ZIP/package traversal.

```text
ByteSource
  ↓
ContainerGraph
  ↓
ContainerMemberId
  ↓
ManagedFrontend.probe/open
  ↓
ManagedImage / ManagedModule
```

## 7.1 Required cases

### WASM

Support standalone core modules first. Embedded/component/container forms are separate profile/container work unless explicitly included at preflight.

### DEX

Handle:

- standalone DEX;
- multiple DEX members in APK/AAB-like containers;
- logical DEX identity separately from package identity;
- current DEX container semantics when included in the declared profile.

A critical modern trap is DEX v41 container behavior: logical files may share later physical data and offsets are defined relative to the physical container. Do not assume every logical DEX is a self-contained contiguous subfile with header-relative offsets.

### CLR/CIL

CIL normally lives inside PE/CLI. This is a **dual-domain association**, not a new unrelated file format.

The same physical binary may yield:

```text
BinaryId
  ├─ Native BinaryImage / PE view
  └─ ManagedImage / CLI module view
```

The two views share source identity and provenance but retain separate semantic domains.

### JVM

Support class files and container members. JAR-like containers may have:

- duplicate member names;
- multi-release variants;
- module metadata;
- multiple candidate classes for different target runtime versions.

Do not flatten all variants into one active class identity without a resolution profile.

---

# 8. ManagedFrontend contract

The foundation should freeze a small contract before frontend fanout.

Conceptual shape:

```ts
interface ManagedFrontend {
  id
  contractVersion
  semanticVersion

  probe(source, context): Promise<ManagedDetection>
  open(source, context): Promise<ManagedImage>

  enumerateModules(image, options): AsyncIterable<ManagedModule>
  enumerateTypes(module, options): AsyncIterable<ManagedType>
  enumerateMethods(module, options): AsyncIterable<ManagedMethod>

  decodeMethod(method, context): Promise<DecodedVMFunction>
  validateMethod(decoded, context): Promise<ManagedValidationReport>
  liftMethod(decoded, validation, context): Promise<VMEffectFunction>
}
```

Exact names are not normative. Required behavior is.

## 8.1 Required contract properties

Every operation must be:

- cancellable;
- budgeted;
- deterministic for the same exact input/profile/options;
- strict about unsupported format/profile/features;
- lazy/demand-driven;
- source/provenance preserving;
- serializable/versioned as an artifact when durable;
- independent from UI objects;
- independent from native addresses;
- safe on hostile input.

## 8.2 Detection result

```ts
ManagedDetection {
  frontendId
  confidence
  formatVersionCandidate?
  requiredBytes
  evidence
  limitations
}
```

Detection does not equal support. M0 is only promoted when the declared M0 contract and tests are satisfied.

---

# 9. Decoded VM operation layer

Do not lift directly from raw bytes into pretty semantic nodes. Preserve an inspectable decode layer analogous to native decoded instructions.

```ts
DecodedVMOperation {
  id: VMOperationId
  frontendId
  opcode
  operands
  bytecodeOffset
  encodedLength
  rawEncodingRef
  featureRequirements
  metadataRefs
  origin
}
```

A function/method decode artifact includes:

```ts
DecodedVMFunction {
  methodId
  profileId
  operations
  declaredEntryState
  exceptionRegions
  metadataRefs
  decodeCompleteness
  origin
}
```

Rules:

- bytecode offsets use target-native units internally where required, but public origin must map to exact source byte ranges;
- payload/data records that occupy the code stream must remain distinguishable from executable operations;
- one malformed operation must not cause unbounded resynchronization scans;
- unsupported operations remain decoded if safely possible, then lift as explicit unsupported/unknown effects.

---

# 10. VM state model

The common abstraction is **logical values plus VM-native locations**, not fake CPU registers.

## 10.1 Value and location are separate concepts

Recommended model:

```ts
VMValue {
  id: VMValueId
  vmType
  origin
  constant?
}

VMLocation =
  | OperandStackLocation
  | LocalLocation
  | RegisterLocation
  | ArgumentLocation
  | GlobalLocation
  | StaticFieldLocation
  | TableLocation
  | RuntimeLocation
```

A location holds a value at a program point. Location identity is not automatically source-variable identity.

This directly prevents two major errors:

- DEX register reuse becoming one fake source variable;
- JVM/CIL local-slot reuse becoming one fake source variable.

## 10.2 Wide/category values

A logical value that occupies multiple VM slots/registers remains **one VMValue** with target-specific layout metadata.

Examples:

- DEX 64-bit values spanning adjacent registers;
- JVM category-2 values and their operand/local-slot rules.

Never split the value into unrelated scalars merely because the storage encoding uses two slots.

## 10.3 Frame state

```ts
VMFrameState {
  id
  methodId
  operationId
  localsOrRegisters
  operandStack?
  specialState
  validationTypeState
  origin
}
```

`specialState` may hold target-defined verifier state such as JVM uninitialized-object identity when required.

---

# 11. VMEffects contract

VMEffects should mirror the safety discipline of `MachineEffects`, not its native-specific vocabulary.

## 11.1 Schema discipline

Define explicit versions from the first implementation:

```text
VM_EFFECTS_SCHEMA_VERSION
VM_EFFECTS_CONTRACT_VERSION
```

Use the same completeness vocabulary unless a reviewed reason requires otherwise:

```text
exact
exact-with-intrinsic
partial
unknown
```

Partial/unknown results must list unknown effect categories and reasons. A no-op/fallthrough bundle cannot imply preservation unless preservation is proven.

## 11.2 Per-operation bundle

Recommended shape:

```ts
VMEffectBundle {
  schemaVersion
  contractVersion
  frontendId
  frontendSemanticVersion
  profileId
  methodId
  operationId

  consumedValues
  producedValues
  locationReads
  locationWrites
  memoryEffects
  callEffects
  controlEffects
  possibleFaults
  possibleExceptions

  origin
  completeness
  unknownEffects?
  statePreservationProof?
  metadata?
}
```

One bundle is bound to one decoded VM operation. A method/function artifact then aggregates ordered bundles plus entry/validation/exception information.

## 11.3 VMEffectFunction

```ts
VMEffectFunction {
  methodId
  profileId
  entryState
  bundles
  exceptionRegions
  validationReportId
  aggregateCompleteness
  resolutionCompleteness
  origin
}
```

Keep **semantic completeness** separate from **resolution completeness**. A `call` opcode can be modeled exactly even when the external target set is unresolved.

## 11.4 Operation families

The common vocabulary should be small and semantic:

```text
value / const / copy
local-or-register read/write
argument read
numeric conversion
arithmetic / bitwise / compare / select
object allocation
array allocation
field read/write
static field read/write
array read/write
linear-memory read/write
global read/write
table read/write
reference/type test or checked cast
call / dispatch / indirect call
return
branch / conditional branch / switch
throw / rethrow
monitor/synchronization
trap
intrinsic
unknown
```

Target mnemonics do not belong in generic consumers. If a target operation cannot yet be normalized safely, keep a target-specific intrinsic with an explicit effect summary.

---

# 12. Validation model

Validation is a first-class artifact, not a parser side effect.

```ts
ManagedValidationReport {
  methodOrModuleId
  profileId
  status: valid | invalid | partial | unsupported
  completeness
  errors
  warnings
  entryStates
  blockEntryStates
  featureUse
  verifierFacts
  origin
}
```

## 12.1 Separate four axes

Do not collapse all failures into one `partial` flag.

Track at least:

1. **structural decode completeness** — can the bytes/metadata be decoded safely?
2. **spec validation completeness** — do the decoded structures satisfy the declared VM validation rules?
3. **semantic effect completeness** — are operation effects modeled exactly?
4. **resolution completeness** — are referenced types/methods/imports/runtime targets resolved?

This avoids a common error: an exact local opcode model being downgraded only because a library target is unavailable, or an unresolved external call being mistaken for unknown local instruction semantics.

## 12.2 Invalid-but-inspectable policy

If safe parsing is possible:

```text
invalid metadata/bytecode
  → preserve decoded evidence
  → expose validation errors
  → allow bounded inspection
  → block exact executable-semantic claims where invalidity matters
```

Do not crash, hang, or rewrite the code into a “valid” program.

---

# 13. Metadata authority model

Phase 11 must not repeat the native-analysis mistake of treating all metadata as weak hints, but it must also avoid the opposite mistake of treating all metadata as execution truth.

## 13.1 Authority classes

### Class A — execution/validation authoritative

Examples:

- WASM function/type/import/export indexes and validated type declarations;
- DEX type/proto/method/field identifiers and code/register structure;
- CIL metadata tokens/signatures required by the CLI model;
- JVM method/field descriptors and verification-relevant classfile structures.

These normally become hard constraints when the containing input is valid for the claimed profile.

### Class B — declared nominal/source model

Examples:

- generic signatures;
- annotations that describe declared API shape;
- language-level nominal names where the VM guarantees their role.

These are strong evidence but can differ from dynamic runtime targets or can be malformed/obfuscated.

### Class C — debug/projection metadata

Examples:

- local variable names;
- line tables;
- source-file names;
- DEX debug info;
- JVM LocalVariableTable;
- PDB-derived source names;
- WASM name/custom debug sections.

These never redefine VM semantics.

### Class D — producer/custom hints

Unknown/custom attributes, custom sections, vendor extensions, and heuristic naming remain evidence with explicit provenance.

## 13.2 Type pipeline rule

```text
execution-authoritative metadata
        ↓ hard TypeConstraintGraph facts
VMEffects semantics
        ↓ hard local constraints
declared nominal metadata
        ↓ strong typed evidence
debug/name/custom metadata
        ↓ projection/soft evidence
use-shape / heuristic naming
        ↓ soft evidence
```

False certainty is a release metric.

---

# 14. Control flow and exception model

Exceptions must exist in the first walking skeleton. Deferring them until decompiler work would force later CFG/SSA redesign.

## 14.1 Generic exception region

Recommended concept:

```ts
ManagedExceptionRegion {
  id
  protectedRanges
  handlerEntry
  handlerKind
  catchType?
  filterEntry?
  priorityOrOrder?
  continuationSemantics?
  origin
}
```

Target-specific information stays attached even when shared CFG represents a common exceptional edge.

## 14.2 Distinguish these events

Do not collapse:

- ordinary branch;
- return;
- catchable language/VM exception;
- runtime linkage/resolution exception;
- VM trap;
- host/runtime termination;
- explicit `throw`/`rethrow`;
- invalid-input verifier failure.

## 14.3 Handler entry state

Handler edges must define exact or explicitly partial entry VM state.

A stack/register merge that violates target validation rules is not repaired by inserting a generic phi node.

---

# 15. Managed memory model

One flat “memory” token is too weak.

## 15.1 Logical spaces/regions

The shared lowering should preserve at least the distinction among:

```text
WASM:
  linear memory instance
  global
  table
  GC/reference object if supported profile includes it

DEX/JVM/CIL:
  instance field
  static field
  array elements
  managed object/reference root
  runtime-managed state
```

These are semantic regions. They are not claims about physical host addresses.

## 15.2 Fault/exception side effects

Field, array, type, and memory operations can have observable exceptional/trap behavior.

Do not model only the successful value result if the target semantics include conditions such as:

- null reference;
- array bounds;
- type check failure;
- memory/table bounds;
- invalid conversion;
- arithmetic trap/exception where applicable.

## 15.3 MemorySSA bridge

Shared MemorySSA may consume managed regions when its region model can represent them safely.

If current MemorySSA lacks a necessary managed distinction, extend the shared region vocabulary through the foundation/integration lane. Do not collapse distinct VM regions to `unknown` solely for convenience if a precise, bounded shared region can be defined.

---

# 16. Calls, dispatch, linking, and native boundaries

A managed call is more than a target string.

Recommended common call descriptor:

```ts
ManagedCallSite {
  id
  methodId
  operationId
  dispatchKind
  declaredTargetRef?
  candidateTargets
  receiverConstraint?
  genericContext?
  argumentValues
  returnValues
  memoryEffects
  mayThrow
  runtimeResolutionRequired
  externalBoundary?
  resolutionCompleteness
  evidenceIds
}
```

## 16.1 Dispatch kinds

The shared API should retain enough detail for:

- direct/static calls;
- virtual calls;
- interface calls;
- special/super/direct dispatch;
- indirect/function-table calls;
- dynamic/bootstrap-based calls;
- function-pointer/calli-like calls;
- constructor/new-object semantics;
- host/import calls.

## 16.2 External/native linking

Safe first rule:

```text
managed callsite
  → exact managed/external descriptor
  → optional candidate native/runtime targets with evidence
  → exact native FunctionId only when identity proof exists
  → otherwise unresolved candidate set
```

A name match alone is never enough to create a verified cross-domain identity.

## 16.3 Class/module initialization and dynamic linking

Some VM operations can trigger class/module initialization or runtime resolution effects beyond the apparent local opcode.

If Phase 11 does not model these fully, preserve an effect-summarized runtime/linkage intrinsic or explicit unknown effect. Do not silently treat resolution as a pure lookup.

---

# 17. Lowering into shared Semantic IR

Write and test a lowering table before multiple frontend lanes diverge.

| VM concept | Shared lowering direction | Information that must survive |
|---|---|---|
| logical VM value | `SemanticValue` | exact VM type + origin |
| local/register/arg location | pre-SSA local state/value relation | location kind/index, not source-variable identity |
| operand stack value | stable logical value | producer/consumer and verifier type |
| field read/write | managed-region load/store-like op | field identity, receiver root, declared type |
| static field | static managed region | declaring type/field identity |
| array element | indexed managed access | element type, bounds/exception behavior |
| WASM linear memory | memory-region access | memory instance, offset/address semantics, width/endian/atomic details |
| table | table region / indirect target source | table identity and element/reference type |
| direct call | shared `CallSite` | exact target where authoritative |
| virtual/interface/dynamic | call with candidate set | dispatch kind, receiver/runtime constraints |
| throw | explicit exceptional control | payload/type and handler relation |
| trap | explicit trap | condition/reason |
| VM-only op | intrinsic | full effect summary + completeness |

## 17.1 Lowering safety rule

A transformation may simplify representation only when it preserves all behavior required by the declared profile.

If a shared operation cannot express an exact VM distinction, do one of:

1. extend the shared operation safely;
2. preserve a target-specific intrinsic with effect summary;
3. return explicit partial/unknown.

Never choose a superficially similar shared opcode that erases target behavior.

---

# 18. CFG and SSA strategy

Do not implement four SSA engines.

The intended split is:

```text
frontend
  decode
  validate target state transitions
  preserve branch/handler structure
  emit VMEffects
        ↓
shared managed lowering
        ↓
Semantic IR / CFG inputs
        ↓
shared CFG
        ↓
shared SSA / dataflow / summaries
```

## 18.1 Stack merge rule

For stack VMs, every CFG join must validate compatible stack height/type/state under the target rules before shared phi construction.

A mismatched stack is:

- invalid input;
- unsupported validation state; or
- partial analysis.

It is not a reason to invent missing phi operands.

## 18.2 Exceptional edges

SSA/dataflow must see handler edges and handler entry state. “Normal-flow-only SSA” is not sufficient for M3 when exceptions are part of the supported profile/corpus.

## 18.3 Shared pass audit

Every shared pass used by managed code must be checked for hidden assumptions such as:

- every code node has a virtual address;
- every entry value is a CPU register;
- every memory address is a native pointer;
- every call follows an ABI plugin;
- every exception is a native unwind edge;
- every function is contiguous native code.

Each assumption gets either a domain-neutral contract or an explicit unsupported path.

---

# 19. ArtifactStore and invalidation

Managed artifacts must be cache-safe from day one.

## 19.1 Artifact key inputs

At minimum bind:

```text
BinaryId
ContainerMemberId / logical module identity
ManagedFrontendId
frontend semantic version
ManagedTargetProfileId
metadata schema/version
DecodedVM schema/version
VMEffects schema/version
Semantic IR schema/version
entity/method identity
pass versions
options hash
```

## 19.2 Artifact families

```text
managed-detection
managed-module-index
managed-type-index
managed-method-index
decoded-vm-function
managed-validation-report
vm-effects-function
managed-semantic-ir
managed-cfg
managed-ssa
managed-type-constraints
managed-summary
managed-highir
managed-decompiler
managed-search-index
```

Do not serialize giant mutable graphs into `.hexproj`.

## 19.3 Determinism rules

For identical keys:

- cold and warm analysis produce semantically identical artifacts;
- scheduler order does not change stable IDs/results;
- cancellation never commits a partial artifact under a complete artifact key;
- failed producers do not publish cache entries as valid;
- semantic/profile version changes invalidate dependent artifacts automatically.

---

# 20. AnalysisQueryAPI and UI integration

Managed support is incomplete if only a new parser tab can see it.

Audit and extend the shared query layer so first-party UI, AI, and headless tools can use managed entities through stable IDs.

Required concepts include:

```text
list managed modules/types/methods
open callable context
VM operation listing
Semantic IR
CFG
callers/callees
xrefs
field reads/writes
type evidence
decompile
search
causal path
evidence
runtime observations where available
```

## 20.1 Native-address detox checklist

No managed UI feature should require inventing a native address.

Audit:

- router/navigation keys;
- code selection model;
- history/back-forward state;
- xref keys;
- call graph node keys;
- evidence anchors;
- decompiler source maps;
- search result navigation;
- AI tool target schemas;
- bookmarks/comments/renames where managed entities are mutable project facts.

## 20.2 Beginner and expert projections

Both consume the same artifacts.

Beginner:

```text
what does this method do?
what fields does it read/write?
who can call it?
what external/runtime behavior is unresolved?
how sure are we?
show evidence
```

Expert:

```text
raw bytecode
decoded VM operations
validation/frame state
VMEffects
Semantic IR
CFG/SSA
type constraints
exception regions
call resolution
HighIR/decompiler
runtime evidence
```

---

# 21. Maturity gates: machine-checkable interpretation

The current repository defines:

```text
M0 Detect/container
M1 Metadata
M2 Exact VMEffects
M3 CFG/SSA
M4 Types/interprocedural
M5 Decompiler
M6 Runtime/debug
```

The Phase 11 verifier should turn each level into explicit acceptance fields.

## M0 — Detect/container

Required:

- bounded probe;
- declared format/profile recognition;
- source/container identity;
- malformed lookalikes do not become supported inputs;
- cancellation and probe budget tested.

## M1 — Metadata

Required:

- authoritative module/type/method/field identities for the supported target;
- exact source ranges;
- required references/indexes validated or explicit invalid state;
- lazy enumeration works;
- malformed metadata corpus passes fail-closed gates.

## M2 — Exact VMEffects

Required:

- declared opcode/profile coverage measured;
- every decoded operation maps to exact, exact-with-intrinsic, partial, or unknown;
- no silent no-op/preserve fallback;
- stack/register state transition is exact for covered operations;
- control/trap/exception effects are represented for covered operations;
- unknown effect categories are explicit;
- origin coverage is complete for emitted bundles;
- verifier records unsupported operations/features.

## M3 — CFG/SSA

Required:

- VMEffects lower through the shared semantic path;
- shared CFG is used;
- shared SSA is used;
- target validation state is respected at joins;
- supported exception edges are present;
- no frontend-private canonical SSA/CFG truth;
- provenance survives lowering.

## M4 — Types/interprocedural

Required:

- execution-authoritative metadata enters hard constraints;
- declared/soft metadata authority is preserved;
- call/dispatch resolution exposes uncertainty;
- function/method summaries run through shared infrastructure;
- unresolved external/runtime behavior remains conservative;
- type false-certainty metric does not regress.

## M5 — Decompiler

Required:

- shared HighIR/decompiler path;
- no canonical direct-bytecode-to-pretty-source bypass;
- exception/control structure preserves semantics;
- variable recovery does not equate slot/register with source variable;
- provenance coverage is complete;
- semantic correctness gate is primary; text similarity is not.

## M6 — Runtime/debug

Required:

- runtime session binds to exact binary/module identity;
- managed location ↔ runtime location mapping has evidence;
- static/runtime facts remain separate;
- cross-version mapping ambiguity is explicit;
- required real runtime/device evidence passes.

A target never receives a higher cumulative `fullySatisfiedLevel` by skipping a lower incomplete level.

---

# 22. Recommended checkpoint topology

Use small vertical checkpoints, not four giant feature branches.

```text
P11-F0  preflight + live dependency audit
P11-F1  identity/profile/DecodedVM/VMEffects contracts
P11-F2  verifier/ownership/canonical runner + synthetic contract skeleton
P11-W0  WASM M0/M1
P11-W1  WASM M2
P11-W2  WASM M3 + UI/query/evidence walking skeleton
P11-S   shared-contract stability checkpoint
P11-D0  DEX M0→M3 vertical path
P11-C0  CIL M0→M3 vertical path
P11-J0  JVM M0→M3 vertical path
P11-H4  shared managed types/interprocedural hardening
P11-H5  shared managed HighIR/decompiler hardening
P11-R   final integration + exact-head release proof
```

M6 may be a target-specific lane if the ratified Phase 11 release contract requires it.

## 22.1 Why a synthetic contract skeleton is allowed

A tiny test-only synthetic VM can prove that shared identities, VMEffects validation, artifact keys, cancellation, and lowering APIs are coherent before WASM implementation becomes large.

It is a **self-test**, not product evidence. It can never replace the real WASM/DEX/CIL/JVM corpus required for release.

---

# 23. WASM lane

WASM should be the first production frontend because it gives a compact, well-specified test of stack semantics, structured control, typed values, memories, tables, imports, and traps without native ABI assumptions.

## 23.1 First vertical slice

```text
module detection
→ pinned profile/version
→ required type/import/function/export/code sections
→ stable module/function identity
→ decode one function
→ validate stack/control state
→ VMEffects for a bounded opcode subset
→ shared Semantic IR
→ shared CFG/SSA
→ evidence query back to byte range
→ expert debug projection of the shared result
```

Do **not** call this M5 decompilation. The first projection is a diagnostic/structural view used to prove the shared pipeline.

## 23.2 Hard cases to design for before broad coverage

- block/loop/if labels and branch depth;
- block parameter/result types and multi-value results;
- unreachable/polymorphic validation state;
- `br_table` target compatibility;
- direct and indirect/ref calls according to the pinned profile;
- table identity and table bounds;
- linear-memory address, width, endian, alignment, memory instance, memory growth;
- memory/table count and multi-memory/table feature gating when supported;
- imported functions/memories/tables/globals as external state;
- reference types and nullability;
- SIMD/atomics/GC/exception features only when included by the pinned profile;
- trap conditions;
- custom/name/debug sections as non-semantic metadata unless separately specified.

## 23.3 Validation strategy

The WebAssembly specification defines validation as a typed system over instructions/modules and publishes an algorithmic validation approach. Reuse that model conceptually: maintain explicit control/operand-stack validation state while decoding/lifting rather than reconstructing it later from CFG text.

## 23.4 WASM exit evidence

Record:

- spec/profile ID;
- official/spec test corpus identity used;
- opcode/feature coverage;
- validation agreement;
- semantic effect coverage;
- trap/exception coverage;
- provenance coverage;
- selected-function latency/memory on target iPad;
- explicit unsupported features.

---

# 24. DEX lane

DEX is the first strong test of a **register VM + metadata-first object model**.

## 24.1 Preserve exactly

- DEX version/container identity;
- string/type/proto/field/method identifiers;
- class definitions;
- method code identity;
- register count;
- parameter mapping into the invocation frame;
- logical wide values spanning register pairs;
- try/catch regions and handler ordering/details;
- invoke kind;
- field/static/array distinction;
- method handles/call sites where supported by the declared DEX version;
- payload pseudo-instructions and their code-unit/source ranges;
- native access flags / JNI relationship evidence;
- execution-authoritative vs debug metadata distinction.

## 24.2 DEX-specific traps

### Registers are not variables

Registers are execution locations. Value identity comes from dataflow/program point.

### Wide values are one value

DEX uses adjacent registers for 64-bit values. Preserve one logical value with a two-register storage shape.

### Arguments use the tail of the frame

Parameter mapping is defined by the method frame/calling model. Do not invent a C/native ABI layer.

### Code offsets use DEX code units

Branch/payload semantics and origin conversion must preserve the DEX encoding units while mapping to exact source byte ranges.

### Payload records are not ordinary executable instructions

Switch/array-data payloads need stable identity and references but must not become fallthrough executable operations.

### Invoke variants matter

Preserve static/direct/virtual/interface/super plus polymorphic/custom semantics when supported by the pinned version.

### Modern container form matters

When v41 container semantics are in scope, logical DEX files can reference shared later physical data and offsets are physical-container-relative. Treat this as a container/identity/mapping requirement, not a local parser edge case.

## 24.3 DEX validation/corpus

Use pinned Android/AOSP documentation and toolchain/runtime evidence. Corpus should include at least:

- Java-produced DEX;
- Kotlin-produced DEX;
- multiple DEX modules;
- exceptions;
- interfaces/virtual dispatch;
- arrays/fields;
- method handles/custom invoke when in profile;
- native method declarations;
- obfuscated examples that remain legally redistributable;
- malformed reference/index/register/control-flow fixtures.

---

# 25. CLR/CIL lane

CIL validates a metadata-rich stack machine and the dual interpretation of PE/CLI.

## 25.1 Preserve exactly

- PE/CLI association and CLI module identity;
- metadata tables/heaps/tokens;
- MethodDef/MemberRef/MethodSpec and related target distinctions;
- type/method/field signatures;
- generic parameters/instantiation context where known;
- args/locals;
- evaluation-stack transitions;
- managed references/byrefs and native-int-like categories;
- exception clauses;
- `call`, `callvirt`, `calli`, `newobj` distinctions;
- function-pointer/token operations where supported;
- P/Invoke descriptors;
- PDB/debug references as separate evidence;
- instruction prefixes and their semantic effect.

## 25.2 Critical prefixes/constructs

The foundation must leave room for exact handling of constructs such as:

- `constrained.`;
- `tail.`;
- `volatile.`;
- `unaligned.`;
- `readonly.`;
- other profile-supported prefixes/intrinsics.

Do not decode a prefix as an independent harmless instruction if it changes the following operation semantics.

## 25.3 Exceptions

CIL exception handling includes distinctions such as catch/filter/finally/fault and control-transfer rules around handlers. Preserve the exact clause type and continuation semantics before generic CFG structuring.

## 25.4 Metadata authority

Metadata token identity survives every projection. Pretty names are not identity.

Generics and custom signature constructs must not be flattened so aggressively at M1/M2 that later M4 recovery becomes impossible.

## 25.5 `callvirt` and runtime behavior

Do not normalize `callvirt` to plain direct `call` only because a statically visible method exists. Preserve dispatch/null/runtime semantics required by the declared CIL model.

---

# 26. JVM lane

JVM should reuse the stack-state infrastructure proven by WASM/CIL while retaining JVM verification, constant-pool, initialization, and dynamic-linking semantics.

## 26.1 Preserve exactly

- classfile major/minor/profile identity;
- constant-pool entry identity;
- class/method/field descriptors;
- local slots;
- operand stack;
- verification types;
- StackMapTable state when applicable;
- exception table entries and ordering;
- invocation kind;
- bootstrap methods / dynamic constants / invokedynamic where supported;
- monitor/synchronization semantics;
- native method/JNI evidence;
- optional debug/generic attributes with correct authority class.

## 26.2 Category values and stack manipulation

Category-2 values and `dup*`/`swap` legality are validation semantics, not formatting details. Model one logical value with target-defined stack width/category.

## 26.3 Constructor verification state

JVM verification distinguishes uninitialized object states around object creation/constructor invocation. Do not prematurely normalize an uninitialized reference into an ordinary object reference.

## 26.4 `invokedynamic` and dynamic constants

Preserve bootstrap method metadata and unresolved runtime semantics. Never invent a direct call target because a lambda-shaped result seems likely.

## 26.5 Exception table

Preserve exact protected ranges, catch type, handler target, and ordering/priority semantics required by the classfile model.

## 26.6 Legacy/version behavior

Old instructions/verification forms and modern classfile rules must be version-gated. A parser written for current javac output must not accidentally claim universal historical support.

## 26.7 Multi-release/container resolution

If multi-release JAR behavior is in scope, target runtime version must be part of the resolution profile. Different class variants remain separate source entities.

---

# 27. Shared M4 type and interprocedural hardening

Do shared work only after all four frontends have proved the M0→M3 vertical path or after the ratified integration contract explicitly permits an earlier shared dependency.

## 27.1 Type goals

- declared method signatures become hard constraints at valid definitions;
- field types remain bound to exact metadata identity;
- verifier types constrain stack/register values;
- nominal/generic/source metadata keeps authority class;
- arrays, managed references, nullability, byrefs, function refs, and runtime handles are represented without pretending they are native pointers;
- ambiguous runtime dispatch produces candidates, not certainty.

## 27.2 Variable recovery

Source-like variables are recovered from:

```text
value SSA
+ location live ranges
+ type constraints
+ debug metadata when available
+ control-flow scope
```

Never from raw slot/register number alone.

## 27.3 Interprocedural resolution levels

Use staged resolution:

```text
R0 exact same-module definition
R1 exact referenced module/type/method identity available in loaded project
R2 deterministic virtual/interface candidate set from known hierarchy
R3 external library/runtime descriptor known, implementation absent
R4 dynamic/bootstrap/reflection-like unresolved
```

Names may help search; they do not upgrade resolution level without identity evidence.

---

# 28. Shared M5 decompiler hardening

M5 is allowed only after M2/M3 evidence exists for the claimed frontend/profile.

## 28.1 Pipeline

```text
VMEffects
→ Semantic IR
→ CFG / SSA / dataflow / summaries
→ managed type constraints + variable recovery
→ HighIR
→ exception/control structuring
→ language/runtime idiom recovery
→ structured AST
→ renderer
```

## 28.2 Do not optimize for syntax first

Primary metrics:

- semantic equivalence on bounded ground-truth cases;
- control/exception structure correctness;
- variable merge/split accuracy;
- prototype/type accuracy;
- dispatch accuracy;
- provenance coverage;
- false certainty;
- unnecessary temporaries/gotos only after semantic correctness.

Text similarity to JADX/ILSpy/javap/etc. is diagnostic, not proof.

## 28.3 Language renderer policy

The default shared output may remain stable C-like/structured pseudocode until a language renderer has enough evidence.

A Java/C#-looking renderer must not fabricate:

- source variable names;
- generic source syntax;
- lambda structure;
- property/event syntax;
- async source constructs;
- exact overload/dispatch behavior.

Render only what the evidence supports.

---

# 29. M6 runtime/debug integration

Phase 10 should provide the provider boundary. Phase 11 maps managed entities into it when feasible.

Required concepts:

```text
RuntimeSession
  ↓
loaded managed module identity
  ↓
runtime method/code identity
  ↓
static ManagedMethodId candidate(s)
  ↓
RuntimeEvidence
```

Rules:

- JIT/native address is runtime evidence, not static method identity;
- one managed method can have multiple runtime code versions;
- runtime optimization/inlining can make location mapping partial;
- cross-version module mismatch fails closed;
- runtime observations do not mutate static VMEffects.

Do not make M6 a release blocker unless the Phase 11 foundation contract explicitly requires it for that frontend.

---

# 30. Scheduler and iPad performance architecture

Managed packages can contain tens or hundreds of thousands of methods. The wrong object model can destroy iPad usability before semantic quality matters.

## 30.1 Forbidden eager path

```text
open package
→ inflate all members
→ parse every type
→ decode every method
→ create one large JS object graph per instruction
→ decompile all methods
→ retain all artifacts in UI memory
```

## 30.2 Required demand path

```text
ByteSource
→ bounded ContainerGraph index
→ lazy module/type/method metadata indexes
→ selected method decode
→ selected method VMEffects
→ selected/dependency shared analysis
→ cold artifact persistence
→ paged query results
→ virtualized UI
```

## 30.3 Compact representation rule

Large indexes and bytecode streams should prefer compact/columnar/typed representations where practical. Do not require one heavyweight mutable JS object per operation for an entire package to be resident at once.

## 30.4 Priority classes

Reuse the global scheduler policy:

```text
P0 selected/visible method and direct user command
P1 dependencies for active question
P2 direct callers/callees/type neighborhood
P3 discovery/search index frontier
P4 global type/knowledge refinement
P5 optional expensive whole-package work
```

## 30.5 Mandatory target-device proof

Phase 11 release evidence must include real primary-device/iPadOS/WebKit proof for at least:

- open representative managed package/module;
- show first useful method result;
- analyze/decode selected method;
- cancel an in-flight managed analysis;
- navigate managed code/evidence;
- warm reopen/cache reuse where supported;
- peak memory observation for the agreed representative corpus;
- no UI main-thread lockup beyond the release threshold.

Chromium-only proof cannot close these gates.

---

# 31. Security and hostile-input model

Every managed input is hostile.

## 31.1 Common parser rules

- checked offset/length/count arithmetic;
- bounded variable-length integer decoding;
- bounded recursion/nesting;
- bounded strings/metadata rows/attributes;
- decompression ratio/member-count limits;
- duplicate member handling by identity, not unsafe path overwrite;
- no path traversal to host filesystem;
- no `eval`/execution of analyzed code;
- cancellation through every long operation;
- fail closed on malformed reference/index/token;
- no unbounded resynchronization after malformed bytecode;
- strict resource budget before allocation;
- immutable validated output objects/artifacts.

## 31.2 Target-specific negative cases

### WASM

- truncated LEB/section;
- oversized declared lengths/counts;
- deep control nesting;
- invalid type index;
- invalid branch depth;
- invalid stack state;
- unsupported feature opcode;
- malicious custom section sizes.

### DEX

- bad map/offset/count relations;
- invalid string/type/proto/method indexes;
- malformed MUTF-8;
- invalid register ranges/wide pairs;
- invalid payload targets;
- invalid try/handler ranges;
- malformed v41 container bounds/cross-logical references when supported.

### CIL

- malformed metadata heap/table indexes;
- invalid compressed integers/signatures;
- recursive/cyclic TypeSpec-like metadata shapes;
- invalid branch/handler ranges;
- invalid evaluation stack transitions;
- illegal/misplaced prefixes;
- invalid tokens/calli signatures.

### JVM

- invalid constant-pool indexes/tags;
- long/double two-slot pool edge cases;
- malformed modified UTF-8;
- malformed attributes;
- invalid StackMapTable transitions;
- illegal dup/category combinations;
- invalid branch targets/exception ranges;
- malformed bootstrap/invokedynamic metadata;
- deep/cyclic generic/signature metadata.

## 31.3 Prompt/data injection boundary

Managed string constants, class names, annotations, debug source text, and custom metadata remain untrusted analyzed data. They never become AI/system instructions.

---

# 32. Test architecture

Testing must prove both **target truth** and **shared-pipeline truth**.

## 32.1 Foundation contract tests

Before frontend fanout:

- ManagedTargetProfile normalization/versioning;
- managed identity stability/collision cases;
- DecodedVM schema validation;
- VMEffects schema/completeness validation;
- explicit unknown/state-preservation rules;
- validation-report schema;
- origin/provenance retention;
- artifact key invalidation;
- cancellation before/during/after producer work;
- no partial artifact publication;
- scheduler coalescing/determinism;
- callable/location union API;
- maturity cannot skip levels;
- support registry remains fail-closed;
- ownership manifest negative tests;
- canonical runner discovers every lane subtree;
- exact-SHA verifier invocation exists;
- synthetic contract VM runs through shared Semantic IR/CFG/SSA.

## 32.2 Per-frontend semantic tests

For each supported opcode family:

```text
decode expected
+ validation state expected
+ VMEffects expected
+ completeness expected
+ origin expected
+ shared lowering expected
```

Unknown/unsupported operations require tests too.

## 32.3 Property/invariant tests

High-value invariants:

- same exact input/profile/options → same stable semantic artifact hash;
- cold/warm path semantic equality;
- scheduler order does not change result;
- cancellation does not publish complete artifacts;
- debug/name metadata removal does not change VM execution semantics;
- unsupported op cannot become exact after lowering;
- every HighIR node retains an origin path;
- invalid join state cannot become a normal phi silently;
- unknown external call remains conservative;
- runtime observation cannot overwrite static facts.

## 32.4 Negative corpus

Malformed fixtures are first-class release tests, not fuzz-only extras.

Every confirmed parser/security bug must add a permanent regression.

## 32.5 Fuzzing

Where CI/runtime allows:

- bounded parser fuzzing;
- structured mutation of metadata indexes/counts;
- bytecode control-flow mutation;
- VMEffects validator fuzzing;
- artifact deserialization fuzzing.

A fuzzer crash is evidence of a bug, not proof of semantic correctness when no crash occurs.

---

# 33. Corpus and oracle strategy

Do not let “whatever toolchain is installed” define the release contract.

## 33.1 Corpus manifest

Create a versioned manifest recording:

```text
fixtureId
sourceHash
binaryHash
frontend/profile
producer/toolchain name + version
compiler options
runtime/validator oracle name + version
license/provenance
expected capabilities exercised
```

## 33.2 Recommended dimensions

### WASM

- multiple producer toolchains when practical;
- integer/float/control/memory/table/import cases;
- multi-value/reference features in declared profile;
- debug/custom metadata present/absent;
- official/spec tests for validation/semantics where applicable.

### DEX

- Java and Kotlin producers;
- multiple DEX modules;
- optimized/obfuscated cases;
- exceptions/interfaces/arrays/fields;
- custom/polymorphic invoke where declared;
- native declarations;
- declared DEX/container versions.

### CIL

- C#/.NET producers;
- generics;
- virtual/interface dispatch;
- exceptions incl. filters/finally where feasible;
- P/Invoke;
- prefixes;
- debug info present/absent.

### JVM

- javac and Kotlin-produced classes when practical;
- multiple classfile versions in declared support set;
- interfaces/exceptions;
- constructors/uninitialized verifier state;
- lambdas/invokedynamic;
- dynamic constants when declared;
- native methods;
- debug metadata present/absent.

## 33.3 Oracles

Priority:

1. normative official specification/tests;
2. official runtime/verifier/toolchain behavior;
3. trusted open-source primary implementation/reference;
4. differential decompiler output only as diagnostic evidence.

An oracle is always scoped to the tested behavior/profile. One successful execution is not proof of general decompilation correctness.

---

# 34. Independent verifier

The verifier is part of the product process and must exist from foundation time.

## 34.1 Required evidence dimensions

```text
productCommitSha
candidateMergeTreeId
verifierVersion/hash
frontend semantic versions
VMEffects schema/contract versions
profile IDs
fixture/corpus manifest hash
producer/toolchain identities
oracle identities
support registry result
origin/provenance result
resource-budget result
iPad/WebKit result
generated-output identity if applicable
```

## 34.2 Per-frontend result

```ts
ManagedFrontendVerification {
  frontendId
  profileId
  implementedLevel
  fullySatisfiedLevel

  detectResult
  metadataResult
  validationResult
  vmEffectsCoverage
  unknownOperationCount
  unsupportedFeatureCount
  silentPreserveFailureCount
  cfgResult
  ssaResult
  exceptionResult
  typeResult
  interproceduralResult
  decompilerResult
  provenanceCoverage
  malformedCorpusResult
  performanceResult

  firstDivergences
  unexplainedBlockingDivergenceCount
}
```

## 34.3 First-divergence rule

When a differential fails, diagnose in this order:

```text
container/member mapping
→ metadata identity
→ bytecode decode
→ validation/frame state
→ VMEffects
→ Semantic IR lowering
→ CFG
→ SSA
→ type/interprocedural analysis
→ HighIR
→ rendering
```

Do not patch the renderer to hide an upstream semantic mismatch.

## 34.4 Atomic evidence publication

CI producers must:

1. write report to a temporary path;
2. validate schema and required fixture IDs;
3. verify producer command succeeded;
4. atomically rename/publish only a valid complete report.

Aggregators validate every input. Missing/empty/partial output from a failed producer is a hard failure.

---

# 35. Performance benchmark plan

Do not invent final thresholds now. Measure the live Phase 10 product and target iPad at P11-F0/P11-F1, then freeze thresholds in the foundation contract.

Track:

- package/module cold open;
- TTFUA — time to first useful method answer;
- metadata index latency;
- selected-method decode latency;
- selected-method M2/M3 latency;
- decompile latency for M5 targets;
- warm reopen;
- search latency;
- peak resident browser memory;
- artifact cache size;
- cancellation latency;
- UI p95/p99 interaction latency;
- pathological malformed input latency;
- whole-package background completion separately from interactive latency.

Corpus size tiers should include small unit fixtures and realistic large packages. Do not optimize CI fanout before profiling a representative production hot path.

---

# 36. Support registry and release claims

The machine-readable capability registry is authority.

## 36.1 Foundation behavior

Do not mark WASM/DEX/CIL/JVM supported when the foundation starts.

The implementation may introduce known frontend IDs with all stages unsupported if useful for UI, but `fullySatisfiedLevel` remains null until measured stages pass.

## 36.2 Promotion transaction

A maturity promotion requires the same reviewed change/checkpoint to contain or reference:

- implementation;
- exact-head tests;
- verifier evidence;
- corpus/profile identity;
- support registry change;
- `SUPPORT_MATRIX.md` projection update;
- no stronger UI wording than the machine truth.

A parser menu item is not support evidence.

---

# 37. Ownership model

Exact paths must be frozen against the live tree at P11-F0. The default ownership shape is:

## Foundation owner

```text
js/managed/shared/**                    proposed
shared managed identity/profile APIs
VMEffects schema/validator
managed query facade changes
js/platform/capability-maturity.js      only when foundation/promotion requires
phase11 verifier/governance/runner
```

## WASM lane

```text
js/managed/wasm/**
tests/phase11/wasm/**
fixtures/phase11/wasm/**                exact path decided at preflight
```

## DEX lane

```text
js/managed/dex/**
tests/phase11/dex/**
fixtures/phase11/dex/**
```

## CIL lane

```text
js/managed/cil/**
tests/phase11/cil/**
fixtures/phase11/cil/**
```

## JVM lane

```text
js/managed/jvm/**
tests/phase11/jvm/**
fixtures/phase11/jvm/**
```

## Shared hardening owner

Owns only genuinely common M4/M5 changes after the vertical frontends exist.

## Integration owner

Owns:

- shared wiring handoffs;
- generated release output;
- support-matrix projection;
- living checkpoint;
- moving-main reconciliation;
- candidate merge-tree proof;
- release evidence.

## 37.1 Contract-change rule after freeze

A component lane that discovers a missing shared capability does not silently edit shared core.

It submits a typed integration handoff:

```text
handoffId
requestingLane
blockedCapability
minimal shared contract change
why target-private workaround is unsafe
expected affected lanes
required evidence invalidation
proposed tests
```

Foundation/integration owns the shared change, then dependent lanes revalidate against the new contract version.

---

# 38. Living integration workflow

Phase 11 must follow `ENGINEERING_PROCESS_GUARDRAILS.md` exactly.

## 38.1 Foundation gate before fanout

No DEX/CIL/JVM parallel fanout until all are true:

- live `main` exact SHA recorded;
- Phase 10 release evidence/postmortem reviewed;
- default Phase 11 exit contract ratified;
- living integration branch/PR exists;
- moving-main owner exists;
- ownership manifest exists and passes negative tests;
- canonical runner exists and discovers sentinel tests in every lane subtree;
- exact-SHA/manual verifier path exists;
- ManagedTargetProfile contract frozen;
- identity contract frozen;
- DecodedVM contract frozen;
- VMEffects contract frozen;
- validation report contract frozen;
- ArtifactKey/version rules frozen;
- support-promotion tests exist;
- synthetic shared skeleton passes;
- first real WASM walking skeleton plan is accepted;
- iPad benchmark/proof plan is defined.

## 38.2 Candidate merge-tree proof

Before a component merge:

1. refetch live `main`, integration head, component head;
2. reconcile integration with current `main` if required by the contract;
3. prove component head did not move after review;
4. inspect actual changed-file union;
5. run ownership/governance checks on the candidate tree;
6. run rolling managed vertical gate on the candidate tree;
7. run independent verifier/shadow proof;
8. only then merge component into living integration.

## 38.3 Integration checkpoint lock

After each component merge, no next component is accepted until one exact integration head has:

- cross-lane contract reconciliation complete;
- schema/version/invalidation updates complete;
- generated outputs canonically rebuilt by integration owner where applicable;
- generated rebuild zero diff;
- rolling vertical gate green;
- independent verifier green;
- required target-device evidence updated when the change affects it;
- exact checkpoint evidence committed/recorded.

---

# 39. Durable Phase 11 checkpoint

Maintain a repository-visible checkpoint through the phase.

Suggested machine-readable fields:

```text
phase: 11
schemaVersion
foundationBaseSha
liveMainShaAtLastReconcile
integrationHeadSha
integrationPr
contractVersions
verifierVersion
corpusManifestHash
integratedComponents
pendingComponents
supportLevels
lastGeneratedIdentity
lastTargetDeviceEvidence
blockingDivergences
nextAllowedAction
```

This checkpoint is evidence, not a substitute for CI. It prevents a long managed-frontend campaign from depending on conversation memory.

---

# 40. Suggested Worker/task decomposition

Use parallelism only after the shared contract is stable.

## Before stability checkpoint

Prefer:

```text
Worker/owner A: shared contracts + schemas
Worker/owner B: verifier/corpus harness, no shared implementation writes
Worker/owner C: WASM official-spec/test research + fixtures, no shared writes
Integration owner: walking skeleton + reconciliation
```

Do not start DEX/CIL/JVM production implementation yet.

## After WASM shared-contract stability

Useful independent lanes:

```text
DEX target-specific frontend
CIL target-specific frontend
JVM target-specific frontend
independent verifier/corpus lane
performance/iPad lane
integration/shared hardening lane
```

No lane edits another lane’s target implementation unless the integration owner deliberately reassigns ownership.

---

# 41. Efficiency rules

These rules reduce Phase 11 wall-clock time without trading correctness.

1. **Prove the vertical path before broad opcode coverage.** A 500-op parser with no shared SSA path is not useful progress.
2. **Freeze identity/version contracts early.** Retrofitting cache/evidence IDs across four frontends is expensive.
3. **Use one stack-state engine for stack VMs where semantics permit.** WASM/CIL/JVM can share infrastructure, not target rules.
4. **Keep target rules data-driven when safe.** Generated opcode tables can reduce boilerplate, but semantics still require reviewed target logic.
5. **Separate decode coverage from semantic coverage.** Broad decoding may advance faster than exact VMEffects; report both.
6. **Keep M4/M5 common.** Do not independently reinvent variable/type/decompiler logic in each lane.
7. **Profile first.** Fix O(N²)/eager hot paths before adding CI shards.
8. **Persist cold artifacts.** Do not recompute parsed metadata/selected-method semantics on every UI visit.
9. **Reuse official conformance corpora.** Generate additional fixtures only for Hex-specific provenance/artifact/UI properties.
10. **Treat unsupported as a feature.** Explicit unsupported profiles let useful subsets ship safely without blocking on every edge case.

---

# 42. Risk register

| Risk | Failure mode | Prevention / early gate |
|---|---|---|
| fake-native model | stack/register semantics lost | VM-native state + VMEffects sibling contract |
| four semantic engines | integration/decompiler divergence | shared lowering/CFG/SSA/HighIR only |
| version drift | artifacts change under “latest” | pinned ManagedTargetProfile in ArtifactKey |
| metadata overtrust | debug/name hint becomes truth | authority classes A–D |
| metadata underuse | exact signatures re-guessed | hard constraints for execution-authoritative metadata |
| invalid-bytecode repair | false exact semantics | invalid-but-inspectable validation state |
| CIL/native collision | PE managed/native identity confusion | dual-domain association on same BinaryId |
| DEX v41 mapping | wrong logical/physical offsets | container-aware identity/mapping tests |
| JVM verifier loss | incorrect CFG/SSA/decompiler | StackMap/uninitialized/category state preserved |
| WASM feature drift | accidental unsupported semantics | pinned core spec/profile + feature gating |
| dynamic dispatch guessing | false direct targets | staged resolution + candidate sets |
| native interop name matching | cross-binary false identity | evidence-bound cross-domain links |
| exception deferral | later CFG rewrite | exception regions in first vertical slice |
| artifact explosion | iPad memory failure | lazy method artifacts + compact indexes |
| cancellation race | stale/partial cached result | atomic artifact publication + scheduler tests |
| late verifier | release blocked by verifier bugs | exact-SHA verifier at foundation |
| moving main | repeated stale PR chains | one living integration owner |
| CI artifact corruption | false green aggregate | temp→validate→atomic publish |
| capability overclaim | UI says “supported” from parser | cumulative M0–M6 registry gate |
| external dependency drift | semantics change silently | pinned dependency/spec/toolchain identity |
| desktop-only architecture | iPad release failure | mandatory real iPad proof |

---

# 43. Explicit non-goals / defer list

Unless ratified as required dependencies, do not let Phase 11 expand into:

- full Android resource/UI decompilation;
- OAT/VDEX/ART native-runtime recovery;
- full .NET ReadyToRun/NativeAOT reverse engineering;
- complete Java source reconstruction including every compiler sugar;
- WASM Component Model support if core-module support is the declared Phase 11 profile;
- dependency/package-manager network resolution;
- automatic downloading of Maven/NuGet/runtime libraries;
- complete reflection target recovery;
- production managed debugger for every runtime;
- cross-language source regeneration;
- managed binary rewriting/reassembly as a new major subsystem;
- generalized archive format work unrelated to the managed container paths required here.

A deferred item remains visible as explicit unsupported/partial capability where relevant.

---

# 44. Decisions that must remain open until Phase 11 preflight

Do not freeze these today because Phase 7–10 and upstream specs/tooling may change them:

- exact source file layout under `js/managed/**`;
- whether VMEffects and MachineEffects share a common envelope implementation or only conventions/interfaces;
- exact parser/decoder library choices;
- exact WebAssembly profile/features;
- exact DEX versions/container variants;
- exact JVM classfile version window;
- exact CLI/runtime profile boundaries;
- exact M4/M5 minimum per frontend beyond the default exit proposal;
- whether any M6 target is release-blocking;
- exact corpus/toolchain versions;
- exact iPad numeric performance thresholds;
- exact CI partition count/topology;
- exact managed plugin contribution surface.

Every one is resolved against live evidence, then versioned.

---

# 45. Decisions that should be frozen now

These are architecture choices, not implementation trivia:

1. four isolated managed semantic engines are forbidden;
2. fake native-register modeling is forbidden;
3. VMEffects is the low-level managed semantic boundary;
4. target profile/version is part of semantic identity;
5. value identity is separate from stack/register/local location;
6. validation is a first-class artifact;
7. invalid-but-inspectable is supported as an explicit state;
8. exception behavior exists before shared CFG claims;
9. metadata authority classes are explicit;
10. shared Semantic IR/CFG/SSA/HighIR remains canonical downstream truth;
11. managed/native links require evidence, never name-only identity;
12. artifact generation is lazy, versioned, atomic, and cancellable;
13. cumulative M0–M6 machine truth controls support labels;
14. iPad/WebKit product evidence is mandatory for Phase 11 release;
15. exact-SHA verifier and living integration exist before parallel fanout.

---

# 46. Preflight checklist

Before writing production Phase 11 frontend code:

- [ ] live `main` exact SHA recorded
- [ ] Phase 10 release evidence/postmortem read
- [ ] Master Architecture re-read
- [ ] Engineering Process Guardrails re-read including all new EP entries
- [ ] official WASM/DEX/CLI/JVM specifications re-verified
- [ ] default Phase 11 exit contract ratified
- [ ] supported target profiles/version windows declared
- [ ] living integration branch/PR created
- [ ] moving-main owner declared
- [ ] ownership manifest created
- [ ] ownership negative tests green
- [ ] canonical runner created
- [ ] sentinel test discovery for every lane proven
- [ ] exact-SHA verifier path created
- [ ] corpus manifest schema created
- [ ] ManagedTargetProfile frozen
- [ ] managed identity schema frozen
- [ ] CallableRef/CodeLocation audit complete
- [ ] DecodedVM schema frozen
- [ ] VM validation schema frozen
- [ ] VMEffects schema/completeness rules frozen
- [ ] artifact key/invalidation rules frozen
- [ ] support promotion tests green
- [ ] synthetic contract walking skeleton green
- [ ] WASM real walking-skeleton fixtures ready
- [ ] target iPad benchmark/proof plan ready

If any applicable item is false, broad frontend fanout has started too early.

---

# 47. Per-component completion checklist

A WASM/DEX/CIL/JVM component lane is ready for candidate integration only when:

- [ ] exact frozen base recorded
- [ ] actual changed files fit ownership allowlist
- [ ] target profile/version stated
- [ ] M0/M1 claimed stages have direct tests
- [ ] decoded VM operations preserve source ranges
- [ ] validation state is explicit
- [ ] M2 coverage is measured, not inferred
- [ ] no silent preserve/no-op fallback
- [ ] unsupported/partial operations have explicit reasons
- [ ] exception/trap behavior for claimed coverage is modeled
- [ ] shared lowering used
- [ ] shared CFG/SSA used for M3 claims
- [ ] provenance chain complete
- [ ] malformed corpus green
- [ ] cancellation/resource tests green
- [ ] owned tests + canonical Phase 11 runner green
- [ ] exact head SHA recorded
- [ ] integration handoffs listed
- [ ] no capability promotion beyond evidence

---

# 48. Integration checkpoint checklist

After each component merge into living integration:

- [ ] live `main` relationship checked
- [ ] contract/version changes reconciled
- [ ] dependent evidence invalidation applied
- [ ] support registry still conservative
- [ ] generated output rebuilt/committed by owner if applicable
- [ ] canonical rebuild zero diff
- [ ] full rolling managed vertical gate green
- [ ] existing native semantic/decompiler regressions green
- [ ] independent managed verifier green
- [ ] malformed corpus aggregate green
- [ ] artifact/cache determinism green
- [ ] target iPad proof refreshed when affected
- [ ] checkpoint exact SHA recorded
- [ ] next component merge unlocked only after all applicable checks pass

---

# 49. Final release checklist

Phase 11 is not done until all applicable repository guardrail items and these Phase 11 items pass on the exact release product:

- [ ] all four declared frontends present
- [ ] every claimed M-level has verifier evidence
- [ ] no skipped cumulative maturity prerequisite
- [ ] supported profile/version set is explicit
- [ ] unsupported feature/version set is explicit
- [ ] VMEffects silent-preserve failures = 0
- [ ] provenance-loss failures = 0
- [ ] unexplained blocking semantic divergences = 0
- [ ] malformed-input blockers = 0
- [ ] type false-certainty gate passes for claimed M4 targets
- [ ] decompiler semantic gate passes for claimed M5 targets
- [ ] runtime identity gate passes for claimed M6 targets
- [ ] candidate merge-tree proof green
- [ ] generated output clean on exact head where applicable
- [ ] target iPad/WebKit product proof green
- [ ] support registry and `SUPPORT_MATRIX.md` agree
- [ ] canonical integration merged with expected-head protection
- [ ] live `main` refetched and proven to contain the release product
- [ ] deployed/in-memory identity separately proven if Phase 11 completion depends on deployed runtime behavior
- [ ] Phase 12 has not started early

---

# 50. Suggested release evidence schema

```text
phase11SchemaVersion
productCommitSha
integrationBaseSha
candidateMergeTreeId
verifierVersion
corpusManifestHash
toolchainManifestHash
vmEffectsSchemaVersion
vmEffectsContractVersion
managedIdentitySchemaVersion
managedProfileSchemaVersion
semanticIrSchemaVersion
artifactSchemaVersion

frontends:
  wasm:
    profileIds
    implementedLevel
    fullySatisfiedLevel
    detect
    metadata
    validation
    vmEffectsCoverage
    exactBundleCount
    intrinsicBundleCount
    partialBundleCount
    unknownBundleCount
    unsupportedFeatureCount
    silentPreserveFailureCount
    cfg
    ssa
    exceptions
    typeInterproc
    decompiler
    runtime
    provenanceCoverage
    malformedCorpus
    performance
    blockers
  dex: ...
  cil: ...
  jvm: ...

ownershipResult
canonicalRunnerDiscoveryResult
candidateMergeTreeResult
nativeRegressionResult
artifactDeterminismResult
resourceBudgetResult
iPadWebKitResult
generatedOutputSynchronizationResult
supportMatrixResult
unexplainedBlockingDivergenceCount
phase11ExitGateFullySatisfied
phase12Started
```

The report records measured values. Product code must not contain hard-coded “expected green” evidence.

---

# 51. Primary technical references

Use primary sources first and pin versions/commits in implementation ADRs and verifier manifests.

## Hex

- `docs/HEX_MASTER_ARCHITECTURE.md`
- `docs/ENGINEERING_PROCESS_GUARDRAILS.md`
- `docs/SOURCES.md`
- `js/platform/capability-maturity.js`
- `js/semantics/effects/index.js`
- live Phase 7–10 release evidence when Phase 11 starts

## WebAssembly

- WebAssembly Core Specification: https://webassembly.github.io/spec/core/
- Validation algorithm: https://webassembly.github.io/spec/core/appendix/algorithm.html
- Upstream spec/tests repository: https://github.com/WebAssembly/spec

## DEX / Android

- DEX format: https://source.android.com/docs/core/runtime/dex-format
- Dalvik bytecode: https://source.android.com/docs/core/runtime/dalvik-bytecode
- Instruction formats: https://source.android.com/docs/core/runtime/instruction-formats
- DEX constraints: https://source.android.com/docs/core/runtime/constraints

## CLR/CIL

- ECMA-335 Common Language Infrastructure: https://ecma-international.org/publications-and-standards/standards/ecma-335/

## JVM

- Java Virtual Machine Specification, current edition index: https://docs.oracle.com/en/java/javase/26/docs/specs/jvms/index.html
- Class file format / verification chapters from the pinned supported edition.

## Differential references

Use `SOURCES.md` for project/repository references such as JADX and ILSpy. They are useful differential implementations, but official VM specifications/runtime behavior remain the first semantic authority.

---

# 52. Final working rule

When a Phase 11 implementation choice is unclear, preserve this chain:

```text
exact source bytes
+ authoritative structural metadata
+ explicit profile/version
        ↓
decoded VM operation
        ↓
validated VM-native state transition
        ↓
VMEffects with explicit completeness
        ↓
shared conservative semantic analysis
        ↓
shared evidence/provenance
        ↓
high-level readability
```

If a shortcut is attractive because it bypasses identity, validation, VMEffects, shared analysis, or provenance, it is almost certainly creating integration debt.

Phase 11 should feel like **adding four rigorously versioned frontends to one analysis compiler**, not bolting four decompilers onto Hex.
