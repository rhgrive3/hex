import { mergeOriginSets } from '../../core/identity/origin.js';
import { safeBigInt } from './semantic-ir-v2-to-v1-core.js';

function constantPayload(node) {
  const attrs = node?.attributes || {};
  const metadata = node?.metadata || {};
  return safeBigInt(attrs.value ?? attrs.constant ?? attrs.address ?? metadata.value ?? metadata.constant ?? metadata.address);
}

function mergeOrigins(...origins) {
  const present = origins.filter(Boolean);
  if (!present.length) return null;
  return present.slice(1).reduce((current, origin) => mergeOriginSets(current, origin), present[0]);
}

function extensionToken(kind, fromBits, toBits) {
  if (toBits !== 64) return null;
  if (fromBits === 32) return kind === 'sext' ? 'sxtw' : kind === 'zext' ? 'uxtw' : null;
  return null;
}

function semanticIndexTerm(valueId, context, active) {
  if (!valueId || active.has(valueId)) return null;
  active.add(valueId);
  const { producerByValueId, valuesById, semanticValueById } = context;
  const producer = producerByValueId.get(valueId) ?? null;
  const legacyValue = valuesById.get(valueId) ?? null;
  const semanticValue = semanticValueById.get(valueId) ?? null;
  let result = null;

  if (!producer || producer.kind === 'state-read') {
    if (legacyValue && !legacyValue.unknown && !legacyValue.undefined) {
      result = {
        value: legacyValue,
        scale: 0,
        extend: null,
        signedness: null,
        sourceWidthBits: legacyValue.bits || null,
        targetWidthBits: legacyValue.bits || null,
        origin: mergeOrigins(semanticValue?.origin, producer?.origin),
      };
    }
  } else if ((producer.kind === 'copy' || producer.kind === 'bitcast') && producer.inputs.length === 1) {
    result = semanticIndexTerm(producer.inputs[0], context, active);
  } else if ((producer.kind === 'sext' || producer.kind === 'zext') && producer.inputs.length === 1) {
    const nested = semanticIndexTerm(producer.inputs[0], context, active);
    const source = valuesById.get(producer.inputs[0]);
    const output = valuesById.get(valueId);
    const fromBits = Number(producer.attributes?.fromBits ?? source?.bits ?? 0) || null;
    const toBits = Number(producer.attributes?.toBits ?? output?.bits ?? 0) || null;
    const extend = nested && fromBits != null && toBits != null ? extensionToken(producer.kind, fromBits, toBits) : null;
    if (nested && extend) {
      result = {
        ...nested,
        extend,
        signedness: producer.kind === 'sext' ? 'signed' : 'unsigned',
        sourceWidthBits: fromBits,
        targetWidthBits: toBits,
        origin: mergeOrigins(nested.origin, producer.origin, semanticValue?.origin),
      };
    }
  } else if (producer.kind === 'binary' && producer.operator === 'shl' && producer.inputs.length === 2) {
    const nested = semanticIndexTerm(producer.inputs[0], context, active);
    const amountNode = producerByValueId.get(producer.inputs[1]) ?? null;
    const amount = amountNode?.kind === 'const' ? constantPayload(amountNode) : null;
    if (nested && amount != null && amount >= 0n && amount <= 63n) {
      result = {
        ...nested,
        scale: Number(amount),
        origin: mergeOrigins(nested.origin, producer.origin, amountNode?.origin, semanticValue?.origin),
      };
    }
  }

  active.delete(valueId);
  return result;
}

function baseLeaf(valueId, context) {
  const { producerByValueId, valuesById, semanticValueById } = context;
  const producer = producerByValueId.get(valueId) ?? null;
  const legacyValue = valuesById.get(valueId) ?? null;
  if (!legacyValue || legacyValue.unknown || legacyValue.undefined) return null;
  if (!producer || producer.kind === 'state-read' || producer.kind === 'copy' || producer.kind === 'bitcast') {
    return {
      base: legacyValue,
      disp: 0n,
      index: null,
      scale: 0,
      extend: null,
      indexSignedness: null,
      indexWidthBits: null,
      addressWidthBits: legacyValue.bits || null,
      stack: producer?.attributes?.stack === true,
      origin: mergeOrigins(semanticValueById.get(valueId)?.origin, producer?.origin),
      precise: true,
    };
  }
  return null;
}

function lowerAddress(valueId, context, active) {
  if (!valueId || active.has(valueId)) return null;
  active.add(valueId);
  const { producerByValueId, valuesById, semanticValueById } = context;
  const producer = producerByValueId.get(valueId) ?? null;
  const semanticValue = semanticValueById.get(valueId) ?? null;
  let result = null;

  if (producer?.kind === 'const') {
    const value = constantPayload(producer);
    const base = valuesById.get(valueId) ?? null;
    if (value != null && base) {
      result = {
        base,
        disp: 0n,
        index: null,
        scale: 0,
        extend: null,
        indexSignedness: null,
        indexWidthBits: null,
        addressWidthBits: base.bits || null,
        stack: false,
        origin: mergeOrigins(producer.origin, semanticValue?.origin),
        precise: true,
      };
    }
  } else if ((producer?.kind === 'address' || producer?.kind === 'binary')
      && (producer.operator === 'add' || producer.operator === 'sub') && producer.inputs.length === 2) {
    const [leftId, rightId] = producer.inputs;
    const leftNode = producerByValueId.get(leftId) ?? null;
    const rightNode = producerByValueId.get(rightId) ?? null;
    const leftConst = leftNode?.kind === 'const' ? constantPayload(leftNode) : null;
    const rightConst = rightNode?.kind === 'const' ? constantPayload(rightNode) : null;

    if (rightConst != null) {
      const left = lowerAddress(leftId, context, active) ?? baseLeaf(leftId, context);
      if (left && left.precise) {
        const delta = producer.operator === 'sub' ? -rightConst : rightConst;
        result = { ...left, disp: (left.disp ?? 0n) + delta, origin: mergeOrigins(left.origin, producer.origin, rightNode.origin, semanticValue?.origin) };
      }
    } else if (producer.operator === 'add' && leftConst != null) {
      const right = lowerAddress(rightId, context, active) ?? baseLeaf(rightId, context);
      if (right && right.precise) {
        result = { ...right, disp: (right.disp ?? 0n) + leftConst, origin: mergeOrigins(right.origin, producer.origin, leftNode.origin, semanticValue?.origin) };
      }
    } else if (producer.operator === 'add') {
      const left = lowerAddress(leftId, context, active) ?? baseLeaf(leftId, context);
      const index = semanticIndexTerm(rightId, context, new Set());
      if (left && left.precise && left.index == null && index) {
        result = {
          ...left,
          index: index.value,
          scale: index.scale,
          extend: index.extend,
          indexSignedness: index.signedness,
          indexWidthBits: index.sourceWidthBits,
          addressWidthBits: index.targetWidthBits ?? left.addressWidthBits,
          origin: mergeOrigins(left.origin, index.origin, producer.origin, semanticValue?.origin),
        };
      }
    }
  } else {
    result = baseLeaf(valueId, context);
  }

  active.delete(valueId);
  return result;
}

export function projectLegacyAddress(addressValueId, memory, context) {
  const lowered = lowerAddress(addressValueId, context, new Set());
  const size = Math.max(1, Math.ceil(Number(memory?.widthBits || 8) / 8));
  const fallbackValue = context.valuesById.get(addressValueId) ?? null;
  const base = lowered?.base ?? fallbackValue;
  const precise = lowered?.precise === true;
  return {
    base: base ?? null,
    baseReg: base?.reg ?? null,
    disp: precise ? (lowered.disp ?? 0n) : null,
    index: precise ? (lowered.index ?? null) : null,
    scale: precise ? (lowered.scale ?? 0) : 0,
    extend: precise ? (lowered.extend ?? null) : null,
    size,
    widthBits: memory?.widthBits ?? null,
    stack: precise ? lowered.stack === true : false,
    addressSpace: memory?.addressSpace ?? null,
    rawAddressValueId: addressValueId,
    indexSignedness: precise ? (lowered.indexSignedness ?? null) : null,
    indexWidthBits: precise ? (lowered.indexWidthBits ?? null) : null,
    addressWidthBits: precise ? (lowered.addressWidthBits ?? base?.bits ?? null) : null,
    origin: mergeOrigins(memory?.origin, lowered?.origin, context.semanticValueById.get(addressValueId)?.origin),
    precise,
    ...(precise ? {} : { unknownReason: 'semantic-address-expression-not-proven' }),
  };
}
