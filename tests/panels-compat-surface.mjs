await import('./panels-compat-surface-stageb-base.mjs');

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../js/ui/panels/function-analysis.js', import.meta.url), 'utf8');
assert.doesNotMatch(source, /app(?:\?\.)?\.symbols/,
  'first-party function summary must not bypass AnalysisQueryAPI through SymbolIndex');
assert.match(source, /api\.function\(snapshot, functionId\)/,
  'function summary must resolve the containing function through the typed QueryAPI');
assert.match(source, /value\.startAddress/,
  'function summary must use the canonical returned function identity');
assert.match(source, /viewer\?\.rowAddress\?\.\(row\)/,
  'function summary must preserve variable-width viewer address geometry');

console.log('Function summary QueryAPI authority tests PASS!');
// Exact-head CI retrigger marker; no runtime effect.
