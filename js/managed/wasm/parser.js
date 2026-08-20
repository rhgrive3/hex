import { deepFreeze } from '../../core/identity/index.js';
import { createManagedImageId, createManagedModuleId } from '../shared/identity.js';

function fail(code) { throw new TypeError(code); }

export function probeWasm(bytes) {
  if (!bytes || bytes.length < 8) return { supported: false, confidence: 0, reason: 'too-small' };
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (u8[0] === 0x00 && u8[1] === 0x61 && u8[2] === 0x73 && u8[3] === 0x6d) {
    const version = u8[4] | (u8[5] << 8) | (u8[6] << 16) | (u8[7] << 24);
    if (version === 1) {
      return { supported: true, confidence: 1.0, formatVersion: '1', vmSpecEdition: 'core-3.0' };
    }
    return { supported: true, confidence: 0.8, formatVersion: String(version), vmSpecEdition: 'unknown' };
  }
  return { supported: false, confidence: 0, reason: 'invalid-magic' };
}

export function decodeUleb128(bytes, offset, maxBytes = 5) {
  let result = 0;
  let shift = 0;
  let pos = offset;
  let count = 0;
  while (pos < bytes.length && count < maxBytes) {
    const byte = bytes[pos++];
    count++;
    result |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) {
      return { value: result >>> 0, nextOffset: pos };
    }
    shift += 7;
  }
  fail('wasm-malformed-uleb128');
}

export function decodeSleb128(bytes, offset, maxBytes = 5) {
  let result = 0;
  let shift = 0;
  let pos = offset;
  let count = 0;
  let byte = 0;
  while (pos < bytes.length && count < maxBytes) {
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
  fail('wasm-malformed-sleb128');
}

export function decodeSleb128_64(bytes, offset) {
  let result = 0n;
  let shift = 0n;
  let pos = offset;
  let count = 0;
  let byte = 0;
  while (pos < bytes.length && count < 10) {
    byte = bytes[pos++];
    count++;
    result |= BigInt(byte & 0x7f) << shift;
    shift += 7n;
    if ((byte & 0x80) === 0) {
      if (shift < 64n && (byte & 0x40) !== 0) {
        result |= (~0n << shift);
      }
      return { value: BigInt.asIntN(64, result), nextOffset: pos };
    }
  }
  fail('wasm-malformed-sleb128-64');
}

export function decodeName(bytes, offset) {
  const { value: len, nextOffset } = decodeUleb128(bytes, offset);
  if (nextOffset + len > bytes.length) fail('wasm-truncated-name');
  const nameBytes = bytes.subarray(nextOffset, nextOffset + len);
  const name = new TextDecoder('utf-8', { fatal: true }).decode(nameBytes);
  return { name, nextOffset: nextOffset + len };
}

export function parseWasm(bytes, options = {}) {
  const probe = probeWasm(bytes);
  if (!probe.supported) fail('wasm-unsupported-binary');

  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let pos = 8; // skip magic (4) and version (4)
  const sections = [];
  const types = [];
  const imports = [];
  const functions = [];
  const tables = [];
  const memories = [];
  const globals = [];
  const exports = [];
  let startFunction = null;
  const elements = [];
  const codeBodies = [];
  const dataSegments = [];
  const customSections = [];

  while (pos < u8.length) {
    if (pos + 1 > u8.length) fail('wasm-truncated-section-id');
    const sectionId = u8[pos++];
    const { value: sectionSize, nextOffset: dataStart } = decodeUleb128(u8, pos);
    pos = dataStart;
    if (pos + sectionSize > u8.length) fail('wasm-truncated-section-payload');
    const sectionEnd = pos + sectionSize;
    const sectionBytes = u8.subarray(pos, sectionEnd);

    sections.push({
      id: sectionId,
      offset: pos - 1,
      size: sectionSize,
    });

    let secPos = 0;
    if (sectionId === 0) {
      // Custom
      try {
        const { name, nextOffset } = decodeName(sectionBytes, 0);
        customSections.push({ name, data: sectionBytes.subarray(nextOffset) });
      } catch {
        // preserve as unnamed custom
        customSections.push({ name: 'unknown', data: sectionBytes });
      }
    } else if (sectionId === 1) {
      // Type
      const { value: count, nextOffset } = decodeUleb128(sectionBytes, secPos);
      secPos = nextOffset;
      for (let i = 0; i < count; i++) {
        if (secPos >= sectionBytes.length) fail('wasm-malformed-type-section');
        const form = sectionBytes[secPos++];
        if (form !== 0x60) fail('wasm-unsupported-type-form');
        const { value: paramCount, nextOffset: pOff } = decodeUleb128(sectionBytes, secPos);
        secPos = pOff;
        const params = [];
        for (let p = 0; p < paramCount; p++) {
          params.push(sectionBytes[secPos++]);
        }
        const { value: retCount, nextOffset: rOff } = decodeUleb128(sectionBytes, secPos);
        secPos = rOff;
        const results = [];
        for (let r = 0; r < retCount; r++) {
          results.push(sectionBytes[secPos++]);
        }
        types.push({ params, results });
      }
    } else if (sectionId === 2) {
      // Import
      const { value: count, nextOffset } = decodeUleb128(sectionBytes, secPos);
      secPos = nextOffset;
      for (let i = 0; i < count; i++) {
        const { name: modName, nextOffset: mOff } = decodeName(sectionBytes, secPos);
        const { name: fieldName, nextOffset: fOff } = decodeName(sectionBytes, mOff);
        secPos = fOff;
        const kind = sectionBytes[secPos++];
        let desc = { kind };
        if (kind === 0) {
          const { value: typeIndex, nextOffset: tOff } = decodeUleb128(sectionBytes, secPos);
          secPos = tOff;
          desc.typeIndex = typeIndex;
        } else if (kind === 1) {
          // table
          secPos++; // elemtype
          const flags = sectionBytes[secPos++];
          const { value: min, nextOffset: minOff } = decodeUleb128(sectionBytes, secPos);
          secPos = minOff;
          desc.min = min;
          if (flags & 1) {
            const { value: max, nextOffset: maxOff } = decodeUleb128(sectionBytes, secPos);
            secPos = maxOff;
            desc.max = max;
          }
        } else if (kind === 2) {
          // memory
          const flags = sectionBytes[secPos++];
          const { value: min, nextOffset: minOff } = decodeUleb128(sectionBytes, secPos);
          secPos = minOff;
          desc.min = min;
          if (flags & 1) {
            const { value: max, nextOffset: maxOff } = decodeUleb128(sectionBytes, secPos);
            secPos = maxOff;
            desc.max = max;
          }
        } else if (kind === 3) {
          // global
          const valType = sectionBytes[secPos++];
          const mutability = sectionBytes[secPos++];
          desc.valType = valType;
          desc.mutable = mutability === 1;
        }
        imports.push({ module: modName, field: fieldName, desc });
      }
    } else if (sectionId === 3) {
      // Function
      const { value: count, nextOffset } = decodeUleb128(sectionBytes, secPos);
      secPos = nextOffset;
      for (let i = 0; i < count; i++) {
        const { value: typeIdx, nextOffset: tOff } = decodeUleb128(sectionBytes, secPos);
        secPos = tOff;
        functions.push(typeIdx);
      }
    } else if (sectionId === 7) {
      // Export
      const { value: count, nextOffset } = decodeUleb128(sectionBytes, secPos);
      secPos = nextOffset;
      for (let i = 0; i < count; i++) {
        const { name, nextOffset: nOff } = decodeName(sectionBytes, secPos);
        secPos = nOff;
        const kind = sectionBytes[secPos++];
        const { value: index, nextOffset: iOff } = decodeUleb128(sectionBytes, secPos);
        secPos = iOff;
        exports.push({ name, kind, index });
      }
    } else if (sectionId === 10) {
      // Code
      const { value: count, nextOffset } = decodeUleb128(sectionBytes, secPos);
      secPos = nextOffset;
      for (let i = 0; i < count; i++) {
        const bodyOffset = pos + secPos;
        const { value: bodySize, nextOffset: bOff } = decodeUleb128(sectionBytes, secPos);
        secPos = bOff;
        const bodyBytes = sectionBytes.subarray(secPos, secPos + bodySize);
        secPos += bodySize;

        let bPos = 0;
        const { value: localGroupCount, nextOffset: lOff } = decodeUleb128(bodyBytes, bPos);
        bPos = lOff;
        const locals = [];
        for (let lg = 0; lg < localGroupCount; lg++) {
          const { value: count, nextOffset: cOff } = decodeUleb128(bodyBytes, bPos);
          bPos = cOff;
          const type = bodyBytes[bPos++];
          for (let c = 0; c < count; c++) locals.push(type);
        }
        const codeStart = bPos;
        const bytecode = bodyBytes.subarray(codeStart);
        codeBodies.push({
          bodyOffset,
          bodySize,
          locals,
          bytecode,
          rawBytes: bodyBytes,
        });
      }
    }

    pos = sectionEnd;
  }

  const binaryId = options.binaryId || 'wasm-binary';
  const imageId = createManagedImageId(binaryId);
  const moduleId = createManagedModuleId(imageId, 'main');

  return deepFreeze({
    imageId,
    moduleId,
    formatVersion: '1',
    vmSpecEdition: 'core-3.0',
    sections,
    types,
    imports,
    functions,
    tables,
    memories,
    globals,
    exports,
    startFunction,
    elements,
    codeBodies,
    dataSegments,
    customSections,
    rawBytes: u8,
  });
}
