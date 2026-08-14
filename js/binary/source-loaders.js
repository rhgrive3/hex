import { detectBinary } from './detect.js';
import { parseELF } from './elf.js';
import { parseMachO } from './macho.js';
import { parsePE } from './pe.js';
import { ByteView } from './reader.js';
import { asByteSource, ByteSourceLimitError } from './source.js';
import { parseSourceRanges } from './source-reader.js';

const FAT_KINDS = new Map([
  ['cafebabe', { bits: 32, littleEndian: false }],
  ['cafebabf', { bits: 64, littleEndian: false }],
  ['bebafeca', { bits: 32, littleEndian: true }],
  ['bfbafeca', { bits: 64, littleEndian: true }],
]);

export async function openBinarySource(input, opts = {}) {
  const sourceOptions = opts.source || {};
  const source = asByteSource(input, sourceOptions);
  const prefixLength = Number(source.size < 16n ? source.size : 16n);
  const prefix = await source.readExactly(0n, prefixLength);
  const detected = detectBinary(prefix);
  const rangeOptions = opts.ranges || {};
  if (opts.strings) {
    throw new ByteSourceLimitError('source-backed string scanning is not implemented; request file ranges explicitly instead');
  }
  if (detected.format === 'elf') return parseELFSource(source, opts, prefix, rangeOptions);
  if (detected.format === 'pe') return parsePESource(source, opts, prefix, rangeOptions);
  if (detected.format === 'macho') return parseMachOSource(source, opts, prefix, rangeOptions);
  throw new Error('対応していない実行ファイル形式です（Mach-O / ELF / PE を判定できませんでした）。');
}

export async function parseELFSource(input, opts = {}, prefix = null, rangeOptions = opts.ranges || {}) {
  const source = asByteSource(input, opts.source || {});
  const magic = prefix || await readPrefix(source);
  return parseSourceRanges(source, parseELF, {}, withInitial(magic, rangeOptions));
}

export async function parsePESource(input, opts = {}, prefix = null, rangeOptions = opts.ranges || {}) {
  const source = asByteSource(input, opts.source || {});
  const magic = prefix || await readPrefix(source);
  return parseSourceRanges(source, parsePE, {}, withInitial(magic, rangeOptions));
}

export async function parseMachOSource(input, opts = {}, prefix = null, rangeOptions = opts.ranges || {}) {
  const source = asByteSource(input, opts.source || {});
  const magic = prefix || await source.readExactly(0n, Number(source.size < 16n ? source.size : 16n));
  const fat = fatKind(magic);
  if (!fat) return parseSourceRanges(source, parseMachO, opts, withInitial(magic, rangeOptions));

  if (source.size < 8n) throw new Error('Mach-O universal header is truncated');
  const head = magic.byteLength >= 8 ? magic.subarray(0, 8) : await source.readExactly(0n, 8);
  const hr = new ByteView(head, { littleEndian: fat.littleEndian });
  const count = hr.u32(4);
  if (count > 128) throw new Error(`unreasonable Mach-O slice count ${count}`);
  const entrySize = fat.bits === 64 ? 32 : 20;
  const tableSize = count * entrySize;
  if (8n + BigInt(tableSize) > source.size) throw new Error('Mach-O universal slice table is truncated');
  const table = await source.readExactly(8n, tableSize);
  const r = new ByteView(table, { littleEndian: fat.littleEndian, base: 8 });
  const all = [];
  for (let i = 0, p = 0; i < count; i++, p += entrySize) {
    const cpu = r.i32(p), subtype = r.i32(p + 4);
    const offset = fat.bits === 64 ? r.u64(p + 8) : BigInt(r.u32(p + 8));
    const size = fat.bits === 64 ? r.u64(p + 16) : BigInt(r.u32(p + 12));
    all.push({ cpu, subtype, offset, size });
  }
  const valid = all.filter((slice) => slice.size > 0n && slice.offset <= source.size && slice.size <= source.size - slice.offset);
  const requested = opts.arch ? valid.find((slice) => cpuName(slice.cpu) === opts.arch) : null;
  const selected = requested || valid.find((slice) => cpuName(slice.cpu) === 'arm64') || valid.find((slice) => cpuName(slice.cpu) === 'x86_64') || valid[0];
  if (!selected) throw new Error('Mach-O universal binary has no readable slice');
  const sliceSource = source.subrange(selected.offset, selected.size);
  const slicePrefix = await readPrefix(sliceSource);
  const image = await parseSourceRanges(sliceSource, parseMachO, { ...opts, containerOffset: selected.offset }, withInitial(slicePrefix, rangeOptions));
  image.metadata.fat = {
    slices: all.map((slice) => ({ arch: cpuName(slice.cpu), cpu: slice.cpu, subtype: slice.subtype, offset: slice.offset, size: slice.size })),
    selected: { arch: cpuName(selected.cpu), offset: selected.offset, size: selected.size },
  };
  return image;
}

function withInitial(prefix, options) {
  if (!prefix?.byteLength) return options;
  return { ...options, initial: [{ offset: 0n, bytes: prefix }] };
}

async function readPrefix(source) {
  return source.readExactly(0n, Number(source.size < 16n ? source.size : 16n));
}

function fatKind(bytes) {
  if (bytes.byteLength < 4) return null;
  let magic = '';
  for (let i = 0; i < 4; i++) magic += bytes[i].toString(16).padStart(2, '0');
  return FAT_KINDS.get(magic) || null;
}

function cpuName(cpu) {
  const value = cpu >>> 0;
  return ({ 7: 'x86', 12: 'arm', 18: 'ppc', 0x01000007: 'x86_64', 0x0100000c: 'arm64', 0x0200000c: 'arm64_32' })[value] || `cpu-${value}`;
}
