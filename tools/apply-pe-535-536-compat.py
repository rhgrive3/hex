from pathlib import Path
p=Path('js/binary/pe-loader.js')
s=p.read_text()
s=s.replace("function markPEPartial(image, reason, warning = null) {\n  image.metadata.peMetadata ||=", "function markPEPartial(image, reason, warning = null) {\n  image.metadata ||= {};\n  image.metadata.peMetadata ||=")
s=s.replace("export function createPEMetadataBudget(image, options = {}) {\n  const limits", "export function createPEMetadataBudget(image, options = {}) {\n  image.metadata ||= {};\n  const limits")
s=s.replace("reached its mapped file boundary/budget without a NUL terminator", "reached its mapped file boundary without a NUL terminator")
s=s.replace("reached its mapped boundary/budget without a zero terminator", "reached its mapped boundary without a zero terminator")
s=s.replace("reached its mapped boundary/budget", "reached its mapped boundary")
old="if(!name)continue;}\n      const iatAddress=image.imageBase+BigInt(iatRva+index*ptrSize);"
new="if(!name){image.warnings.push(`Ignored malformed PE delay-import thunk for ${library||'<unknown>'}`);continue;}}\n      const iatAddress=image.imageBase+BigInt(iatRva+index*ptrSize);"
if old not in s: raise SystemExit('delay import malformed diagnostic anchor missing')
s=s.replace(old,new,1)
if 'function allowedBaseRelocationTypes(machine)' not in s:
  anchor='export function parseBaseRelocations(r, dir, image, machine = null, sharedBudget = null) {'
  helper="""function allowedBaseRelocationTypes(machine) {
  if (machine === 0x014c) return new Set([1, 2, 3, 4]);
  if (machine === 0x8664) return new Set([1, 2, 3, 4, 10]);
  if (machine === 0x01c0 || machine === 0x01c4) return new Set([3, 5, 7]);
  if (machine === 0xaa64 || machine === 0xa641) return new Set([4, 5, 6, 7, 8, 10]);
  return new Set([1, 2, 3, 4, 5, 6, 7, 8, 10]);
}

"""
  if anchor not in s: raise SystemExit('base relocation insertion anchor missing')
  s=s.replace(anchor,helper+anchor,1)
p.write_text(s)

p=Path('tests/issues-97-100-146-147.mjs')
s=p.read_text()
old="""  const imageBase = 0x10000000n;
  const image = { bits: 64, imageBase, imports: [], libraries: [], warnings: [], addressToOffset(address) { const delta = BigInt(address) - imageBase; return delta >= 0n && delta < BigInt(bytes.length) ? delta : null; } };
  parseDelayImports(new ByteView(bytes, { littleEndian: true }), { rva: 0x100, size: 0x40 }, image);"""
new="""  const imageBase = 0x10000000n;
  const mapped = { address: imageBase, size: BigInt(bytes.length), fileOffset: 0n, fileSize: BigInt(bytes.length), perms: { read: true, write: true } };
  const image = { bits: 64, imageBase, sections: [mapped], segments: [mapped], imports: [], libraries: [], warnings: [], addressToOffset(address) { const delta = BigInt(address) - imageBase; return delta >= 0n && delta < BigInt(bytes.length) ? delta : null; } };
  parseDelayImports(new ByteView(bytes, { littleEndian: true }), { rva: 0x100, size: 0x40 }, image);"""
if old not in s: raise SystemExit('direct delay-import fixture anchor missing')
s=s.replace(old,new,1)
old="""  const imageBase = 0x10000000n; const exec = { address: imageBase + 0x1000n, size: 0x100n, perms: { execute: true } };
  const image = { imageBase, functions: [], warnings: [], metadata: {}, addressToOffset(address) { const delta = BigInt(address) - imageBase; return delta >= 0n && delta < BigInt(bytes.length) ? delta : null; }, sectionAt(address) { const a = BigInt(address); return a >= exec.address && a < exec.address + exec.size ? exec : null; } };
  parseExceptionFunctions(new ByteView(bytes, { littleEndian: true }), { rva: 0x200, size: 48 }, image, 0x8664);"""
new="""  const imageBase = 0x10000000n; const exec = { address: imageBase + 0x1000n, size: 0x100n, fileOffset: 0x1000n, fileSize: 0x100n, perms: { execute: true } };
  const meta = { address: imageBase + 0x200n, size: 0x100n, fileOffset: 0x200n, fileSize: 0x100n, perms: { read: true } };
  const image = { imageBase, sections: [exec, meta], segments: [exec, meta], functions: [], warnings: [], metadata: {}, addressToOffset(address) { const a=BigInt(address); for (const owner of [exec, meta]) if (a >= owner.address && a < owner.address + owner.fileSize) return owner.fileOffset + (a-owner.address); return null; }, sectionAt(address) { const a = BigInt(address); return a >= exec.address && a < exec.address + exec.size ? exec : null; } };
  parseExceptionFunctions(new ByteView(bytes, { littleEndian: true }), { rva: 0x200, size: 48 }, image, 0x8664);"""
if old not in s: raise SystemExit('direct exception fixture anchor missing')
s=s.replace(old,new,1)
p.write_text(s)

p=Path('tests/issues-101-112.mjs')
s=p.read_text()
old="""function fixture(size=0x400){
  const bytes=new Uint8Array(size), view=new DataView(bytes.buffer);
  const image={imageBase:BASE,bits:64,functions:[],relocations:[],warnings:[],metadata:{},
    addressToOffset(address){const d=BigInt(address)-BASE; return d>=0n&&d<BigInt(bytes.length)?d:null;},
    sectionAt(address){const d=BigInt(address)-BASE; return d>=0x200n&&d<0x300n?{address:BASE+0x200n,size:0x100n,perms:{execute:true}}:null;}};
  return {bytes,view,r:new ByteView(bytes,{littleEndian:true}),image};
}"""
new="""function fixture(size=0x400){
  const bytes=new Uint8Array(size), view=new DataView(bytes.buffer);
  const mapped={address:BASE,size:BigInt(bytes.length),fileOffset:0n,fileSize:BigInt(bytes.length),perms:{read:true,write:true}};
  const exec={address:BASE+0x200n,size:0x100n,fileOffset:0x200n,fileSize:0x100n,perms:{read:true,execute:true}};
  const image={imageBase:BASE,bits:64,sections:[mapped,exec],segments:[mapped],functions:[],relocations:[],warnings:[],metadata:{},
    addressToOffset(address){const d=BigInt(address)-BASE; return d>=0n&&d<BigInt(bytes.length)?d:null;},
    sectionAt(address){const a=BigInt(address); return a>=exec.address&&a<exec.address+exec.size?exec:null;}};
  return {bytes,view,r:new ByteView(bytes,{littleEndian:true}),image};
}"""
if old not in s: raise SystemExit('issues-101-112 PE fixture anchor missing')
s=s.replace(old,new,1)
p.write_text(s)
