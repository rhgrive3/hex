import { ByteView } from './reader.js';

export const PT_GNU_PROPERTY = 0x6474e553;
export const NT_GNU_PROPERTY_TYPE_0 = 5;
export const GNU_PROPERTY_AARCH64_FEATURE_1_AND = 0xc0000000;
export const GNU_PROPERTY_AARCH64_FEATURE_1_BTI = 1;
export const GNU_PROPERTY_AARCH64_FEATURE_1_PAC = 2;

const EM_AARCH64 = 183;
const PN_XNUM = 0xffff;

function safeNumber(value) {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value >= 0 ? value : null;
  if (typeof value !== 'bigint' || value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  return Number(value);
}

function align(value, alignment) {
  return Math.ceil(value / alignment) * alignment;
}

function boundedSpan(offset, size, length) {
  return Number.isSafeInteger(offset) && Number.isSafeInteger(size)
    && offset >= 0 && size >= 0 && offset <= length && size <= length - offset;
}

function defaultResult(overrides = {}) {
  return Object.freeze({
    kind:'gnu-property-aarch64-feature-1',
    loaderPolicy:'feature-bit-absent',
    btiRequested:false,
    pacRequested:false,
    mappedPageGuarded:'unknown',
    mappedPageGuardedSource:'not-observed',
    evidence:Object.freeze([]),
    warnings:Object.freeze([]),
    ...overrides,
  });
}

/**
 * Parse only the bounded PT_GNU_PROPERTY / NT_GNU_PROPERTY_TYPE_0 data needed
 * for AArch64 FEATURE_1 evidence. This deliberately reports loader policy and
 * never upgrades it into actual mapped-page guarded state.
 */
export function parseAarch64GnuProperty(input, options = {}) {
  const bytes = input instanceof Uint8Array
    ? input
    : ArrayBuffer.isView(input)
      ? new Uint8Array(input.buffer, input.byteOffset, input.byteLength)
      : input instanceof ArrayBuffer
        ? new Uint8Array(input)
        : null;
  if (!bytes || bytes.byteLength < 64) return defaultResult({ loaderPolicy:'unavailable', btiRequested:null, pacRequested:null, warnings:Object.freeze(['ELF bytes unavailable or truncated']) });
  if (bytes[0] !== 0x7f || bytes[1] !== 0x45 || bytes[2] !== 0x4c || bytes[3] !== 0x46) {
    return defaultResult({ loaderPolicy:'not-elf', btiRequested:null, pacRequested:null });
  }
  const cls = bytes[4];
  const data = bytes[5];
  if ((cls !== 1 && cls !== 2) || (data !== 1 && data !== 2)) {
    return defaultResult({ loaderPolicy:'unsupported-elf-header', btiRequested:null, pacRequested:null });
  }
  const bits = cls === 2 ? 64 : 32;
  const littleEndian = data === 1;
  const r = new ByteView(bytes, { littleEndian });
  const machine = r.u16(18);
  if (machine !== EM_AARCH64) return defaultResult({ loaderPolicy:'not-aarch64', btiRequested:null, pacRequested:null });
  const phoff = bits === 64 ? r.u64(32) : BigInt(r.u32(28));
  const phentsize = bits === 64 ? r.u16(54) : r.u16(42);
  let phnum = bits === 64 ? r.u16(56) : r.u16(44);
  const phoffNumber = safeNumber(phoff);
  const minPh = bits === 64 ? 56 : 32;
  const warnings = [];
  if (phnum === PN_XNUM) {
    warnings.push('extended ELF program-header count is not re-read by the bounded GNU property parser');
    return defaultResult({ loaderPolicy:'unknown', btiRequested:null, pacRequested:null, warnings:Object.freeze(warnings) });
  }
  if (phoffNumber == null || phentsize < minPh || phnum > (options.maxProgramHeaders ?? 4096)
      || !boundedSpan(phoffNumber, phnum * phentsize, bytes.byteLength)) {
    warnings.push('ELF program-header table is unavailable or outside bounded input');
    return defaultResult({ loaderPolicy:'unknown', btiRequested:null, pacRequested:null, warnings:Object.freeze(warnings) });
  }

  const evidence = [];
  let featureBits = null;
  for (let index = 0; index < phnum; index++) {
    const p = phoffNumber + index * phentsize;
    const type = r.u32(p);
    if (type !== PT_GNU_PROPERTY) continue;
    const offset = safeNumber(bits === 64 ? r.u64(p + 8) : BigInt(r.u32(p + 4)));
    const filesz = safeNumber(bits === 64 ? r.u64(p + 32) : BigInt(r.u32(p + 16)));
    if (offset == null || filesz == null || filesz > (options.maxPropertyBytes ?? 1024 * 1024)
        || !boundedSpan(offset, filesz, bytes.byteLength)) {
      warnings.push(`PT_GNU_PROPERTY ${index} is outside bounded input`);
      continue;
    }
    const end = offset + filesz;
    let cursor = offset;
    while (cursor + 12 <= end) {
      const namesz = r.u32(cursor);
      const descsz = r.u32(cursor + 4);
      const noteType = r.u32(cursor + 8);
      const nameStart = cursor + 12;
      const descStart = align(nameStart + namesz, 4);
      const next = align(descStart + descsz, 4);
      if (!boundedSpan(nameStart, namesz, end) || !boundedSpan(descStart, descsz, end) || next <= cursor || next > end) {
        warnings.push(`malformed GNU property note at file offset ${cursor}`);
        break;
      }
      let name = '';
      for (let i = 0; i < namesz && nameStart + i < end; i++) {
        const byte = bytes[nameStart + i];
        if (byte === 0) break;
        name += String.fromCharCode(byte);
      }
      if (noteType === NT_GNU_PROPERTY_TYPE_0 && name === 'GNU') {
        const propertyAlignment = bits === 64 ? 8 : 4;
        let propertyCursor = descStart;
        const descEnd = descStart + descsz;
        while (propertyCursor + 8 <= descEnd) {
          const propertyType = r.u32(propertyCursor);
          const dataSize = r.u32(propertyCursor + 4);
          const dataStart = propertyCursor + 8;
          if (!boundedSpan(dataStart, dataSize, descEnd)) {
            warnings.push(`malformed GNU property payload at file offset ${propertyCursor}`);
            break;
          }
          if (propertyType === GNU_PROPERTY_AARCH64_FEATURE_1_AND && dataSize >= 4) {
            const value = r.u32(dataStart);
            featureBits = featureBits == null ? value : (featureBits & value);
            evidence.push(Object.freeze({
              source:'PT_GNU_PROPERTY',
              programHeaderIndex:index,
              noteType:NT_GNU_PROPERTY_TYPE_0,
              propertyType:GNU_PROPERTY_AARCH64_FEATURE_1_AND,
              fileOffset:propertyCursor,
              featureBits:value,
            }));
          }
          const advanced = align(dataStart + dataSize, propertyAlignment);
          if (advanced <= propertyCursor) break;
          propertyCursor = advanced;
        }
      }
      cursor = next;
    }
  }

  if (featureBits == null) {
    return defaultResult({
      loaderPolicy:'feature-bit-absent',
      btiRequested:false,
      pacRequested:false,
      evidence:Object.freeze(evidence),
      warnings:Object.freeze(warnings),
    });
  }
  const btiRequested = (featureBits & GNU_PROPERTY_AARCH64_FEATURE_1_BTI) !== 0;
  const pacRequested = (featureBits & GNU_PROPERTY_AARCH64_FEATURE_1_PAC) !== 0;
  return defaultResult({
    loaderPolicy:btiRequested ? 'bti-requested' : 'bti-not-requested',
    btiRequested,
    pacRequested,
    featureBits,
    evidence:Object.freeze(evidence),
    warnings:Object.freeze(warnings),
  });
}

export function attachAarch64GnuPropertyEvidence(image, input, options = {}) {
  if (!image || image.format !== 'elf' || image.arch !== 'arm64') return image;
  const property = parseAarch64GnuProperty(input, options);
  image.metadata = image.metadata || {};
  image.metadata.arm64Bti = property;
  for (const warning of property.warnings || []) image.warnings?.push?.(`AArch64 GNU property: ${warning}`);
  return image;
}
