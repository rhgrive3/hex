import assert from 'node:assert/strict';
import {
  assertExternalOraclePolicy,
  createExternalOracleEvidence,
  inspectExternalOracleInfrastructure,
} from '../../tools/validation/machine-effects/external-oracles.mjs';

const report = inspectExternalOracleInfrastructure();
assert.equal(report.defaultNetworkRequired, false);
assert.equal(assertExternalOraclePolicy(report), true);

const byId = new Map(report.entries.map((entry) => [entry.id, entry]));
assert.equal(byId.get('compiler-truth').available, true);
assert.equal(byId.get('compiler-truth').role, 'independent-source-and-concrete-vector-evidence');
assert.equal(byId.get('ghidra-differential').available, true);
assert.equal(byId.get('ghidra-differential').semanticAuthority, 'not-absolute-isa-truth');
assert.equal(byId.get('capstone').available, true);
assert.equal(byId.get('capstone').semanticAuthority, 'disassembly-text-does-not-prove-semantics');

const compilerEvidence = createExternalOracleEvidence({
  oracleId:'compiler-truth',
  subject:'signed max source manifest',
  verdict:'supports',
  details:{ vectors:9 },
});
assert.equal(compilerEvidence.semanticAuthority, 'source-manifest-and-independent-evaluation-only');

const ghidraEvidence = createExternalOracleEvidence({
  oracleId:'ghidra-differential',
  subject:'function output comparison',
  verdict:'diagnostic',
});
assert.equal(ghidraEvidence.role, 'external-differential-diagnostic');

assert.throws(() => createExternalOracleEvidence({ oracleId:'capstone', subject:'add', verdict:'proves-semantics' }), /invalid-external-oracle-verdict/);

console.log('machine-effects external oracle policy: PASS');
