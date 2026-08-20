import { ABIPlugin } from './registry.js';

/**
 * RISC-V psABI integer calling conventions for RV64.
 *
 * Authority: "RISC-V ELF psABI specification", Integer Calling Convention and
 * the LP64/LP64F/LP64D hardware floating-point variants.
 *
 * Register identities here are canonical physical ids (`x10`, `x2`, ...) with
 * the psABI alias recorded alongside, because `a0` and `x10` are the same
 * machine location and the semantic layer must never treat them as two.
 *
 * This file contains no instruction knowledge. Which instruction writes a link
 * register is the architecture's business; which register a call *convention*
 * designates as the return address is this file's business.
 */

const XLEN = 64;

/* Integer Calling Convention: a0-a7 are x10-x17. */
const INTEGER_ARGUMENT_REGISTERS = Object.freeze(['x10','x11','x12','x13','x14','x15','x16','x17']);
/* Values up to 2*XLEN are returned in a0-a1. */
const INTEGER_RETURN_REGISTERS = Object.freeze(['x10','x11']);
/* fa0-fa7 for the hardware-float variants. */
const FLOAT_ARGUMENT_REGISTERS = Object.freeze(['f10','f11','f12','f13','f14','f15','f16','f17']);
/* psABI floating-point register convention. */
const FLOAT_CALLER_SAVED = Object.freeze([
  'f0','f1','f2','f3','f4','f5','f6','f7',
  ...FLOAT_ARGUMENT_REGISTERS,
  'f28','f29','f30','f31',
]);
const FLOAT_CALLEE_SAVED = Object.freeze([
  'f8','f9','f18','f19','f20','f21','f22','f23','f24','f25','f26','f27',
]);
const ALL_FLOAT_REGISTERS = Object.freeze(Array.from({ length:32 }, (_, index) => `f${index}`));
const VECTOR_ARGUMENT_REGISTERS = Object.freeze(Array.from({ length:16 }, (_unused, index) => `v${8 + index}`));
const VECTOR_VARIANT_CALLEE_SAVED = Object.freeze([
  ...Array.from({ length:7 }, (_unused, index) => `v${1 + index}`),
  ...Array.from({ length:8 }, (_unused, index) => `v${24 + index}`),
]);
const VECTOR_VARIANT_CALLER_SAVED = Object.freeze([
  'v0', ...VECTOR_ARGUMENT_REGISTERS, 'vl', 'vtype', 'vxrm', 'vxsat', 'vstart',
]);

const ABI_ALIAS = Object.freeze({
  x1:'ra', x2:'sp', x3:'gp', x4:'tp', x5:'t0', x6:'t1', x7:'t2', x8:'s0', x9:'s1',
  x10:'a0', x11:'a1', x12:'a2', x13:'a3', x14:'a4', x15:'a5', x16:'a6', x17:'a7',
  x18:'s2', x19:'s3', x20:'s4', x21:'s5', x22:'s6', x23:'s7', x24:'s8', x25:'s9',
  x26:'s10', x27:'s11', x28:'t3', x29:'t4', x30:'t5', x31:'t6',
});

/* ra and the temporaries/argument registers are caller-saved. */
const CALLER_SAVED = Object.freeze([
  'x1', 'x5', 'x6', 'x7', 'x28', 'x29', 'x30', 'x31',
  ...INTEGER_ARGUMENT_REGISTERS,
]);
/* sp and s0-s11 are callee-saved. */
const CALLEE_SAVED = Object.freeze(['x2', 'x8', 'x9', 'x18','x19','x20','x21','x22','x23','x24','x25','x26','x27']);
/*
 * x0 is hardwired zero, gp and tp are reserved by the psABI for the global and
 * thread pointers and are not allocatable by the compiler. They are neither
 * caller- nor callee-saved: nothing may assume anything about them across a
 * call beyond their reserved role.
 */
const UNALLOCATABLE = Object.freeze(['x0', 'x3', 'x4']);

export function riscvTypeBits(type, fallback = XLEN) {
  const text = String(type || '').toLowerCase().replace(/\s+/g, ' ').trim();
  if (!text) return fallback;
  const bitInt = /(?:^|\s)(?:unsigned\s+)?_bitint\s*\(\s*(\d+)\s*\)/.exec(text);
  if (bitInt) {
    const bits = Number(bitInt[1]);
    return Number.isSafeInteger(bits) && bits > 0 && bits <= 1_000_000 ? bits : fallback;
  }
  if (/\*|\b(?:pointer|ptr|uintptr_t|intptr_t)\b/.test(text)) return XLEN;
  // Longest/compound spellings precede their component words. This avoids
  // matching `long double` as `double`/`long` and `__int128` as fallback XLEN.
  if (/\blong double\b/.test(text)) return 128;
  if (/\b(?:unsigned\s+)?__int128\b|\b(?:u?int128(?:_t)?)\b/.test(text)) return 128;
  if (/\b(?:_float16|__fp16|__bf16|bfloat16)\b/.test(text)) return 16;
  if (/\bdouble\b/.test(text)) return 64;
  if (/\bfloat\b/.test(text)) return 32;
  if (/\b(?:unsigned\s+)?long long\b|\b(?:unsigned\s+)?long\b|\b(?:u?int64(?:_t)?)\b/.test(text)) return 64;
  if (/\b(?:unsigned\s+)?int\b|\b(?:u?int32(?:_t)?)\b/.test(text)) return 32;
  if (/\b(?:unsigned\s+)?short\b|\b(?:u?int16(?:_t)?)\b/.test(text)) return 16;
  if (/\b(?:bool|_bool|signed char|unsigned char|char|u?int8(?:_t)?)\b/.test(text)) return 8;
  return fallback;
}

function isFloatingType(type) {
  const text = String(type || '').toLowerCase();
  return /\b(?:long double|double|float|_float16|__fp16|__bf16|bfloat16)\b/.test(text);
}

function vectorDescriptor(parameter) {
  const type = String(parameter?.type || '').toLowerCase();
  const abiClass = String(parameter?.abiClass || parameter?.class || parameter?.kind || '').toLowerCase();
  const vector = parameter?.vector === true || parameter?.isVector === true
    || /\b(?:vbool|v(?:u?int|float)\d+mf?\d+_t|vector)\b/.test(type)
    || /vector/.test(abiClass);
  if (!vector) return null;
  const mask = parameter?.mask === true || parameter?.vectorMask === true || /\bvbool|mask/.test(`${type} ${abiClass}`);
  const explicitLmul = Number(parameter?.lmul ?? parameter?.LMUL);
  const parsed = /m(1|2|4|8)(?:_t|\b)/.exec(type);
  const lmul = Number.isInteger(explicitLmul) && [1,2,4,8].includes(explicitLmul)
    ? explicitLmul : parsed ? Number(parsed[1]) : 1;
  const tupleCount = Math.max(1, Math.min(8, Number(parameter?.tupleCount ?? parameter?.nf ?? 1) || 1));
  const fixedLength = parameter?.fixedLengthVector === true || /fixed[-_ ]?length/.test(abiClass);
  return { mask, lmul, tupleCount, fixedLength };
}

function aggregateMembers(parameter) {
  const candidates = parameter?.members ?? parameter?.fields ?? parameter?.layout?.fields ?? parameter?.layout?.members;
  return Array.isArray(candidates) && candidates.length ? candidates : null;
}

function callSymbol(instruction, options) {
  const target = instruction?.callTarget ?? null;
  if (target == null) return null;
  try {
    const direct = options?.symbolForAddress?.(target, instruction);
    if (direct) return direct;
  } catch {}
  const symbols = options?.binaryImage?.symbols;
  if (Array.isArray(symbols)) {
    const key = BigInt(target);
    return symbols.find((symbol) => symbol?.address != null && BigInt(symbol.address) === key) || null;
  }
  return null;
}

function vectorVariantRequested(instruction, options, prototype) {
  const explicit = String(instruction?.callingConvention || prototype?.callingConvention || options?.callingConvention || '').toLowerCase();
  if (explicit === 'riscv-vector-variant' || explicit === 'riscv_vector_cc') return true;
  return callSymbol(instruction, options)?.riscvVariantCc === true;
}

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

function parameterClass(parameter) {
  const type = String(parameter?.type || parameter?.name || '').trim().toLowerCase();
  const abiClass = String(parameter?.abiClass || parameter?.class || parameter?.kind || '').trim().toLowerCase();
  const pointer = parameter?.pointer === true || parameter?.isPointer === true || /\*|pointer|ptr|object/.test(`${type} ${abiClass}`);
  const aggregate = parameter?.aggregate === true || parameter?.isAggregate === true || /aggregate|struct|union|record|array/.test(`${type} ${abiClass}`);
  const vector = !aggregate ? vectorDescriptor(parameter) : null;
  const floating = !aggregate && !vector && (parameter?.floating === true || isFloatingType(type) || /\bfp\b/.test(abiClass));
  const declaredBits = parameter?.bits ?? parameter?.sizeBits;
  const rawBits = Number(declaredBits ?? (pointer ? XLEN : riscvTypeBits(type, XLEN)));
  const bits = Number.isSafeInteger(rawBits) && rawBits > 0 ? Math.min(1_000_000, rawBits) : XLEN;
  return { type, abiClass, pointer, aggregate, floating, vector, bits };
}

function registerSource(reg, bits = XLEN, extra = {}) {
  return { t:'reg', reg, bits, abiName:ABI_ALIAS[reg] ?? null, ...extra };
}

function align(value, alignment) { return Math.ceil(value / alignment) * alignment; }

/** With no prototype, every argument register is a possible input and the stack is unknown. */
function conservativeUnknownArguments(scope, hardFloat) {
  const registers = hardFloat
    ? [...INTEGER_ARGUMENT_REGISTERS, ...FLOAT_ARGUMENT_REGISTERS]
    : [...INTEGER_ARGUMENT_REGISTERS];
  const srcs = registers.map((reg) => registerSource(reg));
  return {
    srcs,
    arguments:srcs.map((source, index) => ({
      index,
      location:'register',
      reg:source.reg,
      abiName:source.abiName,
      bits:XLEN,
      abiClass:source.reg.startsWith('f') ? 'unknown-float' : 'unknown-integer',
    })),
    stackArguments:[],
    stackArgsUnknown:true,
    stackArgsMayContainPointers:true,
    aggregateClassification:'partial-unproven',
    variadicClassification:'partial-unproven',
    partial:true,
    scope,
    evidence:'conservative-riscv-lp64',
  };
}

function createClassifier(profile) {
  const hardFloat = profile.floatAbi !== 'soft';
  const abiFlen = profile.floatAbi === 'double' ? 64 : profile.floatAbi === 'single' ? 32 : 0;

  function classifyArguments(instruction, options = {}) {
    const prototype = callPrototypeOf(instruction, options);
    const parameters = parameterList(prototype);
    if (!parameters) return conservativeUnknownArguments(profile.scope, hardFloat);

    const srcs = [];
    const seen = new Set();
    const arguments_ = [];
    const stackArguments = [];
    let integerIndex = 0;
    let floatIndex = 0;
    let stackOffset = 0;
    let partial = false;
    let aggregateProven = false;
    let aggregatePartial = false;
    let stackArgsMayContainPointers = false;
    let variadicStackOnly = false;
    let allocationUnknown = false;
    const vectorVariant = vectorVariantRequested(instruction, options, prototype);
    let vectorCursor = 8;

    function useInteger(reg, extra = {}) {
      if (!seen.has(reg)) { seen.add(reg); srcs.push(registerSource(reg, XLEN, extra)); }
    }
    function useFloat(reg, bits, extra = {}) {
      if (!seen.has(reg)) { seen.add(reg); srcs.push({ t:'reg', reg, bits, ...extra }); }
    }
    function useVector(reg, extra = {}) {
      if (!seen.has(reg)) { seen.add(reg); srcs.push({ t:'reg', reg, bits:128, ...extra }); }
    }
    function unknownArgument(index, classified, reason, extra = {}) {
      partial = true;
      allocationUnknown = true;
      arguments_.push({ index, location:'unknown', abiClass:reason, bits:classified.bits, partial:true, ...extra });
    }
    function allocateVectorGroup(descriptor) {
      if (descriptor.mask) return ['v0'];
      if (descriptor.fixedLength && !(Number(options?.abiVlen) > 0)) return null;
      const group = descriptor.lmul * descriptor.tupleCount;
      let start = vectorCursor;
      while (start <= 23 && (start % descriptor.lmul) !== 0) start += 1;
      if (start + group - 1 > 23) return null;
      vectorCursor = start + group;
      return Array.from({ length:group }, (_unused, index) => `v${start + index}`);
    }
    function flattenAggregate(parameter) {
      const members = aggregateMembers(parameter);
      if (!members) return null;
      if (members.length < 1 || members.length > 2) return { eligible:false, known:true };
      const classifiedMembers = members.map((member) => parameterClass(member));
      if (classifiedMembers.some((member) => member.aggregate || member.vector || member.bits > XLEN)) return { eligible:false, known:true };
      const floatMembers = classifiedMembers.filter((member) => member.floating && member.bits <= abiFlen);
      if (!floatMembers.length || classifiedMembers.some((member) => member.floating && member.bits > abiFlen)) return { eligible:false, known:true };
      if (classifiedMembers.some((member) => !member.floating && member.bits > XLEN)) return { eligible:false, known:true };
      return { eligible:true, known:true, members:classifiedMembers };
    }

    /*
     * psABI: a return value larger than 2*XLEN is returned in memory, and the
     * caller passes the destination pointer as an implicit first integer
     * argument, consuming a0.
     */
    const indirectResult = prototype?.indirectResult === true || prototype?.returnClass === 'indirect';
    if (indirectResult) {
      const reg = INTEGER_ARGUMENT_REGISTERS[0];
      useInteger(reg, { purpose:'indirect-result' });
      arguments_.push({ index:-1, role:'indirect-result', location:'register', reg, abiName:ABI_ALIAS[reg], abiClass:'pointer', pointer:true, bits:XLEN, hidden:true });
      integerIndex = 1;
    }

    const variadic = prototype?.variadic === true || prototype?.varargs === true;
    const fixedParameterCount = Number.isInteger(prototype?.fixedParameterCount)
      ? prototype.fixedParameterCount
      : parameters.length;

    parameters.forEach((parameter, index) => {
      const classified = parameterClass(parameter);
      const variadicArgument = variadic && (
        parameter?.variadic === true || parameter?.unnamed === true || parameter?.named === false || index >= fixedParameterCount
      );

      if (allocationUnknown) {
        arguments_.push({ index, location:'unknown', abiClass:'allocation-after-unproven-argument', bits:classified.bits, partial:true });
        partial = true;
        return;
      }

      if (classified.vector) {
        if (!vectorVariant) {
          unknownArgument(index, classified, 'vector-calling-convention-unknown', { candidates:['riscv-vector-variant','non-vector-fallback'] });
          return;
        }
        const regs = allocateVectorGroup(classified.vector);
        if (!regs) {
          unknownArgument(index, classified, 'vector-register-allocation-unproven', { vector:classified.vector });
          return;
        }
        regs.forEach((reg) => useVector(reg, { purpose:classified.vector.mask ? 'vector-mask-argument' : 'vector-argument' }));
        arguments_.push({ index, location:regs.length === 1 ? 'register' : 'registers', reg:regs.length === 1 ? regs[0] : undefined, regs, abiClass:classified.vector.mask ? 'vector-mask' : 'vector-data', bits:classified.bits, vector:classified.vector });
        return;
      }

      if (classified.aggregate) {
        const bytes = Math.ceil(classified.bits / 8);
        if (bytes > 2 * XLEN / 8) {
          /* Aggregates larger than 2*XLEN are passed by reference. */
          aggregateProven = true;
          const reg = INTEGER_ARGUMENT_REGISTERS[integerIndex];
          if (reg) {
            integerIndex += 1;
            useInteger(reg, { purpose:'aggregate-by-reference' });
            arguments_.push({ index, location:'register', reg, abiName:ABI_ALIAS[reg], abiClass:'aggregate-by-reference', pointer:true, bits:XLEN, pointeeBits:classified.bits, hiddenIndirection:true });
          } else {
            const entry = { index, location:'stack', offset:stackOffset, offsetBase:'incoming-stack-arguments', bytes:8, abiClass:'aggregate-by-reference', pointer:true, bits:XLEN, pointeeBits:classified.bits, hiddenIndirection:true };
            arguments_.push(entry); stackArguments.push(entry); stackOffset += 8; stackArgsMayContainPointers = true;
          }
          return;
        }
        /* Hard-float aggregate flattening is exact only with member evidence. */
        const needed = bytes > XLEN / 8 ? 2 : 1;
        const flattening = hardFloat ? flattenAggregate(parameter) : null;
        if (hardFloat && flattening == null) {
          aggregatePartial = true;
          unknownArgument(index, classified, 'aggregate-hard-float-layout-unproven', { candidates:['fp-flattening','integer-convention'] });
          return;
        }
        if (flattening?.eligible) {
          const fpNeeded = flattening.members.filter((member) => member.floating).length;
          const intNeeded = flattening.members.length - fpNeeded;
          if (floatIndex + fpNeeded <= FLOAT_ARGUMENT_REGISTERS.length && integerIndex + intNeeded <= INTEGER_ARGUMENT_REGISTERS.length) {
            const parts = [];
            for (const [memberIndex, member] of flattening.members.entries()) {
              if (member.floating) {
                const reg = FLOAT_ARGUMENT_REGISTERS[floatIndex++];
                useFloat(reg, member.bits, { purpose:'aggregate-fp-member' });
                parts.push({ memberIndex, reg, bits:member.bits, abiClass:'float' });
              } else {
                const reg = INTEGER_ARGUMENT_REGISTERS[integerIndex++];
                useInteger(reg, { purpose:'aggregate-integer-member' });
                parts.push({ memberIndex, reg, bits:member.bits, abiClass:'integer' });
              }
            }
            aggregateProven = true;
            arguments_.push({ index, location:'flattened-registers', regs:parts.map((part) => part.reg), parts, abiClass:'aggregate-hard-float-flattened', bits:classified.bits });
            return;
          }
          // psABI falls back to the integer convention when required FP register
          // resources are not available; the member layout is still known.
        }
        aggregateProven = true;
        if (needed === 2 && integerIndex === INTEGER_ARGUMENT_REGISTERS.length - 1) {
          const reg = INTEGER_ARGUMENT_REGISTERS[integerIndex++];
          useInteger(reg, { purpose:'aggregate-eightbyte' });
          stackOffset = align(stackOffset, 8);
          const stackPart = {
            index, part:'high', location:'stack', offset:stackOffset,
            offsetBase:'incoming-stack-arguments', bytes:8,
            abiClass:'aggregate-memory', bits:Math.max(0, classified.bits - XLEN),
          };
          stackArguments.push(stackPart);
          arguments_.push({
            index, location:'register-and-stack', reg, regs:[reg], abiName:ABI_ALIAS[reg], abiNames:[ABI_ALIAS[reg]],
            stackOffset, abiClass:'aggregate-integer-split', bits:classified.bits,
          });
          stackOffset += 8;
          return;
        }
        if (integerIndex + needed <= INTEGER_ARGUMENT_REGISTERS.length) {
          const regs = [];
          for (let piece = 0; piece < needed; piece += 1) {
            const reg = INTEGER_ARGUMENT_REGISTERS[integerIndex++];
            useInteger(reg, { purpose:'aggregate-eightbyte' });
            regs.push(reg);
          }
          arguments_.push({
            index, location:'registers', regs, abiNames:regs.map((reg) => ABI_ALIAS[reg]),
            abiClass:'aggregate-integer-registers', bits:classified.bits,
          });
          return;
        }
        const slot = align(bytes, 8);
        stackOffset = align(stackOffset, needed === 2 ? 16 : 8);
        const entry = { index, location:'stack', offset:stackOffset, offsetBase:'incoming-stack-arguments', bytes:slot, abiClass:'aggregate-memory', bits:classified.bits };
        arguments_.push(entry); stackArguments.push(entry); stackOffset += slot;
        return;
      }

      /*
       * Hardware-float variants pass scalar float/double in fa0-fa7. Named
       * arguments only: a variadic call passes floats in integer registers.
       */
      if (hardFloat && classified.floating && classified.bits <= abiFlen && !variadicArgument && floatIndex < FLOAT_ARGUMENT_REGISTERS.length) {
        const reg = FLOAT_ARGUMENT_REGISTERS[floatIndex++];
        if (!seen.has(reg)) { seen.add(reg); srcs.push({ t:'reg', reg, bits:classified.bits }); }
        arguments_.push({ index, location:'register', reg, abiClass:'float', bits:classified.bits });
        return;
      }

      if (classified.bits > 2 * XLEN) {
        const reg = INTEGER_ARGUMENT_REGISTERS[integerIndex];
        if (reg) {
          integerIndex += 1;
          useInteger(reg, { purpose:'wide-scalar-by-reference' });
          arguments_.push({ index, location:'register', reg, abiName:ABI_ALIAS[reg], abiClass:'scalar-by-reference', pointer:true, bits:XLEN, pointeeBits:classified.bits, hiddenIndirection:true });
        } else {
          const entry = { index, location:'stack', offset:stackOffset, offsetBase:'incoming-stack-arguments', bytes:8, abiClass:'scalar-by-reference', pointer:true, bits:XLEN, pointeeBits:classified.bits, hiddenIndirection:true };
          arguments_.push(entry); stackArguments.push(entry); stackOffset += 8; stackArgsMayContainPointers = true;
        }
        return;
      }
      /* Scalars wider than XLEN and at most 2*XLEN use an argument-register pair. */
      const needed = classified.bits > XLEN ? 2 : 1;
      if (variadicArgument && variadicStackOnly) {
        const slotAlignment = needed === 2 ? 16 : 8;
        const bytes = align(Math.max(8, Math.ceil(classified.bits / 8)), slotAlignment);
        stackOffset = align(stackOffset, slotAlignment);
        const entry = {
          index, location:'stack', offset:stackOffset, offsetBase:'incoming-stack-arguments',
          bytes, abiClass:classified.pointer ? 'pointer' : 'integer', pointer:classified.pointer,
          bits:classified.bits, variadic:true,
        };
        arguments_.push(entry); stackArguments.push(entry); stackOffset += bytes;
        stackArgsMayContainPointers ||= classified.pointer;
        return;
      }
      if (variadicArgument && needed === 2) {
        if (integerIndex % 2 === 1) integerIndex += 1;
        if (integerIndex + needed > INTEGER_ARGUMENT_REGISTERS.length) {
          variadicStackOnly = true;
          stackOffset = align(stackOffset, 16);
          const entry = {
            index, location:'stack', offset:stackOffset, offsetBase:'incoming-stack-arguments',
            bytes:16, abiClass:'integer', pointer:false, bits:classified.bits, variadic:true,
          };
          arguments_.push(entry); stackArguments.push(entry); stackOffset += 16;
          return;
        }
      }
      if (!variadicArgument && needed === 2 && integerIndex === INTEGER_ARGUMENT_REGISTERS.length - 1) {
        const reg = INTEGER_ARGUMENT_REGISTERS[integerIndex++];
        useInteger(reg);
        stackOffset = align(stackOffset, 8);
        const stackPart = {
          index, part:'high', location:'stack', offset:stackOffset,
          offsetBase:'incoming-stack-arguments', bytes:8,
          abiClass:'integer', bits:classified.bits - XLEN,
        };
        stackArguments.push(stackPart);
        arguments_.push({
          index, location:'register-and-stack', reg, regs:[reg], abiName:ABI_ALIAS[reg], abiNames:[ABI_ALIAS[reg]],
          stackOffset, abiClass:'integer-split', bits:classified.bits,
        });
        stackOffset += 8;
        return;
      }
      if (integerIndex + needed <= INTEGER_ARGUMENT_REGISTERS.length) {
        const regs = [];
        for (let piece = 0; piece < needed; piece += 1) {
          const reg = INTEGER_ARGUMENT_REGISTERS[integerIndex++];
          useInteger(reg);
          regs.push(reg);
        }
        arguments_.push(needed === 1
          ? { index, location:'register', reg:regs[0], abiName:ABI_ALIAS[regs[0]], abiClass:classified.pointer ? 'pointer' : classified.floating ? 'float-in-integer-register' : 'integer', pointer:classified.pointer, bits:classified.bits }
          : { index, location:'registers', regs, abiNames:regs.map((reg) => ABI_ALIAS[reg]), abiClass:'integer-pair', bits:classified.bits });
        stackArgsMayContainPointers ||= false;
        return;
      }

      const slotAlignment = needed === 2 ? 16 : 8;
      const bytes = align(Math.max(8, Math.ceil(classified.bits / 8)), slotAlignment);
      stackOffset = align(stackOffset, slotAlignment);
      const entry = {
        index, location:'stack', offset:stackOffset, offsetBase:'incoming-stack-arguments',
        bytes, abiClass:classified.pointer ? 'pointer' : 'integer', pointer:classified.pointer, bits:classified.bits,
      };
      arguments_.push(entry); stackArguments.push(entry); stackOffset += bytes;
      stackArgsMayContainPointers ||= classified.pointer;
    });

    return {
      srcs,
      arguments:arguments_,
      stackArguments,
      stackArgsUnknown:variadic,
      stackArgsMayContainPointers:stackArgsMayContainPointers || variadic,
      aggregateClassification:aggregatePartial ? 'partial-unproven' : aggregateProven ? 'proven' : 'not-required',
      variadicClassification:variadic ? 'proven-named-then-integer-varargs' : 'not-variadic',
      partial:partial || aggregatePartial,
      scope:profile.scope,
      evidence:`prototype-${profile.id}`,
      completeness:(partial || aggregatePartial || allocationUnknown) ? 'partial' : 'exact',
      callingConvention:vectorVariant ? 'riscv-vector-variant' : profile.id,
      clobbers:vectorVariant ? Object.freeze([...new Set([...CALLER_SAVED, ...(hardFloat ? FLOAT_CALLER_SAVED : []), ...VECTOR_VARIANT_CALLER_SAVED])]) : undefined,
      variantCalleeSaved:vectorVariant ? VECTOR_VARIANT_CALLEE_SAVED : undefined,
    };
  }

  function classifyReturn(prototype, options = {}) {
    if (!prototype) return null;
    const type = String(options.returnType || prototype.returnType || prototype.ret || prototype.result || '').trim().toLowerCase();
    const abiClass = String(options.returnClass || prototype.returnClass || prototype.abiClass || '').trim().toLowerCase();
    if (options.returnsValue === false || prototype.returnsValue === false || prototype.void === true || type === 'void' || abiClass === 'void') return null;
    const indirectResult = () => ({ reg:null, bits:XLEN, indirect:true, resultLocation:'memory', hiddenResultPointer:{ input:'x10' } });
    if (prototype.indirectResult === true || abiClass === 'indirect') return indirectResult();
    const aggregate = prototype.aggregate === true || /aggregate|struct|union|record|array/.test(`${type} ${abiClass}`);
    const rawBits = Number(prototype.returnBits || prototype.bits || options.returnBits || riscvTypeBits(type, XLEN));
    const bits = Number.isSafeInteger(rawBits) && rawBits > 0 ? rawBits : XLEN;
    const returnVector = vectorDescriptor({ type, abiClass, ...(prototype.returnVector || {}), vector:prototype.vectorReturn === true || prototype.returnVector?.vector === true, mask:prototype.returnVector?.mask, lmul:prototype.returnVector?.lmul, tupleCount:prototype.returnVector?.tupleCount, fixedLengthVector:prototype.returnVector?.fixedLengthVector });
    const vectorVariant = String(prototype.callingConvention || options.callingConvention || '').toLowerCase().replace('_cc','-variant') === 'riscv-vector-variant';
    if (returnVector) {
      if (!vectorVariant) return { reg:null, partial:true, location:'unknown', reason:'vector-return-calling-convention-unknown' };
      if (returnVector.fixedLength && !(Number(options?.abiVlen) > 0)) return { reg:null, partial:true, location:'unknown', reason:'fixed-vector-return-abi-vlen-required' };
      const count = returnVector.mask ? 1 : returnVector.lmul * returnVector.tupleCount;
      if (!returnVector.mask && count > VECTOR_ARGUMENT_REGISTERS.length) return { reg:null, partial:true, location:'unknown', reason:'vector-return-group-too-large' };
      const regs = returnVector.mask ? ['v0'] : Array.from({ length:count }, (_unused, index) => `v${8 + index}`);
      return { reg:regs[0], regs, bits, vector:true, mask:returnVector.mask, callingConvention:'riscv-vector-variant' };
    }
    if (aggregate) {
      if (bits > 2 * XLEN) return indirectResult();
      const members = aggregateMembers(prototype.returnAggregate || prototype);
      if (hardFloat && members) {
        const classifiedMembers = members.map((member) => parameterClass(member));
        const eligible = classifiedMembers.length >= 1 && classifiedMembers.length <= 2
          && classifiedMembers.some((member) => member.floating && member.bits <= abiFlen)
          && classifiedMembers.every((member) => !member.aggregate && !member.vector && member.bits <= XLEN && (!member.floating || member.bits <= abiFlen));
        if (eligible) {
          let fp=0, integer=0;
          const parts=classifiedMembers.map((member, memberIndex) => member.floating
            ? { memberIndex, reg:FLOAT_ARGUMENT_REGISTERS[fp++], bits:member.bits, abiClass:'float' }
            : { memberIndex, reg:INTEGER_RETURN_REGISTERS[integer++], bits:member.bits, abiClass:'integer' });
          return { reg:parts[0].reg, regs:parts.map((part)=>part.reg), parts, bits, aggregate:true, abiClass:'aggregate-hard-float-flattened' };
        }
      }
      if (hardFloat && !members) return { reg:null, partial:true, location:'unknown', reason:`${profile.id}-small-aggregate-return-flattening-not-proven` };
      const regs = bits > XLEN ? INTEGER_RETURN_REGISTERS.slice(0, 2) : INTEGER_RETURN_REGISTERS.slice(0, 1);
      return { reg:regs[0], regs, abiNames:regs.map((reg) => ABI_ALIAS[reg]), bits, aggregate:true };
    }
    const floating = isFloatingType(type) || /\bfp\b/.test(abiClass);
    if (hardFloat && floating && bits <= abiFlen) return { reg:'f10', abiName:'fa0', bits };
    if (bits > 2 * XLEN) return { reg:null, bits, indirect:true, hiddenResultPointer:{ input:'x10', returned:null }, memoryResult:true };
    if (bits > XLEN) return { reg:INTEGER_RETURN_REGISTERS[0], regs:[...INTEGER_RETURN_REGISTERS], abiNames:['a0','a1'], bits };
    if (type || abiClass || options.returnsValue === true || prototype.returnsValue === true) {
      return { reg:INTEGER_RETURN_REGISTERS[0], abiName:'a0', bits };
    }
    return null;
  }

  return { classifyArguments, classifyReturn };
}

function createRiscvAbi(profile) {
  const { classifyArguments, classifyReturn } = createClassifier(profile);
  const abiFlenBits = profile.floatAbi === 'single' ? 32 : profile.floatAbi === 'double' ? 64 : 0;
  const callerSavedFor = ({ valueWidthBits = null } = {}) => {
    if (profile.floatAbi === 'soft') return CALLER_SAVED;
    const width = Number(valueWidthBits);
    const calleeSavedFpWidthProven = Number.isSafeInteger(width) && width > 0 && width <= abiFlenBits;
    return calleeSavedFpWidthProven
      ? Object.freeze([...CALLER_SAVED, ...FLOAT_CALLER_SAVED])
      : Object.freeze([...CALLER_SAVED, ...ALL_FLOAT_REGISTERS]);
  };
  const calleeSavedFor = ({ valueWidthBits = null } = {}) => {
    if (profile.floatAbi === 'soft') return CALLEE_SAVED;
    const width = Number(valueWidthBits);
    const calleeSavedFpWidthProven = Number.isSafeInteger(width) && width > 0 && width <= abiFlenBits;
    return calleeSavedFpWidthProven
      ? Object.freeze([...CALLEE_SAVED, ...FLOAT_CALLEE_SAVED])
      : CALLEE_SAVED;
  };
  return new ABIPlugin({
    id:profile.id,
    semanticVersion:'1',
    architectureId:'riscv64',
    platformPredicate:({ platform }) => !platform || ['linux','freebsd','netbsd','openbsd','unix','bare-metal','unknown'].includes(platform),
    callingConventions:()=>Object.freeze([profile.id, 'riscv-vector-variant']),
    classifyArguments,
    classifyCallReturn:(instruction, options = {}) => classifyReturn(callPrototypeOf(instruction, options), options),
    classifyFunctionReturn:(options = {}) => classifyReturn(options.functionPrototype || options.prototype || {}, options),
    classifyEntryRegister:(reg) => {
      const id = String(reg || '').toLowerCase();
      const index = INTEGER_ARGUMENT_REGISTERS.indexOf(id);
      if (index >= 0) return { kind:'argument', reg:id, abiName:ABI_ALIAS[id], index, abiClass:'integer' };
      if (id === 'x2') return { kind:'stack-pointer', reg:id, abiName:'sp' };
      if (id === 'x1') return { kind:'return-address', reg:id, abiName:'ra' };
      if (UNALLOCATABLE.includes(id)) return { kind:'reserved-register-state', reg:id, abiName:ABI_ALIAS[id] ?? 'zero' };
      return { kind:'incoming-register-state', reg:id };
    },
    callerSaved:(request)=>callerSavedFor(request),
    calleeSaved:(request)=>calleeSavedFor(request),
    stackRules:()=>Object.freeze({
      alignment:16,
      stackGrows:'down',
      argumentSlotBytes:8,
      // The return address is delivered in ra, not pushed by the call, so the
      // callee's incoming stack arguments start at sp+0.
      returnAddressBytes:0,
      returnAddressRegister:'x1',
      calleeEntryAlignmentOffset:0,
      framePointer:'x8',
      unallocatableRegisters:UNALLOCATABLE,
      aggregateClassification:profile.floatAbi === 'soft' ? 'proven' : 'partial',
    }),
    // The RISC-V psABI defines no red zone.
    redZone:()=>0,
    unwindRules:()=>Object.freeze({ framePointer:'x8', returnAddress:'register', returnAddressRegister:'x1' }),
    defaultUnknownCallEffects:()=>Object.freeze({
      registerClobbers:callerSavedFor(),
      memoryEffects:'unknown',
      mayThrow:true,
      redZonePreservedAcrossCall:true,
      aggregateEffects:'unknown',
      variadicEffects:'unknown',
    }),
    syscallABI:null,
  });
}

export const RISCV_LP64_SCOPE = Object.freeze({
  integerArguments:'exact',
  integerReturns:'exact',
  stackArguments:'exact',
  aggregates:'exact-for-integer-registers-and-by-reference',
  variadic:'exact-integer-registers-then-stack',
  floatingPoint:'not-applicable-soft-float-abi',
});

export const RISCV_LP64F_SCOPE = Object.freeze({
  integerArguments:'exact',
  integerReturns:'exact',
  stackArguments:'exact',
  aggregates:'partial-float-member-flattening-not-proven',
  variadic:'exact-integer-registers-then-stack',
  floatingPoint:'partial-scalar-only',
});

export const RISCV_LP64_ABI = createRiscvAbi({ id:'lp64', floatAbi:'soft', scope:RISCV_LP64_SCOPE });
export const RISCV_LP64F_ABI = createRiscvAbi({ id:'lp64f', floatAbi:'single', scope:RISCV_LP64F_SCOPE });
export const RISCV_LP64D_ABI = createRiscvAbi({ id:'lp64d', floatAbi:'double', scope:RISCV_LP64F_SCOPE });

export const RISCV_INTEGER_ARGUMENT_REGISTERS = INTEGER_ARGUMENT_REGISTERS;
export const RISCV_INTEGER_RETURN_REGISTERS = INTEGER_RETURN_REGISTERS;
export const RISCV_CALLER_SAVED = CALLER_SAVED;
export const RISCV_CALLEE_SAVED = CALLEE_SAVED;
export const RISCV_UNALLOCATABLE = UNALLOCATABLE;
export const RISCV_ABI_ALIAS = ABI_ALIAS;
export const RISCV_VECTOR_ARGUMENT_REGISTERS = VECTOR_ARGUMENT_REGISTERS;
export const RISCV_VECTOR_VARIANT_CALLEE_SAVED = VECTOR_VARIANT_CALLEE_SAVED;
export const RISCV_VECTOR_VARIANT_CALLER_SAVED = VECTOR_VARIANT_CALLER_SAVED;

/*
 * psABI variant selection from ELF e_flags.
 *
 * Authority: RISC-V ELF psABI, "File Header" EF_RISCV_* flag definitions. A
 * RV64 ELF does not have one fixed calling convention: the floating-point ABI
 * is declared in the header, and assuming LP64D (or LP64) for every RV64 image
 * would silently mis-classify arguments. This lives with the ABI, not in the
 * ELF loader, so format parsing stays free of calling-convention knowledge.
 */
export const EF_RISCV_RVC = 0x0001;
export const EF_RISCV_FLOAT_ABI_MASK = 0x0006;
export const EF_RISCV_FLOAT_ABI_SOFT = 0x0000;
export const EF_RISCV_FLOAT_ABI_SINGLE = 0x0002;
export const EF_RISCV_FLOAT_ABI_DOUBLE = 0x0004;
export const EF_RISCV_FLOAT_ABI_QUAD = 0x0006;
export const EF_RISCV_RVE = 0x0008;
export const EF_RISCV_TSO = 0x0010;

export function riscvAbiFromElfFlags(flags, { bits = 64 } = {}) {
  const value = Number(flags ?? 0) >>> 0;
  const floatBits = value & EF_RISCV_FLOAT_ABI_MASK;
  const rve = (value & EF_RISCV_RVE) !== 0;
  const base = {
    compressed: (value & EF_RISCV_RVC) !== 0,
    totalStoreOrdering: (value & EF_RISCV_TSO) !== 0,
    reducedRegisterSet: rve,
    flags: value,
  };
  if (bits !== 64) {
    return Object.freeze({ ...base, abiId: null, supported: false, reason: 'riscv-non-64-bit-abi-outside-phase6-profile' });
  }
  if (rve) {
    // RVE halves the integer register file, which changes the argument
    // registers. That is a different convention, not a variant of LP64.
    return Object.freeze({ ...base, abiId: null, supported: false, reason: 'riscv-rve-abi-outside-phase6-profile' });
  }
  if (floatBits === EF_RISCV_FLOAT_ABI_QUAD) {
    return Object.freeze({ ...base, abiId: null, supported: false, reason: 'riscv-lp64q-abi-outside-phase6-profile' });
  }
  const abiId = floatBits === EF_RISCV_FLOAT_ABI_DOUBLE ? 'lp64d'
    : floatBits === EF_RISCV_FLOAT_ABI_SINGLE ? 'lp64f'
      : 'lp64';
  return Object.freeze({
    ...base,
    abiId,
    supported: true,
    floatAbi: abiId === 'lp64' ? 'soft' : abiId === 'lp64f' ? 'single' : 'double',
    // Only the soft-float convention is fully proven by the Phase 6 corpus.
    // The hardware-float variants classify integer arguments exactly and stay
    // explicit that floating-point classification is partial.
    exactness: abiId === 'lp64' ? 'exact' : 'partial-floating-point-classification',
  });
}
