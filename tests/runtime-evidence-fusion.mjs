import assert from 'node:assert/strict';
import { createRuntimeEvidenceRecord, fuseStaticDynamic } from '../js/runtime-evidence/index.js';

const base = {
  backend:'fake', binaryHash:'bin-a', sessionId:'session', experimentId:'experiment', caseId:'case',
  function:0x1000n, provenanceGroup:'runtime:session:experiment:case', confidence:0.8,
};

// Correlated evidence is one group, and a contradiction must dominate support
// regardless of array order. Otherwise evidence fusion becomes order-dependent.
for (const evidence of [
  [
    createRuntimeEvidenceRecord({ ...base, id:'support-first', verdict:'supported' }),
    createRuntimeEvidenceRecord({ ...base, id:'contradiction-second', verdict:'contradicted' }),
  ],
  [
    createRuntimeEvidenceRecord({ ...base, id:'contradiction-first', verdict:'contradicted' }),
    createRuntimeEvidenceRecord({ ...base, id:'support-second', verdict:'supported' }),
  ],
]) {
  const result = fuseStaticDynamic({ confidence:0.9, binaryHash:'bin-a', functionAddress:0x1000n }, evidence);
  assert.equal(result.runtimeGroups,1);
  assert.equal(result.contradictions,1);
  assert.equal(result.support,0);
  assert.equal(result.status,'contradicted');
  assert.ok(result.confidence < 0.9);
}

// Function-scoped candidates must not absorb unscoped or other-function runtime evidence.
{
  const unscoped = createRuntimeEvidenceRecord({ ...base, id:'unscoped', function:null, provenanceGroup:'unscoped', verdict:'supported' });
  const other = createRuntimeEvidenceRecord({ ...base, id:'other', function:0x2000n, provenanceGroup:'other', verdict:'supported' });
  const matching = createRuntimeEvidenceRecord({ ...base, id:'matching', function:0x1000n, provenanceGroup:'matching', verdict:'supported' });
  const result = fuseStaticDynamic({ confidence:0.5, binaryHash:'bin-a', functionAddress:0x1000n }, [unscoped,other,matching]);
  assert.equal(result.support,1);
  assert.equal(result.ignoredEvidence,2);
  assert.equal(result.status,'supported');
}

console.log('runtime evidence fusion tests: ok');
