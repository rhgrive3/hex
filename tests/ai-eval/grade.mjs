import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readJson, readJsonl, gradeRecord, summarize } from './lib.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const input = process.argv[2];
const requireAll = process.argv.includes('--require-all');
if (!input) {
  console.error('usage: node tests/ai-eval/grade.mjs <results.jsonl> [report.json] [--require-all]');
  process.exit(2);
}

const defsDoc = readJson(path.join(HERE, 'cases.json'));
const defs = new Map(defsDoc.cases.map((c) => [c.id, c]));
const records = readJsonl(path.resolve(input));
const grades = [];
const unknown = [];
for (const record of records) {
  const def = defs.get(record.caseId);
  if (!def) { unknown.push(record.caseId || '<missing>'); continue; }
  grades.push(gradeRecord(record, def));
}

const expectedDefs = requireAll ? defsDoc.cases : defsDoc.cases.filter((d) => records.some((r) => r.caseId === d.id));
const missing = expectedDefs.filter((d) => !grades.some((g) => g.caseId === d.id)).map((d) => d.id);
const gate = defsDoc.releaseGate || {};
const summary = summarize(grades, gate);
const report = { version: 1, generatedAt: new Date().toISOString(), summary, unknown, missing, grades };

for (const g of grades) {
  console.log(`${g.passed ? 'PASS' : 'FAIL'} ${g.caseId} score=${g.score} tools=${g.toolCalls}${g.modelCalls == null ? '' : ` models=${g.modelCalls}`}`);
  for (const f of g.hardFailures) console.log(`  - ${f}`);
  for (const w of g.warnings) console.log(`  ? ${w}`);
}
if (unknown.length) console.log(`UNKNOWN case ids: ${unknown.join(', ')}`);
if (missing.length) console.log(`MISSING grades: ${missing.join(', ')}`);
console.log(`SUMMARY ${summary.passed}/${summary.total} pass, mean=${summary.meanScore}, gate=${summary.hardGate ? 'PASS' : 'FAIL'}`);

const reportPath = process.argv[3] && process.argv[3] !== '--require-all' ? process.argv[3] : null;
if (reportPath) fs.writeFileSync(path.resolve(reportPath), JSON.stringify(report, null, 2) + '\n');
if (unknown.length || missing.length || !summary.hardGate) process.exit(1);
