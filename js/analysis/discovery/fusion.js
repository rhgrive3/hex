/**
 * P7-6 — generic function-discovery fusion.
 *
 * The key rule (§12.1): **evidence producers may be target-specific; evidence
 * fusion is generic.** Nothing in this file knows what a prologue looks like,
 * what a link register is, or how any architecture encodes a call. It sees
 * typed evidence records with addresses and authority classes, and combines
 * them.
 *
 * That is not stylistic. The moment the fusion learns one architecture's
 * conventions, every other architecture's results start depending on how well
 * that one is modelled, and the cross-architecture metamorphic laws stop being
 * meaningful.
 *
 * Start and extent are fused separately and can disagree: a start can be exact
 * while its extent stays unknown, which is the correct answer far more often
 * than a single contiguous body would be.
 */

import { createAnalysisStatus } from '../status.js';
import {
  createFunctionCandidate,
  createRegion,
  hasExactStart,
  regionsOverlap,
} from './candidates.js';

export const DISCOVERY_ANALYZER_ID = 'phase7.discovery.fusion';
export const DISCOVERY_ANALYZER_VERSION = '1.0.0';

export const DISCOVERY_DEFAULT_BUDGET = Object.freeze({
  maxCandidates: 200000,
  maxEvidencePerCandidate: 64,
});

/**
 * A registry of evidence producers.
 *
 * Producers are registered per architecture (or as `generic`). The fusion calls
 * them and never inspects their internals, which is what keeps the boundary
 * one-directional.
 */
export class DiscoveryProducerRegistry {
  constructor() {
    this.producers = new Map();
  }

  register(producer) {
    if (typeof producer?.produce !== 'function') throw new TypeError('discovery-producer-must-implement-produce');
    const id = String(producer.id ?? '');
    if (!id) throw new TypeError('discovery-producer-id-required');
    this.producers.set(id, producer);
    return this;
  }

  /** Producers applicable to one architecture, in deterministic order. */
  for(architectureId) {
    return [...this.producers.values()]
      .filter((producer) => producer.architectureId == null || producer.architectureId === architectureId)
      .sort((left, right) => String(left.id).localeCompare(String(right.id)));
  }

  collect(input, architectureId, options = {}) {
    const evidence = [];
    const producerIds = [];
    for (const producer of this.for(architectureId)) {
      if (options.signal?.aborted) break;
      const produced = producer.produce(input, options) ?? [];
      for (const item of produced) evidence.push({ ...item, producerId: producer.id, architectureId: producer.architectureId ?? null });
      producerIds.push(producer.id);
    }
    return { evidence, producerIds };
  }
}

function authorityRank(authority) {
  return authority === 'authoritative' ? 2 : authority === 'corroborating' ? 1 : 0;
}

/**
 * Fuses start evidence into a state.
 *
 * One authoritative producer is enough for `exact`. Two corroborating producers
 * agreeing make `probable`. A single heuristic stays `heuristic`, which is what
 * stops a prologue scanner from manufacturing functions on its own.
 */
function fuseStartState(evidence) {
  const authoritative = evidence.filter((item) => item.authority === 'authoritative');
  const corroborating = new Set(evidence.filter((item) => item.authority === 'corroborating').map((item) => item.producerId));
  if (authoritative.length > 0) return 'exact';
  // Two independent corroborating producers agreeing is worth something; one is
  // not. A single reference into the middle of a function — a shared epilogue
  // reached by exception metadata, say — is exactly the case that would
  // otherwise be promoted to a function start it is not.
  if (corroborating.size >= 2) return 'probable';
  return 'heuristic';
}

/**
 * Fuses extent evidence.
 *
 * Disagreeing extents are a conflict and leave the extent unknown. Choosing the
 * longest, the shortest or the most popular would all be inventions, and the
 * separate extent metrics exist precisely so that leaving it unknown is not
 * punished as harshly as getting it wrong.
 */
function fuseExtent(evidence) {
  const withRegions = evidence.filter((item) => item.regions.length > 0);
  if (withRegions.length === 0) return { regions: [], state: 'unknown', conflicts: [] };

  const authoritative = withRegions.filter((item) => item.authority === 'authoritative');
  const pool = authoritative.length > 0 ? authoritative : withRegions;

  // Partial evidence describes one range of a body that may have others, so
  // several partials are unioned rather than compared. Only `complete` claims
  // are answers to the same question and therefore have to agree.
  const partial = pool.filter((item) => item.extentRole === 'partial');
  const complete = pool.filter((item) => item.extentRole !== 'partial');
  if (complete.length === 0 && partial.length > 0) {
    const merged = new Map();
    for (const item of partial) {
      for (const region of item.regions) merged.set(`${region.start}-${region.end}`, region);
    }
    const regions = [...merged.values()].sort((left, right) => (BigInt(left.start) < BigInt(right.start) ? -1 : 1));
    return {
      regions,
      state: authoritative.length > 0 ? 'exact' : 'heuristic',
      conflicts: [],
    };
  }
  const considered = complete.length > 0 ? complete : pool;

  const signatures = new Map();
  for (const item of considered) {
    const signature = item.regions.map((region) => `${region.start}-${region.end}`).join(',');
    if (!signatures.has(signature)) signatures.set(signature, { regions: item.regions, sources: [] });
    signatures.get(signature).sources.push(item.producerId);
  }

  if (signatures.size === 1) {
    const only = [...signatures.values()][0];
    return {
      regions: only.regions,
      state: authoritative.length > 0 ? 'exact' : considered.length > 1 ? 'probable' : 'heuristic',
      conflicts: [],
    };
  }

  return {
    regions: [],
    state: 'unknown',
    conflicts: [{
      kind: 'extent',
      detail: 'extent evidence disagrees',
      alternatives: [...signatures.entries()].map(([signature, entry]) => ({ signature, sources: entry.sources })),
    }],
  };
}

/**
 * Fuses all evidence into candidates.
 *
 * `evidence` is a flat list from `DiscoveryProducerRegistry.collect`, or any
 * caller that produces the same shape.
 */
export function fuseFunctionCandidates(evidence, options = {}) {
  const budget = { ...DISCOVERY_DEFAULT_BUDGET, ...(options.budget ?? {}) };
  const status = (completeness, stopReason) => createAnalysisStatus({
    snapshotId: options.snapshotId ?? 'snapshot-unbound',
    analyzerId: DISCOVERY_ANALYZER_ID,
    analyzerVersion: DISCOVERY_ANALYZER_VERSION,
    completeness,
    budgetClass: options.budgetClass ?? null,
    stopReason,
  });

  if (options.signal?.aborted) {
    return { candidates: [], status: status('partial', 'cancelled') };
  }

  const byStart = new Map();
  for (const item of evidence) {
    if (item.start == null) continue;
    const key = BigInt(item.start).toString();
    if (!byStart.has(key)) byStart.set(key, []);
    const bucket = byStart.get(key);
    if (bucket.length < budget.maxEvidencePerCandidate) bucket.push(item);
  }

  if (byStart.size > budget.maxCandidates) {
    return { candidates: [], status: status('truncated', 'budget-exhausted') };
  }

  const candidates = [];
  const starts = [...byStart.keys()].sort((left, right) => (BigInt(left) < BigInt(right) ? -1 : 1));
  for (const start of starts) {
    const bucket = byStart.get(start)
      .slice()
      .sort((left, right) => authorityRank(right.authority) - authorityRank(left.authority)
        || String(left.producerId).localeCompare(String(right.producerId)));
    const startState = fuseStartState(bucket);
    const extent = fuseExtent(bucket);
    const names = [...new Set(bucket.map((item) => item.name).filter(Boolean))];
    const conflicts = [...extent.conflicts];

    // Two authoritative sources naming the same address differently is a real
    // disagreement about what this function is, and it is recorded rather than
    // resolved by preference order.
    const authoritativeNames = [...new Set(bucket.filter((item) => item.authority === 'authoritative' && item.name).map((item) => item.name))];
    if (authoritativeNames.length > 1) {
      conflicts.push({ kind: 'name', detail: 'authoritative sources disagree about the name', alternatives: authoritativeNames });
    }

    candidates.push(createFunctionCandidate({
      start,
      name: names[0] ?? null,
      regions: extent.regions,
      startEvidence: bucket,
      extentEvidence: bucket.filter((item) => item.regions.length > 0),
      startState,
      extentState: extent.state,
      conflicts,
      architectureId: bucket.find((item) => item.architectureId)?.architectureId ?? options.architectureId ?? null,
    }));
  }

  const reconciled = reconcileOverlaps(candidates, { signal: options.signal });
  if (options.signal?.aborted) {
    return { candidates: [], status: status('partial', 'cancelled') };
  }
  return {
    candidates: reconciled,
    status: status('complete', null),
  };
}

/**
 * Marks candidates whose claimed regions overlap another candidate's start.
 *
 * A region that swallows another function's start is either a false merge or a
 * genuinely shared range (a shared epilogue, a tail-merged block). The fusion
 * cannot tell which, so it records the conflict and withdraws the extent claim
 * symmetrically instead of picking one owner (§12.3).
 */
function reconcileOverlaps(candidates, { signal = null } = {}) {
  const n = candidates.length;
  if (n <= 1) return candidates;

  const swallowed = Array.from({ length: n }, () => []);
  const overlapping = Array.from({ length: n }, () => []);

  const regions = [];
  for (let i = 0; i < n; i++) {
    for (const r of candidates[i].regions) {
      regions.push({
        candidateIndex: i,
        start: BigInt(r.start),
        end: BigInt(r.end),
      });
    }
  }

  const starts = candidates.map((c, i) => ({ candidateIndex: i, start: BigInt(c.start) }));
  starts.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));

  for (const reg of regions) {
    if (signal?.aborted) break;
    let left = 0;
    let right = starts.length;
    while (left < right) {
      const mid = (left + right) >> 1;
      if (starts[mid].start <= reg.start) left = mid + 1;
      else right = mid;
    }
    for (let k = left; k < starts.length && starts[k].start < reg.end; k++) {
      const otherIdx = starts[k].candidateIndex;
      if (otherIdx !== reg.candidateIndex) {
        swallowed[reg.candidateIndex].push(candidates[otherIdx].start);
      }
    }
  }

  const events = [];
  for (const reg of regions) {
    events.push({ point: reg.start, type: 'start', reg });
    events.push({ point: reg.end, type: 'end', reg });
  }
  events.sort((a, b) => {
    if (a.point < b.point) return -1;
    if (a.point > b.point) return 1;
    if (a.type === 'end' && b.type === 'start') return -1;
    if (a.type === 'start' && b.type === 'end') return 1;
    return 0;
  });

  const active = new Set();
  for (const ev of events) {
    if (signal?.aborted) break;
    if (ev.type === 'start') {
      for (const act of active) {
        if (act.candidateIndex !== ev.reg.candidateIndex) {
          overlapping[ev.reg.candidateIndex].push(candidates[act.candidateIndex].start);
          overlapping[act.candidateIndex].push(candidates[ev.reg.candidateIndex].start);
        }
      }
      active.add(ev.reg);
    } else {
      active.delete(ev.reg);
    }
  }

  return candidates.map((candidate, index) => {
    const sw = [...new Set(swallowed[index])].sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : 1));
    const ov = [...new Set(overlapping[index])].sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : 1));
    if (sw.length === 0 && ov.length === 0) return candidate;

    const conflicts = [...candidate.conflicts];
    if (sw.length) {
      conflicts.push({ kind: 'extent', detail: 'claimed extent contains another function start', alternatives: sw });
    }
    if (ov.length) {
      conflicts.push({ kind: 'extent', detail: 'claimed extent overlaps another candidate', alternatives: ov });
    }
    return createFunctionCandidate({
      start: candidate.start,
      name: candidate.name,
      regions: [],
      startEvidence: candidate.startEvidence,
      extentEvidence: candidate.extentEvidence,
      startState: candidate.startState,
      extentState: 'unknown',
      conflicts,
      architectureId: candidate.architectureId,
    });
  });
}

/**
 * Region evidence built from a start and a size. Producers use this so the
 * fusion never has to interpret a raw length.
 */
export function regionFromSize(start, sizeBytes, ownership = 'exclusive') {
  const begin = BigInt(start);
  const size = BigInt(sizeBytes);
  if (size <= 0n) return null;
  return createRegion({ start: begin, end: begin + size, ownership });
}

export { hasExactStart };
