/**
 * Frozen function-discovery corpus.
 *
 * Truth represents starts and owned regions *separately* (§17.7), and regions
 * may be non-contiguous or explicitly shared. Thunks, tail-merged blocks and
 * shared epilogues carry explicit labels so the metric does not punish a
 * correct non-simple representation or reward an incorrect contiguous one.
 *
 * Each case supplies evidence in the neutral producer shape, so the same case
 * can be replayed on every mandatory architecture lane — which is what the
 * metamorphic laws need.
 */

export const DISCOVERY_CORPUS_ID = 'phase7-discovery-corpus';
export const DISCOVERY_CORPUS_VERSION = 1;

const image = (overrides = {}) => ({
  functionStarts: [], unwindEntries: [], exports: [], symbols: [],
  relocationTargets: [], vtableEntries: [], exceptionMetadata: [], ...overrides,
});

/** Two ordinary functions, both with loader starts and unwind extents. */
function simplePair() {
  return {
    image: image({
      functionStarts: [{ address: 0x1000, name: 'alpha' }, { address: 0x1040, name: 'beta' }],
      unwindEntries: [{ start: 0x1000, end: 0x1040 }, { start: 0x1040, end: 0x1080 }],
    }),
  };
}

/**
 * Two functions that jump into one shared epilogue. The epilogue bytes belong
 * to both, and the truth says so rather than assigning them to one owner.
 */
function sharedEpilogue() {
  return {
    image: image({
      functionStarts: [{ address: 0x2000, name: 'gamma' }, { address: 0x2040, name: 'delta' }],
      unwindEntries: [{ start: 0x2000, end: 0x2038 }, { start: 0x2040, end: 0x2078 }],
      // The shared tail is reported by exception metadata as belonging to both.
      exceptionMetadata: [{ address: 0x2078 }],
    }),
  };
}

/**
 * A tail call: the caller's last instruction transfers to another function.
 * The callee is a real start, and the caller's extent must not swallow it.
 */
function tailCall() {
  return {
    image: image({
      functionStarts: [{ address: 0x3000, name: 'caller' }],
      unwindEntries: [{ start: 0x3000, end: 0x3020 }],
      symbols: [{ address: 0x3020, name: 'tail_target', isFunction: true, sizeBytes: 0x20 }],
    }),
    callTargets: [{ address: 0x3020, name: 'tail_target', callSiteId: 'cs_tail' }],
  };
}

/** A thunk: a tiny function that only forwards to its target. */
function thunk() {
  return {
    image: image({
      functionStarts: [{ address: 0x4000, name: 'thunk_to_real', sizeBytes: 6 }, { address: 0x4100, name: 'real' }],
      unwindEntries: [{ start: 0x4100, end: 0x4180 }],
    }),
    callTargets: [{ address: 0x4100, name: 'real', callSiteId: 'cs_thunk' }],
  };
}

/** One function whose body is split across two ranges by a cold section. */
function nonContiguous() {
  return {
    image: image({
      functionStarts: [{ address: 0x5000, name: 'split' }],
      unwindEntries: [
        { start: 0x5000, end: 0x5030 },
        // The cold range is a continuation of the same function, which is how
        // ELF .eh_frame and PE .pdata chained entries describe it. It is not a
        // second function start.
        { start: 0x9000, end: 0x9010, primary: false, ownerStart: 0x5000 },
      ],
    }),
  };
}

/**
 * A precise start with no extent evidence at all — the case P7-INV-006 exists
 * for. The right answer is an exact start and an unknown extent.
 */
function startWithoutExtent() {
  return {
    image: image({
      functionStarts: [{ address: 0x6000, name: 'known_start' }],
    }),
  };
}

/**
 * A stripped image: only heuristic pattern evidence. Nothing here may become an
 * exact start.
 */
function strippedHeuristicOnly() {
  return {
    image: image({
      code: Uint8Array.from([0x55, 0x48, 0x89, 0xe5, 0x90, 0x90, 0x55, 0x48, 0x89, 0xe5]),
      codeBaseAddress: 0x7000,
    }),
    patterns: [{ id: 'frame-setup', bytes: [0x55, 0x48, 0x89, 0xe5] }],
  };
}

/** Two authoritative sources that disagree about the extent of one function. */
function contradictoryExtents() {
  return {
    image: image({
      functionStarts: [{ address: 0x8000, name: 'disputed', sizeBytes: 0x20 }],
      unwindEntries: [{ start: 0x8000, end: 0x8040 }],
    }),
  };
}

const CASES = Object.freeze({
  'simple-pair': simplePair,
  'shared-epilogue': sharedEpilogue,
  'tail-call': tailCall,
  'thunk': thunk,
  'non-contiguous': nonContiguous,
  'start-without-extent': startWithoutExtent,
  'stripped-heuristic-only': strippedHeuristicOnly,
  'contradictory-extents': contradictoryExtents,
});

export const DISCOVERY_CASE_IDS = Object.freeze(Object.keys(CASES).sort());

export function buildDiscoveryCase(id) {
  if (!CASES[id]) throw new TypeError(`phase7-discovery-corpus-unknown-case:${id}`);
  return CASES[id]();
}

/**
 * Declared truth.
 *
 * `starts` are the real function starts. `regions` maps a start to the byte
 * ranges it owns; `shared: true` marks a range owned by more than one function.
 * `extentKnowable: false` says the corpus itself does not determine an extent,
 * so reporting `unknown` is correct and reporting anything else is not.
 */
export const DISCOVERY_TRUTH = Object.freeze([
  {
    id: 'd-simple-pair', case: 'simple-pair',
    starts: ['0x1000', '0x1040'],
    regions: { '0x1000': [{ start: '0x1000', end: '0x1040' }], '0x1040': [{ start: '0x1040', end: '0x1080' }] },
    extentKnowable: true, labels: {},
  },
  {
    id: 'd-shared-epilogue', case: 'shared-epilogue',
    starts: ['0x2000', '0x2040'],
    regions: {
      '0x2000': [{ start: '0x2000', end: '0x2038' }],
      '0x2040': [{ start: '0x2040', end: '0x2078' }],
    },
    extentKnowable: true, labels: { '0x2078': 'shared-epilogue' },
  },
  {
    id: 'd-tail-call', case: 'tail-call',
    starts: ['0x3000', '0x3020'],
    regions: { '0x3000': [{ start: '0x3000', end: '0x3020' }], '0x3020': [{ start: '0x3020', end: '0x3040' }] },
    extentKnowable: true, labels: { '0x3020': 'tail-call-target' },
  },
  {
    id: 'd-thunk', case: 'thunk',
    starts: ['0x4000', '0x4100'],
    regions: { '0x4000': [{ start: '0x4000', end: '0x4006' }], '0x4100': [{ start: '0x4100', end: '0x4180' }] },
    extentKnowable: true, labels: { '0x4000': 'thunk' },
  },
  {
    id: 'd-non-contiguous', case: 'non-contiguous',
    starts: ['0x5000'],
    // One function, two ranges. A metric that forced contiguity would score
    // the correct answer as wrong here.
    regions: { '0x5000': [{ start: '0x5000', end: '0x5030' }, { start: '0x9000', end: '0x9010' }] },
    extentKnowable: true, labels: { '0x5000': 'non-contiguous' },
  },
  {
    id: 'd-start-without-extent', case: 'start-without-extent',
    starts: ['0x6000'],
    regions: {},
    extentKnowable: false, labels: {},
  },
  {
    id: 'd-stripped-heuristic-only', case: 'stripped-heuristic-only',
    starts: ['0x7000', '0x7006'],
    regions: {},
    extentKnowable: false,
    // Nothing here may be reported as exact: the only evidence is a byte
    // pattern, which never establishes a start on its own.
    maxStartState: 'heuristic',
    labels: {},
  },
  {
    id: 'd-contradictory-extents', case: 'contradictory-extents',
    starts: ['0x8000'],
    regions: {},
    extentKnowable: false,
    requireExtentConflict: true,
    labels: {},
  },
]);
