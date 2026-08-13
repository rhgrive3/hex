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
 * 正直に書いておくと: メソッド名と「機械語のどのアドレスか」の対応づけは、
 * 実行ファイル側の CodeRegistration という表を読む必要があり、Unity の版によって
 * 形が大きく変わります。ここでは名前の一覧までを確実に出し、
 * アドレスとの対応は「候補」として扱います（間違ったまま断定しないため）。
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
      methods.push({ index: i, name, classIndex: owner });
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

  if (!classes.length) warnings.push('クラスの一覧を取り出せませんでした（版が違う可能性があります）。');
  if (!methods.length) warnings.push('メソッドの一覧を取り出せませんでした。');

  return { version, classes, methods, literals, warnings, typeSize };
}

/**
 * 版ごとの Il2CppTypeDefinition の大きさ（バイト）。
 * ここが違うと 1 件ずつずれて名前が化けるので、版ごとに用意する。
 */
function guessTypeSize(version) {
  if (version >= 29) return 92;
  if (version >= 27) return 92;
  if (version >= 24.4 || version >= 25) return 96;
  if (version >= 24) return 100;
  return 100;
}

/** 版ごとの Il2CppMethodDefinition の大きさ。 */
function guessMethodSize(version) {
  if (version >= 27) return 40;      // customAttributeIndex などが消えた
  if (version >= 24.1 || version >= 25) return 52;
  return 56;
}

function utf8(bytes) {
  try { return new TextDecoder('utf-8', { fatal: false }).decode(bytes); }
  catch { return Array.from(bytes).map((b) => String.fromCharCode(b)).join(''); }
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
    methods.push({ index: i, name, classIndex: owner });
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
