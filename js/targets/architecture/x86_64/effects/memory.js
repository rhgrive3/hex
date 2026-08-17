import { createX86EffectContext, x86MemoryFaults, x86RegisterOperand } from './common.js';
import { materializeX86Address, x86EffectiveAddressExpression } from './addressing.js';
import { emitX86ArithmeticFlags, emitX86Condition, emitX86LogicalFlags } from './flags.js';

const MOVES = new Set(['mov','movabs','movzx','movsx','movsxd']);
const BINARY_ARITHMETIC = new Set(['add','sub']);
const BINARY_LOGICAL = new Set(['and','or','xor']);
const SAFE_MEMORY_RMW = new Set([...BINARY_ARITHMETIC, ...BINARY_LOGICAL, 'not']);
const LOCKABLE_CROSS_LANE = new Set(['adc','sbb','inc','dec','neg']);
const CROSS_LANE_REQUIRED = new Set([
  'adc','sbb','inc','dec','neg','shl','sal','shr','sar','rol','ror','imul','mul','div','idiv',
]);
const WIDTHS = new Set([8,16,32,64]);

function supportedWidth(value) { return WIDTHS.has(Number(value)); }
function memoryOperands(operands) { return operands.filter((operand) => operand?.type === 'memory'); }
function memoryOperand(operands) { return memoryOperands(operands)[0] || null; }
function hasLock(instruction) { return [...(instruction?.detail?.prefixes?.legacy || [])].includes(0xf0); }
function conditionCode(instruction, family, prefix) {
  return String(instruction?.detail?.conditionCode || family.slice(prefix.length) || '').toLowerCase();
}
function rmwId(ctx, family) { return `${ctx.instructionId}:rmw:${family}`; }

function addressFor(ctx, operand) {
  if (operand?.type !== 'memory' || !supportedWidth(operand.widthBits)) return null;
  return x86EffectiveAddressExpression(ctx.instruction, operand);
}

function memoryConfig(address, metadata = {}, extra = {}) {
  return {
    space:address.space,
    ...extra,
    metadata:{ ...address.metadata, ...metadata },
  };
}

function readMemoryOperand(ctx, operand, metadata = {}, extra = {}) {
  const address = addressFor(ctx, operand);
  if (!address) return null;
  const value = ctx.readMemory(address.expression, operand.widthBits, memoryConfig(address, metadata, extra));
  return Object.freeze({ address, value });
}

function atomicOrderingPartial(ctx, family, possibleFaults, metadata = {}, detail = {}) {
  return ctx.partial('x86-locked-memory-ordering-not-representable-by-frozen-p5-0-contract', ['memory'], {
    possibleFaults,
    detail:{
      atomicity:'represented-by-MemoryAccess.atomic',
      ordering:'intentionally-unmapped',
      reason:'x86 locked-operation ordering is stronger/more-specific than the frozen generic mapping can prove here',
      ...detail,
    },
    metadata:{
      family:'atomic-memory',
      operation:family,
      atomic:true,
      orderingMapping:'unmapped-not-seq-cst',
      ...metadata,
    },
  });
}

function invalidLockPartial(ctx, family, reason = 'x86-lock-form-not-proven-valid') {
  return ctx.partial(reason, ['memory','flags','other'], {
    metadata:{ operation:family, lockPrefix:true, lockIgnored:false, invalidOrUnsupportedLock:true },
  });
}

function crossLanePartial(ctx, family) {
  const memory = memoryOperand(ctx.operands);
  const address = memory ? addressFor(ctx, memory) : null;
  return ctx.partial(`x86-${family}-memory-form-requires-p5-1-integration-semantics`, ['memory','registers','flags'], {
    possibleFaults:memory && supportedWidth(memory.widthBits) ? x86MemoryFaults(memory === ctx.operands[0] ? 'read-write' : 'read', memory.widthBits) : [],
    detail:{
      p5Classification:'P5-I-INTEGRATION-REQUIRED',
      reason:'exact value/flag rules are owned by concurrent P5-1 and are not part of the frozen P5-0 helper contract',
    },
    metadata:{
      operation:family,
      p5Boundary:'p5-1-memory-form-handoff',
      address:address?.metadata ?? null,
    },
  });
}

function liftMove(ctx, family) {
  const [destination, source] = ctx.operands;
  if (memoryOperands(ctx.operands).length !== 1) {
    return ctx.partial(`x86-${family}-memory-shape-unmodelled`, ['memory','registers']);
  }

  if (destination?.type === 'register' && source?.type === 'memory') {
    if (!supportedWidth(source.widthBits) || !supportedWidth(destination.widthBits)) {
      return ctx.partial(`x86-${family}-load-width-unmodelled`, ['memory','registers']);
    }
    if ((family === 'mov' || family === 'movabs') && destination.widthBits !== source.widthBits) {
      return ctx.partial(`x86-${family}-load-width-mismatch`, ['memory','registers']);
    }
    if ((family === 'movzx' || family === 'movsx') && destination.widthBits <= source.widthBits) {
      return ctx.partial(`x86-${family}-extension-width-invalid`, ['memory','registers']);
    }
    if (family === 'movsxd' && (source.widthBits !== 32 || destination.widthBits !== 64)) {
      return ctx.partial('x86-movsxd-memory-width-invalid', ['memory','registers']);
    }
    const read = readMemoryOperand(ctx, source, { operation:family, direction:'load' });
    if (!read) return ctx.partial(`x86-${family}-load-address-unmodelled`, ['memory','registers']);
    const signed = family === 'movsx' || family === 'movsxd';
    const value = ctx.coerce(read.value, source.widthBits, destination.widthBits, signed);
    if (!ctx.writeRegister(destination, value)) return ctx.partial(`x86-${family}-load-destination-unmodelled`, ['registers']);
    return ctx.finish({
      family:'memory',
      possibleFaults:x86MemoryFaults('read', source.widthBits),
      metadata:{ operation:family, direction:'load', memoryWidthBits:source.widthBits, destinationWidthBits:destination.widthBits, address:read.address.metadata },
    });
  }

  if ((family === 'mov' || family === 'movabs') && destination?.type === 'memory' && source && source.type !== 'memory') {
    if (!supportedWidth(destination.widthBits)) return ctx.partial(`x86-${family}-store-width-unmodelled`, ['memory','registers']);
    if (source.type === 'register' && source.widthBits !== destination.widthBits) {
      return ctx.partial(`x86-${family}-store-register-width-mismatch`, ['memory','registers']);
    }
    const address = addressFor(ctx, destination);
    const value = ctx.readOperand(source, destination.widthBits);
    if (!address || !value) return ctx.partial(`x86-${family}-store-source-unmodelled`, ['memory','registers']);
    ctx.writeMemory(address.expression, destination.widthBits, value, memoryConfig(address, { operation:family, direction:'store' }));
    return ctx.finish({
      family:'memory',
      possibleFaults:x86MemoryFaults('write', destination.widthBits),
      metadata:{ operation:family, direction:'store', memoryWidthBits:destination.widthBits, address:address.metadata },
    });
  }

  return ctx.partial(`x86-${family}-memory-shape-unmodelled`, ['memory','registers']);
}

function liftCompareOrTest(ctx, family) {
  const [leftOperand, rightOperand] = ctx.operands;
  if (!leftOperand || !rightOperand || memoryOperands(ctx.operands).length !== 1) {
    return ctx.partial(`x86-${family}-memory-shape-unmodelled`, ['memory','registers','flags']);
  }
  const widthBits = leftOperand.widthBits;
  if (!supportedWidth(widthBits) || Number(rightOperand.widthBits ?? widthBits) !== Number(widthBits)) {
    return ctx.partial(`x86-${family}-memory-width-unmodelled`, ['memory','registers','flags']);
  }

  let left;
  let right;
  let address;
  if (leftOperand.type === 'memory') {
    const read = readMemoryOperand(ctx, leftOperand, { operation:family, compareOnly:true });
    if (!read) return ctx.partial(`x86-${family}-memory-address-unmodelled`, ['memory','registers','flags']);
    left = read.value;
    address = read.address;
    right = ctx.readOperand(rightOperand, widthBits);
  } else if (rightOperand.type === 'memory') {
    left = ctx.readOperand(leftOperand, widthBits);
    const read = readMemoryOperand(ctx, rightOperand, { operation:family, compareOnly:true });
    if (!read) return ctx.partial(`x86-${family}-memory-address-unmodelled`, ['memory','registers','flags']);
    right = read.value;
    address = read.address;
  }
  if (!left || !right || !address) return ctx.partial(`x86-${family}-memory-operand-unmodelled`, ['memory','registers','flags']);

  const result = ctx.valueOp(family === 'cmp' ? 'sub' : 'and', [left,right], widthBits, {
    compareOnly:true,
    widthBits,
    memoryReadOnly:true,
  });
  if (family === 'cmp') emitX86ArithmeticFlags(ctx, family, left, right, result, widthBits);
  else emitX86LogicalFlags(ctx, family, left, right, result, widthBits);
  return ctx.finish({
    family:'flags',
    possibleFaults:x86MemoryFaults('read', widthBits),
    metadata:{ operation:family, direction:'read-only', destinationWrite:false, memoryWrite:false, address:address.metadata },
  });
}

function liftBinaryMemory(ctx, family, logical) {
  const [destination, source] = ctx.operands;
  const lock = hasLock(ctx.instruction);
  if (!destination || !source || memoryOperands(ctx.operands).length !== 1 || !supportedWidth(destination.widthBits)) {
    return ctx.partial(`x86-${family}-memory-shape-unmodelled`, ['memory','registers','flags']);
  }

  if (destination.type === 'memory') {
    if (source.type === 'memory' || Number(source.widthBits ?? destination.widthBits) !== Number(destination.widthBits)) {
      return ctx.partial(`x86-${family}-memory-source-unmodelled`, ['memory','registers','flags']);
    }
    const address = addressFor(ctx, destination);
    const right = ctx.readOperand(source, destination.widthBits);
    if (!address || !right) return ctx.partial(`x86-${family}-memory-source-unmodelled`, ['memory','registers','flags']);
    const relationshipId = rmwId(ctx, family);
    const accessExtra = { atomic:lock };
    const oldValue = ctx.readMemory(address.expression, destination.widthBits, memoryConfig(address, {
      operation:family,
      rmwId:relationshipId,
      rmwPhase:'read',
      atomicRmw:lock,
    }, accessExtra));
    const result = ctx.valueOp(family, [oldValue,right], destination.widthBits, {
      widthBits:destination.widthBits,
      rmwId:relationshipId,
      sameAddressReadWrite:true,
    });
    ctx.writeMemory(address.expression, destination.widthBits, result, memoryConfig(address, {
      operation:family,
      rmwId:relationshipId,
      rmwPhase:'write',
      atomicRmw:lock,
      sourceReadOperation:'same-instruction-memory-read',
    }, accessExtra));
    if (logical) emitX86LogicalFlags(ctx, family, oldValue, right, result, destination.widthBits);
    else emitX86ArithmeticFlags(ctx, family, oldValue, right, result, destination.widthBits);
    const possibleFaults = x86MemoryFaults('read-write', destination.widthBits);
    const metadata = {
      operation:family,
      direction:'read-modify-write',
      rmwId:relationshipId,
      sameCanonicalAddress:true,
      address:address.metadata,
    };
    if (lock) return atomicOrderingPartial(ctx, family, possibleFaults, metadata);
    return ctx.finish({ family:'memory', possibleFaults, metadata });
  }

  if (destination.type === 'register' && source.type === 'memory') {
    if (lock) return invalidLockPartial(ctx, family, 'x86-lock-requires-memory-destination');
    if (destination.widthBits !== source.widthBits) return ctx.partial(`x86-${family}-load-source-width-mismatch`, ['memory','registers','flags']);
    const left = ctx.readRegister(destination);
    const read = readMemoryOperand(ctx, source, { operation:family, direction:'load-source' });
    if (!left || !read) return ctx.partial(`x86-${family}-load-source-unmodelled`, ['memory','registers','flags']);
    const result = ctx.valueOp(family, [left,read.value], destination.widthBits, { widthBits:destination.widthBits });
    if (!ctx.writeRegister(destination, result)) return ctx.partial(`x86-${family}-register-write-unmodelled`, ['registers','flags']);
    if (logical) emitX86LogicalFlags(ctx, family, left, read.value, result, destination.widthBits);
    else emitX86ArithmeticFlags(ctx, family, left, read.value, result, destination.widthBits);
    return ctx.finish({
      family:'integer',
      possibleFaults:x86MemoryFaults('read', source.widthBits),
      metadata:{ operation:family, direction:'load-source', address:read.address.metadata },
    });
  }

  return ctx.partial(`x86-${family}-memory-destination-unmodelled`, ['memory','registers','flags']);
}

function liftNot(ctx) {
  const [destination] = ctx.operands;
  const lock = hasLock(ctx.instruction);
  if (destination?.type !== 'memory' || memoryOperands(ctx.operands).length !== 1 || !supportedWidth(destination.widthBits)) {
    return ctx.partial('x86-not-memory-shape-unmodelled', ['memory','registers']);
  }
  const address = addressFor(ctx, destination);
  if (!address) return ctx.partial('x86-not-memory-address-unmodelled', ['memory','registers']);
  const relationshipId = rmwId(ctx, 'not');
  const extra = { atomic:lock };
  const oldValue = ctx.readMemory(address.expression, destination.widthBits, memoryConfig(address, {
    operation:'not', rmwId:relationshipId, rmwPhase:'read', atomicRmw:lock,
  }, extra));
  const result = ctx.valueOp('not', [oldValue], destination.widthBits, { widthBits:destination.widthBits, rmwId:relationshipId });
  ctx.writeMemory(address.expression, destination.widthBits, result, memoryConfig(address, {
    operation:'not', rmwId:relationshipId, rmwPhase:'write', atomicRmw:lock,
  }, extra));
  const faults = x86MemoryFaults('read-write', destination.widthBits);
  const metadata = { operation:'not', flagsModified:false, rmwId:relationshipId, sameCanonicalAddress:true, address:address.metadata };
  if (lock) return atomicOrderingPartial(ctx, 'not', faults, metadata);
  return ctx.finish({ family:'memory', possibleFaults:faults, metadata });
}

function liftSetcc(ctx, family) {
  const [destination] = ctx.operands;
  if (destination?.type !== 'memory' || destination.widthBits !== 8 || memoryOperands(ctx.operands).length !== 1) {
    return ctx.partial('x86-setcc-memory-shape-unmodelled', ['memory','flags']);
  }
  const code = conditionCode(ctx.instruction, family, 'set');
  const condition = emitX86Condition(ctx, code);
  const address = addressFor(ctx, destination);
  if (!condition || !address) return ctx.partial('x86-setcc-memory-condition-or-address-unmodelled', ['memory','flags']);
  const value = ctx.coerce(condition, 1, 8, false);
  ctx.writeMemory(address.expression, 8, value, memoryConfig(address, { operation:family, conditionCode:code }));
  return ctx.finish({
    family:'memory',
    possibleFaults:x86MemoryFaults('write', 8),
    metadata:{ operation:family, conditionCode:code, memoryWidthBits:8, address:address.metadata },
  });
}

function liftCmovcc(ctx, family) {
  const [destination, source] = ctx.operands;
  if (destination?.type !== 'register' || source?.type !== 'memory' || memoryOperands(ctx.operands).length !== 1
    || !supportedWidth(destination.widthBits) || destination.widthBits !== source.widthBits) {
    return ctx.partial('x86-cmovcc-memory-shape-unmodelled', ['memory','registers','flags']);
  }
  const read = readMemoryOperand(ctx, source, { operation:family, conditionalMoveSource:true });
  const oldValue = ctx.readRegister(destination);
  const code = conditionCode(ctx.instruction, family, 'cmov');
  const condition = emitX86Condition(ctx, code);
  if (!read || !oldValue || !condition) return ctx.partial('x86-cmovcc-memory-condition-or-source-unmodelled', ['memory','registers','flags']);
  const selected = ctx.valueOp('select', [condition,read.value,oldValue], destination.widthBits, {
    semantic:'x86-cmovcc-memory-source',
    conditionCode:code,
    memoryReadOccursRegardlessOfCondition:true,
  });
  if (!ctx.writeRegister(destination, selected)) return ctx.partial('x86-cmovcc-memory-destination-unmodelled', ['registers','flags']);
  return ctx.finish({
    family:'memory',
    possibleFaults:x86MemoryFaults('read', source.widthBits),
    metadata:{ operation:family, conditionCode:code, sourceReadUnconditional:true, address:read.address.metadata },
  });
}

function liftPush(ctx) {
  const [source] = ctx.operands;
  if (!source) return ctx.partial('x86-push-operand-unmodelled', ['registers','memory']);
  if (source.type !== 'immediate' && ![16,64].includes(Number(source.widthBits))) {
    return ctx.partial('x86-push-width-unmodelled', ['registers','memory']);
  }
  const stackWidth = source.widthBits === 16 ? 16 : 64;

  const oldRsp = ctx.readRegister(x86RegisterOperand('rsp'));
  if (!oldRsp) return ctx.partial('x86-push-rsp-unmodelled', ['registers','memory']);

  let value;
  let sourceAddress = null;
  let faults = [];
  if (source.type === 'memory') {
    if (source.widthBits !== stackWidth) return ctx.partial('x86-push-memory-width-unmodelled', ['memory','registers']);
    const read = readMemoryOperand(ctx, source, { stackSource:true, sourceAddressBeforeStackUpdate:true });
    if (!read) return ctx.partial('x86-push-memory-source-address-unmodelled', ['memory','registers']);
    value = read.value;
    sourceAddress = read.address;
    faults = [...faults, ...x86MemoryFaults('read', stackWidth)];
  } else {
    value = ctx.readOperand(source, stackWidth, { signed:source.type === 'immediate' });
  }
  if (!value) return ctx.partial('x86-push-source-unmodelled', ['registers','memory']);

  const delta = stackWidth / 8;
  const nextRsp = ctx.valueOp('sub', [oldRsp,ctx.constant(64,BigInt(delta))], 64, { stackDelta:-delta, stackWidthBits:stackWidth });
  ctx.writeMemory(nextRsp, stackWidth, value, { metadata:{ stackAccess:true, stackPhase:'push-store', sourceAddress:sourceAddress?.metadata ?? null } });
  ctx.writeRegister(x86RegisterOperand('rsp'), nextRsp);
  faults = [...faults, ...x86MemoryFaults('write', stackWidth)];
  return ctx.finish({
    family:'memory',
    possibleFaults:faults,
    metadata:{ operation:'push', stackDelta:-delta, stackWidthBits:stackWidth, sourceAddress:sourceAddress?.metadata ?? null },
  });
}

function liftPop(ctx) {
  const [destination] = ctx.operands;
  if (!destination || ![16,64].includes(Number(destination.widthBits))) {
    return ctx.partial('x86-pop-width-or-destination-unmodelled', ['registers','memory']);
  }
  const stackWidth = Number(destination.widthBits);
  const delta = stackWidth / 8;
  const oldRsp = ctx.readRegister(x86RegisterOperand('rsp'));
  if (!oldRsp) return ctx.partial('x86-pop-rsp-unmodelled', ['registers','memory']);
  const value = ctx.readMemory(oldRsp, stackWidth, { metadata:{ stackAccess:true, stackPhase:'pop-load' } });
  const nextRsp = ctx.valueOp('add', [oldRsp,ctx.constant(64,BigInt(delta))], 64, { stackDelta:delta, stackWidthBits:stackWidth });
  if (!ctx.writeRegister(x86RegisterOperand('rsp'), nextRsp)) return ctx.partial('x86-pop-rsp-update-unmodelled', ['registers','memory']);

  let faults = [...x86MemoryFaults('read', stackWidth)];
  if (destination.type === 'register') {
    const isRsp = destination.register?.physicalId === 'rsp';
    if (!ctx.writeRegister(destination, value)) return ctx.partial('x86-pop-register-view-unmodelled', ['registers','memory']);
    return ctx.finish({
      family:'memory',
      possibleFaults:faults,
      metadata:{
        operation:'pop',
        stackDelta:delta,
        stackWidthBits:stackWidth,
        rspDestination:isRsp,
        sequencing:isRsp ? 'increment-rsp-then-destination-overwrites-rsp' : 'increment-rsp-before-destination-write',
      },
    });
  }

  if (destination.type === 'memory') {
    const shape = addressFor(ctx, destination);
    const materialized = materializeX86Address(ctx, destination);
    if (!shape || !materialized) {
      return ctx.partial('x86-pop-memory-destination-address-unmodelled', ['registers','memory'], {
        possibleFaults:faults,
        detail:{ rspAlreadyIncrementedBeforeDestinationAddress:true },
      });
    }
    ctx.writeMemory(materialized, stackWidth, value, memoryConfig(shape, {
      stackDestination:true,
      destinationAddressAfterRspIncrement:true,
      structuralAddress:shape.expression,
    }));
    faults = [...faults, ...x86MemoryFaults('write', stackWidth)];
    return ctx.finish({
      family:'memory',
      possibleFaults:faults,
      metadata:{
        operation:'pop',
        stackDelta:delta,
        stackWidthBits:stackWidth,
        destinationAddressAfterRspIncrement:true,
        address:shape.metadata,
      },
    });
  }

  return ctx.partial('x86-pop-destination-unmodelled', ['registers','memory'], { possibleFaults:faults });
}

export function liftX86MemoryEffects(instruction, context = {}) {
  const family = String(instruction?.instructionFamily || '').toLowerCase();
  const recognized = MOVES.has(family)
    || BINARY_ARITHMETIC.has(family)
    || BINARY_LOGICAL.has(family)
    || CROSS_LANE_REQUIRED.has(family)
    || ['cmp','test','not','push','pop','setcc','cmovcc'].includes(family)
    || family.startsWith('set')
    || family.startsWith('cmov');
  if (!recognized) return null;

  const hasMemory = memoryOperands(instruction?.detail?.operands || []).length > 0;
  const lock = hasLock(instruction);
  if (!hasMemory && !lock) return null;

  const ctx = createX86EffectContext(instruction, context);

  if (lock) {
    if (!hasMemory) return invalidLockPartial(ctx, family, 'x86-lock-prefix-without-memory-operand');
    if (!SAFE_MEMORY_RMW.has(family) && !LOCKABLE_CROSS_LANE.has(family)) return invalidLockPartial(ctx, family);
    if (ctx.operands[0]?.type !== 'memory') return invalidLockPartial(ctx, family, 'x86-lock-requires-memory-destination');
  }

  if (CROSS_LANE_REQUIRED.has(family)) return crossLanePartial(ctx, family);
  if (family === 'push') return liftPush(ctx);
  if (family === 'pop') return liftPop(ctx);
  if (MOVES.has(family)) return liftMove(ctx, family);
  if (family === 'cmp' || family === 'test') return liftCompareOrTest(ctx, family);
  if (BINARY_ARITHMETIC.has(family)) return liftBinaryMemory(ctx, family, false);
  if (BINARY_LOGICAL.has(family)) return liftBinaryMemory(ctx, family, true);
  if (family === 'not') return liftNot(ctx);
  if (family === 'setcc' || family.startsWith('set')) return liftSetcc(ctx, family);
  if (family === 'cmovcc' || family.startsWith('cmov')) return liftCmovcc(ctx, family);

  return ctx.partial(`x86-${family}-memory-form-unmodelled`, ['memory','registers','flags']);
}
