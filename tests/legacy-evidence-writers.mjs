import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { scanEvidenceWriters, validateEvidenceWriters } from "../tools/validation/legacy-evidence-writers.mjs";

console.log("Testing Legacy Evidence Writers gate...");

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "hex-writers-test-"));

try {
  const fakeJs = path.join(tempDir, "fake.js");
  fs.writeFileSync(fakeJs, `
    // Comment with new EvidenceStore()
    /* Multi-line comment
       new EvidenceStore()
    */
    const a = new EvidenceStore();
  `);

  const findings = scanEvidenceWriters(tempDir);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].constructor, "EvidenceStore");

  const baselineFile = path.join(tempDir, "baseline.json");
  fs.writeFileSync(baselineFile, JSON.stringify({
    baselineCommit: "test",
    allowed: [{ file: findings[0].file, snippet: findings[0].snippet }],
  }));

  // 1. Baseline construction passes
  const res1 = validateEvidenceWriters({ root: tempDir, baselinePath: baselineFile });
  assert.equal(res1.ok, true);

  // 2. New second construction fails
  fs.writeFileSync(fakeJs, `
    const a = new EvidenceStore();
    const b = new EvidenceStore();
  `);
  const res2 = validateEvidenceWriters({ root: tempDir, baselinePath: baselineFile });
  assert.equal(res2.ok, false);
  assert.equal(res2.violations.length, 1);

  // 3. Stale baseline fails
  fs.writeFileSync(fakeJs, `const a = 1;`);
  const res3 = validateEvidenceWriters({ root: tempDir, baselinePath: baselineFile });
  assert.equal(res3.ok, false);
  assert.equal(res3.stale.length, 1);

  // 4. Comments and strings do not count
  fs.writeFileSync(fakeJs, `
    // new EvidenceStore()
    const str = "new EvidenceStore()";
  `);
  const res4 = scanEvidenceWriters(tempDir);
  assert.equal(res4.length, 0);

  console.log("All legacy evidence writers unit tests PASS!");
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}
