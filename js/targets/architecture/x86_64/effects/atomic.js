import { createX86EffectContext, x86MemoryFaults, x86RegisterOperand } from './common.js';
import { x86EffectiveAddressExpression } from './addressing.js';
import { emitX86ArithmeticFlags } from './flags.js';

const ATOMIC_FAMILIES = new Set(['xchg','xadd','cmpxchg','cmpxchg8b','cmpxchg16b']);
const WIDTHS = new Set([8,16,32,64]);

function supportedWidth(widthBits) { return WIDTHS.has(Number(widthBits)); }
function hasLock(instruction) { return [...(instruction?.detail?.prefixes?.legacy || [])].includes(0xf0); }
function memoryOperands(operands) { return operands.filter((operand) => operand?.type === 'memory'); }
function addressFor(ctx, operand) {
  if (operand?.type !== 'memory' || !supportedWidth(operand.widthBits)) return null;
  return x86EffectiveAddressExpression(ctx.instruction, operand);
}
function accumulatorName(widthBits) { return ({8:'al',16:'ax',32:'eax',64:'rax'})[widthBits] || null; }
function rmwId(ctx, family) { return `${ctx.instructionId}:atomic-rmw:${family}`; }
function memoryConfig(address, relationshipId, phase, atomic, metadata = {}) {
  return { space:address.space, atomic, metadata:{ ...address.metadata, rmwId:relationshipId, rmwPhase:phase, atomicRmw:atomic, sameInstructionRelationship:true, ...metadata } };
}
function orderingPartial(ctx, family, faults, metadata = {}, detail = {}) {
  return ctx.partial('x86-atomic-ordering-not-mapped-by-frozen-p5-0-contract', ['memory'], {
    possibleFaults:faults,
    detail:{ atomicity:'exact', ordering:'intentionally-unmapped', overclaimAvoided:'seq-cst-not-assigned', ...detail },
    metadata:{ family:'atomic', operation:family, atomic:true, orderingMapping:'unmapped-not-seq-cst', ...metadata },
  });
}
function liftXchg(ctx) {
  if (memoryOperands(ctx.operands).length !== 1 || ctx.operands.length !== 2) return ctx.partial('x86-xchg-memory-shape-unmodelled',['memory','registers']);
  const memory = ctx.operands.find((operand) => operand.type === 'memory'), register = ctx.operands.find((operand) => operand.type === 'register');
  if (!memory || !register || !supportedWidth(memory.widthBits) || memory.widthBits !== register.widthBits) return ctx.partial('x86-xchg-memory-width-or-register-unmodelled',['memory','registers']);
  const address = addressFor(ctx,memory), registerValue = ctx.readRegister(register);
  if (!address || !registerValue) return ctx.partial('x86-xchg-memory-address-or-register-unmodelled',['memory','registers']);
  const relationshipId = rmwId(ctx,'xchg');
  const oldMemory = ctx.readMemory(address.expression,memory.widthBits,memoryConfig(address,relationshipId,'read',true,{implicitAtomicity:true,explicitLockPrefix:hasLock(ctx.instruction)}));
  ctx.writeMemory(address.expression,memory.widthBits,registerValue,memoryConfig(address,relationshipId,'write',true,{implicitAtomicity:true,exchangedWithRegister:register.register.id}));
  if (!ctx.writeRegister(register,oldMemory)) return ctx.partial('x86-xchg-register-write-unmodelled',['registers','memory']);
  return orderingPartial(ctx,'xchg',x86MemoryFaults('read-write',memory.widthBits),{rmwId:relationshipId,sameCanonicalAddress:true,implicitAtomicWithoutLock:true,explicitLockPrefix:hasLock(ctx.instruction),address:address.metadata});
}
function liftXadd(ctx) {
  const [destination,source] = ctx.operands;
  if (destination?.type !== 'memory' || source?.type !== 'register' || memoryOperands(ctx.operands).length !== 1 || !supportedWidth(destination.widthBits) || destination.widthBits !== source.widthBits) return ctx.partial('x86-xadd-memory-shape-unmodelled',['memory','registers','flags']);
  const address = addressFor(ctx,destination), sourceValue = ctx.readRegister(source);
  if (!address || !sourceValue) return ctx.partial('x86-xadd-memory-address-or-source-unmodelled',['memory','registers','flags']);
  const locked = hasLock(ctx.instruction), relationshipId = rmwId(ctx,'xadd');
  const oldDestination = ctx.readMemory(address.expression,destination.widthBits,memoryConfig(address,relationshipId,'read',locked,{operation:'xadd'}));
  const result = ctx.valueOp('add',[oldDestination,sourceValue],destination.widthBits,{semantic:'x86-xadd-destination-result',rmwId:relationshipId,preservesOldDestinationForSource:true});
  ctx.writeMemory(address.expression,destination.widthBits,result,memoryConfig(address,relationshipId,'write',locked,{operation:'xadd',oldDestinationTransferredToSource:true}));
  if (!ctx.writeRegister(source,oldDestination)) return ctx.partial('x86-xadd-source-register-write-unmodelled',['registers','memory','flags']);
  emitX86ArithmeticFlags(ctx,'add',oldDestination,sourceValue,result,destination.widthBits);
  const faults = x86MemoryFaults('read-write',destination.widthBits), metadata = {rmwId:relationshipId,sameCanonicalAddress:true,sourceReceivesOldDestination:true,explicitLockPrefix:locked,address:address.metadata};
  if (locked) return orderingPartial(ctx,'xadd',faults,metadata);
  return ctx.finish({family:'atomic',possibleFaults:faults,metadata:{operation:'xadd',atomic:false,...metadata}});
}
function liftCmpxchg(ctx) {
  const [destination,source] = ctx.operands;
  if (destination?.type !== 'memory' || source?.type !== 'register' || memoryOperands(ctx.operands).length !== 1 || !supportedWidth(destination.widthBits) || destination.widthBits !== source.widthBits) return ctx.partial('x86-cmpxchg-memory-shape-unmodelled',['memory','registers','flags']);
  const address = addressFor(ctx,destination), accumulator = x86RegisterOperand(accumulatorName(destination.widthBits)), sourceValue = ctx.readRegister(source), accumulatorValue = accumulator ? ctx.readRegister(accumulator) : null;
  if (!address || !sourceValue || !accumulatorValue) return ctx.partial('x86-cmpxchg-memory-address-or-implicit-state-unmodelled',['memory','registers','flags']);
  const locked = hasLock(ctx.instruction), relationshipId = rmwId(ctx,'cmpxchg');
  const oldDestination = ctx.readMemory(address.expression,destination.widthBits,memoryConfig(address,relationshipId,'read',locked,{operation:'cmpxchg',conditionalRmw:true}));
  const compareResult = ctx.valueOp('sub',[accumulatorValue,oldDestination],destination.widthBits,{compareOnly:true,semantic:'x86-cmpxchg-accumulator-minus-destination',rmwId:relationshipId});
  emitX86ArithmeticFlags(ctx,'cmp',accumulatorValue,oldDestination,compareResult,destination.widthBits);
  const success = ctx.valueOp('eq',[accumulatorValue,oldDestination],1,{semantic:'x86-cmpxchg-success',equivalentFlag:'ZF=1',rmwId:relationshipId});
  const memoryResult = ctx.valueOp('select',[success,sourceValue,oldDestination],destination.widthBits,{semantic:'x86-cmpxchg-memory-result',successPath:'source-to-destination',failurePath:'destination-unchanged',rmwId:relationshipId});
  ctx.writeMemory(address.expression,destination.widthBits,memoryResult,memoryConfig(address,relationshipId,'conditional-write-overapproximation',locked,{operation:'cmpxchg',conditionalWrite:true,writeCondition:'accumulator == oldDestination',failurePathArchitecturalWrite:false,representationIsConservativeMayWrite:true}));
  const accumulatorResult = ctx.valueOp('select',[success,accumulatorValue,oldDestination],destination.widthBits,{semantic:'x86-cmpxchg-accumulator-result',successPath:'accumulator-preserved',failurePath:'old-destination-to-accumulator',rmwId:relationshipId});
  if (!ctx.writeRegister(accumulator,accumulatorResult)) return ctx.partial('x86-cmpxchg-accumulator-write-unmodelled',['registers','memory','flags']);
  const faults = x86MemoryFaults('read-write',destination.widthBits);
  return ctx.partial(locked ? 'x86-cmpxchg-conditional-store-and-atomic-ordering-not-fully-representable' : 'x86-cmpxchg-conditional-store-not-fully-representable',['memory'],{
    possibleFaults:faults,
    detail:{conditionalStore:'generic MachineEffects has no conditional memory-write operation; emitted write is a conservative may-write with exact selected value',successPath:'destination=source; accumulator preserved; ZF=1',failurePath:'destination unchanged; accumulator=old destination; ZF=0',ordering:locked ? 'also intentionally unmapped' : 'not atomic without LOCK'},
    metadata:{family:'atomic',operation:'cmpxchg',rmwId:relationshipId,sameCanonicalAddress:true,conditional:true,explicitLockPrefix:locked,atomic:locked,orderingMapping:locked ? 'unmapped-not-seq-cst' : 'not-applicable',successValue:success,address:address.metadata},
  });
}
function liftWideCmpxchg(ctx,family) {
  const [destination] = ctx.operands, expectedWidth = family === 'cmpxchg16b' ? 128 : 64;
  const address = destination?.type === 'memory' ? x86EffectiveAddressExpression(ctx.instruction,destination) : null;
  const faults = destination?.type === 'memory' ? [...x86MemoryFaults('read-write',expectedWidth),...(family === 'cmpxchg16b' ? [{kind:'general-protection',condition:{kind:'x86-cmpxchg16b-misaligned',requiredAlignment:16},detail:{vector:'#GP',alignmentBytes:16}}] : [])] : [];
  return ctx.partial(`x86-${family}-wide-atomic-pair-semantics-not-representable-by-frozen-p5-0-contract`,['memory','registers','flags'],{possibleFaults:faults,detail:{p5Classification:'P5-I-INTEGRATION-REQUIRED',expectedMemoryWidthBits:expectedWidth,implicitRegisterPairs:true,conditionalWideAtomicRmw:true,alignmentRequirement:family === 'cmpxchg16b' ? 16 : null},metadata:{family:'atomic',operation:family,address:address?.metadata ?? null,exactWideAtomicClaim:false}});
}
export function liftX86AtomicEffects(instruction,context = {}) {
  const family = String(instruction?.instructionFamily || '').toLowerCase(), locked = hasLock(instruction);
  if (!ATOMIC_FAMILIES.has(family) && !locked) return null;
  const ctx = createX86EffectContext(instruction,context);
  if (!ATOMIC_FAMILIES.has(family)) return ctx.partial('x86-lock-prefixed-family-not-modelled-in-p5-2',['memory','registers','flags','other'],{metadata:{family:'atomic',operation:family,lockPrefix:true,lockIgnored:false}});
  if (memoryOperands(ctx.operands).length === 0) {
    if (locked) return ctx.partial('x86-lock-prefix-without-memory-operand',['memory','registers','flags','other'],{metadata:{family:'atomic',operation:family,lockPrefix:true,lockIgnored:false}});
    return null;
  }
  if (family === 'xchg') return liftXchg(ctx);
  if (family === 'xadd') return liftXadd(ctx);
  if (family === 'cmpxchg') return liftCmpxchg(ctx);
  if (family === 'cmpxchg8b' || family === 'cmpxchg16b') return liftWideCmpxchg(ctx,family);
  return null;
}
