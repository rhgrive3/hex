import { DEV_RUN_STATUS, transitionDevRun } from '../run/dev-run.js';
import { parseDevSupervisorDecision } from '../protocol/hex-dev-supervisor-v1.js';
import { buildDevSupervisorPrompt } from '../protocol/dev-supervisor-prompt.js';
import { DevRunEventHost } from '../events/dev-events.js';

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
    const ids = {
      runId: this.supervisor.idFactory('run'),
      supervisorSessionKey: this.supervisor.idFactory('supervisor-session'),
      workerId: this.supervisor.idFactory('worker'),
    };
    let run = this.supervisor.createRun({
      ...ids,
      goal: input.question || input.goal,
      decisionPolicy: this.settings.decisionPolicy,
      analysisScope: this.settings.analysisScope,
      hexConversationId: input.conversationId || null,
    });
    run = this.supervisor.activate(run);
    this.settings.setLastRun(run);
    input.onActivity?.({ label: 'Dev Supervisor', detail: run.status });
    if (!this.bridge || typeof this.bridge.request !== 'function') {
      return uiResponse(`Dev Supervisor run ${run.runId} created.`, run, []);
    }
    const history = [];
    const eventHost = new DevRunEventHost({ supervisor: this.supervisor });

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
        const applied = eventHost.yieldDecision(run, decision);
        run = applied.run;
        this.settings.setLastRun(run);
        return uiResponse(decision.question, run, [decision.question]);
      }

      const applied = this.supervisor.applyDecision(run, decision);
      run = applied.run;
      this.settings.setLastRun(run);
      return uiResponse(decision.answer, run, []);
    }

    if (run.status === DEV_RUN_STATUS.ACTIVE) {
      run = transitionDevRun(run, DEV_RUN_STATUS.PAUSED, { now: this.supervisor.now() });
      this.settings.setLastRun(run);
    }
    throw new Error('Dev Supervisor decision budget exhausted.');
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
