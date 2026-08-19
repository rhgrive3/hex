import assert from 'node:assert/strict';
import { Emulator } from '../js/emu.js';
import { assemble, suggestPatches } from '../js/patch.js';
import { readVtable } from '../js/rtti.js';
import { parseSwiftVTable } from '../js/swift.js';

function vtableBytes(slots, typeinfo = 0n) {
  const bytes = new Uint8Array((slots.length + 2) * 8);
  const view = new DataView(bytes.buffer);
  view.setBigInt64(0, 0n, true);
  view.setBigUint64(8, typeinfo, true);
  slots.forEach((raw, index) => view.setBigUint64((index + 2) * 8, BigInt(raw), true));
  return bytes;
}

function readerFor(bytes, base = 0n) {
  return async (address, length) => {
    const offset = Number(BigInt(address) - BigInt(base));
    if (!Number.isSafeInteger(offset) || offset < 0 || offset >= bytes.length) return new Uint8Array();
    return bytes.subarray(offset, Math.min(bytes.length, offset + Number(length)));
  };
}

// #802 — NEGS is the SUBS-from-zero alias and updates NZCV; NEG does not.
{
  const emu = new Emulator();
  emu.set('w1', 1n);
  emu.nzcv = { n:false, z:true, c:true, v:true };
  await emu.execute('negs', 'w0, w1', 0n);
  assert.equal(emu.get('w0'), 0xffffffffn);
  assert.deepEqual(emu.nzcv, { n:true, z:false, c:false, v:false });

  const before = { ...emu.nzcv };
  await emu.execute('neg', 'w0, w1', 0n);
  assert.deepEqual(emu.nzcv, before, 'NEG must preserve NZCV');

  emu.set('x1', 0x8000000000000000n);
  await emu.execute('negs', 'x0, x1', 0n);
  assert.equal(emu.get('x0'), 0x8000000000000000n);
  assert.deepEqual(emu.nzcv, { n:true, z:false, c:false, v:true });
}

// #805 — hs/lo aliases canonicalize to cs/cc and generated proposals round-trip.
{
  const hs = assemble('b.hs 0x2000', 0x1000n);
  const cs = assemble('b.cs 0x2000', 0x1000n);
  const lo = assemble('b.lo 0x2000', 0x1000n);
  const cc = assemble('b.cc 0x2000', 0x1000n);
  assert.deepEqual(Array.from(hs.bytes), Array.from(cs.bytes));
  assert.deepEqual(Array.from(lo.bytes), Array.from(cc.bytes));
  for (const mnemonic of ['b.hs', 'b.lo', 'b.cs', 'b.cc']) {
    for (const proposal of suggestPatches(mnemonic, '#0x2000', 0x1000n)) {
      const assembled = assemble(proposal.text, 0x1000n);
      assert.equal(assembled.error, undefined, `${mnemonic}: ${proposal.text}`);
      assert.equal(assembled.bytes?.length, 4, `${mnemonic}: ${proposal.text}`);
    }
  }
}

// #810 — a legal null virtual slot is data, not a table terminator.
{
  const bytes = vtableBytes([0x1110n, 0n, 0x3330n]);
  const table = await readVtable(readerFor(bytes), 0n, null, { slotCount:3 });
  assert.equal(table.slots.length, 3);
  assert.deepEqual(table.slots.map((slot) => slot.index), [0, 1, 2]);
  assert.equal(table.slots[0].addr, 0x1110n);
  assert.equal(table.slots[1].addr, 0n);
  assert.equal(table.slots[1].unresolved, false);
  assert.equal(table.slots[2].addr, 0x3330n);
}

// #835 — Swift MethodDescriptorFlags::IsInstance is a positive bit; keep async too.
{
  const bytes = new Uint8Array(24);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, 0x10, true);
  view.setUint32(8, 0x00, true);
  view.setUint32(16, 0x70, true);
  const methods = await parseSwiftVTable(readerFor(bytes), 0n, 3);
  assert.equal(methods[0].instance, true);
  assert.equal(methods[1].instance, false);
  assert.equal(methods[2].instance, true);
  assert.equal(methods[2].dynamic, true);
  assert.equal(methods[2].async, true);
}

// #840 — ARM64E firmware unauthenticated rebases encode vmaddr, unlike offset formats.
{
  const imageBase = 0x100000000n;
  const target = 0x2000n;
  const high8 = 0xABn;
  const absoluteRaw = target | (high8 << 43n);
  const absoluteExpected = target | (high8 << 56n);
  for (const format of [1, 10]) {
    const table = await readVtable(readerFor(vtableBytes([absoluteRaw])), 0n, null, { slotCount:1, pointerFormat:format, imageBase });
    assert.equal(table.slots[0].addr, absoluteExpected, `format ${format} must decode unauth target as vmaddr`);
  }
  for (const format of [7, 9, 12]) {
    const table = await readVtable(readerFor(vtableBytes([target])), 0n, null, { slotCount:1, pointerFormat:format, imageBase });
    assert.equal(table.slots[0].addr, imageBase + target, `format ${format} must decode unauth target as vm offset`);
  }

  const authTarget = 0x1234n;
  const authRaw = (1n << 63n) | authTarget;
  const authFirmware = await readVtable(readerFor(vtableBytes([authRaw])), 0n, null, { slotCount:1, pointerFormat:10, imageBase });
  assert.equal(authFirmware.slots[0].addr, imageBase + authTarget);

  const bindOrdinal = 0x1234n;
  const bindRaw = (1n << 62n) | bindOrdinal;
  const bindFirmware = await readVtable(readerFor(vtableBytes([bindRaw])), 0n, null, { slotCount:1, pointerFormat:10, imageBase });
  assert.equal(bindFirmware.slots[0].addr, null);
  assert.equal(bindFirmware.slots[0].binding?.ordinal, Number(bindOrdinal));
  assert.equal(bindFirmware.slots[0].binding?.authenticated, false);

  const authBindRaw = (1n << 63n) | (1n << 62n) | bindOrdinal;
  const authBindFirmware = await readVtable(readerFor(vtableBytes([authBindRaw])), 0n, null, { slotCount:1, pointerFormat:10, imageBase });
  assert.equal(authBindFirmware.slots[0].binding?.ordinal, Number(bindOrdinal));
  assert.equal(authBindFirmware.slots[0].binding?.authenticated, true);
}

console.log('issues 802/805/810/835/840 regressions: PASS');
