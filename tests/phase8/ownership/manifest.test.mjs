import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { loadManifest, validateFiles, validateManifest, runCli } from '../../../tools/validation/phase8-ownership.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

function capture() {
  const chunks = [];
  return { write: (text) => chunks.push(text), text: () => chunks.join('') };
}

test('the shipped manifest validates', () => {
  assert.deepEqual(validateManifest(loadManifest()), []);
});

test('a contradictory manifest is rejected rather than trusted', () => {
  const base = loadManifest();
  // Phase 4 shipped a manifest that both owned and forbade the same path, and a
  // manifest that declared generated output its only lane could not write
  // (EP-004, EP-008). Both shapes must fail validation.
  assert.ok(validateManifest({ ...base, lanes: { p8: [...base.lanes.p8, 'js/semantics/**'] } })
    .some((error) => error.includes('forbidden')), 'owning a forbidden path must be rejected');
  assert.ok(validateManifest({ ...base, generatedPaths: ['reports/nowhere/**'] })
    .some((error) => error.includes('does not own')), 'generated output the lane cannot write must be rejected');
  assert.ok(validateManifest({ ...base, lanes: { p8: base.lanes.p8, p9: ['x'] } })
    .some((error) => error.includes('lanes must be exactly')), 'an unexpected lane must be rejected');
  assert.ok(validateManifest({ ...base, generatedWriteOwners: ['p9'] })
    .some((error) => error.includes('unknown lane')), 'an unknown generated owner must be rejected');
});

test('owned Phase 8 paths pass and out-of-lane paths do not', () => {
  const manifest = loadManifest();
  assert.equal(validateFiles(manifest, [
    'js/decompiler/phase8/index.js',
    'tests/phase8/run.mjs',
    'tools/validation/phase8/verify.mjs',
    'package.json',
  ]).valid, true);

  for (const [file, category] of [
    ['js/semantics/ssa/build.js', 'forbidden'],
    ['js/analysis/alias/solver.js', 'forbidden'],
    ['js/targets/abi/index.js', 'forbidden'],
    ['docs/HEX_MASTER_ARCHITECTURE.md', 'forbidden'],
    ['tests/phase7/run.mjs', 'forbidden'],
    ['js/ui/product.js', 'outside-lane'],
  ]) {
    const validation = validateFiles(manifest, [file]);
    assert.equal(validation.valid, false, `${file} must not be accepted`);
    assert.ok(validation.violations.some((violation) => violation.category === category),
      `${file} must be rejected as ${category}`);
  }
});

test('path traversal and absolute paths are rejected', () => {
  const manifest = loadManifest();
  for (const file of ['../outside.js', '/etc/passwd', 'js/decompiler/../semantics/ssa/build.js']) {
    assert.equal(validateFiles(manifest, [file]).valid, false, `${file} must be rejected`);
  }
});

test('the CLI reports manifest validity and rejects mixed inventory sources', () => {
  const out = capture();
  const err = capture();
  assert.equal(runCli(['--check-manifest'], { root: ROOT, stdout: out, stderr: err }), 0);
  assert.match(out.text(), /"phase":8/);

  const err2 = capture();
  assert.equal(runCli(['--files-json', '["package.json"]', '--base-sha', 'a'], { root: ROOT, stdout: capture(), stderr: err2 }), 2);
  assert.match(err2.text(), /exactly one inventory source/);
});

test('the ownership workflow watches every path the manifest declares owned', () => {
  const workflow = fs.readFileSync(path.join(ROOT, '.github/workflows/phase8-ownership.yml'), 'utf8');
  // A trigger that does not cover an owned path is a gate that silently stops
  // running for exactly the change it was written for (EP-007).
  for (const owned of loadManifest().lanes.p8) {
    if (owned === 'package.json' || owned.startsWith('userscript/')) continue;
    assert.ok(workflow.includes(owned), `ownership workflow does not watch owned path: ${owned}`);
  }
});
