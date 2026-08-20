import { createValueId, deepFreeze, jsonSafe } from '../../core/identity/index.js';
import { appendTransform, createOriginSet, createTransformRecord, mergeOriginSets } from '../../core/identity/origin.js';
import { createSemanticCfg } from '../../semantics/cfg/index.js';
import { createSemanticIrFunction } from '../../semantics/ir/function.js';
import { createSemanticNode, createSemanticValue } from '../../semantics/ir/nodes.js';
import {
  createSemanticCallSummary,
  createSemanticIntrinsicSummary,
  createSemanticMachineType,
  createSemanticMemoryAccess,
  createSemanticVariableRef,
} from '../../semantics/ir/types.js';
import { buildSemanticSsa } from '../../semantics/ssa/build.js';

export const MANAGED_BRIDGE_VERSION = '1.0.0';

function fail(code) { throw new TypeError(code); }

function normalizeMachineType(t) {
  if (!t) return { kind: 'bitvector', widthBits: 32 };
  const kind = t.kind || 'bitvector';
  const widthBits = Number(t.widthBits || t.bits || 32);
  if (kind === 'float') {
    return { kind, widthBits, format: t.format || (widthBits === 64 ? 'binary64' : 'binary32') };
  } else if (kind === 'address') {
    return { kind, widthBits, addressSpace: t.addressSpace || 'memory' };
  } else if (kind === 'predicate') {
    return { kind, widthBits };
  }
  return { kind: 'bitvector', widthBits };
}

export function lowerVMEffectsToSemanticIr(vmEffectFunction, options = {}) {
  if (!vmEffectFunction || !Array.isArray(vmEffectFunction.bundles)) {
    fail('managed-bridge-invalid-function');
  }

  const bundles = vmEffectFunction.bundles;
  const methodId = vmEffectFunction.methodId;
  const frontendId = vmEffectFunction.frontendId;

  // Identify basic block boundaries: entry (0), branch targets, handler entries, and instructions following branches/returns
  const leaderOffsets = new Set([0]);
  const offsetToIndex = new Map();
  for (let i = 0; i < bundles.length; i++) {
    offsetToIndex.set(bundles[i].bytecodeOffset, i);
  }

  for (let i = 0; i < bundles.length; i++) {
    const b = bundles[i];
    for (const c of b.controlEffects) {
      if (c.targetOffset != null && offsetToIndex.has(c.targetOffset)) {
        leaderOffsets.add(c.targetOffset);
      }
      if (Array.isArray(c.targetOffsets)) {
        for (const t of c.targetOffsets) {
          if (offsetToIndex.has(t)) leaderOffsets.add(t);
        }
      }
      if (c.kind === 'branch' || c.kind === 'conditional-branch' || c.kind === 'switch' || c.kind === 'return' || c.kind === 'throw' || c.kind === 'trap') {
        if (i + 1 < bundles.length) {
          leaderOffsets.add(bundles[i + 1].bytecodeOffset);
        }
      }
    }
  }

  for (const exc of (vmEffectFunction.exceptionRegions || [])) {
    if (exc.handlerOffset != null && offsetToIndex.has(exc.handlerOffset)) {
      leaderOffsets.add(exc.handlerOffset);
    }
  }

  const sortedLeaderOffsets = [...leaderOffsets].sort((a, b) => a - b);
  const blockByOffset = new Map();
  const blocks = [];
  for (let bi = 0; bi < sortedLeaderOffsets.length; bi++) {
    const off = sortedLeaderOffsets[bi];
    const blockId = `bb_0x${off.toString(16)}`;
    blockByOffset.set(off, blockId);
  }

  let currentBlockId = blockByOffset.get(0) || 'bb_0x0';
  let currentBlockNodeIds = [];
  const irBlocks = [];
  const allNodes = [];
  const allValues = [];
  let nodeCounter = 0;
  let valCounter = 0;

  function makeValue(machineType, origin, definitionNodeId, metadata = null) {
    valCounter++;
    const vid = createValueId({
      functionId: methodId,
      canonicalDefinitionIdentity: `val_${valCounter}`,
    });
    const valInput = {
      id: vid,
      kind: 'definition',
      machineType: createSemanticMachineType(normalizeMachineType(machineType)),
      definitionNodeId,
      origin,
    };
    if (metadata != null) valInput.metadata = metadata;
    const val = createSemanticValue(valInput);
    allValues.push(val);
    return val;
  }

  const blockBundlesMap = new Map();
  for (const off of sortedLeaderOffsets) {
    blockBundlesMap.set(blockByOffset.get(off), []);
  }

  let currentLeader = 0;
  for (const b of bundles) {
    if (leaderOffsets.has(b.bytecodeOffset)) {
      currentLeader = b.bytecodeOffset;
    }
    const blkId = blockByOffset.get(currentLeader);
    blockBundlesMap.get(blkId).push(b);
  }

  const evalStack = [];

  for (const [blkId, blkBundles] of blockBundlesMap.entries()) {
    currentBlockNodeIds = [];

    for (let bi = 0; bi < blkBundles.length; bi++) {
      const b = blkBundles[bi];
      const nodeOrigin = appendTransform(b.origin, createTransformRecord({
        passId: 'managed-bridge',
        passVersion: MANAGED_BRIDGE_VERSION,
        ruleId: `vm-effect-lower-${frontendId}`,
        proofKind: 'vm-semantics-preservation',
        consumedEntityIds: [b.operationId],
      }));

      // 1. Process location reads (e.g. locals/registers/stack)
      const readValues = [];
      for (const r of b.locationReads) {
        nodeCounter++;
        const readNodeId = `node_${nodeCounter}`;
        const val = makeValue(r.type || { kind: 'bitvector', widthBits: r.bits || 32 }, nodeOrigin, readNodeId);
        const node = createSemanticNode({
          id: readNodeId,
          blockId: blkId,
          kind: 'state-read',
          inputs: [],
          outputs: [val.id],
          variable: createSemanticVariableRef({
            key: `vm:${frontendId}:${r.kind}:${r.index ?? r.name ?? '0'}`,
            kind: 'logical-state',
            scope: 'function',
            physicalIdentity: `${r.kind}:${r.index ?? r.name ?? '0'}`,
          }),
          origin: nodeOrigin,
          sourceEffectIds: [b.operationId],
        });
        allNodes.push(node);
        currentBlockNodeIds.push(node.id);
        readValues.push(val.id);
        evalStack.push(val.id);
      }

      // 2. Process consumed values
      const consumedInputs = [];
      const numConsumed = (b.consumedValues || []).length;
      for (let ci = numConsumed - 1; ci >= 0; ci--) {
        const cv = b.consumedValues[ci];
        if (evalStack.length > 0) {
          consumedInputs.unshift(evalStack.pop());
        } else {
          valCounter++;
          const entryVid = createValueId({
            functionId: methodId,
            canonicalDefinitionIdentity: `entry_${valCounter}`,
          });
          const entryVal = createSemanticValue({
            id: entryVid,
            kind: 'entry',
            machineType: createSemanticMachineType(normalizeMachineType(cv.type || { kind: 'bitvector', widthBits: cv.bits || 32 })),
            origin: nodeOrigin,
          });
          allValues.push(entryVal);
          consumedInputs.unshift(entryVal.id);
        }
      }

      // 3. Process primary operation effects
      nodeCounter++;
      const mainNodeId = `node_${nodeCounter}`;
      let opOutputs = [];
      if (b.producedValues && b.producedValues.length > 0) {
        for (const p of b.producedValues) {
          const v = makeValue(
            p.type || { kind: 'bitvector', widthBits: p.bits || 32 },
            nodeOrigin,
            mainNodeId,
            p.constant != null ? { constant: String(p.constant) } : null,
          );
          opOutputs.push(v.id);
          evalStack.push(v.id);
        }
      }

      const allInputs = [...readValues, ...consumedInputs];
      
      let nodeKind = 'unary';
      let targets = [];
      if (b.memoryEffects && b.memoryEffects.length > 0) {
        nodeKind = b.memoryEffects[0].isWrite ? 'store' : 'load';
      } else if (b.callEffects && b.callEffects.length > 0) {
        nodeKind = 'call';
      } else if (b.controlEffects && b.controlEffects.length > 0) {
        const c = b.controlEffects[0];
        if (c.kind === 'return') nodeKind = 'return';
        else if (c.kind === 'branch') {
          nodeKind = 'branch';
          if (c.targetOffset != null) {
            targets.push(blockByOffset.get(c.targetOffset) || `bb_0x${c.targetOffset.toString(16)}`);
          }
        } else if (c.kind === 'conditional-branch') {
          nodeKind = 'conditional-branch';
          if (c.targetOffset != null) {
            targets.push(blockByOffset.get(c.targetOffset) || `bb_0x${c.targetOffset.toString(16)}`);
          }
          // Also add fallthrough block if next block exists
          const currentIdx = sortedLeaderOffsets.indexOf(sortedLeaderOffsets.find((off) => blockByOffset.get(off) === blkId));
          if (currentIdx >= 0 && currentIdx + 1 < sortedLeaderOffsets.length) {
            targets.push(blockByOffset.get(sortedLeaderOffsets[currentIdx + 1]));
          }
        } else if (c.kind === 'switch') {
          nodeKind = 'switch';
          if (Array.isArray(c.targetOffsets)) {
            for (const to of c.targetOffsets) {
              targets.push(blockByOffset.get(to) || `bb_0x${to.toString(16)}`);
            }
          }
          if (!targets.length) targets.push(blkId);
        } else if (c.kind === 'trap' || c.kind === 'throw') {
          nodeKind = 'trap';
        } else {
          nodeKind = 'intrinsic';
        }
      } else if (b.opcode != null || b.mnemonic) {
        const mn = (b.mnemonic || '').toLowerCase();
        if (mn.includes('add') || mn.includes('sub') || mn.includes('mul') || mn.includes('div') || mn.includes('and') || mn.includes('or') || mn.includes('xor') || mn.includes('shl') || mn.includes('shr') || mn.includes('rem')) {
          nodeKind = 'binary';
        } else if (mn.includes('cmp') || mn.includes('eq') || mn.includes('ne') || mn.includes('lt') || mn.includes('gt') || mn.includes('le') || mn.includes('ge')) {
          nodeKind = 'compare';
        } else if (mn.includes('const')) {
          nodeKind = 'const';
        } else {
          nodeKind = opOutputs.length > 0 ? 'unary' : 'barrier';
        }
      }

      const nodePayload = {
        id: mainNodeId,
        blockId: blkId,
        kind: nodeKind,
        inputs: allInputs,
        outputs: opOutputs,
        origin: nodeOrigin,
        sourceEffectIds: [b.operationId],
      };

      if (targets.length > 0) {
        nodePayload.targets = targets;
      }

      if (nodeKind === 'call' && b.callEffects?.[0]) {
        const ce = b.callEffects[0];
        nodePayload.call = createSemanticCallSummary({
          callCompleteness: ce.unresolved ? 'partial' : 'complete',
          calleeCandidateFunctionIds: ce.target ? [ce.target] : [],
          dispatchKind: ce.dispatchKind || 'direct',
          isTailCall: false,
          arguments: allInputs,
          returns: opOutputs,
        });
      }

      if ((nodeKind === 'load' || nodeKind === 'store') && b.memoryEffects?.[0]) {
        const me = b.memoryEffects[0];
        nodePayload.memory = createSemanticMemoryAccess({
          space: me.space || 'memory',
          byteWidth: me.byteWidth || 4,
          endianness: 'little',
          ordering: 'relaxed',
        });
      }

      const mainNode = createSemanticNode(nodePayload);
      allNodes.push(mainNode);
      currentBlockNodeIds.push(mainNode.id);

      // 4. Process location writes
      for (let wi = 0; wi < b.locationWrites.length; wi++) {
        const w = b.locationWrites[wi];
        nodeCounter++;
        const writeNodeId = `node_${nodeCounter}`;
        let writeInput = opOutputs[wi] || (opOutputs.length > 0 ? opOutputs[0] : (evalStack.length > 0 ? evalStack[evalStack.length - 1] : readValues[0]));
        if (!writeInput) {
          valCounter++;
          const synthVid = createValueId({
            functionId: methodId,
            canonicalDefinitionIdentity: `entry_${valCounter}`,
          });
          const synthVal = createSemanticValue({
            id: synthVid,
            kind: 'entry',
            machineType: createSemanticMachineType(normalizeMachineType(w.type || { kind: 'bitvector', widthBits: w.bits || 32 })),
            origin: nodeOrigin,
          });
          allValues.push(synthVal);
          writeInput = synthVal.id;
        }
        const writeNode = createSemanticNode({
          id: writeNodeId,
          blockId: blkId,
          kind: 'state-write',
          inputs: [writeInput],
          outputs: [],
          variable: createSemanticVariableRef({
            key: `vm:${frontendId}:${w.kind}:${w.index ?? w.name ?? '0'}`,
            kind: 'logical-state',
            scope: 'function',
            physicalIdentity: `${w.kind}:${w.index ?? w.name ?? '0'}`,
          }),
          origin: nodeOrigin,
          sourceEffectIds: [b.operationId],
        });
        allNodes.push(writeNode);
        currentBlockNodeIds.push(writeNode.id);
      }
    }

    irBlocks.push({
      id: blkId,
      nodeIds: currentBlockNodeIds,
      origin: createOriginSet({ parentEntityIds: [methodId] }),
    });
  }

  const semanticIr = createSemanticIrFunction({
    functionId: methodId,
    entryBlockId: blockByOffset.get(0) || 'bb_0x0',
    blocks: irBlocks,
    nodes: allNodes,
    values: allValues,
    completeness: vmEffectFunction.aggregateCompleteness === 'exact' ? 'complete' : 'partial',
    origin: vmEffectFunction.origin,
  }, options);

  // Construct Semantic CFG
  const cfgBlocks = irBlocks.map((b, idx) => {
    const leaderOff = sortedLeaderOffsets[idx];
    const blkBundles = blockBundlesMap.get(b.id) || [];
    const successors = [];
    let hasUncondBranch = false;
    let hasReturn = false;

    for (const bun of blkBundles) {
      for (const ctrl of bun.controlEffects) {
        if (ctrl.kind === 'branch' && ctrl.targetOffset != null) {
          const targetBlk = blockByOffset.get(ctrl.targetOffset);
          if (targetBlk) {
            successors.push({ to: targetBlk, kind: 'branch' });
            hasUncondBranch = true;
          }
        } else if (ctrl.kind === 'conditional-branch') {
          if (ctrl.targetOffset != null) {
            const targetBlk = blockByOffset.get(ctrl.targetOffset);
            if (targetBlk) {
              successors.push({ to: targetBlk, kind: 'conditional-true' });
            }
          }
          if (idx + 1 < irBlocks.length) {
            successors.push({ to: irBlocks[idx + 1].id, kind: 'conditional-false' });
          }
        } else if (ctrl.kind === 'switch' && Array.isArray(ctrl.targetOffsets)) {
          for (let ti = 0; ti < ctrl.targetOffsets.length; ti++) {
            const tgt = ctrl.targetOffsets[ti];
            if (blockByOffset.has(tgt)) {
              successors.push({ to: blockByOffset.get(tgt), kind: 'switch-case' });
            }
          }
        } else if (ctrl.kind === 'return' || ctrl.kind === 'throw' || ctrl.kind === 'trap') {
          hasReturn = true;
        }
      }
    }

    // Add fallthrough edge if not unconditional branch or return
    if (!hasUncondBranch && !hasReturn && idx + 1 < irBlocks.length) {
      if (!successors.some((s) => s.to === irBlocks[idx + 1].id)) {
        successors.push({ to: irBlocks[idx + 1].id, kind: 'fallthrough' });
      }
    }

    // Add exception edges if covered by an exception region
    for (const exc of (vmEffectFunction.exceptionRegions || [])) {
      if (leaderOff >= exc.startOffset && leaderOff < exc.endOffset) {
        if (exc.handlerOffset != null && blockByOffset.has(exc.handlerOffset)) {
          const hId = blockByOffset.get(exc.handlerOffset);
          if (hId !== b.id && !successors.some((s) => s.to === hId)) {
            successors.push({ to: hId, kind: 'exception' });
          }
        }
      }
    }

    return {
      id: b.id,
      successors,
    };
  });

  const semanticCfg = createSemanticCfg({
    functionId: methodId,
    entryBlockId: blockByOffset.get(0) || 'bb_0x0',
    blocks: cfgBlocks,
  }, options);

  // Build SSA
  const semanticSsa = buildSemanticSsa(semanticIr, semanticCfg, options);

  return deepFreeze({
    methodId,
    frontendId,
    semanticIr,
    cfg: semanticCfg,
    ssa: semanticSsa,
  });
}

/**
 * Phase 9 Solver-backed Verification Hook
 * Phase 9 is running in parallel and not yet completed.
 * Managed verification returns an explicit deferred status.
 */
export function queryManagedSymbolicVerification(methodId, options = {}) {
  return deepFreeze({
    status: 'deferred',
    reason: 'phase-9-solver-backed-verification-in-progress',
    methodId: String(methodId || ''),
    details: 'Solver integration will connect to Phase 9 public SolverBackend contract when landed.',
  });
}

/**
 * Phase 10 Runtime Providers Hook
 * Phase 10 is running in parallel and not yet completed.
 * Managed runtime inspection returns an explicit deferred status.
 */
export function queryManagedRuntimeProvider(methodId, options = {}) {
  return deepFreeze({
    status: 'deferred',
    reason: 'phase-10-runtime-providers-in-progress',
    methodId: String(methodId || ''),
    details: 'Runtime inspection and debugging will connect to Phase 10 RuntimeProvider contract when landed.',
  });
}
