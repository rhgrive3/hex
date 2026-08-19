import assert from 'node:assert/strict';
import test from 'node:test';

import { runPassTransaction, seedAnalysisState } from '../../../js/decompiler/phase8/transaction.js';
import { DCE_PASS, observableEffectReason, runDcePass } from '../../../js/decompiler/phase8/dce.js';
import { loadCorpus } from '../../../tools/validation/phase8/build-corpus.mjs';
import { decompileEntry } from '../../../tools/validation/phase8/decompile-corpus.mjs';
import { fixture } from '../helpers/ir-fixtures.mjs';

/**
 * "The result is unused" and "running the operation is unobservable" are two
 * different facts. Every negative case here has a dead result and must survive
 * anyway, because a pass that deletes on the first fact alone deletes stores,
 * calls, volatile reads and faulting operations.
 */

function analyze(ir) {
  const state = seedAnalysisState(ir);
  const outcome = runPassTransaction(state, { descriptor: DCE_PASS, run: runDcePass }, { analysis: state, ir }, {});
  return { outcome, facts: state.get('deadCode') };
}

const isCandidate = (facts, value) => facts.candidates.some((entry) => entry.valueId === value.id);

test('a pure operation with no uses is a candidate, and the proof names both halves', () => {
  const f = fixture('dead-pure');
  f.block(0);
  const dead = f.binary('add', f.opaque(32), f.opaque(32), 32);
  f.ret();
  const { facts } = analyze(f.build());
  assert.equal(isCandidate(facts, dead), true);
  const candidate = facts.candidates.find((entry) => entry.valueId === dead.id);
  assert.match(candidate.proof, /no remaining use/);
  assert.match(candidate.proof, /unobservable/);
});

test('an operation whose result is used is not a candidate', () => {
  const f = fixture('live');
  f.block(0);
  const used = f.binary('add', f.opaque(32), f.opaque(32), 32);
  f.store(used);
  f.ret();
  const { facts } = analyze(f.build());
  assert.equal(isCandidate(facts, used), false);
});

test('a store is never a candidate, however dead its result looks', () => {
  const f = fixture('store');
  f.block(0);
  const value = f.binary('add', f.opaque(32), f.opaque(32), 32);
  f.store(value);
  f.ret();
  const { facts } = analyze(f.build());
  assert.equal(facts.candidates.length, 0, 'nothing here may be removed');
});

test('a call with an ignored return value is kept', () => {
  const f = fixture('call');
  f.block(0);
  const ignored = f.call(32);
  f.ret();
  const { facts } = analyze(f.build());
  assert.equal(isCandidate(facts, ignored), false);
  assert.match(facts.keptReasons.get(ignored.id), /call is observable/);
  assert.equal(facts.deadButObservable.some((entry) => entry.valueId === ignored.id), true,
    'a dead-but-kept operation must be visible as one');
});

test('an unused volatile load is kept', () => {
  const f = fixture('volatile');
  f.block(0);
  const value = f.load(32, { volatility: true, atomic: false });
  f.ret();
  const { facts } = analyze(f.build());
  assert.equal(isCandidate(facts, value), false);
  assert.match(facts.keptReasons.get(value.id), /known to be volatile/);
});

test('unknown atomicity is not permission', () => {
  // Atomicity is machine-recoverable: the instruction encoding says whether an
  // access is exclusive. `unknown` therefore means an upstream fact is missing,
  // and treating a missing fact as "probably fine" is how an exclusive load gets
  // deleted.
  const f = fixture('unknown-atomicity');
  f.block(0);
  const value = f.load(32, {});
  f.ret();
  const { facts } = analyze(f.build());
  assert.equal(isCandidate(facts, value), false);
  assert.match(facts.keptReasons.get(value.id), /atomicity is unknown/);
});

test('a device access is kept even with every other fact proved', () => {
  const f = fixture('device');
  f.block(0);
  const value = f.load(32, { addressSpace: 'io', atomic: false, ordering: 'unknown' });
  f.ret();
  const { facts } = analyze(f.build());
  assert.equal(isCandidate(facts, value), false);
  assert.match(facts.keptReasons.get(value.id), /not ordinary memory/);
});

test('a load that can fault is kept even when fully proved otherwise', () => {
  const f = fixture('faulting');
  f.block(0);
  const value = f.load(32, { atomic: false, ordering: 'unknown', faults: [{ kind: 'page-fault' }] });
  f.ret();
  const { facts } = analyze(f.build());
  assert.equal(isCandidate(facts, value), false);
  assert.match(facts.keptReasons.get(value.id), /can fault/);
});

test('an ordered access is kept', () => {
  const f = fixture('ordered');
  f.block(0);
  const value = f.load(32, { atomic: false, ordering: 'acquire' });
  f.ret();
  const { facts } = analyze(f.build());
  assert.equal(isCandidate(facts, value), false);
  assert.match(facts.keptReasons.get(value.id), /imposes ordering/);
});

test('a division with no proved fault set is kept', () => {
  const f = fixture('divide');
  f.block(0);
  const trapping = f.divide(f.opaque(32), f.opaque(32), 32);
  f.ret();
  const { facts } = analyze(f.build());
  assert.equal(isCandidate(facts, trapping), false);
  assert.match(facts.keptReasons.get(trapping.id), /trap on a zero divisor/);

  const g = fixture('divide-proved');
  g.block(0);
  const proved = g.divide(g.opaque(32), g.opaque(32), 32, { faults: [] });
  g.ret();
  assert.equal(isCandidate(analyze(g.build()).facts, proved), true, 'a proved-non-trapping division may be removed');
});

test('an operation writing untracked state is kept', () => {
  const f = fixture('state');
  f.block(0);
  const written = f.stateWrite(64);
  f.ret();
  const { facts } = analyze(f.build());
  assert.equal(isCandidate(facts, written), false);
  assert.match(facts.keptReasons.get(written.id), /architectural state/);
});

test('removal is transitive: an operand that only fed a dead operation is also dead', () => {
  const f = fixture('transitive');
  f.block(0);
  const inner = f.binary('add', f.opaque(32), f.opaque(32), 32);
  const outer = f.binary('mul', inner, f.opaque(32), 32);
  f.ret();
  const { facts } = analyze(f.build());
  assert.equal(isCandidate(facts, outer), true);
  assert.equal(isCandidate(facts, inner), true, 'the operand became dead once its only consumer did');
  assert.ok(facts.rounds >= 2, 'a transitive result requires more than one round');
});

test('a chain feeding an observable operation survives entirely', () => {
  const f = fixture('transitive-live');
  f.block(0);
  const inner = f.binary('add', f.opaque(32), f.opaque(32), 32);
  const outer = f.binary('mul', inner, f.opaque(32), 32);
  f.store(outer);
  f.ret();
  const { facts } = analyze(f.build());
  assert.equal(facts.candidates.length, 0);
});

test('the effect predicate answers with a reason, never a bare boolean', () => {
  assert.equal(observableEffectReason({ op: 'bin', sub: 'add' }), null);
  assert.match(observableEffectReason({ op: 'store' }), /observable/);
  assert.match(observableEffectReason({ op: 'cmp', sub: 'sub' }), /not a modelled pure operation/);
  assert.match(observableEffectReason({}), /no kind/);
});

test('cancellation publishes no facts at all', () => {
  const f = fixture('cancelled');
  f.block(0);
  f.binary('add', f.opaque(32), f.opaque(32), 32);
  f.ret();
  const state = seedAnalysisState(f.build());
  const outcome = runPassTransaction(state, { descriptor: DCE_PASS, run: runDcePass }, { analysis: state }, { shouldAbort: () => true });
  assert.equal(outcome.committed, false);
  assert.equal(state.version('deadCode'), 0);
});

test('the IR maintains complete use lists, which is what makes this pass sound', () => {
  // DCE decides liveness from `value.uses`. If the IR ever stops maintaining
  // that list completely, the pass does not fail — it silently starts calling
  // live values dead. So the premise is checked directly, against an
  // independently reconstructed use map, over the whole frozen corpus.
  const corpus = loadCorpus();
  let checked = 0;
  const undeclared = [];
  corpus.functions.forEach((entry, index) => {
    const result = decompileEntry(entry, { index }).result;
    if (!result?.semantic) return;
    const observed = new Map();
    const note = (valueId, instruction) => {
      if (valueId == null) return;
      if (!observed.has(valueId)) observed.set(valueId, new Set());
      observed.get(valueId).add(instruction);
    };
    const scan = (instruction) => {
      for (const argument of instruction.args ?? []) note(argument?.value?.id, instruction);
      for (const incoming of instruction.incoming ?? []) note(incoming?.value?.id, instruction);
      if (instruction.conditionValue?.id != null) note(instruction.conditionValue.id, instruction);
      for (const valueId of instruction.returnValueIds ?? []) note(valueId, instruction);
    };
    for (const block of result.ir.blocks ?? []) {
      for (const instruction of block.insts ?? []) scan(instruction);
      for (const phi of block.phis ?? []) scan(phi);
    }
    for (const instruction of result.ir.instructions ?? []) scan(instruction);
    for (const value of result.ir.values) {
      checked += 1;
      const declared = new Set(value.uses ?? []);
      for (const use of observed.get(value.id) ?? []) {
        if (!declared.has(use)) undeclared.push(`${entry.id}:value_${value.id}`);
      }
    }
  });
  assert.ok(checked > 1000, `the premise check must actually cover the corpus (checked ${checked})`);
  assert.deepEqual(undeclared.slice(0, 5), [], 'a use the IR does not declare would make dead-code removal unsound');
});
