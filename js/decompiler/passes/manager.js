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
    for (const pass of this.passes) {
      const start = clock();
      if (clock() - totalStart > this.budget.timeBudgetMs) {
        state.warnings.push(`Decompiler pass budget exhausted before ${pass.name}.`);
        state.degraded = true;
        break;
      }
      try {
        const result = pass.run(state, { ...this.budget, ...(pass.budget || {}) });
        if (result && result !== state) Object.assign(state, result);
        state.passMetrics.push({ name: pass.name, elapsedMs: clock() - start, ok: true });
      } catch (error) {
        state.warnings.push(`${pass.name}: ${error?.message || String(error)}`);
        state.passMetrics.push({ name: pass.name, elapsedMs: clock() - start, ok: false });
        if (pass.required) throw error;
        state.degraded = true;
      }
    }
    state.passElapsedMs = clock() - totalStart;
    return state;
  }
}
