import assert from 'node:assert/strict';
import { TraceRingBuffer } from '../js/trace/ring-buffer.js';
import { objcPropertyHelperAbi } from '../js/dataflow-semantic.js';
import { buildObjcRuntimeIndex, resolveObjcDispatch } from '../js/apple/objc-runtime.js';
import { callsFromTrace } from '../js/adapters/index.js';
import { createHexProject, serializeHexProject, importHexProject, MAX_PROJECT_BYTES } from '../js/project/index.js';
import { groupByFeature } from '../js/features.js';
import { cfgGraph } from '../js/graphview.js';
import { vendorConflicts } from '../js/vendors.js';

let passed = 0;
async function test(name, fn) { try { await fn(); passed++; console.log('ok', name); } catch (error) { console.error('not ok', name); throw error; } }

await test('trace snapshots nested mutable values at push time and on readback', () => {
  const ring = new TraceRingBuffer({ maxBytes: 65536, maxEvents: 16 });
  const source = { type:'instruction', nested:{ rows:[1,2], bytes:new Uint8Array([3,4]) } };
  assert.equal(ring.push(source), true);
  const accounted = ring.bytes;
  source.nested.rows[0] = 99; source.nested.bytes[0] = 88; source.nested.extra = 'mutated';
  const snap1 = ring.snapshot();
  assert.deepEqual(snap1.events[0].nested.rows, [1,2]);
  assert.deepEqual(Array.from(snap1.events[0].nested.bytes), [3,4]);
  assert.equal(snap1.events[0].nested.extra, undefined);
  snap1.events[0].nested.rows[1] = 77;
  assert.deepEqual(ring.snapshot().events[0].nested.rows, [1,2]);
  assert.equal(ring.bytes, accounted);
});

await test('ObjC property helper ABI uses x2 offset and x3 setter value', () => {
  assert.deepEqual(objcPropertyHelperAbi('objc_getProperty'), { kind:'read', offsetReg:'x2', valueReg:'x0' });
  assert.deepEqual(objcPropertyHelperAbi('objc_setProperty'), { kind:'write', offsetReg:'x2', valueReg:'x3' });
});

await test('typed ObjC dispatch never falls back to an unrelated global selector target', () => {
  const index = buildObjcRuntimeIndex({ classes:[
    { name:'Base', superName:null, methods:[] },
    { name:'Child', superName:'Base', methods:[] },
    { name:'Other', superName:null, methods:[{ sel:'onlyThere', kind:'-', addr:0x5000n }] },
  ] });
  const miss = resolveObjcDispatch(index, { receiverType:'Child *', selector:'onlyThere' });
  assert.equal(miss.resolved, null); assert.equal(miss.candidates.length, 0);
  const unknown = resolveObjcDispatch(index, { receiverType:'Missing *', selector:'onlyThere' });
  assert.equal(unknown.resolved, null); assert.equal(unknown.candidates.length, 0);
});

await test('runtime trace retains concrete indirect call target', () => {
  const target = 0x12345678n;
  const rows = callsFromTrace([{ addr:0x1000n, text:'blr x8', callTarget:target, callIndirect:true }]);
  assert.equal(rows.length, 1); assert.equal(rows[0].target, target); assert.equal(rows[0].indirect, true);
  const source = { addr:0x1000n, text:'blr x8', callTarget:target, callIndirect:true };
  const copied = callsFromTrace([source]); source.callTarget = 1n;
  assert.equal(copied[0].target, target);
});

await test('project serialization refuses payloads above the 16 MiB byte limit', () => {
  const p = createHexProject({ analysisSettings:{ payload:'x'.repeat(MAX_PROJECT_BYTES) } });
  assert.throws(() => serializeHexProject(p), (error) => error?.code === 'HEX_PROJECT_TOO_LARGE');
});

await test('oversized project Blob is rejected before Blob.text materializes it', async () => {
  const blob = new Blob([new Uint8Array(MAX_PROJECT_BYTES + 1)]);
  let textCalled = false;
  blob.text = async () => { textCalled = true; return '{}'; };
  await assert.rejects(() => importHexProject(blob), (error) => error?.code === 'HEX_PROJECT_TOO_LARGE');
  assert.equal(textCalled, false);
});

await test('feature cap keeps strongest late evidence instead of first K discoveries', () => {
  const rows = [
    { addr:1n, text:'damage ' + 'x'.repeat(180) },
    { addr:2n, text:'enemy_tag' },
    { addr:3n, text:'ボスへのクリティカルダメージ' },
  ];
  const battle = groupByFeature(rows, 2).find((g) => g.id === 'battle');
  assert.equal(battle.items.length, 2);
  assert.ok(battle.items.some((x) => x.addr === 3n));
  assert.equal(battle.items.some((x) => x.addr === 1n), false);
});

await test('CFG edge to a lower numbered block is not called back-edge without a cycle', () => {
  const ins = [
    { row:0, address:0x1000n, mnemonic:'b', operands:'0x1020', branchTarget:0x1020n },
    { row:4, address:0x1010n, mnemonic:'ret', operands:'', isReturn:true },
    { row:8, address:0x1020n, mnemonic:'b', operands:'0x1010', branchTarget:0x1010n },
  ];
  const blocks = [
    { index:0, startRow:0, endRow:0, rows:[0] },
    { index:1, startRow:4, endRow:4, rows:[4] },
    { index:2, startRow:8, endRow:8, rows:[8] },
  ];
  const rowOfAddress = (a) => a === 0x1020n ? 8 : a === 0x1010n ? 4 : null;
  const g = cfgGraph({ instructions:ins, basicBlocks:blocks }, { rowOfAddress });
  const e = g.edges.find((x) => x.from === 2 && x.to === 1);
  assert.ok(e); assert.equal(e.kind, 'jump');
});

await test('low-confidence prefix cluster is not a hard vendor conflict', () => {
  assert.equal(vendorConflicts('hp', { vendor:'MyOwnPrefix', confidence:'low', via:'cluster' }), false);
  assert.equal(vendorConflicts('hp', { vendor:'KnownSDK', confidence:'high', via:'class' }), true);
});

console.log(`issue-322-plus: ${passed} tests passed`);
