import { deepFreeze } from '../../core/identity/index.js';
import { createManagedImageId, createManagedModuleId } from '../shared/identity.js';

function fail(code) { throw new TypeError(code); }

export function probeJvm(bytes) {
  if (!bytes || bytes.length < 10) return { supported: false, confidence: 0, reason: 'too-small' };
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (u8[0] === 0xca && u8[1] === 0xfe && u8[2] === 0xba && u8[3] === 0xbe) {
    const minor = (u8[4] << 8) | u8[5];
    const major = (u8[6] << 8) | u8[7];
    return { supported: true, confidence: 1.0, formatVersion: `class-${major}.${minor}`, vmSpecEdition: `java-se-${major >= 45 ? major - 44 : major}` };
  }
  return { supported: false, confidence: 0, reason: 'invalid-magic' };
}

function decodeMutf8(bytes) {
  let pos = 0;
  let chars = [];
  while (pos < bytes.length) {
    const b1 = bytes[pos++];
    if ((b1 & 0x80) === 0) {
      chars.push(String.fromCharCode(b1));
    } else if ((b1 & 0xe0) === 0xc0) {
      const b2 = bytes[pos++];
      chars.push(String.fromCharCode(((b1 & 0x1f) << 6) | (b2 & 0x3f)));
    } else if ((b1 & 0xf0) === 0xe0) {
      const b2 = bytes[pos++];
      const b3 = bytes[pos++];
      chars.push(String.fromCharCode(((b1 & 0x0f) << 12) | ((b2 & 0x3f) << 6) | (b3 & 0x3f)));
    }
  }
  return chars.join('');
}

export function parseJvm(bytes, options = {}) {
  const probe = probeJvm(bytes);
  if (!probe.supported) fail('jvm-unsupported-binary');

  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const view = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);

  const minorVersion = view.getUint16(4, false); // Big-endian
  const majorVersion = view.getUint16(6, false);
  const cpCount = view.getUint16(8, false);

  const constantPool = [null]; // 1-indexed
  let pos = 10;

  for (let i = 1; i < cpCount; i++) {
    if (pos >= u8.length) fail('jvm-truncated-constant-pool');
    const tag = u8[pos++];
    switch (tag) {
      case 1: // Utf8
        {
          const len = view.getUint16(pos, false);
          pos += 2;
          const strBytes = u8.subarray(pos, pos + len);
          pos += len;
          constantPool.push({ tag: 1, value: decodeMutf8(strBytes) });
        }
        break;

      case 3: // Integer
        {
          const val = view.getInt32(pos, false);
          pos += 4;
          constantPool.push({ tag: 3, value: val });
        }
        break;

      case 4: // Float
        {
          const val = view.getFloat32(pos, false);
          pos += 4;
          constantPool.push({ tag: 4, value: val });
        }
        break;

      case 5: // Long (takes 2 slots)
        {
          const val = view.getBigInt64(pos, false);
          pos += 8;
          constantPool.push({ tag: 5, value: val });
          constantPool.push(null);
          i++;
        }
        break;

      case 6: // Double (takes 2 slots)
        {
          const val = view.getFloat64(pos, false);
          pos += 8;
          constantPool.push({ tag: 6, value: val });
          constantPool.push(null);
          i++;
        }
        break;

      case 7: // Class
        {
          const nameIndex = view.getUint16(pos, false);
          pos += 2;
          constantPool.push({ tag: 7, nameIndex });
        }
        break;

      case 8: // String
        {
          const stringIndex = view.getUint16(pos, false);
          pos += 2;
          constantPool.push({ tag: 8, stringIndex });
        }
        break;

      case 9: // Fieldref
      case 10: // Methodref
      case 11: // InterfaceMethodref
        {
          const classIndex = view.getUint16(pos, false);
          const nameAndTypeIndex = view.getUint16(pos + 2, false);
          pos += 4;
          constantPool.push({ tag, classIndex, nameAndTypeIndex });
        }
        break;

      case 12: // NameAndType
        {
          const nameIndex = view.getUint16(pos, false);
          const descriptorIndex = view.getUint16(pos + 2, false);
          pos += 4;
          constantPool.push({ tag: 12, nameIndex, descriptorIndex });
        }
        break;

      case 15: // MethodHandle
        pos += 3;
        constantPool.push({ tag: 15 });
        break;

      case 16: // MethodType
        pos += 2;
        constantPool.push({ tag: 16 });
        break;

      case 17: // Dynamic
      case 18: // InvokeDynamic
        pos += 4;
        constantPool.push({ tag });
        break;

      case 19: // Module
      case 20: // Package
        pos += 2;
        constantPool.push({ tag });
        break;

      default:
        fail(`jvm-invalid-cp-tag-${tag}`);
    }
  }

  function getCpString(idx) {
    const entry = constantPool[idx];
    return entry && entry.tag === 1 ? entry.value : '';
  }

  function getCpClassName(idx) {
    const entry = constantPool[idx];
    return entry && entry.tag === 7 ? getCpString(entry.nameIndex) : '';
  }

  const accessFlags = view.getUint16(pos, false);
  const thisClassIdx = view.getUint16(pos + 2, false);
  const superClassIdx = view.getUint16(pos + 4, false);
  const interfacesCount = view.getUint16(pos + 6, false);
  pos += 8;

  const interfaces = [];
  for (let i = 0; i < interfacesCount; i++) {
    const ifaceIdx = view.getUint16(pos, false);
    pos += 2;
    interfaces.push(getCpClassName(ifaceIdx));
  }

  // Fields
  const fieldsCount = view.getUint16(pos, false);
  pos += 2;
  const fields = [];
  for (let i = 0; i < fieldsCount; i++) {
    const fFlags = view.getUint16(pos, false);
    const nameIdx = view.getUint16(pos + 2, false);
    const descIdx = view.getUint16(pos + 4, false);
    const attrCount = view.getUint16(pos + 6, false);
    pos += 8;
    for (let a = 0; a < attrCount; a++) {
      const aLen = view.getUint32(pos + 2, false);
      pos += 6 + aLen;
    }
    fields.push({
      accessFlags: fFlags,
      name: getCpString(nameIdx),
      descriptor: getCpString(descIdx),
    });
  }

  // Methods
  const methodsCount = view.getUint16(pos, false);
  pos += 2;
  const methods = [];
  for (let i = 0; i < methodsCount; i++) {
    const mFlags = view.getUint16(pos, false);
    const nameIdx = view.getUint16(pos + 2, false);
    const descIdx = view.getUint16(pos + 4, false);
    const attrCount = view.getUint16(pos + 6, false);
    pos += 8;

    let codeAttr = null;
    for (let a = 0; a < attrCount; a++) {
      const attrNameIdx = view.getUint16(pos, false);
      const attrLen = view.getUint32(pos + 2, false);
      const attrName = getCpString(attrNameIdx);
      const attrDataStart = pos + 6;
      pos += 6 + attrLen;

      if (attrName === 'Code') {
        const maxStack = view.getUint16(attrDataStart, false);
        const maxLocals = view.getUint16(attrDataStart + 2, false);
        const codeLength = view.getUint32(attrDataStart + 4, false);
        const bytecode = u8.subarray(attrDataStart + 8, attrDataStart + 8 + codeLength);
        let cPos = attrDataStart + 8 + codeLength;
        const excTableLength = view.getUint16(cPos, false);
        cPos += 2;

        const exceptionTable = [];
        for (let e = 0; e < excTableLength; e++) {
          const startPc = view.getUint16(cPos, false);
          const endPc = view.getUint16(cPos + 2, false);
          const handlerPc = view.getUint16(cPos + 4, false);
          const catchType = view.getUint16(cPos + 6, false);
          cPos += 8;
          exceptionTable.push({
            startPc,
            endPc,
            handlerPc,
            catchType: catchType !== 0 ? getCpClassName(catchType) : null,
          });
        }

        codeAttr = {
          maxStack,
          maxLocals,
          codeLength,
          bytecode,
          exceptionTable,
          offset: attrDataStart + 8,
        };
      }
    }

    methods.push({
      accessFlags: mFlags,
      name: getCpString(nameIdx),
      descriptor: getCpString(descIdx),
      code: codeAttr,
    });
  }

  const thisClassName = getCpClassName(thisClassIdx) || 'MainClass';
  const superClassName = getCpClassName(superClassIdx) || 'java/lang/Object';

  const binaryId = options.binaryId || 'jvm-binary';
  const imageId = createManagedImageId(binaryId);
  const moduleId = createManagedModuleId(imageId, `${thisClassName}.class`);

  return deepFreeze({
    imageId,
    moduleId,
    formatVersion: `class-${majorVersion}.${minorVersion}`,
    vmSpecEdition: probe.vmSpecEdition,
    thisClassName,
    superClassName,
    interfaces,
    accessFlags,
    constantPool,
    fields,
    methods,
    rawBytes: u8,
  });
}
