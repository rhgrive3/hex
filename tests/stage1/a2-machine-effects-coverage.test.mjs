import assert from 'node:assert/strict';
import { parseOperands } from '../../js/arm64.js';
import '../../js/targets/architecture/index.js';
import {
  MACHINE_EFFECTS_COVERAGE_SCHEMA,
  classifyMachineEffectsCoverage,
  machineEffectsCoverageDescriptor,
  measureMachineEffectsCoverage,
} from '../../js/targets/architecture/coverage.js';

function arm64Instruction(instructionId, mnemonic, operands = '', extra = {}) {
  return {
    instructionId,
    mnemonic,
    operands,
    ops: parseOperands(operands),
    mode: 'a64',
    address: 0x4000n,
    origin: { instructionIds: [instructionId] },
    ...extra,
  };
}

{
  const descriptor = machineEffectsCoverageDescriptor('arm64');
  assert.equal(descriptor.schemaVersion, MACHINE_EFFECTS_COVERAGE_SCHEMA);
  assert.equal(descriptor.architectureId, 'arm64');
  assert.equal(descriptor.denominator, 'observed-decoded-instructions');
  assert.equal(descriptor.unsupportedPolicy, 'explicit');
}

const exact = arm64Instruction('stage1-arm64-exact', 'b', '#0x5000', { branchTarget: 0x5000n });
const unsupported = arm64Instruction('stage1-arm64-unsupported', 'stage1_unsupported_opcode');

{
  const result = classifyMachineEffectsCoverage('arm64', exact);
  assert.equal(result.status, 'covered');
  assert.equal(result.completeness, 'exact');
  assert.equal(result.exact, true);
  assert.equal(result.instructionId, exact.instructionId);
}

{
  const result = classifyMachineEffectsCoverage('arm64', unsupported);
  assert.equal(result.status, 'unsupported');
  assert.equal(result.reason, 'machine-effects-not-lifted');
}

{
  const result = measureMachineEffectsCoverage('arm64', [exact, unsupported]);
  assert.equal(result.denominatorCount, 2);
  assert.equal(result.coveredCount, 1);
  assert.equal(result.exactCount, 1);
  assert.equal(result.unsupportedCount, 1);
  assert.equal(result.errorCount, 0);
  assert.equal(result.coverageRate, 0.5);
  assert.equal(result.exactRate, 0.5);
  assert.deepEqual(result.counts, {
    exact: 1,
    exactWithIntrinsic: 0,
    partial: 0,
    unknown: 0,
    unsupported: 1,
    error: 0,
  });
  assert.equal(result.classifications.length, result.denominatorCount);
}

{
  const result = measureMachineEffectsCoverage('arm64', []);
  assert.equal(result.denominatorCount, 0);
  assert.equal(result.coverageRate, null);
  assert.equal(result.exactRate, null);
}

{
  const descriptor = machineEffectsCoverageDescriptor('unknown');
  assert.equal(descriptor.architectureId, 'unknown');
  assert.equal(descriptor.capability, 'unsupported');
  const result = classifyMachineEffectsCoverage('unknown', exact);
  assert.equal(result.status, 'unsupported');
  assert.equal(result.reason, 'machine-effects-lifter-unavailable');
}

{
  const failingPlugin = {
    id: 'stage1-failing',
    semanticVersion: '1',
    modes: () => ['test'],
    capabilities: { exactEffects: 'partial' },
    liftExact() { throw new Error('boom'); },
  };
  const result = classifyMachineEffectsCoverage(failingPlugin, exact);
  assert.equal(result.status, 'error');
  assert.equal(result.reason, 'machine-effects-lifter-error');
  assert.equal(result.error.message, 'boom');
}

console.log('stage1 A2 MachineEffects measured coverage: PASS');
