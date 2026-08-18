import { DEV_RUN_STATUS, transitionDevRun } from '../run/dev-run.js';
import { parseDevSupervisorDecision } from '../protocol/hex-dev-supervisor-v1.js';
import { buildDevSupervisorPrompt } from '../protocol/dev-supervisor-prompt.js';
import { DevRunEventHost } from '../events/dev-events.js';
import { DEV_WORKER_TOOL } from '../workers/tool-surface.js';
import {
  DEV_BOOTSTRAP_EXTENSION,
  DEV_BOOTSTRAP_EXTENSION_VERSION,
  DEV_BOOTSTRAP_ROUND4_PROOF_CAPABILITY,
  DevExtensionLoader,
  createDevBootstrapCheckpoint,
  createDevBootstrapHandoff,
} from '../bootstrap/dev-bootstrap-gate.js';
import {
  DEV_RUNTIME_ACTIVATION_TOOL,
  DEV_RUNTIME_IDENTITY_TOOL,
  DEV_SELF_UPDATE_HISTORY_KIND,
  DevSelfUpdateGate,
} from '../bootstrap/self-update-gate.js';
import {
  DEV_TOOL_ERROR_RECOVERY_BUDGET,
  createDevToolErrorHistoryEntry,
  isTerminalDevToolError,
  sanitizeDevToolArguments,
} from './tool-error-recovery.js';

const MAX_DECISIONS = 16;

export class DevSupervisorEngineV0 {
  constructor({
    supervisor,
    settings,
    bridge = globalThis.__HEX_CHATGPT_BRIDGE__,
    maxDecisions = MAX_DECISIONS,
    extensionLoader = new DevExtensionLoader(),
    selfUpdateGate = new DevSelfUpdateGate(),
    maxToolErrorRecoveries = DEV_TOOL_ERROR_RECOVERY_BUDGET,
  } = {}) {
    if (!supervisor) throw new TypeError('DevSupervisorEngineV0 requires a supervisor.');
    if (!settings) throw new TypeError('DevSupervisorEngineV0 requires settings.');
    if (!extensionLoader || typeof extensionLoader.beginToolCall !== 'function' || typeof extensionLoader.endToolCall !== 'function') {
      throw new TypeError('DevSupervisorEngineV0 extensionLoader must expose tool-call boundaries.');
    }
    this.supervisor = supervisor;
    this.settings = settings;
    this.bridge = bridge || null;
    this.maxDecisions = maxDecisions;
    this.extensionLoader = extensionLoader;
    this.selfUpdateGate = selfUpdateGate;
    this.maxToolErrorRecoveries = Math.max(0, Number(maxToolErrorRecoveries) || 0);
    this.bootstrapStage = null;
    this.supervisorSessions = new Map();
  }

  requireRuntimeActivation(options) {
    return this.selfUpdateGate.requireActivation(options);
  }

  observeActiveRuntimeIdentity(identity) {
    return this.selfUpdateGate.observeActiveRuntime(identity);
  }

  runtimeActivationStatus() {
    return this.selfUpdateGate.status();
  }

  /* An unreadable identity leaves the gate closed instead of failing the run. */
  observeRuntimeIdentityResult(result) {
    try {
      return { ...sanitize(this.selfUpdateGate.observeActiveRuntime(result?.identity ?? result)) };
    } catch (error) {
      return {
        ...sanitize(this.selfUpdateGate.status()),
        identityError: String(error?.message || error || 'active runtime identity is unreadable.').slice(0, 512),
      };
    }
  }

  prepareBootstrapExtension() {
    if (!this.bootstrapStage) this.bootstrapStage = this.extensionLoader.stage(DEV_BOOTSTRAP_EXTENSION);
    return this.bootstrapStage;
  }

  /* Round 4 bootstrap activation is one instance of the general self-update
     rule, so it arms and satisfies the same gate. */
  activateBootstrapAtSafeBoundary(options) {
    const result = this.extensionLoader.activateAtSafeBoundary(options);
    try {
      if (result?.status === 'reload-required') {
        const checkpoint = result.handoff?.checkpoint;
        if (checkpoint) {
          this.selfUpdateGate.requireActivation({
            expectedCommit: checkpoint.expectedCommit,
            expectedBuildId: checkpoint.expectedBuildId,
            reason: result.reason || 'extension-reinitialize',
          });
        }
      } else if (result?.status === 'active' && result.identity) {
        this.selfUpdateGate.observeActiveRuntime(result.identity);
      }
    } catch { /* the gate must never mask the activation result */ }
    return result;
  }

  invokeBootstrapCapability(name) {
    return this.extensionLoader.invoke(name);
  }

  bootstrapSessionFor(conversationId) {
    const hexConversationId = normalizeConversationId(conversationId);
    if (!hexConversationId) throw new TypeError('Bootstrap Hex conversation ID is required.');
    return Object.freeze({
      hexConversationId,
      supervisorSessionKey: this.supervisorSessionKeyFor(hexConversationId),
    });
  }

  createBootstrapCheckpoint({ conversationId, chatgptConversationId, activeIdentity, pendingTask } = {}) {
    const session = this.bootstrapSessionFor(conversationId);
    return createDevBootstrapCheckpoint({
      runId: this.supervisor.idFactory('bootstrap-run'),
      goal: 'Complete the Round 4 production bootstrap proof.',
      decisionPolicy: this.settings.decisionPolicy,
      supervisorSessionKey: session.supervisorSessionKey,
      chatgptConversationId,
      pendingTask: pendingTask ?? { type: 'round4-bootstrap', step: 'resume-proof', hexConversationId: session.hexConversationId },
      expectedCommit: activeIdentity?.commit,
      expectedBuildId: activeIdentity?.buildId,
      expectedExtensionVersion: DEV_BOOTSTRAP_EXTENSION_VERSION,
    });
  }

  restoreBootstrapHandoff(handoff) {
    const normalized = createDevBootstrapHandoff(handoff?.checkpoint || handoff);
    const hexConversationId = normalizeConversationId(normalized.checkpoint?.pendingTask?.hexConversationId);
    if (!hexConversationId) throw new TypeError('Bootstrap handoff is missing the Hex conversation ID.');
    this.supervisorSessions.set(hexConversationId, normalized.supervisorSessionKey);
    return normalized;
  }

  runBootstrapProof({ handoff, model = null, reasoning = null, signal = null } = {}) {
    const restored = this.restoreBootstrapHandoff(handoff);
    const conversationId = normalizeConversationId(restored.checkpoint.pendingTask?.hexConversationId);
    return this.run({
      goal: `Round 4 bootstrap restoration is active. Invoke ${DEV_BOOTSTRAP_ROUND4_PROOF_CAPABILITY} first, verify the returned identity evidence, then finish with no remaining tasks.`,
      conversationId,
      model,
      reasoning,
      signal,
      requiredBootstrapCapability: DEV_BOOTSTRAP_ROUND4_PROOF_CAPABILITY,
    });
  }

  availableTools() {
    return Object.freeze([...new Set([
      ...(this.supervisor.availableTools || []),
      ...(this.extensionLoader.activeCapabilities || []),
      DEV_RUNTIME_ACTIVATION_TOOL,
    ])]);
  }

  async executeWithinToolBoundary(operation) {
    if (typeof operation !== 'function') throw new TypeError('Dev tool operation must be a function.');
    this.extensionLoader.beginToolCall();
    try {
      return await operation();
    } finally {
      this.extensionLoader.endToolCall();
    }
  }

  async run(input = {}) {
    const requiredBootstrapCapability = normalizeRequiredBootstrapCapability(input.requiredBootstrapCapability, this.extensionLoader.activeCapabilities);
    let requiredBootstrapObserved = requiredBootstrapCapability == null;
    const resumedHumanRun = this.resumableHumanRun(input);
    let run;
    const history = [];
    if (resumedHumanRun) {
      run = this.supervisor.resume(resumedHumanRun);
      this.rememberSupervisorSession(run);
      history.push({ kind: 'human-response', text: String(input.question || input.goal || '').trim() });
    } else {
      const hexConversationId = normalizeConversationId(input.conversationId);
      const ids = {
        runId: this.supervisor.idFactory('run'),
        supervisorSessionKey: this.supervisorSessionKeyFor(hexConversationId),
        workerId: this.supervisor.idFactory('worker'),
      };
      run = this.supervisor.createRun({
        ...ids,
        goal: input.question || input.goal,
        decisionPolicy: this.settings.decisionPolicy,
        analysisScope: this.settings.analysisScope,
        hexConversationId,
      });
      run = this.supervisor.activate(run);
      this.rememberSupervisorSession(run);
    }

    this.settings.setLastRun(run);
    input.onActivity?.({ label: 'Dev Supervisor', detail: run.status });
    if (!this.bridge || typeof this.bridge.request !== 'function') {
      return uiResponse(`Dev Supervisor run ${run.runId} created.`, run, []);
    }

    const eventHost = new DevRunEventHost({ supervisor: this.supervisor });
    let workerClaimed = false;
    let workerClaimAttempted = false;
    let toolErrorRecoveries = 0;

    /* A claim that threw leaves ownership ambiguous. Recovery can now carry the
       run all the way to a normal ending, so every exit settles the obligation
       instead of only the confirmed-claim case. */
    const settleWorkerOwnership = async () => {
      if (workerClaimed) {
        run = await this.releaseWorker(run);
        workerClaimed = false;
        workerClaimAttempted = false;
        return;
      }
      if (!workerClaimAttempted) return;
      try { run = await this.releaseWorker(run); }
      catch { /* the ambiguous claim held nothing; a good run must not fail for it */ }
      workerClaimAttempted = false;
    };

    try {
      for (let step = 0; step < this.maxDecisions; step++) {
        const promptTools = requiredBootstrapCapability
          ? Object.freeze([requiredBootstrapCapability])
          : this.availableTools();
        const response = await this.bridge.request(buildDevSupervisorPrompt({
          run,
          availableTools: promptTools,
          history,
        }), {
          signal: input.signal,
          sessionKey: run.supervisorSessionKey,
          model: input.model || null,
          reasoning: input.reasoning || null,
        });
        const text = response && typeof response === 'object' ? response.text : response;
        let decision;
        try {
          decision = parseDevSupervisorDecision(text);
        } catch (decisionError) {
          history.push({
            kind: 'decision-invalid',
            message: '直前のSupervisor decisionは有効なhex-dev-supervisor-v1 JSONではありません。同じdecision shape契約に従ってJSONオブジェクトを1つだけ再出力してください。',
            error: String(decisionError?.message || decisionError || 'Invalid Supervisor decision.'),
          });
          continue;
        }
        const availableTools = requiredBootstrapCapability
          ? Object.freeze([requiredBootstrapCapability])
          : this.availableTools();

        if (decision.type === 'tool' && !availableTools.includes(decision.tool)) {
          history.push({
            kind: 'tool-unavailable',
            tool: decision.tool,
            message: `要求されたツール「${decision.tool}」は現在利用できません。現在利用可能なツール一覧を確認して再判断してください。`,
            availableTools,
          });
          continue;
        }

        if (decision.type === 'tool') {
          input.onActivity?.({ label: decision.tool, detail: decision.purpose });

          /* A merged source change does not make the running runtime new. */
          const rejection = this.selfUpdateGate.rejectionFor(decision.tool);
          if (rejection) {
            history.push({ kind: DEV_SELF_UPDATE_HISTORY_KIND, tool: decision.tool, ...sanitize(rejection) });
            continue;
          }

          try {
            if (decision.tool === DEV_RUNTIME_ACTIVATION_TOOL) {
              const result = this.selfUpdateGate.requireActivation(decision.arguments);
              history.push({ kind: 'tool-result', tool: decision.tool, purpose: decision.purpose, result: sanitize(result) });
              continue;
            }
            if (this.extensionLoader.activeCapabilities?.includes(decision.tool)) {
              const result = await this.executeWithinToolBoundary(() => this.invokeBootstrapCapability(decision.tool));
              history.push({ kind: 'tool-result', tool: decision.tool, purpose: decision.purpose, result: sanitize(result) });
              if (decision.tool === requiredBootstrapCapability) requiredBootstrapObserved = true;
              continue;
            }
            if (decision.tool === DEV_WORKER_TOOL.CLAIM) workerClaimAttempted = true;
            const executed = await this.executeWithinToolBoundary(
              () => this.supervisor.executeToolDecision(run, decision),
            );
            run = executed.run;
            if (decision.tool === DEV_WORKER_TOOL.CLAIM) {
              workerClaimed = true;
              workerClaimAttempted = false;
            }
            if (decision.tool === DEV_WORKER_TOOL.RELEASE) workerClaimed = false;
            this.settings.setLastRun(run);
            history.push({ kind: 'tool-result', tool: decision.tool, purpose: decision.purpose, result: sanitize(executed.result) });
            if (decision.tool === DEV_RUNTIME_IDENTITY_TOOL) {
              history.push({ kind: 'runtime-activation', ...this.observeRuntimeIdentityResult(executed.result) });
            }
            continue;
          } catch (toolError) {
            /* Ownership bookkeeping stays truthful: an unresolved claim keeps
               its cleanup obligation, and a failed release keeps the claim. */
            if (isTerminalDevToolError(toolError) || toolErrorRecoveries >= this.maxToolErrorRecoveries) throw toolError;
            toolErrorRecoveries += 1;
            history.push({
              ...createDevToolErrorHistoryEntry({
                tool: decision.tool,
                purpose: decision.purpose,
                error: toolError,
                attempt: toolErrorRecoveries,
                remaining: this.maxToolErrorRecoveries - toolErrorRecoveries,
              }),
              arguments: sanitizeDevToolArguments(decision.arguments),
            });
            continue;
          }
        }

        if (requiredBootstrapCapability && !requiredBootstrapObserved) {
          history.push({
            kind: 'bootstrap-proof-required',
            capability: requiredBootstrapCapability,
            message: `Invoke ${requiredBootstrapCapability} before any wait, human, or final decision.`,
          });
          continue;
        }

        if (decision.type === 'wait') {
          const waited = await eventHost.waitForWorkerDecision(run, decision, { signal: input.signal });
          run = waited.run;
          this.settings.setLastRun(run);
          history.push({ kind: 'event', event: sanitize(waited.event) });
          continue;
        }

        if (decision.type === 'human') {
          await settleWorkerOwnership();
          const applied = eventHost.yieldDecision(run, decision);
          run = applied.run;
          this.settings.setLastRun(run);
          return uiResponse(decision.question, run, [decision.question]);
        }

        await settleWorkerOwnership();
        const applied = this.supervisor.applyDecision(run, decision);
        run = applied.run;
        this.settings.setLastRun(run);
        return uiResponse(decision.answer, run, []);
      }

      await settleWorkerOwnership();
      if (run.status === DEV_RUN_STATUS.ACTIVE) {
        run = transitionDevRun(run, DEV_RUN_STATUS.PAUSED, { now: this.supervisor.now() });
        this.settings.setLastRun(run);
      }
      throw new Error('Dev Supervisor decision budget exhausted.');
    } catch (error) {
      if (workerClaimed || workerClaimAttempted) {
        try {
          run = await this.releaseWorker(run);
          workerClaimed = false;
          workerClaimAttempted = false;
        } catch (cleanupError) {
          try { error.workerCleanupError = String(cleanupError?.message || cleanupError); } catch {}
        }
      }
      const terminal = error?.name === 'AbortError' || error?.code === 'cancelled'
        ? DEV_RUN_STATUS.CANCELLED
        : DEV_RUN_STATUS.FAILED;
      if (![DEV_RUN_STATUS.COMPLETED, DEV_RUN_STATUS.FAILED, DEV_RUN_STATUS.CANCELLED].includes(run.status)) {
        try { run = transitionDevRun(run, terminal, { now: this.supervisor.now() }); } catch {}
      }
      this.settings.setLastRun(run);
      throw error;
    }
  }

  resumableHumanRun(input) {
    const run = this.settings.lastRun;
    if (!run || run.status !== DEV_RUN_STATUS.WAITING_HUMAN) return null;
    const currentHexConversationId = normalizeConversationId(input.conversationId);
    const waitingHexConversationId = normalizeConversationId(run.hexConversationId);
    return currentHexConversationId === waitingHexConversationId ? run : null;
  }

  supervisorSessionKeyFor(hexConversationId) {
    const conversationId = normalizeConversationId(hexConversationId);
    if (conversationId) {
      const remembered = this.supervisorSessions.get(conversationId);
      if (remembered) return remembered;

      const lastRun = this.settings.lastRun;
      const lastConversationId = normalizeConversationId(lastRun?.hexConversationId);
      const lastSessionKey = String(lastRun?.supervisorSessionKey || '').trim();
      if (lastConversationId === conversationId && lastSessionKey) {
        this.supervisorSessions.set(conversationId, lastSessionKey);
        return lastSessionKey;
      }
    }

    const created = this.supervisor.idFactory('supervisor-session');
    if (conversationId) this.supervisorSessions.set(conversationId, created);
    return created;
  }

  rememberSupervisorSession(run) {
    const conversationId = normalizeConversationId(run?.hexConversationId);
    const sessionKey = String(run?.supervisorSessionKey || '').trim();
    if (conversationId && sessionKey) this.supervisorSessions.set(conversationId, sessionKey);
    return sessionKey || null;
  }

  async releaseWorker(run) {
    if (!this.supervisor.workerTools?.has?.(DEV_WORKER_TOOL.RELEASE)) {
      throw new Error('Dev Worker release tool is unavailable while a Worker claim is active.');
    }
    const result = await this.executeWithinToolBoundary(() => this.supervisor.workerTools.execute(DEV_WORKER_TOOL.RELEASE, {
      runId: run.runId,
      workerId: run.workerId,
    }));
    return this.supervisor.bindWorkerResult(run, result);
  }
}

function uiResponse(answer, run, followups) {
  return {
    answer: String(answer || ''),
    confidence: null,
    evidence: [],
    hypotheses: [],
    actions: [],
    followups,
    devRunId: run.runId,
  };
}
function sanitize(value) {
  try { return JSON.parse(JSON.stringify(value)); } catch { return { error: 'non-json-tool-result' }; }
}
function normalizeConversationId(value) {
  if (value == null) return null;
  const text = String(value).trim();
  return text || null;
}

function normalizeRequiredBootstrapCapability(value, activeCapabilities) {
  if (value == null || value === '') return null;
  const name = String(value).trim();
  if (!name) return null;
  if (!(activeCapabilities || []).includes(name)) throw new Error(`Required bootstrap capability is not active: ${name}`);
  return name;
}
