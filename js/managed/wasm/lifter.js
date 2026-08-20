import { createOriginSet } from '../../core/identity/origin.js';
import { createManagedMethodId, createVMOperationId } from '../shared/identity.js';
import { createVMEffectBundle, createVMEffectFunction } from '../shared/vm-effects.js';
import { decodeSleb128, decodeSleb128_64, decodeUleb128 } from './parser.js';

function fail(code) { throw new TypeError(code); }

export function liftWasmFunction(funcIndex, wasmModule, options = {}) {
  const methodId = createManagedMethodId(wasmModule.moduleId, funcIndex);
  const importedFuncs = wasmModule.imports.filter((i) => i.desc.kind === 0);
  
  let typeIdx = null;
  let codeBody = null;

  if (funcIndex < importedFuncs.length) {
    // Imported function
    const imp = importedFuncs[funcIndex];
    typeIdx = imp.desc.typeIndex;
    const bundle = createVMEffectBundle({
      frontendId: 'wasm',
      methodId,
      operationId: createVMOperationId(methodId, 0),
      bytecodeOffset: 0,
      opcode: 0x10,
      mnemonic: 'host_import',
      callEffects: [{
        target: `${imp.module}.${imp.field}`,
        dispatchKind: 'host-import',
        unresolved: true,
      }],
      controlEffects: [{ kind: 'return' }],
      completeness: 'exact',
    });
    return createVMEffectFunction({
      methodId,
      frontendId: 'wasm',
      bundles: [bundle],
      aggregateCompleteness: 'exact',
    });
  }

  const internalIdx = funcIndex - importedFuncs.length;
  if (internalIdx >= wasmModule.functions.length || internalIdx >= wasmModule.codeBodies.length) {
    fail('wasm-invalid-function-index');
  }

  typeIdx = wasmModule.functions[internalIdx];
  codeBody = wasmModule.codeBodies[internalIdx];
  const funcType = wasmModule.types[typeIdx] || { params: [], results: [] };

  const bytecode = codeBody.bytecode;
  let pos = 0;
  let opSeq = 0;
  const bundles = [];

  const controlStack = [{
    kind: 'block',
    startOffset: 0,
    endOffset: null,
    stackHeight: 0,
    resultTypes: funcType.results,
  }];

  let currentStackHeight = 0;

  while (pos < bytecode.length) {
    const opOffset = pos;
    const opcode = bytecode[pos++];
    opSeq++;
    const opId = createVMOperationId(methodId, opOffset, opSeq);
    const origin = createOriginSet({
      operationIds: [opId],
      byteRanges: [{ start: codeBody.bodyOffset + opOffset, end: codeBody.bodyOffset + pos }],
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
      case 0x00: // unreachable
        mnemonic = 'unreachable';
        controlEffects.push({ kind: 'trap', reason: 'unreachable' });
        break;

      case 0x01: // nop
        mnemonic = 'nop';
        break;

      case 0x02: // block
      case 0x03: // loop
      case 0x04: // if
        {
          const blockType = bytecode[pos++];
          const kind = opcode === 0x02 ? 'block' : opcode === 0x03 ? 'loop' : 'if';
          mnemonic = kind;
          if (kind === 'if') {
            consumedValues.push({ id: 'cond', bits: 32 });
            currentStackHeight--;
          }
          controlStack.push({
            kind,
            startOffset: opOffset,
            stackHeight: currentStackHeight,
            resultTypes: blockType === 0x40 ? [] : [blockType],
          });
          if (kind === 'if') {
            controlEffects.push({ kind: 'conditional-branch' });
          }
        }
        break;

      case 0x05: // else
        mnemonic = 'else';
        controlEffects.push({ kind: 'branch' });
        break;

      case 0x0B: // end
        mnemonic = 'end';
        if (controlStack.length > 0) {
          const frame = controlStack.pop();
          frame.endOffset = opOffset;
        }
        if (controlStack.length === 0) {
          controlEffects.push({ kind: 'return' });
        }
        break;

      case 0x0C: // br
      case 0x0D: // br_if
        {
          const { value: labelIdx, nextOffset } = decodeUleb128(bytecode, pos);
          pos = nextOffset;
          mnemonic = opcode === 0x0C ? 'br' : 'br_if';
          if (labelIdx >= controlStack.length) fail('wasm-invalid-branch-depth');
          const targetFrame = controlStack[controlStack.length - 1 - labelIdx];
          const targetOffset = targetFrame.kind === 'loop' ? targetFrame.startOffset : (targetFrame.endOffset || null);

          if (opcode === 0x0D) {
            consumedValues.push({ id: 'cond', bits: 32 });
            currentStackHeight--;
            controlEffects.push({ kind: 'conditional-branch', targetOffset, labelIdx });
          } else {
            controlEffects.push({ kind: 'branch', targetOffset, labelIdx });
          }
        }
        break;

      case 0x0E: // br_table
        {
          const { value: count, nextOffset } = decodeUleb128(bytecode, pos);
          pos = nextOffset;
          const targets = [];
          for (let ti = 0; ti < count; ti++) {
            const { value: lbl, nextOffset: lOff } = decodeUleb128(bytecode, pos);
            pos = lOff;
            targets.push(lbl);
          }
          const { value: defaultLbl, nextOffset: dOff } = decodeUleb128(bytecode, pos);
          pos = dOff;
          mnemonic = 'br_table';
          consumedValues.push({ id: 'index', bits: 32 });
          currentStackHeight--;
          controlEffects.push({ kind: 'switch', targets, defaultTarget: defaultLbl });
        }
        break;

      case 0x0F: // return
        mnemonic = 'return';
        controlEffects.push({ kind: 'return' });
        break;

      case 0x10: // call
        {
          const { value: calleeIdx, nextOffset } = decodeUleb128(bytecode, pos);
          pos = nextOffset;
          mnemonic = 'call';
          callEffects.push({
            targetIndex: calleeIdx,
            target: `func_${calleeIdx}`,
            dispatchKind: 'direct',
          });
        }
        break;

      case 0x11: // call_indirect
        {
          const { value: typeIndex, nextOffset } = decodeUleb128(bytecode, pos);
          pos = nextOffset;
          const { value: tableIndex, nextOffset: tOff } = decodeUleb128(bytecode, pos);
          pos = tOff;
          mnemonic = 'call_indirect';
          consumedValues.push({ id: 'func_index', bits: 32 });
          currentStackHeight--;
          callEffects.push({
            typeIndex,
            tableIndex,
            dispatchKind: 'indirect',
            unresolved: true,
          });
        }
        break;

      case 0x1A: // drop
        mnemonic = 'drop';
        currentStackHeight--;
        break;

      case 0x1B: // select
        mnemonic = 'select';
        consumedValues.push({ id: 'cond', bits: 32 }, { id: 'val2' }, { id: 'val1' });
        producedValues.push({ bits: 32 });
        currentStackHeight -= 2;
        break;

      case 0x20: // local.get
        {
          const { value: localIdx, nextOffset } = decodeUleb128(bytecode, pos);
          pos = nextOffset;
          mnemonic = 'local.get';
          locationReads.push({ kind: 'local', index: localIdx, bits: 32 });
          producedValues.push({ bits: 32 });
          currentStackHeight++;
        }
        break;

      case 0x21: // local.set
      case 0x22: // local.tee
        {
          const { value: localIdx, nextOffset } = decodeUleb128(bytecode, pos);
          pos = nextOffset;
          mnemonic = opcode === 0x21 ? 'local.set' : 'local.tee';
          locationWrites.push({ kind: 'local', index: localIdx, bits: 32 });
          consumedValues.push({ id: `local_${localIdx}` });
          if (opcode === 0x21) {
            currentStackHeight--;
          }
        }
        break;

      case 0x23: // global.get
        {
          const { value: globalIdx, nextOffset } = decodeUleb128(bytecode, pos);
          pos = nextOffset;
          mnemonic = 'global.get';
          locationReads.push({ kind: 'global', index: globalIdx, bits: 32 });
          producedValues.push({ bits: 32 });
          currentStackHeight++;
        }
        break;

      case 0x24: // global.set
        {
          const { value: globalIdx, nextOffset } = decodeUleb128(bytecode, pos);
          pos = nextOffset;
          mnemonic = 'global.set';
          locationWrites.push({ kind: 'global', index: globalIdx, bits: 32 });
          consumedValues.push({ id: `global_${globalIdx}` });
          currentStackHeight--;
        }
        break;

      // Memory loads: i32.load (0x28), i64.load (0x29), f32.load (0x2A), f64.load (0x2B), i32.load8_s (0x2C), i32.load8_u (0x2D), i32.load16_s (0x2E), i32.load16_u (0x2F)
      case 0x28: case 0x29: case 0x2A: case 0x2B: case 0x2C: case 0x2D: case 0x2E: case 0x2F:
        {
          const { value: align, nextOffset } = decodeUleb128(bytecode, pos);
          pos = nextOffset;
          const { value: memOffset, nextOffset: mOff } = decodeUleb128(bytecode, pos);
          pos = mOff;
          const bits = (opcode === 0x29 || opcode === 0x2B) ? 64 : 32;
          const byteWidth = opcode === 0x2C || opcode === 0x2D ? 1 : opcode === 0x2E || opcode === 0x2F ? 2 : bits / 8;
          mnemonic = opcode === 0x28 ? 'i32.load' : opcode === 0x29 ? 'i64.load' : opcode === 0x2A ? 'f32.load' : opcode === 0x2B ? 'f64.load' : 'load';
          consumedValues.push({ id: 'addr', bits: 32 });
          producedValues.push({ bits });
          memoryEffects.push({
            space: 'linear-memory',
            byteWidth,
            offset: memOffset,
            align,
            isWrite: false,
          });
        }
        break;

      // Memory stores: i32.store (0x36), i64.store (0x37), f32.store (0x38), f64.store (0x39), i32.store8 (0x3A), i32.store16 (0x3B)
      case 0x36: case 0x37: case 0x38: case 0x39: case 0x3A: case 0x3B:
        {
          const { value: align, nextOffset } = decodeUleb128(bytecode, pos);
          pos = nextOffset;
          const { value: memOffset, nextOffset: mOff } = decodeUleb128(bytecode, pos);
          pos = mOff;
          const bits = (opcode === 0x37 || opcode === 0x39) ? 64 : 32;
          const byteWidth = opcode === 0x3A ? 1 : opcode === 0x3B ? 2 : bits / 8;
          mnemonic = opcode === 0x36 ? 'i32.store' : opcode === 0x37 ? 'i64.store' : 'store';
          consumedValues.push({ id: 'val', bits }, { id: 'addr', bits: 32 });
          currentStackHeight -= 2;
          memoryEffects.push({
            space: 'linear-memory',
            byteWidth,
            offset: memOffset,
            align,
            isWrite: true,
          });
        }
        break;

      case 0x41: // i32.const
        {
          const { value: val, nextOffset } = decodeSleb128(bytecode, pos);
          pos = nextOffset;
          mnemonic = 'i32.const';
          producedValues.push({ bits: 32, constant: val });
          currentStackHeight++;
        }
        break;

      case 0x42: // i64.const
        {
          const { value: val, nextOffset } = decodeSleb128_64(bytecode, pos);
          pos = nextOffset;
          mnemonic = 'i64.const';
          producedValues.push({ bits: 64, constant: val });
          currentStackHeight++;
        }
        break;

      // i32 numeric binops: add (0x6A), sub (0x6B), mul (0x6C), div_s (0x6D), div_u (0x6E), and (0x71), or (0x72), xor (0x73), shl (0x74), shr_s (0x75), shr_u (0x76)
      case 0x6A: case 0x6B: case 0x6C: case 0x6D: case 0x6E: case 0x71: case 0x72: case 0x73: case 0x74: case 0x75: case 0x76:
        {
          const names = {
            0x6A: 'i32.add', 0x6B: 'i32.sub', 0x6C: 'i32.mul', 0x6D: 'i32.div_s', 0x6E: 'i32.div_u',
            0x71: 'i32.and', 0x72: 'i32.or', 0x73: 'i32.xor', 0x74: 'i32.shl', 0x75: 'i32.shr_s', 0x76: 'i32.shr_u',
          };
          mnemonic = names[opcode] || 'i32.binop';
          consumedValues.push({ id: 'rhs', bits: 32 }, { id: 'lhs', bits: 32 });
          producedValues.push({ bits: 32 });
          currentStackHeight--;
        }
        break;

      // i32 comparisons: eqz (0x45), eq (0x46), ne (0x47), lt_s (0x48), lt_u (0x49), gt_s (0x4A), gt_u (0x4B), le_s (0x4C), le_u (0x4D)
      case 0x45: case 0x46: case 0x47: case 0x48: case 0x49: case 0x4A: case 0x4B: case 0x4C: case 0x4D:
        {
          mnemonic = opcode === 0x45 ? 'i32.eqz' : 'i32.cmp';
          if (opcode === 0x45) {
            consumedValues.push({ id: 'val', bits: 32 });
          } else {
            consumedValues.push({ id: 'rhs', bits: 32 }, { id: 'lhs', bits: 32 });
            currentStackHeight--;
          }
          producedValues.push({ bits: 32 });
        }
        break;

      // i64 numeric binops (0x7C add, 0x7D sub, 0x7E mul)
      case 0x7C: case 0x7D: case 0x7E:
        mnemonic = opcode === 0x7C ? 'i64.add' : opcode === 0x7D ? 'i64.sub' : 'i64.mul';
        consumedValues.push({ id: 'rhs', bits: 64 }, { id: 'lhs', bits: 64 });
        producedValues.push({ bits: 64 });
        currentStackHeight--;
        break;

      default:
        mnemonic = `wasm_op_0x${opcode.toString(16)}`;
        completeness = 'partial';
        unknownEffects.push({ category: 'other', reason: `unsupported-opcode-0x${opcode.toString(16)}` });
        break;
    }

    bundles.push(createVMEffectBundle({
      schemaVersion: 1,
      contractVersion: '1.0.0',
      frontendId: 'wasm',
      frontendSemanticVersion: '1.0.0',
      profileId: wasmModule.vmSpecEdition,
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
    profileId: wasmModule.vmSpecEdition,
    frontendId: 'wasm',
    bundles,
    entryState: {
      params: funcType.params,
      locals: codeBody.locals,
    },
    exceptionRegions: [],
  }, options);
}
