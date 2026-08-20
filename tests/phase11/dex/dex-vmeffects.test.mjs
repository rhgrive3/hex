import assert from 'node:assert/strict';
import { liftDexMethod } from '../../../js/managed/dex/lifter.js';
import { parseDex } from '../../../js/managed/dex/parser.js';
import { buildMinimalDex } from './dex-parser.test.mjs';

console.log('[phase11] running dex VMEffects tests...');

const dexBytes = buildMinimalDex();
const dexImage = parseDex(dexBytes);
const vmFn = liftDexMethod(0, dexImage);

assert.equal(vmFn.frontendId, 'dex');
assert.equal(vmFn.bundles.length, 2);
assert.equal(vmFn.aggregateCompleteness, 'exact');

// 1. const/4 v0, #1
assert.equal(vmFn.bundles[0].mnemonic, 'const/4');
assert.equal(vmFn.bundles[0].locationWrites[0].kind, 'register');
assert.equal(vmFn.bundles[0].locationWrites[0].index, 0);
assert.equal(vmFn.bundles[0].producedValues[0].constant, 1);

// 2. return-void
assert.equal(vmFn.bundles[1].mnemonic, 'return-void');
assert.equal(vmFn.bundles[1].controlEffects[0].kind, 'return');

console.log('  ok dex VMEffects tests passed');
