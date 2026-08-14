function clock() { return globalThis.performance?.now ? globalThis.performance.now() : Date.now(); }

export const DEFAULT_PASS_BUDGET = Object.freeze({ timeBudgetMs: 40, nodeBudget: 12000, maxIterations: 16 });

export class PassManager {
  constructor(passes = [], budget = {}) {
    this.passes = passes.slice();
    this.budget = { ...DEFAULT_PASS_BUDGET, ...budget };
  }

  run(initialState) {
    const state = initialState || {};
    state.passMetrics ||= [];
    state.warnings ||= [];
    const totalStart = clock();
    let budgetWarned = false;
    for (const pass of this.passes) {
      const start = clock();
      if (clock() - totalStart > this.budget.timeBudgetMs) {
        if (!budgetWarned) state.warnings.push(`Decompiler pass budget exhausted before ${pass.name}; finishing bounded representation passes conservatively.`);
        budgetWarned = true;
        state.degraded = true;
      }
      try {
        // Individual expensive engines (notably rewriting) carry their own iteration,
        // node and time caps. The manager-level budget marks degradation but does not
        // abandon later AST/source-map/printing passes, which are required for a valid
        // public result shape.
        const result = pass.run(state, { ...this.budget, ...(pass.budget || {}), degraded: !!state.degraded });
        if (result && result !== state) Object.assign(state, result);
        state.passMetrics.push({ name: pass.name, elapsedMs: clock() - start, ok: true, degraded: !!state.degraded });
      } catch (error) {
        state.warnings.push(`${pass.name}: ${error?.message || String(error)}`);
        state.passMetrics.push({ name: pass.name, elapsedMs: clock() - start, ok: false, degraded: true });
        if (pass.required) throw error;
        state.degraded = true;
      }
    }
    state.passElapsedMs = clock() - totalStart;
    return state;
  }
}
