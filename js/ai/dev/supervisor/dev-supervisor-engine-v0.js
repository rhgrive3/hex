import { DEV_RUN_STATUS, transitionDevRun } from '../run/dev-run.js';
import { parseDevSupervisorDecision } from '../protocol/hex-dev-supervisor-v1.js';
import { buildDevSupervisorPrompt } from '../protocol/dev-supervisor-prompt.js';
import { DevRunEventHost } from '../events/dev-events.js';
import { DEV_WORKER_TOOL } from '../workers/tool-surface.js';

const MAX_DECISIONS = 16;

export class DevSupervisorEngineV0 {
  constructor({ supervisor, settings, bridge = globalThis.__HEX_CHATGPT_BRIDGE__, maxDecisions = MAX_DECISIONS } = {}) {
    if (!supervisor) throw new TypeError('DevSupervisorEngineV0 requires a supervisor.');
    if (!settings) throw new TypeError('DevSupervisorEngineV0 requires settings.');
    this.supervisor = supervisor;
    this.settings = settings;
    this.bridge = bridge || null;
    this.maxDecisions = maxDecisions;
  }

  async run(input = {}) {
    const resumedHumanRun = this.resumableHumanRun(input);
    let run;
    const history = [];
    if (resumedHumanRun) {
      run = this.supervisor.resume(resumedHumanRun);
      history.push({ kind: 'human-response', text: String(input.question || input.goal || '').trim() });
    } else {
      const ids = {
        runId: this.supervisor.idFactory('run'),
        supervisorSessionKey: this.supervisor.idFactory('supervisor-session'),
        workerId: this.supervisor.idFactory('worker'),
      };
      run = this.supervisor.createRun({
        ...ids,
        goal: input.question || input.goal,
        decisionPolicy: this.settings.decisionPolicy,
        analysisScope: this.settings.analysisScope,
        hexConversationId: input.conversationId || null,
      });
      run = this.supervisor.activate(run);
    }

    this.settings.setLastRun(run);
    input.onActivity?.({ label: 'Dev Supervisor', detail: run.status });
    if (!this.bridge || typeof this.bridge.request !== 'function') {
      return uiResponse(`Dev Supervisor run ${run.runId} created.`, run, []);
    }

    const eventHost = new DevRunEventHost({ supervisor: this.supervisor });
    let workerClaimed = false;

    try {
      for (let step = 0; step < this.maxDecisions; step++) {
        const response = await this.bridge.request(buildDevSupervisorPrompt({
          run,
          availableTools: this.supervisor.availableTools,
          history,
        }), {
          signal: input.signal,
          sessionKey: run.supervisorSessionKey,
          model: input.model || null,
          reasoning: input.reasoning || null,
        });
        const text = response && typeof response === 'object' ? response.text : response;
        const decision = parseDevSupervisorDecision(text, { availableTools: this.supervisor.availableTools });

        if (decision.type === 'tool') {
          input.onActivity?.({ label: decision.tool, detail: decision.purpose });
          const executed = await this.supervisor.executeToolDecision(run, decision);
          run = executed.run;
          if (decision.tool === DEV_WORKER_TOOL.CLAIM) workerClaimed = true;
          if (decision.tool === DEV_WORKER_TOOL.RELEASE) workerClaimed = false;
          this.settings.setLastRun(run);
          history.push({ kind: 'tool-result', tool: decision.tool, purpose: decision.purpose, result: sanitize(executed.result) });
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
          if (workerClaimed) {
            run = await this.releaseWorker(run);
            workerClaimed = false;
          }
          const applied = eventHost.yieldDecision(run, decision);
          run = applied.run;
          this.settings.setLastRun(run);
          return uiResponse(decision.question, run, [decision.question]);
        }

        if (workerClaimed) {
          run = await this.releaseWorker(run);
          workerClaimed = false;
        }
        const applied = this.supervisor.applyDecision(run, decision);
        run = applied.run;
        this.settings.setLastRun(run);
        return uiResponse(decision.answer, run, []);
      }

      if (workerClaimed) {
        run = await this.releaseWorker(run);
        workerClaimed = false;
      }
      if (run.status === DEV_RUN_STATUS.ACTIVE) {
        run = transitionDevRun(run, DEV_RUN_STATUS.PAUSED, { now: this.supervisor.now() });
        this.settings.setLastRun(run);
      }
      throw new Error('Dev Supervisor decision budget exhausted.');
    } catch (error) {
      if (workerClaimed) {
        try {
          run = await this.releaseWorker(run);
          this.settings.setLastRun(run);
        } catch (cleanupError) {
          try { error.workerCleanupError = String(cleanupError?.message || cleanupError); } catch {}
        }
      }
      throw error;
    }
  }

  resumableHumanRun(input) {
    const run = this.settings.lastRun;
    if (!run || run.status !== DEV_RUN_STATUS.WAITING_HUMAN) return null;
    const currentHexConversationId = input.conversationId == null ? null : String(input.conversationId);
    const waitingHexConversationId = run.hexConversationId == null ? null : String(run.hexConversationId);
    return currentHexConversationId === waitingHexConversationId ? run : null;
  }

  async releaseWorker(run) {
    if (!this.supervisor.workerTools?.has?.(DEV_WORKER_TOOL.RELEASE)) {
      throw new Error('Dev Worker release tool is unavailable while a Worker claim is active.');
    }
    const result = await this.supervisor.workerTools.execute(DEV_WORKER_TOOL.RELEASE, {
      runId: run.runId,
      workerId: run.workerId,
    });
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
