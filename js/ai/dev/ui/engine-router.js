import { AGENT_PROFILE } from '../policy/agent-profile.js';
import { DevSupervisorV0 } from '../supervisor/dev-supervisor-v0.js';
import { DevSupervisorEngineV0 } from '../supervisor/dev-supervisor-engine-v0.js';

export function createAgentProfileEngine({ standardEngine, settings, supervisor = new DevSupervisorV0(), devEngine = null } = {}) {
  if (!standardEngine || typeof standardEngine.run !== 'function') throw new TypeError('standardEngine.run is required.');
  if (!settings) throw new TypeError('DevAgentUiSettings is required.');
  const dev = devEngine || new DevSupervisorEngineV0({ supervisor, settings });
  const devBootstrap = Object.freeze({
    prepare: () => dev.prepareBootstrapExtension(),
    activateAtSafeBoundary: (options) => dev.activateBootstrapAtSafeBoundary(options),
    invoke: (name) => dev.invokeBootstrapCapability(name),
    sessionFor: (conversationId) => dev.bootstrapSessionFor(conversationId),
    createCheckpoint: (options) => dev.createBootstrapCheckpoint(options),
    restore: (handoff) => dev.restoreBootstrapHandoff(handoff),
    runProof: (options) => dev.runBootstrapProof(options),
  });

  return new Proxy(standardEngine, {
    get(target, property, receiver) {
      if (property === 'devBootstrap') return devBootstrap;
      if (property !== 'run') {
        const value = Reflect.get(target, property, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      }
      return async (input = {}) => {
        if (input.mode !== 'agent' || settings.agentProfile !== AGENT_PROFILE.DEV) return target.run(input);
        return dev.run(input);
      };
    },
  });
}
