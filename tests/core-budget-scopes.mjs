import assert from "node:assert/strict";
import { ResourceBudget, BudgetExceededError, RESOURCE_BUDGET_CONTRACT_VERSION } from "../js/core/budgets/index.js";

console.log("Testing ResourceBudget composable scopes...");

// 1. Root-only legacy accounting unchanged
{
  const budget = new ResourceBudget({ workUnits: 10 });
  budget.consume("workUnits", 3);
  assert.equal(budget.used.workUnits, 3);
  assert.equal(budget.remaining("workUnits"), 7);
  console.log("  ok 1 root legacy accounting");
}

// 2. Child consume increments child and root
{
  const root = new ResourceBudget({ workUnits: 100 });
  const child = root.scope("child", { workUnits: 50 });
  child.consume("workUnits", 10);
  assert.equal(child.used.workUnits, 10);
  assert.equal(root.used.workUnits, 10);
  console.log("  ok 2 child consume increments child and root");
}

// 3. Grandchild increments all three levels
{
  const root = new ResourceBudget({ workUnits: 100 });
  const child = root.scope("child", { workUnits: 50 });
  const grand = child.scope("grand", { workUnits: 20 });
  grand.consume("workUnits", 5);
  assert.equal(grand.used.workUnits, 5);
  assert.equal(child.used.workUnits, 5);
  assert.equal(root.used.workUnits, 5);
  console.log("  ok 3 grandchild increments 3 levels");
}

// 4. Child-local exhaustion throws with child scopePath
{
  const root = new ResourceBudget({ workUnits: 100 });
  const child = root.scope("child", { workUnits: 10 });
  assert.throws(() => {
    child.consume("workUnits", 15);
  }, (err) => {
    assert.ok(err instanceof BudgetExceededError);
    assert.equal(err.scope, "child");
    assert.equal(err.scopePath, "root/child");
    return true;
  });
  console.log("  ok 4 child-local exhaustion");
}

// 5. Root exhaustion from child consume throws with root scopePath
{
  const root = new ResourceBudget({ workUnits: 10 });
  const child = root.scope("child", { workUnits: 100 });
  assert.throws(() => {
    child.consume("workUnits", 15);
  }, (err) => {
    assert.ok(err instanceof BudgetExceededError);
    assert.equal(err.scope, "root");
    assert.equal(err.scopePath, "root");
    return true;
  });
  console.log("  ok 5 root exhaustion from child consume");
}

// 6. Failed preflight increments no scope
{
  const root = new ResourceBudget({ workUnits: 10 });
  const child = root.scope("child", { workUnits: 5 });
  try {
    child.consume("workUnits", 15);
  } catch {}
  assert.equal(child.used.workUnits || 0, 0);
  assert.equal(root.used.workUnits || 0, 0);
  console.log("  ok 6 failed preflight increments no scope");
}

// 7. remaining() uses minimum local/ancestor capacity
{
  const root = new ResourceBudget({ workUnits: 10 });
  const child = root.scope("child", { workUnits: 50 });
  assert.equal(child.remaining("workUnits"), 10);
  console.log("  ok 7 remaining minimum capacity");
}

// 8. Unbounded child inherits effective ancestor remaining
{
  const root = new ResourceBudget({ workUnits: 10 });
  const child = root.scope("child", {});
  assert.equal(child.remaining("workUnits"), 10);
  console.log("  ok 8 unbounded child inherits ancestor remaining");
}

// 9. Custom domain meter is tracked without automatic work-unit conversion
{
  const root = new ResourceBudget({});
  const child = root.scope("child", { instructions: 500 });
  child.consume("instructions", 100);
  assert.equal(child.used.instructions, 100);
  assert.equal(root.used.instructions, 100);
  assert.equal(root.used.workUnits || 0, 0);
  console.log("  ok 9 custom domain meter");
}

// 10. Siblings have independent local usage but aggregate into root
{
  const root = new ResourceBudget({ workUnits: 100 });
  const s1 = root.scope("s1", { workUnits: 40 });
  const s2 = root.scope("s2", { workUnits: 40 });
  s1.consume("workUnits", 10);
  s2.consume("workUnits", 20);
  assert.equal(s1.used.workUnits, 10);
  assert.equal(s2.used.workUnits, 20);
  assert.equal(root.used.workUnits, 30);
  console.log("  ok 10 sibling aggregation");
}

// 11. Duplicate sibling scope name rejected
{
  const root = new ResourceBudget({});
  root.scope("dup");
  assert.throws(() => {
    root.scope("dup");
  }, /budget-duplicate-sibling-scope:dup/);
  console.log("  ok 11 duplicate sibling rejected");
}

// 12. Invalid scope name rejected
{
  const root = new ResourceBudget({});
  assert.throws(() => {
    root.scope("bad name with spaces");
  }, /budget-scope-name-invalid/);
  console.log("  ok 12 invalid scope name rejected");
}

// 13. Child shares exact same AbortSignal and abort stops consumption
{
  const ac = new AbortController();
  const root = new ResourceBudget({}, { signal: ac.signal });
  const child = root.scope("child");
  assert.equal(child.signal, ac.signal);
  ac.abort();
  assert.throws(() => {
    child.consume("workUnits", 1);
  }, /AbortError|Aborted/);
  console.log("  ok 13 child shares abort signal");
}

// 14. Default snapshot() remains backward-compatible
{
  const root = new ResourceBudget({ workUnits: 100 });
  root.consume("workUnits", 5);
  const snap = root.snapshot();
  assert.equal(snap.contractVersion, RESOURCE_BUDGET_CONTRACT_VERSION);
  assert.equal(snap.limits.workUnits, 100);
  assert.equal(snap.used.workUnits, 5);
  assert.equal(snap.name, "root");
  assert.equal(snap.scopePath, "root");
  assert.equal(snap.children, undefined);
  console.log("  ok 14 backward compatible snapshot");
}

// 15. Recursive snapshot is deterministic, sorted, and deeply frozen
{
  const root = new ResourceBudget({});
  const b = root.scope("b");
  const a = root.scope("a");
  const snap = root.snapshot({ recursive: true });
  assert.ok(Array.isArray(snap.children));
  assert.equal(snap.children.length, 2);
  assert.equal(snap.children[0].name, "a");
  assert.equal(snap.children[1].name, "b");
  assert.ok(Object.isFrozen(snap));
  assert.ok(Object.isFrozen(snap.children));
  console.log("  ok 15 recursive snapshot sorted and frozen");
}

// Limits validation tests (#1176)
{
  assert.throws(() => new ResourceBudget({ workUnits: NaN }), /budget-limit-invalid:workUnits/);
  assert.throws(() => new ResourceBudget({ workUnits: Infinity }), /budget-limit-invalid:workUnits/);
  assert.throws(() => new ResourceBudget({ workUnits: -1 }), /budget-limit-invalid:workUnits/);
  assert.throws(() => new ResourceBudget({ workUnits: 1.5 }), /budget-limit-invalid:workUnits/);
  const zeroBudget = new ResourceBudget({ workUnits: 0 });
  assert.equal(zeroBudget.limits.workUnits, 0);
  console.log("  ok #1176 ResourceBudget limits validation");
}

console.log("All core budget scope tests PASS!");
