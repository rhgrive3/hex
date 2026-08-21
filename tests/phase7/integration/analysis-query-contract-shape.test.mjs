import assert from 'node:assert/strict';
import { AnalysisQueryAPI } from '../../../js/analysis/query/index.js';

const identity = { binaryId:'bin_shape', projectRevision:0, analysisEpoch:1, artifactVersions:{} };
let queried = false;
const api = new AnalysisQueryAPI({
  async currentIdentity() { return identity; },
  async binaryInfo() {
    queried = true;
    return { value:{ architecture:'x86_64' }, status:{ completeness:'partial', reason:'fixture' }, cost:{ units:2 } };
  },
});
const snapshot = await api.snapshot();
const info = await api.binaryInfo(snapshot);
assert.equal(queried, true);
assert.equal(info.completeness, 'partial');
assert.equal(info.status.reason, 'fixture');
assert.deepEqual(info.cost, { units:2 });
assert.equal(info.value.architecture, 'x86_64');
assert.equal(Object.isFrozen(info), true);
assert.equal(Object.isFrozen(info.status), true);
console.log('phase7 AnalysisQueryAPI result envelope: PASS');
