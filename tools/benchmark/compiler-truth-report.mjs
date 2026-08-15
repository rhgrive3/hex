#!/usr/bin/env node
import fs from 'node:fs';
import { SCHEMA_VERSION } from './schema.mjs';

const file = process.argv.find((x) => x.startsWith('--input='))?.slice('--input='.length) || process.argv[2];
const output = process.argv.find((x) => x.startsWith('--output='))?.slice('--output='.length) || null;
if (!file || !fs.existsSync(file)) throw new Error(`missing compiler-truth log: ${file || '(none)'}`);
const line = fs.readFileSync(file, 'utf8').split(/\r?\n/).find((x) => x.startsWith('COMPILER_TRUTH '));
if (!line) throw new Error('COMPILER_TRUTH summary not found');
const summary = JSON.parse(line.slice('COMPILER_TRUTH '.length));
const semanticRows = (summary.results || []).flatMap((r) => r.functions || []);
const semanticMismatches = semanticRows.filter((x) => x?.semanticTruth?.equivalent === false).length;
const semanticUnverified = semanticRows.filter((x) => x?.semanticTruth?.equivalent !== true).length;
const hardFailures = Number(summary.hardFailures || 0);
const ghidraStatus = summary.ghidra?.status || 'unknown';
const report = {
  schema: SCHEMA_VERSION,
  kind: 'compiler-truth',
  completeness: summary.clangAvailable ? 'complete' : 'partial',
  executed: Number(summary.executed || 0),
  expectedCases: Number(summary.expectedCases || 0),
  semanticMismatches,
  semanticUnverified,
  hardFailures,
  decompilerSemanticRegressions: semanticMismatches + hardFailures,
  ghidra: { status: ghidraStatus, parsed: summary.ghidra?.parsed ?? null, expected: summary.ghidra?.expected ?? null },
};
if (ghidraStatus === 'skipped' || ghidraStatus === 'failed') process.exitCode = 2;
const text = JSON.stringify(report, null, 2) + '\n';
if (output) fs.writeFileSync(output, text);
process.stdout.write(text);
