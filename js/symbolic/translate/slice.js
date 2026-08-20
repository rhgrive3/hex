/**
 * js/symbolic/translate/slice.js
 *
 * Backward dependency slicing scaffolding for Semantic IR / SSA.
 * Traverses SSA definitions, phi incoming values, and loads within bounded depth.
 * Tracks cycles and generates explicit assumptions when bounds are reached.
 */

import { OP } from '../../ir-base.js';
import {
  createAssumption,
  createCompleteness,
  ASSUMPTION_TRUST,
  COMPLETENESS_STATUS,
} from './support-matrix.js';

export function backwardDependencySlice(target, options = {}) {
  const ir = options.ir || null;
  const maxDepth = Number(options.maxDepth) || 64;
  const fromBlock = options.fromBlock != null ? options.fromBlock : null;

  const reachedValues = new Set();
  const reachedInstructions = new Set();
  const reachedOrigins = new Set();
  const assumptions = [];
  let hasCycle = false;
  let hitDepthLimit = false;

  const activeValues = new Set();
  const activeInstructions = new Set();

  function visitValue(val, depth) {
    if (!val) return;
    const valId = val.id != null ? String(val.id) : null;
    if (valId && activeValues.has(valId)) {
      hasCycle = true;
      assumptions.push(
        createAssumption({
          id: `cycle_assumption_${valId}`,
          kind: 'phi-cycle-unroll-boundary',
          statement: `SSA dependency graph contains cycle at value ${valId}`,
          source: 'slice',
          originIds: val.origin != null ? [String(val.origin)] : [],
          trust: ASSUMPTION_TRUST.BOUNDED_UNROLL,
        })
      );
      return;
    }
    if (valId && reachedValues.has(valId)) return;

    if (depth > maxDepth) {
      hitDepthLimit = true;
      assumptions.push(
        createAssumption({
          id: `depth_limit_${valId || depth}`,
          kind: 'slicing-depth-boundary',
          statement: `Backward slice reached depth limit ${maxDepth}`,
          source: 'slice',
          originIds: val?.origin != null ? [String(val.origin)] : [],
          trust: ASSUMPTION_TRUST.BOUNDED_UNROLL,
        })
      );
      return;
    }

    if (valId) {
      activeValues.add(valId);
    }
    if (val.origin != null) reachedOrigins.add(String(val.origin));

    if (val.def) {
      visitInstruction(val.def, depth + 1);
    }

    if (valId) {
      activeValues.delete(valId);
      reachedValues.add(valId);
    }
  }

  function visitInstruction(inst, depth) {
    if (!inst) return;
    const instId = inst.id != null ? String(inst.id) : null;
    if (instId && activeInstructions.has(instId)) {
      hasCycle = true;
      return;
    }
    if (instId && reachedInstructions.has(instId)) return;

    if (instId) activeInstructions.add(instId);
    if (inst.origin != null) reachedOrigins.add(String(inst.origin));
    if (inst.row != null) reachedOrigins.add(`row:${inst.row}`);

    // If PHI instruction and fromBlock is specified, filter incoming
    if (inst.op === OP.PHI && Array.isArray(inst.incoming)) {
      if (fromBlock != null) {
        const hit = inst.incoming.find((inc) => inc.from === fromBlock);
        if (hit && hit.value) {
          visitValue(hit.value, depth + 1);
        }
      } else {
        for (const inc of inst.incoming) {
          if (inc && inc.value) {
            visitValue(inc.value, depth + 1);
          }
        }
      }
    } else if (Array.isArray(inst.args)) {
      // Traverse instruction arguments
      for (const arg of inst.args) {
        const v = arg && typeof arg === 'object' && 'value' in arg ? arg.value : arg;
        if (v && typeof v === 'object' && (v.id != null || v.def || v.const != null || v.kind)) {
          visitValue(v, depth + 1);
        }
      }
    }

    // Traverse reaching store if load
    if (inst.op === OP.LOAD && inst.reachingStore) {
      visitInstruction(inst.reachingStore, depth + 1);
    }

    if (instId) {
      activeInstructions.delete(instId);
      reachedInstructions.add(instId);
    }
  }

  // Entry point
  if (target) {
    if (target.op != null) {
      visitInstruction(target, 0);
    } else if (target.id != null || target.kind != null || target.const != null) {
      visitValue(target, 0);
    }
  }

  const completeness = createCompleteness({
    translation: hitDepthLimit ? COMPLETENESS_STATUS.PARTIAL : COMPLETENESS_STATUS.COMPLETE,
    controlFlow: hasCycle ? COMPLETENESS_STATUS.PARTIAL : COMPLETENESS_STATUS.COMPLETE,
    memoryEffects: COMPLETENESS_STATUS.COMPLETE,
    pathCoverage: COMPLETENESS_STATUS.COMPLETE,
    queryScope: COMPLETENESS_STATUS.COMPLETE,
  });

  return Object.freeze({
    values: Object.freeze(reachedValues),
    instructions: Object.freeze(reachedInstructions),
    origins: Object.freeze(reachedOrigins),
    hasCycle,
    hitDepthLimit,
    assumptions: Object.freeze(assumptions),
    completeness,
  });
}
