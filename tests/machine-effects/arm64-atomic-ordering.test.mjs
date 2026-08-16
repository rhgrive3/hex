import assert from 'node:assert/strict';
import { liftArm64MemoryEffects } from '../../js/targets/architecture/arm64/effects/memory.js';
import { liftArm64AtomicEffects, ARM64_ATOMIC_INSTRUCTION_INVENTORY } from '../../js/targets/architecture/arm64/effects/atomic.js';

let sequence = 0;
const x = (n) => ({ k:'reg', text:`x${n}`, cls:'gp', bits:64, num:n });
const w = (n) => ({ k:'reg', text:`w${n}`, cls:'gp', bits:32, num:n });
const sp = () => ({ k:'reg', text:'sp', cls:'sp', bits:64, num:31 });
const imm = (value) => ({ k:'imm', text:`#${value}`, value:BigInt(value) });
const mem = (base, { disp=null, index=null } = {}) => ({ k:'mem', text:'[...]', base, index, shift:null, mode:'offset', disp:disp == null ? null : imm(disp), addressDisp:disp == null ? null : imm(disp), writebackDisp:null });
const other = (text) => ({ k:'other', text });
function context() { const instructionId=`arm64-atomic-test-${sequence++}`; return { instructionId, origin:{ instructionIds:[instructionId] } }; }
function liftMem(mnemonic, ops) { return liftArm64MemoryEffects({ mnemonic, ops }, context()); }
function liftAtomic(mnemonic, ops) { return liftArm64AtomicEffects({ mnemonic, ops }, context()); }

{
  const acquire = liftMem('ldar', [w(0), mem(x(1))]);
  const release = liftMem('stlr', [w(0), mem(x(1))]);
  const la = acquire.operations.find((op) => op.kind === 'memory-read').access;
  const sa = release.operations.find((op) => op.kind === 'memory-write').access;
  assert.deepEqual({ atomic:la.atomic, ordering:la.ordering, endian:la.endian, alignment:la.alignment }, { atomic:true, ordering:'acquire', endian:'little', alignment:4 });
  assert.deepEqual({ atomic:sa.atomic, ordering:sa.ordering, endian:sa.endian, alignment:sa.alignment }, { atomic:true, ordering:'release', endian:'little', alignment:4 });
  assert.equal('volatility' in la, false);
  assert.equal('volatility' in sa, false);
}

{
  const relaxed = liftAtomic('ldxr', [x(0), mem(x(1))]);
  const acquire = liftAtomic('ldaxr', [x(0), mem(x(1))]);
  assert.equal(relaxed.completeness, 'exact-with-intrinsic');
  assert.equal(relaxed.operations.find((op) => op.kind === 'memory-read').access.ordering, 'relaxed');
  assert.equal(acquire.operations.find((op) => op.kind === 'memory-read').access.ordering, 'acquire');
  assert.ok(acquire.operations.some((op) => op.kind === 'intrinsic' && op.intrinsicId === 'arm64.exclusive-monitor-set'));
  assert.ok(acquire.possibleFaults.some((fault) => fault.kind === 'alignment-fault'));
}

{
  const b = liftAtomic('ldxr', [x(0), mem(sp())]);
  assert.equal(b.completeness, 'exact-with-intrinsic');
  assert.ok(b.possibleFaults.some((fault) => fault.kind === 'stack-pointer-alignment-fault'));
  assert.equal(b.operations.find((op) => op.kind === 'memory-read').metadata.tagChecked, false);
}

{
  const b = liftAtomic('stlxr', [w(0), x(2), mem(x(1))]);
  const store = b.operations.find((op) => op.kind === 'intrinsic' && op.intrinsicId === 'arm64.exclusive-store-conditional');
  assert.equal(b.completeness, 'exact-with-intrinsic');
  assert.equal(store.effectSummary.memoryWrite.scope, 'accesses');
  assert.equal(store.effectSummary.memoryWrite.accesses[0].ordering, 'release');
  const statusWrite = b.operations.filter((op) => op.kind === 'register-write').at(-1);
  assert.equal(statusWrite.register.registerId, 'x0');
  assert.equal(statusWrite.register.view, 'w0');
  assert.equal(statusWrite.metadata.writePolicy, 'zero-upper-32');
}

{
  const b = liftAtomic('casal', [x(0), x(2), mem(x(1))]);
  const cas = b.operations.find((op) => op.kind === 'intrinsic' && op.intrinsicId === 'arm64.atomic.compare-swap');
  assert.equal(cas.effectSummary.memoryRead.accesses[0].ordering, 'acquire');
  assert.equal(cas.effectSummary.memoryWrite.accesses[0].ordering, 'release');
  assert.equal(cas.metadata.ordering, 'acq-rel');
  assert.equal(b.operations.filter((op) => op.kind === 'register-write').at(-1).register.registerId, 'x0');
}

{
  const add = liftAtomic('ldadda', [w(0), w(2), mem(x(1))]);
  const rmw = add.operations.find((op) => op.kind === 'intrinsic');
  assert.equal(rmw.intrinsicId, 'arm64.atomic.add');
  assert.equal(rmw.metadata.operation, 'add');
  assert.equal(rmw.effectSummary.memoryRead.accesses[0].ordering, 'acquire');
  assert.equal(rmw.effectSummary.memoryWrite.accesses[0].ordering, 'relaxed');
}

{
  const addByte = liftAtomic('ldaddb', [w(0), w(2), mem(x(1))]);
  const trunc = addByte.operations.find((op) => op.kind === 'value' && op.opcode === 'truncate');
  assert.equal(addByte.completeness, 'exact-with-intrinsic');
  assert.ok(trunc, 'byte atomic source must explicitly truncate the W view');
  assert.equal(trunc.metadata.fromBits, 32);
  assert.equal(trunc.metadata.toBits, 8);
  assert.equal(addByte.operations.find((op) => op.kind === 'intrinsic').effectSummary.memoryRead.accesses[0].widthBits, 8);
}

{
  const swap = liftAtomic('swpal', [x(0), x(2), mem(x(1))]);
  const rmw = swap.operations.find((op) => op.kind === 'intrinsic');
  assert.equal(rmw.metadata.operation, 'swap');
  assert.equal(rmw.effectSummary.memoryRead.accesses[0].ordering, 'acquire');
  assert.equal(rmw.effectSummary.memoryWrite.accesses[0].ordering, 'release');
}

{
  const b = liftAtomic('dmb', [other('ish')]);
  assert.equal(b.completeness, 'exact');
  assert.equal(b.operations[0].kind, 'barrier');
  assert.equal(b.operations[0].scope.domain, 'inner-shareable');
  assert.equal(b.operations[0].scope.access, 'all');
  const bad = liftAtomic('dmb', [other('bad-option')]);
  assert.equal(bad.completeness, 'partial');
  assert.ok(bad.unknownEffects.categories.includes('memory'));
}

{
  const b = liftAtomic('clrex', []);
  assert.equal(b.completeness, 'exact-with-intrinsic');
  assert.equal(b.operations[0].intrinsicId, 'arm64.exclusive-monitor-clear');
}

{
  const malformedWriteback = liftAtomic('stxr', [w(0), x(2), { k:'mem', base:x(1), mode:'post', addressDisp:null, writebackDisp:null }]);
  const malformedOffset = liftAtomic('cas', [x(0), x(2), mem(x(1), { disp:8n })]);
  const malformedIndex = liftAtomic('ldxr', [x(0), mem(x(1), { index:x(3) })]);
  const malformedByteRegister = liftAtomic('ldaddb', [x(0), x(2), mem(x(1))]);
  assert.equal(malformedWriteback.completeness, 'partial');
  assert.equal(malformedOffset.completeness, 'partial');
  assert.equal(malformedIndex.completeness, 'partial');
  assert.equal(malformedByteRegister.completeness, 'partial');
  assert.ok(malformedWriteback.unknownEffects.categories.includes('memory'));
}

assert.deepEqual(ARM64_ATOMIC_INSTRUCTION_INVENTORY.compareSwap, ['cas','casa','casl','casal']);
console.log('arm64 atomic ordering effects: PASS');
