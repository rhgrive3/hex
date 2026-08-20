import assert from 'node:assert/strict';
import { parseJvm, probeJvm } from '../../../js/managed/jvm/parser.js';

console.log('[phase11] running jvm parser tests...');

export function buildMinimalJvmClass() {
  const buf = new Uint8Array(0x200);
  const view = new DataView(buf.buffer);

  // magic 0xCAFEBABE
  buf[0] = 0xca; buf[1] = 0xfe; buf[2] = 0xba; buf[3] = 0xbe;
  view.setUint16(4, 0, false);  // minor_version
  view.setUint16(6, 61, false); // major_version (Java 17)

  // Constant pool count = 6 (entries 1..5)
  view.setUint16(8, 6, false);

  let p = 10;
  // CP 1: Utf8 "TestClass"
  buf[p++] = 1; view.setUint16(p, 9, false); p += 2;
  buf.set(new TextEncoder().encode('TestClass'), p); p += 9;

  // CP 2: Class -> name_index 1
  buf[p++] = 7; view.setUint16(p, 1, false); p += 2;

  // CP 3: Utf8 "testMethod"
  buf[p++] = 1; view.setUint16(p, 10, false); p += 2;
  buf.set(new TextEncoder().encode('testMethod'), p); p += 10;

  // CP 4: Utf8 "()V"
  buf[p++] = 1; view.setUint16(p, 3, false); p += 2;
  buf.set(new TextEncoder().encode('()V'), p); p += 3;

  // CP 5: Utf8 "Code"
  buf[p++] = 1; view.setUint16(p, 4, false); p += 2;
  buf.set(new TextEncoder().encode('Code'), p); p += 4;

  // Class info: access_flags=0x0001, this_class=2, super_class=0, interfaces_count=0
  view.setUint16(p, 0x0001, false); p += 2;
  view.setUint16(p, 2, false); p += 2;
  view.setUint16(p, 0, false); p += 2;
  view.setUint16(p, 0, false); p += 2;

  // fields_count=0
  view.setUint16(p, 0, false); p += 2;

  // methods_count=1
  view.setUint16(p, 1, false); p += 2;
  // method 0: access_flags=0x0001, name_index=3, descriptor_index=4, attributes_count=1
  view.setUint16(p, 0x0001, false); p += 2;
  view.setUint16(p, 3, false); p += 2;
  view.setUint16(p, 4, false); p += 2;
  view.setUint16(p, 1, false); p += 2;

  // Code attribute: name_index=5, length=18
  // attribute header:
  view.setUint16(p, 5, false); p += 2;
  view.setUint32(p, 18, false); p += 4;
  // Code content: max_stack=2, max_locals=2, code_length=6
  view.setUint16(p, 2, false); p += 2;
  view.setUint16(p, 2, false); p += 2;
  view.setUint32(p, 6, false); p += 4;
  // Bytecode: iconst_5 (0x08), istore_1 (0x3c), iload_1 (0x1b), iconst_1 (0x04), iadd (0x60), return (0xb1)
  buf.set([0x08, 0x3c, 0x1b, 0x04, 0x60, 0xb1], p); p += 6;
  // Exception table length = 0
  view.setUint16(p, 0, false); p += 2;
  // Code attributes_count = 0
  view.setUint16(p, 0, false); p += 2;

  // Class attributes_count = 0
  view.setUint16(p, 0, false); p += 2;

  return buf.subarray(0, p);
}

const classBytes = buildMinimalJvmClass();
const probe = probeJvm(classBytes);
assert.equal(probe.supported, true);
assert.equal(probe.formatVersion, 'class-61.0');
assert.equal(probe.vmSpecEdition, 'java-se-17');

const parsed = parseJvm(classBytes);
assert.equal(parsed.thisClassName, 'TestClass');
assert.equal(parsed.methods.length, 1);
assert.equal(parsed.methods[0].name, 'testMethod');
assert.equal(parsed.methods[0].descriptor, '()V');
assert.ok(parsed.methods[0].code);
assert.equal(parsed.methods[0].code.maxStack, 2);
assert.equal(parsed.methods[0].code.maxLocals, 2);
assert.equal(parsed.methods[0].code.codeLength, 6);

console.log('  ok jvm parser tests passed');
