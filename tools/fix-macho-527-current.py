from pathlib import Path

# Prevent the older staging helper from applying its outdated ObjC anchor; its
# canonical linkage + chained caps still apply before this script.
p=Path('tools/fix-macho-linkage-521-527.py'); text=p.read_text(); marker='# Legacy ObjC helper gets a shared memory budget;'
if marker in text: p.write_text(text.split(marker,1)[0].rstrip()+'\n')

# Harden chained fallback against active-slice escape and aggregate allocations.
p=Path('js/chained.js'); s=p.read_text()
a=s.index('async function sliceOffset('); b=s.index('\nasync function parseImage',a)
range_fn=r'''async function sliceRange(file, sliceIndex) {
  const head=await bytes(file,0,8); if(head.length<4)return null;
  const dv=new DataView(head.buffer,head.byteOffset,head.byteLength);
  if(dv.getUint32(0,true)===MH_MAGIC_64)return {base:0n,size:BigInt(file.size)};
  const be=dv.getUint32(0,false);if(be!==FAT_MAGIC&&be!==FAT_MAGIC_64||head.length<8)return null;
  const n=u32be(dv,4),idx=Math.max(0,Number(sliceIndex)||0);if(idx>=n||n>64)return null;
  const wide=be===FAT_MAGIC_64,entry=wide?32:20,table=await bytes(file,0,8+n*entry);if(table.length<8+n*entry)return null;
  const tdv=new DataView(table.buffer,table.byteOffset,table.byteLength),q=8+idx*entry;
  const base=wide?tdv.getBigUint64(q+8,false):BigInt(tdv.getUint32(q+8,false));
  const size=wide?tdv.getBigUint64(q+16,false):BigInt(tdv.getUint32(q+12,false));
  if(base<0n||size<=0n||base+size>BigInt(file.size))return null;return {base,size};
}
'''
s=s[:a]+range_fn+s[b:]
s=s.replace("  const base = await sliceOffset(file, sliceIndex);\n  if (base == null) return null;", "  const range=await sliceRange(file,sliceIndex);if(!range)return null;const {base}=range;const sliceSize=range.size;")
s=s.replace("sizeofcmds > 64 * 1024 * 1024", "sizeofcmds > 4 * 1024 * 1024")
s=s.replace("  const raw = await bytes(file, base, 32 + sizeofcmds);", "  if(BigInt(32+sizeofcmds)>sliceSize)return null;\n  const raw = await bytes(file, base, 32 + sizeofcmds);")
s=s.replace("      segments.push({ name, vmaddr, vmsize, fileoff, filesize });", "      if(fileoff+filesize>sliceSize) return null;\n      segments.push({ name, vmaddr, vmsize, fileoff, filesize });")
s=s.replace("  return { base, segments, stubs, fixups };", "  if(fixups && (fixups.dataoff<0n || fixups.dataoff+BigInt(fixups.datasize)>sliceSize))fixups=null;\n  return { base, sliceSize, segments, stubs, fixups };")
s=s.replace("count > 1_000_000", "count > 100_000")
p.write_text(s)

# Current ObjC fallback: de-duplicate file ranges and refuse an aggregate
# resident set above 32 MiB before materializing any section payloads.
p=Path('js/worker-legacy.js'); s=p.read_text()
needle="""async function objcStubNames(slice, known) {
  const regs = (slice && slice.regions) || [];
  const find = (name) => regs.find((r) => r.section === name && r.size > 0n);"""
repl="""async function objcStubNames(slice, known) {
  const regs = (slice && slice.regions) || [];
  const OBJC_GLOBAL_BYTES=32*1024*1024, seenRanges=new Set(); let aggregateBytes=0;
  const relevant=(r)=>r&&r.size>0n&&(/^(?:__objc_(?:selrefs|superrefs|classrefs|stubs|methname|classname)|__cstring)$/.test(r.section||'')||r.cstrings);
  for(const r of regs){if(!relevant(r))continue;const key=`${r.fileOffset}:${r.size}`;if(seenRanges.has(key))continue;seenRanges.add(key);const n=Number(r.size);if(!Number.isSafeInteger(n)||n>OBJC_STUB_MAX_BYTES||aggregateBytes+n>OBJC_GLOBAL_BYTES)return [];aggregateBytes+=n;}
  const find = (name) => regs.find((r) => r.section === name && r.size > 0n);"""
if needle not in s: raise SystemExit('current objc helper anchor changed')
s=s.replace(needle,repl,1)
# dedupe region collection itself
s=s.replace("  const pointerRegions = [];\n  for (const r of regs) {", "  const pointerRegions = []; const selectedRanges=new Set();\n  for (const r of regs) {")
s=s.replace("      pointerRegions.push(r);", "      const key=`${r.fileOffset}:${r.size}`;if(!selectedRanges.has(key)){selectedRanges.add(key);pointerRegions.push(r);}")
p.write_text(s)
