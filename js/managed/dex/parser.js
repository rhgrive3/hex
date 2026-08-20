import { deepFreeze } from '../../core/identity/index.js';
import { createManagedImageId, createManagedModuleId } from '../shared/identity.js';

function fail(code) { throw new TypeError(code); }

export function probeDex(bytes) {
  if (!bytes || bytes.length < 40) return { supported: false, confidence: 0, reason: 'too-small' };
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (u8[0] === 0x64 && u8[1] === 0x65 && u8[2] === 0x78 && u8[3] === 0x0a) {
    const vStr = String.fromCharCode(u8[4], u8[5], u8[6]);
    return { supported: true, confidence: 1.0, formatVersion: `dex-${vStr}`, vmSpecEdition: `dalvik-dex-${vStr}` };
  }
  return { supported: false, confidence: 0, reason: 'invalid-magic' };
}

function readUleb128(bytes, offset) {
  let result = 0;
  let shift = 0;
  let pos = offset;
  let count = 0;
  while (pos < bytes.length && count < 5) {
    const byte = bytes[pos++];
    count++;
    result |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) {
      return { value: result >>> 0, nextOffset: pos };
    }
    shift += 7;
  }
  fail('dex-malformed-uleb128');
}

function readUleb128p1(bytes, offset) {
  const { value, nextOffset } = readUleb128(bytes, offset);
  return { value: value - 1, nextOffset };
}

function readSleb128(bytes, offset) {
  let result = 0;
  let shift = 0;
  let pos = offset;
  let count = 0;
  let byte = 0;
  while (pos < bytes.length && count < 5) {
    byte = bytes[pos++];
    count++;
    result |= (byte & 0x7f) << shift;
    shift += 7;
    if ((byte & 0x80) === 0) {
      if (shift < 32 && (byte & 0x40) !== 0) {
        result |= (~0 << shift);
      }
      return { value: result | 0, nextOffset: pos };
    }
  }
  fail('dex-malformed-sleb128');
}

function decodeMutf8(bytes, offset) {
  const { value: utf16Size, nextOffset } = readUleb128(bytes, offset);
  let pos = nextOffset;
  let chars = [];
  while (pos < bytes.length) {
    const b1 = bytes[pos++];
    if (b1 === 0) break;
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

export function parseDex(bytes, options = {}) {
  const probe = probeDex(bytes);
  if (!probe.supported) fail('dex-unsupported-binary');

  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const view = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);

  const fileSize = view.getUint32(32, true);
  if (fileSize > u8.length) fail('dex-file-size-mismatch');

  const headerSize = view.getUint32(36, true);
  const stringIdsSize = view.getUint32(56, true);
  const stringIdsOff = view.getUint32(60, true);
  const typeIdsSize = view.getUint32(64, true);
  const typeIdsOff = view.getUint32(68, true);
  const protoIdsSize = view.getUint32(72, true);
  const protoIdsOff = view.getUint32(76, true);
  const fieldIdsSize = view.getUint32(80, true);
  const fieldIdsOff = view.getUint32(84, true);
  const methodIdsSize = view.getUint32(88, true);
  const methodIdsOff = view.getUint32(92, true);
  const classDefsSize = view.getUint32(96, true);
  const classDefsOff = view.getUint32(100, true);

  // 1. Strings
  const strings = [];
  for (let i = 0; i < stringIdsSize; i++) {
    const off = stringIdsOff + i * 4;
    if (off + 4 > u8.length) fail('dex-truncated-string-ids');
    const dataOff = view.getUint32(off, true);
    if (dataOff >= u8.length) fail('dex-invalid-string-data-offset');
    strings.push(decodeMutf8(u8, dataOff));
  }

  // 2. Types
  const types = [];
  for (let i = 0; i < typeIdsSize; i++) {
    const off = typeIdsOff + i * 4;
    if (off + 4 > u8.length) fail('dex-truncated-type-ids');
    const descriptorIdx = view.getUint32(off, true);
    if (descriptorIdx >= strings.length) fail('dex-invalid-type-descriptor-index');
    types.push(strings[descriptorIdx]);
  }

  // 3. Protos
  const protos = [];
  for (let i = 0; i < protoIdsSize; i++) {
    const off = protoIdsOff + i * 12;
    if (off + 12 > u8.length) fail('dex-truncated-proto-ids');
    const shortyIdx = view.getUint32(off, true);
    const returnTypeIdx = view.getUint32(off + 4, true);
    const paramsOff = view.getUint32(off + 8, true);

    const params = [];
    if (paramsOff > 0 && paramsOff + 4 <= u8.length) {
      const pSize = view.getUint32(paramsOff, true);
      for (let p = 0; p < pSize; p++) {
        const tIdx = view.getUint16(paramsOff + 4 + p * 2, true);
        if (tIdx < types.length) params.push(types[tIdx]);
      }
    }
    protos.push({
      shorty: strings[shortyIdx] || '',
      returnType: types[returnTypeIdx] || 'V',
      params,
    });
  }

  // 4. Fields
  const fields = [];
  for (let i = 0; i < fieldIdsSize; i++) {
    const off = fieldIdsOff + i * 8;
    if (off + 8 > u8.length) fail('dex-truncated-field-ids');
    const classIdx = view.getUint16(off, true);
    const typeIdx = view.getUint16(off + 2, true);
    const nameIdx = view.getUint32(off + 4, true);
    fields.push({
      classType: types[classIdx] || '',
      type: types[typeIdx] || '',
      name: strings[nameIdx] || '',
    });
  }

  // 5. Methods
  const methods = [];
  for (let i = 0; i < methodIdsSize; i++) {
    const off = methodIdsOff + i * 8;
    if (off + 8 > u8.length) fail('dex-truncated-method-ids');
    const classIdx = view.getUint16(off, true);
    const protoIdx = view.getUint16(off + 2, true);
    const nameIdx = view.getUint32(off + 4, true);
    methods.push({
      classType: types[classIdx] || '',
      proto: protos[protoIdx] || { returnType: 'V', params: [] },
      name: strings[nameIdx] || '',
    });
  }

  // 6. Class definitions and methods
  const classes = [];
  for (let i = 0; i < classDefsSize; i++) {
    const off = classDefsOff + i * 32;
    if (off + 32 > u8.length) fail('dex-truncated-class-defs');
    const classIdx = view.getUint32(off, true);
    const accessFlags = view.getUint32(off + 4, true);
    const superclassIdx = view.getUint32(off + 8, true);
    const interfacesOff = view.getUint32(off + 12, true);
    const sourceFileIdx = view.getUint32(off + 16, true);
    const annotationsOff = view.getUint32(off + 20, true);
    const classDataOff = view.getUint32(off + 24, true);

    const directMethods = [];
    const virtualMethods = [];

    if (classDataOff > 0 && classDataOff < u8.length) {
      let cPos = classDataOff;
      const { value: staticFieldsSize, nextOffset: sOff } = readUleb128(u8, cPos);
      const { value: instanceFieldsSize, nextOffset: iOff } = readUleb128(u8, sOff);
      const { value: directMethodsSize, nextOffset: dOff } = readUleb128(u8, iOff);
      const { value: virtualMethodsSize, nextOffset: vOff } = readUleb128(u8, dOff);
      cPos = vOff;

      // skip static & instance fields
      for (let f = 0; f < staticFieldsSize + instanceFieldsSize; f++) {
        const { nextOffset: f1 } = readUleb128(u8, cPos);
        const { nextOffset: f2 } = readUleb128(u8, f1);
        cPos = f2;
      }

      // direct methods
      let lastMethodIdx = 0;
      for (let m = 0; m < directMethodsSize; m++) {
        const { value: methodIdxDelta, nextOffset: m1 } = readUleb128(u8, cPos);
        const { value: mFlags, nextOffset: m2 } = readUleb128(u8, m1);
        const { value: codeOff, nextOffset: m3 } = readUleb128(u8, m2);
        cPos = m3;
        lastMethodIdx += methodIdxDelta;
        directMethods.push({ methodIdx: lastMethodIdx, accessFlags: mFlags, codeOff });
      }

      // virtual methods
      lastMethodIdx = 0;
      for (let m = 0; m < virtualMethodsSize; m++) {
        const { value: methodIdxDelta, nextOffset: m1 } = readUleb128(u8, cPos);
        const { value: mFlags, nextOffset: m2 } = readUleb128(u8, m1);
        const { value: codeOff, nextOffset: m3 } = readUleb128(u8, m2);
        cPos = m3;
        lastMethodIdx += methodIdxDelta;
        virtualMethods.push({ methodIdx: lastMethodIdx, accessFlags: mFlags, codeOff });
      }
    }

    classes.push({
      classType: types[classIdx] || `Class_${i}`,
      accessFlags,
      superType: superclassIdx !== 0xffffffff ? (types[superclassIdx] || 'Ljava/lang/Object;') : null,
      sourceFile: sourceFileIdx !== 0xffffffff ? strings[sourceFileIdx] : null,
      directMethods,
      virtualMethods,
    });
  }

  const binaryId = options.binaryId || 'dex-binary';
  const imageId = createManagedImageId(binaryId);
  const moduleId = createManagedModuleId(imageId, 'classes.dex');

  return deepFreeze({
    imageId,
    moduleId,
    formatVersion: probe.formatVersion,
    vmSpecEdition: probe.vmSpecEdition,
    strings,
    types,
    protos,
    fields,
    methods,
    classes,
    rawBytes: u8,
  });
}
