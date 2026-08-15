from pathlib import Path
p=Path('js/binary/pe-loader.js')
s=p.read_text()
s=s.replace("function markPEPartial(image, reason, warning = null) {\n  image.metadata.peMetadata ||=", "function markPEPartial(image, reason, warning = null) {\n  image.metadata ||= {};\n  image.metadata.peMetadata ||=")
s=s.replace("export function createPEMetadataBudget(image, options = {}) {\n  const limits", "export function createPEMetadataBudget(image, options = {}) {\n  image.metadata ||= {};\n  const limits")
s=s.replace("reached its mapped file boundary/budget without a NUL terminator", "reached its mapped file boundary without a NUL terminator")
s=s.replace("reached its mapped boundary/budget without a zero terminator", "reached its mapped boundary without a zero terminator")
s=s.replace("reached its mapped boundary/budget", "reached its mapped boundary")
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
