import assert from 'node:assert/strict';
import test from 'node:test';
import { partitionDecodedFunction, analyzeDecodedSemanticFunction } from '../../../js/analysis/semantic-function.js';
import { architecturePluginV2 } from '../../../js/targets/architecture/index.js';
import { liftRiscv64SystemEffects } from '../../../js/targets/architecture/riscv64/effects/system.js';
import { liftX86ControlEffects } from '../../../js/targets/architecture/x86_64/effects/control.js';

const rv = architecturePluginV2('riscv64');
const x86 = architecturePluginV2('x86_64');
const arm = architecturePluginV2('arm64');

test('unsupported RISC-V control is an unknown terminator with no invented fallthrough (#890)', () => {
  const blocks = partitionDecodedFunction([
    { address:0x1000n, size:4, fields:{ supported:false }, mnemonic:'mret' },
    { address:0x1004n, size:4, fields:{ supported:true, op:'addi' }, mnemonic:'addi' },
  ], rv);
  assert.equal(blocks.length, 2);
  assert.deepEqual(blocks[0].successors, []);
});

test('explicit big-endian input is rejected by the little-endian RISC-V profile (#891)', () => {
  assert.deepEqual(rv.supportedMemoryEndianness, ['little']);
  assert.throws(() => analyzeDecodedSemanticFunction({
    architecture:'riscv64', platform:'linux', abiId:'lp64', endian:'big',
    binaryId:'binary-test', sliceId:'slice-test', decoderSemanticVersion:'test', instructions:[],
  }), /semantic-function-unsupported-memory-endianness:big/);
});

test('x86 LOOP and UD2 control classification does not fabricate fallthrough (#892)', () => {
  const loopBlocks = partitionDecodedFunction([
    { address:0x2000n, size:2, instructionFamily:'loop', detail:{ operands:[{ type:'immediate', value:0x2004n }] } },
    { address:0x2002n, size:2, instructionFamily:'nop', detail:{ operands:[] } },
    { address:0x2004n, size:1, instructionFamily:'ret', detail:{ operands:[] } },
  ], x86);
  assert.deepEqual(new Set(loopBlocks[0].successors.map((edge) => edge.kind)), new Set(['conditional-true','conditional-false']));
  const trapBlocks = partitionDecodedFunction([
    { address:0x2100n, size:2, instructionFamily:'ud2', detail:{ operands:[] } },
    { address:0x2102n, size:1, instructionFamily:'nop', detail:{ operands:[] } },
  ], x86);
  assert.deepEqual(trapBlocks[0].successors, []);
});

test('x86 LOOP MachineEffects decrement count and retain the conditional transfer (#892)', () => {
  const bundle = liftX86ControlEffects({
    instructionId:'loop-test', address:0x2200n, length:2, size:2, mode:'long-64', rawBytes:[0xe2,0x02],
    instructionCode:1, instructionFamily:'loop', mnemonic:'loop', detailAvailable:true,
    detail:{ operands:[{ type:'immediate', value:0x2204n, encodedWidthBits:8, access:'read' }], prefixes:{ legacy:[] } },
  });
  assert.equal(bundle.controlEffect.kind, 'conditional-branch');
  assert.equal(bundle.metadata.countRegister, 'rcx');
  assert.equal(bundle.metadata.countDecremented, true);
  assert.ok(bundle.operations.some((op) => op.kind === 'register-write' && op.metadata?.view === 'rcx'));
});

test('ARM64 exception-return/trap instructions terminate normal CFG flow (#893)', () => {
  for (const mnemonic of ['eret','eretaa','eretab','brk','svc','hvc','smc']) {
    const blocks = partitionDecodedFunction([
      { address:0x3000n, size:4, mnemonic },
      { address:0x3004n, size:4, mnemonic:'add' },
    ], arm);
    assert.equal(blocks.length, 2, mnemonic);
    assert.deepEqual(blocks[0].successors, [], mnemonic);
  }
});

function fence(fields, id) {
  const word = (BigInt(fields.fenceMode) << 28n)
    | (BigInt(fields.predecessor) << 24n)
    | (BigInt(fields.successor) << 20n)
    | 0x0fn;
  const rawBytes = Array.from({ length:4 }, (_unused, index) => Number((word >> BigInt(index * 8)) & 0xffn));
  return liftRiscv64SystemEffects({
    instructionId:id, address:0x4000n, size:4, mode:'rv64imc', rawBytes,
  });
}

test('FENCE.TSO requires the full canonical fm/pred/succ tuple (#895)', () => {
  const canonical = fence({ fenceMode:0b1000, predecessor:0b0011, successor:0b0011 }, 'fence-tso');
  const reservedSucc = fence({ fenceMode:0b1000, predecessor:0b0011, successor:0b0010 }, 'fence-reserved-succ');
  const reservedPred = fence({ fenceMode:0b1000, predecessor:0b0001, successor:0b0011 }, 'fence-reserved-pred');
  const otherFm = fence({ fenceMode:0b0111, predecessor:0b0011, successor:0b0011 }, 'fence-other-fm');
  const mode = (bundle) => bundle.operations.find((op) => op.kind === 'barrier').scope.fenceMode;
  assert.equal(mode(canonical), 'tso');
  assert.equal(mode(reservedSucc), 'normal');
  assert.equal(mode(reservedPred), 'normal');
  assert.equal(mode(otherFm), 'normal');
});
