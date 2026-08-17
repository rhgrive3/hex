import fs from 'node:fs';

export function validateAccuracyRows(rows, expectedIds = null) {
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new TypeError('accuracy-result-empty');
  }
  const ids = [];
  for (const [index, row] of rows.entries()) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) {
      throw new TypeError(`accuracy-result-row-invalid:${index}`);
    }
    if (typeof row.id !== 'string' || !row.id) {
      throw new TypeError(`accuracy-result-id-invalid:${index}`);
    }
    if (typeof row.score !== 'number' || !Number.isFinite(row.score) || row.score < 0 || row.score > 1) {
      throw new TypeError(`accuracy-result-score-invalid:${row.id}`);
    }
    ids.push(row.id);
  }
  if (new Set(ids).size !== ids.length) throw new TypeError('accuracy-result-duplicate-id');

  if (expectedIds) {
    const expected = [...expectedIds].sort();
    const actual = ids.slice().sort();
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      throw new TypeError(`accuracy-result-id-mismatch: expected=${expected.join(',')} actual=${actual.join(',')}`);
    }
  }
  return rows;
}

export function validateAccuracyFile(file, expectedIds = null) {
  const stat = fs.statSync(file);
  if (!stat.isFile() || stat.size === 0) throw new TypeError(`accuracy-result-file-empty:${file}`);
  const rows = JSON.parse(fs.readFileSync(file, 'utf8'));
  return validateAccuracyRows(rows, expectedIds);
}

function main() {
  const [file, ...args] = process.argv.slice(2);
  if (!file) {
    console.error('usage: node tests/accuracy-result-validate.mjs <result.json> [--expect=id1,id2,...]');
    process.exit(2);
  }
  const expectedArg = args.find((arg) => arg.startsWith('--expect='));
  const expectedIds = expectedArg
    ? expectedArg.slice('--expect='.length).split(',').map((id) => id.trim()).filter(Boolean)
    : null;
  validateAccuracyFile(file, expectedIds);
  console.error(`validated accuracy result: ${file}`);
}

if (process.argv[1]?.endsWith('accuracy-result-validate.mjs')) main();
