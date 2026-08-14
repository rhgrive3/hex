# Universal Binary Platform

## Scope

This layer is deliberately independent from Semantic IR, decompiler, Objective-C and Swift recovery. Its job is to make binary I/O, format metadata, architecture capability, projects, diffing, local knowledge and memory behavior reliable before semantic analysis runs.

## File-open pipeline

Browser files enter through one format-neutral facade:

`File/Blob -> ByteSource -> CachedByteSource -> detectBinary -> format engine -> capability -> Backend`

`js/platform/worker.js` owns ByteSource-backed format detection. ELF/PE continue through `openBinarySource -> BinaryImage`; the existing `js/worker.js` remains the ARM64 compatibility engine. For ARM64 ELF/PE, the format-neutral regions produced by `BinaryImage` are registered into that worker, so its disassembly/search/scans can operate without pretending the file is Mach-O.

Mach-O is detected through the same ByteSource stage but intentionally handed to the mature multi-slice compatibility parser without also creating a second universal `BinaryImage` at startup. This preserves chained fixups/function starts/selector metadata and avoids retaining two 100k-300k-function metadata graphs on iPad.

The Node CLI uses `NodeFileByteSource` and the same `js/binary/*` parser core; only I/O differs.

## Supported formats

- Mach-O 32/64 and universal/fat through the compatibility multi-slice UI path. Modern chained fixups/function starts remain owned by the existing parser path.
- ELF32/ELF64, including sectionless and stripped images. Dynamic imports/exports, relocations, unwind-derived function seeds and executable mappings come from `js/binary/*`.
- PE32/PE32+, including imports/exports, base relocations, exception-directory/.pdata function seeds and executable mappings.

Malformed range arithmetic is rejected before allocation. Source reads use BigInt offsets and bounded Number lengths.

## Architecture capability

`js/architecture/index.js` defines the platform boundary: instruction alignment, fixed instruction size, control-flow category, call category and return category. ARM64 is a fixed-width viewer-compatible adapter. x86_64 is variable-width and is intentionally not forced through the existing 4-byte-row assembly viewer.

`capstone-probe-worker.js` checks what the deployed Capstone build can actually open. `Backend.disassembleAt()` exposes independent variable-width disassembly for neutral ELF/PE ranges when that runtime probe succeeds. Mach-O continues to use the existing ARM64 viewer. x86_64 semantic/dataflow analysis remains unsupported; capability must not claim otherwise.

## iPad memory policy

- Browser `File`/`Blob` objects are never converted to one whole-file ArrayBuffer by the platform path.
- Format detection reads through a bounded ByteSource cache.
- ELF/PE parser metadata has a 16 MiB source-range budget and uses adaptive 64 KiB-to-2 MiB reads to avoid small-page restart storms.
- Mach-O startup avoids a duplicate universal parse; only the compatibility parser owns the large function/import metadata graph.
- Runtime byte pages use an 8 MiB LRU (`CachedByteSource`).
- Chunk results use Transferable ArrayBuffers.
- Stale UI epochs reject results even if an older worker request completes later.
- Worker requests accept cancellation; File changes cancel both workers.
- Hidden-page cleanup drops queued chunks and bounded source caches.
- `Backend.memoryStats()` reports platform cached bytes/chunks, indexed functions and estimated memory.
- Strings and content hashing are lazy jobs, not prerequisites for header/section display.

## Progressive analysis

The neutral ELF/PE worker emits `analysisProgress` phases in this order: header, sections, symbols/imports, deferred strings, functions, deferred expensive analysis. `Backend.onAnalysisProgress` is the stable UI hook. Large neutral metadata collections are fetched through `binaryMetadata(kind,start,limit)` instead of cloning every object to the UI thread on open. Mach-O keeps the legacy metadata surface to avoid duplication.

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

The stable registry supports `registerFormat`, `registerArchitecture`, `registerAnalyzer`, `registerKnowledgeProvider`, `registerViewContribution`, and `registerGoalProvider`. Plugins receive a narrow frozen context rather than mutable parser internals. Exceptions are captured per contribution and never propagate into the host app.

## Benchmark interpretation

`npm run binary:benchmark` deliberately parses the real Mach-O fixtures through the universal source-backed parser to stress its range-read path. The browser startup path does not retain that universal Mach-O image alongside the compatibility worker. Benchmark heap deltas therefore measure parser metadata cost, not duplicated browser binary buffers.

## Remaining platform limits

- Existing assembly rows are ARM64/fixed-width. x86_64 uses the independent neutral range-disassembly API/hex navigation until a variable-length viewer is added.
- ARM64 Semantic IR/dataflow remains implemented by the legacy ARM64 engine; this platform branch does not alter semantic/decompiler code.
- Universal Mach-O UI intentionally uses the existing multi-slice compatibility parser; neutral paged metadata collections are currently ELF/PE-first rather than duplicating the full Mach-O metadata graph.
- Content hashing is streaming and lazy; first cache/project hash creation reads the file sequentially, but never allocates the whole binary.
