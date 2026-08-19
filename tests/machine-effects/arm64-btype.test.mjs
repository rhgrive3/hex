import assert from 'node:assert/strict';
import { parseOperands } from '../../js/arm64.js';
import { lowerMachineEffectBundleToSemanticIr } from '../../js/semantics/ir/from-machine-effects.js';
import { ARM64_ARCHITECTURE, ARM64E_ARCHITECTURE } from '../../js/targets/architecture/index.js';
import { ARM64_BTYPE_REGISTER_ID } from '../../js/targets/architecture/arm64/effects/btype.js';
import { liftArm64ControlEffects } from '../../js/targets/architecture/arm64/effects/control.js';
import { liftArm64SystemEffects } from '../../js/targets/architecture/arm64/effects/system.js';

let serial = 0;
function instruction(mnemonic, operands = '', extra = {}) {
  serial += 1;
  const instructionId = `arm64-btype-${serial}`;
  return {
    instructionId,
    mnemonic,
    operands,
    opStr: operands,
    ops: parseOperands(operands),
    mode:'a64',
    address:0x8000n + BigInt(serial * 4),
    origin:{ instructionIds:[instructionId] },
    ...extra,
  };
}

function btypeWrites(bundle) {
  return bundle.operations.filter((operation) => operation.kind === 'register-write' && operation.register.registerId === ARM64_BTYPE_REGISTER_ID);
}
function btypeValue(bundle) {
  const writes = btypeWrites(bundle);
  assert.equal(writes.length, 1, 'control transfer must define exactly one canonical BTYPE state version');
  return writes[0].value.value == null ? null : Number(writes[0].value.value);
}
function guarded(value) {
  return { branchTargetIdentification:{ currentPageGuarded:value } };
}

{
  const bundle = liftArm64ControlEffects(instruction('br', 'x16'));
  assert.equal(bundle.completeness, 'exact');
  assert.equal(btypeValue(bundle), 1, 'BR x16 has the IP0/IP1 jump-compatible BTYPE independent of page guard state');
}

{
  const bundle = liftArm64ControlEffects(instruction('br', 'x17'), guarded(true));
  assert.equal(bundle.completeness, 'exact');
  assert.equal(btypeValue(bundle), 1, 'BR x17 remains BTYPE=1 even on a guarded source page');
}

{
  const unguarded = liftArm64ControlEffects(instruction('br', 'x3'), guarded(false));
  assert.equal(unguarded.completeness, 'exact');
  assert.equal(btypeValue(unguarded), 1, 'BR from a non-guarded source page sets BTYPE=1');

  const guardedBranch = liftArm64ControlEffects(instruction('br', 'x3'), guarded(true));
  assert.equal(guardedBranch.completeness, 'exact');
  assert.equal(btypeValue(guardedBranch), 3, 'BR from a guarded source page through a non-IP register sets BTYPE=3');
}

{
  const unknown = liftArm64ControlEffects(instruction('br', 'x3'));
  assert.equal(unknown.completeness, 'partial', 'missing guarded-page evidence must not guess a BR BTYPE');
  assert.equal(btypeValue(unknown), null, 'unknown BR BTYPE is an explicit unknown-width state write');
  assert.ok(unknown.unknownEffects.categories.includes('registers'));
  assert.match(unknown.operations.find((operation) => operation.kind === 'unknown')?.reason || '', /guarded-state-unavailable/);
}

{
  const bundle = liftArm64ControlEffects(instruction('blr', 'x9'));
  assert.equal(bundle.completeness, 'exact');
  assert.equal(btypeValue(bundle), 2, 'BLR always records indirect-call BTYPE');
  const writes = bundle.operations.filter((operation) => operation.kind === 'register-write').map((operation) => operation.register.registerId);
  assert.ok(writes.includes('x30'), 'BLR still writes the link register');
  assert.ok(writes.includes(ARM64_BTYPE_REGISTER_ID), 'BLR also defines the BTYPE consumed at the landing pad');
}

{
  const direct = liftArm64ControlEffects(instruction('b', '#0x9000', { branchTarget:0x9000n }));
  assert.equal(direct.completeness, 'exact');
  assert.equal(btypeValue(direct), 0, 'direct B resets BTYPE instead of inheriting a stale indirect-branch state');

  const conditional = liftArm64ControlEffects(instruction('b.eq', '#0x9010', { branchTarget:0x9010n }));
  assert.equal(conditional.completeness, 'exact');
  assert.equal(btypeValue(conditional), 0, 'direct conditional branches also reset BTYPE');
}

{
  const br = liftArm64ControlEffects(instruction('br', 'x16'));
  const btiInsn = instruction('bti', 'j');
  btiInsn.ops = [{ k:'other', text:'j' }];
  const bti = liftArm64SystemEffects(btiInsn);
  const btiRead = bti.operations.find((operation) => operation.kind === 'register-read' && operation.register.registerId === ARM64_BTYPE_REGISTER_ID);
  assert.ok(btiRead, 'BTI must consume the same canonical PSTATE.BTYPE identity written by BR/BLR');

  const brIr = lowerMachineEffectBundleToSemanticIr(br, { functionId:'btype-producer', blockId:'entry', addressWidthBits:64 });
  const btiIr = lowerMachineEffectBundleToSemanticIr(bti, { functionId:'btype-consumer', blockId:'entry', addressWidthBits:64 });
  const producer = brIr.nodes.find((node) => node.kind === 'state-write' && node.variable?.physicalIdentity?.registerId === ARM64_BTYPE_REGISTER_ID);
  const consumer = btiIr.nodes.find((node) => node.kind === 'state-read' && node.variable?.physicalIdentity?.registerId === ARM64_BTYPE_REGISTER_ID);
  assert.ok(producer, 'Semantic IR must retain the branch-side BTYPE definition');
  assert.ok(consumer, 'Semantic IR must retain the BTI-side BTYPE use');
  assert.equal(producer.variable.key, consumer.variable.key, 'producer and consumer lower to one physical-state identity for SSA/def-use');
}

{
  const register = ARM64_ARCHITECTURE.registerFile().find((entry) => entry.id === ARM64_BTYPE_REGISTER_ID);
  assert.deepEqual(register, { id:'pstate.btype', bits:2, kind:'system-state' }, 'architecture register file exposes the canonical typed BTYPE state');
}

{
  const branch = instruction('braa', 'x16, x5', { mode:'arm64e' });
  const branchBundle = ARM64E_ARCHITECTURE.liftExact(branch);
  assert.equal(branchBundle.completeness, 'exact-with-intrinsic');
  assert.equal(btypeValue(branchBundle), 1, 'authenticated indirect branch shares BR BTYPE semantics');

  const guardedBranch = instruction('braa', 'x4, x5', { mode:'arm64e' });
  const guardedBundle = ARM64E_ARCHITECTURE.liftExact(guardedBranch, guarded(true));
  assert.equal(guardedBundle.completeness, 'exact-with-intrinsic');
  assert.equal(btypeValue(guardedBundle), 3, 'authenticated BR uses the same guarded-page rule');

  const call = instruction('blraaz', 'x6', { mode:'arm64e' });
  const callBundle = ARM64E_ARCHITECTURE.liftExact(call);
  assert.equal(callBundle.completeness, 'exact-with-intrinsic');
  assert.equal(btypeValue(callBundle), 2, 'authenticated indirect call shares BLR BTYPE semantics');
}

console.log('arm64 PSTATE.BTYPE producer/consumer effects: PASS');
