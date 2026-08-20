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
import { TypeConstraintGraph } from '../../analysis/types/graph.js';
import { createAnalysisStatus } from '../../analysis/status.js';
import {
  createFunctionSummary,
  createMemoryEffect,
  createUnknownCallEffect,
} from '../../analysis/summary/contract.js';
import { condenseCallGraph } from '../../analysis/summary/interprocedural.js';
import { expr, node, sourceOf } from '../../decompiler/ast/nodes.js';
import { printProgram, printExpression } from '../../decompiler/pretty/c.js';

export const MANAGED_BRIDGE_VERSION = '1.0.0';

function fail(code) { throw new TypeError(code); }

function safeIdent(s, fallback = 'value') {
  const x = String(s || '').replace(/^_+/, '').replace(/[^A-Za-z0-9_$]/g, '_').replace(/^([0-9])/, '_$1');
  return x || fallback;
}

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
  for (let bi = 0; bi < sortedLeaderOffsets.length; bi++) {
    const off = sortedLeaderOffsets[bi];
    const blockId = `bb_0x${off.toString(16)}`;
    blockByOffset.set(off, blockId);
  }

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
      if (b.completeness === 'unknown') {
        nodeKind = 'barrier';
      } else if (b.memoryEffects && b.memoryEffects.length > 0) {
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
          nodeKind = 'barrier';
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

      const completeness = b.completeness === 'exact' ? 'complete' : b.completeness === 'unknown' ? 'unknown' : 'partial';
      const nodePayload = {
        id: mainNodeId,
        blockId: blkId,
        kind: nodeKind,
        inputs: allInputs,
        outputs: opOutputs,
        origin: nodeOrigin,
        sourceEffectIds: [b.operationId],
        completeness,
      };

      if (completeness !== 'complete') {
        nodePayload.unknown = {
          reason: b.unknownEffects?.[0]?.reason || (b.completeness === 'unknown' ? 'unknown-vm-effect' : 'partial-vm-effect'),
          categories: b.unknownEffects?.[0]?.categories || ['other'],
        };
      }

      if (targets.length > 0) {
        nodePayload.targets = targets;
      }

      if (nodeKind === 'call' && b.callEffects?.[0]) {
        const ce = b.callEffects[0];
        const isComplete = !ce.unresolved && ce.target;
        nodePayload.call = createSemanticCallSummary({
          targetEntityIds: ce.target ? [String(ce.target)] : [],
          arguments: allInputs,
          returns: opOutputs,
          memoryRead: { scope: isComplete ? 'none' : 'all', addressSpaces: isComplete ? undefined : ['memory'] },
          memoryWrite: { scope: isComplete ? 'none' : 'all', addressSpaces: isComplete ? undefined : ['memory'] },
          determinism: 'input-dependent',
          noreturn: false,
          mayThrow: isComplete ? false : 'unknown',
          summarySource: `vm-effect-${frontendId}`,
          completeness: isComplete ? 'complete' : 'partial',
          unknownEffects: isComplete ? null : {
            reason: `unresolved-managed-call:${ce.dispatchKind || 'unknown'}`,
            categories: ['other'],
          },
        });
      }

      if ((nodeKind === 'load' || nodeKind === 'store') && b.memoryEffects?.[0]) {
        const me = b.memoryEffects[0];
        nodePayload.memory = createSemanticMemoryAccess({
          addressSpace: me.space || 'memory',
          addressValueId: allInputs[0] || 'val_1',
          widthBits: (me.byteWidth || 4) * 8,
          endian: 'little',
          alignment: 1,
        });
      }

      if (b.mnemonic) {
        nodePayload.metadata = { mnemonic: b.mnemonic, opcode: b.opcode };
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

  const isComplete = vmEffectFunction.aggregateCompleteness === 'exact';
  const unknowns = [];
  if (!isComplete) {
    const collectedReasons = new Set();
    for (const b of bundles) {
      if (b.unknownEffects) {
        for (const u of b.unknownEffects) {
          if (u.reason) collectedReasons.add(u.reason);
        }
      }
    }
    if (collectedReasons.size === 0) collectedReasons.add('partial-vm-effects');
    for (const reason of collectedReasons) {
      unknowns.push({ reason, categories: ['other'] });
    }
  }

  const semanticIr = createSemanticIrFunction({
    functionId: methodId,
    entryBlockId: blockByOffset.get(0) || 'bb_0x0',
    blocks: irBlocks,
    nodes: allNodes,
    values: allValues,
    completeness: isComplete ? 'complete' : 'partial',
    unknowns,
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
          if (hId !== b.id && !successors.some((s) => s.to === hId && s.kind === 'exception')) {
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
    exceptionRegions: vmEffectFunction.exceptionRegions || [],
  });
}

/**
 * Phase 9 Solver-backed Verification Hook
 * Connects to Phase 9 SolverBackend contract when provided, or returns accurate deferred status.
 */
export function queryManagedSymbolicVerification(methodId, options = {}) {
  const backend = options.backend || (options.registry?.getDefaultBackend ? options.registry.getDefaultBackend() : null);
  if (!backend) {
    return deepFreeze({
      status: 'deferred',
      reason: 'managed-solver-backend-unbound',
      methodId: String(methodId || ''),
      details: 'Solver-backed verification requires an explicit SolverBackend instance registered or provided in options.backend.',
    });
  }
  if (!options.formulas && !options.constraints && !options.assertions) {
    return deepFreeze({
      status: 'deferred',
      reason: 'managed-symbolic-formulas-unspecified',
      methodId: String(methodId || ''),
      backendId: backend.id,
      details: 'Managed method verification requires symbolic formulas or constraint inputs to query the solver backend.',
    });
  }
  const session = options.session || (typeof backend.createSession === 'function' ? backend.createSession(options) : null);
  return deepFreeze({
    status: 'connected',
    backendId: backend.id,
    methodId: String(methodId || ''),
    session,
  });
}

/**
 * Phase 10 Runtime Providers Hook
 * Connects to Phase 10 RuntimeProvider contract when provided with module identity evidence, or returns accurate deferred status.
 */
export function queryManagedRuntimeProvider(methodId, options = {}) {
  const platform = options.platform || options.runtimePlatform;
  const provider = options.provider || (platform?.current ? platform.current : (platform?.provider ? platform.provider(options.providerId) : null));
  if (!provider) {
    return deepFreeze({
      status: 'deferred',
      reason: 'managed-runtime-provider-unbound',
      methodId: String(methodId || ''),
      details: 'Live runtime inspection requires an attached RuntimeProvider or RuntimeProviderPlatform session with evidence-bound module identity.',
    });
  }
  if (!options.moduleEvidence && !options.sessionBinding && !options.evidence) {
    return deepFreeze({
      status: 'deferred',
      reason: 'managed-runtime-identity-evidence-missing',
      methodId: String(methodId || ''),
      providerId: provider.id || provider.providerId || 'unknown',
      details: 'Managed method inspection requires evidence-bound module identity before binding to live runtime frames.',
    });
  }
  return deepFreeze({
    status: 'connected',
    providerId: provider.id || provider.providerId,
    methodId: String(methodId || ''),
    provider,
  });
}

/**
 * M4 — Build Type Constraint Graph with explicit authority separation.
 */
export function buildManagedTypeConstraintGraph(methodInfo, options = {}) {
  const graph = new TypeConstraintGraph({ snapshotId: options.snapshotId || 'managed-types-v1' });
  const methodId = methodInfo.methodId || methodInfo.id || 'method_0';

  // 1. Authoritative metadata -> Hard constraints
  if (methodInfo.returnType || methodInfo.returnDescriptor) {
    const returnType = methodInfo.returnType || methodInfo.returnDescriptor;
    graph.addHardConstraint({
      kind: 'runtime-metadata-type',
      origin: 'binary-evidence',
      claim: {
        layer: 'nominal',
        entityId: `${methodId}:return`,
        descriptor: { kind: 'nominal', name: String(returnType) },
      },
      evidenceIds: [String(methodId)],
    });
  }

  if (Array.isArray(methodInfo.paramTypes || methodInfo.params)) {
    const params = methodInfo.paramTypes || methodInfo.params;
    for (let i = 0; i < params.length; i++) {
      const pType = params[i];
      graph.addHardConstraint({
        kind: 'runtime-metadata-type',
        origin: 'binary-evidence',
        claim: {
          layer: 'nominal',
          entityId: `${methodId}:param_${i}`,
          descriptor: { kind: typeof pType === 'object' ? (pType.kind || 'primitive') : 'nominal', name: String(pType.name || pType) },
        },
        evidenceIds: [String(methodId)],
      });
    }
  }

  // 2. Debug metadata / heuristics -> Soft evidence (never elevated to hard constraints)
  if (Array.isArray(methodInfo.debugLocalVariables)) {
    for (const d of methodInfo.debugLocalVariables) {
      if (d.name || d.signature || d.type) {
        graph.addSoftEvidence({
          kind: 'signature-candidate',
          origin: 'heuristic',
          claim: {
            layer: 'nominal',
            entityId: `${methodId}:local_${d.slot ?? d.index ?? 0}`,
            descriptor: { kind: 'debug-inferred', name: String(d.signature || d.type || 'unknown'), debugName: d.name },
          },
          weight: 0.85,
          reason: 'debug-symbol-table',
          evidenceIds: [String(methodId)],
        });
      }
    }
  }

  return graph;
}

/**
 * M4 — Build Managed Method Summary.
 */
export function buildManagedMethodSummary(loweredOrFunction, options = {}) {
  let lowered = loweredOrFunction;
  if (loweredOrFunction && Array.isArray(loweredOrFunction.bundles)) {
    lowered = lowerVMEffectsToSemanticIr(loweredOrFunction, options);
  }
  const methodId = lowered.methodId || 'method_0';
  const semanticIr = lowered.semanticIr;
  const cfg = lowered.cfg;

  const directCalls = [];
  const dynamicCalls = [];
  const externalCalls = [];
  const memoryReads = [];
  const memoryWrites = [];
  const unknownCallEffects = [];
  const thrownExceptions = [];

  for (const node of semanticIr.nodes) {
    if (node.kind === 'call' && node.call) {
      const call = node.call;
      const candidates = call.targetEntityIds || [];
      const isComplete = call.completeness === 'complete' && candidates.length === 1;
      if (isComplete) {
        directCalls.push({
          target: candidates[0],
          dispatchKind: 'direct',
          unresolved: false,
          nodeId: node.id,
        });
      } else {
        const isExternal = candidates.some((c) => {
          const lc = String(c).toLowerCase();
          return lc.includes('jni') || lc.includes('host') || lc.includes('import') || lc.includes('native') || lc.includes('pinvoke');
        });
        if (isExternal) {
          externalCalls.push({
            target: candidates[0] || 'external',
            dispatchKind: 'external',
            unresolved: true,
            nodeId: node.id,
          });
          unknownCallEffects.push(createUnknownCallEffect({
            callSiteId: node.id,
            reason: 'unresolved-target',
            targetEntityIds: candidates,
            evidenceIds: [node.id],
          }));
        } else {
          dynamicCalls.push({
            targets: candidates,
            dispatchKind: 'dynamic',
            unresolved: true,
            nodeId: node.id,
          });
          unknownCallEffects.push(createUnknownCallEffect({
            callSiteId: node.id,
            reason: 'indirect-incomplete-target-set',
            targetEntityIds: candidates,
            evidenceIds: [node.id],
          }));
        }
      }
    } else if (node.kind === 'load') {
      memoryReads.push(createMemoryEffect({
        regionKind: 'heap',
        broad: false,
        addressSpaces: ['memory'],
        source: 'instruction',
        evidenceIds: [node.id],
      }));
    } else if (node.kind === 'store') {
      memoryWrites.push(createMemoryEffect({
        regionKind: 'heap',
        broad: false,
        addressSpaces: ['memory'],
        source: 'instruction',
        evidenceIds: [node.id],
      }));
    } else if (node.kind === 'trap') {
      thrownExceptions.push({
        kind: 'trap',
        nodeId: node.id,
      });
    }
  }

  const hasExceptionEdges = cfg.blocks.some((b) => (b.successors || []).some((s) => s.kind === 'exception'));
  const completeness = (unknownCallEffects.length > 0) ? 'partial' : 'complete';

  if (unknownCallEffects.length > 0) {
    memoryWrites.push(createMemoryEffect({
      regionKind: 'unknown',
      broad: true,
      addressSpaces: ['memory'],
      source: 'unknown-call-fallback',
      evidenceIds: unknownCallEffects.map((u) => u.callSiteId),
    }));
  }

  const status = createAnalysisStatus({
    snapshotId: options.snapshotId || 'managed-summary-v1',
    analyzerId: 'managed.method.summary',
    analyzerVersion: '1.0.0',
    completeness,
    stopReason: completeness === 'complete' ? null : 'evidence-missing',
  });

  const summary = createFunctionSummary({
    functionId: methodId,
    status,
    memoryReadRegions: memoryReads,
    memoryWriteRegions: memoryWrites,
    unknownCallEffects,
  });

  return deepFreeze({
    methodId,
    summary,
    directCalls,
    dynamicCalls,
    externalCalls,
    thrownExceptions,
    hasExceptionEdges,
    completeness,
  });
}

/**
 * M4 — Interprocedural analysis across managed methods.
 */
export function analyzeManagedInterprocedural(methods, options = {}) {
  const methodMap = new Map();
  for (const m of methods) {
    const sum = buildManagedMethodSummary(m, options);
    methodMap.set(sum.methodId, sum);
  }

  const roots = [...methodMap.keys()];
  const successorsOf = (id) => {
    const entry = methodMap.get(id);
    if (!entry) return [];
    return entry.directCalls.map((c) => c.target).filter((t) => methodMap.has(t));
  };

  const { components, truncated } = condenseCallGraph(roots, successorsOf, options);

  return deepFreeze({
    components,
    truncated,
    summaries: methodMap,
  });
}

/**
 * M5 — Shared Managed Decompiler.
 * Uses shared decompiler AST and printProgram to produce clean, semantically structured pseudo-C.
 */
export function decompileManagedMethod(loweredOrFunction, options = {}) {
  let lowered = loweredOrFunction;
  if (loweredOrFunction && Array.isArray(loweredOrFunction.bundles)) {
    lowered = lowerVMEffectsToSemanticIr(loweredOrFunction, options);
  }
  const methodId = lowered.methodId || 'managed_method';
  const frontendId = lowered.frontendId || 'wasm';
  const semanticIr = lowered.semanticIr;
  const cfg = lowered.cfg;
  const ssa = lowered.ssa;

  const nodeMap = new Map();
  for (const n of semanticIr.nodes) nodeMap.set(n.id, n);

  const valueMap = new Map();
  for (const v of semanticIr.values) valueMap.set(v.id, v);

  const exprMemo = new Map();

  function buildValueExpr(valId) {
    if (exprMemo.has(valId)) return exprMemo.get(valId);
    const val = valueMap.get(valId);
    if (!val) return expr.variable(`v_${valId}`);

    const defNode = val.definitionNodeId ? nodeMap.get(val.definitionNodeId) : null;
    if (!defNode) {
      if (val.metadata?.constant != null) {
        const c = expr.constant(BigInt(val.metadata.constant), val.machineType?.widthBits || 32);
        exprMemo.set(valId, c);
        return c;
      }
      const vExpr = expr.variable(safeIdent(val.id || `v_${valId}`));
      exprMemo.set(valId, vExpr);
      return vExpr;
    }

    const n = defNode;
    const bits = val.machineType?.widthBits || 32;
    let res = null;

    if (n.kind === 'const') {
      const cVal = val.metadata?.constant != null ? BigInt(val.metadata.constant) : 0n;
      res = expr.constant(cVal, bits);
    } else if (n.kind === 'binary') {
      const left = n.inputs[0] ? buildValueExpr(n.inputs[0]) : expr.constant(0n, bits);
      const right = n.inputs[1] ? buildValueExpr(n.inputs[1]) : expr.constant(0n, bits);
      const mn = (n.metadata?.mnemonic || '').toLowerCase();
      let normalizedOp = 'add';
      if (mn.includes('sub')) normalizedOp = 'sub';
      else if (mn.includes('mul')) normalizedOp = 'mul';
      else if (mn.includes('div')) normalizedOp = 'sdiv';
      else if (mn.includes('rem') || mn.includes('mod')) normalizedOp = 'smod';
      else if (mn.includes('and')) normalizedOp = 'and';
      else if (mn.includes('xor')) normalizedOp = 'xor';
      else if (mn.includes('or')) normalizedOp = 'or';
      else if (mn.includes('shl')) normalizedOp = 'shl';
      else if (mn.includes('shr')) normalizedOp = 'ashr';
      res = expr.binary(normalizedOp, left, right, bits);
    } else if (n.kind === 'compare') {
      const left = n.inputs[0] ? buildValueExpr(n.inputs[0]) : expr.constant(0n, bits);
      const right = n.inputs[1] ? buildValueExpr(n.inputs[1]) : expr.constant(0n, bits);
      const mn = (n.metadata?.mnemonic || '').toLowerCase();
      const op = mn.includes('eq') ? 'eq' : mn.includes('ne') ? 'ne' : mn.includes('le') ? 'le' : mn.includes('ge') ? 'ge' : mn.includes('lt') ? 'lt' : mn.includes('gt') ? 'gt' : 'eq';
      res = expr.compare(op, left, right);
    } else if (n.kind === 'unary') {
      const arg = n.inputs[0] ? buildValueExpr(n.inputs[0]) : expr.constant(0n, bits);
      const mn = (n.metadata?.mnemonic || '').toLowerCase();
      const op = mn.includes('neg') ? 'neg' : mn.includes('not') ? 'not' : 'trunc';
      res = expr.unary(op, arg, bits);
    } else if (n.kind === 'call') {
      const callee = n.call?.targetEntityIds?.[0] || 'callee';
      const args = (n.inputs || []).map(buildValueExpr);
      res = expr.call(callee, args, bits);
    } else if (n.kind === 'load') {
      const base = n.inputs[0] ? buildValueExpr(n.inputs[0]) : expr.variable('base');
      if (n.inputs.length > 1) {
        const idx = buildValueExpr(n.inputs[1]);
        res = expr.index(base, idx, 1, bits);
      } else {
        res = expr.field(base, n.metadata?.fieldName || 'field', 0n, bits);
      }
    } else if (n.kind === 'intrinsic' || n.kind === 'barrier') {
      const args = (n.inputs || []).map(buildValueExpr);
      res = expr.intrinsic(n.metadata?.mnemonic || 'unsupported_intrinsic', args, bits);
    } else if (n.kind === 'state-read') {
      res = expr.variable(safeIdent(val.id || `v_${valId}`));
    } else {
      res = expr.variable(safeIdent(val.id || `v_${valId}`));
    }

    exprMemo.set(valId, res);
    return res;
  }

  const body = [];
  const loopHeaders = new Set();
  for (const blk of cfg.blocks) {
    for (const succ of (blk.successors || [])) {
      if (succ.to === blk.id) loopHeaders.add(blk.id);
    }
  }

  for (let bi = 0; bi < cfg.blocks.length; bi++) {
    const blk = cfg.blocks[bi];
    const isLoop = loopHeaders.has(blk.id);

    if (isLoop) {
      body.push({ kind: 'loop_header', indent: 1, text: 'while (1) {' });
    }

    const irBlock = semanticIr.blocks.find((b) => b.id === blk.id);
    const nodeIds = irBlock ? irBlock.nodeIds : [];

    for (const nid of nodeIds) {
      const n = nodeMap.get(nid);
      if (!n) continue;

      if (n.kind === 'call') {
        const callee = n.call?.targetEntityIds?.[0] || 'callee';
        const args = (n.inputs || []).map((i) => printExpression(buildValueExpr(i))).join(', ');
        if (n.outputs && n.outputs.length > 0) {
          const outVal = n.outputs[0];
          body.push({ kind: 'call_assign', indent: isLoop ? 2 : 1, text: `${safeIdent(outVal)} = ${callee}(${args});` });
        } else {
          body.push({ kind: 'call_stmt', indent: isLoop ? 2 : 1, text: `${callee}(${args});` });
        }
      } else if (n.kind === 'store') {
        const base = n.inputs[0] ? printExpression(buildValueExpr(n.inputs[0])) : 'base';
        if (n.inputs.length > 2) {
          const idx = printExpression(buildValueExpr(n.inputs[1]));
          const val = printExpression(buildValueExpr(n.inputs[2]));
          body.push({ kind: 'array_store', indent: isLoop ? 2 : 1, text: `${base}[${idx}] = ${val};` });
        } else if (n.inputs.length === 2) {
          const val = printExpression(buildValueExpr(n.inputs[1]));
          body.push({ kind: 'field_store', indent: isLoop ? 2 : 1, text: `${base}->${n.metadata?.fieldName || 'field'} = ${val};` });
        }
      } else if (n.kind === 'return') {
        if (n.inputs && n.inputs.length > 0) {
          const retVal = printExpression(buildValueExpr(n.inputs[0]));
          body.push({ kind: 'return', indent: isLoop ? 2 : 1, text: `return ${retVal};` });
        } else {
          body.push({ kind: 'return', indent: isLoop ? 2 : 1, text: 'return;' });
        }
      } else if (n.kind === 'conditional-branch') {
        const cond = n.inputs[0] ? printExpression(buildValueExpr(n.inputs[0])) : 'cond';
        body.push({ kind: 'if', indent: isLoop ? 2 : 1, text: `if (${cond}) {` });
        if (n.targets && n.targets[0]) {
          body.push({ kind: 'goto', indent: isLoop ? 3 : 2, text: `goto ${n.targets[0]};` });
        }
        body.push({ kind: 'if_close', indent: isLoop ? 2 : 1, text: '}' });
      } else if (n.kind === 'trap') {
        body.push({ kind: 'trap', indent: isLoop ? 2 : 1, text: 'throw Exception();' });
      } else if (n.kind === 'intrinsic' || n.kind === 'barrier') {
        const args = (n.inputs || []).map((i) => printExpression(buildValueExpr(i))).join(', ');
        body.push({ kind: 'intrinsic', indent: isLoop ? 2 : 1, text: `${n.metadata?.mnemonic || 'unsupported_intrinsic'}(${args});` });
      } else if (n.outputs && n.outputs.length > 0 && (n.kind === 'binary' || n.kind === 'unary' || n.kind === 'compare' || n.kind === 'const')) {
        const outVal = n.outputs[0];
        const valExpr = printExpression(buildValueExpr(outVal));
        body.push({ kind: 'assign', indent: isLoop ? 2 : 1, text: `${safeIdent(outVal)} = ${valExpr};` });
      }
    }

    if (isLoop) {
      body.push({ kind: 'loop_close', indent: 1, text: '}' });
    }
  }

  const programAst = {
    kind: 'function',
    name: methodId,
    body,
  };

  const printed = printProgram(programAst);

  return deepFreeze({
    methodId,
    frontendId,
    decompiledAst: programAst,
    pseudocode: printed.text,
    lines: printed.lines,
    semanticIr,
    cfg,
    ssa,
  });
}
