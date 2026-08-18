import assert from 'node:assert/strict';
import { Emulator } from '../../js/emu.js';
import { liftArm64FpEffects } from '../../js/targets/architecture/arm64/effects/fp.js';
import { readVtable, findCxxClasses } from '../../js/rtti.js';

async function exec(emu, mnemonic, operands) { return emu.execute(mnemonic, operands, 0x1000n); }
function qwordBytes(values) {
  const bytes = new Uint8Array(values.length * 8);
  const dv = new DataView(bytes.buffer);
  values.forEach((value, index) => dv.setBigUint64(index * 8, BigInt.asUintN(64, BigInt(value)), true));
  return bytes;
}

// #833 — FMOV between GP and scalar FP registers is a bit transfer, not numeric conversion.
{
  const emu = new Emulator();
  emu.set('x0', 0x7ff8123456789abcn);
  await exec(emu, 'fmov', 'd0, x0');
  await exec(emu, 'fmov', 'x1, d0');
  assert.equal(emu.get('x1'), 0x7ff8123456789abcn, 'D<->X preserves NaN payload bits');
  emu.set('w2', 0x80000000n);
  await exec(emu, 'fmov', 's1, w2');
  await exec(emu, 'fmov', 'w3, s1');
  assert.equal(emu.get('w3'), 0x80000000n, 'S<->W preserves negative-zero bit pattern');
  await exec(emu, 'fmov', 'd2, d0');
  await exec(emu, 'fmov', 'x4, d2');
  assert.equal(emu.get('x4'), 0x7ff8123456789abcn, 'FP<->FP move preserves raw payload');
}

// #803 — FMA is single-rounding fused for both binary32 and binary64.
{
  const emu = new Emulator();
  // (1+2^-23)*(1-2^-23)-1 = -2^-46 exactly. A separate FMUL rounds the product to 1.
  for (const [reg, bits] of [['w0',0x3f800001n],['w1',0x3f7ffffen],['w2',0xbf800000n]]) emu.set(reg,bits);
  await exec(emu,'fmov','s0, w0'); await exec(emu,'fmov','s1, w1'); await exec(emu,'fmov','s2, w2');
  await exec(emu,'fmadd','s3, s0, s1, s2'); await exec(emu,'fmov','w3, s3');
  assert.equal(emu.get('w3'), 0xa8800000n, 'binary32 fused result is exact -2^-46');
  await exec(emu,'fmul','s4, s0, s1'); await exec(emu,'fadd','s4, s4, s2'); await exec(emu,'fmov','w4, s4');
  assert.notEqual(emu.get('w4'), emu.get('w3'), 'separate FMUL+FADD may differ from FMADD');
}
{
  const emu = new Emulator();
  // (1+2^-52)*(1-2^-52)-1 = -2^-104; ordinary binary64 multiplication rounds to 1 first.
  for (const [reg, bits] of [['x0',0x3ff0000000000001n],['x1',0x3feffffffffffffen],['x2',0xbff0000000000000n]]) emu.set(reg,bits);
  await exec(emu,'fmov','d0, x0'); await exec(emu,'fmov','d1, x1'); await exec(emu,'fmov','d2, x2');
  await exec(emu,'fmadd','d3, d0, d1, d2'); await exec(emu,'fmov','x3, d3');
  assert.equal(emu.get('x3'), 0xb970000000000000n, 'binary64 fused result is exact -2^-104');
  await exec(emu,'fmul','d4, d0, d1'); await exec(emu,'fadd','d4, d4, d2'); await exec(emu,'fmov','x4, d4');
  assert.equal(emu.get('x4'), 0n, 'separate FMUL+FADD rounds to zero for the counterexample');
}
{
  const emu = new Emulator();
  // Invalid 0*inf produces a quiet NaN and same-sign signed zeros stay signed.
  for (const [reg,bits] of [['x0',0n],['x1',0x7ff0000000000000n],['x2',0x3ff0000000000000n]]) emu.set(reg,bits);
  await exec(emu,'fmov','d0, x0'); await exec(emu,'fmov','d1, x1'); await exec(emu,'fmov','d2, x2');
  await exec(emu,'fmadd','d3, d0, d1, d2'); await exec(emu,'fmov','x3, d3');
  assert.equal(emu.get('x3') & 0x7ff8000000000000n, 0x7ff8000000000000n);
  emu.set('x0',0x8000000000000000n); emu.set('x1',0x3ff0000000000000n); emu.set('x2',0x8000000000000000n);
  await exec(emu,'fmov','d0, x0'); await exec(emu,'fmov','d1, x1'); await exec(emu,'fmov','d2, x2');
  await exec(emu,'fmadd','d3, d0, d1, d2'); await exec(emu,'fmov','x3, d3');
  assert.equal(emu.get('x3'), 0x8000000000000000n, 'negative zero plus negative zero remains -0');
}

// #809 — S/D views read and write the same canonical 128-bit physical V register.
function reg(num, bits, text) { return { k:'reg', cls:'fp', num, bits, text }; }
{
  const bundle = liftArm64FpEffects({ instructionId:'fp-s', mnemonic:'fadd', ops:[reg(0,32,'s0'),reg(1,32,'s1'),reg(2,32,'s2')] });
  const reads = bundle.operations.filter((op) => op.kind === 'register-read' && /^v[12]$/.test(op.register.registerId));
  const writes = bundle.operations.filter((op) => op.kind === 'register-write' && op.register.registerId === 'v0');
  assert.ok(reads.length >= 2);
  assert.ok(reads.every((op) => op.register.widthBits === 128), 'scalar S reads use physical vN width');
  assert.equal(writes.at(-1)?.register.widthBits, 128, 'scalar S write defines physical vN width');
}
{
  const bundle = liftArm64FpEffects({ instructionId:'fp-d', mnemonic:'fmov', ops:[reg(3,64,'d3'),reg(4,64,'d4')] });
  const read = bundle.operations.find((op) => op.kind === 'register-read' && op.register.registerId === 'v4');
  const write = bundle.operations.find((op) => op.kind === 'register-write' && op.register.registerId === 'v3');
  assert.equal(read?.register.widthBits, 128);
  assert.equal(write?.register.widthBits, 128);
  assert.ok(bundle.operations.some((op) => op.kind === 'value' && op.opcode === 'arm64.simd.scalar-write-zero-upper'));
}

// #811 — _ZTV symbol base is distinguished and address point is found only with bounded typeinfo evidence.
{
  const base = 0x1000n, typeinfo = 0x5000n;
  const bytes = qwordBytes([
    0x1111111111111111n, // virtual-base prefix entry; not the offset-to-top
    0x2222222222222222n,
    0n,                 // actual offset-to-top
    typeinfo,           // actual RTTI header
    0x7000n, 0x7010n, 0n,
  ]);
  const read = async (addr, len) => bytes.slice(Number(BigInt(addr)-base), Number(BigInt(addr)-base)+len);
  const symbols = {
    nameAt(addr) { if (addr === typeinfo) return '_ZTI1B'; if (addr === 0x7000n) return '_ZN1B1fEv'; return null; },
    label(addr) { return this.nameAt(addr); },
  };
  const vt = await readVtable(read, base, symbols, { symbolBase:true, maxSlots:8, maxPrefixEntries:8 });
  assert.equal(vt.headerIndex, 2);
  assert.equal(vt.addressPoint, base + 32n);
  assert.equal(vt.offsetToTop, 0n);
  assert.equal(vt.typeinfo, typeinfo);
  assert.equal(vt.slots[0].addr, 0x7000n);
}
{
  const base = 0x2000n;
  const bytes = qwordBytes([1n,2n,3n,4n,5n,6n]);
  const read = async (_addr, len) => bytes.slice(0,len);
  const vt = await readVtable(read, base, { nameAt(){return null;}, label(){return null;} }, { symbolBase:true, maxSlots:4, maxPrefixEntries:3 });
  assert.equal(vt.unresolved, true);
  assert.equal(vt.reason, 'vtable-address-point-unresolved');
  assert.deepEqual(vt.slots, []);
}
{
  const classes = findCxxClasses({ names:['_ZTV1B','_ZTI1B'], addrs:[0x3000n,0x4000n] });
  assert.equal(classes[0].vtableSymbolBase, 0x3000n);
  assert.equal(classes[0].vtableAddressKind, 'symbol-base');
  assert.equal(classes[0].vtableAddressPoint, null);
}

console.log('issues #803 #809 #811 #833 regressions: ok');
