import { ABIPlugin } from './registry.js';

const INTEGER_ARGUMENT_REGISTERS = Object.freeze(['rdi','rsi','rdx','rcx','r8','r9']);
const VECTOR_ARGUMENT_REGISTERS = Object.freeze(Array.from({ length:8 }, (_value, index) => `xmm${index}`));
const CALLER_SAVED = Object.freeze([
  'rax','rcx','rdx','rsi','rdi','r8','r9','r10','r11','rflags',
  ...Array.from({ length:16 }, (_value, index) => `xmm${index}`),
]);
const CALLEE_SAVED = Object.freeze(['rbx','rbp','rsp','r12','r13','r14','r15']);

export const SYSV_AMD64_SCOPE = Object.freeze({
  scalarArguments:'exact',
  scalarReturns:'exact',
  sseArguments:'exact-through-xmm0-xmm7-for-explicit-scalar-or-128-bit-vector-types',
  aggregates:'partial-unclassified',
  variadic:'partial-fixed-parameters-and-vector-count-state',
  x87:'unsupported',
});

function callPrototypeOf(instruction, options) {
  let prototype = instruction?.callPrototype ?? null;
  if (!prototype) {
    try { prototype = options?.callPrototypeFor?.(instruction?.callTarget ?? null, instruction) ?? null; }
    catch { prototype = null; }
  }
  return prototype;
}

function parameterList(prototype) {
  const list = prototype && (prototype.args || prototype.parameters || prototype.params || prototype.arguments);
  return Array.isArray(list) ? list : null;
}

function typeBits(type, fallback = 64) {
  if (/\b(?:bool|char|int8|uint8)\b/.test(type)) return 8;
  if (/\b(?:short|int16|uint16)\b/.test(type)) return 16;
  if (/\b(?:int|unsigned int|int32|uint32|float)\b/.test(type)) return 32;
  if (/\b(?:double|long|int64|uint64|pointer|ptr)\b|\*/.test(type)) return 64;
  return fallback;
}

function parameterClass(parameter) {
  const type = String(parameter?.type || parameter?.name || '').trim().toLowerCase();
  const abiClass = String(parameter?.abiClass || parameter?.class || parameter?.kind || '').trim().toLowerCase();
  const pointer = parameter?.pointer === true || parameter?.isPointer === true
    || /\*|pointer|ptr|object|class|block|closure/.test(`${type} ${abiClass}`);
  const aggregate = parameter?.aggregate === true || parameter?.isAggregate === true
    || /aggregate|struct|union|record|array/.test(`${type} ${abiClass}`);
  const vector = parameter?.vector === true || /vector|simd|sse/.test(`${type} ${abiClass}`);
  const floating = !aggregate && (parameter?.floating === true || /(^|\s)(?:float|double)(?:\s|$)|\bfp\b/.test(`${type} ${abiClass}`));
  const rawBits = Number(parameter?.bits || parameter?.sizeBits || (pointer ? 64 : typeBits(type, vector ? 128 : 64)));
  const bits = Number.isSafeInteger(rawBits) && rawBits > 0 ? Math.min(128, rawBits) : 64;
  return { type, abiClass, pointer, aggregate, vector, floating, bits };
}

function appendRegisterSource(sources, seen, reg, bits, extra = {}) {
  if (seen.has(reg)) return;
  seen.add(reg);
  sources.push({ t:'reg', reg, bits, ...extra });
}

function align(value, alignment) {
  return Math.ceil(value / alignment) * alignment;
}

function conservativeUnknownArguments() {
  const srcs = [
    ...INTEGER_ARGUMENT_REGISTERS.map((reg) => ({ t:'reg', reg, bits:64 })),
    ...VECTOR_ARGUMENT_REGISTERS.map((reg) => ({ t:'reg', reg, bits:128 })),
  ];
  return {
    srcs,
    arguments:srcs.map((source, index) => ({
      index,
      location:'register',
      reg:source.reg,
      bits:source.bits,
      abiClass:source.reg.startsWith('xmm') ? 'unknown-sse' : 'unknown-integer',
    })),
    stackArguments:[],
    stackArgsUnknown:true,
    stackArgsMayContainPointers:true,
    aggregateClassification:'partial-unproven',
    variadicClassification:'partial-unproven',
    partial:true,
    scope:SYSV_AMD64_SCOPE,
    evidence:'conservative-sysv-amd64',
  };
}

export function classifySysVAMD64Arguments(instruction, options = {}) {
  const prototype = callPrototypeOf(instruction, options);
  const parameters = parameterList(prototype);
  if (!parameters) return conservativeUnknownArguments();

  const srcs = [];
  const seenSources = new Set();
  const arguments_ = [];
  const stackArguments = [];
  let integerIndex = 0;
  let vectorIndex = 0;
  let stackOffset = 0;
  let allocationUnknown = false;
  let aggregatePartial = false;
  let stackArgsMayContainPointers = false;

  parameters.forEach((parameter, index) => {
    const classified = parameterClass(parameter);
    if (allocationUnknown || classified.aggregate) {
      aggregatePartial ||= classified.aggregate;
      allocationUnknown = true;
      const candidateRegisters = [
        ...INTEGER_ARGUMENT_REGISTERS.slice(integerIndex),
        ...VECTOR_ARGUMENT_REGISTERS.slice(vectorIndex),
      ];
      for (const reg of INTEGER_ARGUMENT_REGISTERS.slice(integerIndex)) appendRegisterSource(srcs, seenSources, reg, 64);
      for (const reg of VECTOR_ARGUMENT_REGISTERS.slice(vectorIndex)) appendRegisterSource(srcs, seenSources, reg, 128);
      arguments_.push({
        index,
        location:'unknown',
        candidateRegisters,
        stackPossible:true,
        abiClass:classified.aggregate ? 'aggregate-partial' : 'allocation-after-unclassified-aggregate',
        pointer:classified.pointer,
        bits:classified.bits,
        partial:true,
      });
      stackArgsMayContainPointers = true;
      return;
    }

    if ((classified.floating || classified.vector) && vectorIndex < VECTOR_ARGUMENT_REGISTERS.length) {
      const reg = VECTOR_ARGUMENT_REGISTERS[vectorIndex++];
      appendRegisterSource(srcs, seenSources, reg, classified.vector ? 128 : classified.bits);
      arguments_.push({
        index, location:'register', reg,
        abiClass:classified.vector ? 'sse-vector' : 'sse-scalar',
        pointer:false, bits:classified.bits,
      });
      return;
    }

    if (!classified.floating && !classified.vector && integerIndex < INTEGER_ARGUMENT_REGISTERS.length) {
      const reg = INTEGER_ARGUMENT_REGISTERS[integerIndex++];
      appendRegisterSource(srcs, seenSources, reg, 64);
      arguments_.push({
        index, location:'register', reg,
        abiClass:classified.pointer ? 'pointer' : 'integer',
        pointer:classified.pointer, bits:classified.bits,
      });
      return;
    }

    const slotAlignment = classified.vector ? 16 : 8;
    const bytes = align(Math.max(8, Math.ceil(classified.bits / 8)), slotAlignment);
    stackOffset = align(stackOffset, slotAlignment);
    const entry = {
      index,
      location:'stack',
      offset:stackOffset,
      offsetBase:'incoming-stack-arguments',
      calleeEntryOffset:8 + stackOffset,
      bytes,
      abiClass:classified.vector ? 'sse-vector' : classified.floating ? 'sse-scalar' : classified.pointer ? 'pointer' : 'integer',
      pointer:classified.pointer,
      bits:classified.bits,
    };
    stackArguments.push(entry);
    arguments_.push(entry);
    stackOffset += bytes;
    stackArgsMayContainPointers ||= classified.pointer;
  });

  const variadic = prototype?.variadic === true || prototype?.varargs === true;
  return {
    srcs,
    arguments:arguments_,
    stackArguments,
    stackArgsUnknown:allocationUnknown || variadic,
    stackArgsMayContainPointers:stackArgsMayContainPointers || allocationUnknown || variadic,
    aggregateClassification:aggregatePartial ? 'partial-unproven' : 'not-required',
    variadicClassification:variadic ? 'partial-fixed-parameters-only' : 'not-variadic',
    implicitInputs:variadic ? [{ t:'reg', reg:'rax', view:'al', bits:8, purpose:'sse-register-argument-count' }] : [],
    variadicVectorRegisterCount:variadic ? vectorIndex : null,
    partial:aggregatePartial || variadic,
    scope:SYSV_AMD64_SCOPE,
    evidence:'prototype-sysv-amd64',
  };
}

function classifyReturn(prototype, options = {}) {
  if (!prototype) return null;
  const type = String(options.returnType || prototype.returnType || prototype.ret || prototype.result || '').trim().toLowerCase();
  const abiClass = String(options.returnClass || prototype.returnClass || prototype.abiClass || prototype.resultClass || '').trim().toLowerCase();
  if (options.returnsValue === false || prototype.returnsValue === false || prototype.void === true || type === 'void' || abiClass === 'void') return null;
  if (prototype.indirectResult === true || abiClass === 'indirect') return null;
  if (/long double|x87/.test(`${type} ${abiClass}`)) {
    return { reg:null, partial:true, unsupported:true, reason:'sysv-amd64-x87-return-outside-claimed-scope' };
  }
  if (prototype.aggregate === true || /aggregate|struct|union|record|array/.test(`${type} ${abiClass}`)) {
    return { reg:null, partial:true, reason:'sysv-amd64-aggregate-return-classification-not-proven' };
  }
  const vector = /vector|simd|sse/.test(`${type} ${abiClass}`);
  const floating = vector || /(^|\s)(?:float|double)(?:\s|$)|\bfp\b/.test(`${type} ${abiClass}`);
  const rawBits = Number(prototype.returnBits || prototype.bits || options.returnBits || typeBits(type, vector ? 128 : 64));
  const bits = Number.isSafeInteger(rawBits) && rawBits > 0 ? Math.min(128, rawBits) : 64;
  if (floating) return { reg:'xmm0', bits };
  if (type || abiClass || options.returnsValue === true || prototype.returnsValue === true) return { reg:'rax', bits };
  return null;
}

export function classifySysVAMD64CallReturn(instruction, options = {}) {
  return classifyReturn(callPrototypeOf(instruction, options), options);
}

export function classifySysVAMD64FunctionReturn(options = {}) {
  return classifyReturn(options.functionPrototype || options.prototype || {}, options);
}

export const SYSV_AMD64_ABI = new ABIPlugin({
  id:'sysv-amd64',
  semanticVersion:'1',
  architectureId:'x86_64',
  platformPredicate:({ platform }) => !platform || ['linux','freebsd','netbsd','openbsd','solaris','unix','unknown'].includes(platform),
  callingConventions:()=>Object.freeze(['sysv-amd64']),
  classifyArguments:classifySysVAMD64Arguments,
  classifyCallReturn:classifySysVAMD64CallReturn,
  classifyFunctionReturn:classifySysVAMD64FunctionReturn,
  classifyEntryRegister:(reg) => {
    const id = String(reg || '').toLowerCase();
    const integerIndex = INTEGER_ARGUMENT_REGISTERS.indexOf(id);
    if (integerIndex >= 0) return { kind:'argument', reg:id, index:integerIndex, abiClass:'integer' };
    const vectorIndex = VECTOR_ARGUMENT_REGISTERS.indexOf(id);
    if (vectorIndex >= 0) return { kind:'argument', reg:id, index:vectorIndex, abiClass:'sse' };
    return { kind:'incoming-register-state', reg:id };
  },
  callerSaved:()=>CALLER_SAVED,
  calleeSaved:()=>CALLEE_SAVED,
  stackRules:()=>Object.freeze({
    alignment:16,
    stackGrows:'down',
    argumentSlotBytes:8,
    returnAddressBytes:8,
    calleeEntryAlignmentOffset:8,
    shadowSpaceBytes:0,
    aggregateClassification:'partial',
    variadicRegisterSaveAreaBytes:176,
  }),
  redZone:()=>128,
  unwindRules:()=>Object.freeze({ framePointer:'rbp', returnAddress:'stack', returnAddressOffset:0 }),
  defaultUnknownCallEffects:()=>Object.freeze({
    registerClobbers:CALLER_SAVED,
    memoryEffects:'unknown',
    mayThrow:true,
    redZonePreservedAcrossCall:false,
    aggregateEffects:'unknown',
    variadicEffects:'unknown',
  }),
});
