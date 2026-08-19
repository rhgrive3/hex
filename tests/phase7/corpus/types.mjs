/**
 * Frozen type corpus for P7-4.
 *
 * Type accuracy is scored per layer, never as one aggregate, because a single
 * number can hide false certainty in one layer behind accuracy in another
 * (§17.6). Each case declares the expected outcome layer by layer, and the
 * false-certainty cases declare that *no* selection is correct.
 *
 * Debug-assisted and no-debug variants are built from the same case so the two
 * can be reported separately, and DWARF/PDB cannot conceal a regression in
 * inference quality (§11.4).
 */

export const TYPE_CORPUS_ID = 'phase7-type-corpus';
export const TYPE_CORPUS_VERSION = 1;

const machine = (entityId, widthBits, klass = 'integer') => ({
  layer: 'machine', entityId, descriptor: { widthBits, class: klass },
});
const abi = (entityId, location, passingClass) => ({
  layer: 'abi', entityId, descriptor: { location, passingClass },
});
const structural = (entityId, offset, sizeBytes, memberType) => ({
  layer: 'structural', entityId, descriptor: { offset, sizeBytes, memberType },
});
const nominal = (entityId, name, aliases = []) => ({
  layer: 'nominal', entityId, descriptor: { name, aliases },
});

/**
 * Each case is a list of constraint/evidence descriptors plus the truth. Debug
 * constraints are tagged so the no-debug variant can drop exactly those.
 */
export const TYPE_CASES = Object.freeze([
  {
    id: 't-access-width',
    entityId: 'entity_counter',
    hard: [{ kind: 'access-width', origin: 'binary-evidence', claim: machine('entity_counter', 32) }],
    soft: [],
    truth: { machine: { widthBits: 32, class: 'integer' } },
    expectCertain: ['machine'],
  },
  {
    id: 't-abi-location',
    entityId: 'entity_arg0',
    hard: [{ kind: 'abi-location', origin: 'abi-boundary', claim: abi('entity_arg0', 'integer-register-0', 'integer') }],
    soft: [{ kind: 'symbol-spelling', origin: 'heuristic', weight: 0.6, claim: nominal('entity_arg0', 'size_t') }],
    truth: { abi: { location: 'integer-register-0' }, nominal: { name: 'size_t' } },
    expectCertain: ['abi'],
  },
  {
    id: 't-contradicting-widths',
    entityId: 'entity_conflicted',
    hard: [
      { kind: 'access-width', origin: 'binary-evidence', claim: machine('entity_conflicted', 32) },
      { kind: 'debug-type', origin: 'debug-matched', claim: machine('entity_conflicted', 64), debug: true },
    ],
    soft: [{ kind: 'use-shape', origin: 'heuristic', weight: 0.95, claim: machine('entity_conflicted', 64) }],
    // Two hard constraints disagree. No selection is correct at that layer, and
    // a strong soft signal must not break the tie.
    truth: { machine: null },
    expectContradiction: ['machine'],
    expectCertain: [],
    // Without the debug record there is no disagreement, and the binary's own
    // width is then the correct certain answer. Removing evidence changes what
    // is knowable, so the no-debug variant carries its own truth rather than
    // being scored against the debug-assisted one.
    noDebug: {
      truth: { machine: { widthBits: 32, class: 'integer' } },
      expectContradiction: [],
      expectCertain: ['machine'],
    },
  },
  {
    id: 't-soft-only-ranking',
    entityId: 'entity_guessed',
    hard: [],
    soft: [
      { kind: 'symbol-spelling', origin: 'heuristic', weight: 0.8, claim: nominal('entity_guessed', 'FILE') },
      { kind: 'use-shape', origin: 'heuristic', weight: 0.4, claim: nominal('entity_guessed', 'void') },
    ],
    truth: { nominal: { name: 'FILE' } },
    expectCertain: [],
    expectProbable: ['nominal'],
  },
  {
    id: 't-soft-tie-is-ambiguous',
    entityId: 'entity_tied',
    hard: [],
    soft: [
      { kind: 'symbol-spelling', origin: 'heuristic', weight: 0.5, claim: nominal('entity_tied', 'Alpha') },
      { kind: 'signature-candidate', origin: 'heuristic', weight: 0.5, claim: nominal('entity_tied', 'Beta') },
    ],
    truth: { nominal: null },
    expectCertain: [],
    expectAmbiguous: ['nominal'],
  },
  {
    id: 't-soft-cannot-overrule-hard',
    entityId: 'entity_overruled',
    hard: [{ kind: 'access-width', origin: 'binary-evidence', claim: machine('entity_overruled', 8) }],
    soft: [{ kind: 'array-stride-heuristic', origin: 'heuristic', weight: 1, claim: machine('entity_overruled', 64) }],
    truth: { machine: { widthBits: 8, class: 'integer' } },
    expectCertain: ['machine'],
  },
  {
    id: 't-union-overlap',
    entityId: 'entity_union',
    hard: [
      { kind: 'debug-type', origin: 'debug-matched', claim: structural('entity_union', 0, 8, { name: 'int64' }), debug: true },
      { kind: 'debug-type', origin: 'debug-matched', claim: structural('entity_union', 0, 8, { name: 'double' }), debug: true },
    ],
    soft: [],
    // Overlapping storage with incompatible member types is a real union; the
    // graph must report the conflict rather than pick one member.
    truth: { structural: null },
    expectContradiction: ['structural'],
    expectCertain: [],
    // Both constraints are debug-sourced, so the no-debug variant has no
    // structural evidence at all and correctly concludes nothing.
    noDebug: { truth: {}, expectContradiction: [], expectCertain: [] },
  },
  {
    id: 't-disjoint-fields-coexist',
    entityId: 'entity_struct',
    hard: [
      { kind: 'debug-type', origin: 'debug-matched', claim: structural('entity_struct', 0, 4, { name: 'int32' }), debug: true },
      { kind: 'debug-type', origin: 'debug-matched', claim: structural('entity_struct', 8, 4, { name: 'int32' }), debug: true },
    ],
    soft: [],
    truth: { structural: { offset: 0, sizeBytes: 4 } },
    expectCertain: ['structural'],
    noDebug: { truth: {}, expectCertain: [] },
  },
  {
    id: 't-nominal-alias-is-not-conflict',
    entityId: 'entity_alias',
    hard: [
      { kind: 'debug-type', origin: 'debug-matched', claim: nominal('entity_alias', 'uint32_t', ['uint32_t', 'unsigned int']), debug: true },
      { kind: 'call-prototype', origin: 'binary-evidence', claim: nominal('entity_alias', 'unsigned int', ['uint32_t', 'unsigned int']) },
    ],
    soft: [],
    truth: { nominal: { name: 'uint32_t' } },
    expectCertain: ['nominal'],
    // The call prototype survives without debug info, and it spells the same
    // type by its other sanctioned alias.
    noDebug: { truth: { nominal: { name: 'unsigned int' } }, expectCertain: ['nominal'] },
  },
  {
    id: 't-user-declared-constraint',
    entityId: 'entity_user',
    hard: [{ kind: 'user-declared', origin: 'user-approved', claim: nominal('entity_user', 'MyHandle') }],
    soft: [],
    truth: { nominal: { name: 'MyHandle' } },
    expectCertain: ['nominal'],
    userConstrained: true,
  },
]);

/**
 * Builds the constraint list for one case.
 *
 * `withDebug: false` drops every debug-sourced hard constraint, which is what
 * makes the debug-assisted and no-debug scores separable.
 */
export function caseConstraints(testCase, { withDebug = true } = {}) {
  const hard = testCase.hard.filter((constraint) => withDebug || constraint.debug !== true);
  return { hard, soft: testCase.soft };
}

/**
 * The truth and expectations that apply to one run.
 *
 * Removing debug evidence genuinely changes what is knowable, so a case may
 * declare a separate `noDebug` block. Scoring the no-debug run against the
 * debug-assisted truth would manufacture false-certainty counts that describe
 * the corpus, not the analyser.
 */
export function caseExpectations(testCase, { withDebug = true } = {}) {
  if (withDebug || !testCase.noDebug) {
    return {
      truth: testCase.truth ?? {},
      expectCertain: testCase.expectCertain ?? [],
      expectContradiction: testCase.expectContradiction ?? [],
      expectAmbiguous: testCase.expectAmbiguous ?? [],
    };
  }
  return {
    truth: testCase.noDebug.truth ?? {},
    expectCertain: testCase.noDebug.expectCertain ?? [],
    expectContradiction: testCase.noDebug.expectContradiction ?? [],
    expectAmbiguous: testCase.noDebug.expectAmbiguous ?? [],
  };
}
