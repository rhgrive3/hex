import { AIError } from "../schema.js";
import { assertSchema, addressText, jsonSafe } from "../validation.js";
import { ObservationStore } from "./storage/observation-store.js";
import { completenessOf, projectBounded } from "./projections/index.js";

export const COST_WEIGHT = Object.freeze({ cheap: 1, medium: 4, expensive: 12 });
export const ADDRESS_KEYS = new Set(["address", "functionAddress", "from", "to", "start", "end", "target"]);

export class ToolRegistry {
  constructor({ context = {}, evidenceStore = null, onActivity = null, observationStore = null } = {}) {
    this.context = context;
    this.evidenceStore = evidenceStore;
    this.onActivity = onActivity;
    this.observationStore = observationStore || new ObservationStore({ context });
    if (this.evidenceStore?.setObservationStore) this.evidenceStore.setObservationStore(this.observationStore);
    this.tools = new Map();
    this.accounting = { calls: 0, cost: 0, elapsedMs: 0, failures: 0, cacheHits: 0 };
    this.executionSignal = null;
  }

  register(definition) {
    if (!definition || !/^[a-z][a-z0-9_]{1,63}$/.test(definition.name || "")) throw new Error("invalid-tool-definition");
    if (this.tools.has(definition.name)) throw new Error(`duplicate-tool:${definition.name}`);
    if (typeof definition.execute !== "function") throw new Error(`tool-execute-required:${definition.name}`);
    this.tools.set(definition.name, Object.freeze({
      description: "", inputSchema: { type: "object" }, outputSchema: null, cost: "cheap",
      scopeSupport: ["auto", "binary", "project"], mutability: "read-only", needsApproval: false,
      category: "discovery", preferredPrerequisites: [], resultKind: "observation",
      deterministic: true, storeResult: true, modelProjection: projectBounded,
      ...definition,
    }));
    return this;
  }

  has(name) { return this.tools.has(String(name)); }
  get(name) { return this.tools.get(String(name)) || null; }
  costWeight(name) { return COST_WEIGHT[this.get(name)?.cost] || 1; }
  names({ scope = "auto", includeMutations = false } = {}) {
    return Array.from(this.tools.values()).filter((tool) => (scope === "auto" || tool.scopeSupport.includes(scope)) && (includeMutations || tool.mutability === "read-only")).map((tool) => tool.name);
  }
  definitionsForModel(options = {}) {
    return this.names(options).map((name) => {
      const tool = this.get(name);
      return {
        name: tool.name, description: tool.description, inputSchema: tool.inputSchema, cost: tool.cost,
        scopeSupport: tool.scopeSupport, mutability: tool.mutability, needsApproval: tool.needsApproval,
        category: tool.category, preferredPrerequisites: tool.preferredPrerequisites, resultKind: tool.resultKind,
      };
    });
  }

  async execute(name, args = {}, options = {}) {
    const tool = this.get(name);
    if (!tool) throw new AIError("invalid_tool_call", `Unknown tool: ${name}`);
    if (options.signal?.aborted) throw abortError(options.signal);
    assertSchema(args, tool.inputSchema, "invalid_tool_call");
    this.assertScope(tool, args, options.scope || "auto");
    await this.assertAddresses(args, options.scope || "auto");
    if (tool.mutability !== "read-only" || tool.needsApproval) throw new AIError("approval_required", `${name} cannot execute from the model tool loop.`);
    const started = Date.now();
    this.activity({ type: "tool-start", tool: name, label: `${name} を実行中` });
    const previousSignal = this.executionSignal;
    this.executionSignal = options.signal || null;
    try {
      let record = null;
      let raw;
      let cached = false;
      if (tool.storeResult !== false && tool.deterministic !== false) {
        record = this.observationStore.getCached(name, args);
        if (record) { raw = record.fullResult; cached = true; this.accounting.cacheHits++; }
      }
      if (!record) {
        raw = await raceAbort(tool.execute(args, { ...options, context: this.context }), options.signal);
        if (tool.outputSchema) assertSchema(raw, tool.outputSchema, "tool_failed");
        const lifecycle = raw?.solverResult?.lifecycle || raw?.lifecycle || {};
        const publishable = lifecycle.publishable !== false && lifecycle.late !== true;
        if (publishable && tool.storeResult !== false) {
          record = this.observationStore.put({
            tool: name, arguments: jsonSafe(args), fullResult: raw,
            functionIdentity: args.functionAddress ?? args.address ?? null,
            deterministic: tool.deterministic !== false,
          });
        }
      }
      const result = jsonSafe(raw);
      const sourceRef = record ? { detailRef: record.id, path: "$", bindingKey: record.binding.key } : null;
      let evidence = record?.evidence || null;
      const resultLifecycle = raw?.solverResult?.lifecycle || raw?.lifecycle || {};
      const resultPublishable = resultLifecycle.publishable !== false && resultLifecycle.late !== true;
      if (resultPublishable && !evidence) {
        evidence = this.evidenceStore ? this.evidenceStore.ingest(name, result, { verifier: tool.verifier === true, sourceRef }) : [];
        if (record) record.evidence = evidence;
      }
      const evidenceList = Array.isArray(evidence) ? evidence : [];
      const evidenceIds = evidenceList.map((item) => item.id);
      const completeness = completenessOf(result);
      const continuation = result?.continuation?.cursor ? { cursor: result.continuation.cursor } : null;
      const detailRef = record?.id || result?.detailRef || null;
      const projectionMeta = { detailRef, completeness, continuation, evidenceIds, context: this.context, tool };
      const modelData = jsonSafe(tool.modelProjection(result, projectionMeta));
      const elapsedMs = Date.now() - started;
      this.accounting.calls++;
      this.accounting.cost += cached ? 0 : (COST_WEIGHT[tool.cost] || 1);
      this.accounting.elapsedMs += elapsedMs;
      const summary = summarizeToolResult(name, result);
      this.activity({ type: "tool-result", tool: name, label: summary, count: resultCount(result), elapsedMs, cached });
      return {
        tool: name, result, modelData, summary,
        completeness, ...(continuation ? { continuation } : {}), ...(detailRef ? { detailRef } : {}),
        evidence: evidenceList, evidenceIds, cost: tool.cost, elapsedMs, ...(cached ? { cached: true } : {}),
      };
    } catch (error) {
      this.accounting.failures++;
      if (error instanceof AIError) throw error;
      const message = error?.message || String(error);
      if (message === "cancelled" || options.signal?.aborted) throw new AIError("cancelled", "AI investigation was cancelled.");
      if (message === "timeout") throw new AIError("tool_failed", `${name} timed out.`, { cause: message });
      if (/^(invalid-cursor|stale-cursor|cursor-|unknown-detail-ref|stale-detail-ref|detail-path|invalid-detail-path)/.test(message)) {
        throw new AIError("invalid_tool_call", `${name} rejected stale or invalid retrieval state.`, { cause: message });
      }
      throw new AIError("tool_failed", `${name} failed: ${message}`);
    } finally {
      this.executionSignal = previousSignal;
    }
  }

  assertScope(tool, args, scope) {
    if (scope !== "auto" && !tool.scopeSupport.includes(scope)) throw new AIError("scope_violation", `${tool.name} is outside the explicit ${scope} scope.`);
    if (typeof this.context.scopeAllowsTool === "function" && !this.context.scopeAllowsTool(scope, tool.name, args)) throw new AIError("scope_violation", `${tool.name} was rejected by the local scope boundary.`);
  }

  async assertAddresses(args, scope) {
    for (const address of collectAddresses(args)) {
      if (typeof this.context.addressExists === "function" && !await this.context.addressExists(address)) throw new AIError("invalid_tool_call", `Address does not exist: ${address}`);
      if (scope !== "auto" && typeof this.context.scopeContainsAddress === "function" && !await this.context.scopeContainsAddress(scope, address)) throw new AIError("scope_violation", `Address ${address} is outside ${scope} scope.`);
    }
  }

  activity(event) {
    if (typeof this.onActivity === "function") this.onActivity({ ...event, timestamp: event.timestamp || new Date().toISOString() });
  }
}

export function collectAddresses(value) {
  const out = [];
  if (!value || typeof value !== "object") return out;
  for (const [key, item] of Object.entries(value)) {
    if ((ADDRESS_KEYS.has(key) || /Address$/.test(key)) && typeof item === "string" && addressText(item)) out.push(addressText(item));
    else if (item && typeof item === "object") out.push(...collectAddresses(item));
  }
  return out;
}

export function summarizeToolResult(name, result) {
  const count = resultCount(result);
  if (count != null) return `${name}: ${count} 件${result?.truncated ? "（続きあり）" : ""}`;
  if (result?.verified === true) return `${name}: 検証済み`;
  if (result?.found === false) return `${name}: 対象なし`;
  return `${name}: 完了`;
}

export function resultCount(result) {
  if (Number.isFinite(result?.returned)) return result.returned;
  for (const key of ["results", "sites", "functions", "updates", "nodes", "paths", "blocks"]) if (Array.isArray(result?.[key])) return result[key].length;
  return null;
}

export async function raceAbort(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) throw abortError(signal);
  let onAbort;
  const aborted = new Promise((_, reject) => { onAbort = () => reject(abortError(signal)); signal.addEventListener("abort", onAbort, { once: true }); });
  try { return await Promise.race([promise, aborted]); }
  finally { signal.removeEventListener("abort", onAbort); }
}

export function abortError(signal) {
  return signal?.reason === "timeout" ? new AIError("budget_exhausted", "The tool execution exceeded the turn timeout.") : new AIError("cancelled", "AI investigation was cancelled.");
}
