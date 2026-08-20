import { children, mapChildren, nodeCount, structuralKey } from '../ast/nodes.js';

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
    /*
     * The wall-clock valve exists so a pathological function cannot hang an
     * interactive iPad session, and that is a real release constraint. But it
     * makes the rewrite fixed point a function of machine speed: the same input
     * reaches a different fixed point on different runs, and the difference is
     * visible in the output. Measurement therefore has to be able to turn it
     * off, or a Phase 8 quality baseline would be measuring the host, not the
     * decompiler.
     *
     * `deterministicTransforms` disables only the time-based cutoff. The work
     * bounds (iterations, applications, node budget) still apply, so this is not
     * an unbounded mode — it is the same engine bounded by work instead of by
     * clock. Production defaults are unchanged.
     */
    const deterministic = context.deterministicTransforms === true;
    const localDeadline = deterministic ? Infinity : started + Math.max(0, Number(this.budget.timeBudgetMs));
    const contextDeadline = Number(context.deadline);
    const deadline = !deterministic && Number.isFinite(contextDeadline)
      ? Math.min(localDeadline, contextDeadline)
      : localDeadline;
    const proof = [];
    const stats = { iterations: 0, applications: 0, budgetExceeded: false, elapsedMs: 0, byRule: {} };
    const phases = [...new Set(this.rules.map((r) => r.phase))];
    let current = root;

    const overBudget = (candidate = current) => {
      if (stats.applications >= this.budget.maxApplications) return true;
      if (nodeCount(candidate, new Set(), this.budget.nodeBudget) > this.budget.nodeBudget) return true;
      if (now() >= deadline || context.shouldAbort?.()) return true;
      return false;
    };

    const visitIterative = (rootNode, rules) => {
      if (!rootNode) return rootNode;
      const rewritten = new Map();
      const active = new Set();
      const stack = [{ n: rootNode, exit: false }];
      while (stack.length) {
        const frame = stack.pop();
        const n = frame.n;
        if (!n || rewritten.has(n)) continue;
        if (overBudget(n)) { stats.budgetExceeded = true; rewritten.set(n, n); continue; }
        if (!frame.exit) {
          if (active.has(n)) { rewritten.set(n, n); continue; }
          active.add(n);
          stack.push({ n, exit: true });
          const kids = children(n);
          for (let i = kids.length - 1; i >= 0; i--) if (kids[i] && !rewritten.has(kids[i])) stack.push({ n: kids[i], exit: false });
          continue;
        }

        let candidate = mapChildren(n, (child) => rewritten.get(child) || child);
        for (const rule of rules) {
          if (overBudget(candidate)) { stats.budgetExceeded = true; break; }
          const match = rule.match(candidate, context);
          if (!match) continue;
          if (rule.precondition && !rule.precondition(candidate, match, context)) continue;
          const beforeKey = structuralKey(candidate);
          const next = rule.rewrite(candidate, match, context);
          if (!next) continue;
          const afterKey = structuralKey(next);
          if (beforeKey === afterKey) continue;
          const beforeCost = Number(rule.cost(candidate, context) ?? 0);
          const afterCost = Number(rule.cost(next, context) ?? 0);
          if (!rule.allowExpansion && afterCost > beforeCost) continue;
          const evidence = typeof rule.proof === 'function' ? rule.proof(candidate, next, match, context) : rule.proof;
          if (!evidence) continue;
          proof.push({ rule: rule.name, phase: rule.phase, before: beforeKey, after: afterKey, evidence });
          stats.applications++;
          stats.byRule[rule.name] = (stats.byRule[rule.name] || 0) + 1;
          candidate = next;
          if (rule.repeatability === 'once') break;
        }
        rewritten.set(n, candidate);
        active.delete(n);
      }
      return rewritten.get(rootNode) || rootNode;
    };

    for (const phase of phases) {
      const rules = this.rules.filter((r) => r.phase === phase);
      let iterations = 0;
      while (iterations++ < this.budget.maxIterations) {
        if (overBudget(current)) { stats.budgetExceeded = true; break; }
        stats.iterations++;
        const before = structuralKey(current);
        current = visitIterative(current, rules);
        const after = structuralKey(current);
        if (before === after || stats.budgetExceeded) break;
      }
      if (stats.budgetExceeded) break;
    }
    stats.elapsedMs = now() - started;
    return { root: current, proof, stats };
  }
}
