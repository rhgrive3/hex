# Phase 6 checkpoint — RISC-V64 validation architecture

Durable record for the single authoritative Phase 6 branch,
`hex/p6-riscv64-integration`. It is written to be re-readable months later by
someone who was not here: what was frozen, what is actually proven, what is
deliberately not claimed, and how to re-run the proof.

The frozen machine-readable contract is `tools/validation/phase6/profile.json`.
Where this document and that file disagree, the file wins.

---

## What Phase 6 is for

Phase 6 is not "add RISC-V disassembly". It is the experiment that tells us
whether Hex's semantic stack is architecture-neutral in fact or only by
intention.

ARM64 and x86-64 both have a condition-code register. A middle-end built by
those two alone can quietly assume one exists. RISC-V has none: a conditional
branch compares two registers *inside the branch*. So RISC-V is the case that
makes a hidden flags assumption fail loudly instead of passing silently.

The exit condition is therefore not "RISC-V works". It is: RISC-V reaches the
same Semantic IR, CFG, SSA, MemorySSA, alias/dataflow and decompiler as the
other two, through the target plugin boundary, with no synthetic flags
register, no second semantic engine, and no hidden fallback.

---

## Phase 5 prerequisite audit

**Classification: `PHASE5-RELEASE-METADATA-DRIFT`.**

The merged Phase 5 product satisfies its frozen exit contract. Running
`tests/phase5/verification/compiler-corpus-pipeline.test.mjs` on the Phase 6
base commit `e90c5107f9c77d73687ee452d5042dcbe9e79ece` yields
`{"mandatory":144,"passed":144,"failed":0,"blocked":0,"notProven":0}`: all 144
mandatory tuples instantiated from the pinned Clang 18.1.3 / LLD 18.1.3
toolchain, decoded against an independent LLVM objdump oracle, lifted to exact
MachineEffects, and carried through the shared pipeline to the shared
decompiler. `npm run check` was green on the same commit.

Three release-truth surfaces had gone stale against that product:

| surface | stale claim | repaired to |
|---|---|---|
| `js/platform/capability-maturity.js` | x86-64 `implementedLevel: A1`, effects/CFG/SSA/decompiler all `unsupported` | `implementedLevel: A6`, `fullySatisfiedLevel: A1`, status `partial` |
| `reports/phase5/p5-6-required-corpus-gaps.json` | `a6ClaimAllowed: false`, 124 of 144 tuples missing | marked `SUPERSEDED`, historical record retained, pointer to the live gate |
| `docs/SUPPORT_MATRIX.md` | x86-64 projected as decode-only | projection of the repaired machine truth |

Nothing was inflated. Exact effects are proven for the mandatory corpus, not
for the whole instruction set, so A2 stays **partial** and — because a target
never gains a level by skipping an incomplete prerequisite — the cumulative
level stays **A1**, the same shape ARM64 already had.

The reason this drifted unnoticed is that nothing compared the declaration
against the evidence. `tests/phase6/foundation/capability-truth.test.mjs` now
does, and pins the exact stale shape so it cannot silently return.

---

## Frozen identities

| identity | value |
|---|---|
| ISA profile | `rv64imc` — RV64I + M + C, little-endian, ELFCLASS64 |
| ABI profiles | `lp64` exact; `lp64f` / `lp64d` recognised, integer-only exactness |
| toolchain | Clang 18.1.3 / LLD 18.1.3, target `riscv64-unknown-elf` |
| decoder | deployed `capstone.js` / `capstone.wasm`, Capstone 5.0, `ARCH_RISCV` + `MODE_RISCV64|MODE_RISCVC` |
| decoder semantic version | `capstone-5-riscv64-word-exact-v1` |
| architecture semantic version | `1.0.0-phase6-rv64imc` |
| canonical architecture id | `riscv64` |
| corpus | `phase6-riscv64-mandatory/v1` — 2 targets × 6 optimization levels × 22 categories = 264 tuples |
| verifier | `phase6-verifier/1.0.0` |

Explicitly **not** claimed: RV64G/GC, the A, F, D, Q and V extensions, Zicsr,
the privileged architecture, big-endian RISC-V, RV32, RVE, and custom
extensions. Encodings from those families decode to an explicit `unsupported`
record with a reason; they never become a state-preserving nop.

The `riscv64` id is canonical and singular. `rv64` is a normalized alias. A
bare `riscv` is deliberately **not** aliased: it does not say RV32 or RV64, and
inventing a width would create a second identity for the same profile. The ELF
loader folds the width in at parse time, so `EM_RISCV` + ELFCLASS64 yields
`riscv64` and nothing downstream has to guess.

---

## Decoder truth

Capstone is the canonical decode provider: it owns instruction boundaries and
lengths, which matters because the C extension makes the stream variable-width.

But its RISC-V printer normalises encodings to assembler pseudo-instructions
and drops architectural fields — `jal ra, off` and `jal zero, off` print with a
single immediate operand, `xori rd, rs1, -1` prints as `not`, and
`addi rd, x0, imm` prints as `li`. Recovering semantics from those strings
would be exactly the display-text reparsing the Master Architecture forbids,
and it would make a call indistinguishable from a jump.

So `js/targets/architecture/riscv64/instruction-word.js` decodes the
instruction word directly from the decoder-provided raw bytes, following the
official ISA encoding tables. Capstone's structured operands are retained and
used as an **independent cross-check**: every register and memory base Capstone
reports must appear among the fields Hex recovered. Across the mandatory
corpus that differential is zero mismatches.

---

## Generic repairs

RISC-V exposed three assumptions in generic code. Each was repaired
generically, because each was wrong for more than one architecture:

1. **Branch targets never resolved.** The shared semantic-function driver never
   supplied `rowOfAddress`, so `targetBlock` returned null, structured
   recovery bailed, and conditional branches produced no `if` — for **x86-64
   too**. The v2→v1 projection already proved the taken-edge block index, so
   the decompiler now uses that evidence directly instead of an address
   round-trip. x86-64 gained structured `if`/`else` recovery from this.

2. **`x0` hardcoded as the result register.** Generic decompiler core assumed
   AArch64's result register. On RISC-V `x0` is the *hardwired zero register*,
   so this did not merely lose the return value, it read the wrong location.
   Register roles now come from the ABI plugin via the semantic ABI adapter.

3. **`x0..x7` hardcoded as argument registers.** Generic type recovery reported
   RISC-V's stack pointer (`x2`) as a function argument. Argument registers now
   come from the ABI plugin too.

In all three cases the ABI-less legacy path keeps its previous AArch64
behaviour exactly, so ARM64 is unchanged.

`tests/phase6/generic-core/no-flags-register.test.mjs` additionally asserts
that no generic middle-end module names RISC-V or branches on an architecture
id, so a future fix cannot be smuggled in as a special case.

---

## Checkpoint sequence

| checkpoint | status | evidence |
|---|---|---|
| A — live preflight | done | base `e90c5107`, Phase 5 audit above |
| B — foundation | done | `tests/phase6/run.mjs`, `tools/validation/phase6/{profile.json,verify.mjs,release-evidence.schema.json}`, ownership manifest and gate, CI workflows |
| C — deployed decoder | done | `tests/phase6/decoder/**` probes the shipped bundle; profile pins its sha256 |
| D — target vertical | done | `tests/phase6/{registers,effects}/**` |
| E — ABI + ELF | done | `tests/phase6/{abi,elf}/**` |
| F — generic middle-end | done | `tests/phase6/generic-core/**`, `tests/phase6/cross-architecture/**` |
| G — decompiler / compiler truth | done | `tests/phase6/verification/compiler-corpus-pipeline.test.mjs` 264/264, `tests/phase6/verification/source-equivalence.test.mjs` 7,260 semantic checks |
| H — public capability / product | done | capability truth repaired first, `docs/SUPPORT_MATRIX.md` second; `Backend` route parameterized by architecture (`tests/phase6/vertical/**`), decode/probe workers wired, generated userscript rebuilt |
| I — current-main reconciliation | see PR | performed immediately before final exact-head verification |
| J — final exact verification | see PR | `npm run phase6:verify` verdict bound to the exact head |

Implementation preceded some of the Checkpoint B scaffolding in wall-clock
order. That is recorded here rather than smoothed over: the verifier was built
before the final product existed and has been re-run at every subsequent
checkpoint, which is the property the guardrail actually protects.

---

## What is proven

- 264/264 mandatory corpus tuples pass: 2 ELF targets (`ET_EXEC` and PIE
  `ET_DYN`, the latter carrying a real `R_RISCV_RELATIVE` relocation) × 6
  optimization levels (O0, O1, O2, O3, Os, Oz) × 22 semantic categories.
- 4,958 lifted instruction bundles, all `exact`. Zero partial, zero unknown,
  zero unsupported, zero hidden fallbacks, zero provenance losses.
- Decoder agrees with LLVM's disassembly on every boundary and byte, and with
  Capstone's independent structured operands on every register field.
- The lifter matches an independently written ISA reference model over ~26,000
  value combinations, including the defined division-by-zero and signed
  overflow results that RISC-V specifies instead of trapping.
- **Source-level semantic equivalence on real compiler output**: 7,260 checks
  across 12 fixtures × 11 functions. The actual compiled machine code is
  executed through the lifted MachineEffects by an interpreter that knows only
  the generic vocabulary, with the fixture's image mapped into memory so real
  `.rodata` jump tables resolve, and the result is compared against the C
  source's meaning transcribed independently. Exact effects can still be
  wrong effects; this is what rules that out.
- Every compressed encoding computes the same state as the base instruction it
  expands to, checked by differential evaluation rather than by inspection.
- ARM64, x86-64 and RISC-V64 lower an equivalent function through one pipeline
  version and one pipeline path, recovering the same block count and the same
  two conditional edges. ARM64 and x86-64 use flag effects; RISC-V uses none.
- The same three architectures also recover an equivalent **loop** identically:
  same back edge, same block count, phi placement by the same generic SSA pass,
  and again no flag state on the RISC-V side. The cross-architecture claim is
  therefore not resting on a single trivial branch.
- The production classic decode worker decodes RISC-V in a real Chromium
  browser from the deployed `capstone.wasm`, without cross-origin isolation or
  SharedArrayBuffer, with ARM64 and x86-64 unregressed.
- The production `Backend` routes RISC-V through the shared semantic-function
  artifact: correct architecture at the decode-worker boundary, exact effects,
  no flag state, shared decompiler, and warm artifact reuse that does not
  recompute. An ABI belonging to another architecture, or an unregistered
  architecture, is refused rather than routed as something else.

## What is not proven

- Exact effects outside the RV64IMC profile. A/F/D/Q/V, Zicsr and the
  privileged architecture are unsupported by declaration, not by omission.
- Floating-point argument classification for `lp64f` / `lp64d`. Those ABIs are
  recognised from ELF `e_flags` and classify integer arguments exactly; their
  small-aggregate flattening rules are explicitly partial.
- Types / interprocedural analysis (A5) for RISC-V specifically. RISC-V reaches
  the shared implementation, but the mandatory corpus does not prove that stage
  independently, so it is declared `partial`.
- Runtime / debug / patch validation (A7). Phase 6 does not claim it.
- RISC-V relocation coverage beyond what the corpus links. Unsupported
  relocation types remain explicit rather than fabricated.

---

## How to re-verify

```
npm run phase6:test        # canonical Phase 6 suite
npm run phase6:verify      # permanent verifier; writes reports/phase6/
npm run phase6:browser     # real-browser WASM decode proof (needs Playwright)
npm run check              # the canonical repository gate, which includes phase6:test
```

The verifier binds its verdict to the exact commit and tree, the frozen
profile, the corpus digest, the toolchain identity, and the deployed decoder
hashes. It publishes atomically and refuses to emit `READY` when mandatory
coverage is missing, the tree is dirty, or the decoder does not match the
frozen profile. Its output is not committed: a report that named the commit
containing it would dirty the tree it had just verified.

If the branch head moves for any reason after a verification, that verification
no longer describes the new head. Re-run it.
