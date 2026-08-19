import assert from 'node:assert/strict';
import test from 'node:test';

import { summaryIsPure } from '../../../js/analysis/summary/contract.js';
import {
  condenseCallGraph,
  solveInterproceduralSummaries,
} from '../../../js/analysis/summary/interprocedural.js';
import { collectSummaryMetrics } from '../../../tools/validation/phase7/lanes/summary.mjs';
import { SUMMARY_QUERIES, buildSummaryGraph } from '../corpus/summaries.mjs';

function solve(graphId, root, options = {}) {
  return solveInterproceduralSummaries({ roots: [root], localSummaries: buildSummaryGraph(graphId), ...options });
}

test('SCCs are condensed in reverse topological order', () => {
  const edges = new Map([['a', ['b']], ['b', ['c', 'd']], ['c', []], ['d', ['b']]]);
  const { components } = condenseCallGraph(['a'], (node) => edges.get(node) ?? []);
  assert.deepEqual(components, [['c'], ['b', 'd'], ['a']]);
  // A callee's component must appear before its caller's, or the bottom-up
  // solve would read a summary that does not exist yet.
  const order = new Map(components.flatMap((component, index) => component.map((member) => [member, index])));
  assert.ok(order.get('c') < order.get('b'));
  assert.ok(order.get('b') < order.get('a'));
});

test('a deep call chain does not overflow the stack', () => {
  const depth = 20000;
  const edges = new Map();
  for (let index = 0; index < depth; index += 1) edges.set(`fn_${index}`, index + 1 < depth ? [`fn_${index + 1}`] : []);
  const { components } = condenseCallGraph(['fn_0'], (node) => edges.get(node) ?? [], { maxComponents: depth + 10 });
  assert.equal(components.length, depth);
});

test('every corpus case meets its per-field truth', () => {
  const metrics = collectSummaryMetrics();
  assert.equal(metrics.missingEffects, 0, 'an effect that really happens was left out of a summary');
  assert.equal(metrics.inventedEffects, 0, 'a summary claimed an effect that does not happen');
  assert.equal(metrics.falsePurity, 0, 'an incomplete summary read as pure');
  assert.equal(metrics.wrongCompleteness, 0, 'a summary reported the wrong completeness');
  assert.equal(metrics.nonConvergent, 0, 'a case expected to converge hit the iteration cap');
  assert.equal(metrics.nondeterministic, 0, 'the fixed point depended on traversal luck');
});

test('a leaf effect propagates through an acyclic chain', () => {
  const solved = solve('acyclic-chain', 'fn_a');
  assert.equal(solved.status.completeness, 'complete');
  assert.ok(solved.summaries.get('fn_a').memoryWriteRegions.some((effect) => effect.regionId === 'region_leaf'));
});

test('direct self-recursion converges and keeps its own effect', () => {
  const solved = solve('self-recursive', 'fn_self');
  assert.equal(solved.status.completeness, 'complete');
  assert.ok(solved.summaries.get('fn_self').memoryWriteRegions.some((effect) => effect.regionId === 'region_self'));
});

test('mutual recursion converges deterministically', () => {
  const first = solve('mutual-recursion', 'fn_top');
  const second = solve('mutual-recursion', 'fn_top');
  assert.equal(first.status.completeness, 'complete');
  assert.equal(first.iterations, second.iterations);
  for (const member of ['fn_even', 'fn_odd', 'fn_top']) {
    assert.ok(first.summaries.get(member).memoryWriteRegions.some((effect) => effect.regionId === 'region_leaf'),
      `${member} lost the effect that reaches it through the recursion`);
  }
});

test('a component that does not converge is republished conservatively', () => {
  // The optimistic intermediate state is not an answer. Hitting the iteration
  // cap must produce a bounded, explicitly incomplete summary — never a
  // plausible-looking complete one.
  const solved = solve('mutual-recursion', 'fn_top', { budget: { maxIterationsPerComponent: 1 } });
  assert.equal(solved.status.completeness, 'truncated');
  assert.equal(solved.status.stopReason, 'iteration-limit');
  const member = solved.summaries.get('fn_even');
  assert.ok(member.memoryWriteRegions.some((effect) => effect.broad), 'an unconverged summary must clobber broadly');
  assert.ok(member.unknownCallEffects.some((effect) => effect.reason === 'recursion-unconverged'));
  assert.equal(summaryIsPure(member), false);
});

test('an unresolved callee never becomes purity', () => {
  const solved = solve('missing-callee-summary', 'fn_caller');
  const summary = solved.summaries.get('fn_caller');
  assert.notEqual(summary.status.completeness, 'complete');
  assert.ok(summary.memoryWriteRegions.some((effect) => effect.broad));
  assert.equal(summaryIsPure(summary), false);
});

test('a non-exhaustive indirect call adds unknown effects on top of its candidates', () => {
  const solved = solve('non-exhaustive-indirect', 'fn_dispatch');
  const summary = solved.summaries.get('fn_dispatch');
  assert.ok(summary.memoryWriteRegions.some((effect) => effect.broad),
    'candidates must not be averaged into an answer that omits the unresolved rest');
  assert.notEqual(summary.status.completeness, 'complete');
});

test('a proven exhaustive indirect call merges only its candidates', () => {
  const solved = solve('exhaustive-indirect', 'fn_dispatch_exact');
  const summary = solved.summaries.get('fn_dispatch_exact');
  assert.equal(summary.status.completeness, 'complete');
  assert.ok(summary.memoryWriteRegions.some((effect) => effect.regionId === 'region_target'));
  assert.ok(!summary.memoryWriteRegions.some((effect) => effect.broad));
});

test('a library model applies only where the binary does not define the callee', () => {
  // A model must never override contradictory binary evidence (P7-INV-004).
  const locals = buildSummaryGraph('acyclic-chain');
  const model = { memoryWriteRegions: [{ regionId: 'region_from_model', regionKind: 'global-absolute', source: 'library-model' }] };
  const solved = solveInterproceduralSummaries({
    roots: ['fn_a'], localSummaries: locals,
    libraryModels: new Map([['fn_c', model]]),
  });
  const summary = solved.summaries.get('fn_a');
  assert.ok(summary.memoryWriteRegions.some((effect) => effect.regionId === 'region_leaf'),
    'the binary-derived effect for fn_c must win, because the binary defines fn_c');
  assert.ok(!summary.memoryWriteRegions.some((effect) => effect.regionId === 'region_from_model'));
});

test('a library model fills in a callee the binary does not define', () => {
  const locals = buildSummaryGraph('missing-callee-summary');
  const solved = solveInterproceduralSummaries({
    roots: ['fn_caller'], localSummaries: locals,
    libraryModels: new Map([['fn_absent', {
      memoryWriteRegions: [{ regionId: 'region_model', regionKind: 'global-absolute', source: 'library-model' }],
      noreturn: false, mayThrow: false,
    }]]),
  });
  const summary = solved.summaries.get('fn_caller');
  assert.ok(summary.memoryWriteRegions.some((effect) => effect.regionId === 'region_model'));
  assert.equal(summary.status.completeness, 'complete');
});

test('cancellation publishes nothing complete', () => {
  const controller = new AbortController();
  controller.abort();
  const solved = solveInterproceduralSummaries({
    roots: ['fn_a'], localSummaries: buildSummaryGraph('acyclic-chain'), signal: controller.signal,
  });
  assert.equal(solved.status.completeness, 'partial');
  assert.equal(solved.status.stopReason, 'cancelled');
  assert.equal(solved.summaries.size, 0);
});

test('a component budget that cannot hold the graph fails closed', () => {
  const solved = solveInterproceduralSummaries({
    roots: ['fn_a'], localSummaries: buildSummaryGraph('acyclic-chain'), budget: { maxComponents: 1 },
  });
  assert.equal(solved.status.completeness, 'truncated');
  assert.equal(solved.status.stopReason, 'budget-exhausted');
  assert.equal(solved.summaries.size, 0, 'a truncated condensation must publish no summaries at all');
});

test('the solve is demand-driven: unreachable functions are not solved', () => {
  const locals = buildSummaryGraph('acyclic-chain');
  locals.set('fn_unrelated', buildSummaryGraph('self-recursive').get('fn_self'));
  const solved = solveInterproceduralSummaries({ roots: ['fn_a'], localSummaries: locals });
  assert.ok(!solved.summaries.has('fn_unrelated'),
    'opening a binary must not trigger a whole-program summary solve');
});

test('every corpus query names a graph that builds', () => {
  for (const query of SUMMARY_QUERIES) {
    assert.doesNotThrow(() => buildSummaryGraph(query.graph), `graph failed to build: ${query.graph}`);
  }
});
