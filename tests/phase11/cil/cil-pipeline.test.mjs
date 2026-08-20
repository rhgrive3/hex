import assert from 'node:assert/strict';
import { CilFrontend } from '../../../js/managed/cil/frontend.js';
import { lowerVMEffectsToSemanticIr } from '../../../js/managed/shared/bridge.js';
import { buildMinimalCil } from './cil-parser.test.mjs';

console.log('[phase11] running cil pipeline tests...');

const cilBytes = buildMinimalCil();
const frontend = new CilFrontend();
const image = await frontend.open(cilBytes);

const methods = [];
for await (const m of frontend.enumerateMethods(image)) {
  methods.push(m);
}
assert.equal(methods.length, 1);

const decoded = await frontend.decodeMethod(methods[0], { image });
const val = await frontend.validateMethod(decoded);
assert.equal(val.status, 'valid');

const lifted = await frontend.liftMethod(decoded, val);
const bridged = lowerVMEffectsToSemanticIr(lifted);

assert.ok(bridged.semanticIr);
assert.ok(bridged.cfg);
assert.ok(bridged.ssa);
assert.ok(bridged.cfg.blocks.length >= 1);

console.log('  ok cil pipeline tests passed');
