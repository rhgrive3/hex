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
  aggregates:'exact-when-decoder-type-metadata-provides-valid-eightbyte-classes-up-to-16-bytes-otherwise-partial',
  variadic:'partial-fixed-parameters-plus-conservative-register-frontier-and-vector-count-state',
  x87:'arguments-memory-exact-returns-unsupported',
  int128:'exact-two-integer-eightbytes-with-whole-argument-register-rollback',
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

function normalizedType(type) { return String(type || '').trim().toLowerCase().replace(/\s+/g, ' '); }
function isComplexLongDouble(type, abiClass = '') {
  const text = `${normalizedType(type)} ${normalizedType(abiClass)}`;
  return /(?:^|\s)(?:_complex\s+)?long double complex(?:\s|$)/.test(text)
    || /(?:^|\s)complex long double(?:\s|$)/.test(text)
    || /(?:^|\s)complex_x87(?:\s|$)/.test(text);
}
function isLongDouble(type, abiClass = '') {
  const text = `${normalizedType(type)} ${normalizedType(abiClass)}`;
  return !isComplexLongDouble(type, abiClass) && (/(?:^|\s)long double(?:\s|$)/.test(text) || /(?:^|\s)x87(?:up)?(?:\s|$)/.test(text));
}
function isInt128(type) {
  const text = normalizedType(type).replace(/\b(?:const|volatile|signed)\b/g, '').replace(/\s+/g, ' ').trim();
  return /^(?:unsigned )?__int128(?:_t)?$/.test(text) || /^(?:u?int128)(?:_t)?$/.test(text);
}

function typeBits(type, fallback = 64) {
  type = normalizedType(type);
  if (isComplexLongDouble(type)) return 256;
  if (isLongDouble(type)) return 128;
  if (isInt128(type)) return 128;
  if (/\b(?:bool|char|int8|uint8)\b/.test(type)) return 8;
  if (/\b(?:short|int16|uint16)\b/.test(type)) return 16;
  if (/\b(?:int|unsigned int|int32|uint32|float)\b/.test(type)) return 32;
  if (/\b(?:double|long|int64|uint64|pointer|ptr)\b|\*/.test(type)) return 64;
  return fallback;
}

function parameterClass(parameter) {
  const type = normalizedType(parameter?.type || parameter?.name || '');
  const abiClass = normalizedType(parameter?.abiClass || parameter?.class || parameter?.kind || '');
  const complexX87 = parameter?.complexX87 === true || isComplexLongDouble(type, abiClass);
  const x87 = complexX87 || parameter?.x87 === true || isLongDouble(type, abiClass);
  const pointer = parameter?.pointer === true || parameter?.isPointer === true
    || /\*|pointer|ptr|object|class|block|closure/.test(`${type} ${abiClass}`);
  const aggregate = !x87 && (parameter?.aggregate === true || parameter?.isAggregate === true
    || /aggregate|struct|union|record|array/.test(`${type} ${abiClass}`));
  const vector = !x87 && (parameter?.vector === true || /vector|simd|sse/.test(`${type} ${abiClass}`));
  const floating = !x87 && !aggregate && (parameter?.floating === true || /(^|\s)(?:float|double)(?:\s|$)|\bfp\b/.test(`${type} ${abiClass}`));
  const declaredBits = parameter?.bits ?? parameter?.sizeBits;
  const rawBits = Number(declaredBits ?? (pointer ? 64 : typeBits(type, vector ? 128 : 64)));
  const bits = Number.isSafeInteger(rawBits) && rawBits > 0 ? Math.min(512, rawBits) : 64;
  const nonTrivialForCalls = parameter?.nonTrivialForCalls === true || parameter?.nonTrivial === true;
  const integerEightbytes = !pointer && !aggregate && !vector && !floating && !x87 && bits === 128 ? 2 : 1;
  return {
    type, abiClass, pointer, aggregate, vector, floating, bits, bitsProven:declaredBits != null,
    nonTrivialForCalls, x87, complexX87, integerEightbytes,
  };
}

function explicitEightbyteClasses(parameter) {
  const raw = parameter?.eightbyteClasses ?? parameter?.abiClasses;
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > 2) return null;
  const classes = raw.map((value) => String(value || '').trim().toUpperCase());
  if (classes.some((value) => !['INTEGER','SSE','SSEUP','MEMORY','NO_CLASS'].includes(value))) return null;
  if (classes.includes('MEMORY')) return ['MEMORY'];
  if (classes[0] === 'SSEUP') return null;
  if (classes[1] === 'SSEUP' && !['SSE','SSEUP'].includes(classes[0])) return null;
  return classes.filter((value) => value !== 'NO_CLASS');
}

function appendRegisterSource(sources, seen, reg, bits, extra = {}) {
  if (seen.has(reg)) return;
  seen.add(reg);
  sources.push({ t:'reg', reg, bits, ...extra });
}

function align(value, alignment) {
  return Math.ceil(value / alignment) * alignment;
}

function declaredMaxVectorRegisterBits(options = {}) {
  const raw = Number(options.maxVectorRegisterBits ?? options.vectorRegisterBits ?? options.architectureProfile?.maxVectorBits ?? 128);
  return [128, 256, 512].includes(raw) ? raw : 128;
}

function vectorRegisterName(index, bits) {
  if (bits <= 128) return `xmm${index}`;
  if (bits <= 256) return `ymm${index}`;
  if (bits <= 512) return `zmm${index}`;
  return null;
}

function vectorRegisterView(index, bits, options = {}) {
  if (bits > declaredMaxVectorRegisterBits(options)) return null;
  return vectorRegisterName(index, bits);
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
    implicitInputs:[],
    variadicVectorRegisterCount:null,
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
  let aggregateProven = false;
  let vectorPartial = false;
  let stackArgsMayContainPointers = false;
  const indirectResult = prototype?.indirectResult === true || prototype?.returnClass === 'indirect';
  if (indirectResult) {
    appendRegisterSource(srcs, seenSources, INTEGER_ARGUMENT_REGISTERS[0], 64, { purpose:'indirect-result' });
    arguments_.push({ index:-1, role:'indirect-result', location:'register', reg:INTEGER_ARGUMENT_REGISTERS[0], abiClass:'pointer', pointer:true, bits:64, hidden:true });
    integerIndex = 1;
  }

  parameters.forEach((parameter, index) => {
    const classified = parameterClass(parameter);
    const aggregateClasses = classified.aggregate && !classified.nonTrivialForCalls ? explicitEightbyteClasses(parameter) : null;

    if (!allocationUnknown && classified.x87) {
      const bytes = classified.complexX87 ? 32 : 16;
      stackOffset = align(stackOffset, 16);
      const entry = {
        index,
        location:'stack',
        offset:stackOffset,
        offsetBase:'incoming-stack-arguments',
        calleeEntryOffset:8 + stackOffset,
        bytes,
        alignment:16,
        abiClass:classified.complexX87 ? 'complex-x87-memory' : 'x87-memory',
        eightbyteClasses:classified.complexX87 ? ['COMPLEX_X87'] : ['X87','X87UP'],
        pointer:false,
        bits:classified.bits,
      };
      arguments_.push(entry);
      stackArguments.push(entry);
      stackOffset += bytes;
      return;
    }

    if (!allocationUnknown && classified.nonTrivialForCalls) {
      aggregateProven = true;
      const reg = INTEGER_ARGUMENT_REGISTERS[integerIndex];
      if (reg) {
        integerIndex += 1;
        appendRegisterSource(srcs, seenSources, reg, 64, { purpose:'invisible-reference' });
        arguments_.push({ index, location:'register', reg, abiClass:'invisible-reference', pointer:true, bits:64, pointeeBits:classified.bits, hiddenIndirection:true });
      } else {
        const entry = { index, location:'stack', offset:stackOffset, offsetBase:'incoming-stack-arguments', calleeEntryOffset:8 + stackOffset, bytes:8, abiClass:'invisible-reference', pointer:true, bits:64, pointeeBits:classified.bits, hiddenIndirection:true };
        arguments_.push(entry); stackArguments.push(entry); stackOffset += 8; stackArgsMayContainPointers = true;
      }
      return;
    }
    if (!allocationUnknown && aggregateClasses) {
      aggregateProven = true;
      const memoryClass = aggregateClasses.length === 0 || aggregateClasses[0] === 'MEMORY';
      const integerNeeded = aggregateClasses.filter((value) => value === 'INTEGER').length;
      const vectorNeeded = aggregateClasses.filter((value) => value === 'SSE').length;
      const registersAvailable = integerIndex + integerNeeded <= INTEGER_ARGUMENT_REGISTERS.length
        && vectorIndex + vectorNeeded <= VECTOR_ARGUMENT_REGISTERS.length;
      if (!memoryClass && registersAvailable) {
        const pieces = [];
        let activeVectorRegister = null;
        for (let pieceIndex = 0; pieceIndex < aggregateClasses.length; pieceIndex++) {
          const abiClass = aggregateClasses[pieceIndex];
          if (abiClass === 'INTEGER') {
            const reg = INTEGER_ARGUMENT_REGISTERS[integerIndex++];
            appendRegisterSource(srcs, seenSources, reg, 64, { purpose:'aggregate-eightbyte' });
            pieces.push({ index:pieceIndex, abiClass, reg, bits:Math.min(64, Math.max(0, classified.bits - pieceIndex * 64)) || 64 });
          } else if (abiClass === 'SSE') {
            activeVectorRegister = VECTOR_ARGUMENT_REGISTERS[vectorIndex++];
            appendRegisterSource(srcs, seenSources, activeVectorRegister, 128, { purpose:'aggregate-eightbyte' });
            pieces.push({ index:pieceIndex, abiClass, reg:activeVectorRegister, bits:64, byteOffset:0 });
          } else if (abiClass === 'SSEUP') {
            pieces.push({ index:pieceIndex, abiClass, reg:activeVectorRegister, bits:64, byteOffset:8 });
          }
        }
        arguments_.push({ index, location:'registers', regs:Array.from(new Set(pieces.map((piece) => piece.reg))), pieces, abiClass:'aggregate-eightbytes', pointer:classified.pointer, bits:classified.bits });
        stackArgsMayContainPointers ||= classified.pointer;
        return;
      }
      const bytes = align(Math.max(8, Math.ceil(classified.bits / 8)), 8);
      stackOffset = align(stackOffset, Math.min(16, Math.max(8, Number(parameter?.alignment || 8))));
      const entry = { index, location:'stack', offset:stackOffset, offsetBase:'incoming-stack-arguments', calleeEntryOffset:8 + stackOffset, bytes, abiClass:'aggregate-memory', pointer:classified.pointer, bits:classified.bits, eightbyteClasses:aggregateClasses };
      arguments_.push(entry); stackArguments.push(entry); stackOffset += bytes; stackArgsMayContainPointers ||= classified.pointer;
      return;
    }
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

    if (classified.integerEightbytes === 2) {
      if (integerIndex + 2 <= INTEGER_ARGUMENT_REGISTERS.length) {
        const regs = INTEGER_ARGUMENT_REGISTERS.slice(integerIndex, integerIndex + 2);
        integerIndex += 2;
        const pieces = regs.map((reg, pieceIndex) => {
          appendRegisterSource(srcs, seenSources, reg, 64, { purpose:'integer-eightbyte' });
          return { index:pieceIndex, abiClass:'INTEGER', reg, bits:64 };
        });
        arguments_.push({ index, location:'registers', regs, pieces, abiClass:'integer-eightbytes', pointer:false, bits:128 });
      } else {
        stackOffset = align(stackOffset, 16);
        const entry = {
          index,
          location:'stack',
          offset:stackOffset,
          offsetBase:'incoming-stack-arguments',
          calleeEntryOffset:8 + stackOffset,
          bytes:16,
          alignment:16,
          abiClass:'integer-eightbytes-memory',
          eightbyteClasses:['INTEGER','INTEGER'],
          pointer:false,
          bits:128,
        };
        stackArguments.push(entry);
        arguments_.push(entry);
        stackOffset += 16;
      }
      return;
    }

    if ((classified.floating || classified.vector) && vectorIndex < VECTOR_ARGUMENT_REGISTERS.length) {
      const registerIndex = vectorIndex++;
      const exactVectorView = classified.vector ? vectorRegisterView(registerIndex, classified.bits, options) : VECTOR_ARGUMENT_REGISTERS[registerIndex];
      const architecturalView = classified.vector ? (exactVectorView || vectorRegisterName(registerIndex, classified.bits)) : exactVectorView;
      if (!architecturalView) {
        vectorPartial = true;
        allocationUnknown = true;
        arguments_.push({
          index, location:'unknown', candidateRegisters:[], stackPossible:true,
          abiClass:'sse-vector-unsupported-width', pointer:false, bits:classified.bits,
          partial:true, unsupported:true, reason:'sysv-amd64-vector-width-outside-modeled-register-views',
        });
        return;
      }
      const unsupported = classified.vector && exactVectorView == null;
      vectorPartial ||= unsupported;
      appendRegisterSource(srcs, seenSources, architecturalView, classified.bits, unsupported
        ? { partial:true, unsupported:true, purpose:'wide-vector-register-view' }
        : {});
      arguments_.push({
        index, location:'register', reg:architecturalView,
        abiClass:classified.vector ? 'sse-vector' : 'sse-scalar',
        pointer:false, bits:classified.bits,
        ...(unsupported ? { partial:true, unsupported:true, reason:'sysv-amd64-wide-vector-profile-not-proven' } : {}),
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
  const variadicRegisterCandidates = [];
  if (variadic) {
    for (const reg of INTEGER_ARGUMENT_REGISTERS.slice(integerIndex)) {
      variadicRegisterCandidates.push({ t:'reg', reg, bits:64, abiClass:'unknown-integer', possible:true });
      appendRegisterSource(srcs, seenSources, reg, 64, { purpose:'variadic-register-candidate', possible:true });
    }
    for (const reg of VECTOR_ARGUMENT_REGISTERS.slice(vectorIndex)) {
      variadicRegisterCandidates.push({ t:'reg', reg, bits:128, abiClass:'unknown-sse', possible:true });
      appendRegisterSource(srcs, seenSources, reg, 128, { purpose:'variadic-register-candidate', possible:true });
    }
  }
  return {
    srcs,
    arguments:arguments_,
    stackArguments,
    stackArgsUnknown:allocationUnknown || variadic,
    stackArgsMayContainPointers:stackArgsMayContainPointers || allocationUnknown || variadic,
    aggregateClassification:aggregatePartial ? 'partial-unproven' : aggregateProven ? 'proven' : 'not-required',
    variadicClassification:variadic ? 'partial-fixed-parameters-plus-register-frontier' : 'not-variadic',
    variadicRegisterCandidates,
    implicitInputs:variadic ? [{ t:'reg', reg:'rax', view:'al', bits:8, purpose:'sse-register-argument-count' }] : [],
    variadicVectorRegisterCount:variadic ? vectorIndex : null,
    partial:aggregatePartial || vectorPartial || variadic,
    scope:SYSV_AMD64_SCOPE,
    evidence:'prototype-sysv-amd64',
  };
}

function classifyReturn(prototype, options = {}) {
  if (!prototype) return null;
  const type = normalizedType(options.returnType || prototype.returnType || prototype.ret || prototype.result || '');
  const abiClass = normalizedType(options.returnClass || prototype.returnClass || prototype.abiClass || prototype.resultClass || '');
  if (options.returnsValue === false || prototype.returnsValue === false || prototype.void === true || type === 'void' || abiClass === 'void') return null;
  if (prototype.indirectResult === true || abiClass === 'indirect') {
    return { reg:'rax', bits:64, indirect:true, hiddenResultPointer:{ input:'rdi', returned:'rax' } };
  }
  if (isComplexLongDouble(type, abiClass) || isLongDouble(type, abiClass)) {
    return { reg:null, partial:true, unsupported:true, reason:'sysv-amd64-x87-return-outside-claimed-scope' };
  }
  if (prototype.aggregate === true || /aggregate|struct|union|record|array/.test(`${type} ${abiClass}`)) {
    const classes = explicitEightbyteClasses({ eightbyteClasses:options.returnEightbyteClasses ?? prototype.returnEightbyteClasses ?? prototype.eightbyteClasses });
    if (!classes || classes[0] === 'MEMORY') return { reg:null, partial:true, reason:'sysv-amd64-aggregate-return-classification-not-proven' };
    const pieces = [];
    let integerIndex = 0, vectorIndex = 0, activeVectorRegister = null;
    for (let index = 0; index < classes.length; index++) {
      const current = classes[index];
      if (current === 'INTEGER') pieces.push({ index, abiClass:current, reg:['rax','rdx'][integerIndex++], bits:64 });
      else if (current === 'SSE') { activeVectorRegister = ['xmm0','xmm1'][vectorIndex++]; pieces.push({ index, abiClass:current, reg:activeVectorRegister, bits:64, byteOffset:0 }); }
      else if (current === 'SSEUP') pieces.push({ index, abiClass:current, reg:activeVectorRegister, bits:64, byteOffset:8 });
    }
    return { reg:pieces[0]?.reg || null, regs:Array.from(new Set(pieces.map((piece) => piece.reg))), pieces, bits:Number(prototype.returnBits || options.returnBits || classes.length * 64), aggregate:true };
  }
  const vector = prototype.vector === true || options.vector === true || /vector|simd|sse|__m(?:128|256|512)/.test(`${type} ${abiClass}`);
  const floating = vector || /(^|\s)(?:float|double)(?:\s|$)|\bfp\b/.test(`${type} ${abiClass}`);
  const rawBits = Number(prototype.returnBits || prototype.bits || options.returnBits || typeBits(type, vector ? 128 : 64));
  const saneBits = Number.isSafeInteger(rawBits) && rawBits > 0 ? rawBits : 64;
  if (vector && saneBits > 128) {
    const reg = vectorRegisterView(0, saneBits, options);
    if (!reg) return {
      reg:null, candidateReg:vectorRegisterName(0, saneBits), bits:saneBits, partial:true, unsupported:true,
      reason:vectorRegisterName(0, saneBits) ? 'sysv-amd64-wide-vector-profile-not-proven' : 'sysv-amd64-vector-width-outside-modeled-register-views',
    };
    return { reg, bits:saneBits, abiClass:'sse-vector', wideVector:true };
  }
  const bits = Math.min(128, saneBits);
  if (!floating && bits === 128) {
    const pieces = [
      { index:0, abiClass:'INTEGER', reg:'rax', bits:64 },
      { index:1, abiClass:'INTEGER', reg:'rdx', bits:64 },
    ];
    return { reg:'rax', regs:['rax','rdx'], pieces, bits:128, abiClass:'integer-eightbytes' };
  }
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
  semanticVersion:'2',
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
    directionFlag:'clear-on-entry-and-return',
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
