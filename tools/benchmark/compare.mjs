#!/usr/bin/env node
import fs from 'node:fs';
import { readJson, validateBaseline } from './schema.mjs';

const EPS = 1e-12;
const baselinePath = process.argv.find((x) => x.startsWith('--baseline='))?.slice('--baseline='.length) || 'tests/benchmark-baseline.json';
const accuracyPath = process.argv.find((x) => x.startsWith('--accuracy='))?.slice('--accuracy='.length) || null;
const compilerTruthPath = process.argv.find((x) => x.startsWith('--compiler-truth='))?.slice('--compiler-truth='.length) || null;
const binaryPath = process.argv.find((x) => x.startsWith('--binary='))?.slice('--binary='.length) || null;
const baseline = validateBaseline(readJson(baselinePath));
let failed = false;
const checks = [];

function check(name, ok, detail) {
  checks.push({ name, ok, detail });
  if (!ok) failed = true;
}

function atLeast(actual, floor) {
  return typeof actual === 'number' && Number.isFinite(actual) && actual + EPS >= floor;
}

if (accuracyPath) {
  if (!fs.existsSync(accuracyPath)) throw new Error(`missing accuracy report: ${accuracyPath}`);
  const current = readJson(accuracyPath);
  check('accuracy completeness', current.completeness === 'complete', current.completeness || 'missing');
  for (const [target, expected] of Object.entries(baseline.observations.accuracy.targets)) {
    const got = current.targets?.[target];
    check(`${target} accuracy present`, Boolean(got), got ? 'present' : 'missing');
    if (!got) continue;
    const fixtureKey = target === 'BattleCats' ? 'battlecats' : target;
    const fixture = baseline.fixtures[fixtureKey];
    check(`${target} accuracy fixture size`, got.fixture?.size === fixture?.size, `${got.fixture?.size ?? 'N/A'} == ${fixture?.size ?? 'N/A'}`);
    check(`${target} accuracy fixture hash`, got.fixture?.sha256 === fixture?.sha256, got.fixture?.sha256 || 'missing');
    check(`${target} function-start precision`, atLeast(got.functionStartPrecision, expected.functionStartPrecision), `${got.functionStartPrecision ?? 'N/A'} >= ${expected.functionStartPrecision}`);
    check(`${target} function-start recall`, atLeast(got.functionStartRecall, expected.functionStartRecall), `${got.functionStartRecall ?? 'N/A'} >= ${expected.functionStartRecall}`);
    for (const [id, floor] of Object.entries(expected.featureFloors)) {
      const score = got.featureScores?.[id];
      check(`${target} ${id}`, atLeast(score, floor), `${score ?? 'N/A'} >= ${floor}`);
    }
  }
}

if (compilerTruthPath) {
  if (!fs.existsSync(compilerTruthPath)) throw new Error(`missing compiler-truth report: ${compilerTruthPath}`);
  const current = readJson(compilerTruthPath);
  const expected = baseline.observations.compilerTruth;
  check('compiler-truth completeness', current.completeness === 'complete', current.completeness || 'missing');
  check('compiler-truth executed all cases', current.executed === current.expectedCases && current.expectedCases > 0, `${current.executed}/${current.expectedCases}`);
  check('semantic mismatches', current.semanticMismatches <= expected.semanticMismatches, `${current.semanticMismatches} <= ${expected.semanticMismatches}`);
  check('semantic unverified', current.semanticUnverified <= expected.semanticUnverified, `${current.semanticUnverified} <= ${expected.semanticUnverified}`);
  check('decompiler semantic regressions', current.decompilerSemanticRegressions <= expected.decompilerSemanticRegressions, `${current.decompilerSemanticRegressions} <= ${expected.decompilerSemanticRegressions}`);
  check('Ghidra differential', current.ghidra?.status === 'ok', current.ghidra?.status || 'missing');
  check('Ghidra parsed corpus', current.ghidra?.parsed === expected.ghidra.parsed, `${current.ghidra?.parsed ?? 'N/A'} == ${expected.ghidra.parsed}`);
  check('Ghidra expected corpus', current.ghidra?.expected === expected.ghidra.expected, `${current.ghidra?.expected ?? 'N/A'} == ${expected.ghidra.expected}`);
}

if (binaryPath) {
  if (!fs.existsSync(binaryPath)) throw new Error(`missing binary benchmark report: ${binaryPath}`);
  const current = readJson(binaryPath);
  check('binary benchmark samples', Number.isInteger(current.samplesPerTarget) && current.samplesPerTarget >= baseline.baseline.environment.binarySamplesPerTarget, `${current.samplesPerTarget ?? 'N/A'} >= ${baseline.baseline.environment.binarySamplesPerTarget}`);
  for (const [target, expected] of Object.entries(baseline.observations.binary.targets)) {
    const got = current.targets?.[target];
    check(`${target} benchmark present`, Boolean(got), got ? 'present' : 'missing');
    if (!got) continue;
    const fixture = baseline.fixtures[target];
    check(`${target} fixture size`, got.fixture?.size === fixture?.size, `${got.fixture?.size ?? 'N/A'} == ${fixture?.size ?? 'N/A'}`);
    check(`${target} fixture hash`, got.fixture?.sha256 === fixture?.sha256, got.fixture?.sha256 || 'missing');
    check(`${target} source-backed`, got.sourceBacked === true, String(got.sourceBacked));
    check(`${target} audit errors`, got.auditErrors === 0, String(got.auditErrors));
    check(`${target} identity bytes`, got.bytes === expected.identity.bytes, `${got.bytes} == ${expected.identity.bytes}`);
    check(`${target} identity format`, got.format === expected.identity.format, `${got.format} == ${expected.identity.format}`);
    check(`${target} identity arch`, got.arch === expected.identity.arch, `${got.arch} == ${expected.identity.arch}`);
    const ratio = baseline.regressionPolicy.deterministicWork.maxRatio;
    check(`${target} range reads`, got.work?.rangeReads <= Math.ceil(expected.work.rangeReads * ratio), `${got.work?.rangeReads ?? 'N/A'} <= ${Math.ceil(expected.work.rangeReads * ratio)}`);
    check(`${target} requested bytes`, got.work?.totalRequestedBytes <= Math.ceil(expected.work.totalRequestedBytes * ratio), `${got.work?.totalRequestedBytes ?? 'N/A'} <= ${Math.ceil(expected.work.totalRequestedBytes * ratio)}`);
  }
}

for (const row of checks) console.log(`${row.ok ? 'PASS' : 'FAIL'} ${row.name}: ${row.detail}`);
if (!accuracyPath && !compilerTruthPath && !binaryPath) throw new Error('at least one current report is required');
if (failed) process.exit(1);
