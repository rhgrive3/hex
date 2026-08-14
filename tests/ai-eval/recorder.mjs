/*
 * Small, model-independent instrumentation helper for the AI evaluation gate.
 * It records factual execution telemetry only. Do not put model chain-of-thought,
 * raw binary bytes, secrets, or full unbounded tool results into this object.
 */

const hex = (value) => {
  if (typeof value === 'bigint') return `0x${value.toString(16)}`;
  if (typeof value !== 'string') return null;
  const s = value.trim().toLowerCase();
  if (!/^0x[0-9a-f]+$/.test(s)) return null;
  try { return `0x${BigInt(s).toString(16)}`; } catch { return null; }
};

export function createEvaluationRecorder(caseId) {
  const started = Date.now();
  const toolCalls = [];
  const addresses = new Set();
  let modelCalls = 0;
  let binaryUploadBytes = 0;
  let contextBytes = 0;
  let scopeViolation = false;
  let appliedMutations = 0;
  let userApproved = false;
  let toolCallsTriggeredByInjectedData = 0;
  let clarificationAsked = false;
  let sessionEvidencePreserved = false;
  let stopReason = '';

  const api = {
    modelCall(meta = {}) {
      modelCalls += 1;
      if (Number.isFinite(meta.contextBytes)) contextBytes = Math.max(contextBytes, Number(meta.contextBytes));
      if (Number.isFinite(meta.binaryUploadBytes)) binaryUploadBytes += Number(meta.binaryUploadBytes);
    },
    toolCall(name, meta = {}) {
      toolCalls.push({
        name: String(name || ''),
        deterministic: meta.deterministic !== false,
        evidenceIds: Array.isArray(meta.evidenceIds) ? meta.evidenceIds.slice(0, 128) : [],
      });
      for (const value of Array.isArray(meta.addresses) ? meta.addresses : []) {
        const normalized = hex(value);
        if (normalized) addresses.add(normalized);
      }
      if (meta.triggeredByInjectedData === true) toolCallsTriggeredByInjectedData += 1;
    },
    observeAddress(value) { const normalized = hex(value); if (normalized) addresses.add(normalized); },
    noteScopeViolation(value = true) { scopeViolation = !!value; },
    noteMutationApplied(count = 1) { appliedMutations += Math.max(0, Number(count) || 0); },
    noteUserApproval(value = true) { userApproved = !!value; },
    noteClarification(value = true) { clarificationAsked = !!value; },
    noteSessionEvidencePreserved(value = true) { sessionEvidencePreserved = !!value; },
    stop(reason) { stopReason = String(reason || ''); },
    finish(result, extraObserved = {}) {
      return {
        caseId,
        result,
        trace: { modelCalls, toolCalls, ...(stopReason ? { stopReason } : {}) },
        observed: {
          addresses: Array.from(addresses),
          binaryUploadBytes,
          contextBytes,
          scopeViolation,
          appliedMutations,
          userApproved,
          toolCallsTriggeredByInjectedData,
          clarificationAsked,
          sessionEvidencePreserved,
          ...(stopReason ? { stopReason } : {}),
          elapsedMs: Date.now() - started,
          ...extraObserved,
        },
      };
    },
  };
  return api;
}
