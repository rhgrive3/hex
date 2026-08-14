import { mapChildren, nodeCount, structuralKey } from '../ast/nodes.js';

export const DEFAULT_REWRITE_BUDGET = Object.freeze({
  maxIterations: 12,
  nodeBudget: 4096,
  timeBudgetMs: 18,
  maxApplications: 2048,
});

function now() { return globalThis.performance?.now ? globalThis.performance.now() : Date.now(); }

function validateRule(rule) {
  for (const key of ['name', 'phase', 'match', 'rewrite', 'proof']) {
    if (rule?.[key] == null) throw new TypeError(`rewrite rule missing ${key}`);
  }
  if (typeof rule.match !== 'function' || typeof rule.rewrite !== 'function') throw new TypeError(`rewrite rule ${rule.name} has invalid callbacks`);
  if (rule.precondition != null && typeof rule.precondition !== 'function') throw new TypeError(`rewrite rule ${rule.name} has invalid precondition`);
  return Object.freeze({ cost: () => 0, repeatability: 'fixed-point', ...rule });
}

export class RewriteEngine {
  constructor(rules = [], budget = {}) {
    this.rules = rules.map(validateRule);
    this.budget = { ...DEFAULT_REWRITE_BUDGET, ...budget };
  }

  rewrite(root, context = {}) {
    const started = now();
    const proof = [];
    const stats = { iterations: 0, applications: 0, budgetExceeded: false, elapsedMs: 0, byRule: {} };
    const phases = [...new Set(this.rules.map((r) => r.phase))];
    let current = root;

    const overBudget = (candidate = current) => {
      if (stats.applications >= this.budget.maxApplications) return true;
      if (nodeCount(candidate) > this.budget.nodeBudget) return true;
      if (now() - started > this.budget.timeBudgetMs) return true;
      return false;
    };

    for (const phase of phases) {
      const rules = this.rules.filter((r) => r.phase === phase);
      let changed = true;
      let iterations = 0;
      while (changed && iterations++ < this.budget.maxIterations) {
        changed = false;
        stats.iterations++;
        const visit = (n) => {
          if (!n || overBudget(n)) { stats.budgetExceeded = true; return n; }
          let candidate = mapChildren(n, visit);
          for (const rule of rules) {
            const match = rule.match(candidate, context);
            if (!match) continue;
            if (rule.precondition && !rule.precondition(candidate, match, context)) continue;
            const beforeKey = structuralKey(candidate);
            const rewritten = rule.rewrite(candidate, match, context);
            if (!rewritten) continue;
            const afterKey = structuralKey(rewritten);
            if (beforeKey === afterKey) continue;
            const beforeCost = Number(rule.cost(candidate, context) ?? 0);
            const afterCost = Number(rule.cost(rewritten, context) ?? 0);
            if (!rule.allowExpansion && afterCost > beforeCost) continue;
            const evidence = typeof rule.proof === 'function' ? rule.proof(candidate, rewritten, match, context) : rule.proof;
            if (!evidence) continue;
            proof.push({ rule: rule.name, phase, before: beforeKey, after: afterKey, evidence });
            stats.applications++;
            stats.byRule[rule.name] = (stats.byRule[rule.name] || 0) + 1;
            candidate = rewritten;
            changed = true;
            if (rule.repeatability === 'once') break;
            if (overBudget(candidate)) { stats.budgetExceeded = true; break; }
          }
          return candidate;
        };
        current = visit(current);
        if (stats.budgetExceeded) break;
      }
      if (stats.budgetExceeded) break;
    }
    stats.elapsedMs = now() - started;
    return { root: current, proof, stats };
  }
}
