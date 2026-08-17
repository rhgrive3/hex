import { AGENT_PROFILE } from '../policy/agent-profile.js';
import { DevSupervisorV0 } from '../supervisor/dev-supervisor-v0.js';

export function createAgentProfileEngine({ standardEngine, settings, supervisor = new DevSupervisorV0() } = {}) {
  if (!standardEngine || typeof standardEngine.run !== 'function') throw new TypeError('standardEngine.run is required.');
  if (!settings) throw new TypeError('DevAgentUiSettings is required.');

  return new Proxy(standardEngine, {
    get(target, property, receiver) {
      if (property !== 'run') {
        const value = Reflect.get(target, property, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      }
      return async (input = {}) => {
        if (input.mode !== 'agent' || settings.agentProfile !== AGENT_PROFILE.DEV) {
          return target.run(input);
        }
        let run = supervisor.createRun({
          goal: input.question || input.goal,
          decisionPolicy: settings.decisionPolicy,
          analysisScope: settings.analysisScope,
          hexConversationId: input.conversationId || null,
        });
        run = supervisor.activate(run);
        settings.setLastRun(run);
        input.onActivity?.({ label: 'Dev Supervisor', detail: run.status });
        // DevRun stays on the Dev control-plane boundary. Do not leak a new
        // field into the established Standard Agent response schema.
        return {
          answer: `Dev Supervisor run ${run.runId} created.`,
          confidence: null,
          evidence: [],
          hypotheses: [],
          actions: [],
          followups: [],
        };
      };
    },
  });
}
