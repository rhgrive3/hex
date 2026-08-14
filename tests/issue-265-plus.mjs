import assert from 'node:assert/strict';
import { analyzeFunctionCached, analyzeFunction } from '../js/analyze.js';
import { Backend } from '../js/backend.js';
import { memoizeAnalysis, notableFunctions, findings } from '../js/auto.js';
import { rankCandidates } from '../js/rank.js';
import { FieldIndex } from '../js/fields.js';
import { pinpointField } from '../js/pinpoint.js';
import { goalFromPreset } from '../js/goals.js';
import { verifyAccessor, fieldUse } from '../js/verify.js';
import { NoteStore } from '../js/names.js';
import { decodeSchema } from '../js/schema.js';
import { foldShapes, resources } from '../js/shapes.js';
import { ProgramIndex } from '../js/program.js';

let passed = 0;
async function test(name, fn) { try { await fn(); passed++; console.log('ok', name); } catch (e) { console.error('not ok', name); throw e; } }
const emptySymbols = { gen: 1, nameAt: () => null, label: () => null };
function chunk(mn, ops) { return { rows: mn.length, bytes: new Uint8Array(mn.length * 4), mn, ops }; }

await test('analyze cache distinguishes same start with different end rows', async () => {
  let calls = 0;
  const backend = { async fetchChunk() { calls++; return chunk(['nop','nop','nop'], ['', '', '']); }, readAt: async () => null };
  const region = { id: 'cache-end-fixture', vmAddr: 0x1000n, size: 0x100n };
  await analyzeFunctionCached(backend, region, 0, 0, emptySymbols, null, { texts: false });
  await analyzeFunctionCached(backend, region, 0, 1, emptySymbols, null, { texts: false });
  assert.equal(calls, 2);
});

await test('ADRP provenance is killed when destination register is overwritten', async () => {
  const backend = { async fetchChunk() { return chunk(['adrp','mov','add','ret'], ['x8, 0x100000000', 'x8, x0', 'x9, x8, #0x40', '']); } };
  const region = { id: 'adrp-kill-fixture', vmAddr: 0x100000000n, size: 0x100n };
  const res = await analyzeFunction(backend, region, 0, 3, emptySymbols);
  assert.equal(res.addressRefs.some((r) => r.addr === 0x100000040n), false);
});

await test('dispatched bytes-only chunk upgrade finishes with assembly', async () => {
  const b = Object.create(Backend.prototype);
  b.analysisEpoch = 1; b.cache = new Map(); b.inflight = new Map(); b.queue = []; b.onChunk = null;
  let firstResolve; let calls = [];
  b.call = (_t, payload) => {
    calls.push(payload.wantAsm);
    if (calls.length === 1) return new Promise((resolve) => { firstResolve = resolve; });
    return Promise.resolve({ bytes: new Uint8Array([1,2,3,4]), rows: 1, mn: 'mov', ops: 'x0, x0' });
  };
  b.request('r', 0, false);
  b.request('r', 0, true);
  firstResolve({ bytes: new Uint8Array([1,2,3,4]), rows: 1, mn: '', ops: '' });
  for (let i = 0; i < 20 && b.inflight.size; i++) await new Promise((r) => setTimeout(r, 0));
  const got = b.cache.get(b.key('r', 0));
  assert.deepEqual(calls, [false, true]);
  assert.deepEqual(got.mn, ['mov']);
});

await test('failed analysis is diagnostic/retryable and not memoized as null', async () => {
  let tries = 0; const errors = [];
  const memo = memoizeAnalysis(async () => { if (++tries === 1) throw Object.assign(new Error('temporary'), { transient: true }); return { ok: true }; }, (e) => errors.push(e));
  await assert.rejects(() => memo(1n, 2n), /temporary/);
  assert.deepEqual(await memo(1n, 2n), { ok: true });
  assert.equal(tries, 2); assert.equal(errors.length, 1);
});

await test('notableFunctions scores functions beyond the former 20k prefix', () => {
  const funcs = new BigUint64Array(20002);
  for (let i = 0; i < funcs.length; i++) funcs[i] = BigInt(0x1000 + i * 4);
  const target = funcs[20001];
  const symbols = { functionCount: funcs.length, funcs, nameAt: (a) => a === target ? 'target' : null };
  const program = {
    functionRange: (a) => ({ start: a, end: a + 4n }),
    statsOf: (a) => a === target ? { total: 10, numeric: 4, store: 2, load: 2, cmp: 2, mul: 4, div: 0, fmul: 0 } : { total: 1, numeric: 0, store: 0, load: 0, cmp: 0 },
    callCountOf: (a) => a === target ? 5 : 0,
  };
  const list = notableFunctions(program, symbols, { vmAddr: funcs[0], size: BigInt(funcs.length * 4) }, 4);
  assert.equal(list[0].addr, target);
});

await test('findings require an actual referencing function', () => {
  const program = { functionsReferencing: () => [] };
  assert.deepEqual(findings([{ addr: 1n, text: 'https://example.com/api' }], program, { nameAt: () => null }), []);
});

await test('rank does not scan later calls when seed function end is unknown', () => {
  let called = false;
  const goal = goalFromPreset('hp');
  const program = { callCount: 1, refCount: 0, functionRange: () => null, calleesOf: () => { called = true; return []; }, callersOf: () => [], statsOf: () => ({ total: 1 }), callCountOf: () => 0 };
  const symbols = { symbolCount: 1, functionCount: 1, addrs: new BigUint64Array([0x1000n]), names: ['hp'], nameAt: () => 'hp', isFunctionStart: () => true };
  rankCandidates({ goal, strings: [], program, symbols, region: { vmAddr: 0x1000n, size: 0x100n } });
  assert.equal(called, false);
});

await test('shared ObjC IMP stays ambiguous instead of last-owner-wins', () => {
  const fields = new FieldIndex({ classes: [
    { name: 'A', ivars: [], methods: [{ addr: 0x1000n, sel: 'foo', kind: '-' }] },
    { name: 'B', ivars: [], methods: [{ addr: 0x1000n, sel: 'bar', kind: '-' }] },
  ] });
  const owner = fields.ownerOf(0x1000n);
  assert.equal(owner.ambiguous, true); assert.equal(owner.owners.length, 2); assert.equal(owner.className, null);
});

await test('cyclic superclass graph cannot recurse forever', () => {
  const fields = new FieldIndex({ classes: [
    { name: 'A', superName: 'B', instanceSize: 16, ivars: [] },
    { name: 'B', superName: 'A', instanceSize: 16, ivars: [] },
  ] });
  assert.equal(fields.fieldAt('A', 0), null);
});

await test('pinpoint keeps narrowed prior stable across an empty verification pass', async () => {
  const model = { classes: [{ name: 'BattleManager', ivars: [
    { name: '_hp', offset: 0x20, size: 4, type: { kind: 'int', bytes: 4 } },
    { name: '_other', offset: 0x24, size: 4, type: { kind: 'int', bytes: 4 } },
  ], methods: [] }] };
  const fields = new FieldIndex(model);
  const goal = goalFromPreset('hp');
  const common = { goal, fields, map: { classes: [{ name: 'BattleManager', category: 'battle' }] }, strings: [], program: null, symbols: null, budget: { left: 50 } };
  const base = await pinpointField(common);
  const verified = await pinpointField({ ...common, budget: { left: 50 }, analyze: async () => ({ instructions: [], basicBlocks: [], calls: [] }) });
  if (base.top && verified.top && base.top.key === verified.top.key) assert.ok(verified.top.fusion.probability >= base.top.fusion.probability - 1e-12);
});

await test('setter argument proof uses self identity at the store row', () => {
  const model = { instructions: [
    { row: 0, mnemonic: 'mov', ops: [], reads: ['x0'], writes: ['x19'] },
    { row: 1, mnemonic: 'mov', ops: [], reads: ['x1'], writes: ['x19'] },
    { row: 2, mnemonic: 'str', ops: [{ k: 'reg', name: 'w2' }], reads: ['w2','x19'], writes: [], memory: { base: 'x19', disp: 0x20n, kind: 'store', size: 4 } },
  ], basicBlocks: [{ index: 0, rows: [0,1,2] }] };
  const out = verifyAccessor(model, { offset: 0x20n });
  assert.equal(out.setter, false);
});

await test('field compare evidence cannot jump into another basic block', () => {
  const model = { instructions: [
    { row: 0, mnemonic: 'ldr', ops: [{ k: 'reg', name: 'w8' }], reads: ['x0'], writes: ['w8'], memory: { base: 'x0', disp: 0x20n, kind: 'load', size: 4 } },
    { row: 1, mnemonic: 'b.eq', ops: [], reads: [], writes: [] },
    { row: 3, mnemonic: 'cmp', ops: [{ k: 'reg', name: 'w8' }, { k: 'imm', value: 10n }], reads: ['w8'], writes: [] },
  ], basicBlocks: [{ index: 0, rows: [0,1] }, { index: 1, rows: [3] }] };
  assert.equal(fieldUse(model, 0x20n).compares.length, 0);
});

await test('note mutation rolls back when localStorage persistence fails', () => {
  const old = globalThis.localStorage;
  globalThis.localStorage = { getItem: () => null, setItem: () => { throw new Error('quota'); }, removeItem: () => {} };
  try {
    const notes = new NoteStore('fixture');
    assert.equal(notes.setName(0x1000n, 'foo'), false);
    assert.equal(notes.nameOf(0x1000n), null);
  } finally { globalThis.localStorage = old; }
});

await test('note import rejects another binary identity', () => {
  const old = globalThis.localStorage;
  globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
  try {
    const notes = new NoteStore('binary-A');
    assert.throws(() => notes.fromJSON(JSON.stringify({ id: 'binary-B', names: { '4096': 'bad' } })), /notes-binary-mismatch/);
    assert.equal(notes.nameOf(4096n), null);
  } finally { globalThis.localStorage = old; }
});

await test('schema call-return proof is killed by an x0 overwrite before store', () => {
  const BL = 0x94000000, MOV_W0_1 = 0x52800020;
  const STR0 = 0xb9000020, STR4 = 0xb9000420, STR8 = 0xb9000820;
  const words = Uint32Array.from([BL, MOV_W0_1, STR0, BL, STR4, BL, STR8]);
  assert.equal(decodeSchema(words, 0x1000n), null);
});

await test('shape folding does not merge same displacement across object identities', () => {
  const scan = { count: 2, capped: false, disp: Int32Array.from([32,32]), size: Uint8Array.from([4,4]), flags: Uint8Array.from([1,2]), amtKind: Uint8Array.from([0,0]), amtDisp: Int32Array.from([0,0]), addr: new BigUint64Array([1n,2n]), span: Int32Array.from([128,128]), objectId: Uint32Array.from([11,22]), amtObjectId: Uint32Array.from([0,0]) };
  const folded = foldShapes(scan);
  assert.equal(folded.size, 2);
  assert.deepEqual(new Set(Array.from(folded.values()).map((x) => x.objectId)), new Set([11,22]));
});

await test('capped shape scan remains explicitly incomplete downstream', () => {
  const scan = { count: 1, capped: true, disp: Int32Array.from([32]), size: Uint8Array.from([4]), flags: Uint8Array.from([1]), amtKind: Uint8Array.from([0]), amtDisp: Int32Array.from([0]), addr: new BigUint64Array([1n]), span: Int32Array.from([128]) };
  const folded = foldShapes(scan);
  assert.equal(folded.complete, false); assert.equal(folded.capped, true);
  assert.equal(Array.from(folded.values())[0].complete, false);
  for (const row of resources(folded)) assert.equal(row.complete, false);
});

await test('ProgramIndex query arrays expose capped source completeness', () => {
  const p = new ProgramIndex({ vmAddr: 0x1000n, refsCapped: true, callsCapped: true }, null, null);
  const refs = p.refSitesTo(0x2000n);
  const calls = p.callSitesTo(0x2000n);
  assert.equal(refs.complete, false); assert.equal(refs.capped, true); assert.equal(refs.source, 'refs');
  assert.equal(calls.complete, false); assert.equal(calls.capped, true); assert.equal(calls.source, 'calls');
  assert.deepEqual(p.queryCompleteness, { calls: false, refs: false, stats: true });
});

console.log(`issue-265-plus: ${passed} tests passed`);
