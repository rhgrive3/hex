/*
 * semantic-evidence.js — Semantic IR / runtime proof -> existing evidence fusion.
 *
 * One IR instruction is one evidence origin even when it yields read, RMW,
 * threshold and semantic facts simultaneously. This adapter de-duplicates by the
 * evidence ID/group emitted by semantic.js before handing items to fuse().
 */
import { FAMILY, GROUP, fuse } from './evidence.js';

function boundedStrength(v) {
  if (v == null || !Number.isFinite(Number(v))) return 0;
  return Math.max(0, Math.min(1, Number(v)));
}
function isExplicitSemanticProof(f, e) {
  const grade=String(f?.proofGrade || e?.proofGrade || f?.grade || e?.grade || '').toLowerCase();
  return f?.verified === true || e?.verified === true || !!(f?.verificationOrigin || e?.verificationOrigin)
    || ['verified','proof','proof-grade','deterministic'].includes(grade);
}
function runtimeCompleted(r) {
  if (!r || typeof r !== 'object') return false;
  const status=String(r.status || r.state || '').toLowerCase();
  if (r.ok === false || r.success === false || r.complete === false || r.completed === false || r.truncated === true
      || r.timedOut === true || r.timeout === true || r.budgetExceeded === true
      || ['timeout','timed-out','failed','failure','error','crashed','truncated','partial','aborted','budget-exceeded'].includes(status)) return false;
  return r.ok === true || r.success === true || r.complete === true || r.completed === true
    || ['ok','success','succeeded','complete','completed'].includes(status);
}

/**
 * Convert deterministic Semantic Facts into corroborating DATAFLOW evidence.
 * These items intentionally do not identify HP/XP/etc by themselves.
 */
export function semanticEvidenceItems(facts, opts) {
  const o = opts || {};
  const seen = new Set();
  const out = [];
  const lr = o.lr != null ? Math.max(1, Number(o.lr)) : 8;
  for (const f of facts || []) {
    for (const e of f && f.evidence || []) {
      if (!e) continue;
      const key = e.group || e.id || ('ir-row:' + String(e.row));
      if (seen.has(key)) continue;
      seen.add(key);
      const strength=boundedStrength(f.confidence);
      if (strength <= 0) continue;
      const verified=isExplicitSemanticProof(f,e);
      out.push({
        code: verified ? 'semantic-ir-proof' : 'semantic-ir-observation',
        strength,
        lr: verified ? lr : Math.min(lr, 4),
        family: verified ? FAMILY.VERIFIED : FAMILY.USAGE,
        kind: verified ? 'verified' : 'semantic',
        id: false,
        detail: {
          evidenceId: e.id || null,
          instructionId: e.instructionId == null ? null : e.instructionId,
          address: e.address == null ? null : e.address,
          row: e.row == null ? null : e.row,
          fact: f.kind || null,
          relation: f.relation || e.relation || null,
          group: GROUP.DATAFLOW,
        },
      });
    }
  }
  return out;
}

/**
 * Runtime/sandbox verification is an independent RUNTIME origin. The code prefix
 * is understood by evidence.groupOf(), so it cannot be double-counted as the
 * DATAFLOW proof that selected the same instruction.
 */
export function runtimeEvidenceItems(runtimeResult, opts) {
  if (!runtimeCompleted(runtimeResult)) return [];
  const o = opts || {};
  const out = [];
  const touched = runtimeResult.touchedFields || runtimeResult.modifiedFields || [];
  const branches = runtimeResult.takenBranches || [];
  const lr = o.lr != null ? Math.max(1, Number(o.lr)) : 18;
  const strength = boundedStrength(o.strength == null ? 1 : o.strength);
  if (strength <= 0) return [];
  const seen = new Set();
  for (const t of touched) {
    const key = 'field:' + String(t.address != null ? t.address : t.offset != null ? t.offset : t.key);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      code: 'runtime-field-verified', strength, lr,
      family: FAMILY.VERIFIED, kind: 'verified', id: false,
      detail: { ...t, group: GROUP.RUNTIME },
    });
  }
  for (const b of branches) {
    const key = 'branch:' + String(b.address != null ? b.address : b.row);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      code: 'runtime-branch-verified', strength, lr: Math.max(1, Math.sqrt(lr)),
      family: FAMILY.VERIFIED, kind: 'verified', id: false,
      detail: { ...b, group: GROUP.RUNTIME },
    });
  }
  return out;
}

export function fuseSemanticEvidence(baseItems, facts, runtimeResult, opts) {
  const items = [
    ...(baseItems || []),
    ...semanticEvidenceItems(facts, opts && opts.semantic),
    ...runtimeEvidenceItems(runtimeResult, opts && opts.runtime),
  ];
  return fuse(items, opts && opts.fuse);
}
