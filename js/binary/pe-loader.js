import { functionSeed } from './model.js';

export function parseImports(r, dir, image) {
  if (!dir || !dir.rva || !dir.size) return;
  let off = rvaToOffset(image, dir.rva);
  if (off == null) return;
  const end = Math.min(r.length, off + dir.size);
  const ptrSize = image.bits === 64 ? 8 : 4;
  for (let guard = 0; guard < 65536 && off + 20 <= end; guard++, off += 20) {
    const originalFirstThunk = r.u32(off);
    const timeDateStamp = r.u32(off + 4);
    const forwarderChain = r.u32(off + 8);
    const nameRva = r.u32(off + 12);
    const firstThunk = r.u32(off + 16);
    if (!(originalFirstThunk || timeDateStamp || forwarderChain || nameRva || firstThunk)) break;
    const nameOff = rvaToOffset(image, nameRva);
    if (nameOff == null) continue;
    const library = r.cstring(nameOff, Math.min(1 << 16, r.length - nameOff));
    if (library) image.libraries.push(library);
    let thunkRva = originalFirstThunk || firstThunk;
    let thunkOff = rvaToOffset(image, thunkRva);
    if (thunkOff == null) continue;
    for (let index = 0; index < 100000; index++, thunkOff += ptrSize, thunkRva += ptrSize) {
      if (thunkOff + ptrSize > r.length) break;
      const raw = image.bits === 64 ? r.u64(thunkOff) : BigInt(r.u32(thunkOff));
      if (raw === 0n) break;
      const ordinalMask = image.bits === 64 ? 0x8000000000000000n : 0x80000000n;
      let name = null, ordinal = null, hint = null;
      if (raw & ordinalMask) ordinal = Number(raw & 0xffffn);
      else {
        const ibnRva = Number(raw & (image.bits === 64 ? 0x7fffffffffffffffn : 0x7fffffffn));
        const ibnOff = rvaToOffset(image, ibnRva);
        if (ibnOff != null && ibnOff + 2 < r.length) {
          hint = r.u16(ibnOff);
          name = r.cstring(ibnOff + 2, Math.min(1 << 16, r.length - ibnOff - 2));
        }
      }
      const iatAddress = image.imageBase + BigInt(firstThunk + index * ptrSize);
      image.imports.push({ name: name || `#${ordinal}`, library, ordinal, hint, source: 'PE-import', sites: [{ address: iatAddress, offset: image.addressToOffset(iatAddress), kind: 'iat' }] });
    }
  }
}

export function parseExports(r, dir, image) {
  if (!dir || !dir.rva || dir.size < 40) return;
  const off = rvaToOffset(image, dir.rva);
  if (off == null || off + 40 > r.length) return;
  const nameRva = r.u32(off + 12);
  const baseOrdinal = r.u32(off + 16);
  const numberOfFunctions = r.u32(off + 20);
  const numberOfNames = r.u32(off + 24);
  const addrFunctions = r.u32(off + 28);
  const addrNames = r.u32(off + 32);
  const addrOrdinals = r.u32(off + 36);
  const dllNameOff = rvaToOffset(image, nameRva);
  if (dllNameOff != null) image.metadata.exportName = r.cstring(dllNameOff, Math.min(1 << 16, r.length - dllNameOff));
  if (numberOfFunctions > 10_000_000 || numberOfNames > 10_000_000) return;
  const foff = rvaToOffset(image, addrFunctions), noff = rvaToOffset(image, addrNames), ooff = rvaToOffset(image, addrOrdinals);
  if (foff == null || noff == null || ooff == null) return;
  const names = new Map();
  for (let i = 0; i < numberOfNames; i++) {
    if (noff + i * 4 + 4 > r.length || ooff + i * 2 + 2 > r.length) break;
    const nrva = r.u32(noff + i * 4), ordIndex = r.u16(ooff + i * 2);
    const npos = rvaToOffset(image, nrva);
    if (npos != null) names.set(ordIndex, r.cstring(npos, Math.min(1 << 16, r.length - npos)));
  }
  const dirStart = dir.rva, dirEnd = dir.rva + dir.size;
  for (let i = 0; i < numberOfFunctions; i++) {
    if (foff + i * 4 + 4 > r.length) break;
    const frva = r.u32(foff + i * 4);
    if (!frva) continue;
    const name = names.get(i) || `#${baseOrdinal + i}`;
    if (frva >= dirStart && frva < dirEnd) {
      const fwdOff = rvaToOffset(image, frva);
      image.exports.push({ name, address: 0n, ordinal: baseOrdinal + i, kind: 'forwarder', forwarder: fwdOff == null ? null : r.cstring(fwdOff, Math.min(1 << 16, r.length - fwdOff)), source: 'PE-export' });
      continue;
    }
    const address = image.imageBase + BigInt(frva);
    image.exports.push({ name, address, ordinal: baseOrdinal + i, kind: 'export', source: 'PE-export' });
    const sec = image.sectionAt(address);
    if (sec && sec.perms.execute) image.functions.push(functionSeed(address, { name, source: 'export', confidence: 0.95 }));
  }
}

export function parseExceptionFunctions(r, dir, image, machine) {
  if (!dir || !dir.rva || !dir.size) return;
  const off = rvaToOffset(image, dir.rva);
  if (off == null) return;
  const end = Math.min(r.length, off + dir.size);
  if (machine === 0x8664) {
    for (let p = off; p + 12 <= end; p += 12) {
      const begin = r.u32(p), finish = r.u32(p + 4), unwind = r.u32(p + 8);
      if (!begin || finish <= begin) continue;
      image.functions.push(functionSeed(image.imageBase + BigInt(begin), { size: BigInt(finish - begin), source: 'exception', confidence: 0.999 }));
      image.metadata.exceptionDirectory = image.metadata.exceptionDirectory || { count: 0, kind: 'x64-pdata' };
      image.metadata.exceptionDirectory.count++;
      void unwind;
    }
  } else if (machine === 0xaa64 || machine === 0xa641) {
    for (let p = off; p + 8 <= end; p += 8) {
      const begin = r.u32(p), unwindData = r.u32(p + 4);
      if (!begin) continue;
      let size = null;
      if ((unwindData & 3) !== 0) {
        const functionLength = (unwindData >>> 2) & 0x7ff;
        if (functionLength) size = BigInt(functionLength * 4);
      }
      image.functions.push(functionSeed(image.imageBase + BigInt(begin), { size, source: 'exception', confidence: 0.995 }));
      image.metadata.exceptionDirectory = image.metadata.exceptionDirectory || { count: 0, kind: 'arm64-pdata' };
      image.metadata.exceptionDirectory.count++;
    }
  }
}

function allowedBaseRelocationTypes(machine) {
  // IMAGE_REL_BASED_* values defined for the corresponding PE machine.
  if (machine === 0x014c) return new Set([1, 2, 3, 4]);                 // x86
  if (machine === 0x8664) return new Set([1, 2, 3, 4, 10]);            // x86-64
  if (machine === 0x01c0 || machine === 0x01c4) return new Set([3, 5, 7]); // ARM/Thumb
  if (machine === 0xaa64 || machine === 0xa641) return new Set([4, 5, 6, 7, 8, 10]); // ARM64/ARM64EC
  return new Set([1, 2, 3, 4, 5, 6, 7, 8, 10]);
}

export function parseBaseRelocations(r, dir, image, machine = null) {
  if (!dir || !dir.rva || dir.size < 8) return;
  let off = rvaToOffset(image, dir.rva);
  if (off == null) return;
  const end = Math.min(r.length, off + dir.size);
  const allowed = allowedBaseRelocationTypes(machine);
  while (off + 8 <= end) {
    const pageRva = r.u32(off), blockSize = r.u32(off + 4);
    if (blockSize < 8 || (blockSize & 1) !== 0 || off + blockSize > end) {
      image.warnings.push(`Malformed PE base-relocation block at file offset 0x${off.toString(16)}`);
      break;
    }
    const count = (blockSize - 8) / 2;
    for (let i = 0; i < count; i++) {
      const raw = r.u16(off + 8 + i * 2), type = raw >>> 12, within = raw & 0xfff;
      if (!type) continue;
      if (!allowed.has(type)) {
        image.warnings.push(`Ignored reserved/unsupported PE base relocation type ${type} at RVA 0x${(pageRva + within).toString(16)}`);
        continue;
      }
      const address = image.imageBase + BigInt(pageRva + within);
      image.relocations.push({ address, fileOffset: image.addressToOffset(address), type, symbol: null, addend: null, section: null, source: 'PE-base-reloc' });
    }
    off += blockSize;
  }
}

export function parseCoffSymbols(r, ptr, count, image) {
  if (!ptr || !count || count > 10_000_000 || ptr + count * 18 > r.length) return;
  const strBase = ptr + count * 18;
  if (strBase + 4 > r.length) return;
  const strSize = r.u32(strBase);
  let i = 0;
  while (i < count) {
    const p = ptr + i * 18;
    let name;
    if (r.u32(p) === 0) {
      const noff = r.u32(p + 4);
      name = noff >= 4 && noff < strSize && strBase + noff < r.length ? r.cstring(strBase + noff, Math.min(strSize - noff, r.length - strBase - noff)) : '';
    } else name = r.ascii(p, 8);
    const value = r.u32(p + 8), secNo = r.i16(p + 12), type = r.u16(p + 14), storage = r.u8(p + 16), aux = r.u8(p + 17);
    const sec = image.sections.find((s) => s.index === secNo);
    const address = sec ? sec.address + BigInt(value) : 0n;
    if (name) {
      const functionLike = !!(type & 0x20) || (sec && sec.perms.execute && storage === 2);
      image.symbols.push({ name, address, size: null, kind: functionLike ? 'function' : 'symbol', binding: storage === 2 ? 'global' : 'local', defined: secNo > 0, sectionIndex: secNo, source: 'COFF' });
      if (functionLike && address) image.functions.push(functionSeed(address, { name, source: 'symbol', confidence: 0.98 }));
    }
    i += 1 + aux;
  }
}

export function directory(dirs, index) { return dirs[index] || { rva: 0, size: 0 }; }
function rvaToOffset(image, rva) {
  const o = image.addressToOffset(image.imageBase + BigInt(rva));
  return o == null || o > BigInt(Number.MAX_SAFE_INTEGER) ? null : Number(o);
}
export function peMachineName(m) {
  return ({ 0x014c: 'x86', 0x8664: 'x86_64', 0x01c0: 'arm', 0x01c4: 'armv7', 0xaa64: 'arm64', 0xa641: 'arm64ec', 0x5032: 'riscv32', 0x5064: 'riscv64' })[m] || `machine-${m.toString(16)}`;
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
