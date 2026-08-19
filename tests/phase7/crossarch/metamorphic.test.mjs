import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  FORMAT_READER_MODULES,
  GENERIC_MODULES,
  evaluateGenericLaws,
  scanArchitectureNeutrality,
  scanFormatReaderImports,
} from './laws.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const MANIFEST = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests/phase7/corpus/manifest.json'), 'utf8'));
const LANES = MANIFEST.architectureLanes.mandatory;

test('every mandatory architecture lane produces evidence', () => {
  // A missing lane is blocking, never skip-green (§12.5).
  assert.ok(LANES.length >= 3, 'the manifest must name the mandatory lanes');
  for (const lane of LANES) {
    const result = evaluateGenericLaws(lane);
    assert.equal(result.available, true, `lane produced no evidence: ${lane}`);
  }
});

test('the generic middle-end laws hold identically on every lane', () => {
  const observed = new Map();
  for (const lane of LANES) {
    const result = evaluateGenericLaws(lane);
    for (const law of result.laws) {
      assert.equal(law.holds, true, `${lane}: ${law.name} failed (${law.observed})`);
      // The same law must reach the same conclusion everywhere, or the generic
      // solver has learned something about one architecture (FM-9).
      const key = law.name;
      if (!observed.has(key)) observed.set(key, law.holds);
      assert.equal(observed.get(key), law.holds, `${law.name} differs between lanes`);
    }
  }
});

test('generic Phase 7 modules contain no architecture-specific logic', () => {
  for (const module of GENERIC_MODULES) {
    const scan = scanArchitectureNeutrality(module);
    assert.equal(scan.exists, true, `generic module is missing: ${module}`);
    assert.deepEqual(scan.violations, [], `${module} leaks architecture-specific logic`);
  }
});

test('debug format readers know their format but not the target boundary', () => {
  // A DWARF or PDB reader legitimately knows its own constants. Importing an
  // architecture or ABI module would put target semantics behind the debug
  // boundary, which the architecture keeps separate.
  for (const module of FORMAT_READER_MODULES) {
    assert.deepEqual(scanFormatReaderImports(module).violations, [], `${module} imports the target boundary`);
  }
});

test('the neutrality scan uses the repository canonical analyzer', () => {
  // A private regex scan would drift from the gate the rest of the repository
  // is held to, so this asserts the shared analyzer is what runs.
  const source = fs.readFileSync(path.join(ROOT, 'tests/phase7/crossarch/laws.mjs'), 'utf8');
  assert.match(source, /tools\/validation\/semantic-v2\/architecture-neutrality\.mjs/);
});

test('a deliberately leaky module is rejected by the scan', () => {
  // Self-test: prove the gate detects the failure class rather than merely
  // passing on today's code.
  const temporary = path.join(ROOT, 'js/analysis/.neutrality-mutant.js');
  fs.writeFileSync(temporary, "export function f(id) { if (id === 'arm64') return 1; return 0; }\n");
  try {
    const scan = scanArchitectureNeutrality('js/analysis/.neutrality-mutant.js');
    assert.ok(scan.violations.length > 0, 'the neutrality scan failed to detect an architecture branch');
  } finally {
    fs.rmSync(temporary, { force: true });
  }
});
