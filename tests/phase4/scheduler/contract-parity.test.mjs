import assert from 'node:assert/strict';
import * as contract from '../../../js/core/scheduler/index.js';
import * as implementation from '../../../js/core/scheduler/analysis-scheduler.js';

assert.equal(contract.ANALYSIS_SCHEDULER_VERSION, 'hex-analysis-scheduler-v1');
assert.equal(implementation.ANALYSIS_SCHEDULER_VERSION, contract.ANALYSIS_SCHEDULER_VERSION);
assert.strictEqual(implementation.ANALYSIS_PRIORITY, contract.ANALYSIS_PRIORITY);
assert.strictEqual(implementation.SchedulerCycleError, contract.SchedulerCycleError);
assert.strictEqual(implementation.SchedulerDependencyError, contract.SchedulerDependencyError);
assert.strictEqual(implementation.SchedulerDependencyIdentityError, contract.SchedulerDependencyIdentityError);
for (const method of ['request','cancel','dependencyIds','state','stats']) {
  assert.equal(typeof contract.AnalysisScheduler.prototype[method], 'function');
  assert.equal(typeof implementation.AnalysisScheduler.prototype[method], 'function');
}

console.log('phase4 scheduler frozen-contract parity: PASS');
