# Phase 11 Managed Frontends — Implementation Playbook

Status: **planning / preflight guidance**  
Phase: **11 — Managed frontends**  
Scope: **WASM → DEX → CLR/CIL → JVM**  
Canonical architecture: [`HEX_MASTER_ARCHITECTURE.md`](./HEX_MASTER_ARCHITECTURE.md)  
Engineering process: [`ENGINEERING_PROCESS_GUARDRAILS.md`](./ENGINEERING_PROCESS_GUARDRAILS.md)  
Support truth: [`SUPPORT_MATRIX.md`](./SUPPORT_MATRIX.md) and `js/platform/capability-maturity.js`

---

## 1. Why this document exists

Phase 11 is easy to underestimate.

The visible deliverable looks like four new frontends:

1. WASM
2. DEX
3. CLR/CIL
4. JVM

The real architectural task is harder: introduce the first production `VMEffects` pipeline without creating a second semantic universe beside Hex's native `MachineEffects → Semantic IR → SSA/MemorySSA → HighIR` architecture.

The phase succeeds only if managed/VM code becomes another low-level semantic source feeding the same downstream truth chain where that mapping is valid:

```text
WASM / DEX / CIL / JVM bytes + metadata
                ↓
        Managed Frontend
                ↓
            VMEffects
                ↓
          Semantic IR
                ↓
      CFG / SSA / dataflow
                ↓
 types / interprocedural summaries
                ↓
       HighIR / decompiler
                ↓
     EvidenceGraph / UI / AI
```

The phase must **not** implement four isolated decompilers, four private CFG systems, or a fake native-register layer.

The Master Architecture explicitly requires managed formats to preserve their own execution model and lower through `VMEffects`. That is the governing constraint for every design decision in this playbook.

---

## 2. Current baseline and what is actually missing

At current `main` when this playbook was authored:

- the managed maturity schema `M0–M6` already exists;
- the current support matrix has **no registered managed frontend**;
- `managedMaturity()` intentionally returns unsupported;
- no DEX/JVM/CIL/WASM frontend is claimed as supported;
- the target repository layout already reserves `js/managed/{wasm,dex,jvm,cil}/` conceptually in the Master Architecture.

Therefore Phase 11 is not a cleanup phase. It introduces a new family of first-class executable frontends.

The maturity ladder is cumulative:

```text
M0 Detect/container
M1 Metadata
M2 Exact VMEffects
M3 CFG/SSA
M4 Types/interprocedural
M5 Decompiler
M6 Runtime/debug integration
```

A frontend must never be promoted by skipping a missing prerequisite. A parser is not M2. A decompiler-looking UI is not M5 if exact VMEffects or shared CFG/SSA are incomplete.

---

## 3. Phase goal in one sentence

Build one reusable managed/VM semantic pipeline, prove it first with WASM, then add DEX, CLR/CIL, and JVM as thin target-specific frontends that preserve target semantics while sharing Hex's downstream analysis, evidence, artifact, scheduling, and UI infrastructure.

---

## 4. Non-goals

Phase 11 should **not** expand into the following unless a dependency is genuinely required to satisfy the phase contract:

- Android resource decoding/UI reconstruction beyond what is needed to locate and relate code;
- ART/OAT/VDEX ahead-of-time native recovery as a complete subsystem;
- full .NET ReadyToRun/native-image analysis;
- a complete Java source-language compiler reconstruction engine;
- Android emulator/device orchestration;
- production-grade managed debugger implementation for every runtime;
- generalized package-manager/dependency-resolution ecosystems;
- a new alternative Semantic IR designed only for managed code;
- a managed-only project database;
- a managed-only AI reasoning path.

Those are future extensions. Phase 11 establishes the semantic foundation and reaches the highest maturity level that can be proven honestly for each frontend.

---

## 5. The hardest design problems

### 5.1 One downstream core, multiple execution models

The four initial targets do not execute the same way:

| Frontend | Execution model | Important state |
|---|---|---|
| WASM | typed stack machine with structured control | operand stack, locals, globals, linear memories, tables |
| DEX | register machine | method registers, typed references, fields, arrays, exceptions |
| CIL | typed evaluation stack + locals/args | stack, locals, args, metadata tokens, managed references |
| JVM | operand stack + local variable array | stack, locals, constant pool refs, verifier types, exceptions |

The common layer must model **effects**, not pretend these are CPU registers.

Bad design:

```text
DEX v0 -> invent x0/x1/x2...
JVM v0 -> invent x0/x1/x2...
WASM v0 -> invent x0/x1/x2...
```

Correct design:

```text
VM state native to the target
        ↓ exact lowering
VMEffects
        ↓ normalization
Semantic IR values / memory / control
```

### 5.2 Stack identity is part of semantics

For WASM/CIL/JVM, stack operations cannot be reconstructed later from pretty text. The frontend must assign stable value identities during exact lowering.

The preferred pattern is:

```text
input stack state
    ↓
VM op
    ↓
explicit consumed values + produced values
    ↓
output stack state
```

A stack-height mismatch, invalid verifier state, or unsupported operation must become explicit `invalid-input`, `partial`, `unsupported`, or `unknown` state. It must not be silently repaired to make decompilation continue.

### 5.3 Metadata is semantic input, not decoration

Managed formats expose much more authoritative metadata than stripped native binaries.

Examples:

- DEX method/field/type descriptors;
- CLR metadata tables/tokens, signatures, generic parameters;
- JVM descriptors, constant pool, exception tables;
- WASM type/function/import/export tables.

The frontend should bind exact metadata identities early and feed them into type/call constraints. Do not throw this information away and then ask the generic type recovery engine to guess it again.

### 5.4 Exceptions are first-class control flow

DEX, CIL, and JVM all have structured exception metadata; WASM now also has evolving exception/tag semantics depending on feature set.

The frontend must preserve exceptional edges before shared CFG/SSA work. A decompiler that ignores catch/finally edges may look cleaner while being semantically wrong.

### 5.5 Memory models are not interchangeable

Do not map everything to one flat generic memory token.

At minimum distinguish concepts such as:

```text
WASM:
  linear memory
  globals
  tables

DEX/JVM/CIL:
  object fields
  static fields
  arrays
  managed references
  runtime-managed state
```

The generic Semantic IR can still use common load/store/call concepts, but alias regions and effect summaries must retain the managed root/space identity needed for safe reasoning.

### 5.6 Cross-boundary native links

Managed code often crosses into native code:

- DEX/JVM ↔ JNI;
- CLR ↔ P/Invoke / internal calls;
- WASM ↔ imported host functions;
- mixed mobile packages containing native libraries.

Phase 11 should define identity/evidence links for these boundaries even when full cross-domain interprocedural analysis is not yet available.

The safe first step is:

```text
managed callsite
  → exact external/native target descriptor if known
  → linked BinaryImage/function candidate if proven
  → otherwise explicit unresolved target set
```

Never synthesize a native function identity from a name alone.

---

## 6. Shared foundation that must exist before frontend fanout

Do **not** start four component lanes immediately.

The Phase 11 foundation checkpoint should establish the following shared contracts first.

### 6.1 ManagedFrontend contract

Proposed shape:

```ts
interface ManagedFrontend {
  id
  semanticVersion
  probe(source, context): Promise<ManagedDetection>
  open(source, context): Promise<ManagedImage>
  enumerateModules(image, options): AsyncIterable<ManagedModule>
  enumerateMethods(module, options): AsyncIterable<ManagedMethod>
  liftMethod(method, context): Promise<VMEffectFunction>
}
```

This is an architectural sketch, not a mandate for these exact method names.

Required properties:

- cancellable;
- bounded;
- source/provenance preserving;
- lazy/demand-driven;
- artifact-versioned;
- independent from UI objects;
- no frontend-private downstream decompiler contract.

### 6.2 Managed identity model

Define stable IDs before parser implementation spreads.

At minimum:

```text
ManagedImageId
ManagedModuleId
ManagedTypeId
ManagedMethodId
ManagedFieldId
VMOpId
MetadataEntityId
```

Identity rules should use binary/container identity + authoritative target metadata identity, not display names.

Examples conceptually:

```text
DEX method:
  BinaryId + dex-slice/member identity + method_idx

CLR method:
  BinaryId + module identity + metadata token

JVM method:
  BinaryId + class identity + name + descriptor

WASM function:
  BinaryId + module identity + function index
```

If a target has a more authoritative identity than the examples above, use it.

### 6.3 VMEffects schema

The schema must handle both register and stack machines.

Recommended effect families:

```text
const
copy
local/get/set
arg/get
stack consume/produce identity
cast / numeric conversion
binary/unary arithmetic
compare/select
object/field read/write
array read/write
linear-memory load/store
static/global read/write
table read/write
new object/array
call / virtual-call / interface-call / indirect-call
return
branch / conditional branch / switch
throw / rethrow
monitor/lock where applicable
intrinsic
unknown
```

Do not add target mnemonics to generic consumers. Target-specific operations may remain explicit, effect-summarized intrinsics until a safe common normalization exists.

### 6.4 VM type vocabulary

Separate exact VM representation from recovered language rendering.

Examples of hard VM types:

```text
i32/i64/f32/f64/v128/ref     // WASM-style exact representation
int32/int64/native-int/ref   // CIL-style categories
JVM primitive/reference/verifier states
DEX primitive/reference/wide register constraints
```

These are not the same as final source-language nominal types.

### 6.5 Managed artifact keys

All expensive products need versioned keys from the start.

At minimum bind:

```text
BinaryId
container/member identity
frontend id + semantic version
metadata schema version
method identity
VMEffects schema version
shared Semantic IR schema version
pass versions
options hash
```

If this is deferred, warm reopen and invalidation become expensive retrofit work.

### 6.6 Maturity registry integration

The foundation should add real frontend profiles only when implementation exists.

Do not predeclare WASM/DEX/CIL/JVM as `supported` merely because the phase started.

The machine-readable registry remains authority. `SUPPORT_MATRIX.md` is updated as a projection after measured support changes.

### 6.7 Common managed verifier

Build the verifier before the first frontend becomes large.

It should understand at least:

- exact input artifact identity;
- parser/metadata result;
- VMEffects coverage/completeness;
- CFG validity;
- SSA validity;
- provenance coverage;
- unknown/unsupported operation counts;
- type/prototype preservation where authoritative metadata exists;
- decompiler semantic checks when M5 is attempted;
- exact product SHA and frontend semantic version.

The verifier must support exact-SHA/manual invocation. Do not wait until final release to create this path.

---

## 7. Recommended Phase 11 checkpoint structure

The safest implementation order is not four giant PRs. Use a foundation plus vertical checkpoints.

```text
P11-F  Foundation / contracts / verifier / ownership
  ↓
P11-W  WASM M0→M3 walking skeleton, then deepen
  ↓
P11-D  DEX M0→M3 walking skeleton, then deepen
  ↓
P11-C  CLR/CIL M0→M3 walking skeleton, then deepen
  ↓
P11-J  JVM M0→M3 walking skeleton, then deepen
  ↓
P11-H  Shared M4/M5 hardening across all proven frontends
  ↓
P11-R  Release integration / exact-head proof
```

The exact lane names may differ. The important rule is that every frontend hits a shared vertical path early instead of implementing a huge parser before the common VMEffects/CFG/SSA pipeline has been proven.

---

## 8. Why WASM should go first

WASM is the best first frontend for architectural validation because it has:

- explicit module/function/type structure;
- strongly specified binary encoding;
- typed operations;
- structured control flow;
- explicit linear memory/table concepts;
- no need to infer native ABI registers;
- a compact execution model that exercises stack semantics without Java/.NET runtime complexity.

The purpose of the WASM lane is not merely to add WASM support. It is to prove that the shared VM frontend architecture is real.

### WASM minimum vertical slice

A first useful walking skeleton should cover:

```text
module detection
→ section parsing required for code/types/imports/exports
→ function identity
→ basic numeric/local ops
→ structured branch/control lowering
→ VMEffects
→ shared Semantic IR
→ CFG/SSA
→ simple decompile/query projection
→ provenance back to byte offsets
```

### WASM difficult cases to design for early

- structured blocks/loops/if with branch depths;
- multi-value blocks/functions;
- locals vs operand stack values;
- `call_indirect` and tables;
- linear-memory address/width/endian semantics;
- imports/host calls;
- unreachable/polymorphic stack semantics;
- multiple memories/tables or optional proposal features;
- feature/version gating rather than assuming every opcode is valid.

Do not block the initial skeleton on every optional WASM proposal. Unsupported feature sets should fail explicitly and be capability-versioned.

---

## 9. DEX lane strategy

DEX is the first strong test of a **register VM + metadata-first object model**.

### Preserve exactly

- class/type/method/field identifiers;
- method prototypes;
- register count and parameter mapping;
- wide-value register pairs where relevant;
- try/catch regions;
- annotations required for semantic/type evidence;
- invoke kinds;
- field/static/array access distinctions;
- string/type/proto/method handles;
- JNI/native method relationship evidence.

### Major traps

#### Register reuse is not source-variable identity

DEX registers are execution locations. Source variables may occupy the same register at different program points.

Do not expose raw register identity as recovered variable identity.

#### Invoke kind matters

`virtual`, `interface`, `direct`, `static`, and `super` calls encode different dispatch constraints. Preserve that in VMEffects/call metadata before high-level normalization.

#### Wide values and verifier constraints

64-bit values and register constraints must be represented exactly. Do not model a wide pair as two unrelated scalar values.

#### APK/AAB container scope

The DEX frontend should consume a bounded container/member abstraction rather than reimplement ZIP/package traversal inside the semantic lifter.

Keep package/container discovery separate from method semantics.

---

## 10. CLR/CIL lane strategy

CIL validates a metadata-rich stack machine with generics and structured signatures.

### Preserve exactly

- PE/CLI module identity;
- metadata tokens and tables;
- method/field/type signatures;
- generic parameters and instantiated type context where known;
- method args/locals;
- evaluation stack transitions;
- exception regions;
- call/callvirt/newobj distinctions;
- managed references/byrefs;
- PDB references/evidence when available;
- P/Invoke/native boundary descriptors.

### Major traps

#### Metadata token identity must survive decompilation

A pretty name is not the identity. Renames, overloads, generic instantiations, and obfuscation make token/signature identity essential.

#### `callvirt` is not simply `call`

Preserve dispatch and null-check/runtime semantics accurately enough that later normalization does not erase meaningful behavior.

#### Verification/stack typing

Stack type state is powerful hard evidence. Feed it into the shared TypeConstraintGraph instead of downgrading it into weak naming hints.

#### Generics

Do not require complete generic reconstruction for the first M3 skeleton, but the identity/model must not make generics impossible to add later.

---

## 11. JVM lane strategy

JVM should reuse the stack-machine infrastructure proven by WASM/CIL while retaining JVM-specific verifier and constant-pool semantics.

### Preserve exactly

- classfile identity/version;
- constant pool references;
- class/method/field descriptors;
- local variable slots;
- operand stack transitions;
- exception tables;
- invocation kind (`virtual`, `special`, `static`, `interface`, dynamic where supported);
- verifier types/stack map evidence;
- annotations/signatures when present;
- native method/JNI relationships.

### Major traps

#### Local slots are not source variables

As with DEX registers, slot reuse must be split/coalesced by dataflow, scope metadata, and type constraints.

#### `invokedynamic`

Do not fake a direct call target. Preserve bootstrap metadata and unresolved/dynamic target semantics until a deterministic resolver can prove more.

#### `jsr`/legacy bytecode and version differences

Old classfile behavior and modern verification rules should be feature/version gated, not accidentally accepted by a parser written only for current javac output.

---

## 12. Shared lowering rules into Semantic IR

Phase 11 should define a written lowering table before frontend implementation diverges.

Examples:

| VM concept | Shared representation direction |
|---|---|
| local/register value | Semantic value / explicit local state before SSA |
| operand stack value | stable VM value identity, then Semantic value |
| object field read/write | typed/region-aware load/store-like semantic op |
| static/global field | distinct static/global region |
| array element | base + indexed access with element/type metadata |
| direct call | `CallSite` with exact target when authoritative |
| virtual/interface call | candidate dispatch set + dispatch kind + uncertainty |
| indirect table call | target set / unresolved indirect semantics |
| throw | explicit exceptional control effect |
| catch handler | exceptional CFG edge/entry state |
| VM intrinsic/runtime op | effect-summarized intrinsic |

A frontend may preserve richer VMEffects than Semantic IR can currently express. In that case the lowering must report `partial`/intrinsic semantics rather than dropping information.

---

## 13. CFG and SSA strategy

Do not build frontend-specific SSA implementations.

The preferred division is:

```text
frontend:
  validates operation stream
  computes exact VM stack/register transition information
  preserves target control-flow targets + exception regions
  emits VMEffects

shared managed lowering:
  produces Semantic IR CFG inputs

existing generic passes:
  CFG
  SSA
  dataflow
  type constraints
```

If a generic pass cannot represent a valid managed construct, fix the generic contract or add an explicit managed extension. Do not create a hidden frontend-only copy of the pass.

### Stack merges

At CFG joins, operand stack height/type compatibility must be verified before creating merged semantic values.

Invalid or unverifiable merges are not ordinary phi nodes with invented inputs.

---

## 14. Type recovery strategy

Managed frontends should dramatically reduce guessing.

Use a strict evidence order:

```text
authoritative target metadata / verifier facts
        ↓ hard constraints
VM operation semantics
        ↓ hard constraints
runtime/package metadata
        ↓ strong evidence
use-shape / naming / signatures
        ↓ soft evidence
```

Do not feed exact metadata through a confidence scorer as if it were merely a naming hint.

### Shared objective

Phase 11 should expose authoritative managed type facts through the same public type/evidence APIs used by native analysis, while keeping their source and authority level visible.

---

## 15. Decompiler strategy

The Master Architecture rule is explicit: **a managed frontend must reach VMEffects before shared decompiler claims are made**.

Recommended progression:

```text
M0/M1  show metadata and methods
M2     inspect exact VMEffects
M3     shared CFG/SSA queries work
M4     types/interprocedural summaries are credible
M5     source-like decompiler projection is allowed
```

Do not rush M5.

A readable Java/C#/Java-like view produced directly from bytecode without the shared evidence chain would create a second semantic truth and make later debugging much harder.

### Language rendering

The shared default may remain a stable structured pseudocode/HighIR projection.

Language-specific rendering should be added only when evidence is strong enough to preserve semantics. For example, producing exact C# or Java syntax is less important than correct dispatch, exceptions, types, and provenance.

---

## 16. Evidence and provenance requirements

Every managed high-level result must descend to exact managed source evidence.

Required chain:

```text
High-level claim
  ↓
HighIR / decompiler node
  ↓
Semantic IR
  ↓
VMEffects
  ↓
VM operation
  ↓
metadata entity / bytecode offset
  ↓
container member byte range
  ↓
BinaryId
```

Examples:

- a Java field name should link to the constant-pool/descriptor evidence;
- a CIL call target should link to its metadata token/signature;
- a DEX invoke target should link to method/proto indexes;
- a WASM call should link to function/type table identities.

No decompiler rewrite may lose this origin chain.

---

## 17. ArtifactStore, scheduling, and iPad constraints

Managed packages can be huge. The browser/iPad rules remain unchanged.

### Do not do this

```text
open APK/JAR/AAB
→ parse every class/method eagerly
→ create JS objects for every bytecode op
→ decompile all methods
→ keep everything in UI heap
```

### Do this

```text
ByteSource / container member
    ↓ lazy metadata index
method identities
    ↓ demand-driven lift
VMEffects artifact
    ↓ demand-driven shared analysis
CFG/SSA/types/decompiler artifacts
    ↓ paged query API
UI
```

Recommended priorities remain:

```text
P0 visible/selected method
P1 dependencies required for active question
P2 direct callers/callees/type neighbors
P3 background module discovery/indexing
P4 global type/signature refinement
P5 optional whole-package expensive analysis
```

Cancellation and budget accounting must exist from the first walking skeleton, not after performance problems appear.

---

## 18. Security and hostile-input requirements

Every managed container and metadata table is hostile input.

Minimum checks include:

- checked offsets/sizes/counts;
- bounded section/table/member counts;
- bounded strings and nesting;
- no unbounded recursive type/signature parsing;
- decompression/container limits;
- invalid index/token/reference detection;
- malformed control-flow target rejection;
- verifier/stack-state mismatch reporting;
- cancellation;
- no `eval`/host code execution to interpret target semantics.

A malformed binary must not become a parser hang or browser memory exhaustion event.

---

## 19. Testing strategy

Phase 11 needs both **frontend truth** and **shared-pipeline truth**.

### 19.1 Foundation tests

Before frontend fanout:

- VMEffects schema validation;
- provenance/origin retention;
- managed identity stability;
- artifact key/version invalidation;
- cancellation/budget behavior;
- unsupported/partial/invalid distinction;
- maturity registry cannot skip levels;
- canonical managed verifier exact-SHA path;
- ownership manifest self-tests;
- canonical runner discovers every managed lane test subtree.

### 19.2 Per-frontend compiler/runtime corpus

Use generated source + authoritative runtime/toolchain metadata where possible.

Minimum dimensions should grow toward:

```text
WASM:
  multiple producers/toolchains if practical
  debug and stripped/minimal metadata
  control flow, tables, memory, imports

DEX:
  Java/Kotlin produced DEX
  optimized/obfuscated samples where legally available
  exceptions, interfaces, arrays, JNI declarations

CIL:
  C#/.NET assemblies
  generics, exceptions, virtual dispatch, P/Invoke

JVM:
  javac/Kotlin classfiles
  interfaces, exceptions, lambdas/invokedynamic, native methods
```

Do not weaken required toolchain families to whichever happens to be installed. Missing required corpus/toolchain evidence is blocking or explicitly incomplete.

### 19.3 Round-trip/semantic tests

Where an official interpreter/runtime can serve as an oracle, compare bounded behavior for carefully selected methods/functions.

The oracle proves semantics only for the tested scope/input. It is not blanket proof of the decompiler.

### 19.4 Negative corpus

Every frontend must include malformed/adversarial fixtures:

- truncated structures;
- invalid indexes/tokens;
- impossible stack states;
- bad branch targets;
- oversized counts;
- cyclic/recursive metadata shapes;
- unsupported feature/version cases.

---

## 20. Differential/reference strategy

Use primary-source implementations as references, not semantic authority.

Useful reference families already indexed in `SOURCES.md` include:

- JADX for DEX metadata/decompiler behavior;
- ILSpy for CLR/CIL metadata-first decompilation;
- official target specifications/runtime tooling for exact bytecode behavior;
- existing Hex shared IR/decompiler verification infrastructure for downstream invariants.

A differential mismatch should trigger first-divergence analysis:

```text
bytes/metadata
→ parse identity
→ VM op decode
→ VMEffects
→ Semantic IR lowering
→ CFG
→ SSA
→ types
→ HighIR
→ rendering
```

Fix the earliest deterministic divergence. Do not patch the pretty-printer to hide an upstream semantic error.

---

## 21. Suggested ownership model

Exact paths must be finalized against the live tree during Phase 11 preflight, but ownership should follow this shape.

### Foundation owner

Owns shared contracts only:

```text
js/managed/shared/**            // proposed target namespace
js/platform/capability-maturity.js
shared managed artifact/query contracts
phase11 verifier/governance
phase11 canonical test runner
```

### WASM owner

```text
js/managed/wasm/**
tests/phase11/wasm/**
```

### DEX owner

```text
js/managed/dex/**
tests/phase11/dex/**
```

### CIL owner

```text
js/managed/cil/**
tests/phase11/cil/**
```

### JVM owner

```text
js/managed/jvm/**
tests/phase11/jvm/**
```

### Integration owner

Owns only explicit shared wiring, generated artifacts, support-matrix projection, release evidence, and current-main reconciliation.

Component lanes should target the living Phase 11 integration branch, not `main`.

Do not finalize these allowlists until the foundation owner compares them against the real implementation plan and synthetic negative ownership tests.

---

## 22. Living integration strategy

Phase 11 must follow the permanent phase workflow in `ENGINEERING_PROCESS_GUARDRAILS.md`.

### Foundation checkpoint

Before parallel fanout:

1. create living integration branch/PR;
2. freeze shared VMEffects/identity/version contracts;
3. create ownership manifest + regressions;
4. create canonical test runner and prove test discovery;
5. create exact-SHA verifier invocation;
6. implement a tiny end-to-end managed walking skeleton;
7. define corpus/toolchain identities;
8. define moving-main reconciliation owner;
9. define what invalidates evidence.

### Before every component merge

Prove the candidate integration tree, not only the component branch.

### After every component merge

Lock integration until:

- shared contract reconciliation is complete;
- semantic/artifact versions are updated if required;
- generated outputs are rebuilt/committed by the integration owner where applicable;
- rebuild produces zero diff;
- rolling managed vertical gate is green;
- independent verifier is green;
- exact checkpoint evidence is recorded.

Only then accept the next component.

---

## 23. Maturity promotion rules per frontend

### M0 — Detect/container

Require:

- exact format/container identification;
- bounded probe;
- no false support claim for malformed lookalikes.

### M1 — Metadata

Require:

- authoritative entity identities;
- methods/functions/types/imports/exports relevant to target;
- source ranges/provenance;
- malformed metadata rejection.

### M2 — Exact VMEffects

Require:

- measured opcode coverage;
- explicit unsupported/intrinsic/partial semantics;
- exact stack/register transition semantics for covered operations;
- exceptions/control effects represented;
- zero silent preserve/no-op fallback.

### M3 — CFG/SSA

Require:

- shared CFG path;
- generic SSA path;
- validated merge states;
- exception edges;
- no frontend-private hidden SSA truth.

### M4 — Types/interprocedural

Require:

- authoritative metadata integrated as hard constraints;
- call/dispatch summaries;
- conservative unresolved targets;
- cross-method summaries measured on corpus.

### M5 — Decompiler

Require:

- shared HighIR/decompiler path;
- provenance coverage;
- semantic regression gates;
- no direct bytecode-to-pretty-source bypass used as canonical truth.

### M6 — Runtime/debug

Require:

- runtime session identity binding;
- managed runtime/debug provider evidence;
- static/runtime separation preserved;
- exact cross-version ambiguity handling.

Phase 11 does not have to promote every frontend to M6 if the implementation evidence does not justify it. Honest partial completion is preferable to fake maturity.

---

## 24. Common failure modes to avoid

### Failure: one parser per target, no shared contract

Result: four incompatible systems and a large Phase 11 integration rewrite.

Prevention: freeze `ManagedFrontend`, VMEffects, identity, artifact, and verifier contracts first.

### Failure: direct bytecode → pseudocode

Result: attractive output with no shared SSA/evidence semantics.

Prevention: M2/M3 gates before M5 claims.

### Failure: stack machine flattened into fake registers

Result: target semantics leak into generic code and stack verification is lost.

Prevention: preserve VM-native state and explicit value identities.

### Failure: metadata thrown away and re-guessed

Result: lower type accuracy than the input format already provides.

Prevention: authoritative metadata enters hard constraints.

### Failure: exceptions deferred

Result: CFG/SSA/decompiler architecture must be rewritten later.

Prevention: exception regions/edges exist in the first walking skeleton.

### Failure: eager whole-package analysis

Result: iPad memory/latency collapse.

Prevention: method-level artifacts + demand scheduler + paging.

### Failure: maturity promoted from parser presence

Result: misleading UI/support matrix.

Prevention: machine-readable cumulative M0–M6 gates.

### Failure: four parallel lanes edit shared core

Result: ownership conflicts and late integration.

Prevention: foundation owner freezes shared surface; component lanes expose explicit integration handoffs.

### Failure: final verifier built at the end

Result: verifier itself becomes the release blocker.

Prevention: shadow verifier runs from first vertical checkpoint.

---

## 25. Pre-mortem against known engineering failures

Before Phase 11 implementation starts, explicitly review every current `EP-*` entry in `ENGINEERING_PROCESS_GUARDRAILS.md`.

The following are especially relevant:

- late concentrated integration → create living integration + vertical skeleton immediately;
- cross-scope contamination → actual changed-file allowlists;
- ownership contradictions → self-test ownership against real/synthetic inventories;
- canonical runner missing nested tests → sentinel discovery test for every lane subtree;
- verifier maturity arriving late → exact-SHA verifier from foundation;
- moving-main churn → one integration reconciliation owner;
- invalid CI artifacts → atomic validated evidence publication;
- performance symptoms hidden by CI fanout → profile real package/method hot paths first;
- support claims stronger than proof → cumulative M-level registry remains authority.

Phase 11 preflight is not complete until the applicable recurrence-prevention gates are machine-enforced where feasible.

---

## 26. Phase 11 release evidence schema

Create one deterministic release report rather than relying on PR prose.

Suggested fields:

```text
phase11SchemaVersion
productCommitSha
integrationBaseSha
verifierVersion
vmEffectsSchemaVersion
managedIdentitySchemaVersion
semanticIrSchemaVersion
artifactSchemaVersion

frontendResults:
  wasm:
    implementedLevel
    fullySatisfiedLevel
    metadataCorpus
    vmOpcodeCoverage
    unsupportedOpcodeCount
    provenanceCoverage
    cfgResult
    ssaResult
    typeResult
    decompilerResult
  dex: ...
  cil: ...
  jvm: ...

candidateMergeTreeResult
ownershipResult
canonicalRunnerDiscoveryResult
malformedCorpusResult
resourceBudgetResult
iPadBrowserResultIfApplicable
generatedOutputSynchronizationResult
supportMatrixResult
unexplainedBlockingDivergenceCount
phase11ExitGateFullySatisfied
phase12Started
```

Do not hardcode expected green numbers into the product. Derive them from the actual exact-head run.

---

## 27. Suggested execution sequence when Phase 11 actually starts

### Step 1 — Re-read live truth

Refetch:

- `main` exact SHA;
- Master Architecture;
- Engineering Process Guardrails;
- Support Matrix + capability registry;
- Phase 10 release evidence/postmortem;
- current semantic/artifact/query APIs.

Do not assume this playbook's source paths are still exact.

### Step 2 — Freeze the Phase 11 contract

Produce:

- living integration branch/PR;
- ownership manifest;
- managed identity schema;
- VMEffects schema;
- frontend registration contract;
- artifact/version keys;
- verifier schema;
- canonical test runner;
- support-promotion tests.

### Step 3 — Build one tiny walking skeleton

Prefer WASM.

Required proof:

```text
bytes
→ detect
→ metadata
→ one method/function
→ VMEffects
→ Semantic IR
→ CFG/SSA
→ provenance query
→ UI/AnalysisQueryAPI visibility
```

Do this before broad opcode/parser coverage.

### Step 4 — Harden WASM until the shared contract stops moving rapidly

Only then parallelize DEX/CIL/JVM work.

### Step 5 — Add DEX/CIL/JVM as component lanes

Each lane:

- uses frozen shared contracts;
- owns only target-specific paths;
- reaches a vertical M0→M3 slice early;
- reports missing shared capabilities as explicit handoffs;
- targets living integration.

### Step 6 — Shared M4/M5 hardening

Once all four frontends can enter shared analysis, improve:

- managed type constraints;
- dispatch/call summaries;
- exception-aware HighIR;
- variable recovery for VM locals/registers;
- source-like rendering;
- cross-boundary native links.

Do this centrally where behavior is genuinely shared.

### Step 7 — Final exact-head proof

Run:

- all component tests;
- canonical Phase 11 runner;
- malformed corpus;
- shared semantic/decompiler regressions;
- managed independent verifier;
- target package performance/budget checks;
- generated-output checks where applicable;
- support-matrix consistency;
- candidate/current-main reconciliation;
- exact release-head CI.

Then promote only the measured maturity levels.

---

## 28. What can be prepared before Phase 11 begins

Useful work that is low-conflict with earlier phases:

1. keep this playbook updated with Phase 7–10 architecture changes;
2. define fixture/corpus provenance requirements;
3. collect tiny legally redistributable source fixtures for each VM target;
4. draft the VMEffects semantic vocabulary without committing implementation assumptions;
5. draft managed identity test vectors;
6. identify shared exception/call/type concepts that Semantic IR must already support;
7. ensure Phase 10 runtime-provider APIs do not assume native-only instruction/register identities;
8. ensure AnalysisQueryAPI concepts use generic entity/method identities rather than native addresses everywhere;
9. ensure ArtifactStore keys can include managed method identities;
10. keep M0–M6 capability truth fail-closed until real implementation arrives.

Avoid speculative code changes to earlier-phase core contracts merely to "prepare" Phase 11 unless an actual incompatibility is proven.

---

## 29. Decisions to make at Phase 11 preflight, not now

The following should stay open until the live Phase 10 product is inspected:

- exact file/module boundaries;
- whether `VMEffects` shares a physical schema file with MachineEffects or only a common interface;
- exact bytecode decoder implementation/library choices;
- exact WASM proposal/version support baseline;
- APK/AAB/JAR container integration boundaries after current `ContainerGraph` implementation is known;
- how much M4/M5 is required for every frontend versus allowed partial maturity;
- which runtime/debug capabilities count toward M6 in the available browser/backend deployment model;
- exact compiler/runtime corpus versions;
- exact CI partitioning after profiling real workloads.

Keeping these decisions open prevents this planning document from freezing assumptions that Phase 7–10 may invalidate.

---

## 30. Final rule of thumb

When a Phase 11 design choice is unclear, choose the option that preserves this chain:

```text
target bytes + authoritative metadata
        ↓
exact VM-native semantics
        ↓
VMEffects
        ↓
shared conservative analysis
        ↓
shared evidence/provenance
        ↓
high-level readability
```

If an implementation is easier only because it bypasses one of those layers, it is probably creating future integration debt.

Phase 11 should feel like **adding four frontends to one compiler/analysis platform**, not like bolting four decompilers onto Hex.
