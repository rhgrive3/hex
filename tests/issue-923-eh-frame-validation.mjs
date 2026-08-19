// #923: .eh_frame_hdr index rows are not function truth until the referenced FDE/CIE record validates them.
// Keep valid, malformed, mismatched, unsorted, and known-function-only provenance cases together as the fail-closed oracle.
import assert from 'node:assert/strict';
import { ByteView } from '../js/binary/reader.js';
import { BinaryImage } from '../js/binary/model.js';
import { parseEhFrameHeader } from '../js/binary/elf-unwind.js';

const HEADER_ADDR = 0x3000n;
const TEXT_ADDR = 0x1000n;
const EH_FRAME_ADDR = 0x2000n;
const TEXT_OFFSET = 0x80;
const EH_FRAME_OFFSET = 0x100;

function makeFixture({
  entries = [{ initial:0x1010n, fdeAddress:0x2020n, fdeInitial:0x1010n, range:0x20n }],
  ehFramePointer = EH_FRAME_ADDR,
  knownFunction = null,
} = {}) {
  const bytes = new Uint8Array(0x300);
  const view = new DataView(bytes.buffer);
  const u8 = (o, x) => view.setUint8(o, x);
  const u32 = (o, x) => view.setUint32(o, Number(BigInt(x) & 0xffffffffn), true);

  let p = 0;
  u8(p++, 1); u8(p++, 0x03); u8(p++, 0x03); u8(p++, 0x03);
  u32(p, ehFramePointer); p += 4;
  u32(p, entries.length); p += 4;
  for (const entry of entries) {
    u32(p, entry.initial); p += 4;
    u32(p, entry.fdeAddress); p += 4;
  }

  // CIE: length=13, CIE id=0, version=1, augmentation="zR", FDE encoding=udata4.
  p = EH_FRAME_OFFSET;
  u32(p, 13); p += 4;
  u32(p, 0); p += 4;
  u8(p++, 1); u8(p++, 0x7a); u8(p++, 0x52); u8(p++, 0);
  u8(p++, 1); u8(p++, 0x78); u8(p++, 30); u8(p++, 1); u8(p++, 0x03);

  for (const entry of entries) {
    if (entry.fdeAddress < EH_FRAME_ADDR || entry.fdeAddress >= EH_FRAME_ADDR + 0x100n) continue;
    const off = EH_FRAME_OFFSET + Number(entry.fdeAddress - EH_FRAME_ADDR);
    if (off + 17 > EH_FRAME_OFFSET + 0x100) continue;
    u32(off, 13);
    const ciePointerField = entry.fdeAddress + 4n;
    u32(off + 4, ciePointerField - EH_FRAME_ADDR);
    u32(off + 8, entry.fdeInitial ?? entry.initial);
    u32(off + 12, entry.range ?? 0x20n);
    u8(off + 16, 0);
  }

  const image = new BinaryImage(bytes, { format:'elf', arch:'x86_64', bits:64, metadata:{} });
  image.addSection({ name:'.eh_frame_hdr', address:HEADER_ADDR, size:0x40n, fileOffset:0n, fileSize:0x40n, perms:{read:true} });
  image.addSection({ name:'.text', address:TEXT_ADDR, size:0x80n, fileOffset:BigInt(TEXT_OFFSET), fileSize:0x80n, perms:{read:true,execute:true} });
  image.addSection({ name:'.eh_frame', address:EH_FRAME_ADDR, size:0x100n, fileOffset:BigInt(EH_FRAME_OFFSET), fileSize:0x100n, perms:{read:true} });
  if (knownFunction != null) image.functions.push({ address:BigInt(knownFunction), source:'entrypoint', confidence:0.9, exactFunctionStart:true });
  return {
    r:new ByteView(bytes, { littleEndian:true }),
    image,
    header:{ name:'.eh_frame_hdr', addr:HEADER_ADDR, offset:0n, size:0x40n },
  };
}

function parse(options) {
  const fixture = makeFixture(options);
  parseEhFrameHeader(fixture.r, fixture.header, fixture.image, 64, null);
  return fixture.image;
}

{
  const image = parse();
  assert.equal(image.functions.length, 1);
  assert.equal(image.functions[0].address, 0x1010n);
  assert.equal(image.functions[0].source, 'unwind');
  assert.equal(image.functions[0].functionStartEvidence?.verified, true);
  assert.equal(image.metadata.ehFrameHeader.validation, 'verified');
  assert.equal(image.metadata.ehFrameHeader.validatedEntries, 1);
}

{
  const image = parse({ ehFramePointer:0xdead0000n });
  assert.equal(image.functions.length, 0, 'unmapped eh_frame_ptr must suppress new unwind seeds');
  assert.equal(image.metadata.ehFrameHeader.validation, 'invalid');
}

{
  const image = parse({ entries:[{ initial:0x1010n, fdeAddress:0n }] });
  assert.equal(image.functions.length, 0, 'FDE=0 must not create a function from the index row alone');
  assert.equal(image.metadata.ehFrameHeader.invalidEntries, 1);
}

{
  const image = parse({ entries:[{ initial:0x1010n, fdeAddress:0x2020n, fdeInitial:0x1020n, range:0x20n }] });
  assert.equal(image.functions.length, 0, 'table key must match decoded FDE initial location');
  assert.equal(image.metadata.ehFrameHeader.validation, 'partial');
}

{
  const image = parse({ entries:[{ initial:0x1070n, fdeAddress:0x2020n, fdeInitial:0x1070n, range:0x40n }] });
  assert.equal(image.functions.length, 0, 'FDE range escaping executable mapping must not create a function seed');
}

{
  const image = parse({ entries:[
    { initial:0x1020n, fdeAddress:0x2020n, fdeInitial:0x1020n, range:0x10n },
    { initial:0x1010n, fdeAddress:0x2040n, fdeInitial:0x1010n, range:0x10n },
  ]});
  assert.equal(image.functions.length, 0, 'unsorted binary-search table must fail closed for new header-derived seeds');
  assert.equal(image.metadata.ehFrameHeader.tableSorted, false);
}

{
  const image = parse({
    entries:[{ initial:0x1010n, fdeAddress:0n }],
    knownFunction:0x1010n,
  });
  const unwind = image.functions.find((f) => f.source === 'unwind');
  assert.ok(unwind, 'unverified header provenance may attach only to an already-known function');
  assert.equal(unwind.exactFunctionStart, false);
  assert.equal(unwind.confidence, 0);
  assert.equal(unwind.functionStartEvidence?.verified, false);
}

console.log('issue 923 eh_frame_hdr/FDE cross-validation regressions: PASS');
