import assert from 'node:assert/strict';
import test from 'node:test';

import {
  canonicalX86ConditionCode,
  evaluateX86ArithmeticFlags,
  evaluateX86Condition,
  evaluateX86LogicalFlags,
} from '../../../../js/targets/architecture/x86_64/effects/flags.js';

function mask(width) { return (1n << BigInt(width)) - 1n; }
function unsigned(value, width) { return BigInt(value) & mask(width); }
function signed(value, width) {
  const u = unsigned(value,width);
  const sign = 1n << BigInt(width - 1);
  return (u & sign) === 0n ? u : u - (1n << BigInt(width));
}
function parity(value) {
  let x = Number(BigInt(value) & 0xffn);
  let odd = 0;
  for (let i = 0; i < 8; i++) { odd ^= x & 1; x >>>= 1; }
  return odd ^ 1;
}
function common(result,width) {
  const r = unsigned(result,width);
  return { PF:parity(r), ZF:Number(r === 0n), SF:Number((r & (1n << BigInt(width - 1))) !== 0n) };
}

function referenceArithmetic(operation,left,right,width,{ carryIn = 0 } = {}) {
  const op = String(operation);
  const a = unsigned(left,width);
  const b = unsigned(right ?? 0n,width);
  const carry = BigInt(carryIn ? 1 : 0);
  const sign = 1n << BigInt(width - 1);
  const min = -sign;
  const max = sign - 1n;

  if (op === 'neg') {
    const result = unsigned(-a,width);
    return { result, CF:Number(a !== 0n), ...common(result,width), AF:Number((a & 0xfn) !== 0n), OF:Number(a === sign) };
  }
  if (op === 'inc' || op === 'dec') {
    const result = referenceArithmetic(op === 'inc' ? 'add' : 'sub',a,1n,width);
    return { ...result, CF:'unchanged' };
  }

  if (op === 'add' || op === 'adc') {
    const c = op === 'adc' ? carry : 0n;
    const full = a + b + c;
    const result = unsigned(full,width);
    const mathematical = signed(a,width) + signed(b,width) + c;
    return {
      result,
      CF:Number(full > mask(width)),
      ...common(result,width),
      AF:Number(((a & 0xfn) + (b & 0xfn) + c) >= 0x10n),
      OF:Number(mathematical < min || mathematical > max),
    };
  }

  const borrow = op === 'sbb' ? carry : 0n;
  const result = unsigned(a - b - borrow,width);
  const mathematical = signed(a,width) - signed(b,width) - borrow;
  return {
    result,
    CF:Number(a < b + borrow),
    ...common(result,width),
    AF:Number((a & 0xfn) < (b & 0xfn) + borrow),
    OF:Number(mathematical < min || mathematical > max),
  };
}

function compare(operation,left,right,width,carryIn = 0) {
  assert.deepEqual(
    evaluateX86ArithmeticFlags(operation,left,right,width,{ carryIn }),
    Object.freeze(referenceArithmetic(operation,left,right,width,{ carryIn })),
    `${operation} width=${width} left=${left} right=${right} carry=${carryIn}`,
  );
}

test('independent 8-bit exhaustive ADD/SUB reference agrees with production evaluator', () => {
  for (let left = 0; left < 256; left++) {
    for (let right = 0; right < 256; right++) {
      compare('add',BigInt(left),BigInt(right),8,0);
      compare('sub',BigInt(left),BigInt(right),8,0);
    }
  }
});

test('deterministic boundary matrix validates ADD/ADC/SUB/SBB/INC/DEC/NEG at 8/16/32/64', () => {
  for (const width of [8,16,32,64]) {
    const sign = 1n << BigInt(width - 1);
    const all = mask(width);
    const points = [0n,1n,0xfn,0x10n,sign - 1n,sign,all];
    for (const left of points) {
      for (const right of points) {
        compare('add',left,right,width);
        compare('sub',left,right,width);
        compare('adc',left,right,width,0);
        compare('adc',left,right,width,1);
        compare('sbb',left,right,width,0);
        compare('sbb',left,right,width,1);
      }
      compare('inc',left,0n,width);
      compare('dec',left,0n,width);
      compare('neg',left,0n,width);
    }
  }
});

test('logical flag reference makes AF undefined rather than preserved', () => {
  for (const width of [8,16,32,64]) {
    const values = [0n,1n,0xffn,1n << BigInt(width - 1),mask(width)];
    for (const value of values) {
      const flags = evaluateX86LogicalFlags(value,width);
      assert.equal(flags.CF,0);
      assert.equal(flags.OF,0);
      assert.equal(flags.AF,'undefined');
      assert.deepEqual({ PF:flags.PF,ZF:flags.ZF,SF:flags.SF }, common(value,width));
    }
  }
});

test('normal condition-code aliases canonicalize and evaluate identically', () => {
  const groups = [
    ['e','z'], ['ne','nz'], ['b','c','nae'], ['ae','nb','nc'], ['be','na'], ['a','nbe'],
    ['l','nge'], ['ge','nl'], ['le','ng'], ['g','nle'], ['p','pe'], ['np','po'],
  ];
  for (const aliases of groups) {
    const canonical = canonicalX86ConditionCode(aliases[0]);
    for (const alias of aliases) assert.equal(canonicalX86ConditionCode(alias), canonical);
  }

  for (let bits = 0; bits < 32; bits++) {
    const flags = {
      CF:(bits >> 0) & 1,
      PF:(bits >> 1) & 1,
      ZF:(bits >> 2) & 1,
      SF:(bits >> 3) & 1,
      OF:(bits >> 4) & 1,
    };
    for (const aliases of groups) {
      const expected = evaluateX86Condition(flags,aliases[0]);
      for (const alias of aliases.slice(1)) assert.equal(evaluateX86Condition(flags,alias),expected, `${aliases[0]} != ${alias}`);
    }
  }
});
