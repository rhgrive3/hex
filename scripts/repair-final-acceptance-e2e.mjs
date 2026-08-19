import fs from 'node:fs/promises';

const path = 'tests/phase6/generic-core/issues-907-909-910-913.test.mjs';
let source = await fs.readFile(path, 'utf8');
function replaceOnce(before, after) {
  const first = source.indexOf(before);
  if (first < 0) throw new Error(`missing final acceptance anchor: ${before.slice(0,140)}`);
  if (source.indexOf(before, first + before.length) >= 0) throw new Error(`ambiguous final acceptance anchor: ${before.slice(0,140)}`);
  source = source.slice(0, first) + after + source.slice(first + before.length);
}

replaceOnce(
`import { semanticAbiAdapter } from '../../../js/analysis/semantic-function.js';`,
`import { analyzeDecodedSemanticFunction, semanticAbiAdapter } from '../../../js/analysis/semantic-function.js';`);
replaceOnce(
`import { createRiscv64DecodedInstruction } from '../../../js/targets/architecture/riscv64/decoded-instruction.js';`,
`import { createRiscv64DecodedInstruction } from '../../../js/targets/architecture/riscv64/decoded-instruction.js';
import { createX86DecodedInstruction } from '../../../js/targets/architecture/x86_64/decoded-instruction.js';`);

replaceOnce(
`test('#907 IALIGN=16 does not invent instruction-address-misaligned faults', () => {
  const branch = liftRiscv64ControlEffects(rvControl('beq'), { instructionAlignment:2 });
  assert.deepEqual(branch.possibleFaults, []);
  const jal = liftRiscv64ControlEffects(rvControl('jal'), { instructionAlignment:2 });
  assert.deepEqual(jal.possibleFaults, []);
  const jalr = liftRiscv64ControlEffects(rvControl('jalr', { imm:0 }), { instructionAlignment:2 });
  assert.deepEqual(jalr.possibleFaults, []);
});`,
`test('#907 IALIGN=16 does not invent instruction-address-misaligned faults', () => {
  const branchPcPlus2 = liftRiscv64ControlEffects(rvControl('beq', { imm:2 }), { instructionAlignment:2 });
  assert.deepEqual(branchPcPlus2.possibleFaults, []);
  const jalPcPlus2 = liftRiscv64ControlEffects(rvControl('jal', { imm:2 }), { instructionAlignment:2 });
  assert.deepEqual(jalPcPlus2.possibleFaults, []);
  const jalrOddPreMask = liftRiscv64ControlEffects(rvControl('jalr', { imm:1 }), { instructionAlignment:2 });
  assert.deepEqual(jalrOddPreMask.possibleFaults, []);
  const ordinaryAligned = liftRiscv64ControlEffects(rvControl('beq', { imm:4 }), { instructionAlignment:2 });
  assert.deepEqual(ordinaryAligned.possibleFaults, []);
});`);

replaceOnce(
`  assert.equal(compressed.size, 2);
  assert.equal(compressed.mode, 'rv64imc');
  assert.equal(compressed.instructionAlignment, 2);
  assert.equal(compressed.isaEvidence, 'elf-attribute');`,
`  assert.equal(compressed.size, 2);
  assert.equal(compressed.mode, 'rv64imc');
  assert.equal(compressed.instructionAlignment, 2);
  assert.equal(compressed.isaEvidence, 'elf-attribute');
  assert.equal(compressed.fields.supported, true);
  assert.equal(compressed.fields.compressed, true);
  assert.equal(compressed.compressed, true);`);

if (!source.includes("#913 Semantic IR -> compat -> shared Decompiler honors RISC-V and SysV ABI registers")) {
  source += `\n\nfunction rvDecoded(address, bytes, instructionId) {\n  return createRiscv64DecodedInstruction({\n    address, size:bytes.length, rawBytes:Uint8Array.from(bytes), mode:'rv64imc', instructionId,\n    origin:{ instructionIds:[instructionId] },\n  });\n}\n\nfunction x86Decoded({ address, bytes, instructionId, family, operands = [] }) {\n  return createX86DecodedInstruction({\n    address, length:bytes.length, rawBytes:Uint8Array.from(bytes), mode:'long-64',\n    instructionId, instructionCode:family === 'ret' ? 2 : 1, instructionFamily:family,\n    detailAvailable:true, detailStatus:'complete',\n    detail:{ operandCount:operands.length, operands }, mnemonic:family,\n  });\n}\n\ntest('#913 Semantic IR -> compat -> shared Decompiler honors RISC-V and SysV ABI registers', () => {\n  const riscv = analyzeDecodedSemanticFunction({\n    architecture:'riscv64', platform:'linux', abiId:'lp64', mode:'rv64imc',\n    decoderSemanticVersion:'acceptance-riscv-v1', binaryId:'acceptance-riscv', sliceId:'0',\n    functionPrototype:{ returnType:'int64', parameters:[{ type:'int64' }] },\n    instructions:[\n      // addi a0, a0, 1\n      rvDecoded(0x1000n, [0x13,0x05,0x15,0x00], 'rv-addi-a0'),\n      // jalr x0, x1, 0 (ret)\n      rvDecoded(0x1004n, [0x67,0x80,0x00,0x00], 'rv-ret'),\n    ],\n  });\n  assert.equal(riscv.decompiler.semantic, true);\n  assert.match(riscv.decompiler.pseudocode, /return/);\n  assert.doesNotMatch(riscv.decompiler.pseudocode, /\\bx0\\b/, 'RISC-V must never inherit AAPCS64 x0 return/argument spelling');\n\n  const sysv = analyzeDecodedSemanticFunction({\n    architecture:'x86_64', platform:'linux', abiId:'sysv-amd64', mode:'long-64',\n    decoderSemanticVersion:'acceptance-x86-v1', binaryId:'acceptance-x86', sliceId:'0',\n    functionPrototype:{ returnType:'int64', parameters:[{ type:'int64' }] },\n    instructions:[\n      // mov rax, rdi\n      x86Decoded({ address:0x2000n, bytes:[0x48,0x89,0xf8], instructionId:'x86-mov-ret', family:'mov', operands:[\n        { type:'register', register:'rax', access:'write' },\n        { type:'register', register:'rdi', access:'read' },\n      ] }),\n      x86Decoded({ address:0x2003n, bytes:[0xc3], instructionId:'x86-ret', family:'ret' }),\n    ],\n  });\n  assert.equal(sysv.decompiler.semantic, true);\n  assert.match(sysv.decompiler.pseudocode, /return/);\n  assert.doesNotMatch(sysv.decompiler.pseudocode, /\\bx0\\b|\\bv0\\b/, 'x86 must never inherit AAPCS64 register spelling');\n});\n`;
}

await fs.writeFile(path, source);
console.log('final #907/#909/#913 acceptance and cross-architecture semantic E2E staged');
