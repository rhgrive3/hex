from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[1]

def read(path):
    return (ROOT / path).read_text()

def write(path, text):
    (ROOT / path).write_text(text)

def sub(path, pattern, repl, *, flags=re.S, count=1, label=None):
    text = read(path)
    out, n = re.subn(pattern, repl, text, count=count, flags=flags)
    if n != count:
        raise RuntimeError(f"{path}: expected {count} replacement(s) for {label or pattern!r}, got {n}")
    write(path, out)

def replace(path, old, new, label=None):
    text = read(path)
    n = text.count(old)
    if n != 1:
        raise RuntimeError(f"{path}: expected one occurrence for {label or old[:80]!r}, got {n}")
    write(path, text.replace(old, new, 1))

# ---------------------------------------------------------------------------
# #101-104 PE relocation/TLS/GuardCF
# ---------------------------------------------------------------------------
pe_new = r'''export function parseBaseRelocations(r, dir, image) {
  // The loader historically called only this PE post-section hook. Keep TLS and
  // LoadConfig discovery here so older callers gain the new seeds without an API
  // change; each helper reads its own directory from image metadata.
  parseTlsCallbacks(r, image);
  parseGuardCfFunctions(r, image);

  if (!dir || !dir.rva || dir.size < 8) return;
  let off = rvaToOffset(image, dir.rva);
  if (off == null) return;
  const end = Math.min(r.length, off + dir.size);
  const supported = supportedRelocationTypes(image.metadata?.machine);
  let unsupported = 0;
  while (off < end) {
    if (off + 8 > end) throw new Error('PE base relocation block header is truncated');
    const pageRva = r.u32(off), blockSize = r.u32(off + 4);
    if (blockSize < 8 || (blockSize & 1) !== 0 || off + blockSize > end) {
      throw new Error(`invalid PE base relocation block size ${blockSize}`);
    }
    const count = (blockSize - 8) / 2;
    for (let i = 0; i < count; i++) {
      const raw = r.u16(off + 8 + i * 2), type = raw >>> 12, within = raw & 0xfff;
      if (!type) continue; // IMAGE_REL_BASED_ABSOLUTE is padding.
      if (!supported.has(type)) { unsupported++; continue; }
      const address = image.imageBase + BigInt(pageRva + within);
      image.relocations.push({ address, fileOffset: image.addressToOffset(address), type, symbol: null, addend: null, section: null, source: 'PE-base-reloc' });
    }
    off += blockSize;
  }
  if (unsupported) {
    image.metadata.peUnsupportedRelocations = (image.metadata.peUnsupportedRelocations || 0) + unsupported;
    image.warnings?.push?.(`${unsupported} unsupported PE base relocation entr${unsupported === 1 ? 'y' : 'ies'} ignored`);
  }
}

function supportedRelocationTypes(machine) {
  switch (machine) {
    case 0x014c: return new Set([1, 2, 3, 4]);             // x86
    case 0x8664: return new Set([10]);                     // x86-64 DIR64
    case 0x01c0: case 0x01c4: return new Set([3, 5, 7]);   // ARM/Thumb
    case 0xaa64: case 0xa641: return new Set([10]);        // ARM64/ARM64EC
    case 0x5032: return new Set([5, 7, 8]);                // RISC-V 32
    case 0x5064: return new Set([5, 7, 8, 10]);            // RISC-V 64
    default: return new Set();
  }
}

function executableSeed(image, address, source, confidence) {
  const section = image.sectionAt(address);
  if (!section?.perms?.execute) return false;
  image.functions.push(functionSeed(address, { source, confidence }));
  return true;
}

function peDirectory(image, index) {
  return image.metadata?.directories?.[index] || { rva: 0, size: 0 };
}

function parseTlsCallbacks(r, image) {
  const dir = peDirectory(image, 9);
  if (!dir.rva || !dir.size) return;
  const off = rvaToOffset(image, dir.rva);
  const is64 = image.bits === 64;
  const minSize = is64 ? 40 : 24;
  if (off == null || dir.size < minSize || off + minSize > r.length) return;
  const callbacksVa = is64 ? r.u64(off + 24) : BigInt(r.u32(off + 12));
  if (!callbacksVa) return;
  const tableOffBig = image.addressToOffset(callbacksVa);
  if (tableOffBig == null || tableOffBig > BigInt(Number.MAX_SAFE_INTEGER)) return;
  let p = Number(tableOffBig);
  const ptrSize = is64 ? 8 : 4;
  let count = 0, terminated = false;
  for (; count < 65536 && p + ptrSize <= r.length; count++, p += ptrSize) {
    const address = is64 ? r.u64(p) : BigInt(r.u32(p));
    if (address === 0n) { terminated = true; break; }
    executableSeed(image, address, 'tls-callback', 0.999);
  }
  image.metadata.tlsDirectory = { callbacks: count, terminated };
  if (!terminated) image.warnings?.push?.('PE TLS callback table is not null-terminated within the readable file range');
}

function parseGuardCfFunctions(r, image) {
  const dir = peDirectory(image, 10);
  if (!dir.rva || !dir.size) return;
  const off = rvaToOffset(image, dir.rva);
  if (off == null || off + 4 > r.length) return;
  const is64 = image.bits === 64;
  const tableField = is64 ? 128 : 80;
  const countField = is64 ? 136 : 84;
  const flagsField = is64 ? 144 : 88;
  const required = flagsField + 4;
  const structSize = r.u32(off);
  const readable = Math.min(r.length - off, dir.size, structSize || dir.size);
  if (readable < required) return;
  const tableVa = is64 ? r.u64(off + tableField) : BigInt(r.u32(off + tableField));
  const countBig = is64 ? r.u64(off + countField) : BigInt(r.u32(off + countField));
  const guardFlags = r.u32(off + flagsField);
  if (!tableVa || !countBig) return;
  const tableOffBig = image.addressToOffset(tableVa);
  if (tableOffBig == null || tableOffBig > BigInt(Number.MAX_SAFE_INTEGER)) return;
  const tableOff = Number(tableOffBig);
  const extra = (guardFlags >>> 28) & 0xf;
  const stride = 4 + extra;
  const available = Math.max(0, Math.floor((r.length - tableOff) / stride));
  const requested = countBig > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(countBig);
  const count = Math.min(requested, available, 10_000_000);
  let seeded = 0;
  for (let i = 0; i < count; i++) {
    const rva = r.u32(tableOff + i * stride);
    if (!rva) continue;
    if (executableSeed(image, image.imageBase + BigInt(rva), 'guard-cf', 0.995)) seeded++;
  }
  image.metadata.guardCf = { count: requested, parsed: count, seeded, flags: guardFlags, stride, truncated: count < requested };
  if (count < requested) image.warnings?.push?.('PE GuardCF function table is truncated or exceeds the safety cap');
}
'''
sub('js/binary/pe-loader.js', r'export function parseBaseRelocations\(r, dir, image\) \{.*?\n\}\n\n(?=export function parseCoffSymbols)', pe_new + '\n', label='PE relocation/TLS/GuardCF')

# ---------------------------------------------------------------------------
# #108-109 ByteSource option/cancellation propagation
# ---------------------------------------------------------------------------
replace('js/binary/source.js',
        'export function asByteSource(input, options = {}) {\n  if (input instanceof ByteSource) return input;',
        "export function asByteSource(input, options = {}) {\n  if (input instanceof ByteSource) {\n    if (options.maxReadLength == null) return input;\n    const requested = Number(options.maxReadLength);\n    if (!Number.isSafeInteger(requested) || requested <= 0) throw new TypeError('maxReadLength must be a positive safe integer');\n    return new DelegatingByteSource(input, { maxReadLength: Math.min(requested, input.maxReadLength || requested) });\n  }",
        '#108 asByteSource policy')
replace('js/bytesource/cached.js',
        "  async read(offset, length) {\n    const range = this.validateRange(offset, length);\n    this.reads.push({ offset: nonNegativeBigInt(range.offset), length: range.length });\n    return this.source.readExactly(range.offset, range.length);\n  }",
        "  async read(offset, length, options = {}) {\n    const range = this.validateRange(offset, length);\n    throwIfCancelled(options.signal);\n    this.reads.push({ offset: nonNegativeBigInt(range.offset), length: range.length });\n    const bytes = await this.source.readExactly(range.offset, range.length, options);\n    throwIfCancelled(options.signal);\n    return bytes;\n  }\n\n  async readExactly(offset, length, options = {}) {\n    const bytes = await this.read(offset, length, options);\n    if (bytes.length !== length) throw new RangeError(`short read: wanted ${length}, got ${bytes.length}`);\n    return bytes;\n  }",
        '#109 InstrumentedByteSource signal')

# ---------------------------------------------------------------------------
# #105-112 platform worker hardening
# ---------------------------------------------------------------------------
replace('js/platform/worker.js',
        "    const controller = new AbortController();\n    if (msg.id != null) active.set(msg.id, { epoch: msg.epoch, controller });\n    try { return await handle(msg, controller.signal); }\n    finally { if (msg.id != null) active.delete(msg.id); }",
        "    const controller = new AbortController();\n    const owner = Symbol('platform-request');\n    if (msg.id != null) {\n      if (active.has(msg.id)) throw new Error('Duplicate active platform request id.');\n      active.set(msg.id, { epoch: msg.epoch, controller, owner });\n    }\n    try { return await handle(msg, controller.signal); }\n    finally { if (msg.id != null && active.get(msg.id)?.owner === owner) active.delete(msg.id); }",
        '#106 active request ownership')

lifecycle = r'''async function detectFile(msg, signal) {
  const candidateFile = msg.file;
  if (!candidateFile || !Number.isSafeInteger(candidateFile.size) || candidateFile.size <= 0) throw new Error('This file is empty or has an invalid size.');
  const candidateSource = createSource(candidateFile);
  try {
    const length = Math.min(16, candidateFile.size);
    const prefix = await candidateSource.readExactly(0n, length, { signal });
    if (signal.aborted) throw new Error('Open cancelled');
    const detected = detectBinary(prefix);
    const oldSource = source;
    file = candidateFile;
    source = candidateSource;
    image = null;
    descriptor = null;
    regions = new Map();
    if (oldSource && oldSource !== candidateSource) oldSource.clear?.();
    return { formatId: detected.format, fat: !!detected.fat, size: BigInt(candidateFile.size), sourceBacked: true };
  } catch (error) {
    candidateSource.clear?.();
    throw error;
  }
}

async function openFile(msg, signal) {
  const candidateFile = msg.file;
  if (!candidateFile || !Number.isSafeInteger(candidateFile.size) || candidateFile.size <= 0) throw new Error('This file is empty or has an invalid size.');
  progress(msg, 'header', 0, 7);
  const cached = createSource(candidateFile);
  try {
    const cancellable = {
      size: cached.size,
      maxReadLength: cached.maxReadLength,
      read: (offset, length) => cached.read(offset, length, { signal }),
    };
    const candidateImage = await openBinarySource(cancellable, {
      ranges: { pageSize: 64 * 1024, maxPageSize: 2 * 1024 * 1024, maxCachedBytes: 16 * 1024 * 1024, maxReads: 4096 },
    });
    if (signal.aborted) throw new Error('Open cancelled');
    progress(msg, 'sections', 2, 7);
    const engine = { arm64: candidateImage.arch === 'arm64', verified: false };
    const candidateDescriptor = describeBinaryImage(candidateImage, { name: candidateFile.name || 'binary', engine });
    candidateDescriptor.platform.vendorCandidates = fingerprintVendors({ libraries: candidateImage.libraries, imports: candidateImage.imports, symbols: candidateImage.symbols });
    const candidateRegions = new Map();
    for (const region of candidateDescriptor.slices.flatMap((s) => s.regions) || []) if (region?.id) candidateRegions.set(region.id, region);
    candidateRegions.set(candidateDescriptor.raw.id, candidateDescriptor.raw);
    if (signal.aborted) throw new Error('Open cancelled');

    const oldSource = source;
    file = candidateFile;
    source = cached;
    image = candidateImage;
    descriptor = candidateDescriptor;
    regions = candidateRegions;
    if (oldSource && oldSource !== cached) oldSource.clear?.();

    progress(msg, 'symbols', 3, 7, { count: candidateImage.symbols.length });
    progress(msg, 'imports', 4, 7, { count: candidateImage.imports.length });
    progress(msg, 'strings', 4, 7, { deferred: true });
    progress(msg, 'functions', 5, 7, { count: candidateImage.functions.length });
    progress(msg, 'expensive', 5, 7, { deferred: true });
    return candidateDescriptor;
  } catch (error) {
    cached.clear?.();
    throw error;
  }
}
'''
sub('js/platform/worker.js', r'async function detectFile\(msg, signal\) \{.*?\n\}\n\nasync function openFile\(msg, signal\) \{.*?\n\}\n\n(?=function setRegions)', lifecycle + '\n', label='#107 transactional lifecycle')
replace('js/platform/worker.js',
        "async function getChunk({ regionId, chunk }, signal) {\n  const region = regions.get(regionId);\n  if (!region) throw new Error('Unknown region.');\n  const rel = BigInt(chunk) * BigInt(CHUNK_BYTES);",
        "async function getChunk({ regionId, chunk }, signal) {\n  const region = regions.get(regionId);\n  if (!region) throw new Error('Unknown region.');\n  if (!Number.isSafeInteger(chunk) || chunk < 0) throw new Error('Chunk index must be a non-negative safe integer.');\n  const rel = BigInt(chunk) * BigInt(CHUNK_BYTES);",
        '#111 chunk validation')
replace('js/platform/worker.js',
        "  const functions = [...new Set((image.functions || []).map((f) => BigInt(f.address).toString()))].map(BigInt).sort((a, b) => a < b ? -1 : a > b ? 1 : 0);\n  const funcs = new BigUint64Array(functions);",
        "  const byFunctionAddress = new Map();\n  for (const f of image.functions || []) {\n    const key = BigInt(f.address).toString();\n    const prior = byFunctionAddress.get(key) || [];\n    prior.push(f);\n    byFunctionAddress.set(key, prior);\n  }\n  const functions = [...byFunctionAddress.keys()].map(BigInt).sort((a, b) => a < b ? -1 : a > b ? 1 : 0);\n  const exactSources = new Set(['symbol', 'exception', 'unwind', 'function_starts', 'entrypoint', 'export', 'tls-callback', 'guard-cf']);\n  const functionExact = functions.map((addr) => (byFunctionAddress.get(addr.toString()) || []).some((f) => {\n    const sources = Array.isArray(f.sources) ? f.sources : [f.source];\n    return sources.some((s) => exactSources.has(s)) && (f.confidence == null || f.confidence >= 0.9);\n  }));\n  const funcs = new BigUint64Array(functions);",
        '#112 provenance map')
replace('js/platform/worker.js',
        "    functionStartsExact: functions.length > 0,",
        "    functionStartsExact: functions.length > 0 && functionExact.every(Boolean),",
        '#112 analyze exactness')
replace('js/platform/worker.js',
        "function genericFunctionSeeds() {\n  const values = [...new Set((image?.functions || []).map((f) => BigInt(f.address).toString()))].map(BigInt).sort((a, b) => a < b ? -1 : a > b ? 1 : 0);\n  const starts = new BigUint64Array(values);\n  return { starts, cancelled: false, exact: true, __transfer: [starts.buffer] };\n}",
        "function genericFunctionSeeds() {\n  const seeds = image?.functions || [];\n  const values = [...new Set(seeds.map((f) => BigInt(f.address).toString()))].map(BigInt).sort((a, b) => a < b ? -1 : a > b ? 1 : 0);\n  const exactSources = new Set(['symbol', 'exception', 'unwind', 'function_starts', 'entrypoint', 'export', 'tls-callback', 'guard-cf']);\n  const exact = values.length > 0 && values.every((address) => seeds.some((f) => BigInt(f.address) === address && (Array.isArray(f.sources) ? f.sources : [f.source]).some((s) => exactSources.has(s)) && (f.confidence == null || f.confidence >= 0.9)));\n  const starts = new BigUint64Array(values);\n  return { starts, cancelled: false, exact, __transfer: [starts.buffer] };\n}",
        '#112 generic exactness')
replace('js/platform/worker.js',
        "  for (let k = 1; k <= need; k++) if ((buf[index + k] & 0xc0) !== 0x80) return 0;\n  return need + 1;",
        "  for (let k = 1; k <= need; k++) if ((buf[index + k] & 0xc0) !== 0x80) return 0;\n  const b1 = buf[index + 1];\n  if (c === 0xe0 && b1 < 0xa0) return 0;       // overlong U+0000..U+07ff\n  if (c === 0xed && b1 > 0x9f) return 0;       // UTF-16 surrogate range\n  if (c === 0xf0 && b1 < 0x90) return 0;       // overlong 4-byte scalar\n  if (c === 0xf4 && b1 > 0x8f) return 0;       // > U+10ffff\n  return need + 1;",
        '#110 scalar-valid UTF-8')
scan_strings = r'''async function scanStrings(msg, signal) {
  const region = regions.get(msg.regionId);
  if (!region) throw new Error('Unknown region.');
  const minLength = Math.max(2, Number(msg.min) || 4);
  const cap = Math.min(Math.max(1, Number(msg.limit) || STRINGS_LIMIT), STRINGS_LIMIT);
  const regionBytes = BigInt(region.size);
  let requested = regionBytes;
  if (msg.maxBytes != null) {
    if (typeof msg.maxBytes === 'bigint') requested = msg.maxBytes;
    else if (Number.isSafeInteger(msg.maxBytes) && msg.maxBytes >= 0) requested = BigInt(msg.maxBytes);
    else throw new Error('maxBytes must be a non-negative safe integer or bigint');
  }
  const total = requested < regionBytes ? requested : regionBytes;
  const out = [];
  let pos = 0n, runStart = -1n, runBytes = [];
  const publicCount = (n) => n <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(n) : n;
  const progressCount = (n, all) => all <= BigInt(Number.MAX_SAFE_INTEGER)
    ? [Number(n), Number(all)]
    : [Number((n * 1_000_000n) / (all || 1n)), 1_000_000];
  const flush = () => {
    if (runStart >= 0n && runBytes.length) {
      const text = decoder.decode(new Uint8Array(runBytes)).replace(/\t/g, '\\t').replace(/\n/g, '\\n');
      if (text.length >= minLength) out.push({ addr: BigInt(region.vmAddr) + runStart, offset: publicCount(runStart), text });
    }
    runStart = -1n; runBytes = [];
  };
  let carry = new Uint8Array(0), carryAt = 0n;
  while (pos < total && out.length < cap) {
    if (signal.aborted) return { results: out, cancelled: true, capped: false, scannedBytes: publicCount(pos), complete: false };
    const remaining = total - pos;
    const want = remaining < BigInt(SCAN_BLOCK) ? Number(remaining) : SCAN_BLOCK;
    const block = await readFileRange(BigInt(region.fileOffset) + pos, want, signal);
    if (!block.length) break;
    let buffer = block, base = pos;
    if (carry.length) {
      buffer = new Uint8Array(carry.length + block.length);
      buffer.set(carry); buffer.set(block, carry.length); base = carryAt;
    }
    const last = pos + BigInt(block.length) >= total;
    let i = 0;
    for (; i < buffer.length; i++) {
      const n = utf8Len(buffer, i);
      if (n === -1 && !last) break;
      if (n <= 0) { flush(); if (out.length >= cap) break; continue; }
      if (runStart < 0n) { runStart = base + BigInt(i); runBytes = []; }
      if (runBytes.length < MAX_STRING_CHARS * 4) for (let k = 0; k < n; k++) runBytes.push(buffer[i + k]);
      i += n - 1;
    }
    carry = i < buffer.length ? buffer.slice(i) : new Uint8Array(0);
    carryAt = base + BigInt(i);
    pos += BigInt(block.length);
    const [done, all] = progressCount(pos, total);
    self.postMessage({ t: 'scanProgress', requestId: msg.id, epoch: msg.epoch, done, all, doneBytes: publicCount(pos), allBytes: publicCount(total), hits: out.length });
    await Promise.resolve();
  }
  flush();
  return { results: out.slice(0, cap), cancelled: false, capped: out.length >= cap, scannedBytes: publicCount(pos), complete: pos >= regionBytes && out.length < cap };
}
'''
sub('js/platform/worker.js', r'async function scanStrings\(msg, signal\) \{.*?\n\}\n\n(?=async function runSearch)', scan_strings + '\n', label='#105 BigInt scan strings')

# ---------------------------------------------------------------------------
# #113-127 precise API semantics. Specific entries are checked before legacy
# catch-alls, so compatibility is retained for callers depending on old IDs.
# ---------------------------------------------------------------------------
precise_api = r'''const PRECISE_API_TABLE = [
  { id:'memcpy', re:/^_?(memcpy|memmove)$/i, cat:'memory', args:['dst','src','size'], ret:'dst', effect:'copy' },
  { id:'bcopy', re:/^_?bcopy$/i, cat:'memory', args:['src','dst','size'], ret:null, effect:'copy' },
  { id:'memcpy_chk', re:/^_?__(memcpy|memmove)_chk$/i, cat:'memory', args:['dst','src','size','dst_object_size'], ret:'dst', effect:'copy' },
  { id:'memset', re:/^_?memset$/i, cat:'memory', args:['dst','fill','size'], ret:'dst', effect:'fill' },
  { id:'bzero', re:/^_?bzero$/i, cat:'memory', args:['dst','size'], ret:null, effect:'zero' },
  { id:'memset_chk', re:/^_?__memset_chk$/i, cat:'memory', args:['dst','fill','size','dst_object_size'], ret:'dst', effect:'fill' },
  { id:'malloc', re:/^_?(malloc|valloc)$/i, cat:'memory', args:['size'], ret:'heap', effect:'alloc' },
  { id:'calloc', re:/^_?calloc$/i, cat:'memory', args:['nmemb','size'], ret:'heap', effect:'alloc', allocationSize:{ op:'mul', args:[0,1] } },
  { id:'strlen', re:/^_?strlen$/i, cat:'string', args:['str'], ret:'length', effect:'read' },
  { id:'strnlen', re:/^_?strnlen$/i, cat:'string', args:['str','maxlen'], ret:'length', effect:'read' },
  { id:'strcmp', re:/^_?(strcmp|strcasecmp)$/i, cat:'string', args:['a','b'], ret:'diff', effect:'compare' },
  { id:'strncmp', re:/^_?(strncmp|strncasecmp)$/i, cat:'string', args:['a','b','n'], ret:'diff', effect:'compare' },
  { id:'strcpy', re:/^_?(strcpy|stpcpy)$/i, cat:'string', args:['dst','src'], ret:'dst', effect:'copy' },
  { id:'strncpy', re:/^_?strncpy$/i, cat:'string', args:['dst','src','n'], ret:'dst', effect:'copy' },
  { id:'strlcpy', re:/^_?strlcpy$/i, cat:'string', args:['dst','src','dst_size'], ret:'length', effect:'copy' },
  { id:'strcpy_chk', re:/^_?__strcpy_chk$/i, cat:'string', args:['dst','src','dst_object_size'], ret:'dst', effect:'copy' },
  { id:'strncpy_chk', re:/^_?__strncpy_chk$/i, cat:'string', args:['dst','src','n','dst_object_size'], ret:'dst', effect:'copy' },
  { id:'strcat', re:/^_?strcat$/i, cat:'string', args:['dst','src'], ret:'dst', effect:'copy' },
  { id:'strncat', re:/^_?strncat$/i, cat:'string', args:['dst','src','n'], ret:'dst', effect:'copy' },
  { id:'strlcat', re:/^_?strlcat$/i, cat:'string', args:['dst','src','dst_size'], ret:'length', effect:'copy' },
  { id:'sprintf', re:/^_?sprintf$/i, cat:'string', args:['dst','format'], formatIndex:1, variadic:true, ret:'length', effect:'format' },
  { id:'snprintf', re:/^_?snprintf$/i, cat:'string', args:['dst','size','format'], formatIndex:2, variadic:true, ret:'length', effect:'format' },
  { id:'asprintf', re:/^_?asprintf$/i, cat:'string', args:['dst_out','format'], formatIndex:1, variadic:true, ret:'status', effect:'format' },
  { id:'vsnprintf', re:/^_?vsnprintf$/i, cat:'string', args:['dst','size','format','va_list'], formatIndex:2, ret:'length', effect:'format' },
  { id:'sprintf_chk', re:/^_?__sprintf_chk$/i, cat:'string', args:['dst','flag','dst_object_size','format'], formatIndex:3, variadic:true, ret:'length', effect:'format' },
  { id:'snprintf_chk', re:/^_?__snprintf_chk$/i, cat:'string', args:['dst','size','flag','dst_object_size','format'], formatIndex:4, variadic:true, ret:'length', effect:'format' },
  { id:'atoi', re:/^_?(atoi|atol)$/i, cat:'string', args:['str'], ret:'number', effect:'convert' },
  { id:'strtol', re:/^_?(strtol|strtoul)$/i, cat:'string', args:['str','endptr','base'], ret:'number', effect:'convert' },
  { id:'strtod', re:/^_?strtod$/i, cat:'string', args:['str','endptr'], ret:'number', effect:'convert' },
  { id:'printf', re:/^_?printf$/i, cat:'log', args:['format'], formatIndex:0, variadic:true, ret:'status', effect:'log' },
  { id:'fprintf', re:/^_?fprintf$/i, cat:'log', args:['stream','format'], formatIndex:1, variadic:true, ret:'status', effect:'log' },
  { id:'puts', re:/^_?puts$/i, cat:'log', args:['str'], ret:'status', effect:'log' },
  { id:'putchar', re:/^_?putchar$/i, cat:'log', args:['char'], ret:'status', effect:'log' },
  { id:'NSLog', re:/^_?NSLog$/i, cat:'log', args:['format'], formatIndex:0, variadic:true, ret:null, effect:'log' },
  { id:'os_log', re:/^_?os_log$/i, cat:'log', args:['log','type','format'], formatIndex:2, variadic:true, ret:null, effect:'log' },
  { id:'os_log_impl', re:/^_?_os_log_impl$/i, cat:'log', args:['dso','log','type','format','buffer','size'], formatIndex:3, ret:null, effect:'log' },
  { id:'syslog', re:/^_?syslog$/i, cat:'log', args:['priority','format'], formatIndex:1, variadic:true, ret:null, effect:'log' },
  { id:'objc_retain', re:/^_?objc_(retain|autorelease|retainAutorelease(?:ReturnValue)?|retainAutoreleasedReturnValue|autoreleaseReturnValue|claimAutoreleasedReturnValue|unsafeClaimAutoreleasedReturnValue)$/i, cat:'objc', args:['object'], ret:'object', effect:'refcount' },
  { id:'objc_release', re:/^_?objc_release$/i, cat:'objc', args:['object'], ret:null, effect:'refcount' },
  { id:'objc_storeStrong', re:/^_?objc_storeStrong$/i, cat:'objc', args:['slot','value'], ret:null, effect:'store-strong' },
  { id:'swift_retain', re:/^_?swift_(retain|bridgeObjectRetain)$/i, cat:'runtime', args:['object'], ret:'object', effect:'refcount' },
  { id:'swift_release', re:/^_?swift_(release|bridgeObjectRelease)$/i, cat:'runtime', args:['object'], ret:null, effect:'refcount' },
  { id:'swift_allocObject', re:/^_?swift_allocObject$/i, cat:'runtime', args:['metadata','size','align_mask'], ret:'object', effect:'alloc' },
  { id:'open', re:/^_?open$/i, cat:'io', args:['path','flags','mode'], ret:'handle', effect:'open' },
  { id:'openat', re:/^_?openat$/i, cat:'io', args:['dirfd','path','flags','mode'], ret:'handle', effect:'open' },
  { id:'fopen', re:/^_?fopen$/i, cat:'io', args:['path','mode'], ret:'handle', effect:'open' },
  { id:'read', re:/^_?read$/i, cat:'io', args:['fd','buffer','count'], ret:'count', effect:'read' },
  { id:'write', re:/^_?write$/i, cat:'io', args:['fd','buffer','count'], ret:'count', effect:'write' },
  { id:'fread', re:/^_?fread$/i, cat:'io', args:['buffer','size','count','stream'], ret:'count', effect:'read' },
  { id:'fwrite', re:/^_?fwrite$/i, cat:'io', args:['buffer','size','count','stream'], ret:'count', effect:'write' },
  { id:'close', re:/^_?(close|fclose)$/i, cat:'io', args:['handle'], ret:'status', effect:'close' },
  { id:'lseek', re:/^_?lseek$/i, cat:'io', args:['fd','offset','whence'], ret:'offset', effect:'seek' },
  { id:'stat', re:/^_?stat$/i, cat:'io', args:['path','statbuf'], ret:'status', effect:'stat' },
  { id:'unlink', re:/^_?(unlink|remove)$/i, cat:'io', args:['path'], ret:'status', effect:'remove' },
  { id:'mkdir', re:/^_?mkdir$/i, cat:'io', args:['path','mode'], ret:'status', effect:'mkdir' },
  { id:'socket', re:/^_?socket$/i, cat:'network', args:['domain','type','protocol'], ret:'handle', effect:'socket' },
  { id:'connect', re:/^_?(connect|bind)$/i, cat:'network', args:['socket','address','address_length'], ret:'status', effect:'network' },
  { id:'listen', re:/^_?listen$/i, cat:'network', args:['socket','backlog'], ret:'status', effect:'network' },
  { id:'accept', re:/^_?accept$/i, cat:'network', args:['socket','address','address_length_ptr'], ret:'handle', effect:'network' },
  { id:'send', re:/^_?(send|recv)$/i, cat:'network', args:['socket','buffer','length','flags'], ret:'count', effect:'network' },
  { id:'sendto', re:/^_?sendto$/i, cat:'network', args:['socket','buffer','length','flags','address','address_length'], ret:'count', effect:'network' },
  { id:'recvfrom', re:/^_?recvfrom$/i, cat:'network', args:['socket','buffer','length','flags','address','address_length_ptr'], ret:'count', effect:'network' },
  { id:'getaddrinfo', re:/^_?getaddrinfo$/i, cat:'network', args:['node','service','hints','result_out'], ret:'status', effect:'network' },
];

'''
replace('js/blocks.js', 'const API_TABLE = [\n', precise_api + 'const API_TABLE = [\n', '#113-127 precise API table')
replace('js/blocks.js',
        "  const clean = String(name).trim();\n  for (const a of API_TABLE) {",
        "  const clean = String(name).trim();\n  for (const a of PRECISE_API_TABLE) {\n    if (a.re.test(clean)) return a;\n  }\n  for (const a of API_TABLE) {",
        '#113-127 precise lookup')
replace('js/blocks.js',
        "  let parsed = [];\n  try { parsed = parseOperands(opsStr); } catch { parsed = []; }",
        "  let parsed = [];\n  let parseDiagnostic = null;\n  try { parsed = parseOperands(opsStr); }\n  catch (error) {\n    parsed = [];\n    parseDiagnostic = { kind: 'operand-parse-error', message: error?.message || String(error), operands: opsStr };\n  }",
        '#128 parse diagnostics')
replace('js/blocks.js',
        "    data: base.charCodeAt(0) === 46,",
        "    data: base.charCodeAt(0) === 46,\n    unsupported: !!parseDiagnostic,\n    diagnostics: parseDiagnostic ? [parseDiagnostic] : [],",
        '#128 instruction evidence')
replace('js/blocks.js',
        "    try { insns.push(makeInstruction(r)); }\n    catch { /* 1 行壊れていても解析全体は続ける */ }",
        "    try { insns.push(makeInstruction(r)); }\n    catch (error) {\n      insns.push({ row:r?.row, address:r?.address, mnemonic:r?.mn || '', operands:r?.ops || '', ops:[], role:'other', source:null, destination:null, callTarget:null, branchTarget:null, isCall:false, isReturn:false, isBranch:false, isConditional:false, memory:null, data:false, unsupported:true, diagnostics:[{ kind:'instruction-parse-error', message:error?.message || String(error), text:`${r?.mn || ''} ${r?.ops || ''}`.trim() }] });\n    }",
        '#128 outer parse preservation')

# ---------------------------------------------------------------------------
# #135-136 iterative SCC + O(N) dominator storage. Dominator collections remain
# Set-like (.has/.size/iteration) through lightweight ancestor views.
# ---------------------------------------------------------------------------
controlflow = r'''/*
 * Graph-theoretic control-flow analysis shared by the semantic model,
 * CFG viewer and decompiler. Address order is deliberately irrelevant.
 */
function normalizedSuccessors(successors) {
  const n = successors.length;
  return successors.map((xs) => Array.from(new Set((xs || []).filter((x) => Number.isInteger(x) && x >= 0 && x < n))));
}
function predecessorsOf(succ) {
  const pred = succ.map(() => []);
  for (let i = 0; i < succ.length; i++) for (const j of succ[i]) pred[j].push(i);
  return pred;
}
function reachableFrom(succ, entry) {
  const out = new Set();
  if (!(entry >= 0 && entry < succ.length)) return out;
  const stack = [entry];
  while (stack.length) {
    const i = stack.pop();
    if (out.has(i)) continue;
    out.add(i);
    for (const j of succ[i]) if (!out.has(j)) stack.push(j);
  }
  return out;
}
function reversePostOrder(succ, entry, allowed) {
  if (!allowed.has(entry)) return [];
  const seen = new Set([entry]), post = [], frames = [{ node:entry, next:0 }];
  while (frames.length) {
    const frame = frames[frames.length - 1];
    const xs = succ[frame.node];
    if (frame.next < xs.length) {
      const next = xs[frame.next++];
      if (allowed.has(next) && !seen.has(next)) { seen.add(next); frames.push({ node:next, next:0 }); }
    } else { post.push(frame.node); frames.pop(); }
  }
  return post.reverse();
}
function immediateDominatorsCore(succ, pred, entry, allowed) {
  const n = succ.length, rpo = reversePostOrder(succ, entry, allowed);
  const rank = new Int32Array(n); rank.fill(-1);
  rpo.forEach((v, i) => { rank[v] = i; });
  const idom = new Int32Array(n); idom.fill(-1);
  if (!rpo.length) return { idom, rpo };
  idom[entry] = entry;
  const intersect = (a, b) => {
    let x = a, y = b;
    while (x !== y) {
      while (rank[x] > rank[y]) x = idom[x];
      while (rank[y] > rank[x]) y = idom[y];
    }
    return x;
  };
  let changed = true, rounds = 0;
  while (changed && rounds++ < n + 4) {
    changed = false;
    for (let k = 1; k < rpo.length; k++) {
      const b = rpo[k];
      const ps = pred[b].filter((p) => allowed.has(p) && idom[p] >= 0);
      if (!ps.length) continue;
      let next = ps[0];
      for (let i = 1; i < ps.length; i++) next = intersect(next, ps[i]);
      if (idom[b] !== next) { idom[b] = next; changed = true; }
    }
  }
  return { idom, rpo };
}
class AncestorView {
  constructor(node, parent, stop = -1, reachable = true) { this.node=node; this.parent=parent; this.stop=stop; this.reachable=reachable; }
  has(value) {
    if (!this.reachable) return value === this.node;
    let at = this.node, guard = 0;
    while (at >= 0 && at !== this.stop && guard++ <= this.parent.length + 1) {
      if (at === value) return true;
      const p = this.parent[at];
      if (p < 0 || p === at) break;
      at = p;
    }
    return false;
  }
  get size() { let n=0; for (const _ of this) n++; return n; }
  *[Symbol.iterator]() {
    if (!this.reachable) { yield this.node; return; }
    let at=this.node, guard=0;
    while (at >= 0 && at !== this.stop && guard++ <= this.parent.length + 1) {
      yield at;
      const p=this.parent[at];
      if (p < 0 || p === at) break;
      at=p;
    }
  }
}
function iterativeScc(succ, reachable, pred) {
  const seen = new Set(), finish = [];
  for (const root of reachable) {
    if (seen.has(root)) continue;
    seen.add(root);
    const frames=[{node:root,next:0}];
    while (frames.length) {
      const f=frames[frames.length-1], xs=succ[f.node];
      if (f.next < xs.length) {
        const w=xs[f.next++];
        if (reachable.has(w) && !seen.has(w)) { seen.add(w); frames.push({node:w,next:0}); }
      } else { finish.push(f.node); frames.pop(); }
    }
  }
  const components=[], componentOf=new Int32Array(succ.length); componentOf.fill(-1);
  const assigned=new Set();
  for (let k=finish.length-1;k>=0;k--) {
    const root=finish[k]; if (assigned.has(root)) continue;
    const comp=[], stack=[root]; assigned.add(root);
    while (stack.length) {
      const v=stack.pop(); comp.push(v); componentOf[v]=components.length;
      for (const w of pred[v]) if (reachable.has(w) && !assigned.has(w)) { assigned.add(w); stack.push(w); }
    }
    components.push(comp);
  }
  return {components, componentOf:Array.from(componentOf)};
}
function postDominatorsOf(succ, pred, reachable, components, componentOf) {
  const n=succ.length, EXIT=n;
  const compOut=components.map(()=>new Set()), compHasExit=components.map(()=>false);
  for (const i of reachable) {
    const ci=componentOf[i], xs=succ[i].filter(j=>reachable.has(j));
    if (!xs.length) compHasExit[ci]=true;
    for (const j of xs) if (componentOf[j] !== ci) compOut[ci].add(componentOf[j]);
  }
  const bad=new Set(), work=[];
  for (let c=0;c<components.length;c++) if (!compOut[c].size && !compHasExit[c]) for (const i of components[c]) { bad.add(i); work.push(i); }
  while (work.length) {
    const i=work.pop();
    for (const p of pred[i]) if (reachable.has(p) && !bad.has(p)) { bad.add(p); work.push(p); }
  }
  const eligible=new Set([...reachable].filter(i=>!bad.has(i)));
  const rev=Array.from({length:n+1},()=>[]);
  for (const i of eligible) {
    const xs=succ[i].filter(j=>eligible.has(j));
    if (!xs.length) rev[EXIT].push(i);
    else for (const j of xs) rev[j].push(i);
  }
  const revPred=predecessorsOf(rev), allowed=new Set(eligible); allowed.add(EXIT);
  const {idom}=immediateDominatorsCore(rev, revPred, EXIT, allowed);
  const postDominators=Array.from({length:n},(_,i)=>new AncestorView(i,idom,EXIT,eligible.has(i)));
  const immediatePostDominators=Array.from({length:n},(_,i)=> eligible.has(i) && idom[i]>=0 && idom[i]!==EXIT ? idom[i] : null);
  return {postDominators, immediatePostDominators, nonTerminatingReachable:bad};
}
export function analyzeGraph(successors, entry = 0) {
  const succ=normalizedSuccessors(successors||[]), predecessors=predecessorsOf(succ), reachable=reachableFrom(succ,entry);
  const {idom}=immediateDominatorsCore(succ,predecessors,entry,reachable);
  const dominators=succ.map((_,i)=>new AncestorView(i,idom,-1,reachable.has(i)));
  const immediateDominators=succ.map((_,i)=>reachable.has(i) && i!==entry && idom[i]>=0 ? idom[i] : null);
  const {components,componentOf}=iterativeScc(succ,reachable,predecessors);
  const backEdges=[];
  for (const from of reachable) for (const to of succ[from]) if (reachable.has(to) && componentOf[from]>=0 && componentOf[from]===componentOf[to] && dominators[from].has(to)) backEdges.push({from,to});
  const loopByHeader=new Map();
  for (const edge of backEdges) {
    const header=edge.to,latch=edge.from; let loop=loopByHeader.get(header);
    if (!loop) { loop={header,latches:new Set(),nodes:new Set([header]),exits:new Set()}; loopByHeader.set(header,loop); }
    loop.latches.add(latch); const members=new Set([header,latch]), stack=latch===header?[]:[latch];
    while (stack.length) {
      const x=stack.pop();
      for (const p of predecessors[x]) {
        if (!reachable.has(p)||members.has(p)||!dominators[p].has(header)||componentOf[p]!==componentOf[header]) continue;
        members.add(p); if (p!==header) stack.push(p);
      }
    }
    for (const x of members) loop.nodes.add(x);
  }
  for (const loop of loopByHeader.values()) for (const x of loop.nodes) for (const y of succ[x]) if (!loop.nodes.has(y)) loop.exits.add(y);
  const post=postDominatorsOf(succ,predecessors,reachable,components,componentOf);
  return {successors:succ,predecessors,reachable,dominators,immediateDominators,components,componentOf,backEdges,loops:[...loopByHeader.values()],loopByHeader,postDominators:post.postDominators,immediatePostDominators:post.immediatePostDominators,nonTerminatingReachable:post.nonTerminatingReachable};
}
'''
write('js/controlflow.js', controlflow)

# ---------------------------------------------------------------------------
# #132-134 CFG edge semantics and lookup
# ---------------------------------------------------------------------------
replace('js/cfg.js',
        "          node.succ.push({ to: -1, kind: EDGE.JUMP, target, address: inst.address, outside: true });\n          node.isExit = true;",
        "          node.succ.push({ to: -1, kind: isUncond ? EDGE.JUMP : EDGE.TAKEN, target, address: inst.address, outside: true, conditional: !isUncond });\n          node.isExit = !!isUncond;",
        '#132 external conditional edge')
replace('js/cfg.js',
        "        thenBlock: c, elseBlock: a, merge,",
        "        thenBlock: a, elseBlock: c, takenBlock: a, fallBlock: c, merge,",
        '#133 shape arm polarity')
# Replace linear block lookup if present in the expected compact form.
sub('js/cfg.js', r'function blockAtRow\(blocks, row\) \{.*?\n\}', r'''function blockAtRow(blocks, row) {
  let lo = 0, hi = blocks.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1, b = blocks[mid];
    if (row < b.startRow) hi = mid - 1;
    else if (row > b.endRow) lo = mid + 1;
    else return b.index;
  }
  return -1;
}''', label='#134 blockAtRow binary search')

# ---------------------------------------------------------------------------
# #129, #131-132, #137 IR consistency/ABI/location identity.
# ---------------------------------------------------------------------------
replace('js/ir-core.js', 'function lift(insn) {', 'function lift(insn, opts = {}) {', '#130/131 lift options')
replace('js/ir-core.js',
        "  if (insn.isReturn) { push({ op: OP.RET, srcs: [{ t: 'reg', reg: 'x0', bits: 64 }] }); return out; }\n  if (insn.isCall) {\n    push({\n      op: OP.CALL,\n      target: insn.callTarget != null ? insn.callTarget : null,\n      indirect: insn.callTarget == null,\n      srcs: (insn.callTarget == null && ops[0] && ops[0].k === 'reg')\n        ? [{ t: 'reg', reg: regKeyOf(ops[0]), bits: 64 }] : [],\n      dstReg: 'x0', dstBits: 64,\n      clobbers: CALL_CLOBBERS,\n    });\n    return out;\n  }",
        "  if (insn.isReturn) {\n    let proto = null;\n    try { proto = opts.prototypeForReturn?.(insn) || opts.functionPrototype || null; } catch {}\n    const returns = Array.isArray(proto?.returns) ? proto.returns : proto?.returnLocations;\n    const srcs = proto?.returnType === 'void' || proto?.void === true ? [] : Array.isArray(returns)\n      ? returns.filter((x) => x?.reg).map((x) => ({ t:'reg', reg:x.reg, bits:x.bits || 64 }))\n      : (opts.assumeIntegerReturn === true ? [{ t:'reg', reg:'x0', bits:64 }] : []);\n    push({ op: OP.RET, srcs, returnUnknown: !proto && opts.assumeIntegerReturn !== true }); return out;\n  }\n  if (insn.isCall) {\n    let proto = null;\n    try { proto = opts.callPrototypeForIR?.(insn.callTarget, insn) || null; } catch {}\n    const returns = Array.isArray(proto?.returns) ? proto.returns : proto?.returnLocations;\n    const firstReturn = proto?.returnType === 'void' || proto?.void === true ? null : Array.isArray(returns) ? returns.find((x) => x?.reg) : null;\n    const call = push({\n      op: OP.CALL,\n      target: insn.callTarget != null ? insn.callTarget : null,\n      indirect: insn.callTarget == null,\n      srcs: (insn.callTarget == null && ops[0] && ops[0].k === 'reg') ? [{ t:'reg', reg:regKeyOf(ops[0]), bits:64 }] : [],\n      dstReg: firstReturn?.reg || null, dstBits: firstReturn?.bits || null,\n      returnLocations: returns || (proto?.returnType === 'void' || proto?.void === true ? [] : null),\n      indirectResultReg: proto?.sret || proto?.indirectResult ? 'x8' : null,\n      clobbers: CALL_CLOBBERS,\n    });\n    if (!proto) { call.dstReg = null; call.dstBits = null; call.returnUnknown = true; }\n    return out;\n  }",
        '#130/131 ABI return model')
replace('js/ir-core.js', 'try { parts = lift(insn); } catch { parts = []; }', 'try { parts = lift(insn, o); } catch { parts = []; }', '#130/131 pass options')
# Truncation: build CFG from the same bounded instruction universe.
replace('js/ir-core.js',
        "  const insns = model.instructions.length > MAX_INSTRUCTIONS ? model.instructions.slice(0, MAX_INSTRUCTIONS) : model.instructions;\n  const truncated = insns.length !== model.instructions.length;\n  const cfg = o.cfg || buildCfg(model, o);",
        "  const insns = model.instructions.length > MAX_INSTRUCTIONS ? model.instructions.slice(0, MAX_INSTRUCTIONS) : model.instructions;\n  const truncated = insns.length !== model.instructions.length;\n  let cfgModel = model;\n  if (truncated) {\n    const lastRow = insns.length ? insns[insns.length - 1].row : -1;\n    cfgModel = { ...model, instructions: insns, basicBlocks: (model.basicBlocks || []).filter((b) => b.startRow <= lastRow).map((b) => ({ ...b, endRow: Math.min(b.endRow, lastRow), rows: Array.isArray(b.rows) ? b.rows.filter((r) => r <= lastRow) : b.rows })) };\n  }\n  const cfg = !truncated && o.cfg ? o.cfg : buildCfg(cfgModel, o);",
        '#129 bounded CFG')
# Carry edge provenance into IR blocks.
replace('js/ir-core.js',
        "      succ: nodes[i].succ.filter((s) => s.to >= 0).map((s) => s.to),",
        "      succ: nodes[i].succ.filter((s) => s.to >= 0).map((s) => s.to),\n      edges: nodes[i].succ.map((s) => ({ ...s })),",
        '#132/139 edge provenance')
# Signed stack identity; includes base register and SSA frame epoch.
replace('js/ir-core.js',
        "  if (a.stack) return { key: 'stack:' + a.disp.toString(), kind: MK.STACK, disp: a.disp, size: a.size };",
        "  if (a.stack) {\n    const baseReg = a.baseReg || a.base?.reg || 'sp';\n    const frameEpoch = Number.isInteger(a.base?.version) ? a.base.version : 0;\n    return { key: `stack:${baseReg}:${frameEpoch}:${a.disp.toString()}`, kind: MK.STACK, disp:a.disp, size:a.size, baseReg, frameEpoch };\n  }",
        '#137 stack location identity')

# ---------------------------------------------------------------------------
# #138-142 semantic decompiler: no invented condition/successor polarity; use
# per-return-site reaching evidence.
# ---------------------------------------------------------------------------
replace('js/decompiler/semantic.js',
        "  let cond = inst.cond || inst.extra?.cond || 'ne';\n  if (invert) cond = inverseCondition(cond) || cond;",
        "  let cond = inst.cond || inst.extra?.cond || null;\n  if (!cond || !COND[cond]) {\n    const token = JSON.stringify(cond || inst.text || 'unknown');\n    const opaque = `__arm64_cond(${token})`;\n    return invert ? `!(${opaque})` : opaque;\n  }\n  if (invert) cond = inverseCondition(cond) || cond;",
        '#138 unknown condition')
# branchSucc function: replace fallback ordering with edge evidence.
sub('js/decompiler/semantic.js', r'function branchSucc\(ir, block, term, ctx\) \{.*?\n\}', r'''function branchSucc(ir, block, term, ctx) {
  const succ = block?.succ || [];
  if (term?.op !== OP.CBR || succ.length < 2) return { yes:succ[0] ?? null, no:succ[1] ?? null };
  const edges = block?.edges || [];
  const taken = edges.find((e) => e.kind === 'taken' && e.to >= 0)?.to;
  const fall = edges.find((e) => e.kind === 'fallthrough' && e.to >= 0)?.to;
  if (taken != null || fall != null) return { yes:taken ?? null, no:fall ?? null };
  const yes = targetBlock(ir, term, ctx.opts);
  if (yes == null || !succ.includes(yes)) return { yes:null, no:null };
  return { yes, no:succ.find((x) => x !== yes) ?? null };
}''', label='#139 branch successor evidence')
# Never collapse stack identities merely because displacements match.
sub('js/decompiler/semantic.js', r'function stackName\(.*?\n\}', lambda m: m.group(0).replace(" || s.disp === loc.disp", ""), label='#137 stackName identity')
# Last-RET global anchor -> list of return sites.
replace('js/decompiler/semantic.js',
        "returnInst: [...ir.instructions].reverse().find((inst) => inst.op === OP.RET) || null,",
        "returnInsts: ir.instructions.filter((inst) => inst.op === OP.RET),",
        '#142 per-return sites')
# feedsReturn may have exact textual shape; adapt if found.
text = read('js/decompiler/semantic.js')
if 'ctx.returnInst' in text:
    text = text.replace('ctx.returnInst', '(ctx.returnInsts || [])[0]')
    write('js/decompiler/semantic.js', text)

# stack-return recovery: resolve each return independently and only rewrite when
# all return sites prove the same expression. This removes sibling leakage.
replace('js/decompiler/passes/stack-return-recovery.js',
        "  const ret = [...(result.ir.instructions || [])].reverse().find((i) => i.op === 'ret');\n  if (!ret) return result;",
        "  const rets = (result.ir.instructions || []).filter((i) => i.op === 'ret');\n  if (!rets.length) return result;",
        '#141/#142 all returns')
replace('js/decompiler/passes/stack-return-recovery.js',
        "  const committed = committedReturnValue(result, root, ret);\n  const recovered = committed || resolve(result.ir, ret.block, ret.row, root.location.key, values, opts, engine, new Set());\n  // A stack load means no useful reconstruction happened. A committed non-stack\n  // field/global load is an intentional high-level return and must be retained.\n  if (!recovered || (recovered.kind === 'load' && recovered.location?.kind === 'stack') || !rewriteReturn(result, recovered, opts)) return result;",
        "  const recoveredAt = rets.map((ret) => committedReturnValue(result, root, ret) || resolve(result.ir, ret.block, ret.row, root.location.key, values, opts, engine, new Set()));\n  if (recoveredAt.some((x) => !x || (x.kind === 'load' && x.location?.kind === 'stack'))) return result;\n  const keys = new Set(recoveredAt.map((x) => structuralKey(x)));\n  if (keys.size !== 1 || !rewriteReturn(result, recoveredAt[0], opts)) return result;\n  const recovered = recoveredAt[0];",
        '#141/#142 reaching definitions')
# stack-phi controller: reject row-order heuristic by requiring dominance of merge.
replace('js/decompiler/passes/stack-phi-recovery.js',
        "    candidates.push({ term, yesIndex, noIndex, row: term.row ?? -1 });\n  }\n  candidates.sort((a, b) => b.row - a.row);\n  return candidates[0] || null;",
        "    if (ir.dominators?.[mergeBlock] && !ir.dominators[mergeBlock].has(block.index)) continue;\n    candidates.push({ term, yesIndex, noIndex, block:block.index });\n  }\n  if (candidates.length !== 1) return null;\n  return candidates[0];",
        '#140 dominance controller')

# ---------------------------------------------------------------------------
# #143-145 AAPCS64 prototype recovery. Extend rather than remove legacy fields.
# ---------------------------------------------------------------------------
prototype = r'''import { VK, MK } from '../../ir.js';

function usedValue(value) { return !!(value?.uses && value.uses.length); }
function contiguousUsed(ir, prefix, count = 8) {
  let last = -1;
  for (let i=0;i<count;i++) if (usedValue(ir.args?.get?.(`${prefix}${i}`))) last=i;
  return Array.from({length:last+1},(_,i)=>i);
}
function stackArguments(ir) {
  const seen=new Map();
  for (const inst of ir.instructions || []) {
    if (inst.op !== 'load' || inst.loc?.kind !== MK.STACK) continue;
    const addr=inst.addr || {};
    const base=addr.base;
    if ((addr.baseReg || base?.reg) !== 'sp' || base?.kind !== VK.ARG || Number(base?.version || 0) !== 0) continue;
    const disp=BigInt(addr.disp ?? inst.loc.disp ?? -1);
    if (disp < 0n) continue;
    const key=disp.toString();
    if (!seen.has(key)) seen.set(key,{location:'stack',stackOffset:disp,bits:Number((inst.size || inst.loc.size || 8)*8),class:'stack'});
  }
  return [...seen.values()].sort((a,b)=>a.stackOffset<b.stackOffset?-1:a.stackOffset>b.stackOffset?1:0);
}
function typeAt(types, reg, fallback='uint64_t') {
  const t=types?.values?.get?.(reg) || types?.args?.get?.(reg) || null;
  return t?.name || t?.type || fallback;
}
export function recoverFunctionPrototype(ir, types = {}, opts = {}) {
  const args=[];
  for (const i of contiguousUsed(ir,'x')) args.push({index:args.length,name:`arg${args.length}`,location:`x${i}`,reg:`x${i}`,class:'integer',type:typeAt(types,`x${i}`)});
  for (const i of contiguousUsed(ir,'v')) args.push({index:args.length,name:`arg${args.length}`,location:`v${i}`,reg:`v${i}`,class:'fp-simd',type:typeAt(types,`v${i}`,'double')});
  for (const loc of stackArguments(ir)) args.push({index:args.length,name:`arg${args.length}`,...loc,type:'uint64_t'});
  const x8=ir.args?.get?.('x8');
  const sret=!!(opts.sret || (x8 && usedValue(x8) && opts.allowInferredSret));
  let returns=[];
  if (opts.voidReturn || types?.ret?.kind === 'void' || types?.ret?.name === 'void') returns=[];
  else if (Array.isArray(opts.returnLocations)) returns=opts.returnLocations.map((x)=>typeof x==='string'?{reg:x,bits:64}:x);
  else {
    const rt=types?.ret || {};
    const name=String(rt.name || rt.type || '').toLowerCase();
    if (sret) returns=[];
    else if (/float|double|vector|simd/.test(name)) returns=[{reg:'v0',bits:rt.bits || 128,class:'fp-simd'}];
    else if (rt.registers > 1 || rt.aggregateRegisters > 1) returns=Array.from({length:Math.min(2,rt.registers || rt.aggregateRegisters)},(_,i)=>({reg:`x${i}`,bits:64,class:'integer'}));
    else if (rt.kind || rt.name || opts.assumeIntegerReturn) returns=[{reg:'x0',bits:rt.bits || 64,class:'integer'}];
  }
  return {
    args,
    returnType: sret ? (opts.sretType || 'indirect') : (types?.ret?.name || types?.ret?.type || (returns.length ? 'uint64_t' : 'unknown')),
    returnLocations: returns,
    returns,
    sret,
    indirectResultRegister:sret?'x8':null,
    abi:'aapcs64',
  };
}
'''
write('js/decompiler/types/prototype.js', prototype)

# Call prototype helpers: arity >8 is valid and expose stack locations.
replace('js/decompiler/call-prototypes.js', 'return Number.isInteger(n) && n >= 0 && n <= 8 ? n : null;', 'return Number.isInteger(n) && n >= 0 && n <= 64 ? n : null;', '#144 arity > 8')
replace('js/decompiler/call-prototypes.js',
        "  const count = Math.max(0, Math.min(8, Number(n) || 0));\n  return Array.from({ length: count }, (_, i) => i);",
        "  const count = Math.max(0, Math.min(64, Number(n) || 0));\n  return Array.from({ length: count }, (_, i) => i);",
        '#144 call arg indices')
# semantic call rendering currently indexes x-register arrays. For >8, retain
# proven stack locations as explicit arguments instead of reading x8+.
replace('js/decompiler/semantic.js',
        "      logicalArgs = indexes.map((i) => argText[i] ?? 'unknown');",
        "      logicalArgs = indexes.map((i) => i < 8 ? (argText[i] ?? 'unknown') : (ctx.opts.stackArgumentAtCall?.(inst, i - 8) ?? `stack_arg_${i - 8}`));",
        '#144 caller stack args')

# ---------------------------------------------------------------------------
# Regression tests dedicated to this issue range. They exercise exported APIs
# plus source-level invariants for worker-only code that cannot be imported in
# Node without a Worker global.
# ---------------------------------------------------------------------------
test = r'''import assert from 'node:assert/strict';
import fs from 'node:fs';
import { apiInfo, makeInstruction } from '../js/blocks.js';
import { analyzeGraph } from '../js/controlflow.js';
import { asByteSource, MemoryByteSource } from '../js/binary/source.js';
import { InstrumentedByteSource } from '../js/bytesource/cached.js';
import { callArgumentIndices } from '../js/decompiler/call-prototypes.js';

// #108 stricter policy must wrap an existing source.
const base = new MemoryByteSource(new Uint8Array(32), { maxReadLength: 32 });
const wrapped = asByteSource(base, { maxReadLength: 8 });
assert.notEqual(wrapped, base);
await assert.rejects(() => wrapped.readExactly(0n, 9));

// #109 abort is forwarded through the instrumentation wrapper.
const inst = new InstrumentedByteSource(base), controller = new AbortController(); controller.abort();
await assert.rejects(() => inst.read(0n, 1, { signal:controller.signal }));

// #113-127 representative exact schemas.
assert.deepEqual(apiInfo('bcopy').args, ['src','dst','size']);
assert.deepEqual(apiInfo('bzero').args, ['dst','size']);
assert.deepEqual(apiInfo('__memcpy_chk').args, ['dst','src','size','dst_object_size']);
assert.deepEqual(apiInfo('calloc').args, ['nmemb','size']);
assert.deepEqual(apiInfo('strnlen').args, ['str','maxlen']);
assert.deepEqual(apiInfo('strncmp').args, ['a','b','n']);
assert.deepEqual(apiInfo('strlcpy').args, ['dst','src','dst_size']);
assert.deepEqual(apiInfo('strncat').args, ['dst','src','n']);
assert.equal(apiInfo('snprintf').formatIndex, 2);
assert.deepEqual(apiInfo('strtol').args, ['str','endptr','base']);
assert.deepEqual(apiInfo('fprintf').args, ['stream','format']);
assert.equal(apiInfo('objc_release').ret, null);
assert.deepEqual(apiInfo('objc_storeStrong').args, ['slot','value']);
assert.deepEqual(apiInfo('swift_allocObject').args, ['metadata','size','align_mask']);
assert.deepEqual(apiInfo('read').args, ['fd','buffer','count']);
assert.deepEqual(apiInfo('connect').args, ['socket','address','address_length']);

// #128 parser failure evidence is not silently discarded.
const bad = makeInstruction({ row:0, address:0n, mn:'ldr', ops:'[x0, ???' });
assert.ok(Array.isArray(bad.diagnostics));

// #135 deep graph does not recurse; #136 views do not materialize per-node Sets.
const n=20000, chain=Array.from({length:n},(_,i)=>i+1<n?[i+1]:[]);
const graph=analyzeGraph(chain,0);
assert.equal(graph.reachable.size,n);
assert.equal(graph.dominators[n-1].has(0),true);
assert.equal(graph.immediateDominators[n-1],n-2);
assert.equal(graph.dominators[n-1] instanceof Set,false);

// #144 fixed arity beyond x7 retains indexes for stack arguments.
assert.equal(callArgumentIndices({override:{arity:10}}).length,10);

const worker=fs.readFileSync(new URL('../js/platform/worker.js', import.meta.url),'utf8');
assert.match(worker,/Duplicate active platform request id/); // #106
assert.match(worker,/Chunk index must be a non-negative safe integer/); // #111
assert.match(worker,/c === 0xed && b1 > 0x9f/); // #110
assert.match(worker,/const regionBytes = BigInt\(region.size\)/); // #105
assert.match(worker,/functionStartsExact: functions.length > 0 && functionExact\.every/); // #112

const cfg=fs.readFileSync(new URL('../js/cfg.js', import.meta.url),'utf8');
assert.match(cfg,/isUncond \? EDGE\.JUMP : EDGE\.TAKEN/); // #132
assert.match(cfg,/thenBlock: a, elseBlock: c/); // #133
const ir=fs.readFileSync(new URL('../js/ir-core.js', import.meta.url),'utf8');
assert.match(ir,/stack:\$\{baseReg\}:\$\{frameEpoch\}:/); // #137
assert.match(ir,/returnUnknown/); // #130/#131
const sem=fs.readFileSync(new URL('../js/decompiler/semantic.js', import.meta.url),'utf8');
assert.match(sem,/__arm64_cond/); // #138
assert.match(sem,/yes:null, no:null/); // #139

console.log('issues 101-145 regression tests passed');
'''
write('tests/issues-101-145.mjs', test)

# Make the dedicated regression part of the normal test command.
pkg = read('package.json')
pkg = pkg.replace('"test": "node tests/run.js', '"test": "node tests/issues-101-145.mjs && node tests/run.js', 1)
write('package.json', pkg)

print('issues 101-145 patch applied')
