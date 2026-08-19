import { ByteView } from './reader.js';
import { BinaryImage, functionSeed } from './model.js';
import { parseImports, parseExports, parseExceptionFunctions, parseBaseRelocations, parseCoffSymbols, parseDelayImports, parseTlsDirectory, parseLoadConfig, resolveCoffSectionName, directory, peMachineName, createPEMetadataBudget } from './pe-loader.js';

const IMAGE_DIRECTORY_ENTRY_EXPORT = 0;
const IMAGE_DIRECTORY_ENTRY_IMPORT = 1;
const IMAGE_DIRECTORY_ENTRY_EXCEPTION = 3;
const IMAGE_DIRECTORY_ENTRY_BASERELOC = 5;
const IMAGE_DIRECTORY_ENTRY_TLS = 9;
const IMAGE_DIRECTORY_ENTRY_LOAD_CONFIG = 10;
const IMAGE_DIRECTORY_ENTRY_DELAY_IMPORT = 13;

function seedValidatedEntrypoint(image, entryRva, sizeOfImage, machine) {
  const address = image.imageBase + BigInt(entryRva);
  const reject = (reason) => {
    image.warnings.push(`PE entrypoint 0x${entryRva.toString(16)} rejected: ${reason}`);
    image.metadata.entrypointValid = false;
    image.metadata.entrypointDiagnostic = reason;
  };
  if (entryRva >= sizeOfImage) { reject('RVA is outside SizeOfImage'); return; }
  const segment = image.segments.find((s) => s.source === 'PE-section' &&
    address >= s.address && address < s.address + s.size);
  if (!segment) { reject('RVA is not mapped by a section'); return; }
  if (!segment.perms?.execute) { reject('section is not executable'); return; }
  const offset = address - segment.address;
  if (offset < 0n || offset >= segment.fileSize) { reject('entrypoint has no file-backed instruction byte'); return; }
  const alignment = machine === 0xaa64 || machine === 0x01c0 || machine === 0x01c4 ? 4n : 1n;
  if (address % alignment !== 0n) { reject(`address is not ${alignment}-byte aligned`); return; }
  image.metadata.entrypointValid = true;
  image.metadata.entrypointDiagnostic = null;
  image.functions.push(functionSeed(address, { source: 'entrypoint', confidence: 0.9 }));
}

function reconcileExportFunctionEvidence(image) {
  const exportNames = new Map();
  for (const ex of image.exports || []) {
    if (!ex || ex.kind === 'forwarder' || ex.address == null || ex.address === 0n) continue;
    exportNames.set(BigInt(ex.address).toString(), ex.name || null);
  }
  let rejectedExportOnly = 0;
  image.functions = (image.functions || []).filter((f) => {
    if (f?.source !== 'export') return true;
    rejectedExportOnly++;
    return false;
  });
  let corroborated = 0;
  for (const f of image.functions) {
    if (f?.address == null) continue;
    const name = exportNames.get(BigInt(f.address).toString());
    if (!name) continue;
    corroborated++;
    if (!f.name) f.name = name;
    f.sources = [...new Set([...(f.sources || [f.source]), 'export-name'])];
  }
  image.metadata.peExportFunctionEvidence = {
    policy:'export-is-symbol-evidence-not-function-proof',
    rejectedExportOnly,
    corroborated,
  };
}

export function parsePE(input, options = {}) {
  const bytes = new ByteView(input).bytes;
  const r = new ByteView(bytes, { littleEndian: true });
  if (r.length < 0x40 || r.u16(0) !== 0x5a4d) throw new Error('not a PE file');
  const pe = r.u32(0x3c);
  if (pe + 24 > r.length || r.u32(pe) !== 0x00004550) throw new Error('invalid PE signature');
  const coff = pe + 4;
  const machine = r.u16(coff);
  const numberOfSections = r.u16(coff + 2);
  const timestamp = r.u32(coff + 4);
  const ptrSymbols = r.u32(coff + 8);
  const numberOfSymbols = r.u32(coff + 12);
  const sizeOptional = r.u16(coff + 16);
  const characteristics = r.u16(coff + 18);
  const opt = coff + 20;
  if (opt + sizeOptional > r.length) throw new Error('PE optional header is truncated');
  if (sizeOptional < 2) throw new Error('PE optional header is too small for its magic');
  const magic = r.u16(opt);
  if (magic !== 0x10b && magic !== 0x20b) throw new Error(`unsupported PE optional magic 0x${magic.toString(16)}`);
  const bits = magic === 0x20b ? 64 : 32;
  const minimumOptionalSize = bits === 64 ? 112 : 96;
  if (sizeOptional < minimumOptionalSize) throw new Error(`PE optional header size ${sizeOptional} is smaller than ${minimumOptionalSize}`);
  const entryRva = r.u32(opt + 16);
  const imageBase = bits === 64 ? r.u64(opt + 24) : BigInt(r.u32(opt + 28));
  const sectionAlignment = r.u32(opt + 32);
  const fileAlignment = r.u32(opt + 36);
  const sizeOfImage = r.u32(opt + 56);
  const sizeOfHeaders = r.u32(opt + 60);
  const subsystem = r.u16(opt + 68);
  const numberOfRvaAndSizes = r.u32(opt + (bits === 64 ? 108 : 92));
  const dirBase = opt + (bits === 64 ? 112 : 96);
  const directories = [];
  const dirCount = Math.min(numberOfRvaAndSizes, 16, Math.max(0, Math.floor((opt + sizeOptional - dirBase) / 8)));
  for (let i = 0; i < dirCount; i++) directories.push({ rva: r.u32(dirBase + i * 8), size: r.u32(dirBase + i * 8 + 4) });

  const image = new BinaryImage(bytes, {
    format: 'pe', arch: peMachineName(machine), bits, endian: 'little', platform: 'windows',
    imageBase, entrypoint: entryRva ? imageBase + BigInt(entryRva) : null,
    metadata: { machine, timestamp, characteristics, subsystem, sectionAlignment, fileAlignment, sizeOfImage, sizeOfHeaders, directories },
  });

  image.addSegment({ name: 'headers', address: imageBase, size: BigInt(sizeOfHeaders), fileOffset: 0n, fileSize: BigInt(Math.min(sizeOfHeaders, bytes.length)), perms: { read: true, write: false, execute: false }, source: 'PE-headers' });
  const secBase = opt + sizeOptional;
  if (numberOfSections > 4096 || secBase + numberOfSections * 40 > r.length) throw new Error('PE section table is invalid');
  for (let i = 0; i < numberOfSections; i++) {
    const p = secBase + i * 40;
    const name = resolveCoffSectionName(r, r.ascii(p, 8), ptrSymbols, numberOfSymbols);
    const virtualSize = r.u32(p + 8);
    const virtualAddress = r.u32(p + 12);
    const sizeRaw = r.u32(p + 16);
    const ptrRaw = r.u32(p + 20);
    const flags = r.u32(p + 36);
    const address = imageBase + BigInt(virtualAddress);
    const virtualExtent = BigInt(virtualSize || sizeRaw);
    const rawAvailable = BigInt(Math.min(sizeRaw, Math.max(0, bytes.length - ptrRaw)));
    const mappedFileSize = rawAvailable < virtualExtent ? rawAvailable : virtualExtent;
    const perms = { read: !!(flags & 0x40000000), write: !!(flags & 0x80000000), execute: !!(flags & 0x20000000) };
    image.addSegment({ name, address, size: virtualExtent, fileOffset: BigInt(ptrRaw), fileSize: mappedFileSize, perms, flags, source: 'PE-section' });
    image.addSection({ name, address, size: virtualExtent, fileOffset: BigInt(ptrRaw), fileSize: mappedFileSize, perms, flags, type: null, index: i + 1, source: 'PE-section' });
  }

  if (entryRva) seedValidatedEntrypoint(image, entryRva, sizeOfImage, machine);
  const metadataBudget = createPEMetadataBudget(image, { signal: options.signal, limits: options.metadataLimits });
  parseCoffSymbols(r, ptrSymbols, numberOfSymbols, image, metadataBudget);
  parseImports(r, directory(directories, IMAGE_DIRECTORY_ENTRY_IMPORT), image, metadataBudget);
  parseExports(r, directory(directories, IMAGE_DIRECTORY_ENTRY_EXPORT), image, metadataBudget);
  parseExceptionFunctions(r, directory(directories, IMAGE_DIRECTORY_ENTRY_EXCEPTION), image, machine, metadataBudget);
  parseBaseRelocations(r, directory(directories, IMAGE_DIRECTORY_ENTRY_BASERELOC), image, machine, metadataBudget);
  parseDelayImports(r, directory(directories, IMAGE_DIRECTORY_ENTRY_DELAY_IMPORT), image, metadataBudget);
  parseTlsDirectory(r, directory(directories, IMAGE_DIRECTORY_ENTRY_TLS), image, metadataBudget);
  parseLoadConfig(r, directory(directories, IMAGE_DIRECTORY_ENTRY_LOAD_CONFIG), image, metadataBudget);
  reconcileExportFunctionEvidence(image);
  return image.finalize();
}
