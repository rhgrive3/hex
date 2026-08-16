import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const REQUIRED = Object.freeze([
  'INV-002','INV-003','INV-004','INV-005','INV-007','INV-008',
  'INV-010','INV-011','INV-012','INV-014','INV-015',
]);

const gates = Object.freeze([
  { name:'core-contracts', invariants:['INV-004','INV-007','INV-008','INV-010','INV-012','INV-015'], file:'tests/invariant-contracts.mjs' },
  { name:'unknown-semantics', invariants:['INV-002','INV-003'], file:'tests/ir.mjs' },
  { name:'alias-safety', invariants:['INV-003','INV-015'], file:'tests/ir-alias.mjs' },
  { name:'unknown-call-clobber', invariants:['INV-003'], file:'tests/issue-430-memory-escape.mjs' },
  { name:'provenance-regression', invariants:['INV-004'], file:'tests/issue-428-schema-provenance.mjs' },
  { name:'architecture-boundaries', invariants:['INV-005'], file:'tools/validation/import-boundaries.mjs' },
  { name:'runtime-static-separation', invariants:['INV-007'], file:'tests/runtime-evidence-fusion.mjs' },
  { name:'verified-evidence-discipline', invariants:['INV-008'], file:'tests/evidence-verdict.mjs' },
  { name:'capability-grading', invariants:['INV-010'], file:'tests/capstone-capability.mjs' },
  { name:'large-input-source-backed', invariants:['INV-011','INV-012','INV-015'], file:'tests/universal-binary-source.mjs' },
  { name:'analysis-budget-fail-closed', invariants:['INV-010','INV-011','INV-012','INV-015'], file:'tests/ai-analysis-boundary.mjs' },
  { name:'arm64-compiler-truth', invariants:['INV-014'], file:'tests/compiler-truth/run.mjs' },
]);

const covered = new Set(gates.flatMap((gate) => gate.invariants));
for (const invariant of REQUIRED) {
  if (!covered.has(invariant)) throw new Error(`invariant gate coverage missing: ${invariant}`);
}

for (const gate of gates) {
  process.stdout.write(`\n[invariant-gate] ${gate.name} (${gate.invariants.join(', ')})\n`);
  const result = spawnSync(process.execPath, [path.join(root, gate.file)], {
    cwd:root,
    stdio:'inherit',
    env:{ ...process.env, HEX_INVARIANT_GATE:'1' },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    process.stderr.write(`[invariant-gate] FAIL ${gate.name}: ${gate.file}\n`);
    process.exit(result.status || 1);
  }
}

process.stdout.write(`\nInvariant gates PASS: ${REQUIRED.length} invariants covered by ${gates.length} executable gates.\n`);
