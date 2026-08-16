#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ratioFromDetail, readJson, SCHEMA_VERSION } from './schema.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const fixtureManifest = readJson(path.join(ROOT, 'tests', 'fixtures', 'real-binaries.json'));
const DEFAULTS = [
  ['BattleCats', 'accuracy-BattleCats.json', 'battlecats'],
  ['TsumTsum', 'accuracy-TsumTsum.json', 'TsumTsum'],
  ['YWP', 'accuracy-YWP.json', 'YWP'],
];
const args = process.argv.slice(2);
const outputArg = args.find((x) => x.startsWith('--output='));
const output = outputArg ? outputArg.slice('--output='.length) : null;
const positional = args.filter((x) => !x.startsWith('--'));
const files = positional.length
  ? positional.map((file) => {
      const name = path.basename(file).replace(/^accuracy-/, '').replace(/\.json$/, '');
      return [name, file, name === 'BattleCats' ? 'battlecats' : name];
    })
  : DEFAULTS;

function exactFunctionStarts(row) {
  if (!row) return null;
  const counts = /（(\d+)\/(\d+)）/.exec(String(row.detail || ''));
  if (counts && typeof row.score === 'number') {
    const tp = Number(counts[1]);
    const truth = Number(counts[2]);
    const recall = truth > 0 ? tp / truth : 0;
    const f1 = row.score;
    const denom = 2 * recall - f1;
    if (recall === 0 && f1 === 0) return { precision: 0, recall: 0 };
    if (denom > 0) return { precision: (f1 * recall) / denom, recall };
  }
  return ratioFromDetail(row.detail);
}

const targets = {};
for (const [name, file, fixtureName] of files) {
  if (!fs.existsSync(file)) throw new Error(`${name}: missing required accuracy result ${file}`);
  const rows = readJson(file);
  if (!Array.isArray(rows) || rows.length === 0) throw new Error(`${name}: empty/invalid accuracy result ${file}`);
  const byId = new Map(rows.map((row) => [row.id, row]));
  const functionStarts = exactFunctionStarts(byId.get('funcs'));
  if (!functionStarts) throw new Error(`${name}: funcs row does not expose precision/recall`);
  const fixture = fixtureManifest.fixtures?.[fixtureName];
  if (!fixture) throw new Error(`${name}: no pinned fixture metadata for ${fixtureName}`);
  targets[name] = {
    fixture: { size: fixture.size, sha256: fixture.sha256 },
    functionStartPrecision: functionStarts.precision,
    functionStartRecall: functionStarts.recall,
    featureScores: Object.fromEntries(rows.map((row) => [row.id, typeof row.score === 'number' ? row.score : null])),
  };
}

const report = {
  schema: SCHEMA_VERSION,
  kind: 'accuracy',
  completeness: 'complete',
  targets,
};
const text = JSON.stringify(report, null, 2) + '\n';
if (output) fs.writeFileSync(output, text);
process.stdout.write(text);
