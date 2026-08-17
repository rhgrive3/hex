import { createX86EffectContext, x86MemoryFaults, x86RegisterOperand } from './common.js';
import { x86EffectiveAddressExpression } from './addressing.js';
import { emitX86ArithmeticFlags } from './flags.js';

const STRING_FAMILIES = new Map([
  ['movsb', { kind:'movs', widthBits:8 }], ['movsw', { kind:'movs', widthBits:16 }],
  ['movsd', { kind:'movs', widthBits:32, ambiguous:true }], ['movsq', { kind:'movs', widthBits:64 }],
  ['stosb', { kind:'stos', widthBits:8 }], ['stosw', { kind:'stos', widthBits:16 }],
  ['stosd', { kind:'stos', widthBits:32 }], ['stosq', { kind:'stos', widthBits:64 }],
  ['lodsb', { kind:'lods', widthBits:8 }], ['lodsw', { kind:'lods', widthBits:16 }],
  ['lodsd', { kind:'lods', widthBits:32 }], ['lodsq', { kind:'lods', widthBits:64 }],
  ['cmpsb', { kind:'cmps', widthBits:8 }], ['cmpsw', { kind:'cmps', widthBits:16 }],
  ['cmpsd', { kind:'cmps', widthBits:32, ambiguous:true }], ['cmpsq', { kind:'cmps', widthBits:64 }],
  ['scasb', { kind:'scas', widthBits:8 }], ['scasw', { kind:'scas', widthBits:16 }],
  ['scasd', { kind:'scas', widthBits:32 }], ['scasq', { kind:'scas', widthBits:64 }],
]);
const SEGMENT_PREFIX = new Map([[0x2e,'cs'],[0x36,'ss'],[0x3e,'ds'],[0x26,'es'],[0x64,'fs'],[0x65,'gs']]);

function legacyPrefixes(instruction) { return [...(instruction?.detail?.prefixes?.legacy || [])]; }
function addressSizeBits(instruction) { const width = Number(instruction?.detail?.addressSizeBits || 64); return width === 32 || width === 64 ? width : null; }
function accumulatorName(widthBits) { return ({8:'al',16:'ax',32:'eax',64:'rax'})[widthBits] || null; }
function pointerName(role, widthBits) {
  if (role === 'source') return widthBits === 32 ? 'esi' : 'rsi';
  if (role === 'destination') return widthBits === 32 ? 'edi' : 'rdi';
  if (role === 'count') return widthBits === 32 ? 'ecx' : 'rcx';
  return null;
}
function sourceSegment(instruction) { let segment = 'ds'; for (const prefix of legacyPrefixes(instruction)) if (SEGMENT_PREFIX.has(prefix)) segment = SEGMENT_PREFIX.get(prefix); return segment; }
function repeatKind(instruction, kind) {
  const prefixes = legacyPrefixes(instruction);
  if (prefixes.includes(0xf2)) return kind === 'cmps' || kind === 'scas' ? 'repne' : 'unsupported-f2';
  if (prefixes.includes(0xf3)) return kind === 'cmps' || kind === 'scas' ? 'repe' : 'rep';
  return null;
}
function physicalSet(values) { return new Set((values || []).map((entry) => entry?.physicalId || entry?.id).filter(Boolean)); }
function ambiguousStringFormIsProven(instruction, spec) {
  if (!spec.ambiguous) return true;
  const operands = instruction?.detail?.operands || [];
  if (operands.some((operand) => operand?.type === 'register' && operand.register?.kind === 'vector')) return false;
  const reads = physicalSet(instruction?.detail?.implicitReads), writes = physicalSet(instruction?.detail?.implicitWrites);
  return (reads.has('rsi') || writes.has('rsi')) && (reads.has('rdi') || writes.has('rdi'));
}
function stringMemoryOperand(role, widthBits, addressBits, segment) {
  const register = x86RegisterOperand(pointerName(role, addressBits));
  if (!register) return null;
  return Object.freeze({ type:'memory', widthBits, access:'unknown', memory:Object.freeze({ base:register.register, index:null, scale:1, displacement:0n, segment, addressSizeBits:addressBits }) });
}
function stringAddress(ctx, role, spec, addressBits) {
  const segment = role === 'source' ? sourceSegment(ctx.instruction) : 'es';
  const operand = stringMemoryOperand(role, spec.widthBits, addressBits, segment);
  return operand ? x86EffectiveAddressExpression(ctx.instruction, operand) : null;
}
function updatePointer(ctx, role, addressBits, elementBytes, directionFlag) {
  const operand = x86RegisterOperand(pointerName(role, addressBits));
  const current = operand ? ctx.readRegister(operand) : null;
  if (!current) return false;
  const inc = ctx.valueOp('add', [current,ctx.constant(addressBits,BigInt(elementBytes))], addressBits, { semantic:'x86-string-pointer-increment', role, elementBytes, addressSizeBits:addressBits, wrap:true });
  const dec = ctx.valueOp('sub', [current,ctx.constant(addressBits,BigInt(elementBytes))], addressBits, { semantic:'x86-string-pointer-decrement', role, elementBytes, addressSizeBits:addressBits, wrap:true });
  const next = ctx.valueOp('select', [directionFlag,dec,inc], addressBits, { semantic:'x86-string-direction-select', condition:'DF', truePath:'decrement', falsePath:'increment', elementBytes });
  return ctx.writeRegister(operand, next);
}
function repeatedStringPartial(ctx, spec, repeat, addressBits) {
  const countName = pointerName('count', addressBits), readNames = [], writtenNames = [countName], inputs = [];
  const countOperand = x86RegisterOperand(countName), count = countOperand ? ctx.readRegister(countOperand) : null;
  if (count) { inputs.push(count); readNames.push(countName); }
  inputs.push(ctx.readFlag('DF'));
  if (['movs','lods','cmps'].includes(spec.kind)) {
    const name = pointerName('source', addressBits), op = x86RegisterOperand(name), value = op ? ctx.readRegister(op) : null;
    if (value) inputs.push(value); readNames.push(name); writtenNames.push(name);
  }
  if (['movs','stos','cmps','scas'].includes(spec.kind)) {
    const name = pointerName('destination', addressBits), op = x86RegisterOperand(name), value = op ? ctx.readRegister(op) : null;
    if (value) inputs.push(value); readNames.push(name); writtenNames.push(name);
  }
  if (spec.kind === 'stos' || spec.kind === 'scas') {
    const name = accumulatorName(spec.widthBits), op = x86RegisterOperand(name), value = op ? ctx.readRegister(op) : null;
    if (value) inputs.push(value); readNames.push(name);
  }
  if (spec.kind === 'lods') writtenNames.push(accumulatorName(spec.widthBits));
  if (spec.kind === 'cmps' || spec.kind === 'scas') writtenNames.push('rflags');
  const readsMemory = ['movs','lods','cmps','scas'].includes(spec.kind), writesMemory = spec.kind === 'movs' || spec.kind === 'stos';
  ctx.intrinsic(`x86.${repeat}.${spec.kind}.${spec.widthBits}`, inputs, [], {
    registersRead:readNames, registersWritten:writtenNames,
    memoryRead:readsMemory ? { scope:'unknown', detail:{ repeated:true, elementWidthBits:spec.widthBits, directionFromDF:true, countRegister:countName } } : { scope:'none' },
    memoryWrite:writesMemory ? { scope:'unknown', detail:{ repeated:true, elementWidthBits:spec.widthBits, directionFromDF:true, countRegister:countName } } : { scope:'none' },
    determinism:'input-dependent', symbolicDetail:'summary-only',
    metadata:{ boundedSummary:true, runtimeCountNotUnrolled:true, repeatKind:repeat, repeatCondition:repeat === 'repe' ? 'RCX != 0 && ZF == 1' : repeat === 'repne' ? 'RCX != 0 && ZF == 0' : 'RCX != 0', counterBehavior:'decrement once per completed element', directionBehavior:'DF=0 increment, DF=1 decrement', elementWidthBits:spec.widthBits, exactArchitecturalSummary:false },
  });
  const possibleFaults = [];
  if (readsMemory) possibleFaults.push(...x86MemoryFaults('read', spec.widthBits));
  if (writesMemory) possibleFaults.push(...x86MemoryFaults('write', spec.widthBits));
  return ctx.partial('x86-repeated-string-effect-scope-not-fully-representable-by-frozen-p5-0-intrinsic-contract', ['memory','registers', ...(spec.kind === 'cmps' || spec.kind === 'scas' ? ['flags'] : [])], {
    possibleFaults,
    detail:{ repeatKind:repeat, boundedRepresentation:true, runtimeCountUnrolled:false, directionFlagAssumedClear:false, unknownMemoryScope:true },
    metadata:{ family:'string', operation:spec.kind, elementWidthBits:spec.widthBits, addressSizeBits:addressBits, repeatKind:repeat, boundedRepresentation:true, exactIntrinsicRejected:true },
  });
}
function liftSingleString(ctx, spec, addressBits) {
  const elementBytes = spec.widthBits / 8, df = ctx.readFlag('DF'), possibleFaults = [];
  let sourceAddress = null, destinationAddress = null;
  if (['movs','lods','cmps'].includes(spec.kind)) { sourceAddress = stringAddress(ctx,'source',spec,addressBits); if (!sourceAddress) return ctx.partial('x86-string-source-address-unmodelled',['memory','registers']); }
  if (['movs','stos','cmps','scas'].includes(spec.kind)) { destinationAddress = stringAddress(ctx,'destination',spec,addressBits); if (!destinationAddress) return ctx.partial('x86-string-destination-address-unmodelled',['memory','registers']); }
  if (spec.kind === 'movs') {
    const value = ctx.readMemory(sourceAddress.expression,spec.widthBits,{space:sourceAddress.space,metadata:{...sourceAddress.metadata,stringRole:'source',elementWidthBits:spec.widthBits}});
    ctx.writeMemory(destinationAddress.expression,spec.widthBits,value,{space:destinationAddress.space,metadata:{...destinationAddress.metadata,stringRole:'destination',elementWidthBits:spec.widthBits}});
    possibleFaults.push(...x86MemoryFaults('read',spec.widthBits),...x86MemoryFaults('write',spec.widthBits));
    if (!updatePointer(ctx,'source',addressBits,elementBytes,df) || !updatePointer(ctx,'destination',addressBits,elementBytes,df)) return ctx.partial('x86-movs-pointer-update-unmodelled',['registers']);
  } else if (spec.kind === 'stos') {
    const acc = x86RegisterOperand(accumulatorName(spec.widthBits)), value = acc ? ctx.readRegister(acc) : null;
    if (!value) return ctx.partial('x86-stos-accumulator-unmodelled',['registers','memory']);
    ctx.writeMemory(destinationAddress.expression,spec.widthBits,value,{space:destinationAddress.space,metadata:{...destinationAddress.metadata,stringRole:'destination',accumulator:acc.register.id}});
    possibleFaults.push(...x86MemoryFaults('write',spec.widthBits));
    if (!updatePointer(ctx,'destination',addressBits,elementBytes,df)) return ctx.partial('x86-stos-pointer-update-unmodelled',['registers']);
  } else if (spec.kind === 'lods') {
    const value = ctx.readMemory(sourceAddress.expression,spec.widthBits,{space:sourceAddress.space,metadata:{...sourceAddress.metadata,stringRole:'source',elementWidthBits:spec.widthBits}}), acc = x86RegisterOperand(accumulatorName(spec.widthBits));
    if (!acc || !ctx.writeRegister(acc,value)) return ctx.partial('x86-lods-accumulator-unmodelled',['registers','memory']);
    possibleFaults.push(...x86MemoryFaults('read',spec.widthBits));
    if (!updatePointer(ctx,'source',addressBits,elementBytes,df)) return ctx.partial('x86-lods-pointer-update-unmodelled',['registers']);
  } else if (spec.kind === 'cmps') {
    const left = ctx.readMemory(sourceAddress.expression,spec.widthBits,{space:sourceAddress.space,metadata:{...sourceAddress.metadata,stringRole:'source',compareOperand:'left'}}), right = ctx.readMemory(destinationAddress.expression,spec.widthBits,{space:destinationAddress.space,metadata:{...destinationAddress.metadata,stringRole:'destination',compareOperand:'right'}}), result = ctx.valueOp('sub',[left,right],spec.widthBits,{compareOnly:true,semantic:'x86-cmps'});
    emitX86ArithmeticFlags(ctx,'cmp',left,right,result,spec.widthBits); possibleFaults.push(...x86MemoryFaults('read',spec.widthBits),...x86MemoryFaults('read',spec.widthBits));
    if (!updatePointer(ctx,'source',addressBits,elementBytes,df) || !updatePointer(ctx,'destination',addressBits,elementBytes,df)) return ctx.partial('x86-cmps-pointer-update-unmodelled',['registers','flags']);
  } else if (spec.kind === 'scas') {
    const acc = x86RegisterOperand(accumulatorName(spec.widthBits)), left = acc ? ctx.readRegister(acc) : null;
    if (!left) return ctx.partial('x86-scas-accumulator-unmodelled',['registers','memory','flags']);
    const right = ctx.readMemory(destinationAddress.expression,spec.widthBits,{space:destinationAddress.space,metadata:{...destinationAddress.metadata,stringRole:'destination',compareOperand:'right'}}), result = ctx.valueOp('sub',[left,right],spec.widthBits,{compareOnly:true,semantic:'x86-scas'});
    emitX86ArithmeticFlags(ctx,'cmp',left,right,result,spec.widthBits); possibleFaults.push(...x86MemoryFaults('read',spec.widthBits));
    if (!updatePointer(ctx,'destination',addressBits,elementBytes,df)) return ctx.partial('x86-scas-pointer-update-unmodelled',['registers','flags']);
  }
  return ctx.finish({ family:'string', possibleFaults, metadata:{ operation:spec.kind, elementWidthBits:spec.widthBits, addressSizeBits:addressBits, repeatKind:null, directionFlag:'explicit-read', dfZeroDelta:elementBytes, dfOneDelta:-elementBytes, sourceAddress:sourceAddress?.metadata ?? null, destinationAddress:destinationAddress?.metadata ?? null } });
}
export function liftX86StringEffects(instruction, context = {}) {
  const family = String(instruction?.instructionFamily || '').toLowerCase(), spec = STRING_FAMILIES.get(family);
  if (!spec || !ambiguousStringFormIsProven(instruction,spec)) return null;
  const ctx = createX86EffectContext(instruction,context), addressBits = addressSizeBits(ctx.instruction);
  if (!addressBits) return ctx.partial('x86-string-address-size-unmodelled',['memory','registers']);
  const repeat = repeatKind(ctx.instruction,spec.kind);
  if (repeat === 'unsupported-f2') return ctx.partial('x86-string-f2-repeat-prefix-not-proven-for-this-family',['memory','registers','flags'],{metadata:{family:'string',operation:spec.kind,lockIgnored:false,prefix:0xf2}});
  return repeat ? repeatedStringPartial(ctx,spec,repeat,addressBits) : liftSingleString(ctx,spec,addressBits);
}
