import assert from 'node:assert/strict';
import { planAnalysisGoal } from '../js/query/planner.js';
import { FACT } from '../js/semantic.js';

const addresses = Array.from({ length:49 }, (_, i) => 0x100000000n + BigInt(i * 0x100));
const exact = addresses[48];
const analyzed = [];

// External analysis tools are metered: fixtures must report the work they consume.
const tools = {
  async search_functions() {
    return { results:addresses.map((address, i) => ({ address, name:`candidate_${i + 1}` })) };
  },
  async search_strings() { return { results:[] }; },
  async get_xrefs() { return { functions:[] }; },
  async get_callers() { return { results:[] }; },
  async get_callees() { return { results:[] }; },
  async get_function(address) {
    analyzed.push(BigInt(address));
    return {
      address:BigInt(address),
      name:`fn_${BigInt(address).toString(16)}`,
      instructions:1,
      cost:{ functions:1, disassembly:1 },
      summary:{ calls:[] },
    };
  },
  async get_semantic_facts(address) {
    if (BigInt(address) === exact) {
      return { results:[
        { kind:FACT.RMW, location:{ key:'field:coins' }, evidence:['ir:900'] },
        { kind:FACT.INCREMENT, location:{ key:'field:coins' }, evidence:['ir:901'] },
      ] };
    }
    return { results:[] };
  },
  async verify_field_update() { return { verified:true, evidence:['ir:999'] }; },
  async find_thresholds() { return { results:[] }; },
};

const query = {
  action:'increase',
  entity:{ terms:['needle'] },
  context:{ terms:[] },
  event:{ terms:[] },
  dataflow:{ shape:'read-modify-write' },
  expect:{ calls:[] },
  confident:true,
};

const result = await planAnalysisGoal(query, {}, {
  tools,
  maxFunctions:48,
  maxDisassembly:1000,
  maxSearchResults:100,
  maxExpansions:0,
  timeoutMs:10000,
});

assert.equal(result.stats.candidateFunctions, 49);
assert.equal(result.stats.analyzedFunctions, 48);
assert.equal(result.stats.unanalyzedFunctions, 1);
assert.equal(analyzed.length, 48);
assert.ok(!analyzed.includes(exact), '49th semantic exact match should remain outside the hard function budget fixture');
assert.equal(result.partial, true, 'truncated candidate search must be explicitly partial');
assert.equal(result.exhausted, true, 'candidate truncation must be exposed as exhaustion');
assert.ok(result.missingEvidence.includes('function-budget'));
assert.equal(result.best?.budgetLimited, true);
assert.equal(result.best?.complete, false);
assert.equal(result.completeness?.candidateCoverage, 48 / 49);
assert.equal(result.completeness?.reason, 'function-budget');

// No truncation => do not mark a complete bounded search as partial.
const complete = await planAnalysisGoal(query, {}, {
  tools:{ ...tools, search_functions:async () => ({ results:addresses.slice(0, 4).map((address) => ({ address })) }) },
  maxFunctions:48,
  maxDisassembly:1000,
  maxSearchResults:100,
  maxExpansions:0,
  timeoutMs:10000,
});
assert.equal(complete.partial, false);
assert.equal(complete.exhausted, false);
assert.ok(!complete.missingEvidence.includes('function-budget'));
assert.equal(complete.best?.budgetLimited, false);
assert.equal(complete.best?.complete, true);

console.log('issue #425 planner budget regressions passed');
