import { createOriginSet } from '../../core/identity/origin.js';
import { createManagedExceptionRegionId, createManagedMethodId, createVMOperationId } from '../shared/identity.js';
import { createVMEffectBundle, createVMEffectFunction } from '../shared/vm-effects.js';

function fail(code) { throw new TypeError(code); }

export function liftJvmMethod(methodIdx, jvmClass, options = {}) {
  const method = jvmClass.methods[methodIdx];
  if (!method) fail('jvm-invalid-method-index');

  const methodId = createManagedMethodId(jvmClass.moduleId, methodIdx, method.name);
  const isNative = (method.accessFlags & 0x0100) !== 0; // ACC_NATIVE

  if (isNative || !method.code) {
    const bundle = createVMEffectBundle({
      frontendId: 'jvm',
      methodId,
      operationId: createVMOperationId(methodId, 0),
      bytecodeOffset: 0,
      opcode: 0,
      mnemonic: isNative ? 'jni_native_method' : 'abstract_method',
      callEffects: isNative ? [{
        target: `${jvmClass.thisClassName}.${method.name}${method.descriptor}`,
        dispatchKind: 'jni-native',
        unresolved: true,
      }] : [],
      controlEffects: [{ kind: 'return' }],
      completeness: 'exact',
    });
    return createVMEffectFunction({
      methodId,
      profileId: jvmClass.vmSpecEdition,
      frontendId: 'jvm',
      bundles: [bundle],
      aggregateCompleteness: 'exact',
    });
  }

  const codeAttr = method.code;
  const bytecode = codeAttr.bytecode;
  const view = new DataView(bytecode.buffer, bytecode.byteOffset, bytecode.byteLength);

  let pc = 0;
  let opSeq = 0;
  let currentStackHeight = 0;
  const bundles = [];

  const exceptionRegions = (codeAttr.exceptionTable || []).map((exc, idx) => ({
    id: createManagedExceptionRegionId(methodId, idx),
    startOffset: exc.startPc,
    endOffset: exc.endPc,
    handlerOffset: exc.handlerPc,
    catchType: exc.catchType,
  }));

  while (pc < bytecode.length) {
    const opOffset = pc;
    const opcode = bytecode[pc++];
    opSeq++;

    const opId = createVMOperationId(methodId, opOffset, opSeq);
    const origin = createOriginSet({
      operationIds: [opId],
      byteRanges: [{ start: codeAttr.offset + opOffset, end: codeAttr.offset + pc }],
    });

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

    switch (opcode) {
      case 0x00: // nop
        mnemonic = 'nop';
        break;

      case 0x01: // aconst_null
        mnemonic = 'aconst_null';
        producedValues.push({ bits: 64, isNull: true });
        currentStackHeight++;
        break;

      // iconst_m1 (-1), iconst_0 .. iconst_5
      case 0x02: case 0x03: case 0x04: case 0x05: case 0x06: case 0x07: case 0x08:
        {
          const val = opcode === 0x02 ? -1 : opcode - 0x03;
          mnemonic = `iconst_${opcode === 0x02 ? 'm1' : val}`;
          producedValues.push({ bits: 32, constant: val });
          currentStackHeight++;
        }
        break;

      // lconst_0, lconst_1 (category 2)
      case 0x09: case 0x0a:
        {
          const val = opcode === 0x09 ? 0n : 1n;
          mnemonic = `lconst_${val}`;
          producedValues.push({ bits: 64, constant: val, category: 2 });
          currentStackHeight += 2;
        }
        break;

      case 0x10: // bipush
        {
          let val = bytecode[pc++];
          if (val >= 128) val -= 256;
          mnemonic = 'bipush';
          producedValues.push({ bits: 32, constant: val });
          currentStackHeight++;
        }
        break;

      case 0x11: // sipush
        {
          const val = view.getInt16(pc, false);
          pc += 2;
          mnemonic = 'sipush';
          producedValues.push({ bits: 32, constant: val });
          currentStackHeight++;
        }
        break;

      case 0x12: // ldc
      case 0x13: // ldc_w
      case 0x14: // ldc2_w
        {
          const cpIdx = opcode === 0x12 ? bytecode[pc++] : view.getUint16(pc, false);
          if (opcode !== 0x12) pc += 2;
          const isCategory2 = opcode === 0x14;
          mnemonic = opcode === 0x12 ? 'ldc' : opcode === 0x13 ? 'ldc_w' : 'ldc2_w';
          producedValues.push({ bits: isCategory2 ? 64 : 32, cpIndex: cpIdx, category: isCategory2 ? 2 : 1 });
          currentStackHeight += isCategory2 ? 2 : 1;
        }
        break;

      // iload, lload, fload, dload, aload
      case 0x15: case 0x16: case 0x17: case 0x18: case 0x19:
        {
          const locIdx = bytecode[pc++];
          const isCategory2 = opcode === 0x16 || opcode === 0x18;
          const names = { 0x15: 'iload', 0x16: 'lload', 0x17: 'fload', 0x18: 'dload', 0x19: 'aload' };
          mnemonic = names[opcode];
          locationReads.push({ kind: 'local', index: locIdx, bits: isCategory2 ? 64 : 32 });
          producedValues.push({ bits: isCategory2 ? 64 : 32 });
          currentStackHeight += isCategory2 ? 2 : 1;
        }
        break;

      // iload_0 .. aload_3
      case 0x1a: case 0x1b: case 0x1c: case 0x1d: // iload_0..3
      case 0x1e: case 0x1f: case 0x20: case 0x21: // lload_0..3 (cat 2)
      case 0x22: case 0x23: case 0x24: case 0x25: // fload_0..3
      case 0x26: case 0x27: case 0x28: case 0x29: // dload_0..3 (cat 2)
      case 0x2a: case 0x2b: case 0x2c: case 0x2d: // aload_0..3
        {
          const base = opcode < 0x1e ? 0x1a : opcode < 0x22 ? 0x1e : opcode < 0x26 ? 0x22 : opcode < 0x2a ? 0x26 : 0x2a;
          const prefix = opcode < 0x1e ? 'iload' : opcode < 0x22 ? 'lload' : opcode < 0x26 ? 'fload' : opcode < 0x2a ? 'dload' : 'aload';
          const locIdx = opcode - base;
          const isCategory2 = prefix === 'lload' || prefix === 'dload';
          mnemonic = `${prefix}_${locIdx}`;
          locationReads.push({ kind: 'local', index: locIdx, bits: isCategory2 ? 64 : 32 });
          producedValues.push({ bits: isCategory2 ? 64 : 32 });
          currentStackHeight += isCategory2 ? 2 : 1;
        }
        break;

      // istore, lstore, fstore, dstore, astore
      case 0x36: case 0x37: case 0x38: case 0x39: case 0x3a:
        {
          const locIdx = bytecode[pc++];
          const isCategory2 = opcode === 0x37 || opcode === 0x39;
          const names = { 0x36: 'istore', 0x37: 'lstore', 0x38: 'fstore', 0x39: 'dstore', 0x3a: 'astore' };
          mnemonic = names[opcode];
          locationWrites.push({ kind: 'local', index: locIdx, bits: isCategory2 ? 64 : 32 });
          consumedValues.push({ id: 'top' });
          currentStackHeight -= isCategory2 ? 2 : 1;
        }
        break;

      // istore_0 .. astore_3
      case 0x3b: case 0x3c: case 0x3d: case 0x3e: // istore_0..3
      case 0x3f: case 0x40: case 0x41: case 0x42: // lstore_0..3 (cat 2)
      case 0x43: case 0x44: case 0x45: case 0x46: // fstore_0..3
      case 0x47: case 0x48: case 0x49: case 0x4a: // dstore_0..3 (cat 2)
      case 0x4b: case 0x4c: case 0x4d: case 0x4e: // astore_0..3
        {
          const base = opcode < 0x3f ? 0x3b : opcode < 0x43 ? 0x3f : opcode < 0x47 ? 0x43 : opcode < 0x4b ? 0x47 : 0x4b;
          const prefix = opcode < 0x3f ? 'istore' : opcode < 0x43 ? 'lstore' : opcode < 0x47 ? 'fstore' : opcode < 0x4b ? 'dstore' : 'astore';
          const locIdx = opcode - base;
          const isCategory2 = prefix === 'lstore' || prefix === 'dstore';
          mnemonic = `${prefix}_${locIdx}`;
          locationWrites.push({ kind: 'local', index: locIdx, bits: isCategory2 ? 64 : 32 });
          consumedValues.push({ id: 'top' });
          currentStackHeight -= isCategory2 ? 2 : 1;
        }
        break;

      case 0x57: // pop
      case 0x58: // pop2
        mnemonic = opcode === 0x57 ? 'pop' : 'pop2';
        consumedValues.push({ id: 'top' });
        currentStackHeight -= opcode === 0x57 ? 1 : 2;
        break;

      case 0x59: // dup
        mnemonic = 'dup';
        consumedValues.push({ id: 'top' });
        producedValues.push({ id: 'dup1' }, { id: 'dup2' });
        currentStackHeight++;
        break;

      // iadd (0x60), isub (0x64), imul (0x68), idiv (0x6C), irem (0x70), iand (0x7E), ior (0x80), ixor (0x82), ishl (0x78), ishr (0x7A), iushr (0x7C)
      case 0x60: case 0x64: case 0x68: case 0x6c: case 0x70: case 0x78: case 0x7a: case 0x7c: case 0x7e: case 0x80: case 0x82:
        {
          const names = {
            0x60: 'iadd', 0x64: 'isub', 0x68: 'imul', 0x6c: 'idiv', 0x70: 'irem',
            0x78: 'ishl', 0x7a: 'ishr', 0x7c: 'iushr', 0x7e: 'iand', 0x80: 'ior', 0x82: 'ixor',
          };
          mnemonic = names[opcode] || 'ibinop';
          consumedValues.push({ id: 'rhs', bits: 32 }, { id: 'lhs', bits: 32 });
          producedValues.push({ bits: 32 });
          currentStackHeight--;
        }
        break;

      case 0x84: // iinc index, const
        {
          const locIdx = bytecode[pc++];
          let imm = bytecode[pc++];
          if (imm >= 128) imm -= 256;
          mnemonic = 'iinc';
          locationReads.push({ kind: 'local', index: locIdx, bits: 32 });
          locationWrites.push({ kind: 'local', index: locIdx, bits: 32 });
          producedValues.push({ bits: 32, constant: imm });
        }
        break;

      // ifeq (0x99), ifne (0x9A), iflt (0x9B), ifge (0x9C), ifgt (0x9D), ifle (0x9E)
      case 0x99: case 0x9a: case 0x9b: case 0x9c: case 0x9d: case 0x9e:
        {
          const offset = view.getInt16(pc, false);
          pc += 2;
          const names = { 0x99: 'ifeq', 0x9a: 'ifne', 0x9b: 'iflt', 0x9c: 'ifge', 0x9d: 'ifgt', 0x9e: 'ifle' };
          mnemonic = names[opcode];
          consumedValues.push({ id: 'val', bits: 32 });
          currentStackHeight--;
          controlEffects.push({ kind: 'conditional-branch', targetOffset: opOffset + offset });
        }
        break;

      // if_icmpeq (0x9F) .. if_icmple (0xA4)
      case 0x9f: case 0xa0: case 0xa1: case 0xa2: case 0xa3: case 0xa4:
        {
          const offset = view.getInt16(pc, false);
          pc += 2;
          const names = {
            0x9f: 'if_icmpeq', 0xa0: 'if_icmpne', 0xa1: 'if_icmplt',
            0xa2: 'if_icmpge', 0xa3: 'if_icmpgt', 0xa4: 'if_icmple',
          };
          mnemonic = names[opcode];
          consumedValues.push({ id: 'rhs', bits: 32 }, { id: 'lhs', bits: 32 });
          currentStackHeight -= 2;
          controlEffects.push({ kind: 'conditional-branch', targetOffset: opOffset + offset });
        }
        break;

      case 0xa7: // goto
        {
          const offset = view.getInt16(pc, false);
          pc += 2;
          mnemonic = 'goto';
          controlEffects.push({ kind: 'branch', targetOffset: opOffset + offset });
        }
        break;

      // ireturn (0xAC) .. return (0xB1)
      case 0xac: case 0xad: case 0xae: case 0xaf: case 0xb0: case 0xb1:
        mnemonic = opcode === 0xb1 ? 'return' : 'return_val';
        if (opcode !== 0xb1) {
          consumedValues.push({ id: 'ret_val' });
        }
        controlEffects.push({ kind: 'return' });
        break;

      case 0xb2: // getstatic
      case 0xb3: // putstatic
      case 0xb4: // getfield
      case 0xb5: // putfield
        {
          const fieldIdx = view.getUint16(pc, false);
          pc += 2;
          const isWrite = opcode === 0xb3 || opcode === 0xb5;
          const isStatic = opcode === 0xb2 || opcode === 0xb3;
          mnemonic = opcode === 0xb2 ? 'getstatic' : opcode === 0xb3 ? 'putstatic' : opcode === 0xb4 ? 'getfield' : 'putfield';
          if (isWrite) {
            consumedValues.push({ id: 'val' });
            if (!isStatic) consumedValues.push({ id: 'obj' });
            currentStackHeight -= isStatic ? 1 : 2;
          } else {
            if (!isStatic) consumedValues.push({ id: 'obj' });
            producedValues.push({ bits: 32 });
            if (isStatic) currentStackHeight++;
          }
          memoryEffects.push({
            space: isStatic ? 'static-field' : 'field',
            cpIndex: fieldIdx,
            isWrite,
          });
        }
        break;

      // invokevirtual (0xB6), invokespecial (0xB7), invokestatic (0xB8), invokeinterface (0xB9)
      case 0xb6: case 0xb7: case 0xb8: case 0xb9:
        {
          const methIdx = view.getUint16(pc, false);
          pc += 2;
          if (opcode === 0xb9) pc += 2; // skip count, 0
          const kinds = { 0xb6: 'virtual', 0xb7: 'special', 0xb8: 'static', 0xb9: 'interface' };
          mnemonic = `invoke${kinds[opcode]}`;
          callEffects.push({
            cpIndex: methIdx,
            dispatchKind: kinds[opcode],
          });
        }
        break;

      case 0xbb: // new
        {
          const classIdx = view.getUint16(pc, false);
          pc += 2;
          mnemonic = 'new';
          producedValues.push({ bits: 64, cpClassIndex: classIdx });
          currentStackHeight++;
        }
        break;

      case 0xbf: // athrow
        mnemonic = 'athrow';
        consumedValues.push({ id: 'exception' });
        controlEffects.push({ kind: 'throw' });
        currentStackHeight--;
        break;

      case 0xc0: // checkcast
      case 0xc1: // instanceof
        {
          const classIdx = view.getUint16(pc, false);
          pc += 2;
          mnemonic = opcode === 0xc0 ? 'checkcast' : 'instanceof';
          if (opcode === 0xc1) producedValues.push({ bits: 32 });
        }
        break;

      case 0xc2: // monitorenter
      case 0xc3: // monitorexit
        mnemonic = opcode === 0xc2 ? 'monitorenter' : 'monitorexit';
        consumedValues.push({ id: 'obj' });
        currentStackHeight--;
        break;

      default:
        mnemonic = `jvm_op_0x${opcode.toString(16)}`;
        completeness = 'partial';
        unknownEffects.push({ category: 'other', reason: `unsupported-jvm-opcode-0x${opcode.toString(16)}` });
        break;
    }

    bundles.push(createVMEffectBundle({
      schemaVersion: 1,
      contractVersion: '1.0.0',
      frontendId: 'jvm',
      frontendSemanticVersion: '1.0.0',
      profileId: jvmClass.vmSpecEdition,
      methodId,
      operationId: opId,
      bytecodeOffset: opOffset,
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
  }

  return createVMEffectFunction({
    methodId,
    profileId: jvmClass.vmSpecEdition,
    frontendId: 'jvm',
    bundles,
    entryState: {
      maxStack: codeAttr.maxStack,
      maxLocals: codeAttr.maxLocals,
    },
    exceptionRegions,
  }, options);
}
