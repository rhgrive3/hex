import { compareFingerprints, fingerprintFunction } from '../diff/index.js';

export class KnowledgeDB {
  constructor(options = {}) {
    this.indexedDB = options.indexedDB === undefined ? globalThis.indexedDB : options.indexedDB;
    this.dbName = options.dbName || 'hex-knowledge';
    this.memory = options.memory || (!this.indexedDB ? new Map() : null);
    this._db = null;
  }

  async remember(input) {
    const fingerprint = input.fingerprint?.hash ? input.fingerprint : fingerprintFunction(input.fingerprint || input);
    const sourceBinaryHash = input.sourceBinaryHash || 'unknown';
    const address = input.address ?? fingerprint.address;
    const id = input.id || `${sourceBinaryHash}:${address == null ? fingerprint.hash : BigInt(address).toString(16)}:${fingerprint.hash}`;
    const record = {
      id,
      fingerprint,
      fingerprints: input.fingerprints || [fingerprint.hash],
      names: unique(input.names || (input.name ? [input.name] : [])),
      roles: unique(input.roles || []),
      types: unique(input.types || []),
      semanticLabels: unique(input.semanticLabels || []),
      sourceBinaryHash,
      versions: unique(input.versions || []),
      confidence: clamp(input.confidence ?? 1),
      evidence: Array.isArray(input.evidence) ? input.evidence.slice(0, 1000) : [],
      updatedAt: Date.now(),
    };
    if (this.memory) this.memory.set(id, structuredCloneSafe(record));
    else await this.#put(record);
    return record;
  }

  async findMatches(input, options = {}) {
    const fingerprint = input?.hash ? input : fingerprintFunction(input);
    const limit = Math.min(50, Math.max(1, Number(options.limit) || 10));
    let records;
    if (this.memory) records = [...this.memory.values()];
    else records = await this.#candidateRecords(fingerprint);
    const matches = [];
    for (const record of records) {
      const cmp = compareFingerprints(fingerprint, record.fingerprint);
      const confidence = clamp(cmp.confidence * (0.5 + 0.5 * clamp(record.confidence)));
      if (confidence < (options.threshold ?? 0.65)) continue;
      matches.push({ record: structuredCloneSafe(record), confidence, reasons: cmp.reasons });
    }
    matches.sort((a, b) => b.confidence - a.confidence || b.record.updatedAt - a.record.updatedAt);
    return matches.slice(0, limit);
  }

  async reidentify(input, options = {}) {
    const matches = await this.findMatches(input, { threshold: options.threshold ?? 0.72, limit: 5 });
    if (!matches.length) return { matched: false, confidence: 0, candidates: [] };
    const best = matches[0], second = matches[1];
    const ambiguous = !!second && best.confidence - second.confidence < (options.ambiguityWindow ?? 0.05);
    const accepted = best.confidence >= (options.acceptThreshold ?? 0.8) && !ambiguous;
    return {
      matched: accepted,
      ambiguous,
      confidence: best.confidence,
      knowledge: accepted ? best.record : null,
      reasons: best.reasons,
      candidates: matches.map((x) => ({ id: x.record.id, names: x.record.names, confidence: x.confidence, reasons: x.reasons })),
    };
  }

  async clear() {
    if (this.memory) { this.memory.clear(); return; }
    const db = await this.#dbOpen();
    await requestPromise(db.transaction('functions', 'readwrite').objectStore('functions').clear());
  }

  async #dbOpen() {
    if (this._db) return this._db;
    this._db = await new Promise((resolve, reject) => {
      const req = this.indexedDB.open(this.dbName, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('functions')) {
          const store = db.createObjectStore('functions', { keyPath: 'id' });
          store.createIndex('normalizedByteHash', 'fingerprint.normalizedByteHash', { unique: false });
          store.createIndex('sourceBinaryHash', 'sourceBinaryHash', { unique: false });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return this._db;
  }

  async #put(record) {
    const db = await this.#dbOpen();
    await requestPromise(db.transaction('functions', 'readwrite').objectStore('functions').put(record));
  }

  async #candidateRecords(fingerprint) {
    const db = await this.#dbOpen();
    const tx = db.transaction('functions', 'readonly');
    const store = tx.objectStore('functions');
    if (fingerprint.normalizedByteHash) {
      const exact = await requestPromise(store.index('normalizedByteHash').getAll(fingerprint.normalizedByteHash, 200));
      if (exact.length) return exact;
    }
    return requestPromise(store.getAll(null, 5000));
  }
}

const VENDOR_RULES = [
  { name: 'Firebase', kind: 'sdk', signals: [/firebase/i, /googleappmeasurement/i, /gdtcore/i] },
  { name: 'Unity', kind: 'engine', signals: [/unityframework/i, /unityplayer/i, /unityengine/i] },
  { name: 'IL2CPP', kind: 'runtime', signals: [/il2cpp/i, /global-metadata/i, /il2cpp_codegen/i] },
  { name: 'Ad SDK', kind: 'sdk', signals: [/googlemobileads/i, /applovin/i, /ironsource/i, /unityads/i, /admob/i] },
  { name: 'libSystem', kind: 'runtime', signals: [/libsystem/i, /libc\+\+/i, /libobjc/i] },
  { name: 'Foundation', kind: 'runtime', signals: [/foundation\.framework/i, /_ns[a-z0-9_]+/i] },
  { name: 'Swift runtime', kind: 'runtime', signals: [/libswift/i, /swiftcore/i, /swift_[a-z0-9_]+/i] },
];

export function fingerprintVendors(input = {}) {
  const evidence = [
    ...(input.libraries || []),
    ...(input.imports || []).map((x) => typeof x === 'string' ? x : `${x.library || ''}:${x.name || ''}`),
    ...(input.symbols || []).map((x) => typeof x === 'string' ? x : x.name || ''),
    ...(input.strings || []).map((x) => typeof x === 'string' ? x : x.text || ''),
  ].filter(Boolean).map(String);
  const results = [];
  for (const rule of VENDOR_RULES) {
    const hits = [];
    for (const value of evidence) {
      if (rule.signals.some((rx) => rx.test(value))) hits.push(value);
      if (hits.length >= 8) break;
    }
    if (!hits.length) continue;
    const confidence = Math.min(0.98, 0.45 + 0.16 * hits.length);
    results.push({ name: rule.name, kind: rule.kind, confidence, confirmed: false, reasons: hits });
  }
  results.sort((a, b) => b.confidence - a.confidence);
  return results;
}

function requestPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
function unique(values) { return [...new Set((values || []).filter((x) => x != null).map(String))]; }
function clamp(value) { return Math.max(0, Math.min(1, Number(value) || 0)); }
function structuredCloneSafe(value) { return typeof structuredClone === 'function' ? structuredClone(value) : value; }
