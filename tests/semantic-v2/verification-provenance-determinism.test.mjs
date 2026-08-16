import assert from 'node:assert/strict';
import { verifyProvenance, verifyDeterminism } from '../../tools/validation/semantic-v2/provenance.mjs';

const roots = [
  { id:'ir:1', kind:'semantic-ir', origin:{ instructionIds:['insn:1'], operationIds:['effect:1'], parentEntityIds:[] } },
];
const entities = [
  { id:'ssa:1', kind:'ssa-definition', origin:{ parentEntityIds:['ir:1'] } },
  { id:'ssa:phi', kind:'ssa-phi', origin:{ parentEntityIds:['ssa:1'] } },
  { id:'mem:def', kind:'memoryssa-memory-def', origin:{ parentEntityIds:['ir:1'] } },
  { id:'mem:use', kind:'memoryssa-use', origin:{ parentEntityIds:['mem:def'] } },
  { id:'compat:1', kind:'compatibility-projection', origin:{ parentEntityIds:['ssa:phi','mem:use'] } },
];
const ok = verifyProvenance({ roots, entities });
assert.equal(ok.provenanceLossCount, 0);

const broken = verifyProvenance({ roots, entities:[
  ...entities,
  { id:'fabricated', kind:'ssa-definition', origin:{ instructionIds:['insn:other'], parentEntityIds:[] } },
  { id:'lost', kind:'ssa-definition', origin:{ parentEntityIds:[] } },
] });
assert.equal(broken.provenanceLossCount, 2);
assert.equal(broken.losses.every((item) => item.reason === 'origin-not-grounded'), true);

const variants = [
  { object:{ a:1, b:2 }, map:new Map([['a',1],['b',2]]) },
  { object:{ b:2, a:1 }, map:new Map([['b',2],['a',1]]) },
];
const deterministic = await verifyDeterminism({ build:async (input)=>input, variants });
assert.equal(deterministic.deterministic, true);

const nondeterministic = await verifyDeterminism({
  build:async (input)=>({ order:[...input.map.keys()] }), variants,
});
assert.equal(nondeterministic.deterministic, false);
assert.deepEqual(nondeterministic.mismatchVariantIndexes, [1]);
console.log('provenance and determinism verification tests passed');
