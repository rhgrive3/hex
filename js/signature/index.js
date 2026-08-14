import { vendorInText } from '../vendors.js';
export const SIGNATURE_PACK_VERSION = 2;
export const SIGNATURE_PACK_FORMAT = 'hex-knowledge-pack';

const LIBRARIES = [
  { name:'libSystem', classification:'SYSTEM', kind:'runtime', libraries:[/libSystem\./i], symbols:[/^_?(malloc|free|memcpy|pthread_)/] },
  { name:'Foundation', classification:'SYSTEM', kind:'runtime', libraries:[/Foundation\.framework/i], symbols:[/^_?NS[A-Z]/] },
  { name:'CoreFoundation', classification:'SYSTEM', kind:'runtime', libraries:[/CoreFoundation\.framework/i], symbols:[/^_?CF[A-Z]/] },
  { name:'Swift runtime', classification:'RUNTIME', kind:'runtime', libraries:[/libswift(Core|Foundation|Concurrency)/i], symbols:[/^_?swift_/] },
  { name:'libc++', classification:'LIBRARY', kind:'library', libraries:[/libc\+\+/i], symbols:[/__ZSt|std::/] },
  { name:'SQLite', classification:'LIBRARY', kind:'library', libraries:[/sqlite3/i], symbols:[/^_?sqlite3_/] },
  { name:'zlib', classification:'LIBRARY', kind:'library', libraries:[/libz\.|zlib/i], symbols:[/^_?(inflate|deflate|crc32)$/] },
  { name:'Compression', classification:'SYSTEM', kind:'library', libraries:[/Compression\.framework/i], symbols:[/^_?compression_/] },
  { name:'CommonCrypto', classification:'SYSTEM', kind:'crypto', libraries:[/libcommonCrypto|Security\.framework/i], symbols:[/^_?CC(Crypt|_SHA|_MD5|KeyDerivation)/] },
  { name:'OpenSSL/BoringSSL', classification:'LIBRARY', kind:'crypto', libraries:[/lib(ssl|crypto)|boringssl/i], symbols:[/^_?(SSL_|EVP_|CRYPTO_|OPENSSL_)/] },
  { name:'Protocol Buffers', classification:'LIBRARY', kind:'library', libraries:[/protobuf/i], symbols:[/google::protobuf|GPBMessage|swiftprotobuf/i] },
  { name:'Unity', classification:'SDK', kind:'engine', libraries:[/UnityFramework/i], symbols:[/UnityEngine|UnityPlayer/] },
  { name:'IL2CPP', classification:'RUNTIME', kind:'runtime', libraries:[/libil2cpp|GameAssembly/i], symbols:[/^_?il2cpp_|il2cpp_codegen/] },
  { name:'Firebase', classification:'SDK', kind:'sdk', libraries:[/Firebase/i], symbols:[/FIR(App|Analytics)|firebase/i] },
  { name:'Google Mobile Ads', classification:'SDK', kind:'sdk', libraries:[/GoogleMobileAds/i], symbols:[/^_?GAD[A-Z]|googlemobileads/i] },
  { name:'AppLovin MAX', classification:'SDK', kind:'sdk', libraries:[/AppLovin/i], symbols:[/MA(Ad|Rewarded)|ALSdk|AppLovin/i] },
  { name:'IronSource LevelPlay', classification:'SDK', kind:'sdk', libraries:[/IronSource|LevelPlay/i], symbols:[/IronSource|LevelPlay|LPMReward/i] },
  { name:'AFNetworking', classification:'LIBRARY', kind:'library', libraries:[/AFNetworking/i], symbols:[/^_?AF(URL|HTTP|Network|Security)/] },
  { name:'Alamofire', classification:'LIBRARY', kind:'library', libraries:[/Alamofire/i], symbols:[/Alamofire/] },
  { name:'gRPC', classification:'LIBRARY', kind:'network', libraries:[/grpc/i], symbols:[/^_?grpc_|GRPC[A-Z]/] },
  { name:'libcurl', classification:'LIBRARY', kind:'network', libraries:[/libcurl|curl\.framework/i], symbols:[/^_?curl_(easy|multi|share|global)/] },
  { name:'SDWebImage', classification:'LIBRARY', kind:'library', libraries:[/SDWebImage/i], symbols:[/^_?SDWebImage/] },
];

function textOf(value) { return typeof value === 'string' ? value : value?.name || value?.library || value?.text || ''; }
function hits(values, regexes) {
  const out = [];
  for (const value of values || []) { const s = textOf(value); if (s && regexes?.some((rx) => rx.test(s))) out.push(s); }
  return [...new Set(out)].slice(0, 12);
}
export function recognizeLibraries(input = {}, signatures = LIBRARIES) {
  const libraries = input.libraries || [], symbols = [...(input.symbols || []), ...(input.imports || [])], strings = input.strings || [];
  const results = [];
  for (const sig of signatures) {
    const libraryHits = hits(libraries, sig.libraries), symbolHits = hits(symbols, sig.symbols), stringHits = hits(strings, sig.strings || []);
    const kinds = Number(libraryHits.length > 0) + Number(symbolHits.length > 0) + Number(stringHits.length > 0);
    if (!kinds) continue;
    // One exact framework/library path is strong evidence of presence, but still inferred.
    let confidence = libraryHits.length ? 0.82 : 0.52;
    if (symbolHits.length) confidence += 0.11;
    if (stringHits.length) confidence += 0.04;
    if (!libraryHits.length && kinds < 2 && symbolHits.length < 2) confidence = Math.min(confidence, 0.62);
    results.push({ name:sig.name, library:sig.name, classification:sig.classification, kind:sig.kind, confidence:Math.min(0.98,confidence), confirmed:false, evidence:[...libraryHits,...symbolHits,...stringHits] });
  }
  const existing = new Set(results.map((x) => x.name.toLowerCase()));
  const vendorHits = new Map();
  for (const [source, values] of [['library',libraries],['symbol',symbols],['string',strings]]) {
    for (const value of values) {
      const text = textOf(value); if (!text) continue; const vendor = vendorInText(text); if (!vendor) continue;
      let record = vendorHits.get(vendor.vendor);
      if (!record) vendorHits.set(vendor.vendor, record = { values:new Set(), sources:new Set(), kind:vendor.kind });
      record.values.add(text); record.sources.add(source);
    }
  }
  for (const [name, hit] of vendorHits) {
    if (existing.has(name.toLowerCase())) continue;
    const evidence=[...hit.values].slice(0,12), evidenceKinds=[...hit.sources];
    let confidence = hit.sources.has('library') ? 0.82 : hit.sources.has('symbol') ? (evidence.length >= 2 ? 0.68 : 0.56) : (evidence.length >= 2 ? 0.56 : 0.46);
    if (hit.sources.size >= 2) confidence += 0.08;
    confidence = Math.min(0.92, confidence);
    results.push({ name, library:name, classification:hit.kind==='library'?'LIBRARY':'SDK', kind:hit.kind, confidence, confirmed:false, evidence, evidenceKinds });
  }
  return results.sort((a,b) => b.confidence - a.confidence);
}

function clamp(value) { return Math.max(0, Math.min(1, Number(value) || 0)); }
function normalizeSignatureEntry(entry = {}, pack = {}) {
  return {
    architecture: entry.architecture || pack.architecture || 'any',
    compiler: entry.compiler ?? pack.compiler ?? null,
    library: entry.library ?? pack.library ?? null,
    version: entry.version ?? pack.libraryVersion ?? null,
    fingerprint: entry.fingerprint || null,
    symbols: Array.isArray(entry.symbols) ? [...new Set(entry.symbols.map(String))] : [],
    provenance: entry.provenance || pack.provenance || { source:'local', author:null },
    license: entry.license || pack.license || 'unspecified',
    confidence: clamp(entry.confidence ?? pack.confidence ?? 1),
    classification: entry.classification || null,
    name: entry.name || entry.symbol || null,
  };
}
function normalizeMappingEntry(entry = {}, pack = {}) {
  return {
    identity: entry.identity || entry.identityKey || null,
    name: entry.name || null,
    roles: Array.isArray(entry.roles) ? [...new Set(entry.roles.map(String))] : [],
    types: Array.isArray(entry.types) ? [...new Set(entry.types.map(String))] : [],
    comments: Array.isArray(entry.comments) ? [...new Set(entry.comments.map(String))] : [],
    semanticLabels: Array.isArray(entry.semanticLabels) ? [...new Set(entry.semanticLabels.map(String))] : [],
    confirmation: entry.confirmation || 'weak-inferred',
    negative: entry.negative === true,
    provenance: entry.provenance || pack.provenance || { source:'local', author:null },
    license: entry.license || pack.license || 'unspecified',
    confidence: clamp(entry.confidence ?? pack.confidence ?? 1),
  };
}

export function createKnowledgePack(input = {}) {
  const metadata = {
    architecture: input.architecture || 'any', compiler: input.compiler || null,
    library: input.library || null, libraryVersion: input.libraryVersion || null,
    provenance: input.provenance || { source:'local', author:null }, license: input.license || 'unspecified',
    confidence: clamp(input.confidence ?? 1),
  };
  return {
    format: SIGNATURE_PACK_FORMAT, version: SIGNATURE_PACK_VERSION,
    createdAt: input.createdAt || new Date().toISOString(),
    ...metadata,
    signatures: Array.isArray(input.signatures) ? input.signatures.map((entry) => normalizeSignatureEntry(entry, metadata)) : [],
    mappings: Array.isArray(input.mappings) ? input.mappings.map((entry) => normalizeMappingEntry(entry, metadata)) : [],
  };
}
export function validateKnowledgePack(pack) {
  try {
    if (!pack || typeof pack !== 'object' || Array.isArray(pack)) throw new Error('pack root must be an object');
    if (pack.format !== SIGNATURE_PACK_FORMAT) throw new Error('unsupported knowledge pack format');
    if (!Number.isInteger(pack.version) || pack.version < 1 || pack.version > SIGNATURE_PACK_VERSION) throw new Error('unsupported knowledge pack version');
    if (!Array.isArray(pack.signatures) || !Array.isArray(pack.mappings)) throw new Error('pack signatures/mappings must be arrays');
    if (pack.signatures.length > 1_000_000 || pack.mappings.length > 1_000_000) throw new Error('knowledge pack is unreasonably large');
    for (const entry of [...pack.signatures, ...pack.mappings]) if (!entry || typeof entry !== 'object') throw new Error('knowledge pack entry must be an object');
    for (const entry of pack.signatures) {
      if (!entry.architecture || typeof entry.architecture !== 'string') throw new Error('signature architecture is required');
      if (!(entry.confidence >= 0 && entry.confidence <= 1)) throw new Error('signature confidence must be in [0,1]');
      if (!Array.isArray(entry.symbols)) throw new Error('signature symbols must be an array');
      if (!entry.provenance || typeof entry.provenance !== 'object') throw new Error('signature provenance is required');
      if (typeof entry.license !== 'string' || !entry.license) throw new Error('signature license is required');
    }
    for (const entry of pack.mappings) {
      if (!(entry.confidence >= 0 && entry.confidence <= 1)) throw new Error('mapping confidence must be in [0,1]');
      if (!entry.provenance || typeof entry.provenance !== 'object') throw new Error('mapping provenance is required');
      if (typeof entry.license !== 'string' || !entry.license) throw new Error('mapping license is required');
    }
    return { ok:true, pack };
  } catch (error) { return { ok:false, error:error.message }; }
}
export function importKnowledgePack(value) {
  let parsed = value;
  if (typeof value === 'string') { try { parsed = JSON.parse(value); } catch (error) { return { ok:false, error:'malformed knowledge pack JSON: ' + error.message }; } }
  return validateKnowledgePack(parsed);
}
export const BUILTIN_LIBRARY_SIGNATURES = Object.freeze(LIBRARIES.slice());
