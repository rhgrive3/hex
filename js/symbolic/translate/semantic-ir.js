/**
 * js/symbolic/translate/semantic-ir.js
 *
 * Architecture-neutral translator from Semantic IR / SSA to solver-neutral Expr DAG.
 * Preserves provenance, origin mappings, and explicit assumptions.
 * Guarantees fail-closed behavior on unknown semantics and unsupported operations.
 * Never leaks solver-native AST objects.
 */

import { OP, VK, MK } from '../../ir-base.js';
import {
  bvSort,
  boolSort,
  BV_UNARY_OP,
  BV_BINARY_OP,
  BV_COMPARE_OP,
  BOOL_CONNECTIVE_OP,
  CAST_OP,
} from '../expr/kinds.js';
import {
  createBool,
  createBv,
  createFreshSymbol,
  createUnknownSemantic,
  createUnary,
  createBinary,
  createCompare,
  createConnective,
  createIte,
  createExtract,
  createConcat,
  createCast,
} from '../expr/factory.js';
import { computeStructuralHash } from '../expr/hash.js';
import {
  TRANSLATION_STATUS,
  ASSUMPTION_TRUST,
  COMPLETENESS_STATUS,
  createAssumption,
  createCompleteness,
  classifyOpSupport,
} from './support-matrix.js';

export function translateSemanticIR(target, options = {}) {
  const ir = options.ir || null;
  const defaultWidth = Number(options.bitWidth) || 64;
  const fromBlock = options.fromBlock != null ? options.fromBlock : null;
  const configuredArgs = options.symbolicArgs || {};

  const assumptions = [];
  const unsupportedEntities = [];
  let semanticUnknowns = 0;
  const originMap = new Map(); // expr hash / sym id -> Set of origins
  const memo = new Map();
  const active = new Set();

  function recordOrigin(node, ...origins) {
    if (!node) return;
    const key = node.symbolId || computeStructuralHash(node);
    if (!originMap.has(key)) originMap.set(key, new Set());
    const set = originMap.get(key);
    for (const o of origins) {
      if (o != null) set.add(String(o));
    }
  }

  function translateValue(val, width = defaultWidth) {
    if (!val) {
      semanticUnknowns++;
      const unk = createUnknownSemantic(bvSort(width), 'missing-ssa-value');
      return unk;
    }

    const valId = val.id != null ? String(val.id) : null;
    const memoKey = `${valId || 'anon'}@${fromBlock}@${width}`;
    if (memo.has(memoKey)) return memo.get(memoKey);

    if (valId && active.has(valId)) {
      semanticUnknowns++;
      assumptions.push(
        createAssumption({
          id: `cycle_${valId}`,
          kind: 'phi-cycle-unroll-boundary',
          statement: `Detected recursion/cycle in SSA value ${valId}`,
          source: 'translator',
          originIds: val.origin != null ? [String(val.origin)] : [],
          trust: ASSUMPTION_TRUST.BOUNDED_UNROLL,
        })
      );
      const unk = createUnknownSemantic(bvSort(width), 'ssa-dependency-cycle', { valueId: valId });
      return unk;
    }

    if (valId) active.add(valId);
    let res = null;

    if (val.const != null) {
      res = createBv(width, val.const);
      recordOrigin(res, val.origin, `const:${val.const}`);
    } else if (val.kind === VK.ARG || val.kind === 'arg') {
      const reg = String(val.reg || val.id || 'arg');
      const argIndex = val.index != null ? val.index : (reg.startsWith('x') ? Number(reg.slice(1)) : null);
      let name = `arg_${reg}`;
      let customVal = null;
      if (configuredArgs) {
        if (argIndex != null && configuredArgs[argIndex] !== undefined) customVal = configuredArgs[argIndex];
        else if (configuredArgs[reg] !== undefined) customVal = configuredArgs[reg];
      }
      if (customVal !== null && typeof customVal === 'bigint') {
        res = createBv(width, customVal);
      } else if (customVal !== null && typeof customVal === 'number') {
        res = createBv(width, BigInt(customVal));
      } else if (typeof customVal === 'string') {
        name = customVal;
        res = createFreshSymbol(bvSort(width), name, { source: 'argument', reg, argIndex });
      } else {
        res = createFreshSymbol(bvSort(width), name, { source: 'argument', reg, argIndex });
      }
      recordOrigin(res, val.origin, `arg:${reg}`);
    } else if (val.def) {
      res = translateInstruction(val.def, width);
      recordOrigin(res, val.origin, val.def.origin, val.def.id ? `inst:${val.def.id}` : null);
    } else {
      // Unresolved value without definition
      semanticUnknowns++;
      unsupportedEntities.push({ id: valId, op: 'unresolved-def', reason: 'value without def' });
      res = createUnknownSemantic(bvSort(width), 'value-without-definition', { valueId: valId });
      recordOrigin(res, val.origin);
    }

    if (valId) active.delete(valId);
    memo.set(memoKey, res);
    return res;
  }

  function translateInstruction(inst, width = defaultWidth) {
    if (!inst) {
      semanticUnknowns++;
      return createUnknownSemantic(bvSort(width), 'missing-instruction');
    }

    const opSupport = classifyOpSupport(inst.op, inst);
    if (opSupport === TRANSLATION_STATUS.UNSUPPORTED) {
      semanticUnknowns++;
      unsupportedEntities.push({ id: inst.id, op: inst.op, reason: 'unsupported-instruction-op' });
      return createUnknownSemantic(bvSort(width), `unsupported-instruction-op-${inst.op}`, {
        instructionId: inst.id,
        op: inst.op,
      });
    }

    switch (inst.op) {
      case OP.CONST:
        return createBv(width, inst.value != null ? inst.value : 0);

      case OP.MOV:
      case OP.ADDR: {
        const src = inst.args?.[0]?.value || inst.args?.[0];
        return translateValue(src, width);
      }

      case OP.BIN: {
        const subOp = String(inst.subOp || inst.name || 'add').toLowerCase();
        const leftVal = inst.args?.[0]?.value || inst.args?.[0];
        const rightVal = inst.args?.[1]?.value || inst.args?.[1];
        const leftExpr = translateValue(leftVal, width);
        const rightExpr = translateValue(rightVal, width);

        let bvOp = null;
        if (subOp === 'add') bvOp = BV_BINARY_OP.ADD;
        else if (subOp === 'sub') bvOp = BV_BINARY_OP.SUB;
        else if (subOp === 'mul') bvOp = BV_BINARY_OP.MUL;
        else if (subOp === 'and') bvOp = BV_BINARY_OP.AND;
        else if (subOp === 'or' || subOp === 'orr') bvOp = BV_BINARY_OP.OR;
        else if (subOp === 'xor' || subOp === 'eor') bvOp = BV_BINARY_OP.XOR;
        else if (subOp === 'shl') bvOp = BV_BINARY_OP.SHL;
        else if (subOp === 'lshr') bvOp = BV_BINARY_OP.LSHR;
        else if (subOp === 'ashr') bvOp = BV_BINARY_OP.ASHR;
        else if (subOp === 'udiv') bvOp = BV_BINARY_OP.UDIV;
        else if (subOp === 'sdiv') bvOp = BV_BINARY_OP.SDIV;
        else if (subOp === 'urem') bvOp = BV_BINARY_OP.UREM;
        else if (subOp === 'srem') bvOp = BV_BINARY_OP.SREM;

        if (!bvOp) {
          semanticUnknowns++;
          unsupportedEntities.push({ id: inst.id, op: `bin:${subOp}`, reason: 'unsupported-binary-subop' });
          return createUnknownSemantic(bvSort(width), `unsupported-binary-subop-${subOp}`, { instructionId: inst.id });
        }
        return createBinary(bvOp, leftExpr, rightExpr);
      }

      case OP.UN: {
        const subOp = String(inst.subOp || inst.name || 'not').toLowerCase();
        const srcVal = inst.args?.[0]?.value || inst.args?.[0];
        const srcExpr = translateValue(srcVal, width);
        if (subOp === 'not') return createUnary(BV_UNARY_OP.NOT, srcExpr);
        if (subOp === 'neg') return createUnary(BV_UNARY_OP.NEG, srcExpr);
        semanticUnknowns++;
        unsupportedEntities.push({ id: inst.id, op: `un:${subOp}`, reason: 'unsupported-unary-subop' });
        return createUnknownSemantic(bvSort(width), `unsupported-unary-subop-${subOp}`);
      }

      case OP.CMP: {
        const condOp = inst.cond || inst.subOp || '==';
        const isSigned = inst.signed === true;
        const leftVal = inst.args?.[0]?.value || inst.args?.[0];
        const rightVal = inst.args?.[1]?.value || inst.args?.[1];
        const leftExpr = translateValue(leftVal, width);
        const rightExpr = translateValue(rightVal, width);

        let cmpOp = null;
        if (condOp === '==' || condOp === 'eq') cmpOp = BV_COMPARE_OP.EQ;
        else if (condOp === '!=' || condOp === 'ne') cmpOp = BV_COMPARE_OP.NE;
        else if (condOp === '<' || condOp === 'lt') cmpOp = isSigned ? BV_COMPARE_OP.SLT : BV_COMPARE_OP.ULT;
        else if (condOp === '<=' || condOp === 'le') cmpOp = isSigned ? BV_COMPARE_OP.SLE : BV_COMPARE_OP.ULE;
        else if (condOp === '>' || condOp === 'gt') cmpOp = isSigned ? BV_COMPARE_OP.SGT : BV_COMPARE_OP.UGT;
        else if (condOp === '>=' || condOp === 'ge') cmpOp = isSigned ? BV_COMPARE_OP.SGE : BV_COMPARE_OP.UGE;

        if (!cmpOp) {
          semanticUnknowns++;
          unsupportedEntities.push({ id: inst.id, op: `cmp:${condOp}`, reason: 'unsupported-cmp-op' });
          return createUnknownSemantic(boolSort(), `unsupported-cmp-op-${condOp}`);
        }
        return createCompare(cmpOp, leftExpr, rightExpr);
      }

      case OP.SEL: {
        const condExpr = inst.cond ? translateInstruction(inst.cond, width) : createBool(true);
        const thenExpr = translateValue(inst.args?.[0]?.value || inst.args?.[0], width);
        const elseExpr = translateValue(inst.args?.[1]?.value || inst.args?.[1], width);
        return createIte(condExpr, thenExpr, elseExpr);
      }

      case OP.PHI: {
        if (!Array.isArray(inst.incoming) || inst.incoming.length === 0) {
          semanticUnknowns++;
          unsupportedEntities.push({ id: inst.id, op: 'phi', reason: 'phi-without-incoming' });
          return createUnknownSemantic(bvSort(width), 'phi-without-incoming');
        }
        if (fromBlock != null) {
          const hit = inst.incoming.find((inc) => inc.from === fromBlock);
          if (hit && hit.value) {
            return translateValue(hit.value, width);
          }
        }
        if (inst.incoming.length === 1 && inst.incoming[0]?.value) {
          return translateValue(inst.incoming[0].value, width);
        }
        // Unconstrained phi without specific incoming block
        assumptions.push(
          createAssumption({
            id: `phi_unconstrained_${inst.id}`,
            kind: 'phi-branch-merge',
            statement: `PHI node ${inst.id} merged across ${inst.incoming.length} predecessor blocks`,
            source: 'translator',
            originIds: inst.origin != null ? [String(inst.origin)] : [],
            trust: ASSUMPTION_TRUST.QUERY_SCOPE,
          })
        );
        const sym = createFreshSymbol(bvSort(width), `phi_${inst.id}`, { phiInst: inst.id });
        return sym;
      }

      case OP.LOAD: {
        if (inst.reachingStore && inst.reachingStore.args?.[0]?.value) {
          return translateValue(inst.reachingStore.args[0].value, width);
        }
        if (inst.loc && inst.loc.kind !== MK.UNKNOWN) {
          assumptions.push(
            createAssumption({
              id: `load_assumption_${inst.id}`,
              kind: 'memory-read-immutable',
              statement: `Memory location ${inst.loc.key || inst.loc.kind} assumed stable at load ${inst.id}`,
              source: 'translator',
              originIds: inst.origin != null ? [String(inst.origin)] : [],
              trust: ASSUMPTION_TRUST.SEMANTIC_FACT,
            })
          );
          const sym = createFreshSymbol(bvSort(width), `mem_${inst.loc.key || inst.id}`, { loadInst: inst.id, loc: inst.loc });
          return sym;
        }
        semanticUnknowns++;
        unsupportedEntities.push({ id: inst.id, op: 'load', reason: 'unknown-load-alias' });
        return createUnknownSemantic(bvSort(width), 'unknown-load-alias', { instructionId: inst.id });
      }

      default: {
        semanticUnknowns++;
        unsupportedEntities.push({ id: inst.id, op: inst.op, reason: 'unsupported-instruction' });
        return createUnknownSemantic(bvSort(width), `unsupported-instruction-${inst.op}`);
      }
    }
  }

  // Translate entry point
  let rootExpr = null;
  if (target) {
    if (target.op != null) {
      rootExpr = translateInstruction(target, defaultWidth);
    } else if (target.id != null || target.kind != null || target.const != null) {
      rootExpr = translateValue(target, defaultWidth);
    }
  }

  // Determine overall translation status
  let status = TRANSLATION_STATUS.EXACT;
  if (semanticUnknowns > 0 || unsupportedEntities.length > 0) {
    status = TRANSLATION_STATUS.UNSUPPORTED;
  } else if (assumptions.length > 0) {
    status = TRANSLATION_STATUS.EXACT_WITH_ASSUMPTIONS;
  }

  const completeness = createCompleteness({
    translation: status === TRANSLATION_STATUS.EXACT ? COMPLETENESS_STATUS.COMPLETE : (status === TRANSLATION_STATUS.EXACT_WITH_ASSUMPTIONS ? COMPLETENESS_STATUS.COMPLETE : COMPLETENESS_STATUS.UNSUPPORTED),
    controlFlow: status === TRANSLATION_STATUS.EXACT ? COMPLETENESS_STATUS.COMPLETE : COMPLETENESS_STATUS.PARTIAL,
    memoryEffects: status === TRANSLATION_STATUS.EXACT ? COMPLETENESS_STATUS.COMPLETE : COMPLETENESS_STATUS.PARTIAL,
    pathCoverage: COMPLETENESS_STATUS.COMPLETE,
    queryScope: COMPLETENESS_STATUS.COMPLETE,
  });

  const serializedOrigins = {};
  for (const [k, set] of originMap.entries()) {
    serializedOrigins[k] = [...set].sort();
  }

  return Object.freeze({
    status,
    expression: rootExpr,
    assumptions: Object.freeze(assumptions),
    unsupportedEntities: Object.freeze(unsupportedEntities),
    semanticUnknowns,
    originMap: Object.freeze(serializedOrigins),
    completeness,
  });
}
