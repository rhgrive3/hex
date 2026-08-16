import assert from 'node:assert/strict';
import { createMemorySsaOracleCases, runMemorySsaOracle, verifyMemorySsaCase } from '../../tools/validation/semantic-v2/memoryssa-oracle.mjs';

function fakeOutput(caseName) {
  const region = { id:'R', kind:'rooted-offset' };
  if (caseName === 'known-store-reaches-load') return {
    regions:[region],
    definitions:[{ id:'d-store', kind:'memory-def', regionId:'R', sourceEntityId:'known-store', previousDefinitionIds:[], incoming:[] }],
    uses:[{ id:'u-load', regionId:'R', reachingDefinitionId:'d-store', sourceEntityId:'load-after-known' }],
  };
  if (caseName === 'unknown-store-kills-stale-proof') return {
    regions:[region],
    definitions:[
      { id:'d-store', kind:'memory-def', regionId:'R', sourceEntityId:'known-store', previousDefinitionIds:[], incoming:[] },
      { id:'d-barrier', kind:'unknown-clobber', regionId:'R', sourceEntityId:'unknown-store', previousDefinitionIds:['d-store'], incoming:[] },
    ],
    uses:[{ id:'u-load', regionId:'R', reachingDefinitionId:'d-barrier', sourceEntityId:'load-after-unknown-store' }],
  };
  if (caseName === 'unknown-call-kills-stale-proof') return {
    regions:[region],
    definitions:[
      { id:'d-store', kind:'memory-def', regionId:'R', sourceEntityId:'known-store', previousDefinitionIds:[], incoming:[] },
      { id:'d-call', kind:'call-clobber', regionId:'R', sourceEntityId:'unknown-call', previousDefinitionIds:['d-store'], incoming:[] },
    ],
    uses:[{ id:'u-load', regionId:'R', reachingDefinitionId:'d-call', sourceEntityId:'load-after-unknown-call' }],
  };
  if (caseName === 'may-alias-store-kills-stale-proof') return {
    regions:[region],
    definitions:[
      { id:'d-store', kind:'memory-def', regionId:'R', sourceEntityId:'known-store', previousDefinitionIds:[], incoming:[] },
      { id:'d-may', kind:'may-alias-clobber', regionId:'R', sourceEntityId:'may-store', previousDefinitionIds:['d-store'], incoming:[] },
    ],
    uses:[{ id:'u-load', regionId:'R', reachingDefinitionId:'d-may', sourceEntityId:'load-after-may-store' }],
  };
  throw new Error(`unknown fake case ${caseName}`);
}

const result = await runMemorySsaOracle({ adapter:{ async buildMemorySsa(_program,_cfg,{caseName}) { return fakeOutput(caseName); } } });
assert.equal(result.integrated, true);
assert.equal(result.failed, 0);
assert.equal(result.passed, createMemorySsaOracleCases().length);

const barrierCase = createMemorySsaOracleCases().find((testCase) => testCase.name === 'unknown-store-kills-stale-proof');
const stale = structuredClone(fakeOutput(barrierCase.name));
stale.uses[0].reachingDefinitionId = 'd-store';
const staleResult = verifyMemorySsaCase(barrierCase, stale);
assert.equal(staleResult.passed, false);
assert.match(staleResult.errors.join('\n'), /stale reaching-def proof survived barrier/);

const missing = await runMemorySsaOracle({ adapter:null });
assert.equal(missing.integrated, false);
assert.equal(missing.blocking, true);
console.log('verification MemorySSA oracle tests passed');
