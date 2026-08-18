import { DevSupervisorEngineV0 as BaseDevSupervisorEngineV0 } from './dev-supervisor-engine-v0.js';

/*
 * The base engine's maxDecisions loop is a safety budget for decisions that do
 * not make progress. A successful tool call is positive progress and must not
 * consume that budget forever. This production wrapper keeps the existing
 * fail-closed base loop, but moves its upper bound forward after each
 * successful tool execution so the Supervisor always gets a fresh
 * maxDecisions window after progress.
 *
 * Invalid decisions, unavailable tools, activation rejections and failed tool
 * calls do not mark progress, so they remain bounded by the original window.
 */
export class ProgressBudgetDevSupervisorEngineV0 extends BaseDevSupervisorEngineV0 {
  constructor(options = {}) {
    super(options);
    this.progressDecisionWindow = this.maxDecisions;
    this.progressDecisionCount = 0;
    this.progressRunActive = false;

    /* Never Proxy the production bridge: request may be a non-configurable,
       non-writable own property. A Proxy get trap returning a wrapper function
       violates the ECMAScript invariant and aborts R4 bootstrap. */
    const bridge = this.bridge;
    if (bridge && typeof bridge.request === 'function') {
      const request = bridge.request.bind(bridge);
      this.bridge = Object.freeze({
        request: async (...args) => {
          const result = await request(...args);
          if (this.progressRunActive) this.progressDecisionCount += 1;
          return result;
        },
      });
    }

    const gate = this.selfUpdateGate;
    if (gate && typeof gate.requireActivation === 'function') {
      const requireActivation = gate.requireActivation.bind(gate);
      gate.requireActivation = (...args) => {
        const result = requireActivation(...args);
        this.markToolProgress();
        return result;
      };
    }
  }

  markToolProgress() {
    if (!this.progressRunActive) return;
    this.maxDecisions = this.progressDecisionCount + this.progressDecisionWindow;
  }

  async executeWithinToolBoundary(operation) {
    const result = await super.executeWithinToolBoundary(operation);
    this.markToolProgress();
    return result;
  }

  async readActiveRuntimeIdentity(args = {}) {
    const result = await super.readActiveRuntimeIdentity(args);
    this.markToolProgress();
    return result;
  }

  async run(input = {}) {
    this.progressDecisionCount = 0;
    this.maxDecisions = this.progressDecisionWindow;
    this.progressRunActive = true;
    try {
      return await super.run(input);
    } finally {
      this.progressRunActive = false;
      this.progressDecisionCount = 0;
      this.maxDecisions = this.progressDecisionWindow;
    }
  }
}
