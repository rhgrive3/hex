import { ABIPlugin } from './registry.js';
import { MICROSOFT_X64_ABI, callPrototypeOf, parameterClass, typeBits } from './microsoft-x64.js';

const INTEGER_ARGUMENT_REGISTERS = Object.freeze(['rcx','rdx','r8','r9']);
const VECTOR_REGISTER_COUNT = 6;
const VECTORCALL_NAMES = new Set(['vectorcall','microsoft-vectorcall']);

function parameterList(prototype) {
  const list = prototype && (prototype.args || prototype.parameters || prototype.params || prototype.arguments);
  return Array.isArray(list) ? list : null;
}

function canonicalConvention(value) {
  return String(value || '').trim().toLowerCase().replace(/^__/, '');
}

function conventionOf(prototype, options = {}) {
  return canonicalConvention(options.callingConvention ?? options.convention ?? options.cc
    ?? prototype?.callingConvention ?? prototype?.convention ?? prototype?.cc ?? null);
}

function vectorRegister(index, bits) {
  if (bits > 256) return `zmm${index}`;
  if (bits > 128) return `ymm${index}`;
  return `xmm${index}`;
}

function unsupported(convention) {
  return {
    srcs:[], arguments:[], stackArguments:[], stackArgsUnknown:true,
    stackArgsMayContainPointers:true, partial:true, unsupported:true,
    reason:'microsoft-vectorcall-calling-convention-mismatch',
    callingConvention:convention,
    evidence:'unsupported-microsoft-vectorcall-convention',
  };
}

function appendSource(srcs, reg, bits, extra = {}) {
  srcs.push({ t:'reg', reg, bits, possible:false, mustUse:true, ...extra });
}

function hvaInfo(parameter, classified) {
  const type = `${classified.type} ${classified.abiClass}`;
  const hva = parameter?.hva === true || parameter?.hfa === true || /hva|homogeneous vector/.test(type);
  const members = Math.max(1, Math.min(4, Number(parameter?.members || parameter?.elements || parameter?.count || 1) || 1));
  const elementBits = Math.max(64, Math.min(256, Number(parameter?.elementBits || parameter?.memberBits || (classified.bits / members) || classified.bits) || classified.bits));
  return { hva, members, elementBits };
}

export function classifyMicrosoftVectorcallArguments(instruction, options = {}) {
  const prototype = callPrototypeOf(instruction, options);
  const convention = conventionOf(prototype, options);
  if (convention && !VECTORCALL_NAMES.has(convention)) return unsupported(convention);
  const parameters = parameterList(prototype);
  if (!parameters) {
    const srcs = [
      ...INTEGER_ARGUMENT_REGISTERS.map((reg) => ({ t:'reg', reg, bits:64, possible:true, mustUse:false })),
      ...Array.from({ length:VECTOR_REGISTER_COUNT }, (_value, index) => ({ t:'reg', reg:`xmm${index}`, bits:128, possible:true, mustUse:false, wideVectorPossible:true })),
    ];
    return {
      srcs,
      arguments:srcs.map((source) => ({ location:'register', reg:source.reg, bits:source.bits, possible:true, mustUse:false })),
      stackArguments:[], stackArgsUnknown:true, stackArgsMayContainPointers:true,
      partial:true, evidence:'conservative-microsoft-vectorcall',
    };
  }

  const srcs = [];
  const arguments_ = [];
  const stackArguments = [];
  let vectorIndex = 0;
  let stackIndex = 0;
  let stackArgsMayContainPointers = false;

  parameters.forEach((parameter, index) => {
    const classified = parameterClass(parameter);
    const hva = hvaInfo(parameter, classified);
    const vectorValue = classified.vector || hva.hva;
    if (vectorValue) {
      const regsNeeded = hva.hva ? hva.members : 1;
      const elementBits = hva.hva ? hva.elementBits : classified.bits;
      if (elementBits <= 256 && vectorIndex + regsNeeded <= VECTOR_REGISTER_COUNT) {
        const regs = [];
        for (let n = 0; n < regsNeeded; n++) {
          const reg = vectorRegister(vectorIndex++, elementBits);
          regs.push(reg);
          appendSource(srcs, reg, elementBits, { purpose:hva.hva?'vectorcall-hva':'vectorcall-vector' });
        }
        arguments_.push({
          index, location:'register', reg:regs[0], regs,
          abiClass:hva.hva?'hva':'vector', bits:classified.bits,
          vectorElementBits:elementBits, pointer:false,
          possible:false, mustUse:true,
        });
        return;
      }
      const offset = 32 + stackIndex++ * 8;
      const entry = {
        index, location:'stack', offset, offsetBase:'caller-stack-before-call', calleeEntryOffset:offset + 8,
        bytes:8, abiClass:hva.hva?'hva-indirect':'vector-indirect', pointer:true,
        bits:64, pointeeBits:classified.bits, requiredTemporaryAlignment:Math.min(32, Math.max(16, Math.ceil(classified.bits / 8))),
        possible:false, mustUse:true,
      };
      arguments_.push(entry); stackArguments.push(entry); stackArgsMayContainPointers = true;
      return;
    }

    if (classified.aggregate) {
      const offsetOrPosition = index;
      if (offsetOrPosition < INTEGER_ARGUMENT_REGISTERS.length) {
        const reg = INTEGER_ARGUMENT_REGISTERS[offsetOrPosition];
        appendSource(srcs, reg, 64, { purpose:'vectorcall-aggregate-by-reference' });
        arguments_.push({ index, location:'register', reg, abiClass:'aggregate-indirect', pointer:true, bits:64, pointeeBits:classified.bits, possible:false, mustUse:true });
      } else {
        const offset = 32 + stackIndex++ * 8;
        const entry = { index, location:'stack', offset, offsetBase:'caller-stack-before-call', calleeEntryOffset:offset + 8, bytes:8, abiClass:'aggregate-indirect', pointer:true, bits:64, pointeeBits:classified.bits, possible:false, mustUse:true };
        arguments_.push(entry); stackArguments.push(entry);
      }
      stackArgsMayContainPointers = true;
      return;
    }

    if (index < INTEGER_ARGUMENT_REGISTERS.length) {
      if (classified.floating) {
        const reg = vectorRegister(Math.min(index, VECTOR_REGISTER_COUNT - 1), classified.bits);
        appendSource(srcs, reg, classified.bits, { purpose:'vectorcall-scalar-fp' });
        arguments_.push({ index, location:'register', reg, abiClass:'fp', pointer:false, bits:classified.bits, possible:false, mustUse:true });
      } else {
        const reg = INTEGER_ARGUMENT_REGISTERS[index];
        appendSource(srcs, reg, 64, { purpose:'vectorcall-integer' });
        arguments_.push({ index, location:'register', reg, abiClass:classified.pointer?'pointer':'integer', pointer:classified.pointer, bits:classified.bits, possible:false, mustUse:true });
        stackArgsMayContainPointers ||= classified.pointer;
      }
      return;
    }

    const offset = 32 + stackIndex++ * 8;
    const entry = { index, location:'stack', offset, offsetBase:'caller-stack-before-call', calleeEntryOffset:offset + 8, bytes:8, abiClass:classified.floating?'fp':classified.pointer?'pointer':'integer', pointer:classified.pointer, bits:classified.bits, possible:false, mustUse:true };
    arguments_.push(entry); stackArguments.push(entry); stackArgsMayContainPointers ||= classified.pointer;
  });

  return {
    srcs, arguments:arguments_, stackArguments,
    stackArgsUnknown:prototype?.variadic===true||prototype?.varargs===true,
    stackArgsMayContainPointers:stackArgsMayContainPointers || prototype?.variadic===true || prototype?.varargs===true,
    partial:prototype?.variadic===true||prototype?.varargs===true,
    callingConvention:'vectorcall',
    evidence:'prototype-microsoft-vectorcall',
  };
}

function vectorcallReturn(prototype, options = {}) {
  if (!prototype) return { reg:null, partial:true, reason:'prototype-missing' };
  const convention = conventionOf(prototype, options);
  if (convention && !VECTORCALL_NAMES.has(convention)) return { reg:null, partial:true, unsupported:true, reason:'microsoft-vectorcall-calling-convention-mismatch' };
  const type = String(options.returnType || prototype.returnType || prototype.ret || prototype.result || '').trim().toLowerCase();
  const abiClass = String(options.returnClass || prototype.returnClass || prototype.abiClass || prototype.resultClass || '').trim().toLowerCase();
  if (options.returnsValue === false || prototype.returnsValue === false || prototype.void === true || type === 'void' || abiClass === 'void') return null;
  const vector = /vector|simd|sse|__m128|__m256/.test(`${type} ${abiClass}`);
  if (vector) {
    const rawBits = Number(options.returnBits ?? prototype.returnBits ?? prototype.bits ?? typeBits(type, /__m256/.test(type) ? 256 : 128));
    const bits = Number.isSafeInteger(rawBits) && rawBits > 0 ? rawBits : 128;
    if (bits <= 256) return { reg:vectorRegister(0, bits), bits, abiClass:'vector' };
    return { reg:null, partial:true, reason:'microsoft-vectorcall-wide-vector-return-unsupported' };
  }
  if (/float|double|\bfp\b/.test(`${type} ${abiClass}`)) {
    const bits = Number(options.returnBits ?? prototype.returnBits ?? prototype.bits ?? typeBits(type, 64)) || 64;
    return { reg:'xmm0', bits, abiClass:'fp' };
  }
  const aggregate = prototype.aggregate === true || /aggregate|struct|union|record|array/.test(`${type} ${abiClass}`);
  if (aggregate) return { reg:null, partial:true, reason:'microsoft-vectorcall-non-hva-aggregate-return-requires-layout-proof' };
  if (type || abiClass || options.returnsValue === true || prototype.returnsValue === true) {
    return { reg:'rax', bits:Number(options.returnBits ?? prototype.returnBits ?? prototype.bits ?? 64) || 64 };
  }
  return { reg:null, partial:true, reason:'return-value-evidence-missing' };
}

export function classifyMicrosoftVectorcallCallReturn(instruction, options = {}) {
  return vectorcallReturn(callPrototypeOf(instruction, options), options);
}

export function classifyMicrosoftVectorcallFunctionReturn(options = {}) {
  return vectorcallReturn(options.functionPrototype || options.prototype || {}, options);
}

export const MICROSOFT_VECTORCALL_ABI = new ABIPlugin({
  id:'microsoft-vectorcall', semanticVersion:'1', semanticIdentity:'microsoft-vectorcall@1', architectureId:'x86_64',
  platformPredicate:({ platform }) => ['windows','win32','windows-nt','pe'].includes(platform),
  callingConventions:()=>Object.freeze(['vectorcall','__vectorcall','microsoft-vectorcall']),
  classifyArguments:classifyMicrosoftVectorcallArguments,
  classifyCallReturn:classifyMicrosoftVectorcallCallReturn,
  classifyFunctionReturn:classifyMicrosoftVectorcallFunctionReturn,
  classifyEntryRegister:(reg) => MICROSOFT_X64_ABI.classifyEntryRegister(reg),
  callerSaved:()=>MICROSOFT_X64_ABI.callerSaved(),
  calleeSaved:()=>MICROSOFT_X64_ABI.calleeSaved(),
  stackRules:()=>Object.freeze({ ...MICROSOFT_X64_ABI.stackRules(), callingConvention:'vectorcall', vectorArgumentRegisters:6 }),
  redZone:()=>0,
  unwindRules:()=>MICROSOFT_X64_ABI.unwindRules(),
  defaultUnknownCallEffects:()=>Object.freeze({ ...MICROSOFT_X64_ABI.defaultUnknownCallEffects(), vectorcallEffects:'unknown' }),
});
