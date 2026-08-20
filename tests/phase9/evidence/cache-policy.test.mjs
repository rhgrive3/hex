import assert from 'node:assert/strict';
import test from 'node:test';

import {
  computeVerifierFingerprint,
  isCacheableProof,
  getProofToolCacheOptions,
  computeProofCacheKey,
  VERIFIER_FINGERPRINT_SCHEMA_VERSION,
} from '../../../js/symbolic/evidence/cache-policy.js';
import { SOLVER_STATUS } from '../../../js/symbolic/solver/result.js';
import { COMPLETENESS_STATUS, createCompleteness } from '../../../js/symbolic/translate/support-matrix.js';
import { ToolRegistry } from '../../../js/ai/tools/registry.js';
import { ObservationStore } from '../../../js/ai/tools/storage/observation-store.js';

test('computeVerifierFingerprint produces deterministic toolchain binding', () => {
  const baseConfig = {
    queryKind: 'edge-feasibility',
    exprSchemaVersion: '1.0.0',
    exprDagVersion: '1.0.0',
    translatorVersion: '1.0.0',
    backendId: 'z3',
    backendVersion: '4.12.2',
    solverOptions: { timeoutMs: 5000, randomSeed: 42 },
  };

  const fp1 = computeVerifierFingerprint(baseConfig);
  const fp2 = computeVerifierFingerprint(baseConfig);

  assert.equal(fp1, fp2);
  assert.match(fp1, /^[a-f0-9]{64}$/);

  // Invariant to key insertion order in solverOptions
  const fpKeyOrder = computeVerifierFingerprint({
    ...baseConfig,
    solverOptions: { randomSeed: 42, timeoutMs: 5000 },
  });
  assert.equal(fp1, fpKeyOrder);

  // Sensitive to queryKind
  assert.notEqual(fp1, computeVerifierFingerprint({ ...baseConfig, queryKind: 'bounded-equivalence' }));

  // Sensitive to exprSchemaVersion
  assert.notEqual(fp1, computeVerifierFingerprint({ ...baseConfig, exprSchemaVersion: '1.1.0' }));

  // Sensitive to exprDagVersion
  assert.notEqual(fp1, computeVerifierFingerprint({ ...baseConfig, exprDagVersion: '1.1.0' }));

  // Sensitive to translatorVersion
  assert.notEqual(fp1, computeVerifierFingerprint({ ...baseConfig, translatorVersion: '2.0.0' }));

  // Sensitive to backendId
  assert.notEqual(fp1, computeVerifierFingerprint({ ...baseConfig, backendId: 'cvc5' }));

  // Sensitive to backendVersion
  assert.notEqual(fp1, computeVerifierFingerprint({ ...baseConfig, backendVersion: '4.13.0' }));

  // Sensitive to solverOptions values
  assert.notEqual(
    fp1,
    computeVerifierFingerprint({
      ...baseConfig,
      solverOptions: { timeoutMs: 10000, randomSeed: 42 },
    })
  );
});

test('computeVerifierFingerprint rejects missing or invalid required parameters', () => {
  assert.throws(() => computeVerifierFingerprint({}), TypeError);
  assert.throws(() => computeVerifierFingerprint({ queryKind: '' }), TypeError);
  assert.throws(() => computeVerifierFingerprint({ queryKind: 'edge-feasibility' }), TypeError);
  assert.throws(() => computeVerifierFingerprint({ queryKind: 'edge-feasibility', backendId: '' }), TypeError);
});

test('isCacheableProof allows only clean PROVED and REFUTED results', () => {
  const completeCompleteness = createCompleteness({
    translation: COMPLETENESS_STATUS.COMPLETE,
  });

  // Clean proved UNSAT result is cacheable
  assert.equal(
    isCacheableProof({
      verdict: 'proved',
      solverStatus: SOLVER_STATUS.UNSAT,
      completeness: completeCompleteness,
      hasUnresolvedUnknowns: false,
    }),
    true
  );

  // Clean refuted SAT result is cacheable
  assert.equal(
    isCacheableProof({
      verdict: 'refuted',
      solverStatus: SOLVER_STATUS.SAT,
      completeness: completeCompleteness,
      hasUnresolvedUnknowns: false,
      validationStatus: 'validated',
    }),
    true
  );

  // UNKNOWN verdict is NOT cacheable
  assert.equal(
    isCacheableProof({
      verdict: 'unknown',
      solverStatus: SOLVER_STATUS.UNKNOWN,
      completeness: completeCompleteness,
    }),
    false
  );

  // Solver failures (timeouts, limits, unsupported, provider failure, invalid query, cancelled) are NOT cacheable
  const failureStatuses = [
    SOLVER_STATUS.TIMEOUT,
    SOLVER_STATUS.RESOURCE_LIMIT,
    SOLVER_STATUS.UNSUPPORTED,
    SOLVER_STATUS.CANCELLED,
    SOLVER_STATUS.PROVIDER_FAILURE,
    SOLVER_STATUS.INVALID_QUERY,
    SOLVER_STATUS.UNKNOWN,
  ];

  for (const status of failureStatuses) {
    assert.equal(
      isCacheableProof({
        verdict: 'proved',
        solverStatus: status,
        completeness: completeCompleteness,
      }),
      false,
      `Failure status ${status} must not be cacheable`
    );
  }

  // Unresolved unknowns prevent caching
  assert.equal(
    isCacheableProof({
      verdict: 'proved',
      solverStatus: SOLVER_STATUS.UNSAT,
      completeness: completeCompleteness,
      hasUnresolvedUnknowns: true,
    }),
    false
  );

  // Unsupported or partial translation completeness prevents caching
  assert.equal(
    isCacheableProof({
      verdict: 'proved',
      solverStatus: SOLVER_STATUS.UNSAT,
      completeness: { translation: COMPLETENESS_STATUS.UNSUPPORTED },
    }),
    false
  );
  assert.equal(
    isCacheableProof({
      verdict: 'proved',
      solverStatus: SOLVER_STATUS.UNSAT,
      completeness: { translation: COMPLETENESS_STATUS.PARTIAL },
    }),
    false
  );

  // Inconsistent or unknown preconditions prevent caching
  assert.equal(
    isCacheableProof({
      verdict: 'proved',
      solverStatus: SOLVER_STATUS.UNSAT,
      preconditionStatus: 'inconsistent',
    }),
    false
  );
  assert.equal(
    isCacheableProof({
      verdict: 'proved',
      solverStatus: SOLVER_STATUS.UNSAT,
      preconditionStatus: 'unknown',
    }),
    false
  );

  // Rejected counterexample prevents caching
  assert.equal(
    isCacheableProof({
      verdict: 'refuted',
      solverStatus: SOLVER_STATUS.SAT,
      validationStatus: 'rejected',
    }),
    false
  );
});

test('getProofToolCacheOptions configures ToolRegistry and ObservationStore safely', async () => {
  const fingerprint = computeVerifierFingerprint({
    queryKind: 'edge-feasibility',
    exprSchemaVersion: '1.0.0',
    exprDagVersion: '1.0.0',
    translatorVersion: '1.0.0',
    backendId: 'fake-solver',
    backendVersion: '1.0.0',
  });

  const cacheOptions = getProofToolCacheOptions({ verifierFingerprint: fingerprint });

  assert.equal(cacheOptions.storeResult, true);
  assert.equal(cacheOptions.deterministic, false);
  assert.equal(cacheOptions.verifierFingerprint, fingerprint);

  let executions = 0;
  const observationStore = new ObservationStore({
    context: { binaryIdentity: 'bin_test', analysisRevision: 'rev_1' },
  });

  const registry = new ToolRegistry({
    context: { binaryIdentity: 'bin_test', analysisRevision: 'rev_1' },
    observationStore,
  });

  registry.register({
    name: 'verify_edge_feasibility_probe',
    inputSchema: { type: 'object', properties: { edgeId: { type: 'string' } }, required: ['edgeId'] },
    ...cacheOptions,
    execute: async ({ edgeId }) => {
      executions++;
      return { ok: true, edgeId, executionCount: executions };
    },
  });

  // Calling the tool twice with identical arguments must execute each time because deterministic is false
  const res1 = await registry.execute('verify_edge_feasibility_probe', { edgeId: 'edge_1' });
  const res2 = await registry.execute('verify_edge_feasibility_probe', { edgeId: 'edge_1' });

  assert.equal(executions, 2, 'Proof tool without version-safe automatic cache must re-execute rather than serve stale cache');
  assert.equal(res1.result.executionCount, 1);
  assert.equal(res2.result.executionCount, 2);
  assert.equal(res1.cached, undefined);
  assert.equal(res2.cached, undefined);

  // But observation is stored in observationStore without creating automatic cache lookup keys
  assert.equal(observationStore.records.size, 2);
  assert.equal(observationStore.cache.size, 0, 'No automatic cache entry is created when deterministic is false');

  const records = [...observationStore.records.values()];
  assert.equal(records[0].tool, 'verify_edge_feasibility_probe');
  assert.equal(records[0].cacheKey, null);
  assert.equal(records[1].tool, 'verify_edge_feasibility_probe');
  assert.equal(records[1].cacheKey, null);
});

test('computeProofCacheKey binds base, identity, revision, verifier fingerprint, and query hash', () => {
  const key1 = computeProofCacheKey({
    baseKey: 'proof:edge',
    queryHash: 'query_hash_123',
    verifierFingerprint: 'verifier_fp_456',
    binaryIdentity: 'binary_bin1',
    analysisRevision: 'rev_10',
  });

  assert.equal(key1, 'proof:edge::binary_bin1::rev_10::verifier_fp_456::query_hash_123');

  // Key changes if verifier fingerprint changes
  const keyDiffFp = computeProofCacheKey({
    baseKey: 'proof:edge',
    queryHash: 'query_hash_123',
    verifierFingerprint: 'verifier_fp_789',
    binaryIdentity: 'binary_bin1',
    analysisRevision: 'rev_10',
  });
  assert.notEqual(key1, keyDiffFp);

  // Key changes if query hash changes
  const keyDiffQuery = computeProofCacheKey({
    baseKey: 'proof:edge',
    queryHash: 'query_hash_999',
    verifierFingerprint: 'verifier_fp_456',
    binaryIdentity: 'binary_bin1',
    analysisRevision: 'rev_10',
  });
  assert.notEqual(key1, keyDiffQuery);

  // Rejection of missing required fields
  assert.throws(() => computeProofCacheKey({ queryHash: '' }), TypeError);
  assert.throws(() => computeProofCacheKey({ queryHash: 'h' }), TypeError);
});
