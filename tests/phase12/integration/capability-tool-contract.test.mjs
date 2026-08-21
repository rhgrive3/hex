import assert from "node:assert/strict";
import { HEX_CAPABILITIES, CapabilityCatalog } from "../../../js/ai/capabilities/catalog.js";
import { CapabilityExecutor } from "../../../js/ai/capabilities/executor.js";
import { createHexToolRegistry } from "../../../js/ai/tools/registry.js";
import { ToolRegistry } from "../../../js/ai/tools/registry-core.js";
import { analysisToolContract, auditCapabilityToolContracts } from "../../../js/ai/tools/contracts.js";
import { AIError } from "../../../js/ai/schema.js";

console.log("[phase12] running capability tool contract tests...");

const baseRegistry = createHexToolRegistry({
  runtime: {},
  binaryDiff: {},
  searchFunctions: async () => [],
  searchStrings: async () => [],
});

// 1. Current registry audit is green
{
  const audit = auditCapabilityToolContracts({ capabilities: HEX_CAPABILITIES, toolRegistry: baseRegistry });
  assert.equal(audit.ok, true, "Audit should be ok. Errors: " + JSON.stringify(audit.errors));
  assert.equal(audit.errors.length, 0);
  console.log("  ok 1 current registry audit is green");
}

// 2. Every catalog agentTool exists
{
  for (const cap of HEX_CAPABILITIES) {
    if (cap.agentTool) {
      assert.equal(baseRegistry.has(cap.agentTool), true, "Missing tool for " + cap.id + ": " + cap.agentTool);
    }
  }
  console.log("  ok 2 every catalog agentTool exists");
}

// 3. Search functions exposes actual scopes
{
  const catalog = new CapabilityCatalog();
  const list = catalog.list({ toolRegistry: baseRegistry });
  const searchCap = list.find((c) => c.id === "analysis.search-functions");
  assert.ok(searchCap);
  assert.deepEqual(searchCap.scopeSupport, ["auto", "binary", "project"]);
  console.log("  ok 3 search functions exposes actual scopes");
}

// 4. Function-scoped tool exposes its actual scopes
{
  const catalog = new CapabilityCatalog();
  const list = catalog.list({ toolRegistry: baseRegistry });
  const cfgCap = list.find((c) => c.id === "analysis.cfg");
  assert.ok(cfgCap);
  const toolDef = baseRegistry.get("get_cfg");
  assert.deepEqual(cfgCap.scopeSupport, toolDef.scopeSupport);
  console.log("  ok 4 function-scoped tool exposes actual scopes");
}

// 5. Unsupported scope fails before execution
{
  let execCount = 0;
  const spyRegistry = new ToolRegistry();
  spyRegistry.register({
    name: "search_functions",
    scopeSupport: ["auto", "binary", "project"],
    execute: async () => {
      execCount++;
      return { results: [] };
    },
  });
  const catalog = new CapabilityCatalog();
  const executor = new CapabilityExecutor({ catalog, toolRegistry: spyRegistry });
  await assert.rejects(
    async () => executor.execute("analysis.search-functions", { query: "test" }, { scope: "function" }),
    (err) => err instanceof AIError && err.type === "scope_violation"
  );
  assert.equal(execCount, 0, "Backing tool should not be called on scope violation");
  console.log("  ok 5 unsupported scope fails before execution");
}

// 6. Supported scope executes once
{
  let execCount = 0;
  const spyRegistry = new ToolRegistry();
  spyRegistry.register({
    name: "search_functions",
    scopeSupport: ["auto", "binary", "project"],
    execute: async () => {
      execCount++;
      return { results: [] };
    },
  });
  const catalog = new CapabilityCatalog();
  const executor = new CapabilityExecutor({ catalog, toolRegistry: spyRegistry });
  const res = await executor.execute("analysis.search-functions", { query: "test" }, { scope: "binary" });
  assert.equal(execCount, 1, "Backing tool should execute once");
  assert.ok(res);
  console.log("  ok 6 supported scope executes once");
}

// 7. Missing backing tool remains unavailable
{
  const emptyRegistry = new ToolRegistry();
  const catalog = new CapabilityCatalog();
  const list = catalog.list({ toolRegistry: emptyRegistry });
  const searchCap = list.find((c) => c.id === "analysis.search-functions");
  assert.equal(searchCap.available.ok, false);
  assert.equal(searchCap.available.reason, "analysis-tool-unavailable:search_functions");
  console.log("  ok 7 missing backing tool remains unavailable");
}

// 8. Audit rejects writable backing tool
{
  const fakeRegistry = new ToolRegistry();
  fakeRegistry.register({
    name: "search_functions",
    mutability: "mutation",
    execute: async () => ({}),
  });
  const audit = auditCapabilityToolContracts({
    capabilities: [{ id: "analysis.search-functions", agentTool: "search_functions" }],
    toolRegistry: fakeRegistry,
  });
  assert.equal(audit.ok, false);
  assert.ok(audit.errors.includes("analysis-tool-not-read-only:search_functions"));
  console.log("  ok 8 audit rejects writable backing tool");
}

// 9. Audit rejects approval-required backing tool
{
  const fakeRegistry = new ToolRegistry();
  fakeRegistry.register({
    name: "search_functions",
    needsApproval: true,
    execute: async () => ({}),
  });
  const audit = auditCapabilityToolContracts({
    capabilities: [{ id: "analysis.search-functions", agentTool: "search_functions" }],
    toolRegistry: fakeRegistry,
  });
  assert.equal(audit.ok, false);
  assert.ok(audit.errors.includes("analysis-tool-needs-approval:search_functions"));
  console.log("  ok 9 audit rejects approval-required backing tool");
}

// 10. Audit rejects invalid/duplicate scopes
{
  const fakeRegistry = new ToolRegistry();
  fakeRegistry.register({
    name: "search_functions",
    scopeSupport: ["binary", "binary", "bogus"],
    execute: async () => ({}),
  });
  const audit = auditCapabilityToolContracts({
    capabilities: [{ id: "analysis.search-functions", agentTool: "search_functions" }],
    toolRegistry: fakeRegistry,
  });
  assert.equal(audit.ok, false);
  assert.ok(audit.errors.includes("duplicate-tool-scope:search_functions:binary"));
  assert.ok(audit.errors.includes("invalid-tool-scope:search_functions:bogus"));
  console.log("  ok 10 audit rejects invalid/duplicate scopes");
}

// 11. Catalog immutability
{
  const catalog = new CapabilityCatalog();
  const reg1 = new ToolRegistry();
  reg1.register({ name: "search_functions", scopeSupport: ["binary"], execute: async () => ({}) });
  const reg2 = new ToolRegistry();
  reg2.register({ name: "search_functions", scopeSupport: ["project"], execute: async () => ({}) });

  const list1 = catalog.list({ toolRegistry: reg1 });
  const list2 = catalog.list({ toolRegistry: reg2 });
  assert.deepEqual(list1.find((c) => c.id === "analysis.search-functions").scopeSupport, ["binary"]);
  assert.deepEqual(list2.find((c) => c.id === "analysis.search-functions").scopeSupport, ["project"]);
  // HEX_CAPABILITIES entry unchanged
  const rawEntry = HEX_CAPABILITIES.find((c) => c.id === "analysis.search-functions");
  assert.deepEqual(rawEntry.scopeSupport, ["auto", "selection", "function", "neighborhood", "binary", "project"]);
  console.log("  ok 11 catalog immutability");
}

console.log("  ok all capability tool contract tests passed!");
