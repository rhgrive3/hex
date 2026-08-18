import assert from 'node:assert/strict';
import { buildSemanticModel } from '../js/blocks.js';
import { summarizeFunction, createFunctionSummaryCache } from '../js/interproc.js';

const BASE = 0x100000000n;
const CALLEE = 0x100001000n;

function modelAt(base, lines) {
  const rows = lines.map((line, i) => {
    const text = line.trim();
    const space = text.indexOf(' ');
    return {
      row: i,
      address: base + BigInt(i * 4),
      mn: space < 0 ? text : text.slice(0, space),
      ops: space < 0 ? '' : text.slice(space + 1),
    };
  });
  return buildSemanticModel(rows, {
    startRow: 0,
    endRow: rows.length - 1,
    rowOfAddress(address) {
      const delta = address - base;
      if (delta < 0n || delta >= BigInt(rows.length * 4)) return null;
      return Number(delta / 4n);
    },
  });
}

// #437: terminal x0 is only a hint unless external return evidence exists.
{
  const voidCallThenRet = summarizeFunction(modelAt(BASE, [
    `bl #0x${CALLEE.toString(16)}`,
    'ret',
  ]));
  assert.equal(voidCallThenRet.returns[0].inferred, true);
  assert.equal(voidCallThenRet.returns[0].trusted, false);
  assert.equal(voidCallThenRet.classification.wrapper, false);
  assert.equal(voidCallThenRet.classification.forwarding, false);

  const localTemporary = summarizeFunction(modelAt(BASE, [
    'add x0, x1, #7',
    'ret',
  ]));
  assert.equal(localTemporary.returns[0].inferred, true);
  assert.equal(localTemporary.returns[0].trusted, false);
  assert.equal(localTemporary.classification.simpleArithmeticWrapper, false);

  const trueValueWrapper = summarizeFunction(modelAt(BASE, [
    `bl #0x${CALLEE.toString(16)}`,
    'ret',
  ]), { returnEvidence: { trusted: true, source: 'prototype' } });
  assert.equal(trueValueWrapper.returns[0].trusted, true);
  assert.equal(trueValueWrapper.classification.wrapper, true);
  assert.equal(trueValueWrapper.classification.forwarding, true);
}

async function composedConstant(wrapperLines, calleeLines) {
  const wrapper = modelAt(BASE, wrapperLines);
  const callee = modelAt(CALLEE, calleeLines);
  const cache = createFunctionSummaryCache({
    program: { functionRange: () => null },
    analyze: async (address) => address === BASE ? wrapper : address === CALLEE ? callee : null,
    returnEvidenceFor: async () => ({ trusted: true, source: 'prototype-fixture' }),
  }, { maxDepth: 2 });
  const summary = await cache.summaryFor(BASE);
  assert.ok(summary.propagatedReturn, 'wrapper should receive the trusted callee return summary');
  assert.equal(summary.propagatedReturn.kind, 'constant');
  return summary.propagatedReturn;
}

// #438: composed arithmetic obeys the callee result bit width.
{
  const add32 = await composedConstant([
    'mov w0, #0xffffffff',
    `bl #0x${CALLEE.toString(16)}`,
    'ret',
  ], [
    'add w0, w0, #1',
    'ret',
  ]);
  assert.equal(add32.bits, 32);
  assert.equal(add32.value, 0n);

  const sub32 = await composedConstant([
    'mov w0, #0',
    `bl #0x${CALLEE.toString(16)}`,
    'ret',
  ], [
    'sub w0, w0, #1',
    'ret',
  ]);
  assert.equal(sub32.bits, 32);
  assert.equal(sub32.value, 0xffffffffn);

  const add64 = await composedConstant([
    'mov x0, #0xffffffffffffffff',
    `bl #0x${CALLEE.toString(16)}`,
    'ret',
  ], [
    'add x0, x0, #1',
    'ret',
  ]);
  assert.equal(add64.bits, 64);
  assert.equal(add64.value, 0n);

  const sub64 = await composedConstant([
    'mov x0, #0',
    `bl #0x${CALLEE.toString(16)}`,
    'ret',
  ], [
    'sub x0, x0, #1',
    'ret',
  ]);
  assert.equal(sub64.bits, 64);
  assert.equal(sub64.value, 0xffffffffffffffffn);
}

// #831: FunctionSummaryCache must preserve top-level function-local ABI/IR options.
{
  const local = modelAt(BASE, ['add w0, w0, #1', 'ret']);
  const cache = createFunctionSummaryCache({
    program: { functionRange: () => null },
    analyze: async (address) => address === BASE ? local : null,
  });

  const optionSets = [
    { returnsValue: true },
    { returnsValue: true, functionPrototype: { returnType: 'uint32_t', returnBits: 32, returnsValue: true } },
    { returnsValue: true, prototype: { returnType: 'uint32_t', returnBits: 32, returnsValue: true } },
    { returnsValue: true, ir: { returnType: 'uint32_t', returnBits: 32, returnsValue: true } },
  ];
  for (const opts of optionSets) {
    const direct = summarizeFunction(local, opts);
    const throughCache = await cache.summaryFor(BASE, opts);
    assert.deepEqual(throughCache.returns, direct.returns, 'cache facade must preserve function-local summary/IR semantics');
    assert.deepEqual(throughCache.classification, direct.classification, 'cache facade classification must match direct summary');
    assert.equal(throughCache.returns[0].trusted, true);
  }
}

// #831: caller-local return evidence must be stripped before recursive callee analysis.
{
  const wrapper = modelAt(BASE, [`bl #0x${CALLEE.toString(16)}`, 'ret']);
  const callee = modelAt(CALLEE, ['add x0, x0, #1', 'ret']);
  const cache = createFunctionSummaryCache({
    program: { functionRange: () => null },
    analyze: async (address) => address === BASE ? wrapper : address === CALLEE ? callee : null,
  }, { maxDepth: 2 });
  const summary = await cache.summaryFor(BASE, { returnsValue: true, functionPrototype: { returnType: 'uint64_t', returnsValue: true } });
  assert.equal(summary.classification.forwarding, true, 'root evidence should make the wrapper return trusted');
  assert.equal(summary.propagatedReturn, undefined, 'root ABI evidence must not leak into the callee summary');
}

// #806: width-changing MOVs must remain explicit in return summaries.
{
  const callee = modelAt(CALLEE, [
    'add x8, x0, #1',
    'mov w0, w8',
    'ret',
  ]);
  const direct = summarizeFunction(callee, { returnsValue: true });
  assert.equal(direct.classification.simpleArithmeticWrapper, false,
    'truncating x8 -> w0 must not be peeled into a 64-bit argument-arithmetic summary');
  assert.notEqual(direct.returns[0].kind, 'argument-arithmetic');

  const wrapper = modelAt(BASE, [
    'mov x0, #0xffffffff',
    `bl #0x${CALLEE.toString(16)}`,
    'ret',
  ]);
  const cache = createFunctionSummaryCache({
    program: { functionRange: () => null },
    analyze: async (address) => address === BASE ? wrapper : address === CALLEE ? callee : null,
    returnEvidenceFor: async () => ({ trusted: true, source: 'prototype-fixture' }),
  }, { maxDepth: 2 });
  const summary = await cache.summaryFor(BASE);
  assert.equal(summary.propagatedReturn, undefined,
    'caller composition must not erase the callee truncation and invent 0x100000000');
}

console.log('issues #437/#438/#806/#831 interproc regressions PASS');