import { mergeOriginSets } from '../../core/identity/origin.js';
import {
  V1_OP, sourceInstructionIds, bytesForBits, classifyCallWithAbi, safeBigInt, unique,
  addUse, attachArgs, defaultUnknownInstruction, baseInstruction, targetAddress,
} from './semantic-ir-v2-to-v1-core.js';

function constantPayload(node) {
  const attrs = node?.attributes || {};
  const metadata = node?.metadata || {};
  const raw = attrs.value ?? attrs.constant ?? attrs.address ?? metadata.value ?? metadata.constant ?? metadata.address;
  if (raw == null) return { value: null, float: null, constKind: null };
  const integer = safeBigInt(raw);
  if (integer != null) return { value: integer, float: null, constKind: attrs.constKind ?? metadata.constKind ?? null };
  const number = Number(raw);
  if (Number.isFinite(number)) return { value: null, float: number, constKind: attrs.constKind ?? metadata.constKind ?? 'float' };
  return { value: null, float: null, constKind: null };
}

export function projectNode(node, context) {
  const { blockIndex, row, valuesById, ir, nodeById, blockBySemanticId, options } = context;
  const inst = baseInstruction(node, blockIndex, row, options);
  const inputValues = node.inputs.map((id) => valuesById.get(id)).filter(Boolean);
  const outputValues = node.outputs.map((id) => valuesById.get(id)).filter(Boolean);
  const primaryOutput = outputValues[0] ?? null;
  const attrs = node.attributes || {};
  const widthBits = primaryOutput?.bits ?? inputValues[0]?.bits ?? 64;
  const setBasic = (op, sub = null, args = inputValues) => {
    inst.op = op; inst.sub = sub; inst.dst = primaryOutput;
    attachArgs(inst, args);
    inst.extra = { semanticNodeId: node.id, widthBits, attributes: attrs, completeness: node.completeness };
  };

  switch (node.kind) {
    case 'const': {
      const c = constantPayload(node);
      setBasic(V1_OP.CONST, null, []);
      inst.extra.value = c.value;
      if (c.float != null) { inst.extra.float = c.float; inst.extra.constKind = c.constKind || 'float'; }
      if (primaryOutput && c.value != null) primaryOutput.const = BigInt.asUintN(primaryOutput.bits || 64, c.value);
      if (primaryOutput && c.float != null) { primaryOutput.float = c.float; primaryOutput.floatConst = c.float; primaryOutput.constKind = c.constKind || 'float'; }
      break;
    }
    case 'copy': case 'bitcast': setBasic(V1_OP.MOV, null); inst.extra.castKind = node.kind; break;
    case 'unary': setBasic(V1_OP.UN, node.operator || attrs.operator || 'unknown'); break;
    case 'binary': setBasic(V1_OP.BIN, node.operator || attrs.operator || 'unknown'); break;
    case 'compare':
      setBasic(V1_OP.CMP, attrs.sub ?? (attrs.float ? 'fsub' : 'sub'));
      inst.extra.comparison = node.operator ?? attrs.predicate ?? null;
      inst.extra.signed = attrs.signed ?? null;
      inst.extra.float = attrs.float === true || inputValues.some((value) => value.machineType?.kind === 'float');
      inst.bits = Math.max(1, ...inputValues.map((value) => value.bits || 1));
      break;
    case 'select': {
      const selected = inputValues.length >= 3 ? inputValues.slice(1, 3) : inputValues.slice(0, 2);
      setBasic(V1_OP.SEL, node.operator || 'sel', selected);
      inst.cond = attrs.conditionCode ?? null;
      if (inputValues.length >= 3) {
        inst.conditionValue = inputValues[0];
        addUse(inputValues[0], inst);
        inst.extra.conditionValueId = node.inputs[0];
      }
      break;
    }
    case 'zext': case 'sext': case 'trunc':
      setBasic(V1_OP.UN, node.kind);
      inst.extra.sourceBits = inputValues[0]?.bits ?? null;
      inst.extra.targetBits = primaryOutput?.bits ?? null;
      break;
    case 'extract':
      setBasic(V1_OP.BFX, 'extract');
      inst.extra.lsb = attrs.lsb ?? attrs.offset ?? null;
      inst.extra.width = attrs.width ?? primaryOutput?.bits ?? null;
      inst.extra.signed = attrs.signed === true;
      break;
    case 'insert':
      setBasic(V1_OP.BFI, 'insert');
      inst.extra.lsb = attrs.lsb ?? attrs.offset ?? null;
      inst.extra.width = attrs.width ?? null;
      inst.extra.bitfieldKind = attrs.bitfieldKind ?? 'bfi';
      break;
    case 'concat': {
      const unknown = defaultUnknownInstruction(node, blockIndex, row, options, { reason: 'semantic-ir-v2-concat-not-representable-in-v1' });
      Object.assign(inst, unknown, { semanticNodeId: node.id, sourceEntityId: node.id, sourceEffectIds: node.sourceEffectIds.slice(), instructionId: sourceInstructionIds(node.origin)[0] ?? null, sourceInstructionIds: sourceInstructionIds(node.origin), origin: node.origin });
      inst.dst = primaryOutput; attachArgs(inst, inputValues); break;
    }
    case 'state-read':
      setBasic(V1_OP.MOV, null);
      inst.extra.stateRead = node.variable;
      if (!inst.args.length) inst.extra.entryStateRead = true;
      break;
    case 'state-write':
      if (primaryOutput) setBasic(V1_OP.MOV, null);
      else {
        setBasic(V1_OP.CLOBBER, null);
        inst.clobbers = node.variable ? [node.variable.key] : [];
        inst.extra.clobbers = inst.clobbers.slice();
      }
      inst.extra.stateWrite = node.variable;
      break;
    case 'address': {
      const c = constantPayload(node);
      if (c.value != null) {
        setBasic(V1_OP.ADDR, node.operator || 'address', []);
        inst.extra.value = c.value;
        if (primaryOutput) primaryOutput.const = BigInt.asUintN(primaryOutput.bits || 64, c.value);
      } else {
        setBasic(V1_OP.MOV, null);
        inst.extra.addressSemantic = true;
      }
      break;
    }
    case 'load': {
      inst.op = V1_OP.LOAD; inst.sub = null; inst.dst = primaryOutput;
      const addressValue = valuesById.get(node.memory.addressExpr.valueId) ?? null;
      const nonAddressInputs = inputValues.filter((value) => value !== addressValue);
      attachArgs(inst, nonAddressInputs);
      if (addressValue) addUse(addressValue, inst);
      inst.addr = {
        base: addressValue,
        baseReg: addressValue?.reg ?? null,
        disp: 0n,
        index: null,
        scale: 0,
        extend: null,
        size: bytesForBits(node.memory.widthBits),
        widthBits: node.memory.widthBits,
        stack: false,
        addressSpace: node.memory.addressSpace,
        rawAddressValueId: node.memory.addressExpr.valueId,
      };
      inst.extra = { semanticNodeId: node.id, size: bytesForBits(node.memory.widthBits), widthBits: node.memory.widthBits,
        signed: attrs.signed === true, memoryAccess: node.memory, completeness: node.completeness };
      break;
    }
    case 'store': {
      inst.op = V1_OP.STORE; inst.sub = null; inst.dst = null;
      const addressValue = valuesById.get(node.memory.addressExpr.valueId) ?? null;
      const stored = inputValues.filter((value) => value !== addressValue);
      attachArgs(inst, stored);
      if (addressValue) addUse(addressValue, inst);
      inst.addr = {
        base: addressValue,
        baseReg: addressValue?.reg ?? null,
        disp: 0n,
        index: null,
        scale: 0,
        extend: null,
        size: bytesForBits(node.memory.widthBits),
        widthBits: node.memory.widthBits,
        stack: false,
        addressSpace: node.memory.addressSpace,
        rawAddressValueId: node.memory.addressExpr.valueId,
      };
      inst.extra = { semanticNodeId: node.id, size: bytesForBits(node.memory.widthBits), widthBits: node.memory.widthBits,
        memoryAccess: node.memory, completeness: node.completeness };
      break;
    }
    case 'call': {
      inst.op = V1_OP.CALL; inst.sub = null; inst.dst = primaryOutput;
      const callArgs = node.call.arguments.map((id) => valuesById.get(id)).filter(Boolean);
      attachArgs(inst, callArgs);
      for (const id of node.call.targetValueIds) {
        const value = valuesById.get(id); if (value) addUse(value, inst);
      }
      const targetValues = node.call.targetValueIds.map((id) => valuesById.get(id)).filter(Boolean);
      const directValue = targetValues.find((value) => value.const != null);
      const directTarget = directValue?.const ?? null;
      const abi = classifyCallWithAbi(node, ir, valuesById, options);
      inst.extra = {
        semanticNodeId: node.id,
        target: directTarget,
        targetValueIds: node.call.targetValueIds.slice(),
        targetEntityIds: node.call.targetEntityIds.slice(),
        indirect: directTarget == null,
        callArguments: abi.callArguments,
        stackArguments: abi.stackArguments,
        stackArgsUnknown: abi.stackArgsUnknown,
        stackArgsMayContainPointers: abi.stackArgsMayContainPointers,
        argumentEvidence: abi.argumentEvidence,
        clobbers: unique([...abi.clobbers, ...node.call.stateWrites.map((state) => state.key)]),
        unknownRegisters: abi.adapterStatus !== 'used' && node.call.completeness !== 'complete',
        memoryRead: node.call.memoryRead,
        memoryWrite: node.call.memoryWrite,
        noreturn: node.call.noreturn,
        mayThrow: node.call.mayThrow,
        summarySource: node.call.summarySource,
        returnValueIds: node.call.returns.slice(),
        callCompleteness: node.call.completeness,
        unknownEffects: node.call.unknownEffects,
        abiAdapterStatus: abi.adapterStatus,
      };
      inst.callArguments = abi.callArguments;
      inst.stackArguments = abi.stackArguments;
      inst.stackArgsUnknown = abi.stackArgsUnknown;
      inst.stackArgsMayContainPointers = abi.stackArgsMayContainPointers;
      inst.argumentEvidence = abi.argumentEvidence;
      inst.clobbers = inst.extra.clobbers;
      if (abi.returnReg != null) inst.returnReg = abi.returnReg;
      if (abi.returnBits != null) inst.returnBits = abi.returnBits;
      if (abi.returnEvidence != null) inst.returnEvidence = abi.returnEvidence;
      if (node.call.memoryWrite.scope !== 'none' || node.call.completeness !== 'complete') inst.memoryBarrier = true;
      break;
    }
    case 'return':
      setBasic(V1_OP.RET, null);
      inst.returnValueIds = node.inputs.slice();
      break;
    case 'branch': {
      setBasic(V1_OP.BR, null);
      const targetBlockId = node.targets[0] ?? null;
      inst.extra.targetBlockId = targetBlockId;
      inst.extra.targetBlock = targetBlockId == null ? null : blockBySemanticId.get(targetBlockId)?.index ?? null;
      inst.extra.target = targetBlockId == null ? null : targetAddress(targetBlockId, blockBySemanticId, nodeById, options);
      inst.extra.indirect = inst.extra.target == null && targetBlockId == null;
      break;
    }
    case 'conditional-branch': {
      setBasic(V1_OP.CBR, null);
      const [taken, fallthrough] = node.targets;
      inst.cond = attrs.conditionCode ?? null;
      inst.extra.kind = attrs.kind ?? 'semantic-condition';
      inst.extra.targetBlockId = taken ?? null;
      inst.extra.fallthroughBlockId = fallthrough ?? null;
      inst.extra.targetBlock = taken == null ? null : blockBySemanticId.get(taken)?.index ?? null;
      inst.extra.fallthroughBlock = fallthrough == null ? null : blockBySemanticId.get(fallthrough)?.index ?? null;
      inst.extra.target = taken == null ? null : targetAddress(taken, blockBySemanticId, nodeById, options);
      inst.extra.fallthrough = fallthrough == null ? null : targetAddress(fallthrough, blockBySemanticId, nodeById, options);
      break;
    }
    case 'switch': {
      const unknown = defaultUnknownInstruction(node, blockIndex, row, options, {
        reason: 'semantic-ir-v2-switch-not-representable-in-v1', unknownCategories: ['control'], switchTargets: node.targets.slice(),
      });
      Object.assign(inst, unknown, { semanticNodeId: node.id, sourceEntityId: node.id, sourceEffectIds: node.sourceEffectIds.slice(), instructionId: sourceInstructionIds(node.origin)[0] ?? null, sourceInstructionIds: sourceInstructionIds(node.origin), origin: node.origin });
      attachArgs(inst, inputValues);
      break;
    }
    case 'trap': {
      const unknown = defaultUnknownInstruction(node, blockIndex, row, options, { reason: attrs.reason ?? 'semantic-ir-v2-trap', unknownCategories: ['control', 'faults'] });
      Object.assign(inst, unknown, { semanticNodeId: node.id, sourceEntityId: node.id, sourceEffectIds: node.sourceEffectIds.slice(), instructionId: sourceInstructionIds(node.origin)[0] ?? null, sourceInstructionIds: sourceInstructionIds(node.origin), origin: node.origin });
      attachArgs(inst, inputValues);
      break;
    }
    case 'barrier': {
      const unknown = defaultUnknownInstruction(node, blockIndex, row, options, { reason: 'semantic-ir-v2-memory-barrier', unknownCategories: ['memory'] });
      Object.assign(inst, unknown, { semanticNodeId: node.id, sourceEntityId: node.id, sourceEffectIds: node.sourceEffectIds.slice(), instructionId: sourceInstructionIds(node.origin)[0] ?? null, sourceInstructionIds: sourceInstructionIds(node.origin), origin: node.origin, memoryBarrier: true });
      attachArgs(inst, inputValues);
      break;
    }
    case 'intrinsic':
      setBasic(V1_OP.CLOBBER, null);
      inst.extra.intrinsic = node.intrinsic;
      inst.intrinsicId = attrs.intrinsicId ?? node.operator ?? node.id;
      inst.clobbers = node.intrinsic.stateWrites.map((state) => state.key);
      if (node.intrinsic.memoryWrite.scope !== 'none') inst.memoryBarrier = true;
      break;
    default: {
      const unknown = defaultUnknownInstruction(node, blockIndex, row, options);
      Object.assign(inst, unknown, { semanticNodeId: node.id, sourceEntityId: node.id, sourceEffectIds: node.sourceEffectIds.slice(), instructionId: sourceInstructionIds(node.origin)[0] ?? null, sourceInstructionIds: sourceInstructionIds(node.origin), origin: node.origin });
      inst.dst = primaryOutput;
      attachArgs(inst, inputValues);
      if (node.kind === 'unknown-memory-effect') inst.memoryBarrier = true;
      break;
    }
  }

  if (primaryOutput && primaryOutput.def == null) primaryOutput.def = inst;
  const extras = [];
  for (const extraOutput of outputValues.slice(1)) {
    const extra = defaultUnknownInstruction(node, blockIndex, row, options, {
      reason: 'semantic-ir-v2-extra-output-not-representable-in-v1',
      unknownCategories: ['value'],
      semanticOutputValueId: extraOutput.semanticValueId,
    });
    extra.dst = extraOutput;
    extra.semanticNodeId = `${node.id}:extra:${extraOutput.semanticValueId}`;
    extra.sourceEntityId = node.id;
    extra.sourceEffectIds = node.sourceEffectIds.slice();
    extra.instructionId = sourceInstructionIds(node.origin)[0] ?? null;
    extra.sourceInstructionIds = sourceInstructionIds(node.origin);
    extra.origin = mergeOriginSets(node.origin, extraOutput.origin);
    extraOutput.def = extra;
    extras.push(extra);
  }
  return [inst, ...extras];
}
