import assert from 'node:assert/strict';
import test from 'node:test';

import {
  EVIDENCE_SCHEMA_VERSION,
  EVIDENCE_VERDICT,
  CLAIM_KIND,
  PRECONDITION_STATUS,
  VALIDATION_STATUS,
  computeEvidenceId,
  createSymbolicEvidence,
  isProvedEvidence,
  isRefutedEvidence,
} from '../../../js/symbolic/evidence/symbolic-evidence.js';
import { SOLVER_STATUS } from '../../../js/symbolic/solver/result.js';
import { COMPLETENESS_STATUS, createAssumption, createCompleteness } from '../../../js/symbolic/translate/support-matrix.js';

test('SymbolicEvidence schema builder produces immutable validated evidence records', () => {
  const assumption = createAssumption({
    id: 'asm_1',
    kind: 'memory-read-immutable',
    statement: 'Global table assumed stable',
  });

  const completeness = createCompleteness({
    translation: COMPLETENESS_STATUS.COMPLETE,
    controlFlow: COMPLETENESS_STATUS.COMPLETE,
    memoryEffects: COMPLETENESS_STATUS.COMPLETE,
    pathCoverage: COMPLETENESS_STATUS.COMPLETE,
    queryScope: COMPLETENESS_STATUS.COMPLETE,
  });

  const evidence = createSymbolicEvidence({
    queryKind: 'edge-feasibility',
    claimKind: CLAIM_KIND.EDGE_FEASIBILITY,
    proofStatement: 'Edge 0x1000->0x1020 is infeasible under precondition P',
    targetEntities: ['func:0x1000', 'block:0x1000', 'edge:0x1000->0x1020'],
    queryHash: 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90',
    exprSchemaVersion: '1.0.0',
    translatorVersion: '1.0.0',
    backendId: 'fake-solver',
    backendVersion: '1.0.0',
    solverStatus: SOLVER_STATUS.UNSAT,
    preconditionStatus: PRECONDITION_STATUS.SATISFIABLE,
    validationStatus: VALIDATION_STATUS.NOT_APPLICABLE,
    assumptions: [assumption],
    completeness,
    origins: { 'sym:1': ['inst:0x1004', 'arg:x0'] },
    verdict: EVIDENCE_VERDICT.PROVED,
    witnessModel: null,
  });

  assert.equal(evidence.schemaVersion, EVIDENCE_SCHEMA_VERSION);
  assert.equal(evidence.schemaVersion, '1.0.0');
  assert.equal(evidence.queryKind, 'edge-feasibility');
  assert.equal(evidence.claimKind, 'edge-feasibility');
  assert.equal(evidence.proofStatement, 'Edge 0x1000->0x1020 is infeasible under precondition P');
  assert.deepEqual(evidence.targetEntities, ['func:0x1000', 'block:0x1000', 'edge:0x1000->0x1020']);
  assert.equal(evidence.queryHash, 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90');
  assert.equal(evidence.exprSchemaVersion, '1.0.0');
  assert.equal(evidence.translatorVersion, '1.0.0');
  assert.equal(evidence.backendId, 'fake-solver');
  assert.equal(evidence.backendVersion, '1.0.0');
  assert.equal(evidence.solverStatus, SOLVER_STATUS.UNSAT);
  assert.equal(evidence.preconditionStatus, PRECONDITION_STATUS.SATISFIABLE);
  assert.equal(evidence.validationStatus, VALIDATION_STATUS.NOT_APPLICABLE);
  assert.equal(evidence.verdict, EVIDENCE_VERDICT.PROVED);
  assert.equal(evidence.witnessModel, null);
  assert.match(evidence.id, /^ev_[a-f0-9]{32}$/);

  // Assert deep immutability
  assert.ok(Object.isFrozen(evidence));
  assert.ok(Object.isFrozen(evidence.targetEntities));
  assert.ok(Object.isFrozen(evidence.assumptions));
  assert.ok(Object.isFrozen(evidence.completeness));
  assert.ok(Object.isFrozen(evidence.origins));

  assert.throws(() => {
    evidence.verdict = 'refuted';
  }, TypeError);
  assert.throws(() => {
    evidence.targetEntities.push('extra');
  }, TypeError);

  assert.equal(isProvedEvidence(evidence), true);
  assert.equal(isRefutedEvidence(evidence), false);
});

test('SymbolicEvidence handles counterexample models for refuted claims', () => {
  const modelMap = new Map([
    ['arg_x0', 42n],
    ['arg_x1', 0x100n],
  ]);

  const evidence = createSymbolicEvidence({
    queryKind: 'bounded-equivalence',
    claimKind: CLAIM_KIND.BOUNDED_EQUIVALENCE,
    proofStatement: 'Patch produces divergence on input x0=42, x1=256',
    targetEntities: ['patch:0x2000'],
    queryHash: 'deadbeef12345678deadbeef12345678deadbeef12345678deadbeef12345678',
    backendId: 'fake-solver',
    backendVersion: '1.0.0',
    solverStatus: SOLVER_STATUS.SAT,
    preconditionStatus: PRECONDITION_STATUS.SATISFIABLE,
    validationStatus: VALIDATION_STATUS.VALIDATED,
    verdict: EVIDENCE_VERDICT.REFUTED,
    witnessModel: modelMap,
  });

  assert.equal(evidence.verdict, EVIDENCE_VERDICT.REFUTED);
  assert.equal(evidence.validationStatus, VALIDATION_STATUS.VALIDATED);
  assert.deepEqual(evidence.witnessModel, {
    arg_x0: '0x2a',
    arg_x1: '0x100',
  });
  assert.ok(Object.isFrozen(evidence.witnessModel));

  assert.equal(isProvedEvidence(evidence), false);
  assert.equal(isRefutedEvidence(evidence), true);
});

test('SymbolicEvidence rejects missing or invalid required fields', () => {
  const baseValid = {
    queryKind: 'edge-feasibility',
    claimKind: CLAIM_KIND.EDGE_FEASIBILITY,
    proofStatement: 'Edge is infeasible',
    targetEntities: ['func:0x1000'],
    queryHash: 'hash123',
    exprSchemaVersion: '1.0.0',
    translatorVersion: '1.0.0',
    backendId: 'fake-solver',
    backendVersion: '1.0.0',
    solverStatus: SOLVER_STATUS.UNSAT,
    verdict: EVIDENCE_VERDICT.PROVED,
  };

  // Missing queryKind
  assert.throws(() => createSymbolicEvidence({ ...baseValid, queryKind: '' }), TypeError);
  assert.throws(() => createSymbolicEvidence({ ...baseValid, queryKind: null }), TypeError);

  // Missing claimKind
  assert.throws(() => createSymbolicEvidence({ ...baseValid, claimKind: '' }), TypeError);

  // Missing proofStatement
  assert.throws(() => createSymbolicEvidence({ ...baseValid, proofStatement: '' }), TypeError);

  // Invalid targetEntities (not array)
  assert.throws(() => createSymbolicEvidence({ ...baseValid, targetEntities: 'func:0x1000' }), TypeError);

  // Missing queryHash
  assert.throws(() => createSymbolicEvidence({ ...baseValid, queryHash: '' }), TypeError);

  // Missing backendId
  assert.throws(() => createSymbolicEvidence({ ...baseValid, backendId: '' }), TypeError);

  // Invalid solverStatus
  assert.throws(() => createSymbolicEvidence({ ...baseValid, solverStatus: 'non-existent-status' }), TypeError);

  // Invalid verdict
  assert.throws(() => createSymbolicEvidence({ ...baseValid, verdict: 'maybe-proved' }), TypeError);

  // Invalid preconditionStatus
  assert.throws(() => createSymbolicEvidence({ ...baseValid, preconditionStatus: 'bogus' }), TypeError);

  // Invalid validationStatus
  assert.throws(() => createSymbolicEvidence({ ...baseValid, validationStatus: 'bogus' }), TypeError);
});

test('SymbolicEvidence enforces fail-closed semantic invariants', () => {
  const base = {
    queryKind: 'edge-feasibility',
    claimKind: CLAIM_KIND.EDGE_FEASIBILITY,
    proofStatement: 'Edge is infeasible',
    targetEntities: ['func:0x1000'],
    queryHash: 'hash123',
    backendId: 'fake-solver',
    backendVersion: '1.0.0',
  };

  // Invariant 1: Inconsistent precondition cannot mint proved evidence (vacuous truth prevention)
  assert.throws(
    () =>
      createSymbolicEvidence({
        ...base,
        solverStatus: SOLVER_STATUS.UNSAT,
        preconditionStatus: PRECONDITION_STATUS.INCONSISTENT,
        verdict: EVIDENCE_VERDICT.PROVED,
      }),
    /cannot mint proved evidence when preconditions are inconsistent/
  );

  // Invariant 2: Solver failures cannot mint proved evidence
  const failureStatuses = [
    SOLVER_STATUS.TIMEOUT,
    SOLVER_STATUS.RESOURCE_LIMIT,
    SOLVER_STATUS.UNSUPPORTED,
    SOLVER_STATUS.CANCELLED,
    SOLVER_STATUS.PROVIDER_FAILURE,
    SOLVER_STATUS.INVALID_QUERY,
    SOLVER_STATUS.UNKNOWN,
  ];

  for (const failureStatus of failureStatuses) {
    assert.throws(
      () =>
        createSymbolicEvidence({
          ...base,
          solverStatus: failureStatus,
          verdict: EVIDENCE_VERDICT.PROVED,
        }),
      /cannot mint proved evidence with solver failure status/
    );
  }

  // Invariant 3: Unsupported translation cannot mint proved evidence
  assert.throws(
    () =>
      createSymbolicEvidence({
        ...base,
        solverStatus: SOLVER_STATUS.UNSAT,
        completeness: { translation: COMPLETENESS_STATUS.UNSUPPORTED },
        verdict: EVIDENCE_VERDICT.PROVED,
      }),
    /cannot mint proved evidence with unsupported translation completeness/
  );

  // Invariant 4: Refuted verdict with rejected counterexample model cannot be minted
  assert.throws(
    () =>
      createSymbolicEvidence({
        ...base,
        solverStatus: SOLVER_STATUS.SAT,
        validationStatus: VALIDATION_STATUS.REJECTED,
        verdict: EVIDENCE_VERDICT.REFUTED,
      }),
    /cannot mint refuted evidence when witness model validation was rejected/
  );
});

test('SymbolicEvidence generates deterministic collision-resistant evidence IDs', () => {
  const payload1 = {
    queryKind: 'edge-feasibility',
    claimKind: CLAIM_KIND.EDGE_FEASIBILITY,
    proofStatement: 'Edge is infeasible',
    targetEntities: ['func:0x1000', 'block:0x1000'],
    queryHash: 'hash_abc',
    backendId: 'fake-solver',
    backendVersion: '1.0.0',
    solverStatus: SOLVER_STATUS.UNSAT,
    verdict: EVIDENCE_VERDICT.PROVED,
  };

  const ev1 = createSymbolicEvidence(payload1);
  const ev2 = createSymbolicEvidence(payload1);

  // Determinism
  assert.equal(ev1.id, ev2.id);

  // Sensitivity to target difference
  const evDiffTarget = createSymbolicEvidence({
    ...payload1,
    targetEntities: ['func:0x1000', 'block:0x2000'],
  });
  assert.notEqual(ev1.id, evDiffTarget.id);

  // Sensitivity to backend difference
  const evDiffBackend = createSymbolicEvidence({
    ...payload1,
    backendId: 'z3',
  });
  assert.notEqual(ev1.id, evDiffBackend.id);

  // Sensitivity to query hash difference
  const evDiffQuery = createSymbolicEvidence({
    ...payload1,
    queryHash: 'hash_xyz',
  });
  assert.notEqual(ev1.id, evDiffQuery.id);
});
