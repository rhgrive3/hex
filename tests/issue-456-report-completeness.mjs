import assert from 'node:assert/strict';
import { buildSemanticModel } from '../js/blocks.js';
import { ProgramIndex } from '../js/program.js';
import { buildFunctionReport, CERTAINTY } from '../js/report.js';

const BASE = 0x100000000n;
const rows = [{ row:0, address:BASE, mn:'ret', ops:'' }];
const model = buildSemanticModel(rows, {
  startRow:0,
  endRow:0,
  rowOfAddress:(addr) => BigInt(addr) === BASE ? 0 : null,
});
const region = { vmAddr:BASE, size:4n };

function query(items, { complete, capped = false, queryLimited = false }) {
  const out = items.slice();
  Object.defineProperties(out, {
    complete:{ value:complete, enumerable:false },
    capped:{ value:capped, enumerable:false },
    queryLimited:{ value:queryLimited, enumerable:false },
  });
  return out;
}
function program({ statsComplete = true, callsComplete = true, queryComplete = callsComplete, callers = [] }) {
  return {
    statsComplete,
    graphCompleteness:{ callsComplete, refsComplete:true, statsComplete },
    functionRange() { return { start:BASE, end:BASE + 4n }; },
    callersOf() { return query(callers, { complete:queryComplete, capped:!callsComplete, queryLimited:callsComplete && !queryComplete }); },
    calleesOf() { return []; },
    statsOf() { return { numeric:false, indcall:0, mul:0, div:0, fmul:0, farith:0 }; },
  };
}
function report(opts) { return buildFunctionReport({ model, region, program:program(opts), symbols:null }); }
function has(xs, code) { return xs.some((x) => x.code === code); }

// Complete call graph + complete empty query is the only safe absence fact.
{
  const r = report({ statsComplete:true, callsComplete:true, queryComplete:true, callers:[] });
  assert.ok(has(r.facts, 'no-callers'));
  assert.ok(!has(r.unknowns, 'callers-partial'));
  assert.ok(r.nextSteps.some((x) => x.code === 'no-callers-hint'));
  assert.equal(r.facts.find((x) => x.code === 'no-callers')?.certainty, CERTAINTY.FACT);
}

// Issue reproducer: instruction statistics can be complete while the call graph is capped.
{
  const r = report({ statsComplete:true, callsComplete:false, queryComplete:false, callers:[] });
  assert.ok(!has(r.facts, 'no-callers'));
  assert.ok(has(r.unknowns, 'callers-partial'));
  assert.ok(!has(r.unknowns, 'stats-partial'), 'stats completeness is independent of call-edge completeness');
  assert.ok(r.nextSteps.some((x) => x.code === 'check-callers-incomplete'));
}

// Conversely, incomplete instruction statistics do not invalidate a complete caller absence query.
{
  const r = report({ statsComplete:false, callsComplete:true, queryComplete:true, callers:[] });
  assert.ok(has(r.facts, 'no-callers'));
  assert.ok(has(r.unknowns, 'stats-partial'));
  assert.ok(!has(r.unknowns, 'callers-partial'));
}

// A local result limit also makes absence/inventory claims incomplete even with a complete source graph.
{
  const r = report({ statsComplete:true, callsComplete:true, queryComplete:false, callers:[] });
  assert.ok(!has(r.facts, 'no-callers'));
  assert.ok(has(r.unknowns, 'callers-partial'));
}

// Partial + hit: presence is safe, but the caller set is still incomplete.
{
  const r = report({ statsComplete:true, callsComplete:false, queryComplete:false, callers:[{ addr:BASE + 0x100n, site:BASE + 0x20n, count:1 }] });
  assert.ok(has(r.facts, 'callers'));
  assert.ok(!has(r.facts, 'no-callers'));
  assert.ok(has(r.unknowns, 'callers-partial'));
  assert.equal(r.callers.length, 1);
  assert.ok(r.nextSteps.some((x) => x.code === 'check-callers'));
}

// ProgramIndex source caps and local query limits must survive as query metadata.
{
  const capped = new ProgramIndex({
    vmAddr:BASE, words:1, kindsCovered:1, kinds:new Uint8Array([0]),
    callFrom:new BigUint64Array(0), callTo:new BigUint64Array(0), callsCapped:true,
  }, null, region);
  assert.equal(capped.statsComplete, true);
  assert.equal(capped.graphCompleteness.callsComplete, false);
  const q = capped.callersOf(BASE, 60);
  assert.equal(q.length, 0);
  assert.equal(q.complete, false);
  assert.equal(q.capped, true);
  assert.equal(q.queryLimited, true, 'caller query inherits incomplete source scan state');
}

{
  const target = BASE + 0x800n;
  const callFrom = BigUint64Array.from([BASE, BASE+4n, BASE+8n, BASE+12n, BASE+16n]);
  const callTo = BigUint64Array.from([target,target,target,target,target]);
  const p = new ProgramIndex({ vmAddr:BASE, words:5, kindsCovered:5, kinds:new Uint8Array(5), callFrom, callTo }, null, { vmAddr:BASE, size:0x1000n });
  const sites = p.callSitesTo(target, 2);
  assert.equal(sites.length, 2);
  assert.equal(sites.complete, false);
  assert.equal(sites.capped, false);
  assert.equal(sites.queryLimited, true);
  const callers = p.callersOf(target, 2);
  assert.equal(callers.length, 2);
  assert.equal(callers.complete, false);
  assert.equal(callers.queryLimited, true);
}

// The same completeness contract applies to reference queries used by absence reasoning elsewhere.
{
  const refTo = BigUint64Array.from([BASE+0x100n, BASE+0x100n, BASE+0x100n]);
  const p = new ProgramIndex({
    vmAddr:BASE, words:3, kindsCovered:3, kinds:new Uint8Array(3),
    refFrom:BigUint64Array.from([BASE,BASE+4n,BASE+8n]), refTo, refKind:new Uint8Array(3),
  }, null, { vmAddr:BASE, size:0x1000n });
  const refs = p.refSitesTo(BASE+0x100n, 1n, 2);
  assert.equal(refs.length, 2);
  assert.equal(refs.complete, false);
  assert.equal(refs.queryLimited, true);
}

console.log('issue #456 report completeness regressions passed');
