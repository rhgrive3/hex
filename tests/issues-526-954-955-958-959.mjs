import assert from 'node:assert/strict';
import { classifyAAPCS64Arguments } from '../js/targets/abi/aapcs64.js';
import { classifyDarwinArm64Arguments, DARWIN_ARM64_ABI } from '../js/targets/abi/darwin-arm64.js';
import {
  classifyMicrosoftX64Arguments,
  classifyMicrosoftX64CallReturn,
} from '../js/targets/abi/microsoft-x64.js';
import {
  classifyMicrosoftVectorcallArguments,
  classifyMicrosoftVectorcallCallReturn,
} from '../js/targets/abi/microsoft-vectorcall.js';
import { resolveABIPlugin } from '../js/targets/abi/index.js';

// #526: an unknown AAPCS64 call must conservatively retain both GP/SIMD
// register candidates and the possibility of pointer-bearing stack arguments.
{
  const result = classifyAAPCS64Arguments({});
  assert.equal(result.stackArgsUnknown, true);
  assert.equal(result.stackArgsMayContainPointers, true);
  assert.ok(result.srcs.some((source) => source.reg === 'x0' && source.possible === true && source.mustUse === false));
  assert.ok(result.srcs.some((source) => source.reg === 'v0' && source.possible === true && source.mustUse === false));
}

// #526: the ninth integer-class pointer is an explicit stack argument and must
// remain visible to escape/MemorySSA consumers.
{
  const result = classifyAAPCS64Arguments({ callPrototype:{
    args:[
      ...Array.from({ length:8 }, () => ({ type:'uint64_t', bits:64 })),
      { type:'void *', bits:64, pointer:true },
    ],
  } });
  const arg9 = result.arguments.find((argument) => argument.index === 8);
  assert.equal(arg9.location, 'stack');
  assert.equal(arg9.offset, 0);
  assert.equal(arg9.pointer, true);
  assert.equal(result.stackArgsMayContainPointers, true);
}

// #526: HFA dependencies remain explicit in the SIMD register use set.
{
  const result = classifyAAPCS64Arguments({ callPrototype:{ args:[{ type:'float4', hfa:true, members:4, bits:32 }] } });
  assert.deepEqual(result.arguments[0].regs, ['v0','v1','v2','v3']);
  assert.deepEqual(result.srcs.map((source) => source.reg), ['v0','v1','v2','v3']);
}

// #958: known variadic prototypes retain the unconsumed GP/FP frontier as
// possible inputs rather than pretending the fixed parameter list is complete.
{
  const result = classifyAAPCS64Arguments({ callPrototype:{
    args:[{ type:'const char *', bits:64, pointer:true }],
    variadic:true,
  } });
  assert.ok(result.srcs.some((source) => source.reg === 'x0' && source.mustUse === true));
  assert.ok(result.srcs.some((source) => source.reg === 'x1' && source.possible === true && source.mustUse === false));
  assert.ok(result.srcs.some((source) => source.reg === 'v0' && source.possible === true && source.mustUse === false));
  assert.equal(result.stackArgsUnknown, true);
  assert.equal(result.stackArgsMayContainPointers, true);
}

// #959: Darwin is a distinct semantic ABI identity and generic Linux remains
// on AAPCS64.
{
  const darwin = resolveABIPlugin({ architecture:'arm64', platform:'darwin' });
  const linux = resolveABIPlugin({ architecture:'arm64', platform:'linux' });
  assert.equal(darwin.id, 'darwin-arm64');
  assert.equal(linux.id, 'aapcs64');
  assert.notEqual(darwin.semanticIdentity, linux.semanticIdentity);
  assert.equal(DARWIN_ARM64_ABI.redZone(), 128);
  assert.deepEqual(DARWIN_ARM64_ABI.stackRules().reservedRegisters, ['x18']);
}

// #959: Apple stack arguments use compact type-sized slots.
{
  const result = classifyDarwinArm64Arguments({ callPrototype:{
    args:Array.from({ length:10 }, () => ({ type:'char', bits:8 })),
  } });
  const ninth = result.arguments[8];
  const tenth = result.arguments[9];
  assert.equal(ninth.location, 'stack');
  assert.equal(ninth.offset, 0);
  assert.equal(ninth.bytes, 1);
  assert.equal(tenth.offset, 1);
  assert.equal(tenth.bytes, 1);
}

// #959: Apple permits a 128-bit integer to start at odd NGRN.
{
  const result = classifyDarwinArm64Arguments({ callPrototype:{
    args:[{ type:'uint64_t', bits:64 }, { type:'__int128', bits:128, alignmentBytes:16 }],
  } });
  assert.equal(result.arguments[0].reg, 'x0');
  assert.deepEqual(result.arguments[1].regs, ['x1','x2']);
}

// #959: Apple anonymous variadic arguments are stack-only; do not inherit the
// generic AAPCS64 register-save-area frontier from #958.
{
  const result = classifyDarwinArm64Arguments({ callPrototype:{
    args:[{ type:'const char *', bits:64, pointer:true }],
    variadic:true,
  } });
  assert.deepEqual(result.possibleRegisterInputs, []);
  assert.equal(result.variadicTail.location, 'stack');
  assert.equal(result.variadicTail.slotAlignmentBytes, 8);
  assert.equal(result.stackArgsUnknown, true);
}

// #954: convention evidence participates in resolution. Standard Win64 cannot
// silently consume __vectorcall.
{
  const standard = resolveABIPlugin({ architecture:'x86_64', platform:'windows', callingConvention:'win64' });
  const vectorcall = resolveABIPlugin({ architecture:'x86_64', platform:'windows', callingConvention:'__vectorcall' });
  assert.equal(standard.id, 'microsoft-x64');
  assert.equal(vectorcall.id, 'microsoft-vectorcall');
  assert.notEqual(standard.semanticIdentity, vectorcall.semanticIdentity);

  const rejected = classifyMicrosoftX64Arguments({ callPrototype:{
    callingConvention:'__vectorcall',
    args:[{ type:'__m128', bits:128, vector:true }],
  } });
  assert.equal(rejected.unsupported, true);
  assert.equal(rejected.partial, true);
  assert.equal(rejected.srcs.length, 0);
}

// #954: vectorcall vectors are values in XMM/YMM registers, not standard-Win64
// by-reference GPR arguments.
{
  const result = classifyMicrosoftVectorcallArguments({ callPrototype:{
    callingConvention:'__vectorcall',
    args:[
      { type:'__m128', bits:128, vector:true },
      { type:'__m128', bits:128, vector:true },
      { type:'__m256', bits:256, vector:true },
    ],
  } });
  assert.deepEqual(result.arguments.map((argument) => argument.reg), ['xmm0','xmm1','ymm2']);
  assert.deepEqual(result.arguments.map((argument) => argument.pointer), [false,false,false]);

  const returned = classifyMicrosoftVectorcallCallReturn({ callPrototype:{
    callingConvention:'__vectorcall', returnType:'__m256', returnBits:256, returnsValue:true,
  } });
  assert.equal(returned.reg, 'ymm0');
  assert.equal(returned.bits, 256);
}

// #955: ABI derives mandatory hidden sret from authoritative aggregate layout;
// callers do not have to precompute indirectResult=true.
{
  const prototype = {
    returnType:'struct Pair', aggregate:true, returnBits:128, returnTrivialForCalls:true,
    args:[{ type:'uint64_t', bits:64 }],
  };
  const args = classifyMicrosoftX64Arguments({ callPrototype:prototype });
  assert.equal(args.arguments[0].role, 'indirect-result');
  assert.equal(args.arguments[0].reg, 'rcx');
  assert.equal(args.arguments[1].reg, 'rdx');
  const returned = classifyMicrosoftX64CallReturn({ callPrototype:prototype });
  assert.equal(returned.indirect, true);
  assert.deepEqual(returned.hiddenResultPointer, { input:'rcx', returned:'rax', callerAllocated:true });
}

// #955: the position bias moves the fourth user argument to the stack.
{
  const result = classifyMicrosoftX64Arguments({ callPrototype:{
    returnType:'struct Pair', aggregate:true, returnBits:128, returnTrivialForCalls:true,
    args:Array.from({ length:4 }, () => ({ type:'uint64_t', bits:64 })),
  } });
  assert.deepEqual(result.arguments.slice(0,4).map((argument) => argument.reg ?? null), ['rcx','rdx','r8','r9']);
  const fourthUser = result.arguments.find((argument) => argument.index === 3);
  assert.equal(fourthUser.location, 'stack');
  assert.equal(fourthUser.offset, 32);
}

// Direct-return control remains direct.
{
  const prototype = {
    returnType:'struct Tiny', aggregate:true, returnBits:64, returnTrivialForCalls:true,
    args:[{ type:'uint64_t', bits:64 }],
  };
  const args = classifyMicrosoftX64Arguments({ callPrototype:prototype });
  assert.equal(args.arguments[0].reg, 'rcx');
  assert.equal(args.arguments.some((argument) => argument.role === 'indirect-result'), false);
  const returned = classifyMicrosoftX64CallReturn({ callPrototype:prototype });
  assert.equal(returned.reg, 'rax');
  assert.equal(returned.bits, 64);
  assert.equal(returned.indirect, undefined);
}

console.log('issues #526/#954/#955/#958/#959 ABI regressions: PASS');
