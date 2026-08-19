import assert from 'node:assert/strict';
import { parsePE } from '../js/binary/pe.js';
import { ByteView } from '../js/binary/reader.js';
import { parseDelayImports, parseExceptionFunctions } from '../js/binary/pe-loader.js';
import { structureKnownSwitches } from '../js/decompiler/switch.js';

function minimalPE({ entry = 0, sectionName = '.text', longName = null } = {}) {
  const bytes = new Uint8Array(0x600);
  const v = new DataView(bytes.buffer);
  const le = true;
  const u16 = (o, x) => v.setUint16(o, x, le);
  const u32 = (o, x) => v.setUint32(o, x, le);
  const u64 = (o, x) => v.setBigUint64(o, BigInt(x), le);
  const enc = new TextEncoder();
  u16(0, 0x5a4d); u32(0x3c, 0x80); u32(0x80, 0x4550); const coff = 0x84;
  u16(coff, 0x8664); u16(coff + 2, 1); u16(coff + 16, 0xf0); u16(coff + 18, 0x22); const opt = coff + 20;
  u16(opt, 0x20b); u32(opt + 16, entry); u64(opt + 24, 0x140000000n); u32(opt + 32, 0x1000); u32(opt + 36, 0x200); u32(opt + 56, 0x2000); u32(opt + 60, 0x200); u16(opt + 68, 3); u32(opt + 108, 16);
  const section = opt + 0xf0;
  if (longName) { const symbolPtr = 0x500; u32(coff + 8, symbolPtr); u32(coff + 12, 0); bytes.set(enc.encode('/4'), section); const nameBytes = enc.encode(`${longName}\0`); u32(symbolPtr, 4 + nameBytes.length); bytes.set(nameBytes, symbolPtr + 4); }
  else bytes.set(enc.encode(sectionName), section);
  u32(section + 8, 0x100); u32(section + 12, 0x1000); u32(section + 16, 0x200); u32(section + 20, 0x200); u32(section + 36, 0x60000020);
  return bytes;
}

{
  const image = parsePE(minimalPE({ entry: 0 }));
  assert.equal(image.entrypoint, null);
  assert.equal(image.functions.some((f) => f.source === 'entrypoint'), false);
}
{
  const image = parsePE(minimalPE({ longName: 'very_long_text_section' }));
  assert.equal(image.sections[0].name, 'very_long_text_section');
}
{
  const bytes = new Uint8Array(0x400); const v = new DataView(bytes.buffer); const u32 = (o, x) => v.setUint32(o, x, true); const u64 = (o, x) => v.setBigUint64(o, BigInt(x), true); const enc = new TextEncoder();
  u32(0x100, 1); u32(0x104, 0x180); u32(0x10c, 0x240); u32(0x110, 0x200); bytes.set(enc.encode('delay.dll\0'), 0x180); u64(0x200, 0x280n); u64(0x208, 0x3ffn); u64(0x210, 0n); v.setUint16(0x280, 7, true); bytes.set(enc.encode('DelayedApi\0'), 0x282);
  const imageBase = 0x10000000n;
  const mapped = { address: imageBase, size: BigInt(bytes.length), fileOffset: 0n, fileSize: BigInt(bytes.length), perms: { read: true, write: true } };
  const image = { bits: 64, imageBase, sections: [mapped], segments: [mapped], imports: [], libraries: [], warnings: [], addressToOffset(address) { const delta = BigInt(address) - imageBase; return delta >= 0n && delta < BigInt(bytes.length) ? delta : null; } };
  parseDelayImports(new ByteView(bytes, { littleEndian: true }), { rva: 0x100, size: 0x40 }, image);
  assert.equal(image.libraries.includes('delay.dll'), true); assert.equal(image.imports.length, 1); assert.equal(image.imports[0].name, 'DelayedApi'); assert.equal(image.imports[0].source, 'PE-delay-import'); assert.equal(image.imports[0].sites[0].kind, 'delay-iat'); assert.equal(image.imports[0].sites[0].address, imageBase + 0x240n); assert.ok(image.warnings.some((w) => /malformed PE delay-import thunk/.test(w)));
}
{
  const bytes = new Uint8Array(0x400); const v = new DataView(bytes.buffer); const put = (p, begin, finish) => { v.setUint32(p, begin, true); v.setUint32(p + 4, finish, true); v.setUint32(p + 8, 0x280, true); };
  v.setUint32(0x280, 1, true); // UNWIND_INFO: version 1, no flags, no codes (#922/#933 require validated unwind data)
  put(0x200, 0x1000, 0x1040); put(0x20c, 0x1030, 0x1060); put(0x218, 0x1080, 0x1090); put(0x224, 0x1020, 0x1030);
  const imageBase = 0x10000000n; const exec = { address: imageBase + 0x1000n, size: 0x100n, fileOffset: 0x1000n, fileSize: 0x100n, perms: { execute: true } };
  const meta = { address: imageBase + 0x200n, size: 0x100n, fileOffset: 0x200n, fileSize: 0x100n, perms: { read: true } };
  const image = { imageBase, sections: [exec, meta], segments: [exec, meta], functions: [], warnings: [], metadata: {}, addressToOffset(address) { const a=BigInt(address); for (const owner of [exec, meta]) if (a >= owner.address && a < owner.address + owner.fileSize) return owner.fileOffset + (a-owner.address); return null; }, sectionAt(address) { const a = BigInt(address); return a >= exec.address && a < exec.address + exec.size ? exec : null; } };
  parseExceptionFunctions(new ByteView(bytes, { littleEndian: true }), { rva: 0x200, size: 48 }, image, 0x8664);
  assert.deepEqual(image.functions.map((f) => f.address), [imageBase + 0x1000n, imageBase + 0x1080n]); assert.equal(image.metadata.exceptionDirectory.count, 2); assert.ok(image.warnings.some((w) => /overlapping\/out-of-order/.test(w)));
}
{
  const result = { lines: [{ kind: 'sig', indent: 0, text: 'f()' }, { kind: 'stmt', indent: 1, text: '__asm("br x8");', row: 0 }, { kind: 'ctrl', indent: 0, text: '}' }], ir: { blocks: [] } };
  const model = { instructions: [{ row: 0, address: 0x1000n }, { row: 1, address: 0x1004n }, { row: 2, address: 0x1008n }] };
  structureKnownSwitches(result, model, { switches: [{ row: 0, cases: [{ value: '16', address: 0x1004n }, { value: '0x10', address: 0x1008n }] }] });
  assert.doesNotMatch(result.pseudocode || '', /switch/);
}
{
  const count = 512; const base = 0x200000000n; const instructions = Array.from({ length: count + 1 }, (_, row) => ({ row, address: base + BigInt(row * 4) })); instructions.find = () => { throw new Error('quadratic instruction scan'); };
  const blocks = Array.from({ length: count + 1 }, (_, row) => ({ startRow: row }));
  const lines = [{ kind: 'sig', indent: 0, text: 'g()' }, { kind: 'stmt', indent: 1, text: '__asm("br x9");', row: 0 }, ...Array.from({ length: count }, (_, i) => ({ kind: 'stmt', indent: 1, text: `v${i};`, row: i + 1 })), { kind: 'ctrl', indent: 0, text: '}' }];
  const cases = Array.from({ length: count }, (_, i) => ({ value: i, block: i + 1 })); cases[count - 1] = { value: count - 1, address: base + 4n };
  const result = { lines, ir: { blocks } }; structureKnownSwitches(result, { instructions }, { switches: [{ row: 0, expr: 'x9', cases }] }); assert.match(result.pseudocode, /switch \(x9\)/); const sharedLabel = `loc_${(base + 4n).toString(16).toUpperCase()}:`; assert.equal(result.lines.filter((l) => l.text === sharedLabel).length, 1);
}
console.log('issues-97-100-146-147: ok');
