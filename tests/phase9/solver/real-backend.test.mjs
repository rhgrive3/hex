import assert from 'node:assert/strict';
import test from 'node:test';

import { bvSort, BV_BINARY_OP, BV_COMPARE_OP, BOOL_CONNECTIVE_OP } from '../../../js/symbolic/expr/kinds.js';
import {
  createBv,
  createBool,
  createBinary,
  createCompare,
  createConnective,
  createFreshSymbol,
  createIte,
  createUnary,
} from '../../../js/symbolic/expr/factory.js';
import { evaluateExpr, EVAL_STATUS } from '../../../js/symbolic/expr/evaluate.js';
import { ExhaustiveBvBackend } from '../../../js/symbolic/solver/exhaustive-backend.js';
import { SOLVER_STATUS } from '../../../js/symbolic/solver/result.js';
import { CLAIM_KIND, VERIFICATION_QUERY_KIND, createVerificationQuery } from '../../../js/symbolic/verify/query.js';
import { validateSatModel } from '../../../js/symbolic/verify/validate-model.js';

const MASK = (width) => (1n << BigInt(width)) - 1n;
const wrap = (value, width) => BigInt.asUintN(width, BigInt(value));
const signed = (value, width) => BigInt.asIntN(width, wrap(value, width));

function oracleBinary(op, a, b, width) {
  const ua = wrap(a, width);
  const ub = wrap(b, width);
  switch (op) {
    case 'add': return wrap(ua + ub, width);
    case 'sub': return wrap(ua - ub, width);
    case 'mul': return wrap(ua * ub, width);
    case 'and': return ua & ub;
    case 'or': return ua | ub;
    case 'xor': return ua ^ ub;
    case 'shl': return ub >= BigInt(width) ? 0n : wrap(ua << ub, width);
    case 'lshr': return ub >= BigInt(width) ? 0n : ua >> ub;
    case 'ashr': return ub >= BigInt(width) ? (signed(a, width) < 0n ? MASK(width) : 0n) : wrap(signed(a, width) >> ub, width);
    default: throw new Error(`unknown oracle binary op ${op}`);
  }
}

function oracleCompare(op, a, b, width) {
  const ua = wrap(a, width);
  const ub = wrap(b, width);
  const sa = signed(a, width);
  const sb = signed(b, width);
  switch (op) {
    case 'eq': return ua === ub;
    case 'ult': return ua < ub;
    case 'ule': return ua <= ub;
    case 'ugt': return ua > ub;
    case 'uge': return ua >= ub;
    case 'slt': return sa < sb;
    case 'sle': return sa <= sb;
    case 'sgt': return sa > sb;
    case 'sge': return sa >= sb;
    default: throw new Error(`unknown oracle compare op ${op}`);
  }
}

function allValues(width) {
  return Array.from({ length: 1 << width }, (_, value) => BigInt(value));
}

function cornerValues(width) {
  const max = MASK(width);
  const minSigned = 1n << BigInt(width - 1);
  return [...new Set([
    0n,
    1n,
    max,
    minSigned,
    max, // -1 in two's-complement form
    BigInt(Math.max(0, width - 1)),
    BigInt(width),
    BigInt(width + 1),
  ].filter((value) => value >= 0n && value <= max).map(String))].map(BigInt);
}

function queryFor(assertion, constraints = []) {
  return createVerificationQuery({
    kind: VERIFICATION_QUERY_KIND.CONDITIONAL_EDGE_FEASIBILITY,
    claimKind: CLAIM_KIND.EDGE_INFEASIBLE,
    targetEntity: 'differential-corpus',
    constraints,
    assertion,
  });
}

async function assertSolverMatches({ backend, width, x, y, a, b, expression, expected }) {
  const constraints = [
    createCompare(BV_COMPARE_OP.EQ, x, createBv(width, a)),
    createCompare(BV_COMPARE_OP.EQ, y, createBv(width, b)),
  ];
  const assertion = expression.sort.kind === 'bool'
    ? (expected ? expression : createConnective(BOOL_CONNECTIVE_OP.NOT, expression))
    : createCompare(BV_COMPARE_OP.EQ, expression, createBv(width, expected));
  const result = await backend.createSession().check(queryFor(assertion, constraints));
  assert.equal(result.status, SOLVER_STATUS.SAT, `real backend rejected correct ${width}-bit model`);
  assert.equal(validateSatModel(queryFor(assertion, constraints), result.model).valid, true);
}

test('real exact backend solves SAT/UNSAT and validates its own model', async () => {
  const backend = new ExhaustiveBvBackend({ maxBvWidth: 8 });
  const x = createFreshSymbol(bvSort(3), 'x');
  const one = createCompare(BV_COMPARE_OP.EQ, x, createBv(3, 1n));
  const query = queryFor(one);
  const sat = await backend.createSession().check(query);
  assert.equal(sat.status, SOLVER_STATUS.SAT);
  assert.equal(validateSatModel(query, sat.model).valid, true);

  const contradiction = queryFor(null, [
    createCompare(BV_COMPARE_OP.EQ, x, createBv(3, 1n)),
    createCompare(BV_COMPARE_OP.EQ, x, createBv(3, 2n)),
  ]);
  const unsat = await backend.createSession().check(contradiction);
  assert.equal(unsat.status, SOLVER_STATUS.UNSAT);
  assert.equal(unsat.model, null);

  const tooWide = createFreshSymbol(bvSort(9), 'too_wide');
  const unsupported = await backend.createSession().check(queryFor(createCompare(BV_COMPARE_OP.EQ, tooWide, createBv(9, 0n))));
  assert.equal(unsupported.status, SOLVER_STATUS.UNSUPPORTED);

  const malformed = {
    kind: 'binary',
    sort: bvSort(2),
    op: 'not-a-bitvector-op',
    left: createBv(2, 0n),
    right: createBv(2, 0n),
  };
  const malformedResult = await backend.createSession().check(queryFor(createCompare(BV_COMPARE_OP.EQ, malformed, createBv(2, 0n))));
  assert.equal(malformedResult.status, SOLVER_STATUS.UNSUPPORTED, 'malformed semantics must not collapse to UNSAT');
});

test('deterministic 1-8 bit evaluator/real-solver/exhaustive differential corpus', async () => {
  const backend = new ExhaustiveBvBackend({ maxBvWidth: 8, maxAssignments: 1 << 20 });
  const binaryOps = [
    ['add', BV_BINARY_OP.ADD],
    ['sub', BV_BINARY_OP.SUB],
    ['mul', BV_BINARY_OP.MUL],
    ['and', BV_BINARY_OP.AND],
    ['or', BV_BINARY_OP.OR],
    ['xor', BV_BINARY_OP.XOR],
    ['shl', BV_BINARY_OP.SHL],
    ['lshr', BV_BINARY_OP.LSHR],
    ['ashr', BV_BINARY_OP.ASHR],
  ];
  const compareOps = [
    ['eq', BV_COMPARE_OP.EQ],
    ['ult', BV_COMPARE_OP.ULT],
    ['ule', BV_COMPARE_OP.ULE],
    ['ugt', BV_COMPARE_OP.UGT],
    ['uge', BV_COMPARE_OP.UGE],
    ['slt', BV_COMPARE_OP.SLT],
    ['sle', BV_COMPARE_OP.SLE],
    ['sgt', BV_COMPARE_OP.SGT],
    ['sge', BV_COMPARE_OP.SGE],
  ];

  for (let width = 1; width <= 8; width++) {
    const values = allValues(width);
    const solverValues = width <= 4 ? values : cornerValues(width);
    for (const [name, op] of binaryOps) {
      for (const a of values) for (const b of values) {
        const x = createFreshSymbol(bvSort(width), `x_${width}_${name}_${a}_${b}`);
        const y = createFreshSymbol(bvSort(width), `y_${width}_${name}_${a}_${b}`);
        const expression = createBinary(op, x, y);
        const evaluated = evaluateExpr(expression, { [x.name]: a, [y.name]: b });
        assert.equal(evaluated.status, EVAL_STATUS.VALUE);
        assert.equal(evaluated.value, oracleBinary(name, a, b, width), `${name} evaluator/oracle mismatch at BV${width}`);
      }
      for (const a of solverValues) for (const b of solverValues) {
        const x = createFreshSymbol(bvSort(width), `sx_${width}_${name}_${a}_${b}`);
        const y = createFreshSymbol(bvSort(width), `sy_${width}_${name}_${a}_${b}`);
        const expression = createBinary(op, x, y);
        const expected = oracleBinary(name, a, b, width);
        const evaluated = evaluateExpr(expression, { [x.name]: a, [y.name]: b });
        assert.equal(evaluated.value, expected);
        await assertSolverMatches({ backend, width, x, y, a, b, expression, expected });
      }
    }

    for (const [name, op] of compareOps) {
      for (const a of values) for (const b of values) {
        const x = createFreshSymbol(bvSort(width), `cx_${width}_${name}_${a}_${b}`);
        const y = createFreshSymbol(bvSort(width), `cy_${width}_${name}_${a}_${b}`);
        const expression = createCompare(op, x, y);
        const evaluated = evaluateExpr(expression, { [x.name]: a, [y.name]: b });
        assert.equal(evaluated.status, EVAL_STATUS.VALUE);
        assert.equal(evaluated.value, oracleCompare(name, a, b, width), `${name} evaluator/oracle mismatch at BV${width}`);
      }
      for (const a of solverValues) for (const b of solverValues) {
        const x = createFreshSymbol(bvSort(width), `scx_${width}_${name}_${a}_${b}`);
        const y = createFreshSymbol(bvSort(width), `scy_${width}_${name}_${a}_${b}`);
        const expression = createCompare(op, x, y);
        const expected = oracleCompare(name, a, b, width);
        await assertSolverMatches({ backend, width, x, y, a, b, expression, expected });
      }
    }

    for (const value of values) {
      for (const [name, op] of [['not', 'not'], ['neg', 'neg']]) {
        const x = createFreshSymbol(bvSort(width), `u_${width}_${name}_${value}`);
        const expression = createUnary(op, x);
        const expected = name === 'not' ? MASK(width) ^ value : wrap(-value, width);
        const evaluated = evaluateExpr(expression, { [x.name]: value });
        assert.equal(evaluated.value, expected);
        const assertion = createCompare(BV_COMPARE_OP.EQ, expression, createBv(width, expected));
        const result = await backend.createSession().check(queryFor(assertion, [createCompare(BV_COMPARE_OP.EQ, x, createBv(width, value))]));
        assert.equal(result.status, SOLVER_STATUS.SAT);
      }
    }

    for (const condition of [false, true]) {
      for (const a of solverValues) for (const b of solverValues) {
        const x = createFreshSymbol(bvSort(width), `ix_${width}_${condition}_${a}_${b}`);
        const y = createFreshSymbol(bvSort(width), `iy_${width}_${condition}_${a}_${b}`);
        const expression = createIte(createBool(condition), x, y);
        const expected = condition ? a : b;
        const evaluated = evaluateExpr(expression, { [x.name]: a, [y.name]: b });
        assert.equal(evaluated.value, expected);
        await assertSolverMatches({ backend, width, x, y, a, b, expression, expected });
      }
    }
  }
});
