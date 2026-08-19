# Hex Master Architecture Specification

> **Status:** Proposed canonical target architecture  
> **Version:** 1.0  
> **Repository:** `rhgrive3/hex`  
> **Current implementation baseline:** `574429289786c9d3d8998c8240b67d56c8029b1b`  
> **Primary product constraint:** Browser/iPad-first, universal binary analysis, beginner-to-expert, evidence-first  
> **Research inputs:** `deep-research-report.md` (non-normative) and `REFERENCES.md` / `SOURCES.md` (evidence index)  
> **Normative keywords:** MUST, MUST NOT, SHOULD, SHOULD NOT, MAY have their RFC-style meanings.

---

## 0. Authority, purpose, and maintenance

This document is the canonical target architecture for Hex. It exists to prevent the project from becoming a collection of individually strong features with incompatible semantics.

The implementation may temporarily differ during migration, but every architectural change MUST move the code toward this specification or update this specification in the same change with an explicit architecture decision.

### 0.1 Source-of-truth order

When documents disagree, use this order:

1. This specification, as updated on the target branch.
2. An accepted Architecture Decision Record (ADR) merged after this specification.
3. Versioned public API/schema contracts.
4. Current source code and tests, for what Hex actually does today.
5. `REFERENCES.md` / `SOURCES.md`, for external evidence.
6. `deep-research-report.md`, for research context and rationale only.

An accepted ADR that changes this specification MUST update the affected section in the same PR. Permanent divergence between an ADR and this document is not allowed.

### 0.2 What this document is not

This is not:

- a feature wishlist;
- a competitive-comparison report;
- a promise that an unimplemented capability already exists;
- a license opinion;
- a requirement to rewrite working code in one step.

It is the contract that future Hex implementations, refactors, plugins, AI agents, tests, and UI projections MUST converge on.

---

# 1. Mission

Hex SHALL become a universal reverse-engineering and binary-analysis platform that combines:

- exact and retargetable low-level semantics;
- industrial static analysis;
- high-quality decompilation;
- dynamic/runtime verification;
- explainable binary similarity and knowledge;
- deterministic evidence-backed semantic facts;
- safe AI-assisted investigation;
- browser/iPad accessibility;
- an interface that is useful to a beginner without reducing expert power.

Hex SHALL NOT win by copying the appearance of IDA, Ghidra, Binary Ninja, or any other product. It SHALL win by maintaining a stronger end-to-end truth chain:

```text
High-level claim
    ↓
Capability / Semantic Fact
    ↓
Decompiler / High IR
    ↓
Type / Dataflow / Alias proof
    ↓
SSA / Memory SSA
    ↓
Semantic IR
    ↓
Low-Level Effects
    ↓
Decoded instruction / bytecode operation
    ↓
Binary / container offset

             +
             ├── Runtime Evidence
             ├── Symbolic Proof
             ├── Signature / Knowledge Evidence
             └── User Confirmation
```

Every layer SHALL be inspectable. A high-level answer that cannot descend to its evidence is incomplete.

---

# 2. Non-negotiable invariants

These invariants outrank convenience, UI simplicity, and short-term performance.

## INV-001 — One semantic truth

Hex MUST NOT maintain multiple unrelated semantic interpretations of the same instruction as competing truths.

Low-level semantics, Semantic IR, SSA, High IR, decompiler output, facts, AI explanations, and runtime conclusions are derived projections linked by stable identities and provenance.

## INV-002 — Unknown is explicit

If Hex cannot model an operation, alias relation, function boundary, type, runtime state, or control-flow target safely, it MUST represent the uncertainty.

It MUST NOT invent a value because a guessed answer is more useful to the UI.

## INV-003 — Conservative analysis

An unknown store MUST NOT become `NoAlias`.

An unknown call MUST NOT be assumed pure.

An unresolved indirect branch MUST NOT be silently discarded.

An unsupported instruction MUST NOT be modeled as preserving state unless preservation is proven by the target specification.

## INV-004 — Provenance is preserved through every transform

Every derived semantic entity MUST retain a path to its origin.

Decompiler simplification, variable recovery, type recovery, diff matching, capability inference, symbolic proof, runtime fusion, and AI explanation MUST preserve origin/evidence links.

## INV-005 — Architecture, ABI, platform, and language are separate

An architecture module MUST NOT contain OS calling-convention assumptions.

An ABI module MUST NOT decode instructions.

A loader MUST NOT perform source-language type inference.

A language-runtime provider MUST NOT redefine machine semantics.

## INV-006 — Parser is not loader

Reading a file header is not format support.

Format support requires correct mapped-address semantics, imports/exports, relocations/bindings, symbols, executable regions, function-boundary evidence, and relevant runtime/debug metadata references.

## INV-007 — Runtime observation does not overwrite static truth

Runtime observations are time-stamped evidence from a specific binary identity, runtime session, input, and execution path.

They MAY confirm, contradict, or refine a static hypothesis. They MUST NOT silently mutate the static semantic model.

## INV-008 — AI has no semantic authority

The model may plan, select tools, summarize, rank bounded candidates, and explain results.

Only deterministic Hex analyzers/verifiers or explicit user confirmation may create verified facts.

Model prose is never a source of binary truth.

## INV-009 — Beginner and expert modes share one analysis

Beginner mode MUST NOT use a weaker, separate analysis engine.

Expert mode MUST NOT expose a different semantic truth.

The modes differ only in projection, terminology, density, and available detail.

## INV-010 — Capability is graded, not boolean

Hex MUST NOT claim that an architecture or format is simply “supported” when only decoding or header parsing works.

Support SHALL be reported by explicit capability levels.

## INV-011 — Large input is demand-driven

Opening a large binary MUST NOT require loading the entire file, decoding every instruction, constructing every CFG, decompiling every function, or retaining every analysis object in browser memory.

## INV-012 — Work is cancellable and budgeted

Long-running parsing, analysis, plugin execution, symbolic execution, runtime work, AI investigation, indexing, and diffing MUST support cancellation and resource budgets.

## INV-013 — User state and derived analysis are separate

Names, comments, types, patches, confirmations, bookmarks, and investigation decisions are user/project facts.

SSA, CFGs, decompiler ASTs, indexes, fingerprints, and inferred facts are derived analysis artifacts.

The two MUST have different persistence and invalidation rules.

## INV-014 — No big-bang semantic rewrite

Existing ARM64 correctness MUST remain protected while v2 semantics are introduced.

Migration MUST use compatibility adapters, differential gates, and staged cutovers.

## INV-015 — “Fast” never means unsound

Performance improvements MAY defer work, page artifacts, cache results, lower scheduling priority, or return explicit `unknown`.

They MUST NOT change a conservative result into an unjustified confident result.

---

# 3. Current-state baseline

The baseline for this specification is commit:

```text
574429289786c9d3d8998c8240b67d56c8029b1b
```

At this baseline, Hex already has substantial implementation in the following areas:

- browser-first file handling and source-backed binary parsing;
- Mach-O, ELF, and PE foundations;
- ARM64-oriented Semantic IR;
- SSA and Memory SSA;
- conservative unknown-store handling;
- pointer provenance and alias queries;
- CFG/dataflow;
- multi-stage semantic decompiler;
- type recovery;
- Objective-C and Swift intelligence;
- signatures, fingerprints, recognition, diff, and knowledge;
- bounded symbolic execution;
- runtime/debug adapter abstractions and runtime evidence;
- `.hexproj` v1;
- plugin isolation/budgets;
- typed AI tools/evidence/hypothesis/proposal architecture;
- mobile-first UI architecture;
- broad regression and differential CI.

The largest architectural debt is not missing feature count. It is boundary quality.

### 3.1 Current architecture debt

1. `js/ir-core.js` combines ARM64 lifting, AAPCS64 knowledge, IR vocabulary, and SSA/Memory-SSA responsibilities.
2. `ArchitectureAdapter` currently abstracts decode/view/control-flow/assemble concerns but does not own complete exact semantic lifting.
3. x86-64 can be decoded in the platform layer but does not have ARM64-equivalent semantic/dataflow/decompiler capability.
4. current Memory SSA and alias safety are strong foundations but not a complete region/points-to/interprocedural model.
5. `.hexproj` v1 is a good portable project document, not a scalable analysis artifact database.
6. plugin API contribution categories are narrower than the final platform requires.
7. decompiler middle-end quality is ahead of a prototype but still carries ARM64-specific patterns and lacks the complete optimization/structuring depth required for a best-in-class universal decompiler.
8. current symbolic execution is intentionally bounded and solver-light.
9. runtime adapters are an excellent boundary but are not yet an industrial debugger/instrumentation/emulation ecosystem.
10. current UI documentation contains one legacy contradiction about whether Investigate or Code is the default route. This specification resolves it: **Code is the canonical default route.**

---

# 4. Canonical system architecture

Hex SHALL be organized as cooperating planes around one identity/provenance system.

```text
┌──────────────────────────────────────────────────────────────────────┐
│                           INPUT PLANE                                │
│ ByteSource → ContainerGraph → Loader → BinaryImage                   │
└──────────────────────────────┬───────────────────────────────────────┘
                               │
┌──────────────────────────────▼───────────────────────────────────────┐
│                         TARGET PLANE                                 │
│ Architecture + Decoder + ABI + Platform + Runtime Metadata           │
└──────────────────────────────┬───────────────────────────────────────┘
                               │
┌──────────────────────────────▼───────────────────────────────────────┐
│                      LOW-LEVEL EFFECT PLANE                          │
│ Native: MachineEffects        VM/Managed: VMEffects                  │
└──────────────────────────────┬───────────────────────────────────────┘
                               │
┌──────────────────────────────▼───────────────────────────────────────┐
│                        SEMANTIC PLANE                                │
│ Semantic IR → CFG → SSA → MemorySSA → Alias → Dataflow → Summaries  │
└──────────────────────────────┬───────────────────────────────────────┘
                               │
┌──────────────────────────────▼───────────────────────────────────────┐
│                    HIGH-LEVEL ANALYSIS PLANE                         │
│ Types → Variables → HighIR → Structuring → Decompiler → Facts       │
└──────────────────────────────┬───────────────────────────────────────┘
                               │
        ┌──────────────────────┼────────────────────────┐
        │                      │                        │
┌───────▼────────┐   ┌─────────▼─────────┐    ┌────────▼────────┐
│ KNOWLEDGE      │   │ VERIFICATION      │    │ MUTATION        │
│ signatures     │   │ symbolic          │    │ patch plans     │
│ recognition    │   │ runtime/debug     │    │ rebuild         │
│ diff           │   │ instrumentation   │    │ validation      │
│ capabilities   │   │ emulation         │    │                 │
└───────┬────────┘   └─────────┬─────────┘    └────────┬────────┘
        │                      │                       │
        └──────────────────────┼───────────────────────┘
                               │
┌──────────────────────────────▼───────────────────────────────────────┐
│                    EVIDENCE + ARTIFACT PLANE                        │
│ EvidenceGraph + ArtifactStore + ProjectStore + SearchIndex          │
└──────────────────────────────┬───────────────────────────────────────┘
                               │
        ┌──────────────────────┼────────────────────────┐
        │                      │                        │
┌───────▼────────┐   ┌─────────▼─────────┐    ┌────────▼────────┐
│ TYPED AI PLANE │   │ PLUGIN PLANE      │    │ UI PROJECTION   │
│ tools/verifier │   │ isolated/versioned│    │ beginner/expert │
└────────────────┘   └───────────────────┘    └─────────────────┘
```

No plane may bypass the evidence/identity contracts merely because a direct call is easier.

---

# 5. Identity and provenance model

Stable identity is the foundation for caching, evidence, diffing, runtime fusion, project persistence, and AI.

## 5.1 Required identities

Hex SHALL define at least:

```text
BinaryId
ContainerId
SliceId
ImageId
ArchitectureId
AbiId
PlatformId
ArtifactId
EntityId
InstructionId / BytecodeOpId
BlockId
FunctionId
ValueId
MemoryRegionId
TypeCandidateId
EvidenceId
HypothesisId
RuntimeSessionId
PatchSetId
PluginId
```

### BinaryId

`BinaryId` MUST derive from content, not filename.

For very large files, hashing MAY be lazy/streaming, but any operation that persists or fuses cross-session evidence MUST eventually bind to a verified content hash.

### FunctionId

Within a binary:

```text
FunctionId = (BinaryId, SliceId, canonicalStartIdentity)
```

A cross-version function match MUST NOT reuse `FunctionId`.

Cross-binary identity SHALL use a separate `FunctionMatch` / `FunctionIdentityCandidate` with algorithm version, confidence, ambiguity margin, and evidence.

### InstructionId

For native code:

```text
InstructionId =
    BinaryId
  + SliceId
  + virtualAddress
  + decodeMode
  + decoderSemanticVersion
```

For managed/VM code, the equivalent uses method identity + operation index/offset.

## 5.2 OriginSet

Every semantic node SHALL carry an immutable `OriginSet`.

An `OriginSet` may contain:

- binary byte ranges;
- virtual-address ranges;
- decoded instruction IDs;
- bytecode operation IDs;
- source debug locations when available;
- parent semantic entity IDs;
- transform records.

A transform MUST union or deliberately narrow origins. It MUST NOT silently drop origins.

## 5.3 Transform history

High-level rewrites SHOULD record:

```ts
TransformRecord {
  passId
  passVersion
  ruleId
  consumedEntityIds
  producedEntityIds
  preconditions
  proofKind
  timestampOrBuildId
}
```

This record is analysis metadata, not model chain-of-thought.


## 5.4 EvidenceGraph

`EvidenceGraph` is a first-class core subsystem, not a UI annotation layer.

It SHALL model claims, observations, proofs, contradictions, and derivations as typed nodes/edges.

Minimum node families:

```text
BinaryEvidence
DecodeEvidence
SemanticEvidence
DataflowEvidence
TypeEvidence
ControlFlowEvidence
SignatureEvidence
KnowledgeEvidence
SymbolicEvidence
RuntimeEvidence
UserEvidence
Claim
```

Minimum edge families:

```text
derived-from
supports
contradicts
refines
observed-at
originates-from
verified-by
matched-by
supersedes
```

Every `Claim` MUST identify:

- the target entity or scope;
- semantic kind;
- supporting evidence IDs;
- contradicting evidence IDs;
- assumptions;
- completeness;
- current verdict.

Evidence nodes are immutable. A later result creates a new node/edge or supersedes a prior interpretation; it does not rewrite historical evidence.

### Evidence verdicts

Canonical verdicts:

```text
confirmed
supported
unverified
contradicted
unknown
```

`confirmed` requires direct deterministic observation/proof appropriate to the claim type.

A confidence score MUST NOT by itself promote a claim to `confirmed`.

### Evidence completeness

Evidence may also state whether analysis was complete for the relevant scope:

```text
complete
bounded
partial
truncated
unsupported
```

This prevents a strong-looking local result from being presented as proof about an unanalyzed whole binary.

## 5.5 AnalysisSnapshot

UI, AI, plugins, exporters, and long-running queries SHALL read through an immutable `AnalysisSnapshot`.

```ts
AnalysisSnapshot {
  snapshotId
  binaryId
  projectRevision
  artifactVersions
  analysisEpoch
  createdAt
}
```

A snapshot provides a consistent view while background analysis continues.

Background tasks MAY publish newer artifacts, but an in-flight query MUST NOT observe half of the old graph and half of the new graph unless it explicitly opts into a newer snapshot.

This is required for reproducible AI answers, deterministic exports, and race-free UI navigation.

## 5.6 Public Analysis Query API

All first-party frontends SHALL consume one typed query layer rather than reaching into subsystem internals.

```ts
interface AnalysisQueryAPI {
  snapshot(options?): Promise<AnalysisSnapshot>

  binaryInfo(snapshot)
  functions(snapshot, query, page)
  function(snapshot, functionId)
  instructions(snapshot, range, page)
  semanticIR(snapshot, functionId, options)
  cfg(snapshot, functionId)
  callers(snapshot, functionId, page)
  callees(snapshot, functionId, page)
  xrefs(snapshot, entityId, page)
  types(snapshot, scope, page)
  evidence(snapshot, query, page)
  decompile(snapshot, functionId, options)
  search(snapshot, query, page)
  causalPath(snapshot, source, sink, options)
}
```

Rules:

- large collections are paged/streamed;
- results use stable IDs;
- every query accepts cancellation;
- expensive queries expose cost/completeness;
- no API requires the caller to understand a private JS object layout;
- UI, Node/headless tooling, AI tools, and MCP-like integrations SHOULD reuse this layer.

## 5.7 Command/Capability API

Mutating or action-oriented operations SHALL use a separate capability/command layer.

Examples:

```text
navigate
rename
comment
set-type
add-struct-field
create-patch
apply-patch
start-runtime-session
run-experiment
export
```

Each command declares whether it is:

- read-only;
- project mutation;
- binary mutation/export;
- runtime mutation;
- privileged external action.

Human UI and AI adapters SHOULD map to the same capability catalog, while authorization remains explicit and context-specific.

## 5.8 Determinism and reproducibility metadata

Every durable analysis result SHOULD identify:

```text
engineBuild
schemaVersion
passVersions
targetSemanticVersions
optionsHash
inputArtifactIds
outputArtifactId
```

A result produced by an optional remote/native backend must be distinguishable from one produced locally, even when both implement the same semantic contract.

---

# 6. Input, ByteSource, containers, and loaders

## 6.1 ByteSource

All binary access SHALL pass through a format-neutral source abstraction.

```ts
interface ByteSource {
  size(): Promise<bigint> | bigint
  read(offset: bigint, length: number, options?): Promise<Uint8Array>
  stream?(range?, options?): AsyncIterable<Uint8Array>
  identityHint?(): SourceIdentityHint
}
```

Rules:

- offsets are `BigInt`;
- lengths are bounded safe integers;
- reads are cancellable;
- implementations MAY be File/Blob, OPFS, memory, Node file, remote HTTP range, archive member, runtime memory snapshot;
- whole-file buffering MUST NOT be required.

## 6.2 ContainerGraph

Nested formats SHALL be modeled explicitly.

Examples:

```text
IPA
 └─ ZIP
    └─ Payload/App.app/App
       └─ FAT Mach-O
          ├─ arm64 slice
          └─ arm64e slice
```

```text
APK
 ├─ classes.dex
 ├─ lib/arm64-v8a/libfoo.so
 └─ resources.arsc
```

A container node MUST preserve parent range/source provenance.

## 6.3 Detector

Detection SHALL return ranked candidates:

```ts
Detection {
  formatId
  confidence
  evidence
  requiredBytes
}
```

A detector MUST have a bounded probe budget.

## 6.4 Loader contract

A loader is responsible for executable semantics, not only parsing.

```ts
interface Loader {
  probe(source, options): Promise<Detection>
  open(source, options): Promise<BinaryImage>
  debugInfoRefs?(image): AsyncIterable<DebugInfoRef>
  runtimeMetadataHints?(image): AsyncIterable<RuntimeMetadataHint>
}
```

## 6.5 BinaryImage

Canonical fields:

```ts
BinaryImage {
  id
  format
  bits
  endian
  architecture
  architectureMode
  platform
  abiHints
  imageBase
  entrypoints

  segments
  sections
  imports
  exports
  symbols
  relocations
  libraries
  functionSeeds
  unwindSources
  debugInfoRefs
  runtimeMetadataHints

  addressToSource(address)
  sourceToAddress(offset)
  readVirtual(address, length)
}
```

Every mapped range MUST retain loader provenance.

## 6.6 Function seed contract

Function starts and extents are separate facts.

```ts
FunctionSeed {
  address
  sourceKind
  confidence
  exactStart
  extent?        // optional
  extentConfidence?
  evidenceIds
}
```

Sources MAY include:

- symbols;
- unwind metadata;
- format function-start tables;
- exports;
- entrypoints;
- relocation/call targets;
- validated prologue heuristics;
- debug information;
- runtime observations.

Heuristics MUST NOT silently become exact boundaries.

## 6.7 Native format priorities

### Mach-O

Required mature semantics include:

- FAT/universal containers;
- segments/sections and VA mapping;
- classic dyld binds/rebases;
- chained fixups;
- exports trie;
- function starts;
- unwind information;
- Objective-C/Swift metadata;
- code-signature metadata and patch implications.

### ELF

Required mature semantics include:

- program-header mapping;
- sectionless operation;
- dynamic linking;
- PLT/GOT;
- REL/RELA/RELR;
- symbol versions;
- GNU/SysV hashes;
- unwind/DWARF references;
- stripped function recovery.

### PE/PE+

Required mature semantics include:

- imports and delay imports;
- exports;
- base relocations;
- exception/unwind data;
- TLS;
- CodeView/PDB references;
- Authenticode implications.

## 6.8 Future format families

After native foundations stabilize:

1. archives / COFF / XCOFF;
2. WASM;
3. DEX/APK/AAB;
4. JVM class/JAR;
5. CLR/CIL;
6. UEFI/TE;
7. OAT/VDEX/ART;
8. firmware/raw images;
9. additional kernel/container formats.


## 6.9 Typed data interpretation / Pattern Engine

Hex SHALL eventually provide a safe declarative data-description layer for structures that are better understood as typed bytes than executable code.

The Pattern Engine operates on `ByteSource` and produces typed data entities with provenance.

Required language concepts SHOULD include:

- primitive integer/float/string types with explicit endian;
- structs/unions/enums/bitfields;
- arrays and bounded dynamic arrays;
- pointers/offset references;
- conditional fields;
- named constants;
- reusable modules;
- lazy evaluation;
- visual annotations/bookmarks;
- format-specific helper functions through allowlisted pure intrinsics.

Security rules:

- no arbitrary network;
- no arbitrary filesystem access;
- no host `eval`;
- bounded recursion;
- bounded allocation/read budgets;
- cancellation;
- every produced field retains source byte ranges.

Pattern results MAY contribute type/data evidence. They MUST NOT bypass loader/semantic truth for executable behavior.

---

# 7. Architecture, ABI, platform, and language boundaries

## 7.1 ArchitecturePlugin v2

```ts
interface ArchitecturePlugin {
  id
  semanticVersion
  modes()
  registerFile()
  physicalAddressSpaces()
  decode(bytes, address, mode, options): DecodedInstruction
  liftExact(decoded, context): MachineEffectBundle
  classifyControlFlow(decoded): ControlFlowClass
  assemble?(textOrAst, address, mode): AssembledInstruction
  validateEncoding?(decoded): ValidationResult
}
```

The architecture owns:

- instruction encoding/decoding;
- register semantics;
- exact instruction side effects;
- flag semantics;
- atomics/exclusive behavior;
- architecture-defined exceptions/traps;
- architecture-specific pointer-authentication or mode behavior.

It does not own calling-convention argument classification.

## 7.2 ABIPlugin

```ts
interface ABIPlugin {
  id
  architectureId
  platformPredicate
  callingConventions()
  classifyArguments(signature?, callSite?)
  classifyReturn(type?, callSite?)
  callerSaved()
  calleeSaved()
  stackRules()
  redZone()
  syscallABI?()
  unwindRules()
  defaultUnknownCallEffects()
}
```

Required first-class ABI targets:

- AAPCS64;
- Darwin arm64/arm64e refinements;
- SysV AMD64;
- Microsoft x64;
- RISC-V ELF psABI;
- later AAPCS32 and x86-32 convention families.

## 7.3 PlatformProfile

Platform profiles provide OS/executable-environment knowledge that is neither ISA nor source-language semantics.

Examples:

- Darwin;
- Linux;
- Windows;
- bare metal;
- Android;
- UEFI.

They may identify default ABIs, runtime libraries, loader conventions, syscall families, and debug-info ecosystems.

## 7.4 LanguageRuntimeProvider

Source-language/runtime recovery is separate:

- Objective-C;
- Swift;
- C++ Itanium;
- C++ MSVC;
- Rust;
- Go;
- Java/Dex;
- CLR/.NET.

The provider may create type constraints, runtime metadata facts, dispatch candidates, demangled names, vtable/witness information, closure/state-machine hints, and language-level semantic facts.

It MUST NOT replace exact low-level semantics.

---

# 8. Low-Level Effects: native and VM

The target architecture SHALL use one common low-level effect contract with domain-specific variants.

```text
LowLevelEffects
 ├─ MachineEffects  — native CPU instructions
 └─ VMEffects       — DEX/CIL/JVM/WASM-style execution operations
```

This avoids forcing managed code into fake native registers while preserving one downstream semantic architecture.

## 8.1 MachineEffectBundle

Each decoded instruction lowers to zero or more explicit operations.

```ts
MachineEffectBundle {
  instructionId
  architectureId
  mode
  operations
  controlEffect
  possibleFaults
  origin
  completeness
}
```

`completeness` is one of:

```text
exact
exact-with-intrinsic
partial
unknown
```

A partial bundle MUST enumerate what is unknown.

## 8.2 Machine value system

The low-level layer SHALL support:

- bitvectors with exact width;
- IEEE floating values/operations where architecture semantics are represented;
- fixed vectors;
- scalable-vector intrinsics where required;
- predicates/masks;
- explicit register state;
- physical memory address spaces;
- temporaries;
- condition/flag values.

Widths are semantic, not decoration.

## 8.3 Physical address spaces vs analysis regions

Do not conflate these.

Physical/low-level spaces:

```text
register
memory
code
tls       // where architecture/platform makes this meaningful
io
unique/temp
```

Analysis alias regions are introduced later:

```text
stack
global
object-root
allocation-root
tls-root
unknown
```

## 8.4 Flags

Flags MUST be explicit values/effects.

ARM NZCV, x86 CF/ZF/SF/OF/PF/AF, and architectures without a flags register MUST all fit the same middle-end.

A consumer MUST NOT need to reinterpret an instruction mnemonic to recover flag meaning.

## 8.5 Memory effects

A memory operation MUST carry:

```ts
MemoryAccess {
  space
  addressExpr
  widthBits
  alignment?
  endian
  volatility?
  atomic?
  ordering?
}
```

## 8.6 Calls and returns

At MachineEffects level, a call is primarily a control-transfer effect plus exact architectural effects.

ABI argument/return/clobber semantics are added by ABI analysis.

This prevents machine semantics from embedding AAPCS64/x86 conventions.

## 8.7 Intrinsics

An intrinsic MAY represent an operation that is not practical to expand into primitives.

Every intrinsic MUST declare an effect summary:

- inputs;
- outputs;
- registers affected;
- memory read/write scope;
- control effects;
- determinism;
- whether detailed semantics are available to symbolic execution.

An opaque intrinsic without effect summary is equivalent to an unknown clobber.

## 8.8 arm64e

PAC/AUT/XPAC and related arm64e behavior SHALL be modeled as explicit semantics or effect-summarized intrinsics.

They MUST NOT be dropped simply because the resulting pointer often looks like a normal pointer after authentication.

## 8.9 VMEffects

DEX/CIL/JVM/WASM frontends MAY produce VMEffects that preserve:

- VM registers or operand stack;
- typed locals;
- exception semantics;
- method/function references;
- metadata tokens;
- managed heap references;
- verifier types.

They SHALL lower into shared Semantic IR without pretending that VM locals are CPU registers.

---

# 9. Semantic IR v2

Semantic IR is the architecture-neutral analysis representation.

It is derived from Low-Level Effects. It is not allowed to invent semantics missing from Low-Level Effects.

## 9.1 Core requirements

Semantic IR MUST be:

- architecture-neutral;
- width-aware;
- explicit about unknowns;
- suitable for SSA;
- suitable for Memory SSA;
- suitable for symbolic translation;
- provenance-preserving;
- serializable/versioned as an analysis artifact;
- independent from UI text.

## 9.2 Core operation families

At minimum:

```text
const
copy
cast / trunc / zext / sext / bitcast
binary arithmetic
unary arithmetic
bit extract / insert / concat
compare
select
address
load
store
call
return
branch
conditional branch
switch
phi
memory-phi / memory-def / clobber
intrinsic
trap / throw
unknown
```

Vector/atomic/exception operations MAY remain explicit intrinsics until common normalized forms are justified.

## 9.3 Semantic values

```ts
SemanticValue {
  id
  machineType
  recoveredTypeRef?
  provenance
  constant?
  range?
  signedness?
  nullability?
}
```

`machineType` is hard low-level information. `recoveredTypeRef` is a higher-level hypothesis.

## 9.4 Calls

Semantic calls SHALL include:

```ts
CallSite {
  targetSet
  targetConfidence
  callingConvention
  arguments
  returns
  callerClobbers
  memoryEffects
  noreturn
  mayThrow
  summarySource
}
```

Unknown calls use conservative ABI defaults.

## 9.5 Semantic versioning

Every artifact derived from Semantic IR SHALL include:

```text
semanticSchemaVersion
architectureSemanticVersion
abiSemanticVersion
passVersion(s)
```

Changing semantics invalidates dependent artifacts by key, not by manually clearing arbitrary caches.


## 9.6 Shared dataflow framework

Dataflow analyses SHALL run over Semantic IR/SSA rather than decoding architecture text again.

Core reusable domains SHOULD include:

```text
constant lattice
integer range / wrapped interval
value-set candidates
signedness
nullability
liveness
reaching definitions
pointer provenance
taint/source labels
escape state
```

A domain must define:

- lattice/state representation;
- transfer function;
- merge/join;
- widening when required;
- completeness/unknown behavior;
- proof/evidence extraction.

Analyses MAY be demand-driven or whole-function, but a consumer must be able to ask why a result holds.

### Taint

Taint is an evidence-bearing dataflow label, not an automatic vulnerability claim.

Sources/sinks/sanitizers are provider-defined facts. Taint results retain the exact def-use/memory path that produced them.

---

# 10. CFG and control-flow model

## 10.1 CFG stages

Hex SHALL distinguish:

1. decoded control-flow evidence;
2. recovered basic-block graph;
3. exceptional edges;
4. indirect-target candidates;
5. structured high-level regions.

## 10.2 Edge kinds

At minimum:

```text
fallthrough
branch
conditional-true
conditional-false
switch-case
call
tail-call
return
exception
indirect-candidate
unknown
```

Each edge carries origin and confidence when not exact.

## 10.3 Indirect control flow

Indirect branch/call recovery SHOULD combine:

- local value analysis;
- jump-table analysis;
- relocation information;
- type/runtime metadata;
- signature/library knowledge;
- runtime trace evidence.

A candidate target set MUST expose uncertainty.

## 10.4 Function extents

Shared epilogues, tail calls, thunks, overlapping code, exception pads, and unusual compiler layouts MUST NOT be forced into a simplistic contiguous-function assumption.

Function identity and code regions SHALL be related but separable concepts.

---

# 11. Scalar SSA

SSA SHALL be a generic pass over Semantic IR.

It MUST NOT contain architecture register naming rules such as `x0..x7` or `v0..v7`.

Architecture entry state is mapped into semantic variables by the target/ABI boundary before SSA.

## 11.1 Requirements

- dominance-based construction;
- explicit phi nodes;
- stable value IDs;
- def-use and use-def indexes;
- incremental invalidation per function/artifact;
- unreachable blocks represented explicitly;
- no silent value invention at undefined reads.

## 11.2 Entry values

Entry values have explicit categories:

```text
argument
incoming-register-state
global-state
runtime-bound-value
undefined
unknown
```

The ABI layer may classify some entry values as arguments.

---

# 12. Memory SSA

Memory SSA SHALL evolve from the current conservative design into a region-aware model.

## 12.1 Region tokens

Initial regions:

```text
StackRegion(function/frame)
GlobalRegion(image/module)
ObjectRegion(root identity)
AllocationRegion(site/summary)
TLSRegion(module/thread model)
UnknownRegion
```

A region MAY later be subdivided by field/interval when proven safe.

## 12.2 Memory versions

```text
M(region, version)
```

Loads consume a memory version.

Stores produce a memory version.

Merges create memory phi nodes.

## 12.3 Unknown stores

An unknown pointer store MUST clobber every region it may alias.

If region precision is insufficient, the safe result is broad clobbering.

It is never valid to preserve a reaching-store proof merely because doing so produces cleaner pseudocode.

## 12.4 Call effects

Calls consume and produce memory tokens based on:

1. known function summaries;
2. known imported/library models;
3. ABI/runtime rules;
4. conservative unknown-call fallback.

## 12.5 Memory proof API

Consumers SHALL query:

```ts
reachingMemoryDef(load)
memoryEffects(call)
explainMemoryPath(source, sink)
```

rather than reimplementing alias logic.

---

# 13. Alias, pointer provenance, and points-to analysis

The alias system SHALL be tiered and demand-driven.

## 13.1 AliasResult

```ts
AliasResult {
  relation: "must" | "may" | "no" | "unknown"
  reasonCodes
  evidenceIds
  analysisLevel
}
```

For optimization safety, `may` and `unknown` both block transformations that require `NoAlias`.

## 13.2 Analysis levels

### A0 — local provenance

Current-style root + constant offset, stack/global identification, exact interval disjointness.

### A1 — region analysis

Stack, global, object, allocation, TLS, unknown region partitioning.

### A2 — field-sensitive points-to

Object/allocation roots, field intervals, pointer copies, address arithmetic, phi merges.

### A3 — escape and interprocedural summaries

Arguments, returns, globals, captured closures, indirect calls, allocation escape.

### A4 — targeted context sensitivity

Used only for active questions/functions when necessary.

Hex SHOULD NOT run an expensive fully context-sensitive whole-program points-to solver on every open.

## 13.3 Proof discipline

A `NoAlias` result requires a proof reason.

Examples:

- disjoint fixed stack intervals;
- distinct proven non-escaping allocations;
- distinct address spaces;
- non-overlapping absolute globals;
- incompatible region roots with proven separation.

Absence of evidence is not a proof.

---

# 14. Interprocedural analysis and function summaries

Every analyzed function SHOULD produce a versioned summary.

```ts
FunctionSummary {
  functionId
  inputs
  returnValues
  registerEffects
  memoryReadRegions
  memoryWriteRegions
  escapes
  allocations
  frees
  directCalls
  indirectCallSets
  noreturn
  mayThrow
  stackDelta
  semanticFacts
  completeness
}
```

## 14.1 Summary construction

- build local summary;
- solve recursive SCCs to a fixed point;
- widen when needed to guarantee termination;
- use imported/library models when available;
- retain unknown effects explicitly.

## 14.2 Library semantic models

Hex SHOULD support reusable models for common runtimes and libraries.

A library model MUST be versioned and identify its source.

It MUST NOT override contradictory binary evidence.

---

# 15. Type system

The final type system SHALL separate low-level facts from recovered hypotheses.

## 15.1 Four layers

```text
MachineType
  exact width/vector/float/bit representation

ABIType
  argument/return classification and aggregate passing shape

RecoveredStructuralType
  pointer/array/struct/union/function/field layout candidates

NominalLanguageType
  ObjC/Swift/C++/Rust/Go/.NET/Java names and runtime identities
```

## 15.2 TypeConstraintGraph

Type recovery SHALL be a constraint problem plus weighted evidence.

### Hard constraints

Examples:

- load/store width;
- ABI argument location;
- exact debug-info type;
- verified runtime metadata;
- pointer arithmetic width/stride;
- call prototype constraints when authoritative.

### Soft evidence

Examples:

- selector naming;
- symbol spelling;
- runtime-library patterns;
- decompiler use shape;
- inferred array stride;
- signature database candidate.

## 15.3 Contradictions

A contradiction MUST produce ambiguity/conflict state.

Hex MUST NOT force the highest-scoring candidate into certainty.

## 15.4 Type result

```ts
TypeResult {
  candidates
  selected?
  hardConstraints
  softEvidence
  contradictions
  confidence
  origin
}
```


## 15.5 DebugInfoProvider

DWARF, PDB/CodeView, dSYM, and future debug formats SHALL enter through a common provider contract.

```ts
interface DebugInfoProvider {
  probe(image, refs)
  symbols(scope, page)
  types(scope, page)
  lines(scope, page)
  inlineFrames(scope, page)
  unwindInfo?(scope)
}
```

Authoritative debug information is strong evidence but still tied to a specific binary/build identity.

Debug data MUST NOT be applied across a different build solely because a filename matches.

## 15.6 Type packages

Hex SHOULD support reusable, versioned type packages analogous in role to mature type-library ecosystems.

A package contains:

- target/platform constraints;
- type declarations;
- function prototypes;
- constants/enums;
- source/license/provenance;
- package version.

Type packages suggest/apply constraints through the Type System; they do not mutate Semantic IR directly.

---

# 16. Function discovery

Function discovery SHALL be a first-class analysis, not a side effect of disassembly.

## 16.1 Evidence sources

- loader function starts;
- unwind tables;
- symbols/debug info;
- exports/entrypoints;
- direct calls;
- relocation targets;
- vtables/witness tables;
- exception metadata;
- compiler/runtime tables;
- validated prologue/epilogue heuristics;
- runtime traces.

## 16.2 Start vs extent

Start precision/recall and extent precision/recall are separate metrics.

A reliable start with unknown extent is valid.

## 16.3 FunctionCandidate

```ts
FunctionCandidate {
  start
  regions
  startEvidence
  extentEvidence
  confidence
  conflicts
  state: exact | probable | heuristic | contradicted
}
```

---

# 17. Recognition, signatures, knowledge, diff, and capabilities

## 17.1 Function recognition tiers

Hex SHALL use staged identity:

```text
Tier 0 — exact content/debug identity
Tier 1 — relocation-normalized identity
Tier 2 — structural features
Tier 3 — normalized Semantic IR/dataflow
Tier 4 — high-level semantic/capability/type-use similarity
```

No single fuzzy score is authoritative.

## 17.2 MatchResult

```ts
MatchResult {
  sourceFunctionId
  targetFunctionId
  tier
  score
  confidence
  ambiguityMargin
  featuresUsed
  conflictingFeatures
  algorithmVersion
  evidenceIds
}
```

## 17.3 KnowledgeDB

Reusable knowledge may include:

- names;
- prototypes;
- types;
- library identities;
- roles;
- known semantic facts;
- signatures;
- source provenance.

Knowledge MAY suggest. It MUST NOT silently overwrite stronger local evidence.

## 17.4 CapabilityFact

Hex SHALL introduce deterministic capability inference above Semantic IR.

Example:

```text
Capability: modifies persistent currency
Evidence:
  same must-alias field read and written
  arithmetic increment
  upper-bound clamp
  caller linked to save/update path
```

Every match MUST retain constituent evidence IDs.

AI may explain a capability. AI must not create the verified capability match.

---

# 18. Decompiler architecture

Decompiler quality is a core product feature, but semantics preservation outranks prettiness.

## 18.1 Pipeline

```text
Semantic IR
  ↓
SSA / MemorySSA
  ↓
local dataflow + interprocedural summaries
  ↓
type constraints + variable recovery
  ↓
HighIR
  ↓
expression canonicalization
  ↓
control-flow structuring
  ↓
language/runtime idiom recovery
  ↓
Structured AST
  ↓
pretty printer
```

## 18.2 Mandatory middle-end passes

The mature pipeline SHOULD contain:

- sparse conditional constant propagation;
- copy propagation;
- effect-aware dead-code elimination;
- GVN/CSE;
- constant/range/value-set reasoning;
- load/store forwarding only with alias proof;
- pointer/address normalization;
- induction-variable analysis;
- loop simplification;
- switch recovery;
- prototype recovery;
- aggregate/array/union layout recovery;
- stack/register variable coalescing;
- tail-call and thunk normalization;
- exception-aware analysis.

## 18.3 Structuring

Control-flow structuring SHALL support:

- dominance/post-dominance;
- natural loops;
- SESE regions;
- if/else;
- switch;
- break/continue;
- irreducible SCCs;
- controlled node splitting where safe;
- state-machine/flattening recovery;
- explicit goto fallback.

Hex MUST NOT remove a goto if doing so changes semantics.

## 18.4 Decompiler pass contract

A semantics-changing transform is forbidden.

A rewrite result SHALL carry:

```ts
TransformResult {
  replacement
  consumedNodeIds
  producedNodeIds
  preconditions
  proofKind
  originUnion
  confidence
}
```

## 18.5 Architecture-specific idioms

Architecture/compiler idiom passes MAY exist, but they operate after exact semantics and MUST NOT become the only path to basic meaning.

ARM64/Clang idioms therefore become optional refinement passes, not semantic foundations.

## 18.6 Language-aware output

Language providers MAY improve:

- ObjC messaging/properties;
- Swift methods, closures, witness tables, async state machines;
- C++ classes/vtables/EH;
- Rust enums/traits/panics/async;
- Go interfaces/goroutines/runtime helpers.

The default text output remains a stable C-like pseudocode unless a language-specific renderer has enough evidence.

---

# 19. Managed and VM frontends

Managed formats MUST NOT be treated as malformed native binaries.

## 19.1 DEX

Preserve:

- method/field/type descriptors;
- DEX registers;
- exception regions;
- verifier/type information;
- annotations;
- JNI/native links.

## 19.2 CLR/CIL

Preserve:

- metadata tokens;
- nominal types;
- generics;
- signatures;
- CIL operand stack;
- exception regions;
- PDB references.

## 19.3 JVM

Preserve:

- classfile constant pool;
- verifier types;
- operand stack/locals;
- exceptions;
- annotations/generic metadata.

## 19.4 WASM

Preserve:

- function/type tables;
- structured control flow;
- linear memory;
- tables;
- imports/exports;
- source/DWARF mappings.

These frontends produce `VMEffects` and then shared Semantic IR/HighIR where semantically valid.

---

# 20. Symbolic reasoning

Hex SHALL keep two symbolic tiers.

## 20.1 FastSymbolicEvaluator

The current bounded executor evolves into a fast, deterministic evaluator for:

- small local paths;
- expression recovery;
- constant/condition reasoning;
- simple what-if questions;
- cheap verification.

Unsupported operations return explicit unknown.

## 20.2 Solver-backed engine

```text
Semantic IR
   ↓
SymbolicTranslator
   ↓
solver-neutral expression DAG
   ↓
SolverBackend
   ├─ Z3 adapter
   ├─ Bitwuzla adapter
   └─ future backend
```

## 20.3 SymbolicState

```ts
SymbolicState {
  values
  memoryRegions
  constraints
  path
  callStack
  sideEffects
  assumptions
  completeness
}
```

## 20.4 Use policy

SMT SHOULD be targeted, not a default whole-binary background job.

Priority queries:

- branch reachability;
- value bounds;
- patch invariant checking;
- equivalence of bounded rewrites;
- alias disambiguation when representable;
- decompiler transform verification;
- concolic path extension.

State explosion MUST be controlled by budgets, merge policies, loop bounds, and query-specific slicing.

---

# 21. Runtime, debugger, instrumentation, emulation, and traces

The current adapter direction SHALL be retained and generalized.

```text
RuntimeProvider
 ├─ DebuggerProvider
 ├─ InstrumentationProvider
 ├─ EmulatorProvider
 └─ TraceProvider
```

A single provider MAY implement multiple facets.

## 21.1 RuntimeSession identity

Every runtime session MUST bind to:

- provider;
- target identity;
- binary hash when available;
- architecture/platform;
- process/session ID;
- start time;
- runtime capabilities.

Cross-binary replay requires explicit re-resolution and confidence gates.

## 21.2 DebuggerProvider

Core operations:

- launch/attach;
- pause/resume/step;
- breakpoints/watchpoints;
- threads/registers;
- memory read/write;
- modules;
- stack frames;
- remote transport.

The browser UI SHALL use a versioned provider protocol rather than direct OS debugger APIs.

## 21.3 InstrumentationProvider

Frida-style capabilities:

- intercept;
- replace/probe where allowed;
- trace blocks/calls;
- memory/process observation;
- runtime symbol/module queries.

Instrumentation output becomes RuntimeEvidence.

## 21.4 EmulatorProvider

The core owns the interface, not a specific third-party engine.

Optional providers may use Hex execution, Unicorn, Qiling, QEMU service, or future engines subject to license/deployment policy.

## 21.5 TraceProvider

Imported traces SHALL support:

- coverage;
- branch/call sequence;
- memory observations when available;
- thread/process identity;
- timestamp/order;
- source tool identity.

## 21.6 Runtime evidence

```ts
RuntimeEvidence {
  id
  binaryId
  runtimeSessionId
  experimentId?
  timestamp
  input
  observation
  path
  backend
  reproducibility
  confidence
  staticEntityLinks
}
```

---

# 22. Patching and binary rewriting

Patching SHALL be non-destructive and layered.

```text
Original Binary
   ↓
PatchSet
   ↓
Patched Projection
   ↓
Rebuild Plan
   ↓
Validation
   ↓
Export
```

## 22.1 Patch types

```text
BytePatch
InstructionPatch
DataPatch
SectionPatch
RelocationPatch
ImportPatch
CodeCavePatch
RebuildOperation
```

## 22.2 Patch preconditions

Every patch MUST include expected-original state.

This prevents applying an old patch to a different binary/version.

## 22.3 Validation

Validation SHALL include as applicable:

- decode validity;
- instruction alignment/length;
- branch range;
- CFG consequences;
- relocation correctness;
- section/segment permissions;
- unwind/exception metadata;
- import/export consistency;
- checksum/signature implications;
- Mach-O code signing;
- PE Authenticode;
- format rebuild integrity.

## 22.4 Semantic validation

Where possible, Hex SHOULD offer:

- local symbolic equivalence;
- bounded emulator comparison;
- runtime experiment;
- before/after decompiler diff.

A successful byte write is not sufficient to call a patch valid.

---

# 23. ArtifactStore and ProjectStore

Derived analysis and user work SHALL use separate persistence.

## 23.1 ArtifactStore

Artifacts are disposable and reproducible.

Canonical key:

```text
ArtifactKey =
  BinaryId
+ SliceId
+ loaderVersion
+ architectureSemanticVersion
+ abiSemanticVersion
+ semanticSchemaVersion
+ entityIdentity
+ passId
+ passVersion
+ optionsHash
```

Examples:

- BinaryImage metadata;
- function candidates;
- decoded blocks;
- Low-Level Effects;
- Semantic IR;
- CFG;
- SSA;
- MemorySSA;
- type constraints;
- decompiler AST;
- signatures/fingerprints;
- search indexes.

## 23.2 Storage backend

Browser priority:

```text
OPFS        large binary/cache blobs where available
IndexedDB   metadata/indexes/project facts
memory LRU  hot working set
```

Fallbacks MUST exist where OPFS is unavailable.

## 23.3 ProjectStore

User/project facts:

```text
BinaryIdentity
Names
Comments
Types
Structs
Bookmarks
PatchSets
Confirmations
Rejected hypotheses
Pinned evidence
Investigation sessions
Navigation state
Settings
ChangeLog
```

## 23.4 `.hexproj`

`.hexproj` remains the portable exchange/export format.

The current v1 JSON format remains supported.

The scalable local database MUST NOT require embedding all analysis artifacts into `.hexproj`.

A future v2 may add structured manifests/change history, but MUST provide a v1 migration path and MUST NOT embed the analyzed binary by default.

## 23.5 Collaboration

When collaboration is added:

- merge user facts;
- do not merge opaque analysis caches;
- preserve semantic conflicts;
- never silently resolve competing names/types when both are meaningful analyst decisions.

---

# 24. Scheduling and performance architecture

The scheduler SHALL be demand-driven.

## 24.1 Priority classes

```text
P0  current visible address/function and direct user command
P1  dependencies required for the active question
P2  nearby callers/callees / selected neighborhood
P3  discovery frontier and search indexes
P4  global signature/type/knowledge refinement
P5  optional expensive whole-binary work
```

A lower-priority task MUST yield to direct user work.

## 24.2 Analysis DAG

Every analysis task SHALL declare:

```ts
Task {
  inputs
  outputs
  costClass
  memoryEstimate
  priority
  cancellable
  cachePolicy
  version
}
```

Scheduling works on artifact dependencies rather than arbitrary function calls.

## 24.3 Large-binary rules

For 100 MB–1 GB+ inputs:

- never require one whole-file `ArrayBuffer`;
- page binary reads;
- page metadata;
- page search results;
- use virtualized UI lists;
- avoid one JS object per instruction for entire-binary resident state;
- prefer compact typed/columnar representations for large indexes;
- persist cold artifacts;
- analyze functions on demand;
- incrementally discover/index in background.

## 24.4 Browser workers

Recommended topology:

```text
UI/Main Thread
   │
   ├─ Loader worker
   ├─ Analysis worker pool
   ├─ Optional decoder/WASM workers
   └─ Plugin workers
        │
        └─ ArtifactStore / ByteSource broker
```

Workers MUST exchange stable IDs and bounded transferable data, not giant mutable object graphs.

## 24.5 SharedArrayBuffer

SharedArrayBuffer/WASM threads MAY accelerate supported deployments.

They MUST NOT be a correctness requirement.

Hex must retain a non-cross-origin-isolated fallback.

## 24.6 ComputeProvider

Expensive analysis MAY execute locally or through an optional compute provider.

```ts
interface ComputeProvider {
  capabilities()
  run(taskDescriptor, inputArtifacts, options)
  cancel(taskId)
}
```

Provider results MUST obey the same artifact schemas, semantic versions, provenance, and evidence contracts as local results.

Remote computation MUST NOT become a second semantic implementation with incompatible output.

Uploading binary bytes to a remote provider requires an explicit product/privacy policy and user authorization appropriate to that feature.

## 24.7 Performance KPI

Primary browser/iPad KPI:

**Time To First Useful Answer (TTFUA)**

Also track:

- cold open;
- first code view;
- active function analysis latency;
- decompiler latency;
- search latency;
- warm reopen;
- peak working set;
- cache footprint;
- cancellation latency;
- UI p95/p99 interaction latency;
- whole-binary background completion separately.

---

# 25. Adaptive ResourceBudgetManager

Hard-coded limits are necessary for safety but SHOULD be coordinated by one resource-budget service.

```ts
ResourceBudget {
  binaryReadBytes
  residentAnalysisBytes
  artifactCacheBytes
  parserObjects
  decodedInstructions
  activeFunctions
  symbolicStates
  pluginReadBytes
  pluginCpuMs
  aiContextBytes
  runtimeTraceEvents
}
```

Budgets may adapt to environment capability but MUST preserve correctness by returning deferred/partial/unknown states instead of unsound shortcuts.

---

# 26. Plugin API v2

The current snapshot/budget/failure-isolation behavior is retained.

## 26.1 Contribution taxonomy

Final first-class contribution types:

```text
LoaderPlugin
ArchitecturePlugin
ABIPlugin
AnalyzerPlugin
DecompilerPassPlugin
TypeProviderPlugin
RuntimeMetadataPlugin
DebuggerPlugin
InstrumentationPlugin
EmulatorPlugin
TracePlugin
SymbolicSolverPlugin
SignaturePlugin
RecognitionPlugin
DiffFeaturePlugin
KnowledgeProviderPlugin
CapabilityRulePlugin
ViewPlugin
AIToolPlugin
ExporterPlugin
```

## 26.2 Manifest

```ts
PluginManifest {
  id
  name
  version
  apiVersion
  contributionTypes
  permissions
  supportedTargets
  dependencyConstraints
  integrity?
}
```

## 26.3 Trust levels

### Built-in trusted

May run in first-party workers with declared internal capabilities.

### Third-party isolated

MUST run outside the UI main thread.

Default permissions:

- no DOM;
- no arbitrary network;
- no unrestricted binary reads;
- no project mutation;
- no runtime control.

Capabilities are granted explicitly.

## 26.4 Binary reads

Plugins receive bounded read capabilities, not the raw file object.

## 26.5 Mutable analysis internals

Plugins MUST NOT receive mutable pointers/references to internal AST, IR, or project objects.

They receive immutable snapshots/handles and submit structured requests/results.

## 26.6 Decompiler pass plugin

A plugin pass receives versioned nodes and returns rewrite proposals with proof/provenance metadata.

## 26.7 API compatibility

Plugin APIs SHALL use semantic versioning plus capability negotiation.

Breaking plugin changes require migration tooling/documentation.

---

# 27. AI architecture

The existing AI trust boundary is a strong foundation and SHALL remain.

## 27.1 Role

AI is an investigation interface over deterministic Hex capabilities.

```text
User goal
  ↓
AI planner
  ↓ typed request
Hex Tool Registry
  ↓
AnalysisSnapshot
  ↓
deterministic result/evidence
  ↓
AI explanation
```

## 27.2 Required tools

The mature tool plane SHOULD include:

```text
find_function
search_strings
search_semantic
function_context
callers
callees
xrefs
decompile
cfg
explain_value
slice_backward
slice_forward
causal_path
prove_alias
explain_type
field_reads
field_writes
compare_functions
knowledge_lookup
capability_search
verify_hypothesis
symbolic_query
runtime_observations
validate_patch
```

## 27.3 Claim schema

AI conclusions SHALL be structured:

```ts
Claim {
  text
  semanticKind
  confidence
  evidenceIds
  contradictingEvidenceIds
  assumptions
  unknowns
  verificationOptions
  targetEntityIds
}
```

## 27.4 Verified status

The model cannot mint `verified`.

Verified status requires deterministic verifier evidence or explicit user confirmation.

## 27.5 Mutation policy

AI read/query tools are callable.

Rename/comment/type/patch/project mutations are proposals.

A proposal requires:

- target;
- before fingerprint;
- requested change;
- supporting evidence;
- explicit approval token.

Direct user actions outside the model do not need an extra model-specific approval layer.

## 27.6 Prompt-injection boundary

Strings, symbols, comments, debug names, disassembly, pseudocode, and embedded text from a binary are untrusted data.

They MUST NOT become system/developer instructions.

## 27.7 Inference privacy policy

Hex SHALL support an explicit inference-boundary policy.

Suggested modes:

```text
local-only
metadata-only
selected-excerpts
provider-default-approved
```

Default remote operation MUST NOT upload the complete binary.

Raw binary bytes should remain local unless a future explicit feature receives clear user authorization.

## 27.8 Activity visibility

UI may show:

- tool name;
- target;
- progress phase;
- candidate count;
- evidence produced;
- time/cost.

It MUST NOT expose hidden model chain-of-thought.

---

# 28. UI and interaction architecture

## 28.1 Core product order

Hex presents information as:

**Question → Answer → Evidence → Detail**

But the canonical default route is **Code**.

Reason: Hex is an analysis editor. Opening a file should immediately show useful code, while investigation and AI remain one action away.

## 28.2 Top-level navigation

Exactly four primary destinations:

1. Investigate
2. Code
3. Explorer
4. Results

Advanced, Settings, Learn, Help remain secondary.

## 28.3 No-file state

`/code` with no file shows the open/sample entry state.

It does not redirect to a separate onboarding application.

## 28.4 File-open state

After open, Hex goes directly to code at the best initial address:

1. prior project navigation if valid;
2. selected function/entry state;
3. primary entrypoint;
4. first high-confidence executable function;
5. first executable region.

## 28.5 Function Workspace

One function, one workspace:

- Overview
- Pseudocode
- Flow
- Calls
- Evidence
- Runtime

Expert low-level detail is accessible inside the same identity.

## 28.6 Causal Path UI

This is a flagship Hex capability.

For a selected value/claim:

```text
result
  ← arithmetic
     ← prior field load
        ← MemorySSA version
           ← reaching store
              ← caller argument
                 ← caller
```

Every edge is clickable into the exact underlying semantic entity/instruction/byte.

## 28.7 Evidence states

Canonical states:

```text
Confirmed
Likely
Unverified
Contradicted
Unknown
```

A ranking score is not an evidence state.

## 28.8 Beginner projection

Beginner mode prefers:

- what does this do?
- why?
- where is it?
- what does it change?
- who calls it?
- what happens if this condition changes?
- how sure are we?

Terms such as SSA/MemorySSA remain behind explanation/detail.

## 28.9 Expert projection

Expert mode exposes:

- bytes/disassembly;
- Low-Level Effects;
- Semantic IR;
- SSA;
- MemorySSA;
- alias proof;
- dominators/postdominators;
- CFG/call graph;
- type constraints;
- function summaries;
- decompiler transforms;
- symbolic constraints;
- runtime traces.

## 28.10 Responsive behavior

Maintain mobile/iPad-first rules:

- 44 px minimum touch targets;
- safe-area support;
- dynamic viewport units;
- `visualViewport` keyboard handling;
- virtualized code and large lists;
- no body horizontal scrolling;
- code-local horizontal scrolling only where needed;
- graph text alternative;
- route state independent of retained DOM.

---

# 29. Search architecture

Search SHALL be multi-index but one user concept.

## 29.1 Index families

- symbol/name;
- string;
- address;
- type/class;
- imported/external API;
- semantic facts;
- capabilities;
- decompiler tokens;
- function fingerprints;
- project annotations.

## 29.2 Query planner

The query planner SHOULD choose cheap indexes first and escalate only when needed.

A user query must not trigger whole-binary decompilation by default.

## 29.3 Search result

Every result includes:

- entity ID;
- reason matched;
- score components when ranked;
- analysis completeness;
- evidence/origin;
- navigation action.

---

# 30. Security architecture

Every binary is hostile input.

## 30.1 Parser safety

- bounded reads;
- checked arithmetic;
- bounded allocation;
- maximum collection counts;
- nesting depth limits;
- decompression limits;
- cancellation;
- fail closed on malformed ranges.

## 30.2 Worker isolation

Expensive/untrusted parsing, analysis, and plugins SHOULD run outside the main UI thread.

## 30.3 Project import

Project import MUST validate:

- size;
- schema version;
- BigInt representation;
- collection bounds;
- embedded-binary policy;
- unexpected object shapes.

Import failure MUST NOT partially mutate current project state.

## 30.4 Runtime transports

Remote debugger/instrumentation providers MUST authenticate/authorize where the transport supports it.

A runtime session MUST be identity-bound before mutation.

## 30.5 Threat model

Hex SHALL explicitly defend against:

- intentionally malformed binaries;
- decompression/container bombs;
- adversarial symbol/string content;
- prompt injection embedded in analyzed data;
- malicious or buggy plugins;
- malicious project files;
- stale/cross-binary runtime sessions;
- compromised or replaced external WASM/assets;
- resource-exhaustion attacks through analysis requests;
- untrusted remote/provider output.

The threat model does not assume that an analyzed binary is cooperative.

## 30.6 Supply chain

External binaries/WASM/assets used by production builds SHOULD be:

- version pinned;
- integrity hashed;
- reproducibly obtained where feasible;
- license reviewed;
- covered by update policy.

## 30.7 Userscript/browser loader

The secure loader SHALL continue to verify expected assets and expose a recoverable error path without silently falling back to unverified code.

---

# 31. Error and uncertainty model

Hex SHALL use typed states, not generic failure strings.

Canonical categories:

```text
unsupported
unknown
partial
contradicted
invalid-input
resource-limit
cancelled
provider-failure
analysis-failure
schema-mismatch
identity-mismatch
permission-denied
```

Important distinction:

- `unsupported`: Hex does not implement the capability;
- `unknown`: capability exists but evidence is insufficient;
- `partial`: some exact facts exist and missing parts are listed;
- `analysis-failure`: implementation failed unexpectedly.

The UI and AI tools MUST preserve this distinction.

---

# 32. Capability maturity model

Every format/architecture/frontend capability SHALL be measured independently.

## 32.1 Architecture levels

```text
A0 Detect
A1 Decode
A2 Exact Low-Level Effects
A3 CFG + Semantic IR
A4 SSA + MemorySSA + dataflow
A5 Types + interprocedural analysis
A6 Decompiler
A7 Runtime/debug/patch validation
```

Example: current x86-64 is not “supported” at A6 merely because Capstone can decode it.

## 32.2 Format levels

```text
F0 Detect
F1 Parse structures
F2 Correct mapping
F3 imports/exports/relocations
F4 function/debug/unwind evidence
F5 runtime/language metadata
F6 validated rebuild/patch
```

## 32.3 Managed frontend levels

```text
M0 Detect/container
M1 metadata parse
M2 exact VMEffects
M3 CFG/SSA
M4 types/interprocedural
M5 decompiler
M6 runtime/debug integration
```

Support matrices SHALL report these levels explicitly.

---

# 33. Target support priorities

## 33.1 Native architectures

Priority order:

1. AArch64 — retain and harden.
2. arm64e — complete PAC semantics and Darwin behavior.
3. x86-64 — full semantics, SysV + Win64.
4. RISC-V64 — early clean-ISA validation target.
5. ARM32/Thumb.
6. x86-32.
7. MIPS.
8. PowerPC.
9. additional embedded/niche architectures based on demand.

RISC-V is intentionally early because it exposes hidden ARM assumptions.

## 33.2 Formats

1. Mach-O/ELF/PE parity and correctness.
2. archives/COFF where needed for tooling.
3. WASM.
4. DEX/APK/AAB.
5. CLR/CIL.
6. JVM.
7. UEFI/firmware families.

---

# 34. Target repository/module boundaries

This is the desired namespace structure, not a command to perform a mass rename immediately.

```text
js/
  core/
    identity/
    evidence/
    artifacts/
    scheduler/
    budgets/

  io/
    bytesource/
    containers/

  binary/
    model/
    loaders/
      macho/
      elf/
      pe/

  targets/
    architecture/
      arm64/
      x86_64/
      riscv64/
    abi/
      aapcs64/
      sysv-amd64/
      win64/
      riscv-psabi/
    platform/

  semantics/
    effects/
    ir/
    cfg/
    ssa/
    memoryssa/

  analysis/
    alias/
    dataflow/
    interproc/
    functions/
    types/
    variables/
    signatures/
    recognition/
    capabilities/
    diff/

  decompiler/
    highir/
    passes/
    structuring/
    idioms/
    render/

  managed/
    wasm/
    dex/
    jvm/
    cil/

  runtime/
    providers/
    sessions/
    evidence/
    protocols/

  symbolic/
    fast/
    expr/
    solver/
    executor/

  project/
    store/
    exchange/
    changelog/

  patch/
    model/
    rebuild/
    validate/

  plugins/
    api/
    sandbox/

  ai/
    tools/
    context/
    evidence/
    agent/
    providers/

  ui/
    routes/
    projections/
    components/
```

Existing paths MAY remain until a functional migration justifies movement. File churn without architectural value is prohibited.

---

# 35. Migration from the current implementation

Migration is dependency-driven.

## 35.1 Current-file migration map

The following map defines how the current baseline evolves. It is intentionally compatibility-first.

| Current path / subsystem | Target role | Migration rule |
|---|---|---|
| `js/architecture/index.js` | Architecture v1 compatibility facade | Keep public behavior while a v2 target registry is introduced behind it. Do not add more ABI logic here. |
| `js/ir-core.js` | Temporary mixed legacy core | Split ARM64 lifting into the ARM64 target, ABI classification into ABI modules, and SSA/MSSA into generic passes. Keep compatibility exports until downstream consumers migrate. |
| `js/ir.js` | Public semantic facade | Preserve as the compatibility/public boundary. Internally redirect queries to Semantic IR v2 artifacts. Its conservative unknown-store/alias behavior is the minimum safety floor. |
| `js/decompiler/pipeline-core.js` | High-level decompiler consumer | Preserve the rule that it consumes semantic analysis rather than re-decoding instructions. Move ARM64/Clang idioms into target/compiler-specific refinement providers. |
| `js/binary/*` | Universal native-loader foundation | Preserve and evolve. Introduce loader registry/contracts without replacing proven Mach-O/ELF/PE logic unnecessarily. |
| `js/platform/plugin-api.js` | Plugin API v1 | Keep as a compatibility shim while Plugin API v2 adds first-class ABI/decompiler/runtime/solver/export contributions. |
| `js/project/index.js` | `.hexproj` exchange format | Keep v1 import/export compatibility. Do not turn this JSON object into the scalable ArtifactStore. |
| `js/runtime/index.js` | Runtime orchestration | Preserve session/evidence concepts. Recast adapters as versioned RuntimeProvider facets. |
| `js/symbolic/executor.js` | FastSymbolicEvaluator | Preserve bounded conservative behavior. Add solver-backed symbolic execution beside it, not by making this fast path unbounded. |
| `js/runtime-evidence/*` | Runtime evidence producer | Integrate into the central EvidenceGraph without changing the static/runtime separation rule. |
| `js/ai/*` | Typed AI/control plane | Preserve deterministic tool execution, evidence stores, hypothesis validation, proposal approval, and untrusted-data boundaries. Move all analysis access toward `AnalysisQueryAPI`. |
| current worker/platform cache | Scheduler + ArtifactStore seed | Preserve source-backed paging and cancellation, then move derived products into versioned artifact storage. |
| current UI/router/docs | UI projection | Preserve four-destination information architecture, resolve default route as Code, and move data access to snapshots/query API. |

### Migration rule

No migration PR may both replace a core semantic representation and remove its compatibility oracle in the same step unless the replacement has already passed the complete required differential corpus.

## Phase 0 — Freeze the contracts

Deliver:

- this master specification;
- architecture capability maturity schema;
- stable identity/provenance schema;
- baseline benchmark artifacts;
- ADR process;
- explicit invariant regression tests.

Exit gate:

- current test suite green;
- current ARM64 real-binary gates green;
- baseline performance captured.

## Phase 1 — Architecture/ABI split

Deliver:

- `ArchitecturePlugin v2`;
- `ABIPlugin`;
- compatibility adapter for current `ArchitectureAdapter`;
- extract AAPCS64 call classification from generic IR core.

Exit gate:

- current ARM64 outputs unchanged on required fixtures;
- no generic semantic module imports ARM64 ABI constants.

## Phase 2 — Low-Level Effects

Deliver:

- `MachineEffectBundle`;
- ARM64 exact lifter;
- compatibility lowering from MachineEffects to current Semantic IR;
- flags and memory effects explicit;
- arm64e effect model for PAC-related instructions.

Exit gate:

- per-instruction differential/equivalence tests;
- unsupported instructions explicitly counted;
- zero silent-preserve fallbacks.

## Phase 3 — Semantic IR v2 + generic SSA/MemorySSA

Deliver:

- v2 schema;
- generic SSA;
- region-capable MemorySSA;
- current alias/provenance behavior preserved as minimum;
- v1 compatibility projection while downstream migration runs.

Exit gate:

- all current semantic/decompiler tests pass through compatibility path;
- unknown-store safety unchanged or stricter;
- no architecture names in generic SSA/MSSA code.

## Phase 4 — Artifact identity/store and scheduler

Deliver:

- ArtifactKey/CAS model;
- IndexedDB/OPFS persistence;
- analysis DAG scheduler;
- priority/cancellation;
- paged artifact APIs.

Exit gate:

- warm reopen reuses artifacts;
- invalidation is version-keyed;
- large-binary memory does not scale linearly with fully analyzed instruction count in the UI process.

## Phase 5 — x86-64 first-class semantics

Deliver:

- x86-64 exact effects;
- SysV AMD64 and Microsoft x64 ABI plugins;
- variable-length code viewer;
- x86 CFG/SSA/MSSA/decompiler path.

Exit gate:

- x86-64 reaches A6 for mandatory compiler corpus;
- semantic differential gate green;
- no ARM64-specific code in generic passes.

## Phase 6 — RISC-V64 validation architecture

Deliver:

- RV64 decoder/lifter integration;
- RISC-V psABI;
- ELF integration;
- end-to-end analysis/decompiler baseline.

Exit gate:

- generic core handles architecture without flags register;
- cross-architecture tests demonstrate same middle-end.

## Phase 7 — Industrial static-analysis depth

Deliver:

- alias A1/A2/A3;
- escape analysis;
- function summaries;
- hard type constraints;
- DWARF/PDB ingestion;
- cross-architecture function discovery.

Exit gate:

- measurable reduction in unknown memory links without unsound alias regressions;
- type accuracy benchmark improves without increasing false certainty.

## Phase 8 — Decompiler quality

Deliver:

- SCCP;
- GVN/CSE;
- effect-aware DCE;
- richer ranges/value sets;
- loop induction;
- irreducible/exception structuring;
- aggregate/array recovery;
- language pattern providers.

Exit gate:

- semantic regression zero on mandatory corpus;
- readability metrics improve;
- Ghidra differential diagnostics do not regress;
- provenance coverage remains complete.

## Phase 9 — Solver-backed verification

Deliver:

- solver-neutral DAG;
- first SolverBackend;
- targeted symbolic APIs;
- patch/branch/equivalence verification.

Exit gate:

- deterministic replayable solver tests;
- strict time/state budgets;
- unsupported semantics remain explicit.

## Phase 10 — Runtime providers

Deliver:

- mature debugger provider;
- Frida-compatible instrumentation provider;
- trace provider;
- emulator provider interface;
- remote protocol.

Exit gate:

- runtime evidence identity binding;
- static/runtime fusion tests;
- replay/cross-version ambiguity gates.

## Phase 11 — Managed frontends

Deliver in order:

- WASM;
- DEX;
- CLR/CIL;
- JVM.

Each frontend must reach VMEffects before shared decompiler claims are made.

## Phase 12 — Knowledge, collaboration, advanced rewrite

Deliver:

- scalable signature/knowledge packages;
- capability rule ecosystem;
- collaboration/change log;
- generalized relocation-aware rebuilding;
- declarative data-pattern language.

---

# 36. CI and benchmark architecture

Hex SHALL measure correctness before marketing labels.

## 36.1 Existing gates to preserve

Current categories already present in the repository SHALL remain protected:

- general checks;
- semantic regressions;
- decompiler regressions;
- compiler-truth tests;
- Ghidra differential;
- universal binary tests/gates/benchmark;
- cross-binary accuracy;
- runtime tests;
- AI boundary tests;
- UI/browser/mobile tests;
- sandbox/security tests.

## 36.2 Corpus matrix

Required long-term corpus dimensions:

```text
Architecture:
  AArch64
  x86-64
  RISC-V64
  later ARM32/x86-32/...

Formats:
  Mach-O
  ELF
  PE

Optimization:
  O0 O1 O2 O3 Os/Oz LTO

Languages:
  C C++ Objective-C Swift Rust Go

Compilers:
  Clang/LLVM GCC MSVC rustc Swift Go

Build truth:
  paired debug + stripped builds

Size:
  tiny → 1 MB → 10 MB → 100 MB → 500 MB → 1 GB+
```

## 36.3 Function discovery metrics

Track separately:

- start precision;
- start recall;
- extent precision;
- extent recall;
- false split;
- false merge.

## 36.4 CFG metrics

- block-boundary precision/recall;
- edge precision/recall;
- switch target correctness;
- indirect-target set quality;
- exception-edge correctness.

## 36.5 Low-Level Effects / IR correctness

Mandatory strategy:

1. concrete execution equivalence where practical;
2. independent semantic differential oracles;
3. generated instruction/property tests;
4. SMT equivalence for representable subsets;
5. regression corpus for every discovered semantic bug.

A known semantic mismatch is a correctness bug, not a readability tradeoff.

## 36.6 Decompiler metrics

Do not use text similarity as the primary metric.

Track:

- semantic equivalence;
- control-structure recovery;
- variable merge/split accuracy;
- prototype accuracy;
- type accuracy;
- aggregate field recovery;
- unnecessary temporaries;
- goto count where semantics permit reduction;
- expression complexity;
- source/provenance coverage.

## 36.7 Type metrics

Confusion matrices for:

- scalar;
- signedness;
- float;
- pointer;
- array;
- struct/union;
- enum;
- function pointer;
- object/class;
- prototype arguments/return;
- field offsets/strides.

Measure false certainty separately.

## 36.8 Performance metrics

- TTFUA;
- cold/warm open;
- active-function analysis;
- decompilation latency;
- search;
- peak resident memory;
- artifact-store size;
- cancellation latency;
- browser p95/p99 responsiveness.

## 36.9 Competitive differential

When legally/technically available, maintain reproducible comparisons against:

- Ghidra as mandatory open reference;
- Binary Ninja/IDA when licensed automation is available;
- independent lifters/decoders for semantic validation.

Competitor output is an oracle/reference, not truth by authority.

---

# 37. Quality gates for “done”

A capability is not complete because the UI can display it.

## 37.1 Architecture A6 “Decompiler support” requires

- format mapping works;
- decoder works;
- exact effects coverage meets target;
- CFG works;
- SSA/MSSA works;
- ABI exists;
- function discovery works;
- alias/dataflow have no architecture-specific hacks;
- decompiler runs;
- provenance links survive;
- mandatory compiler corpus passes;
- capability matrix updated.

## 37.2 New analyzer requires

- stable input/output schema;
- artifact key/version;
- cancellation;
- budget;
- provenance;
- explicit unknown behavior;
- tests;
- performance measurement;
- AI/UI access only through public API.

## 37.3 New AI tool requires

- deterministic existing capability;
- narrow schema;
- bounded output;
- scope rules;
- evidence creation policy;
- injection tests;
- cancellation;
- no hidden mutation.

## 37.4 New plugin type requires

- API version;
- permission model;
- isolation;
- lifecycle;
- error model;
- resource budget;
- tests.

---

# 38. Permanent design decisions

These decisions remain in force unless an ADR with new evidence changes them.

## D-001

Do not use LLVM IR as the sole canonical machine semantic truth.

LLVM MAY be an optional lowering/backend.

## D-002

Do not use QEMU TCG as the canonical analysis IR.

It MAY be an execution backend/reference.

## D-003

Do not make a disassembler decoder the semantic authority.

Capstone/LLVM MC-like decoders feed Hex-owned semantics.

## D-004

Do not create separate beginner and expert analysis engines.

## D-005

Do not let AI infer binary facts from pseudocode alone when deterministic analysis is available.

## D-006

Do not use addresses alone as cross-version function identity.

## D-007

Do not persist giant mutable analysis graphs inside `.hexproj`.

## D-008

Do not use an opaque similarity score without contributing evidence/features.

## D-009

Do not let runtime observations silently rewrite static facts.

## D-010

Do not optimize away unknown alias/clobber effects for prettier output.

## D-011

Do not force DEX/CIL/JVM/WASM through a fake native-register model.

Use VMEffects/managed frontends.

## D-012

Do not perform a repository-wide folder rewrite merely to match the target layout.

Move modules when their contract is actually migrated.

---

# 39. Risk register

## R-001 — ARM64 regression during semantic refactor

Mitigation:

- compatibility lowering;
- current real-binary fixtures;
- semantic differential tests;
- staged cutover.

## R-002 — New architectures expose hidden ARM assumptions

Mitigation:

- RISC-V early;
- no architecture names/constants in generic SSA/MSSA;
- generic target conformance suite.

## R-003 — Browser memory collapse on very large binaries

Mitigation:

- source-backed reads;
- paged artifacts;
- compact indexes;
- artifact persistence;
- scheduler/budgets;
- UI virtualization.

## R-004 — Decompiler becomes prettier but unsound

Mitigation:

- provenance;
- alias proof requirement;
- semantic regression;
- transform preconditions;
- optional symbolic checks.

## R-005 — Type recovery creates false certainty

Mitigation:

- hard/soft constraints;
- contradiction state;
- false-certainty benchmark;
- confidence visible.

## R-006 — Plugin ecosystem weakens security

Mitigation:

- worker isolation;
- least privilege;
- bounded reads;
- no network/DOM by default;
- immutable APIs.

## R-007 — AI prompt injection from analyzed content

Mitigation:

- untrusted-data tagging;
- typed tools;
- host execution;
- static allowlists;
- no model-issued authorization.

## R-008 — Runtime evidence tied to wrong binary/version

Mitigation:

- binary identity binding;
- cross-version re-resolution thresholds;
- explicit unsupported/ambiguous status.

## R-009 — Third-party license conflict

Mitigation:

- `REFERENCES.md` license triage;
- pinned dependency review;
- adapter/service boundary;
- no code import before project distribution policy is decided.

## R-010 — Documentation drift

Mitigation:

- master-spec precedence;
- ADR+spec same-PR update;
- capability matrix in CI;
- architecture docs reviewed by affected subsystem tests.

---

# 40. Open product decisions that do not block this architecture

These are intentionally not guessed because the current repository/research does not establish them.

## O-001 — Hex distribution license

The current repository baseline does not declare a GitHub license.

Before direct third-party code reuse or distribution commitments, the owner MUST decide the Hex licensing/distribution policy.

The architecture itself does not require a specific license.

## O-002 — Hosted backend product

The architecture supports an optional backend for:

- expensive SMT;
- giant corpus matching;
- remote debug/instrumentation;
- large indexing;
- optional native analyzers.

Hex core MUST remain usable without requiring a hosted backend.

Whether an official hosted service exists is a product decision.

## O-003 — Collaboration service

ProjectStore/change-log design permits future collaboration.

The server/service model is not fixed by this specification.

---

# 41. Definition of the final Hex architecture

The completed architecture is not “many tools connected together.”

It is one semantic/evidence system with replaceable providers:

```text
                    ┌──────────────────────────┐
                    │      User / AI Goal      │
                    └────────────┬─────────────┘
                                 │
                    ┌────────────▼─────────────┐
                    │ Query / Analysis Planner │
                    └────────────┬─────────────┘
                                 │
         ┌───────────────────────▼────────────────────────┐
         │       Versioned Analysis Artifact Graph        │
         └───────────────────────┬────────────────────────┘
                                 │
       ┌─────────────────────────▼─────────────────────────┐
       │ Semantic IR / SSA / MemorySSA / Types / HighIR   │
       └─────────────────────────┬─────────────────────────┘
                                 │
       ┌─────────────────────────▼─────────────────────────┐
       │ MachineEffects / VMEffects + ABI + Runtime Meta   │
       └─────────────────────────┬─────────────────────────┘
                                 │
       ┌─────────────────────────▼─────────────────────────┐
       │ BinaryImage / Loader / Container / ByteSource     │
       └─────────────────────────┬─────────────────────────┘
                                 │
                              bytes

Every derived claim
        │
        ▼
EvidenceGraph
   ├─ static proof
   ├─ symbolic proof
   ├─ runtime observation
   ├─ signature/knowledge
   └─ user confirmation
        │
        ▼
Beginner / Expert / AI projections
```

The strategic rule is simple:

> **Exact low-level meaning first. Conservative analysis second. High-level readability third. Evidence never lost. AI last.**

If a future feature conflicts with that order, the feature design is wrong unless an explicit ADR proves otherwise.

---

# 42. Implementation order summary

The shortest safe path from the current Hex to this target is:

```text
1. Freeze identities/invariants/benchmark baseline
2. Separate Architecture and ABI
3. Introduce MachineEffects
4. Migrate ARM64 through compatibility lowering
5. Introduce Semantic IR v2
6. Make SSA/MemorySSA architecture-neutral
7. Add ArtifactStore + scheduler
8. Make x86-64 first-class
9. Validate generic core with RISC-V64
10. Deepen alias/interprocedural/type analysis
11. Deepen decompiler
12. Add solver-backed verification
13. Mature runtime providers
14. Add VM/managed frontends
15. Expand knowledge/capabilities/collaboration/rewrite
```

No later phase is allowed to create an alternate semantic core to bypass an earlier dependency.

---

# 43. Review checklist for every architecture-changing PR

Before merge, answer all of these:

- Does this introduce a second semantic truth?
- Does it preserve origin/evidence?
- Does unknown remain explicit?
- Does it weaken alias/call conservatism?
- Is architecture knowledge leaking into generic analysis?
- Is ABI knowledge leaking into architecture semantics?
- Is format-specific address math escaping the loader?
- Is a large object graph being copied to UI?
- Can work be cancelled?
- Is the artifact versioned/cacheable?
- Does it work without loading the whole binary?
- Does it add a false “supported” capability?
- Does AI gain authority that deterministic analysis should own?
- Can runtime data be confused with static truth?
- Can a plugin escape its permission boundary?
- Are current ARM64 regressions protected?
- Are benchmark/capability matrices updated?
- If third-party code is used, was the exact pinned license reviewed?

If any answer is unsafe, the PR is not architecture-complete.

---

# 44. References

The normative implementation should use the project’s durable reference index (`REFERENCES.md`, currently derived from `SOURCES.md`) for primary-source links.

High-priority reference families:

- Ghidra SLEIGH/P-code — exact retargetable machine semantics;
- Binary Ninja BNIL — layered queryable semantic projections;
- IDA/Hex-Rays public SDK/docs — mature types, signatures, database/navigation;
- rev.ng — artifact/pass discipline;
- angr/Triton — explicit symbolic state and solver separation;
- Frida/LLDB/GDB/WinDbg — runtime/debug provider boundaries;
- Rizin/radare2 — IO/plugin/patch modularity;
- LIEF/Rust object — loader/rebuild/differential parsing;
- ImHex — declarative data interpretation;
- capa — deterministic capability facts;
- BinDiff/Diaphora — explainable multi-feature similarity;
- JADX/ILSpy — metadata-first managed frontends;
- architecture vendor ISA and ABI specifications — final semantic authority for target behavior.

`deep-research-report.md` remains research context for maintainers. It is not an implementation contract.

---

# 45. Final acceptance principle

A feature is ready when:

1. it is semantically correct or explicitly unknown;
2. its evidence can be inspected;
3. its result is reproducible/versioned;
4. it obeys resource/cancellation boundaries;
5. it works through stable public contracts;
6. it does not regress existing supported targets;
7. it has measurable quality gates;
8. both beginner and expert projections can consume the same truth.

That is the architecture Hex should converge on.
