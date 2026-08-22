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

// Issue #1105: scanSourceStrings executable fallback
{
  const { scanSourceStrings } = await import('../js/bytesource/strings.js');
  const raw = new Uint8Array(100);
  const img = new BinaryImage(raw);
  img.addSection({ name: '.text', address: 0x1000n, size: 100n, fileOffset: 0n, fileSize: 100n, perms: { execute: true } });
  // With includeExecutable: false and all sections executable, it should NOT fallback to whole file
  const res = await scanSourceStrings(img, raw, { includeExecutable: false });
  assert.equal(res.results.length, 0);
  console.log('  ok #1105 scanSourceStrings executable fallback');
}

// Issue #1103: discovery candidate region sorting
{
  const { createFunctionCandidate } = await import('../js/analysis/discovery/candidates.js');
  const c1 = createFunctionCandidate({
    start: '0x1000',
    extentState: 'exact',
    regions: [
      { start: '0x1000', end: '0x1020', ownership: 'exclusive' },
      { start: '0x1000', end: '0x1010', ownership: 'exclusive' },
      { start: '0x1000', end: '0x1010', ownership: 'shared' },
    ],
  });
  assert.equal(c1.regions[0].end, '4112');
  assert.equal(c1.regions[0].ownership, 'exclusive');
  assert.equal(c1.regions[1].end, '4112');
  assert.equal(c1.regions[1].ownership, 'shared');
  assert.equal(c1.regions[2].end, '4128');
  console.log('  ok #1103 discovery candidate region total ordering');
}

// Issue #1101: debug record sizeBytes validation
{
  const { createDebugRecord } = await import('../js/analysis/debug/provider.js');
  assert.throws(() => {
    createDebugRecord({
      kind: 'symbol',
      entityId: 'ent1',
      providerId: 'p1',
      providerVersion: '1.0',
      sizeBytes: -5,
    });
  });
  assert.throws(() => {
    createDebugRecord({
      kind: 'symbol',
      entityId: 'ent1',
      providerId: 'p1',
      providerVersion: '1.0',
      sizeBytes: NaN,
    });
  });
  assert.throws(() => {
    createDebugRecord({
      kind: 'symbol',
      entityId: 'ent1',
      providerId: 'p1',
      providerVersion: '1.0',
      sizeBytes: Infinity,
    });
  });
  const okRec = createDebugRecord({
    kind: 'symbol',
    entityId: 'ent1',
    providerId: 'p1',
    providerVersion: '1.0',
    sizeBytes: 16,
  });
  assert.equal(okRec.sizeBytes, 16);
  console.log('  ok #1101 debug record sizeBytes validation');
}

// Issue #1099: analysis surface functionSummary cache isolation
{
  const { createAnalysisSurface } = await import('../js/analysis/index.js');
  const { buildFixture } = await import('./phase7/corpus/fixtures.mjs');
  const built = buildFixture('stack-disjoint');
  const surface = createAnalysisSurface({
    ir: built.ir,
    cfg: built.cfg,
    ssa: built.ssa,
    memorySsa: built.memorySsa,
    resolveRegion: built.resolveRegion,
  });
  const s1 = surface.functionSummary();
  const s2 = surface.functionSummary({ customOption: true });
  const s3 = surface.functionSummary();
  assert.equal(s1, s3);
  assert.notEqual(s1, s2);
  console.log('  ok #1099 analysis surface functionSummary cache isolation');
}

// Issue #1097: Phase 7 artifact descriptor requires abiId for ABI-dependent kinds
{
  const descriptorBase = {
    kind: 'phase7.types.constraint-graph',
    binaryId: 'binary_1',
    functionId: 'function_1',
    architectureId: 'arm64',
    snapshotId: 'snapshot_1',
    analyzerId: 'phase7.types.constraints',
    analyzerVersion: '1.0.0',
    semanticSchemaVersion: '2',
    cfgVersion: '2.0.0',
    ssaVersion: '2.0.0',
    memorySsaVersion: '2.0.0',
  };
  assert.throws(() => {
    createPhase7ArtifactDescriptor({ ...descriptorBase });
  });
  const valid = createPhase7ArtifactDescriptor({
    ...descriptorBase,
    abiId: 'darwin-aapcs64',
  });
  assert.ok(valid.artifactId);
  console.log('  ok #1097 Phase 7 artifact descriptor abiId requirement');
}

// Issue #1096: decodeWireValue/encodeWireValue __proto__ prototype safety
{
  const wire = JSON.parse('{"__proto__":{"polluted":true},"normal":123}');
  const decoded = decodeWireValue(wire);
  assert.equal(Object.hasOwn(decoded, '__proto__'), true);
  assert.equal(decoded.polluted, undefined);
  assert.equal(Object.getPrototypeOf(decoded), Object.prototype);
  assert.deepEqual(decoded.__proto__, { polluted: true });

  const encoded = encodeWireValue(decoded);
  assert.equal(Object.hasOwn(encoded, '__proto__'), true);
  assert.equal(encoded.polluted, undefined);
  console.log('  ok #1096 remote wire codec __proto__ prototype safety');
}

// Issue #1089: RemoteProtocolClient preserves falsy abort reason
{
  const { RemoteProtocolClient } = await import('../js/debug/remote-protocol.js');
  const client = new RemoteProtocolClient({ send: async () => {} });
  const ac = new AbortController();
  ac.abort(false);
  await assert.rejects(
    async () => client.request('test', {}, { signal: ac.signal }),
    (err) => err.code === 'cancelled' && err.message === 'false',
  );
  console.log('  ok #1089 RemoteProtocolClient preserves falsy abort reason');
}

// Issues #1086 & #1088: worker validation rejects malformed scalars
{
  const { checkedChunkIndex, regionSize } = await import('../js/platform/worker-validation.js');
  assert.throws(() => checkedChunkIndex(null), RangeError);
  assert.throws(() => checkedChunkIndex(true), RangeError);
  assert.throws(() => checkedChunkIndex(false), RangeError);
  assert.throws(() => checkedChunkIndex(''), RangeError);
  assert.throws(() => checkedChunkIndex('   '), RangeError);
  assert.equal(checkedChunkIndex(0), 0);
  assert.equal(checkedChunkIndex('0'), 0);

  assert.throws(() => regionSize(null), RangeError);
  assert.throws(() => regionSize(true), RangeError);
  assert.throws(() => regionSize(false), RangeError);
  assert.throws(() => regionSize(''), RangeError);
  assert.throws(() => regionSize('   '), RangeError);
  assert.equal(regionSize(0), 0n);
  assert.equal(regionSize('0'), 0n);
  console.log('  ok #1086 / #1088 worker validation rejects malformed scalars');
}

// Issue #1084: content identity preserves falsy abort reason
{
  const { sha256BlobHex } = await import('../js/cache/content-identity.js');
  const ac = new AbortController();
  ac.abort('');
  await assert.rejects(
    async () => sha256BlobHex(new Blob([new Uint8Array([1, 2, 3])]), { signal: ac.signal }),
    (err) => err === '',
  );
  console.log('  ok #1084 content identity preserves falsy abort reason');
}

// Issue #1082: Store.reset() allocates fresh regions array
{
  const { Store } = await import('../js/state.js');
  const store = new Store();
  store.state.regions.push({ name: 'r1' });
  store.reset();
  assert.equal(store.state.regions.length, 0);
  store.state.regions.push({ name: 'r2' });
  const store2 = new Store();
  assert.equal(store2.state.regions.length, 0);
  console.log('  ok #1082 Store.reset() allocates fresh regions array');
}

// Issue #1080: LRU.get() refreshes undefined-valued entries
{
  const { LRU } = await import('../js/lru.js');
  const lru = new LRU(2);
  lru.set('a', undefined);
  lru.set('b', 2);
  assert.equal(lru.get('a'), undefined); // should refresh 'a'
  lru.set('c', 3); // should evict 'b', NOT 'a'!
  assert.equal(lru.has('a'), true);
  assert.equal(lru.has('b'), false);
  assert.equal(lru.has('c'), true);
  console.log('  ok #1080 LRU.get() refreshes undefined-valued entries');
}

// Issue #1079: base64ToBytes rejects non-canonical base64 padding
{
  const { decodeWireValue, WIRE_TAG } = await import('../js/debug/remote-protocol.js');
  // 'YQ==' is canonical for 'a', 'YQ=' has non-canonical padding
  assert.throws(() => {
    decodeWireValue({ [WIRE_TAG]: 'bytes-base64', value: 'YQ=', length: 1 });
  });
  const decoded = decodeWireValue({ [WIRE_TAG]: 'bytes-base64', value: 'YQ==', length: 1 });
  assert.equal(decoded.length, 1);
  assert.equal(decoded[0], 0x61);
  console.log('  ok #1079 base64ToBytes rejects non-canonical base64 padding');
}

// Issue #1078: pageRows does not relabel mismatched adapter page offset
{
  const { pageRows } = await import('../js/agent/tools.js');
  const mismatched = { results: ['row0'], offset: 0, total: 100 };
  const paged = pageRows(mismatched, 10, 50);
  assert.equal(paged.offset, 50);
  assert.equal(paged.returned, 0);
  assert.deepEqual(paged.results, []);
  console.log('  ok #1078 pageRows does not relabel mismatched adapter page');
}

// Issue #1077: compactFact preserves falsy values
{
  const { compactFact } = await import('../js/agent/tools.js');
  const fZero = compactFact({ id: 'f1', kind: 'constant', value: 0, evidence: [] });
  assert.equal(fZero.value, 0);
  const fFalse = compactFact({ id: 'f2', kind: 'constant', value: false, evidence: [] });
  assert.equal(fFalse.value, false);
  const fEmpty = compactFact({ id: 'f3', kind: 'constant', value: '', evidence: [] });
  assert.equal(fEmpty.value, '');
  const fNull = compactFact({ id: 'f4', kind: 'constant', value: null, evidence: [] });
  assert.equal(fNull.value, null);
  console.log('  ok #1077 compactFact preserves falsy values');
}

// Issue #1074: HypothesisStore avoids generated hypothesis ID collisions
{
  const { HypothesisStore } = await import('../js/ai/hypothesis.js');
  const store = new HypothesisStore();
  store.upsert({ id: 'hyp_1', claim: 'restored' });
  const auto1 = store.upsert({ claim: 'auto1' });
  const auto2 = store.upsert({ claim: 'auto2' });
  assert.notEqual(auto1.id, 'hyp_1');
  assert.notEqual(auto2.id, 'hyp_1');
  assert.equal(store.records.get('hyp_1').claim, 'restored');
  console.log('  ok #1074 HypothesisStore avoids generated hypothesis ID collisions');
}

// Issues #1071 & #1073: AI quota rejects duplicate lease token & normalizes windowMs
{
  const { acquireQuotaState } = await import('../js/ai/quota.js');
  const raw = { windowStarted: Date.now(), count: 0, sessions: {}, leases: {} };
  const r1 = acquireQuotaState(raw, { token: 'tok_1', sessionId: 's1' });
  assert.equal(r1.result.allowed, true);
  // Reacquiring with same active token is denied for concurrency
  const r2 = acquireQuotaState(r1.state, { token: 'tok_1', sessionId: 's1' });
  assert.equal(r2.result.allowed, false);
  assert.equal(r2.result.reason, 'concurrency');

  // Rate limit retryAfterMs with non-standard config
  const fullState = { windowStarted: Date.now(), count: 100, sessions: {}, leases: {} };
  const r3 = acquireQuotaState(fullState, { token: 'tok_2', sessionId: 's2' }, { ipRateLimit: 10, windowMs: 60000 });
  assert.equal(r3.result.allowed, false);
  assert.equal(r3.result.reason, 'rate');
  assert.ok(r3.result.retryAfterMs > 0 && r3.result.retryAfterMs <= 60000);
  console.log('  ok #1071 / #1073 AI quota duplicate token rejection and retryAfterMs');
}

// Issue #1066: ArchitectureAdapter bounds checks for fixed-size instructions
{
  const { ArchitectureAdapter } = await import('../js/architecture/index.js');
  const adapter = new ArchitectureAdapter({
    id: 'test-arch',
    name: 'Test Arch',
    fixedInstructionSize: 4,
    instructionAlignment: 4,
  });
  const region = { vmAddr: 0x1000n, size: 6n };
  // rowForAddress
  assert.equal(adapter.rowForAddress(region, 0x1000n), 0);
  assert.equal(adapter.rowForAddress(region, 0x1004n), null); // 4 + 4 = 8 > 6

  // addressForRow
  assert.equal(adapter.addressForRow(region, 0), 0x1000n);
  assert.equal(adapter.addressForRow(region, 1), null); // 0x1004 + 4 > 0x1006

  // validateInstructionPlacement
  const p1 = adapter.validateInstructionPlacement(region, 0x1000n, 4);
  assert.equal(p1.ok, true);
  const p2 = adapter.validateInstructionPlacement(region, 0x1004n, 4);
  assert.equal(p2.ok, false);
  assert.equal(p2.code, 'patch-range');
  console.log('  ok #1066 ArchitectureAdapter fixedInstructionSize region boundary check');
}

// Issues #1299 / #1302 live in their own file because they need a wide
// value-kind matrix and a large sweep. Imported here rather than registered in
// package.json, so an AI-subsystem fix does not drag every phase release
// validator into its ownership lane through the shared trigger path (EP-007).
await import('./ai-identity-collisions.mjs');

console.log('\nAll integrated issue tests PASS!');

