import { planAnalysisGoal } from '../query/planner.js';
import { ContextBroker } from './context/index.js';
import { EvidenceStore } from './evidence.js';
import { HypothesisStore } from './hypothesis.js';
import { ProposalStore } from './proposals.js';
import { aiBudget, AIError } from './schema.js';
import { InvestigationSessionStore } from './session-core/index.js';
import { createHexToolRegistry } from './tools/index.js';
import { normalizeTurnRequest, sanitizeActions, validateAIResult, validateModelDecision } from './validation.js';

const BROAD_TOOL_SCOPE = Object.freeze({
  search_functions: 'binary', search_strings: 'binary', project_search: 'project', compare_functions: 'binary',
  get_related_functions: 'neighborhood', get_runtime_observations: 'runtime', verify_runtime_hypothesis: 'runtime', get_binary_diff: 'project',
});
const SCOPE_RANK = Object.freeze({ selection: 0, function: 1, neighborhood: 2, binary: 3, project: 4, runtime: 5 });

export class AIRuntime {
  constructor(options = {}) {
    this.localContext = options.context || {};
    this.provider = options.provider || null;
    this.sessionStore = options.sessionStore || new InvestigationSessionStore({ persistence: options.persistence });
    this.evidenceStore = options.evidenceStore || new EvidenceStore();
    this.hypothesisStore = options.hypothesisStore || new HypothesisStore(this.evidenceStore);
    this.proposalStore = options.proposalStore || new ProposalStore({ evidenceStore: this.evidenceStore });
    this.initialStores = {
      evidenceStore: this.evidenceStore,
      hypothesisStore: this.hypothesisStore,
      proposalStore: this.proposalStore,
    };
    this.storeNamespaces = new Map();
    this.contextBroker = options.contextBroker || new ContextBroker(this.localContext, options.contextOptions);
    this.planner = options.planner === false ? null : (options.planner || planAnalysisGoal);
    this.development = !!options.development;
    this.activeControllers = new Set();
  }

  storesFor(session, binaryId) {
    const key = `${binaryId == null ? '<none>' : String(binaryId)}::${String(session.id)}`;
    let stores = this.storeNamespaces.get(key);
    if (stores) return stores;
    if (this.storeNamespaces.size === 0) {
      // User-injected stores are bound to exactly the first binary/session
      // namespace; they are never subsequently reused for another binary.
      stores = this.initialStores;
    } else {
      const evidenceStore = new EvidenceStore(session.confirmedFindings || []);
      const hypothesisStore = new HypothesisStore(evidenceStore, session.hypotheses || []);
      stores = { evidenceStore, hypothesisStore, proposalStore: new ProposalStore({ evidenceStore }) };
    }
    this.storeNamespaces.set(key, stores);
    return stores;
  }

  async turn(input = {}, options = {}) {
    const request = normalizeTurnRequest(input);
    const budget = aiBudget(request.mode, { ...request.budget, ...options.budget });
    const started = Date.now();
    const activity = [];
    const observations = [];
    let modelCalls = 0;
    let toolCalls = 0;
    let contextBytes = 0;
    let plan = null;
    let decision = null;
    let limitReason = null;
    let autoScope = request.scope === 'auto' ? this.contextBroker.initialAutoScope() : request.scope;
    const externalSignal = options.signal || request.signal;
    if (externalSignal?.aborted) throw new AIError('cancelled', 'AI investigation was cancelled.');
    const turnController = new AbortController();
    const externalAbort = () => turnController.abort(externalSignal?.reason || 'cancelled');
    if (externalSignal) {
      externalSignal.addEventListener('abort', externalAbort, { once: true });
      if (externalSignal.aborted) externalAbort();
    }
    const deadline = setTimeout(() => turnController.abort('timeout'), budget.timeoutMs);
    this.activeControllers.add(turnController);
    const signal = turnController.signal;
    const addActivity = (event) => {
      const value = { ...event, timestamp: event.timestamp || new Date().toISOString() };
      activity.push(value);
      if (typeof options.onActivity === 'function') options.onActivity(value);
    };

    try {
      ensureRunning(signal, started, budget.timeoutMs);
      const requestedBinaryId = request.binaryId ?? this.localContext.binaryId ?? null;
      const requestedProjectId = request.projectId ?? this.localContext.projectId ?? null;
      let session = request.sessionId ? await this.sessionStore.get(request.sessionId) : null;
      ensureRunning(signal, started, budget.timeoutMs);
      if (session) {
        if (identityMismatch(session.binaryId, requestedBinaryId)) {
          throw new AIError('scope_violation', 'The requested AI session belongs to a different binary.');
        }
        if (identityMismatch(session.projectId, requestedProjectId)) {
          throw new AIError('scope_violation', 'The requested AI session belongs to a different project.');
        }
      } else {
        session = await this.sessionStore.create({
          binaryId: requestedBinaryId, projectId: requestedProjectId,
          mode: request.mode, style: request.style, scope: request.scope, goal: request.goal,
        });
      }

      const stores = this.storesFor(session, requestedBinaryId);
      this.evidenceStore = stores.evidenceStore;
      this.hypothesisStore = stores.hypothesisStore;
      this.proposalStore = stores.proposalStore;

      const registry = createHexToolRegistry(this.localContext, {
        evidenceStore: this.evidenceStore, maxFunctions: budget.maxFunctions, maxDisassembly: budget.maxDisassembly, onActivity: addActivity,
      });
      this.localContext.toolRegistry = registry;
      this.localContext.evidenceStore = this.evidenceStore;

      if (request.sessionId) await this.sessionStore.update(session.id, { mode: request.mode, style: request.style, scope: request.scope, goal: request.goal });
      await this.sessionStore.appendMessage(session.id, { role: 'user', content: request.goal });
      session = await this.sessionStore.get(session.id);
      addActivity({ type: 'turn-start', label: request.mode === 'agent' ? '調査を開始' : '質問を解析' });

      try {
        ensureRunning(signal, started, budget.timeoutMs);
        if (request.mode === 'agent' && this.planner) {
          addActivity({ type: 'plan-start', label: '決定論的候補探索を開始' });
          plan = await this.planner(request.goal, this.localContext, {
            maxFunctions: budget.maxFunctions,
            maxDisassembly: budget.maxDisassembly,
            maxSearchResults: request.maxSearchResults || 40,
            timeoutMs: Math.max(1, Math.min(budget.timeoutMs, request.plannerTimeoutMs || 15000)),
            isCancelled: () => !!signal?.aborted || Date.now() - started >= budget.timeoutMs,
            tools: registry.legacyTools,
          });
          const plannedEvidence = this.evidenceStore.ingestPlan(plan);
          observations.push({
            tool: 'deterministic_goal_planner', summary: `${plan.candidates?.length || 0} ranked candidates`,
            evidenceIds: plannedEvidence.map((item) => item.id),
            data: {
              candidates: (plan.candidates || []).slice(0, 20).map((candidate) => ({
                address: addressString(candidate.address), name: candidate.name, lexicalScore: candidate.lexicalScore,
                semanticScore: candidate.semanticScore, graphScore: candidate.graphScore,
                evidenceScore: candidate.evidenceScore, runtimeScore: candidate.runtimeScore,
                totalScore: candidate.totalScore, reasons: candidate.reasons,
              })),
              best: plan.best ? { address: addressString(plan.best.address), name: plan.best.name, verified: !!plan.best.verification?.verified } : null,
              missingEvidence: plan.missingEvidence || [],
            },
          });
          addActivity({ type: 'candidate-update', label: `候補を ${plan.candidates?.length || 0} 関数に絞り込み`, count: plan.candidates?.length || 0 });
          if (plan.exhausted) addActivity({ type: 'budget', label: '決定論的 planner の予算上限に到達' });
        }

        if (!this.provider || typeof this.provider.nextTurn !== 'function') {
          decision = deterministicDecision(plan, request);
        } else {
          const seenCalls = new Map();
          let repairs = 0;
          while (modelCalls < budget.maxModelCalls) {
            ensureRunning(signal, started, budget.timeoutMs);
            const tools = registry.definitionsForModel({ scope: request.scope });
            const built = this.contextBroker.buildModelContext({
              request, session, evidenceStore: this.evidenceStore, hypotheses: this.hypothesisStore.all(), observations,
              budgetBytes: budget.contextBytes,
            });
            contextBytes = Math.max(contextBytes, built.bytes);
            let next;
            try {
              modelCalls++;
              addActivity({ type: 'model-start', label: '次の解析手順を選択' });
              next = await this.provider.nextTurn({
                sessionId: session.id, mode: request.mode, style: request.style, scope: request.scope,
                messages: session.messages.slice(-8), context: built.context, tools,
              }, { signal, timeoutMs: remainingTime(started, budget.timeoutMs) });
              next = validateModelDecision(next, tools.map((tool) => tool.name));
            } catch (error) {
              const normalized = normalizeError(error, signal);
              if ((normalized.type === 'invalid_model_output' || normalized.type === 'invalid_tool_call') && repairs++ === 0 && modelCalls < budget.maxModelCalls) {
                observations.push({ tool: 'protocol_guardrail', summary: `Previous model response rejected: ${normalized.message}`, evidenceIds: [] });
                addActivity({ type: 'model-repair', label: '不正なモデル出力を1回だけ修復' });
                continue;
              }
              throw normalized;
            }
            addActivity({ type: 'model-result', label: next.type === 'tool' ? `ツール ${next.tool} を選択` : '回答候補を生成' });
            if (next.type === 'final') { decision = next; break; }
            if (toolCalls >= budget.maxToolCalls) { limitReason = 'tool-call-budget'; break; }
            if (registry.accounting.cost + registry.costWeight(next.tool) > budget.maxCost) { limitReason = 'tool-cost-budget'; break; }
            const signature = `${next.tool}:${stableStringify(next.arguments)}`;
            const repeated = (seenCalls.get(signature) || 0) + 1;
            seenCalls.set(signature, repeated);
            if (repeated > 2) { limitReason = 'repeated-tool-loop'; break; }

            if (request.scope === 'auto') {
              const required = BROAD_TOOL_SCOPE[next.tool] || 'function';
              if ((SCOPE_RANK[required] ?? 0) > (SCOPE_RANK[autoScope] ?? 0)) {
                const event = ContextBroker.expansion(autoScope, required, next.purpose || next.tool);
                if (event) addActivity(event);
                autoScope = required;
              }
            }
            const observation = await registry.execute(next.tool, next.arguments, { scope: request.scope, signal });
            toolCalls++;
            observations.push({ tool: next.tool, summary: observation.summary, evidenceIds: observation.evidenceIds, data: observation.modelData });
          }
          if (!decision && !limitReason && modelCalls >= budget.maxModelCalls) limitReason = 'model-call-budget';
        }
      } catch (error) {
        const normalized = normalizeError(error, signal);
        limitReason = normalized.type;
        addActivity({ type: 'error', errorType: normalized.type, label: humanError(normalized) });
        if (!decision) decision = deterministicDecision(plan, request, normalized);
      }

      if (!decision) decision = deterministicDecision(plan, request, new AIError('budget_exhausted', 'The investigation budget was exhausted.'));
      const result = this.finalize({ request, decision, plan, activity, modelCalls, toolCalls, contextBytes, started, limitReason, registry });
      await this.sessionStore.appendMessage(session.id, { role: 'assistant', content: result.answer });
      session = await this.sessionStore.get(session.id);
      await this.sessionStore.update(session.id, {
        summary: compactHistory(session), hypotheses: this.hypothesisStore.all(),
        confirmedFindings: this.evidenceStore.all().filter((item) => item.status === 'verified'),
        proposedActions: this.proposalStore.all(), lastActivity: activity[activity.length - 1] || null,
      });
      result.sessionId = session.id;
      return validateAIResult(result);
    } finally {
      clearTimeout(deadline);
      this.activeControllers.delete(turnController);
      if (externalSignal) externalSignal.removeEventListener('abort', externalAbort);
    }
  }

  finalize({ request, decision, plan, activity, modelCalls, toolCalls, contextBytes, started, limitReason, registry }) {
    const requestedEvidence = Array.from(new Set((decision.evidenceIds || []).map(String)));
    const evidence = requestedEvidence.map((id) => this.evidenceStore.get(id)).filter(Boolean);
    const missingIds = requestedEvidence.filter((id) => !this.evidenceStore.has(id));
    if (missingIds.length) activity.push({ type: 'consistency-check', label: `${missingIds.length} 件の存在しない evidence 参照を除外`, timestamp: new Date().toISOString() });
    const finalEvidence = evidence.length ? evidence : fallbackEvidence(this.evidenceStore, plan);
    for (const modelHypothesis of decision.hypotheses || []) this.hypothesisStore.upsert(modelHypothesis);
    const hypothesisIds = new Set((decision.hypothesisIds || []).map(String));
    const hypotheses = hypothesisIds.size ? this.hypothesisStore.all().filter((item) => hypothesisIds.has(item.id)) : this.hypothesisStore.all();
    const actions = sanitizeActions(decision.suggestedActions, {
      evidenceStore: this.evidenceStore, proposalStore: this.proposalStore,
      addressExists: (address) => addressExistsSync(this.localContext, address),
    });
    let confidence = Number.isFinite(decision.confidence) ? Math.max(0, Math.min(1, decision.confidence)) : deterministicConfidence(plan);
    if (!finalEvidence.length) confidence = Math.min(confidence, 0.5);
    const exhausted = !!limitReason;
    return {
      mode: request.mode,
      style: request.style,
      answer: presentAnswer(String(decision.answer || ''), request.style, finalEvidence, plan),
      confidence,
      evidence: finalEvidence,
      hypotheses,
      actions,
      followups: (decision.followups || []).map(String).slice(0, 8),
      activity,
      usage: { modelCalls, toolCalls, elapsedMs: Date.now() - started, contextBytes, candidateCount: plan?.candidates?.length || 0, analyzedFunctions: plan?.stats?.analyzedFunctions || 0, disassembly: Math.max(plan?.stats?.disassembly || 0, registry.analysisStats?.disassembly || 0), toolCost: registry.accounting.cost },
      limits: { exhausted, reason: limitReason || undefined },
    };
  }

  cancel() {
    for (const controller of this.activeControllers) controller.abort('cancelled');
    this.activeControllers.clear();
    if (this.provider && typeof this.provider.cancel === 'function') this.provider.cancel();
  }
}

export function createAIRuntime(options) { return new AIRuntime(options); }

function deterministicDecision(plan, request, error = null) {
  const best = plan?.best;
  if (best) {
    const address = addressString(best.address);
    return {
      type: 'final',
      answer: `最も強い候補は ${best.name || address} です。Hex の決定論的 planner が候補を順位付けし、${best.verification?.verified ? '更新経路を検証しました。' : '追加検証が必要です。'}`,
      confidence: deterministicConfidence(plan), evidenceIds: plan.evidence || [], hypothesisIds: [],
      suggestedActions: address ? [{ kind: 'open-function', target: address, label: '候補関数を開く' }] : [],
      followups: plan.missingEvidence || [],
    };
  }
  return { type: 'final', answer: error ? humanError(error) : (request.mode === 'chat' ? '利用できるローカル根拠だけでは回答を確定できませんでした。' : '有力な候補を特定できませんでした。'), confidence: 0, evidenceIds: [], suggestedActions: [], followups: plan?.missingEvidence || [] };
}

function fallbackEvidence(store, plan) {
  const planIds = new Set(plan?.evidence || []);
  const exact = store.all().filter((item) => planIds.has(item.id));
  if (exact.length) return exact.slice(0, 50);
  const planned = store.all().filter((item) => item.sourceTool === 'deterministic-goal-planner');
  if (planned.length) return planned.slice(-50);
  return store.all().filter((item) => item.status === 'verified').slice(-50);
}

function deterministicConfidence(plan) {
  if (plan?.best?.verification?.verified) return 0.98;
  if (plan?.best?.semanticFacts?.length) return 0.78;
  return plan?.best ? 0.45 : 0;
}

function presentAnswer(answer, style, evidence, plan) {
  if (style === 'analyst') return answer;
  const suffix = evidence.length ? `\n\nHex が確認できた根拠は ${evidence.length} 件です。` : '\n\nこの回答には、Hex が確認済みにした根拠がまだありません。';
  return `${answer}${suffix}${plan?.missingEvidence?.length ? ` 次に確認する点: ${plan.missingEvidence.slice(0, 3).join('、')}。` : ''}`;
}

function ensureRunning(signal, started, timeoutMs) {
  if (signal?.aborted) throw new AIError(signal.reason === 'timeout' ? 'budget_exhausted' : 'cancelled', signal.reason === 'timeout' ? 'The AI investigation timed out.' : 'AI investigation was cancelled.');
  if (Date.now() - started >= timeoutMs) throw new AIError('budget_exhausted', 'The AI investigation timed out.');
}

function remainingTime(started, timeoutMs) { return Math.max(1, timeoutMs - (Date.now() - started)); }

function normalizeError(error, signal) {
  if (error instanceof AIError) return error;
  if (signal?.aborted || error?.name === 'AbortError') return new AIError(signal?.reason === 'timeout' ? 'budget_exhausted' : 'cancelled', signal?.reason === 'timeout' ? 'The AI investigation timed out.' : 'AI investigation was cancelled.');
  return new AIError('provider_error', error?.message || String(error));
}

function humanError(error) {
  const labels = {
    cancelled: '解析を停止しました。保存済みの証拠とセッションは保持されています。',
    budget_exhausted: '解析予算または時間上限に達しました。得られた根拠までを返します。',
    model_timeout: 'モデル応答が時間内に完了しませんでした。ローカル解析結果は保持されています。',
    provider_error: 'AI provider を利用できませんでした。ローカル解析結果は保持されています。',
    invalid_model_output: 'モデル出力を安全に検証できませんでした。',
    invalid_tool_call: 'モデルが要求したツール呼び出しを検証できませんでした。',
    scope_violation: '指定された解析範囲を越える要求を拒否しました。',
    tool_failed: 'Hex ツールの実行に失敗しました。',
  };
  return labels[error?.type] || error?.message || 'AI 解析を完了できませんでした。';
}

function compactHistory(session) {
  const older = (session.messages || []).slice(0, -6);
  if (!older.length) return session.summary || '';
  const text = older.map((message) => `${message.role}: ${String(message.content || '').slice(0, 500)}`).join('\n');
  return `${session.summary ? `${session.summary}\n` : ''}${text}`.slice(-8000);
}

function identityMismatch(stored, requested) {
  if (stored == null || requested == null) return false;
  return String(stored) !== String(requested);
}

function addressExistsSync(context, address) {
  if (typeof context.addressExists === 'function') {
    const result = context.addressExists(address);
    if (typeof result === 'boolean') return result;
  }
  try {
    if (context.program?.functionRange) return !!context.program.functionRange(BigInt(address));
    if (context.symbols?.functionAt) return !!context.symbols.functionAt(BigInt(address));
  } catch { return false; }
  return true;
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

function addressString(value) {
  try { return `0x${BigInt(value).toString(16)}`; } catch { return null; }
}