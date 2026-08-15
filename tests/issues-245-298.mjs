import assert from 'node:assert/strict';
import fs from 'node:fs';
import { demangleSwiftSymbol } from '../js/swift.js';
import { demangleCxx } from '../js/rtti.js';
import { validateSchema } from '../js/ai/validation.js';
import { fitCalibration } from '../js/calib.js';

// #248: unsupported Itanium grammar/substitutions must fail closed.
assert.equal(demangleCxx('__ZN3Foo3barEiX'), null);
assert.equal(demangleCxx('__ZN3Foo3barESZZ_'), null);
assert.equal(demangleCxx('__ZN3Foo3barEi'), 'Foo::bar(int)');

// #249: a partial Swift parse is evidence, never an exact identity.
{
  const valid = demangleSwiftSymbol('$s3Foo3BarF');
  assert.equal(valid.parsed, true);
  assert.equal(valid.demangled, 'Foo.Bar');

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
  add(0.15, 4);   // 0.20
  add(0.45, 17);  // 0.85
  add(0.75, 10);  // 0.50 -- deliberate inversion
  add(0.95, 19);  // 0.95
  const curve = fitCalibration(samples, 5);
  assert.ok(curve && curve.length >= 2);
  for (let i = 1; i < curve.length; i++) {
    assert.ok(curve[i - 1].score <= curve[i].score);
    assert.ok(curve[i - 1].observed <= curve[i].observed,
      `non-monotone calibration: ${curve[i - 1].observed} > ${curve[i].observed}`);
  }
}

// #274/#298: wrappers must preserve their audited semantic boundaries.
{
  const pinpoint = fs.readFileSync(new URL('../js/pinpoint.js', import.meta.url), 'utf8');
  assert.match(pinpoint, /priorStableAcrossVerification:\s*true/);
  assert.match(pinpoint, /fuse\(c\.evidence\s*\|\|\s*\[\],\s*\{ candidates: priorCandidates \}\)/);

  const report = fs.readFileSync(new URL('../js/report.js', import.meta.url), 'utf8');
  assert.match(report, /fieldCertaintyBoundary\s*=\s*true/);
  assert.match(report, /candidate\.certain\s*===\s*true/);
  assert.match(report, /f\.detail\.field\s*=\s*null/);
}

// #287/#288/#289: worker hardening must parse as classic-worker JavaScript and
// retain the three fail-closed guards. Functional browser coverage exercises the
// actual message protocol; these assertions prevent accidental shim removal.
{
  const worker = fs.readFileSync(new URL('../js/worker-fixes.js', import.meta.url), 'utf8');
  assert.doesNotThrow(() => new Function(worker));
  assert.match(worker, /new TextEncoder\(\)/);
  assert.match(worker, /__controlBoundary/);
  assert.match(worker, /dataPointerRequiresConfirmation:\s*true/);
  assert.match(worker, /ev\.structured\.has\(a\)/);
}

console.log('issues 245-298 regression tests passed');
