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

function typeBits(type, fallback = XLEN) {
  if (/\b(?:bool|char|int8|uint8)\b/.test(type)) return 8;
  if (/\b(?:short|int16|uint16)\b/.test(type)) return 16;
  if (/\b(?:int|unsigned int|int32|uint32|float)\b/.test(type)) return 32;
  if (/\b(?:double|long|int64|uint64|pointer|ptr)\b|\*/.test(type)) return 64;
  return fallback;
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
  const floating = !aggregate && (parameter?.floating === true || /(^|\s)(?:float|double)(?:\s|$)|\bfp\b/.test(`${type} ${abiClass}`));
  const declaredBits = parameter?.bits ?? parameter?.sizeBits;
  const rawBits = Number(declaredBits ?? (pointer ? XLEN : typeBits(type, XLEN)));
  const bits = Number.isSafeInteger(rawBits) && rawBits > 0 ? Math.min(512, rawBits) : XLEN;
  return { type, abiClass, pointer, aggregate, floating, bits };
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
  const abiFlenBits = Number(profile.abiFlenBits || 0);

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

    function useInteger(reg, extra = {}) {
      if (!seen.has(reg)) { seen.add(reg); srcs.push(registerSource(reg, XLEN, extra)); }
    }

    function placeByReference(index, classified, abiClass) {
      const reg = INTEGER_ARGUMENT_REGISTERS[integerIndex];
      if (reg) {
        integerIndex += 1;
        useInteger(reg, { purpose:abiClass });
        arguments_.push({
          index, location:'register', reg, abiName:ABI_ALIAS[reg], abiClass,
          pointer:true, bits:XLEN, pointeeBits:classified.bits,
          hiddenIndirection:true, byReference:true, mayBeModified:true,
        });
        return;
      }
      const entry = {
        index, location:'stack', offset:stackOffset, offsetBase:'incoming-stack-arguments',
        bytes:8, abiClass, pointer:true, bits:XLEN, pointeeBits:classified.bits,
        hiddenIndirection:true, byReference:true, mayBeModified:true,
      };
      arguments_.push(entry); stackArguments.push(entry); stackOffset += 8;
      stackArgsMayContainPointers = true;
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

      if (classified.aggregate) {
        const bytes = Math.ceil(classified.bits / 8);
        if (bytes > 2 * XLEN / 8) {
          /* Aggregates larger than 2*XLEN are passed by reference. */
          aggregateProven = true;
          placeByReference(index, classified, 'aggregate-by-reference');
          return;
        }
        /*
         * Aggregates of at most 2*XLEN are passed in up to two integer
         * registers. Whether a small struct containing floating-point members
         * is instead flattened into FP registers depends on member layout the
         * decoder does not supply, so the hard-float variants stay explicit
         * about that gap rather than guessing.
         */
        const needed = bytes > XLEN / 8 ? 2 : 1;
        if (hardFloat) { aggregatePartial = true; partial = true; }
        else aggregateProven = true;
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
            stackOffset, abiClass:hardFloat ? 'aggregate-partial' : 'aggregate-integer-split',
            bits:classified.bits, ...(hardFloat ? { partial:true } : {}),
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
            abiClass:hardFloat ? 'aggregate-partial' : 'aggregate-integer-registers',
            bits:classified.bits, ...(hardFloat ? { partial:true } : {}),
          });
          return;
        }
        const slot = align(bytes, 8);
        stackOffset = align(stackOffset, needed === 2 ? 16 : 8);
        const entry = { index, location:'stack', offset:stackOffset, offsetBase:'incoming-stack-arguments', bytes:slot, abiClass:'aggregate-memory', bits:classified.bits };
        arguments_.push(entry); stackArguments.push(entry); stackOffset += slot;
        return;
      }

      /* Scalars wider than 2*XLEN are replaced with a pointer to a caller copy. */
      if (classified.bits > 2 * XLEN) {
        placeByReference(index, classified, 'scalar-by-reference');
        return;
      }

      /*
       * Hardware-float variants pass named scalar float/double in fa0-fa7 only
       * when the scalar is no wider than ABI_FLEN. Variadic/unnamed arguments
       * and wider floating scalars use the integer convention.
       */
      if (hardFloat && classified.floating && classified.bits <= abiFlenBits && !variadicArgument && floatIndex < FLOAT_ARGUMENT_REGISTERS.length) {
        const reg = FLOAT_ARGUMENT_REGISTERS[floatIndex++];
        if (!seen.has(reg)) { seen.add(reg); srcs.push({ t:'reg', reg, bits:classified.bits }); }
        arguments_.push({ index, location:'register', reg, abiClass:'float', bits:classified.bits });
        return;
      }

      const needed = classified.bits > XLEN ? 2 : 1;

      /* 2*XLEN-aligned variadic values require an aligned pair; spilling makes the remaining variadic tail stack-only. */
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

      /* Ordinary named 2*XLEN scalars do not require an even register pair. */
      if (needed === 2 && integerIndex === INTEGER_ARGUMENT_REGISTERS.length - 1) {
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
    const rawBits = Number(prototype.returnBits || prototype.bits || options.returnBits || typeBits(type, XLEN));
    const bits = Number.isSafeInteger(rawBits) && rawBits > 0 ? rawBits : XLEN;
    if (aggregate) {
      if (bits > 2 * XLEN) return indirectResult();
      if (hardFloat) return { reg:null, partial:true, reason:`${profile.id}-small-aggregate-return-flattening-not-proven` };
      const regs = bits > XLEN ? INTEGER_RETURN_REGISTERS.slice(0, 2) : INTEGER_RETURN_REGISTERS.slice(0, 1);
      return { reg:regs[0], regs, abiNames:regs.map((reg) => ABI_ALIAS[reg]), bits, aggregate:true };
    }
    const floating = /(^|\s)(?:float|double)(?:\s|$)|\bfp\b/.test(`${type} ${abiClass}`);
    if (hardFloat && floating && bits <= abiFlenBits) return { reg:'f10', abiName:'fa0', bits };
    if (bits > 2 * XLEN) return indirectResult();
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
  const callerSaved = profile.floatAbi === 'soft'
    ? CALLER_SAVED
    : Object.freeze([...CALLER_SAVED, ...FLOAT_ARGUMENT_REGISTERS]);
  return new ABIPlugin({
    id:profile.id,
    semanticVersion:'1',
    architectureId:'riscv64',
    platformPredicate:({ platform }) => !platform || ['linux','freebsd','netbsd','openbsd','unix','bare-metal','unknown'].includes(platform),
    callingConventions:()=>Object.freeze([profile.id]),
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
    callerSaved:()=>callerSaved,
    calleeSaved:()=>CALLEE_SAVED,
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
      registerClobbers:callerSaved,
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
  variadic:'exact-named-hard-float-then-integer-varargs',
  floatingPoint:'partial-scalar-only',
});

export const RISCV_LP64_ABI = createRiscvAbi({ id:'lp64', floatAbi:'soft', abiFlenBits:0, scope:RISCV_LP64_SCOPE });
export const RISCV_LP64F_ABI = createRiscvAbi({ id:'lp64f', floatAbi:'single', abiFlenBits:32, scope:RISCV_LP64F_SCOPE });
export const RISCV_LP64D_ABI = createRiscvAbi({ id:'lp64d', floatAbi:'double', abiFlenBits:64, scope:RISCV_LP64F_SCOPE });

export const RISCV_INTEGER_ARGUMENT_REGISTERS = INTEGER_ARGUMENT_REGISTERS;
export const RISCV_INTEGER_RETURN_REGISTERS = INTEGER_RETURN_REGISTERS;
export const RISCV_CALLER_SAVED = CALLER_SAVED;
export const RISCV_CALLEE_SAVED = CALLEE_SAVED;
export const RISCV_UNALLOCATABLE = UNALLOCATABLE;
export const RISCV_ABI_ALIAS = ABI_ALIAS;

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
