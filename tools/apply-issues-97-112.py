from pathlib import Path

# ---------- PE loader ----------
p=Path('js/binary/pe-loader.js'); t=p.read_text()
# Exception ranges: accept only mapped executable code ranges.
old="""export function parseExceptionFunctions(r, dir, image, machine) {
  if (!dir || !dir.rva || !dir.size) return;
"""
new="""function executableRvaRange(image, beginRva, size = 1) {
  if (!Number.isInteger(beginRva) || beginRva <= 0 || !Number.isInteger(size) || size <= 0) return false;
  const begin = image.imageBase + BigInt(beginRva);
  const end = begin + BigInt(size);
  const sec = image.sectionAt(begin);
  return !!(sec?.perms?.execute && end <= sec.address + sec.size);
}

export function parseExceptionFunctions(r, dir, image, machine) {
  if (!dir || !dir.rva || !dir.size) return;
"""
if t.count(old)!=1: raise SystemExit('exception function marker mismatch')
t=t.replace(old,new)
t=t.replace(
"""      if (!begin || finish <= begin) continue;
      image.functions.push(functionSeed(image.imageBase + BigInt(begin), { size: BigInt(finish - begin), source: 'exception', confidence: 0.999 }));
""",
"""      if (!begin || finish <= begin || !executableRvaRange(image, begin, finish - begin)) {
        if (begin || finish) image.warnings.push(`Ignored invalid x64 exception range RVA 0x${begin.toString(16)}..0x${finish.toString(16)}`);
        continue;
      }
      image.functions.push(functionSeed(image.imageBase + BigInt(begin), { size: BigInt(finish - begin), source: 'exception', confidence: 0.999 }));
""",1)
t=t.replace(
"""      if (!begin) continue;
      let size = null;
""",
"""      if (!begin || !executableRvaRange(image, begin, 1)) {
        if (begin) image.warnings.push(`Ignored ARM64 exception entry outside executable sections at RVA 0x${begin.toString(16)}`);
        continue;
      }
      let size = null;
""",1)
# Inline ARM64 size must itself remain in executable section.
old="""        if (functionLength) size = BigInt(functionLength * 4);
      }
      image.functions.push(functionSeed(image.imageBase + BigInt(begin), { size, source: 'exception', confidence: 0.995 }));
"""
new="""        if (functionLength) {
          const bytes = functionLength * 4;
          if (!executableRvaRange(image, begin, bytes)) {
            image.warnings.push(`Ignored ARM64 exception range extending outside executable section at RVA 0x${begin.toString(16)}`);
            continue;
          }
          size = BigInt(bytes);
        }
      }
      image.functions.push(functionSeed(image.imageBase + BigInt(begin), { size, source: 'exception', confidence: 0.995 }));
"""
if t.count(old)!=1: raise SystemExit('arm exception size mismatch')
t=t.replace(old,new)
# Base reloc: even block size + machine-specific known types only.
old="""export function parseBaseRelocations(r, dir, image) {
  if (!dir || !dir.rva || dir.size < 8) return;
"""
new="""function allowedBaseRelocationTypes(machine) {
  // IMAGE_REL_BASED_* values defined for the corresponding PE machine.
  if (machine === 0x014c) return new Set([1, 2, 3, 4]);                 // x86
  if (machine === 0x8664) return new Set([1, 2, 3, 4, 10]);            // x86-64
  if (machine === 0x01c0 || machine === 0x01c4) return new Set([3, 5, 7]); // ARM/Thumb
  if (machine === 0xaa64 || machine === 0xa641) return new Set([4, 5, 6, 7, 8, 10]); // ARM64/ARM64EC
  return new Set([1, 2, 3, 4, 5, 6, 7, 8, 10]);
}

export function parseBaseRelocations(r, dir, image, machine = null) {
  if (!dir || !dir.rva || dir.size < 8) return;
"""
if t.count(old)!=1: raise SystemExit('base reloc signature mismatch')
t=t.replace(old,new)
old="""  while (off + 8 <= end) {
    const pageRva = r.u32(off), blockSize = r.u32(off + 4);
    if (blockSize < 8 || off + blockSize > end) break;
    const count = Math.floor((blockSize - 8) / 2);
"""
new="""  const allowed = allowedBaseRelocationTypes(machine);
  while (off + 8 <= end) {
    const pageRva = r.u32(off), blockSize = r.u32(off + 4);
    if (blockSize < 8 || (blockSize & 1) !== 0 || off + blockSize > end) {
      image.warnings.push(`Malformed PE base-relocation block at file offset 0x${off.toString(16)}`);
      break;
    }
    const count = (blockSize - 8) / 2;
"""
if t.count(old)!=1: raise SystemExit('reloc block validation mismatch')
t=t.replace(old,new)
old="""      const raw = r.u16(off + 8 + i * 2), type = raw >>> 12, within = raw & 0xfff;
      if (!type) continue;
      const address = image.imageBase + BigInt(pageRva + within);
"""
new="""      const raw = r.u16(off + 8 + i * 2), type = raw >>> 12, within = raw & 0xfff;
      if (!type) continue;
      if (!allowed.has(type)) {
        image.warnings.push(`Ignored reserved/unsupported PE base relocation type ${type} at RVA 0x${(pageRva + within).toString(16)}`);
        continue;
      }
      const address = image.imageBase + BigInt(pageRva + within);
"""
if t.count(old)!=1: raise SystemExit('reloc type validation mismatch')
t=t.replace(old,new)
# COFF long section-name resolver + new PE directories.
append=r'''

export function resolveCoffSectionName(r, inlineName, ptrSymbols, count) {
  const raw = String(inlineName || '');
  const m = /^\/(\d+)$/.exec(raw);
  if (!m) return raw;
  if (!ptrSymbols || !Number.isInteger(count) || count < 0) return raw;
  const stringBase = ptrSymbols + count * 18;
  if (!Number.isSafeInteger(stringBase) || stringBase < 0 || stringBase + 4 > r.length) return raw;
  const stringSize = r.u32(stringBase);
  const offset = Number(m[1]);
  if (!Number.isSafeInteger(offset) || offset < 4 || offset >= stringSize || stringBase + offset >= r.length) return raw;
  return r.cstring(stringBase + offset, Math.min(stringSize - offset, r.length - stringBase - offset)) || raw;
}

function rvaFromDelayField(value, attrs, image) {
  if (!value) return 0;
  if (attrs & 1) return value >>> 0;
  const va = BigInt(value >>> 0), base = image.imageBase;
  if (va < base || va - base > 0xffffffffn) return 0;
  return Number(va - base);
}

export function parseDelayImports(r, dir, image) {
  if (!dir || !dir.rva || dir.size < 32) return;
  let off = rvaToOffset(image, dir.rva);
  if (off == null) return;
  const end = Math.min(r.length, off + dir.size);
  const ptrSize = image.bits === 64 ? 8 : 4;
  for (let guard = 0; guard < 65536 && off + 32 <= end; guard++, off += 32) {
    const attrs=r.u32(off), nameField=r.u32(off+4), iatField=r.u32(off+12), intField=r.u32(off+16);
    const bound=r.u32(off+20), unload=r.u32(off+24), stamp=r.u32(off+28);
    if (!(attrs||nameField||iatField||intField||bound||unload||stamp)) break;
    const nameRva=rvaFromDelayField(nameField,attrs,image), iatRva=rvaFromDelayField(iatField,attrs,image), intRva=rvaFromDelayField(intField,attrs,image);
    const nameOff=rvaToOffset(image,nameRva), thunkOff0=rvaToOffset(image,intRva||iatRva);
    if (nameOff==null || thunkOff0==null || !iatRva) { image.warnings.push('Ignored malformed PE delay-import descriptor'); continue; }
    const library=r.cstring(nameOff,Math.min(1<<16,r.length-nameOff));
    if (library) image.libraries.push(library);
    for (let index=0, thunkOff=thunkOff0; index<100000; index++,thunkOff+=ptrSize) {
      if (thunkOff+ptrSize>r.length) break;
      const raw=image.bits===64?r.u64(thunkOff):BigInt(r.u32(thunkOff));
      if (raw===0n) break;
      const ordinalMask=image.bits===64?0x8000000000000000n:0x80000000n;
      let name=null,ordinal=null,hint=null;
      if (raw & ordinalMask) ordinal=Number(raw&0xffffn);
      else {
        let ibnRva;
        if (attrs&1) ibnRva=Number(raw & (image.bits===64?0x7fffffffffffffffn:0x7fffffffn));
        else {
          const va=raw & (image.bits===64?0x7fffffffffffffffn:0x7fffffffn);
          ibnRva=va>=image.imageBase && va-image.imageBase<=0xffffffffn?Number(va-image.imageBase):0;
        }
        const ibnOff=rvaToOffset(image,ibnRva);
        if (ibnOff!=null && ibnOff+2<r.length) { hint=r.u16(ibnOff); name=r.cstring(ibnOff+2,Math.min(1<<16,r.length-ibnOff-2)); }
      }
      const iatAddress=image.imageBase+BigInt(iatRva+index*ptrSize);
      image.imports.push({name:name||`#${ordinal}`,library,ordinal,hint,source:'PE-delay-import',sites:[{address:iatAddress,offset:image.addressToOffset(iatAddress),kind:'delay-iat'}]});
    }
  }
}

function readPointer(r, off, bits) { return bits===64?r.u64(off):BigInt(r.u32(off)); }

export function parseTlsDirectory(r, dir, image) {
  const need=image.bits===64?40:24;
  if (!dir || !dir.rva || dir.size<need) return;
  const off=rvaToOffset(image,dir.rva);
  if (off==null || off+need>r.length) return;
  const callbacksVa=readPointer(r,off+(image.bits===64?24:12),image.bits);
  const callbacks=[];
  if (callbacksVa) {
    const ptrSize=image.bits===64?8:4;
    const tableOff=image.addressToOffset(callbacksVa);
    if (tableOff!=null && tableOff<=BigInt(Number.MAX_SAFE_INTEGER)) {
      let p=Number(tableOff);
      for (let i=0;i<65536 && p+ptrSize<=r.length;i++,p+=ptrSize) {
        const target=readPointer(r,p,image.bits);
        if (!target) break;
        const sec=image.sectionAt(target);
        if (!sec?.perms?.execute) { image.warnings.push(`Ignored TLS callback outside executable section: 0x${target.toString(16)}`); continue; }
        callbacks.push(target);
        image.functions.push(functionSeed(target,{source:'tls-callback',confidence:0.999}));
      }
    }
  }
  image.metadata.tls={callbacks,callbacksAddress:callbacksVa||null};
}

export function parseLoadConfig(r, dir, image) {
  if (!dir || !dir.rva || dir.size<4) return;
  const off=rvaToOffset(image,dir.rva);
  if (off==null || off+4>r.length) return;
  const declared=Math.min(r.u32(off),dir.size,r.length-off);
  const is64=image.bits===64;
  const tableOffset=is64?128:80, countOffset=is64?136:84, flagsOffset=is64?144:88;
  const ptrSize=is64?8:4;
  if (declared<countOffset+ptrSize) return;
  const tableVa=readPointer(r,off+tableOffset,image.bits);
  const count64=readPointer(r,off+countOffset,image.bits);
  const guardFlags=declared>=flagsOffset+4?r.u32(off+flagsOffset):0;
  const extra=(guardFlags>>>28)&0xf;
  const entrySize=4+extra;
  const count=count64>10000000n?10000000:Number(count64);
  const functions=[];
  const tableFile=tableVa?image.addressToOffset(tableVa):null;
  if (tableFile!=null && tableFile<=BigInt(Number.MAX_SAFE_INTEGER)) {
    let p=Number(tableFile);
    for (let i=0;i<count && p+4<=r.length;i++,p+=entrySize) {
      const rva=r.u32(p);
      if (!rva) continue;
      const address=image.imageBase+BigInt(rva), sec=image.sectionAt(address);
      if (!sec?.perms?.execute) { image.warnings.push(`Ignored GuardCF target outside executable section at RVA 0x${rva.toString(16)}`); continue; }
      functions.push(address);
      image.functions.push(functionSeed(address,{source:'guard-cf',confidence:0.995}));
    }
  }
  image.metadata.loadConfig={guardFlags,guardCFFunctionTable:tableVa||null,guardCFFunctionCount:count64,guardCFFunctions:functions};
}
'''
t += append
p.write_text(t)

# ---------- PE parser wiring / entrypoint / COFF long names ----------
p=Path('js/binary/pe.js'); t=p.read_text()
old="""import { parseImports, parseExports, parseExceptionFunctions, parseBaseRelocations, parseCoffSymbols, directory, peMachineName } from './pe-loader.js';
"""
new="""import { parseImports, parseExports, parseExceptionFunctions, parseBaseRelocations, parseCoffSymbols, parseDelayImports, parseTlsDirectory, parseLoadConfig, resolveCoffSectionName, directory, peMachineName } from './pe-loader.js';
"""
if t.count(old)!=1: raise SystemExit('pe import mismatch')
t=t.replace(old,new)
t=t.replace("const IMAGE_DIRECTORY_ENTRY_BASERELOC = 5;","const IMAGE_DIRECTORY_ENTRY_BASERELOC = 5;\nconst IMAGE_DIRECTORY_ENTRY_TLS = 9;\nconst IMAGE_DIRECTORY_ENTRY_LOAD_CONFIG = 10;\nconst IMAGE_DIRECTORY_ENTRY_DELAY_IMPORT = 13;")
old="""    imageBase, entrypoint: imageBase + BigInt(entryRva),
"""
new="""    imageBase, entrypoint: entryRva ? imageBase + BigInt(entryRva) : null,
"""
if t.count(old)!=1: raise SystemExit('entrypoint mismatch')
t=t.replace(old,new)
old="""    const name = r.ascii(p, 8);
"""
new="""    const name = resolveCoffSectionName(r, r.ascii(p, 8), ptrSymbols, numberOfSymbols);
"""
if t.count(old)!=1: raise SystemExit('section name mismatch')
t=t.replace(old,new)
old="""  parseExceptionFunctions(r, directory(directories, IMAGE_DIRECTORY_ENTRY_EXCEPTION), image, machine);
  parseBaseRelocations(r, directory(directories, IMAGE_DIRECTORY_ENTRY_BASERELOC), image);
"""
new="""  parseExceptionFunctions(r, directory(directories, IMAGE_DIRECTORY_ENTRY_EXCEPTION), image, machine);
  parseBaseRelocations(r, directory(directories, IMAGE_DIRECTORY_ENTRY_BASERELOC), image, machine);
  parseDelayImports(r, directory(directories, IMAGE_DIRECTORY_ENTRY_DELAY_IMPORT), image);
  parseTlsDirectory(r, directory(directories, IMAGE_DIRECTORY_ENTRY_TLS), image);
  parseLoadConfig(r, directory(directories, IMAGE_DIRECTORY_ENTRY_LOAD_CONFIG), image);
"""
if t.count(old)!=1: raise SystemExit('PE directory calls mismatch')
t=t.replace(old,new)
p.write_text(t)

# ---------- ByteSource options + AbortSignal propagation ----------
p=Path('js/binary/source.js'); t=p.read_text()
t=t.replace("async readExactly(offset, length) {\n    const range = this.validateRange(offset, length);\n    const bytes = asBytes(await this.read(range.offset, range.length));",
            "async readExactly(offset, length, options = {}) {\n    const range = this.validateRange(offset, length);\n    const bytes = asBytes(await this.read(range.offset, range.length, options));",1)
t=t.replace("async read(offset, length) {\n    const range = this.validateRange(offset, length);\n    return this.parent.readExactly(this.offset + range.offset, range.length);",
            "async read(offset, length, options = {}) {\n    const range = this.validateRange(offset, length);\n    return this.parent.readExactly(this.offset + range.offset, range.length, options);",1)
t=t.replace("async read(offset, length) {\n    const range = this.validateRange(offset, length);\n    // The adapter contract keeps offsets lossless while lengths stay allocation-safe.\n    const bytes = asBytes(await this.delegate.read(range.offset, range.length));",
            "async read(offset, length, options = {}) {\n    const range = this.validateRange(offset, length);\n    // The adapter contract keeps offsets lossless while lengths stay allocation-safe.\n    const bytes = asBytes(await this.delegate.read(range.offset, range.length, options));",1)
old="""export function asByteSource(input, options = {}) {
  if (input instanceof ByteSource) return input;
"""
new="""export function asByteSource(input, options = {}) {
  if (input instanceof ByteSource) {
    const requested = options?.maxReadLength;
    return requested == null || requested === input.maxReadLength ? input : new DelegatingByteSource(input, options);
  }
"""
if t.count(old)!=1: raise SystemExit('asByteSource mismatch')
t=t.replace(old,new)
p.write_text(t)

p=Path('js/bytesource/cached.js'); t=p.read_text()
t=t.replace("const bytes = await this.source.readExactly(offset, length);","const bytes = await this.source.readExactly(offset, length, { signal });",1)
old="""  async read(offset, length) {
    const range = this.validateRange(offset, length);
    this.reads.push({ offset: nonNegativeBigInt(range.offset), length: range.length });
    return this.source.readExactly(range.offset, range.length);
  }
"""
new="""  async read(offset, length, options = {}) {
    const range = this.validateRange(offset, length);
    this.reads.push({ offset: nonNegativeBigInt(range.offset), length: range.length });
    return this.source.readExactly(range.offset, range.length, options);
  }
"""
if t.count(old)!=1: raise SystemExit('instrumented read mismatch')
t=t.replace(old,new)
p.write_text(t)

# ---------- Worker validation helpers ----------
Path('js/platform/worker-validation.js').write_text(r'''const MAX_SAFE_BIGINT=BigInt(Number.MAX_SAFE_INTEGER);
export function checkedChunkIndex(value){
  const n=Number(value);
  if(!Number.isSafeInteger(n)||n<0) throw new RangeError('Chunk index must be a non-negative safe integer.');
  return n;
}
export function safeRegionLength(value,label='region size'){
  let n;
  try{n=BigInt(value);}catch{throw new RangeError(`${label} is invalid.`)}
  if(n<0n||n>MAX_SAFE_BIGINT) throw new RangeError(`${label} exceeds JavaScript safe integer range; refusing a lossy conversion.`);
  return Number(n);
}
export function utf8Len(buf,index){
  const c=buf[index];
  if(c<0x80) return (c>=0x20&&c<0x7f)||c===9||c===10?1:0;
  let need=0;
  if(c>=0xc2&&c<=0xdf) need=1;
  else if(c>=0xe0&&c<=0xef) need=2;
  else if(c>=0xf0&&c<=0xf4) need=3;
  else return 0;
  if(index+need>=buf.length) return -1;
  const b1=buf[index+1];
  if((b1&0xc0)!==0x80) return 0;
  // Reject overlong sequences, UTF-16 surrogate code points, and > U+10FFFF.
  if(c===0xe0&&b1<0xa0) return 0;
  if(c===0xed&&b1>0x9f) return 0;
  if(c===0xf0&&b1<0x90) return 0;
  if(c===0xf4&&b1>0x8f) return 0;
  for(let k=2;k<=need;k++) if((buf[index+k]&0xc0)!==0x80) return 0;
  return need+1;
}
export function isExactFunctionSeed(seed){
  if(!seed) return false;
  const sources=new Set([seed.source,...(seed.sources||[])]);
  return [...sources].some((s)=>['entrypoint','export','exception','unwind','function_starts','symbol','tls-callback','guard-cf'].includes(s)) && Number(seed.confidence??0)>=0.9;
}
''')

p=Path('js/platform/worker.js'); t=p.read_text()
old="""import { hashByteSource } from './hash.js';
"""
new="""import { hashByteSource } from './hash.js';
import { checkedChunkIndex, safeRegionLength, utf8Len, isExactFunctionSeed } from './worker-validation.js';
"""
if t.count(old)!=1: raise SystemExit('worker import marker mismatch')
t=t.replace(old,new)
# Active request keys are epoch+id; duplicate IDs cannot overwrite controllers.
old="""  if (msg.t === 'cancel') {
    for (const [id, entry] of active) {
      if ((msg.requestId == null || msg.requestId === id) && (msg.epoch == null || msg.epoch === entry.epoch)) entry.controller.abort();
    }
    return;
  }
"""
new="""  if (msg.t === 'cancel') {
    for (const entry of active.values()) {
      if ((msg.requestId == null || msg.requestId === entry.id) && (msg.epoch == null || msg.epoch === entry.epoch)) entry.controller.abort();
    }
    return;
  }
"""
if t.count(old)!=1: raise SystemExit('cancel active mismatch')
t=t.replace(old,new)
old="""    const controller = new AbortController();
    if (msg.id != null) active.set(msg.id, { epoch: msg.epoch, controller });
    try { return await handle(msg, controller.signal); }
    finally { if (msg.id != null) active.delete(msg.id); }
"""
new="""    const controller = new AbortController();
    const requestKey = msg.id == null ? null : `${msg.epoch}:${msg.id}`;
    if (requestKey != null && active.has(requestKey)) throw new Error(`Duplicate active request id ${msg.id} for epoch ${msg.epoch}.`);
    if (requestKey != null) active.set(requestKey, { id:msg.id, epoch:msg.epoch, controller });
    try { return await handle(msg, controller.signal); }
    finally { if (requestKey != null && active.get(requestKey)?.controller === controller) active.delete(requestKey); }
"""
if t.count(old)!=1: raise SystemExit('active set mismatch')
t=t.replace(old,new)
# detect is side-effect free until open succeeds.
start=t.index('async function detectFile(msg, signal) {')
end=t.index('\nasync function openFile(msg, signal) {',start)
detect=r'''async function detectFile(msg, signal) {
  const candidate = msg.file;
  if (!candidate || !Number.isSafeInteger(candidate.size) || candidate.size <= 0) throw new Error('This file is empty or has an invalid size.');
  const temporary = createSource(candidate);
  try {
    const length = Math.min(16, candidate.size);
    const prefix = await temporary.readExactly(0n, length, { signal });
    if (signal.aborted) throw new Error('Open cancelled');
    const detected = detectBinary(prefix);
    return { formatId: detected.format, fat: !!detected.fat, size: BigInt(candidate.size), sourceBacked: true };
  } finally { temporary.clear?.(); }
}
'''
t=t[:start]+detect+t[end:]
# Transactional open.
start=t.index('async function openFile(msg, signal) {')
end=t.index('\nfunction setRegions(list) {',start)
openf=r'''async function openFile(msg, signal) {
  const candidateFile = msg.file;
  if (!candidateFile || !Number.isSafeInteger(candidateFile.size) || candidateFile.size <= 0) throw new Error('This file is empty or has an invalid size.');
  progress(msg, 'header', 0, 7);
  const candidateSource = createSource(candidateFile);
  const cancellable = {
    size: candidateSource.size,
    maxReadLength: candidateSource.maxReadLength,
    read: (offset, length, options = {}) => candidateSource.read(offset, length, { ...options, signal }),
  };
  let candidateImage, candidateDescriptor;
  try {
    candidateImage = await openBinarySource(cancellable, {
      ranges: { pageSize: 64 * 1024, maxPageSize: 2 * 1024 * 1024, maxCachedBytes: 16 * 1024 * 1024, maxReads: 4096 },
    });
    if (signal.aborted) throw new Error('Open cancelled');
    progress(msg, 'sections', 2, 7);
    const engine = { arm64: candidateImage.arch === 'arm64', verified: false };
    candidateDescriptor = describeBinaryImage(candidateImage, { name: candidateFile.name || 'binary', engine });
    candidateDescriptor.platform.vendorCandidates = fingerprintVendors({ libraries: candidateImage.libraries, imports: candidateImage.imports, symbols: candidateImage.symbols });
    const candidateRegions = new Map();
    for (const region of candidateDescriptor.slices.flatMap((s) => s.regions)) if (region?.id) candidateRegions.set(region.id, region);
    candidateRegions.set(candidateDescriptor.raw.id, candidateDescriptor.raw);

    progress(msg, 'symbols', 3, 7, { count: candidateImage.symbols.length });
    progress(msg, 'imports', 4, 7, { count: candidateImage.imports.length });
    progress(msg, 'strings', 4, 7, { deferred: true });
    progress(msg, 'functions', 5, 7, { count: candidateImage.functions.length });
    progress(msg, 'expensive', 5, 7, { deferred: true });

    // Commit the new session only after every parsing/description step succeeds.
    const previousSource = source;
    file = candidateFile; source = candidateSource; image = candidateImage; descriptor = candidateDescriptor; regions = candidateRegions;
    if (previousSource && previousSource !== candidateSource) previousSource.clear?.();
    return candidateDescriptor;
  } catch (error) {
    candidateSource.clear?.();
    throw error;
  }
}
'''
t=t[:start]+openf+t[end:]
# Chunk validation.
old="""async function getChunk({ regionId, chunk }, signal) {
  const region = regions.get(regionId);
  if (!region) throw new Error('Unknown region.');
  const rel = BigInt(chunk) * BigInt(CHUNK_BYTES);
"""
new="""async function getChunk({ regionId, chunk }, signal) {
  const region = regions.get(regionId);
  if (!region) throw new Error('Unknown region.');
  const chunkIndex = checkedChunkIndex(chunk);
  const rel = BigInt(chunkIndex) * BigInt(CHUNK_BYTES);
"""
if t.count(old)!=1: raise SystemExit('chunk validation mismatch')
t=t.replace(old,new)
# Exactness flags.
old="""    functionStartsExact: functions.length > 0,
"""
new="""    functionStartsExact: functions.length > 0 && (image.functions || []).every(isExactFunctionSeed),
"""
if t.count(old)!=1: raise SystemExit('functionStartsExact mismatch')
t=t.replace(old,new)
old="""  return { starts, cancelled: false, exact: true, __transfer: [starts.buffer] };
"""
new="""  return { starts, cancelled: false, exact: values.length > 0 && (image?.functions || []).every(isExactFunctionSeed), __transfer: [starts.buffer] };
"""
if t.count(old)!=1: raise SystemExit('generic exact mismatch')
t=t.replace(old,new)
# Remove old permissive UTF-8 implementation now imported from helper.
start=t.index('function utf8Len(buf, index) {')
end=t.index('\nasync function scanStrings',start)
t=t[:start]+t[end+1:]
# Lossless region-size conversion: explicit rejection rather than rounded Number.
t=t.replace('  const regionBytes = Number(region.size);','  const regionBytes = safeRegionLength(region.size);',1)
t=t.replace('  const total = Number(region.size);','  const total = safeRegionLength(region.size);',1)
p.write_text(t)

# ---------- Focused tests ----------
Path('tests/issues-97-112.mjs').write_text(r'''import assert from 'node:assert/strict';
import { parsePE } from '../js/binary/pe.js';
import { ByteSource, asByteSource } from '../js/binary/source.js';
import { InstrumentedByteSource } from '../js/bytesource/cached.js';
import { checkedChunkIndex, safeRegionLength, utf8Len, isExactFunctionSeed } from '../js/platform/worker-validation.js';

function minimalPE({entry=0,sectionName='.text',longName=null}={}){
  const bytes=new Uint8Array(0x600); const v=new DataView(bytes.buffer); const le=true;
  const u16=(o,x)=>v.setUint16(o,x,le),u32=(o,x)=>v.setUint32(o,x,le),u64=(o,x)=>v.setBigUint64(o,BigInt(x),le);
  u16(0,0x5a4d);u32(0x3c,0x80);u32(0x80,0x4550); const c=0x84;
  u16(c,0x8664);u16(c+2,1);u16(c+16,0xf0);u16(c+18,0x22); const opt=c+20;
  u16(opt,0x20b);u32(opt+16,entry);u64(opt+24,0x140000000n);u32(opt+32,0x1000);u32(opt+36,0x200);u32(opt+56,0x2000);u32(opt+60,0x200);u16(opt+68,3);u32(opt+108,16);
  const s=opt+0xf0; const enc=new TextEncoder();
  let symbolPtr=0;
  if(longName){symbolPtr=0x500;u32(c+8,symbolPtr);u32(c+12,0);bytes.set(enc.encode('/4'),s);const b=enc.encode(longName+'\0');u32(symbolPtr,4+b.length);bytes.set(b,symbolPtr+4);}
  else bytes.set(enc.encode(sectionName),s);
  u32(s+8,0x100);u32(s+12,0x1000);u32(s+16,0x200);u32(s+20,0x200);u32(s+36,0x60000020);
  return bytes;
}
{
  const image=parsePE(minimalPE({entry:0}));
  assert.equal(image.entrypoint,null);
  assert.equal(image.functions.some((f)=>f.source==='entrypoint'),false);
}
{
  const image=parsePE(minimalPE({longName:'very_long_text_section'}));
  assert.equal(image.sections[0].name,'very_long_text_section');
}
// #108: maxReadLength options must be honored even for an existing ByteSource.
{
  class S extends ByteSource{constructor(){super(16n,{maxReadLength:16})}async read(_o,n){return new Uint8Array(n)}}
  const base=new S(), wrapped=asByteSource(base,{maxReadLength:4});
  assert.notEqual(wrapped,base); await wrapped.readExactly(0n,4); await assert.rejects(()=>wrapped.readExactly(0n,5));
}
// #109: InstrumentedByteSource forwards AbortSignal/options to its delegate.
{
  let seen=null;
  const delegate={size:8n,maxReadLength:8,async read(_o,n,opts){seen=opts;return new Uint8Array(n)}};
  const src=new InstrumentedByteSource(delegate); const ac=new AbortController();
  await src.read(0n,1,{signal:ac.signal}); assert.equal(seen.signal,ac.signal);
}
// #110 strict UTF-8 validity.
assert.equal(utf8Len(Uint8Array.from([0xe0,0x80,0x80]),0),0); // overlong
assert.equal(utf8Len(Uint8Array.from([0xed,0xa0,0x80]),0),0); // surrogate
assert.equal(utf8Len(Uint8Array.from([0xf4,0x90,0x80,0x80]),0),0); // > U+10FFFF
assert.equal(utf8Len(Uint8Array.from([0xf0,0x9f,0x98,0x80]),0),4);
// #105/#111 no lossy sizes or negative/fractional chunks.
assert.throws(()=>safeRegionLength(9007199254740992n));
assert.throws(()=>checkedChunkIndex(-1)); assert.throws(()=>checkedChunkIndex(1.5)); assert.equal(checkedChunkIndex(3),3);
// #112 heuristic starts are never globally labelled exact.
assert.equal(isExactFunctionSeed({source:'heuristic',confidence:1}),false);
assert.equal(isExactFunctionSeed({source:'exception',confidence:.999}),true);
console.log('issues-97-112: ok');
''')
print('patched issues 97-112')
