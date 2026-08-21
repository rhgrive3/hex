import { HYPOTHESIS_STATUSES } from './schema.js';

let sequence = 1;
const DETERMINISTIC_HYPOTHESIS = Symbol('deterministic-hypothesis');

export class HypothesisStore {
  constructor(evidenceStore, initial = []) {
    this.evidenceStore = evidenceStore;
    this.records = new Map();
    /* Persisted application state is restored through the trusted path, but still
       has to satisfy verified-evidence requirements below. */
    for (const item of initial) this.upsert(item, DETERMINISTIC_HYPOTHESIS);
  }

  upsert(input = {}, authority = null) {
    const now = new Date().toISOString();
    let id;
    if (input.id) {
      id = String(input.id);
    } else {
      // Explicit IDs restored from persistence may occupy generated sequence slots.
      do id = `hyp_${sequence++}`;
      while (this.records.has(id));
    }
    const previous = this.records.get(id);

    /* A model may refer to hypothesis IDs, but it must never rewrite the claim
       attached to a terminal deterministic verdict. */
    if (previous && (previous.status === 'verified' || previous.status === 'rejected') && authority !== DETERMINISTIC_HYPOTHESIS) {
      return previous;
    }

    const supportEvidenceIds = knownIds(input.supportEvidenceIds, this.evidenceStore);
    const contradictionEvidenceIds = knownIds(input.contradictionEvidenceIds, this.evidenceStore);
    let status = HYPOTHESIS_STATUSES.includes(input.status) ? input.status : 'open';

    /* `verified` and `rejected` are application verdicts, not model vocabulary.
       Even a real verified evidence ID cannot prove that an arbitrary new claim
       is semantically supported by that evidence. Only verify()/reject() can
       create terminal hypothesis states. */
    if ((status === 'verified' || status === 'rejected') && authority !== DETERMINISTIC_HYPOTHESIS) {
      status = supportEvidenceIds.length ? 'supported' : 'open';
    }

    if (status === 'verified') {
      if (!supportEvidenceIds.length || supportEvidenceIds.some((evidenceId) => this.evidenceStore.get(evidenceId)?.status !== 'verified')) {
        status = supportEvidenceIds.length ? 'supported' : 'open';
      }
    }
    if (status === 'rejected') {
      if (!contradictionEvidenceIds.length || contradictionEvidenceIds.some((evidenceId) => this.evidenceStore.get(evidenceId)?.status !== 'verified')) {
        status = 'open';
      }
    }
    if (status === 'supported' && !supportEvidenceIds.length) status = 'open';
    if (contradictionEvidenceIds.length && status !== 'rejected') status = 'open';

    const record = {
      id,
      claim: String(input.claim || previous?.claim || '').slice(0, 3000),
      confidence: clamp(input.confidence ?? previous?.confidence ?? 0.5),
      status,
      supportEvidenceIds,
      contradictionEvidenceIds,
      missingEvidence: (Array.isArray(input.missingEvidence) ? input.missingEvidence : previous?.missingEvidence || []).map(String).slice(0, 50),
      createdAt: previous?.createdAt || input.createdAt || now,
      updatedAt: now,
    };
    if (!record.claim) return null;
    this.records.set(id, record);
    return record;
  }

  reject(id, contradictionEvidenceIds = []) {
    const current = this.records.get(String(id));
    if (!current) return null;
    return this.upsert({ ...current, status: 'rejected', contradictionEvidenceIds }, DETERMINISTIC_HYPOTHESIS);
  }

  verify(id, evidenceIds) {
    const current = this.records.get(String(id));
    if (!current) return null;
    return this.upsert({ ...current, status: 'verified', supportEvidenceIds: evidenceIds }, DETERMINISTIC_HYPOTHESIS);
  }

  get(id) { return this.records.get(String(id)) || null; }
  all() { return Array.from(this.records.values()); }
}

function knownIds(ids, store) {
  return Array.from(new Set((Array.isArray(ids) ? ids : []).map(String).filter((id) => store && store.has(id))));
}

function clamp(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0.5;
}
