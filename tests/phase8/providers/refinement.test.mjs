/**
 * P8-7 — providers refine, they do not decide.
 *
 * A provider is allowed to name a shape the generic passes already proved. It is
 * not allowed to see an instruction, to promote a fact past the evidence, to
 * settle a contradiction, or to matter when it is switched off. Each of those is
 * a property of the code here rather than a promise, and each has a test that
 * would fail if it stopped being true.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { PASS_STAGES } from '../../../js/decompiler/phase8/contract.js';
import {
  HINT_STATUSES, PROVIDER_HINT_KINDS, PROVIDER_INTERFACE_VERSION, PROVIDER_PASS, REGISTERED_PROVIDERS,
  createProvider, describeProviderHints, judgeHint, providerAuthorityFailures, providerView, runPhase8Stage,
} from '../../../js/decompiler/phase8/index.js';
import { fixture } from '../helpers/ir-fixtures.mjs';

function run(ir, { providers = undefined, opts = undefined, types = null, shouldAbort = undefined } = {}) {
  const { ledger, analysis } = runPhase8Stage(
    { ir, types, providers, opts },
    { stages: PASS_STAGES, timeBudgetMs: 2000, shouldAbort },
  );
  return { ledger, analysis, facts: ledger.published ? analysis.get('providerHints') : null };
}

/** `for (i = 0; i < 10; i += 1) { *p; p += 4 }` — a counted walk over an array. */
function countedWalk(name = 'walk') {
  const f = fixture(name);
  f.block(0);
  const start = f.constant(0, 32);
  const limit = f.constant(10, 32);
  const pointer = f.opaque(64);
  f.branch(1);
  f.block(1, { succ: [2, 3] });
  const counter = f.phi([[0, start], [2, null]], 32);
  const cursor = f.phi([[0, pointer], [2, null]], 64);
  f.conditionalBranch(f.binary('ult', counter, limit, 1), 2, 3);
  f.block(2, { succ: [1] });
  f.load(32, { addrBase: cursor, disp: 0 });
  f.closePhi(counter, 2, f.binary('add', counter, f.constant(1, 32), 32));
  f.closePhi(cursor, 2, f.binary('add', cursor, f.constant(4, 64), 64));
  f.branch(1);
  f.block(3).ret();
  return f.build();
}

test('a proved counted loop is named, and a for-loop is suggested', () => {
  const { facts } = run(countedWalk());
  const names = facts.hints.map((hint) => hint.name).sort();
  assert.ok(names.includes('counted-loop'), `expected a counted-loop hint, saw ${names.join(', ')}`);
  assert.ok(names.includes('for-loop'));
  for (const hint of facts.hints) {
    assert.equal(hint.status, 'accepted');
    assert.ok(hint.evidence.length > 0, `${hint.name} carries no evidence`);
    assert.ok(hint.targets.length > 0);
    assert.equal(hint.interfaceVersion, PROVIDER_INTERFACE_VERSION);
  }
});

test('with providers off the generic facts are unchanged and no hint is published', () => {
  const ir = countedWalk('off');
  const on = run(ir);
  const off = run(ir, { opts: { phase8Providers: false } });
  assert.ok(on.facts.hints.length > 0);
  assert.equal(off.facts.hints.length, 0);
  // The refinement layer must not change what it refines.
  const encode = (value) => JSON.stringify(value, (key, item) => (typeof item === 'bigint' ? `${item}n` : item));
  for (const key of ['induction', 'aggregates', 'structuredRegions', 'ranges']) {
    assert.equal(encode(off.analysis.get(key)), encode(on.analysis.get(key)),
      `${key} moved when providers were switched off`);
  }
});

test('a provider sees facts, never instructions', () => {
  let seen = null;
  const spy = createProvider({
    id: 'test.spy', version: '1.0.0', kinds: ['idiom'],
    refine(view) { seen = view; return []; },
  });
  run(countedWalk('spy'), { providers: [spy] });
  assert.ok(seen, 'the provider was never called');
  // Checked by walking the keys rather than searching the serialised text:
  // `regionKey` contains "reg" and would make a substring scan pass or fail for
  // the wrong reason.
  const forbidden = new Set(['insts', 'text', 'address', 'reg', 'opcode', 'mnemonic', 'def', 'args', 'origin', 'loc', 'addr', 'block']);
  const walk = (node, path) => {
    if (node == null || typeof node !== 'object') return;
    for (const [key, value] of Object.entries(node)) {
      assert.ok(!forbidden.has(key), `the provider view exposes ${path}.${key}`);
      if (Array.isArray(value)) value.forEach((item, index) => walk(item, `${path}.${key}[${index}]`));
      else walk(value, `${path}.${key}`);
    }
  };
  walk(seen, 'view');
  // What it does see: proved facts, and nothing that could be decoded.
  assert.ok(Array.isArray(seen.loops));
  assert.ok(Array.isArray(seen.regions));
  assert.ok(Object.isFrozen(seen));
});

test('a hint cannot reach further than the generic evidence for its region', () => {
  const view = {
    regions: [{ regionKey: 'r', conflicts: [], highestCertainty: 'supported' }],
  };
  assert.deepEqual(judgeHint({ regionKey: 'r', certainty: 'confirmed' }, view),
    { status: 'accepted', certainty: 'supported', reason: 'capped at supported: the generic evidence for this region reaches no further' });
  assert.equal(judgeHint({ regionKey: 'r', certainty: 'candidate' }, view).certainty, 'candidate');
  assert.equal(judgeHint({ regionKey: 'missing', certainty: 'confirmed' }, view).status, 'rejected');
});

test('a hint about a contradicted region is rejected and kept', () => {
  const view = { regions: [{ regionKey: 'r', conflicts: ['nominal-disagreement'], highestCertainty: 'candidate' }] };
  const verdict = judgeHint({ regionKey: 'r', certainty: 'supported', kind: 'nominal-type' }, view);
  assert.equal(verdict.status, 'rejected');
  assert.match(verdict.reason, /does not settle a contradiction/);
});

test('a provider that argues with a real contradiction has its hint published as rejected', () => {
  const f = fixture('contradiction');
  f.block(0);
  const slot = f.load(64, { locKey: 'stack:-8' });
  const other = f.load(64, { locKey: 'stack:-8' });
  f.load(32, { addrBase: slot, disp: 0 });
  f.load(32, { addrBase: other, disp: 4 });
  f.ret();
  const pushy = createProvider({
    id: 'test.pushy', version: '1.0.0', kinds: ['nominal-type'],
    refine(view) {
      return view.regions.map((region) => ({
        kind: 'nominal-type', name: 'Player', regionKey: region.regionKey, certainty: 'confirmed',
        targets: [`region:${region.regionKey}`], evidence: ['the provider recognises this shape'],
      }));
    },
  });
  const types = { values: new Map([[slot.id, { className: 'Player' }], [other.id, { className: 'Enemy' }]]) };
  const { facts, analysis } = run(f.build(), { providers: [pushy], types });
  const rejected = facts.hints.filter((hint) => hint.status === 'rejected');
  assert.ok(rejected.length > 0, 'the hint was allowed to settle a contradiction');
  assert.equal(facts.rejectedCount, rejected.length);
  // A rejected hint stays in the artifact: it is evidence about the provider.
  assert.ok(rejected[0].reason.length > 0);
  assert.deepEqual(providerAuthorityFailures(facts, providerView(analysis)), []);
});

test('the independent authority check catches a hint that was granted too much', () => {
  const view = { regions: [{ regionKey: 'r', conflicts: ['width-disagreement'], highestCertainty: 'candidate' }] };
  const overreaching = {
    hints: [{ providerId: 'p', status: 'accepted', certainty: 'confirmed', regionKey: 'r', name: 'x', evidence: ['e'] }],
  };
  const failures = providerAuthorityFailures(overreaching, view);
  assert.ok(failures.some((entry) => entry.problem === 'accepted-over-hard-conflict'));
  assert.ok(failures.some((entry) => entry.problem === 'certainty-above-generic-evidence'));

  const unevidenced = { hints: [{ providerId: 'p', status: 'accepted', certainty: 'candidate', regionKey: null, name: 'x', evidence: [] }] };
  assert.ok(providerAuthorityFailures(unevidenced, view).some((entry) => entry.problem === 'no-evidence'));
});

test('a hint with no evidence or no target is refused at the interface', () => {
  const sloppy = (raw) => createProvider({ id: 'test.sloppy', version: '1.0.0', kinds: ['idiom'], refine: () => [raw] });
  const noEvidence = run(countedWalk('no-evidence'), { providers: [sloppy({ kind: 'idiom', name: 'x', targets: ['block:1'], evidence: [] })] });
  assert.equal(noEvidence.facts.hints.length, 0);
  assert.match(noEvidence.facts.failures[0].reason, /evidence-required/);

  const noTarget = run(countedWalk('no-target'), { providers: [sloppy({ kind: 'idiom', name: 'x', targets: [], evidence: ['e'] })] });
  assert.match(noTarget.facts.failures[0].reason, /targets-required/);

  const undeclared = run(countedWalk('undeclared'), { providers: [sloppy({ kind: 'render', name: 'x', targets: ['block:1'], evidence: ['e'] })] });
  assert.match(undeclared.facts.failures[0].reason, /undeclared-hint-kind/);
});

test('a provider that throws is switched off, and takes nothing down with it', () => {
  const broken = createProvider({
    id: 'test.broken', version: '1.0.0', kinds: ['idiom'],
    refine() { throw new Error('provider exploded'); },
  });
  const { ledger, facts, analysis } = run(countedWalk('broken'), { providers: [broken] });
  assert.equal(ledger.published, true, 'a broken provider must not withhold the generic result');
  assert.equal(facts.hints.length, 0);
  assert.match(facts.failures[0].reason, /provider exploded/);
  assert.equal(facts.completeness, 'partial', 'a provider that failed makes the refinement partial, not complete');
  // The generic facts are still there and still whole.
  assert.ok(analysis.get('induction').loops.length > 0);
});

test('createProvider refuses a provider that cannot be identified or audited', () => {
  assert.throws(() => createProvider({ version: '1', kinds: ['idiom'], refine() {} }), /id-required/);
  assert.throws(() => createProvider({ id: 'a', kinds: ['idiom'], refine() {} }), /version-required/);
  assert.throws(() => createProvider({ id: 'a', version: '1', kinds: ['idiom'] }), /refine-required/);
  assert.throws(() => createProvider({ id: 'a', version: '1', kinds: [], refine() {} }), /kinds-required/);
  assert.throws(() => createProvider({ id: 'a', version: '1', kinds: ['decode'], refine() {} }), /unknown-hint-kind/);
});

test('every shipped provider declares itself and only known hint kinds', () => {
  assert.ok(REGISTERED_PROVIDERS.length > 0);
  for (const provider of REGISTERED_PROVIDERS) {
    assert.match(provider.id, /^phase8\.provider\./);
    assert.match(provider.version, /^\d+\.\d+\.\d+$/);
    assert.equal(provider.interfaceVersion, PROVIDER_INTERFACE_VERSION);
    for (const kind of provider.kinds) assert.ok(PROVIDER_HINT_KINDS.includes(kind), kind);
  }
  // Ids are unique and sorted, so the published provider list is stable.
  const ids = REGISTERED_PROVIDERS.map((provider) => provider.id);
  assert.deepEqual(ids, [...new Set(ids)].sort());
});

test('the shipped providers import no target, architecture or ABI module', async () => {
  const source = await import('node:fs').then((fs) => fs.readFileSync(new URL('../../../js/decompiler/phase8/providers.js', import.meta.url), 'utf8'));
  const imports = [...source.matchAll(/^import[^;]+from\s+'([^']+)'/gm)].map((match) => match[1]);
  for (const specifier of imports) {
    assert.ok(!/targets|architecture|abi|arm64|x86|riscv/i.test(specifier),
      `a provider module must not import ${specifier}`);
  }
  // And the generic passes must not import the provider module either: the
  // dependency runs one way.
  for (const name of ['sccp.js', 'valuenumber.js', 'dce.js', 'induction.js', 'structuring.js', 'aggregates.js']) {
    const generic = await import('node:fs').then((fs) => fs.readFileSync(new URL(`../../../js/decompiler/phase8/${name}`, import.meta.url), 'utf8'));
    assert.ok(!generic.includes("from './providers.js'"), `${name} imports the provider layer`);
  }
});

test('a provider version change is visible in the published hints', () => {
  const one = createProvider({
    id: 'test.versioned', version: '1.0.0', kinds: ['idiom'],
    refine: () => [{ kind: 'idiom', name: 'x', targets: ['block:1'], evidence: ['e'] }],
  });
  const two = createProvider({ ...one, version: '2.0.0', refine: one.refine });
  const first = run(countedWalk('v1'), { providers: [one] }).facts;
  const second = run(countedWalk('v2'), { providers: [two] }).facts;
  assert.equal(first.hints[0].providerVersion, '1.0.0');
  assert.equal(second.hints[0].providerVersion, '2.0.0');
  assert.notEqual(JSON.stringify(first.providers), JSON.stringify(second.providers));
});

test('the pass transforms nothing and publishes exactly one analysis', () => {
  const { ledger } = run(countedWalk('no-transform'));
  const result = ledger.passes.find((entry) => entry.passId === 'phase8.providers');
  assert.equal(result.transforms.length, 0);
  assert.deepEqual([...result.produced], ['providerHints']);
  assert.deepEqual([...result.invalidated], []);
  assert.equal(PROVIDER_PASS.stage, 'providers');
  for (const key of ['induction', 'aggregates', 'structuredRegions']) {
    assert.ok(PROVIDER_PASS.consumes.includes(key), `providers must read ${key} rather than derive it`);
  }
});

test('the hints are identical across runs', () => {
  const ir = countedWalk('deterministic');
  const encode = (value) => JSON.stringify(value, (key, item) => (typeof item === 'bigint' ? `${item}n` : item));
  assert.equal(encode(run(ir).facts), encode(run(ir).facts));
});

test('cancellation withholds the whole ledger rather than publishing some providers', () => {
  let calls = 0;
  const { ledger, facts } = run(countedWalk('cancelled'), { shouldAbort: () => { calls += 1; return calls > 2; } });
  assert.equal(ledger.published, false);
  assert.equal(facts, null);
});

test('every hint status is one the contract declares', () => {
  const { facts } = run(countedWalk('vocabulary'));
  for (const hint of facts.hints) {
    assert.ok(HINT_STATUSES.includes(hint.status), hint.status);
    assert.ok(PROVIDER_HINT_KINDS.includes(hint.kind), hint.kind);
  }
});

test('describeProviderHints says what was said and what happened to it', () => {
  const { facts } = run(countedWalk('describe'));
  assert.match(describeProviderHints(facts), /for-loop:accepted/);
  assert.equal(describeProviderHints(null), 'no provider hints');
});
