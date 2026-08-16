import assert from 'node:assert/strict';
import { parseOperands } from '../../js/arm64.js';
import { OP } from '../../js/ir-core.js';
import { lowerMachineEffectsToLegacyV1 } from '../../js/semantics/compat/index.js';
import { ARM64_ARCHITECTURE } from '../../js/targets/architecture/index.js';

let address = 0x7000n;
function instruction(mnemonic, operands = '', extra = {}) {
  const current = address;
  address += 4n;
  const instructionId = `compat-shadow:${mnemonic}:${current.toString(16)}`;
  return {
    mnemonic,
    operands,
    ops:parseOperands(operands),
    address:current,
    mode:'a64',
    instructionId,
    origin:{ instructionIds:[instructionId] },
    ...extra,
  };
}

{
  const bundle = ARM64_ARCHITECTURE.liftExact(instruction('add', 'x0, x1, x2'));
  const lowered = lowerMachineEffectsToLegacyV1(bundle);
  assert.ok(lowered.some((item) => item.op === OP.BIN && item.sub === 'add'));
  assert.equal(lowered.some((item) => item.op === OP.UNKNOWN && /add-with-carry|extract-bit|is-zero/.test(String(item.reason))), false);
}

{
  const bundle = ARM64_ARCHITECTURE.liftExact(instruction('sub', 'x3, x4, x5'));
  const lowered = lowerMachineEffectsToLegacyV1(bundle);
  const arithmetic = lowered.find((item) => item.op === OP.BIN && item.sub === 'sub');
  assert.ok(arithmetic);
  assert.equal(arithmetic.srcs[0].reg, '$me:compat-shadow:sub:7004:read-x4:1');
  assert.equal(arithmetic.srcs[1].reg, '$me:compat-shadow:sub:7004:read-x5:2');
  assert.equal(lowered.some((item) => item.op === OP.UNKNOWN && /add-with-carry|extract-bit|is-zero/.test(String(item.reason))), false);
}

{
  const decoded = instruction('ldr', 'x0, [x1, #16]', { memory:{ kind:'load', size:8, stack:false } });
  const bundle = ARM64_ARCHITECTURE.liftExact(decoded);
  const lowered = lowerMachineEffectsToLegacyV1(bundle);
  const load = lowered.find((item) => item.op === OP.LOAD);
  assert.ok(load);
  assert.equal(load.addr.base, '$me:addr.base');
  assert.equal(load.addr.disp, 16n);
}

{
  const decoded = instruction('b', '#0x9000', { branchTarget:0x9000n });
  const bundle = ARM64_ARCHITECTURE.liftExact(decoded);
  const lowered = lowerMachineEffectsToLegacyV1(bundle);
  const branch = lowered.find((item) => item.op === OP.BR);
  assert.ok(branch);
  assert.equal(branch.target, 0x9000n);
  assert.equal(branch.indirect, false);
}

console.log('MachineEffects v1 shadow compatibility regressions: PASS');
