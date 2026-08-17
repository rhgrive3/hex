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
    if (!Object.prototype.hasOwnProperty.call(row, 'score')) {
      throw new TypeError(`accuracy-result-score-missing:${row.id}`);
    }
    // Some feature families legitimately report null when the pinned fixture
    // contains no applicable samples. Preserve that existing accuracy contract
    // while rejecting malformed numeric scores.
    if (row.score !== null &&
        (typeof row.score !== 'number' || !Number.isFinite(row.score) || row.score < 0 || row.score > 1)) {
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
  let stat;
  try { stat = fs.statSync(file); } catch { throw new TypeError(`accuracy-result-file-missing:${file}`); }
  if (!stat.isFile() || stat.size === 0) throw new TypeError(`accuracy-result-file-empty:${file}`);
  const rows = JSON.parse(fs.readFileSync(file, 'utf8'));
  return validateAccuracyRows(rows, expectedIds);
}

function selfTest() {
  const valid = [{ id: 'a', score: 1 }, { id: 'b', score: 0.5 }, { id: 'c', score: null }];
  validateAccuracyRows(valid, ['a', 'b', 'c']);
  const expectFailure = (fn, pattern) => {
    let error = null;
    try { fn(); } catch (caught) { error = caught; }
    if (!error || !pattern.test(String(error.message))) {
      throw new Error(`expected ${pattern}, got ${error?.message ?? 'success'}`);
    }
  };
  expectFailure(() => validateAccuracyRows([]), /accuracy-result-empty/);
  expectFailure(() => validateAccuracyRows([{ id: 'a', score: 1 }, { id: 'a', score: 1 }]), /duplicate-id/);
  expectFailure(() => validateAccuracyRows([{ id: 'a', score: NaN }]), /score-invalid/);
  expectFailure(() => validateAccuracyRows([{ id: 'a' }]), /score-missing/);
  expectFailure(() => validateAccuracyRows(valid, ['a', 'b', 'd']), /id-mismatch/);
  console.log('accuracy result validation self-test passed');
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--self-test')) {
    selfTest();
    return;
  }
  const [file, ...args] = argv;
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
