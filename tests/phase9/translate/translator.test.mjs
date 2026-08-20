import assert from 'node:assert/strict';
import test from 'node:test';

import { OP, VK, MK } from '../../../js/ir-base.js';
import { EXPR_KIND, BV_BINARY_OP, BV_COMPARE_OP } from '../../../js/symbolic/expr/kinds.js';
import { evaluateExpr, EVAL_STATUS } from '../../../js/symbolic/expr/evaluate.js';
import { TRANSLATION_STATUS } from '../../../js/symbolic/translate/support-matrix.js';
import { backwardDependencySlice } from '../../../js/symbolic/translate/slice.js';
import { translateSemanticIR } from '../../../js/symbolic/translate/semantic-ir.js';

test('translator translates simple integer arithmetic SSA graphs accurately', () => {
  // arg0 + 42
  const arg0 = { kind: VK.ARG, id: 'v0', reg: 'x0', origin: '0x1000' };
  const c42 = { const: 42n, id: 'v1', origin: '0x1004' };
  const addInst = {
    id: 'i1',
    op: OP.BIN,
    subOp: 'add',
    origin: '0x1008',
    row: 2,
    args: [{ value: arg0 }, { value: c42 }],
  };
  const addVal = { id: 'v2', def: addInst, origin: '0x1008' };

  const res = translateSemanticIR(addVal, { bitWidth: 64 });
  assert.equal(res.status, TRANSLATION_STATUS.EXACT);
  assert.equal(res.semanticUnknowns, 0);
  assert.equal(res.unsupportedEntities.length, 0);
  assert.equal(res.expression.kind, EXPR_KIND.BINARY);
  assert.equal(res.expression.op, BV_BINARY_OP.ADD);

  // Evaluate with environment
  const evalRes = evaluateExpr(res.expression, new Map([['arg_x0', 100n]]));
  assert.equal(evalRes.status, EVAL_STATUS.VALUE);
  assert.equal(evalRes.value, 142n);

  // Check provenance / originMap
  assert.ok(Object.keys(res.originMap).length > 0);
});

test('translator translates branch conditions (CMP) accurately', () => {
  const arg0 = { kind: VK.ARG, id: 'v0', reg: 'x0', origin: '0x1000' };
  const c0 = { const: 0n, id: 'v1', origin: '0x1004' };
  const cmpInst = {
    id: 'i_cmp',
    op: OP.CMP,
    cond: '!=',
    signed: false,
    origin: '0x1008',
    args: [{ value: arg0 }, { value: c0 }],
  };

  const res = translateSemanticIR(cmpInst, { bitWidth: 64 });
  assert.equal(res.status, TRANSLATION_STATUS.EXACT);
  assert.equal(res.expression.kind, EXPR_KIND.COMPARE);
  assert.equal(res.expression.op, BV_COMPARE_OP.NE);

  const evalTrue = evaluateExpr(res.expression, new Map([['arg_x0', 5n]]));
  assert.equal(evalTrue.value, true);

  const evalFalse = evaluateExpr(res.expression, new Map([['arg_x0', 0n]]));
  assert.equal(evalFalse.value, false);
});

test('translator fails closed on unsupported operations and unknown memory locations', () => {
  // Unknown load location
  const unkLoad = {
    id: 'i_load',
    op: OP.LOAD,
    loc: { kind: MK.UNKNOWN },
    origin: '0x2000',
  };
  const val = { id: 'v_load', def: unkLoad, origin: '0x2000' };

  const res = translateSemanticIR(val, { bitWidth: 64 });
  assert.equal(res.status, TRANSLATION_STATUS.UNSUPPORTED);
  assert.ok(res.semanticUnknowns > 0);
  assert.ok(res.unsupportedEntities.length > 0);
  assert.equal(res.expression.kind, EXPR_KIND.UNKNOWN_SEMANTIC);

  // Unknown semantic cannot evaluate to a constant
  const evalRes = evaluateExpr(res.expression);
  assert.equal(evalRes.status, EVAL_STATUS.UNKNOWN);
});

test('backward dependency slicing correctly traces dependencies and detects cycles', () => {
  const v0 = { id: 'v0', origin: '0x100' };
  const v1 = { id: 'v1', origin: '0x104' };
  const phiInst = {
    id: 'i_phi',
    op: OP.PHI,
    incoming: [{ from: 0, value: v0 }, { from: 1, value: v1 }],
  };
  const vPhi = { id: 'vPhi', def: phiInst };

  // Create cycle: v0 depends on vPhi
  v0.def = { id: 'i_add', op: OP.BIN, subOp: 'add', args: [{ value: vPhi }] };

  const slice = backwardDependencySlice(vPhi, { maxDepth: 10 });
  assert.equal(slice.hasCycle, true);
  assert.ok(slice.assumptions.length > 0);
  assert.equal(slice.completeness.controlFlow, 'partial');
});
