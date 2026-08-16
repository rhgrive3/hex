import { aiBudget, AIError } from '../schema.js';
import { normalizeTurnRequest, validateAIResult, validateModelDecision } from '../validation.js';
import { createTurnSnapshot, createSnapshotContext } from './snapshot.js';
import { ScopeController } from './scope.js';
import { routeIntent, shouldRunPlanner } from '../routing/intent.js';
import { selectToolWindow } from './tool-window.js';
import { assertWireBudget, providerCapabilities, semanticBudgetFor } from '../budget/wire.js';
import { createHexToolRegistry } from '../tools/index.js';
import {
  addressString, assertLiveBindingsUnchanged, compactCandidate, deterministicDecision,
  ensureRunning, humanError, maxWireUsage, memoryAnchor, normalizeError, providerDiagnostics,
  remainingTime, requiredScopeForTool, sessionMatchesSnapshot, stableStringify, wireMeta,
} from './runtime-support.js';

const MIN_MODEL_REPAIR_REMAINING_MS = 45000;

export async function executeTurn(input = {}, options = {}) {
    const request = normalizeTurnRequest(input);
    const budgetOverrides = { ...request.budget, ...options.budget };
    const providerTimeout = this.provider?.turnTimeoutMs?.(request.mode, request);
    const providerHasNoDefaultTimeout = providerTimeout == null;
    if (budgetOverrides.timeoutMs == null && !providerHasNoDefaultTimeout) {
      const providerDefault = Number(providerTimeout);
      budgetOverrides.timeoutMs = Number.isFinite(providerDefault) && providerDefault > 0
        ? Math.floor(providerDefault)
        : (request.mode === 'agent' ? 120000 : 30000);
    }
    const budget = aiBudget(request.mode, budgetOverrides);
    const turnTimeoutMs = providerHasNoDefaultTimeout && budgetOverrides.timeoutMs == null ? Infinity : budget.timeoutMs;
    const started = Date.now(), activity = [], observations = [];
    let modelCalls = 0, toolCalls = 0, contextBytes = 0, plan = null, decision = null, limitReason = null;
    let wireUsage = { semanticContextBytes: 0, toolSchemaBytes: 0, historyBytes: 0, wireBytes: 0, estimatedInputTokens: 0 };
    const externalSignal = options.signal || request.signal;
    if (externalSignal?.aborted) throw new AIError('cancelled', 'AI investigation was cancelled.');
    const turnController = new AbortController();
    const externalAbort = () => turnController.abort(externalSignal?.reason || 'cancelled');
    if (externalSignal) { externalSignal.addEventListener('abort', externalAbort, { once: true }); if (externalSignal.aborted) externalAbort(); }
    const deadline = Number.isFinite(turnTimeoutMs) ? setTimeout(() => turnController.abort('timeout'), turnTimeoutMs) : null;
    this.activeControllers.add(turnController);
    const signal = turnController.signal;
    const addActivity = (event) => {
      const value = { ...event, timestamp: event.timestamp || new Date().toISOString() };
      activity.push(value); if (typeof options.onActivity === 'function') options.onActivity(value);
    };

    try {
      ensureRunning(signal, started, turnTimeoutMs);
      // Snapshot is intentionally first: all anchoring/scope decisions in this
      // turn are derived from this immutable workbench state.
      const snapshot = createTurnSnapshot(this.localContext, request);
      const intent = request.intent || routeIntent(request.goal, snapshot);
      request.intent = intent;
      const scopeController = new ScopeController(snapshot, request.scope, { onExpand: addActivity });
      scopeController.ensureForIntent(intent);
      request.effectiveScope = scopeController.effectiveScope;
      const snapshotContext = createSnapshotContext(this.localContext, snapshot, scopeController);

      let session = request.sessionId ? await this.sessionStore.get(request.sessionId) : null;
      ensureRunning(signal, started, turnTimeoutMs);
      if (session && !sessionMatchesSnapshot(session, snapshot)) {
        // Never attach an old binary investigation to the newly visible binary.
        // For an explicit session id this is a hard boundary rather than a silent reset.
        throw new AIError('scope_violation', 'The requested AI session belongs to a different binary or project.');
      }
      if (!session) {
        session = await this.sessionStore.create({
          binaryId: snapshot.binaryId, binaryIdentity: snapshot.binaryIdentity, projectId: snapshot.projectIdentity,
          mode: request.mode, style: request.style, scope: request.scope, effectiveScope: scopeController.effectiveScope, goal: request.goal,
          investigationMemory: { goal: request.goal, anchor: memoryAnchor(snapshot, scopeController.effectiveScope) },
        });
      }

      const stores = this.storesFor(session, snapshot.binaryId);
      this.evidenceStore = stores.evidenceStore; this.hypothesisStore = stores.hypothesisStore; this.proposalStore = stores.proposalStore;
      const registry = createHexToolRegistry(snapshotContext, {
        evidenceStore: this.evidenceStore, maxFunctions: budget.maxFunctions, maxDisassembly: budget.maxDisassembly, onActivity: addActivity,
      });

      await this.sessionStore.update(session.id, {
        mode: request.mode, style: request.style, scope: request.scope, effectiveScope: scopeController.effectiveScope, goal: request.goal,
        binaryIdentity: snapshot.binaryIdentity, projectId: snapshot.projectIdentity,
      });
      await this.sessionStore.updateMemory(session.id, { goal: request.goal, anchor: memoryAnchor(snapshot, scopeController.effectiveScope) });
      await this.sessionStore.appendMessage(session.id, { role: 'user', content: request.goal });
      session = await this.sessionStore.get(session.id);
      addActivity({ type: 'turn-start', label: request.mode === 'agent' ? '調査を開始' : '質問を解析', intent, requestedScope: request.scope, effectiveScope: scopeController.effectiveScope, snapshotId: snapshot.id });

      try {
        ensureRunning(signal, started, turnTimeoutMs);
        if (this.planner && shouldRunPlanner(request, snapshot, intent)) {
          addActivity({ type: 'plan-start', label: '決定論的候補探索を開始' });
          plan = await this.planner(request.goal, snapshotContext, {
            maxFunctions: budget.maxFunctions, maxDisassembly: budget.maxDisassembly,
            maxSearchResults: request.maxSearchResults || 40,
            timeoutMs: Math.max(1, Math.min(turnTimeoutMs, request.plannerTimeoutMs || 15000)),
            isCancelled: () => !!signal?.aborted || Date.now() - started >= turnTimeoutMs,
            tools: registry.legacyTools,
          });
          const plannedEvidence = this.evidenceStore.ingestPlan(plan);
          observations.push({
            tool: 'deterministic_goal_planner', summary: `${plan.candidates?.length || 0} ranked candidates`, evidenceIds: plannedEvidence.map((item) => item.id),
            data: { candidates: (plan.candidates || []).slice(0, 20).map(compactCandidate), best: plan.best ? { address: addressString(plan.best.address), name: plan.best.name, verified: !!plan.best.verification?.verified } : null, missingEvidence: plan.missingEvidence || [] },
          });
          addActivity({ type: 'candidate-update', label: `候補を ${plan.candidates?.length || 0} 関数に絞り込み`, count: plan.candidates?.length || 0 });
          if (plan.exhausted) addActivity({ type: 'budget', label: '決定論的 planner の予算上限に到達' });
        } else if (request.mode === 'agent') addActivity({ type: 'plan-skip', label: '現在の質問は局所解析で解決可能なため planner を省略', intent });

        if (!this.provider || typeof this.provider.nextTurn !== 'function') decision = deterministicDecision(plan, request);
        else {
          if (typeof this.provider.prepareCapabilities === 'function') {
            await this.provider.prepareCapabilities({ signal, timeoutMs: Math.min(5000, remainingTime(started, turnTimeoutMs)) });
            ensureRunning(signal, started, turnTimeoutMs);
          }
          const seenCalls = new Map(); let repairs = 0;
          while (modelCalls < budget.maxModelCalls) {
            ensureRunning(signal, started, turnTimeoutMs);
            request.effectiveScope = scopeController.effectiveScope;
            const caps = providerCapabilities(this.provider);
            const maxTools = Math.max(1, Math.min(10, Number(caps.maxTools || 10)));
            const window = selectToolWindow(registry, { mode: request.mode, requestedScope: request.scope, effectiveScope: scopeController.effectiveScope, intent, observations, hypotheses: this.hypothesisStore.all(), maxTools });
            const tools = window.tools;
            if (!tools.length) throw new AIError('invalid_tool_call', `No model-visible tools are available in ${scopeController.effectiveScope} scope.`);
            const messages = session.messages.slice(-8).map(({ role, content }) => ({ role, content }));
            const semanticBytes = semanticBudgetFor({ messages, tools, meta: wireMeta(request, scopeController, intent, session.id), capabilities: caps, configuredBytes: budget.contextBytes });
            const built = this.contextBroker.buildModelContext({
              request, session, evidenceStore: this.evidenceStore, hypotheses: this.hypothesisStore.all(), observations,
              budgetBytes: semanticBytes, snapshot, effectiveScope: scopeController.effectiveScope, includeHistory: false,
            });
            contextBytes = Math.max(contextBytes, built.bytes);
            const payloadForBudget = { messages, context: built.context, tools, meta: wireMeta(request, scopeController, intent, session.id) };
            const measured = assertWireBudget(payloadForBudget, caps);
            wireUsage = maxWireUsage(wireUsage, measured);
            let next;
            try {
              modelCalls++;
              addActivity({ type: 'model-start', label: '次の解析手順を選択', phase: window.phase, toolCount: tools.length, effectiveScope: scopeController.effectiveScope });
              next = await this.provider.nextTurn({
                sessionId: session.id, mode: request.mode, style: request.style,
                conversationId: request.conversationId || null,
                provider: request.provider || null,
                model: request.model || null,
                reasoning: request.reasoning || null,
                scope: scopeController.effectiveScope, requestedScope: request.scope, effectiveScope: scopeController.effectiveScope,
                intent, task: request.task || null, messages, context: built.context, tools,
              }, {
                signal,
                ...(Number.isFinite(turnTimeoutMs) ? { timeoutMs: remainingTime(started, turnTimeoutMs) } : {}),
              });
              const visibleToolNames = tools.map((tool) => tool.name);
              const previousTool = observations.length ? observations[observations.length - 1]?.tool : null;
              if (
                next?.type === 'tool'
                && previousTool
                && next.tool === previousTool
                && registry.has(previousTool)
                && scopeController.scopeAllowsTool(scopeController.effectiveScope, previousTool, next.arguments)
                && !visibleToolNames.includes(previousTool)
              ) visibleToolNames.push(previousTool);
              next = validateModelDecision(next, visibleToolNames);
            } catch (error) {
              const normalized = normalizeError(error, signal);
              const repairable = normalized.type === 'invalid_model_output' || normalized.type === 'invalid_tool_call';
              if (repairable && repairs === 0 && modelCalls < budget.maxModelCalls) {
                const repairRemainingMs = Number.isFinite(turnTimeoutMs) ? remainingTime(started, turnTimeoutMs) : null;
                if (repairRemainingMs == null || repairRemainingMs >= MIN_MODEL_REPAIR_REMAINING_MS) {
                  repairs++;
                  observations.push({ tool: 'protocol_guardrail', summary: `Previous model response rejected: ${normalized.message}`, evidenceIds: [] });
                  addActivity({ type: 'model-repair', label: 'モデル出力の形式を1回だけ再確認', ...(repairRemainingMs == null ? {} : { remainingMs: repairRemainingMs }) });
                  continue;
                }
                addActivity({ type: 'model-repair-skip', label: '残り時間が少ないためモデル出力の再確認を省略', remainingMs: repairRemainingMs });
              }
              throw normalized;
            }
            addActivity({ type: 'model-result', label: next.type === 'tool' ? `ツール ${next.tool} を選択` : '回答候補を生成' });
            if (next.type === 'final') { decision = next; break; }
            if (toolCalls >= budget.maxToolCalls) { limitReason = 'tool-call-budget'; break; }
            if (registry.accounting.cost + registry.costWeight(next.tool) > budget.maxCost) { limitReason = 'tool-cost-budget'; break; }
            const signature = `${next.tool}:${stableStringify(next.arguments)}`;
            const repeated = (seenCalls.get(signature) || 0) + 1; seenCalls.set(signature, repeated);
            if (repeated > 2) { limitReason = 'repeated-tool-loop'; break; }

            const requiredScope = requiredScopeForTool(next.tool);
            if (requiredScope) scopeController.expandTo(requiredScope, next.purpose || next.tool);
            request.effectiveScope = scopeController.effectiveScope;
            assertLiveBindingsUnchanged(this.localContext, snapshot);
            scopeController.assertToolCall(next.tool, next.arguments);
            const observation = await registry.execute(next.tool, next.arguments, { scope: scopeController.effectiveScope, signal });
            toolCalls++;
            observations.push({ tool: next.tool, summary: observation.summary, evidenceIds: observation.evidenceIds, data: observation.modelData });
            await this.sessionStore.updateMemory(session.id, { importantPriorActions: [{ tool: next.tool, summary: observation.summary, evidenceIds: observation.evidenceIds }] });
            session = await this.sessionStore.get(session.id);
          }
          if (!decision && !limitReason && modelCalls >= budget.maxModelCalls) limitReason = 'model-call-budget';
        }
      } catch (error) {
        const normalized = normalizeError(error, signal);
        limitReason = normalized.type;
        addActivity({ type: 'error', errorType: normalized.type, label: humanError(normalized), ...(providerDiagnostics(normalized) || {}) });
        if (!decision) decision = deterministicDecision(plan, request, normalized);
      }

      if (!decision) decision = deterministicDecision(plan, request, new AIError('budget_exhausted', 'The investigation budget was exhausted.'));
      const result = this.finalize({ request, decision, plan, activity, modelCalls, toolCalls, contextBytes, wireUsage, started, limitReason, registry, snapshot, effectiveScope: scopeController.effectiveScope });
      await this.sessionStore.appendMessage(session.id, { role: 'assistant', content: result.answer });
      await this.sessionStore.updateMemory(session.id, {
        anchor: memoryAnchor(snapshot, scopeController.effectiveScope, this.localContext),
        confirmedFacts: result.evidence.filter((item) => item.status === 'verified').map((item) => ({ id: item.id, summary: item.summary || item.title, functionAddress: item.functionAddress })),
        activeHypotheses: result.hypotheses.filter((item) => item.status === 'open' || item.status === 'supported'),
        rejectedHypotheses: result.hypotheses.filter((item) => item.status === 'rejected'),
        unresolvedQuestions: result.followups,
        importantPriorActions: result.actions,
      });
      await this.sessionStore.update(session.id, {
        effectiveScope: scopeController.effectiveScope, hypotheses: this.hypothesisStore.all(),
        confirmedFindings: this.evidenceStore.all().filter((item) => item.status === 'verified'), proposedActions: this.proposalStore.all(),
        lastActivity: activity[activity.length - 1] || null,
      });
      result.sessionId = session.id;
      return validateAIResult(result);
    } finally {
      clearTimeout(deadline); this.activeControllers.delete(turnController);
      if (externalSignal) externalSignal.removeEventListener('abort', externalAbort);
    }
}
