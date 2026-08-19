# Universal Binary Platform

## Scope

This layer is deliberately independent from Semantic IR, decompiler, Objective-C and Swift recovery. Its job is to make binary I/O, format metadata, architecture capability, projects, diffing, local knowledge and memory behavior reliable before semantic analysis runs.

## File-open pipeline

Browser files enter through one format-neutral facade:

`File/Blob -> ByteSource -> CachedByteSource -> detectBinary -> format engine -> capability -> Backend`

`js/platform/worker.js` owns ByteSource-backed format detection. ELF/PE continue through `openBinarySource -> BinaryImage`; the existing `js/worker.js` remains the ARM64 compatibility engine for legacy/product surfaces that still require it. For ARM64 ELF/PE, the format-neutral regions produced by `BinaryImage` are registered into that worker, so its disassembly/search/scans can operate without pretending the file is Mach-O.

Mach-O is detected through the same ByteSource stage but intentionally handed to the mature multi-slice compatibility parser without also creating a second universal `BinaryImage` at startup. This preserves chained fixups/function starts/selector metadata and avoids retaining two large metadata graphs on iPad.

The Node CLI uses `NodeFileByteSource` and the same `js/binary/*` parser core; only I/O differs.

## Supported formats

- Mach-O 32/64 and universal/fat through the compatibility multi-slice UI path. Modern chained fixups/function starts remain owned by the existing parser path.
- ELF32/ELF64, including sectionless and stripped images. Dynamic imports/exports, relocations, unwind-derived function seeds and executable mappings come from `js/binary/*`.
- PE32/PE32+, including imports/exports, **delay imports**, base relocations, exception-directory/.pdata function seeds and executable mappings.

Malformed range arithmetic is rejected before allocation. Source reads use BigInt offsets and bounded Number lengths.

## Architecture capability

`js/architecture/index.js` defines the platform-facing architecture boundary: instruction alignment/size information, control-flow category, call category and return category. ARM64 is fixed-width. x86-64 and RISC-V64 must not be forced into a four-byte-row assumption; RISC-V64 is variable-width when the C extension is enabled.

`capstone-probe-worker.js` checks what the deployed Capstone build can actually open. `Backend.disassembleAt()` exposes independent range disassembly for neutral ranges when the runtime probe succeeds. Product-viewer support and semantic-analysis support are separate capability dimensions.

x86-64 is **not** decode-only: Phase 5 carries its mandatory corpus through exact MachineEffects, Semantic IR, CFG, SSA, MemorySSA and the shared decompiler (implemented depth A6). The frozen RISC-V64 Phase 6 profile does the same through A6. Neither target is promoted cumulatively beyond A1 because complete whole-contract A2 exact MachineEffects coverage remains Partial. `SUPPORT_MATRIX.md` and `js/platform/capability-maturity.js` are the authority for the exact current grades.

## iPad memory policy

- Browser `File`/`Blob` objects are never converted to one whole-file ArrayBuffer by the platform path.
- Format detection reads through a bounded ByteSource cache.
- ELF/PE parser metadata has a bounded source-range budget and adaptive reads to avoid small-page restart storms.
- Mach-O startup avoids a duplicate universal parse; only the compatibility parser owns the large function/import metadata graph.
- Runtime byte pages use a bounded LRU (`CachedByteSource`).
- Chunk results use Transferable ArrayBuffers.
- Stale UI epochs reject results even if an older worker request completes later.
- Worker requests accept cancellation; File changes cancel relevant workers.
- Hidden-page cleanup drops queued chunks and bounded source caches.
- `Backend.memoryStats()` reports platform cached bytes/chunks, indexed functions and estimated memory.
- Strings and content hashing are lazy jobs, not prerequisites for header/section display.

Exact byte budgets are implementation values and should be read from current source/tests rather than copied into long-lived architecture prose unless a public contract requires them.

## Progressive analysis

The neutral ELF/PE worker emits `analysisProgress` phases in this order: header, sections, symbols/imports, deferred strings, functions, deferred expensive analysis. `Backend.onAnalysisProgress` is the stable UI hook. Large neutral metadata collections are fetched through bounded `binaryMetadata(kind,start,limit)` requests instead of cloning every object to the UI thread on open. Mach-O keeps the compatibility metadata surface where duplicating a full second graph would waste iPad memory.

## Analysis cache

`AnalysisCache` stores only allowed derived products: format metadata, function seeds, string indexes, imports and analysis summaries. Entries are keyed by a lazily computed streaming content hash and carry a schema version. Binary bytes are never accepted into the cache. Stale schemas are invalidated explicitly.

## `.hexproj`

Version 1 is JSON (`application/vnd.hex.project+json`) with tagged BigInt values. It stores binary hash/metadata, names, comments, types, structs, bookmarks, patches, confirmed findings, agent answers, evidence, analysis settings, cache references and navigation state. The binary itself is not embedded. Import validates size/version/shape and rejects future or corrupted projects without mutating app state.

## Binary diff

Function matching does not use addresses as identity. Fingerprints combine relocation-normalized bytes, a bounded byte sample, optional normalized IR hash, CFG-ish shape, strings, imports, calls, constants and size. Matching is sparse-token seeded and one-to-one. Results are `identical`, `moved`, `slightly changed`, `new` or `deleted`, with confidence, reasons and near-tie candidates.

## Knowledge DB and vendor hints

`KnowledgeDB` stores FunctionKnowledge locally in IndexedDB (or an in-memory backend for tests): fingerprints, names, roles, types, semantic labels, source binary hash, versions, confidence and evidence. Reidentification returns an accepted result only above threshold and outside an ambiguity window.

Vendor/runtime fingerprinting is evidence-only. Firebase, Unity, IL2CPP, ad SDKs, libSystem, Foundation and Swift runtime are returned as unconfirmed candidates with confidence and matching evidence; the platform never converts a weak hint into a confirmed vendor identity.

## Plugin API

The stable registry currently supports `registerFormat`, `registerArchitecture`, `registerAnalyzer`, `registerKnowledgeProvider`, `registerSignatureProvider`, `registerRecognitionProvider`, `registerViewContribution`, and `registerGoalProvider`. Plugins receive a narrow frozen context rather than mutable parser internals. Exceptions are captured per contribution and never propagate into the host app.

New contribution categories are additive contract work; they must not be inferred from aspirational architecture prose before they exist in `js/platform/plugin-api.js` and tests.

## Benchmark interpretation

`npm run binary:benchmark` may deliberately parse real Mach-O fixtures through the universal source-backed parser to stress its range-read path. The browser startup path does not retain that universal Mach-O image alongside the compatibility worker. Benchmark heap deltas therefore measure parser metadata cost, not duplicated browser binary buffers.

## Remaining platform limits

- Variable-length architecture product/viewer integration is still less uniform than ARM64's fixed-width path even though x86-64/RISC-V64 semantic pipelines exist.
- Semantic IR v2 compatibility is the production default behind `js/ir-core.js`; the legacy ARM64/AAPCS64 implementation remains an explicit oracle/compatibility path. The important remaining semantic limitation is incomplete exact MachineEffects coverage and residual architecture/ABI assumptions in generic consumers, not the absence of Semantic IR/dataflow.
- Universal Mach-O UI intentionally uses the existing multi-slice compatibility parser; neutral paged metadata collections remain ELF/PE-first where duplicating the full Mach-O metadata graph would violate the iPad memory policy.
- Content hashing is streaming and lazy; first cache/project hash creation reads the file sequentially but does not require a whole-file buffer.
