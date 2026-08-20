import assert from 'node:assert/strict';
import test from 'node:test';

import { expr, sourceOf } from '../../../js/decompiler/ast/nodes.js';
import { applyPhase8Projection } from '../../../js/decompiler/phase8/projection.js';

function source(valueId, row = 1) {
  return sourceOf({ row, address:0x2000n + BigInt(row) * 4n, ssaDef:valueId, evidence:[{ reason:'cast-chain-fixture' }] });
}

function project(expression) {
  const result = {
    semantic:true,
    semanticAst:{
      values:[{ kind:'SemanticValue', valueId:9, expression, source:expression.source }],
      stores:[], calls:[], conditions:[], inputs:[], outputs:[{ name:'return', expression }],
    },
    cAst:{
      kind:'CProgram',
      body:[{ kind:'stmt', indent:1, text:'return old;', source:source(9, 4), semantic:{ op:'return', expression, ir:9 } }],
      source:sourceOf(),
    },
    metrics:{ rawAssemblyFallbacks:0, gotos:0, temporaries:0, redundantCasts:3, structured:true },
  };
  const analysis = { get(key) { return key === 'induction' ? { completeness:'complete', loops:[] } : null; } };
  return applyPhase8Projection(result, analysis);
}

test('P8-I narrows a zero extension hidden under an exact unsigned truncation', () => {
  const input = expr.variable('a1', 64, false, source(1));
  const low = expr.unary('trunc', input, 8, false, source(2));
  const wide = expr.unary('zext', low, 64, false, source(3), { fromBits:8 });
  const view = expr.unary('trunc', wide, 32, false, source(4), { fromBits:64 });
  const result = project(view);

  assert.match(result.pseudocode, /return \(uint32_t\)\(uint8_t\)a1;/);
  assert.doesNotMatch(result.pseudocode, /\(uint32_t\)\(uint64_t\)/);
  assert.ok(result.phase8Projection.transforms.some((entry) => entry.proof.includes('trunc_N(zext_M')));
  assert.ok(result.semanticAst.values[0].expression.source.evidence.some((entry) => entry.reason === 'Phase 8 exact zero-extension narrowing proof'));
});

test('P8-I discards an extension only when the outer truncation removes every extension bit', () => {
  const input = expr.variable('a1', 32, true, source(1));
  const wide = expr.unary('sext', input, 64, true, source(2), { fromBits:32 });
  const view = expr.unary('trunc', wide, 16, false, source(3), { fromBits:64 });
  const result = project(view);

  assert.match(result.pseudocode, /return \(uint16_t\)a1;/);
  assert.doesNotMatch(result.pseudocode, /\(int64_t\)/);
  assert.ok(result.phase8Projection.transforms.some((entry) => entry.proof.includes('trunc_N(ext_M')));
});

test('P8-I preserves sign extension when truncation keeps sign-extension bits', () => {
  const input = expr.variable('a1', 8, true, source(1));
  const signedWide = expr.unary('sext', input, 64, true, source(2), { fromBits:8 });
  const unsignedView = expr.unary('trunc', signedWide, 32, false, source(3), { fromBits:64 });
  const result = project(unsignedView);

  assert.match(result.pseudocode, /return \(uint32_t\)\(int64_t\)a1;/);
  assert.equal(result.phase8Projection.transforms.filter((entry) => entry.proof.includes('trunc_N(ext_M')).length, 0);
});

test('P8-I collapses repeated equal-kind extensions and retains merged provenance', () => {
  const input = expr.variable('a1', 8, false, source(1));
  const mid = expr.unary('zext', input, 32, false, source(2), { fromBits:8 });
  const wide = expr.unary('zext', mid, 64, false, source(3), { fromBits:32 });
  const result = project(wide);

  assert.match(result.pseudocode, /return \(uint64_t\)a1;/);
  assert.doesNotMatch(result.pseudocode, /\(uint64_t\)\(uint32_t\)/);
  assert.ok(result.phase8Projection.transforms.some((entry) => entry.proof.includes('zext_N(zext_M')));
  assert.ok(result.semanticAst.values[0].expression.source.rows.includes(2));
  assert.ok(result.semanticAst.values[0].expression.source.rows.includes(3));
});
