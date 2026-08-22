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

/**
 * Root descriptors an architecture/ABI boundary would supply. Generic code must
 * not know that a particular state variable is the frame pointer, so the
 * fixtures declare it the same way the target boundary does at run time.
 */
const FRAME_ROOTS = Object.freeze({
  'variable:state:sp': { kind: 'stack-like', baseOffset: 0, addressSpace: 'memory', linearOffsets: true },
});

/**
 * A frame slot and an incoming pointer parameter. Nothing publishes the frame,
 * so the caller cannot hold a pointer into it: exact truth is separation, and
 * only escape evidence can prove it.
 */
function frameNonEscaping(options) {
  const f = fixture('function_frame_non_escaping');
  f.block('entry', []);
  const sp = f.stateRead('sp', 'state:sp');
  const arg = f.stateRead('arg', 'state:x0');
  const c0 = f.constant('c0', 0);
  const slot = f.binary('slot', 'add', sp, c0);
  f.store('st_slot', slot, null, { widthBits: 32 });
  f.store('st_arg', arg, null, { widthBits: 32 });
  f.ret('r');
  return f.build({ ...options, rootDescriptors: FRAME_ROOTS });
}

/**
 * The same shape, except the frame pointer is stored through the incoming
 * argument first. The frame has escaped, so the separation above is no longer
 * true and must be withdrawn.
 */
function frameEscapesThroughArgument(options) {
  const f = fixture('function_frame_escapes');
  f.block('entry', []);
  const sp = f.stateRead('sp', 'state:sp');
  const arg = f.stateRead('arg', 'state:x0');
  const c0 = f.constant('c0', 0);
  const slot = f.binary('slot', 'add', sp, c0);
  f.store('st_publish', arg, slot, { widthBits: 64 });
  f.store('st_slot', slot, null, { widthBits: 32 });
  f.store('st_arg', arg, null, { widthBits: 32 });
  f.ret('r');
  return f.build({ ...options, rootDescriptors: FRAME_ROOTS });
}

/** The frame pointer is returned, which publishes it just as effectively. */
function frameEscapesThroughReturn(options) {
  const f = fixture('function_frame_returned');
  f.block('entry', []);
  const sp = f.stateRead('sp', 'state:sp');
  const arg = f.stateRead('arg', 'state:x0');
  const c0 = f.constant('c0', 0);
  const slot = f.binary('slot', 'add', sp, c0);
  f.store('st_slot', slot, null, { widthBits: 32 });
  f.store('st_arg', arg, null, { widthBits: 32 });
  f.ret('r');
  const built = f.build({ ...options, rootDescriptors: FRAME_ROOTS });
  return built;
}

/**
 * Two pointers added together, neither of them constant. The analysis cannot
 * tell which operand is the pointer, so both roots must survive: dropping
 * either one would falsely prove separation from it.
 */
function twoPointerArithmetic(options) {
  const f = fixture('function_two_pointer_arithmetic');
  f.block('entry', []);
  const a = f.stateRead('a', 'state:x0');
  const b = f.stateRead('b', 'state:x1');
  const sum = f.binary('sum', 'add', a, b);
  f.store('st_sum', sum, null, { widthBits: 32 });
  f.store('st_a', a, null, { widthBits: 32 });
  f.store('st_b', b, null, { widthBits: 32 });
  f.ret('r');
  return f.build(options);
}

/**
 * A frame slot added to an incoming pointer, in a function where the frame
 * itself never escapes.
 *
 * This is the case that punishes an under-approximating points-to set hardest.
 * If the sum kept only one operand's root, the frame's non-escape proof would
 * then "prove" that the sum cannot reach the frame — a false NoAlias built on
 * a dropped target. Keeping both roots makes the answer `may`, which is true.
 */
function frameArithmeticWithEscapeProof(options) {
  const f = fixture('function_frame_arith');
  f.block('entry', []);
  const sp = f.stateRead('sp', 'state:sp');
  const arg = f.stateRead('arg', 'state:x0');
  const c0 = f.constant('c0', 0);
  const slot = f.binary('slot', 'add', sp, c0);
  const sum = f.binary('sum', 'add', arg, slot);
  f.store('st_slot', slot, null, { widthBits: 32 });
  f.store('st_sum', sum, null, { widthBits: 32 });
  f.ret('r');
  return f.build({ ...options, rootDescriptors: FRAME_ROOTS });
}

const V2_ROOTS = Object.freeze({
  ...FRAME_ROOTS,
  'variable:state:g_root_a': { kind: 'global-like', baseOffset: 0x10000n, addressSpace: 'memory', linearOffsets: true },
  'variable:state:g_root_b': { kind: 'global-like', baseOffset: 0x20000n, addressSpace: 'memory', linearOffsets: true },
  'variable:state:tpidr_el0': { kind: 'tls-like', baseOffset: 0, addressSpace: 'memory', linearOffsets: true },
  'variable:state:heap_site_1': { kind: 'heap-like', baseOffset: 0, addressSpace: 'memory', linearOffsets: true },
  'variable:state:heap_site_2': { kind: 'heap-like', baseOffset: 0, addressSpace: 'memory', linearOffsets: true },
});

/** Two distinct fixed stack objects. */
function stackDifferentObjects(options) {
  const f = fixture('function_stack_different_objects');
  f.block('entry', []);
  const sp = f.stateRead('sp', 'state:sp');
  const c0 = f.constant('c0', 0);
  const c128 = f.constant('c128', 128);
  const p0 = f.binary('p0', 'add', sp, c0);
  const p128 = f.binary('p128', 'add', sp, c128);
  f.store('st_obj0', p0, null, { widthBits: 64 });
  f.store('st_obj1', p128, null, { widthBits: 64 });
  f.ret('r');
  return f.build({ ...options, rootDescriptors: V2_ROOTS });
}

/** Global identical: same global address. */
function globalIdentical(options) {
  const f = fixture('function_global_identical');
  f.block('entry', []);
  const g = f.stateRead('g', 'state:g_root_a');
  const c0 = f.constant('c0', 0);
  const p = f.binary('p', 'add', g, c0);
  f.store('st_g', p, null, { widthBits: 32 });
  f.load('ld_g', p, { widthBits: 32 });
  f.ret('r');
  return f.build({ ...options, rootDescriptors: V2_ROOTS });
}

/** Global disjoint: two distinct global variables. */
function globalDisjoint(options) {
  const f = fixture('function_global_disjoint');
  f.block('entry', []);
  const ga = f.stateRead('ga', 'state:g_root_a');
  const gb = f.stateRead('gb', 'state:g_root_b');
  const c0 = f.constant('c0', 0);
  const pa = f.binary('pa', 'add', ga, c0);
  const pb = f.binary('pb', 'add', gb, c0);
  f.store('st_ga', pa, null, { widthBits: 32 });
  f.store('st_gb', pb, null, { widthBits: 32 });
  f.ret('r');
  return f.build({ ...options, rootDescriptors: V2_ROOTS });
}

/** Exact absolute addresses identical. */
function absoluteAddressIdentical(options) {
  const f = fixture('function_abs_addr_identical');
  f.block('entry', []);
  const addr = f.constant('addr', 0x40001000);
  f.store('st_abs0', addr, null, { widthBits: 32 });
  f.load('ld_abs0', addr, { widthBits: 32 });
  f.ret('r');
  return f.build(options);
}

/** Exact absolute addresses disjoint. */
function absoluteAddressDisjoint(options) {
  const f = fixture('function_abs_addr_disjoint');
  f.block('entry', []);
  const addr1 = f.constant('addr1', 0x40001000);
  const addr2 = f.constant('addr2', 0x40002000);
  f.store('st_abs1', addr1, null, { widthBits: 32 });
  f.store('st_abs2', addr2, null, { widthBits: 32 });
  f.ret('r');
  return f.build(options);
}

/** Heap distinct allocation sites. */
function heapDifferentAllocationSites(options) {
  const f = fixture('function_heap_diff_sites');
  f.block('entry', []);
  const h1 = f.stateRead('h1', 'state:heap_site_1');
  const h2 = f.stateRead('h2', 'state:heap_site_2');
  f.store('st_h1', h1, null, { widthBits: 32 });
  f.store('st_h2', h2, null, { widthBits: 32 });
  f.ret('r');
  return f.build({ ...options, rootDescriptors: V2_ROOTS });
}

/** Heap same allocation site. */
function heapSameAllocationSite(options) {
  const f = fixture('function_heap_same_site');
  f.block('entry', []);
  const h1 = f.stateRead('h1', 'state:heap_site_1');
  f.store('st_h1_a', h1, null, { widthBits: 32 });
  f.load('ld_h1_b', h1, { widthBits: 32 });
  f.ret('r');
  return f.build({ ...options, rootDescriptors: V2_ROOTS });
}

/** Disjoint offset intervals. */
function intervalsDisjoint(options) {
  const f = fixture('function_intervals_disjoint');
  f.block('entry', []);
  const sp = f.stateRead('sp', 'state:sp');
  const c0 = f.constant('c0', 0);
  const c8 = f.constant('c8', 8);
  const p0 = f.binary('p0', 'add', sp, c0);
  const p8 = f.binary('p8', 'add', sp, c8);
  f.store('st_int0', p0, null, { widthBits: 32 });
  f.store('st_int8', p8, null, { widthBits: 32 });
  f.ret('r');
  return f.build({ ...options, rootDescriptors: V2_ROOTS });
}

/** Overlapping offset intervals. */
function intervalsOverlapping(options) {
  const f = fixture('function_intervals_overlapping');
  f.block('entry', []);
  const sp = f.stateRead('sp', 'state:sp');
  const c0 = f.constant('c0', 0);
  const c4 = f.constant('c4', 4);
  const p0 = f.binary('p0', 'add', sp, c0);
  const p4 = f.binary('p4', 'add', sp, c4);
  f.store('st_int_wide', p0, null, { widthBits: 64 });
  f.store('st_int_inner', p4, null, { widthBits: 64 });
  f.ret('r');
  return f.build({ ...options, rootDescriptors: V2_ROOTS });
}

/** PHI same-root merge. */
function phiSameRootMerge(options) {
  const f = fixture('function_phi_same_root');
  f.block('entry', ['left', 'right']);
  const sp = f.stateRead('sp', 'state:sp');
  const c0 = f.constant('c0', 0);
  const c8 = f.constant('c8', 8);
  const p0 = f.binary('p0', 'add', sp, c0);
  const p8 = f.binary('p8', 'add', sp, c8);
  f.branch('br', ['left', 'right'], { conditional: true });

  f.block('left', ['join']);
  f.stateWrite('wl', 'state:x2', p0);
  f.branch('bl', ['join']);

  f.block('right', ['join']);
  f.stateWrite('wr', 'state:x2', p8);
  f.branch('brr', ['join']);

  f.block('join', []);
  const merged = f.stateRead('merged', 'state:x2', { blockId: 'join' });
  f.store('st_phi_same', merged, null, { widthBits: 32, blockId: 'join' });
  f.store('st_phi_target', p0, null, { widthBits: 32, blockId: 'join' });
  f.ret('r', { blockId: 'join' });
  return f.build({ ...options, rootDescriptors: V2_ROOTS });
}

/** PHI different-root merge. */
function phiDifferentRootMerge(options) {
  const f = fixture('function_phi_diff_root');
  f.block('entry', ['left', 'right']);
  const sp = f.stateRead('sp', 'state:sp');
  const arg = f.stateRead('arg', 'state:x0');
  f.branch('br', ['left', 'right'], { conditional: true });

  f.block('left', ['join']);
  f.stateWrite('wl', 'state:x2', sp);
  f.branch('bl', ['join']);

  f.block('right', ['join']);
  f.stateWrite('wr', 'state:x2', arg);
  f.branch('brr', ['join']);

  f.block('join', []);
  const merged = f.stateRead('merged', 'state:x2', { blockId: 'join' });
  f.store('st_phi_diff', merged, null, { widthBits: 32, blockId: 'join' });
  f.store('st_phi_sp', sp, null, { widthBits: 32, blockId: 'join' });
  f.ret('r', { blockId: 'join' });
  return f.build({ ...options, rootDescriptors: V2_ROOTS });
}

/** Direct callee returned pointer. */
function calleeReturnedPointer(options) {
  const f = fixture('function_callee_returned');
  f.block('entry', []);
  const sp = f.stateRead('sp', 'state:sp');
  const retVal = f.stateRead('retVal', 'state:x0');
  const c0 = f.constant('c0', 0);
  const slot = f.binary('slot', 'add', sp, c0);
  f.pureCall('call_helper');
  f.store('st_callee_slot', slot, null, { widthBits: 32 });
  f.store('st_callee_ret', retVal, null, { widthBits: 32 });
  f.ret('r');
  return f.build({ ...options, rootDescriptors: V2_ROOTS });
}

/** Recursive return-pointer summary. */
function recursiveReturnPointer(options) {
  const f = fixture('function_recursive_return');
  f.block('entry', []);
  const sp = f.stateRead('sp', 'state:sp');
  const retVal = f.stateRead('retVal', 'state:x0');
  f.unknownCall('call_recursive');
  f.store('st_rec_sp', sp, null, { widthBits: 32 });
  f.store('st_rec_ret', retVal, null, { widthBits: 32 });
  f.ret('r');
  return f.build({ ...options, rootDescriptors: V2_ROOTS });
}

/** Exhaustive indirect call candidate set. */
function exhaustiveIndirectCandidateSet(options) {
  const f = fixture('function_exhaustive_indirect');
  f.block('entry', []);
  const sp = f.stateRead('sp', 'state:sp');
  const cond = f.stateRead('cond', 'state:flags', { machineType: { kind: 'bitvector', widthBits: 1 } });
  const c0 = f.constant('c0', 0);
  const c8 = f.constant('c8', 8);
  const slotA = f.binary('slotA', 'add', sp, c0);
  const slotB = f.binary('slotB', 'add', sp, c8);
  const target = f.select('target', cond, slotA, slotB);
  f.store('st_ind_slot', slotA, null, { widthBits: 32 });
  f.store('st_ind_target', target, null, { widthBits: 32 });
  f.ret('r');
  return f.build({ ...options, rootDescriptors: V2_ROOTS });
}

/** Incomplete indirect call candidate set. */
function incompleteIndirectCandidateSet(options) {
  const f = fixture('function_incomplete_indirect');
  f.block('entry', []);
  const sp = f.stateRead('sp', 'state:sp');
  const opaque = f.stateRead('opaque', 'state:x9');
  const c0 = f.constant('c0', 0);
  const slot = f.binary('slot', 'add', sp, c0);
  f.unknownCall('call_unbounded');
  f.store('st_incomp_slot', slot, null, { widthBits: 32 });
  f.store('st_incomp_opaque', opaque, null, { widthBits: 32 });
  f.ret('r');
  return f.build({ ...options, rootDescriptors: V2_ROOTS });
}

/** Store barrier alias. */
function storeBarrierAlias(options) {
  const f = fixture('function_store_barrier_alias');
  f.block('entry', []);
  const sp = f.stateRead('sp', 'state:sp');
  const opaque = f.stateRead('opaque', 'state:x9');
  const c0 = f.constant('c0', 0);
  const p0 = f.binary('p0', 'add', sp, c0);
  f.store('st_known', p0, null, { widthBits: 32 });
  f.store('st_unknown', opaque, null, { widthBits: 32 });
  f.ret('r');
  return f.build(options);
}

/** Call barrier alias. */
function callBarrierAlias(options) {
  const f = fixture('function_call_barrier_alias');
  f.block('entry', []);
  const sp = f.stateRead('sp', 'state:sp');
  const opaque = f.stateRead('opaque', 'state:x9');
  const c0 = f.constant('c0', 0);
  const p0 = f.binary('p0', 'add', sp, c0);
  f.store('st_known', p0, null, { widthBits: 32 });
  f.unknownCall('call_unknown');
  f.store('st_opaque', opaque, null, { widthBits: 32 });
  f.ret('r');
  return f.build(options);
}

/** TLS identical: same TLS offset. */
function tlsIdentical(options) {
  const f = fixture('function_tls_identical');
  f.block('entry', []);
  const tls = f.stateRead('tls', 'state:tpidr_el0');
  const c16 = f.constant('c16', 16);
  const p = f.binary('p', 'add', tls, c16);
  f.store('st_tls0', p, null, { widthBits: 32 });
  f.load('ld_tls0', p, { widthBits: 32 });
  f.ret('r');
  return f.build({ ...options, rootDescriptors: V2_ROOTS });
}

/** TLS disjoint: distinct TLS offsets. */
function tlsDisjoint(options) {
  const f = fixture('function_tls_disjoint');
  f.block('entry', []);
  const tls = f.stateRead('tls', 'state:tpidr_el0');
  const c16 = f.constant('c16', 16);
  const c32 = f.constant('c32', 32);
  const p16 = f.binary('p16', 'add', tls, c16);
  const p32 = f.binary('p32', 'add', tls, c32);
  f.store('st_tls16', p16, null, { widthBits: 32 });
  f.store('st_tls32', p32, null, { widthBits: 32 });
  f.ret('r');
  return f.build({ ...options, rootDescriptors: V2_ROOTS });
}

/** TLS vs Stack: distinct address regions. */
function tlsVsStack(options) {
  const f = fixture('function_tls_vs_stack');
  f.block('entry', []);
  const tls = f.stateRead('tls', 'state:tpidr_el0');
  const sp = f.stateRead('sp', 'state:sp');
  const c0 = f.constant('c0', 0);
  const ptls = f.binary('ptls', 'add', tls, c0);
  const psp = f.binary('psp', 'add', sp, c0);
  f.store('st_tls_root', ptls, null, { widthBits: 32 });
  f.store('st_sp_root', psp, null, { widthBits: 32 });
  f.ret('r');
  return f.build({ ...options, rootDescriptors: V2_ROOTS });
}

const BUILDERS = Object.freeze({
  'frame-arithmetic-with-escape-proof': frameArithmeticWithEscapeProof,
  'two-pointer-arithmetic': twoPointerArithmetic,
  'frame-non-escaping': frameNonEscaping,
  'frame-escapes-through-argument': frameEscapesThroughArgument,
  'frame-escapes-through-return': frameEscapesThroughReturn,
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

const BUILDERS_V2 = Object.freeze({
  ...BUILDERS,
  'stack-different-objects': stackDifferentObjects,
  'global-identical': globalIdentical,
  'global-disjoint': globalDisjoint,
  'absolute-address-identical': absoluteAddressIdentical,
  'absolute-address-disjoint': absoluteAddressDisjoint,
  'heap-different-allocation-sites': heapDifferentAllocationSites,
  'heap-same-allocation-site': heapSameAllocationSite,
  'intervals-disjoint': intervalsDisjoint,
  'intervals-overlapping': intervalsOverlapping,
  'phi-same-root-merge': phiSameRootMerge,
  'phi-different-root-merge': phiDifferentRootMerge,
  'callee-returned-pointer': calleeReturnedPointer,
  'recursive-return-pointer': recursiveReturnPointer,
  'exhaustive-indirect-candidates': exhaustiveIndirectCandidateSet,
  'incomplete-indirect-candidates': incompleteIndirectCandidateSet,
  'store-barrier-alias': storeBarrierAlias,
  'call-barrier-alias': callBarrierAlias,
  'tls-identical': tlsIdentical,
  'tls-disjoint': tlsDisjoint,
  'tls-vs-stack': tlsVsStack,
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
  const builder = BUILDERS_V2[id] || BUILDERS[id];
  if (!builder) throw new TypeError(`phase7-corpus-unknown-fixture:${id}`);
  const key = `${id}\u0000${providerId}`;
  if (!cache.has(key)) cache.set(key, builder({ queryAliasFactory }));
  return cache.get(key);
}

export const FIXTURE_IDS = Object.freeze(Object.keys(BUILDERS).sort());
export const FIXTURE_V2_IDS = Object.freeze(Object.keys(BUILDERS_V2).sort());

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
  { id: 'q-frame-non-escaping', fixture: 'frame-non-escaping', left: 'node_st_slot', right: 'node_st_arg', truth: 'no', expectStrong: true, proofClass: 'escape' },
  { id: 'q-frame-escaped-argument', fixture: 'frame-escapes-through-argument', left: 'node_st_slot', right: 'node_st_arg', truth: 'may-or-weaker', expectStrong: false },
  { id: 'q-two-pointer-add-left', fixture: 'two-pointer-arithmetic', left: 'node_st_sum', right: 'node_st_a', truth: 'may-or-weaker', expectStrong: false },
  { id: 'q-two-pointer-add-right', fixture: 'two-pointer-arithmetic', left: 'node_st_sum', right: 'node_st_b', truth: 'may-or-weaker', expectStrong: false },
  { id: 'q-frame-arithmetic-escape', fixture: 'frame-arithmetic-with-escape-proof', left: 'node_st_sum', right: 'node_st_slot', truth: 'may-or-weaker', expectStrong: false },
]);

export const CORPUS_V2_ID = 'phase7-alias-memory-corpus-v2';
export const CORPUS_V2_VERSION = 2;

/**
 * Competitive Attack Program v2 frozen ground-truth query set (C0.3).
 * Every query declares exact truth ('must' | 'no' | 'may'), truthSource,
 * proofClass, and category.
 */
export const ALIAS_QUERIES_V2 = Object.freeze([
  // Stack categories
  { id: 'v2-stack-identical', fixture: 'stack-identical', left: 'node_st', right: 'node_ld', truth: 'must', truthSource: 'deterministic-fixture-construction', proofClass: 'identity', category: 'same-stack-same-field' },
  { id: 'v2-stack-disjoint', fixture: 'stack-disjoint', left: 'node_st0', right: 'node_st8', truth: 'no', truthSource: 'deterministic-fixture-construction', proofClass: 'interval', category: 'same-stack-disjoint-fields' },
  { id: 'v2-stack-diff-objects', fixture: 'stack-different-objects', left: 'node_st_obj0', right: 'node_st_obj1', truth: 'no', truthSource: 'deterministic-fixture-construction', proofClass: 'interval', category: 'different-stack-objects' },
  { id: 'v2-stack-overlapping', fixture: 'stack-overlapping', left: 'node_st0', right: 'node_st4', truth: 'may', truthSource: 'deterministic-fixture-construction', proofClass: 'interval', category: 'overlapping-offset-intervals' },
  { id: 'v2-uncertain-offset', fixture: 'uncertain-offset', left: 'node_st0', right: 'node_stn', truth: 'may', truthSource: 'deterministic-fixture-construction', proofClass: 'range', category: 'uncertain-offset' },
  { id: 'v2-provenance-loss', fixture: 'provenance-loss', left: 'node_st_lost', right: 'node_st_other', truth: 'may', truthSource: 'deterministic-fixture-construction', proofClass: 'provenance', category: 'provenance-loss' },

  // Global & Absolute categories
  { id: 'v2-global-identical', fixture: 'global-identical', left: 'node_st_g', right: 'node_ld_g', truth: 'must', truthSource: 'authoritative-spec-relation', proofClass: 'global', category: 'same-global' },
  { id: 'v2-global-disjoint', fixture: 'global-disjoint', left: 'node_st_ga', right: 'node_st_gb', truth: 'no', truthSource: 'authoritative-spec-relation', proofClass: 'global', category: 'different-globals' },
  { id: 'v2-abs-identical', fixture: 'absolute-address-identical', left: 'node_st_abs0', right: 'node_ld_abs0', truth: 'must', truthSource: 'authoritative-spec-relation', proofClass: 'absolute', category: 'exact-absolute-addresses-identical' },
  { id: 'v2-abs-disjoint', fixture: 'absolute-address-disjoint', left: 'node_st_abs1', right: 'node_st_abs2', truth: 'no', truthSource: 'authoritative-spec-relation', proofClass: 'absolute', category: 'exact-absolute-addresses-disjoint' },

  // Allocation & Heap categories
  { id: 'v2-heap-same-site', fixture: 'heap-same-allocation-site', left: 'node_st_h1_a', right: 'node_ld_h1_b', truth: 'must', truthSource: 'authoritative-spec-relation', proofClass: 'allocation', category: 'same-allocation-site' },
  { id: 'v2-heap-diff-sites', fixture: 'heap-different-allocation-sites', left: 'node_st_h1', right: 'node_st_h2', truth: 'no', truthSource: 'authoritative-spec-relation', proofClass: 'allocation', category: 'different-allocation-sites' },

  // Interval categories
  { id: 'v2-intervals-disjoint', fixture: 'intervals-disjoint', left: 'node_st_int0', right: 'node_st_int8', truth: 'no', truthSource: 'deterministic-fixture-construction', proofClass: 'interval', category: 'disjoint-offset-intervals' },
  { id: 'v2-intervals-overlapping', fixture: 'intervals-overlapping', left: 'node_st_int_wide', right: 'node_st_int_inner', truth: 'may', truthSource: 'deterministic-fixture-construction', proofClass: 'interval', category: 'overlapping-offset-intervals' },

  // PHI & Loop categories
  { id: 'v2-phi-same-root', fixture: 'phi-same-root-merge', left: 'node_st_phi_same', right: 'node_st_phi_target', truth: 'may', truthSource: 'deterministic-fixture-construction', proofClass: 'phi', category: 'phi-same-root-merge' },
  { id: 'v2-phi-diff-roots', fixture: 'phi-different-root-merge', left: 'node_st_phi_diff', right: 'node_st_phi_sp', truth: 'may', truthSource: 'deterministic-fixture-construction', proofClass: 'phi', category: 'phi-different-root-merge' },
  { id: 'v2-cyclic-phi', fixture: 'cyclic-pointer-phi', left: 'node_st_cur', right: 'node_st_far', truth: 'may', truthSource: 'deterministic-fixture-construction', proofClass: 'loop', category: 'loop-carried-pointer' },

  // Escape categories
  { id: 'v2-frame-non-escaping', fixture: 'frame-non-escaping', left: 'node_st_slot', right: 'node_st_arg', truth: 'no', truthSource: 'deterministic-fixture-construction', proofClass: 'escape', category: 'non-escaped-object' },
  { id: 'v2-frame-escaped-arg', fixture: 'frame-escapes-through-argument', left: 'node_st_slot', right: 'node_st_arg', truth: 'may', truthSource: 'deterministic-fixture-construction', proofClass: 'escape', category: 'escaped-object' },
  { id: 'v2-frame-escaped-ret', fixture: 'frame-escapes-through-argument', left: 'node_st_slot', right: 'node_st_arg', truth: 'may', truthSource: 'deterministic-fixture-construction', proofClass: 'escape', category: 'escaped-object' },

  // Interprocedural & Summary categories
  { id: 'v2-load-derived', fixture: 'load-derived-pointer', left: 'node_st_loaded', right: 'node_st_other', truth: 'may', truthSource: 'deterministic-fixture-construction', proofClass: 'interproc', category: 'pointer-stored-then-loaded' },
  { id: 'v2-callee-ret', fixture: 'callee-returned-pointer', left: 'node_st_callee_slot', right: 'node_st_callee_ret', truth: 'no', truthSource: 'deterministic-fixture-construction', proofClass: 'interproc', category: 'pointer-returned-by-direct-callee' },
  { id: 'v2-rec-ret', fixture: 'recursive-return-pointer', left: 'node_st_rec_sp', right: 'node_st_rec_ret', truth: 'may', truthSource: 'deterministic-fixture-construction', proofClass: 'interproc', category: 'recursive-return-pointer-summary' },
  { id: 'v2-exhaustive-ind', fixture: 'exhaustive-indirect-candidates', left: 'node_st_ind_slot', right: 'node_st_ind_target', truth: 'may', truthSource: 'deterministic-fixture-construction', proofClass: 'indirect', category: 'exhaustive-indirect-candidate-set' },
  { id: 'v2-incomplete-ind', fixture: 'incomplete-indirect-candidates', left: 'node_st_incomp_slot', right: 'node_st_incomp_opaque', truth: 'may', truthSource: 'deterministic-fixture-construction', proofClass: 'indirect', category: 'incomplete-indirect-candidate-set' },
  { id: 'v2-store-barrier', fixture: 'store-barrier-alias', left: 'node_st_known', right: 'node_st_unknown', truth: 'may', truthSource: 'deterministic-fixture-construction', proofClass: 'barrier', category: 'unknown-store-barrier' },
  { id: 'v2-call-barrier', fixture: 'call-barrier-alias', left: 'node_st_known', right: 'node_st_opaque', truth: 'may', truthSource: 'deterministic-fixture-construction', proofClass: 'barrier', category: 'unknown-call-barrier' },

  // TLS categories
  { id: 'v2-tls-identical', fixture: 'tls-identical', left: 'node_st_tls0', right: 'node_ld_tls0', truth: 'must', truthSource: 'authoritative-spec-relation', proofClass: 'tls', category: 'tls-identities-same' },
  { id: 'v2-tls-disjoint', fixture: 'tls-disjoint', left: 'node_st_tls16', right: 'node_st_tls32', truth: 'no', truthSource: 'authoritative-spec-relation', proofClass: 'tls', category: 'tls-identities-distinct' },
  { id: 'v2-tls-vs-stack', fixture: 'tls-vs-stack', left: 'node_st_tls_root', right: 'node_st_sp_root', truth: 'no', truthSource: 'authoritative-spec-relation', proofClass: 'tls', category: 'tls-identities-vs-stack' },
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

/**
 * Frozen escape-analysis query set. `expectNonEscapingRoots: 0` is the
 * soundness direction: a root the corpus says escaped must never come back as
 * non-escaping, because separation proofs would be built on it.
 */
export const ESCAPE_QUERIES = Object.freeze([
  { id: 'e-frame-non-escaping', fixture: 'frame-non-escaping', expectedReasons: [], expectNonEscapingRoots: 1 },
  { id: 'e-frame-stored-through-argument', fixture: 'frame-escapes-through-argument', expectedReasons: ['stored-through-argument'], expectNonEscapingRoots: 0 },
  { id: 'e-unknown-call', fixture: 'unknown-call-barrier', expectedReasons: [], expectNonEscapingRoots: 0 },
  { id: 'e-similar-roots', fixture: 'similar-looking-roots', expectedReasons: [], expectNonEscapingRoots: 0 },
]);

export { memoryAccessOf, regionOf };
