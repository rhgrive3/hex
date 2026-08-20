import assert from 'node:assert/strict';
import { liftJvmMethod } from '../../../js/managed/jvm/lifter.js';
import { parseJvm } from '../../../js/managed/jvm/parser.js';
import { buildMinimalJvmClass } from './jvm-parser.test.mjs';

console.log('[phase11] running jvm VMEffects tests...');

const classBytes = buildMinimalJvmClass();
const jvmClass = parseJvm(classBytes);
const vmFn = liftJvmMethod(0, jvmClass);

assert.equal(vmFn.frontendId, 'jvm');
assert.equal(vmFn.bundles.length, 6);
assert.equal(vmFn.aggregateCompleteness, 'exact');

// 1. iconst_5
assert.equal(vmFn.bundles[0].mnemonic, 'iconst_5');
assert.equal(vmFn.bundles[0].producedValues[0].constant, 5);

// 2. istore_1
assert.equal(vmFn.bundles[1].mnemonic, 'istore_1');
assert.equal(vmFn.bundles[1].locationWrites[0].kind, 'local');
assert.equal(vmFn.bundles[1].locationWrites[0].index, 1);

// 3. iload_1
assert.equal(vmFn.bundles[2].mnemonic, 'iload_1');
assert.equal(vmFn.bundles[2].locationReads[0].kind, 'local');
assert.equal(vmFn.bundles[2].locationReads[0].index, 1);

// 4. iconst_1
assert.equal(vmFn.bundles[3].mnemonic, 'iconst_1');
assert.equal(vmFn.bundles[3].producedValues[0].constant, 1);

// 5. iadd
assert.equal(vmFn.bundles[4].mnemonic, 'iadd');
assert.equal(vmFn.bundles[4].consumedValues.length, 2);
assert.equal(vmFn.bundles[4].producedValues.length, 1);

// 6. return
assert.equal(vmFn.bundles[5].mnemonic, 'return');
assert.equal(vmFn.bundles[5].controlEffects[0].kind, 'return');

console.log('  ok jvm VMEffects tests passed');
