import assert from 'node:assert/strict';
import { expr } from '../js/decompiler/ast/nodes.js';
import { printExpression } from '../js/decompiler/pretty/c.js';
import { BinaryImage } from '../js/binary/model.js';
import { parseMachO } from '../js/binary/macho.js';

// #969: fixed-width arithmetic must not inherit C signed-overflow/left-shift UB.
{
  const x32 = expr.variable('x', 32, true);
  const cases = [
    ['add', expr.constant(1n, 32, true)],
    ['sub', expr.constant(1n, 32, true)],
    ['mul', expr.constant(2n, 32, true)],
    ['shl', expr.constant(1n, 32, false)],
  ];
  for (const [op, rhs] of cases) {
    const text = printExpression(expr.binary(op, x32, rhs, 32, true));
    assert.match(text, /uint32_t/, `${op} must execute in an unsigned 32-bit domain: ${text}`);
    assert.match(text, /int32_t/, `${op} signed view must be restored only after modulo arithmetic: ${text}`);
    assert.ok(text.includes({add:'+',sub:'-',mul:'*',shl:'<<'}[op]));
  }
  for (const bits of [8, 16]) {
    const text = printExpression(expr.binary('mul', expr.variable('x', bits, true), expr.constant(2n, bits, true), bits, true));
    assert.match(text, /uint32_t/, `${bits}-bit arithmetic must avoid signed integer promotion UB`);
    assert.match(text, new RegExp(`uint${bits}_t`));
  }
  const u64 = printExpression(expr.binary('add', expr.variable('x',64,true), expr.constant(1n,64,true),64,true));
  assert.match(u64,/uint64_t/); assert.match(u64,/int64_t/);
  const u128 = printExpression(expr.binary('add', expr.variable('x',128,true), expr.constant(1n,128,true),128,true));
  assert.match(u128,/unsigned __int128/); assert.match(u128,/\(__int128\)/);
  const safe = printExpression(expr.binary('add', expr.variable('x',32,true), expr.constant(1n,32,true),32,true));
  assert.notEqual(safe, 'x + 1', 'even apparently small syntax must not discard modulo semantics without a range proof');
}

function mappedImage(bytes, { format='elf', base=0x1000n, size=8n, fileOffset=0n, fileSize=4n } = {}) {
  const image = new BinaryImage(bytes, { format, arch:'arm64', bits:64, imageBase:base });
  image.addSegment({ name:'mapped', address:base, size, fileOffset, fileSize, perms:{read:true,write:true,execute:true}, source:'test' });
  return image;
}

// #970: virtual reads compose file-backed and zero-fill spans; raw file adjacency is irrelevant.
{
  const raw = Uint8Array.from([0xAA,0xBB,0xCC,0xDD,0x11,0x22,0x33,0x44]);
  for (const format of ['elf','macho','pe']) {
    const image = mappedImage(raw, { format });
    assert.deepEqual([...image.readVirtual(0x1000n,4)], [0xAA,0xBB,0xCC,0xDD]);
    assert.deepEqual([...image.readVirtual(0x1002n,4)], [0xCC,0xDD,0,0], `${format} file->zero-fill crossing`);
    assert.deepEqual([...image.readVirtual(0x1004n,4)], [0,0,0,0], `${format} zero-fill tail`);
  }

  const gap = new BinaryImage(raw, { format:'elf', arch:'arm64', bits:64 });
  gap.addSegment({ name:'a', address:0x1000n, size:4n, fileOffset:0n, fileSize:4n, perms:{read:true} });
  gap.addSegment({ name:'b', address:0x2000n, size:4n, fileOffset:4n, fileSize:4n, perms:{read:true} });
  assert.equal(gap.readVirtual(0x1002n,4), null, 'unmapped VA gap must fail closed');

  const splitRaw = Uint8Array.from([0xAA,0xBB,0,0,0,0,0xCC,0xDD]);
  const split = new BinaryImage(splitRaw, { format:'elf', arch:'arm64', bits:64 });
  split.addSegment({ name:'a', address:0x1000n, size:2n, fileOffset:0n, fileSize:2n, perms:{read:true} });
  split.addSegment({ name:'b', address:0x1002n, size:2n, fileOffset:6n, fileSize:2n, perms:{read:true} });
  assert.deepEqual([...split.readVirtual(0x1000n,4)], [0xAA,0xBB,0xCC,0xDD], 'VA-contiguous mappings may compose non-contiguous file spans');

  const asyncImage = mappedImage(raw);
  const sourceBytes = raw.slice();
  asyncImage.attachSource({
    size:BigInt(sourceBytes.length),
    async readExactly(offset, size) {
      const o=Number(offset), n=Number(size);
      return sourceBytes.slice(o,o+n);
    },
  }, { discardBytes:true });
  assert.deepEqual([...await asyncImage.readVirtualAsync(0x1002n,4)], [0xCC,0xDD,0,0]);
  assert.deepEqual([...await asyncImage.readVirtualAsync(0x1004n,4)], [0,0,0,0]);
}

function macho64ThreadFixture({ cpu=0x0100000c, subtype=0, flavor=6, count=68, pc=0x100000200n, cpsr=0x60000000, extraFlavor=false } = {}) {
  const headerSize=32, segmentSize=72;
  const firstStateBytes=extraFlavor?4:0;
  const prefix=extraFlavor?(8+firstStateBytes):0;
  const stateBytes=count*4;
  const threadSize=8+prefix+8+stateBytes;
  const bytes=new Uint8Array(Math.max(0x400,headerSize+segmentSize+threadSize));
  const dv=new DataView(bytes.buffer);
  dv.setUint32(0,0xfeedfacf,true); dv.setInt32(4,cpu,true); dv.setInt32(8,subtype,true);
  dv.setUint32(12,2,true); dv.setUint32(16,2,true); dv.setUint32(20,segmentSize+threadSize,true);
  const seg=headerSize;
  dv.setUint32(seg,0x19,true); dv.setUint32(seg+4,segmentSize,true);
  new TextEncoder().encodeInto('__TEXT',bytes.subarray(seg+8,seg+24));
  dv.setBigUint64(seg+24,0x100000000n,true); dv.setBigUint64(seg+32,0x1000n,true);
  dv.setBigUint64(seg+40,0n,true); dv.setBigUint64(seg+48,BigInt(bytes.length),true);
  dv.setInt32(seg+56,7,true); dv.setInt32(seg+60,5,true); dv.setUint32(seg+64,0,true); dv.setUint32(seg+68,0,true);
  const thread=headerSize+segmentSize;
  dv.setUint32(thread,0x5,true); dv.setUint32(thread+4,threadSize,true);
  let q=thread+8;
  if(extraFlavor){dv.setUint32(q,0xdead,true);dv.setUint32(q+4,1,true);dv.setUint32(q+8,0x12345678,true);q+=12;}
  dv.setUint32(q,flavor,true); dv.setUint32(q+4,count,true); const state=q+8;
  if(flavor===6&&count>=68){dv.setBigUint64(state+256,pc,true);dv.setUint32(state+264,cpsr,true);dv.setUint32(state+268,0xA5A5A5A5,true);}
  else if(flavor===4&&count>=34){dv.setBigUint64(state+128,pc,true);}
  return bytes;
}

function macho32ArmThreadFixture(pc=0x1200) {
  const headerSize=28,segmentSize=56,count=16,stateBytes=64,threadSize=8+8+stateBytes;
  const bytes=new Uint8Array(0x400); const dv=new DataView(bytes.buffer);
  dv.setUint32(0,0xfeedface,true); dv.setInt32(4,12,true); dv.setInt32(8,0,true);
  dv.setUint32(12,2,true);dv.setUint32(16,2,true);dv.setUint32(20,segmentSize+threadSize,true);
  const seg=headerSize;dv.setUint32(seg,1,true);dv.setUint32(seg+4,segmentSize,true);new TextEncoder().encodeInto('__TEXT',bytes.subarray(seg+8,seg+24));
  dv.setUint32(seg+24,0x1000,true);dv.setUint32(seg+28,0x1000,true);dv.setUint32(seg+32,0,true);dv.setUint32(seg+36,bytes.length,true);dv.setInt32(seg+40,7,true);dv.setInt32(seg+44,5,true);
  const t=headerSize+segmentSize;dv.setUint32(t,5,true);dv.setUint32(t+4,threadSize,true);dv.setUint32(t+8,1,true);dv.setUint32(t+12,count,true);dv.setUint32(t+16+60,pc,true);
  return bytes;
}

// #971: ARM_THREAD_STATE64 PC is +256, never CPSR/pad at +264, and must validate as code.
{
  const arm64=parseMachO(macho64ThreadFixture());
  assert.equal(arm64.entrypoint,0x100000200n); assert.equal(arm64.metadata.entrypointSource,'LC_UNIXTHREAD');
  assert.equal(arm64.metadata.threadEntrypoint.layout,'ARM_THREAD_STATE64'); assert.equal(arm64.metadata.threadEntrypoint.valid,true);
  assert.equal(arm64.functions.some((f)=>f.source==='entrypoint'&&f.address===0x100000200n),true);

  const arm64e=parseMachO(macho64ThreadFixture({subtype:2}));
  assert.equal(arm64e.arch,'arm64e'); assert.equal(arm64e.entrypoint,0x100000200n);

  const multiple=parseMachO(macho64ThreadFixture({extraFlavor:true}));
  assert.equal(multiple.entrypoint,0x100000200n,'parser must skip unrelated flavors and find ARM_THREAD_STATE64');

  const short=parseMachO(macho64ThreadFixture({count:67}));
  assert.equal(short.entrypoint,null); assert.ok(short.warnings.some((w)=>w.includes('count-67-below-68')));

  const unmapped=parseMachO(macho64ThreadFixture({pc:0x100002000n}));
  assert.equal(unmapped.entrypoint,null); assert.equal(unmapped.metadata.threadEntrypoint.valid,false);
  assert.equal(unmapped.functions.some((f)=>f.source==='entrypoint'),false);

  const x64=parseMachO(macho64ThreadFixture({cpu:0x01000007,flavor:4,count:34,pc:0x100000200n,cpsr:0}));
  assert.equal(x64.entrypoint,0x100000200n); assert.equal(x64.metadata.threadEntrypoint.layout,'x86_THREAD_STATE64');

  const arm32=parseMachO(macho32ArmThreadFixture());
  assert.equal(arm32.entrypoint,0x1200n); assert.equal(arm32.metadata.threadEntrypoint.layout,'ARM_THREAD_STATE');
}

console.log('issues #969/#970/#971 regressions PASS');
