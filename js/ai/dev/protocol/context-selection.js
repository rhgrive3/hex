/* Deterministic, host-side context selection.

   The goal is not a smaller packet. It is the smallest packet that still
   contains everything the next decision actually needs -- which means the
   correctness-critical parts are the ones this module is forbidden to touch.
   Objective, constraints, forbidden actions, stop conditions, unknowns, negative
   evidence and required authoritative facts are never dropped to hit a byte
   target; if they do not fit, that is a blocker, not a smaller packet.

   Everything here is pure host-side computation: no model call, no summarizer,
   no embedding, no retrieval, no vector store, no persistence. Selection that
   needs semantic judgement is not done at all -- the context is kept instead.
*/

export const DEV_CONTEXT_SELECTION_SCHEMA = 'hex-dev-context-selection/v1';

/* Why an item was left out, so an omission is always inspectable. */
export const DEV_OMISSION_REASON = Object.freeze({
  DUPLICATE: 'duplicate',
  SUPERSEDED: 'superseded',
  ALREADY_COVERED: 'already-covered',
  EXCERPT_OVER_BUDGET: 'excerpt-over-budget',
  OVER_BUDGET: 'over-budget',
});

export const DEV_SELECTION_BLOCKER = Object.freeze({
  CONTEXT_BUDGET_TOO_SMALL: 'context-budget-too-small',
});

/* The engine uses a bounded default; callers may still pass null explicitly
   when they are proving an unbounded selection. The pure selector itself keeps
   its null default so it never invents a transport policy. */
export const DEV_DEFAULT_CONTEXT_BUDGET_BYTES = 32 * 1024;

/* Priority order. Lower number is selected first and dropped last. */
const OPTIONAL_TIERS = ['dependencyResults', 'artifactRefs', 'contextDelta'];
const UTF8_ENCODER = typeof TextEncoder === 'function' ? new TextEncoder() : null;

export function selectDevContext({ packet, budgetBytes = null, expandEvidenceRefs = [] } = {}) {
  if (!packet || typeof packet !== 'object') throw new TypeError('Context selection requires a ContextPacket.');
  const budget = normalizeBudget(budgetBytes);
  const expand = new Set((Array.isArray(expandEvidenceRefs) ? expandEvidenceRefs : [expandEvidenceRefs]).map((value) => String(value || '')).filter(Boolean));
  const omitted = [];

  const { facts, superseded } = resolveFacts(packet.authoritativeFacts || [], omitted);
  /* Evidence a compact result already accounts for is not injected a second
     time -- unless this task explicitly asked to expand it, which is the audit
     path. Coverage is only honoured when the compact item states it; nothing is
     inferred. */
  /* Coverage only suppresses an artifact after the compact representation that
     declared the coverage actually survived selection. */
  const covered = coveredRefs(packet, expand);

  // Tiers 1 and 2. These are the reason the packet exists; they are never
  // dropped for budget.
  const core = {
    schemaVersion: packet.schemaVersion,
    orchestrationRunId: packet.orchestrationRunId ?? null,
    graphId: packet.graphId ?? null,
    taskId: packet.taskId,
    attempt: packet.attempt ?? null,
    leaseId: packet.leaseId ?? null,
    role: packet.role ?? null,
    objective: packet.objective,
    successCriteria: [...(packet.successCriteria || [])],
    scope: packet.scope ?? null,
    constraints: [...(packet.constraints || [])],
    forbiddenActions: [...(packet.forbiddenActions || [])],
    stopConditions: [...(packet.stopConditions || [])],
    authoritativeFacts: facts,
    unknowns: [...(packet.unknowns || [])],
    knownFailures: [...(packet.knownFailures || [])],
    requiredEvidence: [...(packet.requiredEvidence || [])],
    budget: packet.budget ?? null,
    dependencyResults: [],
    artifactRefs: [],
    contextDelta: [],
  };

  let bytes = byteLength(core);
  if (budget != null && bytes > budget) {
    // Refusing is the correct outcome: the alternative is silently deleting
    // something the decision depends on and calling it success.
    return Object.freeze({
      schemaVersion: DEV_CONTEXT_SELECTION_SCHEMA,
      packet: freezeDeepCopy(core),
      omitted: Object.freeze(omitted),
      supersededFacts: Object.freeze(superseded),
      bytes,
      budgetBytes: budget,
      blocker: Object.freeze({
        code: DEV_SELECTION_BLOCKER.CONTEXT_BUDGET_TOO_SMALL,
        message: `Correctness-critical context needs ${bytes} bytes but the budget is ${budget}.`,
      }),
    });
  }

  for (const tier of OPTIONAL_TIERS) {
    for (const item of candidates(tier, packet, covered, omitted)) {
      const cost = byteLength(item.value) + 1;
      if (budget != null && bytes + cost > budget) {
        // Prefer a reference over bulk content before giving the item up.
        const reduced = item.reduce?.();
        const reducedCost = reduced ? byteLength(reduced) + 1 : null;
        if (reduced && budget != null && bytes + reducedCost <= budget) {
          core[tier].push(reduced);
          bytes += reducedCost;
          omitted.push(omission(item.ref, DEV_OMISSION_REASON.EXCERPT_OVER_BUDGET, tier));
          continue;
        }
        omitted.push(omission(item.ref, DEV_OMISSION_REASON.OVER_BUDGET, tier));
        continue;
      }
      core[tier].push(item.value);
      bytes += cost;
      if (tier === 'dependencyResults') {
        for (const ref of item.value?.coveredEvidenceRefs || []) {
          const normalized = String(ref);
          if (!expand.has(normalized)) covered.add(normalized);
        }
      }
    }
  }

  bytes = byteLength(core);
  // JSON key overhead can push the total past the estimate; give back the
  // lowest-priority items until it genuinely fits.
  while (budget != null && bytes > budget) {
    const tier = [...OPTIONAL_TIERS].reverse().find((name) => core[name].length > 0);
    if (!tier) break;
    const dropped = core[tier].pop();
    omitted.push(omission(refOf(dropped), DEV_OMISSION_REASON.OVER_BUDGET, tier));
    bytes = byteLength(core);
  }

  return Object.freeze({
    schemaVersion: DEV_CONTEXT_SELECTION_SCHEMA,
    packet: freezeDeepCopy(core),
    omitted: Object.freeze(omitted),
    supersededFacts: Object.freeze(superseded),
    bytes,
    budgetBytes: budget,
    blocker: null,
  });
}

/* Exact duplicates collapse, and an explicitly superseded fact loses to the one
   that supersedes it. Both are deterministic; nothing is judged by meaning. The
   loser is never erased -- it is returned as audit evidence, and the winner
   keeps its supersedes/conflictsWith so the conflict stays inspectable. */
function resolveFacts(input, omitted) {
  const facts = [...input];
  const supersededKeys = new Set();
  for (const fact of facts) {
    /* A Worker/cache observation is evidence, not authority. Only the
       host-bound owning-system fact may cause another fact to be suppressed. */
    if (!isOwningSystemFact(fact)) continue;
    for (const key of fact?.supersedes || []) supersededKeys.add(String(key));
  }

  const byStatement = new Map();
  const kept = [];
  const superseded = [];
  for (const fact of facts) {
    if (!fact?.statement) continue;
    if (supersededKeys.has(fact.statement) || (fact.source && supersededKeys.has(fact.source))) {
      superseded.push({ ...fact, omissionReason: DEV_OMISSION_REASON.SUPERSEDED });
      omitted.push(omission(fact.statement, DEV_OMISSION_REASON.SUPERSEDED, 'authoritativeFacts'));
      continue;
    }
    const existing = byStatement.get(fact.statement);
    if (!existing) {
      byStatement.set(fact.statement, fact);
      kept.push(fact);
      continue;
    }
    // Same statement twice: the fresher owning-system observation wins.
    const winner = fresher(existing, fact);
    const loser = winner === existing ? fact : existing;
    superseded.push({ ...loser, omissionReason: DEV_OMISSION_REASON.DUPLICATE });
    omitted.push(omission(loser.statement, DEV_OMISSION_REASON.DUPLICATE, 'authoritativeFacts'));
    if (winner !== existing) {
      byStatement.set(fact.statement, winner);
      kept[kept.indexOf(existing)] = winner;
    }
  }
  return { facts: kept, superseded };
}

function fresher(a, b) {
  // A cache or Worker report can never replace an owning-system observation,
  // even if its caller supplied a later timestamp. Timestamps only order facts
  // after the authority boundary has been respected.
  const aOwning = isOwningSystemFact(a);
  const bOwning = isOwningSystemFact(b);
  if (aOwning !== bOwning) return aOwning ? a : b;

  const at = Date.parse(a?.observedAt || '');
  const bt = Date.parse(b?.observedAt || '');
  if (Number.isFinite(at) && Number.isFinite(bt) && at !== bt) return at > bt ? a : b;
  if (Number.isFinite(bt) && !Number.isFinite(at)) return b;
  if (Number.isFinite(at) && !Number.isFinite(bt)) return a;
  return a;
}

function isOwningSystemFact(fact) {
  return fact?.authority === 'owning-system';
}

/* Only coverage that a compact item actually declared. If nothing states that a
   summary covers a ref, both are kept: guessing coverage is how evidence goes
   missing. */
function coveredRefs(packet, expand) {
  const covered = new Set();
  for (const ref of packet.coveredEvidenceRefs || []) covered.add(String(ref));
  for (const ref of expand) covered.delete(ref);
  return covered;
}

function candidates(tier, packet, covered, omitted) {
  if (tier === 'dependencyResults') {
    return (packet.dependencyResults || []).map((value) => ({ value, ref: value?.taskId || null, reduce: null }));
  }
  if (tier === 'artifactRefs') {
    const out = [];
    for (const value of packet.artifactRefs || []) {
      const ref = refOf(value);
      if (ref && covered.has(ref)) {
        omitted.push(omission(ref, DEV_OMISSION_REASON.ALREADY_COVERED, tier));
        continue;
      }
      // A reference is the cheap form; the excerpt is the part worth dropping.
      out.push({ value, ref, reduce: () => (value?.excerpt ? { ...value, excerpt: null } : null) });
    }
    return out;
  }
  return (packet.contextDelta || []).map((value) => ({ value, ref: value?.statement || null, reduce: null }));
}

function omission(ref, reason, tier) {
  return { ref: ref == null ? null : String(ref).slice(0, 256), reason, section: tier };
}
function refOf(value) {
  if (typeof value === 'string') return value;
  return value?.ref ?? value?.taskId ?? value?.statement ?? null;
}
function normalizeBudget(value) {
  if (value == null) return null;
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) throw new TypeError('Context budget must be a positive number of bytes.');
  return Math.floor(number);
}
/* Characters, not tokens: a tokenizer dependency is not worth its weight on iOS
   and a byte budget is what the transport actually cares about. */
function byteLength(value) {
  const json = JSON.stringify(value) ?? '';
  if (UTF8_ENCODER) return UTF8_ENCODER.encode(json).byteLength;
  let bytes = 0;
  for (const character of json) {
    const codePoint = character.codePointAt(0);
    bytes += codePoint <= 0x7f ? 1 : codePoint <= 0x7ff ? 2 : codePoint <= 0xffff ? 3 : 4;
  }
  return bytes;
}
/* Copies rather than freezing in place: the incoming packet is already frozen
   and belongs to the caller, so the selection must never write through to it. */
function freezeDeepCopy(value) {
  if (Array.isArray(value)) return Object.freeze(value.map(freezeDeepCopy));
  if (value && typeof value === 'object') {
    const copy = {};
    for (const key of Object.keys(value)) copy[key] = freezeDeepCopy(value[key]);
    return Object.freeze(copy);
  }
  return value;
}
