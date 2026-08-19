# Hex Universal Binary Analysis Platform — Deep Research / Gap Analysis / Ideal Architecture

## Executive Summary と Current Hex Architecture

今回の最重要結論は、**現行 Hex は「iOS/Mach-O の小さな解析ツール」ではすでにない**、という点です。調査時点の `rhgrive3/hex` `main` には、Mach-O だけでなく ELF / PE の loader/parser、architecture adapter、CFG、Semantic IR、SSA、Memory SSA、pointer provenance、alias safety、range analysis、dataflow、multi-stage decompiler、type recovery、Objective-C / Swift runtime intelligence、signature / fingerprint / recognition、binary diff、knowledge、emulator、debug/runtime abstraction、bounded symbolic execution、runtime evidence、project persistence、plugin API、worker/backend、cache、AI control/data plane、evidence、graph/navigation/search/UI、およびそれらを対象にした非常に広い regression suite が既に存在します。リポジトリ自身も現在を “Browser-first universal binary analysis platform for Mach-O, ELF and PE, optimized for iPad” と定義しています。fileciteturn2file0L2-L2 fileciteturn19file0L2-L2

したがって、Hex の次の課題は「SSA を追加する」「Decompiler を作る」「ELF/PE を開けるようにする」といった初期フェーズではありません。**最大の問題は、既に実装された高度な機能の多くが ARM64/AAPCS64 中心の semantic core に集まりすぎており、Universal Platform にするための abstraction boundary が解析機能の成熟度に追いついていないこと**です。特に `js/ir-core.js` は IR vocabulary、ARM64 lifting、call ABI 解釈、SSA/Memory-SSA に近い責務を一つの semantic core に抱えています。一方 `ArchitectureAdapter` は decode/control-flow/assemble などを抽象化しているものの、現在 x86-64 は disassembly capability がある一方で dataflow analysis capability は無効で、arm64e も部分対応として扱われています。ここが最優先の architectural debt です。fileciteturn9file0L2-L2 fileciteturn11file0L2-L2

**Hex が既に強い領域**は、Evidence-first architecture です。`ir.js` は Semantic IR を semantic boundary と明示し、consumer が ARM64 instruction を再解釈して semantic facts を再構築することを禁止する方向に進んでいます。また unknown store を may-alias barrier として扱い、証明できない reaching-store relation を破棄するなど、「分からないものを都合よく推測しない」設計がコード化されています。Decompiler AST も address、row、IR instruction、SSA def/use、evidence を source information として保持します。これは多くの既存 RE 製品が UI では提供していても、**AI reasoning まで一貫した provenance DAG として扱うことを中心目的にはしていない領域**であり、Hex の競争優位になり得ます。fileciteturn13file0L2-L2 fileciteturn14file0L2-L2

現行 Semantic IR は、命令から IR、SSA、Memory SSA、typed semantic interpretation へ進む思想を明確に持っています。IR 語彙には load/store/call/branch/phi/clobber/unknown のほか arithmetic、bitfield、select、address などがあり、メモリ location は stack / field / global / unknown に分類されます。さらに pointer provenance、must-alias、may-alias、unknown-store barriers、constant/range information が付加されます。つまり、「SSA/Memory SSA が Missing」ではありません。問題はその**architecture-independent completeness と alias model の精度**です。fileciteturn11file0L2-L2 fileciteturn13file0L2-L2

Decompiler も legacy renderer だけではありません。現行の high-level pipeline は Semantic IR / SSA / Memory-SSA を直接入力として AST を生成し、rewrite engine、ARM64/Clang idiom recovery、high-variable recovery、function prototype recovery、aggregate layout recovery、pass manager、pretty-printer、NZCV flag semantics、semantic explanations を持っています。Type recovery は width だけで型を決めず、signedness、float、pointer、object、Objective-C、Swift、function pointer、closure、array、nullability、nominal type、enum/struct などの evidence を fusion し、confidence と conflicting candidates を保持しています。これは「Decompiler/Type recovery が無い」という状態とは全く異なります。fileciteturn14file0L2-L2 fileciteturn15file0L2-L2

Symbolic execution も存在しますが、ここは明確に成熟度差があります。`symbolic/executor.js` 自身が “bounded light symbolic execution over Semantic IR” と定義しており、unsupported semantic operations で停止する conservative executor です。AST は const/symbol/op/ITE/unknown を持ち、path constraints や state cloning を行いますが、angr / Triton のような本格的 SMT-backed path exploration engine とはまだ別カテゴリです。これは「Missing」ではなく **Weak / intentionally bounded** に分類すべきです。fileciteturn16file0L2-L2

Universal input についても基礎は成立しています。`BinaryImage` は format/arch/bits/endian/platform/ABI/image base/entrypoint、segments、sections、imports、exports、symbols、relocations、functions、libraries を共通 model とし、resident bytes と backing source の双方から virtual read を行えます。function seeds には source/confidence/exact-start/extent provenance があり、symbol、unwind、function-starts、exports、entrypoint、heuristic をランク付きで融合します。これは Universal Loader の良い出発点です。fileciteturn20file0L2-L2

Plugin API もすでに format、architecture、analyzer、knowledge provider、signature provider、recognition provider、view contribution、goal provider を登録でき、binary read permissions、range restrictions、1-call/total read budgets、timeout、abort、deep-frozen snapshots、failure isolation を備えています。逆に、Decompiler Pass、Runtime Provider、Debugger Adapter、Symbolic Solver、Exporter、AI Tool の第一級 plugin category がまだ API vocabulary にないことは、Universal Platform 化に向けた具体的 gap です。fileciteturn17file0L2-L2

Project persistence も存在しますが、現在は `.hexproj` v1 JSON で、binary hash/metadata、renames/comments/types/structs/bookmarks/patches、confirmed findings、agent answers、evidence、investigation sessions、analysis settings/cache references、navigation を保存します。16 MiB safety limit もあります。これは個人プロジェクトには良いですが、百万 function 規模、共有 annotation、versioned analysis、collaboration、incremental object persistence には不足します。fileciteturn18file0L2-L2

要約すると、現在地は次です。

| 分類 | Hex の現在地 |
|---|---|
| **Already Strong** | Evidence/provenance、Semantic IR の conservative philosophy、SSA/Memory SSA、ObjC/Swift intelligence、browser/iPad-first safety、structured AI data plane、豊富な regression tests |
| **Adequate** | Mach-O/ELF/PE common model、CFG/dataflow、high-level decompiler pipeline、type recovery、recognition/signatures/diff、project v1、plugin API |
| **Weak** | architecture-neutral lifting、alias/points-to、global type constraints、prototype recovery、cross-arch function discovery、debugger/emulator maturity、large-scale persistence、full binary rewrite |
| **Missing / major gaps** | RISC-V/ARM32/Thumb/MIPS/PPC 等の first-class semantic lifting、WASM/DEX/.NET/JVM pipelines、industrial SMT/concolic engine、full collaboration/versioning、stable decompiler/runtime/exporter plugin contracts |
| **Architectural Debt** | ARM64/AAPCS64 semantics と generic IR/SSA の責務混在、in-memory analysis assumptions、project JSON scalability、semantic plugin contract の不足 |

この評価は README の機能表ではなく、現行 tree、IR core、architecture adapter、decompiler/type recovery、symbolic executor、plugin API、project model、binary model、test scripts を突き合わせたものです。fileciteturn2file0L2-L2 fileciteturn9file0L2-L2 fileciteturn11file0L2-L2 fileciteturn19file0L2-L2

## Competitive Landscape と Tool-by-Tool Deep Dive

最も重要な設計比較は、単純な feature count ではありません。IDA は成熟した database/type/signature/ecosystem、Binary Ninja は analysis API と multi-level IL、Ghidra は formal machine semantics と open decompiler internals、rev.ng は compiler/pipeline orientation、angr/Triton は program reasoning、Frida は runtime observation、Rizin/radare2 は modular IO/bin/analysis、ImHex は data interpretation、capa は low-level evidence を semantic capability に持ち上げるモデルで強い、という**異なる強さの軸**があります。citeturn1search6turn2search7turn13search1turn3search0turn3search1turn6search4turn6search1turn4search1turn9search0turn9search3

以下の dossier では、ユーザー指定の必須項目を圧縮して記述します。「Memory SSA」は公開仕様上 classical MemorySSA と確認できない場合、無理に「有」とせず限定評価にしています。

**IDA Pro / Hex-Rays**  
**Purpose:** mature interactive/native RE platform。**License:** proprietary/commercial。**Primary languages:** core は native、SDK は C++、IDAPython。**Supported formats / architectures:** loaders/processor modules により非常に広い。**Core architecture:** kernel database + loader + processor modules + analyzers + type system + debugger + UI。**IR:** Hex-Rays microcode。**SSA:** decompiler-internal dataflow/use-def を持つ。**Memory SSA:** 公開 API から classical MemorySSA と同一とは断定しない。**Decompiler:** Hex-Rays multi-maturity microcode→ctree。**Type recovery:** local types、TIL、debug information、calling-convention/type propagation。**CFG:** mature graph/xref infrastructure。**Function discovery:** analyzers、prologues、symbols、unwind/signatures 等を融合。**Symbol/signature:** FLIRT、TIL、Lumina。**Dynamic:** integrated debugger。**Symbolic:** core strength ではない。**Diff:** BinDiff/Diaphora 等 ecosystem。**Plugin:** C++ SDK、IDAPython。**Project/database:** IDB/I64 系と Teams ecosystem。**UI strengths:** cross-reference/navigation と long-lived analyst workflow。**Performance strengths:** mature demand-oriented database analysis。**Unique strength:** 30年以上蓄積した analysis/type/signature ergonomics。**Weakness:** proprietary semantic internals、API/automation の一部が historical kernel abstractionsに依存。**What Hex already has:** xref/CFG、type/evidence、signatures、project、debug abstractions。**What Hex lacks:** FLIRT/Lumina 級 corpus、TIL 級 type ecosystem、mature cross-platform function discovery。**Adopt:** signatures/type libraries/database navigation model。**Do NOT adopt:** hidden opaque high-level conclusionsや proprietary format dependence。**Relevant source/docs:** SDK、microcode viewer/API、TILIB、FLAIR、types docs。**Papers:** public Hex-Rays talks/docs onlyを参照。**Difficulty:** Very High。**Impact:** Very High。**Priority:** P1。Hex-Rays microcode API では maturity、opcode、operand use/def・may/must access 等が公開され、IDA は TIL/FLIRT 等を独立した reusable knowledge layer として扱う点が特に参考になります。citeturn1search0turn1search2turn1search3turn1search6turn1search14turn1search15

**Binary Ninja**  
**Purpose:** analysis-first programmable RE platform。**License:** proprietary。**Languages:** Core/C++、Python、Rust bindings。**Formats/architectures:** broad native ecosystem。**Core:** BinaryView→Architecture/Platform/CallingConvention→Function analysis→BNIL family。**IR:** Lifted IL、LLIL、LLIL SSA、Mapped MLIL、MLIL、MLIL SSA、HLIL。**SSA:** first-class。**Memory SSA:** SSA APIs expose memory-version reasoning; practical analysis layerとして strong。**Decompiler:** HLIL→Pseudo-C rendering。**Type recovery:** type libraries/archives、debug info、Smart Structures、confidence。**CFG:** function/basic-block object model。**Function discovery:** incremental/background autoanalysis。**Signature:** WARP/signature libraries。**Dynamic:** DebuggerController。**Symbolic:** not core differentiator。**Diff:** plugin ecosystem。**Plugin:** Python/C++/Rust Core API。**Project/database:** BNDB/database。**UI:** clean IL switching/navigation。**Performance:** immediately starts analysis but prioritizes viewed/user-requested work。**Unique strength:** API ergonomics。**Weakness:** proprietary internals、higher IL necessarily loses low-level structure。**Hex already has:** IR→SSA→decompiler、background worker、evidence。**Hex lacks:** same degree of architecture-independent IL API uniformity and stable query semantics。**Adopt:** explicit semantic levels、BinaryView-like object API、priority analysis scheduler。**Avoid:** treating each IL as independent truth。**Files/docs:** BNIL guide、API docs、autoanalysis、debugger、WARP、MCP。**Papers:** public docs/talks。**Difficulty:** High。**Impact:** Very High。**Priority:** P0/P1。BN の API が扱いやすい理由は、UI と scripting が同じ stable object graph/IL model を共有し、analysis を background/incremental に行いながら Function/IL/dataflow を直接問い合わせられるからです。citeturn2search7turn2search9turn2search10turn2search2turn2search12turn2search14turn2search0

**Ghidra**  
**Purpose:** open SRE framework。**License:** Apache-2.0。**Languages:** Java中心、decompiler native C++ 等。**Formats/architectures:** very broad。**Core:** Program database + loaders + analyzers + language specs + datatype managers + decompiler process + tool/plugin framework。**IR:** SLEIGH-generated P-code。**SSA:** decompiler heritage/dataflow。**Memory SSA:** decompiler memory/indirect effectsは高度だが、LLVM MemorySSA と同じ public abstraction とは扱わない。**Decompiler:** open C++ decompiler。**Type recovery:** HighFunction/datatype/prototype propagation。**CFG:** reducibility/structuring pipeline。**Function discovery:** analyzer framework。**Signature:** Function ID。**Dynamic:** debugger/emulation frameworks。**Symbolic:** P-code based analysis can be extended; angrほど solver-centric ではない。**Diff:** Version Tracking。**Plugin:** modules/extensions/scripts/PyGhidra。**Project/database:** project repository/domain object model。**UI:** rich but complex。**Performance:** headless/batch and analysis managers; very large binaries still produce practical scaling challenges in issue reports。**Unique:** architecture definitions and decompiler internals are open。**Weakness:** heavy framework/UX complexity。**Hex already has:** Semantic IR, SSA/MSSA, decompiler passes, evidence。**Hex lacks:** SLEIGH級 retargetable formal ISA specification、decompiler middle-end breadth。**Adopt:** address spaces/varnodes/explicit effects、action/pass pipeline、datatype managers、analyzer scheduling。**Avoid:** Java-heavy monolithic desktop framework and UI complexity。**Relevant source files:** decompiler `heritage`, `action`, varnode/type/block families; language `.slaspec` definitions。**Docs:** SLEIGH/P-code refs。**Papers:** Cifuentes lineage cited in Ghidra’s own SLEIGH docs。**Difficulty:** Very High。**Impact:** Critical。**Priority:** P0。SLEIGH が instruction encoding と p-code semantics を一つの processor specification から生成し、P-code が address spaces・varnodes・explicit side effects で architecture neutrality を実現している点は、Hex の最重要 reference です。citeturn13search1turn13search4turn13search2turn13search7

**rev.ng**  
**Purpose:** compiler-style binary analysis/decompilation。**License:** repository 全体は QEMU 由来を含み GPLv2、個別ファイルには permissive licensing もあるため file-level verification が必要。**Languages:** C++/LLVM ecosystem。**Formats/architectures:** supported targets via model/QEMU/LLVM pipeline。**Core:** lifting/model/passes/decompilation pipeline。**IR:** LLVM-oriented/canonicalized representations。**SSA:** LLVM ecosystem。**Memory SSA:** LLVM analysisを利用可能だが rev.ng-specific guarantees は component dependent。**Decompiler:** yes。**Type recovery/CFG:** pipeline passes。**Function discovery:** CFG/recovery pipeline。**Signature/Dynamic/Symbolic/Diff:** primary focusではない。**Plugin/project/UI:** compiler analysis service model。**Performance:** pass-oriented、artifact reuseが参考。**Unique:** modelとanalysis pipelineの分離。**Weakness:** GPL/QEMU implicationsとframework complexity。**Hex already has:** pass/decompiler semantics。**Hex lacks:** formally separated model/canonical analysis artifacts。**Adopt:** model/pipeline/artifact architecture。**Avoid:** LLVM IR を machine semantics の唯一の truth にすること。**Source/docs:** official repo。**Difficulty:** High。**Impact:** High。**Priority:** P1。citeturn3search0

**angr**  
**Purpose:** program analysis / symbolic reasoning framework。**License:** BSD-2-Clause。**Languages:** Python plus native dependencies。**Formats:** CLE loaders。**Architectures:** archinfo/pyvex ecosystem。**Core:** CLE→VEX/pyvex→CFG/dataflow→SimState/Claripy/exploration→decompiler。**IR:** VEX。**SSA/MSSA:** analyses use normalized IR/dataflow rather than exposing BN-style user-facing SSA stack。**Decompiler:** yes。**Type recovery:** variable/type analyses。**CFG:** CFGFast/CFGEmulated family。**Function discovery:** CFG analyses。**Signature:** SimProcedures/library knowledge more central than FLIRT corpus。**Dynamic:** concrete/symbolic integration possible。**Symbolic:** premier capability。**Diff:** not main feature。**Plugin:** Python components。**Project:** `Project` object as main analysis root。**UI:** angr-management separately。**Performance:** selective analyses but path explosion remains fundamental。**Unique:** stateful symbolic execution, Claripy solver abstraction, SimProcedure models。**Weakness:** Python/state explosion; not interactive decompiler UX first。**Hex already has:** bounded symbolic executor, Semantic IR, goals/verifier。**Hex lacks:** industrial SMT backend/state exploration/state merge/hooked procedures。**Adopt:** SimState-like explicit execution state, solver abstraction, SimProcedure-equivalent call semantics。**Avoid:** making symbolic execution default whole-binary analysis。**Relevant repos:** angr, cle, pyvex, claripy, angr-management。**Difficulty:** Very High。**Impact:** High for verification。**Priority:** P1/P2。citeturn3search1turn3search5turn3search12

**Triton**  
**Purpose:** dynamic symbolic execution/concolic/taint。**License:** OSS project license must be verified per imported component before reuse。**Languages:** C++/Python。**Formats:** not loader-centric。**Architectures:** x86/x64, ARM32/AArch64, RISC-V 等。**Core:** instruction semantics→symbolic AST→taint→path constraints→SMT。**IR:** symbolic AST。**SSA/MSSA:** symbolic references rather than decompiler SSA pipeline。**Decompiler:** no。**Type recovery/CFG/function recognition/diff/project/UI:** not core。**Dynamic:** strong。**Symbolic:** very strong、Z3/Bitwuzla integrations。**Plugin:** library API。**Performance:** instruction-level symbolic engine。**Unique:** precise concrete+symbolic semantics。**Weakness:** not full RE platform。**Hex has:** IR/symbolic skeleton。**Hex lacks:** solver abstraction/taint/AST simplification/concolic trace.**Adopt:** symbolic backend architecture。**Avoid:** coupling UI directly to solver AST。**Difficulty:** High。**Impact:** High。**Priority:** P1。citeturn6search4

**Miasm**  
**Purpose:** binary analysis, lifting, symbolic execution, JIT。**Core:** decoder→IR→dataflow/symbolic→JIT。**IR:** own machine-independent IR。**SSA:** analysis support。**Memory SSA:** not its primary public abstraction。**Decompiler:** limited relative to Ghidra/Hex-Rays。**Dynamic/Symbolic:** strong for research。**Unique:** one framework connects lifter, IR, symbolic and JIT।**Hex implication:** study IR-to-symbolic/JIT reuse rather than copy UI/platform architecture。**Difficulty:** Medium/High。**Impact:** Medium。**Priority:** P2。Official source documents own disassembly/IR/semantics, symbolic execution and optional LLVM/GCC/Clang based JIT pathways. citeturn6search3

**BAP**  
**Purpose:** architecture-independent binary analysis research framework。**IR:** BIL family/knowledge-oriented program model。**Core:** extensible analysis/knowledge/plugins。**Symbolic/decompiler/UI:** not its competitive center。**License:** MIT in current project materials. **Hex should adopt:** typed knowledge facts and monotonic information enrichment as a conceptual reference for Knowledge DB。**Do not adopt:** research-framework complexity without clear UX contract。**Difficulty:** Medium。**Impact:** Medium/High for semantic knowledge model。**Priority:** P2。citeturn6search6

**Rizin**  
**Purpose:** modular RE framework/backend。**License:** LGPL/GPL component mix; verify each linked module。**Languages:** C/C++ ecosystem。**Formats/architectures:** broad plugin ecosystem。**Core:** IO/bin/asm/analysis/types/debug/project modules。**IR:** ESIL-related semantics plus analysis representations。**SSA/MSSA:** not BN/Ghidra-style central user abstraction。**Decompiler:** normally integrated external decompilers such as rz-ghidra。**CFG/xrefs/function analysis:** yes。**Signatures:** yes。**Dynamic:** debugger framework。**Symbolic:** ESIL-based reasoning, not angr class。**Diff:** ecosystem/commands。**Plugin:** extensive native modules。**Project/database:** project support。**UI:** backend, Cutter separate。**Performance:** native modular engine。**Unique:** separation of backend components。**Weakness:** command/API complexity and mixed historical abstractions。**Hex should adopt:** IO/bin/plugin decomposition。**Avoid:** string-command API as primary stable public contract。**Difficulty:** Medium。**Impact:** High for platform architecture。**Priority:** P1。citeturn4search3turn4search6

**Cutter**  
**Purpose:** GUI frontend over Rizin。**License:** GPL-3.0。**Core:** explicit frontend/backend separation。**IR/SSA/decompiler/etc.:** inherited/integrated from Rizin and plugins rather than owned semantic core。**UI strengths:** graph navigation、dockable widgets、xrefs、decompiler integration。**Unique:** proves backend and interactive GUI can evolve semi-independently。**Weakness:** inherits backend semantic/API constraints。**Hex has:** own graph/navigation/UI. **Adopt:** UI projection layer with replaceable widgets and common analysis identifiers。**Avoid:** UI issuing opaque textual backend commands。**Difficulty:** Medium。**Impact:** High for UX。**Priority:** P2。citeturn4search0

**radare2**  
**Purpose:** RE framework、debugger、editor、scriptable binary toolkit。**License:** core primarily LGPLv3 with per-plugin/component caveats。**Core:** `RIO`→bin plugins→asm/analysis→commands/debugger。**IR:** ESIL。**SSA/MSSA:** not central high-level abstraction。**Decompiler:** external/plugin integrations。**CFG/xref/functions/signatures:** yes。**Dynamic:** strong debugger/remote IO。**Diff:** `radiff2` ecosystem。**Plugin:** major strength。**Project:** yes。**UI:** CLI-centric。**Performance:** native and highly selective commands。**Unique:** IO abstraction, write/patch/remote IO. **Weakness:** semantic consistency/API discoverability。**Hex should adopt:** remote/range IO, patching architecture, plugin boundaries。**Avoid:** command-string semantics as data plane。**Difficulty:** Medium。**Impact:** High。**Priority:** P1/P2。citeturn4search1turn4search15

**REDasm**  
**Purpose:** native interactive disassembler platform。**License:** GPL-3.0。**Languages:** C++17/Qt。**Formats/architectures:** multiple via core plugins。**Core:** loader/processor/analyzer plugins with GUI/core separation。**IR/SSA/MSSA/decompiler:** less mature than Ghidra/BN focus。**CFG/xrefs:** yes。**Dynamic/symbolic/diff:** not defining strengths。**Plugin/UI:** strong simple extension model。**Hex should study:** small clean loader/processor/analyzer boundaries。**Avoid:** GPL code reuse unless license-compatible。**Difficulty:** Low/Medium to study。**Impact:** Medium。**Priority:** P2。citeturn5search0

**Glass**  
**Purpose:** modern mobile-app-first disassembler。**License:** GPL-3 implications owing to included ecosystem/components; exact file-level reuse requires verification。**Languages:** Rust。**Formats:** APK/AAB/IPA/ELF/Mach-O in current project description。**Architectures:** AArch64/ARMv7 and DEX/mobile focus、FAT Mach-O handling including arm64e selection。**Core:** workspace crates separate core、architecture、DEX/mobile、database、device、API、UI、CLI、MCP、script responsibilities。**IR/SSA/MSSA/decompiler:** not its main mature differentiator today。**Language intelligence:** ObjC/Swift/mobile metadata。**Dynamic:** device-oriented modules。**Project:** redb-based persistence. **UI:** GPUI/GPU native frontend。**AI:** built-in MCP/API direction。**Unique:** shared typed API across GUI/CLI/MCP and content-addressed/artifact-oriented state。**Hex already has:** ObjC/Swift, MCP-like AI direction, browser UI。**Hex lacks:** similarly clean artifact/API boundary across every frontend。**Adopt:** shared API/data model, artifact identity, mobile-first interaction。**Avoid:** duplicating mobile-specific assumptions into semantic core。**Difficulty:** Medium。**Impact:** High。**Priority:** P1/P2。citeturn5search1

**Frida**  
**Purpose:** process instrumentation。**License:** component-dependent OSS; Gum/bridges must be checked individually before linking。**Languages:** C core + JS/TypeScript bindings/ecosystem。**Formats:** runtime process rather than file-loader centric。**Architectures:** broad supported platforms。**Core:** Gum instrumentation engine, Interceptor, Stalker, Memory APIs, bridges, injected agent/host IPC。**IR/SSA/decompiler:** no. **Dynamic:** exceptional。**Symbolic:** no native SMT focus。**Plugin:** agent scripts/modules。**Project/UI:** host-specific。**Unique:** arbitrary runtime observation/manipulation。**Hex has:** runtime evidence model。**Hex lacks:** production-grade process instrumentation provider。**Adopt:** Frida as optional RuntimeProvider feeding immutable evidence—not as Hex semantic core。**Avoid:** runtime observations silently overriding static truth。**Difficulty:** Medium backend / High browser-device integration。**Impact:** Very High。**Priority:** P1/P2。Gum explicitly exposes Interceptor, Stalker, memory/symbol instrumentation, and Frida’s Stalker transforms instruction streams while collecting runtime events. citeturn6search1turn6search0turn6search2turn6search5

**Unicorn Engine**  
**Purpose:** CPU emulation library。**License:** GPLv2。**Core:** QEMU-derived CPU engine + architecture-neutral memory/hook API。**Architectures:** x86/ARM/AArch64/MIPS/PPC/RISC-V/SPARC 等。**IR/SSA/decompiler:** not exposed as analyst IR。**Dynamic:** emulation。**Symbolic:** no。**UI/project:** none。**Unique:** lightweight CPU emulation. **Weakness:** no OS semantics. **Hex:** already emulator abstractions. **Adopt:** architecture/reference or optional service where licensing is acceptable。**Avoid:** direct mandatory dependency in a non-GPL Hex product. **Difficulty:** Medium。**Impact:** Medium/High。**Priority:** P2。citeturn7search0

**Qiling**  
**Purpose:** executable/OS-level emulation。**License:** GPLv2。**Core:** Unicorn + loaders + OS/syscall/dynamic linker/filesystem abstractions。**Formats:** PE/Mach-O/ELF plus firmware/DOS/UEFI-oriented scenarios。**IR/SSA:** no RE middle-end。**Dynamic:** strong emulation。**Symbolic:** supporting integrations possible but not central。**Plugin:** Python extensibility。**Unique:** bridges CPU emulation and executable/OS semantics。**Hex should adopt:** Loader→OS personality→syscall model decomposition。**Avoid:** in-process GPL coupling unless licensing permits。**Difficulty:** High。**Impact:** High for runtime verification/firmware。**Priority:** P2。citeturn7search3turn7search15turn7search7

**QEMU / TCG**  
**Purpose:** system/user-mode emulation and dynamic translation。**License:** GPL/LGPL component mix。**IR:** TCG internal translation representation。**SSA/decompiler:** not intended as RE analysis IR。**Dynamic:** exceptional execution coverage。**Symbolic:** not built as symbolic executor。**Unique:** mature architecture translation/emulation and translated-block lifecycle。**Hex should study:** architecture translation tests, target semantics, TB caching/invalidation, user-mode runtime architecture。**Do NOT adopt:** TCG as Hex semantic truth; it is optimized for execution, not provenance/decompilation. **Difficulty:** Very High。**Impact:** Medium as reference, High for optional backend。**Priority:** P2/P3。citeturn3search10turn7search10turn7search12

**LLDB**  
**Purpose:** modular native debugger。**License:** LLVM Apache-2.0 with exceptions in llvm-project。**Core:** Target/Process/Thread/Platform/ABI/object/symbol/expression plugins。**IR/decompiler:** not RE middle-end。**Dynamic:** strong break/watch/expression/remote。**Remote:** client-server over gdb-remote; modern LLDB often uses the remote stub even for local debugging, reducing host/target divergence。**Symbolic/diff:** no。**Plugin:** fundamental architecture。**Unique:** platform/process plugin separation。**Hex should adopt:** DebuggerAdapter + PlatformProvider + RemoteTransport separation。**Avoid:** coupling target process state into static Project model。**Difficulty:** High。**Impact:** High。**Priority:** P1/P2。citeturn12search3turn11search8

**GDB**  
**Purpose:** cross-platform native/remote debugger。**License:** GPL。**Core:** target abstraction, architecture support, symbol/read/write/process control, GDB remote protocol。**Dynamic:** breakpoints/watchpoints/catchpoints、conditional execution、gdbserver。**Symbolic/decompiler:** not central。**Plugin/scripting:** Python/commands。**Unique:** extremely mature remote protocol and target ecosystem。**Hex should adopt:** protocol/provider design concepts, not GPL source unless compatible。**Avoid:** CLI command language as primary AI API。**Difficulty:** Medium/High。**Impact:** High for debugger interoperability。**Priority:** P2。citeturn11search2turn11search1turn11search3

**x64dbg**  
**Purpose:** Windows user-mode RE debugger。**License:** open source; component licenses must be verified before reuse, TitanEngine itself is separately licensed. **Architectures:** x86/x64。**Core:** debugger engine + Zydis disassembly + plugin system。**Dynamic:** excellent interactive stepping/registers/stack/memory/breakpoints/patching。**UI strength:** beginner-visible machine state。**IR/decompiler/symbolic:** not primary. **Unique:** debugger ergonomics rather than analysis formalism。**Hex should adopt:** synchronized register/stack/memory/source views and low-friction patch UX。**Avoid:** Windows-specific assumptions in generic debugger API。**Difficulty:** Medium。**Impact:** High beginner value。**Priority:** P2。citeturn11search0turn11search6

**WinDbg**  
**Purpose:** Windows user/kernel/crash/TTD debugger。**License:** proprietary Microsoft tooling/API ecosystem。**Core:** DbgEng engine separates target control from WinDbg UI; engine exposes targets/events/breakpoints/symbols/memory/threads/processes。**Dynamic:** user + kernel, dumps, TTD。**Symbols:** PDB/Symbol Server is a standout ecosystem。**UI:** asynchronous/cancellable tool windows, modern data model, scripting。**Unique:** symbols + kernel + time-travel + data-model projection。**Hex should adopt:** symbols as service/cache, cancellable tool views, time-indexed runtime evidence model。**Avoid:** Windows-only data model in universal core。**Difficulty:** Very High for TTD-equivalent。**Impact:** High。**Priority:** P2/P3。citeturn12search0turn12search2turn12search4turn12search11

**Capstone**  
**Purpose:** multi-architecture decoder。**License:** BSD。**Core:** architecture-neutral decode API with detailed operands where supported。**Formats:** none; byte decoder。**Architectures:** broad including mainstream targets and RISC-V/WASM-related support in current generations。**IR/SSA/decompiler:** none。**Performance:** lightweight/thread-safe native decoder。**Hex has:** Capstone-related platform tests/probes in current tree. **Adopt:** decoder oracle/optional decoder backend. **Avoid:** treating textual/detail decode as complete semantics. **Difficulty:** Low。**Impact:** High for architecture breadth。**Priority:** P0/P1。citeturn4search16

**LLVM MC**  
**Purpose:** assembler/disassembler/machine-code infrastructure。**License:** Apache-2.0 with LLVM exceptions。**Core:** TableGen-driven target descriptions, `MCInst`, `MCOperand`, `MCInstrDesc`, disassembler/assembler/object support。**IR:** `MCInst` is decoded machine instruction representation, not semantic IR。**SSA/decompiler:** no。**Unique:** architecture breadth and generated metadata。**Hex should adopt:** use as decoder/assembler oracle and possibly backend service; use TableGen-style generated architecture metadata conceptually。**Avoid:** mapping `MCInst` directly to high Semantic IR without a semantic lifter。**Difficulty:** Medium。**Impact:** Very High。**Priority:** P0/P1。citeturn8search2turn8search7turn8search5

**Keystone**  
**Purpose:** multi-architecture assembler。**License:** GPLv2/commercial dual-license model。**Architectures:** ARM/ARM64/MIPS/PPC/RISC-V/SPARC/SystemZ/x86 etc. **Core:** LLVM-derived assembly framework with simple neutral API。**IR/SSA/decompiler:** none。**Hex should use:** optional assembler backend where license permits, otherwise architecture oracle/reference。**Avoid:** mandatory GPL dependency for proprietary/permissive distribution。**Difficulty:** Low。**Impact:** Medium patching value。**Priority:** P2。citeturn13search0

**LIEF**  
**Purpose:** executable parsing/modification。**License:** Apache-2.0。**Languages:** C++ plus Python/Rust bindings。**Formats:** ELF/PE/Mach-O and additional Android/object formats in current library。**Core:** format-specific parser/models exposed through common abstractions; modification/rebuild capabilities。**IR/SSA/decompiler:** none。**Unique:** parsing + editing + signing/relocation-oriented binary model。**Hex has:** custom Mach-O/ELF/PE BinaryImage/loaders. **Adopt:** differential oracle, optional native/backend parser/rebuilder, format semantics test corpus. **Avoid:** delegating all hostile-input validation without Hex-owned budgets/validation. **Difficulty:** Medium。**Impact:** Very High universal loader/patching。**Priority:** P1。citeturn8search6turn8search1turn8search10

**LLVM Object / Rust `object` / goblin**  
**Purpose:** generic object readers。**Licenses:** LLVM Apache-2.0 with exceptions; Rust `object` dual MIT/Apache; goblin Rust ecosystem license must be checked from crate metadata before copying. **Formats:** `object` covers ELF/Mach-O/PE/COFF/Wasm/XCOFF/archive; goblin covers ELF/Mach-O/PE/archive and newer TE/COFF detection paths. **IR/decompiler:** none。**Strength:** lightweight common object abstraction。**Weakness:** `object` explicitly positions itself as an object processing library, not a hostile executable loader with every runtime semantic; parser hardening remains Hex’s responsibility。**Hex should adopt:** differential tests and selective permissive-library reuse on native/backend side。**Priority:** P1/P2。citeturn8search0turn15search2turn15search5turn15search7

**Kaitai Struct / Construct**  
**Purpose:** declarative binary parsing。**Core:** schema describes layout; Kaitai generates parsers across languages, Construct defines symmetrical Python parse/build structures with lazy parsing and pointers。**Formats:** schema-defined。**IR/decompiler:** none。**Strength:** removes repetitive field decoding and provides inspectable binary-format grammar。**Weakness:** executable loading semantics—relocation, symbol binding, address mapping, runtime metadata—still require domain logic。**Hex should adopt:** declarative schemas for ancillary containers/debug metadata where feasible, not as complete loader replacement。**Difficulty:** Medium。**Impact:** Medium/High。**Priority:** P2。citeturn13search5turn14search3

**RetDec**  
**Purpose:** retargetable LLVM-based decompiler。**License:** MIT。**Formats:** ELF/PE/Mach-O/COFF/AR/raw/Intel HEX and others。**Architectures:** x86/ARM/MIPS/PPC/PIC families historically supported。**IR:** LLVM-centered。**Decompiler:** yes。**Type/function/signature/debug info:** project includes function/type reconstruction, signature recognition and PDB/DWARF processing. **Dynamic/symbolic:** not main strength。**Unique:** useful open LLVM decompiler reference and test corpus。**Weakness:** less active/mature today than Ghidra/BN/Hex-Rays. **Hex should study:** architecture normalization and decompiler passes; not copy architecture wholesale。**Priority:** P2。citeturn10search3

**JADX**  
**Purpose:** Android DEX/APK decompiler。**License:** Apache-2.0。**Languages:** Java/Kotlin ecosystem。**Formats:** DEX/APK/AAB/AAR/ZIP etc。**IR:** DEX-focused internal transformations。**Decompiler:** Java source reconstruction。**Type recovery/CFG:** managed-runtime-aware。**Function discovery:** DEX metadata gives explicit methods rather than native discovery problem。**Dynamic:** smali debugger support exists in tooling. **UI:** search/find usages/navigation。**Unique:** managed runtime should not be forced through native machine-code IR first。**Hex should adopt:** separate ManagedCode frontend that lowers DEX semantics into shared High Semantic facts while preserving DEX registers/types. **Difficulty:** High。**Impact:** Very High Android expansion。**Priority:** P2。citeturn10search5

**ILSpy / dnSpy lineage**  
**Purpose:** .NET IL decompilation/debugging ecosystem。**License:** ILSpy MIT; dnSpy descendants vary and must be individually checked。**Formats:** PE/CLI assemblies, metadata, CIL; ILSpy also understands ReadyToRun-related structures. **IR:** managed IL/AST transformations。**SSA/MSSA:** not exposed like BN native stack。**Decompiler/type recovery:** strong because CLR metadata supplies rich nominal types/signatures。**Dynamic:** dnSpy lineage demonstrates managed debugger UX; ILSpy is primarily decompiler. **Unique:** metadata-first decompilation. **Hex should adopt:** CLRMetadataProvider + CIL frontend, never “decode .NET native bytes and guess everything.” **Difficulty:** High。**Impact:** Very High。**Priority:** P2。citeturn10search0turn10search4

**BinDiff**  
**Purpose:** binary similarity/diff。**License:** Apache-2.0 current open-source release。**Core:** function/basic-block graph and feature matching。**IR/SSA/decompiler:** consumes analysis rather than owning it。**Function/block matching:** primary capability。**UI:** diff exploration / transferring names/comments. **Unique:** layered graph matching heuristics. **Hex should adopt:** staged exact→structural→semantic matcher with evidence and match reasons. **Avoid:** one opaque similarity score。**Difficulty:** High。**Impact:** High knowledge/diff。**Priority:** P1/P2。citeturn9search8turn9search7

**Diaphora**  
**Purpose:** IDA-based program diff / patch diff。**License:** AGPLv3 since 2.x with commercial licensing option。**Core:** exported function features + graph/assembly/pseudocode/microcode heuristics + parallel matching。**Diff:** function/CFG/callgraph/pseudocode/manual matching and symbol/comment/type transfer。**Unique:** many heterogeneous weak signals rather than one hash。**Hex should adopt:** feature fusion and explainable match evidence。**Avoid:** direct AGPL code integration unless distribution/service license is deliberately compatible。**Difficulty:** Medium/High。**Impact:** High。**Priority:** P2。citeturn14search5

**YARA / YARA-X**  
**Purpose:** byte/text/metadata rule matching。**IR/SSA/decompiler:** none。**Capability:** deterministic signatures over binary/context modules。Current upstream direction puts major new feature work into YARA-X, a Rust rewrite under BSD-3-Clause, while classic YARA remains maintained mainly for fixes/minor evolution. **Hex should adopt:** deterministic signature layer as one evidence source, preferably considering YARA-X for new integrations. **Avoid:** confusing pattern match with semantic proof。**Difficulty:** Low/Medium。**Impact:** Medium。**Priority:** P2。citeturn14search1turn14search9

**capa**  
**Purpose:** elevate low-level program observations into capabilities。**License:** engine/rules need component-level verification; official rules repository is Apache-2.0. **Formats:** static PE/ELF/.NET and supported dynamic analysis sources depending backend. **Core:** feature extraction→scoped rules→capability matches。**IR/SSA/decompiler:** consumes extracted semantics rather than being a decompiler。**Unique:** scope hierarchy from instruction/basic-block/function/file and dynamic call/span/thread/process creates a disciplined semantic vocabulary。**Hex has:** role/purpose/semantic facts/AI evidence. **Hex should adopt:** `CapabilityFact` layer above Semantic IR, with every rule match retaining constituent evidence IDs. **Avoid:** LLM-generated “purpose” without deterministic semantic matches. **Difficulty:** Medium。**Impact:** Very High beginner/AI value。**Priority:** P1。citeturn9search3turn9search13turn9search5

**ImHex**  
**Purpose:** hex editor/data interpretation platform。**License:** main project GPLv2-only; libimhex/plugin portions and Pattern Language components have separate LGPL licensing, so file-level verification is essential。**Core:** byte provider→Pattern Language→data inspector/visualization/search/bookmarks/patching/plugins。**IR/decompiler:** not core。**Performance:** designed around interactive large data inspection and web port work exists in project ecosystem。**UI strength:** bytes become named typed structures, not just hex rows。**Hex has:** hex editor/search/patch/navigation. **Hex lacks:** a powerful user-extensible declarative binary interpretation language. **Adopt:** Pattern-Language-like safe declarative templates, bookmarks/visualization, lazy byte interpretation. **Avoid:** importing GPL core code unless Hex license is compatible。**Difficulty:** High。**Impact:** Very High beginner UX。**Priority:** P1/P2。citeturn9search0turn9search1turn9search2

**Remill と Rellic — 追加研究対象**  
Remill は machine instruction を LLVM bitcode に lift する architecture-semantics project で、Rellic は LLVM bitcode から goto-free C-style output を再構築する decompiler research projectです。これらは製品プラットフォームとしてではなく、**Hex Semantic Lifter の differential semantics oracle と structured-code reconstruction benchmark** として価値があります。特に machine-code lifter の symbolic equivalence validation が実際に既存 lifter bugs を発見した研究は、Hex の “compiler-truth” testing を semantic-equivalence testing へ拡張すべき強い根拠です。citeturn3search7turn3search11turn3search9

この landscape からの結論は、**Hex がコピーすべき単一製品は存在しません**。Machine semantics は Ghidra、programmatic IL ergonomics は Binary Ninja、mature knowledge/navigation は IDA、symbolic state は angr/Triton、runtime provider は Frida/LLDB、binary IO は Rizin/radare2、data interpretation は ImHex、capability layer は capa、artifact/API boundary は Glass が最も参考になります。citeturn13search1turn2search7turn1search14turn3search1turn6search4turn6search1turn12search3turn4search1turn9search0turn9search3turn5search1

## IR Architecture と Decompiler Design

Hex の最重要設計判断は「P-code をコピーするか」「Binary Ninja の LLIL/MLIL/HLIL をコピーするか」ではありません。推奨は、**Ghidra 型の exact machine semantics と Binary Ninja 型の multi-level analyst representation を、一つの versioned semantic graph の異なる projection として統合すること**です。

Ghidra P-code が強い理由は、machine instruction の挙動を architecture-independent な primitive operations に変換し、register すら address space 上の varnode としてモデル化し、すべての変更を明示的 output にするためです。SLEIGH 自身の設計資料は P-code を machine-independent、general-purpose processor modeling、explicit data manipulation、no indirect effects と定義し、`ram`、`register`、`unique`、`const` 等の address spaces と `(space, offset, size)` の varnode で状態を表します。これにより analysis middle-end が x86/ARM/MIPS ごとに同じ解析を再実装する必要がありません。citeturn13search1turn13search7

Binary Ninja が強い理由は別です。Lifted IL/LLIL は machine effects に近く、MLIL では physical registers/memory mechanics を variables/types/platform-call semantics に持ち上げ、SSA variants で dataflow を直接問い合わせられ、HLIL は structured control flow と source-like expression に集中します。つまり「一つの IR に exact semantics と decompiler readability の両方を詰め込まない」。この separation が Python/C++/Rust API の扱いやすさにも直結しています。citeturn2search7turn2search9turn2search2

現行 Hex はその中間にあります。`OP.LOAD/STORE/BIN/CMP/SEL/CALL/...` の semantic vocabulary と SSA/MSSA を一つの IR family に入れつつ、その core lifter が AAPCS64 register bankや ARM64 instruction family を直接理解しています。そのため、現在は ARM64 では非常に有用でも、「Architecture Plugin を追加すれば同じ middle-end が x86/RISC-V に自然に移植できる」とはまだ言い切れません。fileciteturn11file0L2-L2 fileciteturn9file0L2-L2

推奨する **Hex Semantic IR v2** は次の論理層を持つべきです。ただし保存上は別々の incompatible IR ではなく、**同じ `SemanticEntityId` / `OriginSet` を共有する derived projections** とします。

| Layer | 役割 | 参考設計 |
|---|---|---|
| `DecodedInstruction` | bytes、mnemonic、operands、encoding、mode | LLVM MC / Capstone |
| `MachineEffects` | bit-precise architecture semantics | Ghidra P-code / BN LLIL |
| `SemanticIR` | normalized architecture-neutral operations | Hex current IR + BN MLIL |
| `SemanticSSA` | scalar/variable SSA | BN SSA / compiler SSA |
| `MemorySSA` | alias-region memory versions | Hex current MSSAを一般化 |
| `HighIR` | recovered variables/types/expressions | BN HLIL / Ghidra HighFunction |
| `StructuredAST` | if/loop/switch/source-like output | Hex current AST / Ghidra / Rellic |
| `SemanticFacts` | “field increases”, “decrypts data” 等 | capa + Hex evidence |
| `EvidenceGraph` | fact→IR→instruction→file byte | Hex-native differentiator |

この構成で重要なのは、**MachineEffects が唯一の machine-semantic truth** であり、HighIR は「別の意味」ではなく evidence-preserving projection だという点です。例えば `x86 INC` と `AArch64 ADD` が同じ `add` high semantics になるとしても、flags の違いを MachineEffects から消してはいけません。

現行 `OP.CMP` と flags handling は ARM64 NZCV に強く結びついています。v2 では flags を implicit processor magic にせず、

```text
(result, flag_c, flag_v, flag_z, flag_n) =
    add_with_flags(lhs, rhs, width)
```

のような exact effect、または packed flag bank + independently addressable flag bits にします。x86 CF/ZF/SF/OF/PF/AF、ARM NZCV、RISC-V の「flags がない」設計を同じ generic middle-end で扱うにはこの明示性が必要です。Ghidra が indirect effects を避けて明示的 P-code output を採用する理由と同じです。citeturn13search1

さらに v2 では次を first-class にする必要があります。

| 項目 | 現行 Hex からの拡張 |
|---|---|
| Address Spaces | `register`, `stack`, `memory`, `tls`, `io`, `code`, `unique/temp`, managed heap |
| Bitvectors | width を常に semantic type の一部にする |
| Flags | explicit defs/uses |
| Memory | address space + address expression + size + alignment + ordering |
| Alias | `MustAlias / MayAlias / NoAlias / Unknown` と region partition |
| Calls | ABI、args、returns、clobbers、stack delta、may-read/write、noreturn、throws |
| Atomics | ordering、RMW、exclusive monitor |
| SIMD | fixed/scalable vector type、lane operations |
| Exceptions | trap/fault/throw/unwind edges |
| arm64e | PAC/AUT/XPAC を単なる opaque unknown にしない |
| Intrinsics | unsupported machine features用だが effect summary 必須 |
| Provenance | every op has `OriginSet` and transform history |

Memory SSA は特に慎重に進化させるべきです。現行 Hex が `STORE(MK.UNKNOWN)` を may-alias write barrier として扱い、具体的 load→store proof を無効化するのは正しい conservative policy です。これを捨てて高速な optimistic aliasing に変えるべきではありません。次は `stack`, immutable globals, distinct allocation/object roots, argument escape classes などの **alias regions** を導入し、`unknown` write は必要な region tokens を clobber するモデルへ伸ばすべきです。fileciteturn13file0L2-L2

つまり理想は、

```text
M0
 ├─ stack-region S0
 ├─ global-region G0
 ├─ object(self) O0
 └─ unknown U0

store self->coins
O1 = MemDef(O0)

load self->coins
value = MemUse(O1)

unknown pointer store
O2 = Clobber(O1)
G1 = Clobber(G0)
U1 = Clobber(U0)
```

です。完全な points-to solver がない段階でも安全であり、precision を段階的に上げられます。

Decompiler について、Hex-Rays級に近づくための最大 gap は「pretty-printer」ではありません。現行 Hex はすでに rewrite、high variables、prototype、aggregate layout、CFG structuring、compiler idioms、source mapping を持っています。fileciteturn14file0L2-L2

不足しているのは次の middle-end depth です。

| Decompiler area | 現行評価 | Hex-Rays/Ghidra級へ必要なもの |
|---|---|---|
| Exact lifting | ARM64 strong / universal weak | ISA-independent formal lifters |
| SSA | strong | genericize out of ARM64 core |
| Memory SSA | good foundation | region/points-to/interprocedural effects |
| Constant/copy propagation | present in forms | unified fixed-point pass framework |
| SCCP | limited/unclear | executable-edge-aware propagation |
| CSE/GVN | limited | expression/value numbering |
| DCE | partial | effect-aware full DCE |
| Alias analysis | conservative baseline | allocation/root/escape/field sensitivity |
| Reaching defs | present | interprocedural summaries |
| Range analysis | present | relational/value-set constraints |
| Prototype recovery | present | global constraint solver + ABI library |
| Aggregate recovery | present | access-shape clustering + array/union distinctions |
| Variable recovery | present | stack/register coalescing + debug/runtime fusion |
| Loop analysis | present structuring | induction/SCEV-like reasoning |
| Switch | present | table/pattern recognition cross-architecture |
| Irreducible CFG | needs stronger strategy | node splitting / controlled goto / region structuring |
| Flattened CFG | weak | state-variable recovery, semantic state machines |
| Exceptions | weak | unwind-aware exceptional CFG |
| Language-aware output | ObjC/Swift hints | C++/Rust/Go/Swift high-level patterns |
| Proof mapping | **strong** | preserve through every rewrite |

Hex の rewrite engine が式をきれいにしても、その rewrite が evidence origin を失えば競争優位を失います。Decompiler pass contract は必ず、

```text
TransformResult {
  replacement,
  consumedNodeIds,
  producedNodeIds,
  proofKind,
  preconditions,
  originUnion,
  confidence
}
```

に近い形式にすべきです。

**Type recovery** は現在の evidence-weighting を捨てる必要はありません。むしろ runtime metadata など noisy evidence の fusion には優れています。ただし、それを **constraint solver の代わりにしてはいけません**。現在は pointer/object/Swift/ObjC/closure/array 等のスコアと confidence を融合しています。ここへ `TypeConstraintGraph` を追加し、hard constraints と soft evidence を分離するのが正解です。fileciteturn15file0L2-L2

例:

```text
Hard:
  load32(p)              => pointee_width(p) = 32
  call f(x0, v0)         => ABI location constraints
  add(ptr, k*4) + load   => possible array stride 4

Soft:
  ObjC selector evidence => object likelihood +8
  Swift metadata         => nominal type candidate
  symbol spelling        => weak nominal hint
```

hard contradiction は「型をでっち上げる」のではなく ambiguous/union candidate にし、soft confidence は UI/AI に可視化します。

CFG structuring は Ghidra/Hex-Rays級を目指すなら、単純 dominator-based `if/loop` recovery だけでなく、SESE regions、dominance/post-dominance、natural loops、irreducible SCC、switch regions、break/continue synthesis、controlled goto fallback、flattened state-machine recognition を個別 pass にするべきです。高品質 decompiler が強いのは「goto を絶対に消す」からではなく、**意味を壊さず消せる goto だけを消す**からです。Ghidra の SLEIGH documentation 自身も decompilation を data-flow transformation と graph reducibility による structured representation の組み合わせとして位置づけています。citeturn13search1

最終的に Hex Decompiler の success metric は「C が綺麗」ではなく、

```text
Machine semantics preservation
×
structured readability
×
type correctness
×
source/evidence traceability
```

であるべきです。

## Universal Loader・CPU・Language・Dynamic Intelligence

Universal Platform 化では、**File Format、Architecture、ABI、Runtime Language を同じ abstraction に押し込めない**ことが重要です。

推奨 decomposition は、

```text
ByteSource
  ↓
ContainerDetector
  ↓
Container
  ↓
ExecutableLoader
  ↓
BinaryImage
  ↓
ArchitectureProfile
  ↓
ABI / Platform
  ↓
RuntimeMetadataProvider
  ↓
Semantic Lifter
```

です。

現行 `BinaryImage` はすでに format と arch と platform/ABI を別フィールドにし、segments/sections/imports/exports/symbols/relocations/functions を共通化しているので、この方向との compatibility は高いです。fileciteturn20file0L2-L2

**Loader contract** は最低限、

```text
probe(source) -> confidence
open(source, options) -> BinaryImage
mapAddress(address) -> SourceRange?
relocations()
imports()
exports()
symbols()
functionSeeds()
unwindInfo()
debugInfoRefs()
runtimeMetadataHints()
```

とし、Parser と Loader を区別します。「ELF header を読める」は loader support ではありません。

形式別の必要能力は以下です。

| Format family | Parsing 以外に必要な semantic layer | 推奨優先度 |
|---|---|---:|
| Mach-O/FAT | dyld bind/rebase/chained fixups、exports trie、LC_FUNCTION_STARTS、unwind、ObjC/Swift、codesign | 既存強化 |
| ELF | program headers、dynamic linking、PLT/GOT、REL/RELA/RELR、symbol versions、GNU hash、unwind/DWARF | 既存強化 |
| PE/PE+ | imports/delay imports、exports、base reloc、exception directory、unwind、TLS、PDB/CodeView | 既存強化 |
| COFF/XCOFF | sections、symbols、relocs、archive members | P2 |
| `.a` / import libs | archive index/member loader + recursive object model | P1/P2 |
| WASM | sections、type/function tables、structured bytecode CFG、imports/exports、DWARF/source maps | P2 |
| DEX/APK/AAB | ZIP container + resources + DEX classes/methods/types + JNI native links | P2 |
| Java/JAR | classfile constant pool、bytecode verifier types、exceptions、generics metadata | P2 |
| .NET | PE/CLI metadata streams、CIL、signatures、generics、PDB | P2 |
| OAT/VDEX/ART | Android runtime/version-specific metadata + DEX mapping | P3 |
| UEFI | PE/TE + firmware volume/filesystem + protocols | P2/P3 |
| raw firmware | mapping specification、vector tables、architecture heuristics | P3 |
| DOS MZ/COM | segmented address model | P3 |
| kernel images | OS-specific symbol/unwind/cache/container semantics | P3 |

LIEF が ELF/PE/Mach-O の parsing/modification を同一 library family で扱い、Rust `object` が ELF/Mach-O/PE/COFF/Wasm/XCOFF/archive を generic object interface で扱うのは良い differential oracle になります。一方 `object` は万能 executable loader ではないため、Hex の hostile-input validation、resource budgets、runtime metadata interpretation を外部 parser に丸投げすべきではありません。citeturn8search6turn8search0

CPU architecture abstraction では、現行 `ArchitectureAdapter` の「decode/assemble/control flow」の先に `lift()` と ABI knowledge を正式に置く必要があります。fileciteturn9file0L2-L2

推奨 public contract:

```text
ArchitecturePlugin {
  id
  modes()
  registerFile()
  addressSpaces()
  decode(bytes, address, mode)
  lift(decodedInstruction, LiftContext)
  classifyControlFlow(decodedInstruction)
  assemble(text, address, mode)
  validateEncoding(decodedInstruction)
}

ABIPlugin {
  architectureId
  platformId
  callingConventions()
  classifyArguments(signature?)
  classifyReturn(type?)
  calleeSaved()
  callerSaved()
  stackRules()
  redZone()
  unwindRules()
  syscallABI()
}
```

これにより `AArch64` と `AAPCS64`、`x86-64` と `SysV AMD64`、`x86-64` と `Windows x64` を分離できます。現行 Semantic IR 内に AAPCS64 の `x0..x7` / `v0..v7` assumptions が入っている部分をそのまま x86へ拡張するのは避けるべきです。fileciteturn11file0L2-L2

優先 architecture は、

| Architecture | Decoder | Semantics | ABI | Priority |
|---|---|---|---|---:|
| AArch64 | 現行強い | 現行強い | AAPCS64/Darwin strong | keep |
| arm64e | 現行部分対応 | PAC semantics強化必要 | Darwin | P0/P1 |
| x86-64 | decodeあり | **major gap** | SysV + Win64 | **P0** |
| RISC-V 64 | 新規 | clean ISAでIR validationに最適 | ELF psABI | **P0/P1 pilot** |
| ARM32/Thumb | 新規 | mode/interworking重要 | AAPCS32 | P1 |
| x86-32 | x86 backend共有 | segmentation/calling conventions | cdecl/stdcall/etc | P1/P2 |
| MIPS | 新規 | delay slots/HI-LO等 | multiple ABIs | P2 |
| PowerPC | 新規 | CR/LR/endianness | ELF/AIX | P2 |
| SPARC | 新規 | register windows/delay slots | ABI variants | P3 |
| AVR/MSP430 | 新規 | embedded address spaces | embedded ABI | P3 |

RISC-V を早めに選ぶ理由は市場だけではありません。flags register がなく、ISA semantics が比較的明示的なため、Hex Semantic IR v2 が「ARM64 assumptions を本当に取り除けたか」を検証する良い second architecture だからです。

Decoder は全 architecture を自前で書く必要はありません。Capstone は軽量で broad decode に強く、LLVM MC は generated target metadata と assembler/disassembler の breadth に強い一方、どちらも complete semantic IR ではありません。従って、

```text
external decoder
     ↓
Hex DecodedInstruction
     ↓
Hex-owned semantic lifter
```

を基本にし、critical architecture だけ decoder validation/fast path を必要に応じ自前化するのが合理的です。citeturn4search16turn8search2turn8search7

**Language intelligence は Architecture と分離**します。

Objective-C では Mach-O metadata、class/selector/ivar/protocol/category、message-send conventions を runtime provider として Semantic facts に載せます。Swift は mangling/demangling だけでなく nominal metadata、protocol conformances、witness tables、vtables、generic metadata、existential containers、closures、async state machines の provider が必要です。Hex にはすでに ObjC/Swift modules と type evidence の runtime integration が存在するため、ここは「作り直す」のではなく general `LanguageRuntimeProvider` API に昇格させるべきです。fileciteturn2file0L2-L2 fileciteturn15file0L2-L2

同じ枠で、

| Language | Static knowledge provider |
|---|---|
| C++ Itanium | RTTI、vtable、typeinfo、EH/unwind、mangling |
| C++ MSVC | RTTI Complete Object Locator、vftables、EH metadata、MS mangling |
| Rust | vtables、panic/lang items、symbol patterns、enum layout clues、async state machines |
| Go | pclntab/moduledata、goroutine/runtime helpers、interface itabs、build info |
| .NET | CLI metadataそのものを authoritative type source |
| Java/Dex | class/method/field/type descriptors、annotations、exceptions |
| Swift | nominal/witness/conformance metadata |
| Objective-C | runtime sections/selectors/classes/protocols |

とします。

Dynamic analysis も一枚岩にすべきではありません。

```text
RuntimeProvider
 ├── DebuggerProvider        LLDB/GDB/DbgEng
 ├── InstrumentationProvider Frida
 ├── EmulatorProvider        Hex/Unicorn/Qiling/QEMU backend
 └── TraceProvider           imported traces/Lighthouse-like coverage
```

LLDB が client/server + platform plugin + gdb-remote stub を分離し、ローカル debugging にも同様の remote stub architecture を利用するのは特に参考になります。Hex も browser UI が直接 OS debugger API を呼ぶのではなく、同じ versioned remote protocol で local backend / remote device / cloud backend を扱うべきです。citeturn12search3

Frida integration は、

```text
Static claim:
  store self->coins

Runtime experiment:
  intercept function F
  observe [self+0x20] before/after
  trace caller G

Evidence fusion:
  StaticEvidence + RuntimeEvidence
      ↓
  Confirmed/Refuted/Partial
```

とします。Frida の instrumentation result を static IR に「書き戻して真実にする」のではなく、time-stamped observation として evidence graph に追加します。Gum/Interceptor/Stalker の architecture はこの用途と非常に相性が良いです。citeturn6search1turn6search2

Symbolic execution も同様で、

```text
Semantic IR
   ↓
SymbolicTranslator
   ↓
Expression DAG
   ↓
SolverBackend
   ├─ Z3
   ├─ Bitwuzla
   └─ future WASM/native solver
```

とし、現行 bounded executor を捨てず `FastSymbolicEvaluator` として残します。SMT は「常に動かす」ものではなく、「この branch は入力 x で到達可能か」「この patch は invariant を破らないか」のような verified query に限定します。Triton の AST/solver separation と angr の explicit symbolic state が参考になります。citeturn6search4turn3search1

## UX・AI・Performance・Plugin・Project・Licensing

Hex の Beginner UX は、advanced analysis を隠すのではなく **progressive disclosure** にするべきです。これはユーザーの目標と非常に整合します。

理想 UI の最上位は、

```text
この関数は何をしている？
  ↓
「所持コインを加算し、最大値で制限して保存している可能性が高い」
Confidence: 93%

Why?
  ↓
self->coins read
+ amount
min(..., maxCoins)
self->coins write

Show evidence
  ↓
Semantic Fact
  ↓
High IR
  ↓
SSA / Memory SSA
  ↓
Machine Instruction
  ↓
File Offset
```

です。

重要なのは Beginner Mode と Expert Mode が別解析 engine を使わないことです。**同一 Analysis Snapshot の projection だけを変えます。**

Beginner projection:

```text
What?
Why?
Where?
Who calls it?
What does it change?
What happens if condition changes?
How sure are we?
```

Expert projection:

```text
Disassembly
MachineEffects
SSA
Memory SSA
CFG
Dominators
Dataflow
Types
Aliases
Call effects
Decompiler
Runtime trace
Symbolic constraints
```

Binary Ninja の IL views/API、Cutter の graph/widget separation、x64dbg の register/stack/memory transparency、ImHex の typed data interpretation、Glass の shared API architecture はそれぞれ UI design reference になります。citeturn2search7turn4search0turn11search0turn9search0turn5search1

**Causal Path UI** は Hex 独自の重点機能にする価値があります。

たとえば「この値はどこから来た？」に対して、

```text
coins_after
  ← add
      ← coins_before
          ← load self+0x20
              ← memory version M12
                  ← store in loadSaveData()
      ← rewardAmount
          ← argument x1
              ← caller calculateReward()
```

を表示し、各 edge を click すると underlying SSA/use-def、MemorySSA、machine instruction を開けるようにします。

これは `value origin`, `use-def`, pointer provenance, memory versions をすでに持つ Hex と特に相性が良い方向です。fileciteturn11file0L2-L2 fileciteturn13file0L2-L2

**AI architecture** は既存 Hex の方向を維持すべきで、むしろ単純 LLM decompiler assistant に退行してはいけません。Binary Ninja が公式 MCP tooling で function lookup、symbols、disassembly/IL/decompiled view、xrefs、callers/callees 等の structured tool access を提供していることは、LLM に巨大な pseudocode text を渡すより typed analysis APIs が重要だという有力な実例です。citeturn2search5

Hex AI の contract は、

```text
Agent
  ↓ typed request
Analysis Tool API
  ↓
versioned AnalysisSnapshot
  ↓
Semantic Facts / IR / Evidence Store
  ↓
deterministic result
  ↓
Agent explanation
```

に固定します。

追加すべき AI tools は次です。

| Tool | deterministic output |
|---|---|
| `explain_value(id)` | reaching defs + source/evidence graph |
| `causal_path(source, sink)` | minimal inter/intra-procedural causal path |
| `prove_alias(a,b)` | must/may/no + reason |
| `slice_backward(value)` | SSA/MemorySSA slice |
| `slice_forward(value)` | affected state/calls |
| `find_semantic(pattern)` | typed SemanticFacts |
| `compare_functions(a,b)` | exact/structural/semantic match evidence |
| `explain_type(value)` | constraints + soft evidence |
| `verify_hypothesis(h)` | static/symbolic/runtime verification plan/result |
| `validate_patch(patch)` | decode/CFG/reloc/signature/runtime risks |
| `runtime_observations(scope)` | immutable trace evidence |

Agent output should never be just:

> “これはおそらく coins を増やしています。”

ではなく、

```text
Claim
Confidence
Evidence IDs
Contradicting evidence
Unknown assumptions
Verification options
```

を返すべきです。

capa の instruction→block→function→file scoped rules は、Hex の `role`, `purpose`, semantic facts を deterministic layer にする非常に良いモデルです。例えば、

```text
Capability: modifies persistent currency
Evidence:
  reads field candidate "coins"
  arithmetic increment
  writes same must-alias field
  caller reachable from save/update path
```

を rule-based semantic fact として作り、その上で AI が「コイン増加処理」と説明する構造が安全です。citeturn9search3turn9search13

**Large binary performance** では、今後 100 MB〜1 GB+ / 数十万 function を扱うなら「最適化した JavaScript Map を増やす」だけでは足りません。Binary Ninja のように foreground-viewed analysis を優先し、Ghidraのような project persistenceを持ち、UI API は必ず paginated/query-based にする必要があります。Binary Ninja は analysis を background で進めつつユーザーが見ている場所を優先する仕組みを公式に説明しています。citeturn2search10

推奨 scheduling:

```text
Priority 0  user opened address/function
Priority 1  dependencies required by current question
Priority 2  callers/callees around active function
Priority 3  discovered function frontiers
Priority 4  global type/signature refinement
Priority 5  optional whole-binary expensive analyses
```

analysis artifact は、

```text
AnalysisKey =
  binary_hash
+ loader_version
+ arch_semantics_version
+ function_identity
+ pass_version
+ options_hash
```

で content-addressed にします。

1 GB binary で全 instruction、全 CFG、全 AST、全 xref をブラウザ heap に同時に resident にする設計は避け、`ByteSource` と同じ考え方を analysis objects にも適用します。現行 `BinaryImage` が bytes backing を discard して asynchronous source read に切り替えられるのは良い基礎です。fileciteturn20file0L2-L2

Browser/iPad では、

```text
File/OPFS/remote range source
    ↓
chunk cache
    ↓
loader worker
    ↓
analysis workers
    ↓
IndexedDB / OPFS artifact store
    ↓
paged UI projections
```

を基本にします。

SharedArrayBuffer/WASM threads は利用可能な環境では使う価値がありますが、cross-origin isolation 非対応でも動く fallback が必要です。GPU は CFG/SSA/type propagation のような irregular graph workloads の主 engine にするべきではありません。GPU の利用候補は massive similarity embeddings、vector searches、bulk hashing/feature transforms などに限定すべきです。

iPad で精度を犠牲にする必要はありません。

```text
Local:
  parsing
  disassembly
  targeted SSA/dataflow
  decompilation
  evidence navigation
  basic symbolic

Optional backend:
  whole-program points-to
  SMT-heavy exploration
  QEMU/Qiling
  Frida/LLDB device session
  giant binary indexing
  cross-version similarity corpus
```

とすれば、**同じ semantic model に対して計算資源だけを変える**ことができます。

**Plugin API** は現行の secure snapshot/budget model を維持しながら拡張します。現行 API は permissioned binary read、timeouts、cancellation、deep-frozen snapshots をすでに備えており、この安全性は強みです。fileciteturn17file0L2-L2

最終 plugin taxonomy は、

```text
LoaderPlugin
ArchitecturePlugin
ABIPlugin
AnalyzerPlugin
DecompilerPassPlugin
TypeProviderPlugin
RuntimeMetadataPlugin
DebuggerPlugin
EmulatorPlugin
SymbolicSolverPlugin
SignaturePlugin
RecognitionPlugin
DiffFeaturePlugin
KnowledgeProviderPlugin
UIPlugin
AIToolPlugin
ExporterPlugin
```

を推奨します。

stable public API では raw internal object を渡さず、

```text
apiVersion
capabilities
immutable snapshot handles
stable entity IDs
paged iterators
budget/cancellation
structured errors
```

を契約にします。

Decompiler pass plugin に mutable AST pointer を渡して内部構造へ依存させるのは避け、versioned nodes + rewrite request API にするべきです。

**Project Model** は `.hexproj v1` を破棄せず、human-portable export format として維持します。その下に scalable local database を追加します。現在 `.hexproj` は names/comments/types/structs/bookmarks/patches/evidence/investigation sessions を明示的に保存するため、project semantics 自体は良いです。問題は 16 MiB JSON と collaboration model です。fileciteturn18file0L2-L2

推奨:

```text
Project
 ├── immutable BinaryIdentity
 ├── UserFacts
 │    ├── names
 │    ├── comments
 │    ├── types
 │    ├── patches
 │    └── confirmations
 ├── AnalysisSnapshots
 ├── EvidenceGraph
 ├── InvestigationLog
 └── ChangeLog
```

分析 cache は collaboration merge しません。user facts だけ merge します。名前変更の conflict は LWW で黙って消すより、

```text
name = "updateCoins" by Alice
name = "applyReward" by Bob
→ unresolved semantic conflict
```

として保持する方が RE には適しています。

**Patching** は必ず original/patched/risk を別レイヤーにします。

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
```

Patch は byte edits だけでなく、

```text
InstructionPatch
DataPatch
SectionPatch
RelocationPatch
ImportPatch
CodeCave
RebuildOperation
```

として semantic type を持たせます。

validation には decoder validation、branch range、relocations、unwind tables、code signing/checksums、PE Authenticode/Mach-O codesign implications などを含めます。LIEF の modification/rebuild model と radare2 の write/IO architecture、x64dbg の direct patch UX はそれぞれ参考になります。citeturn8search6turn4search15turn11search0

**Licensing** は重大です。現行 `package.json` は `"private": true` で license field を持たず、今回確認した main tree では明確な top-level license grant を確認できませんでした。したがって第三者コードを取り込む前に、Hex 自身の distribution/license policy を明示することが最初の legal architecture task です。これは法的助言ではなく、engineering risk management 上の判断です。fileciteturn19file0L2-L2 fileciteturn2file0L2-L2

分類すると、

| Class | 意味 | 主な候補 |
|---|---|---|
| **A — direct reuse candidate** | permissive、通常は attribution/notice 管理で組み込みやすい | Ghidra Apache-2.0、angr BSD-2、LIEF Apache-2.0、Rust object MIT/Apache、Capstone BSD、BinDiff Apache-2.0、JADX Apache-2.0、ILSpy MIT、RetDec MIT、YARA-X BSD-3 |
| **B — library usage candidate with conditions** | LGPL等。link/distribution方式を個別確認 | Rizin/radare2の LGPL components、ImHex LGPL subcomponents |
| **C — design/reference preferred** | proprietary または strong copyleft で code importを避けたい | IDA、Binary Ninja、rev.ng whole project、Cutter、REDasm、Glass、Unicorn、Qiling、GDB |
| **D — high legal attention** | AGPL / dual commercial / mixed license | Diaphora AGPLv3、Keystone GPLv2/commercial、component-mixed frameworks |

Ghidra は Apache-2.0、angr は BSD-2-Clause、BinDiff は Apache-2.0、JADX は Apache-2.0、ILSpy は MIT、YARA-X は BSD-3-Clause と公式 repositories/docs で確認できます。Cutter/REDasm は GPL-3、Keystone は GPLv2/commercial dual licensing、Diaphora は AGPLv3 に移行しています。citeturn13search2turn3search1turn9search8turn10search5turn10search0turn14search1turn4search0turn5search0turn13search0turn14search5

## Feature Matrix・Gap Analysis・Ideal Hex Architecture

凡例は `● = first-class/strong`, `◐ = partial/plugin/limited`, `— = not core` です。これはマーケティング上「開けるか」ではなく、今回の目的に合わせて **実際の analysis platform capability** を評価しています。Commercial tool の内部 MemorySSA 等、公開一次資料で断定できないものは保守的に `◐` としています。citeturn1search15turn2search7turn13search1

| Tool | Mach-O/ELF/PE | WASM/DEX/.NET | ARM64 | x64 | RISC-V | IR | SSA | MemSSA | Types | Decomp | CFG | SymExec | Runtime | Diff | Sig/KB | Plugin | AI | Browser | Beginner |
|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| **Hex** | ● | — | ● | ◐ | — | ● | ● | ● | ◐ | ◐ | ● | ◐ | ◐ | ◐ | ◐ | ◐ | **●** | **●** | **●** |
| IDA/Hex-Rays | ● | ◐ | ● | ● | ● | ● | ◐ | ◐ | ● | ● | ● | — | ● | ◐ | ● | ● | ◐ | — | ◐ |
| Binary Ninja | ● | ◐ | ● | ● | ● | ● | **●** | ● | ● | ● | ● | ◐ | ● | ◐ | ● | ● | ● | — | ● |
| Ghidra | ● | ◐ | ● | ● | ● | **●** | ● | ◐ | ● | **●** | ● | ◐ | ● | ● | ● | ● | ◐ | — | ◐ |
| rev.ng | ● | —/◐ | ● | ● | ◐ | ● | ● | ◐ | ● | ● | ● | — | ◐ | — | ◐ | ◐ | — | ◐ | ◐ |
| angr | ● | ◐ | ● | ● | ●/◐ | ● | ◐ | ◐ | ◐ | ◐ | ● | **●** | ◐ | — | ◐ | ● | ◐ | — | — |
| Rizin | ● | ◐ | ● | ● | ● | ◐ | — | — | ◐ | ◐ | ● | ◐ | ● | ◐ | ● | ● | ◐ | — | ◐ |
| radare2 | ● | ◐ | ● | ● | ● | ◐ | — | — | ◐ | ◐ | ● | ◐ | ● | ● | ● | ● | ●/◐ | — | — |
| Cutter | inherited | inherited | ● | ● | ● | ◐ | — | — | ◐ | ◐ | ● | ◐ | ● | ◐ | ● | ● | ◐ | — | ● |
| REDasm | ●/◐ | ◐ | ● | ● | ◐ | ◐ | — | — | ◐ | ◐ | ● | — | ◐ | — | ◐ | ● | — | — | ● |
| Glass | Mach-O/ELF + mobile | DEX ● | ● | — | — | ◐ | — | — | ObjC/Swift ● | ◐ | ● | — | ◐ | — | ◐ | ◐ | ● MCP | — | ● |
| ImHex | data-oriented | patterns | disasm | disasm | disasm | — | — | — | pattern types | — | — | — | — | — | pattern DB | ● | ◐ | ●/◐ | **●** |
| Frida | runtime | runtime bridges | ● | ● | platform-dependent | — | — | — | runtime metadata | — | runtime CFG trace | — | **●** | — | — | ● | ◐ | — | ◐ |
| Triton | — | — | ● | ● | ● | symbolic AST | ◐ | — | — | — | ◐ | **●** | ● | — | — | library | — | — | — |
| Miasm | ●/◐ | — | ●/◐ | ● | ◐ | ● | ◐ | ◐ | ◐ | ◐ | ● | ● | JIT | — | — | ● | — | — | — |
| BAP | ●/◐ | — | ● | ● | ◐ | ● | ●/◐ | ◐ | ◐ | — | ● | ◐ | — | — | KB ● | ● | — | — | — |
| RetDec | ● | — | ● | ● | ◐ | LLVM | ● | LLVM | ◐ | ● | ● | — | — | — | signatures | library | — | — | — |
| LIEF | **●** | Android formats ◐ | metadata | metadata | metadata | — | — | — | format types | — | — | — | — | — | symbols | library | — | backend/WASM possible | — |
| Capstone | — | WASM decoder support varies | ● | ● | ● | decoded ops | — | — | — | — | — | — | — | — | — | library | — | WASM builds possible | — |
| Unicorn | — | — | ● | ● | ● | internal | — | — | — | — | runtime | — | **●** | — | — | library | — | — | — |
| Qiling | ● | firmware | ● | ● | ●/◐ | internal | — | — | OS models | — | runtime | ◐ | **●** | — | — | ● | — | — | ◐ |
| JADX | APK/DEX | **DEX ●** | bytecode | N/A | N/A | managed | internal | managed | **●** | **●** | ● | — | ◐ | — | — | ● | — | — | ● |
| ILSpy | PE/CLI | **.NET ●** | IL | IL | N/A | managed | internal | managed | **●** | **●** | ● | — | — | — | — | ● | — | — | ● |
| BinDiff | inputs via analyzers | — | ● | ● | ◐ | consumes | — | — | — | — | graph | — | — | **●** | match DB | — | — | — | ◐ |
| capa | PE/ELF/.NET etc | .NET ●/◐ | extractor | extractor | extractor | semantic facts | — | — | — | — | scopes | — | dynamic input | — | capability rules | extensible | AI-friendly | — | **●** |

Hex の gap analysis を、現行コードを基準にさらに具体化すると次です。

**Already Strong**

`js/ir-core.js` / `js/ir.js` の conservative Semantic IR、SSA/MemorySSA、pointer provenance、unknown alias barriers、`decompiler/pipeline-core.js` の semantic-only decompiler path、`type-recovery.js` の confidence/evidence fusion、AI/evidence modules、browser-first worker/cache tests は、単なる prototype を超えています。特に high-level claim から machine evidence へ戻す思想は Hex の独自性として維持すべきです。fileciteturn11file0L2-L2 fileciteturn13file0L2-L2 fileciteturn14file0L2-L2

**Adequate**

Mach-O/ELF/PE common `BinaryImage`、function-seed confidence/provenance、CFG/dataflow、decompiler passes、ObjC/Swift intelligence、signatures/recognition/diff/project/plugin/runtime abstractions は Universal Platform の skeleton として十分な breadth があります。fileciteturn20file0L2-L2 fileciteturn2file0L2-L2

**Weak**

第一に semantic architecture portability。x86-64 を decode できても dataflow/decompiler pipeline が ARM64 と同じ品質で動かないことが `ArchitectureAdapter` capability の時点で表れています。第二に alias/type reasoning。current alias safety は正しいものの points-to/escape/interprocedural effects が不足し、type recovery は evidence scoring が先行しています。第三に persistent/scalable analysis database。`.hexproj` は user state export として良い一方、百万-function artifact store ではありません。fileciteturn9file0L2-L2 fileciteturn13file0L2-L2 fileciteturn18file0L2-L2

**Missing**

First-class RISC-V/ARM32/Thumb/MIPS/PPC semantic lifters、WASM/DEX/CLR/JVM frontend families、本格 solver-backed symbolic/concolic engine、C++/Rust/Go language-provider families、DWARF/PDB を中心にした universal debug/type ingestion、collaboration/version history、relocation-aware generalized binary rewriting、stable Decompiler/Runtime/Solver/AI/export plugin contracts は、現行 tree からは Universal Platform として完成した形では確認できません。fileciteturn2file0L2-L2

**Architectural Debt**

最重要は `ir-core.js` の ARM64/AAPCS64 knowledge と generic semantic transformation が接近しすぎていることです。次に project v1 JSON/in-memory object model と huge analysis workloads の tension、そして architecture plugin と semantic lifter contract の非対称性です。fileciteturn11file0L2-L2 fileciteturn17file0L2-L2

これを解消する **Ideal Hex Architecture** は次です。

```text
                    ┌──────────────────────────┐
                    │      Universal Input      │
                    └────────────┬─────────────┘
                                 │
                    ┌────────────▼─────────────┐
                    │ ByteSource / Binary IO    │
                    │ mmap/range/chunk/remote   │
                    └────────────┬─────────────┘
                                 │
                    ┌────────────▼─────────────┐
                    │ Container Detection       │
                    │ ZIP/IPA/APK/FAT/archive   │
                    └────────────┬─────────────┘
                                 │
                    ┌────────────▼─────────────┐
                    │ Loader / BinaryImage      │
                    │ maps/relocs/symbols       │
                    └────────────┬─────────────┘
                                 │
            ┌────────────────────▼────────────────────┐
            │ Architecture + ABI + Platform Profiles   │
            └────────────────────┬────────────────────┘
                                 │
                    ┌────────────▼─────────────┐
                    │ Decoder                   │
                    └────────────┬─────────────┘
                                 │
                    ┌────────────▼─────────────┐
                    │ Exact Machine Effects     │
                    └────────────┬─────────────┘
                                 │
                    ┌────────────▼─────────────┐
                    │ Hex Semantic IR v2        │
                    └────────────┬─────────────┘
                                 │
              ┌──────────────────▼───────────────────┐
              │ SSA / MemorySSA / Alias / Dataflow    │
              └──────────────────┬───────────────────┘
                                 │
      ┌──────────────────────────▼───────────────────────────┐
      │ CFG / CallGraph / Types / ABI / Runtime / Languages │
      └──────────────────────────┬───────────────────────────┘
                                 │
       ┌─────────────────────────▼──────────────────────────┐
       │ Function Recognition / Signatures / Knowledge      │
       └─────────────────────────┬──────────────────────────┘
                                 │
                    ┌────────────▼─────────────┐
                    │ High IR / Decompiler      │
                    └────────────┬─────────────┘
                                 │
            ┌────────────────────▼────────────────────┐
            │ Static Verification / Symbolic Engine    │
            └────────────────────┬────────────────────┘
                                 │
     ┌───────────────────────────▼────────────────────────────┐
     │ Debugger / Emulator / Frida / Runtime Verification     │
     └───────────────────────────┬────────────────────────────┘
                                 │
       ┌─────────────────────────▼───────────────────────────┐
       │ Diff / Capability Facts / Knowledge / Search        │
       └─────────────────────────┬───────────────────────────┘
                                 │
         ┌───────────────────────▼─────────────────────────┐
         │ Evidence Store / Project DB / Analysis Cache    │
         └───────────────────────┬─────────────────────────┘
                                 │
                    ┌────────────▼─────────────┐
                    │ Typed AI Tool Plane       │
                    └────────────┬─────────────┘
                                 │
                    ┌────────────▼─────────────┐
                    │ UI Projections            │
                    │ Beginner ↔ Expert          │
                    └──────────────────────────┘
```

Module boundary を API/invariant まで落とすとこうなります。

| Module | Responsibility / public API | Dependencies | Invariant |
|---|---|---|---|
| Binary IO | range reads、stream、hash | filesystem/network | offset reads deterministic |
| Container Detection | nested formats | Binary IO | probe has bounded reads |
| Loader | executable semantics | Container | never invent mapping |
| BinaryImage | canonical loaded image | Loader | addresses map with provenance |
| Architecture | register/mode/decode | bytes only | no OS ABI assumptions |
| Decoder | bytes→instruction | Architecture | exact consumed bytes |
| ABI | args/returns/clobber/stack | Architecture+Platform | no ISA decode |
| Semantic Lifter | instruction→MachineEffects | Architecture | exact or explicit unknown |
| Semantic IR | normalized effects | lifter | architecture-neutral schema |
| SSA | scalar SSA | CFG+IR | one def/version |
| Memory SSA | memory versions | alias+CFG | unknown write never treated no-alias |
| Pass Manager | incremental analyses | artifact graph | declared inputs/outputs |
| Dataflow | use-def/range/reaching | SSA | conservative fixpoints |
| Alias Analysis | must/may/no | pointer provenance | no unsound no-alias |
| CFG | blocks/edges/dom/postdom | IR | edge provenance preserved |
| Call Graph | direct/indirect calls | CFG/types/recognition | uncertainty explicit |
| Type System | structural+nominal types | constraints/providers | hard vs soft evidence separated |
| Runtime Metadata | ObjC/Swift/C++/... | Loader | runtime-version aware |
| Language Intelligence | source-language patterns | runtime+IR | hints never replace semantics |
| Function Recognition | function seeds/bounds | loader+CFG | start vs extent confidence separate |
| Signature DB | fingerprints | recognition | canonicalization versioned |
| Decompiler | HighIR/AST | SSA/types/CFG | source map preserved |
| Symbolic Engine | state/constraints/solver | Semantic IR | unsupported op yields unknown |
| Emulator | deterministic execution | semantics/runtime | execution observation timestamped |
| Debugger | target control | remote provider | target state separated from project |
| Runtime Verification | observations→evidence | debugger/Frida | runtime ≠ static truth |
| Binary Diff | staged matching | fingerprints/CFG/IR | every match explains features |
| Knowledge DB | names/types/capabilities | project/providers | source and confidence retained |
| Project DB | durable user/project facts | storage | binary identity immutable |
| Search Index | symbols/text/semantic facts | project/analysis | paged/cancellable |
| Plugin Runtime | versioned capability API | all extension points | budget/permissions/isolation |
| AI Agent | planning/tool calls | typed API only | no hidden binary interpretation |
| Evidence Store | provenance DAG | all analyses | every claim can descend to bytes |
| UI Projection | Beginner/Expert views | API | UI never becomes semantic source |

## Concrete Recommendations・Priority・Roadmap・Benchmark・Sources

最も重要な改善は、機能追加量ではなく**依存順**で決まります。x86 decompiler、SMT、DEX、Frida、AIを同時に追加する前に、Semantic IR と artifact identity を固定しなければ、各 subsystem が独自 semantic model を作り始めます。

優先度 scoring は `User Value / Analysis Quality / Beginner Value / Architecture Value / Implementation Cost / Regression Risk` の順です。Cost/Risk は高いほど困難です。

| Priority | Improvement | Scores U/A/B/Arch/Cost/Risk | 理由 |
|---|---|---|---|
| **P0** | IR core から ISA/ABI lifting を分離 | 5/5/3/5/4/4 | Universal化の blocker |
| **P0** | Semantic IR v2 exact effects/address spaces | 5/5/3/5/5/5 | 全解析の semantic truth |
| **P0** | Generic SSA/MemorySSA pass | 5/5/3/5/4/4 | cross-architecture prerequisite |
| **P0** | x86-64 full semantic lifter + SysV/Win64 ABI | 5/5/4/5/5/4 | 最大の実用 coverage gap |
| **P0** | RISC-V64 pilot lifter | 4/5/3/5/4/3 | ARM assumptions を検出 |
| **P0** | Persistent chunked artifact/cache DB | 5/4/4/5/4/3 | 100MB〜1GB scaling |
| **P0** | Differential semantic benchmark gate | 5/5/3/5/3/2 | regression control |
| **P1** | region/points-to/escape alias analysis | 5/5/4/5/5/4 | decompiler/type/symbolic 全部に効く |
| **P1** | hard constraint type solver | 5/5/4/5/5/4 | evidence scoringを補完 |
| **P1** | decompiler optimization pass suite | 5/5/5/4/5/4 | output quality |
| **P1** | cross-arch function recovery | 5/5/4/4/4/4 | CFG/callgraph quality |
| **P1** | DWARF/PDB universal debug ingestion | 5/5/4/4/4/3 | ground-truth types/symbols |
| **P1** | SMT solver backend | 4/5/4/4/5/3 | deterministic verification |
| **P1** | plugin API v2 | 4/4/3/5/3/3 | ecosystem |
| **P1** | CapabilityFact/capa-style semantic layer | 5/4/5/4/3/2 | beginner/AI differentiation |
| **P1** | explainable semantic diff | 4/4/4/4/4/3 | knowledge growth |
| **P2** | Frida RuntimeProvider | 5/4/5/3/4/3 | static↔runtime evidence |
| **P2** | WASM frontend | 4/4/4/4/4/3 | web/portable binaries |
| **P2** | DEX/Java frontend | 5/4/5/4/5/3 | Android |
| **P2** | CLR/.NET frontend | 5/4/5/4/5/3 | Windows managed ecosystem |
| **P2** | collaboration/versioned project | 4/3/4/4/5/3 | team workflows |
| **P2** | relocation-aware binary rewriting | 4/4/4/4/5/5 | patching |
| **P2** | ImHex-like Pattern Language | 4/3/5/3/4/3 | binary understanding UX |
| **P3** | full-system/firmware emulation | 3/4/2/3/5/4 | specialized |
| **P3** | GPU-assisted similarity/search | 2/2/2/2/4/3 | only selective benefit |
| **P3** | SPARC/AVR/MSP430 first-class support | 2/3/2/3/4/3 | niche after architecture stabilizes |

**Study / Adopt / Adapt / Avoid** を concrete recommendation に落とすと次になります。

| Feature | Inspiration | Decision | Hex current state | Recommended design | Affected modules | Complexity | Risk | Priority |
|---|---|---|---|---|---|---|---|---|
| Exact machine semantics | Ghidra P-code | **Adapt** | ARM64 IR strong | address-space/effect MachineIR | `ir-core`, architecture | VH | H | P0 |
| Multi-level IL | Binary Ninja | **Adapt** | IR→AST exists | projections sharing same semantic IDs | IR/decompiler/API | H | M | P0 |
| Type libraries | IDA TIL / BN archives | **Adopt concept** | local recovery | versioned reusable type packages | types/knowledge/project | H | M | P1 |
| Signatures | FLIRT/WARP/FID | **Adapt** | signature/fingerprint exists | exact+normalized+structural+semantic tiers | signature/recognition | H | M | P1 |
| Symbolic state | angr | **Adapt** | bounded executor | explicit SimState-like state | symbolic | VH | M | P1 |
| SMT AST | Triton | **Adapt** | simple AST | solver-neutral bitvector DAG | symbolic/verifier | H | M | P1 |
| Runtime instrumentation | Frida | **Adopt as provider** | runtime abstractions | optional external provider | runtime/evidence | H | M | P2 |
| CPU emulation | Unicorn/Qiling | **Study/optional** | Hex emulator | service/provider abstraction | emu/runtime | H | License | P2 |
| Binary parser/edit | LIEF | **Adopt selectively** | custom loaders | oracle/rebuilder/backend | binary/patch | M | M | P1 |
| Decoder | LLVM MC/Capstone | **Adopt selectively** | adapter/probe exists | decoder provider + differential checks | architecture | M | L | P0/P1 |
| Pattern language | ImHex | **Adapt** | hex editor exists | sandbox declarative templates | hex UI/plugin | H | M | P2 |
| Capabilities | capa | **Adopt architecture** | semantic facts | deterministic capability rules | facts/AI | M | L | P1 |
| Diff | BinDiff/Diaphora | **Adapt** | diff exists | explainable staged matcher | diff/knowledge | H | M | P1 |
| Project teams | Ghidra/IDA/BN | **Adapt** | JSON project | snapshot + oplog + conflict model | project | VH | M | P2 |
| AI over pseudocode only | commodity AI plugins | **Avoid** | Hex already better positioned | structured tool/evidence plane | AI | — | — | permanent |
| TCG as core IR | QEMU | **Avoid** | n/a | execution backend only | emu | — | — | — |
| LLVM IR as sole semantic truth | rev.ng/RetDec-style possibility | **Avoid** | custom IR | LLVM optional lowering only | IR/backend | — | — | — |
| opaque similarity score | many diff systems | **Avoid** | evidence design available | score + contributing evidence | diff/UI | — | — | permanent |

実装 roadmap は、ユーザー指定の Phase を現状に合わせて修正するべきです。**Phase Foundation は既存機能の再実装ではなく、v2 boundary refactor** になります。

**Phase Foundation — Universal semantic foundation**

```text
ArchitectureAdapter v2
    ↓
MachineEffects schema
    ↓
Semantic IR v2
    ↓
generic SSA / MemorySSA
    ↓
artifact IDs / cache DB
    ↓
ARM64 compatibility adapter
    ↓
x86-64
    ↓
RISC-V
```

この段階で現行 ARM64 accuracy を regression suite で守り、old `ir-core` behavior と v2 semantics の differential tests を行います。既存 decompiler を一時的に compatibility projection から動かせば big-bang rewrite を避けられます。現行 package scripts に semantic/decompiler/compiler-truth/platform/runtime/universal-binary/AI/browser tests が既に分割されているため、migration gate を作りやすい状態です。fileciteturn19file0L2-L2

**Phase Static Intelligence**

SSA/MSSAを generic化した後に alias-region analysis、escape summaries、interprocedural call effects、type constraints、prototype solver、DWARF/PDB ingestion、function recovery、signature tiers を強化します。

依存関係は、

```text
Generic IR
 → SSA
 → MemorySSA
 → alias
 → call summaries
 → type/prototype
 → decompiler quality
 → symbolic quality
```

です。Alias analysis を後回しにして decompiler rewrite rulesだけ増やすと、temporary eliminationやload/store foldingで unsafe simplification risk が上がります。

**Phase Decompiler**

既存 pipeline を保持しながら Pass Manager の semantics を固定し、SCCP、GVN/CSE、effect-aware DCE、copy propagation、range reasoning、induction variables、SESE structuring、irreducible CFG、exception edges、flattened state-machine recovery、aggregate/array recovery、expression reconstruction を追加します。すべての pass に provenance contract を義務化します。

**Phase Runtime Intelligence**

DebuggerAdapter を LLDB/GDB/DbgEng-style provider interface にし、Frida、Hex emulator、optional Qiling/QEMU serviceを同じ RuntimeEvidence schema に接続します。LLDB の remote platform separation と Frida Gum の instrumentation design を参考にします。citeturn12search3turn6search1

**Phase Universal Formats**

既存 Mach-O/ELF/PE を「完成済みとして放置」せず loader conformance tests を強化し、その共通 contract が安定してから WASM、archives/COFF、DEX、CLR、JVM、UEFI/raw firmware の順に追加します。Managed targets は native instruction IR へ無理に flatten せず frontend-specific semantics を共有 High Semantic modelへ bridge します。JADX と ILSpy が有力な primary reference です。citeturn10search5turn10search0

**Phase Knowledge**

現行 signature/fingerprint/recognition/diff を、FunctionIdentity DB に統合します。

推奨 matching pipeline:

```text
Tier 0 Exact Identity
  exact bytes/hash/debug symbol

Tier 1 Relocation-normalized
  normalized instruction hash

Tier 2 Structural
  CFG shape
  call graph neighborhood
  constants/strings
  imported APIs

Tier 3 Semantic
  normalized Semantic IR
  dataflow fingerprints
  call effect summaries

Tier 4 Cross-compiler fuzzy
  high-level operation graph
  inferred capability set
  type/use patterns
```

各 match は、

```text
Match {
  score,
  confidence,
  featuresUsed,
  conflictingFeatures,
  algorithmVersion
}
```

を返します。

FLIRT は exact-library recognition、WARP/FID は ecosystem signature knowledge、BinDiff/Diaphora は graph/multi-feature matching の reference として役割を分けて研究すべきです。citeturn1search14turn2search0turn9search8turn14search5

**Phase AI-native Analysis**

Hex はこの Phase の多くをすでに開始しています。従って AI chat UI を作り直すのではなく、`EvidenceGraph`、stable IDs、tool schemas、pagination、reproducible query snapshot、semantic search、causal path、verifier integration を完成させます。Binary Ninja の MCP tools が示すように、structured function/IL/xref queries は AI integration との相性が良いです。citeturn2search5

**Phase UX**

最後に見た目だけ作るのではなく、各 semantic layerが完成するごとに Beginner Projection を追加します。

最終 UX は、

```text
Ask
 ↓
Semantic search
 ↓
Candidate functions
 ↓
Capability ranking
 ↓
Causal path
 ↓
Explanation
 ↓
Evidence
 ↓
Optional runtime verification
```

にします。

**Benchmark Plan**

「IDA級」「Hex-Rays級」という評価を禁止し、ground truth と differential oracle を持つ suite にします。

Corpus matrix:

| Dimension | Values |
|---|---|
| Architectures | AArch64, x86-64, RISC-V64 |
| Formats | Mach-O, ELF, PE |
| Optimization | O0, O1, O2, O3, Os/Oz, LTO |
| Languages | C, C++, Objective-C, Swift, Rust, Go |
| Compilers | Clang/LLVM, GCC, MSVC where applicable, rustc, Swift compiler, Go |
| Debug build | symbols retained ground-truth |
| Stripped build | same program stripped |
| Size | tiny, 1MB, 10MB, 100MB, 500MB, 1GB+ synthetic/realistic |

Ground truth should build時に compiler-side metadata を生成し、strip後の binary analysis result と比較します。

**Function discovery**

```text
precision = true recovered starts / all recovered starts
recall    = true recovered starts / ground-truth starts
```

Function extent は startとは別metricにし、現行 `BinaryImage.functionSeed` と同様に start evidence と extent evidence を分けるべきです。fileciteturn20file0L2-L2

**CFG correctness**

basic-block boundaries、edge precision/recall、indirect branches、switch targets、exception edgesを個別評価します。

**IR correctness**

randomized concrete executionで、

```text
machine instruction sequence
vs
Semantic IR execution
```

の architectural state equivalence を比較します。さらに Remill/Ghidra等の independent semantics と differential testingし、可能な subset は SMT equivalence proof を行います。Lifter validation が実際に既存 binary lifters の semantics bugs を見つけた研究例があるため、これは最重要 gate の一つです。citeturn3search9

**Decompiler**

単なる text similarity は使いません。

```text
Structural:
  loops / if / switch recovery

Variable:
  variable count / merge / split accuracy

Type:
  scalar/pointer/struct/field/prototype accuracy

Semantic:
  recompilation + differential tests
  symbolic equivalence on bounded functions

Readability:
  expression complexity
  unnecessary temporaries
  goto count
```

を分けます。

**Type recovery**

pointer/scalar/float/enum/struct/class/function pointer、field offsets、prototype args/returns、signedness、array stride を confusion matrix で評価します。

**Performance**

```text
cold open
first useful function
active function full analysis
whole-binary background
peak memory
persistent cache size
reopen warm time
cancel latency
UI 99th percentile interaction latency
```

を計測します。

特に iPad/browser では「whole analysis time」だけでなく **Time To First Useful Answer** を主要 KPI にします。Binary Ninja が user-visible analysis を優先する設計はこの方向と整合します。citeturn2search10

**最終アーキテクチャ判断**

Hex が目指すべきものは、

```text
Ghidra:
  exact retargetable machine semantics

Binary Ninja:
  layered IL + programmable analysis API

IDA:
  mature type/signature/navigation knowledge

rev.ng:
  artifact/pass/compiler discipline

angr + Triton:
  explicit program state + solver-backed verification

Frida + LLDB:
  runtime observation and target abstraction

Rizin/radare2:
  binary IO / loader / plugin modularity

ImHex:
  data interpretation and hex interaction

capa:
  deterministic semantic capability inference

Glass:
  shared API/artifact model for modern frontends

Hex:
  evidence-first reasoning
  browser/iPad accessibility
  beginner-to-expert progressive disclosure
```

です。これらは互いに独立した engine の寄せ集めではなく、**Hex Semantic IR v2 と Evidence Store を中心に整合させる**べきです。Ghidraのように machine semanticsをformalizeし、Binary Ninjaのようにanalysisをqueryableにし、angr/Tritonのように同じ semanticsをreasoningに使い、Fridaのruntime observationを別evidenceとして加え、capaのようにdeterministic semantic factsに昇格し、その上にAIを置く構造が最も一貫します。citeturn13search1turn2search7turn3search1turn6search4turn6search1turn9search3

最終的な competitive advantage は「Decompiler の見た目が IDA に似ている」ことではありません。

```text
High-level claim
    ↓
Capability / Semantic Fact
    ↓
Decompiler expression
    ↓
Type / Dataflow proof
    ↓
SSA / Memory SSA
    ↓
Semantic IR
    ↓
MachineEffects
    ↓
Instruction
    ↓
Binary offset

             +
             │
             ├── Runtime Evidence
             ├── Symbolic Proof
             ├── Signature Knowledge
             └── User Confirmation
```

この chain を**一切切らずに人間と AI の双方へ公開できること**が Hex の最大の差別化になります。現行コードはすでにその方向へかなり進んでおり、次に必要なのは機能の全面再実装ではなく、architecture-neutral semantic core、industrial middle-end、scalable persistence、runtime/solver providers、managed-runtime frontendsを、その evidence architectureを壊さず接続することです。fileciteturn13file0L2-L2 fileciteturn14file0L2-L2

**主要一次資料**

Hex については current `main` の repository tree、`architecture/index.js`、`ir-core.js`、`ir.js`、Decompiler pipeline/type recovery、symbolic executor、plugin API、project model、binary model、package/test definitions を一次資料としました。fileciteturn2file0L2-L2 fileciteturn9file0L2-L2 fileciteturn11file0L2-L2 fileciteturn13file0L2-L2 fileciteturn14file0L2-L2 fileciteturn15file0L2-L2 fileciteturn16file0L2-L2 fileciteturn17file0L2-L2 fileciteturn18file0L2-L2 fileciteturn20file0L2-L2

Commercial reference は Hex-Rays/IDA の公式 SDK/docs/blog と Binary Ninja の公式 BNIL/API/autoanalysis/debugger/WARP/MCP documentation を優先しました。citeturn1search15turn1search14turn1search6turn2search7turn2search10turn2search12turn2search5

OSS architecture は Ghidra SLEIGH/P-code と公式 source repository、angr project repositories/docs、rev.ng source、Rizin/radare2/Cutter repositories、Frida Gum/docs、Triton、QEMU/Unicorn/Qiling、LIEF/object、ImHex、capa、BinDiff/Diaphora、JADX/ILSpy 等の upstream sources を優先しました。citeturn13search1turn13search2turn3search1turn3search0turn4search3turn4search1turn6search1turn6search4turn7search0turn7search3turn8search6turn8search0turn9search0turn9search3turn9search8turn14search5turn10search5turn10search0

**調査上の制約**

今回、Hex については現行 main の主要 architecture/IR/decompiler/type/symbolic/plugin/project/binary paths と tree/test surface を実コードで確認しました。一方、IDA/Hex-Rays および Binary Ninja の proprietary internals は公開 SDK・documentation・合法的公開技術資料の範囲に限定しており、非公開 implementation detail を推測して事実扱いしていません。また、このレポートで挙げた全 OSS の全 source file を同じ深度で line-by-line audit したわけではなく、Ghidra、Hex、主要 symbolic/runtime/tooling architecture を優先しています。そのため、特に component-level license、rare architecture coverage、MemorySSA と呼べる内部形式の有無について一次資料で明示できない場合は意図的に保守的評価としています。 proprietary/leaked source は使用していません。