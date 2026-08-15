import assert from 'node:assert/strict';
import { parseELF } from '../js/binary/elf.js';
import { BinaryImage, functionSeed } from '../js/binary/model.js';
import { ByteView } from '../js/binary/reader.js';
import { parseCoffSymbols } from '../js/binary/pe-loader.js';
import { isExactFunctionSeed } from '../js/platform/worker-validation.js';

function u16(b, o, v) { new DataView(b.buffer).setUint16(o, v, true); }
function i16(b, o, v) { new DataView(b.buffer).setInt16(o, v, true); }
function u32(b, o, v) { new DataView(b.buffer).setUint32(o, v >>> 0, true); }
function u64(b, o, v) { new DataView(b.buffer).setBigUint64(o, BigInt(v), true); }
function ascii(b, o, s, n = s.length) { for (let i = 0; i < n; i++) b[o + i] = i < s.length ? s.charCodeAt(i) : 0; }

function makeElfXindex({ companion = true, companionSize = 8, resolved = 1 } = {}) {
  const shnum = companion ? 5 : 4;
  const shoff = 0x200;
  const b = new Uint8Array(shoff + shnum * 64);
  b.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0], 0);
  u16(b, 16, 1); u16(b, 18, 0x3e); u32(b, 20, 1);
  u64(b, 24, 0); u64(b, 32, 0); u64(b, 40, shoff);
  u32(b, 48, 0); u16(b, 52, 64); u16(b, 54, 56); u16(b, 56, 0);
  u16(b, 58, 64); u16(b, 60, shnum); u16(b, 62, 0);

  const sh = (idx, { type = 0, flags = 0n, addr = 0n, off = 0n, size = 0n, link = 0, info = 0, align = 1n, entsize = 0n } = {}) => {
    const p = shoff + idx * 64;
    u32(b, p + 4, type); u64(b, p + 8, flags); u64(b, p + 16, addr);
    u64(b, p + 24, off); u64(b, p + 32, size); u32(b, p + 40, link); u32(b, p + 44, info);
    u64(b, p + 48, align); u64(b, p + 56, entsize);
  };
  sh(1, { type: 1, flags: 0x6n, addr: 0x400000n, off: 0x80n, size: 4n, align: 4n });
  b.set([0, 0, 0, 0], 0x80);
  b.set([0, 0x66, 0x6f, 0x6f, 0], 0x90);
  sh(2, { type: 3, off: 0x90n, size: 5n, align: 1n });
  sh(3, { type: 2, off: 0xA0n, size: 48n, link: 2, info: 1, align: 8n, entsize: 24n });
  const sym = 0xA0 + 24;
  u32(b, sym, 1); b[sym + 4] = 0x12; b[sym + 5] = 0; u16(b, sym + 6, 0xffff);
  u64(b, sym + 8, 0x400000n); u64(b, sym + 16, 4n);
  if (companion) {
    sh(4, { type: 18, off: 0xD0n, size: BigInt(companionSize), link: 3, align: 4n, entsize: 4n });
    if (companionSize >= 4) u32(b, 0xD0, 0);
    if (companionSize >= 8) u32(b, 0xD4, resolved);
  }
  return b;
}

for (const bytes of [
  makeElfXindex({ companion: false }),
  makeElfXindex({ companion: true, companionSize: 4 }),
  makeElfXindex({ companion: true, companionSize: 8, resolved: 99 }),
]) {
  const image = parseELF(bytes);
  const sym = image.symbols.find((s) => s.name === 'foo');
  assert.ok(sym);
  assert.equal(sym.defined, null, 'unproven SHN_XINDEX must remain unknown');
  assert.equal(sym.sectionIndex, null);
  assert.equal(image.functions.length, 0);
  assert.equal(image.exports.length, 0);
  assert.equal(image.imports.length, 0);
}

{
  const image = parseELF(makeElfXindex({ resolved: 0 }));
  const sym = image.symbols.find((s) => s.name === 'foo');
  assert.equal(sym.defined, false);
  assert.equal(sym.sectionIndex, 0);
  assert.equal(image.functions.length, 0);
  assert.equal(image.exports.length, 0);
  assert.equal(image.imports.some((x) => x.name === 'foo'), true);
}

{
  const image = parseELF(makeElfXindex({ resolved: 1 }));
  const sym = image.symbols.find((s) => s.name === 'foo');
  assert.equal(sym.defined, true);
  assert.equal(sym.sectionIndex, 1);
  const seed = image.functions.find((x) => x.name === 'foo');
  assert.ok(seed);
  assert.equal(seed.exactFunctionStart, true);
  assert.match(seed.functionStartEvidence, /STT_FUNC/);
  assert.equal(isExactFunctionSeed(seed), true);
}

// Generic symbols — including Mach-O N_SECT-derived heuristic seeds — are never exact by source alone.
assert.equal(isExactFunctionSeed(functionSeed(0x1000n, { source: 'symbol', confidence: 1 })), false);
assert.equal(isExactFunctionSeed(functionSeed(0x1000n, { source: 'function_starts', confidence: 0.95 })), true);
assert.equal(isExactFunctionSeed(functionSeed(0x1000n, { source: 'symbol', confidence: 0.95, exactFunctionStart: true, functionStartEvidence: 'validated parser proof' })), true);
assert.equal(isExactFunctionSeed(functionSeed(0x1000n, { source: 'symbol', confidence: 0.89, exactFunctionStart: true })), false);

// COFF's derived-function type is explicit proof; an executable external symbol without it stays heuristic.
{
  const bytes = new Uint8Array(64);
  const ptr = 4;
  ascii(bytes, ptr, 'func', 8);
  u32(bytes, ptr + 8, 0); i16(bytes, ptr + 12, 1); u16(bytes, ptr + 14, 0x20); bytes[ptr + 16] = 2; bytes[ptr + 17] = 0;
  u32(bytes, ptr + 18, 4);
  const image = new BinaryImage(bytes, { format: 'pe', arch: 'x86_64', bits: 64, imageBase: 0x140000000n });
  image.addSection({ name: '.text', address: 0x140001000n, size: 0x100n, fileOffset: 0n, fileSize: 0x100n, perms: { read: true, write: false, execute: true }, index: 1 });
  parseCoffSymbols(new ByteView(bytes), ptr, 1, image);
  const seed = image.functions[0];
  assert.ok(seed);
  assert.equal(seed.exactFunctionStart, true);
  assert.equal(isExactFunctionSeed(seed), true);
}

console.log('reopened binary issues #80/#112: ok');
