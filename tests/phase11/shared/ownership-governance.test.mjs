import assert from 'node:assert/strict';
import {
  queryManagedRuntimeProvider,
  queryManagedSymbolicVerification,
} from '../../../js/managed/index.js';
import { architectureMaturity } from '../../../js/platform/capability-maturity.js';

console.log('[phase11] running ownership and governance tests...');

// 1. Phase 9 Solver-backed verification non-interference
const symResult = queryManagedSymbolicVerification('managed-method:123');
assert.equal(symResult.status, 'deferred');
assert.equal(symResult.reason, 'managed-solver-backend-unbound');

// 2. Phase 10 Runtime provider non-interference
const rtResult = queryManagedRuntimeProvider('managed-method:123');
assert.equal(rtResult.status, 'deferred');
assert.equal(rtResult.reason, 'managed-runtime-provider-unbound');

// 3. Native architecture maturity non-interference
const arm64Maturity = architectureMaturity('arm64');
assert.equal(arm64Maturity.implementedLevel, 'A6');

const x86Maturity = architectureMaturity('x86_64');
assert.equal(x86Maturity.implementedLevel, 'A6');

const riscvMaturity = architectureMaturity('riscv64');
assert.equal(riscvMaturity.implementedLevel, 'A6');

console.log('  ok ownership and governance tests passed');
