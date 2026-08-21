import fs from "node:fs";
import path from "node:path";
import { moduleBoundaryPolicy, MODULE_BOUNDARY_POLICY_VERSION } from "./module-boundaries-policy.mjs";

const IMPORT_SPEC_RE = /(?:import\s+(?:(?:[\w*\s{},]+from\s+)?[\x27"]([^\x27"]+)[\x27"])|export\s+[\w*\s{},]+from\s+[\x27"]([^\x27"]+)[\x27"]|import\(\s*[\x27"]([^\x27"]+)[\x27"]\s*\))/g;

export function extractLiteralImports(sourceText) {
  const specs = [];
  let match;
  while ((match = IMPORT_SPEC_RE.exec(sourceText)) !== null) {
    const spec = match[1] || match[2] || match[3];
    if (spec) specs.push(spec);
  }
  return specs;
}

export function scanModuleBoundaries(options = {}) {
  const root = options.root || "js";
  const policy = options.policy || moduleBoundaryPolicy;
  const violations = [];

  function walk(dir) {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === ".git") continue;
        walk(full);
      } else if (entry.isFile() && (entry.name.endsWith(".js") || entry.name.endsWith(".mjs"))) {
        const normPath = full.replace(/\\/g, "/");
        const importerGroup = policy.classify(normPath);
        if (!importerGroup) continue;

        const text = fs.readFileSync(full, "utf8");
        const specs = extractLiteralImports(text);
        for (const spec of specs) {
          if (!spec.startsWith(".")) continue; // Ignore non-relative (bare / URL)
          let target = path.posix.normalize(path.posix.join(path.posix.dirname(normPath), spec));
          if (!target.endsWith(".js") && !target.endsWith(".mjs")) {
            target += ".js";
          }
          const targetGroup = policy.classify(target);
          if (!targetGroup) continue;

          const rule = policy.isForbidden(importerGroup, targetGroup);
          if (rule) {
            violations.push({
              importer: normPath,
              target,
              importerGroup,
              targetGroup,
              rule,
            });
          }
        }
      }
    }
  }

  walk(root);
  return violations.sort((a, b) => a.importer.localeCompare(b.importer) || a.target.localeCompare(b.target) || a.rule.localeCompare(b.rule));
}

export function validateModuleBoundaries(options = {}) {
  const baselinePath = options.baselinePath || "tools/validation/module-boundaries-baseline.json";
  const policy = options.policy || moduleBoundaryPolicy;
  const violations = scanModuleBoundaries({ root: options.root, policy });

  if (options.noBaseline) {
    return { ok: violations.length === 0, violations, stale: [] };
  }

  const baseline = JSON.parse(fs.readFileSync(baselinePath, "utf8"));
  if (baseline.policyVersion !== policy.policyVersion) {
    throw new Error(`module-boundary-policy-version-mismatch: expected ${policy.policyVersion}, got ${baseline.policyVersion}`);
  }

  const baseViolations = baseline.violations || [];
  const unbaselined = [];
  for (const v of violations) {
    const found = baseViolations.some(
      (b) => b.importer === v.importer && b.target === v.target && b.rule === v.rule
    );
    if (!found) unbaselined.push(v);
  }

  const stale = [];
  for (const b of baseViolations) {
    const found = violations.some(
      (v) => v.importer === b.importer && v.target === b.target && v.rule === b.rule
    );
    if (!found) stale.push(b);
  }

  return {
    ok: unbaselined.length === 0 && stale.length === 0,
    violations: unbaselined,
    stale,
    allViolations: violations,
  };
}

if (process.argv[1] && process.argv[1].endsWith("module-boundaries.mjs")) {
  const isJson = process.argv.includes("--json");
  const noBaseline = process.argv.includes("--no-baseline");
  let root = "js";
  const rootIdx = process.argv.indexOf("--root");
  if (rootIdx !== -1 && process.argv[rootIdx + 1]) {
    root = process.argv[rootIdx + 1];
  }

  try {
    const result = validateModuleBoundaries({ root, noBaseline });
    if (isJson) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      if (result.violations.length) {
        for (const v of result.violations) {
          console.error(`[${v.rule}]`);
          console.error(`  importer: ${v.importer}`);
          console.error(`  target:   ${v.target}`);
        }
      }
      if (result.stale.length) {
        console.error("FAIL: module-boundary-baseline-stale");
        for (const s of result.stale) {
          console.error(`  stale: ${s.importer} -> ${s.target}`);
        }
      }
      if (result.ok) {
        console.log("Module boundaries check: PASS");
      }
    }
    if (!result.ok) {
      process.exit(1);
    }
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}
