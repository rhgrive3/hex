/**
 * P8-6 — aggregate candidates, with the ambiguity kept.
 *
 * The failure under test is a decompiler that scores "array" above "struct",
 * prints one of them, and discards the other. The score was never a proof. Every
 * test here checks the same thing from a different angle: both shapes survive
 * when both fit, conflicts cap certainty instead of being resolved, and no pile
 * of repeated access patterns is ever allowed to become confirmation.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { PASS_STAGES } from '../../../js/decompiler/phase8/contract.js';
import {
  AGGREGATE_KINDS, AGGREGATE_PASS, CERTAINTIES,
  certaintyOf, describeRegion, forcedContradictions, regionIdentityOf, runPhase8Stage,
} from '../../../js/decompiler/phase8/index.js';
import { fixture } from '../helpers/ir-fixtures.mjs';

function aggregates(ir, { types = null, timeBudgetMs = 2000, shouldAbort = undefined } = {}) {
  const { ledger, analysis } = runPhase8Stage({ ir, types }, { stages: PASS_STAGES, timeBudgetMs, shouldAbort });
  return { ledger, facts: ledger.published ? analysis.get('aggregates') : null };
}

function regionOf(facts, key) {
  const region = facts.regions.find((entry) => entry.regionKey === key);
  assert.ok(region, `no region ${key}; saw ${facts.regions.map((entry) => entry.regionKey).join(', ')}`);
  return region;
}

function shapes(region) {
  return region.candidates.map((entry) => entry.kind).sort();
}

/** A function whose only content is memory traffic through one pointer. */
function accessFixture(name, build) {
  const f = fixture(name);
  f.block(0);
  const pointer = f.opaque(64);
  build(f, pointer);
  f.ret();
  return { ir: f.build(), pointer };
}

test('fixed non-overlapping fields are a struct, and the gap between them is padding', () => {
  const { ir, pointer } = accessFixture('struct', (f, pointer) => {
    f.load(32, { addrBase: pointer, disp: 0 });
    f.load(16, { addrBase: pointer, disp: 8 });
  });
  const { facts } = aggregates(ir);
  const region = regionOf(facts, `value:${pointer.id}`);
  assert.ok(shapes(region).includes('struct'));
  assert.deepEqual(region.fields.map((field) => [field.offset, field.widthBits]), [[0n, 32], [8n, 16]]);
  // The four bytes nobody touched are reported as a gap, not filled in with an
  // invented field.
  assert.deepEqual(region.padding.map((entry) => [entry.from, entry.to]), [[4n, 8n]]);
  assert.equal(region.conflicts.length, 0);
});

test('indexed accesses scaled by the element width are an array', () => {
  const { ir, pointer } = accessFixture('array', (f, pointer) => {
    const index = f.opaque(64);
    f.load(32, { addrBase: pointer, addrIndex: index, scale: 2 });
    f.load(32, { addrBase: pointer, addrIndex: index, scale: 2 });
  });
  const { facts } = aggregates(ir);
  const region = regionOf(facts, `value:${pointer.id}`);
  const array = region.candidates.find((entry) => entry.kind === 'array');
  assert.ok(array, `expected an array candidate, saw ${shapes(region).join(', ')}`);
  assert.equal(array.strideBytes, 4n);
  assert.equal(array.elementWidthBits, 32);
});

test('offsets that fit a struct and an array equally well keep both, and neither is certain', () => {
  const { ir, pointer } = accessFixture('ambiguous', (f, pointer) => {
    f.load(32, { addrBase: pointer, disp: 0 });
    f.load(32, { addrBase: pointer, disp: 4 });
    f.load(32, { addrBase: pointer, disp: 8 });
  });
  const { facts } = aggregates(ir);
  const region = regionOf(facts, `value:${pointer.id}`);
  assert.deepEqual(shapes(region), ['array', 'struct']);
  assert.ok(region.conflicts.some((entry) => entry.kind === 'ambiguous-shape'));
  for (const entry of region.candidates) {
    assert.equal(entry.certainty, 'candidate', `${entry.kind} was allowed past candidate over an unresolved shape conflict`);
  }
  assert.equal(facts.ambiguousRegionCount, 1);
});

test('two widths at one offset are a union as much as a struct, and both are published', () => {
  const { ir, pointer } = accessFixture('union', (f, pointer) => {
    f.load(32, { addrBase: pointer, disp: 0 });
    f.load(64, { addrBase: pointer, disp: 0 });
    f.load(32, { addrBase: pointer, disp: 16 });
  });
  const { facts } = aggregates(ir);
  const region = regionOf(facts, `value:${pointer.id}`);
  assert.ok(shapes(region).includes('union'));
  assert.ok(shapes(region).includes('struct'));
  assert.ok(region.conflicts.some((entry) => entry.kind === 'width-disagreement'));
  for (const entry of region.candidates) assert.equal(entry.certainty, 'candidate');
});

test('overlapping ranges at different offsets are recorded as an overlap', () => {
  const { ir, pointer } = accessFixture('overlap', (f, pointer) => {
    f.load(64, { addrBase: pointer, disp: 0 });
    f.load(32, { addrBase: pointer, disp: 4 });
  });
  const { facts } = aggregates(ir);
  const region = regionOf(facts, `value:${pointer.id}`);
  assert.ok(region.conflicts.some((entry) => entry.kind === 'overlapping-accesses'));
  assert.ok(shapes(region).includes('union'));
});

test('a struct whose last field is also indexed is the flexible-array shape', () => {
  const { ir, pointer } = accessFixture('flexible', (f, pointer) => {
    const index = f.opaque(64);
    f.load(32, { addrBase: pointer, disp: 0 });
    f.load(32, { addrBase: pointer, disp: 8 });
    f.load(32, { addrBase: pointer, addrIndex: index, scale: 2, disp: 8 });
  });
  const { facts } = aggregates(ir);
  const region = regionOf(facts, `value:${pointer.id}`);
  assert.ok(region.conflicts.some((entry) => entry.kind === 'flexible-array-tail'));
  // The shape stays a candidate; a flexible array member is a hypothesis about
  // a tail, not a proof of one.
  for (const entry of region.candidates) assert.equal(entry.certainty, 'candidate');
});

test('one stride that holds the fixed offsets is an array of struct', () => {
  const { ir, pointer } = accessFixture('aos', (f, pointer) => {
    const index = f.opaque(64);
    f.load(32, { addrBase: pointer, disp: 0 });
    f.load(32, { addrBase: pointer, disp: 4 });
    f.load(32, { addrBase: pointer, addrIndex: index, scale: 4 });
  });
  const { facts } = aggregates(ir);
  const region = regionOf(facts, `value:${pointer.id}`);
  const aos = region.candidates.find((entry) => entry.kind === 'array-of-struct');
  assert.ok(aos, `expected array-of-struct, saw ${shapes(region).join(', ')}`);
  assert.equal(aos.strideBytes, 16n);
  assert.deepEqual([...aos.innerOffsets], [0n, 4n]);
});

test('several independent strides from one base are a struct of arrays', () => {
  const { ir, pointer } = accessFixture('soa', (f, pointer) => {
    const index = f.opaque(64);
    f.load(32, { addrBase: pointer, addrIndex: index, scale: 2 });
    f.load(64, { addrBase: pointer, addrIndex: index, scale: 3 });
  });
  const { facts } = aggregates(ir);
  const region = regionOf(facts, `value:${pointer.id}`);
  const soa = region.candidates.find((entry) => entry.kind === 'struct-of-array');
  assert.ok(soa, `expected struct-of-array, saw ${shapes(region).join(', ')}`);
  assert.equal(soa.strides.length, 2);
});

test('a field that loads a pointer used elsewhere is an embedded object, named not inlined', () => {
  const f = fixture('embedded');
  f.block(0);
  const outer = f.opaque(64);
  const inner = f.load(64, { addrBase: outer, disp: 16 });
  f.load(32, { addrBase: inner, disp: 0 });
  f.load(32, { addrBase: inner, disp: 4 });
  f.ret();
  const { facts } = aggregates(f.build());
  const outerRegion = regionOf(facts, `value:${outer.id}`);
  const embedded = outerRegion.candidates.find((entry) => entry.kind === 'embedded-object');
  assert.ok(embedded, `expected embedded-object, saw ${shapes(outerRegion).join(', ')}`);
  assert.equal(embedded.children[0].offset, 16n);
  // The child is referenced by key. Its layout stays its own region rather than
  // being flattened into the parent.
  assert.ok(facts.regions.some((entry) => entry.regionKey === embedded.children[0].regionKey));
});

test('a negative offset means the pointer left its region, and that is a conflict not an extension', () => {
  const { ir, pointer } = accessFixture('boundary', (f, pointer) => {
    f.load(32, { addrBase: pointer, disp: 0 });
    f.load(32, { addrBase: pointer, disp: -8 });
  });
  const { facts } = aggregates(ir);
  const region = regionOf(facts, `value:${pointer.id}`);
  assert.ok(region.conflicts.some((entry) => entry.kind === 'boundary-crossing'));
  for (const entry of region.candidates) assert.equal(entry.certainty, 'candidate');
});

test('an unknown store between the pointer load and the access stops the grouping', () => {
  const f = fixture('barrier');
  f.block(0);
  const slot = f.load(64, { locKey: 'stack:-8', addressPrecise: true });
  const guarded = f.load(64, { locKey: 'stack:-8', barrier: { inst: { id: 99 } } });
  f.load(32, { addrBase: slot, disp: 0 });
  f.load(32, { addrBase: guarded, disp: 4 });
  f.ret();
  const { facts } = aggregates(f.build());
  // The pointer with a barrier is identified by its own value, not folded in
  // with the other reload of the same slot.
  assert.ok(facts.regions.some((entry) => entry.regionKey === `value:${guarded.id}`));
  assert.ok(facts.regions.some((entry) => entry.regionKey === 'via:stack:-8'));
});

test('grouping through reloads of one slot is published as a hypothesis, not a proof', () => {
  const f = fixture('grouping');
  f.block(0);
  const first = f.load(64, { locKey: 'stack:-8' });
  const second = f.load(64, { locKey: 'stack:-8' });
  f.load(32, { addrBase: first, disp: 0 });
  f.load(32, { addrBase: second, disp: 4 });
  f.ret();
  const { facts } = aggregates(f.build());
  const region = regionOf(facts, 'via:stack:-8');
  assert.equal(region.groupingEvidence[0].tier, 'soft');
  assert.match(region.groupingEvidence[0].detail, /hypothesis/);
  assert.ok(region.conflicts.some((entry) => entry.kind === 'unproven-grouping'));
});

test('two recovered names for one base stay two names', () => {
  const f = fixture('nominal-conflict');
  f.block(0);
  const slot = f.load(64, { locKey: 'stack:-8' });
  const other = f.load(64, { locKey: 'stack:-8' });
  f.load(32, { addrBase: slot, disp: 0 });
  f.load(32, { addrBase: other, disp: 4 });
  f.ret();
  const types = { values: new Map([[slot.id, { className: 'Player' }], [other.id, { className: 'Enemy' }]]) };
  const { facts } = aggregates(f.build(), { types });
  const region = regionOf(facts, 'via:stack:-8');
  const conflict = region.conflicts.find((entry) => entry.kind === 'nominal-disagreement');
  assert.ok(conflict, 'the contradiction was resolved instead of recorded');
  assert.deepEqual([...conflict.between].sort(), ['Enemy', 'Player']);
  assert.equal(region.nominal, null, 'a contradicted name must not be adopted');
  for (const entry of region.candidates) assert.equal(entry.certainty, 'candidate');
});

test('repetition is not proof: no number of soft facts reaches confirmed', () => {
  const soft = (count) => Array.from({ length: count }, (_, index) => ({ tier: 'soft', fact: `f${index}`, detail: '' }));
  assert.equal(certaintyOf(soft(1), []), 'candidate');
  assert.equal(certaintyOf(soft(2), []), 'supported');
  assert.equal(certaintyOf(soft(50), []), 'supported');
  assert.equal(certaintyOf([{ tier: 'hard', fact: 'declared', detail: '' }], []), 'confirmed');
  // A conflict caps everything, hard evidence included.
  assert.equal(certaintyOf([{ tier: 'hard', fact: 'declared', detail: '' }], ['overlapping-accesses']), 'candidate');
});

test('the independent certainty check catches a candidate that was forced', () => {
  const { ir, pointer } = accessFixture('forced', (f, pointer) => {
    f.load(32, { addrBase: pointer, disp: 0 });
    f.load(32, { addrBase: pointer, disp: 8 });
  });
  const { facts } = aggregates(ir);
  assert.deepEqual(forcedContradictions(facts), []);

  const region = facts.regions[0];
  const overConflict = {
    regions: [{ ...region, candidates: [{ ...region.candidates[0], certainty: 'confirmed', conflicts: ['ambiguous-shape'] }] }],
  };
  assert.ok(forcedContradictions(overConflict).some((entry) => entry.problem === 'confirmed-over-conflict'));

  const softConfirmed = {
    regions: [{ ...region, candidates: [{ ...region.candidates[0], certainty: 'confirmed', conflicts: [] }] }],
  };
  assert.ok(forcedContradictions(softConfirmed).some((entry) => entry.problem === 'confirmed-without-hard-evidence'));

  const settledContradiction = {
    regions: [{
      ...region,
      conflicts: [{ kind: 'nominal-disagreement', detail: '', between: ['A', 'B'] }],
      candidates: [{ ...region.candidates[0], kind: 'struct', certainty: 'candidate', conflicts: [] }],
    }],
  };
  assert.ok(forcedContradictions(settledContradiction).some((entry) => entry.problem === 'contradiction-resolved-to-one-shape'));
});

test('a region always publishes at least one shape, even when nothing fits', () => {
  const { ir, pointer } = accessFixture('nothing', (f, pointer) => {
    f.load(32, { addrBase: pointer, disp: 0 });
  });
  const { facts } = aggregates(ir);
  const region = regionOf(facts, `value:${pointer.id}`);
  assert.deepEqual(shapes(region), ['unknown']);
  assert.equal(region.candidates[0].certainty, 'candidate');
});

test('regionIdentityOf names the stack and globals directly and pointers by their source', () => {
  assert.equal(regionIdentityOf({ loc: { kind: 'stack' } }).regionKey, 'stack-frame');
  assert.equal(regionIdentityOf({ loc: { kind: 'global', address: '0x1000' } }).regionKey, 'global:0x1000');
  assert.equal(regionIdentityOf({ loc: { kind: 'field' } }), null, 'an access with no base has no region');
});

test('every candidate kind and certainty is one the contract declares', () => {
  const { ir } = accessFixture('vocabulary', (f, pointer) => {
    const index = f.opaque(64);
    f.load(32, { addrBase: pointer, disp: 0 });
    f.load(64, { addrBase: pointer, disp: 0 });
    f.load(32, { addrBase: pointer, addrIndex: index, scale: 2 });
  });
  const { facts } = aggregates(ir);
  for (const region of facts.regions) {
    for (const entry of region.candidates) {
      assert.ok(AGGREGATE_KINDS.includes(entry.kind), entry.kind);
      assert.ok(CERTAINTIES.includes(entry.certainty), entry.certainty);
    }
  }
});

test('every field and every candidate carries provenance', () => {
  const { ir, pointer } = accessFixture('provenance', (f, pointer) => {
    f.load(32, { addrBase: pointer, disp: 0 });
    f.load(32, { addrBase: pointer, disp: 8 });
  });
  const { facts } = aggregates(ir);
  const region = regionOf(facts, `value:${pointer.id}`);
  assert.ok(region.origin.instructionIds.length > 0);
  for (const field of region.fields) assert.ok(field.origin.instructionIds.length > 0, `field +${field.offset} lost its origin`);
  for (const entry of region.candidates) {
    for (const fact of entry.support) assert.ok(fact.detail.length > 0, `${entry.kind} carries a support fact with no detail`);
  }
});

test('the pass transforms nothing and publishes exactly one analysis', () => {
  const { ir } = accessFixture('no-transform', (f, pointer) => {
    f.load(32, { addrBase: pointer, disp: 0 });
  });
  const { ledger } = aggregates(ir);
  const result = ledger.passes.find((entry) => entry.passId === 'phase8.aggregates');
  assert.equal(result.transforms.length, 0);
  assert.deepEqual([...result.produced], ['aggregates']);
  assert.deepEqual([...result.invalidated], []);
  assert.equal(AGGREGATE_PASS.stage, 'high-level-recovery');
  assert.ok(AGGREGATE_PASS.consumes.includes('induction'),
    'stride facts come from P8-4; aggregate recovery must not contain a second induction analyser');
});

test('the published facts are identical across runs', () => {
  const { ir } = accessFixture('deterministic', (f, pointer) => {
    const index = f.opaque(64);
    f.load(32, { addrBase: pointer, disp: 0 });
    f.load(32, { addrBase: pointer, addrIndex: index, scale: 2 });
  });
  const encode = (value) => JSON.stringify(value, (key, item) => (typeof item === 'bigint' ? `${item}n` : item));
  assert.equal(encode(aggregates(ir).facts), encode(aggregates(ir).facts));
});

test('cancellation withholds the whole ledger rather than publishing half the regions', () => {
  const { ir } = accessFixture('cancelled', (f, pointer) => {
    f.load(32, { addrBase: pointer, disp: 0 });
    f.load(32, { addrBase: pointer, disp: 4 });
  });
  let calls = 0;
  const { ledger, facts } = aggregates(ir, { shouldAbort: () => { calls += 1; return calls > 2; } });
  assert.equal(ledger.published, false);
  assert.equal(facts, null);
});

test('describeRegion states the shapes and the conflicts, not a score', () => {
  const { ir, pointer } = accessFixture('describe', (f, pointer) => {
    f.load(32, { addrBase: pointer, disp: 0 });
    f.load(32, { addrBase: pointer, disp: 4 });
  });
  const { facts } = aggregates(ir);
  const text = describeRegion(regionOf(facts, `value:${pointer.id}`));
  assert.match(text, /struct\(candidate\)/);
  assert.ok(!/0\.\d/.test(text), 'a confidence number in the description is the thing this checkpoint removes');
  assert.equal(describeRegion(null), 'no region');
});
