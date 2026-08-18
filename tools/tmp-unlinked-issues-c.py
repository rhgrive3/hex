from pathlib import Path


def replace_once(path, old, new):
    p = Path(path)
    text = p.read_text()
    count = text.count(old)
    if count != 1:
        raise SystemExit(f'{path}: expected exactly one match, got {count}: {old[:160]!r}')
    p.write_text(text.replace(old, new, 1))

# #875 + #882 + #888: canonical type widths, fail-closed hard-float aggregates,
# and function-specific RISC-V vector calling-convention metadata.
replace_once('js/targets/abi/riscv-lp64.js',
'''/* fa0-fa7 for the hardware-float variants. */
const FLOAT_ARGUMENT_REGISTERS = Object.freeze(['f10','f11','f12','f13','f14','f15','f16','f17']);''',
'''/* fa0-fa7 for the hardware-float variants. */
const FLOAT_ARGUMENT_REGISTERS = Object.freeze(['f10','f11','f12','f13','f14','f15','f16','f17']);
const VECTOR_ARGUMENT_REGISTERS = Object.freeze(Array.from({ length:16 }, (_unused, index) => `v${8 + index}`));
const VECTOR_VARIANT_CALLEE_SAVED = Object.freeze([
  ...Array.from({ length:7 }, (_unused, index) => `v${1 + index}`),
  ...Array.from({ length:8 }, (_unused, index) => `v${24 + index}`),
]);
const VECTOR_VARIANT_CALLER_SAVED = Object.freeze([
  'v0', ...VECTOR_ARGUMENT_REGISTERS, 'vl', 'vtype', 'vxrm', 'vxsat', 'vstart',
]);''')

replace_once('js/targets/abi/riscv-lp64.js',
'''function typeBits(type, fallback = XLEN) {
  if (/\\b(?:bool|char|int8|uint8)\\b/.test(type)) return 8;
  if (/\\b(?:short|int16|uint16)\\b/.test(type)) return 16;
  if (/\\b(?:int|unsigned int|int32|uint32|float)\\b/.test(type)) return 32;
  if (/\\b(?:double|long|int64|uint64|pointer|ptr)\\b|\\*/.test(type)) return 64;
  return fallback;
}''',
'''export function riscvTypeBits(type, fallback = XLEN) {
  const text = String(type || '').toLowerCase().replace(/\\s+/g, ' ').trim();
  if (!text) return fallback;
  const bitInt = /(?:^|\\s)(?:unsigned\\s+)?_bitint\\s*\\(\\s*(\\d+)\\s*\\)/.exec(text);
  if (bitInt) {
    const bits = Number(bitInt[1]);
    return Number.isSafeInteger(bits) && bits > 0 && bits <= 1_000_000 ? bits : fallback;
  }
  if (/\\*|\\b(?:pointer|ptr|uintptr_t|intptr_t)\\b/.test(text)) return XLEN;
  // Longest/compound spellings precede their component words. This avoids
  // matching `long double` as `double`/`long` and `__int128` as fallback XLEN.
  if (/\\blong double\\b/.test(text)) return 128;
  if (/\\b(?:unsigned\\s+)?__int128\\b|\\b(?:u?int128(?:_t)?)\\b/.test(text)) return 128;
  if (/\\b(?:_float16|__fp16|__bf16|bfloat16)\\b/.test(text)) return 16;
  if (/\\bdouble\\b/.test(text)) return 64;
  if (/\\bfloat\\b/.test(text)) return 32;
  if (/\\b(?:unsigned\\s+)?long long\\b|\\b(?:unsigned\\s+)?long\\b|\\b(?:u?int64(?:_t)?)\\b/.test(text)) return 64;
  if (/\\b(?:unsigned\\s+)?int\\b|\\b(?:u?int32(?:_t)?)\\b/.test(text)) return 32;
  if (/\\b(?:unsigned\\s+)?short\\b|\\b(?:u?int16(?:_t)?)\\b/.test(text)) return 16;
  if (/\\b(?:bool|_bool|signed char|unsigned char|char|u?int8(?:_t)?)\\b/.test(text)) return 8;
  return fallback;
}

function isFloatingType(type) {
  const text = String(type || '').toLowerCase();
  return /\\b(?:long double|double|float|_float16|__fp16|__bf16|bfloat16)\\b/.test(text);
}

function vectorDescriptor(parameter) {
  const type = String(parameter?.type || '').toLowerCase();
  const abiClass = String(parameter?.abiClass || parameter?.class || parameter?.kind || '').toLowerCase();
  const vector = parameter?.vector === true || parameter?.isVector === true
    || /\\b(?:vbool|v(?:u?int|float)\\d+mf?\\d+_t|vector)\\b/.test(type)
    || /vector/.test(abiClass);
  if (!vector) return null;
  const mask = parameter?.mask === true || parameter?.vectorMask === true || /\\bvbool|mask/.test(`${type} ${abiClass}`);
  const explicitLmul = Number(parameter?.lmul ?? parameter?.LMUL);
  const parsed = /m(1|2|4|8)(?:_t|\\b)/.exec(type);
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
}''')

replace_once('js/targets/abi/riscv-lp64.js',
'''function parameterClass(parameter) {
  const type = String(parameter?.type || parameter?.name || '').trim().toLowerCase();
  const abiClass = String(parameter?.abiClass || parameter?.class || parameter?.kind || '').trim().toLowerCase();
  const pointer = parameter?.pointer === true || parameter?.isPointer === true || /\\*|pointer|ptr|object/.test(`${type} ${abiClass}`);
  const aggregate = parameter?.aggregate === true || parameter?.isAggregate === true || /aggregate|struct|union|record|array/.test(`${type} ${abiClass}`);
  const floating = !aggregate && (parameter?.floating === true || /(^|\\s)(?:float|double)(?:\\s|$)|\\bfp\\b/.test(`${type} ${abiClass}`));
  const declaredBits = parameter?.bits ?? parameter?.sizeBits;
  const rawBits = Number(declaredBits ?? (pointer ? XLEN : typeBits(type, XLEN)));
  const bits = Number.isSafeInteger(rawBits) && rawBits > 0 ? Math.min(512, rawBits) : XLEN;
  return { type, abiClass, pointer, aggregate, floating, bits };
}''',
'''function parameterClass(parameter) {
  const type = String(parameter?.type || parameter?.name || '').trim().toLowerCase();
  const abiClass = String(parameter?.abiClass || parameter?.class || parameter?.kind || '').trim().toLowerCase();
  const pointer = parameter?.pointer === true || parameter?.isPointer === true || /\\*|pointer|ptr|object/.test(`${type} ${abiClass}`);
  const aggregate = parameter?.aggregate === true || parameter?.isAggregate === true || /aggregate|struct|union|record|array/.test(`${type} ${abiClass}`);
  const vector = !aggregate ? vectorDescriptor(parameter) : null;
  const floating = !aggregate && !vector && (parameter?.floating === true || isFloatingType(type) || /\\bfp\\b/.test(abiClass));
  const declaredBits = parameter?.bits ?? parameter?.sizeBits;
  const rawBits = Number(declaredBits ?? (pointer ? XLEN : riscvTypeBits(type, XLEN)));
  const bits = Number.isSafeInteger(rawBits) && rawBits > 0 ? Math.min(1_000_000, rawBits) : XLEN;
  return { type, abiClass, pointer, aggregate, floating, vector, bits };
}''')

replace_once('js/targets/abi/riscv-lp64.js',
'''function createClassifier(profile) {
  const hardFloat = profile.floatAbi !== 'soft';''',
'''function createClassifier(profile) {
  const hardFloat = profile.floatAbi !== 'soft';
  const abiFlen = profile.floatAbi === 'double' ? 64 : profile.floatAbi === 'single' ? 32 : 0;''')

replace_once('js/targets/abi/riscv-lp64.js',
'''    let stackArgsMayContainPointers = false;

    function useInteger(reg, extra = {}) {
      if (!seen.has(reg)) { seen.add(reg); srcs.push(registerSource(reg, XLEN, extra)); }
    }''',
'''    let stackArgsMayContainPointers = false;
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
    }''')

# Insert vector / allocation-unknown path before aggregate handling.
replace_once('js/targets/abi/riscv-lp64.js',
'''    parameters.forEach((parameter, index) => {
      const classified = parameterClass(parameter);

      if (classified.aggregate) {''',
'''    parameters.forEach((parameter, index) => {
      const classified = parameterClass(parameter);

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

      if (classified.aggregate) {''')

replace_once('js/targets/abi/riscv-lp64.js',
'''        /*
         * Aggregates of at most 2*XLEN are passed in up to two integer
         * registers. Whether a small struct containing floating-point members
         * is instead flattened into FP registers depends on member layout the
         * decoder does not supply, so the hard-float variants stay explicit
         * about that gap rather than guessing.
         */
        const needed = bytes > XLEN / 8 ? 2 : 1;
        if (hardFloat) { aggregatePartial = true; partial = true; }
        else aggregateProven = true;
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
        const slot = align(bytes, 8);''',
'''        /* Hard-float aggregate flattening is exact only with member evidence. */
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
        const slot = align(bytes, 8);''')

replace_once('js/targets/abi/riscv-lp64.js',
'''      if (hardFloat && classified.floating && !variadic && floatIndex < FLOAT_ARGUMENT_REGISTERS.length) {''',
'''      if (hardFloat && classified.floating && classified.bits <= abiFlen && !variadic && floatIndex < FLOAT_ARGUMENT_REGISTERS.length) {''')

# Wider-than-2*XLEN scalar values are passed by reference; needed by canonical _BitInt widths.
replace_once('js/targets/abi/riscv-lp64.js',
'''      /*
       * Scalars wider than XLEN occupy an aligned pair of argument registers.
       * On RV64 that only arises for 128-bit integers.
       */
      const needed = classified.bits > XLEN ? 2 : 1;''',
'''      if (classified.bits > 2 * XLEN) {
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
      const needed = classified.bits > XLEN ? 2 : 1;''')

replace_once('js/targets/abi/riscv-lp64.js',
'''      evidence:`prototype-${profile.id}`,
    };''',
'''      evidence:`prototype-${profile.id}`,
      completeness:(partial || aggregatePartial || allocationUnknown) ? 'partial' : 'exact',
      callingConvention:vectorVariant ? 'riscv-vector-variant' : profile.id,
      clobbers:vectorVariant ? Object.freeze([...new Set([...CALLER_SAVED, ...(hardFloat ? FLOAT_ARGUMENT_REGISTERS : []), ...VECTOR_VARIANT_CALLER_SAVED])]) : undefined,
      variantCalleeSaved:vectorVariant ? VECTOR_VARIANT_CALLEE_SAVED : undefined,
    };''')

# Return classification uses the same type resolver/ABI_FLEN boundary and supports proven vector/aggregate variants.
replace_once('js/targets/abi/riscv-lp64.js',
'''    const rawBits = Number(prototype.returnBits || prototype.bits || options.returnBits || typeBits(type, XLEN));
    const bits = Number.isSafeInteger(rawBits) && rawBits > 0 ? rawBits : XLEN;
    if (aggregate) {
      if (bits > 2 * XLEN) return { reg:INTEGER_RETURN_REGISTERS[0], abiName:'a0', bits:XLEN, indirect:true, hiddenResultPointer:{ input:'x10', returned:'x10' } };
      if (hardFloat) return { reg:null, partial:true, reason:`${profile.id}-small-aggregate-return-flattening-not-proven` };
      const regs = bits > XLEN ? INTEGER_RETURN_REGISTERS.slice(0, 2) : INTEGER_RETURN_REGISTERS.slice(0, 1);
      return { reg:regs[0], regs, abiNames:regs.map((reg) => ABI_ALIAS[reg]), bits, aggregate:true };
    }
    const floating = /(^|\\s)(?:float|double)(?:\\s|$)|\\bfp\\b/.test(`${type} ${abiClass}`);
    if (hardFloat && floating) return { reg:'f10', abiName:'fa0', bits };
    if (bits > XLEN) return { reg:INTEGER_RETURN_REGISTERS[0], regs:[...INTEGER_RETURN_REGISTERS], abiNames:['a0','a1'], bits };''',
'''    const rawBits = Number(prototype.returnBits || prototype.bits || options.returnBits || riscvTypeBits(type, XLEN));
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
      if (bits > 2 * XLEN) return { reg:INTEGER_RETURN_REGISTERS[0], abiName:'a0', bits:XLEN, indirect:true, hiddenResultPointer:{ input:'x10', returned:'x10' } };
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
    const floating = isFloatingType(type) || /\\bfp\\b/.test(abiClass);
    if (hardFloat && floating && bits <= abiFlen) return { reg:'f10', abiName:'fa0', bits };
    if (bits > 2 * XLEN) return { reg:null, bits, indirect:true, hiddenResultPointer:{ input:'x10', returned:null }, memoryResult:true };
    if (bits > XLEN) return { reg:INTEGER_RETURN_REGISTERS[0], regs:[...INTEGER_RETURN_REGISTERS], abiNames:['a0','a1'], bits };''')

replace_once('js/targets/abi/riscv-lp64.js',
'''    callingConventions:()=>Object.freeze([profile.id]),''',
'''    callingConventions:()=>Object.freeze([profile.id, 'riscv-vector-variant']),''')

replace_once('js/targets/abi/riscv-lp64.js',
'''export const RISCV_ABI_ALIAS = ABI_ALIAS;''',
'''export const RISCV_ABI_ALIAS = ABI_ALIAS;
export const RISCV_VECTOR_ARGUMENT_REGISTERS = VECTOR_ARGUMENT_REGISTERS;
export const RISCV_VECTOR_VARIANT_CALLEE_SAVED = VECTOR_VARIANT_CALLEE_SAVED;
export const RISCV_VECTOR_VARIANT_CALLER_SAVED = VECTOR_VARIANT_CALLER_SAVED;''')

# #882: generic semantic adapter preserves ABI partial/completeness and per-call clobbers.
replace_once('js/analysis/semantic-function.js',
'''        argumentEvidence:classified.evidence ?? `abi-${abiPlugin.id}`,
        clobbers:abiPlugin.callerSaved(),
        returnReg:returned?.reg ?? null,''',
'''        argumentEvidence:classified.evidence ?? `abi-${abiPlugin.id}`,
        argumentCompleteness:classified.completeness ?? (classified.partial === true ? 'partial' : 'exact'),
        abiPartial:classified.partial === true,
        aggregateClassification:classified.aggregateClassification ?? null,
        callingConvention:classified.callingConvention ?? abiPlugin.id,
        clobbers:classified.clobbers ?? abiPlugin.callerSaved(),
        returnReg:returned?.reg ?? null,''')

# #888: ELF st_other is lossless and RISC-V variant-CC is elevated to typed symbol/function metadata.
replace_once('js/binary/elf.js',
'''const SHF_EXECINSTR = 0x4n;''',
'''const SHF_EXECINSTR = 0x4n;
const EM_RISCV = 243;
export const STO_RISCV_VARIANT_CC = 0x80;''')

replace_once('js/binary/elf.js',
'''    const sym={name,address:address??0n,originalValue:value,size,kind,binding,defined,sectionIndex:sectionIdentityKnown?resolvedShndx:null,visibility:other&3,source:table.type===SHT_DYNSYM?'dynsym':'symtab',index:i,tableIndex:table.index,
      sectionRelative:elfType===ET_REL&&normal?{sectionIndex:resolvedShndx,offset:value}:null,addressDomain:elfType===ET_REL&&normal?'section-relative-synthetic':'virtual'};''',
'''    const riscvVariantCc=image.metadata.machine===EM_RISCV&&type===2&&(other&STO_RISCV_VARIANT_CC)!==0;
    const sym={name,address:address??0n,originalValue:value,size,kind,binding,defined,sectionIndex:sectionIdentityKnown?resolvedShndx:null,
      visibility:other&3,stOther:other,processorSpecificOther:other&~3,riscvVariantCc,
      callingConvention:riscvVariantCc?'riscv-vector-variant':null,
      source:table.type===SHT_DYNSYM?'dynsym':'symtab',index:i,tableIndex:table.index,
      sectionRelative:elfType===ET_REL&&normal?{sectionIndex:resolvedShndx,offset:value}:null,addressDomain:elfType===ET_REL&&normal?'section-relative-synthetic':'virtual'};''')

replace_once('js/binary/elf.js',
'''    if(defined===true&&type===2&&address!=null&&address!==0n){
      const owner=executableELFRange(image,address,size||0n,normal?resolvedShndx:null);
      if(owner){if(!budget.take({objects:1,operations:1,estimatedHeapBytes:128},'symbol-function'))break;image.functions.push(functionSeed(address,{size:size||null,name,source:'symbol',confidence:0.995,exactFunctionStart:true,functionStartEvidence:elfType===ET_REL?'ELF ET_REL STT_FUNC with validated executable section-relative extent':'ELF STT_FUNC with validated executable section extent'}));}
      else image.warnings.push(`Ignored ELF STT_FUNC ${name} outside its canonical executable extent`);
    }''',
'''    if(defined===true&&type===2&&address!=null&&address!==0n){
      const owner=executableELFRange(image,address,size||0n,normal?resolvedShndx:null);
      if(owner){
        if(!budget.take({objects:1,operations:1,estimatedHeapBytes:160},'symbol-function'))break;
        image.functions.push(functionSeed(address,{size:size||null,name,source:'symbol',confidence:0.995,exactFunctionStart:true,
          functionStartEvidence:elfType===ET_REL?'ELF ET_REL STT_FUNC with validated executable section-relative extent':'ELF STT_FUNC with validated executable section extent',
          callingConvention:riscvVariantCc?'riscv-vector-variant':null,
          abiMetadata:riscvVariantCc?{ riscvVariantCc:true, stOther:other }:null,
        }));
        if(riscvVariantCc){
          if(!Array.isArray(image.metadata.riscvVariantCcFunctions))image.metadata.riscvVariantCcFunctions=[];
          image.metadata.riscvVariantCcFunctions.push({name,address,symbolIndex:i,tableIndex:table.index,stOther:other,callingConvention:'riscv-vector-variant'});
        }
      }
      else image.warnings.push(`Ignored ELF STT_FUNC ${name} outside its canonical executable extent`);
    }''')

# Preserve function-level ABI metadata through functionSeed merging.
replace_once('js/binary/model.js',
'''    extentInherited: !!opts.extentInherited,
  };''',
'''    extentInherited: !!opts.extentInherited,
    callingConvention: opts.callingConvention || null,
    abiMetadata: opts.abiMetadata == null ? null : { ...opts.abiMetadata },
  };''')
replace_once('js/binary/model.js',
'''    if (!best.functionStartEvidence) best.functionStartEvidence = other.functionStartEvidence || null;
    let inheritedExtent = false;''',
'''    if (!best.functionStartEvidence) best.functionStartEvidence = other.functionStartEvidence || null;
    if (!best.callingConvention && other.callingConvention) best.callingConvention = other.callingConvention;
    if (!best.abiMetadata && other.abiMetadata) best.abiMetadata = { ...other.abiMetadata };
    let inheritedExtent = false;''')

print('guarded batch C source patch applied')
