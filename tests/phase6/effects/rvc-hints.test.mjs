import assert from 'node:assert/strict';
import test from 'node:test';

import { architecturePluginV2 } from '../../../js/targets/architecture/index.js';
import { evaluateBundle, liftBytes } from './helpers.mjs';

const rv = architecturePluginV2('riscv64');

const HINTS = Object.freeze([
  { name: 'c.nop imm=1', bytes: [0x05, 0x00], expandedFrom: 'c.nop' },
  { name: 'c.addi x1, 0', bytes: [0x81, 0x00], expandedFrom: 'c.addi' },
  { name: 'c.li x0, 0', bytes: [0x01, 0x40], expandedFrom: 'c.li' },
  { name: 'c.lui x0, 1', bytes: [0x05, 0x60], expandedFrom: 'c.lui' },
  { name: 'c.srli x8, 0', bytes: [0x01, 0x80], expandedFrom: 'c.srli' },
  { name: 'c.srai x8, 0', bytes: [0x01, 0x84], expandedFrom: 'c.srai' },
  { name: 'c.slli x1, 0', bytes: [0x82, 0x00], expandedFrom: 'c.slli' },
  { name: 'c.slli x0, 1', bytes: [0x06, 0x00], expandedFrom: 'c.slli' },
  { name: 'c.mv x0, x1', bytes: [0x06, 0x80], expandedFrom: 'c.mv' },
  { name: 'c.add x0, x1', bytes: [0x06, 0x90], expandedFrom: 'c.add' },
  { name: 'c.ntl.p1 / c.add x0, x2', bytes: [0x0a, 0x90], expandedFrom: 'c.add' },
]);

test('all standard RV64C HINT classes decode as supported architectural no-ops', () => {
  for (const item of HINTS) {
    const { decoded } = liftBytes(item.bytes);
    assert.equal(decoded.fields.supported, true, item.name);
    assert.equal(decoded.fields.op, 'hint', item.name);
    assert.equal(decoded.fields.hint, true, item.name);
    assert.equal(decoded.fields.architecturalNoOp, true, item.name);
    assert.equal(decoded.fields.expandedFrom, item.expandedFrom, item.name);
    assert.equal(rv.classifyControlFlow(decoded), 'fallthrough', item.name);
  }
});

test('RV64C HINTs lift to exact fallthrough with a state-preservation proof and no fake SSA defs', () => {
  const initial = { x1: 0x1122334455667788n, x8: 0x8877665544332211n, x10: 7n };
  for (const item of HINTS) {
    const { bundle } = liftBytes(item.bytes);
    assert.ok(bundle, `${item.name} must lift exactly`);
    assert.equal(bundle.completeness, 'exact', item.name);
    assert.equal(bundle.controlEffect.kind, 'fallthrough', item.name);
    assert.deepEqual(bundle.operations, [], `${item.name} must not manufacture register/dataflow effects`);
    assert.equal(bundle.statePreservation?.proven, true, item.name);
    assert.equal(bundle.metadata.family, 'hint', item.name);
    assert.equal(bundle.metadata.architecturalNoOp, true, item.name);
    assert.deepEqual(Object.fromEntries(evaluateBundle(bundle, initial).registers), initial, item.name);
  }
});

test('canonical C.NOP is an exact no-op but is not mislabeled as a HINT', () => {
  const { decoded, bundle } = liftBytes([0x01, 0x00]);
  assert.equal(decoded.fields.supported, true);
  assert.equal(decoded.fields.op, 'nop');
  assert.equal(decoded.fields.architecturalNoOp, true);
  assert.notEqual(decoded.fields.hint, true);
  assert.ok(bundle);
  assert.equal(bundle.completeness, 'exact');
  assert.deepEqual(bundle.operations, []);
  assert.equal(bundle.controlEffect.kind, 'fallthrough');
  assert.equal(bundle.statePreservation?.proven, true);
});

test('nearby reserved compressed encodings remain unsupported', () => {
  for (const item of [
    { name: 'c.addi4spn nzuimm=0', bytes: [0x00, 0x00] },
    { name: 'c.jr x0', bytes: [0x02, 0x80] },
    { name: 'c.lwsp x0', bytes: [0x02, 0x40] },
  ]) {
    const { decoded, bundle } = liftBytes(item.bytes);
    assert.equal(decoded.fields.supported, false, item.name);
    assert.equal(bundle, null, item.name);
  }
});
