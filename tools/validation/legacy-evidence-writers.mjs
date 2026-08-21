import fs from "node:fs";
import path from "node:path";

export function scanEvidenceWriters(rootDir = "js") {
  const findings = [];
  function walk(dir) {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile() && entry.name.endsWith(".js")) {
        const text = fs.readFileSync(full, "utf8");
        const lines = text.split("\n");
        let inBlockComment = false;
        for (let i = 0; i < lines.length; i++) {
          let line = lines[i];
          const trimmed = line.trim();
          if (inBlockComment) {
            if (line.includes("*/")) {
              line = line.slice(line.indexOf("*/") + 2);
              inBlockComment = false;
            } else {
              continue;
            }
          }
          while (line.includes("/*")) {
            const start = line.indexOf("/*");
            const end = line.indexOf("*/", start + 2);
            if (end !== -1) {
              line = line.slice(0, start) + " " + line.slice(end + 2);
            } else {
              line = line.slice(0, start);
              inBlockComment = true;
              break;
            }
          }
          if (line.includes("//")) {
            line = line.slice(0, line.indexOf("//"));
          }
          // Remove double and single quoted strings
          const withoutStrings = line.replace(/(["'])(?:(?=(\\?))\2.)*?\1/g, '""');
          if (/\bnew\s+EvidenceStore\s*\(/.test(withoutStrings)) {
            findings.push({
              file: full.replace(/\\/g, "/"),
              line: i + 1,
              constructor: "EvidenceStore",
              snippet: trimmed,
            });
          }
        }
      }
    }
  }
  walk(rootDir);
  return findings.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
}

export function validateEvidenceWriters(options = {}) {
  const root = options.root || "js";
  const baselinePath = options.baselinePath || "tools/validation/legacy-evidence-writers-baseline.json";
  const findings = scanEvidenceWriters(root);

  if (options.noBaseline) {
    return { ok: findings.length === 0, findings, violations: findings, stale: [] };
  }

  const baseline = JSON.parse(fs.readFileSync(baselinePath, "utf8"));
  const allowed = baseline.allowed || [];

  const violations = [];
  for (const f of findings) {
    const isAllowed = allowed.some((a) => a.file === f.file && a.snippet === f.snippet);
    if (!isAllowed) violations.push(f);
  }

  const stale = [];
  for (const a of allowed) {
    const isFound = findings.some((f) => f.file === a.file && f.snippet === a.snippet);
    if (!isFound) stale.push(a);
  }

  return {
    ok: violations.length === 0 && stale.length === 0,
    findings,
    violations,
    stale,
  };
}

if (process.argv[1] && process.argv[1].endsWith("legacy-evidence-writers.mjs")) {
  const result = validateEvidenceWriters();
  if (result.violations.length) {
    console.error("FAIL: legacy-evidence-writer-added:", result.violations);
    process.exit(1);
  }
  if (result.stale.length) {
    console.error("FAIL: legacy-evidence-writer-baseline-stale:", result.stale);
    process.exit(1);
  }
  console.log("Legacy evidence writers check: PASS");
}
