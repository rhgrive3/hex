import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { scanModuleBoundaries, validateModuleBoundaries, extractLiteralImports } from "../tools/validation/module-boundaries.mjs";
import { moduleBoundaryPolicy } from "../tools/validation/module-boundaries-policy.mjs";

console.log("Testing Module Boundaries validator...");

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "hex-mod-boundaries-test-"));

try {
  // Setup virtual js tree
  const jsDir = path.join(tempDir, "js");
  const semDir = path.join(jsDir, "semantics");
  const compatDir = path.join(semDir, "compat");
  fs.mkdirSync(compatDir, { recursive: true });

  fs.writeFileSync(path.join(jsDir, "ir.js"), "export const ir = 1;");
  fs.writeFileSync(path.join(jsDir, "cfg.js"), "export const cfg = 1;");
  fs.writeFileSync(path.join(semDir, "canonical.js"), "export const can = 1;");
  fs.writeFileSync(path.join(compatDir, "adapter.js"), "import { can } from '../canonical.js';");

  const customPolicy = {
    policyVersion: "hex-module-boundaries-v1",
    classify(filePath) {
      const norm = filePath.replace(/\\/g, "/");
      if (norm.includes("/js/semantics/compat/")) return "semantic-compat";
      if (norm.includes("/js/semantics/")) return "canonical-semantics";
      if (norm.endsWith("/js/ir.js") || norm.endsWith("/js/cfg.js")) return "legacy-semantic-facade";
      return null;
    },
    isForbidden(imp, tgt) {
      return moduleBoundaryPolicy.isForbidden(imp, tgt);
    },
  };

  // 1. compat -> canonical passes
  const v1 = scanModuleBoundaries({ root: compatDir, policy: customPolicy });
  assert.equal(v1.length, 0, "compat -> canonical must pass");

  // 2. canonical -> compat fails
  fs.writeFileSync(path.join(semDir, "bad-compat.js"), "import { x } from './compat/adapter.js';");
  const v2 = scanModuleBoundaries({ root: semDir, policy: customPolicy });
  assert.ok(v2.some((v) => v.rule === "canonical-semantics->semantic-compat"), "canonical -> compat must fail");

  // 3. canonical -> legacy fails
  fs.writeFileSync(path.join(semDir, "bad-legacy.js"), "import { ir } from '../ir.js';");
  const v3 = scanModuleBoundaries({ root: semDir, policy: customPolicy });
  assert.ok(v3.some((v) => v.rule === "canonical-semantics->legacy-semantic-facade"), "canonical -> legacy must fail");

  // 4. literal dynamic import("../legacy...") is checked
  fs.writeFileSync(path.join(semDir, "bad-dynamic.js"), "const mod = await import('../cfg.js');");
  const v4 = scanModuleBoundaries({ root: semDir, policy: customPolicy });
  assert.ok(v4.some((v) => v.importer.endsWith("bad-dynamic.js") && v.rule === "canonical-semantics->legacy-semantic-facade"), "dynamic import to legacy must fail");

  // 5. bare package import is ignored
  const bareImports = extractLiteralImports("import React from 'react';\nimport assert from 'node:assert';");
  for (const b of bareImports) assert.ok(!b.startsWith("."));

  // 6. URL import is ignored
  const urlImports = extractLiteralImports("import { x } from 'https://example.com/mod.js';");
  for (const u of urlImports) assert.ok(!u.startsWith("."));

  // 7. normalized ../ path still resolves correctly
  fs.writeFileSync(path.join(semDir, "norm-test.js"), "import { ir } from './../ir.js';");
  const v7 = scanModuleBoundaries({ root: semDir, policy: customPolicy });
  assert.ok(v7.some((v) => v.importer.endsWith("norm-test.js") && v.target.endsWith("/js/ir.js")));

  // 8. violation ordering is deterministic
  assert.deepEqual(
    [...v4].sort((a, b) => a.importer.localeCompare(b.importer) || a.target.localeCompare(b.target) || a.rule.localeCompare(b.rule)),
    v4
  );

  // Baseline integration tests
  const baseFile = path.join(tempDir, "baseline.json");
  fs.writeFileSync(baseFile, JSON.stringify({
    policyVersion: "hex-module-boundaries-v1",
    baselineCommit: "test",
    violations: [
      {
        importer: path.join(semDir, "bad-legacy.js").replace(/\\/g, "/"),
        target: path.join(jsDir, "ir.js").replace(/\\/g, "/"),
        importerGroup: "canonical-semantics",
        targetGroup: "legacy-semantic-facade",
        rule: "canonical-semantics->legacy-semantic-facade",
      }
    ],
  }));

  // Clean other bad files
  fs.unlinkSync(path.join(semDir, "bad-compat.js"));
  fs.unlinkSync(path.join(semDir, "bad-dynamic.js"));
  fs.unlinkSync(path.join(semDir, "norm-test.js"));

  // 9. a current edge listed in baseline passes
  const res9 = validateModuleBoundaries({ root: semDir, baselinePath: baseFile, policy: customPolicy });
  assert.equal(res9.ok, true);

  // 10. a new current edge not in baseline fails
  fs.writeFileSync(path.join(semDir, "new-bad.js"), "import { cfg } from '../cfg.js';");
  const res10 = validateModuleBoundaries({ root: semDir, baselinePath: baseFile, policy: customPolicy });
  assert.equal(res10.ok, false);
  assert.equal(res10.violations.length, 1);

  // 11. a baseline edge no longer present fails as stale
  fs.unlinkSync(path.join(semDir, "bad-legacy.js"));
  fs.unlinkSync(path.join(semDir, "new-bad.js"));
  const res11 = validateModuleBoundaries({ root: semDir, baselinePath: baseFile, policy: customPolicy });
  assert.equal(res11.ok, false);
  assert.equal(res11.stale.length, 1);

  // 12. policy version mismatch fails
  fs.writeFileSync(baseFile, JSON.stringify({ policyVersion: "bad-version", violations: [] }));
  assert.throws(() => validateModuleBoundaries({ root: semDir, baselinePath: baseFile, policy: customPolicy }), /module-boundary-policy-version-mismatch/);

  console.log("All module boundaries unit tests PASS!");
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}
