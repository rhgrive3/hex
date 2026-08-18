import assert from 'node:assert/strict';
import test from 'node:test';

import {
  RISCV_LP64_ABI as lp64,
  RISCV_LP64F_ABI as lp64f,
  RISCV_LP64D_ABI as lp64d,
} from '../../../js/targets/abi/riscv-lp64.js';

const call = (abi, args, extra = {}) => abi.classifyArguments({ callPrototype: { args, ...extra } });

test('#868 LP64F honors ABI_FLEN for scalar arguments and returns', () => {
  assert.equal(call(lp64f, [{ type:'float', bits:32 }]).arguments[0].reg, 'f10');
  assert.equal(call(lp64f, [{ type:'double', bits:64 }]).arguments[0].reg, 'x10');
  assert.equal(call(lp64d, [{ type:'double', bits:64 }]).arguments[0].reg, 'f10');
  assert.equal(lp64f.classifyFunctionReturn({ functionPrototype:{ returnType:'double', returnBits:64, returnsValue:true } }).reg, 'x10');
  assert.equal(lp64d.classifyFunctionReturn({ functionPrototype:{ returnType:'double', returnBits:64, returnsValue:true } }).reg, 'f10');
});

test('#869 named 2xXLEN scalar and aggregate may split across final arg register and stack', () => {
  const leading = Array.from({ length:7 }, () => ({ type:'long', bits:64 }));
  const wide = call(lp64, [...leading, { type:'__int128', bits:128 }]);
  assert.equal(wide.arguments[7].location, 'register-and-stack');
  assert.equal(wide.arguments[7].reg, 'x17');
  assert.equal(wide.stackArguments.at(-1).offset, 0);

  const unaligned = call(lp64, [{ bits:64 }, { type:'__int128', bits:128 }]);
  assert.deepEqual(unaligned.arguments[1].regs, ['x11', 'x12']);

  const aggregate = call(lp64, [...leading, { type:'struct Pair', aggregate:true, bits:128 }]);
  assert.equal(aggregate.arguments[7].reg, 'x17');
  assert.equal(aggregate.stackArguments.at(-1).offset, 0);
});

test('#869 variadic aligned 2xXLEN spill makes following variadic tail stack-only', () => {
  const args = [
    ...Array.from({ length:7 }, () => ({ bits:64 })),
    { type:'__int128', bits:128, named:false },
    { bits:64, named:false },
  ];
  const classified = call(lp64, args, { variadic:true, fixedParameterCount:7 });
  assert.equal(classified.arguments[7].location, 'stack');
  assert.equal(classified.arguments[7].offset, 0);
  assert.equal(classified.arguments[8].location, 'stack');
  assert.equal(classified.arguments[8].offset, 16);
});

test('#870 indirect aggregate return does not invent an a0 return identity', () => {
  const result = lp64.classifyFunctionReturn({
    functionPrototype:{ returnType:'struct Big', aggregate:true, returnBits:192, returnsValue:true },
  });
  assert.equal(result.indirect, true);
  assert.equal(result.reg, null);
  assert.deepEqual(result.hiddenResultPointer, { input:'x10' });
  assert.equal(result.resultLocation, 'memory');
});

test('#871 named floating parameters of variadic functions still use hard-float convention', () => {
  const named = call(lp64d, [{ type:'double', bits:64 }], { variadic:true });
  assert.equal(named.arguments[0].reg, 'f10');

  const mixed = call(lp64d, [
    { type:'double', bits:64 },
    { type:'double', bits:64, named:false },
  ], { variadic:true, fixedParameterCount:1 });
  assert.equal(mixed.arguments[0].reg, 'f10');
  assert.equal(mixed.arguments[1].reg, 'x10');
});

test('#872 scalars wider than 2xXLEN are passed and returned by reference', () => {
  for (const bits of [129, 192, 256, 512]) {
    const arg = call(lp64, [{ type:`_BitInt(${bits})`, bits }]).arguments[0];
    assert.equal(arg.abiClass, 'scalar-by-reference');
    assert.equal(arg.reg, 'x10');
    assert.equal(arg.pointer, true);
    assert.equal(arg.pointeeBits, bits);

    const ret = lp64.classifyFunctionReturn({
      functionPrototype:{ returnType:`_BitInt(${bits})`, returnBits:bits, returnsValue:true },
    });
    assert.equal(ret.indirect, true);
    assert.equal(ret.reg, null);
  }
  assert.deepEqual(
    lp64.classifyFunctionReturn({ functionPrototype:{ returnType:'int128', returnBits:128, returnsValue:true } }).regs,
    ['x10', 'x11'],
  );
});
