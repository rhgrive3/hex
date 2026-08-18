import test from 'node:test';
import assert from 'node:assert/strict';
import { architecturePluginV2 } from '../../../js/targets/architecture/index.js';
import { liftRiscv64ControlEffects } from '../../../js/targets/architecture/riscv64/effects/control.js';
import { partitionDecodedFunction, semanticAbiAdapter } from '../../../js/analysis/semantic-function.js';

function rv(op, fields = {}, address = 0x1000n) {
  return {
    instructionId:`${op}-${address.toString(16)}`,
    contractVersion:'riscv64-decoded-instruction/v1',
    address,
    size:4,
    length:4,
    mode:'rv64imc',
    origin:{ instructionIds:[`${op}-${address.toString(16)}`] },
    fields:{ supported:true, compressed:false, op, ...fields },
  };
}

test('issue #889: non-RAS link registers do not become ABI calls', () => {
  const plugin = architecturePluginV2('riscv64');
  assert.equal(plugin.classifyControlFlow(rv('jal', { rd:'x6', imm:8n })), 'branch');
  assert.equal(plugin.classifyControlFlow(rv('jal', { rd:'x1', imm:8n })), 'call');
  assert.equal(plugin.classifyControlFlow(rv('jal', { rd:'x5', imm:8n })), 'call');

  const direct = liftRiscv64ControlEffects(rv('jal', { rd:'x6', imm:8n }));
  assert.equal(direct.controlEffect.kind, 'branch');
  assert.equal(direct.metadata.jumpWithLinkage, true);
  assert.ok(direct.operations.some((operation) => operation.kind === 'register-write'));

  const indirect = liftRiscv64ControlEffects(rv('jalr', { rd:'x6', rs1:'x10', imm:0n }));
  assert.equal(indirect.controlEffect.kind, 'indirect');
  assert.equal(indirect.metadata.jumpWithLinkage, true);
  assert.ok(indirect.controlEffect.target);

  const realCall = liftRiscv64ControlEffects(rv('jalr', { rd:'x1', rs1:'x10', imm:0n }));
  assert.equal(realCall.controlEffect.kind, 'call');
});

test('issue #897: authoritative noreturn call has no normal CFG successor', () => {
  const plugin = {
    classifyControlFlow: (instruction) => instruction.kind,
    directControlTarget: () => null,
  };
  const instructions = [
    { address:0x1000n, size:4, length:4, kind:'call' },
    { address:0x1004n, size:4, length:4, kind:'fallthrough' },
    { address:0x1008n, size:4, length:4, kind:'return' },
  ];
  const blocks = partitionDecodedFunction(instructions, plugin, { callPrototype:{ noreturn:true } });
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].instructions.length, 1);
  assert.deepEqual(blocks[0].successors, []);

  const ordinary = partitionDecodedFunction(instructions, plugin, { callPrototype:{ noreturn:false } });
  assert.equal(ordinary[0].instructions.length, 3);
});

test('issue #897: call summary preserves typed noreturn evidence without conflating void', () => {
  const abi = {
    id:'test', semanticVersion:'1',
    stackRules:()=>({}), unwindRules:()=>({}),
    classifyArguments:()=>({ arguments:[], stackArguments:[], stackArgsUnknown:false, stackArgsMayContainPointers:false }),
    classifyCallReturn:()=>null,
    callerSaved:()=>[],
  };
  assert.equal(semanticAbiAdapter(abi, { callPrototype:{ noreturn:true, returnType:'void' } }).classifyCall({ call:{} }).noreturn, true);
  assert.equal(semanticAbiAdapter(abi, { callPrototype:{ noreturn:false, returnType:'void' } }).classifyCall({ call:{} }).noreturn, false);
  assert.equal(semanticAbiAdapter(abi, { callPrototype:{ returnType:'void', returnsValue:false } }).classifyCall({ call:{} }).noreturn, 'unknown');
});
