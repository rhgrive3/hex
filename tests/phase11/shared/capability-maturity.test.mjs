import assert from 'node:assert/strict';
import {
  capabilityDisplay,
  currentSupportMatrix,
  MANAGED_LEVELS,
  managedMaturity,
} from '../../../js/platform/capability-maturity.js';

console.log('[phase11] running capability maturity tests...');

assert.equal(MANAGED_LEVELS.M0.code, 'M0');
assert.equal(MANAGED_LEVELS.M1.code, 'M1');
assert.equal(MANAGED_LEVELS.M2.code, 'M2');
assert.equal(MANAGED_LEVELS.M3.code, 'M3');
assert.equal(MANAGED_LEVELS.M4.code, 'M4');
assert.equal(MANAGED_LEVELS.M5.code, 'M5');
assert.equal(MANAGED_LEVELS.M6.code, 'M6');

const wasmMaturity = managedMaturity('wasm');
assert.equal(wasmMaturity.id, 'wasm');
assert.equal(wasmMaturity.implementedLevel, 'M3');
assert.equal(wasmMaturity.fullySatisfiedLevel, 'M3');
assert.equal(wasmMaturity.status, 'partial');
assert.equal(wasmMaturity.features.detectContainer, 'supported');
assert.equal(wasmMaturity.features.metadata, 'supported');
assert.equal(wasmMaturity.features.vmEffects, 'supported');
assert.equal(wasmMaturity.features.cfgSsa, 'supported');
assert.equal(wasmMaturity.features.typesInterprocedural, 'partial');
assert.equal(wasmMaturity.features.decompiler, 'partial');
assert.equal(wasmMaturity.features.runtimeDebug, 'unsupported');

const dexMaturity = managedMaturity('dex');
assert.equal(dexMaturity.id, 'dex');
assert.equal(dexMaturity.implementedLevel, 'M3');

const cilMaturity = managedMaturity('cil');
assert.equal(cilMaturity.id, 'cil');
assert.equal(cilMaturity.implementedLevel, 'M3');

const jvmMaturity = managedMaturity('jvm');
assert.equal(jvmMaturity.id, 'jvm');
assert.equal(jvmMaturity.implementedLevel, 'M3');

const matrix = currentSupportMatrix();
assert.equal(matrix.managed.length, 4);
assert.deepEqual(matrix.managed.map((m) => m.id), ['wasm', 'dex', 'cil', 'jvm']);

const display = capabilityDisplay(wasmMaturity);
assert.equal(display.levelCode, 'M3');
assert.equal(display.levelLabel, 'CFG/SSA');
assert.equal(display.statusLabel, 'Partial');

console.log('  ok capability maturity tests passed');
