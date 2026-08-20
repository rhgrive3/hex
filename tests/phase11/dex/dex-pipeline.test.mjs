import assert from 'node:assert/strict';
import { DexFrontend } from '../../../js/managed/dex/frontend.js';
import { lowerVMEffectsToSemanticIr } from '../../../js/managed/shared/bridge.js';
import { buildMinimalDex } from './dex-parser.test.mjs';

console.log('[phase11] running dex pipeline tests...');

const dexBytes = buildMinimalDex();
const frontend = new DexFrontend();
const image = await frontend.open(dexBytes);

const methods = [];
for await (const m of frontend.enumerateMethods(image)) {
  methods.push(m);
}
assert.equal(methods.length, 1);
assert.equal(methods[0].name, 'foo');

const decoded = await frontend.decodeMethod(methods[0], { image });
const val = await frontend.validateMethod(decoded);
assert.equal(val.status, 'valid');

const lifted = await frontend.liftMethod(decoded, val);
const bridged = lowerVMEffectsToSemanticIr(lifted);

assert.ok(bridged.semanticIr);
assert.ok(bridged.cfg);
assert.ok(bridged.ssa);
assert.equal(bridged.cfg.blocks.length, 1);

console.log('  ok dex pipeline tests passed');
