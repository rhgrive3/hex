import assert from 'node:assert/strict';
import test from 'node:test';

import { expr, sourceOf } from '../../../js/decompiler/ast/nodes.js';
import { applyPhase8Projection } from '../../../js/decompiler/phase8/projection.js';

function source(valueId, row = 3) {
  return sourceOf({ row, address:0x1000n + BigInt(row) * 4n, ssaDef:valueId, evidence:[{ reason:'fixture-origin' }] });
}

function resultWith(expression, { condition = null } = {}) {
  const returnNode = { kind:'stmt', indent:1, text:'return old;', source:source(99, 4), semantic:{ op:'return', expression, ir:9 } };
  const body = [returnNode];
  const conditions = [];
  if (condition) {
    body.unshift({ kind:'ctrl', indent:1, text:'if (v12 != 0) goto loc_2000;', source:source(12, 3), semantic:null });
    conditions.push({ kind:'SemanticCondition', expression:condition, text:'v12 != 0', row:3, address:0x100cn, ir:7 });
  }
  return {
    semantic:true,
    semanticAst:{ values:[{ kind:'SemanticValue', valueId:99, expression, source:expression.source }], stores:[], calls:[], conditions, inputs:[], outputs:[{ name:'return', expression }] },
    cAst:{ kind:'CProgram', body, source:sourceOf() },
    metrics:{ rawAssemblyFallbacks:0, gotos:condition ? 1 : 0, temporaries:condition ? 1 : 0, redundantCasts:3, structured:true },
  };
}

function analysis(induction = null) {
  return {
    get(key) {
      if (key !== 'induction') return null;
      return induction ?? { completeness:'complete', loops:[] };
    },
  };
}

test('P8-I collapses only an exact nested truncation and retains proof provenance', () => {
  const value = expr.variable('a1', 64, true, source(1));
  const wide = expr.unary('trunc', value, 32, false, source(2));
  const narrow = expr.unary('trunc', wide, 8, false, source(3));
  const signed = expr.unary('sext', narrow, 32, true, source(4));
  const result = applyPhase8Projection(resultWith(signed), analysis());

  assert.match(result.pseudocode, /return \(int32_t\)\(uint8_t\)a1;/);
  assert.doesNotMatch(result.pseudocode, /\(uint8_t\)\(uint32_t\)a1/);
  assert.ok(result.metrics.redundantCasts < 3);
  assert.ok(result.phase8Projection.transforms.some((entry) => entry.kind === 'exact-view-collapse'));
  const evidence = result.semanticAst.values[0].expression.arg.source.evidence.map((item) => item.reason);
  assert.ok(evidence.includes('Phase 8 exact nested-truncation proof'));
});

test('P8-I refuses nested truncation when the width relation is not a proof', () => {
  const value = expr.variable('a1', 16, false, source(1));
  const first = expr.unary('trunc', value, 8, false, source(2));
  const invalid = expr.unary('trunc', first, 12, false, source(3));
  const result = applyPhase8Projection(resultWith(invalid), analysis());
  assert.equal(result.phase8Projection.transforms.filter((entry) => entry.kind === 'exact-view-collapse').length, 0);
});

test('P8-I names only a temporary backed by a proved natural-loop induction fact', () => {
  const temporary = expr.variable('v12', 64, false, source(12, 3));
  const condition = expr.compare('ne', temporary, expr.constant(0, 64, false, source(13, 3)), false, source(14, 3));
  const returned = expr.constant(0, 64, false, source(99, 4));
  const induction = {
    completeness:'complete',
    loops:[{
      header:1,
      classification:'natural',
      inductions:[{
        valueId:12,
        step:1n,
        stepReason:null,
        origin:{ instructionIds:['insn-12'] },
      }],
    }],
  };
  const result = applyPhase8Projection(resultWith(returned, { condition }), analysis(induction));

  assert.match(result.pseudocode, /if \(induction_0 != 0\) goto loc_2000;/);
  assert.doesNotMatch(result.pseudocode, /\bv12\b/);
  assert.equal(result.metrics.temporaries, 0);
  assert.ok(result.phase8Projection.transforms.some((entry) => entry.kind === 'induction-variable' && entry.valueId === 12));
});

test('P8-I does not rename a same-looking temporary without matching SSA provenance', () => {
  const temporary = expr.variable('v12', 64, false, source(88, 3));
  const condition = expr.compare('ne', temporary, expr.constant(0, 64, false, source(13, 3)), false, source(14, 3));
  const returned = expr.constant(0, 64, false, source(99, 4));
  const induction = {
    completeness:'complete',
    loops:[{ header:1, classification:'natural', inductions:[{ valueId:12, step:1n, stepReason:null, origin:{ instructionIds:['insn-12'] } }] }],
  };
  const result = applyPhase8Projection(resultWith(returned, { condition }), analysis(induction));
  assert.match(result.pseudocode, /\bv12\b/);
  assert.equal(result.phase8Projection.transforms.filter((entry) => entry.kind === 'induction-variable').length, 0);
});
