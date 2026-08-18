# Hex Research Sources

> Durable primary-source index for the **Hex Universal Binary Analysis Platform** research and architecture work.
>
> This file intentionally uses **canonical URLs** instead of ChatGPT-internal citation IDs such as `turn13search1` or `turn2file0`, because those IDs are session-local and are not suitable as long-lived engineering references.

## Verification metadata

- Last source review: **2026-08-16 (JST)**
- Hex repository: `rhgrive3/hex`
- Hex repository URL: https://github.com/rhgrive3/hex
- Hex snapshot used when this source index was created: `11a0cf272d1f07fa74b228ada1fe2b2e2294636e`
- Snapshot permalink: https://github.com/rhgrive3/hex/commit/11a0cf272d1f07fa74b228ada1fe2b2e2294636e
- Companion research report: `deep-research-report.md` / `Hex Universal Binary Analysis Platform — Deep Research / Gap Analysis / Ideal Architecture`

## Source policy

Use sources in this order:

1. **Hex source code at a pinned commit** — source of truth for what Hex currently implements.
2. **Official upstream source repositories** — source of truth for open-source implementations.
3. **Official vendor/developer documentation** — source of truth for proprietary products and public APIs.
4. **Original papers / project technical manuals** — source of truth for algorithms and architecture rationale.
5. Secondary articles only when a primary source does not cover the required point.

Rules:

- Do not use leaked or unauthorized proprietary source code.
- Do not treat a marketing feature page as proof of an internal algorithm when public implementation details are unavailable.
- Do not infer “Memory SSA”, “SSA”, “SMT-backed”, “formal semantics”, etc. merely because a tool has a decompiler.
- For code reuse, verify the exact `LICENSE` file at the **pinned dependency commit/tag** before import.
- Copyleft/proprietary projects may still be excellent **design references** without being code-reuse candidates.
- Prefer permalinks to a commit/tag when a specific implementation detail is cited in an ADR, benchmark, issue, or PR.

---

# 1. Hex — source of truth

## Repository

- Repository: https://github.com/rhgrive3/hex
- Snapshot used for this research: https://github.com/rhgrive3/hex/commit/11a0cf272d1f07fa74b228ada1fe2b2e2294636e
- README: https://github.com/rhgrive3/hex/blob/11a0cf272d1f07fa74b228ada1fe2b2e2294636e/README.md
- JavaScript source tree: https://github.com/rhgrive3/hex/tree/11a0cf272d1f07fa74b228ada1fe2b2e2294636e/js
- Documentation: https://github.com/rhgrive3/hex/tree/11a0cf272d1f07fa74b228ada1fe2b2e2294636e/docs
- Tests: https://github.com/rhgrive3/hex/tree/11a0cf272d1f07fa74b228ada1fe2b2e2294636e/tests

## High-value Hex paths to track

These are the areas referenced by the architecture/gap-analysis report. Paths should be revalidated when the repository is reorganized.

- Architecture adapters / architecture abstraction: https://github.com/rhgrive3/hex/tree/11a0cf272d1f07fa74b228ada1fe2b2e2294636e/js/architecture
- Semantic IR core: https://github.com/rhgrive3/hex/blob/11a0cf272d1f07fa74b228ada1fe2b2e2294636e/js/ir-core.js
- Semantic IR integration: https://github.com/rhgrive3/hex/blob/11a0cf272d1f07fa74b228ada1fe2b2e2294636e/js/ir.js
- Decompiler: https://github.com/rhgrive3/hex/tree/11a0cf272d1f07fa74b228ada1fe2b2e2294636e/js/decompiler
- AI/evidence plane: https://github.com/rhgrive3/hex/tree/11a0cf272d1f07fa74b228ada1fe2b2e2294636e/js/ai
- Runtime subsystem: https://github.com/rhgrive3/hex/tree/11a0cf272d1f07fa74b228ada1fe2b2e2294636e/js/runtime
- Symbolic subsystem: https://github.com/rhgrive3/hex/tree/11a0cf272d1f07fa74b228ada1fe2b2e2294636e/js/symbolic
- Project/persistence subsystem: https://github.com/rhgrive3/hex/tree/11a0cf272d1f07fa74b228ada1fe2b2e2294636e/js/project
- Plugin API: https://github.com/rhgrive3/hex/blob/11a0cf272d1f07fa74b228ada1fe2b2e2294636e/js/platform/plugin-api.js
- Plugin registry/integration: https://github.com/rhgrive3/hex/blob/11a0cf272d1f07fa74b228ada1fe2b2e2294636e/js/plugins.js
- Binary/loader subsystem: https://github.com/rhgrive3/hex/tree/11a0cf272d1f07fa74b228ada1fe2b2e2294636e/js/binary
- Capstone browser build currently shipped by Hex: https://github.com/rhgrive3/hex/blob/11a0cf272d1f07fa74b228ada1fe2b2e2294636e/capstone.js

### Research role

**P0 / authoritative.** All statements of the form “Hex currently has X”, “Hex currently lacks Y”, or “Hex does Z conservatively” must ultimately be checked against the current source tree and regression tests, not only this research report.

---

# 2. IDA Pro / Hex-Rays

## Official documentation

- Hex-Rays documentation home: https://docs.hex-rays.com/
- Developer guide: https://docs.hex-rays.com/developer-guide
- C++ SDK: https://docs.hex-rays.com/developer-guide/cpp-sdk
- Type system/user types: https://docs.hex-rays.com/user-guide/types
- FLIRT signatures: https://docs.hex-rays.com/user-guide/signatures/flirt

## Research role

- Mature disassembly/decompilation workflow
- Long-lived analysis database model
- Type libraries / reusable type knowledge
- FLIRT-style function/library recognition
- Microcode/decompiler pass concepts where publicly documented
- Navigation/xref ergonomics

## Adoption guidance

**Study / adapt concepts.** IDA/Hex-Rays is proprietary. Public SDK/documentation is valid reference material; non-public implementation details must not be assumed.

---

# 3. Binary Ninja

## Official documentation and repositories

- BNIL overview: https://docs.binary.ninja/dev/bnil-overview.html
- Developer guide: https://docs.binary.ninja/dev/index.html
- Medium Level IL: https://docs.binary.ninja/dev/bnil-mlil.html
- WARP function recognition: https://docs.binary.ninja/guide/warp.html
- Debugger guide: https://docs.binary.ninja/guide/debugger/index.html
- Public API repository: https://github.com/Vector35/binaryninja-api
- Vector 35 organization/repositories: https://github.com/Vector35

## Research role

- Layered IL design
- SSA exposed as a stable analysis API
- BinaryView/Function-style programmable object model
- Analysis/query ergonomics
- Background/incremental analysis model
- WARP/signature knowledge
- Debugger API separation

## Adoption guidance

**Study / adapt concepts.** Binary Ninja is proprietary; its public API and documentation are the reference boundary.

---

# 4. Ghidra — SLEIGH / P-code / Decompiler

## Official repository and technical documentation

- Ghidra repository: https://github.com/NationalSecurityAgency/ghidra
- Processor languages / SLEIGH documentation index: https://ghidra.re/ghidra_docs/languages/index.html
- SLEIGH overview/manual: https://ghidra.re/ghidra_docs/languages/html/sleigh.html
- SLEIGH reference: https://ghidra.re/ghidra_docs/languages/html/sleigh_ref.html

## Source areas worth studying

- Processor specifications: https://github.com/NationalSecurityAgency/ghidra/tree/master/Ghidra/Processors
- Decompiler source: https://github.com/NationalSecurityAgency/ghidra/tree/master/Ghidra/Features/Decompiler

## Research role

**P0 architecture reference.** Primary reference for:

- Retargetable machine semantics
- Explicit address spaces / varnodes
- P-code as architecture-neutral machine effects
- Language specification separation
- Open decompiler middle-end and structuring design
- Analyzer/pass architecture

## License note

Ghidra is distributed under Apache-2.0; still verify individual bundled/third-party components before copying code.

---

# 5. rev.ng

## Official sources

- Repository: https://github.com/revng/revng
- Documentation: https://docs.rev.ng/
- What is rev.ng: https://docs.rev.ng/what-is-revng/
- Model: https://docs.rev.ng/user-manual/key-concepts/model/
- Artifacts and analyses: https://docs.rev.ng/user-manual/key-concepts/artifacts-and-analyses/
- Pipeline reference: https://docs.rev.ng/references/pipeline/

## Research role

- Compiler/pipeline-oriented binary analysis
- Model vs derived artifact separation
- Reproducible analysis artifacts
- Pass/pipeline discipline
- LLVM-oriented decompilation architecture

## License note

**Inspect file/component-level licensing before reuse.** rev.ng includes/depends on components with different licensing constraints. Treat as a design reference unless a particular reusable file/library has been verified.

---

# 6. angr ecosystem

## Official sources

- angr repository: https://github.com/angr/angr
- Documentation: https://docs.angr.io/en/latest/
- angr organization: https://github.com/angr
- CLE loader: https://github.com/angr/cle
- pyvex: https://github.com/angr/pyvex
- Claripy: https://github.com/angr/claripy
- archinfo: https://github.com/angr/archinfo
- angr-management: https://github.com/angr/angr-management

## Research role

- Explicit symbolic program state
- Path exploration
- Solver abstraction
- SimProcedure/library-call modeling
- CFG recovery approaches
- VEX-based architecture normalization
- Static + symbolic program reasoning

## License note

angr core is BSD-2-Clause; verify each ecosystem repository independently before reuse.

---

# 7. Triton

## Official sources

- Repository: https://github.com/JonathanSalwan/Triton
- Documentation/API: https://triton-library.github.io/
- Wiki/examples: https://github.com/JonathanSalwan/Triton/wiki

## Canonical paper

- Florent Saudel, Jonathan Salwan, **“Triton: A Dynamic Symbolic Execution Framework”**, SSTIC 2015. The upstream repository contains the canonical project citation and publication references.

## Research role

- Dynamic symbolic execution
- Taint analysis
- Symbolic AST
- SMT solver abstraction (Z3 / Bitwuzla)
- Instruction-level symbolic semantics
- Concolic workflows

## License note

Apache-2.0 in the upstream repository. Verify dependency licenses separately.

---

# 8. Miasm

## Official source

- Repository: https://github.com/cea-sec/miasm
- Project site: https://miasm.re/

## Research role

- Own intermediate representation and ISA semantics
- Symbolic execution
- Expression simplification
- JIT-backed execution of lifted IR
- Reverse-engineering research framework design

## License note

GPL-2.0. Prefer as a **design/reference implementation** unless Hex distribution strategy is compatible.

---

# 9. Binary Analysis Platform (BAP)

## Official sources

- Repository: https://github.com/BinaryAnalysisPlatform/bap
- Organization: https://github.com/BinaryAnalysisPlatform
- Formal BIL repository: https://github.com/BinaryAnalysisPlatform/bil

## Research role

- Architecture-independent binary analysis
- Knowledge/fact-oriented program analysis
- BIL semantics
- Extensible analyzers and interpreters
- Symbolic/micro-execution concepts

## License note

BAP repository uses MIT licensing. Verify satellite projects independently.

---

# 10. Rizin / Cutter / rz-ghidra

## Official sources

- Rizin repository: https://github.com/rizinorg/rizin
- Rizin book: https://book.rizin.re/
- Cutter repository: https://github.com/rizinorg/cutter
- Cutter documentation: https://cutter.re/docs/
- rz-ghidra: https://github.com/rizinorg/rz-ghidra

## Research role

- Modular IO/bin/analysis/debug architecture
- Backend/frontend separation
- Plugin architecture
- Graph/navigation UI
- Integration of independent decompiler engines

## License note

Rizin/Cutter ecosystem contains LGPL/GPL-licensed components. Verify the exact component and linking/distribution model before reuse.

---

# 11. radare2

## Official sources

- Repository: https://github.com/radareorg/radare2
- Official book: https://book.rada.re/

## Research role

- IO abstraction
- Remote/range-backed binary access
- Patching/write workflows
- Debugger architecture
- Broad binary-format/architecture plugin ecosystem
- CLI/scriptability lessons

## Adoption guidance

Good architectural reference for modular IO and patching. Avoid making opaque textual command strings the primary Hex semantic/API boundary.

---

# 12. REDasm

## Official source

- Repository: https://github.com/REDasmOrg/REDasm

## Research role

- Relatively compact loader/processor/analyzer/plugin boundaries
- Native interactive disassembler architecture

## License note

GPL-3.0. Primarily a design/reference source for Hex unless licensing is deliberately compatible.

---

# 13. Glass

## Official source

- Repository: https://github.com/azw413/Glass

## Research role

- Modern mobile-app-first disassembler design
- Rust/native architecture
- AArch64/ARMv7 and mobile application formats
- APK/DEX/IPA/Mach-O/ELF workflows
- Objective-C / Swift intelligence
- Shared GUI/CLI/API/MCP concepts
- Content-addressed/persistent analysis artifacts

## License note

The current repository is GPL-3.0-oriented. Treat architecture as a reference unless code-reuse licensing is explicitly resolved.

---

# 14. Frida / Gum

## Official sources

- Frida Gum repository: https://github.com/frida/frida-gum
- Gum API: https://frida.re/docs/gum-api/
- Interceptor: https://frida.re/docs/gum/class.Interceptor.html
- Stalker API: https://frida.re/docs/gum/class.Stalker.html
- Stalker guide: https://frida.re/docs/stalker/

## Research role

**P1 runtime reference.** Primary reference for:

- Runtime instrumentation providers
- Function interception
- Execution tracing
- Memory/process observation
- Host/agent separation

## Hex integration principle

Runtime observations should enter Hex as timestamped/provenanced **RuntimeEvidence**, not silently overwrite static semantic facts.

---

# 15. Unicorn Engine

## Official sources

- Repository: https://github.com/unicorn-engine/unicorn
- Documentation: https://www.unicorn-engine.org/docs/

## Research role

- Lightweight CPU emulation
- Architecture-neutral memory/register/hook API
- Optional execution backend/reference

## License note

GPL-2.0. Treat as optional/service/reference unless Hex distribution licensing is compatible.

---

# 16. Qiling

## Official sources

- Repository: https://github.com/qilingframework/qiling
- Documentation: https://docs.qiling.io/

## Research role

- Executable/OS-level emulation
- Loader + OS personality + syscall modeling
- Filesystem/runtime abstraction
- Firmware-oriented workflows

## License note

GPL-2.0. Prefer optional backend/service or design reference unless compatible with Hex licensing.

---

# 17. QEMU / TCG

## Official sources

- TCG intermediate operations: https://www.qemu.org/docs/master/devel/tcg-ops.html
- TCG internals: https://www.qemu.org/docs/master/devel/tcg.html
- Emulation overview: https://www.qemu.org/docs/master/about/emulation.html

## Research role

- Mature multi-architecture dynamic translation
- Translation-block lifecycle/caching
- User/system-mode emulation architecture
- Architecture semantics and execution testing reference

## Adoption guidance

Do **not** use TCG as Hex’s canonical analysis IR. TCG is optimized for execution; Hex requires provenance-preserving analysis semantics.

---

# 18. LLDB

## Official sources

- LLDB project: https://lldb.llvm.org/
- Remote debugging: https://lldb.llvm.org/use/remote.html
- LLVM monorepo LLDB source: https://github.com/llvm/llvm-project/tree/main/lldb

## Research role

- Target / Process / Thread / Platform separation
- ABI and object/symbol plugins
- Remote debugger transport
- Host/target decoupling

## Hex integration principle

Model debugger integration as a provider/transport boundary rather than mixing live target state into immutable static project facts.

---

# 19. GDB

## Official sources

- Online documentation: https://www.sourceware.org/gdb/current/onlinedocs/
- Remote debugging chapter: https://sourceware.org/gdb/current/onlinedocs/gdb.html/Remote-Debugging.html
- Source repository browser: https://sourceware.org/git/?p=binutils-gdb.git

## Research role

- Mature remote-target protocol/ecosystem
- Breakpoints/watchpoints/process control
- Debugger target abstraction

## License note

GPL. Use protocol/design knowledge with appropriate licensing review; do not casually copy GPL implementation code into an incompatible distribution.

---

# 20. x64dbg

## Official sources

- Repository: https://github.com/x64dbg/x64dbg
- Documentation: https://help.x64dbg.com/en/latest/index.html

## Research role

- Beginner-visible debugger state
- Registers/stack/memory synchronization
- Low-friction patch/debug UI
- Windows x86/x64 debugger ergonomics

## License note

GPL-3.0 project; verify bundled dependency licenses separately.

---

# 21. WinDbg / DbgEng

## Official Microsoft documentation

- Debugger introduction: https://learn.microsoft.com/en-us/windows-hardware/drivers/debugger/introduction
- Debugger Engine and Extension APIs: https://learn.microsoft.com/en-us/windows-hardware/drivers/debugger/debugger-engine-and-extension-apis

## Research role

- Engine/UI separation
- Windows symbols/PDB ecosystem
- Kernel/user-mode target models
- Time-indexed/debug-data concepts

## Adoption guidance

Reference architecture/API behavior only. WinDbg/DbgEng is proprietary Microsoft technology.

---

# 22. Capstone

## Official sources

- Repository: https://github.com/capstone-engine/capstone
- Documentation: https://www.capstone-engine.org/documentation.html

## Research role

**P0/P1 decoder reference.** Useful for:

- Broad multi-architecture decoding
- Differential decoder testing
- Operand/detail extraction
- Browser/WASM decoder backend strategies

## Important limitation

A decoder is **not** a complete semantic lifter. Hex should normalize Capstone output into Hex-owned `DecodedInstruction` and then perform Hex-owned semantic lifting.

---

# 23. LLVM MC / TableGen

## Official sources

- LLVM MC command/tool documentation: https://llvm.org/docs/CommandGuide/llvm-mc.html
- TableGen documentation: https://llvm.org/docs/TableGen/index.html
- LLVM source: https://github.com/llvm/llvm-project

## Research role

- Generated architecture metadata
- Assembly/disassembly infrastructure
- `MCInst`/target description concepts
- Differential decoder/assembler oracle

## Important limitation

`MCInst` is a machine-instruction representation, not Hex’s desired architecture-neutral semantic truth.

---

# 24. Keystone Engine

## Official source

- Repository: https://github.com/keystone-engine/keystone

## Research role

- Multi-architecture assembly backend
- Patching/assemble workflow reference

## License note

Keystone has GPL/commercial licensing considerations. Verify the exact release and intended distribution model before integrating.

---

# 25. LIEF

## Official sources

- Repository: https://github.com/lief-project/LIEF
- Documentation: https://lief.re/doc/stable/

## Research role

**P1 loader/rebuilder reference.** Useful for:

- ELF / PE / Mach-O parsing
- Binary modification/rebuilding
- Relocations/imports/exports/sections
- Differential parser testing

## Hex integration principle

Use as an oracle or optional backend where useful, while retaining Hex-owned hostile-input budgets, provenance, and validation.

## License note

Apache-2.0 upstream project; verify bundled dependencies and selected features.

---

# 26. Rust `object`

## Official sources

- Repository: https://github.com/gimli-rs/object
- API documentation: https://docs.rs/object/

## Research role

- Lightweight generic object-file abstraction
- ELF/Mach-O/PE/COFF/Wasm/XCOFF/archive coverage
- Differential parsing reference

## Important security/scope note

The project documentation explicitly scopes the library toward object-file processing and warns that it is not intended to reproduce every platform loader behavior or necessarily serve as a hardened arbitrary-malware loader. Hex should keep its own hostile-input validation/resource budgets.

## License note

MIT OR Apache-2.0.

---

# 27. goblin

## Official sources

- Repository: https://github.com/m4b/goblin
- Documentation: https://www.m4b.io/goblin/goblin/index.html

## Research role

- Rust executable/object parsing
- ELF/Mach-O/PE/archive parsing reference
- Lightweight parser architecture

## License note

Verify the current crate/repository license at the pinned release before reuse.

---

# 28. Kaitai Struct

## Official sources

- Repository: https://github.com/kaitai-io/kaitai_struct
- Project site: https://kaitai.io/
- User guide: https://doc.kaitai.io/user_guide.html

## Research role

- Declarative binary format grammars
- Generated parsers
- Ancillary/container/debug-format schema ideas

## Important limitation

Declarative layout parsing does not replace executable-loader semantics such as relocations, symbol binding, mapped address spaces, ABI/runtime metadata, or provenance.

---

# 29. Construct

## Official sources

- Repository: https://github.com/construct/construct
- Documentation: https://construct.readthedocs.io/en/latest/intro.html

## Research role

- Declarative/symmetric binary parsing
- Lazy parsing and pointer-like structures
- Schema ergonomics reference

---

# 30. ImHex / Pattern Language

## Official sources

- ImHex repository: https://github.com/WerWolv/ImHex
- ImHex documentation: https://docs.werwolv.net/imhex
- Pattern Language repository: https://github.com/WerWolv/PatternLanguage
- Pattern database: https://github.com/WerWolv/ImHex-Patterns

## Research role

**P1/P2 UX/data-interpretation reference.** Primary inspiration for:

- Typed binary structures over raw bytes
- Safe declarative binary templates
- Lazy data interpretation
- Bookmarks/visualization
- Hex-editor extensibility

## License note

ImHex main project is GPL-2.0-oriented; Pattern Language/lib components have separate licensing. Verify the exact component before reuse.

---

# 31. RetDec

## Official source

- Repository: https://github.com/avast/retdec

## Research role

- Open retargetable decompiler reference
- LLVM-based decompilation pipeline
- Function/type/signature/debug-info reconstruction ideas
- Regression corpus/reference implementation

## Maintenance note

The upstream project is no longer the most active state-of-the-art decompiler reference; use primarily for architectural comparison and tests rather than as the main design target.

---

# 32. JADX

## Official sources

- Repository: https://github.com/skylot/jadx
- Plugin guide: https://github.com/skylot/jadx/wiki/Jadx-plugins-guide
- Library usage: https://github.com/skylot/jadx/wiki/Use-jadx-as-a-library

## Research role

**P2 managed-runtime reference.** Useful for:

- DEX/APK/AAB frontend design
- Managed-runtime metadata-first analysis
- Java-source reconstruction
- Find-usage/navigation UX

## Hex architecture lesson

DEX should have a dedicated managed-code frontend preserving registers/types/metadata, then bridge into shared higher-level Hex semantics. Do not force it through a native machine-code frontend first.

## License note

Apache-2.0.

---

# 33. ILSpy

## Official source

- Repository: https://github.com/icsharpcode/ILSpy

## Research role

**P2 managed-runtime reference.** Useful for:

- .NET metadata-first decompilation
- CIL frontend architecture
- Nominal types/signatures/generics
- Managed-code source reconstruction

## License note

MIT.

---

# 34. Remill

## Official source

- Repository: https://github.com/lifting-bits/remill

## Research role

- Machine-code-to-LLVM lifting
- ISA semantic implementation reference
- Differential semantics testing
- Lifter validation research

## License note

Verify the current upstream license and any architecture/dependency-specific components before code reuse.

---

# 35. Rellic

## Official source

- Repository: https://github.com/lifting-bits/rellic

## Research role

- LLVM-bitcode-to-structured-C reconstruction
- Control-flow structuring/decompilation research reference
- Benchmark/reference for goto reduction and high-level reconstruction

## Adoption guidance

Research/reference value is higher than direct architectural fit: Hex should keep its provenance-preserving Semantic IR rather than make LLVM IR its only source of truth.

---

# 36. BinDiff

## Official source

- Repository: https://github.com/google/bindiff

## Canonical papers referenced by upstream

The BinDiff repository/README links the original graph/structural binary comparison literature, including:

- Thomas Dullien, Rolf Rolles — **Graph-Based Comparison of Executable Objects** (SSTIC 2005)
- Halvar Flake — **Structural Comparison of Executable Objects** (DIMVA 2004)

Use the upstream repository’s current “Further reading” references when pinning paper URLs in an ADR or design document.

## Research role

- Function/basic-block graph matching
- Staged binary similarity
- Diff navigation
- Name/comment transfer concepts

## Hex architecture lesson

A Hex match should expose the features/reasons contributing to its score, not return a single opaque similarity number.

## License note

Apache-2.0 upstream repository.

---

# 37. Diaphora

## Official source

- Repository: https://github.com/joxeankoret/diaphora

## Research role

- Heterogeneous function-match features
- CFG/callgraph/assembly/pseudocode diffing
- Patch-diff workflow
- Explainable feature fusion inspiration

## License note

AGPL-3.0 in current major versions. Prefer design/reference use unless Hex’s distribution/service obligations are deliberately compatible.

---

# 38. YARA / YARA-X

## Official sources

- YARA-X repository: https://github.com/VirusTotal/yara-x
- YARA-X documentation: https://virustotal.github.io/yara-x/
- Classic YARA repository: https://github.com/VirusTotal/yara

## Research role

- Deterministic signature/rule matching
- Byte/text/metadata conditions
- Rule language design
- Signature evidence source

## Direction

For new integrations, evaluate YARA-X first; keep classic YARA compatibility only when ecosystem needs justify it.

## License note

YARA-X is BSD-3-Clause upstream. Verify classic YARA separately for the selected version/components.

---

# 39. capa

## Official sources

- capa repository: https://github.com/mandiant/capa
- capa-rules repository: https://github.com/mandiant/capa-rules
- Rule format documentation: https://github.com/mandiant/capa-rules/blob/master/doc/format.md

## Research role

**P1 semantic-capability reference.** Primary inspiration for:

- Instruction/basic-block/function/file scoped features
- Deterministic capability inference
- Rule matches as evidence-backed semantic claims
- Beginner-facing high-level explanations grounded in lower-level facts

## Hex architecture lesson

`CapabilityFact` should retain the constituent evidence IDs that caused the rule to match, allowing:

`Capability -> Semantic Fact -> IR -> Instruction -> Binary Offset`

## License note

Verify the exact licenses of the engine and selected rule repositories independently before bundling or redistributing them.

---

# 40. Additional compiler/ISA specification sources

These are not replacement RE platforms, but they are useful for validating ABI/ISA semantics.

## Arm

- Arm architecture resources: https://developer.arm.com/architectures
- AAPCS / ABI specifications: https://github.com/ARM-software/abi-aa

## RISC-V

- RISC-V ISA manual: https://github.com/riscv/riscv-isa-manual
- RISC-V ELF psABI: https://github.com/riscv-non-isa/riscv-elf-psabi-doc

## x86 / AMD64 ABI

- Intel software developer manuals: https://www.intel.com/content/www/us/en/developer/articles/technical/intel-sdm.html
- System V AMD64 ABI project: https://gitlab.com/x86-psABIs/x86-64-ABI
- Microsoft x64 calling convention: https://learn.microsoft.com/en-us/cpp/build/x64-calling-convention

## LLVM

- LLVM Language Reference: https://llvm.org/docs/LangRef.html
- LLVM source: https://github.com/llvm/llvm-project

## Research role

Use architecture vendor/ABI specifications to validate register semantics, calling conventions, unwind rules, relocation behavior, flags, atomics, SIMD, and edge cases. Third-party disassemblers should not be the only semantic authority.

---

# 41. Mapping: Hex design decision -> primary references

| Hex design area | Primary references | Why |
|---|---|---|
| Exact `MachineEffects` / retargetable semantics | Ghidra SLEIGH/P-code, ISA manuals, Remill | Explicit machine effects and cross-architecture validation |
| Layered Semantic IR / High IR projections | Binary Ninja BNIL, Ghidra decompiler | Separate exact effects from analyst-friendly representations |
| Generic SSA / dataflow | Binary Ninja, Ghidra, compiler literature | Stable use-def/dataflow APIs |
| Memory/alias conservatism | Ghidra, compiler analysis literature, Hex current IR | Avoid unsound load/store simplification |
| Function signatures / reusable knowledge | IDA FLIRT/TIL, Binary Ninja WARP, Ghidra FID, YARA-X | Library/type recognition and deterministic knowledge |
| Artifact/pass architecture | rev.ng, Ghidra analysis manager | Reproducible incremental derived artifacts |
| Symbolic execution | angr, Triton | Explicit state, solver abstraction, path constraints |
| Runtime instrumentation | Frida Gum | Interception and trace evidence |
| Debugger providers | LLDB, GDB, WinDbg | Target/process/platform/transport separation |
| Emulation | Unicorn, Qiling, QEMU | CPU/OS execution backends |
| IO / plugin modularity | Rizin, radare2 | Independent binary IO, formats, analysis, debugger modules |
| Hex/data interpretation | ImHex Pattern Language, Kaitai Struct | Typed declarative interpretation of bytes |
| Managed DEX frontend | JADX | Metadata-first Android bytecode analysis |
| Managed CLR frontend | ILSpy | Metadata-first CIL/.NET analysis |
| Binary parsing/rebuild | LIEF, Rust `object`, goblin | Differential loader tests and optional backends |
| Decoder/assembler backends | Capstone, LLVM MC, Keystone | Broad architecture coverage without conflating decoding with semantics |
| Binary diff | BinDiff, Diaphora | Multi-stage explainable matching |
| Capability facts | capa | Deterministic high-level semantic claims from lower-level evidence |
| Mobile-first artifact/API model | Glass | Modern mobile-first analysis workflow and shared frontend concepts |
| Beginner debugger ergonomics | x64dbg, Cutter | Machine state and graph/navigation visibility |

---

# 42. License/reuse triage

This is an engineering triage, **not legal advice**. Always re-check the exact dependency/version/commit.

| Project | High-level reuse posture for Hex | Notes |
|---|---|---|
| Ghidra | Permissive candidate / study | Apache-2.0 main project; verify third-party files |
| angr | Permissive candidate / study | BSD-2-Clause core; ecosystem repos vary |
| Triton | Permissive candidate / study | Apache-2.0 upstream |
| BAP | Permissive candidate / study | MIT upstream |
| LIEF | Permissive candidate / study | Apache-2.0 upstream |
| Rust `object` | Permissive candidate / study | MIT OR Apache-2.0 |
| Capstone | Permissive candidate / study | BSD-family upstream; verify release |
| LLVM | Permissive candidate / study | Apache-2.0 WITH LLVM-exception |
| BinDiff | Permissive candidate / study | Apache-2.0 upstream |
| JADX | Permissive candidate / study | Apache-2.0 |
| ILSpy | Permissive candidate / study | MIT |
| YARA-X | Permissive candidate / study | BSD-3-Clause |
| IDA/Hex-Rays | Reference/API only | Proprietary |
| Binary Ninja | Reference/API only | Proprietary |
| WinDbg | Reference/API only | Proprietary Microsoft technology |
| rev.ng | Verify component-level | Mixed/dependency constraints; do not assume blanket permissive reuse |
| Rizin/radare2 | Conditional | LGPL/GPL component boundaries require review |
| Cutter | Strong-copyleft caution | GPL-oriented |
| REDasm | Strong-copyleft caution | GPL-3.0 |
| Glass | Strong-copyleft caution | GPL-3.0-oriented current repo |
| Miasm | Strong-copyleft caution | GPL-2.0 |
| Unicorn | Strong-copyleft caution | GPL-2.0 |
| Qiling | Strong-copyleft caution | GPL-2.0 |
| GDB | Strong-copyleft caution | GPL |
| x64dbg | Strong-copyleft caution | GPL-3.0 |
| Diaphora | Network-copyleft caution | AGPL-3.0 |
| Keystone | Dual/GPL caution | Check exact distribution/commercial terms |
| ImHex | Component-level review | Main project and Pattern Language components differ |
| capa | Component-level review | Check engine and rule set independently |
| Remill/Rellic | Verify pinned commit | Check current LICENSE and dependency chain before reuse |

---

# 43. What should be cited for common Hex architecture claims

## “Hex needs architecture-neutral machine semantics”

Use:

- Ghidra SLEIGH/P-code documentation
- ARM/RISC-V/x86 ISA specifications
- Remill for independent lifting reference
- Hex current `ir-core.js` / architecture modules

## “Hex should expose multiple semantic levels without multiple competing truths”

Use:

- Binary Ninja BNIL overview
- Ghidra P-code/decompiler architecture
- Hex decompiler/IR source

## “Hex symbolic execution should use an explicit state and pluggable solver backend”

Use:

- angr docs/repositories
- Triton repository/API
- Hex current symbolic executor

## “Runtime observations must remain evidence, not overwrite static truth”

Use:

- Frida Gum / Interceptor / Stalker docs
- LLDB target/process/remote architecture
- Hex AI/evidence/runtime source

## “Managed targets should use metadata-first frontends”

Use:

- JADX for DEX
- ILSpy for CLR/CIL

## “Decompiler/diff conclusions should be explainable”

Use:

- capa rule/scoping model
- BinDiff / Diaphora matching architecture
- Hex evidence graph/source mapping

## “Large-binary analysis should be artifact-based, demand-driven, and persistent”

Use:

- rev.ng artifacts/pipeline/model docs
- Binary Ninja analysis architecture documentation where publicly documented
- Ghidra project/analyzer design
- Glass persistent/artifact architecture
- Hex worker/cache/project implementation

---

# 44. Maintenance procedure

When this file is updated:

1. Record the current Hex commit SHA in **Verification metadata**.
2. Check every P0/P1 upstream project for repository moves or documentation URL changes.
3. Re-check license classification before any code is imported or linked.
4. Prefer a tagged documentation version or commit permalink for ADRs and implementation PRs.
5. Add new papers only when the original publication/project page can be located.
6. Do not delete an old source merely because a newer tool exists if an implemented Hex design still derives from it.
7. If an upstream project becomes archived/unmaintained, mark it as **historical/reference** rather than silently removing it.
8. Keep the companion research report and this file separate:
   - Research report = conclusions, comparisons, roadmap, gap analysis.
   - `SOURCES.md` = durable evidence/reference index.

---

# 45. Recommended citation format inside future Hex docs

For architecture/design docs, use a short source block such as:

```md
### References

- Ghidra SLEIGH specification: https://ghidra.re/ghidra_docs/languages/html/sleigh.html
- Binary Ninja BNIL overview: https://docs.binary.ninja/dev/bnil-overview.html
- Hex snapshot: https://github.com/rhgrive3/hex/commit/<SHA>
```

For a statement about a specific implementation detail, prefer a GitHub permalink pinned to a commit:

```text
https://github.com/<owner>/<repo>/blob/<commit-sha>/<path>#Lx-Ly
```

This prevents future changes on `main`/`master` from silently changing the evidence behind an architecture decision.
