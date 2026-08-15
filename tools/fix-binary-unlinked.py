from pathlib import Path


def rep(path, old, new, label):
    p=Path(path); s=p.read_text()
    if new in s:
        print('already',label); return
    if old not in s:
        raise SystemExit(f'missing {label} in {path}')
    p.write_text(s.replace(old,new,1))

# #446 Apple chained-pointer formats 7/10 advance in 4-byte strides.
rep('js/binary/macho-dyld.js', """    return { bind, ordinal, addend, next, stride: 8 };
  }
  return { bind: false, ordinal: 0, addend: 0, next: 0, stride: 8 };""", """    const stride = (format === 7 || format === 10) ? 4 : 8;
    return { bind, ordinal, addend, next, stride };
  }
  return { bind: false, ordinal: 0, addend: 0, next: 0, stride: 8 };""", '#446 stride')
# expose decoder for ABI truth regression without changing existing callers.
p=Path('js/binary/macho-dyld.js'); s=p.read_text()
if 'export function decodeChainedPointer' not in s:
    s=s.replace('function decodeChainedPointer(raw, format) {','export function decodeChainedPointer(raw, format) {',1)
    p.write_text(s)

# #448 bound PE thunk walks by file-backed INT and IAT sections.
p=Path('js/binary/pe-loader.js'); s=p.read_text()
helper="""function fileBackedSectionEnd(image, rva) {
  if (!Number.isInteger(rva) || rva < 0) return null;
  const address = image.imageBase + BigInt(rva);
  const sec = image.sectionAt(address);
  if (!sec || sec.source !== 'PE-section') return null;
  const delta = address - sec.address;
  if (delta < 0n || delta >= sec.fileSize) return null;
  const end = sec.fileOffset + sec.fileSize;
  return end <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(end) : null;
}

"""
if 'function fileBackedSectionEnd(image, rva)' not in s:
    s=s.replace('export function parseImports(r, dir, image) {',helper+'export function parseImports(r, dir, image) {',1)
old="""    let thunkRva = originalFirstThunk || firstThunk;
    let thunkOff = rvaToOffset(image, thunkRva);
    if (thunkOff == null) continue;
    for (let index = 0; index < 100000; index++, thunkOff += ptrSize, thunkRva += ptrSize) {
      if (thunkOff + ptrSize > r.length) break;
      const raw = image.bits === 64 ? r.u64(thunkOff) : BigInt(r.u32(thunkOff));
      if (raw === 0n) break;"""
new="""    let thunkRva = originalFirstThunk || firstThunk;
    let thunkOff = rvaToOffset(image, thunkRva);
    if (thunkOff == null) continue;
    const thunkEnd = fileBackedSectionEnd(image, thunkRva);
    const iatOff = rvaToOffset(image, firstThunk);
    const iatEnd = fileBackedSectionEnd(image, firstThunk);
    if (thunkEnd == null || iatOff == null || iatEnd == null) {
      image.warnings.push(`PE import thunk for ${library || '<unknown>'} is not file-backed`);
      continue;
    }
    let terminated = false;
    for (let index = 0; index < 100000; index++, thunkOff += ptrSize, thunkRva += ptrSize) {
      const iatEntryOff = iatOff + index * ptrSize;
      if (thunkOff + ptrSize > thunkEnd || iatEntryOff + ptrSize > iatEnd || thunkOff + ptrSize > r.length) break;
      const raw = image.bits === 64 ? r.u64(thunkOff) : BigInt(r.u32(thunkOff));
      if (raw === 0n) { terminated = true; break; }"""
if new not in s:
    if old not in s: raise SystemExit('missing #448 thunk loop')
    s=s.replace(old,new,1)
old2="""      image.imports.push({ name: name || `#${ordinal}`, library, ordinal, hint, source: 'PE-import', sites: [{ address: iatAddress, offset: image.addressToOffset(iatAddress), kind: 'iat' }] });
    }
  }
}"""
new2="""      image.imports.push({ name: name || `#${ordinal}`, library, ordinal, hint, source: 'PE-import', sites: [{ address: iatAddress, offset: image.addressToOffset(iatAddress), kind: 'iat' }] });
    }
    if (!terminated) image.warnings.push(`PE import thunk for ${library || '<unknown>'} reached its file-backed section boundary without a terminator`);
  }
}"""
if new2 not in s:
    if old2 not in s: raise SystemExit('missing #448 warning anchor')
    s=s.replace(old2,new2,1)
p.write_text(s)

# #450 direct FunctionSandbox API is itself a trust boundary.
p=Path('js/symbolic/function-sandbox.js'); s=p.read_text()
if "from '../debug/adapter.js'" not in s:
    s=s.replace("import { symbolicExecute } from './executor.js';", "import { symbolicExecute } from './executor.js';\nimport { boundedInteger } from '../debug/adapter.js';",1)
old="const maxSteps = Math.max(1, Number(o.maxSteps || 20000));"
new="const maxSteps = boundedInteger(o.maxSteps, 20000, 1, 1_000_000, 'maxSteps');"
if new not in s:
    if old not in s: raise SystemExit('missing #450 maxSteps anchor')
    s=s.replace(old,new,1)
p.write_text(s)

# #466 propagate AbortSignal through all structural source reads and passes.
p=Path('js/binary/source-loaders.js'); s=p.read_text()
# top-level prefix
s=s.replace('const prefix = await source.readExactly(0n, prefixLength);','const prefix = await source.readExactly(0n, prefixLength, { signal: opts.signal });',1)
# ensure range options always carry signal
s=s.replace('const rangeOptions = opts.ranges || {};','const rangeOptions = { ...(opts.ranges || {}), signal: opts.ranges?.signal ?? opts.signal };',1)
# direct parse helpers may be called independently; preserve passed range options + opts signal
s=s.replace("export async function parseELFSource(input, opts = {}, prefix = null, rangeOptions = opts.ranges || {}) {", "export async function parseELFSource(input, opts = {}, prefix = null, rangeOptions = opts.ranges || {}) {\n  rangeOptions = { ...rangeOptions, signal: rangeOptions.signal ?? opts.signal };",1)
s=s.replace("export async function parsePESource(input, opts = {}, prefix = null, rangeOptions = opts.ranges || {}) {", "export async function parsePESource(input, opts = {}, prefix = null, rangeOptions = opts.ranges || {}) {\n  rangeOptions = { ...rangeOptions, signal: rangeOptions.signal ?? opts.signal };",1)
s=s.replace("export async function parseMachOSource(input, opts = {}, prefix = null, rangeOptions = opts.ranges || {}) {", "export async function parseMachOSource(input, opts = {}, prefix = null, rangeOptions = opts.ranges || {}) {\n  rangeOptions = { ...rangeOptions, signal: rangeOptions.signal ?? opts.signal };",1)
# prefix/fat table reads
s=s.replace("const magic = prefix || await source.readExactly(0n, Number(source.size < 16n ? source.size : 16n));", "const magic = prefix || await source.readExactly(0n, Number(source.size < 16n ? source.size : 16n), { signal: opts.signal });",1)
s=s.replace("const head = magic.byteLength >= 8 ? magic.subarray(0, 8) : await source.readExactly(0n, 8);", "const head = magic.byteLength >= 8 ? magic.subarray(0, 8) : await source.readExactly(0n, 8, { signal: opts.signal });",1)
s=s.replace("const table = await source.readExactly(8n, tableSize);", "const table = await source.readExactly(8n, tableSize, { signal: opts.signal });",1)
s=s.replace('const slicePrefix = await readPrefix(sliceSource);','const slicePrefix = await readPrefix(sliceSource, opts.signal);',1)
s=s.replace('async function readPrefix(source) {\n  return source.readExactly(0n, Number(source.size < 16n ? source.size : 16n));\n}', "async function readPrefix(source, signal = null) {\n  return source.readExactly(0n, Number(source.size < 16n ? source.size : 16n), { signal });\n}")
s=s.replace('const magic = prefix || await readPrefix(source);','const magic = prefix || await readPrefix(source, opts.signal);')
p.write_text(s)

p=Path('js/binary/source-reader.js'); s=p.read_text()
if 'function throwIfSourceAborted(signal)' not in s:
    s=s.replace("export class SourceRangeMissingError extends BinaryReadError {", "function throwIfSourceAborted(signal) {\n  if (!signal?.aborted) return;\n  const cancelled = new Error('binary metadata read aborted');\n  cancelled.name = 'AbortError';\n  cancelled.code = 'BYTE_SOURCE_CANCELLED';\n  throw cancelled;\n}\n\nexport class SourceRangeMissingError extends BinaryReadError {",1)
s=s.replace('  for (;;) {\n    try {','  for (;;) {\n    throwIfSourceAborted(options.signal);\n    try {',1)
s=s.replace("        if (options.signal?.aborted) {\n          const cancelled = new Error('binary metadata read aborted');\n          cancelled.name = 'AbortError';\n          throw cancelled;\n        }", '        throwIfSourceAborted(options.signal);',1)
s=s.replace('        const bytes = await source.readExactly(cursor, length, { signal: options.signal });\n        const added = sparse.additionalBytes(cursor, bytes.byteLength);', '        const bytes = await source.readExactly(cursor, length, { signal: options.signal });\n        throwIfSourceAborted(options.signal);\n        const added = sparse.additionalBytes(cursor, bytes.byteLength);',1)
p.write_text(s)
