import assert from 'node:assert/strict';
import test from 'node:test';

import { OP, MK } from '../../../js/ir-base.js';
import {
  TRANSLATION_STATUS,
  ASSUMPTION_TRUST,
  COMPLETENESS_STATUS,
  classifyOpSupport,
  createAssumption,
  createCompleteness,
} from '../../../js/symbolic/translate/support-matrix.js';

test('support matrix correctly classifies exact, exact-with-assumptions, and unsupported operations', () => {
  // Exact operations
  assert.equal(classifyOpSupport(OP.CONST), TRANSLATION_STATUS.EXACT);
  assert.equal(classifyOpSupport(OP.MOV), TRANSLATION_STATUS.EXACT);
  assert.equal(classifyOpSupport(OP.ADDR), TRANSLATION_STATUS.EXACT);
  assert.equal(classifyOpSupport(OP.BIN, { subOp: 'add' }), TRANSLATION_STATUS.EXACT);
  assert.equal(classifyOpSupport(OP.UN, { subOp: 'not' }), TRANSLATION_STATUS.EXACT);
  assert.equal(classifyOpSupport(OP.CMP), TRANSLATION_STATUS.EXACT);
  assert.equal(classifyOpSupport(OP.SEL), TRANSLATION_STATUS.EXACT);

  // Reaching store load is exact
  assert.equal(
    classifyOpSupport(OP.LOAD, { loc: { kind: MK.STACK, key: 'sp+8' }, reachingStore: { id: 's1' } }),
    TRANSLATION_STATUS.EXACT
  );

  // Stack/field load without reaching store is exact-with-assumptions
  assert.equal(
    classifyOpSupport(OP.LOAD, { loc: { kind: MK.STACK, key: 'sp+8' } }),
    TRANSLATION_STATUS.EXACT_WITH_ASSUMPTIONS
  );

  // Unknown memory location load is unsupported
  assert.equal(
    classifyOpSupport(OP.LOAD, { loc: { kind: MK.UNKNOWN } }),
    TRANSLATION_STATUS.UNSUPPORTED
  );

  // Side-effecting / unsupported ops
  assert.equal(classifyOpSupport(OP.STORE), TRANSLATION_STATUS.UNSUPPORTED);
  assert.equal(classifyOpSupport(OP.CALL), TRANSLATION_STATUS.UNSUPPORTED);
  assert.equal(classifyOpSupport(OP.CLOBBER), TRANSLATION_STATUS.UNSUPPORTED);
  assert.equal(classifyOpSupport(OP.UNKNOWN), TRANSLATION_STATUS.UNSUPPORTED);
});

test('assumptions enforce explicit taxonomy and trust classification', () => {
  const fact = createAssumption({
    id: 'a1',
    kind: 'memory-reaching-def',
    statement: 'stack load reaching store proven',
    source: 'dataflow',
    originIds: ['row:10', 'row:12'],
    trust: ASSUMPTION_TRUST.SEMANTIC_FACT,
  });
  assert.equal(fact.id, 'a1');
  assert.equal(fact.trust, 'semantic-fact');
  assert.deepEqual(fact.originIds, ['row:10', 'row:12']);

  assert.throws(
    () => createAssumption({ id: 'a2', kind: 'test', statement: 'stmt', trust: 'invalid-trust' }),
    TypeError
  );
});

test('completeness dimensions model all 5 critical verification axes', () => {
  const complete = createCompleteness();
  assert.equal(complete.translation, COMPLETENESS_STATUS.COMPLETE);
  assert.equal(complete.controlFlow, COMPLETENESS_STATUS.COMPLETE);
  assert.equal(complete.memoryEffects, COMPLETENESS_STATUS.COMPLETE);
  assert.equal(complete.pathCoverage, COMPLETENESS_STATUS.COMPLETE);
  assert.equal(complete.queryScope, COMPLETENESS_STATUS.COMPLETE);

  const partial = createCompleteness({ translation: COMPLETENESS_STATUS.PARTIAL });
  assert.equal(partial.translation, COMPLETENESS_STATUS.PARTIAL);
});
