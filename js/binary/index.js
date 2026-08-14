import { detectBinary } from './detect.js';
import { parseMachO } from './macho.js';
import { parseELF } from './elf.js';
import { parsePE } from './pe.js';
import { scanStrings } from './strings.js';

export { BinaryImage, functionSeed, mergeFunctionSeeds } from './model.js';
export { ByteView, BinaryReadError, hex } from './reader.js';
export {
  ByteSource, ByteSourceError, ByteSourceRangeError, ByteSourceLimitError,
  MemoryByteSource, BlobByteSource, SubrangeByteSource,
  asByteSource, readExactly, safeNumber,
} from './source.js';
export { openBinarySource, parseMachOSource, parseELFSource, parsePESource } from './source-loaders.js';
export { detectBinary } from './detect.js';
export { parseMachO } from './macho.js';
export { parseELF } from './elf.js';
export { parsePE } from './pe.js';
export { scanStrings } from './strings.js';
export { auditBinary, capabilitiesOf } from './audit.js';
export { fnv1a64, fingerprintBytes, fingerprintFunction, fingerprintImage } from './fingerprint.js';

export function openBinary(input, opts = {}) {
  const detected = detectBinary(input);
  let image;
  if (detected.format === 'macho') image = parseMachO(input, opts);
  else if (detected.format === 'elf') image = parseELF(input, opts);
  else if (detected.format === 'pe') image = parsePE(input, opts);
  else throw new Error('対応していない実行ファイル形式です（Mach-O / ELF / PE を判定できませんでした）。');
  if (opts.strings) image.strings = scanStrings(image, typeof opts.strings === 'object' ? opts.strings : {});
  return image;
}
