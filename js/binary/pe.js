import { ByteView } from './reader.js';
import { BinaryImage, functionSeed } from './model.js';
import { parseImports, parseExports, parseExceptionFunctions, parseBaseRelocations, parseCoffSymbols, directory, peMachineName } from './pe-loader.js';

const IMAGE_DIRECTORY_ENTRY_EXPORT = 0;
const IMAGE_DIRECTORY_ENTRY_IMPORT = 1;
const IMAGE_DIRECTORY_ENTRY_EXCEPTION = 3;
const IMAGE_DIRECTORY_ENTRY_BASERELOC = 5;

export function parsePE(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
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
  const magic = r.u16(opt);
  if (magic !== 0x10b && magic !== 0x20b) throw new Error(`unsupported PE optional magic 0x${magic.toString(16)}`);
  const bits = magic === 0x20b ? 64 : 32;
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
    imageBase, entrypoint: imageBase + BigInt(entryRva),
    metadata: { machine, timestamp, characteristics, subsystem, sectionAlignment, fileAlignment, sizeOfImage, sizeOfHeaders, directories },
  });

  image.addSegment({ name: 'headers', address: imageBase, size: BigInt(sizeOfHeaders), fileOffset: 0n, fileSize: BigInt(Math.min(sizeOfHeaders, bytes.length)), perms: { read: true, write: false, execute: false }, source: 'PE-headers' });
  const secBase = opt + sizeOptional;
  if (numberOfSections > 4096 || secBase + numberOfSections * 40 > r.length) throw new Error('PE section table is invalid');
  for (let i = 0; i < numberOfSections; i++) {
    const p = secBase + i * 40;
    const name = r.ascii(p, 8);
    const virtualSize = r.u32(p + 8);
    const virtualAddress = r.u32(p + 12);
    const sizeRaw = r.u32(p + 16);
    const ptrRaw = r.u32(p + 20);
    const flags = r.u32(p + 36);
    const address = imageBase + BigInt(virtualAddress);
    const size = BigInt(Math.max(virtualSize, sizeRaw));
    const perms = { read: !!(flags & 0x40000000), write: !!(flags & 0x80000000), execute: !!(flags & 0x20000000) };
    image.addSegment({ name, address, size, fileOffset: BigInt(ptrRaw), fileSize: BigInt(Math.min(sizeRaw, Math.max(0, bytes.length - ptrRaw))), perms, flags, source: 'PE-section' });
    image.addSection({ name, address, size: BigInt(virtualSize || sizeRaw), fileOffset: BigInt(ptrRaw), fileSize: BigInt(sizeRaw), perms, flags, type: null, index: i + 1, source: 'PE-section' });
  }

  if (entryRva) image.functions.push(functionSeed(image.entrypoint, { source: 'entrypoint', confidence: 0.9 }));
  parseCoffSymbols(r, ptrSymbols, numberOfSymbols, image);
  parseImports(r, directory(directories, IMAGE_DIRECTORY_ENTRY_IMPORT), image);
  parseExports(r, directory(directories, IMAGE_DIRECTORY_ENTRY_EXPORT), image);
  parseExceptionFunctions(r, directory(directories, IMAGE_DIRECTORY_ENTRY_EXCEPTION), image, machine);
  parseBaseRelocations(r, directory(directories, IMAGE_DIRECTORY_ENTRY_BASERELOC), image);
  return image.finalize();
}
