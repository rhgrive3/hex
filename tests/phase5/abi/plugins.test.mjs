import assert from 'node:assert/strict';
import test from 'node:test';
import {
  SYSV_AMD64_ABI,
  classifySysVAMD64Arguments,
  classifySysVAMD64FunctionReturn,
} from '../../../js/targets/abi/sysv-amd64.js';
import {
  MICROSOFT_X64_ABI,
  classifyMicrosoftX64Arguments,
  classifyMicrosoftX64FunctionReturn,
} from '../../../js/targets/abi/microsoft-x64.js';

test('SysV assigns explicit aggregate eightbytes without splitting physical register identity', () => {
  const result = classifySysVAMD64Arguments({ callPrototype:{ args:[
    { type:'struct pair', aggregate:true, bits:128, eightbyteClasses:['INTEGER','INTEGER'] },
    { type:'int' },
  ] } });
  assert.equal(result.partial, false);
  assert.deepEqual(result.arguments[0].regs, ['rdi','rsi']);
  assert.deepEqual(result.arguments[0].pieces.map(({ abiClass, reg }) => ({ abiClass, reg })), [
    { abiClass:'INTEGER', reg:'rdi' },
    { abiClass:'INTEGER', reg:'rsi' },
  ]);
  assert.equal(result.arguments[1].reg, 'rdx');
});

test('SysV uses independent INTEGER/SSE register sequences for mixed aggregates', () => {
  const result = classifySysVAMD64Arguments({ callPrototype:{ args:[
    { type:'struct mixed', aggregate:true, bits:128, eightbyteClasses:['INTEGER','SSE'] },
    { type:'double' },
    { type:'int' },
  ] } });
  assert.deepEqual(result.arguments[0].regs, ['rdi','xmm0']);
  assert.equal(result.arguments[1].reg, 'xmm1');
  assert.equal(result.arguments[2].reg, 'rsi');
});

test('SysV rolls back an aggregate that does not wholly fit in registers', () => {
  const result = classifySysVAMD64Arguments({ callPrototype:{ args:[
    ...Array.from({ length:5 }, () => ({ type:'int' })),
    { type:'struct pair', aggregate:true, bits:128, eightbyteClasses:['INTEGER','INTEGER'] },
    { type:'int' },
  ] } });
  assert.equal(result.arguments[5].location, 'stack');
  assert.equal(result.arguments[5].abiClass, 'aggregate-memory');
  assert.equal(result.arguments[6].reg, 'r9');
});

test('SysV keeps unclassified aggregates explicit and makes later allocation conservative', () => {
  const result = classifySysVAMD64Arguments({ callPrototype:{ args:[
    { type:'struct opaque', aggregate:true, bits:128 },
    { type:'int' },
  ] } });
  assert.equal(result.partial, true);
  assert.equal(result.arguments[0].abiClass, 'aggregate-partial');
  assert.equal(result.arguments[1].abiClass, 'allocation-after-unclassified-aggregate');
  assert.equal(result.stackArgsUnknown, true);
});

test('SysV models invisible references and indirect-result register shifting', () => {
  const indirectArgument = classifySysVAMD64Arguments({ callPrototype:{ args:[
    { type:'class value', aggregate:true, bits:256, nonTrivialForCalls:true },
  ] } });
  assert.deepEqual(indirectArgument.arguments[0], {
    index:0, location:'register', reg:'rdi', abiClass:'invisible-reference', pointer:true,
    bits:64, pointeeBits:256, hiddenIndirection:true,
  });

  const sret = classifySysVAMD64Arguments({ callPrototype:{ indirectResult:true, args:[{ type:'int' }] } });
  assert.equal(sret.arguments[0].role, 'indirect-result');
  assert.equal(sret.arguments[0].reg, 'rdi');
  assert.equal(sret.arguments[1].reg, 'rsi');
  assert.deepEqual(classifySysVAMD64FunctionReturn({ functionPrototype:{ indirectResult:true } }), {
    reg:'rax', bits:64, indirect:true, hiddenResultPointer:{ input:'rdi', returned:'rax' },
  });
});

test('SysV returns explicit INTEGER and SSE aggregate pieces through canonical return registers', () => {
  const integer = classifySysVAMD64FunctionReturn({
    functionPrototype:{ aggregate:true, returnBits:128, returnEightbyteClasses:['INTEGER','INTEGER'] },
  });
  assert.deepEqual(integer.regs, ['rax','rdx']);
  assert.equal(integer.aggregate, true);
  const vector = classifySysVAMD64FunctionReturn({
    functionPrototype:{ aggregate:true, returnBits:128, returnEightbyteClasses:['SSE','SSEUP'] },
  });
  assert.deepEqual(vector.regs, ['xmm0']);
  assert.equal(vector.pieces[1].byteOffset, 8);
});

test('Microsoft default x64 passes proven aggregates exactly or by reference', () => {
  const result = classifyMicrosoftX64Arguments({ callPrototype:{ args:[
    { type:'struct word', aggregate:true, bits:32, trivialForCalls:true },
    { type:'struct wide', aggregate:true, bits:128, trivialForCalls:true },
    { type:'__m128', vector:true, bits:128 },
  ] } });
  assert.equal(result.partial, false);
  assert.deepEqual(result.arguments.slice(0, 3).map((argument) => argument.reg), ['rcx','rdx','r8']);
  assert.equal(result.arguments[0].abiClass, 'integer-aggregate');
  assert.equal(result.arguments[0].pointer, false);
  assert.equal(result.arguments[1].abiClass, 'aggregate-indirect');
  assert.equal(result.arguments[1].pointeeBits, 128);
  assert.equal(result.arguments[2].abiClass, 'vector-indirect');
  assert.ok(!result.srcs.some((source) => source.reg === 'xmm2'));
});

test('Microsoft keeps aggregate layout unknown without proven size/triviality', () => {
  const result = classifyMicrosoftX64Arguments({ callPrototype:{ args:[{ type:'struct opaque', aggregate:true }] } });
  assert.equal(result.partial, true);
  assert.equal(result.arguments[0].location, 'unknown');
  assert.equal(result.arguments[0].abiClass, 'aggregate-unclassified-partial');
  assert.deepEqual(result.arguments[0].candidateRegisters, ['rcx','xmm0']);
});

test('Microsoft hidden result pointer consumes RCX and shifts positional FP registers', () => {
  const result = classifyMicrosoftX64Arguments({ callPrototype:{
    indirectResult:true,
    args:[{ type:'int' }, { type:'double' }, { type:'int' }, { type:'int' }],
  } });
  assert.equal(result.arguments[0].role, 'indirect-result');
  assert.equal(result.arguments[0].reg, 'rcx');
  assert.equal(result.arguments[1].reg, 'rdx');
  assert.equal(result.arguments[2].reg, 'xmm2');
  assert.equal(result.arguments[3].reg, 'r9');
  assert.equal(result.arguments[4].location, 'stack');
  assert.equal(result.arguments[4].offset, 32);
  assert.deepEqual(classifyMicrosoftX64FunctionReturn({ functionPrototype:{ indirectResult:true } }), {
    reg:'rax', bits:64, indirect:true, hiddenResultPointer:{ input:'rcx', returned:'rax' },
  });
});

test('Microsoft aggregate returns are exact only with proven trivial size', () => {
  assert.deepEqual(classifyMicrosoftX64FunctionReturn({
    functionPrototype:{ aggregate:true, returnBits:64, trivialForCalls:true },
  }), { reg:'rax', bits:64, aggregate:true, abiClass:'integer-aggregate' });
  assert.equal(classifyMicrosoftX64FunctionReturn({
    functionPrototype:{ aggregate:true, returnBits:128, trivialForCalls:true },
  }).partial, true);
});

test('both ABIs retain conservative unknown-call and platform stack rules', () => {
  assert.equal(SYSV_AMD64_ABI.semanticVersion, '2');
  assert.equal(MICROSOFT_X64_ABI.semanticVersion, '2');
  assert.equal(SYSV_AMD64_ABI.defaultUnknownCallEffects().memoryEffects, 'unknown');
  assert.equal(MICROSOFT_X64_ABI.defaultUnknownCallEffects().memoryEffects, 'unknown');
  assert.equal(SYSV_AMD64_ABI.stackRules().directionFlag, 'clear-on-entry-and-return');
  assert.equal(MICROSOFT_X64_ABI.stackRules().shadowSpaceBytes, 32);
  assert.equal(MICROSOFT_X64_ABI.stackRules().redZoneBytes, 0);
  assert.deepEqual(MICROSOFT_X64_ABI.stackRules().mxcsrVolatileBits, [0,1,2,3,4,5]);
  assert.equal(MICROSOFT_X64_ABI.defaultUnknownCallEffects().vectorUpperEffects, 'clobbered');
});
