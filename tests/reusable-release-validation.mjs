import assert from "node:assert/strict";
import fs from "node:fs";

console.log("Testing Reusable Release Validation workflows...");

const reusableText = fs.readFileSync(".github/workflows/_phase-release-validation.yml", "utf8");
const phase10Text = fs.readFileSync(".github/workflows/phase10-release-validation.yml", "utf8");
const phase11Text = fs.readFileSync(".github/workflows/phase11-release-validation.yml", "utf8");

// Reusable workflow assertions
assert.ok(reusableText.includes("workflow_call:"), "1. contains workflow_call");
assert.ok(reusableText.includes("contents: read"), "2. contains contents: read");
assert.ok(!reusableText.includes("write"), "2. no write permission");
assert.ok(reusableText.includes("checkout_ref:"), "3. checkout_ref input");
assert.ok(reusableText.includes("ownership_script:"), "3. ownership_script input");
assert.ok(reusableText.includes("verify_script:"), "3. verify_script input");
assert.ok(reusableText.includes("artifact_prefix:"), "3. artifact_prefix input");
assert.ok(reusableText.includes("artifact_suffix:"), "3. artifact_suffix input");
assert.ok(reusableText.includes("evidence_paths:"), "3. evidence_paths input");
assert.ok(reusableText.includes("actions/checkout@v4"), "4. actions/checkout@v4");
assert.ok(reusableText.includes("fetch-depth: 0"), "5. fetch-depth: 0");
assert.ok(reusableText.includes("git fetch --no-tags origin main:refs/remotes/origin/main"), "6. fetch origin/main");
assert.ok(reusableText.includes("actions/setup-node@v4"), "7. setup-node");
assert.ok(reusableText.includes("22"), "7. node 22");
assert.ok(reusableText.includes("npm ci --no-audit --no-fund"), "8. npm ci");
assert.ok(reusableText.includes("node ${{ inputs.ownership_script }}"), "9. ownership execution");
assert.ok(reusableText.includes("--expect-sha"), "10. --expect-sha");
assert.ok(reusableText.includes("--shadow"), "11. --shadow");
assert.ok(reusableText.includes("${{ inputs.run_broad_regression }}"), "12. run_broad_regression gate");
assert.ok(reusableText.includes("actions/upload-artifact@v4"), "13. upload-artifact");
assert.ok(reusableText.includes("if: success()"), "14. if: success()");
assert.ok(reusableText.includes("${{ inputs.artifact_prefix }}-${{ inputs.artifact_suffix }}"), "15. artifact name");
assert.ok(reusableText.includes("if-no-files-found: error"), "16. if-no-files-found: error");

console.log("  ok 1-16 reusable workflow assertions");

// Phase 10 assertions
const p10ExpectedPaths = [
  ".github/workflows/_phase-release-validation.yml",
  ".github/workflows/phase10-release-validation.yml",
  "js/adapters/**",
  "js/core/evidence/**",
  "js/core/identity/**",
  "js/debug/**",
  "js/runtime/**",
  "js/runtime-evidence/**",
  "package.json",
  "tests/phase10/**",
  "tests/runtime-evidence-fusion.mjs",
  "tests/runtime-platform.mjs",
  "tools/validation/phase10/**",
].sort();

function extractPaths(text, event) {
  const match = text.match(new RegExp(event + ":[\\s\\S]*?paths:\\s*\\n([\\s\\S]*?)(?:\\n\\s*\\w+:|\\Z)"));
  if (!match) return [];
  const lines = match[1].split("\n").map(l => l.trim()).filter(l => l.startsWith("-"));
  return lines.map(l => l.replace(/^-\s*['"]?/, "").replace(/['"]?$/, "")).sort();
}

assert.deepEqual(extractPaths(phase10Text, "push"), p10ExpectedPaths, "Phase 10 push paths match");
assert.deepEqual(extractPaths(phase10Text, "pull_request"), p10ExpectedPaths, "Phase 10 PR paths match");

assert.ok(phase10Text.includes("main"));
assert.ok(phase10Text.includes("phase10/**"));
assert.ok(phase10Text.includes("workflow_dispatch:"));
assert.ok(phase10Text.includes("sha:"));
assert.ok(phase10Text.includes("shadow:"));
assert.ok(phase10Text.includes("group: phase10-release-"));
assert.ok(phase10Text.includes("tools/validation/phase10/ownership-check.mjs"));
assert.ok(phase10Text.includes("tools/validation/phase10/verify.mjs"));
assert.ok(phase10Text.includes("phase10-release-evidence"));
assert.ok(phase10Text.includes("reports/phase10/phase10-release-evidence.json"));
assert.ok(phase10Text.includes("reports/phase10/checkpoints.json"));

// Check SHA selection expression identical for checkout_ref and artifact_suffix
const p10CheckoutMatch = phase10Text.match(/checkout_ref:\s*(.+)/);
const p10SuffixMatch = phase10Text.match(/artifact_suffix:\s*(.+)/);
assert.ok(p10CheckoutMatch && p10SuffixMatch, "Phase 10 has checkout_ref and artifact_suffix");
assert.equal(p10CheckoutMatch[1].trim(), p10SuffixMatch[1].trim(), "Phase 10 checkout_ref and artifact_suffix expressions match");

console.log("  ok Phase 10 caller assertions");

// Phase 11 assertions
const p11PushExpectedPaths = [
  ".github/workflows/_phase-release-validation.yml",
  ".github/workflows/phase11-release-validation.yml",
  "docs/SUPPORT_MATRIX.md",
  "js/managed/**",
  "js/platform/capability-maturity.js",
  "package.json",
  "tests/capability-maturity.mjs",
  "tests/phase11/**",
  "tools/validation/phase11/**",
  "userscript/hex.user.template.js",
  "userscript/release-version.json",
].sort();

const p11PrExpectedPaths = [
  ".github/workflows/_phase-release-validation.yml",
  ".github/workflows/phase11-release-validation.yml",
  "docs/SUPPORT_MATRIX.md",
  "js/managed/**",
  "js/platform/capability-maturity.js",
  "package.json",
  "tests/capability-maturity.mjs",
  "tests/phase11/**",
  "tools/validation/phase11/**",
].sort();

assert.deepEqual(extractPaths(phase11Text, "push"), p11PushExpectedPaths, "Phase 11 push paths match");
assert.deepEqual(extractPaths(phase11Text, "pull_request"), p11PrExpectedPaths, "Phase 11 PR paths match");

assert.ok(phase11Text.includes("main"));
assert.ok(phase11Text.includes("phase11/**"));
assert.ok(phase11Text.includes("workflow_dispatch:"));
assert.ok(phase11Text.includes("sha:"));
assert.ok(phase11Text.includes("shadow:"));
assert.ok(phase11Text.includes("group: phase11-release-"));
assert.ok(phase11Text.includes("tools/validation/phase11/ownership-check.mjs"));
assert.ok(phase11Text.includes("tools/validation/phase11/verify.mjs"));
assert.ok(phase11Text.includes("phase11-release-evidence"));
assert.ok(phase11Text.includes("reports/phase11/phase11-release-evidence.json"));
assert.ok(phase11Text.includes("reports/phase11/checkpoints.json"));

const p11CheckoutMatch = phase11Text.match(/checkout_ref:\s*(.+)/);
const p11SuffixMatch = phase11Text.match(/artifact_suffix:\s*(.+)/);
assert.ok(p11CheckoutMatch && p11SuffixMatch, "Phase 11 has checkout_ref and artifact_suffix");
assert.equal(p11CheckoutMatch[1].trim(), p11SuffixMatch[1].trim(), "Phase 11 checkout_ref and artifact_suffix expressions match");

console.log("  ok Phase 11 caller assertions");

// No duplicated mechanics in caller files
for (const caller of [phase10Text, phase11Text]) {
  assert.ok(!caller.includes("actions/setup-node@v4"));
  assert.ok(!caller.includes("npm ci --no-audit --no-fund"));
  assert.ok(!caller.includes("git fetch --no-tags origin main"));
  assert.ok(!caller.includes("args=()"));
  assert.ok(!caller.includes("actions/upload-artifact@v4"));
}

console.log("  ok No duplicated mechanics in callers");
console.log("All reusable release validation tests PASS!");
