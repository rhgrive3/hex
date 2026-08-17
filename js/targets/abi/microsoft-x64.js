import { ABIPlugin } from './registry.js';

const INTEGER_ARGUMENT_REGISTERS = Object.freeze(['rcx','rdx','r8','r9']);
const VECTOR_ARGUMENT_REGISTERS = Object.freeze(['xmm0','xmm1','xmm2','xmm3']);
const CALLER_SAVED = Object.freeze([
  'rax','rcx','rdx','r8','r9','r10','r11','rflags',
  ...Array.from({ length:6 }, (_value, index) => `xmm${index}`),
]);
const CALLEE_SAVED = Object.freeze([
  'rbx','rbp','rdi','rsi','rsp','r12','r13','r14','r15',
  ...Array.from({ length:10 }, (_value, index) => `xmm${index + 6}`),
]);

export const MICROSOFT_X64_SCOPE = Object.freeze({
  scalarArguments:'exact',
  scalarReturns:'exact',
  vectorArguments:'partial-default-convention-indirect-classification',
  aggregates:'partial-unclassified',
  variadic:'partial-fixed-parameters-with-floating-register-mirroring',
  vectorNonvolatility:'xmm6-xmm15-low-128-bits',
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
  if (/\b(?:int|unsigned int|long|unsigned long|int32|uint32|float)\b/.test(type)) return 32;
  if (/\b(?:double|long long|int64|uint64|pointer|ptr)\b|\*/.test(type)) return 64;
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

function appendSource(sources, seen, reg, bits, extra = {}) {
  const key = `${reg}:${bits}:${extra.purpose || ''}`;
  if (seen.has(key)) return;
  seen.add(key);
  sources.push({ t:'reg', reg, bits, ...extra });
}

function conservativeUnknownArguments() {
  const srcs = [
    ...INTEGER_ARGUMENT_REGISTERS.map((reg) => ({ t:'reg', reg, bits:64 })),
    ...VECTOR_ARGUMENT_REGISTERS.map((reg) => ({ t:'reg', reg, bits:128 })),
  ];
  return {
    srcs,
    arguments:srcs.map((source, index) => ({
      index:index % 4,
      location:'register',
      reg:source.reg,
      bits:source.bits,
      abiClass:source.reg.startsWith('xmm') ? 'unknown-vector-position' : 'unknown-integer-position',
    })),
    stackArguments:[],
    stackArgsUnknown:true,
    stackArgsMayContainPointers:true,
    aggregateClassification:'partial-unproven',
    variadicClassification:'partial-unproven',
    partial:true,
    scope:MICROSOFT_X64_SCOPE,
    evidence:'conservative-microsoft-x64',
  };
}

export function classifyMicrosoftX64Arguments(instruction, options = {}) {
  const prototype = callPrototypeOf(instruction, options);
  const parameters = parameterList(prototype);
  if (!parameters) return conservativeUnknownArguments();

  const variadic = prototype?.variadic === true || prototype?.varargs === true;
  const srcs = [];
  const seenSources = new Set();
  const arguments_ = [];
  const stackArguments = [];
  let aggregatePartial = false;
  let stackArgsMayContainPointers = false;

  parameters.forEach((parameter, index) => {
    const classified = parameterClass(parameter);
    const registerPosition = index < 4;
    if (classified.aggregate || classified.vector) {
      aggregatePartial = true;
      if (registerPosition) {
        const candidates = [INTEGER_ARGUMENT_REGISTERS[index], VECTOR_ARGUMENT_REGISTERS[index]];
        appendSource(srcs, seenSources, candidates[0], 64, { purpose:'aggregate-candidate' });
        appendSource(srcs, seenSources, candidates[1], 128, { purpose:'aggregate-candidate' });
        arguments_.push({
          index,
          location:'unknown',
          candidateRegisters:candidates,
          stackPossible:false,
          abiClass:classified.vector ? 'vector-indirect-partial' : 'aggregate-or-indirect-partial',
          pointer:true,
          bits:classified.bits,
          partial:true,
        });
      } else {
        const offset = 32 + (index - 4) * 8;
        const entry = {
          index,
          location:'stack',
          offset,
          offsetBase:'caller-stack-before-call',
          calleeEntryOffset:offset + 8,
          bytes:8,
          abiClass:classified.vector ? 'vector-indirect-partial' : 'aggregate-or-indirect-partial',
          pointer:true,
          bits:classified.bits,
          partial:true,
        };
        arguments_.push(entry);
        stackArguments.push(entry);
      }
      stackArgsMayContainPointers = true;
      return;
    }

    if (registerPosition) {
      if (classified.floating || classified.vector) {
        const reg = VECTOR_ARGUMENT_REGISTERS[index];
        appendSource(srcs, seenSources, reg, classified.vector ? 128 : classified.bits);
        const entry = {
          index, location:'register', reg,
          abiClass:classified.vector ? 'vector' : 'fp',
          pointer:false, bits:classified.bits,
        };
        if (variadic) {
          entry.mirrorReg = INTEGER_ARGUMENT_REGISTERS[index];
          appendSource(srcs, seenSources, entry.mirrorReg, 64, { purpose:'variadic-floating-mirror' });
        }
        arguments_.push(entry);
      } else {
        const reg = INTEGER_ARGUMENT_REGISTERS[index];
        appendSource(srcs, seenSources, reg, 64);
        arguments_.push({
          index, location:'register', reg,
          abiClass:classified.pointer ? 'pointer' : 'integer',
          pointer:classified.pointer, bits:classified.bits,
        });
      }
      return;
    }

    const offset = 32 + (index - 4) * 8;
    const entry = {
      index,
      location:'stack',
      offset,
      offsetBase:'caller-stack-before-call',
      calleeEntryOffset:offset + 8,
      bytes:8,
      abiClass:classified.vector ? 'vector-reference-or-value' : classified.floating ? 'fp' : classified.pointer ? 'pointer' : 'integer',
      pointer:classified.pointer,
      bits:classified.bits,
    };
    stackArguments.push(entry);
    arguments_.push(entry);
    stackArgsMayContainPointers ||= classified.pointer;
  });

  return {
    srcs,
    arguments:arguments_,
    stackArguments,
    stackArgsUnknown:variadic,
    stackArgsMayContainPointers:stackArgsMayContainPointers || variadic,
    aggregateClassification:aggregatePartial ? 'partial-unproven' : 'not-required',
    variadicClassification:variadic ? 'partial-fixed-parameters-with-floating-mirroring' : 'not-variadic',
    partial:aggregatePartial || variadic,
    scope:MICROSOFT_X64_SCOPE,
    evidence:'prototype-microsoft-x64',
  };
}

function classifyReturn(prototype, options = {}) {
  if (!prototype) return null;
  const type = String(options.returnType || prototype.returnType || prototype.ret || prototype.result || '').trim().toLowerCase();
  const abiClass = String(options.returnClass || prototype.returnClass || prototype.abiClass || prototype.resultClass || '').trim().toLowerCase();
  if (options.returnsValue === false || prototype.returnsValue === false || prototype.void === true || type === 'void' || abiClass === 'void') return null;
  if (prototype.indirectResult === true || abiClass === 'indirect') return null;
  if (prototype.aggregate === true || /aggregate|struct|union|record|array/.test(`${type} ${abiClass}`)) {
    return { reg:null, partial:true, reason:'microsoft-x64-aggregate-return-classification-not-proven' };
  }
  const vector = /vector|simd|sse/.test(`${type} ${abiClass}`);
  const floating = vector || /(^|\s)(?:float|double)(?:\s|$)|\bfp\b/.test(`${type} ${abiClass}`);
  const rawBits = Number(prototype.returnBits || prototype.bits || options.returnBits || typeBits(type, vector ? 128 : 64));
  const bits = Number.isSafeInteger(rawBits) && rawBits > 0 ? Math.min(128, rawBits) : 64;
  if (floating) return { reg:'xmm0', bits };
  if (type || abiClass || options.returnsValue === true || prototype.returnsValue === true) return { reg:'rax', bits };
  return null;
}

export function classifyMicrosoftX64CallReturn(instruction, options = {}) {
  return classifyReturn(callPrototypeOf(instruction, options), options);
}

export function classifyMicrosoftX64FunctionReturn(options = {}) {
  return classifyReturn(options.functionPrototype || options.prototype || {}, options);
}

export const MICROSOFT_X64_ABI = new ABIPlugin({
  id:'microsoft-x64',
  semanticVersion:'1',
  architectureId:'x86_64',
  platformPredicate:({ platform }) => ['windows','win32','windows-nt','pe'].includes(platform),
  callingConventions:()=>Object.freeze(['microsoft-x64','win64']),
  classifyArguments:classifyMicrosoftX64Arguments,
  classifyCallReturn:classifyMicrosoftX64CallReturn,
  classifyFunctionReturn:classifyMicrosoftX64FunctionReturn,
  classifyEntryRegister:(reg) => {
    const id = String(reg || '').toLowerCase();
    const integerIndex = INTEGER_ARGUMENT_REGISTERS.indexOf(id);
    if (integerIndex >= 0) return { kind:'argument', reg:id, index:integerIndex, abiClass:'integer' };
    const vectorIndex = VECTOR_ARGUMENT_REGISTERS.indexOf(id);
    if (vectorIndex >= 0) return { kind:'argument', reg:id, index:vectorIndex, abiClass:'fp-or-vector' };
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
    shadowSpaceBytes:32,
    firstStackArgumentOffset:40,
    redZoneBytes:0,
    aggregateClassification:'partial',
    nonvolatileVectorRegisters:Object.freeze(Array.from({ length:10 }, (_value, index) => `xmm${index + 6}`)),
    nonvolatileVectorBits:128,
  }),
  redZone:()=>0,
  unwindRules:()=>Object.freeze({ framePointer:'rbp', returnAddress:'stack', returnAddressOffset:0, homeSpaceBytes:32 }),
  defaultUnknownCallEffects:()=>Object.freeze({
    registerClobbers:CALLER_SAVED,
    memoryEffects:'unknown',
    mayThrow:true,
    shadowSpaceRequired:true,
    aggregateEffects:'unknown',
    variadicEffects:'unknown',
  }),
});
