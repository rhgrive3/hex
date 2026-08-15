import assert from 'node:assert/strict';
import fs from 'node:fs';
import { demangleSwiftSymbol } from '../js/swift.js';
import { demangleCxx } from '../js/rtti.js';
import { validateSchema } from '../js/ai/validation.js';
import { fitCalibration } from '../js/calib.js';

// #245: UI browser dependency is deterministic and npx cannot auto-fetch a
// different package version behind the workflow's back.
{
  const workflow = fs.readFileSync(new URL('../.github/workflows/ui-regression.yml', import.meta.url), 'utf8');
  assert.match(workflow, /playwright@1\.55\.0/);
  assert.match(workflow, /npx --no-install playwright install/);
  assert.doesNotMatch(workflow, /npm install --no-save playwright\s*$/m);
}

// #248: unsupported Itanium grammar/substitutions must fail closed.
assert.equal(demangleCxx('__ZN3Foo3barEiX'), null);
assert.equal(demangleCxx('__ZN3Foo3barESZZ_'), null);
assert.equal(demangleCxx('__ZN3Foo3barEi'), 'Foo::bar(int)');

// #249: a partial Swift parse is evidence, never an exact identity. Known ABI
// tokens such as the empty-tuple type `y` must continue to parse normally.
{
  const valid = demangleSwiftSymbol('$s3Foo3BarF');
  assert.equal(valid.parsed, true);
  assert.equal(valid.demangled, 'Foo.Bar');

  const asyncThrowing = demangleSwiftSymbol('$s4Game6loaderyyYaKF');
  assert.equal(asyncThrowing.parsed, true);
  assert.equal(asyncThrowing.async, true);
  assert.equal(asyncThrowing.throws, true);

  const unknown = '$s3Foo3BarQF';
  const partial = demangleSwiftSymbol(unknown);
  assert.equal(partial.parsed, false);
  assert.equal(partial.unsupported, true);
  assert.equal(partial.demangled, unknown);
  assert.equal(partial.partial, 'Foo.Bar');
}

// #259: JSON/schema numbers must be finite, not merely typeof number.
for (const value of [NaN, Infinity, -Infinity]) {
  assert.equal(validateSchema(value, { type: 'number' }).ok, false);
  assert.equal(validateSchema(value, { type: 'integer' }).ok, false);
}
assert.equal(validateSchema(12.5, { type: 'number' }).ok, true);
assert.equal(validateSchema(12, { type: 'integer' }).ok, true);

// #290: fitted calibration must be monotone even when empirical bins are not.
{
  const samples = [];
  const add = (p, hits, n = 20) => {
    for (let i = 0; i < n; i++) samples.push({ probability: p, correct: i < hits });
  };
  add(0.15, 4);
  add(0.45, 17);
  add(0.75, 10); // deliberate inversion
  add(0.95, 19);
  const curve = fitCalibration(samples, 5);
  assert.ok(curve && curve.length >= 2);
  for (let i = 1; i < curve.length; i++) {
    assert.ok(curve[i - 1].score <= curve[i].score);
    assert.ok(curve[i - 1].observed <= curve[i].observed,
      `non-monotone calibration: ${curve[i - 1].observed} > ${curve[i].observed}`);
  }
}

// #274: the real verification engine, not just its facade, must use one prior
// candidate universe for initial fusion and every verification round.
{
  const core = fs.readFileSync(new URL('../js/pinpoint-legacy.js', import.meta.url), 'utf8');
  const fieldStart = core.indexOf('export async function pinpointField');
  const fieldEnd = core.indexOf('/* ── クラスの前提', fieldStart);
  assert.ok(fieldStart >= 0 && fieldEnd > fieldStart);
  const fieldBody = core.slice(fieldStart, fieldEnd);
  assert.match(fieldBody, /const priorCandidates = narrowed \? asked\.length : universe/);
  assert.equal((fieldBody.match(/candidates: priorCandidates/g) || []).length, 2);
  assert.doesNotMatch(fieldBody, /candidates: narrowed \? asked\.length : universe/);

  const facade = fs.readFileSync(new URL('../js/pinpoint.js', import.meta.url), 'utf8');
  assert.match(facade, /priorStableAcrossVerification:\s*true/);
}

// #271/#292: unknown function ranges cannot be expanded to EOF and string
// expansion is explicitly sampled beyond a fixed head prefix.
{
  const rank = fs.readFileSync(new URL('../js/rank.js', import.meta.url), 'utf8');
  assert.match(rank, /range && range\.start === seed\.addr && range\.end != null/);
  assert.match(rank, /STRING_EXPANSION_BUDGET = 1200/);
  assert.match(rank, /string-matches-sampled/);
  assert.match(rank, /matchedStringsComplete/);
}

// #280/#281: missing object identity may retain recall only behind a strong
// confidence penalty, and capped shape scans remain explicitly incomplete.
{
  const shapes = fs.readFileSync(new URL('../js/shapes.js', import.meta.url), 'utf8');
  assert.match(shapes, /function provenancePenalty\(e\) \{ return e\.identityKnown \? 1 : 0\.25; \}/);
  assert.match(shapes, /loc-object-identity-unknown/);
  assert.match(shapes, /complete: \{ value: !scan\?\.capped/);
}

// #298: uncertain FieldIndex resolutions are inference candidates, never FACT.
{
  const report = fs.readFileSync(new URL('../js/report.js', import.meta.url), 'utf8');
  assert.match(report, /fieldCertaintyBoundary\s*=\s*true/);
  assert.match(report, /candidate\.certain\s*===\s*true/);
  assert.match(report, /f\.detail\.field\s*=\s*null/);
}

// #287/#288/#289: worker hardening parses as classic-worker JavaScript and
// retains UTF-8 search, control-boundary invalidation, and independent function
// evidence. Functional browser coverage exercises the message protocol.
{
  const worker = fs.readFileSync(new URL('../js/worker-fixes.js', import.meta.url), 'utf8');
  assert.doesNotThrow(() => new Function(worker));
  assert.match(worker, /new TextEncoder\(\)/);
  assert.match(worker, /__controlBoundary/);
  assert.match(worker, /dataPointerRequiresConfirmation:\s*true/);
  assert.match(worker, /ev\.structured\.has\(a\)/);
}

console.log('issues 245-298 regression tests passed');
