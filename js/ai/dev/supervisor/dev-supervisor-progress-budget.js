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

    /*
     * The production ChatGPT bridge may be frozen. Never Proxy it: ECMAScript
     * requires a Proxy get trap to return the exact target value for an own,
     * non-configurable, non-writable data property. Returning a wrapped request
     * function violates that invariant and aborts Round 4 bootstrap before the
     * Supervisor can make a decision. A fresh facade delegates to the real
     * bridge without interposing on the frozen object itself.
     */
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

    /* dev.runtime.require_activation is a successful Dev tool too, but the
       base engine invokes this gate directly rather than through
       executeWithinToolBoundary(). Preserve the gate semantics while marking
       the successful call as progress. */
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
