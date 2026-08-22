import { compareFingerprints, fingerprintFunction } from '../fingerprint/index.js';
import { recognizeLibraries } from '../signature/index.js';
import { FunctionMatchIndex } from '../recognition/matcher.js';

export const KNOWLEDGE_SCHEMA_VERSION = 3;
export const CONFIRMATION_LEVELS = Object.freeze(['user-confirmed','debugger-confirmed','metadata-confirmed','high-confidence-inferred','weak-inferred']);

function clamp(v) { return Math.max(0, Math.min(1, Number(v) || 0)); }
function uniq(values) { return [...new Set((values || []).filter((x) => x != null && String(x).length).map(String))]; }
function clone(value) {
  if (typeof structuredClone === 'function') return structuredClone(value);
  if (value == null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(clone);
  if (value instanceof Uint8Array) return value.slice();
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    Object.defineProperty(out, key, { value: clone(item), enumerable:true, writable:true, configurable:true });
  }
  return out;
}
function searchTermsOf(input = {}) {
  const values = [...(input.names || []), ...(input.roles || []), ...(input.semanticLabels || []), ...(input.comments || [])];
  const out = new Set();
  for (const value of values) {
    const text = String(value || '').trim().toLowerCase(); if (!text) continue; out.add(text);
    for (const token of text.split(/[^\p{L}\p{N}_+.-]+/u)) if (token) out.add(token);
  }
  return [...out].slice(0, 512);
}
function addrText(value) { return value == null ? 'unknown' : BigInt(value).toString(16); }
function requestPromise(request) { return new Promise((resolve,reject) => { request.onsuccess=()=>resolve(request.result); request.onerror=()=>reject(request.error); }); }
function candidateBatch(values, truncated = false) {
  const out = Array.isArray(values) ? values : [];
  Object.defineProperty(out, 'truncated', { value:!!truncated, enumerable:false, configurable:true });
  return out;
}

export class KnowledgeDB {
  constructor(options = {}) {
    this.indexedDB = options.indexedDB === undefined ? globalThis.indexedDB : options.indexedDB;
    this.dbName = options.dbName || 'hex-knowledge';
    this.memory = options.memory || (!this.indexedDB ? new Map() : null);
    this.negativeMemory = options.negativeMemory || (!this.indexedDB ? new Map() : null);
    this._db = null;
    const maxCandidates = Number(options.maxCandidates || 1000);
    this.maxCandidates = Number.isFinite(maxCandidates) ? Math.max(50, maxCandidates) : 1000;
  }

  async remember(input = {}) {
    const fingerprint = input.fingerprint?.schema ? fingerprintFunction(input.fingerprint) : fingerprintFunction(input.fingerprint || input);
    const sourceBinaryHash = input.sourceBinaryHash || 'unknown';
    const address = input.address ?? fingerprint.address;
    const identityKey = input.identityKey || fingerprint.semanticHash || fingerprint.normalizedBytesHash || fingerprint.hash || null;
    const id = input.id || `${sourceBinaryHash}:${addrText(address)}:${identityKey || 'sparse'}`;
    const requestedConfirmation = CONFIRMATION_LEVELS.includes(input.confirmation) ? input.confirmation : null;
    const userConfirmed = input.userConfirmed || requestedConfirmation === 'user-confirmed';
    const debuggerConfirmed = input.debuggerConfirmed || requestedConfirmation === 'debugger-confirmed';
    const metadataConfirmed = input.metadataConfirmed || requestedConfirmation === 'metadata-confirmed';
    const resolvedConfidence = input.confidence == null ? (userConfirmed || debuggerConfirmed ? 1 : metadataConfirmed ? 0.95 : 0.5) : clamp(input.confidence);
    const confirmation = requestedConfirmation || (userConfirmed ? 'user-confirmed' : debuggerConfirmed ? 'debugger-confirmed' : metadataConfirmed ? 'metadata-confirmed' : resolvedConfidence >= 0.9 ? 'high-confidence-inferred' : 'weak-inferred');
    const record = {
      schemaVersion: KNOWLEDGE_SCHEMA_VERSION, id, identityKey, fingerprint, fingerprints: uniq(input.fingerprints || (fingerprint.hash ? [fingerprint.hash] : [])),
      names: uniq(input.names || (input.name ? [input.name] : [])), roles: uniq(input.roles), types: uniq(input.types),
      comments: uniq(input.comments || (input.comment ? [input.comment] : [])), semanticLabels: uniq(input.semanticLabels),
      fieldInterpretations: Array.isArray(input.fieldInterpretations) ? clone(input.fieldInterpretations) : [],
      sourceBinaryHash, versions: uniq(input.versions), confidence: resolvedConfidence, confirmation,
      evidence: Array.isArray(input.evidence) ? clone(input.evidence.slice(0,1000)) : [], userConfirmed: confirmation === 'user-confirmed',
      searchTerms: [], updatedAt: Date.now(), createdAt: input.createdAt || Date.now(),
    };
    record.searchTerms = searchTermsOf(record);
    if (this.memory) this.memory.set(id, clone(record)); else await this.#put('functions', record);
    return record;
  }

  async reject(input = {}) {
    const targetFingerprint = input.fingerprint ? fingerprintFunction(input.fingerprint) : null;
    const key = input.id || [input.sourceBinaryHash || 'unknown', input.candidateName || input.candidateIdentity || 'unknown', targetFingerprint?.semanticHash || targetFingerprint?.normalizedBytesHash || targetFingerprint?.hash || addrText(input.address)].join(':');
    const targetAddress = input.address ?? targetFingerprint?.address ?? null;
    const record = { id:key, sourceBinaryHash:input.sourceBinaryHash || 'unknown', candidateName:input.candidateName || null, candidateIdentity:input.candidateIdentity || null,
      targetHash:targetFingerprint?.hash || null, targetSemanticHash:targetFingerprint?.semanticHash || null, targetNormalizedBytesHash:targetFingerprint?.normalizedBytesHash || null,
      targetAddress:targetAddress == null ? null : addrText(targetAddress), targetSize:targetFingerprint?.size || null, reason:input.reason || 'rejected', updatedAt:Date.now() };
    if (this.negativeMemory) this.negativeMemory.set(key, clone(record)); else await this.#put('negative', record);
    return record;
  }

  async isRejected(input = {}) {
    const name = input.candidateName || null, identity = input.candidateIdentity || null;
    const fp = input.fingerprint ? fingerprintFunction(input.fingerprint) : null;
    const records = this.negativeMemory ? [...this.negativeMemory.values()] : await this.#negativeCandidates(name, identity, fp);
    return records.some((r) => {
      if (r.candidateName && r.candidateName !== name) return false;
      if (r.candidateIdentity && r.candidateIdentity !== identity) return false;
      if (fp) {
        if (r.targetHash && fp.hash && r.targetHash === fp.hash) return true;
        if (r.targetNormalizedBytesHash && fp.normalizedBytesHash && r.targetNormalizedBytesHash === fp.normalizedBytesHash) return true;
        if (r.candidateIdentity && r.targetSemanticHash && fp.semanticHash && r.targetSemanticHash === fp.semanticHash && (!r.targetSize || !fp.size || r.targetSize === fp.size)) return true;
      }
      const address = input.address ?? fp?.address ?? null;
      const sameBinary = r.sourceBinaryHash !== 'unknown' && input.sourceBinaryHash && r.sourceBinaryHash === input.sourceBinaryHash;
      return !r.targetHash && !r.targetNormalizedBytesHash && !r.targetSemanticHash && sameBinary && address != null && r.targetAddress === addrText(address);
    });
  }

  async findMatches(input, options = {}) {
    const fingerprint = fingerprintFunction(input);
    const limit = Math.min(50, Math.max(1, Number(options.limit) || 10));
    const records = this.memory ? this.#memoryCandidates(fingerprint) : await this.#candidateRecords(fingerprint, this.maxCandidates);
    const matches = [];
    for (const record of records) {
      const cmp = compareFingerprints(fingerprint, record.fingerprint);
      const confirmationBoost = record.confirmation === 'user-confirmed' || record.confirmation === 'debugger-confirmed' ? 1 : record.confirmation === 'metadata-confirmed' ? 0.98 : 0.92;
      const confidence = clamp(cmp.confidence * (0.55 + 0.45 * clamp(record.confidence)) * confirmationBoost);
      if (confidence < (options.threshold ?? 0.55) || cmp.identity === 'unrelated') continue;
      const rejected = await this.isRejected({ candidateIdentity:record.identityKey, candidateName:record.names[0], fingerprint });
      if (rejected) continue;
      matches.push({ record:clone(record), confidence, identity:cmp.identity, reasons:cmp.reasons, evidence:cmp.evidence });
    }
    matches.sort((a,b) => b.confidence - a.confidence || b.record.updatedAt - a.record.updatedAt);
    const selected = matches.slice(0,limit);
    return candidateBatch(selected, records.truncated === true || matches.length > limit);
  }

  async reidentify(input, options = {}) {
    const matches = await this.findMatches(input, { threshold:options.threshold ?? 0.58, limit:Math.max(5, options.limit || 5) });
    if (!matches.length) return { matched:false, ambiguous:matches.truncated === true, truncated:matches.truncated === true, confidence:0, candidates:[] };
    const best = matches[0], second = matches[1];
    const truncated = matches.truncated === true;
    const ambiguous = truncated || (!!second && best.confidence - second.confidence < (options.ambiguityWindow ?? 0.045));
    const accepted = !ambiguous && best.confidence >= (options.acceptThreshold ?? 0.82) && ['exact','normalized-identical','semantic-equivalent','probable-same'].includes(best.identity);
    return {
      matched:accepted, ambiguous, truncated, confidence:best.confidence, knowledge:accepted ? best.record : null, reasons:best.reasons,
      candidates:matches.map((x) => ({ id:x.record.id, names:x.record.names, roles:x.record.roles, confirmation:x.record.confirmation, confidence:x.confidence, identity:x.identity, reasons:x.reasons })),
    };
  }

  async propagate(input, options = {}) {
    const result = await this.reidentify(input, { acceptThreshold:options.threshold ?? 0.84, ambiguityWindow:options.ambiguityWindow ?? 0.035 });
    if (!result.matched) return { propagated:false, ...result };
    const source = result.knowledge;
    const status = source.confirmation === 'user-confirmed' || source.confirmation === 'debugger-confirmed' ? 'high-confidence-inferred' : 'weak-inferred';
    return { propagated:true, confidence:result.confidence, sourceId:source.id, confirmation:status,
      candidate:{ names:source.names, roles:source.roles, types:source.types, comments:source.comments, semanticLabels:source.semanticLabels, fieldInterpretations:source.fieldInterpretations }, evidence:result.reasons };
  }

  async query(text, functions = [], options = {}) {
    const q = String(text || '').trim().toLowerCase();
    if (!q) return [];
    const terms = q.split(/\s+/).filter(Boolean);
    const fps = functions.map((fn) => fingerprintFunction(fn));
    const scored = new Map();
    const addScore = (index, amount, reason, knowledge = null) => {
      const current = scored.get(index) || { function:fps[index], score:0, reasons:[], knowledge:null };
      current.score = Math.min(1, current.score + amount);
      if (reason && !current.reasons.includes(reason)) current.reasons.push(reason);
      if (knowledge) current.knowledge = knowledge;
      scored.set(index, current);
    };

    for (let i = 0; i < fps.length; i++) {
      const fp = fps[i];
      const textFields = [fp.name, ...fp.strings].filter(Boolean).map((x) => String(x).toLowerCase());
      const hits = terms.filter((term) => textFields.some((x) => x.includes(term))).length;
      if (hits) addScore(i, 0.4 * hits / terms.length, 'text');
      if (fp.semantic.writes.length && terms.some((t) => /coin|xp|experience|money|reward|経験|所持|報酬/.test(t))) addScore(i, 0.22, 'semantic-writer');
    }

    if (options.useKnowledge !== false && fps.length) {
      const records = await this.#searchKnowledgeRecords(q, terms, Math.min(100, options.knowledgeLimit || 50));
      if (records.length) {
        const index = new FunctionMatchIndex(fps);
        for (const record of records) {
          const candidateIds = index.candidates(record.fingerprint, { maxCandidates:Math.min(128, options.maxCandidates || 64) });
          for (const candidateIndex of candidateIds) {
            const cmp = compareFingerprints(record.fingerprint, fps[candidateIndex]);
            if (cmp.confidence < 0.7 || !['exact','normalized-identical','semantic-equivalent','probable-same'].includes(cmp.identity)) continue;
            const candidateName = record.names?.[0] || null;
            if (await this.isRejected({ candidateIdentity:record.identityKey, candidateName, fingerprint:fps[candidateIndex] })) continue;
            const knowledge = { id:record.id, names:record.names || [], roles:record.roles || [], confirmation:record.confirmation, confidence:cmp.confidence, identity:cmp.identity, reasons:cmp.reasons };
            addScore(candidateIndex, 0.25 * cmp.confidence, 'prior-knowledge', knowledge);
          }
        }
      }
    }
    return [...scored.values()].sort((a,b) => b.score - a.score).slice(0, Math.min(500, options.limit || 100));
  }

  async page(options = {}) {
    const limit = Math.min(500, Math.max(1, Number(options.limit) || 100));
    const after = options.after || null;
    if (this.memory) {
      const ids = [...this.memory.keys()].sort(); const found = after == null ? 0 : ids.findIndex((id) => id > after); const start = found < 0 ? ids.length : found;
      const selected = ids.slice(start, start + limit); const records = selected.map((id) => clone(this.memory.get(id)));
      return { records, nextCursor:selected.length === limit ? selected[selected.length - 1] : null };
    }
    const db = await this.#dbOpen(); const store = db.transaction('functions','readonly').objectStore('functions');
    const range = after != null && globalThis.IDBKeyRange ? globalThis.IDBKeyRange.lowerBound(after, true) : null;
    return new Promise((resolve,reject) => {
      const records=[]; let last=null; const req=store.openCursor(range);
      req.onsuccess=()=>{ const c=req.result; if (!c || records.length>=limit) return resolve({records,nextCursor:records.length===limit?last:null}); records.push(clone(c.value)); last=c.key; c.continue(); };
      req.onerror=()=>reject(req.error);
    });
  }

  async clear() {
    if (this.memory) { this.memory.clear(); this.negativeMemory?.clear(); return; }
    const db = await this.#dbOpen(); const tx = db.transaction(['functions','negative'],'readwrite');
    await Promise.all([requestPromise(tx.objectStore('functions').clear()), requestPromise(tx.objectStore('negative').clear())]);
  }

  #memoryCandidates(fp) {
    const records = [...this.memory.values()];
    const strong = records.filter((r) => (fp.normalizedBytesHash && (r.fingerprint?.normalizedBytesHash || r.fingerprint?.normalizedByteHash) === fp.normalizedBytesHash) || (fp.semanticHash && r.fingerprint?.semanticHash === fp.semanticHash) || (fp.instructionSequenceHash && r.fingerprint?.instructionSequenceHash === fp.instructionSequenceHash));
    const pool = strong.length ? strong : records.filter((r) => r.fingerprint?.size && fp.size && Math.min(r.fingerprint.size,fp.size)/Math.max(r.fingerprint.size,fp.size) >= 0.7);
    return candidateBatch(pool.slice(0,this.maxCandidates), pool.length > this.maxCandidates);
  }

  async #dbOpen() {
    if (this._db) return this._db;
    this._db = await new Promise((resolve,reject) => {
      const req = this.indexedDB.open(this.dbName, KNOWLEDGE_SCHEMA_VERSION);
      req.onupgradeneeded = () => {
        const db=req.result;
        let store;
        if (!db.objectStoreNames.contains('functions')) store=db.createObjectStore('functions',{keyPath:'id'}); else store=req.transaction.objectStore('functions');
        for (const [name,path,opts] of [['normalizedBytesHash','fingerprint.normalizedBytesHash',{}],['semanticHash','fingerprint.semanticHash',{}],['instructionSequenceHash','fingerprint.instructionSequenceHash',{}],['sourceBinaryHash','sourceBinaryHash',{}],['identityKey','identityKey',{}],['searchTerms','searchTerms',{multiEntry:true}]]) if (!store.indexNames.contains(name)) store.createIndex(name,path,{unique:false,...opts});
        let neg;
        if (!db.objectStoreNames.contains('negative')) neg=db.createObjectStore('negative',{keyPath:'id'}); else neg=req.transaction.objectStore('negative');
        if (!neg.indexNames.contains('candidateName')) neg.createIndex('candidateName','candidateName',{unique:false});
        if (!neg.indexNames.contains('candidateIdentity')) neg.createIndex('candidateIdentity','candidateIdentity',{unique:false});
      };
      req.onsuccess=()=>resolve(req.result); req.onerror=()=>reject(req.error);
    });
    return this._db;
  }
  async #put(storeName,record) { const db=await this.#dbOpen(); await requestPromise(db.transaction(storeName,'readwrite').objectStore(storeName).put(record)); }
  async #candidateRecords(fp,limit) {
    const db=await this.#dbOpen(); const store=db.transaction('functions','readonly').objectStore('functions'); const out=new Map();
    let truncated=false;
    for (const [index,value] of [['normalizedBytesHash',fp.normalizedBytesHash],['semanticHash',fp.semanticHash],['instructionSequenceHash',fp.instructionSequenceHash]]) {
      if (!value || !store.indexNames.contains(index)) continue;
      const cap=Math.min(limit,250);
      const found=await requestPromise(store.index(index).getAll(value, cap + 1));
      if (found.length > cap) truncated=true;
      for (const r of found.slice(0,cap)) out.set(r.id,r);
      if (out.size>=limit) { truncated=true; break; }
    }
    if (out.size) return candidateBatch([...out.values()].slice(0,limit), truncated || out.size > limit);
    // Bounded cursor fallback; scan one extra matching row so a cap can never be
    // mistaken for exhaustive evidence. A hard scan cap itself is truncation.
    return new Promise((resolve,reject) => {
      const rows=[]; let scanned=0; const scanCap=Math.max(2000,limit*20); const req=store.openCursor();
      req.onsuccess=()=>{ const c=req.result; if (!c || rows.length>limit || scanned>=scanCap) return resolve(candidateBatch(rows.slice(0,limit), rows.length>limit || (!!c && scanned>=scanCap))); scanned++; const r=c.value, sz=r.fingerprint?.size; if (sz && fp.size && Math.min(sz,fp.size)/Math.max(sz,fp.size)>=0.7) rows.push(r); c.continue(); };
      req.onerror=()=>reject(req.error);
    });
  }
  async #searchKnowledgeRecords(query, terms, limit) {
    if (this.memory) {
      return [...this.memory.values()].filter((record) => {
        const hay = record.searchTerms?.length ? record.searchTerms : searchTermsOf(record);
        return hay.some((value) => value.includes(query) || terms.some((term) => value.includes(term)));
      }).slice(0, limit);
    }
    const db=await this.#dbOpen(); const store=db.transaction('functions','readonly').objectStore('functions'); const out=new Map();
    if (store.indexNames.contains('searchTerms')) {
      const index=store.index('searchTerms');
      for (const term of [query,...terms]) {
        const found=await requestPromise(index.getAll(term,limit)); for (const record of found) out.set(record.id,record);
        if (out.size>=limit) break;
      }
    }
    if (!out.size) {
      await new Promise((resolve,reject) => {
        let scanned=0; const req=store.openCursor();
        req.onsuccess=()=>{ const c=req.result; if (!c || out.size>=limit || scanned>=2000) return resolve(); scanned++; const record=c.value; const hay=record.searchTerms?.length?record.searchTerms:searchTermsOf(record); if (hay.some((value)=>value.includes(query)||terms.some((term)=>value.includes(term)))) out.set(record.id,record); c.continue(); };
        req.onerror=()=>reject(req.error);
      });
    }
    return [...out.values()].slice(0,limit);
  }

  async #negativeCandidates(name,identity) {
    const db=await this.#dbOpen(); const store=db.transaction('negative','readonly').objectStore('negative');
    if (name && store.indexNames.contains('candidateName')) return requestPromise(store.index('candidateName').getAll(name,200));
    if (identity && store.indexNames.contains('candidateIdentity')) return requestPromise(store.index('candidateIdentity').getAll(identity,200));
    return [];
  }
}

export function fingerprintVendors(input = {}) {
  return recognizeLibraries(input).map((x) => ({ name:x.name, kind:x.kind, confidence:x.confidence, confirmed:false, reasons:x.evidence, classification:x.classification }));
}
