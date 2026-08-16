import { mergeOriginSets } from '../../core/identity/origin.js';
import {
  V1_OP, sourceInstructionIds, bytesForBits, classifyCallWithAbi, safeBigInt, unique,
  legacyPublicStateIdentity, addUse, attachArgs, defaultUnknownInstruction, baseInstruction, targetAddress,
} from './semantic-ir-v2-to-v1-core.js';
import { projectLegacyAddress } from './semantic-ir-v2-to-v1-address.js';

function constantPayload(node) {
  const attrs = node?.attributes || {};
  const metadata = node?.metadata || {};
  const operation = attrs.machineEffects?.operationMetadata || {};
  const raw = attrs.value ?? attrs.constant ?? attrs.address
    ?? operation.value ?? operation.constant ?? operation.address
    ?? metadata.value ?? metadata.constant ?? metadata.address;
  if (raw == null) return { value: null, float: null, constKind: null };
  const integer = safeBigInt(raw);
  if (integer != null) return { value: integer, float: null, constKind: attrs.constKind ?? metadata.constKind ?? null };
  const number = Number(raw);
  if (Number.isFinite(number)) return { value: null, float: number, constKind: attrs.constKind ?? metadata.constKind ?? 'float' };
  return { value: null, float: null, constKind: null };
}

function operationMetadata(node) { return node?.attributes?.machineEffects?.operationMetadata ?? {}; }
function bundleMetadata(node) { return node?.attributes?.machineEffects?.bundleMetadata ?? {}; }
function machineControl(node) { return node?.attributes?.machineControlEffect ?? null; }

function conditionCode(node) {
  const attrs = node?.attributes || {};
  const op = operationMetadata(node);
  const bundle = bundleMetadata(node);
  return attrs.conditionCode ?? op.conditionCode ?? op.condition ?? bundle.conditionCode ?? null;
}

function comparisonPredicate(node) {
  const attrs = node?.attributes || {};
  const op = operationMetadata(node);
  const direct = attrs.predicate ?? op.predicate ?? attrs.comparison ?? null;
  if (direct != null) return String(direct).toLowerCase();
  const text = String(node?.operator ?? '').toLowerCase();
  const parts = text.split(/[.:/]/);
  return parts.length > 1 ? parts.at(-1) : null;
}

function comparisonSignedness(node) {
  const attrs = node?.attributes || {};
  const op = operationMetadata(node);
  return attrs.signed ?? op.signed ?? null;
}

function conditionFromCompare(node) {
  const predicate = comparisonPredicate(node);
  const signed = comparisonSignedness(node);
  if (predicate === 'eq' || predicate === '==' || predicate === 'equal') return 'eq';
  if (predicate === 'ne' || predicate === '!=' || predicate === 'not-equal') return 'ne';
  if (['lt','<','slt','ult'].includes(predicate)) return predicate === 'ult' || signed === false ? 'lo' : signed === true || predicate === 'slt' ? 'lt' : null;
  if (['le','<=','sle','ule'].includes(predicate)) return predicate === 'ule' || signed === false ? 'ls' : signed === true || predicate === 'sle' ? 'le' : null;
  if (['gt','>','sgt','ugt'].includes(predicate)) return predicate === 'ugt' || signed === false ? 'hi' : signed === true || predicate === 'sgt' ? 'gt' : null;
  if (['ge','>=','sge','uge'].includes(predicate)) return predicate === 'uge' || signed === false ? 'hs' : signed === true || predicate === 'sge' ? 'ge' : null;
  return null;
}

function constForValue(valueId, context) {
  const producer = context.producerByValueId.get(valueId) ?? null;
  return producer?.kind === 'const' ? constantPayload(producer).value : null;
}

function comparisonCarrier(valueId, context, active = new Set()) {
  if (!valueId || active.has(valueId)) return null;
  active.add(valueId);
  const producer = context.producerByValueId.get(valueId) ?? null;
  let result = null;
  if (producer) {
    const direct = context.comparisonCarrierByNodeId.get(producer.id) ?? null;
    if (direct) result = { value: direct, compareNode: producer };
    else if (producer.kind === 'state-read') {
      const use = context.stateProjection.readUseByNodeId.get(producer.id) ?? null;
      const reaching = use == null ? null : context.stateProjection.definitionByValueId.get(use.valueId) ?? null;
      const sourceValueId = reaching?.proof?.sourceSemanticValueId ?? null;
      if (sourceValueId) result = comparisonCarrier(sourceValueId, context, active);
    } else {
      const candidates = [];
      for (const inputId of producer.inputs || []) {
        const candidate = comparisonCarrier(inputId, context, active);
        if (candidate) candidates.push(candidate);
      }
      const uniqueById = new Map(candidates.map((candidate) => [candidate.value.id, candidate]));
      if (uniqueById.size === 1) result = uniqueById.values().next().value;
    }
  }
  active.delete(valueId);
  return result;
}

function zeroCondition(valueId, context) {
  const producer = context.producerByValueId.get(valueId) ?? null;
  if (producer?.kind === 'intrinsic' && producer.operator === 'is-zero' && producer.inputs?.length === 1) {
    return { kind: 'cbz', testedValueId: producer.inputs[0], producer };
  }
  if (producer?.kind === 'intrinsic' && producer.operator === 'not-bool' && producer.inputs?.length === 1) {
    const nested = context.producerByValueId.get(producer.inputs[0]) ?? null;
    if (nested?.kind === 'intrinsic' && nested.operator === 'is-zero' && nested.inputs?.length === 1) {
      return { kind: 'cbnz', testedValueId: nested.inputs[0], producer };
    }
  }
  return null;
}

function localPhysicalStateSource(node, context) {
  const identity = legacyPublicStateIdentity(node.variable);
  if (!identity) return null;
  const current = context.physicalStateCurrent?.get(identity) ?? null;
  if (!current) return null;
  const readBits = context.valuesById.get(node.outputs?.[0])?.bits ?? null;
  const sourceValueId = current.sourceSemanticValueId ?? null;
  const source = sourceValueId == null ? null : context.valuesById.get(sourceValueId) ?? null;
  if (source && source.bits === readBits) return source;
  const producer = sourceValueId == null ? null : context.producerByValueId.get(sourceValueId) ?? null;
  if (producer?.kind === 'zext' && producer.inputs?.length === 1) {
    const inner = context.valuesById.get(producer.inputs[0]) ?? null;
    const fromBits = Number(producer.attributes?.fromBits ?? operationMetadata(producer).fromBits ?? inner?.bits ?? 0) || null;
    const toBits = Number(producer.attributes?.toBits ?? operationMetadata(producer).toBits ?? source?.bits ?? 0) || null;
    if (inner && readBits != null && fromBits === readBits && toBits === source?.bits) return inner;
  }
  if (current.value?.bits === readBits) return current.value;
  return null;
}

function recordPhysicalStateWrite(node, destination, context) {
  const identity = legacyPublicStateIdentity(node.variable);
  if (!identity || !context.physicalStateCurrent) return;
  context.physicalStateCurrent.set(identity, {
    value: destination,
    sourceSemanticValueId: node.inputs?.[0] ?? null,
    origin: node.origin,
  });
}

function clearPhysicalState(variable, context) {
  const identity = legacyPublicStateIdentity(variable);
  if (identity && context.physicalStateCurrent) context.physicalStateCurrent.delete(identity);
}

function addWithCarryOperands(node, context) {
  if (node.operator !== 'add-with-carry' || (node.inputs || []).length < 3) return null;
  const metadata = operationMetadata(node);
  const subtract = metadata.subtract === true;
  const carry = constForValue(node.inputs[2], context);
  if (carry !== (subtract ? 1n : 0n)) return null;
  let rhsId = node.inputs[1];
  if (subtract) {
    const rhsProducer = context.producerByValueId.get(rhsId) ?? null;
    if (rhsProducer?.kind !== 'unary' || rhsProducer.operator !== 'not' || rhsProducer.inputs?.length !== 1) return null;
    rhsId = rhsProducer.inputs[0];
  }
  const lhs = context.valuesById.get(node.inputs[0]) ?? null;
  const rhs = context.valuesById.get(rhsId) ?? null;
  return lhs && rhs ? { lhs, rhs, subtract } : null;
}

function hasRegisterStateWriteForValue(valueId, context) {
  return context.ir.nodes.some((candidate) => candidate.kind === 'state-write'
    && candidate.inputs?.[0] === valueId
    && candidate.variable?.physicalIdentity?.kind === 'register');
}

function deterministicIntrinsicProjection(node, context, inst, setBasic, primaryOutput, inputValues) {
  const op = node.operator;
  if (op === 'not-bool') { setBasic(V1_OP.UN, 'not'); return true; }
  if (op === 'and-bool') { setBasic(V1_OP.BIN, 'and'); return true; }
  if (op === 'or-bool') { setBasic(V1_OP.BIN, 'or'); return true; }
  if (op === 'equal-bool') { setBasic(V1_OP.BIN, 'eq'); return true; }
  if (op === 'is-zero') { setBasic(V1_OP.UN, 'is-zero'); return true; }
  if (op === 'extract-bit' && inputValues.length >= 1) {
    setBasic(V1_OP.BFX, 'extract');
    const bit = operationMetadata(node).bit;
    inst.extra.lsb = Number.isInteger(Number(bit)) ? Number(bit) : null;
    inst.extra.width = 1;
    inst.extra.signed = false;
    return true;
  }
  if (op === 'insert-bits' && inputValues.length >= 2) {
    setBasic(V1_OP.BFI, 'insert');
    const metadata = operationMetadata(node);
    inst.extra.lsb = Number.isInteger(Number(metadata.lsb)) ? Number(metadata.lsb) : null;
    inst.extra.width = Number.isInteger(Number(metadata.fieldWidth ?? metadata.width)) ? Number(metadata.fieldWidth ?? metadata.width) : null;
    inst.extra.bitfieldKind = 'bfi';
    return inst.extra.lsb != null && inst.extra.width != null;
  }
  void context; void primaryOutput;
  return false;
}

function appendComparisonInstruction(node, context, inst, carrier, args, sub, row, blockIndex) {
  if (!carrier || !args.length) return null;
  const cmp = baseInstruction(node, blockIndex, row, context.options);
  cmp.op = V1_OP.CMP;
  cmp.sub = sub;
  cmp.dst = carrier;
  attachArgs(cmp, args);
  cmp.bits = Math.max(1, ...args.map((value) => value.bits || 1));
  cmp.extra = {
    semanticNodeId: node.id,
    widthBits: cmp.bits,
    comparison: 'semantic-flag-result',
    semanticComparisonCarrier: true,
    sourceSemanticValueIds: node.outputs?.slice() ?? [],
    attributes: node.attributes || {},
    completeness: node.completeness,
  };
  carrier.def = cmp;
  return cmp;
}

export function projectNode(node, context) {
  const {
    blockIndex, row, valuesById, ir, nodeById, blockBySemanticId, options,
    stateProjection, comparisonCarrierByNodeId,
  } = context;
  const inst = baseInstruction(node, blockIndex, row, options);
  const inputValues = node.inputs.map((id) => valuesById.get(id)).filter(Boolean);
  const outputValues = node.outputs.map((id) => valuesById.get(id)).filter(Boolean);
  const primaryOutput = outputValues[0] ?? null;
  const attrs = node.attributes || {};
  const opMeta = operationMetadata(node);
  const widthBits = primaryOutput?.bits ?? inputValues[0]?.bits ?? 64;
  const representedExtraValueIds = new Set();
  const extraInstructions = [];
  const setBasic = (op, sub = null, args = inputValues, destination = primaryOutput) => {
    inst.op = op; inst.sub = sub; inst.dst = destination;
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
    case 'copy': case 'bitcast':
      setBasic(V1_OP.MOV, null);
      inst.extra.castKind = node.kind;
      break;
    case 'unary':
      setBasic(V1_OP.UN, node.operator || attrs.operator || 'unknown');
      break;
    case 'binary': {
      setBasic(V1_OP.BIN, node.operator || attrs.operator || 'unknown');
      const carrier = comparisonCarrierByNodeId.get(node.id) ?? null;
      if (carrier) {
        const resultIsWritten = node.outputs?.[0] && hasRegisterStateWriteForValue(node.outputs[0], context);
        if (!resultIsWritten) {
          inst.op = V1_OP.CMP;
          inst.dst = carrier;
          inst.bits = Math.max(1, ...inputValues.map((value) => value.bits || 1));
          inst.extra.comparison = 'semantic-flag-result';
          inst.extra.semanticComparisonCarrier = true;
          carrier.def = inst;
        } else {
          const cmp = appendComparisonInstruction(node, context, inst, carrier, inputValues, inst.sub, row, blockIndex);
          if (cmp) extraInstructions.push(cmp);
        }
      }
      break;
    }
    case 'compare': {
      const sub = opMeta.sub ?? (opMeta.float || attrs.float ? 'fsub' : 'sub');
      setBasic(V1_OP.CMP, sub);
      inst.extra.comparison = comparisonPredicate(node) ?? node.operator ?? null;
      inst.extra.signed = comparisonSignedness(node);
      inst.extra.float = attrs.float === true || opMeta.float === true || inputValues.some((value) => value.machineType?.kind === 'float');
      inst.bits = Math.max(1, ...inputValues.map((value) => value.bits || 1));
      break;
    }
    case 'select': {
      const selected = inputValues.length >= 3 ? inputValues.slice(1, 3) : inputValues.slice(0, 2);
      setBasic(V1_OP.SEL, 'sel', selected);
      const conditionValueId = inputValues.length >= 3 ? node.inputs[0] : null;
      const conditionValue = conditionValueId == null ? null : valuesById.get(conditionValueId) ?? null;
      const carrier = conditionValueId == null ? null : comparisonCarrier(conditionValueId, context);
      inst.cond = conditionCode(node) ?? (carrier?.compareNode?.kind === 'compare' ? conditionFromCompare(carrier.compareNode) : null);
      if (conditionValue) {
        inst.conditionValue = conditionValue;
        addUse(conditionValue, inst);
        inst.extra.conditionValueId = conditionValueId;
      }
      if (carrier?.value) {
        inst.args.push({ value: carrier.value, bits: carrier.value.bits || 1 });
        addUse(carrier.value, inst);
        inst.extra.conditionCarrierValueId = carrier.value.semanticValueId ?? carrier.value.semanticSsaValueId ?? carrier.value.id;
      }
      break;
    }
    case 'zext': {
      // Zero extension preserves the mathematical unsigned value. Legacy v1 has
      // no standalone cast opcode consumed by current analyses, so serialize it
      // as a width-carrying MOV rather than losing the copy/constant chain.
      setBasic(V1_OP.MOV, 'zext');
      inst.extra.castKind = 'zext';
      inst.extra.sourceBits = Number(attrs.fromBits ?? opMeta.fromBits ?? inputValues[0]?.bits ?? 0) || null;
      inst.extra.targetBits = Number(attrs.toBits ?? opMeta.toBits ?? primaryOutput?.bits ?? 0) || null;
      break;
    }
    case 'sext': case 'trunc':
      setBasic(V1_OP.UN, node.kind);
      inst.extra.sourceBits = Number(attrs.fromBits ?? opMeta.fromBits ?? inputValues[0]?.bits ?? 0) || null;
      inst.extra.targetBits = Number(attrs.toBits ?? opMeta.toBits ?? primaryOutput?.bits ?? 0) || null;
      break;
    case 'extract':
      setBasic(V1_OP.BFX, 'extract');
      inst.extra.lsb = attrs.lsb ?? attrs.offset ?? opMeta.lsb ?? opMeta.bit ?? null;
      inst.extra.width = attrs.width ?? attrs.fieldWidth ?? opMeta.width ?? opMeta.fieldWidth ?? primaryOutput?.bits ?? null;
      inst.extra.signed = attrs.signed === true || opMeta.signed === true;
      break;
    case 'insert':
      setBasic(V1_OP.BFI, 'insert');
      inst.extra.lsb = attrs.lsb ?? attrs.offset ?? opMeta.lsb ?? null;
      inst.extra.width = attrs.width ?? attrs.fieldWidth ?? opMeta.width ?? opMeta.fieldWidth ?? null;
      inst.extra.bitfieldKind = attrs.bitfieldKind ?? opMeta.bitfieldKind ?? 'bfi';
      break;
    case 'concat': {
      const unknown = defaultUnknownInstruction(node, blockIndex, row, options, { reason: 'semantic-ir-v2-concat-not-representable-in-v1' });
      Object.assign(inst, unknown, { semanticNodeId: node.id, sourceEntityId: node.id, sourceEffectIds: node.sourceEffectIds.slice(), instructionId: sourceInstructionIds(node.origin)[0] ?? null, sourceInstructionIds: sourceInstructionIds(node.origin), origin: node.origin });
      inst.dst = primaryOutput; attachArgs(inst, inputValues); break;
    }
    case 'state-read': {
      const use = stateProjection.readUseByNodeId.get(node.id) ?? null;
      const canonical = use == null ? null : valuesById.get(use.valueId) ?? null;
      const canonicalDefinition = use == null ? null : stateProjection.definitionByValueId.get(use.valueId) ?? null;
      const local = canonicalDefinition?.proof?.kind === 'implicit-undef' ? localPhysicalStateSource(node, context) : null;
      const reaching = local ?? canonical;
      setBasic(V1_OP.MOV, null, reaching ? [reaching] : []);
      inst.extra.stateRead = node.variable;
      inst.extra.publicStateIdentity = legacyPublicStateIdentity(node.variable);
      inst.extra.reachingStateSsaValueId = use?.valueId ?? null;
      inst.extra.stateReadProof = use?.proof ?? null;
      inst.extra.localPhysicalViewProjection = local != null;
      if (!reaching) inst.extra.entryStateRead = true;
      break;
    }
    case 'state-write': {
      const definition = stateProjection.writeDefinitionByNodeId.get(node.id) ?? null;
      const source = inputValues[0] ?? null;
      const destination = definition == null ? null : valuesById.get(definition.valueId) ?? null;
      const provenAssignment = definition?.kind === 'definition'
        && definition.proof?.sourceSemanticValueId === node.inputs?.[0]
        && source != null && destination != null;
      if (provenAssignment) {
        setBasic(V1_OP.MOV, null, [source], destination);
        inst.extra.stateWrite = node.variable;
        inst.extra.publicStateIdentity = legacyPublicStateIdentity(node.variable);
        inst.extra.stateSsaDefinitionId = definition.definitionId;
        inst.extra.stateWriteProof = definition.proof ?? null;
        destination.def = inst;
        recordPhysicalStateWrite(node, destination, context);
      } else {
        setBasic(V1_OP.CLOBBER, null, inputValues, null);
        const identity = legacyPublicStateIdentity(node.variable);
        inst.clobbers = identity ? [identity] : [];
        inst.extra.clobbers = inst.clobbers.slice();
        inst.extra.stateWrite = node.variable;
        inst.extra.publicStateIdentity = identity;
        inst.extra.reason = 'semantic-state-write-assignment-not-proven';
        clearPhysicalState(node.variable, context);
      }
      break;
    }
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
      const addressValueId = node.memory.addressExpr.valueId;
      const addressValue = valuesById.get(addressValueId) ?? null;
      const nonAddressInputs = inputValues.filter((value) => value !== addressValue);
      attachArgs(inst, nonAddressInputs);
      if (addressValue) addUse(addressValue, inst);
      inst.addr = projectLegacyAddress(addressValueId, node.memory, context);
      if (inst.addr.base && inst.addr.base !== addressValue) addUse(inst.addr.base, inst);
      if (inst.addr.index) addUse(inst.addr.index, inst);
      inst.extra = { semanticNodeId: node.id, size: bytesForBits(node.memory.widthBits), widthBits: node.memory.widthBits,
        signed: attrs.signed === true || opMeta.signed === true, memoryAccess: node.memory, completeness: node.completeness,
        addressPrecise: inst.addr.precise, addressOrigin: inst.addr.origin };
      break;
    }
    case 'store': {
      inst.op = V1_OP.STORE; inst.sub = null; inst.dst = null;
      const addressValueId = node.memory.addressExpr.valueId;
      const addressValue = valuesById.get(addressValueId) ?? null;
      const stored = inputValues.filter((value) => value !== addressValue);
      attachArgs(inst, stored);
      if (addressValue) addUse(addressValue, inst);
      inst.addr = projectLegacyAddress(addressValueId, node.memory, context);
      if (inst.addr.base && inst.addr.base !== addressValue) addUse(inst.addr.base, inst);
      if (inst.addr.index) addUse(inst.addr.index, inst);
      inst.extra = { semanticNodeId: node.id, size: bytesForBits(node.memory.widthBits), widthBits: node.memory.widthBits,
        memoryAccess: node.memory, completeness: node.completeness,
        addressPrecise: inst.addr.precise, addressOrigin: inst.addr.origin };
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
        clobbers: unique([...abi.clobbers, ...node.call.stateWrites.map((state) => legacyPublicStateIdentity(state) ?? state.key)]),
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
      for (const state of node.call.stateWrites || []) clearPhysicalState(state, context);
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
      const conditionValueId = node.inputs[0] ?? null;
      const semanticConditionValue = conditionValueId == null ? null : valuesById.get(conditionValueId) ?? null;
      const zero = conditionValueId == null ? null : zeroCondition(conditionValueId, context);
      const carrier = zero ? null : comparisonCarrier(conditionValueId, context);
      const branchArgs = [];
      let kind = 'semantic-condition';
      if (zero) {
        const tested = valuesById.get(zero.testedValueId) ?? null;
        if (tested) branchArgs.push(tested);
        kind = zero.kind;
      } else if (carrier?.value) {
        branchArgs.push(carrier.value);
        kind = 'cond';
      } else if (semanticConditionValue) branchArgs.push(semanticConditionValue);
      setBasic(V1_OP.CBR, null, branchArgs);
      const [taken, fallthrough] = node.targets;
      inst.cond = zero ? null : (conditionCode(node) ?? (carrier?.compareNode?.kind === 'compare' ? conditionFromCompare(carrier.compareNode) : null));
      inst.conditionValue = semanticConditionValue;
      if (semanticConditionValue && !branchArgs.includes(semanticConditionValue)) addUse(semanticConditionValue, inst);
      inst.extra.kind = kind;
      inst.extra.conditionValueId = conditionValueId;
      inst.extra.conditionCarrierValueId = carrier?.value ? (carrier.value.semanticValueId ?? carrier.value.semanticSsaValueId ?? carrier.value.id) : null;
      inst.extra.targetBlockId = taken ?? null;
      inst.extra.fallthroughBlockId = fallthrough ?? null;
      inst.extra.targetBlock = taken == null ? null : blockBySemanticId.get(taken)?.index ?? null;
      inst.extra.fallthroughBlock = fallthrough == null ? null : blockBySemanticId.get(fallthrough)?.index ?? null;
      inst.extra.target = taken == null ? null : targetAddress(taken, blockBySemanticId, nodeById, options);
      inst.extra.fallthrough = fallthrough == null ? null : targetAddress(fallthrough, blockBySemanticId, nodeById, options);
      inst.extra.machineControlEffect = machineControl(node);
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
    case 'intrinsic': {
      const carrier = comparisonCarrierByNodeId.get(node.id) ?? null;
      const addSub = carrier ? addWithCarryOperands(node, context) : null;
      if (carrier && addSub) {
        const resultIsWritten = node.outputs?.[0] && hasRegisterStateWriteForValue(node.outputs[0], context);
        const args = [addSub.lhs, addSub.rhs];
        if (resultIsWritten) {
          setBasic(V1_OP.BIN, addSub.subtract ? 'sub' : 'add', args);
          const cmp = appendComparisonInstruction(node, context, inst, carrier, args, addSub.subtract ? 'sub' : 'add', row, blockIndex);
          if (cmp) extraInstructions.push(cmp);
        } else {
          setBasic(V1_OP.CMP, addSub.subtract ? 'sub' : 'add', args, carrier);
          inst.bits = Math.max(1, ...args.map((value) => value.bits || 1));
          inst.extra.comparison = 'semantic-flag-result';
          inst.extra.semanticComparisonCarrier = true;
          carrier.def = inst;
        }
        for (const value of outputValues) representedExtraValueIds.add(value.semanticValueId);
      } else if (!deterministicIntrinsicProjection(node, context, inst, setBasic, primaryOutput, inputValues)) {
        setBasic(V1_OP.CLOBBER, null);
        inst.extra.intrinsic = node.intrinsic;
        inst.intrinsicId = attrs.intrinsicId ?? node.operator ?? node.id;
        inst.clobbers = node.intrinsic.stateWrites.map((state) => legacyPublicStateIdentity(state) ?? state.key);
        if (node.intrinsic.memoryWrite.scope !== 'none') inst.memoryBarrier = true;
        for (const state of node.intrinsic.stateWrites || []) clearPhysicalState(state, context);
      }
      break;
    }
    default: {
      const unknown = defaultUnknownInstruction(node, blockIndex, row, options);
      Object.assign(inst, unknown, { semanticNodeId: node.id, sourceEntityId: node.id, sourceEffectIds: node.sourceEffectIds.slice(), instructionId: sourceInstructionIds(node.origin)[0] ?? null, sourceInstructionIds: sourceInstructionIds(node.origin), origin: node.origin });
      inst.dst = primaryOutput;
      attachArgs(inst, inputValues);
      if (node.kind === 'unknown-memory-effect') inst.memoryBarrier = true;
      break;
    }
  }

  if (primaryOutput && primaryOutput.def == null && inst.dst === primaryOutput) primaryOutput.def = inst;
  for (const extra of extraInstructions) if (extra.dst && extra.dst.def == null) extra.dst.def = extra;
  const extras = [];
  for (const extraOutput of outputValues.slice(1)) {
    if (representedExtraValueIds.has(extraOutput.semanticValueId)) {
      if (extraOutput.def == null && extraInstructions[0]) extraOutput.def = extraInstructions[0];
      continue;
    }
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
  return [inst, ...extraInstructions, ...extras];
}
