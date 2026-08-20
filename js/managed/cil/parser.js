import { deepFreeze } from '../../core/identity/index.js';
import { createManagedImageId, createManagedModuleId } from '../shared/identity.js';

function fail(code) { throw new TypeError(code); }

export function probeCil(bytes) {
  if (!bytes || bytes.length < 64) return { supported: false, confidence: 0, reason: 'too-small' };
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  
  // Direct metadata signature check: 'BSJB' (0x42534a42)
  for (let i = 0; i <= u8.length - 4; i += 4) {
    if (u8[i] === 0x42 && u8[i + 1] === 0x53 && u8[i + 2] === 0x4a && u8[i + 3] === 0x42) {
      return { supported: true, confidence: 1.0, formatVersion: 'cli-ecma-335', vmSpecEdition: 'clr-v4' };
    }
  }

  // DOS header 'MZ'
  if (u8[0] === 0x4d && u8[1] === 0x5a) {
    const view = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    const peOff = view.getUint32(0x3c, true);
    if (peOff + 4 <= u8.length && u8[peOff] === 0x50 && u8[peOff + 1] === 0x45) {
      return { supported: true, confidence: 0.9, formatVersion: 'pe-cli', vmSpecEdition: 'clr-v4' };
    }
  }

  return { supported: false, confidence: 0, reason: 'invalid-signature' };
}

export function readCompressedInt(bytes, offset) {
  if (offset >= bytes.length) fail('cil-truncated-compressed-int');
  const b0 = bytes[offset];
  if ((b0 & 0x80) === 0) {
    return { value: b0, nextOffset: offset + 1 };
  } else if ((b0 & 0xc0) === 0x80) {
    if (offset + 1 >= bytes.length) fail('cil-truncated-compressed-int');
    return { value: ((b0 & 0x3f) << 8) | bytes[offset + 1], nextOffset: offset + 2 };
  } else if ((b0 & 0xe0) === 0xc0) {
    if (offset + 3 >= bytes.length) fail('cil-truncated-compressed-int');
    return {
      value: ((b0 & 0x1f) << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3],
      nextOffset: offset + 4,
    };
  }
  fail('cil-invalid-compressed-int');
}

export function parseCil(bytes, options = {}) {
  const probe = probeCil(bytes);
  if (!probe.supported) fail('cil-unsupported-binary');

  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const view = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);

  // Find BSJB metadata root
  let bsjbOffset = -1;
  for (let i = 0; i <= u8.length - 4; i += 4) {
    if (u8[i] === 0x42 && u8[i + 1] === 0x53 && u8[i + 2] === 0x4a && u8[i + 3] === 0x42) {
      bsjbOffset = i;
      break;
    }
  }

  const types = [];
  const methods = [];
  const fields = [];
  const strings = [];
  let runtimeVersion = 'v4.0.30319';

  if (bsjbOffset >= 0 && bsjbOffset + 20 <= u8.length) {
    const vLen = view.getUint32(bsjbOffset + 12, true);
    if (bsjbOffset + 16 + vLen <= u8.length) {
      const vBytes = u8.subarray(bsjbOffset + 16, bsjbOffset + 16 + vLen);
      runtimeVersion = new TextDecoder('utf-8').decode(vBytes).replace(/\0+$/, '');
    }

    const flagsOff = bsjbOffset + 16 + vLen;
    if (flagsOff + 4 <= u8.length) {
      const streamCount = view.getUint16(flagsOff + 2, true);
      let sPos = flagsOff + 4;
      const streams = [];
      for (let s = 0; s < streamCount; s++) {
        if (sPos + 8 > u8.length) break;
        const sOffset = view.getUint32(sPos, true);
        const sSize = view.getUint32(sPos + 4, true);
        sPos += 8;
        let sName = '';
        while (sPos < u8.length && u8[sPos] !== 0) {
          sName += String.fromCharCode(u8[sPos++]);
        }
        sPos = (sPos + 4) & ~3; // 4-byte align
        streams.push({ name: sName, offset: bsjbOffset + sOffset, size: sSize });
      }

      const stringStream = streams.find((st) => st.name === '#Strings');
      if (stringStream && stringStream.offset + stringStream.size <= u8.length) {
        let p = stringStream.offset;
        const end = stringStream.offset + stringStream.size;
        while (p < end) {
          let str = '';
          while (p < end && u8[p] !== 0) {
            str += String.fromCharCode(u8[p++]);
          }
          p++; // skip null
          if (str) strings.push(str);
        }
      }
    }
  }

  // Scan method bodies after CLI metadata streams
  const methodBodies = [];
  const startScan = bsjbOffset >= 0 ? bsjbOffset + 0x60 : 0x100;
  for (let p = startScan; p <= u8.length - 4; p++) {
    const headerByte = u8[p];
    if ((headerByte & 0x03) === 0x02) {
      // Tiny header
      const codeSize = headerByte >> 2;
      if (codeSize > 0 && codeSize <= 63 && p + 1 + codeSize <= u8.length) {
        // Verify valid CIL opcodes inside
        const bytecode = u8.subarray(p + 1, p + 1 + codeSize);
        if (bytecode[bytecode.length - 1] === 0x2a || bytecode.some((b) => b === 0x2a)) { // contains ret
          methodBodies.push({
            headerOffset: p,
            isTiny: true,
            maxStack: 8,
            codeSize,
            bytecode,
            exceptionClauses: [],
          });
          p += codeSize;
        }
      }
    } else if ((headerByte & 0x0f) === 0x03 && p + 12 <= u8.length) {
      // Fat header (Flags: CorILMethod_FatFormat=0x03, Size=3 dwords=12 bytes)
      const flags = view.getUint16(p, true);
      const headerSize = (flags >> 12) * 4;
      const maxStack = view.getUint16(p + 2, true);
      const codeSize = view.getUint32(p + 4, true);
      const localVarSigTok = view.getUint32(p + 8, true);
      if (headerSize === 12 && codeSize > 0 && codeSize < 0x100000 && p + headerSize + codeSize <= u8.length) {
        const bytecode = u8.subarray(p + headerSize, p + headerSize + codeSize);
        const exceptionClauses = [];

        if (flags & 0x08) { // Extra data section (Exception handlers)
          let extraPos = (p + headerSize + codeSize + 3) & ~3;
          if (extraPos + 4 <= u8.length) {
            const kind = u8[extraPos];
            const dataSize = u8[extraPos + 1] | (u8[extraPos + 2] << 8);
            if ((kind & 0x01) && (kind & 0x40)) { // Fat exception header
              const clauseCount = (dataSize - 4) / 24;
              for (let c = 0; c < clauseCount; c++) {
                const cOff = extraPos + 4 + c * 24;
                if (cOff + 24 <= u8.length) {
                  const flags = view.getUint32(cOff, true);
                  const tryOffset = view.getUint32(cOff + 4, true);
                  const tryLength = view.getUint32(cOff + 8, true);
                  const handlerOffset = view.getUint32(cOff + 12, true);
                  const handlerLength = view.getUint32(cOff + 16, true);
                  const classTokenOrFilter = view.getUint32(cOff + 20, true);
                  exceptionClauses.push({
                    kind: flags === 1 ? 'filter' : flags === 2 ? 'finally' : flags === 4 ? 'fault' : 'catch',
                    tryOffset,
                    tryLength,
                    handlerOffset,
                    handlerLength,
                    classTokenOrFilter,
                  });
                }
              }
            } else if (kind & 0x01) { // Small exception header
              const clauseCount = (dataSize - 4) / 12;
              for (let c = 0; c < clauseCount; c++) {
                const cOff = extraPos + 4 + c * 12;
                if (cOff + 12 <= u8.length) {
                  const flags = view.getUint16(cOff, true);
                  const tryOffset = view.getUint16(cOff + 2, true);
                  const tryLength = u8[cOff + 4];
                  const handlerOffset = view.getUint16(cOff + 5, true);
                  const handlerLength = u8[cOff + 7];
                  const classTokenOrFilter = view.getUint32(cOff + 8, true);
                  exceptionClauses.push({
                    kind: flags === 1 ? 'filter' : flags === 2 ? 'finally' : flags === 4 ? 'fault' : 'catch',
                    tryOffset,
                    tryLength,
                    handlerOffset,
                    handlerLength,
                    classTokenOrFilter,
                  });
                }
              }
            }
          }
        }

        methodBodies.push({
          headerOffset: p,
          isTiny: false,
          maxStack,
          codeSize,
          localVarSigTok,
          bytecode,
          exceptionClauses,
        });
        p += headerSize + codeSize;
      }
    }
  }

  const binaryId = options.binaryId || 'cil-binary';
  const imageId = createManagedImageId(binaryId);
  const moduleId = createManagedModuleId(imageId, 'Assembly.dll');

  return deepFreeze({
    imageId,
    moduleId,
    formatVersion: 'cli-ecma-335',
    vmSpecEdition: runtimeVersion,
    types,
    methods,
    fields,
    strings,
    methodBodies,
    rawBytes: u8,
  });
}
