import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { Emulator } from '../js/emu.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (!globalThis.Words) vm.runInThisContext(fs.readFileSync(path.join(root, 'js', 'words.js'), 'utf8'), { filename: 'js/words.js' });
const W = globalThis.Words;
const mem = (word) => W.memoryAccess(word >>> 0);

// #814 LDPSW: two 32-bit memory elements, sign-extended into X registers.
for (const [word, disp, mode] of [
  [0x69400440, 0n, 'offset'],
  [0x69408440, 4n, 'offset'],
  [0x697f8440, -4n, 'offset'],
  [0x68c08440, 4n, 'post'],
  [0x69ff8440, -4n, 'pre'],
]) {
  const m = mem(word);
  assert.equal(m.load, true);
  assert.equal(m.pair, true);
  assert.equal(m.elementSize, 4);
  assert.equal(m.size, 8);
  assert.equal(m.disp, disp);
  assert.equal(m.mode, mode);
  assert.equal(m.signed, true);
  assert.equal(m.signExtendTo, 8);
  assert.equal(m.reg, 0);
  assert.equal(m.reg2, 1);
}
for (const [label, word, elementSize, totalSize, vector] of [
  ['ldp w', 0x29400440, 4, 8, false],
  ['ldp x', 0xa9400440, 8, 16, false],
  ['ldp s', 0x2d400440, 4, 8, true],
  ['ldp d', 0x6d400440, 8, 16, true],
  ['ldp q', 0xad400440, 16, 32, true],
]) {
  const m = mem(word);
  assert.equal(m.elementSize, elementSize, label);
  assert.equal(m.size, totalSize, label);
  assert.equal(m.vector, vector, label);
  assert.notEqual(m.signed, true, label);
}

// #815 pair-exclusive: preserve both data registers, total width and store status.
for (const [label, word, elementSize, total, load, order] of [
  ['ldxp w', 0x887f0440, 4, 8, true, 'relaxed'],
  ['ldxp x', 0xc87f0440, 8, 16, true, 'relaxed'],
  ['ldaxp x', 0xc87f8440, 8, 16, true, 'acquire'],
  ['stxp w', 0x88230440, 4, 8, false, 'relaxed'],
  ['stxp x', 0xc8230440, 8, 16, false, 'relaxed'],
  ['stlxp x', 0xc8238440, 8, 16, false, 'release'],
]) {
  const m = mem(word);
  assert.equal(m.atomic, true, label);
  assert.equal(m.pair, true, label);
  assert.equal(m.elementSize, elementSize, label);
  assert.equal(m.size, total, label);
  assert.equal(m.load, load, label);
  assert.equal(m.store, !load, label);
  assert.equal(m.reg, 0, label);
  assert.equal(m.reg2, 1, label);
  assert.equal(m.ordering, order, label);
  if (!load) assert.equal(m.statusReg, 3, label);
}

// #816 CAS/CASP and the complete base LSE RMW operation family.
for (const [label, word, size, order] of [
  ['casb', 0x08a07c41, 1, 'relaxed'],
  ['cash', 0x48a07c41, 2, 'relaxed'],
  ['cas w', 0x88a07c41, 4, 'relaxed'],
  ['cas x', 0xc8a07c41, 8, 'relaxed'],
  ['casa x', 0xc8e07c41, 8, 'acquire'],
  ['casl x', 0xc8a0fc41, 8, 'release'],
  ['casal x', 0xc8e0fc41, 8, 'acq_rel'],
]) {
  const m = mem(word);
  assert.equal(m.atomicOp, 'cas', label);
  assert.equal(m.load, true, label);
  assert.equal(m.store, true, label);
  assert.equal(m.rmw, true, label);
  assert.equal(m.size, size, label);
  assert.equal(m.compareReg, 0, label);
  assert.equal(m.valueReg, 1, label);
  assert.equal(m.resultReg, 0, label);
  assert.equal(m.base, 2, label);
  assert.equal(m.ordering, order, label);
}
for (const [label, word, element, total, order] of [
  ['casp w', 0x08207ca2, 4, 8, 'relaxed'],
  ['casp x', 0x48207c42, 8, 16, 'relaxed'],
  ['caspa x', 0x48607c42, 8, 16, 'acquire'],
  ['caspl x', 0x4820fc42, 8, 16, 'release'],
  ['caspal x', 0x4860fc42, 8, 16, 'acq_rel'],
]) {
  const m = mem(word);
  assert.equal(m.atomicOp, 'casp', label);
  assert.equal(m.pair, true, label);
  assert.equal(m.elementSize, element, label);
  assert.equal(m.size, total, label);
  assert.equal(m.compareReg, 0, label);
  assert.equal(m.compareReg2, 1, label);
  assert.equal(m.valueReg, 2, label);
  assert.equal(m.valueReg2, 3, label);
  assert.equal(m.ordering, order, label);
}
const opNames = ['ldadd', 'ldclr', 'ldeor', 'ldset', 'ldsmax', 'ldsmin', 'ldumax', 'ldumin', 'swp'];
for (let op = 0; op < opNames.length; op++) {
  const m = mem((0xb8200041 | (op << 12)) >>> 0);
  assert.equal(m.atomicOp, opNames[op]);
  assert.equal(m.load, true);
  assert.equal(m.store, true);
  assert.equal(m.rmw, true);
  assert.equal(m.sourceReg, 0);
  assert.equal(m.resultReg, 1);
  assert.equal(m.base, 2);
  assert.equal(m.size, 4);
}
for (const [label, word, size, order] of [
  ['ldaddb', 0x38200041, 1, 'relaxed'],
  ['ldaddh', 0x78200041, 2, 'relaxed'],
  ['ldadd w', 0xb8200041, 4, 'relaxed'],
  ['ldadd x', 0xf8200041, 8, 'relaxed'],
  ['ldadda x', 0xf8a00041, 8, 'acquire'],
  ['ldaddl x', 0xf8600041, 8, 'release'],
  ['ldaddal x', 0xf8e00041, 8, 'acq_rel'],
  ['swpal x', 0xf8e08041, 8, 'acq_rel'],
]) {
  const m = mem(word);
  assert.equal(m.load, true, label);
  assert.equal(m.store, true, label);
  assert.equal(m.rmw, true, label);
  assert.equal(m.size, size, label);
  assert.equal(m.ordering, order, label);
}
assert.notEqual(mem(0x38bfc041)?.rmw, true, 'LDAPR must not be classified as LSE RMW');

// #814 emulator: LDPSW reads 4-byte lanes and sign-extends each into X registers.
const emu = new Emulator({});
emu.mapZero(0x1000n, 0x100);
await emu.store(0x1000n, 4, 0xffffffffn);
await emu.store(0x1004n, 4, 0x80000000n);
emu.set('x2', 0x1000n);
await emu.execute('ldpsw', 'x0, x1, [x2]', 0n);
assert.equal(emu.get('x0'), 0xffffffffffffffffn);
assert.equal(emu.get('x1'), 0xffffffff80000000n);

console.log('issues 814-816 ARM64 memory regressions: ok');
