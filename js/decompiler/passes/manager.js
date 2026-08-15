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
    const totalBudget = Math.max(0, Number(this.budget.timeBudgetMs ?? DEFAULT_PASS_BUDGET.timeBudgetMs));
    const deadline = totalStart + totalBudget;
    let budgetWarned = false;

    for (const pass of this.passes) {
      const start = clock();
      const remainingMs = Math.max(0, deadline - start);
      if (remainingMs <= 0 && !pass.required) {
        if (!budgetWarned) state.warnings.push(`Decompiler pass budget exhausted before ${pass.name}; optional passes were skipped.`);
        budgetWarned = true;
        state.degraded = true;
        state.passMetrics.push({ name: pass.name, elapsedMs: 0, ok: true, skipped: true, reason: 'deadline', degraded: true });
        continue;
      }

      if (remainingMs <= 0) {
        if (!budgetWarned) state.warnings.push(`Decompiler pass budget exhausted before ${pass.name}; only required finalization may continue.`);
        budgetWarned = true;
        state.degraded = true;
      }

      try {
        // Passes receive an absolute deadline and a cheap synchronous cancellation
        // predicate. Expensive passes are expected to poll shouldAbort() at bounded
        // intervals; once the deadline is crossed the manager never starts another
        // optional pass. Required representation/finalization passes still run so the
        // public result remains structurally valid.
        const passBudget = { ...this.budget, ...(pass.budget || {}) };
        const passRemaining = Math.max(0, deadline - clock());
        passBudget.timeBudgetMs = Math.min(Math.max(0, Number(passBudget.timeBudgetMs ?? passRemaining)), passRemaining);
        passBudget.remainingTimeMs = passRemaining;
        passBudget.deadline = deadline;
        passBudget.degraded = !!state.degraded;
        passBudget.shouldAbort = () => clock() >= deadline;

        const result = pass.run(state, passBudget);
        if (result && result !== state) Object.assign(state, result);
        const elapsedMs = clock() - start;
        if (clock() >= deadline) state.degraded = true;
        state.passMetrics.push({ name: pass.name, elapsedMs, ok: true, degraded: !!state.degraded });
      } catch (error) {
        state.warnings.push(`${pass.name}: ${error?.message || String(error)}`);
        state.passMetrics.push({ name: pass.name, elapsedMs: clock() - start, ok: false, degraded: true });
        if (pass.required) throw error;
        state.degraded = true;
      }
    }
    state.passElapsedMs = clock() - totalStart;
    state.passDeadlineExceeded = state.passElapsedMs > totalBudget;
    return state;
  }
}
