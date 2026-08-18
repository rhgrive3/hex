import assert from 'node:assert/strict';
import { BASIC_TYPES, inferTypes, typeFromAccess, widthOfRegisterName } from '../js/types.js';
import { verifyAccessor } from '../js/verify.js';

const reg = (text, num = Number(String(text).replace(/\D/g, '') || 0)) => ({ k: 'reg', text, num });
const gp = (text) => ({ k: 'reg', cls: 'gp', text, num: Number(String(text).replace(/\D/g, '') || 0), bits: text.startsWith('w') ? 32 : 64 });
const insn = (row, mnemonic, options = {}) => ({
  row, mnemonic, ops: options.ops || [], reads: options.reads || [], writes: options.writes || [],
  memory: options.memory || null, isCall: !!options.isCall, callTarget: options.callTarget ?? null,
  category: options.category || null,
});
const model = (instructions, argRegs = []) => ({ instructions, argRegs, calls: [], facts: {} });
const argType = (result, index) => result.args.find((a) => a.index === index)?.type;

// #472: scalar FP widths remain scalar, Q/V are explicit 128-bit vectors.
assert.deepEqual(widthOfRegisterName('s0'), { bytes: 4, float: true });
assert.deepEqual(widthOfRegisterName('d3'), { bytes: 8, float: true });
assert.deepEqual(widthOfRegisterName('q7'), { bytes: 16, vector: true });
assert.deepEqual(widthOfRegisterName('v12'), { bytes: 16, vector: true });
assert.equal(typeFromAccess(4, { float: true }), 'float');
assert.equal(typeFromAccess(8, { float: true }), 'double');
assert.equal(typeFromAccess(16, { vector: true }), 'vector128');
assert.equal(typeFromAccess(16, { float: true }), 'vector128');
assert.equal(BASIC_TYPES.find((t) => t.name === 'vector128')?.size, 16);

{
  const result = inferTypes(model([
    insn(0, 'ldr', { ops: [reg('s0')], writes: ['s0'], reads: ['sp'], memory: { stack: true, base: 'sp', disp: -4n, kind: 'load', size: 4 } }),
    insn(1, 'ldr', { ops: [reg('d1')], writes: ['d1'], reads: ['sp'], memory: { stack: true, base: 'sp', disp: -16n, kind: 'load', size: 8 } }),
    insn(2, 'ldr', { ops: [reg('q2')], writes: ['v2'], reads: ['sp'], memory: { stack: true, base: 'sp', disp: -32n, kind: 'load', size: 16 } }),
    insn(3, 'str', { ops: [reg('v3')], writes: [], reads: ['v3', 'sp'], memory: { stack: true, base: 'sp', disp: -48n, kind: 'store', size: 16 } }),
  ]));
  const byOffset = new Map(result.locals.map((x) => [x.offset, x]));
  assert.equal(byOffset.get(-4)?.type, 'float');
  assert.equal(byOffset.get(-16)?.type, 'double');
  assert.equal(byOffset.get(-32)?.type, 'vector128');
  assert.equal(byOffset.get(-48)?.type, 'vector128');
  assert.equal(byOffset.get(-32)?.type === 'double', false, '16-byte Q load must never collapse to 8-byte double');
}

// #471: a proven full-width MOV copy keeps argument provenance.
{
  const result = inferTypes(model([
    insn(0, 'mov', { ops: [reg('x19'), reg('x0')], reads: ['x0'], writes: ['x19'] }),
    insn(1, 'ldr', { ops: [reg('w8')], reads: ['x19'], writes: ['x8'], memory: { stack: false, base: 'x19', disp: 0n, kind: 'load', size: 4 } }),
  ], [0]));
  assert.equal(argType(result, 0), 'void *');
}

// Any non-copy overwrite kills the alias before a later memory use.
{
  const result = inferTypes(model([
    insn(0, 'mov', { ops: [reg('x19'), reg('x0')], reads: ['x0'], writes: ['x19'] }),
    insn(1, 'add', { ops: [reg('x19'), reg('x2'), reg('x3')], reads: ['x2', 'x3'], writes: ['x19'] }),
    insn(2, 'ldr', { ops: [reg('w8')], reads: ['x19'], writes: ['x8'], memory: { stack: false, base: 'x19', disp: 0n, kind: 'load', size: 4 } }),
  ], [0]));
  assert.equal(argType(result, 0), 'unknown', 'overwritten x19 must not attribute pointer evidence back to entry x0');
}

// A call consumes the pre-call argument identity, then x0 becomes caller-saved /
// return-value state. A post-call dereference must not retroactively type arg x0.
{
  const result = inferTypes(model([
    insn(0, 'bl', { isCall: true, reads: ['x0'], writes: ['x0', 'x30'] }),
    insn(1, 'ldr', { ops: [reg('w8')], reads: ['x0'], writes: ['x8'], memory: { stack: false, base: 'x0', disp: 0n, kind: 'load', size: 4 } }),
  ], [0]));
  assert.equal(argType(result, 0), 'unknown', 'call return x0 must not retain entry argument identity');
}

// #812: W-register MOV truncates to 32 bits and zero-extends the physical X destination.
// It must not preserve the original 64-bit entry-argument identity.
{
  const result = inferTypes(model([
    insn(0, 'mov', { ops: [reg('w19'), reg('w0')], reads: ['w0'], writes: ['x19'] }),
    insn(1, 'ldr', { ops: [reg('w8')], reads: ['x19'], writes: ['x8'], memory: { stack: false, base: 'x19', disp: 4n, kind: 'load', size: 4 } }),
  ], [0]));
  assert.equal(argType(result, 0), 'unknown', 'mov w19,w0 must not attribute truncated-address evidence to entry x0');
}

// Once truncated, a later full-width copy must not resurrect the lost entry identity.
{
  const result = inferTypes(model([
    insn(0, 'mov', { ops: [reg('w19'), reg('w0')], reads: ['w0'], writes: ['x19'] }),
    insn(1, 'mov', { ops: [reg('x20'), reg('x19')], reads: ['x19'], writes: ['x20'] }),
    insn(2, 'ldr', { ops: [reg('w8')], reads: ['x20'], writes: ['x8'], memory: { stack: false, base: 'x20', disp: 0n, kind: 'load', size: 4 } }),
  ], [0]));
  assert.equal(argType(result, 0), 'unknown', 'full-width copy after W truncation must not resurrect x0 identity');
}

// #813: accessor verification may only trace exact setter-argument identity through MOV copies.
const accessorModel = (definition, storeReg) => model([
  definition,
  insn(1, 'str', {
    ops: [gp(storeReg), { k: 'mem', text: '[x0, #0x20]' }],
    reads: [storeReg, 'x0'], writes: [],
    memory: { stack: false, indexed: false, base: 'x0', disp: 0x20n, kind: 'store', size: storeReg.startsWith('w') ? 4 : 8 },
  }),
]);
const accessor = (definition, storeReg) => verifyAccessor(accessorModel(definition, storeReg), { offset: 0x20n });

{
  const xCopy = accessor(insn(0, 'mov', { ops: [gp('x8'), gp('x2')], reads: ['x2'], writes: ['x8'] }), 'x8');
  const wCopy = accessor(insn(0, 'mov', { ops: [gp('w8'), gp('w2')], reads: ['x2'], writes: ['x8'] }), 'w8');
  assert.equal(xCopy.fromArgument, true, 'mov x8,x2 must preserve setter argument identity');
  assert.equal(wCopy.fromArgument, true, 'mov w8,w2 must preserve the 32-bit setter argument identity');
}

for (const [mnemonic, dst, src, ops] of [
  ['neg', 'w8', 'w2', [gp('w8'), gp('w2')]],
  ['lsl', 'w8', 'w2', [gp('w8'), gp('w2'), { k: 'imm', value: 1n }]],
  ['mvn', 'w8', 'w2', [gp('w8'), gp('w2')]],
  ['sxtw', 'x8', 'w2', [gp('x8'), gp('w2')]],
  ['uxtw', 'x8', 'w2', [gp('x8'), gp('w2')]],
  ['rev', 'w8', 'w2', [gp('w8'), gp('w2')]],
]) {
  const result = accessor(insn(0, mnemonic, { ops, reads: ['x2'], writes: ['x8'] }), dst);
  assert.equal(result.fromArgument, false, `${mnemonic} must not be accepted as setter argument identity`);
}

// A synthetic width-changing MOV must also fail closed rather than equating W/X views.
{
  const result = accessor(insn(0, 'mov', { ops: [gp('x8'), gp('w2')], reads: ['x2'], writes: ['x8'] }), 'x8');
  assert.equal(result.fromArgument, false, 'width-changing MOV must not preserve setter argument identity');
}

console.log('legacy/verification regressions #471/#472/#812/#813 PASS');
