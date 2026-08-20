import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const ledger = JSON.parse(fs.readFileSync(path.join(ROOT, 'reports/phase8/checkpoints.json'), 'utf8'));

const EXPECTED_PRODUCT_SHA = 'e88c45791ed7f294d0df865ae7001cc45212d0bb';
const EXPECTED_PRODUCT_TREE = '8588dbae75e6b41a2a2a0eae5f83bfaab8a166b7';
const EXPECTED_CORPUS_DIGEST = '94094f7e9487f640e871e46b19c86c69';

const REQUIRED_GATES = [
  'npm run phase8:test',
  'npm run migration:test',
  'npm run semantic:test',
  'npm run decompiler:test',
  'npm run compiler-truth',
  'Generated userscript sync',
  'Generated userscript autofix',
  'Phase 8 ownership',
  'Migration guardrails',
  'Sandbox security',
  'Ghidra decompiler differential',
  'Phase 6 release validation',
  'Universal binary platform',
  'ChatGPT userscript host',
  'Phase 7 release validation',
  'Cross-binary accuracy',
  'UI regression',
  'Invariant Gates',
];

test('P8-I cutover evidence remains durably persisted', () => {
  const entry = ledger.checkpoints.find((checkpoint) => checkpoint.id === 'P8-I');
  assert.ok(entry, 'P8-I acceptance must be present in the durable checkpoint ledger');
  assert.equal(entry.result, 'accepted');
  assert.equal(entry.blockingReason, null);
  assert.equal(entry.integrationSha, EXPECTED_PRODUCT_SHA);
  assert.equal(entry.integrationTreeSha, EXPECTED_PRODUCT_TREE);
  assert.equal(entry.corpusDigest, EXPECTED_CORPUS_DIGEST);
  assert.equal(entry.generatedOutputDiff, 'zero');

  assert.deepEqual(
    entry.toolchain.targets.map((target) => target.architectureId).sort(),
    ['arm64', 'riscv64', 'x86_64'],
    'P8-I must retain evidence for every mandatory architecture lane',
  );

  const recordedGates = new Set(entry.gates);
  for (const gate of REQUIRED_GATES) {
    assert.ok(recordedGates.has(gate), `P8-I is missing exact-head gate evidence: ${gate}`);
  }

  assert.equal(
    fs.existsSync(path.join(ROOT, 'tools/validation/phase8/p8i-cutover-request.json')),
    false,
    'the one-shot P8-I cutover request must be removed after accepted evidence is persisted',
  );
});
