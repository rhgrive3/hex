/*
 * Unity（IL2CPP）で作られたアプリの追加解析。
 *
 * Unity のアプリは C# で書かれていますが、出荷時には IL2CPP という仕組みで
 * C++ に変換され、機械語になります。このとき、クラス名やメソッド名は
 * 実行ファイルから消え、代わりに **global-metadata.dat** という別ファイルに移ります。
 *
 *   YourApp.app/
 *     YourApp                                  ← 機械語（このツールで開くもの）
 *     Data/Managed/Metadata/global-metadata.dat ← 名前の入った箱（こちらも読み込む）
 *
 * つまり、この 2 つを合わせて初めて「どのクラスの、どのメソッドか」が分かります。
 * ここは global-metadata.dat を読んで、
 *   - C# のクラス（名前空間つき）の一覧
 *   - メソッド名の一覧（どのクラスのものか付き）
 *   - プログラムの中の文字列（string literal）
 * を取り出します。
 *
 * Method→addressは実行ファイル側のCodeRegistrationを検証できた版だけ復元する。
 * modern codegen-module形式など検証できない版では、推測addressを作らず名前一覧に留める。
 */

const SANITY = 0xFAB11BAF;

/* 見出し（ヘッダ）は「位置と個数」の組が並んだだけの単純な作り。
   版によって組の数が増減するので、必要なものだけを添字で取り出す。 */
const PAIR = {
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
};

/**
 * global-metadata.dat を読む。
 * @param {ArrayBuffer|Uint8Array} buffer
 * @returns {{version, classes, methods, literals, warnings}}
 */
export function parseMetadata(buffer) {
  const u8 = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  if (u8.length < 64) throw new Error('ファイルが小さすぎます。global-metadata.dat ではないようです。');
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const sanity = dv.getUint32(0, true);
  if (sanity !== SANITY) {
    throw new Error('global-metadata.dat ではないようです（先頭の印が合いません）。');
  }
  const version = dv.getInt32(4, true);
  const warnings = [];
  if (version < 16 || version > 31) warnings.push('知らない版です（version ' + version + '）。読める範囲だけ出します。');

  const pair = (i) => {
    const off = 8 + i * 8;
    if (off + 8 > u8.length) return null;
    return { offset: dv.getInt32(off, true), size: dv.getInt32(off + 4, true) };
  };

  /* 名前の文字列。0 終端でぎっしり詰まっている */
  const strings = pair(PAIR.string);
  const stringAt = (index) => {
    if (!strings || index < 0) return null;
    const base = strings.offset + index;
    if (base < 0 || base >= u8.length) return null;
    let end = base;
    while (end < u8.length && u8[end] !== 0 && end - base < 512) end++;
    return utf8(u8.subarray(base, end));
  };

  /* クラス（型）。先頭 2 つの int32 が名前と名前空間なのは、どの版でも同じ */
  const typeDefs = pair(PAIR.typeDefinitions);
  const classes = [];
  let typeSize = 0;
  if (typeDefs && typeDefs.size > 0) {
    typeSize = guessTypeSize(version);
    const count = Math.floor(typeDefs.size / typeSize);
    for (let i = 0; i < count && i < 200000; i++) {
      const o = typeDefs.offset + i * typeSize;
      if (o + 8 > u8.length) break;
      const name = stringAt(dv.getInt32(o, true));
      const ns = stringAt(dv.getInt32(o + 4, true));
      if (!name) continue;
      classes.push({ index: i, name, namespace: ns || '', full: ns ? ns + '.' + name : name });
    }
  }

  /* メソッド。こちらも先頭 2 つは名前と「どのクラスのものか」 */
  const methodDefs = pair(PAIR.methods);
  const methods = [];
  if (methodDefs && methodDefs.size > 0) {
    const size = guessMethodSize(version);
    const count = Math.floor(methodDefs.size / size);
    for (let i = 0; i < count && i < 500000; i++) {
      const o = methodDefs.offset + i * size;
      if (o + 8 > u8.length) break;
      const name = stringAt(dv.getInt32(o, true));
      const owner = dv.getInt32(o + 4, true);
      if (!name) continue;
      const tokenAt = version >= 27 ? 24 : 40;
      const token = o + tokenAt + 4 <= u8.length ? dv.getUint32(o + tokenAt, true) : 0;
      methods.push({ index: i, name, classIndex: owner, token });
    }
  }

  /* プログラムの中の文字列（"Login failed" など）。ここが解析の入口になりやすい */
  const litIndex = pair(PAIR.stringLiteral);
  const litData = pair(PAIR.stringLiteralData);
  const literals = [];
  if (litIndex && litData && litIndex.size > 0) {
    const count = Math.floor(litIndex.size / 8);
    for (let i = 0; i < count && i < 200000; i++) {
      const o = litIndex.offset + i * 8;
      if (o + 8 > u8.length) break;
      const len = dv.getInt32(o, true);
      const off = dv.getInt32(o + 4, true);
      if (len < 0 || len > 1 << 16) continue;
      const base = litData.offset + off;
      if (base < 0 || base + len > u8.length) continue;
      literals.push({ index: i, text: utf8(u8.subarray(base, base + len)) });
    }
  }

  /* クラス名をメソッドに結びつける */
  const byIndex = new Map(classes.map((c) => [c.index, c]));
  for (const m of methods) {
    const c = byIndex.get(m.classIndex);
    m.className = c ? c.full : null;
    m.full = (c ? c.full + '::' : '') + m.name;
  }

  const images = parseImages(u8, dv, pair(PAIR.images), stringAt);

  if (!classes.length) warnings.push('クラスの一覧を取り出せませんでした（版が違う可能性があります）。');
  if (!methods.length) warnings.push('メソッドの一覧を取り出せませんでした。');

  return { version, classes, methods, literals, images, warnings, typeSize };
}

/**
 * 版ごとの Il2CppTypeDefinition の大きさ（バイト）。
 * ここが違うと 1 件ずつずれて名前が化けるので、版ごとに用意する。
 */
function guessTypeSize(version) {
  if (version >= 29) return 92;
  if (version >= 27) return 92;
  if (version >= 25) return 96;
  if (version >= 24) return 100;
  return 100;
}

/** 版ごとの Il2CppMethodDefinition の大きさ。 */
function guessMethodSize(version) {
  if (version >= 27) return 40;      // customAttributeIndex などが消えた
  if (version >= 25) return 52;
  return 56;
}

function utf8(bytes) {
  try { return new TextDecoder('utf-8', { fatal: false }).decode(bytes); }
  catch { return Array.from(bytes).map((b) => String.fromCharCode(b)).join(''); }
}

function parseImages(u8, dv, table, stringAt) {
  if (!table || table.size <= 0) return [];
  let best = [];
  for (const size of [40, 32, 24]) {
    const out = [];
    const count = Math.floor(table.size / size);
    for (let i = 0; i < count && i < 10000; i++) {
      const o = table.offset + i * size;
      if (o < 0 || o + 16 > u8.length) break;
      const name = stringAt(dv.getInt32(o, true));
      const typeStart = dv.getInt32(o + 8, true), typeCount = dv.getUint32(o + 12, true);
      if (!name || typeStart < 0 || typeCount > 2_000_000) continue;
      out.push({ index: i, name, typeStart, typeCount });
    }
    if (out.length > best.length) best = out;
  }
  return best;
}

/**
 * 大きさの見立てが合っているかを、名前の取れ具合で確かめる。
 * 合っていなければ、他の大きさも試して、いちばん名前が取れたものを選ぶ。
 *
 * 「版によって形が違う」問題に、実測で答えるための仕組み。
 */
export function parseMetadataAuto(buffer) {
  const candidates = [
    null,                                  // まず版どおり
    { type: 92, method: 40 },
    { type: 96, method: 52 },
    { type: 100, method: 56 },
    { type: 88, method: 40 },
  ];
  let best = null;
  for (const c of candidates) {
    let res;
    try { res = c ? parseWithSizes(buffer, c) : parseMetadata(buffer); }
    catch (err) { if (!c) throw err; continue; }
    const score = scoreOf(res);
    if (!best || score > best.score) best = { res, score, sizes: c };
  }
  if (!best) throw new Error('読み取れませんでした。');
  if (best.sizes) best.res.warnings.push('版どおりの形では読めなかったので、実際に名前が取れる形（' +
    best.sizes.type + ' / ' + best.sizes.method + ' バイト）で読み直しました。');
  return best.res;
}

function parseWithSizes(buffer, sizes) {
  const saveType = guessTypeSize;
  const saveMethod = guessMethodSize;
  void saveType; void saveMethod;
  // 大きさを差し替えて読む（同じ処理を使い回す）
  const res = parseMetadataWith(buffer, sizes.type, sizes.method);
  return res;
}

/** 大きさを指定して読む本体。parseMetadata はこれに既定値を渡しているだけ。 */
function parseMetadataWith(buffer, typeSize, methodSize) {
  const original = { t: guessTypeSize, m: guessMethodSize };
  void original;
  const u8 = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const res = parseMetadata(u8);
  // 取り直し（クラスとメソッドだけ、指定の大きさで）
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const pair = (i) => ({ offset: dv.getInt32(8 + i * 8, true), size: dv.getInt32(8 + i * 8 + 4, true) });
  const strings = pair(PAIR.string);
  const stringAt = (index) => {
    const base = strings.offset + index;
    if (base < 0 || base >= u8.length) return null;
    let end = base;
    while (end < u8.length && u8[end] !== 0 && end - base < 512) end++;
    return utf8(u8.subarray(base, end));
  };
  const typeDefs = pair(PAIR.typeDefinitions);
  const classes = [];
  const count = Math.floor(typeDefs.size / typeSize);
  for (let i = 0; i < count && i < 200000; i++) {
    const o = typeDefs.offset + i * typeSize;
    if (o + 8 > u8.length) break;
    const name = stringAt(dv.getInt32(o, true));
    const ns = stringAt(dv.getInt32(o + 4, true));
    if (!name) continue;
    classes.push({ index: i, name, namespace: ns || '', full: ns ? ns + '.' + name : name });
  }
  const methodDefs = pair(PAIR.methods);
  const methods = [];
  const mcount = Math.floor(methodDefs.size / methodSize);
  for (let i = 0; i < mcount && i < 500000; i++) {
    const o = methodDefs.offset + i * methodSize;
    if (o + 8 > u8.length) break;
    const name = stringAt(dv.getInt32(o, true));
    const owner = dv.getInt32(o + 4, true);
    if (!name) continue;
    const tokenAt = res.version >= 27 ? 24 : 40;
    const token = o + tokenAt + 4 <= u8.length ? dv.getUint32(o + tokenAt, true) : 0;
    methods.push({ index: i, name, classIndex: owner, token });
  }
  const byIndex = new Map(classes.map((c) => [c.index, c]));
  for (const m of methods) {
    const c = byIndex.get(m.classIndex);
    m.className = c ? c.full : null;
    m.full = (c ? c.full + '::' : '') + m.name;
  }
  res.classes = classes;
  res.methods = methods;
  return res;
}

/** 読めた名前がどれだけ「それらしいか」で点数をつける。 */
function scoreOf(res) {
  const ok = (s) => !!s && /^[A-Za-z_<][\w`<>.\-]*$/.test(s);
  const cs = res.classes.slice(0, 300).filter((c) => ok(c.name)).length;
  const ms = res.methods.slice(0, 300).filter((m) => ok(m.name)).length;
  return cs * 2 + ms;
}

/**
 * Unity のアプリかどうかを、実行ファイル側の手がかりで見分ける。
 * @param {Array} strings 収集済みの文字列
 * @param {object} slice
 */
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

/**
 * Legacy/monolithic Il2CppCodeRegistration から methodPointers を復元する。
 *
 * Unityの版を決め打ちせず、データ区画内の {count, pointer} 候補を検証し、pointer
 * tableの大半が実行区画を指す場合だけ採用する。見つからないmodern codegen-module
 * 形式では空を返し、誤ったaddressを名前へ結びつけない。
 */
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
    p &= 0x00ffffffffffffffn; // top-byte tags/PAC discriminator
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
      /* A per-module table must never be mistaken for the old global table. */
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
    if (!wantedNames.has(name.toLowerCase())) continue;
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
