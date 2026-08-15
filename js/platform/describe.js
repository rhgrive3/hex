import { architectureCapability } from '../architecture/index.js';
import { DEPLOYED_CAPSTONE_SUPPORT } from './capstone-capability.js';

function displayFormat(image) {
  if (image.format === 'elf') return `ELF ${image.bits || '?'}-bit`;
  if (image.format === 'pe') return image.bits === 64 ? 'PE32+' : 'PE32';
  if (image.format === 'macho') return `Mach-O ${image.bits || '?'}-bit`;
  return String(image.format || 'Raw binary');
}

function regionFrom(item, id, kind) {
  const fileSize = BigInt(item.fileSize ?? item.size ?? 0);
  const declaredSize = BigInt(item.size ?? fileSize);
  const section = kind === 'section' ? item.name || '' : null;
  return {
    id,
    kind,
    name: item.name || (kind === 'segment' ? `Segment ${id}` : `Section ${id}`),
    segment: item.segment || (kind === 'segment' ? item.name || null : null),
    section,
    fileOffset: BigInt(item.fileOffset ?? 0),
    vmAddr: BigInt(item.address ?? 0),
    size: fileSize,
    declaredSize,
    exec: !!item.perms?.execute,
    write: !!item.perms?.write,
    read: !!item.perms?.read,
    zerofill: fileSize === 0n && declaredSize > 0n,
    truncated: false,
    cstrings: /cstring|string|strtab|rdata|rodata/i.test(item.name || ''),
  };
}

export function regionsForImage(image, prefix = 'p0_') {
  const sections = image.sections || [];
  const usefulSections = sections.filter((s) => BigInt(s.fileSize ?? s.size ?? 0) > 0n || BigInt(s.size ?? 0) > 0n);
  const source = usefulSections.length ? usefulSections : (image.segments || []);
  const kind = usefulSections.length ? 'section' : 'segment';
  return source.map((item, index) => regionFrom(item, `${prefix}${kind[0]}${index}`, kind));
}

export function describeBinaryImage(image, options = {}) {
  const requestedEngine = options.engine || {};
  const engine = {
    ...DEPLOYED_CAPSTONE_SUPPORT,
    ...requestedEngine,
    verified: requestedEngine.verified === true,
  };
  const capability = architectureCapability(image, engine);
  const regions = regionsForImage(image);
  const info = {
    cpu: image.arch || 'unknown',
    cpuSub: image.metadata?.subtypeName || (image.metadata?.subtypeBase == null ? 'all' : String(image.metadata.subtypeBase)),
    is64: image.bits === 64,
    isArm64: image.arch === 'arm64' || image.arch === 'arm64e',
    isArm64e: image.arch === 'arm64e',
    textVM: (regions.find((r) => r.exec)?.vmAddr ?? image.imageBase ?? 0n),
    encrypted: false,
    endian: image.endian,
    format: image.format,
    capability,
  };
  const summary = image.summary();
  const raw = {
    id: 'raw', kind: 'file', name: 'Whole file (raw)', fileOffset: 0n, vmAddr: 0n,
    size: image.fileSize, declaredSize: image.fileSize, exec: false, write: false, read: true,
    zerofill: false, truncated: false,
  };
  return {
    name: options.name || 'binary',
    size: image.fileSize,
    format: displayFormat(image),
    formatId: image.format,
    slices: [{ name: image.arch || 'unknown', offset: image.fileOffset || 0n, size: image.fileSize, info, capability, regions }],
    raw,
    warnings: [...(image.warnings || [])],
    capability,
    platform: {
      summary,
      sourceBacked: !!image.metadata?.sourceBacked,
      sourceReads: image.metadata?.sourceReads || null,
      metadataKeys: Object.keys(image.metadata || {}).sort(),
    },
  };
}
