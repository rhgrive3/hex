import assert from 'node:assert/strict';
import { readVtable } from '../js/rtti.js';

const BASE = 0x100000000n;
const TARGET = 0x2000n;
const HIGH8 = 0xabn;

function arm64eRebase(target, high8 = 0n) {
  return (target & 0x7ffffffffffn) | ((high8 & 0xffn) << 43n);
}
function arm64eAuthRebase(target) {
  return (1n << 63n) | (target & 0xffffffffn);
}
function arm64eBind(ordinal, auth = false) {
  return (auth ? 3n : 1n) << 62n | BigInt(ordinal);
}
function ptr64Rebase(target, high8 = 0n) {
  return (target & 0xfffffffffn) | ((high8 & 0xffn) << 36n);
}
function ptr64Bind(ordinal) {
  return (1n << 63n) | BigInt(ordinal);
}
async function decode(raw, format, imageBase = BASE) {
  const bytes = new Uint8Array(32);
  const dv = new DataView(bytes.buffer);
  dv.setBigUint64(8, raw, true);
  dv.setBigUint64(16, raw, true);
  const read = async () => bytes;
  const v = await readVtable(read, 0n, null, 2, { pointerFormat: format, imageBase });
  return { typeinfo: v.typeinfo, typeinfoBinding: v.typeinfoBinding, slot: v.slots[0] };
}

for (const format of [1, 10]) {
  const d = await decode(arm64eRebase(TARGET), format);
  assert.equal(d.typeinfo, TARGET, `format ${format} unauth rebase is vmaddr`);
}
for (const format of [7, 9, 12]) {
  const d = await decode(arm64eRebase(TARGET), format);
  assert.equal(d.typeinfo, BASE + TARGET, `format ${format} unauth rebase is vm offset`);
}
for (const format of [1, 10]) {
  const d = await decode(arm64eRebase(TARGET, HIGH8), format);
  assert.equal(d.typeinfo, (HIGH8 << 56n) | TARGET);
}
for (const format of [7, 9, 12]) {
  const d = await decode(arm64eRebase(TARGET, HIGH8), format);
  assert.equal(d.typeinfo, BASE + ((HIGH8 << 56n) | TARGET));
}
for (const format of [1, 7, 9, 10, 12]) {
  const d = await decode(arm64eAuthRebase(TARGET), format);
  assert.equal(d.typeinfo, BASE + TARGET, `format ${format} auth rebase`);
  assert.equal(d.slot.addr, BASE + TARGET);
}
for (const format of [1, 7, 9, 10]) {
  const d = await decode(arm64eBind(0x1234), format);
  assert.equal(d.typeinfo, null);
  assert.equal(d.typeinfoBinding.ordinal, 0x1234);
  const auth = await decode(arm64eBind(0x2345, true), format);
  assert.equal(auth.typeinfoBinding.ordinal, 0x2345);
  assert.equal(auth.typeinfoBinding.authenticated, true);
}
{
  const d = await decode(arm64eBind(0x123456), 12);
  assert.equal(d.typeinfoBinding.ordinal, 0x123456);
  const auth = await decode(arm64eBind(0xabcdef, true), 12);
  assert.equal(auth.typeinfoBinding.ordinal, 0xabcdef);
}
{
  const raw = ptr64Rebase(TARGET, HIGH8);
  assert.equal((await decode(raw, 2)).typeinfo, (HIGH8 << 56n) | TARGET);
  assert.equal((await decode(raw, 6)).typeinfo, BASE + ((HIGH8 << 56n) | TARGET));
  assert.equal((await decode(ptr64Bind(0x654321), 2)).typeinfoBinding.ordinal, 0x654321);
  assert.equal((await decode(ptr64Bind(0x654321), 6)).typeinfoBinding.ordinal, 0x654321);
}
assert.equal((await decode(arm64eRebase(TARGET), 10, null)).typeinfo, TARGET);
assert.equal((await decode(arm64eRebase(TARGET), 9, null)).typeinfo, null);
assert.equal((await decode(ptr64Rebase(TARGET), 6, null)).typeinfo, null);

console.log('issue 840 RTTI chained-pointer formats: ok');
