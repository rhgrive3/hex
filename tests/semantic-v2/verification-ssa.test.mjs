import assert from 'node:assert/strict';
import { createSsaOracleCases, runSsaOracle, verifySsaCase } from '../../tools/validation/semantic-v2/ssa-oracle.mjs';

function finish(definitions, uses) {
  const byValue = new Map(definitions.map((definition) => [definition.valueId, definition]));
  const useDefLinks = uses.map((use) => ({ useId: use.useId, valueId: use.valueId, definitionId: byValue.get(use.valueId).definitionId })).sort((a,b)=>a.useId.localeCompare(b.useId));
  const defUseLinks = definitions.map((definition) => ({
    definitionId: definition.definitionId,
    valueId: definition.valueId,
    useIds: uses.filter((use) => use.valueId === definition.valueId).map((use) => use.useId).sort(),
  }));
  return { definitions, uses, useDefLinks, defUseLinks };
}

function fakeOutput(caseName) {
  if (caseName === 'linear-reaching-definition') return finish(
    [{ definitionId:'d0', valueId:'v0', kind:'definition', blockId:'b0', variableKey:'v', sourceEntityId:'def-v', incoming:[] }],
    [{ useId:'u0', valueId:'v0', blockId:'b1', sourceEntityId:'use-v' }],
  );
  if (caseName === 'diamond-phi-placement') return finish(
    [
      { definitionId:'dl', valueId:'vl', kind:'definition', blockId:'left', variableKey:'v', sourceEntityId:'left-v', incoming:[] },
      { definitionId:'dr', valueId:'vr', kind:'definition', blockId:'right', variableKey:'v', sourceEntityId:'right-v', incoming:[] },
      { definitionId:'dp', valueId:'vp', kind:'phi', blockId:'merge', variableKey:'v', sourceEntityId:null, incoming:[
        { predecessorBlockId:'left', valueId:'vl' }, { predecessorBlockId:'right', valueId:'vr' },
      ] },
    ],
    [{ useId:'um', valueId:'vp', blockId:'merge', sourceEntityId:'merge-use' }],
  );
  if (caseName === 'loop-carried-phi') return finish(
    [
      { definitionId:'di0', valueId:'vi0', kind:'definition', blockId:'entry', variableKey:'i', sourceEntityId:'init-i', incoming:[] },
      { definitionId:'dip', valueId:'vip', kind:'phi', blockId:'header', variableKey:'i', sourceEntityId:null, incoming:[
        { predecessorBlockId:'entry', valueId:'vi0' }, { predecessorBlockId:'body', valueId:'vi1' },
      ] },
      { definitionId:'di1', valueId:'vi1', kind:'definition', blockId:'body', variableKey:'i', sourceEntityId:'step-i', incoming:[] },
    ],
    [
      { useId:'uh', valueId:'vip', blockId:'header', sourceEntityId:'header-use' },
      { useId:'ue', valueId:'vip', blockId:'exit', sourceEntityId:'exit-use' },
    ],
  );
  if (caseName === 'explicit-undef') return finish(
    [{ definitionId:'du', valueId:'vu', kind:'undef', blockId:null, variableKey:'missing', sourceEntityId:null, incoming:[] }],
    [{ useId:'uu', valueId:'vu', blockId:'use', sourceEntityId:'undef-use' }],
  );
  throw new Error(`unknown fake case ${caseName}`);
}

const result = await runSsaOracle({ adapter:{ async buildSsa(_program,_cfg,{caseName}) { return fakeOutput(caseName); } } });
assert.equal(result.integrated, true);
assert.equal(result.failed, 0);
assert.equal(result.passed, createSsaOracleCases().length);

const diamond = createSsaOracleCases().find((testCase) => testCase.name === 'diamond-phi-placement');
const broken = structuredClone(fakeOutput('diamond-phi-placement'));
broken.definitions.find((definition) => definition.kind === 'phi').incoming[1].valueId = 'vl';
const brokenResult = verifySsaCase(diamond, broken);
assert.equal(brokenResult.passed, false);
assert.match(brokenResult.errors.join('\n'), /wrong reaching definition/);

const missing = await runSsaOracle({ adapter:null });
assert.equal(missing.integrated, false);
assert.equal(missing.blocking, true);
console.log('verification SSA oracle tests passed');
