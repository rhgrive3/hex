import assert from 'node:assert/strict';
import { liftCilMethod } from '../../../js/managed/cil/lifter.js';
import { parseCil } from '../../../js/managed/cil/parser.js';
import { buildMinimalCil } from './cil-parser.test.mjs';

console.log('[phase11] running cil VMEffects tests...');

const cilBytes = buildMinimalCil();
const cilImage = parseCil(cilBytes);
const vmFn = liftCilMethod(0, cilImage);

assert.equal(vmFn.frontendId, 'cil');
assert.equal(vmFn.bundles.length, 5);
assert.equal(vmFn.aggregateCompleteness, 'exact');

// 1. ldc.i4.5
assert.equal(vmFn.bundles[0].mnemonic, 'ldc.i4.5');
assert.equal(vmFn.bundles[0].producedValues[0].constant, 5);

// 2. stloc.0
assert.equal(vmFn.bundles[1].mnemonic, 'stloc.0');
assert.equal(vmFn.bundles[1].locationWrites[0].kind, 'local');
assert.equal(vmFn.bundles[1].locationWrites[0].index, 0);

// 3. ldloc.0
assert.equal(vmFn.bundles[2].mnemonic, 'ldloc.0');
assert.equal(vmFn.bundles[2].locationReads[0].kind, 'local');
assert.equal(vmFn.bundles[2].locationReads[0].index, 0);

// 4. ret
assert.equal(vmFn.bundles[3].mnemonic, 'ret');
assert.equal(vmFn.bundles[3].controlEffects[0].kind, 'return');

console.log('  ok cil VMEffects tests passed');
