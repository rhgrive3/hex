import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runPhase3Verification } from '../../tools/validation/semantic-v2/report.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const report = await runPhase3Verification({ root });
assert.equal(report.reportVersion, 1);
assert.equal(report.status, 'blocking');
assert.equal(report.notIntegrated, true);
assert.equal(report.ssaCases.integrated, false);
assert.equal(report.memorySsaCases.integrated, false);
assert.equal(report.differentialNotIntegratedCount, 1);
assert.equal(report.mismatchCount, 0);
assert.equal(typeof report.architectureLeakCount, 'number');
assert.equal(typeof report.provenanceLossCount, 'number');
assert.doesNotThrow(() => JSON.stringify(report));
console.log('Phase 3 machine-readable verification report tests passed');
