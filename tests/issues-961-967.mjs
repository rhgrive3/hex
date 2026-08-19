import assert from 'node:assert/strict';
import {
  AAPCS64_ABI,
  classifyAAPCS64Arguments,
  classifyAAPCS64CallReturn,
  classifyAAPCS64FunctionReturn,
} from '../js/targets/abi/aapcs64.js';
import { parseELF } from '../js/binary/elf.js';
import { BinaryImage } from '../js/binary/model.js';
import { ByteView } from '../js/binary/reader.js';
import { parseExports, parseExceptionFunctions } from '../js/binary/pe-loader.js';

function hasRegister(list, register) { return list.map(String).includes(register); }

// #961: x18 is caller-saved when no platform ABI reserves it, but not on Darwin.
{
  const linux = AAPCS64_ABI.callerSaved({ platform:'linux' });
  const unknown = AAPCS64_ABI.callerSaved({ platform:'unknown' });
  const darwin = AAPCS64_ABI.callerSaved({ platform:'darwin' });
  assert.equal(hasRegister(linux, 'x18'), true);
  assert.equal(hasRegister(unknown, 'x18'), true);
  assert.equal(hasRegister(darwin, 'x18'), false);
  assert.equal(hasRegister(linux, 'x19'), false, 'x19 remains callee-saved');
  for (const reg of ['x16','x17','x30']) assert.equal(hasRegister(linux, reg), true, `${reg} remains caller-saved`);
  assert.equal(hasRegister(AAPCS64_ABI.defaultUnknownCallEffects({ platform:'linux' }).registerClobbers, 'x18'), true);
  assert.equal(hasRegister(AAPCS64_ABI.defaultUnknownCallEffects({ platform:'darwin' }).registerClobbers, 'x18'), false);
}

// #962: SVE evidence never silently falls back to xN/vN while the scalable PCS is unsupported.
{
  const vector = classifyAAPCS64Arguments({ callPrototype:{ args:[{ type:'svint32_t' }] } });
  assert.equal(vector.unsupported, true);
  assert.equal(vector.partial, true);
  assert.equal(vector.arguments[0].abiClass, 'scalable-vector');
  assert.equal(vector.arguments[0].location, 'unknown');
  assert.equal(vector.srcs.length, 0);

  const predicate = classifyAAPCS64Arguments({ callPrototype:{ args:[{ type:'svbool_t' }] } });
  assert.equal(predicate.unsupported, true);
  assert.equal(predicate.arguments[0].abiClass, 'scalable-predicate');
  assert.equal(predicate.arguments[0].location, 'unknown');

  const explicit = classifyAAPCS64Arguments({ callPrototype:{ args:[{ type:'opaque', abiClass:'vector-length-agnostic' }] } });
  assert.equal(explicit.unsupported, true);
  assert.equal(explicit.srcs.length, 0);

  const callReturn = classifyAAPCS64CallReturn({ callPrototype:{ returnType:'svint32_t', returnsValue:true } });
  assert.equal(callReturn.unsupported, true);
  assert.equal(callReturn.reg, null);
  const functionReturn = classifyAAPCS64FunctionReturn({ returnType:'svbool_t', returnsValue:true });
  assert.equal(functionReturn.unsupported, true);
  assert.equal(functionReturn.reg, null);

  const scalableEffects = AAPCS64_ABI.defaultUnknownCallEffects({
    platform:'linux',
    callPrototype:{ args:[{ type:'svint32_t' }], returnType:'svint32_t', returnsValue:true },
  });
  assert.equal(scalableEffects.unsupported, true);
  for (const reg of ['x18','z0','z31','p0','p15','ffr']) {
    assert.equal(hasRegister(scalableEffects.registerClobbers, reg), true, `scalable fail-closed clobber includes ${reg}`);
  }

  const fp = classifyAAPCS64Arguments({ callPrototype:{ args:[{ type:'float', bits:32 }] } });
  assert.equal(fp.arguments[0].reg, 'v0');
  const integer = classifyAAPCS64Arguments({ callPrototype:{ args:[{ type:'uint64_t', bits:64 }] } });
  assert.equal(integer.arguments[0].reg, 'x0');
  const shortVector = classifyAAPCS64Arguments({ callPrototype:{ args:[{ type:'uint32x4_t', abiClass:'vector', bits:128 }] } });
  assert.equal(shortVector.arguments[0].reg, 'v0');
}

function elf64Fixture(entry = 0n) {
  const bytes = new Uint8Array(0x200);
  const dv = new DataView(bytes.buffer);
  bytes.set([0x7f,0x45,0x4c,0x46,2,1,1,0], 0);
  dv.setUint16(16, 2, true);              // ET_EXEC
  dv.setUint16(18, 183, true);            // EM_AARCH64
  dv.setUint32(20, 1, true);
  dv.setBigUint64(24, BigInt(entry), true);
  dv.setBigUint64(32, 64n, true);         // e_phoff
  dv.setBigUint64(40, 0n, true);          // no section table
  dv.setUint32(48, 0, true);
  dv.setUint16(52, 64, true);
  dv.setUint16(54, 56, true);
  dv.setUint16(56, 1, true);
  dv.setUint16(58, 0, true);
  dv.setUint16(60, 0, true);
  dv.setUint16(62, 0, true);

  const ph = 64;
  dv.setUint32(ph, 1, true);              // PT_LOAD
  dv.setUint32(ph + 4, 5, true);          // PF_R | PF_X
  dv.setBigUint64(ph + 8, 0n, true);
  dv.setBigUint64(ph + 16, 0n, true);
  dv.setBigUint64(ph + 24, 0n, true);
  dv.setBigUint64(ph + 32, BigInt(bytes.length), true);
  dv.setBigUint64(ph + 40, BigInt(bytes.length), true);
  dv.setBigUint64(ph + 48, 0x1000n, true);
  return bytes;
}

function entrySeeds(image) { return image.functions.filter((seed) => seed.source === 'entrypoint'); }

// #965: address zero is distinct from no-entry and becomes a seed only with platform authority.
{
  const firmware = parseELF(elf64Fixture(0n), { platform:'bare-metal' });
  assert.equal(firmware.entrypoint, 0n);
  assert.equal(firmware.metadata.entrypointPresence, 'present');
  assert.equal(firmware.metadata.entrypointValid, true);
  assert.equal(entrySeeds(firmware).length, 1);
  assert.equal(entrySeeds(firmware)[0].address, 0n);

  const generic = parseELF(elf64Fixture(0n));
  assert.equal(generic.entrypoint, 0n);
  assert.equal(generic.metadata.entrypointPresence, 'ambiguous-zero');
  assert.equal(generic.metadata.entrypointValid, null);
  assert.equal(entrySeeds(generic).length, 0);

  const sentinel = parseELF(elf64Fixture(0n), { entrypointPresence:'absent' });
  assert.equal(sentinel.metadata.entrypointPresence, 'absent-zero-sentinel');
  assert.equal(entrySeeds(sentinel).length, 0);

  const nonzero = parseELF(elf64Fixture(0x80n));
  assert.equal(nonzero.metadata.entrypointPresence, 'present');
  assert.equal(entrySeeds(nonzero).length, 1);
  assert.equal(entrySeeds(nonzero)[0].address, 0x80n);

  const unmapped = parseELF(elf64Fixture(0x300n));
  assert.equal(unmapped.metadata.entrypointValid, false);
  assert.equal(entrySeeds(unmapped).length, 0);
}

function peExportFixture({ targetRva = 0x1200, forwarder = null } = {}) {
  const bytes = new Uint8Array(0x800);
  const imageBase = 0x140000000n;
  const image = new BinaryImage(bytes, { format:'pe', arch:'x86_64', bits:64, endian:'little', platform:'windows', imageBase });
  image.addSection({
    name:'.text', address:imageBase + 0x1000n, size:0x500n,
    fileOffset:0x200n, fileSize:0x500n,
    perms:{read:true,write:false,execute:true}, source:'PE-section', index:1,
  });
  image.addSegment({
    name:'.text', address:imageBase + 0x1000n, size:0x500n,
    fileOffset:0x200n, fileSize:0x500n,
    perms:{read:true,write:false,execute:true}, source:'PE-section',
  });
  const dv = new DataView(bytes.buffer);
  const exportOff = 0x300;               // RVA 0x1100
  dv.setUint32(exportOff + 12, 0x1168, true);
  dv.setUint32(exportOff + 16, 1, true);
  dv.setUint32(exportOff + 20, 1, true);
  dv.setUint32(exportOff + 24, 1, true);
  dv.setUint32(exportOff + 28, 0x1140, true);
  dv.setUint32(exportOff + 32, 0x1144, true);
  dv.setUint32(exportOff + 36, 0x1148, true);
  dv.setUint32(0x340, targetRva, true);
  dv.setUint32(0x344, 0x1160, true);
  dv.setUint16(0x348, 0, true);
  bytes.set(new TextEncoder().encode('foo\0'), 0x360);
  bytes.set(new TextEncoder().encode('x.dll\0'), 0x368);
  if (forwarder) bytes.set(new TextEncoder().encode(`${forwarder}\0`), 0x370);
  return { bytes, image, view:new ByteView(bytes, { littleEndian:true }), imageBase };
}

// #967: EAT proves export visibility, not function identity, even inside RX data.
{
  const { image, view, imageBase } = peExportFixture();
  parseExports(view, { rva:0x1100, size:0x80 }, image);
  assert.equal(image.exports.length, 1);
  assert.equal(image.exports[0].name, 'foo');
  assert.equal(image.exports[0].symbolKind, 'unknown');
  assert.equal(image.exports[0].functionStartAuthority, false);
  assert.equal(image.exports[0].evidence, 'exported-symbol-kind-unknown');
  assert.equal(image.functions.length, 0, 'RX export alone must not seed a function');

  const dv = new DataView(view.bytes.buffer, view.bytes.byteOffset, view.bytes.byteLength);
  dv.setUint32(0x380, 0x1200, true);      // .pdata BeginAddress
  dv.setUint32(0x384, 0x1210, true);      // EndAddress
  dv.setUint32(0x388, 0, true);           // UnwindInfoAddress
  parseExceptionFunctions(view, { rva:0x1180, size:12 }, image, 0x8664);
  assert.equal(image.functions.length, 1);
  assert.equal(image.functions[0].source, 'exception');
  assert.equal(image.functions[0].address, imageBase + 0x1200n);
  assert.equal(image.functions[0].name, 'foo', 'EAT name enriches independently proven function start');
}

// Forwarder behavior remains unchanged and never creates a function seed.
{
  const fixture = peExportFixture({ targetRva:0x1170, forwarder:'KERNEL32.Sleep' });
  parseExports(fixture.view, { rva:0x1100, size:0x80 }, fixture.image);
  assert.equal(fixture.image.exports.length, 1);
  assert.equal(fixture.image.exports[0].kind, 'forwarder');
  assert.equal(fixture.image.exports[0].forwarder, 'KERNEL32.Sleep');
  assert.equal(fixture.image.functions.length, 0);
}

console.log('issues #961/#962/#965/#967 regressions PASS');
