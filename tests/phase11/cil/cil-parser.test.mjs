import assert from 'node:assert/strict';
import { parseCil, probeCil } from '../../../js/managed/cil/parser.js';

console.log('[phase11] running cil parser tests...');

export function buildMinimalCil() {
  const buf = new Uint8Array(0x300);
  const view = new DataView(buf.buffer);

  // DOS header
  buf[0] = 0x4d; buf[1] = 0x5a; // 'MZ'
  view.setUint32(0x3c, 0x80, true); // PE offset

  // PE signature
  buf[0x80] = 0x50; buf[0x81] = 0x45; buf[0x82] = 0; buf[0x83] = 0; // 'PE\0\0'

  // Metadata root BSJB signature at 0x100
  buf[0x100] = 0x42; buf[0x101] = 0x53; buf[0x102] = 0x4a; buf[0x103] = 0x42; // 'BSJB'
  view.setUint16(0x104, 1, true); // MajorVersion
  view.setUint16(0x106, 1, true); // MinorVersion
  view.setUint32(0x10c, 12, true); // Version length
  // Version string "v4.0.30319\0\0"
  const vBytes = new TextEncoder().encode('v4.0.30319\0\0');
  buf.set(vBytes, 0x110);

  // Flags & streams at 0x11c (0x110 + 12)
  view.setUint16(0x11e, 1, true); // 1 stream
  // Stream 0: offset 0x40, size 0x20, name "#Strings\0"
  view.setUint32(0x120, 0x40, true);
  view.setUint32(0x124, 0x20, true);
  buf.set([0x23, 0x53, 0x74, 0x72, 0x69, 0x6e, 0x67, 0x73, 0], 0x128); // "#Strings\0"

  // #Strings content at 0x140 (0x100 + 0x40)
  buf.set([0, 0x4d, 0x79, 0x4d, 0x65, 0x74, 0x68, 0x6f, 0x64, 0], 0x140); // "\0MyMethod\0"

  // Method body at 0x200 (Tiny header: 0x02 | (codeSize << 2))
  // codeSize = 5 -> byte = 0x02 | (5 << 2) = 0x16
  // bytecode: ldc.i4.5 (0x1b), stloc.0 (0x0a), ldloc.0 (0x06), ret (0x2a), nop (0x00) -> 5 bytes
  buf[0x200] = (5 << 2) | 0x02;
  buf[0x201] = 0x1b; // ldc.i4.5
  buf[0x202] = 0x0a; // stloc.0
  buf[0x203] = 0x06; // ldloc.0
  buf[0x204] = 0x2a; // ret
  buf[0x205] = 0x00; // nop

  return buf;
}

const cilBytes = buildMinimalCil();
const probe = probeCil(cilBytes);
assert.equal(probe.supported, true);

const parsed = parseCil(cilBytes);
assert.equal(parsed.formatVersion, 'cli-ecma-335');
assert.equal(parsed.vmSpecEdition, 'v4.0.30319');
assert.equal(parsed.methodBodies.length, 1);
assert.equal(parsed.methodBodies[0].isTiny, true);
assert.equal(parsed.methodBodies[0].codeSize, 5);

console.log('  ok cil parser tests passed');
