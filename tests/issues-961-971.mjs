import assert from 'node:assert/strict';
import { BinaryImage } from '../js/binary/model.js';
import { parseELF } from '../js/binary/elf.js';
import { parseMachO } from '../js/binary/macho.js';
import { parsePE } from '../js/binary/pe.js';
import { AAPCS64_ABI, classifyAAPCS64Arguments, classifyAAPCS64CallReturn } from '../js/targets/abi/aapcs64.js';
import { expr } from '../js/decompiler/ast/nodes.js';
import { printExpression } from '../js/decompiler/pretty/c.js';

const putAscii = (bytes, offset, text) => {
  for (let i = 0; i < text.length; i++) bytes[offset + i] = text.charCodeAt(i);
};

function elf64Fixture(machine) {
  const bytes = new Uint8Array(0x100);
  const d = new DataView(bytes.buffer);
  bytes.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0]);
  d.setUint16(16, 2, true); // ET_EXEC
  d.setUint16(18, machine, true);
  d.setUint32(20, 1, true);
  d.setBigUint64(24, 0n, true); // reset vector / zero sentinel
  d.setBigUint64(32, 64n, true);
  d.setBigUint64(40, 0n, true);
  d.setUint16(52, 64, true);
  d.setUint16(54, 56, true);
  d.setUint16(56, 1, true);
  d.setUint16(58, 0, true);
  d.setUint16(60, 0, true);
  d.setUint16(62, 0, true);
  const p = 64;
  d.setUint32(p, 1, true); // PT_LOAD
  d.setUint32(p + 4, 5, true); // R|X
  d.setBigUint64(p + 8, 0n, true);
  d.setBigUint64(p + 16, 0n, true);
  d.setBigUint64(p + 24, 0n, true);
  d.setBigUint64(p + 32, BigInt(bytes.length), true);
  d.setBigUint64(p + 40, BigInt(bytes.length), true);
  d.setBigUint64(p + 48, 0x1000n, true);
  return bytes;
}

function machoArm64ThreadFixture({ subtype = 0, count = 68, pc = 0x1100n } = {}) {
  const bytes = new Uint8Array(0x400);
  const d = new DataView(bytes.buffer);
  d.setUint32(0, 0xfeedfacf, true);
  d.setUint32(4, 0x0100000c, true);
  d.setUint32(8, subtype, true);
  d.setUint32(12, 2, true);
  d.setUint32(16, 2, true);
  d.setUint32(20, 72 + 288, true);
  d.setUint32(24, 0, true);
  d.setUint32(28, 0, true);

  const seg = 32;
  d.setUint32(seg, 0x19, true);
  d.setUint32(seg + 4, 72, true);
  putAscii(bytes, seg + 8, '__TEXT');
  d.setBigUint64(seg + 24, 0x1000n, true);
  d.setBigUint64(seg + 32, 0x1000n, true);
  d.setBigUint64(seg + 40, 0n, true);
  d.setBigUint64(seg + 48, BigInt(bytes.length), true);
  d.setInt32(seg + 56, 5, true);
  d.setInt32(seg + 60, 5, true);
  d.setUint32(seg + 64, 0, true);
  d.setUint32(seg + 68, 0, true);

  const thread = seg + 72;
  d.setUint32(thread, 5, true); // LC_UNIXTHREAD
  d.setUint32(thread + 4, 288, true);
  d.setUint32(thread + 8, 6, true); // ARM_THREAD_STATE64
  d.setUint32(thread + 12, count, true);
  const state = thread + 16;
  d.setBigUint64(state + 256, pc, true);
  d.setUint32(state + 264, 0x12345678, true); // CPSR: deliberately not PC
  d.setUint32(state + 268, 0x87654321, true);
  return bytes;
}

function peExportFixture({ withPdata = false } = {}) {
  const bytes = new Uint8Array(0x800);
  const d = new DataView(bytes.buffer);
  d.setUint16(0, 0x5a4d, true);
  d.setUint32(0x3c, 0x80, true);
  d.setUint32(0x80, 0x00004550, true);
  const coff = 0x84;
  d.setUint16(coff, 0x8664, true);
  d.setUint16(coff + 2, 1, true);
  d.setUint16(coff + 16, 240, true);
  d.setUint16(coff + 18, 0x2022, true);
  const opt = coff + 20;
  d.setUint16(opt, 0x20b, true);
  d.setUint32(opt + 16, 0, true);
  d.setBigUint64(opt + 24, 0x140000000n, true);
  d.setUint32(opt + 32, 0x1000, true);
  d.setUint32(opt + 36, 0x200, true);
  d.setUint32(opt + 56, 0x2000, true);
  d.setUint32(opt + 60, 0x200, true);
  d.setUint16(opt + 68, 3, true);
  d.setUint32(opt + 108, 16, true);
  const dirs = opt + 112;
  d.setUint32(dirs, 0x1100, true);
  d.setUint32(dirs + 4, 0x80, true);
  if (withPdata) {
    d.setUint32(dirs + 3 * 8, 0x1160, true);
    d.setUint32(dirs + 3 * 8 + 4, 12, true);
  }

  const sec = opt + 240;
  putAscii(bytes, sec, '.text');
  d.setUint32(sec + 8, 0x1000, true);
  d.setUint32(sec + 12, 0x1000, true);
  d.setUint32(sec + 16, 0x600, true);
  d.setUint32(sec + 20, 0x200, true);
  d.setUint32(sec + 36, 0x60000020, true);

  const exp = 0x300; // RVA 0x1100
  d.setUint32(exp + 12, 0x1180, true);
  d.setUint32(exp + 16, 1, true);
  d.setUint32(exp + 20, 1, true);
  d.setUint32(exp + 24, 1, true);
  d.setUint32(exp + 28, 0x1140, true);
  d.setUint32(exp + 32, 0x1144, true);
  d.setUint32(exp + 36, 0x1148, true);
  d.setUint32(0x340, 0x1200, true);
  d.setUint32(0x344, 0x1190, true);
  d.setUint16(0x348, 0, true);
  putAscii(bytes, 0x380, 'fixture.dll\0');
  putAscii(bytes, 0x390, 'exported_symbol\0');

  if (withPdata) {
    d.setUint32(0x360, 0x1200, true);
    d.setUint32(0x364, 0x1210, true);
    d.setUint32(0x368, 0x1220, true);
    // UNWIND_INFO at RVA 0x1220 (file 0x420): version 1, no flags, no codes.
    d.setUint32(0x420, 0x00000001, true);
  }
  return bytes;
}

// #970: virtual reads must honor file-backed and zero-fill spans and fail on gaps.
{
  const bytes = Uint8Array.from([0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff]);
  const image = new BinaryImage(bytes);
  image.addSegment({ address:0x1000n, size:8n, fileOffset:0n, fileSize:4n, perms:{read:true} });
  assert.deepEqual([...image.readVirtual(0x1002n, 4)], [0xcc, 0xdd, 0, 0]);

  const sourceImage = new BinaryImage(bytes);
  sourceImage.addSegment({ address:0x1000n, size:8n, fileOffset:0n, fileSize:4n, perms:{read:true} });
  sourceImage.attachSource({
    size:BigInt(bytes.length),
    async readExactly(offset, length) {
      const start = Number(offset), end = start + Number(length);
      return bytes.slice(start, end);
    },
  }, { discardBytes:true });
  assert.deepEqual([...await sourceImage.readVirtualAsync(0x1002n, 4)], [0xcc, 0xdd, 0, 0]);

  const gap = new BinaryImage(bytes);
  gap.addSegment({ address:0x2000n, size:2n, fileOffset:0n, fileSize:2n, perms:{read:true} });
  gap.addSegment({ address:0x2004n, size:2n, fileOffset:2n, fileSize:2n, perms:{read:true} });
  assert.equal(gap.readVirtual(0x2001n, 4), null);

  const remapped = new BinaryImage(bytes);
  remapped.addSegment({ address:0x3000n, size:2n, fileOffset:4n, fileSize:2n, perms:{read:true} });
  remapped.addSegment({ address:0x3002n, size:2n, fileOffset:0n, fileSize:2n, perms:{read:true} });
  assert.deepEqual([...remapped.readVirtual(0x3000n, 4)], [0xee, 0xff, 0xaa, 0xbb]);
}

// #961: x18 is caller-saved outside Apple, reserved on Apple, while x19 remains preserved.
{
  assert(AAPCS64_ABI.callerSaved({ platform:'linux' }).includes('x18'));
  assert(AAPCS64_ABI.callerSaved({ platform:'unknown' }).includes('x18'));
  assert(!AAPCS64_ABI.callerSaved({ platform:'darwin' }).includes('x18'));
  assert(!AAPCS64_ABI.callerSaved({ platform:'ios' }).includes('x18'));
  assert(!AAPCS64_ABI.callerSaved({ platform:'linux' }).includes('x19'));
  assert(AAPCS64_ABI.defaultUnknownCallEffects({ platform:'linux' }).registerClobbers.includes('x18'));
}

// #962: scalable SVE types must never silently consume xN/vN scalar ABI locations.
{
  const classified = classifyAAPCS64Arguments({
    callPrototype:{ args:[{ type:'svint32_t' }, { type:'svbool_t' }, { type:'uint64_t' }] },
  });
  assert.equal(classified.unsupported, true);
  assert.equal(classified.arguments[0].location, 'unsupported');
  assert.equal(classified.arguments[0].abiClass, 'sve-scalable-vector');
  assert.equal(classified.arguments[1].abiClass, 'sve-predicate');
  assert.equal(classified.arguments[2].reg, 'x0');
  assert.equal(classifyAAPCS64CallReturn({ callPrototype:{ returnType:'svint32_t' } }), null);

  const vector = classifyAAPCS64Arguments({ callPrototype:{ args:[{ abiClass:'vector', bits:128 }] } });
  assert.equal(vector.arguments[0].reg, 'v0');
}

// #965: e_entry=0 is a real AArch64 reset vector only when executable mapping evidence exists.
{
  const arm64 = parseELF(elf64Fixture(183));
  assert.equal(arm64.entrypoint, 0n);
  assert.equal(arm64.metadata.entrypointZeroEvidence, 'aarch64-executable-pt-load-at-zero');
  assert(arm64.functions.some((f) => f.address === 0n && f.source === 'entrypoint'));
  assert.equal(arm64.toJSON().entrypoint, '0x0');

  const x64 = parseELF(elf64Fixture(62));
  assert.equal(x64.entrypoint, 0n);
  assert.equal(x64.metadata.entrypointZeroEvidence, 'zero-sentinel-unproven');
  assert(!x64.functions.some((f) => f.address === 0n && f.source === 'entrypoint'));
}

// #967: an EAT entry in RX memory is symbol evidence, not function proof by itself.
{
  const exportOnly = parsePE(peExportFixture());
  const exportAddress = 0x140001200n;
  assert(exportOnly.exports.some((e) => e.address === exportAddress && e.name === 'exported_symbol'));
  assert(!exportOnly.functions.some((f) => f.address === exportAddress));
  assert.equal(exportOnly.metadata.peExportFunctionEvidence.rejectedExportOnly, 1);

  const corroborated = parsePE(peExportFixture({ withPdata:true }));
  const fn = corroborated.functions.find((f) => f.address === exportAddress);
  assert(fn, 'validated .pdata function must survive export reconciliation');
  assert.equal(fn.name, 'exported_symbol');
  assert(fn.sources.includes('export-name'));
}

// #969: fixed-width modulo operations are printed through unsigned arithmetic at the operation site.
{
  const operatorText = { add:'+', sub:'-', mul:'*' };
  for (const bits of [8, 16, 32, 64, 128]) {
    const a = expr.variable('a', bits, true);
    const b = expr.variable('b', bits, true);
    for (const op of ['add', 'sub', 'mul']) {
      const text = printExpression(expr.binary(op, a, b, bits, true));
      // Both operands must go through an unsigned type whose rank cannot be
      // promoted back to signed `int`, and the result is truncated to the exact
      // machine width before the signed view is restored.
      assert.match(text, /^\(int(?:8|16|32|64)_t|^\(__int128/);
      assert.match(text, /\(uint(?:32|64)_t\)a|\(unsigned __int128\)a/);
      assert.match(text, /\(uint(?:32|64)_t\)b|\(unsigned __int128\)b/);
      assert.doesNotMatch(text, /\(int(?:8|16|32|64)_t\)a|\(__int128\)a/);
      assert(text.includes(` ${operatorText[op]} `));
    }
    const shifted = printExpression(expr.binary('shl', a, b, bits, true));
    assert.match(shifted, /\(uint(?:32|64)_t\)a|\(unsigned __int128\)a/);
    assert.match(shifted, /<</);
  }
}

// #971: ARM_THREAD_STATE64 PC is +256; +264 is CPSR. Exact count and executable mapping are required.
{
  for (const subtype of [0, 2]) {
    const image = parseMachO(machoArm64ThreadFixture({ subtype }));
    assert.equal(image.entrypoint, 0x1100n);
    assert(image.functions.some((f) => f.address === 0x1100n && f.source === 'entrypoint'));
    assert.equal(image.metadata.entrypointSource, 'LC_UNIXTHREAD');
  }

  const shortState = parseMachO(machoArm64ThreadFixture({ count:67 }));
  assert.equal(shortState.entrypoint, null);
  assert(!shortState.functions.some((f) => f.source === 'entrypoint'));

  const unmapped = parseMachO(machoArm64ThreadFixture({ pc:0x5000n }));
  assert.equal(unmapped.entrypoint, 0x5000n);
  assert.equal(unmapped.metadata.entrypointValid, false);
  assert(!unmapped.functions.some((f) => f.address === 0x5000n));
}

console.log('issues-961-971: ok');
