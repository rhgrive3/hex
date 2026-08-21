import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "tools/validation/phase10/ownership.json"), "utf8"));

assert.ok(
  manifest.allowedExact.includes("tests/core-identity-contracts.mjs"),
  "Phase 10 release validation must allow the shared core identity regression exactly",
);
assert.ok(
  !manifest.allowedPrefixes.includes("tests/"),
  "Phase 10 ownership must not be broadened to every repository test",
);
assert.ok(
  !manifest.allowedPrefixes.includes("js/"),
  "Phase 10 ownership must remain narrowly scoped rather than accepting all source changes",
);
