/**
 * Phase 7 frozen fixture corpus.
 *
 * Every fixture here is named, immutable, and carries its own machine truth.
 * The truth is declared next to the construction because that is the only way
 * it stays honest: a fixture whose expected answer is decided after the
 * analyser has been run is not evidence, it is a rationalisation (FM-16).
 *
 * `truth` values mean:
 *   'no' / 'must'  — exact truth; the analyser is *required* to be sound here,
 *                    and being weaker is a precision miss, not a failure.
 *   'may-or-weaker'— the strong answers are provably wrong. Returning `no` or
 *                    `must` is a soundness failure and blocks the phase.
 *
 * `expectStrong` records whether the current contract expects Phase 7 to
 * actually reach the exact truth. It is separate from `truth` so that a
 * precision miss is visible in the metrics without being confused for a
 * soundness bug.
 */

import { fixture, memoryAccessOf, regionOf } from '../helpers/fixtures.mjs';

export const CORPUS_ID = 'phase7-alias-memory-corpus';
export const CORPUS_VERSION = 1;

/** Two disjoint fixed slots in one frame. Exact truth: they cannot overlap. */
function stackDisjoint(options) {
  const f = fixture('function_stack_disjoint');
  f.block('entry', []);
  const sp = f.stateRead('sp', 'state:sp');
  const c0 = f.constant('c0', 0);
  const c8 = f.constant('c8', 8);
  const p0 = f.binary('p0', 'add', sp, c0);
  const p8 = f.binary('p8', 'add', sp, c8);
  f.store('st0', p0, null, { widthBits: 32 });
  f.store('st8', p8, null, { widthBits: 32 });
  f.ret('r');
  return f.build(options);
}

/** Two 8-byte accesses four bytes apart: they overlap. `no` would be false. */
function stackOverlapping(options) {
  const f = fixture('function_stack_overlapping');
  f.block('entry', []);
  const sp = f.stateRead('sp', 'state:sp');
  const c0 = f.constant('c0', 0);
  const c4 = f.constant('c4', 4);
  const p0 = f.binary('p0', 'add', sp, c0);
  const p4 = f.binary('p4', 'add', sp, c4);
  f.store('st0', p0, null, { widthBits: 64 });
  f.store('st4', p4, null, { widthBits: 64 });
  f.ret('r');
  return f.build(options);
}

/** Same slot, same width: exact truth is identity. */
function stackIdentical(options) {
  const f = fixture('function_stack_identical');
  f.block('entry', []);
  const sp = f.stateRead('sp', 'state:sp');
  const c16 = f.constant('c16', 16);
  const p = f.binary('p', 'add', sp, c16);
  f.store('st', p, null, { widthBits: 32 });
  f.load('ld', p, { widthBits: 32 });
  f.ret('r');
  return f.build(options);
}

/**
 * The displacement comes from a value the analysis cannot bound. Same root,
 * unknown offset: any strong answer is wrong in both directions.
 */
function uncertainOffset(options) {
  const f = fixture('function_uncertain_offset');
  f.block('entry', []);
  const sp = f.stateRead('sp', 'state:sp');
  const idx = f.stateRead('idx', 'state:x1');
  const c0 = f.constant('c0', 0);
  const p0 = f.binary('p0', 'add', sp, c0);
  const pn = f.binary('pn', 'add', sp, idx);
  f.store('st0', p0, null, { widthBits: 32 });
  f.store('stn', pn, null, { widthBits: 32 });
  f.ret('r');
  return f.build(options);
}

/**
 * A pointer round-tripped through a narrower integer. The recovered bits are no
 * longer proof of provenance, so separation must not be claimed.
 */
function provenanceLoss(options) {
  const f = fixture('function_provenance_loss');
  f.block('entry', []);
  const sp = f.stateRead('sp', 'state:sp');
  const c0 = f.constant('c0', 0);
  const c32 = f.constant('c32', 32);
  const p0 = f.binary('p0', 'add', sp, c0);
  const narrowed = f.cast('narrowed', 'trunc', p0, { widthBits: 32 });
  const widened = f.cast('widened', 'zext', narrowed, { widthBits: 64 });
  const other = f.binary('other', 'add', sp, c32);
  f.store('st_lost', widened, null, { widthBits: 32 });
  f.store('st_other', other, null, { widthBits: 32 });
  f.ret('r');
  return f.build(options);
}

/**
 * A pointer phi joining two different frame slots. Its offset is one of two
 * values, so an access through it overlaps either — separation from both is
 * false.
 */
function pointerPhiDistinctOffsets(options) {
  const f = fixture('function_pointer_phi');
  f.block('entry', ['left', 'right']);
  const sp = f.stateRead('sp', 'state:sp');
  const c0 = f.constant('c0', 0);
  const c64 = f.constant('c64', 64);
  const p0 = f.binary('p0', 'add', sp, c0);
  const p64 = f.binary('p64', 'add', sp, c64);
  f.branch('br', ['left', 'right'], { conditional: true });

  f.block('left', ['join']);
  f.stateWrite('wl', 'state:x2', p0);
  f.branch('bl', ['join']);

  f.block('right', ['join']);
  f.stateWrite('wr', 'state:x2', p64);
  f.branch('brr', ['join']);

  f.block('join', []);
  const merged = f.stateRead('merged', 'state:x2', { blockId: 'join' });
  f.store('st_merged', merged, null, { widthBits: 32, blockId: 'join' });
  f.store('st_zero', p0, null, { widthBits: 32, blockId: 'join' });
  f.ret('r', { blockId: 'join' });
  return f.build(options);
}

/**
 * A pointer advanced by a constant stride on a loop back edge. The offset range
 * grows without bound, so the solve must widen and terminate, and it must not
 * claim separation from a slot the walk can reach.
 */
function cyclicPointerPhi(options) {
  const f = fixture('function_cyclic_phi');
  f.block('entry', ['loop']);
  const sp = f.stateRead('sp', 'state:sp');
  const c0 = f.constant('c0', 0);
  const p0 = f.binary('p0', 'add', sp, c0);
  f.stateWrite('w0', 'state:x3', p0);
  f.branch('b0', ['loop']);

  f.block('loop', ['loop', 'exit']);
  const cur = f.stateRead('cur', 'state:x3', { blockId: 'loop' });
  const c8 = f.constant('c8', 8, { blockId: 'loop' });
  const next = f.binary('next', 'add', cur, c8, { blockId: 'loop' });
  f.store('st_cur', cur, null, { widthBits: 32, blockId: 'loop' });
  f.stateWrite('w1', 'state:x3', next, { blockId: 'loop' });
  f.branch('b1', ['loop', 'exit'], { blockId: 'loop', conditional: true });

  f.block('exit', []);
  const c128 = f.constant('c128', 128, { blockId: 'exit' });
  const far = f.binary('far', 'add', sp, c128, { blockId: 'exit' });
  f.store('st_far', far, null, { widthBits: 32, blockId: 'exit' });
  f.ret('r', { blockId: 'exit' });
  return f.build(options);
}

/**
 * Two field labels whose byte intervals overlap. Different names are not
 * different storage.
 */
function overlappingFields(options) {
  const f = fixture('function_overlapping_fields');
  f.block('entry', []);
  const base = f.stateRead('base', 'state:x0');
  const c0 = f.constant('c0', 0);
  const c2 = f.constant('c2', 2);
  const wide = f.binary('wide', 'add', base, c0);
  const inner = f.binary('inner', 'add', base, c2);
  f.store('st_wide', wide, null, { widthBits: 64 });
  f.store('st_inner', inner, null, { widthBits: 16 });
  f.ret('r');
  return f.build(options);
}

/** An unknown store between a store and a load: the link must stay blocked. */
function unknownStoreBarrier(options) {
  const f = fixture('function_unknown_store_barrier');
  f.block('entry', []);
  const sp = f.stateRead('sp', 'state:sp');
  const opaque = f.stateRead('opaque', 'state:x9');
  const c0 = f.constant('c0', 0);
  const p0 = f.binary('p0', 'add', sp, c0);
  f.store('st_known', p0, null, { widthBits: 32 });
  f.store('st_unknown', opaque, null, { widthBits: 32 });
  f.load('ld', p0, { widthBits: 32 });
  f.ret('r');
  return f.build(options);
}

/** An unknown call between a store and a load: the link must stay blocked. */
function unknownCallBarrier(options) {
  const f = fixture('function_unknown_call_barrier');
  f.block('entry', []);
  const sp = f.stateRead('sp', 'state:sp');
  const c0 = f.constant('c0', 0);
  const p0 = f.binary('p0', 'add', sp, c0);
  f.store('st_known', p0, null, { widthBits: 32 });
  f.unknownCall('call_unknown');
  f.load('ld', p0, { widthBits: 32 });
  f.ret('r');
  return f.build(options);
}

/** A fully known, effect-free call must not block the link. */
function pureCallNoBarrier(options) {
  const f = fixture('function_pure_call');
  f.block('entry', []);
  const sp = f.stateRead('sp', 'state:sp');
  const c0 = f.constant('c0', 0);
  const p0 = f.binary('p0', 'add', sp, c0);
  f.store('st_known', p0, null, { widthBits: 32 });
  f.pureCall('call_pure');
  f.load('ld', p0, { widthBits: 32 });
  f.ret('r');
  return f.build(options);
}

/**
 * Two distinct opaque pointer parameters. They look alike and have different
 * roots, but nothing proves they are different objects, so neither `no` nor
 * `must` is available without escape evidence.
 */
function similarLookingRoots(options) {
  const f = fixture('function_similar_roots');
  f.block('entry', []);
  const a = f.stateRead('a', 'state:x0');
  const b = f.stateRead('b', 'state:x1');
  f.store('st_a', a, null, { widthBits: 32 });
  f.store('st_b', b, null, { widthBits: 32 });
  f.ret('r');
  return f.build(options);
}

/** A pointer selected between two distinct roots at runtime. */
function selectDistinctRoots(options) {
  const f = fixture('function_select_roots');
  f.block('entry', []);
  const cond = f.stateRead('cond', 'state:flags', { machineType: { kind: 'bitvector', widthBits: 1 } });
  const a = f.stateRead('a', 'state:x0');
  const b = f.stateRead('b', 'state:x1');
  const chosen = f.select('chosen', cond, a, b);
  f.store('st_chosen', chosen, null, { widthBits: 32 });
  f.store('st_a', a, null, { widthBits: 32 });
  f.ret('r');
  return f.build(options);
}

/** A pointer read out of memory: A2 does not resolve through loads. */
function loadDerivedPointer(options) {
  const f = fixture('function_load_derived');
  f.block('entry', []);
  const base = f.stateRead('base', 'state:x0');
  const loaded = f.load('loaded', base, { widthBits: 64 });
  const c0 = f.constant('c0', 0);
  const other = f.binary('other', 'add', base, c0);
  f.store('st_loaded', loaded, null, { widthBits: 32 });
  f.store('st_other', other, null, { widthBits: 32 });
  f.ret('r');
  return f.build(options);
}

const BUILDERS = Object.freeze({
  'stack-disjoint': stackDisjoint,
  'stack-overlapping': stackOverlapping,
  'stack-identical': stackIdentical,
  'uncertain-offset': uncertainOffset,
  'provenance-loss': provenanceLoss,
  'pointer-phi-distinct-offsets': pointerPhiDistinctOffsets,
  'cyclic-pointer-phi': cyclicPointerPhi,
  'overlapping-fields': overlappingFields,
  'unknown-store-barrier': unknownStoreBarrier,
  'unknown-call-barrier': unknownCallBarrier,
  'pure-call-no-barrier': pureCallNoBarrier,
  'similar-looking-roots': similarLookingRoots,
  'select-distinct-roots': selectDistinctRoots,
  'load-derived-pointer': loadDerivedPointer,
});

const cache = new Map();

/**
 * Builds one frozen fixture.
 *
 * `providerId` names the alias provider MemorySSA is wired to, so the same
 * fixture can be measured under the conservative floor and under the Phase 7
 * solver without either run contaminating the other's cache.
 */
export function buildFixture(id, { providerId = 'none', queryAliasFactory = null } = {}) {
  if (!BUILDERS[id]) throw new TypeError(`phase7-corpus-unknown-fixture:${id}`);
  const key = `${id}\u0000${providerId}`;
  if (!cache.has(key)) cache.set(key, BUILDERS[id]({ queryAliasFactory }));
  return cache.get(key);
}

export const FIXTURE_IDS = Object.freeze(Object.keys(BUILDERS).sort());

/**
 * The frozen alias query set. Precision is scored on exactly these pairs, with
 * exactly this denominator, so a candidate cannot look better by answering a
 * different set of questions (§17.3).
 */
export const ALIAS_QUERIES = Object.freeze([
  { id: 'q-stack-disjoint', fixture: 'stack-disjoint', left: 'node_st0', right: 'node_st8', truth: 'no', expectStrong: true, proofClass: 'interval' },
  { id: 'q-stack-overlapping', fixture: 'stack-overlapping', left: 'node_st0', right: 'node_st4', truth: 'may-or-weaker', expectStrong: false },
  { id: 'q-stack-identical', fixture: 'stack-identical', left: 'node_st', right: 'node_ld', truth: 'must', expectStrong: true, proofClass: 'identity' },
  { id: 'q-uncertain-offset', fixture: 'uncertain-offset', left: 'node_st0', right: 'node_stn', truth: 'may-or-weaker', expectStrong: false },
  { id: 'q-provenance-loss', fixture: 'provenance-loss', left: 'node_st_lost', right: 'node_st_other', truth: 'may-or-weaker', expectStrong: false },
  { id: 'q-pointer-phi', fixture: 'pointer-phi-distinct-offsets', left: 'node_st_merged', right: 'node_st_zero', truth: 'may-or-weaker', expectStrong: false },
  { id: 'q-cyclic-phi', fixture: 'cyclic-pointer-phi', left: 'node_st_cur', right: 'node_st_far', truth: 'may-or-weaker', expectStrong: false },
  { id: 'q-overlapping-fields', fixture: 'overlapping-fields', left: 'node_st_wide', right: 'node_st_inner', truth: 'may-or-weaker', expectStrong: false },
  { id: 'q-similar-roots', fixture: 'similar-looking-roots', left: 'node_st_a', right: 'node_st_b', truth: 'may-or-weaker', expectStrong: false },
  { id: 'q-select-roots', fixture: 'select-distinct-roots', left: 'node_st_chosen', right: 'node_st_a', truth: 'may-or-weaker', expectStrong: false },
  { id: 'q-load-derived', fixture: 'load-derived-pointer', left: 'node_st_loaded', right: 'node_st_other', truth: 'may-or-weaker', expectStrong: false },
]);

/**
 * The frozen memory-link query set: for each load, whether the reaching
 * definition must be an exact store or must remain blocked by a barrier.
 */
export const MEMORY_LINK_QUERIES = Object.freeze([
  { id: 'm-unknown-store', fixture: 'unknown-store-barrier', load: 'node_ld', truth: 'blocked' },
  { id: 'm-unknown-call', fixture: 'unknown-call-barrier', load: 'node_ld', truth: 'blocked' },
  { id: 'm-pure-call', fixture: 'pure-call-no-barrier', load: 'node_ld', truth: 'exact', expectedStore: 'node_st_known' },
  { id: 'm-stack-identical', fixture: 'stack-identical', load: 'node_ld', truth: 'exact', expectedStore: 'node_st' },
]);

export { memoryAccessOf, regionOf };
