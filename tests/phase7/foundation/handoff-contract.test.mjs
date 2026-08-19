import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  PHASE7_ANALYSIS_CONTRACT_VERSION,
  analyzeInterproceduralSummaries,
  createAnalysisSurface,
  functionCandidates,
} from '../../../js/analysis/index.js';
import { isCompleteStatus } from '../../../js/analysis/status.js';
import { buildFixture, memoryAccessOf, regionOf } from '../corpus/fixtures.mjs';
import { buildSummaryGraph } from '../corpus/summaries.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

function surfaceFor(fixtureId) {
  const built = buildFixture(fixtureId);
  return {
    built,
    surface: createAnalysisSurface({
      ir: built.ir, cfg: built.cfg, ssa: built.ssa, memorySsa: built.memorySsa,
      snapshotId: 'snapshot_handoff', resolveRegion: built.resolveRegion,
      options: built.rootDescriptors == null ? {} : { canonicalOptions: { rootDescriptors: built.rootDescriptors } },
    }),
  };
}

/**
 * The Phase 8 handoff contract (§22). Phase 8 consumes exactly these boundaries
 * and never private solver state, so that SCCP/GVN/DCE can improve without
 * coupling to a particular Phase 7 implementation.
 */
const REQUIRED_CAPABILITIES = Object.freeze([
  'alias',
  'reachingMemoryDef',
  'memoryEffects',
  'explainMemoryPath',
  'functionSummary',
  'escape',
  'explainType',
]);

test('the public surface exposes every handoff capability', () => {
  const { surface } = surfaceFor('stack-disjoint');
  for (const capability of REQUIRED_CAPABILITIES) {
    assert.equal(typeof surface[capability], 'function', `missing handoff capability: ${capability}`);
  }
  assert.equal(typeof functionCandidates, 'function');
  assert.equal(typeof analyzeInterproceduralSummaries, 'function');
  assert.ok(PHASE7_ANALYSIS_CONTRACT_VERSION);
});

test('every answer carries a status', () => {
  const { built, surface } = surfaceFor('stack-disjoint');
  const alias = surface.alias(regionOf(built, 'node_st0'), regionOf(built, 'node_st8'), {
    leftAccess: memoryAccessOf(built, 'node_st0'), rightAccess: memoryAccessOf(built, 'node_st8'),
  });
  assert.ok(alias.status, 'an alias answer without a status cannot be judged for completeness');
  assert.ok(surface.memoryEffects().status);
  assert.ok(surface.functionSummary().status);
  assert.ok(surface.escape().status);
  assert.ok(surface.explainType('entity_absent').status);
});

test('the surface answers a real alias query through the boundary', () => {
  const { built, surface } = surfaceFor('stack-disjoint');
  const result = surface.alias(regionOf(built, 'node_st0'), regionOf(built, 'node_st8'), {
    leftAccess: memoryAccessOf(built, 'node_st0'), rightAccess: memoryAccessOf(built, 'node_st8'),
  });
  assert.equal(result.relation, 'no');
  assert.ok(result.reasonCodes.length > 0);
});

test('a blocked memory link is reported as blocked, not as missing', () => {
  const { built, surface } = surfaceFor('unknown-store-barrier');
  const use = built.memorySsa.uses.find((item) => item.sourceEntityId === 'node_ld');
  const answer = surface.reachingMemoryDef(use);
  assert.ok(answer.definition, 'a clobber is a real answer');
  assert.equal(answer.blocked, true);
});

test('memory effects stay conservative when the summary is incomplete', () => {
  const { surface } = surfaceFor('unknown-call-barrier');
  const effects = surface.memoryEffects({ regionId: 'region_that_does_not_exist' });
  assert.equal(effects.mayWrite, true);
  assert.equal(isCompleteStatus(effects.status), false);
  assert.ok(effects.unknownCalls.length > 0);
});

test('the memory path can be explained through the boundary', () => {
  const { built, surface } = surfaceFor('stack-identical');
  const use = built.memorySsa.uses.find((item) => item.sourceEntityId === 'node_ld');
  const explained = surface.explainMemoryPath(use);
  assert.ok(explained.path, 'a proof path must be reachable from the public surface');
});

test('interprocedural summaries are reachable without private solver state', () => {
  const solved = analyzeInterproceduralSummaries({
    roots: ['fn_top'], localSummaries: buildSummaryGraph('mutual-recursion'),
  });
  assert.equal(solved.status.completeness, 'complete');
  assert.ok(solved.summaries.get('fn_top'));
});

test('function candidates are reachable without private solver state', () => {
  const result = functionCandidates({
    input: { image: { functionStarts: [{ address: 0x1000, name: 'alpha' }] } },
    architectureId: 'generic',
  });
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].startState, 'exact');
});

test('constructing the surface performs no analysis', () => {
  // Opening a binary must not trigger a whole-program solve (P7-INV-009).
  const built = buildFixture('cyclic-pointer-phi');
  const started = process.hrtime.bigint();
  createAnalysisSurface({ ir: built.ir, cfg: built.cfg, ssa: built.ssa, memorySsa: built.memorySsa });
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
  assert.ok(elapsedMs < 5, `constructing the surface took ${elapsedMs} ms, so it solved something`);
});

test('one surface is bound to one snapshot', () => {
  // P7-INV-012: a query must not mix an old MemorySSA graph with a new alias
  // result, so the snapshot is fixed at construction and exposed for auditing.
  const { surface } = surfaceFor('stack-disjoint');
  assert.equal(surface.snapshotId, 'snapshot_handoff');
  assert.throws(() => { surface.snapshotId = 'other'; }, TypeError);
});

test('no Phase 7 consumer reaches into private solver state', () => {
  // The decompiler and UI must come through the public surface. A direct import
  // of a solver internal is the coupling §22 forbids.
  const forbidden = [
    'js/analysis/pointsto/local.js',
    'js/analysis/pointsto/lattice.js',
    'js/analysis/summary/interprocedural.js',
  ];
  const consumerDirs = ['js/decompiler', 'js/ui', 'js/ai'];
  const offenders = [];
  const visit = (directory) => {
    const absolute = path.join(ROOT, directory);
    if (!fs.existsSync(absolute)) return;
    for (const entry of fs.readdirSync(absolute, { withFileTypes: true })) {
      const relative = path.join(directory, entry.name);
      if (entry.isDirectory()) { visit(relative); continue; }
      if (!entry.name.endsWith('.js')) continue;
      const source = fs.readFileSync(path.join(ROOT, relative), 'utf8');
      for (const target of forbidden) {
        const basename = target.split('/').slice(-2).join('/');
        if (source.includes(basename)) offenders.push(`${relative} -> ${target}`);
      }
    }
  };
  for (const directory of consumerDirs) visit(directory);
  assert.deepEqual(offenders, [], 'these consumers import Phase 7 solver internals directly');
});
