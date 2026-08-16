import { planAnalysisGoal } from '../query/planner.js';
import { ContextBroker } from './context/index.js';
import { EvidenceStore } from './evidence.js';
import { HypothesisStore } from './hypothesis.js';
import { ProposalStore } from './proposals.js';
import { createAgentJobManager } from './jobs/index.js';
import { InvestigationSessionStore } from './session-core/index.js';
import { sanitizeActions } from './validation.js';
import { executeTurn } from './control/turn-executor.js';
import { addressExistsSync, assertLiveBindingsUnchanged, deterministicConfidence, fallbackEvidence, presentAnswer } from './control/runtime-support.js';

const BUDGET_LIMIT_REASONS = new Set([
  'budget_exhausted',
  'model-call-budget',
  'tool-call-budget',
  'tool-cost-budget',
]);

export class AIRuntime {
  constructor(options = {}) {
    this.localContext = options.context || {};
    this.provider = options.provider || null;
    this.sessionStore = options.sessionStore || new InvestigationSessionStore({ persistence: options.persistence });
    this.evidenceStore = options.evidenceStore || new EvidenceStore();
    this.hypothesisStore = options.hypothesisStore || new HypothesisStore(this.evidenceStore);
    this.proposalStore = options.proposalStore || new ProposalStore({ evidenceStore: this.evidenceStore, binding: () => proposalBinding(this.localContext) });
    this.initialStores = { evidenceStore: this.evidenceStore, hypothesisStore: this.hypothesisStore, proposalStore: this.proposalStore };
    this.storeNamespaces = new Map();
    this.contextBroker = options.contextBroker || new ContextBroker(this.localContext, options.contextOptions);
    this.planner = options.planner === false ? null : (options.planner || planAnalysisGoal);
    this.development = !!options.development;
    this.activeControllers = new Set();
    this.jobs = createAgentJobManager({ runtime: this, persistence: options.jobPersistence, maxSlices: options.maxJobSlices, maxElapsedMs: options.maxJobElapsedMs });
  }

  storesFor(session, binaryId) {
    const key = `${binaryId == null ? '<none>' : String(binaryId)}::${String(session.id)}`;
    let stores = this.storeNamespaces.get(key);
    if (stores) return stores;
    if (this.storeNamespaces.size === 0) stores = this.initialStores;
    else {
      const evidenceStore = new EvidenceStore(session.confirmedFindings || []);
      const hypothesisStore = new HypothesisStore(evidenceStore, session.hypotheses || []);
      stores = { evidenceStore, hypothesisStore, proposalStore: new ProposalStore({ evidenceStore, binding: () => proposalBinding(this.localContext) }) };
    }
    this.storeNamespaces.set(key, stores);
    return stores;
  }

  async turn(input = {}, options = {}) { return executeTurn.call(this, input, options); }
  async createJob(input = {}) { return this.jobs.create(input); }
  async runJobSlice(jobOrId, options = {}) { return this.jobs.runSlice(jobOrId, options); }
  async resumeJob(id, options = {}) { return this.jobs.resume(id, options); }

  finalize({ request, decision, plan, activity, modelCalls, toolCalls, contextBytes, wireUsage, started, limitReason, registry, snapshot, effectiveScope }) {
    // The final model call can overlap a workbench binary/project/runtime switch
    // without another tool execution. Re-check the turn binding before any
    // live-context validation (notably suggested action addresses) so finalization
    // cannot mix a snapshotted investigation with the newly visible binary.
    assertLiveBindingsUnchanged(this.localContext, snapshot);
    const requestedEvidence = Array.from(new Set((decision.evidenceIds || []).map(String)));
    const evidence = requestedEvidence.map((id) => this.evidenceStore.get(id)).filter(Boolean);
    const missingIds = requestedEvidence.filter((id) => !this.evidenceStore.has(id));
    if (missingIds.length) activity.push({ type: 'consistency-check', label: `${missingIds.length} 件の存在しない evidence 参照を除外`, timestamp: new Date().toISOString() });
    const finalEvidence = evidence.length ? evidence : fallbackEvidence(this.evidenceStore, plan);
    for (const modelHypothesis of decision.hypotheses || []) this.hypothesisStore.upsert(modelHypothesis);
    const hypothesisIds = new Set((decision.hypothesisIds || []).map(String));
    const hypotheses = hypothesisIds.size ? this.hypothesisStore.all().filter((item) => hypothesisIds.has(item.id)) : this.hypothesisStore.all();
    const actions = sanitizeActions(decision.suggestedActions, { evidenceStore: this.evidenceStore, proposalStore: this.proposalStore, addressExists: (address) => addressExistsSync(this.localContext, address) });
    let confidence = Number.isFinite(decision.confidence) ? Math.max(0, Math.min(1, decision.confidence)) : deterministicConfidence(plan);
    if (!finalEvidence.length) confidence = Math.min(confidence, 0.5);
    const budgetReason = BUDGET_LIMIT_REASONS.has(limitReason) ? limitReason : null;
    return {
      mode: request.mode, style: request.style,
      answer: presentAnswer(String(decision.answer || ''), request.style, finalEvidence, plan), confidence, evidence: finalEvidence, hypotheses, actions,
      followups: (decision.followups || []).map(String).slice(0, 8), activity,
      usage: { modelCalls, toolCalls, elapsedMs: Date.now() - started, contextBytes, ...wireUsage, candidateCount: plan?.candidates?.length || 0, analyzedFunctions: plan?.stats?.analyzedFunctions || 0, disassembly: Math.max(plan?.stats?.disassembly || 0, registry.analysisStats?.disassembly || 0), toolCost: registry.accounting.cost },
      scope: { requested: request.scope, effective: effectiveScope }, turnSnapshotId: snapshot.id,
      limits: { exhausted: !!budgetReason, reason: budgetReason || undefined },
    };
  }

  cancel() { for (const controller of this.activeControllers) controller.abort('cancelled'); this.activeControllers.clear(); if (this.provider && typeof this.provider.cancel === 'function') this.provider.cancel(); }
}

export function createAIRuntime(options) { return new AIRuntime(options); }

function proposalBinding(context) {
  return {
    binaryId: context?.binaryId == null ? null : String(context.binaryId),
    projectId: context?.projectId == null ? null : String(context.projectId),
    runtimeSessionId: context?.runtimeSessionId == null ? null : String(context.runtimeSessionId),
  };
}
