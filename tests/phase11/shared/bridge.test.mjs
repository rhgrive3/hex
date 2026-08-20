import assert from 'node:assert/strict';
import {
  analyzeManagedInterprocedural,
  buildManagedMethodSummary,
  buildManagedTypeConstraintGraph,
  createManagedMethodId,
  createVMOperationId,
  createVMEffectBundle,
  createVMEffectFunction,
  decompileManagedMethod,
  lowerVMEffectsToSemanticIr,
  queryManagedRuntimeProvider,
  queryManagedSymbolicVerification,
} from '../../../js/managed/index.js';
import { FakeSolverBackend } from '../../../js/symbolic/solver/fake-backend.js';

console.log('[phase11] running shared bridge tests...');

const methodId = createManagedMethodId('mod-shared', 'complexBranching');

// Bytecodes:
// 0: const 10
// 2: const 20
// 4: if_lt -> target offset 10
// 6: const 100
// 8: goto -> target offset 12
// 10: const 200
// 12: return
const bundles = [
  createVMEffectBundle({
    frontendId: 'wasm',
    methodId,
    operationId: createVMOperationId(methodId, 0),
    bytecodeOffset: 0,
    mnemonic: 'const',
    producedValues: [{ bits: 32, constant: 10 }],
    completeness: 'exact',
  }),
  createVMEffectBundle({
    frontendId: 'wasm',
    methodId,
    operationId: createVMOperationId(methodId, 2),
    bytecodeOffset: 2,
    mnemonic: 'const',
    producedValues: [{ bits: 32, constant: 20 }],
    completeness: 'exact',
  }),
  createVMEffectBundle({
    frontendId: 'wasm',
    methodId,
    operationId: createVMOperationId(methodId, 4),
    bytecodeOffset: 4,
    mnemonic: 'if_lt',
    consumedValues: [{ id: 'rhs', bits: 32 }, { id: 'lhs', bits: 32 }],
    controlEffects: [{ kind: 'conditional-branch', targetOffset: 10 }],
    completeness: 'exact',
  }),
  createVMEffectBundle({
    frontendId: 'wasm',
    methodId,
    operationId: createVMOperationId(methodId, 6),
    bytecodeOffset: 6,
    mnemonic: 'const',
    producedValues: [{ bits: 32, constant: 100 }],
    completeness: 'exact',
  }),
  createVMEffectBundle({
    frontendId: 'wasm',
    methodId,
    operationId: createVMOperationId(methodId, 8),
    bytecodeOffset: 8,
    mnemonic: 'goto',
    controlEffects: [{ kind: 'branch', targetOffset: 12 }],
    completeness: 'exact',
  }),
  createVMEffectBundle({
    frontendId: 'wasm',
    methodId,
    operationId: createVMOperationId(methodId, 10),
    bytecodeOffset: 10,
    mnemonic: 'const',
    producedValues: [{ bits: 32, constant: 200 }],
    completeness: 'exact',
  }),
  createVMEffectBundle({
    frontendId: 'wasm',
    methodId,
    operationId: createVMOperationId(methodId, 12),
    bytecodeOffset: 12,
    mnemonic: 'return',
    controlEffects: [{ kind: 'return' }],
    completeness: 'exact',
  }),
];

const vmFn = createVMEffectFunction({
  methodId,
  frontendId: 'wasm',
  bundles,
  exceptionRegions: [
    { startOffset: 0, endOffset: 8, handlerOffset: 10 },
  ],
  aggregateCompleteness: 'exact',
});

const lowered = lowerVMEffectsToSemanticIr(vmFn);
assert.ok(lowered.semanticIr);
assert.ok(lowered.cfg);
assert.ok(lowered.ssa);

// Verify that multiple CFG blocks were formed from branches
assert.ok(lowered.cfg.blocks.length >= 3, `Expected at least 3 CFG blocks, got ${lowered.cfg.blocks.length}`);

// Verify that SSA contains phi/dataflow structures
assert.equal(lowered.ssa.functionId, methodId);

// 2. Test Phase 9 Solver Verification query
const unbackedQuery = queryManagedSymbolicVerification(methodId);
assert.equal(unbackedQuery.status, 'deferred');
assert.equal(unbackedQuery.reason, 'managed-solver-backend-unbound');

const fakeBackend = new FakeSolverBackend({ id: 'fake-solver', version: '1.0.0' });
const solverNoFormulas = queryManagedSymbolicVerification(methodId, { backend: fakeBackend });
assert.equal(solverNoFormulas.status, 'deferred');
assert.equal(solverNoFormulas.reason, 'managed-symbolic-formulas-unspecified');

const connectedSolver = queryManagedSymbolicVerification(methodId, {
  backend: fakeBackend,
  formulas: ['assert (x > 0)'],
});
assert.equal(connectedSolver.status, 'connected');
assert.equal(connectedSolver.backendId, 'fake-solver');
assert.ok(connectedSolver.session);

// 3. Test Phase 10 Runtime Provider query
const unbackedRuntime = queryManagedRuntimeProvider(methodId);
assert.equal(unbackedRuntime.status, 'deferred');
assert.equal(unbackedRuntime.reason, 'managed-runtime-provider-unbound');

const fakeProvider = { id: 'test-runtime-provider', providerId: 'test-runtime-provider' };
const runtimeNoEvidence = queryManagedRuntimeProvider(methodId, { provider: fakeProvider });
assert.equal(runtimeNoEvidence.status, 'deferred');
assert.equal(runtimeNoEvidence.reason, 'managed-runtime-identity-evidence-missing');

const connectedRuntime = queryManagedRuntimeProvider(methodId, {
  provider: fakeProvider,
  moduleEvidence: { hash: 'abcd', matched: true },
});
assert.equal(connectedRuntime.status, 'connected');
assert.equal(connectedRuntime.providerId, 'test-runtime-provider');

// 4. Test M4 Type Constraint Graph
const graph = buildManagedTypeConstraintGraph({
  methodId,
  returnType: 'i32',
  params: ['i32', 'i32'],
  debugLocalVariables: [{ slot: 0, name: 'counter', type: 'int' }],
});
const solvedReturn = graph.solveEntity(`${methodId}:return`);
assert.equal(solvedReturn.layers.nominal?.selected?.descriptor?.name, 'i32');
assert.equal(solvedReturn.layers.nominal?.confidence, 'certain');

const solvedLocal = graph.solveEntity(`${methodId}:local_0`);
assert.equal(solvedLocal.layers.nominal?.selected?.descriptor?.name, 'int');
assert.equal(solvedLocal.layers.nominal?.confidence, 'probable'); // debug evidence never claims 'certain'

// 5. Test M4 Method Summary & Interprocedural
const summary = buildManagedMethodSummary(lowered);
assert.equal(summary.methodId, methodId);
assert.ok(summary.hasExceptionEdges);

const interproc = analyzeManagedInterprocedural([vmFn]);
assert.ok(interproc.components.length >= 1);

// 6. Test M5 Decompiler
const decompiled = decompileManagedMethod(lowered);
assert.ok(decompiled.pseudocode);
assert.ok(decompiled.decompiledAst);
assert.ok(decompiled.lines.length > 0);

console.log('  ok shared bridge tests passed');
