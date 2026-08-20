import assert from 'node:assert/strict';
import { parseDex, probeDex } from '../../../js/managed/dex/parser.js';

console.log('[phase11] running dex parser tests...');

export function buildMinimalDex() {
  const buf = new Uint8Array(0x200);
  const view = new DataView(buf.buffer);

  // magic 'dex\n035\0'
  buf.set([0x64, 0x65, 0x78, 0x0a, 0x30, 0x33, 0x35, 0x00], 0);
  view.setUint32(32, 0x200, true); // file_size
  view.setUint32(36, 0x70, true);  // header_size
  view.setUint32(40, 0x12345678, true); // endian_tag

  // string_ids
  view.setUint32(56, 3, true);  // string_ids_size
  view.setUint32(60, 0x70, true); // string_ids_off

  // type_ids
  view.setUint32(64, 2, true);  // type_ids_size
  view.setUint32(68, 0x80, true); // type_ids_off

  // proto_ids
  view.setUint32(72, 1, true);  // proto_ids_size
  view.setUint32(76, 0x90, true); // proto_ids_off

  // method_ids
  view.setUint32(88, 1, true);  // method_ids_size
  view.setUint32(92, 0xa0, true); // method_ids_off

  // class_defs
  view.setUint32(96, 1, true);  // class_defs_size
  view.setUint32(100, 0xb0, true); // class_defs_off

  // String data offsets (at 0x70)
  view.setUint32(0x70, 0x100, true); // string 0: "V"
  view.setUint32(0x74, 0x104, true); // string 1: "LTest;"
  view.setUint32(0x78, 0x110, true); // string 2: "foo"

  // Type ids (at 0x80)
  view.setUint32(0x80, 0, true); // type 0 -> string 0 ("V")
  view.setUint32(0x84, 1, true); // type 1 -> string 1 ("LTest;")

  // Proto ids (at 0x90): shorty=0, return_type=0, params_off=0
  view.setUint32(0x90, 0, true);
  view.setUint32(0x94, 0, true);
  view.setUint32(0x98, 0, true);

  // Method ids (at 0xa0): class_idx=1, proto_idx=0, name_idx=2
  view.setUint16(0xa0, 1, true);
  view.setUint16(0xa2, 0, true);
  view.setUint32(0xa4, 2, true);

  // Class defs (at 0xb0): class_idx=1, access_flags=1, superclass_idx=0xffffffff, interfaces_off=0, source_file=0xffffffff, annotations=0, class_data_off=0x120
  view.setUint32(0xb0, 1, true);
  view.setUint32(0xb4, 1, true);
  view.setUint32(0xb8, 0xffffffff, true);
  view.setUint32(0xbc, 0, true);
  view.setUint32(0xc0, 0xffffffff, true);
  view.setUint32(0xc4, 0, true);
  view.setUint32(0xc8, 0x120, true);

  // String data
  buf.set([1, 0x56, 0], 0x100); // 1, 'V', \0
  buf.set([6, 0x4c, 0x54, 0x65, 0x73, 0x74, 0x3b, 0], 0x104); // 6, 'LTest;', \0
  buf.set([3, 0x66, 0x6f, 0x6f, 0], 0x110); // 3, 'foo', \0

  // Class data (at 0x120): static_fields=0, instance_fields=0, direct_methods=1, virtual_methods=0
  // direct_method: method_idx_diff=0, access_flags=1, code_off=0x140
  buf.set([0x00, 0x00, 0x01, 0x00, 0x00, 0x01, 0xc0, 0x02], 0x120);

  // Code item (at 0x140):
  // registers_size=2, ins_size=1, outs_size=0, tries_size=0, debug_info_off=0, insns_size=2
  view.setUint16(0x140, 2, true);
  view.setUint16(0x142, 1, true);
  view.setUint16(0x144, 0, true);
  view.setUint16(0x146, 0, true);
  view.setUint32(0x148, 0, true);
  view.setUint32(0x14c, 2, true);
  // insns: const/4 v0, #1 (0x12, 0x10) -> return-void (0x0e, 0x00)
  buf.set([0x12, 0x10, 0x0e, 0x00], 0x150);

  return buf;
}

const dexBytes = buildMinimalDex();
const probe = probeDex(dexBytes);
assert.equal(probe.supported, true);
assert.equal(probe.formatVersion, 'dex-035');

const parsed = parseDex(dexBytes);
assert.equal(parsed.strings.length, 3);
assert.equal(parsed.strings[1], 'LTest;');
assert.equal(parsed.strings[2], 'foo');
assert.equal(parsed.classes.length, 1);
assert.equal(parsed.classes[0].classType, 'LTest;');
assert.equal(parsed.classes[0].directMethods.length, 1);
assert.equal(parsed.classes[0].directMethods[0].codeOff, 0x140);

console.log('  ok dex parser tests passed');
