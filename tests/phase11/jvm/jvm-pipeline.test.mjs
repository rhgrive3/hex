import assert from 'node:assert/strict';
import { JvmFrontend } from '../../../js/managed/jvm/frontend.js';
import { lowerVMEffectsToSemanticIr } from '../../../js/managed/shared/bridge.js';
import { buildMinimalJvmClass } from './jvm-parser.test.mjs';

console.log('[phase11] running jvm pipeline tests...');

const classBytes = buildMinimalJvmClass();
const frontend = new JvmFrontend();
const image = await frontend.open(classBytes);

const methods = [];
for await (const m of frontend.enumerateMethods(image)) {
  methods.push(m);
}
assert.equal(methods.length, 1);
assert.equal(methods[0].name, 'testMethod');

const decoded = await frontend.decodeMethod(methods[0], { image });
const val = await frontend.validateMethod(decoded);
assert.equal(val.status, 'valid');

const lifted = await frontend.liftMethod(decoded, val);
const bridged = lowerVMEffectsToSemanticIr(lifted);

assert.ok(bridged.semanticIr);
assert.ok(bridged.cfg);
assert.ok(bridged.ssa);
assert.equal(bridged.cfg.blocks.length, 1);

console.log('  ok jvm pipeline tests passed');
