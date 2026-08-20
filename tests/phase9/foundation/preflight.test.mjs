import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { PHASE7_ANALYSIS_CONTRACT_VERSION } from '../../../js/analysis/index.js';
import {
  ANALYSIS_STATUS_SCHEMA_VERSION,
  ANALYSIS_STATUS_CONTRACT_VERSION,
  ANALYSIS_STOP_REASONS,
} from '../../../js/analysis/status.js';
import { SYM } from '../../../js/symbolic/executor.js';
import { ToolRegistry } from '../../../js/ai/tools/registry.js';
import { ObservationStore } from '../../../js/ai/tools/storage/observation-store.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const readJson = (relative) => JSON.parse(fs.readFileSync(path.join(ROOT, relative), 'utf8'));
const preflight = readJson('reports/phase9/preflight.json');
const phase8Ledger = readJson('reports/phase8/checkpoints.json');

test('P9-0 is pinned to the verified Phase 8 handoff', () => {
  assert.equal(preflight.checkpoint, 'P9-0-preflight');
  assert.equal(preflight.recordedFromMain.commitSha, 'b9728ded0913d39b9886df7e66a7e07bb6153ab9');
  assert.equal(preflight.recordedFromMain.treeSha, '10a14553c15a499c14b611efb336dc536bf758e2');
  assert.equal(preflight.phase8Handoff.status, 'accepted');
  assert.equal(preflight.phase8Handoff.verdict, 'READY');

  const p8i = phase8Ledger.checkpoints.find((entry) => entry.id === 'P8-I');
  assert.ok(p8i, 'durable Phase 8 ledger must retain P8-I');
  assert.equal(p8i.result, 'accepted');
  assert.equal(p8i.integrationSha, preflight.phase8Handoff.productionCandidateSha);
  assert.equal(p8i.integrationTreeSha, preflight.phase8Handoff.productionCandidateTree);
  assert.equal(p8i.corpusDigest, preflight.phase8Handoff.corpusDigest);
  assert.deepEqual(
    p8i.toolchain.targets.map((target) => target.architectureId).sort(),
    [...preflight.phase8Handoff.mandatoryArchitectures].sort(),
  );
  assert.equal(fs.existsSync(path.join(ROOT, 'tools/validation/phase8/p8i-cutover-request.json')), false,
    'consumed Phase 8 cutover request must not survive into Phase 9');
});

test('live upstream analysis contracts are explicitly pinned rather than reimplemented', () => {
  assert.equal(PHASE7_ANALYSIS_CONTRACT_VERSION, preflight.contracts.analysisBoundary.contractVersion);
  assert.equal(ANALYSIS_STATUS_SCHEMA_VERSION, preflight.contracts.analysisStatus.schemaVersion);
  assert.equal(ANALYSIS_STATUS_CONTRACT_VERSION, preflight.contracts.analysisStatus.contractVersion);
  for (const reason of ['cancelled', 'timeout', 'budget-exhausted', 'memory-limit', 'dependency-missing', 'dependency-mismatch']) {
    assert.ok(ANALYSIS_STOP_REASONS.includes(reason), `analysis status must retain fail-closed reason ${reason}`);
  }
});

test('the bounded symbolic fast path remains separate and explicitly unknown-aware', () => {
  assert.notEqual(SYM.UNKNOWN, SYM.SYMBOL);
  assert.equal(preflight.contracts.fastSymbolicEvaluator.explicitUnknown, true);
  assert.equal(preflight.contracts.fastSymbolicEvaluator.replacementAllowed, false);
  assert.equal(preflight.contracts.fastSymbolicEvaluator.mode, 'bounded-conservative');
});

test('Phase 9 proof tools cannot silently inherit the current automatic cache contract', () => {
  const registry = new ToolRegistry({ context: { binaryIdentity: 'fixture', analysisRevision: 'r1' } });
  registry.register({ name: 'phase9_probe', execute: async () => ({ ok: true }) });
  const definition = registry.get('phase9_probe');
  assert.equal(definition.deterministic, true);
  assert.equal(definition.storeResult, true);
  assert.equal(
    preflight.contracts.toolRegistry.automaticCachePolicy,
    'disabled-for-phase9-proof-tools-until-version-safe-fingerprint',
  );
});

test('ObservationStore cache identity behavior is recorded from the live implementation', () => {
  const store = new ObservationStore({
    context: {
      binaryIdentity: 'binary-a',
      analysisRevision: 'analysis-1',
      sliceIdentity: 'slice-a',
      projectRevision: 'project-1',
      runtimeSessionId: 'runtime-1',
    },
  });
  const sameA = store.cacheKey('phase9_probe', { value: 1 });
  const sameB = store.cacheKey('phase9_probe', { value: 1 });
  const differentArgs = store.cacheKey('phase9_probe', { value: 2 });
  assert.equal(sameA, sameB);
  assert.notEqual(sameA, differentArgs);

  store.setContext({
    binaryIdentity: 'binary-a',
    analysisRevision: 'analysis-2',
    sliceIdentity: 'slice-a',
    projectRevision: 'project-1',
    runtimeSessionId: 'runtime-1',
  });
  assert.notEqual(sameA, store.cacheKey('phase9_probe', { value: 1 }));
  assert.match(preflight.contracts.observationStore.phase9Requirement, /verifier\/backend\/query\/expr\/translator\/semantic versions/);
});

test('Wave 0 is ready while proof publication, proof cache, and remote egress stay fail-closed', () => {
  assert.equal(preflight.wave0.ready, true);
  assert.deepEqual(preflight.wave0.blockingPrerequisites, []);
  assert.ok(preflight.wave0.allowedParallelLanes.includes('contract-and-adversarial-corpus'));
  assert.ok(preflight.wave0.allowedParallelLanes.includes('bool-bv-expression-dag'));
  assert.ok(preflight.wave0.allowedParallelLanes.includes('solver-backend-lifecycle-and-fake-backend'));
  assert.ok(preflight.wave0.forbiddenUntilFrozen.includes('proof-producing-public-api'));
  assert.ok(preflight.wave0.forbiddenUntilFrozen.includes('automatic-proof-cache'));
  assert.ok(preflight.wave0.forbiddenUntilFrozen.includes('remote-solver-data-egress'));

  const provider = preflight.deferredDecisions.find((entry) => entry.id === 'solver-provider');
  const remote = preflight.deferredDecisions.find((entry) => entry.id === 'remote-solver-policy');
  assert.equal(provider.status, 'unselected');
  assert.equal(provider.blockingWave0, false);
  assert.equal(remote.status, 'disabled-until-explicit-policy');
});

test('canonical Phase 9 planning and architecture sources are present', () => {
  for (const relative of [
    'docs/HEX_MASTER_ARCHITECTURE.md',
    'docs/PHASE9_SOLVER_BACKED_VERIFICATION_IMPLEMENTATION_GUIDE.ja.md',
    'docs/PHASE9_WORKER_PROMPTS.ja.md',
  ]) {
    assert.equal(fs.existsSync(path.join(ROOT, relative)), true, `${relative} must exist`);
  }
});
