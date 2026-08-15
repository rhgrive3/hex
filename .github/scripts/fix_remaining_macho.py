from pathlib import Path
import re


def read(path):
    return Path(path).read_text()


def write(path, text):
    Path(path).write_text(text)


def replace_once(path, old, new):
    text = read(path)
    if text.count(old) != 1:
        raise SystemExit(f'{path}: expected one exact match, got {text.count(old)}: {old[:100]!r}')
    write(path, text.replace(old, new, 1))


def sub_once(path, pattern, repl):
    text = read(path)
    out, count = re.subn(pattern, repl, text, count=1, flags=re.S)
    if count != 1:
        raise SystemExit(f'{path}: expected one regex match, got {count}: {pattern[:100]!r}')
    write(path, out)


# Exact requested fat slice is authoritative; no preferred-arch substitution.
replace_once('js/binary/source-loaders.js',
"""  const valid = all.filter((slice) => slice.size > 0n && slice.offset <= source.size && slice.size <= source.size - slice.offset);
  const requested = opts.arch ? valid.find((slice) => sliceArchName(slice) === opts.arch) : null;
  if (opts.arch && !requested) throw new Error(`requested Mach-O architecture ${opts.arch} is not present in the universal binary`);
  const selected = requested || valid.find((slice) => sliceArchName(slice) === 'arm64e') || valid.find((slice) => sliceArchName(slice) === 'arm64') || valid.find((slice) => sliceArchName(slice) === 'x86_64') || valid[0];
""",
"""  const valid = all.filter((slice) => slice.size > 0n && slice.offset <= source.size && slice.size <= source.size - slice.offset);
  const requestedIndex = opts.sliceIndex == null ? null : Number(opts.sliceIndex);
  if (requestedIndex != null && (!Number.isSafeInteger(requestedIndex) || requestedIndex < 0 || requestedIndex >= all.length)) {
    throw new Error(`requested Mach-O slice index ${opts.sliceIndex} is not present in the universal binary`);
  }
  const indexed = requestedIndex == null ? null : all[requestedIndex];
  if (indexed && !valid.includes(indexed)) throw new Error(`requested Mach-O slice index ${requestedIndex} is outside the active file`);
  const requested = indexed || (opts.arch ? valid.find((slice) => sliceArchName(slice) === opts.arch) : null);
  if (requestedIndex == null && opts.arch && !requested) throw new Error(`requested Mach-O architecture ${opts.arch} is not present in the universal binary`);
  const selected = requested || valid.find((slice) => sliceArchName(slice) === 'arm64e') || valid.find((slice) => sliceArchName(slice) === 'arm64') || valid.find((slice) => sliceArchName(slice) === 'x86_64') || valid[0];
""")
replace_once('js/binary/source-loaders.js',
"    selected: { arch: sliceArchName(selected), cpu: selected.cpu, subtype: selected.subtype, offset: selected.offset, size: selected.size },",
"    selected: { index: all.indexOf(selected), arch: sliceArchName(selected), cpu: selected.cpu, subtype: selected.subtype, offset: selected.offset, size: selected.size },")

# Share one AbortSignal-aware Mach-O metadata budget.
replace_once('js/binary/macho.js',
"import { ensureMachOMetadataBudget } from './macho-budget.js';",
"import { createMachOMetadataBudget, ensureMachOMetadataBudget } from './macho-budget.js';")
replace_once('js/binary/macho.js',
"  const metadataBudget = ensureMachOMetadataBudget(image);",
"  const metadataBudget = ensureMachOMetadataBudget(image, createMachOMetadataBudget(image, { signal: opts.signal }));")

# Platform worker projects normalized BinaryImage import/export truth and reparses exact fat slice lazily.
replace_once('js/platform/worker.js',
"import { asByteSource, detectBinary, openBinarySource } from '../binary/index.js';",
"import { asByteSource, detectBinary, openBinarySource, parseMachOSource } from '../binary/index.js';")
replace_once('js/platform/worker.js',
"import { boundedOffset, checkedChunkIndex, chunkLength, exactExternalInteger, regionSize, utf8Len, isExactFunctionSeed } from './worker-validation.js';",
"import { boundedOffset, checkedChunkIndex, chunkLength, exactExternalInteger, regionSize, utf8Len, isExactFunctionSeed } from './worker-validation.js';\nimport { analysisFromBinaryImage, emptyAnalysis } from './analysis-result.js';")
replace_once('js/platform/worker.js',
"    case 'analyze': return analyzeImage();",
"    case 'analyze': return analyzeImage(msg, signal);")
sub_once('js/platform/worker.js',
r"function analyzeImage\(\) \{.*?\n\}\n\nfunction emptyAnalysis\(\) \{.*?\n\}\n\nfunction genericFunctionSeeds",
"""async function analyzeImage(msg, signal) {
  if (!image) return emptyAnalysis();
  let selected = image;
  if (image.metadata?.fat?.slices?.length && msg.sliceIndex != null) {
    selected = await parseMachOSource(source, {
      sliceIndex: msg.sliceIndex,
      signal,
      ranges: { pageSize: 64 * 1024, maxPageSize: 2 * 1024 * 1024, maxCachedBytes: 16 * 1024 * 1024, maxReads: 4096 },
    });
  }
  if (signal.aborted) throw new Error('Analysis cancelled');
  return analysisFromBinaryImage(selected);
}

function genericFunctionSeeds""")

# Production Mach-O opens both engines: legacy ARM64/ObjC enrichment + source-backed normalized dyld truth.
replace_once('js/backend.js',
"import { augmentAnalysisResultWithChainedImports } from './chained.js';",
"import { augmentAnalysisResultWithChainedImports } from './chained.js';\nimport { markMachOSymbolTruthIncomplete, mergeMachOAnalysisResults } from './macho-analysis-merge.js';")
replace_once('js/backend.js',
"""    if (detection?.formatId === 'macho') {
      nextFormat = 'macho';
      const legacy = await this._callTo('legacy', 'open', { file });
      legacy.formatId = 'macho';
      for (const slice of legacy.slices || []) slice.capability = legacySliceCapability(slice);
      legacy.capability = legacy.slices?.[0]?.capability || legacySliceCapability(null);
      legacy.platform = { compatibility:'legacy-macho', sourceBackedDetection:true, detected:detection, duplicateUniversalParseAvoided:true };
      nextLegacy = legacy;
      nextPlatform = { formatId:'macho', capability:legacy.capability, detection, compatibility:'legacy-macho' };
      result = legacy;
""",
"""    if (detection?.formatId === 'macho') {
      nextFormat = 'macho';
      const legacy = await this._callTo('legacy', 'open', { file });
      let normalized = null;
      try { normalized = await this._callTo('platform', 'open', { file }, null, (p) => this.onAnalysisProgress?.(p)); }
      catch (error) { if (error?.stale) throw error; platformError = error; }
      legacy.formatId = 'macho';
      for (const slice of legacy.slices || []) slice.capability = legacySliceCapability(slice);
      legacy.capability = legacy.slices?.[0]?.capability || legacySliceCapability(null);
      legacy.platform = {
        compatibility:'hybrid-macho', sourceBackedDetection:true, detected:detection,
        normalizedDyldTruth:!!normalized, duplicateUniversalParseAvoided:false,
        ...(platformError ? { normalizedDyldError: platformError.message } : {}),
      };
      nextLegacy = legacy;
      nextPlatform = normalized
        ? { ...normalized, normalizedDyldTruth:true, compatibility:'hybrid-macho' }
        : { formatId:'macho', capability:legacy.capability, detection, normalizedDyldTruth:false, compatibility:'legacy-macho' };
      result = legacy;
""")
replace_once('js/backend.js',
"""  analyze(sliceIndex) {
    const worker = this.formatId === 'macho' ? 'legacy' : 'platform';
    const file = this.file;
    return this._callTo(worker, 'analyze', { sliceIndex }).then((result) => {
      if (this.formatId !== 'macho') return result;
      return augmentAnalysisResultWithChainedImports(file, sliceIndex, result);
    });
  }
""",
"""  async analyze(sliceIndex) {
    if (this.formatId !== 'macho') return this._callTo('platform', 'analyze', { sliceIndex });
    const file = this.file;
    const legacy = await this._callTo('legacy', 'analyze', { sliceIndex });
    const enriched = await augmentAnalysisResultWithChainedImports(file, sliceIndex, legacy);
    if (!this.platformInfo?.normalizedDyldTruth) {
      return markMachOSymbolTruthIncomplete(enriched, this.legacyInfo?.platform?.normalizedDyldError || 'normalized-macho-analysis-unavailable');
    }
    try {
      const normalized = await this._callTo('platform', 'analyze', { sliceIndex });
      return mergeMachOAnalysisResults(enriched, normalized);
    } catch (error) {
      if (error?.stale) throw error;
      return markMachOSymbolTruthIncomplete(enriched, error?.message || 'normalized-macho-analysis-failed');
    }
  }
""")

replace_once('js/symbols.js',
"    this.capped = !!r.capped;",
"    this.capped = !!r.capped;\n    this.symbolTruth = r.symbolTruth || null;")

# Legacy chained-stub supplement is now strictly bounded and contained inside the selected fat slice.
replace_once('js/chained.js',
"const S_SYMBOL_STUBS = 0x8;",
"""const S_SYMBOL_STUBS = 0x8;
const MAX_LOAD_COMMAND_BYTES = 4 * 1024 * 1024;
const MAX_FIXUP_BYTES = 16 * 1024 * 1024;
const MAX_CHAINED_IMPORTS = 250_000;
const MAX_STUB_BYTES = 8 * 1024 * 1024;
const MAX_STUBS = 80_000;
const MAX_SUPPLEMENTAL_READ_BYTES = 32 * 1024 * 1024;""")
sub_once('js/chained.js',
r"/\*\* Return the byte offset of the requested architecture slice\. \*/\nasync function sliceOffset\(file, sliceIndex\) \{.*?\n\}\n\nasync function parseImage",
"""/** Return the bounded active architecture slice. */
async function sliceOffset(file, sliceIndex) {
  const head = await bytes(file, 0, 8);
  if (head.length < 4) return null;
  const dv = new DataView(head.buffer, head.byteOffset, head.byteLength);
  if (dv.getUint32(0, true) === MH_MAGIC_64) return { base:0n, size:BigInt(file.size) };
  const be = dv.getUint32(0, false);
  if (be !== FAT_MAGIC && be !== FAT_MAGIC_64 || head.length < 8) return null;
  const n = u32be(dv, 4), idx = Math.max(0, Number(sliceIndex) || 0);
  if (idx >= n || n > 64) return null;
  const wide = be === FAT_MAGIC_64, entry = wide ? 32 : 20;
  const table = await bytes(file, 0, 8 + n * entry);
  if (table.length < 8 + n * entry) return null;
  const tdv = new DataView(table.buffer, table.byteOffset, table.byteLength), p = 8 + idx * entry;
  const base = wide ? tdv.getBigUint64(p + 8, false) : BigInt(tdv.getUint32(p + 8, false));
  const size = wide ? tdv.getBigUint64(p + 16, false) : BigInt(tdv.getUint32(p + 12, false));
  const total = BigInt(file.size);
  if (size <= 0n || base > total || size > total - base) return null;
  return { base, size };
}

async function parseImage""")
replace_once('js/chained.js',
"""  const base = await sliceOffset(file, sliceIndex);
  if (base == null) return null;
  const h = await bytes(file, base, 32);
""",
"""  const slice = await sliceOffset(file, sliceIndex);
  if (slice == null) return null;
  const { base, size: sliceSize } = slice;
  const h = await bytes(file, base, 32);
""")
replace_once('js/chained.js',
"  if (!ncmds || ncmds > 10000 || sizeofcmds > 64 * 1024 * 1024) return null;",
"  if (!ncmds || ncmds > 10000 || sizeofcmds > MAX_LOAD_COMMAND_BYTES || BigInt(32 + sizeofcmds) > sliceSize) return null;")
replace_once('js/chained.js',
"""      const nsects = dv.getUint32(p + 64, true);
      const segIndex = segments.length;
      segments.push({ name, vmaddr, vmsize, fileoff, filesize });
""",
"""      const nsects = dv.getUint32(p + 64, true);
      const segIndex = segments.length;
      const validFileRange = fileoff <= sliceSize && filesize <= sliceSize - fileoff;
      segments.push({ name, vmaddr, vmsize, fileoff, filesize, validFileRange });
""")
replace_once('js/chained.js',
"  return { base, segments, stubs, fixups };",
"  return { base, sliceSize, segments, stubs, fixups };")
replace_once('js/chained.js',
"  if (version !== 0 || count > 1_000_000 || startsOffset >= raw.length ||",
"  if (version !== 0 || count > MAX_CHAINED_IMPORTS || startsOffset >= raw.length ||")
replace_once('js/chained.js',
"""  if (!image || !image.fixups || !image.stubs.length) return [];
  const raw = await bytes(file, image.base + image.fixups.dataoff, image.fixups.datasize);
""",
"""  if (!image || !image.fixups || !image.stubs.length) return [];
  if (image.fixups.datasize > MAX_FIXUP_BYTES) return [];
  const fixupSize = BigInt(image.fixups.datasize);
  if (image.fixups.dataoff > image.sliceSize || fixupSize > image.sliceSize - image.fixups.dataoff) return [];
  const raw = await bytes(file, image.base + image.fixups.dataoff, image.fixups.datasize);
""")
replace_once('js/chained.js',
"""  const read64 = makeBlockReader(file);
  const out = [];
  for (const sec of image.stubs) {
    const code = await bytes(file, image.base + sec.fileoff, sec.size);
    const count = Math.floor(Number(sec.size) / sec.stubSize);
""",
"""  const read64 = makeBlockReader(file);
  const out = [];
  let supplementalReadBytes = raw.length;
  let decodedStubs = 0;
  for (const sec of image.stubs) {
    if (sec.size > BigInt(MAX_STUB_BYTES) || sec.fileoff > image.sliceSize || sec.size > image.sliceSize - sec.fileoff) continue;
    const sectionBytes = Number(sec.size);
    if (supplementalReadBytes + sectionBytes > MAX_SUPPLEMENTAL_READ_BYTES) break;
    const code = await bytes(file, image.base + sec.fileoff, sectionBytes);
    supplementalReadBytes += code.length;
    const count = Math.min(Math.floor(Number(sec.size) / sec.stubSize), MAX_STUBS - decodedStubs);
""")
replace_once('js/chained.js',
"""      const hit = segmentFor(image.segments, slot);
      if (!hit) continue;
      const format = imports.formats.get(hit.i);
""",
"""      const hit = segmentFor(image.segments, slot);
      if (!hit || hit.s.validFileRange === false) continue;
      const delta = slot - hit.s.vmaddr;
      if (delta < 0n || delta + 8n > hit.s.filesize) continue;
      const format = imports.formats.get(hit.i);
""")
replace_once('js/chained.js',
"    for (let i = 0; i < count; i++) {\n      const stubAddr = sec.addr + BigInt(i * sec.stubSize);",
"    for (let i = 0; i < count; i++) {\n      decodedStubs++;\n      const stubAddr = sec.addr + BigInt(i * sec.stubSize);")

# One shared supplemental recovery budget in the classic worker.
replace_once('js/worker-budget.js',
"    FUNCTION_AUX_SLOTS: 800_000,",
"""    FUNCTION_AUX_SLOTS: 800_000,
    SUPPLEMENTAL_READ_BYTES: 32 * MiB,
    SUPPLEMENTAL_RESIDENT_BYTES: 8 * MiB,
    SUPPLEMENTAL_REGIONS: 128,
    SUPPLEMENTAL_NAMES: 80_000,
    SUPPLEMENTAL_STRING_BYTES: 8 * MiB,
    SUPPLEMENTAL_OPERATIONS: 2_000_000,
    SUPPLEMENTAL_WALL_MS: 3000,
    createSupplementalBudget() {
      const start = Date.now();
      const used = { read:0, resident:0, regions:0, names:0, strings:0, operations:0 };
      const take = (key, amount, limit) => {
        const n = Number(amount);
        if (!Number.isFinite(n) || n < 0 || Date.now() - start > 3000 || used[key] + n > limit) return false;
        used[key] += n; return true;
      };
      return {
        takeRead:(n)=>take('read',n,32*MiB), takeResident:(n)=>take('resident',n,8*MiB),
        releaseResident(n){ used.resident=Math.max(0,used.resident-Math.max(0,Number(n)||0)); },
        takeRegion:(n=1)=>take('regions',n,128), takeName:(n=1)=>take('names',n,80_000),
        takeString:(n)=>take('strings',n,8*MiB), takeOperation:(n=1)=>take('operations',n,2_000_000),
        expired:()=>Date.now()-start>3000, snapshot:()=>({...used,elapsedMs:Date.now()-start}),
      };
    },""")
replace_once('js/worker-legacy.js',
"importScripts('./macho.js', './words.js', './worker-budget.js', './address-provenance.js', '../capstone.js');",
"importScripts('./macho.js', './words.js', './worker-budget.js', './objc-stub-recovery.js', './address-provenance.js', '../capstone.js');")
replace_once('js/worker-legacy.js',
"async function analyzeSlice({ sliceIndex }) {",
"async function analyzeSlice({ sliceIndex, id: requestId }) {")
replace_once('js/worker-legacy.js',
"    for (const s of await objcStubNames(slice, entries)) {",
"    for (const s of await objcStubNames(slice, entries, requestId)) {")
sub_once('js/worker-legacy.js',
r"async function objcStubNames\(slice, known\) \{.*?\n\}\n\nconst MAX_SELECTOR",
"""async function objcStubNames(slice, known, requestId = null) {
  return globalThis.HexObjCStubRecovery.recover({
    slice, known, readRange, cancelled, requestId, fileSize, Words,
    budget:WORKER_BUDGET.createSupplementalBudget(), sanitizePointer:sanitizeStubPointer,
    maxSelector:MAX_SELECTOR, maxStubs:MAX_OBJC_STUBS, maxSectionBytes:OBJC_STUB_MAX_BYTES,
  });
}

const MAX_SELECTOR""")

# Regression stays in the ordinary suite.
replace_once('package.json',
'"test": "node tests/worker-classic-harness.mjs',
'"test": "node tests/issues-521-527.mjs && node tests/worker-classic-harness.mjs')

print('patch applied')
