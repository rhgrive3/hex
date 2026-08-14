/*
 * Unity IL2CPP metadata parser.
 *
 * Metadata is untrusted input. Every table is validated before use and layout
 * selection is driven by cross-table invariants, not by printable names alone.
 */

const SANITY = 0xFAB11BAF;
const MAX_STRING_BYTES = 64 * 1024;
const MAX_TYPES = 200000;
const MAX_METHODS = 500000;
const MAX_LITERALS = 200000;
const MAX_IMAGES = 10000;

const PAIR = Object.freeze({
  stringLiteral: 0,
  stringLiteralData: 1,
  string: 2,
  events: 3,
  properties: 4,
  methods: 5,
  parameterDefaultValues: 6,
  fieldDefaultValues: 7,
  fieldAndParameterDefaultValueData: 8,
  fieldMarshaledSizes: 9,
  parameters: 10,
  fields: 11,
  genericParameters: 12,
  genericParameterConstraints: 13,
  genericContainers: 14,
  nestedTypes: 15,
  interfaces: 16,
  vtableMethods: 17,
  interfaceOffsets: 18,
  typeDefinitions: 19,
  images: 20,
  assemblies: 21,
});

const TABLE_NAMES = Object.freeze(Object.entries(PAIR).sort((a, b) => a[1] - b[1]).map(([name]) => name));
const REQUIRED_HEADER_PAIRS = PAIR.images + 1;
const REQUIRED_HEADER_BYTES = 8 + REQUIRED_HEADER_PAIRS * 8;

export class Il2CppMetadataError extends Error {
  constructor(message, code = 'IL2CPP_METADATA_INVALID', details = null) {
    super(message);
    this.name = 'Il2CppMetadataError';
    this.code = code;
    this.details = details;
  }
}

function diagnostic(code, message, table = null, details = null) {
  return { code, message, table, details };
}

function utf8(bytes) {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { return null; }
}

function finiteRange(offset, size, length) {
  return Number.isSafeInteger(offset) && Number.isSafeInteger(size) &&
    offset >= 0 && size >= 0 && offset <= length && size <= length - offset;
}

function readHeader(u8, dv, diagnostics) {
  if (u8.length < REQUIRED_HEADER_BYTES) {
    throw new Il2CppMetadataError(
      `IL2CPP metadata header is truncated: ${u8.length} < ${REQUIRED_HEADER_BYTES}`,
      'IL2CPP_HEADER_TRUNCATED',
      { actual: u8.length, required: REQUIRED_HEADER_BYTES },
    );
  }
  const tables = new Map();
  for (let index = 0; index < TABLE_NAMES.length; index++) {
    const name = TABLE_NAMES[index];
    const at = 8 + index * 8;
    if (at + 8 > u8.length) break;
    const offset = dv.getInt32(at, true);
    const size = dv.getInt32(at + 4, true);
    const entry = { name, index, offset, size, end: offset + size, valid: true };
    if (!finiteRange(offset, size, u8.length)) {
      entry.valid = false;
      diagnostics.push(diagnostic(
        'IL2CPP_TABLE_RANGE',
        `${name} table is outside metadata file`,
        name,
        { offset, size, fileSize: u8.length },
      ));
    }
    tables.set(name, entry);
  }

  const active = [...tables.values()].filter((t) => t.valid && t.size > 0).sort((a, b) => a.offset - b.offset || a.end - b.end);
  for (let i = 1; i < active.length; i++) {
    const previous = active[i - 1];
    const current = active[i];
    if (current.offset < previous.end) {
      previous.valid = false;
      current.valid = false;
      diagnostics.push(diagnostic(
        'IL2CPP_TABLE_OVERLAP',
        `${previous.name} overlaps ${current.name}`,
        current.name,
        { first: { offset: previous.offset, size: previous.size }, second: { offset: current.offset, size: current.size } },
      ));
    }
  }
  return tables;
}

function tableOf(tables, name) {
  const table = tables.get(name);
  return table?.valid ? table : null;
}

function makeStringReader(u8, strings, diagnostics) {
  let malformed = 0;
  return (index) => {
    if (!strings || !Number.isSafeInteger(index) || index < 0 || index >= strings.size) return null;
    const base = strings.offset + index;
    const tableEnd = strings.offset + strings.size;
    const maxEnd = Math.min(tableEnd, base + MAX_STRING_BYTES);
    let end = base;
    while (end < maxEnd && u8[end] !== 0) end++;
    if (end >= maxEnd || u8[end] !== 0) {
      if (malformed++ < 8) diagnostics.push(diagnostic(
        'IL2CPP_STRING_UNTERMINATED',
        'metadata string is not NUL-terminated inside the declared string table',
        'string',
        { index },
      ));
      return null;
    }
    if (end === base) return '';
    const decoded = utf8(u8.subarray(base, end));
    if (decoded == null && malformed++ < 8) diagnostics.push(diagnostic(
      'IL2CPP_STRING_UTF8',
      'metadata string is not valid UTF-8',
      'string',
      { index },
    ));
    return decoded;
  };
}

const LAYOUTS = Object.freeze([
  { id: '24.x-100-56', versions: [16, 24], typeSize: 100, methodSize: 56, typeMethodStart: 48, typeMethodCount: 76, typeToken: 96, methodToken: 40 },
  { id: '24.x-96-52', versions: [24, 26], typeSize: 96, methodSize: 52, typeMethodStart: 44, typeMethodCount: 72, typeToken: 92, methodToken: 40 },
  { id: '24.x-92-40', versions: [24, 31], typeSize: 92, methodSize: 40, typeMethodStart: 40, typeMethodCount: 68, typeToken: 88, methodToken: 24 },
  { id: '24.x-88-40', versions: [24, 31], typeSize: 88, methodSize: 40, typeMethodStart: 36, typeMethodCount: 64, typeToken: 84, methodToken: 24 },
]);

function layoutsFor(version) {
  const matching = LAYOUTS.filter((x) => version >= x.versions[0] && version <= x.versions[1]);
  if (version >= 27) {
    matching.sort((a, b) => Number(b.typeSize === 92 && b.methodSize === 40) - Number(a.typeSize === 92 && a.methodSize === 40));
  } else if (version >= 25) {
    matching.sort((a, b) => Number(b.typeSize === 96 && b.methodSize === 52) - Number(a.typeSize === 96 && a.methodSize === 52));
  } else {
    matching.sort((a, b) => Number(b.typeSize === 100 && b.methodSize === 56) - Number(a.typeSize === 100 && a.methodSize === 56));
  }
  return matching.length ? matching : LAYOUTS.slice();
}

function recordCount(table, stride, diagnostics, name) {
  if (!table || !(stride > 0)) return 0;
  if (table.size % stride !== 0) {
    diagnostics.push(diagnostic(
      'IL2CPP_TABLE_STRIDE',
      `${name} table size is not divisible by record size ${stride}`,
      name,
      { size: table.size, stride },
    ));
    return -1;
  }
  return table.size / stride;
}

function tokenPlausible(token, expectedTable) {
  if (token === 0) return true;
  const table = token >>> 24;
  const rid = token & 0x00ffffff;
  return rid > 0 && (!expectedTable || table === expectedTable);
}

function parseLayout(u8, dv, tables, stringAt, layout, diagnostics, { materialize = true } = {}) {
  const local = [];
  const typeTable = tableOf(tables, 'typeDefinitions');
  const methodTable = tableOf(tables, 'methods');
  const imageTable = tableOf(tables, 'images');
  const assemblyTable = tableOf(tables, 'assemblies');
  const typeCount = recordCount(typeTable, layout.typeSize, local, 'typeDefinitions');
  const methodCount = recordCount(methodTable, layout.methodSize, local, 'methods');
  if (typeCount < 0 || methodCount < 0 || typeCount > MAX_TYPES || methodCount > MAX_METHODS) {
    return { valid: false, score: -Infinity, diagnostics: local, layout, classes: [], methods: [], images: [] };
  }

  const types = [];
  let goodTypeNames = 0;
  let goodTypeTokens = 0;
  let validTypeMethodRanges = 0;
  let invalidTypeMethodRanges = 0;
  for (let i = 0; i < typeCount; i++) {
    const o = typeTable.offset + i * layout.typeSize;
    const nameIndex = dv.getInt32(o, true);
    const namespaceIndex = dv.getInt32(o + 4, true);
    const name = stringAt(nameIndex);
    const namespace = stringAt(namespaceIndex) ?? '';
    const methodStart = layout.typeMethodStart + 4 <= layout.typeSize ? dv.getInt32(o + layout.typeMethodStart, true) : -1;
    const methodCountForType = layout.typeMethodCount + 2 <= layout.typeSize ? dv.getUint16(o + layout.typeMethodCount, true) : 0;
    const token = layout.typeToken + 4 <= layout.typeSize ? dv.getUint32(o + layout.typeToken, true) : 0;
    const methodRangeValid = methodStart >= 0 && methodCountForType >= 0 && methodStart <= methodCount && methodCountForType <= methodCount - methodStart;
    if (methodRangeValid) validTypeMethodRanges++; else invalidTypeMethodRanges++;
    if (name) goodTypeNames++;
    if (tokenPlausible(token, 0x02)) goodTypeTokens++;
    types.push({
      index: i, name, namespace, full: name ? (namespace ? `${namespace}.${name}` : name) : null,
      methodStart, methodCount: methodCountForType, token, methodRangeValid,
    });
  }

  const methodsRaw = [];
  let goodMethodNames = 0;
  let validOwners = 0;
  let invalidOwners = 0;
  let goodMethodTokens = 0;
  for (let i = 0; i < methodCount; i++) {
    const o = methodTable.offset + i * layout.methodSize;
    const name = stringAt(dv.getInt32(o, true));
    const owner = dv.getInt32(o + 4, true);
    const token = layout.methodToken + 4 <= layout.methodSize ? dv.getUint32(o + layout.methodToken, true) : 0;
    if (name) goodMethodNames++;
    if (owner >= 0 && owner < typeCount) validOwners++; else invalidOwners++;
    if (tokenPlausible(token, 0x06)) goodMethodTokens++;
    methodsRaw.push({ index: i, name, classIndex: owner, token });
  }

  let ownerRangeMatches = 0;
  let ownerRangeMismatches = 0;
  for (const method of methodsRaw) {
    if (method.classIndex < 0 || method.classIndex >= types.length) {
      ownerRangeMismatches++;
      continue;
    }
    const owner = types[method.classIndex];
    const inRange = owner.methodRangeValid &&
      method.index >= owner.methodStart &&
      method.index < owner.methodStart + owner.methodCount;
    if (inRange) ownerRangeMatches++; else ownerRangeMismatches++;
  }
  for (const type of types) {
    if (!type.methodRangeValid) continue;
    for (let i = type.methodStart; i < type.methodStart + type.methodCount; i++) {
      if (methodsRaw[i]?.classIndex === type.index) continue;
      ownerRangeMismatches++;
    }
  }

  const assemblyUpperBound = assemblyTable && assemblyTable.size > 0 ? Math.max(1, Math.floor(assemblyTable.size / 16)) : null;
  const imageSelection = parseImagesForLayout(u8, dv, imageTable, stringAt, typeCount, assemblyUpperBound);
  local.push(...imageSelection.diagnostics);

  const denomTypes = Math.max(1, typeCount);
  const denomMethods = Math.max(1, methodCount);
  const nameScore = goodTypeNames / denomTypes * 8 + goodMethodNames / denomMethods * 6;
  const tokenScore = goodTypeTokens / denomTypes * 2 + goodMethodTokens / denomMethods * 2;
  const rangeScore = validTypeMethodRanges / denomTypes * 12 - invalidTypeMethodRanges / denomTypes * 24;
  const ownerScore = validOwners / denomMethods * 8 - invalidOwners / denomMethods * 24;
  const ownerRangeScore = ownerRangeMatches / denomMethods * 20 - ownerRangeMismatches / denomMethods * 30;
  const imageScore = imageSelection.score;
  const score = nameScore + tokenScore + rangeScore + ownerScore + ownerRangeScore + imageScore;

  const structurallyValid =
    typeCount >= 0 && methodCount >= 0 &&
    (typeCount === 0 || invalidTypeMethodRanges === 0) &&
    (methodCount === 0 || (invalidOwners === 0 && ownerRangeMismatches === 0)) &&
    imageSelection.valid;

  if (!materialize) return { valid: structurallyValid, score, diagnostics: local, layout, metrics: {
    typeCount, methodCount, goodTypeNames, goodMethodNames, validOwners, invalidOwners,
    validTypeMethodRanges, invalidTypeMethodRanges, ownerRangeMatches, ownerRangeMismatches,
  } };

  const classes = [];
  for (const type of types) {
    if (!type.name || !type.methodRangeValid) continue;
    classes.push(type);
  }
  const classByIndex = new Map(classes.map((c) => [c.index, c]));
  const methods = [];
  let rejectedMethods = 0;
  for (const method of methodsRaw) {
    if (!method.name) continue;
    const owner = classByIndex.get(method.classIndex);
    const inRange = owner && method.index >= owner.methodStart && method.index < owner.methodStart + owner.methodCount;
    if (!inRange) { rejectedMethods++; continue; }
    method.className = owner.full;
    method.full = `${owner.full}::${method.name}`;
    methods.push(method);
  }
  if (rejectedMethods) local.push(diagnostic(
    'IL2CPP_METHOD_OWNER_RANGE',
    `${rejectedMethods} method records were excluded because owner/type ranges disagree`,
    'methods',
    { rejected: rejectedMethods },
  ));
  return { valid: structurallyValid, score, diagnostics: local, layout, metrics: {
    typeCount, methodCount, goodTypeNames, goodMethodNames, validOwners, invalidOwners,
    validTypeMethodRanges, invalidTypeMethodRanges, ownerRangeMatches, ownerRangeMismatches,
  }, classes, methods, images: imageSelection.images };
}

function parseImagesForLayout(u8, dv, table, stringAt, typeCount, assemblyUpperBound) {
  if (!table || table.size === 0) return { valid: true, score: 0, images: [], diagnostics: [], recordSize: null };
  const candidates = [];
  for (const size of [40, 32, 24]) {
    if (table.size % size !== 0) continue;
    const count = table.size / size;
    if (count > MAX_IMAGES) continue;
    const images = [];
    let invalid = 0;
    let nameHits = 0;
    let rangeHits = 0;
    let assemblyHits = 0;
    let tokenHits = 0;
    for (let i = 0; i < count; i++) {
      const o = table.offset + i * size;
      const name = stringAt(dv.getInt32(o, true));
      const assemblyIndex = dv.getInt32(o + 4, true);
      const typeStart = dv.getInt32(o + 8, true);
      const countForImage = dv.getUint32(o + 12, true);
      const token = size >= 32 ? dv.getUint32(o + 28, true) : 0;
      const rangeValid = typeStart >= 0 && typeStart <= typeCount && countForImage <= typeCount - typeStart;
      const assemblyValid = assemblyUpperBound == null || (assemblyIndex >= 0 && assemblyIndex < assemblyUpperBound);
      const tokenValid = tokenPlausible(token, null);
      if (name) nameHits++;
      if (rangeValid) rangeHits++;
      if (assemblyValid) assemblyHits++;
      if (tokenValid) tokenHits++;
      if (!name || !rangeValid || !assemblyValid || !tokenValid) { invalid++; continue; }
      images.push({ index: i, name, assemblyIndex, typeStart, typeCount: countForImage, token });
    }
    const denom = Math.max(1, count);
    const score = nameHits / denom * 4 + rangeHits / denom * 12 + assemblyHits / denom * 5 + tokenHits / denom * 2 - invalid / denom * 30;
    candidates.push({ size, count, invalid, score, images });
  }
  candidates.sort((a, b) => b.score - a.score || a.invalid - b.invalid || b.images.length - a.images.length || b.size - a.size);
  const best = candidates[0];
  if (!best) {
    return { valid: false, score: -30, images: [], recordSize: null, diagnostics: [diagnostic(
      'IL2CPP_IMAGE_LAYOUT',
      'image table does not match any supported record stride',
      'images',
      { size: table.size },
    )] };
  }
  const diagnostics = [];
  if (best.invalid) diagnostics.push(diagnostic(
    'IL2CPP_IMAGE_INVARIANT',
    `${best.invalid} image records violate name/type-range/assembly invariants`,
    'images',
    { recordSize: best.size, rejected: best.invalid },
  ));
  return { valid: best.invalid === 0, score: best.score, images: best.images, recordSize: best.size, diagnostics };
}

function parseLiterals(u8, dv, tables, diagnostics) {
  const indexTable = tableOf(tables, 'stringLiteral');
  const dataTable = tableOf(tables, 'stringLiteralData');
  if (!indexTable || !dataTable || indexTable.size === 0) return [];
  if (indexTable.size % 8 !== 0) {
    diagnostics.push(diagnostic('IL2CPP_TABLE_STRIDE', 'string literal index table has partial record', 'stringLiteral', { size: indexTable.size }));
    return [];
  }
  const literals = [];
  const count = Math.min(indexTable.size / 8, MAX_LITERALS);
  for (let i = 0; i < count; i++) {
    const o = indexTable.offset + i * 8;
    const len = dv.getInt32(o, true);
    const relativeOffset = dv.getInt32(o + 4, true);
    if (len < 0 || len > (1 << 20) || relativeOffset < 0 || relativeOffset > dataTable.size || len > dataTable.size - relativeOffset) {
      diagnostics.push(diagnostic(
        'IL2CPP_LITERAL_RANGE',
        'string literal points outside declared literal-data table',
        'stringLiteral',
        { index: i, len, offset: relativeOffset, dataSize: dataTable.size },
      ));
      continue;
    }
    const base = dataTable.offset + relativeOffset;
    const text = utf8(u8.subarray(base, base + len));
    if (text != null) literals.push({ index: i, text });
  }
  return literals;
}

function selectLayout(u8, dv, tables, stringAt, version, diagnostics) {
  const evaluations = [];
  for (const layout of layoutsFor(version)) {
    const candidate = parseLayout(u8, dv, tables, stringAt, layout, [], { materialize: false });
    evaluations.push(candidate);
  }
  evaluations.sort((a, b) =>
    Number(b.valid) - Number(a.valid) ||
    b.score - a.score ||
    a.layout.id.localeCompare(b.layout.id)
  );
  const best = evaluations[0];
  if (!best || !Number.isFinite(best.score)) {
    diagnostics.push(diagnostic('IL2CPP_LAYOUT_UNRESOLVED', 'no supported metadata layout passed basic table validation'));
    return null;
  }
  if (!best.valid) {
    diagnostics.push(diagnostic(
      'IL2CPP_LAYOUT_INVARIANT',
      'no layout satisfies all cross-table invariants; refusing unsafe owner/image associations',
      null,
      { candidates: evaluations.map((x) => ({ id: x.layout.id, valid: x.valid, score: x.score, metrics: x.metrics })) },
    ));
  }
  return best;
}

export function parseMetadata(buffer) {
  const u8 = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  if (u8.length < 8) throw new Il2CppMetadataError('metadata header is truncated', 'IL2CPP_HEADER_TRUNCATED', { actual: u8.length, required: 8 });
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  if (dv.getUint32(0, true) !== SANITY) throw new Il2CppMetadataError('not a global-metadata.dat file', 'IL2CPP_BAD_SANITY');
  const version = dv.getInt32(4, true);
  const diagnostics = [];
  if (version < 16 || version > 31) diagnostics.push(diagnostic('IL2CPP_VERSION_UNKNOWN', `unrecognized metadata version ${version}`));

  const tables = readHeader(u8, dv, diagnostics);
  const strings = tableOf(tables, 'string');
  const stringAt = makeStringReader(u8, strings, diagnostics);
  const selection = selectLayout(u8, dv, tables, stringAt, version, diagnostics);
  const parsed = selection
    ? parseLayout(u8, dv, tables, stringAt, selection.layout, diagnostics, { materialize: true })
    : { classes: [], methods: [], images: [], diagnostics: [], layout: null, score: -Infinity, valid: false };
  diagnostics.push(...parsed.diagnostics);
  const literals = parseLiterals(u8, dv, tables, diagnostics);
  const warnings = diagnostics.map((x) => x.message);
  if (!parsed.classes.length) warnings.push('クラスの一覧を取り出せませんでした（metadata layoutを安全に確定できない可能性があります）。');
  if (!parsed.methods.length) warnings.push('メソッドの一覧を取り出せませんでした。');

  return {
    version,
    classes: parsed.classes,
    methods: parsed.methods,
    literals,
    images: parsed.images,
    warnings: [...new Set(warnings)],
    diagnostics,
    typeSize: parsed.layout?.typeSize || 0,
    methodSize: parsed.layout?.methodSize || 0,
    layout: parsed.layout ? {
      id: parsed.layout.id,
      typeSize: parsed.layout.typeSize,
      methodSize: parsed.layout.methodSize,
      score: parsed.score,
      structurallyValid: parsed.valid,
    } : null,
    tables: Object.fromEntries([...tables].map(([name, value]) => [name, { offset: value.offset, size: value.size, valid: value.valid }])),
  };
}

export function parseMetadataAuto(buffer) {
  return parseMetadata(buffer);
}

export function looksLikeUnity(strings, slice) {
  const hints = ['il2cpp', 'UnityEngine', 'global-metadata', 'Il2CppCodeRegistration', 'mono_'];
  let hit = 0;
  for (const s of (strings || []).slice(0, 200000)) {
    for (const h of hints) if (s.text && s.text.includes(h)) { hit++; break; }
    if (hit >= 3) return true;
  }
  const dylibs = slice && slice.info ? slice.info.dylibs || [] : [];
  return dylibs.some((d) => /UnityFramework|libil2cpp/i.test(d));
}

export async function bindMethodAddresses(meta, opts) {
  const o = opts || {};
  const regions = o.regions || [];
  const read = o.read;
  if (!meta || !meta.methods || !meta.methods.length || typeof read !== 'function') return { bound: 0, candidate: null };
  const exec = regions.filter((r) => r.exec && r.size > 0n);
  const data = regions.filter((r) => !r.exec && !r.zerofill && r.size >= 16n &&
    /__(const|data|data_const|rodata)/.test(r.section || ''));
  const inExec = (raw) => {
    let p = BigInt.asUintN(64, raw);
    p &= 0x00ffffffffffffffn;
    return exec.some((r) => p >= r.vmAddr && p < r.vmAddr + r.size) ? p : null;
  };
  const containing = (addr, bytes) => regions.find((r) => addr >= r.vmAddr && addr + BigInt(bytes) <= r.vmAddr + r.size);
  const expected = meta.methods.length;
  const candidates = [];
  const scanLimit = o.scanLimit || 64 * 1024 * 1024;
  let scanned = 0;
  for (const r of data) {
    if (scanned >= scanLimit) break;
    const want = Math.min(Number(r.size), scanLimit - scanned);
    const bytes = await read(r.vmAddr, want).catch(() => null);
    scanned += want;
    if (!bytes || bytes.length < 16) continue;
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    for (let at = 0; at + 16 <= bytes.length; at += 8) {
      const count64 = dv.getBigUint64(at, true);
      if (count64 < 1n || count64 > 5_000_000n) continue;
      const count = Number(count64);
      if (count < Math.max(1, Math.floor(expected * 0.85)) || count > expected * 1.15 + 32) continue;
      const table = dv.getBigUint64(at + 8, true) & 0x00ffffffffffffffn;
      const sampleCount = Math.min(count, 96);
      if (!containing(table, sampleCount * 8)) continue;
      const sample = await read(table, sampleCount * 8).catch(() => null);
      if (!sample || sample.length < sampleCount * 8) continue;
      const sdv = new DataView(sample.buffer, sample.byteOffset, sample.byteLength);
      let executable = 0, nonzero = 0;
      for (let i = 0; i < sampleCount; i++) {
        const raw = sdv.getBigUint64(i * 8, true);
        if (raw) nonzero++;
        if (inExec(raw) != null) executable++;
      }
      const ratio = executable / Math.max(1, nonzero);
      if (nonzero >= Math.min(8, sampleCount) && ratio >= 0.85) {
        candidates.push({ addr: r.vmAddr + BigInt(at), table, count, ratio,
          score: ratio - Math.abs(count - expected) / Math.max(count, expected) * 0.2 });
      }
    }
  }
  candidates.sort((a, b) => b.score - a.score);
  const best = candidates[0];
  if (!best) {
    const modern = await bindCodeGenModules(meta, { regions, data, exec, read, containing, inExec, scanLimit });
    if (modern.bound) return modern;
    meta.warnings.push('Method→address表は検証できませんでした。');
    return { bound: 0, candidate: null };
  }
  const tableBytes = await read(best.table, best.count * 8).catch(() => null);
  if (!tableBytes || tableBytes.length < best.count * 8) return { bound: 0, candidate: null };
  const tdv = new DataView(tableBytes.buffer, tableBytes.byteOffset, tableBytes.byteLength);
  let bound = 0;
  for (const method of meta.methods) {
    if (method.index < 0 || method.index >= best.count) continue;
    const address = inExec(tdv.getBigUint64(method.index * 8, true));
    if (address == null) continue;
    method.address = address;
    method.binding = 'code-registration';
    bound++;
  }
  meta.methodBinding = { kind: 'code-registration', bound, count: best.count, table: best.table };
  if (!bound) meta.warnings.push('Method pointer表は見つかりましたが、metadata indexと対応しませんでした。');
  return { bound, candidate: best };
}

async function bindCodeGenModules(meta, ctx) {
  const { data, read, containing, inExec, scanLimit } = ctx;
  const images = meta.images || [];
  if (!images.length) return { bound: 0, candidate: null };
  const raw = [];
  let scanned = 0;
  for (const r of data) {
    if (scanned >= scanLimit) break;
    const want = Math.min(Number(r.size), scanLimit - scanned);
    const bytes = await Promise.resolve(read(r.vmAddr, want)).catch(() => null);
    scanned += want;
    if (!bytes || bytes.length < 24) continue;
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    for (let at = 0; at + 24 <= bytes.length; at += 8) {
      const namePtr = dv.getBigUint64(at, true) & 0x00ffffffffffffffn;
      const count = dv.getUint32(at + 8, true);
      const table = dv.getBigUint64(at + 16, true) & 0x00ffffffffffffffn;
      if (!count || count > meta.methods.length + 4096 || !containing(namePtr, 1) || !containing(table, Math.min(count, 32) * 8)) continue;
      raw.push({ addr: r.vmAddr + BigInt(at), namePtr, count, table });
      if (raw.length >= 5000) break;
    }
  }
  const wantedNames = new Set(images.map((x) => x.name.toLowerCase()));
  const modules = new Map();
  for (const c of raw) {
    const nameBytes = await Promise.resolve(read(c.namePtr, 160)).catch(() => null);
    if (!nameBytes) continue;
    const zero = nameBytes.indexOf(0);
    const name = utf8(nameBytes.subarray(0, zero < 0 ? nameBytes.length : zero));
    if (!name || !wantedNames.has(name.toLowerCase())) continue;
    const sampleCount = Math.min(c.count, 64);
    const sample = await Promise.resolve(read(c.table, sampleCount * 8)).catch(() => null);
    if (!sample || sample.length < sampleCount * 8) continue;
    const dv = new DataView(sample.buffer, sample.byteOffset, sample.byteLength);
    let nonzero = 0, executable = 0;
    for (let i = 0; i < sampleCount; i++) {
      const p = dv.getBigUint64(i * 8, true);
      if (p) nonzero++;
      if (inExec(p) != null) executable++;
    }
    if (nonzero && executable / nonzero >= 0.85) modules.set(name.toLowerCase(), c);
  }
  let bound = 0;
  const tables = new Map();
  for (const image of images) {
    const mod = modules.get(image.name.toLowerCase());
    if (!mod) continue;
    const bytes = await Promise.resolve(read(mod.table, mod.count * 8)).catch(() => null);
    if (bytes && bytes.length >= mod.count * 8) tables.set(image.index, { mod, bytes });
  }
  for (const method of meta.methods) {
    const image = images.find((x) => method.classIndex >= x.typeStart && method.classIndex < x.typeStart + x.typeCount);
    if (!image || !method.token) continue;
    const entry = tables.get(image.index);
    const rid = (method.token & 0x00ffffff) - 1;
    if (!entry || rid < 0 || rid >= entry.mod.count) continue;
    const dv = new DataView(entry.bytes.buffer, entry.bytes.byteOffset, entry.bytes.byteLength);
    const address = inExec(dv.getBigUint64(rid * 8, true));
    if (address == null) continue;
    method.address = address;
    method.binding = 'codegen-module';
    bound++;
  }
  if (bound) meta.methodBinding = { kind: 'codegen-modules', bound, modules: tables.size };
  return { bound, candidate: null, modules: tables.size };
}
