(function installHexX86CapstoneStructured(root) {
  'use strict';

  const ABI = Object.freeze({
    contractVersion:'capstone-5-wasm32-x86-detail/v1',
    capstoneMajor:5,
    capstoneMinor:0,
    instructionSize:240,
    instructionDetailPointer:236,
    instructionBytes:18,
    x86Detail:96,
    operandCount:64,
    operands:72,
    operandStride:48,
    encoding:456,
  });

  function u8(M, pointer) { return M.getValue(pointer, 'i8') & 0xff; }
  function u16(M, pointer) { return M.getValue(pointer, 'i16') & 0xffff; }
  function u32(M, pointer) { return M.getValue(pointer, 'i32') >>> 0; }
  function i32(M, pointer) { return M.getValue(pointer, 'i32') | 0; }
  function i64(M, pointer) { return BigInt(M.getValue(pointer, 'i64')); }

  function capstoneString(M, functionName, handle, id) {
    if (!id) return null;
    try {
      const value = M.ccall(functionName, 'string', ['number','number'], [handle, id]);
      return value ? String(value).toLowerCase() : null;
    } catch { return null; }
  }

  function accessName(M, value) {
    const read = Number(M.AC_READ ?? 1);
    const write = Number(M.AC_WRITE ?? 2);
    if ((value & read) && (value & write)) return 'read-write';
    if (value & read) return 'read';
    if (value & write) return 'write';
    return 'unknown';
  }

  function vectorPrefix(rawBytes) {
    let cursor = 0;
    const legacy = new Set([0xf0,0xf2,0xf3,0x2e,0x36,0x3e,0x26,0x64,0x65,0x66,0x67]);
    while (cursor < rawBytes.length && legacy.has(rawBytes[cursor])) cursor++;
    if (cursor < rawBytes.length && rawBytes[cursor] >= 0x40 && rawBytes[cursor] <= 0x4f) cursor++;
    const lead = rawBytes[cursor];
    const width = lead === 0xc5 ? 2 : lead === 0xc4 ? 3 : lead === 0x62 ? 4 : 0;
    if (!width || cursor + width > rawBytes.length) return null;
    return Object.freeze({
      kind:lead === 0xc5 ? 'vex2' : lead === 0xc4 ? 'vex3' : 'evex',
      bytes:rawBytes.slice(cursor, cursor + width),
      offset:cursor,
      fieldsVerified:false,
    });
  }

  function conditionCode(opcodeName) {
    const name = String(opcodeName || '').toLowerCase();
    for (const prefix of ['cmov','set','j']) {
      if (!name.startsWith(prefix) || name === 'jmp') continue;
      const suffix = name.slice(prefix.length);
      return suffix || null;
    }
    return null;
  }

  function implicitRegisters(M, handle, detail, offset, countOffset, capacity) {
    const count = Math.min(capacity, u8(M, detail + countOffset));
    const result = [];
    for (let index = 0; index < count; index++) {
      const id = u16(M, detail + offset + index * 2);
      const name = capstoneString(M, 'cs_reg_name', handle, id);
      if (name) result.push(name);
    }
    return result;
  }

  function groups(M, handle, detail) {
    const count = Math.min(8, u8(M, detail + 91));
    const result = [];
    for (let index = 0; index < count; index++) {
      const id = u8(M, detail + 83 + index);
      const name = capstoneString(M, 'cs_group_name', handle, id);
      result.push(Object.freeze({ id, name }));
    }
    return result;
  }

  function operand(M, handle, pointer, index) {
    const typeCode = u32(M, pointer);
    const widthBits = u8(M, pointer + 32) * 8;
    const access = accessName(M, u8(M, pointer + 33));
    const common = { index, widthBits, access, typeCode };
    if (typeCode === Number(M.X86_OP_REG ?? 1)) {
      const registerCode = u32(M, pointer + 8);
      return Object.freeze({
        ...common,
        type:'register',
        registerId:capstoneString(M, 'cs_reg_name', handle, registerCode),
        registerCode,
      });
    }
    if (typeCode === Number(M.X86_OP_IMM ?? 2)) {
      return Object.freeze({ ...common, type:'immediate', value:i64(M, pointer + 8) });
    }
    if (typeCode === Number(M.X86_OP_MEM ?? 3)) {
      const segmentCode = u32(M, pointer + 8);
      const baseCode = u32(M, pointer + 12);
      const indexCode = u32(M, pointer + 16);
      return Object.freeze({
        ...common,
        type:'memory',
        memory:Object.freeze({
          segment:capstoneString(M, 'cs_reg_name', handle, segmentCode),
          segmentCode,
          base:capstoneString(M, 'cs_reg_name', handle, baseCode),
          baseCode,
          index:capstoneString(M, 'cs_reg_name', handle, indexCode),
          indexCode,
          scale:i32(M, pointer + 20),
          displacement:i64(M, pointer + 24),
        }),
      });
    }
    return Object.freeze({ ...common, type:'invalid' });
  }

  function verifyVersion(M) {
    const major = M._malloc(4);
    const minor = M._malloc(4);
    try {
      M.ccall('cs_version', 'number', ['pointer','pointer'], [major, minor]);
      const actualMajor = M.getValue(major, 'i32');
      const actualMinor = M.getValue(minor, 'i32');
      if (actualMajor !== ABI.capstoneMajor || actualMinor !== ABI.capstoneMinor) {
        throw new Error(`x86-capstone-detail-abi-version-mismatch:${actualMajor}.${actualMinor}`);
      }
      return Object.freeze({ major:actualMajor, minor:actualMinor });
    } finally {
      M._free(major);
      M._free(minor);
    }
  }

  function parseInstruction(M, handle, instructionPointer, options = {}) {
    const size = u16(M, instructionPointer + 16);
    if (size < 1 || size > 15) throw new Error(`x86-decoder-invalid-instruction-length:${size}`);
    const address = i64(M, instructionPointer + 8);
    const expected = BigInt(options.address);
    if (address !== expected) throw new Error(`x86-decoder-address-mismatch:${address}:${expected}`);
    const rawBytes = Uint8Array.from({ length:size }, (_unused, index) => u8(M, instructionPointer + ABI.instructionBytes + index));
    const opcodeId = u32(M, instructionPointer);
    const opcodeName = capstoneString(M, 'cs_insn_name', handle, opcodeId);
    const mnemonic = M.UTF8ToString(instructionPointer + 42);
    const opStr = M.UTF8ToString(instructionPointer + 74);
    const detailPointer = u32(M, instructionPointer + ABI.instructionDetailPointer);
    const base = {
      address,
      size,
      length:size,
      mnemonic,
      opStr,
      rawBytes,
      architecture:'x86_64',
      mode:String(options.mode || 'long-64'),
      decoderContractVersion:'x86-64-decoded-instruction/v1',
      decoderSemanticVersion:'capstone-5-x86-structured-v1',
      instructionCode:opcodeId,
      opcodeId,
      instructionFamily:opcodeName || mnemonic,
      opcodeName:opcodeName || null,
    };
    if (!opcodeId || !detailPointer) {
      return Object.freeze({
        ...base,
        detailAvailable:false,
        detailStatus:opcodeId ? 'unavailable' : 'skipdata',
        detail:Object.freeze({ unavailableFacts:Object.freeze(['all-structured-x86-detail']) }),
      });
    }

    const x86 = detailPointer + ABI.x86Detail;
    const operandCount = Math.min(8, u8(M, x86 + ABI.operandCount));
    const operands = [];
    for (let index = 0; index < operandCount; index++) {
      operands.push(operand(M, handle, x86 + ABI.operands + index * ABI.operandStride, index));
    }
    const legacyPrefixes = Uint8Array.from({ length:4 }, (_unused, index) => u8(M, x86 + index)).filter((value) => value !== 0);
    const opcodeBytes = Uint8Array.from({ length:4 }, (_unused, index) => u8(M, x86 + 4 + index));
    const encoding = x86 + ABI.encoding;
    const detail = Object.freeze({
      abiContractVersion:ABI.contractVersion,
      prefixes:Object.freeze({ legacy:legacyPrefixes, rex:u8(M, x86 + 8) || null, vector:vectorPrefix(rawBytes) }),
      opcodeBytes,
      addressSizeBits:u8(M, x86 + 9) * 8,
      modrm:u8(M, x86 + 10),
      sib:u8(M, x86 + 11),
      displacement:i64(M, x86 + 16),
      sibIndex:capstoneString(M, 'cs_reg_name', handle, u32(M, x86 + 24)),
      sibScale:i32(M, x86 + 28),
      sibBase:capstoneString(M, 'cs_reg_name', handle, u32(M, x86 + 32)),
      eflags:i64(M, x86 + 56),
      operandCount,
      operands:Object.freeze(operands),
      implicitReads:Object.freeze(implicitRegisters(M, handle, detailPointer, 0, 40, 20)),
      implicitWrites:Object.freeze(implicitRegisters(M, handle, detailPointer, 42, 82, 20)),
      groups:Object.freeze(groups(M, handle, detailPointer)),
      conditionCode:conditionCode(opcodeName),
      encodingOffsets:Object.freeze({
        modrmOffset:u8(M, encoding),
        displacementOffset:u8(M, encoding + 1),
        displacementSize:u8(M, encoding + 2),
        immediateOffset:u8(M, encoding + 3),
        immediateSize:u8(M, encoding + 4),
      }),
      unavailableFacts:Object.freeze(vectorPrefix(rawBytes)?.fieldsVerified === false ? ['decoded-vex-evex-bitfields'] : []),
    });
    return Object.freeze({ ...base, detailAvailable:true, detailStatus:'complete', detail });
  }

  root.HexX86CapstoneStructured = Object.freeze({ ABI, verifyVersion, parseInstruction });
})(globalThis);
