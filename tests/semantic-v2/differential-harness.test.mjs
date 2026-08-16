import assert from 'node:assert/strict';
import { runDifferentialHarness } from '../../tools/validation/semantic-v2/differential.mjs';
import { verifyPathProof, COMPATIBILITY_PATH } from '../../tools/validation/semantic-v2/path-proof.mjs';

const adapters = {
  legacy:{ async run(input) { return input.legacy; } },
  v2:{
    async machineEffects(input) { return input; },
    async semanticIrV2(effects) { return effects; },
    async scalarSsa(ir) { return ir; },
    async resolveRegions(ir) { return { ir }; },
    async memorySsa(ir, regions) { return { ir, regions }; },
    async compatV1({ ir }) { return ir.v2; },
  },
};

const cases = [
  { name:'exact', input:{ legacy:{ ops:['a'] }, v2:{ ops:['a'] } } },
  {
    name:'stricter', input:{ legacy:{ barriers:['unknown-store'] }, v2:{ barriers:['unknown-store','unknown-call'] } },
    isStricterConservative(legacy, projected) {
      return legacy.barriers.every((item) => projected.barriers.includes(item)) && projected.barriers.length > legacy.barriers.length;
    },
  },
  {
    name:'representation', input:{ legacy:{ target:'0x10' }, v2:{ target:16 } },
    explainRepresentationDifference(legacy, projected) {
      return Number.parseInt(legacy.target, 16) === projected.target ? 'hex string versus numeric address' : '';
    },
    safetyFloorPreserved() { return true; },
  },
  {
    name:'representation-without-proof', input:{ legacy:{ target:'0x20' }, v2:{ target:32 } },
    explainRepresentationDifference(legacy, projected) {
      return Number.parseInt(legacy.target, 16) === projected.target ? 'looks representational but has no safety proof' : '';
    },
  },
  { name:'mismatch', input:{ legacy:{ op:'load' }, v2:{ op:'store' } } },
];

const result = await runDifferentialHarness({ cases, adapters });
assert.equal(result.exactEquivalentCount, 1);
assert.equal(result.stricterConservativeCount, 1);
assert.equal(result.explainedRepresentationDifferenceCount, 1);
assert.equal(result.differentialMatchCount, 2);
assert.equal(result.mismatchCount, 2);
assert.equal(result.blocking, true);
assert.equal(result.results.find((item) => item.caseName === 'mismatch').blocking, true);
const unproved = result.results.find((item) => item.caseName === 'representation-without-proof');
assert.equal(unproved.classification, 'mismatch');
assert.equal(unproved.blocking, true);
assert.equal(result.results.find((item) => item.caseName === 'exact').pathProof.passed, true);

const notIntegrated = await runDifferentialHarness({ cases:[cases[0]], adapters:{ legacy:adapters.legacy, v2:{} } });
assert.equal(notIntegrated.notIntegratedCount, 1);
assert.equal(notIntegrated.blocking, true);

const legacyOnlyProof = verifyPathProof([{ stage:'legacy-v1' }], COMPATIBILITY_PATH);
assert.equal(legacyOnlyProof.passed, false);
assert.equal(legacyOnlyProof.legacyOnly, true);
console.log('differential harness and v1 path-proof tests passed');
