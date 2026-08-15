import assert from 'node:assert/strict';
import { planAnalysisGoal } from '../js/query/planner.js';

const recognition = Array.from({ length:5000 }, (_, i) => ({ addr:0x200000000n + BigInt(i * 0x10), source:'recognition', score:1 }));
const lexical = Array.from({ length:12 }, (_, i) => ({ address:0x100000000n + BigInt(i * 0x100), name:`reward_${i}` }));
const analyzed = [];
let callerQueries = 0;
let calleeQueries = 0;
const graphBase = 0x300000000n;

const tools = {
  async search_functions(_query, { limit }) {
    return { results:lexical.slice(0, limit), total:lexical.length, returned:Math.min(limit, lexical.length), complete:limit >= lexical.length, coverage:Math.min(1, limit / lexical.length) };
  },
  async search_strings() { return { results:[], total:0, returned:0, complete:true, coverage:1 }; },
  async get_xrefs() { return { functions:[], total:0, returned:0, complete:true }; },
  async get_callers(address) {
    callerQueries++;
    return { results:[{ addr:graphBase + (BigInt(address) & 0xfffn) + 0x10n }], total:1, returned:1, complete:true };
  },
  async get_callees(address) {
    calleeQueries++;
    return { results:[{ addr:graphBase + (BigInt(address) & 0xfffn) + 0x20n }], total:1, returned:1, complete:true };
  },
  async get_function(address) {
    analyzed.push(BigInt(address));
    return { address:BigInt(address), name:`fn_${BigInt(address).toString(16)}`, instructions:1, summary:{ calls:[] }, cost:{ functions:1, disassembly:1 } };
  },
  async get_semantic_facts() { return { results:[], total:0, returned:0, complete:true, coverage:1 }; },
  async verify_field_update() { return { verified:false, evidence:[] }; },
  async find_thresholds() { return { results:[], total:0, returned:0, complete:true }; },
};
const query = {
  action:'increase', entity:{ terms:['reward'] }, context:{ terms:[] }, event:{ terms:[] },
  dataflow:{ shape:'read-modify-write' }, expect:{ calls:[] }, confident:true,
};
const result = await planAnalysisGoal(query, { candidateFunctions:recognition }, {
  tools, maxFunctions:48, maxDisassembly:1000, maxSearchResults:12, maxExpansions:8, timeoutMs:10000,
});

// K. 5k recognition candidates cannot suppress graph expansion.
assert.ok(callerQueries > 0 && calleeQueries > 0, 'graph expansion starved by recognition pool');
assert.ok(result.candidateSources.stored.graph > 0, 'graph candidates were not retained');
assert.equal(result.candidateSources.supplied.recognition, 5000);
assert.equal(result.candidateSources.completeness.bySource.recognition.complete, false);
assert.ok(result.candidateSources.completeness.bySource.recognition.coverage < 1);
assert.ok(result.missingEvidence.includes('candidate-source-limit'));

// L. Source quotas prevent one signal family from taking all shortlist slots.
assert.ok(result.candidateSources.quotas.lexical > 0);
assert.ok(result.candidateSources.quotas.graph > 0);
assert.ok(result.candidateSources.quotas.recognition > 0);
assert.ok(result.candidateSources.quotas.recognition < result.budget.planner.functions);
assert.ok(result.candidates.some((candidate) => candidate.sourcePoolScores.graph > 0));
assert.ok(result.candidates.some((candidate) => candidate.sourcePoolScores.lexical > 0));
assert.ok(result.candidates.some((candidate) => candidate.sourcePoolScores.recognition > 0));

// M. Planner reserves resources for LLM refinement / verification instead of consuming the turn ceiling.
assert.equal(result.budget.requested.functions, 48);
assert.equal(result.budget.planner.functions, 19);
assert.equal(result.budget.reserved.functions, 29);
assert.ok(result.stats.analyzedFunctions <= 19);
assert.ok(analyzed.length <= 19);
assert.equal(result.budget.planner.disassembly, 400);
assert.equal(result.budget.reserved.disassembly, 600);
assert.equal(result.refinementAvailable, true);
assert.equal(result.completeness.budgetLimited, false);

// Small budgets remain valid: three planner slots still reserve room and represent distinct available sources.
const small = await planAnalysisGoal(query, { candidateFunctions:recognition }, {
  tools, maxFunctions:8, maxDisassembly:128, maxSearchResults:8, maxExpansions:4, timeoutMs:10000,
});
assert.equal(small.budget.planner.functions, 3);
assert.equal(small.budget.reserved.functions, 5);
assert.ok(small.stats.analyzedFunctions <= 3);
assert.ok(small.candidateSources.quotas.lexical > 0);
assert.ok(small.candidateSources.quotas.graph > 0);
assert.ok(small.candidateSources.quotas.recognition > 0);
assert.ok(Object.values(small.candidateSources.quotas).reduce((sum, value) => sum + value, 0) <= 3);

// Search scan truncation is first-class: zero hits in a partial scan is not a complete zero-hit result.
const partialTools = {
  ...tools,
  async search_functions() { return { results:[], returned:0, truncated:true, reason:'scan-budget', scanned:100000, scanTotal:1000000 }; },
  async search_strings() { return { results:[], returned:0, total:0, complete:true, coverage:1 }; },
};
const partial = await planAnalysisGoal(query, {}, {
  tools:partialTools, maxFunctions:48, maxDisassembly:1000, maxSearchResults:40, maxExpansions:0, timeoutMs:10000,
});
assert.equal(partial.partial, true);
assert.equal(partial.completeness.searchComplete, false);
assert.ok(partial.completeness.searchCoverage < 1);
assert.ok(partial.missingEvidence.includes('search-incomplete'));
assert.equal(partial.searchCompleteness.reports.find((r) => r.tool === 'search_functions').reason, 'scan-budget');

console.log('ai-planner-data-plane: PASS');
