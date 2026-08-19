import assert from 'node:assert/strict';
import test from 'node:test';

import { createMemoryRegionRef } from '../../../js/semantics/memoryssa/contract.js';
import { aliasMemoryRegions } from '../../../js/analysis/alias/legacy-safety-floor.js';
import { a1RegionAlias, provenAddressSpace } from '../../../js/analysis/alias/a1-region-alias.js';
import { ALIAS_PROOF_REASONS, permitsSeparationTransform } from '../../../js/analysis/alias/result.js';

const functionId = 'function_a1';
const binaryId = 'binary_a1';

// A region is only "precise" when it carries origin evidence: a region derived
// from nothing is not a proof of anything, and the floor already refuses to
// reason about one. The helpers therefore supply real evidence, and the
// evidence-free case gets its own test below.
const evidence = (id) => ({ instructionIds: [`instruction_${id}`] });

const stack = (offset, widthBits = 32) => createMemoryRegionRef({
  id: `region_stack_${offset}_${widthBits}`, kind: 'stack-fixed', functionId, binaryId, offset, widthBits,
  origin: evidence(`stack_${offset}_${widthBits}`),
});
const global_ = (address, widthBits = 32) => createMemoryRegionRef({
  id: `region_global_${address}_${widthBits}`, kind: 'global-absolute', functionId, binaryId, address, widthBits,
  origin: evidence(`global_${address}_${widthBits}`),
});
const rooted = (root, offset, widthBits = 32) => createMemoryRegionRef({
  id: `region_rooted_${root}_${offset}`, kind: 'rooted-offset', functionId, binaryId, rootEntityId: root, offset, widthBits,
  origin: evidence(`rooted_${root}_${offset}`),
});
const io = (space, widthBits = 32) => createMemoryRegionRef({
  id: `region_io_${space}`, kind: 'io', functionId, binaryId, addressSpace: space, rootIdentity: { port: space }, widthBits,
  origin: evidence(`io_${space}`),
});
const unknown = () => createMemoryRegionRef({
  id: 'region_unknown_a1', kind: 'unknown', functionId, uncertaintyIdentity: { reason: 'unresolved-pointer' },
});

test('disjoint fixed stack intervals separate, with a named proof', () => {
  const result = a1RegionAlias(stack(0), stack(8));
  assert.equal(result.relation, 'no');
  assert.deepEqual(result.reasonCodes, ['disjoint-stack-interval']);
  assert.ok(permitsSeparationTransform(result));
});

test('overlapping fixed stack intervals do not separate', () => {
  const result = a1RegionAlias(stack(0, 64), stack(4, 64));
  assert.notEqual(result.relation, 'no');
});

test('the same slot at the same width is proven identical', () => {
  const result = a1RegionAlias(stack(16), stack(16));
  assert.equal(result.relation, 'must');
  assert.ok(result.reasonCodes.some((code) => code.startsWith('identical-')));
});

test('non-overlapping exact globals separate', () => {
  const result = a1RegionAlias(global_(0x1000), global_(0x2000));
  assert.equal(result.relation, 'no');
  assert.deepEqual(result.reasonCodes, ['disjoint-global-interval']);
});

test('proven distinct physical address spaces separate', () => {
  // This is A1's one refinement over the conservative floor, and it is the
  // safest kind available: two different physical spaces are not one storage.
  const result = a1RegionAlias(io('mmio-a'), io('mmio-b'));
  assert.equal(result.relation, 'no');
  assert.ok(result.reasonCodes.includes('distinct-address-space'));
  assert.equal(provenAddressSpace(io('mmio-a')), 'mmio-a');
});

test('flat memory regions all share one address space', () => {
  for (const region of [stack(0), global_(0x10), rooted('root_a', 0)]) {
    assert.equal(provenAddressSpace(region), 'memory');
  }
  assert.equal(provenAddressSpace(unknown()), null, 'an unknown region has no proven address space');
});

test('distinct roots do not separate without escape evidence', () => {
  const result = a1RegionAlias(rooted('root_a', 0), rooted('root_b', 0));
  assert.equal(result.relation, 'may');
  assert.ok(result.reasonCodes.includes('escape-unproven'),
    'the weak answer must say what evidence is missing');
});

test('an unknown region is may-alias, never no-alias', () => {
  for (const other of [stack(0), global_(0x10), rooted('root_a', 0), io('mmio-a')]) {
    const result = a1RegionAlias(unknown(), other);
    assert.notEqual(result.relation, 'no', 'an unresolved pointer must clobber everything it may reach');
    assert.notEqual(result.relation, 'must');
  }
});

test('A1 is never weaker than the conservative floor', () => {
  const strength = { unknown: 0, may: 1, must: 2, no: 2 };
  const regions = [stack(0), stack(8), stack(0, 64), global_(0x1000), global_(0x2000), rooted('root_a', 0), rooted('root_b', 0), io('mmio-a'), io('mmio-b'), unknown()];
  for (const left of regions) {
    for (const right of regions) {
      const floor = aliasMemoryRegions(left, right);
      const a1 = a1RegionAlias(left, right).relation;
      assert.ok(strength[a1] >= strength[floor], `A1 (${a1}) weaker than floor (${floor}) for ${left.id} vs ${right.id}`);
    }
  }
});

test('alias relations are symmetric', () => {
  const regions = [stack(0), stack(8), global_(0x1000), rooted('root_a', 0), io('mmio-a'), unknown()];
  for (const left of regions) {
    for (const right of regions) {
      assert.equal(a1RegionAlias(left, right).relation, a1RegionAlias(right, left).relation,
        `asymmetric answer for ${left.id} vs ${right.id}`);
    }
  }
});

test('every reason code A1 can emit is in the closed vocabulary', () => {
  const regions = [stack(0), stack(8), stack(0, 64), global_(0x1000), rooted('root_a', 0), rooted('root_b', 0), io('mmio-a'), io('mmio-b'), unknown()];
  for (const left of regions) {
    for (const right of regions) {
      for (const code of a1RegionAlias(left, right).reasonCodes) {
        assert.ok(ALIAS_PROOF_REASONS.includes(code), `undeclared reason code: ${code}`);
      }
    }
  }
});

test('a missing region yields unknown, not a default separation', () => {
  assert.equal(a1RegionAlias(null, stack(0)).relation, 'unknown');
  assert.equal(a1RegionAlias(stack(0), undefined).relation, 'unknown');
});

test('a region with no origin evidence is not treated as precise', () => {
  // Region identity without provenance is a label, not a proof. Two such
  // labels must not separate even when their offsets look disjoint.
  const evidenceless = createMemoryRegionRef({
    id: 'region_no_origin', kind: 'stack-fixed', functionId, binaryId, offset: 64, widthBits: 32,
  });
  const result = a1RegionAlias(evidenceless, stack(0));
  assert.equal(result.relation, 'unknown');
  assert.ok(result.reasonCodes.includes('unresolved-root'));
});
