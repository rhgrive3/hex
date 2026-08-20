import assert from 'node:assert/strict';
import { createInterventionRecord } from '../js/runtime/evidence-bridge.js';
import { RuntimeEventNormalizer, createRuntimeEvent } from '../js/runtime/events.js';
import { DebugSession } from '../js/runtime/session.js';
import { MemoryRegion } from '../js/runtime/memory.js';
import { encodeWireValue, decodeWireValue, WIRE_TAG } from '../js/debug/remote-protocol.js';
import { TraceRingBuffer } from '../js/trace/ring-buffer.js';
import { BinaryImage } from '../js/binary/model.js';
import { auditBinary } from '../js/binary/audit.js';
import { recognizeObjcBlockLiteral } from '../js/apple/objc-runtime.js';
import { resolveObjcIMP } from '../js/apple/runtime.js';
import { liftCilMethod } from '../js/managed/cil/lifter.js';
import { liftJvmMethod } from '../js/managed/jvm/lifter.js';
import { liftDexMethod } from '../js/managed/dex/lifter.js';
import { extraApiInfo } from '../js/api-cross-binary-families.js';
import { createPhase7ArtifactDescriptor } from '../js/analysis/artifact-identity.js';

console.log('Testing integrated PRs and issue fixes...');

// Issue #1057: Intervention sequence numbers reject NaN/Infinity/negative
{
  const valid = createInterventionRecord({
    runtimeSessionId: 'sess1',
    providerId: 'prov1',
    kind: 'breakpoint',
    sequence: 5,
  });
  assert.equal(valid.sequence, 5);

  assert.throws(() => {
    createInterventionRecord({
      runtimeSessionId: 'sess1',
      providerId: 'prov1',
      kind: 'breakpoint',
      sequence: NaN,
    });
  });

  assert.throws(() => {
    createInterventionRecord({
      runtimeSessionId: 'sess1',
      providerId: 'prov1',
      kind: 'breakpoint',
      sequence: Infinity,
    });
  });

  assert.throws(() => {
    createInterventionRecord({
      runtimeSessionId: 'sess1',
      providerId: 'prov1',
      kind: 'breakpoint',
      sequence: -1,
    });
  });
  console.log('  ok #1057 intervention sequence validation');
}

// Issue #1055: RuntimeEventNormalizer capacity drops
{
  const normalizer = new RuntimeEventNormalizer({ runtimeSessionId: 's1', providerId: 'p1', sessionEpoch: 1 }, { maxEvents: 1 });
  const e1 = normalizer.push({ kind: 'trace-marker', streamId: 'st1', sequence: 1 });
  assert.ok(e1);
  const e2 = normalizer.push({ kind: 'trace-marker', streamId: 'st1', sequence: 2 });
  assert.equal(e2, null); // dropped due to capacity

  // flush queue
  const batch = normalizer.flush();
  assert.equal(batch.dropped, 1);

  // retry e2: should now succeed because it wasn't permanently marked seen when dropped
  const e2retry = normalizer.push({ kind: 'trace-marker', streamId: 'st1', sequence: 2 });
  assert.ok(e2retry);
  console.log('  ok #1055 RuntimeEventNormalizer capacity drops retryable');
}

// Issue #1053: DebugSession preserves remote event payload
{
  const mockAdapter = {
    kind: 'mock',
    id: 'mock-1',
    capabilities: {},
    connect: async () => {},
    disconnect: async () => {},
  };
  const session = new DebugSession(mockAdapter);
  session.acceptEvent({
    version: 1,
    type: 'event',
    epoch: 1,
    event: 'breakpoint-hit',
    data: { address: '0x1234', threadId: 7 },
  });

  const events = session.traces.snapshot().events;
  assert.equal(events.length, 1);
  assert.equal(events[0].event, 'breakpoint-hit');
  assert.deepEqual(events[0].data, { address: '0x1234', threadId: 7 });
  console.log('  ok #1053 DebugSession preserves remote event payload');
}

// Issue #1051: empty memory permissions preserved as explicit
{
  const entry = new MemoryRegion({
    start: 0x1000n,
    size: 0x100,
    permissions: '',
  });
  assert.deepEqual(entry.permissions, { read: false, write: false, execute: false });
  console.log('  ok #1051 empty memory permissions');
}

// Issue #1050: remote wire codec rejects reserved WIRE_TAG in plain objects
{
  assert.throws(() => {
    encodeWireValue({ [WIRE_TAG]: 'bigint', value: '42' });
  });
  assert.throws(() => {
    encodeWireValue({ nested: { [WIRE_TAG]: 'bytes-base64', value: 'AQ==', length: 1 } });
  });
  console.log('  ok #1050 remote wire codec rejects reserved tag');
}

// Issue #1048: trace ring buffer handles circular references safely
{
  const ring = new TraceRingBuffer({ maxBytes: 1024 * 1024 });
  const cyclic = { name: 'cyclic' };
  cyclic.self = cyclic;
  const pushed = ring.push(cyclic);
  assert.equal(pushed, true);
  console.log('  ok #1048 trace ring buffer circular reference safety');
}

// Issue #1046: BinaryImage addressToOffset / offsetToAddress with zero-fill child
{
  const image = new BinaryImage(new Uint8Array(8));
  image.addSegment({
    name: 'parent', address: 0x1000n, size: 8n,
    fileOffset: 0n, fileSize: 8n,
  });
  image.addSection({
    name: 'zerofill-child', address: 0x1004n, size: 4n,
    fileOffset: 0n, fileSize: 0n,
  });

  assert.equal(image.resolveVirtualMapping(0x1004n).kind, 'zero');
  assert.equal(image.addressToOffset(0x1004n), null);
  assert.equal(image.offsetToAddress(4n), null);
  assert.equal(image.addressToOffset(0x1000n), 0n);
  assert.equal(image.offsetToAddress(0n), 0x1000n);
  console.log('  ok #1046 BinaryImage zero-fill child mapping consistency');
}

// Issue #1044: auditBinary ignores unproven zero entrypoint sentinel
{
  const img = new BinaryImage(new Uint8Array(16));
  img.entrypoint = 0n;
  img.metadata = { entrypointZeroEvidence: 'zero-sentinel-unproven' };
  const audit = auditBinary(img);
  assert.ok(!audit.issues.some((i) => i.id === 'entrypoint-not-executable'));
  console.log('  ok #1044 auditBinary unproven zero entrypoint sentinel');
}

// Issue #1042: recognizeObjcBlockLiteral supports pointerSize 4
{
  const fields32 = new Map([
    [0, 0x1000],  // isa
    [4, 0],       // flags
    [12, 0x5000], // invoke at 4 + 8 = 12
    [16, 0x6000], // descriptor at 12 + 4 = 16
    [20, 0x7000], // capture 1 at 16 + 4 = 20
  ]);
  const block32 = recognizeObjcBlockLiteral(fields32, { pointerSize: 4 });
  assert.ok(block32);
  assert.equal(block32.invoke, 0x5000);
  assert.equal(block32.descriptor, 0x6000);
  assert.equal(block32.captures.length, 1);
  assert.equal(block32.captures[0].offset, 20);
  console.log('  ok #1042 recognizeObjcBlockLiteral 32-bit pointerSize');
}

// Issue #1036: Phase 7 artifact presentation guard rejects forbidden fields in arrays
{
  assert.throws(() => {
    createPhase7ArtifactDescriptor({
      schema: 'hex.analysis.callgraph',
      binaryId: 'bin1',
      config: {
        options: [{ fileName: 'test.bin' }],
      },
    });
  });
  console.log('  ok #1036 Phase 7 artifact presentation guard array traversal');
}

// Issue #1034: resolveObjcIMP rejects contradictory selector/receiverType
{
  const objcIndex = {
    methodsByIMP: new Map([
      ['4096', [
        { className: 'MyClass', selector: 'foo' },
        { className: 'OtherClass', selector: 'bar' },
      ]],
    ]),
    classes: new Map([['MyClass', { superName: null }], ['OtherClass', { superName: null }]]),
  };
  const resolved = resolveObjcIMP(objcIndex, 4096, { selector: 'baz' });
  assert.equal(resolved.candidates.length, 0);
  assert.equal(resolved.resolved, null);
  console.log('  ok #1034 resolveObjcIMP contradictory metadata rejection');
}

// Issue #1032, #1029: CIL lifter origin ranges and comparison branches
{
  // bytecode: ldc.i4.s 127 (1f 7f), ret (2a)
  const cilImage = {
    moduleId: 'mod1',
    vmSpecEdition: 'cil-v4',
    methodBodies: [{
      headerOffset: 100,
      maxStack: 8,
      isTiny: true,
      bytecode: Uint8Array.from([0x1f, 0x7f, 0x2a]),
    }],
  };
  const fn = liftCilMethod(0, cilImage);
  assert.equal(fn.bundles.length, 2);
  const ldc = fn.bundles[0];
  assert.equal(ldc.mnemonic, 'ldc.i4.s');
  assert.equal(ldc.producedValues[0].constant, 127);
  assert.deepEqual(ldc.origin.byteRanges, [{ start: '100', end: '102' }]); // covers both opcode and immediate byte!

  // test comparison branch: ldc.i4.0 (16), ldc.i4.1 (17), bge.un.s +0 (34 00), ret (2a)
  const cilBranch = {
    moduleId: 'mod1',
    vmSpecEdition: 'cil-v4',
    methodBodies: [{
      headerOffset: 200,
      maxStack: 8,
      isTiny: true,
      bytecode: Uint8Array.from([0x16, 0x17, 0x34, 0x00, 0x2a]),
    }],
  };
  const fnBranch = liftCilMethod(0, cilBranch);
  const bge = fnBranch.bundles[2];
  assert.equal(bge.mnemonic, 'bge.un.s');
  assert.equal(bge.consumedValues.length, 2);
  assert.deepEqual(bge.origin.byteRanges, [{ start: '202', end: '204' }]);
  console.log('  ok #1032 / #1029 CIL lifter origin ranges & comparison branches');
}

// Issue #1031: JVM lifter origin ranges cover operands
{
  // bipush 127 (10 7f), return (b1)
  const jvmClass = {
    moduleId: 'mod1',
    vmSpecEdition: 'jvm-8',
    thisClassName: 'Test',
    methods: [{
      name: 'foo',
      descriptor: '()V',
      accessFlags: 1,
      code: {
        offset: 50,
        maxStack: 4,
        maxLocals: 2,
        bytecode: Uint8Array.from([0x10, 0x7f, 0xb1]),
      },
    }],
  };
  const fn = liftJvmMethod(0, jvmClass);
  const bipush = fn.bundles[0];
  assert.equal(bipush.mnemonic, 'bipush');
  assert.equal(bipush.producedValues[0].constant, 127);
  assert.deepEqual(bipush.origin.byteRanges, [{ start: '50', end: '52' }]); // covers opcode and immediate!
  console.log('  ok #1031 JVM lifter origin ranges');
}

// Issue #1030: DEX lifter origin ranges cover multi-unit instructions
{
  // const/16 v0, #0x1234 -> format 21s, 2 code units = 4 bytes: [13, 00, 34, 12]
  // return-void -> 1 code unit = 2 bytes: [0e, 00]
  const raw = new Uint8Array(100);
  const view = new DataView(raw.buffer);
  const codeOff = 16;
  view.setUint16(codeOff, 2, true);     // registersSize
  view.setUint16(codeOff + 2, 0, true); // insSize
  view.setUint16(codeOff + 4, 0, true); // outsSize
  view.setUint16(codeOff + 6, 0, true); // triesSize
  view.setUint32(codeOff + 8, 0, true); // debugInfoOff
  view.setUint32(codeOff + 12, 3, true); // insnsSize (3 code units = 6 bytes)
  // insns: const/16 (opcode 0x13, reg 0), imm 0x1234
  raw[codeOff + 16] = 0x13;
  raw[codeOff + 17] = 0x00;
  raw[codeOff + 18] = 0x34;
  raw[codeOff + 19] = 0x12;
  // return-void (opcode 0x0e)
  raw[codeOff + 20] = 0x0e;
  raw[codeOff + 21] = 0x00;

  const dexImage = {
    moduleId: 'dex1',
    vmSpecEdition: 'dex-039',
    rawBytes: raw,
    methods: [{ name: 'test', classType: 'LTest;' }],
    classes: [{
      directMethods: [{ methodIdx: 0, codeOff, accessFlags: 1 }],
      virtualMethods: [],
    }],
  };
  const fn = liftDexMethod(0, dexImage);
  const const16 = fn.bundles[0];
  assert.equal(const16.mnemonic, 'const/16');
  assert.deepEqual(const16.origin.byteRanges, [{ start: String(codeOff + 16), end: String(codeOff + 20) }]); // 4 bytes!
  console.log('  ok #1030 DEX lifter origin ranges');
}

// Issues #1022 & #1021: extraApiInfo div_t return and modf write effect
{
  const divInfo = extraApiInfo('div');
  assert.ok(divInfo);
  assert.equal(divInfo.id, 'libc_div');
  assert.equal(divInfo.ret, 'div_t');

  const modfInfo = extraApiInfo('modf');
  assert.ok(modfInfo);
  assert.equal(modfInfo.id, 'libm_modf');
  assert.equal(modfInfo.effect, 'write');

  const coshInfo = extraApiInfo('cosh');
  assert.ok(coshInfo);
  assert.equal(coshInfo.id, 'libm');
  assert.equal(coshInfo.ret, 'number');
  assert.equal(coshInfo.effect, 'read');
  console.log('  ok #1022 / #1021 extraApiInfo div_t and modf write effect');
}

console.log('\nAll integrated issue tests PASS!');
