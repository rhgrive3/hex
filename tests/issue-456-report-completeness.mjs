import assert from 'node:assert/strict';
import { buildSemanticModel } from '../js/blocks.js';
import { buildFunctionReport, CERTAINTY } from '../js/report.js';

const BASE = 0x100000000n;
const rows = [{ row:0, address:BASE, mn:'ret', ops:'' }];
const model = buildSemanticModel(rows, {
  startRow:0,
  endRow:0,
  rowOfAddress:(addr) => BigInt(addr) === BASE ? 0 : null,
});
const region = { vmAddr:BASE, size:4n };

function program({ complete, callers = [] }) {
  return {
    statsComplete: complete,
    functionRange() { return { start:BASE, end:BASE + 4n }; },
    callersOf() { return callers; },
    calleesOf() { return []; },
    statsOf() { return { numeric:false, indcall:0, mul:0, div:0, fmul:0, farith:0 }; },
  };
}

function report(opts) {
  return buildFunctionReport({ model, region, program:program(opts), symbols:null });
}
function has(xs, code) { return xs.some((x) => x.code === code); }

// Complete + empty is the only case where absence is a FACT.
{
  const r = report({ complete:true, callers:[] });
  assert.ok(has(r.facts, 'no-callers'));
  assert.ok(!has(r.unknowns, 'callers-partial'));
  assert.ok(r.nextSteps.some((x) => x.code === 'no-callers-hint'));
  assert.equal(r.facts.find((x) => x.code === 'no-callers')?.certainty, CERTAINTY.FACT);
}

// Partial + empty must not be promoted to an absence fact.
{
  const r = report({ complete:false, callers:[] });
  assert.ok(!has(r.facts, 'no-callers'));
  assert.ok(has(r.unknowns, 'callers-partial'));
  assert.ok(has(r.unknowns, 'stats-partial'));
  assert.ok(!r.nextSteps.some((x) => x.code === 'no-callers-hint'));
  assert.ok(r.nextSteps.some((x) => x.code === 'check-callers-incomplete'));
}

// Partial + hit: presence is safe, but the caller set is still incomplete.
{
  const r = report({ complete:false, callers:[{ addr:BASE + 0x100n, site:BASE + 0x20n, count:1 }] });
  assert.ok(has(r.facts, 'callers'));
  assert.ok(!has(r.facts, 'no-callers'));
  assert.ok(has(r.unknowns, 'callers-partial'));
  assert.equal(r.callers.length, 1);
  assert.ok(r.nextSteps.some((x) => x.code === 'check-callers'));
}

console.log('issue #456 report completeness regressions passed');
