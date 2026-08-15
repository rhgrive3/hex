export function genericEvidenceStatus(item) {
  const verdict = String(item?.verdict?.status || item?.verdict || item?.status || '').toLowerCase();
  if (verdict === 'contradicted') return 'contradicted';
  if (verdict === 'confirmed' || item?.confirmed === true || item?.verified === true) return 'confirmed';
  const confidence = Number(item?.confidence ?? item?.verdict?.confidence);
  if (verdict === 'supported' || (Number.isFinite(confidence) && confidence >= 0.75)) return 'likely';
  return 'unverified';
}

export function ownerEvidence(owner) {
  if (!owner) return { status: 'unverified', unique: null, candidates: [] };
  if (owner.ambiguous === true || Array.isArray(owner.owners) && owner.owners.length > 1) {
    return { status: 'likely', unique: null, candidates: (owner.owners || []).filter(Boolean) };
  }
  if (owner.className) return { status: 'confirmed', unique: owner, candidates: [owner] };
  return { status: 'unverified', unique: null, candidates: [] };
}

export function summaryEvidenceStatus(result) {
  const value = result?.summary;
  if (value && typeof value === 'object') return genericEvidenceStatus(value);
  const confidence = Number(result?.summaryConfidence);
  if (Number.isFinite(confidence) && confidence >= 0.75) return 'likely';
  return value ? 'likely' : 'unverified';
}

export function provenanceStatus(provenance) {
  if (!provenance) return 'unverified';
  if (provenance.manual || provenance.status === 'manual') return 'manual';
  if (provenance.confirmed === true) return 'confirmed';
  const confidence = Number(provenance.confidence);
  return Number.isFinite(confidence) && confidence >= 0.5 ? 'likely' : 'unverified';
}
