import assert from "node:assert/strict";
import fs from "node:fs";
import { ToolRegistry as CoreToolRegistry } from "../js/ai/tools/registry-core.js";
import { ToolRegistry as RegistryToolRegistry, createHexToolRegistry } from "../js/ai/tools/registry.js";
import { ToolRegistry as IndexToolRegistry, AI_TOOL_NAMES } from "../js/ai/tools/index.js";
import * as schemas from "../js/ai/tools/schemas.js";
import { AIError } from "../js/ai/schema.js";

console.log("Testing AI Tool Registry Module Boundary...");

// 1. Public export identity
assert.equal(RegistryToolRegistry, IndexToolRegistry);
console.log("  ok 1 public export identity");

// 2. Direct core export identity
assert.equal(CoreToolRegistry, RegistryToolRegistry);
console.log("  ok 2 direct core export identity");

// 3. Built-in factory compatibility
const reg = createHexToolRegistry({ runtime: {}, binaryDiff: {} });
assert.ok(reg instanceof CoreToolRegistry);
console.log("  ok 3 built-in factory compatibility");

// 4. Tool-name surface unchanged
const names = reg.names({ includeMutations: true });
for (const n of AI_TOOL_NAMES) {
  assert.ok(names.includes(n), "Missing expected tool: " + n);
}
console.log("  ok 4 tool-name surface unchanged");

// 5. Representative definition lock
const repTools = ["search_functions", "get_function", "get_cfg", "symbolic_execute", "get_observation_detail"];
for (const t of repTools) {
  const def = reg.get(t);
  assert.ok(def, "Tool def exists: " + t);
  assert.equal(def.name, t);
  assert.ok(def.cost);
  assert.ok(Array.isArray(def.scopeSupport));
  assert.ok(def.mutability);
  assert.ok(typeof def.needsApproval === "boolean");
  assert.ok(def.category);
  assert.ok(def.resultKind);
  assert.ok(typeof def.deterministic === "boolean");
  assert.ok(typeof def.storeResult === "boolean");
  assert.ok(def.inputSchema && typeof def.inputSchema === "object");
}
console.log("  ok 5 representative definition lock");

// 6. Schema builder exactness
const expectedBuilders = [
  "cursorProperty", "searchSchema", "emptySchema", "addressProperty", "limitProperty",
  "addressSchema", "addressLimitSchema", "semanticSchema", "fieldValueSchema", "fieldSchema",
  "sliceSchema", "traceSchema", "thresholdSchema", "verifyFieldSchema", "lookupSchema",
  "compareSchema", "runtimeObservationSchema", "runtimeVerifySchema", "regionSchema",
  "constantSchema", "pathSchema", "explainEvidenceSchema", "symbolicSchema",
  "observationDetailSchema", "evidenceDetailSchema",
];
for (const b of expectedBuilders) {
  assert.equal(typeof schemas[b], "function", "Missing schema builder: " + b);
  const result = schemas[b]();
  assert.ok(result && typeof result === "object", "Builder returns schema: " + b);
}
console.log("  ok 6 schema builder exactness");

// 7. Validation behavior unchanged
{
  const testReg = new CoreToolRegistry();
  testReg.register({
    name: "test_tool",
    inputSchema: schemas.searchSchema(),
    execute: async () => ({ ok: true }),
  });
  // Valid
  const res = await testReg.execute("test_tool", { query: "main" });
  assert.deepEqual(res.result, { ok: true });
  // Missing required
  await assert.rejects(async () => testReg.execute("test_tool", {}), (err) => {
    return err instanceof AIError && err.type === "invalid_tool_call";
  });
  // Additional property
  await assert.rejects(async () => testReg.execute("test_tool", { query: "main", invalid_prop: 123 }), (err) => {
    return err instanceof AIError && err.type === "invalid_tool_call";
  });
  console.log("  ok 7 validation behavior unchanged");
}

// 8. Scope behavior unchanged
{
  const testReg = new CoreToolRegistry();
  testReg.register({
    name: "binary_tool",
    scopeSupport: ["binary"],
    execute: async () => ({ ok: true }),
  });
  // Rejected in function scope
  await assert.rejects(async () => testReg.execute("binary_tool", {}, { scope: "function" }), (err) => {
    return err instanceof AIError && err.type === "scope_violation";
  });
  // Accepted in binary scope
  const res = await testReg.execute("binary_tool", {}, { scope: "binary" });
  assert.deepEqual(res.result, { ok: true });
  console.log("  ok 8 scope behavior unchanged");
}

// 9. Observer/activity behavior unchanged
{
  const activities = [];
  const testReg = new CoreToolRegistry({
    onActivity: (ev) => activities.push(ev),
  });
  testReg.register({
    name: "act_tool",
    execute: async () => ({ results: [1, 2, 3] }),
  });
  await testReg.execute("act_tool", {});
  assert.equal(activities.length, 2);
  assert.equal(activities[0].type, "tool-start");
  assert.equal(activities[0].tool, "act_tool");
  assert.equal(activities[1].type, "tool-result");
  assert.equal(activities[1].tool, "act_tool");
  assert.equal(activities[1].count, 3);
  console.log("  ok 9 observer/activity behavior unchanged");
}

// 10. Cache/accounting behavior unchanged
{
  let execCount = 0;
  const testReg = new CoreToolRegistry();
  testReg.register({
    name: "cached_tool",
    deterministic: true,
    storeResult: true,
    execute: async () => {
      execCount++;
      return { val: 42 };
    },
  });
  const res1 = await testReg.execute("cached_tool", {});
  assert.equal(execCount, 1);
  assert.equal(testReg.accounting.calls, 1);
  assert.equal(testReg.accounting.cacheHits, 0);

  const res2 = await testReg.execute("cached_tool", {});
  assert.equal(execCount, 1);
  assert.equal(testReg.accounting.calls, 2);
  assert.equal(testReg.accounting.cacheHits, 1);
  assert.equal(res2.cached, true);
  console.log("  ok 10 cache/accounting behavior unchanged");
}

// 11. Failure normalization unchanged
{
  const testReg = new CoreToolRegistry();
  testReg.register({
    name: "fail_tool",
    execute: async () => { throw new Error("boom"); },
  });
  await assert.rejects(async () => testReg.execute("fail_tool", {}), (err) => {
    return err instanceof AIError && err.type === "tool_failed" && err.message.includes("boom");
  });
  console.log("  ok 11 failure normalization unchanged");
}

// 12. Abort normalization unchanged
{
  const testReg = new CoreToolRegistry();
  testReg.register({
    name: "abort_tool",
    execute: async () => new Promise((resolve) => setTimeout(resolve, 1000)),
  });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(async () => testReg.execute("abort_tool", {}, { signal: controller.signal }), (err) => {
    return err instanceof AIError && err.type === "cancelled";
  });
  console.log("  ok 12 abort normalization unchanged");
}

// 13. Static dependency guard
{
  const coreSrc = fs.readFileSync("/workspaces/hex/js/ai/tools/registry-core.js", "utf8");
  const forbidden = [
    "../../agent/",
    "../../ir.js",
    "../../semantic.js",
    "../../symbolic/",
    "../../platform/",
    "../../project/",
    "../../ui/",
    "./registry.js",
  ];
  for (const f of forbidden) {
    assert.ok(!coreSrc.includes(f), "registry-core.js contains forbidden import: " + f);
  }
  console.log("  ok 13 static dependency guard passed");
}

console.log("All AI Tool Registry module boundary tests PASS!");
