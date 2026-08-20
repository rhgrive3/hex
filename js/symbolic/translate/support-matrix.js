/**
 * js/symbolic/translate/support-matrix.js
 *
 * Machine-readable support matrix and taxonomy for Semantic IR to Expr translation.
 * Enforces fail-closed classification across exact, exact-with-assumptions,
 * partial, and unsupported boundaries.
 */

import { OP, MK } from '../../ir-base.js';

export const TRANSLATION_STATUS = Object.freeze({
  EXACT: 'exact',
  EXACT_WITH_ASSUMPTIONS: 'exact_with_assumptions',
  PARTIAL: 'partial',
  UNSUPPORTED: 'unsupported',
});

export const ASSUMPTION_TRUST = Object.freeze({
  SEMANTIC_FACT: 'semantic-fact',
  USER_PRECONDITION: 'user-precondition',
  QUERY_SCOPE: 'query-scope',
  BOUNDED_UNROLL: 'bounded-unroll',
});

export const COMPLETENESS_STATUS = Object.freeze({
  COMPLETE: 'complete',
  PARTIAL: 'partial',
  UNSUPPORTED: 'unsupported',
});

export function createAssumption({ id, kind, statement, source, originIds = [], trust = ASSUMPTION_TRUST.SEMANTIC_FACT }) {
  if (!id || !kind || !statement) {
    throw new TypeError('createAssumption: id, kind, and statement are required');
  }
  if (!Object.values(ASSUMPTION_TRUST).includes(trust)) {
    throw new TypeError(`createAssumption: unknown trust classification '${trust}'`);
  }
  return Object.freeze({
    id: String(id),
    kind: String(kind),
    statement: String(statement),
    source: String(source || 'translator'),
    originIds: Object.freeze([...originIds]),
    trust,
  });
}

export function createCompleteness({
  translation = COMPLETENESS_STATUS.COMPLETE,
  controlFlow = COMPLETENESS_STATUS.COMPLETE,
  memoryEffects = COMPLETENESS_STATUS.COMPLETE,
  pathCoverage = COMPLETENESS_STATUS.COMPLETE,
  queryScope = COMPLETENESS_STATUS.COMPLETE,
} = {}) {
  return Object.freeze({
    translation,
    controlFlow,
    memoryEffects,
    pathCoverage,
    queryScope,
  });
}

export function classifyOpSupport(op, inst = null) {
  if (!op) return TRANSLATION_STATUS.UNSUPPORTED;

  switch (op) {
    case OP.CONST:
    case OP.MOV:
    case OP.ADDR:
      return TRANSLATION_STATUS.EXACT;

    case OP.BIN: {
      const sub = inst?.subOp || inst?.name;
      const supportedBin = ['add', 'sub', 'mul', 'and', 'or', 'orr', 'xor', 'eor', 'shl', 'lshr', 'ashr'];
      if (!sub || supportedBin.includes(sub)) {
        return TRANSLATION_STATUS.EXACT;
      }
      return TRANSLATION_STATUS.UNSUPPORTED;
    }

    case OP.UN: {
      const sub = inst?.subOp || inst?.name;
      const supportedUn = ['not', 'neg'];
      if (!sub || supportedUn.includes(sub)) {
        return TRANSLATION_STATUS.EXACT;
      }
      return TRANSLATION_STATUS.UNSUPPORTED;
    }

    case OP.CMP:
    case OP.SEL:
    case OP.BFX:
    case OP.BFI:
      return TRANSLATION_STATUS.EXACT;

    case OP.LOAD: {
      if (!inst?.loc) return TRANSLATION_STATUS.UNSUPPORTED;
      if (inst.loc.kind === MK.UNKNOWN) return TRANSLATION_STATUS.UNSUPPORTED;
      if (inst.reachingStore) return TRANSLATION_STATUS.EXACT;
      if (inst.loc.kind === MK.STACK || inst.loc.kind === MK.FIELD || inst.loc.kind === MK.GLOBAL) {
        return TRANSLATION_STATUS.EXACT_WITH_ASSUMPTIONS;
      }
      return TRANSLATION_STATUS.PARTIAL;
    }

    case OP.PHI:
      return TRANSLATION_STATUS.EXACT;

    case OP.STORE:
    case OP.CALL:
    case OP.CLOBBER:
    case OP.RET:
    case OP.BR:
    case OP.CBR:
    case OP.UNKNOWN:
    default:
      return TRANSLATION_STATUS.UNSUPPORTED;
  }
}
