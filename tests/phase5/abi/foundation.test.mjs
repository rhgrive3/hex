import assert from 'node:assert/strict';
import {
  SYSV_AMD64_ABI,
  SYSV_AMD64_SCOPE,
} from '../../../js/targets/abi/sysv-amd64.js';
import {
  MICROSOFT_X64_ABI,
  MICROSOFT_X64_SCOPE,
} from '../../../js/targets/abi/microsoft-x64.js';

assert.equal(SYSV_AMD64_ABI.id, 'sysv-amd64');
assert.equal(SYSV_AMD64_ABI.architectureId, 'x86_64');
assert.equal(SYSV_AMD64_ABI.platformPredicate({ platform:'linux' }), true);
assert.equal(SYSV_AMD64_ABI.platformPredicate({ platform:'windows' }), false);

{
  const classified = SYSV_AMD64_ABI.classifyArguments({
    callPrototype:{
      args:[
        { type:'int' },
        { type:'double' },
        { type:'int *' },
        { type:'float' },
      ],
      returnType:'double',
    },
  });
  assert.deepEqual(classified.arguments.map((argument) => argument.reg), ['rdi','xmm0','rsi','xmm1']);
  assert.deepEqual(classified.srcs.map((source) => source.reg), ['rdi','xmm0','rsi','xmm1']);
  assert.equal(classified.arguments[2].bits, 64);
  assert.equal(classified.partial, false);
  assert.deepEqual(SYSV_AMD64_ABI.classifyCallReturn({ callPrototype:{ returnType:'double' } }), { reg:'xmm0', bits:64 });
  assert.deepEqual(SYSV_AMD64_ABI.classifyFunctionReturn({ functionPrototype:{ returnType:'int' } }), { reg:'rax', bits:32 });
  assert.deepEqual(SYSV_AMD64_ABI.classifyFunctionReturn({ returnsValue:true, returnBits:64 }), { reg:'rax', bits:64 });
}

{
  const classified = SYSV_AMD64_ABI.classifyArguments({
    callPrototype:{ args:Array.from({ length:7 }, () => ({ type:'int' })) },
  });
  assert.deepEqual(classified.arguments.slice(0, 6).map((argument) => argument.reg), ['rdi','rsi','rdx','rcx','r8','r9']);
  assert.equal(classified.stackArguments[0].offset, 0);
  assert.equal(classified.stackArguments[0].calleeEntryOffset, 8);
}

{
  const classified = SYSV_AMD64_ABI.classifyArguments({
    callPrototype:{ args:[{ type:'int' }, { type:'double' }], variadic:true },
  });
  assert.equal(classified.partial, true);
  assert.equal(classified.stackArgsUnknown, true);
  assert.equal(classified.stackArgsMayContainPointers, true);
  assert.equal(classified.variadicVectorRegisterCount, 1);
  assert.deepEqual(classified.implicitInputs, [{ t:'reg', reg:'rax', view:'al', bits:8, purpose:'sse-register-argument-count' }]);
  assert.equal(classified.scope, SYSV_AMD64_SCOPE);
}

{
  const classified = SYSV_AMD64_ABI.classifyArguments({
    callPrototype:{ args:[{ type:'struct pair', aggregate:true, bits:128 }] },
  });
  assert.equal(classified.partial, true);
  assert.equal(classified.aggregateClassification, 'partial-unproven');
  assert.equal(classified.arguments[0].location, 'unknown');
  assert.equal(classified.stackArgsMayContainPointers, true);
}

{
  const unknown = SYSV_AMD64_ABI.classifyArguments({});
  assert.deepEqual(unknown.srcs.slice(0, 6).map((source) => source.reg), ['rdi','rsi','rdx','rcx','r8','r9']);
  assert.deepEqual(unknown.srcs.slice(6).map((source) => source.reg), ['xmm0','xmm1','xmm2','xmm3','xmm4','xmm5','xmm6','xmm7']);
  assert.equal(unknown.stackArgsUnknown, true);
  assert.equal(unknown.stackArgsMayContainPointers, true);
  assert.equal(SYSV_AMD64_ABI.redZone(), 128);
  assert.equal(SYSV_AMD64_ABI.stackRules().alignment, 16);
  assert.equal(SYSV_AMD64_ABI.stackRules().shadowSpaceBytes, 0);
  assert.ok(SYSV_AMD64_ABI.callerSaved().includes('xmm15'));
  assert.ok(SYSV_AMD64_ABI.calleeSaved().includes('r12'));
  assert.equal(SYSV_AMD64_ABI.defaultUnknownCallEffects().memoryEffects, 'unknown');
  assert.equal(SYSV_AMD64_ABI.defaultUnknownCallEffects().mayThrow, true);
}

assert.equal(MICROSOFT_X64_ABI.id, 'microsoft-x64');
assert.equal(MICROSOFT_X64_ABI.architectureId, 'x86_64');
assert.equal(MICROSOFT_X64_ABI.platformPredicate({ platform:'windows' }), true);
assert.equal(MICROSOFT_X64_ABI.platformPredicate({ platform:'linux' }), false);

{
  const classified = MICROSOFT_X64_ABI.classifyArguments({
    callPrototype:{
      args:[
        { type:'int' },
        { type:'double' },
        { type:'int *' },
        { type:'float' },
        { type:'int' },
      ],
      returnType:'double',
    },
  });
  assert.deepEqual(classified.arguments.slice(0, 4).map((argument) => argument.reg), ['rcx','xmm1','r8','xmm3']);
  assert.equal(classified.arguments[2].bits, 64);
  assert.equal(classified.stackArguments[0].offset, 32);
  assert.equal(classified.stackArguments[0].calleeEntryOffset, 40);
  assert.equal(classified.partial, false);
  assert.deepEqual(MICROSOFT_X64_ABI.classifyCallReturn({ callPrototype:{ returnType:'double' } }), { reg:'xmm0', bits:64 });
  assert.deepEqual(MICROSOFT_X64_ABI.classifyFunctionReturn({ functionPrototype:{ returnType:'int' } }), { reg:'rax', bits:32 });
  assert.deepEqual(MICROSOFT_X64_ABI.classifyFunctionReturn({ returnsValue:true, returnBits:64 }), { reg:'rax', bits:64 });
}

{
  const classified = MICROSOFT_X64_ABI.classifyArguments({
    callPrototype:{ args:[{ type:'int' }, { type:'double' }], variadic:true },
  });
  assert.equal(classified.partial, true);
  assert.equal(classified.stackArgsUnknown, true);
  assert.equal(classified.stackArgsMayContainPointers, true);
  assert.equal(classified.arguments[1].reg, 'xmm1');
  assert.equal(classified.arguments[1].mirrorReg, 'rdx');
  assert.ok(classified.srcs.some((source) => source.reg === 'rdx' && source.purpose === 'variadic-floating-mirror'));
  assert.equal(classified.scope, MICROSOFT_X64_SCOPE);
}

{
  const classified = MICROSOFT_X64_ABI.classifyArguments({
    callPrototype:{ args:[{ type:'struct pair', aggregate:true, bits:128 }] },
  });
  assert.equal(classified.partial, false);
  assert.equal(classified.aggregateClassification, 'proven');
  assert.equal(classified.arguments[0].location, 'register');
  assert.equal(classified.arguments[0].reg, 'rcx');
  assert.equal(classified.arguments[0].abiClass, 'aggregate-indirect');
  assert.equal(classified.arguments[0].pointeeBits, 128);
}

{
  const classified = MICROSOFT_X64_ABI.classifyArguments({
    callPrototype:{ args:[{ type:'__m128', vector:true, bits:128 }] },
  });
  assert.equal(classified.partial, false);
  assert.equal(classified.arguments[0].abiClass, 'vector-indirect');
  assert.equal(classified.arguments[0].reg, 'rcx');
  assert.equal(classified.arguments[0].pointer, true);
  assert.equal(classified.scope.vectorArguments, 'exact-default-convention-by-reference-when-size-is-proven');
}

{
  const unknown = MICROSOFT_X64_ABI.classifyArguments({});
  assert.deepEqual(unknown.srcs.slice(0, 4).map((source) => source.reg), ['rcx','rdx','r8','r9']);
  assert.deepEqual(unknown.srcs.slice(4).map((source) => source.reg), ['xmm0','xmm1','xmm2','xmm3']);
  assert.equal(unknown.stackArgsUnknown, true);
  assert.equal(unknown.stackArgsMayContainPointers, true);
  assert.equal(MICROSOFT_X64_ABI.redZone(), 0);
  assert.equal(MICROSOFT_X64_ABI.stackRules().alignment, 16);
  assert.equal(MICROSOFT_X64_ABI.stackRules().shadowSpaceBytes, 32);
  assert.equal(MICROSOFT_X64_ABI.stackRules().firstStackArgumentOffset, 40);
  assert.deepEqual(MICROSOFT_X64_ABI.stackRules().nonvolatileVectorRegisters, ['xmm6','xmm7','xmm8','xmm9','xmm10','xmm11','xmm12','xmm13','xmm14','xmm15']);
  assert.ok(MICROSOFT_X64_ABI.callerSaved().includes('xmm5'));
  assert.ok(!MICROSOFT_X64_ABI.callerSaved().includes('xmm6'));
  assert.ok(MICROSOFT_X64_ABI.calleeSaved().includes('xmm6'));
  assert.equal(MICROSOFT_X64_ABI.defaultUnknownCallEffects().memoryEffects, 'unknown');
  assert.equal(MICROSOFT_X64_ABI.defaultUnknownCallEffects().mayThrow, true);
}

console.log('Phase 5 x86-64 ABI foundation tests passed');
