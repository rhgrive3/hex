import assert from 'node:assert/strict';
import fs from 'node:fs';
import { classifyAAPCS64Arguments, classifyAAPCS64CallReturn } from '../js/targets/abi/aapcs64.js';

const classify = (args) => classifyAAPCS64Arguments({ callPrototype:{ args } });

// #926: 16-byte integral values consume an even-aligned GP pair or spill whole.
{
  const first = classify([{ type:'__int128' }]);
  assert.deepEqual(first.arguments[0].regs, ['x0','x1']);
  assert.deepEqual(first.srcs.map(x => x.reg), ['x0','x1']);
  const odd = classify([{ type:'uint64_t', bits:64 }, { type:'unsigned __int128' }]);
  assert.equal(odd.arguments[0].reg, 'x0');
  assert.deepEqual(odd.arguments[1].regs, ['x2','x3']);
  const boundary = classify([
    ...Array.from({length:7}, () => ({ type:'uint64_t', bits:64 })),
    { type:'__int128', bits:128 },
  ]);
  assert.equal(boundary.arguments[7].location, 'stack');
  assert.equal(boundary.arguments[7].bytes, 16);
  const ret = classifyAAPCS64CallReturn({callPrototype:{returnType:'__int128',returnBits:128}});
  assert.deepEqual(ret.regs, ['x0','x1']);
}

// #925: non-HFA composites are never collapsed to one scalar register.
{
  const pair = classify([{ type:'struct Pair', aggregate:true, bits:128 }]);
  assert.deepEqual(pair.arguments[0].regs, ['x0','x1']);
  assert.equal(pair.arguments[0].abiClass, 'aggregate');
  const afterScalar = classify([{ type:'uint64_t', bits:64 }, { type:'struct Pair', aggregate:true, bits:128 }]);
  assert.deepEqual(afterScalar.arguments[1].regs, ['x1','x2']);
  const large = classify([{ type:'struct Triple', aggregate:true, bits:192, containsPointers:true }]);
  assert.equal(large.arguments[0].abiClass, 'aggregate-indirect-copy');
  assert.equal(large.arguments[0].reg, 'x0');
  assert.equal(large.arguments[0].pointeeBits, 192);
  assert.equal(large.stackArgsMayContainPointers, true);
}

// #925/#926 acceptance-boundary regressions.
{
  const one = classify([{ type:'struct One', aggregate:true, bits:64 }]);
  assert.deepEqual(one.arguments[0].regs, ['x0']);
  const union = classify([{ type:'union U', bits:128 }]);
  assert.equal(union.arguments[0].abiClass, 'aggregate');
  assert.deepEqual(union.arguments[0].regs, ['x0','x1']);
  const split = classify([
    ...Array.from({length:7}, () => ({ type:'uint64_t', bits:64 })),
    { type:'struct Pair', aggregate:true, bits:128 },
  ]);
  assert.equal(split.arguments[7].location, 'register-stack');
  assert.deepEqual(split.arguments[7].regs, ['x7']);
  assert.equal(split.arguments[7].stackBytes, 8);
  assert.equal(split.stackArguments.at(-1).pieceOffsetBytes, 8);
  const aligned = classify([{type:'uint64_t',bits:64},{type:'struct Pair',aggregate:true,bits:128,alignment:16}]);
  assert.deepEqual(aligned.arguments[1].regs, ['x2','x3']);
  const wide6 = classify([...Array.from({length:6},()=>({type:'uint64_t',bits:64})),{type:'__int128'}]);
  assert.deepEqual(wide6.arguments[6].regs, ['x6','x7']);
  const unsigned = classify([{type:'unsigned __int128'}]);
  assert.deepEqual(unsigned.arguments[0].regs, ['x0','x1']);
  const hfa = classify([{type:'struct H',hfa:true,members:2,bits:64}]);
  assert.deepEqual(hfa.arguments[0].regs, ['v0','v1']);
  const hfaExhaust = classify([
    {type:'struct H7',hfa:true,members:4,bits:32},
    {type:'struct H4',hfa:true,members:4,bits:32},
    {type:'struct H2',hfa:true,members:2,bits:32},
  ]);
  assert.equal(hfaExhaust.arguments[2].location, 'stack');
}

// #932/#935/#948 structural invariants protect the exact state-model boundary.
{
  const system = fs.readFileSync(new URL('../js/targets/architecture/arm64/effects/system.js', import.meta.url), 'utf8');
  assert.match(system, /createRegisterValue\(nzcvFlagId\(flag\),1\)/);
  assert.match(system, /opcode:'arm64\.pack-nzcv'/);
  assert.match(system, /opcode:'extract-bit'.*PSTATE\.NZCV/s);
  const mrsBody = system.slice(system.indexOf('function mrs('), system.indexOf('function msr('));
  const msrBody = system.slice(system.indexOf('function msr('), system.indexOf('function maintenance('));
  assert.match(mrsBody, /if \(sys === 'nzcv'\)[\s\S]*canonicalState:'PSTATE\.NZCV'/);
  assert.match(msrBody, /if \(sys === 'nzcv'\)[\s\S]*canonicalState:'PSTATE\.NZCV'/);
  const mrsNzcv = mrsBody.slice(mrsBody.indexOf("if (sys === 'nzcv')"), mrsBody.indexOf('const operation = completeIntrinsic', mrsBody.indexOf("if (sys === 'nzcv')")));
  const msrNzcv = msrBody.slice(msrBody.indexOf("if (sys === 'nzcv')"), msrBody.indexOf('const operation = completeIntrinsic', msrBody.indexOf("if (sys === 'nzcv')")));
  assert.doesNotMatch(mrsNzcv, /sysRegId\(sys\)/);
  assert.doesNotMatch(msrNzcv, /sysRegId\(sys\)/);

  const integer = fs.readFileSync(new URL('../js/targets/architecture/x86_64/effects/integer.js', import.meta.url), 'utf8');
  const zeroStart = integer.indexOf('if (count.knownCount === 0)');
  const zeroBlock = integer.slice(zeroStart, integer.indexOf('const value = ctx.readRegister(destination)', zeroStart));
  assert.match(zeroBlock, /destinationWrite:false/);
  assert.doesNotMatch(zeroBlock, /writeRegister/);
  assert.match(integer, /writeConditionalRegister\(ctx, destination, nonzero, result\)/);

  const simd = fs.readFileSync(new URL('../js/targets/architecture/arm64/effects/simd.js', import.meta.url), 'utf8');
  const lane = simd.slice(simd.indexOf('function appendElementRead'), simd.indexOf('function appendGpRead'));
  assert.match(lane, /createRegisterValue\(`v\$\{op\.num\}`, 128/);
  assert.match(lane, /opcode:'extract-lane'/);
  assert.match(lane, /laneIndex:info\.index/);
  assert.doesNotMatch(lane, /createRegisterValue\(`v\$\{op\.num\}`, info\.elementBits/);
}

console.log('issues #925/#926/#932/#935/#948 regressions: PASS');
