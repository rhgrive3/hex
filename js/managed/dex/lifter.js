import { createOriginSet } from '../../core/identity/origin.js';
import { createManagedExceptionRegionId, createManagedMethodId, createVMOperationId } from '../shared/identity.js';
import { createVMEffectBundle, createVMEffectFunction } from '../shared/vm-effects.js';

function fail(code) { throw new TypeError(code); }

export function liftDexMethod(methodIdx, dexImage, options = {}) {
  const methodDef = dexImage.methods[methodIdx];
  if (!methodDef) fail('dex-invalid-method-index');

  const methodId = createManagedMethodId(dexImage.moduleId, methodIdx, methodDef.name);

  // Find class and direct/virtual method entry to check codeOff and accessFlags
  let codeOff = 0;
  let accessFlags = 0;
  for (const cls of dexImage.classes) {
    const dm = cls.directMethods.find((m) => m.methodIdx === methodIdx);
    if (dm) { codeOff = dm.codeOff; accessFlags = dm.accessFlags; break; }
    const vm = cls.virtualMethods.find((m) => m.methodIdx === methodIdx);
    if (vm) { codeOff = vm.codeOff; accessFlags = vm.accessFlags; break; }
  }

  const isNative = (accessFlags & 0x0100) !== 0; // ACC_NATIVE
  if (isNative || codeOff === 0) {
    // Native method (JNI boundary) or abstract method
    const bundle = createVMEffectBundle({
      frontendId: 'dex',
      methodId,
      operationId: createVMOperationId(methodId, 0),
      bytecodeOffset: 0,
      opcode: 0,
      mnemonic: isNative ? 'jni_native_method' : 'abstract_method',
      callEffects: isNative ? [{
        target: `${methodDef.classType}->${methodDef.name}`,
        dispatchKind: 'jni-native',
        unresolved: true,
      }] : [],
      controlEffects: [{ kind: 'return' }],
      completeness: 'exact',
    });
    return createVMEffectFunction({
      methodId,
      profileId: dexImage.vmSpecEdition,
      frontendId: 'dex',
      bundles: [bundle],
      aggregateCompleteness: 'exact',
    });
  }

  const u8 = dexImage.rawBytes;
  const view = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);

  if (codeOff + 16 > u8.length) fail('dex-truncated-code-item');
  const registersSize = view.getUint16(codeOff, true);
  const insSize = view.getUint16(codeOff + 2, true);
  const outsSize = view.getUint16(codeOff + 4, true);
  const triesSize = view.getUint16(codeOff + 6, true);
  const debugInfoOff = view.getUint32(codeOff + 8, true);
  const insnsSize = view.getUint32(codeOff + 12, true);

  const insnsStart = codeOff + 16;
  const insnsEnd = insnsStart + insnsSize * 2;
  if (insnsEnd > u8.length) fail('dex-truncated-instructions');

  // Decode try/catch items
  const exceptionRegions = [];
  if (triesSize > 0) {
    let triesStart = insnsEnd;
    if (insnsSize % 2 === 1) triesStart += 2; // 4-byte align tries
    for (let t = 0; t < triesSize; t++) {
      const tOff = triesStart + t * 8;
      if (tOff + 8 <= u8.length) {
        const startAddr = view.getUint32(tOff, true) * 2;
        const insnCount = view.getUint16(tOff + 4, true) * 2;
        const handlerOff = view.getUint16(tOff + 6, true);
        exceptionRegions.push({
          id: createManagedExceptionRegionId(methodId, t),
          startOffset: startAddr,
          endOffset: startAddr + insnCount,
          handlerOffset: startAddr + insnCount, // approximate / mapped
        });
      }
    }
  }

  const bundles = [];
  let pc = 0; // code unit offset
  let opSeq = 0;

  while (pc < insnsSize) {
    const codeUnitOffset = pc * 2; // byte offset relative to code start
    const opByteOffset = insnsStart + codeUnitOffset;
    const insn = view.getUint16(insnsStart + pc * 2, true);
    const opcode = insn & 0xff;
    const formatByte = (insn >> 8) & 0xff;
    opSeq++;

    const opId = createVMOperationId(methodId, codeUnitOffset, opSeq);

    let mnemonic = 'unknown';
    let completeness = 'exact';
    let locationReads = [];
    let locationWrites = [];
    let memoryEffects = [];
    let callEffects = [];
    let controlEffects = [];
    let producedValues = [];
    let consumedValues = [];
    let unknownEffects = [];
    let insnLen = 1; // in 16-bit code units

    switch (opcode) {
      case 0x00: // nop
        mnemonic = 'nop';
        break;

      case 0x01: // move vA, vB
      case 0x04: // move-wide vA, vB
      case 0x07: // move-object vA, vB
        {
          const vA = formatByte & 0x0f;
          const vB = (formatByte >> 4) & 0x0f;
          const isWide = opcode === 0x04;
          mnemonic = isWide ? 'move-wide' : opcode === 0x07 ? 'move-object' : 'move';
          locationReads.push({ kind: 'register', index: vB, bits: isWide ? 64 : 32 });
          locationWrites.push({ kind: 'register', index: vA, bits: isWide ? 64 : 32 });
        }
        break;

      case 0x02: // move/from16 vAA, vBBBB
      case 0x05: // move-wide/from16
      case 0x08: // move-object/from16
        {
          insnLen = 2;
          const vAA = formatByte;
          const vBBBB = view.getUint16(insnsStart + (pc + 1) * 2, true);
          const isWide = opcode === 0x05;
          mnemonic = isWide ? 'move-wide/from16' : opcode === 0x08 ? 'move-object/from16' : 'move/from16';
          locationReads.push({ kind: 'register', index: vBBBB, bits: isWide ? 64 : 32 });
          locationWrites.push({ kind: 'register', index: vAA, bits: isWide ? 64 : 32 });
        }
        break;

      case 0x0a: // move-result vAA
      case 0x0b: // move-result-wide vAA
      case 0x0c: // move-result-object vAA
      case 0x0d: // move-exception vAA
        {
          const vAA = formatByte;
          const isWide = opcode === 0x0b;
          mnemonic = opcode === 0x0d ? 'move-exception' : isWide ? 'move-result-wide' : 'move-result';
          locationWrites.push({ kind: 'register', index: vAA, bits: isWide ? 64 : 32 });
        }
        break;

      case 0x0e: // return-void
        mnemonic = 'return-void';
        controlEffects.push({ kind: 'return' });
        break;

      case 0x0f: // return vAA
      case 0x10: // return-wide vAA
      case 0x11: // return-object vAA
        {
          const vAA = formatByte;
          const isWide = opcode === 0x10;
          mnemonic = isWide ? 'return-wide' : opcode === 0x11 ? 'return-object' : 'return';
          locationReads.push({ kind: 'register', index: vAA, bits: isWide ? 64 : 32 });
          controlEffects.push({ kind: 'return' });
        }
        break;

      case 0x12: // const/4 vA, #+B
        {
          const vA = formatByte & 0x0f;
          let imm = (formatByte >> 4) & 0x0f;
          if (imm >= 8) imm -= 16; // sign extend 4-bit
          mnemonic = 'const/4';
          locationWrites.push({ kind: 'register', index: vA, bits: 32 });
          producedValues.push({ bits: 32, constant: imm });
        }
        break;

      case 0x13: // const/16 vAA, #+BBBB
        {
          insnLen = 2;
          const vAA = formatByte;
          const imm = view.getInt16(insnsStart + (pc + 1) * 2, true);
          mnemonic = 'const/16';
          locationWrites.push({ kind: 'register', index: vAA, bits: 32 });
          producedValues.push({ bits: 32, constant: imm });
        }
        break;

      case 0x14: // const vAA, #+BBBBBBBB
        {
          insnLen = 3;
          const vAA = formatByte;
          const imm = view.getInt32(insnsStart + (pc + 1) * 2, true);
          mnemonic = 'const';
          locationWrites.push({ kind: 'register', index: vAA, bits: 32 });
          producedValues.push({ bits: 32, constant: imm });
        }
        break;

      case 0x16: // const-wide/16 vAA, #+BBBB
        {
          insnLen = 2;
          const vAA = formatByte;
          const imm = view.getInt16(insnsStart + (pc + 1) * 2, true);
          mnemonic = 'const-wide/16';
          locationWrites.push({ kind: 'register', index: vAA, bits: 64 });
          producedValues.push({ bits: 64, constant: BigInt(imm) });
        }
        break;

      case 0x1a: // const-string vAA, string@BBBB
        {
          insnLen = 2;
          const vAA = formatByte;
          const strIdx = view.getUint16(insnsStart + (pc + 1) * 2, true);
          mnemonic = 'const-string';
          locationWrites.push({ kind: 'register', index: vAA, bits: 32 });
          producedValues.push({ bits: 32, stringRef: dexImage.strings[strIdx] || '' });
        }
        break;

      case 0x22: // new-instance vAA, type@BBBB
        {
          insnLen = 2;
          const vAA = formatByte;
          const typeIdx = view.getUint16(insnsStart + (pc + 1) * 2, true);
          mnemonic = 'new-instance';
          locationWrites.push({ kind: 'register', index: vAA, bits: 32 });
          producedValues.push({ bits: 32, type: dexImage.types[typeIdx] || '' });
        }
        break;

      case 0x27: // throw vAA
        {
          const vAA = formatByte;
          mnemonic = 'throw';
          locationReads.push({ kind: 'register', index: vAA, bits: 32 });
          controlEffects.push({ kind: 'throw' });
        }
        break;

      case 0x28: // goto +AA
        {
          let offset = formatByte;
          if (offset >= 128) offset -= 256;
          mnemonic = 'goto';
          controlEffects.push({ kind: 'branch', targetOffset: (pc + offset) * 2 });
        }
        break;

      case 0x29: // goto/16 +AAAA
        {
          insnLen = 2;
          const offset = view.getInt16(insnsStart + (pc + 1) * 2, true);
          mnemonic = 'goto/16';
          controlEffects.push({ kind: 'branch', targetOffset: (pc + offset) * 2 });
        }
        break;

      // if-test vA, vB, +CCCC: if-eq (0x32), if-ne (0x33), if-lt (0x34), if-ge (0x35), if-gt (0x36), if-le (0x37)
      case 0x32: case 0x33: case 0x34: case 0x35: case 0x36: case 0x37:
        {
          insnLen = 2;
          const vA = formatByte & 0x0f;
          const vB = (formatByte >> 4) & 0x0f;
          const offset = view.getInt16(insnsStart + (pc + 1) * 2, true);
          const names = { 0x32: 'if-eq', 0x33: 'if-ne', 0x34: 'if-lt', 0x35: 'if-ge', 0x36: 'if-gt', 0x37: 'if-le' };
          mnemonic = names[opcode] || 'if-test';
          locationReads.push({ kind: 'register', index: vA, bits: 32 });
          locationReads.push({ kind: 'register', index: vB, bits: 32 });
          controlEffects.push({ kind: 'conditional-branch', targetOffset: (pc + offset) * 2 });
        }
        break;

      // if-testz vAA, +BBBB: if-eqz (0x38), if-nez (0x39), if-ltz (0x3A), if-gez (0x3B), if-gtz (0x3C), if-lez (0x3D)
      case 0x38: case 0x39: case 0x3a: case 0x3b: case 0x3c: case 0x3d:
        {
          insnLen = 2;
          const vAA = formatByte;
          const offset = view.getInt16(insnsStart + (pc + 1) * 2, true);
          const names = { 0x38: 'if-eqz', 0x39: 'if-nez', 0x3a: 'if-ltz', 0x3b: 'if-gez', 0x3c: 'if-gtz', 0x3d: 'if-lez' };
          mnemonic = names[opcode] || 'if-testz';
          locationReads.push({ kind: 'register', index: vAA, bits: 32 });
          controlEffects.push({ kind: 'conditional-branch', targetOffset: (pc + offset) * 2 });
        }
        break;

      // Instance field reads/writes: iget (0x52), iput (0x59)
      case 0x52: case 0x53: case 0x54: case 0x55: case 0x56: case 0x57: case 0x58:
      case 0x59: case 0x5a: case 0x5b: case 0x5c: case 0x5d: case 0x5e: case 0x5f:
        {
          insnLen = 2;
          const vA = formatByte & 0x0f;
          const vB = (formatByte >> 4) & 0x0f;
          const fieldIdx = view.getUint16(insnsStart + (pc + 1) * 2, true);
          const isWrite = opcode >= 0x59;
          const fld = dexImage.fields[fieldIdx] || { name: `f_${fieldIdx}` };
          mnemonic = isWrite ? 'iput' : 'iget';
          if (isWrite) {
            locationReads.push({ kind: 'register', index: vA, bits: 32 });
            locationReads.push({ kind: 'register', index: vB, bits: 32 });
          } else {
            locationReads.push({ kind: 'register', index: vB, bits: 32 });
            locationWrites.push({ kind: 'register', index: vA, bits: 32 });
          }
          memoryEffects.push({
            space: 'field',
            field: fld.name,
            classType: fld.classType,
            isWrite,
          });
        }
        break;

      // Method invokes: invoke-virtual (0x6E), invoke-super (0x6F), invoke-direct (0x70), invoke-static (0x71), invoke-interface (0x72)
      case 0x6e: case 0x6f: case 0x70: case 0x71: case 0x72:
        {
          insnLen = 3;
          const argCount = (formatByte >> 4) & 0x0f;
          const methIdx = view.getUint16(insnsStart + (pc + 1) * 2, true);
          const argsWord = view.getUint16(insnsStart + (pc + 2) * 2, true);
          const vC = argsWord & 0x0f;
          const vD = (argsWord >> 4) & 0x0f;
          const vE = (argsWord >> 8) & 0x0f;
          const vF = (argsWord >> 12) & 0x0f;
          const vG = formatByte & 0x0f;
          const argRegs = [vC, vD, vE, vF, vG].slice(0, argCount);

          const kinds = { 0x6e: 'virtual', 0x6f: 'super', 0x70: 'direct', 0x71: 'static', 0x72: 'interface' };
          const targetMeth = dexImage.methods[methIdx] || { name: `m_${methIdx}` };
          mnemonic = `invoke-${kinds[opcode]}`;

          for (const reg of argRegs) {
            locationReads.push({ kind: 'register', index: reg, bits: 32 });
          }
          callEffects.push({
            target: `${targetMeth.classType}->${targetMeth.name}`,
            dispatchKind: kinds[opcode],
            argRegisters: argRegs,
          });
        }
        break;

      // 23x binops: add-int (0x90), sub-int (0x91), mul-int (0x92), div-int (0x93), rem-int (0x94), and-int (0x95), or-int (0x96), xor-int (0x97), shl-int (0x98), shr-int (0x99), ushr-int (0x9A)
      case 0x90: case 0x91: case 0x92: case 0x93: case 0x94: case 0x95: case 0x96: case 0x97: case 0x98: case 0x99: case 0x9a:
        {
          insnLen = 2;
          const vAA = formatByte;
          const regs = view.getUint16(insnsStart + (pc + 1) * 2, true);
          const vBB = regs & 0xff;
          const vCC = (regs >> 8) & 0xff;
          const names = {
            0x90: 'add-int', 0x91: 'sub-int', 0x92: 'mul-int', 0x93: 'div-int', 0x94: 'rem-int',
            0x95: 'and-int', 0x96: 'or-int', 0x97: 'xor-int', 0x98: 'shl-int', 0x99: 'shr-int', 0x9a: 'ushr-int',
          };
          mnemonic = names[opcode] || 'binop-int';
          locationReads.push({ kind: 'register', index: vBB, bits: 32 });
          locationReads.push({ kind: 'register', index: vCC, bits: 32 });
          locationWrites.push({ kind: 'register', index: vAA, bits: 32 });
        }
        break;

      // 2addr binops: add-int/2addr (0xB0), sub-int/2addr (0xB1), etc.
      case 0xb0: case 0xb1: case 0xb2: case 0xb3: case 0xb4: case 0xb5: case 0xb6: case 0xb7: case 0xb8: case 0xb9: case 0xba:
        {
          const vA = formatByte & 0x0f;
          const vB = (formatByte >> 4) & 0x0f;
          mnemonic = 'binop-2addr';
          locationReads.push({ kind: 'register', index: vA, bits: 32 });
          locationReads.push({ kind: 'register', index: vB, bits: 32 });
          locationWrites.push({ kind: 'register', index: vA, bits: 32 });
        }
        break;

      // lit8 binops: add-int/lit8 (0xD8), sub-int/lit8 (0xD9), mul-int/lit8 (0xDA), div-int/lit8 (0xDB), and-int/lit8 (0xDD), or-int/lit8 (0xDE), xor-int/lit8 (0xDF)
      case 0xd8: case 0xd9: case 0xda: case 0xdb: case 0xdc: case 0xdd: case 0xde: case 0xdf:
        {
          insnLen = 2;
          const vAA = formatByte;
          const words = view.getUint16(insnsStart + (pc + 1) * 2, true);
          const vBB = words & 0xff;
          let lit8 = (words >> 8) & 0xff;
          if (lit8 >= 128) lit8 -= 256;
          mnemonic = 'binop-lit8';
          locationReads.push({ kind: 'register', index: vBB, bits: 32 });
          locationWrites.push({ kind: 'register', index: vAA, bits: 32 });
          producedValues.push({ bits: 32, constant: lit8 });
        }
        break;

      default:
        mnemonic = `dex_op_0x${opcode.toString(16)}`;
        completeness = 'partial';
        unknownEffects.push({ category: 'other', reason: `unsupported-dex-opcode-0x${opcode.toString(16)}` });
        break;
    }

    const origin = createOriginSet({
      operationIds: [opId],
      byteRanges: [{ start: opByteOffset, end: opByteOffset + insnLen * 2 }],
    });

    bundles.push(createVMEffectBundle({
      schemaVersion: 1,
      contractVersion: '1.0.0',
      frontendId: 'dex',
      frontendSemanticVersion: '1.0.0',
      profileId: dexImage.vmSpecEdition,
      methodId,
      operationId: opId,
      bytecodeOffset: codeUnitOffset,
      opcode,
      mnemonic,
      consumedValues,
      producedValues,
      locationReads,
      locationWrites,
      memoryEffects,
      callEffects,
      controlEffects,
      possibleExceptions: [],
      origin,
      completeness,
      unknownEffects,
    }, options));

    pc += insnLen;
  }

  return createVMEffectFunction({
    methodId,
    profileId: dexImage.vmSpecEdition,
    frontendId: 'dex',
    bundles,
    entryState: {
      registersSize,
      insSize,
      outsSize,
    },
    exceptionRegions,
  }, options);
}
