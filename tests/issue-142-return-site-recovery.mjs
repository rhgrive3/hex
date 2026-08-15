import assert from 'node:assert/strict';
import { expr } from '../js/decompiler/ast/nodes.js';
import { recoverExactStackPhiExpressions } from '../js/decompiler/passes/stack-phi-recovery.js';

const source = (row, ir) => ({ addresses: [], rows: [row], ir: [ir], ssaDefs: [], ssaUses: [], evidence: [] });
const loc = { kind: 'stack', key: 'stack:8', name: 'local_8' };

function makeResult(order = ['r1', 'r2', 'r3']) {
  const v1 = { id: 1 }, v2 = { id: 2 };
  const store1 = { id: 's1', op: 'store', row: 1, block: 0, loc, args: [{ value: v1 }] };
  const ret1 = { id: 'r1', op: 'ret', row: 2, block: 0, args: [] };
  const store2 = { id: 's2', op: 'store', row: 3, block: 1, loc, args: [{ value: v2 }] };
  const ret2 = { id: 'r2', op: 'ret', row: 4, block: 1, args: [] };
  const ret3 = { id: 'r3', op: 'ret', row: 5, block: 2, args: [] };
  const load1 = expr.load(loc, 64, source(2, 'r1'));
  const load2 = expr.load(loc, 64, source(4, 'r2'));
  const early = expr.constant(-1, 64, true, source(5, 'r3'));
  const nodes = {
    r1: { kind: 'stmt', indent: 1, text: 'return local_8;', semantic: { op: 'return', expression: load1, ir: 'r1' }, source: source(2, 'r1') },
    r2: { kind: 'stmt', indent: 1, text: 'return local_8;', semantic: { op: 'return', expression: load2, ir: 'r2' }, source: source(4, 'r2') },
    r3: { kind: 'stmt', indent: 1, text: 'return -1;', semantic: { op: 'return', expression: early, ir: 'r3' }, source: source(5, 'r3') },
  };
  return {
    semantic: true,
    ir: {
      instructions: [store1, ret1, store2, ret2, ret3],
      blocks: [
        { index: 0, pred: [], succ: [], insts: [store1, ret1] },
        { index: 1, pred: [], succ: [], insts: [store2, ret2] },
        { index: 2, pred: [], succ: [], insts: [ret3] },
      ],
    },
    semanticAst: {
      values: [
        { valueId: 1, expression: expr.constant(11, 64, false) },
        { valueId: 2, expression: expr.constant(22, 64, false) },
      ],
      conditions: [],
      outputs: [
        { name: 'return', expression: load1 },
        { name: 'return', expression: load2 },
        { name: 'return', expression: early },
      ],
    },
    cAst: { body: order.map((id) => nodes[id]) },
    lines: [], pseudocode: '', sourceMap: [], rewriteProof: [], metrics: {}, ctx: {},
  };
}

function byIr(result) {
  return new Map(result.cAst.body.map((n) => [n.semantic?.ir, n.text]));
}

{
  const result = recoverExactStackPhiExpressions(makeResult());
  const text = byIr(result);
  assert.equal(text.get('r1'), 'return 11;');
  assert.equal(text.get('r2'), 'return 22;');
  assert.equal(text.get('r3'), 'return -1;');
  assert.equal(result.semanticAst.outputs[0].expression.value, 11n);
  assert.equal(result.semanticAst.outputs[1].expression.value, 22n);
  assert.equal(result.semanticAst.outputs[2].expression.value, -1n);
  assert.equal(result.ctx.decompilerPipeline.exactStackPhiRecoveredSites, 2);
  assert.equal(result.metrics.rewrittenExpressions, 2);
}

// Reordering C-AST return nodes cannot change which reaching stack state belongs to a RET.
{
  const result = recoverExactStackPhiExpressions(makeResult(['r2', 'r3', 'r1']));
  const text = byIr(result);
  assert.equal(text.get('r1'), 'return 11;');
  assert.equal(text.get('r2'), 'return 22;');
  assert.equal(text.get('r3'), 'return -1;');
}

// A return-looking node without a proven source RET id is deliberately left untouched.
{
  const result = makeResult();
  result.cAst.body.push({ kind: 'stmt', indent: 1, text: 'return local_8;', semantic: { op: 'return', expression: expr.load(loc, 64), ir: null }, source: source(9, null) });
  recoverExactStackPhiExpressions(result);
  assert.equal(result.cAst.body.at(-1).text, 'return local_8;');
}

console.log('issue #142 return-site recovery regression: ok');
