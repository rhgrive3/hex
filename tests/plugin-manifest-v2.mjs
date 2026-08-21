import assert from "node:assert/strict";
import { PlatformPluginRegistry, registerAnalyzer, PluginCompatibilityError } from "../js/platform/plugin-api.js";
import { validatePluginManifest, checkManifestCompatibility, HOST_API_VERSION, ANALYZER_CONTRACT_VERSION } from "../js/platform/plugin-manifest.js";

console.log("Testing Plugin Manifest v2...");

// Validation
// 1. valid manifest normalizes and freezes deeply
{
  const m = {
    id: "vendor.plugin.test",
    name: "Test Plugin",
    version: "1.0.0",
    apiVersion: "2.0.0",
    permissions: { binaryRead: true },
    supportedTargets: ["*"],
    contributions: [{
      type: "analyzer",
      id: "vendor.plugin.test.analyzer",
      contractVersion: "1.0.0",
      capabilities: ["progress", "cancel"],
    }],
  };
  const norm = validatePluginManifest(m);
  assert.equal(norm.id, "vendor.plugin.test");
  assert.ok(Object.isFrozen(norm));
  assert.ok(Object.isFrozen(norm.contributions[0]));
  console.log("  ok 1 valid manifest normalizes and freezes deeply");
}

// 2. malformed plugin ID rejected
{
  assert.throws(() => validatePluginManifest({ id: "", name: "a", version: "1.0.0", apiVersion: "2.0.0", supportedTargets: ["*"], contributions: [] }), /plugin-manifest-id-invalid/);
  console.log("  ok 2 malformed plugin ID rejected");
}

// 3. malformed semver rejected
{
  assert.throws(() => validatePluginManifest({ id: "p1", name: "a", version: "invalid", apiVersion: "2.0.0", supportedTargets: ["*"], contributions: [] }), /semver-invalid/);
  console.log("  ok 3 malformed semver rejected");
}

// 4. empty supportedTargets rejected
{
  assert.throws(() => validatePluginManifest({ id: "p1", name: "a", version: "1.0.0", apiVersion: "2.0.0", supportedTargets: [], contributions: [] }), /plugin-manifest-supported-targets-invalid/);
  console.log("  ok 4 empty supportedTargets rejected");
}

// 5. duplicate contribution IDs rejected
{
  assert.throws(() => validatePluginManifest({
    id: "p1", name: "a", version: "1.0.0", apiVersion: "2.0.0", supportedTargets: ["*"],
    contributions: [
      { type: "analyzer", id: "c1", contractVersion: "1.0.0" },
      { type: "analyzer", id: "c1", contractVersion: "1.0.0" },
    ],
  }), /plugin-manifest-duplicate-contribution-id/);
  console.log("  ok 5 duplicate contribution IDs rejected");
}

// 6. unknown permission rejected
{
  assert.throws(() => validatePluginManifest({
    id: "p1", name: "a", version: "1.0.0", apiVersion: "2.0.0", permissions: { network: true }, supportedTargets: ["*"],
    contributions: [{ type: "analyzer", id: "c1", contractVersion: "1.0.0" }],
  }), /plugin-manifest-unknown-permission/);
  console.log("  ok 6 unknown permission rejected");
}

// 7. unknown capability rejected
{
  assert.throws(() => validatePluginManifest({
    id: "p1", name: "a", version: "1.0.0", apiVersion: "2.0.0", supportedTargets: ["*"],
    contributions: [{ type: "analyzer", id: "c1", contractVersion: "1.0.0", capabilities: ["fly"] }],
  }), /plugin-manifest-unknown-capability/);
  console.log("  ok 7 unknown capability rejected");
}

// 8. unsupported contribution type rejected
{
  assert.throws(() => validatePluginManifest({
    id: "p1", name: "a", version: "1.0.0", apiVersion: "2.0.0", supportedTargets: ["*"],
    contributions: [{ type: "unknownType", id: "c1", contractVersion: "1.0.0" }],
  }), /plugin-manifest-unsupported-contribution-type/);
  console.log("  ok 8 unsupported contribution type rejected");
}

// Compatibility
// 9. host 2.0.x request compatible
{
  const m = validatePluginManifest({
    id: "p1", name: "a", version: "1.0.0", apiVersion: "2.0.5", supportedTargets: ["*"],
    contributions: [{ type: "analyzer", id: "c1", contractVersion: "1.0.0" }],
  });
  checkManifestCompatibility(m);
  console.log("  ok 9 host 2.0.x request compatible");
}

// 10. host 1.x / 3.x incompatible
{
  const m1 = validatePluginManifest({
    id: "p1", name: "a", version: "1.0.0", apiVersion: "1.9.9", supportedTargets: ["*"],
    contributions: [{ type: "analyzer", id: "c1", contractVersion: "1.0.0" }],
  });
  assert.throws(() => checkManifestCompatibility(m1), (err) => err instanceof PluginCompatibilityError && err.code === "plugin-api-version-incompatible");

  const m2 = validatePluginManifest({
    id: "p1", name: "a", version: "1.0.0", apiVersion: "3.0.0", supportedTargets: ["*"],
    contributions: [{ type: "analyzer", id: "c1", contractVersion: "1.0.0" }],
  });
  assert.throws(() => checkManifestCompatibility(m2), (err) => err instanceof PluginCompatibilityError && err.code === "plugin-api-version-incompatible");
  console.log("  ok 10 host 1.x / 3.x incompatible");
}

// 11. host 2.1.0 incompatible with supported 2.0.0
{
  const m = validatePluginManifest({
    id: "p1", name: "a", version: "1.0.0", apiVersion: "2.1.0", supportedTargets: ["*"],
    contributions: [{ type: "analyzer", id: "c1", contractVersion: "1.0.0" }],
  });
  assert.throws(() => checkManifestCompatibility(m), /plugin-api-version-incompatible/);
  console.log("  ok 11 host 2.1.0 incompatible");
}

// 12. analyzer 1.0.x compatible
{
  const m = validatePluginManifest({
    id: "p1", name: "a", version: "1.0.0", apiVersion: "2.0.0", supportedTargets: ["*"],
    contributions: [{ type: "analyzer", id: "c1", contractVersion: "1.0.8" }],
  });
  checkManifestCompatibility(m);
  console.log("  ok 12 analyzer 1.0.x compatible");
}

// 13. analyzer 2.0.0 incompatible
{
  const m = validatePluginManifest({
    id: "p1", name: "a", version: "1.0.0", apiVersion: "2.0.0", supportedTargets: ["*"],
    contributions: [{ type: "analyzer", id: "c1", contractVersion: "2.0.0" }],
  });
  assert.throws(() => checkManifestCompatibility(m), (err) => err instanceof PluginCompatibilityError && err.code === "plugin-contribution-version-incompatible");
  console.log("  ok 13 analyzer 2.0.0 incompatible");
}

// 14. incompatible registration leaves registry empty
{
  const reg = new PlatformPluginRegistry();
  const m = {
    id: "p1", name: "a", version: "1.0.0", apiVersion: "3.0.0", supportedTargets: ["*"],
    contributions: [{ type: "analyzer", id: "c1", contractVersion: "1.0.0" }],
  };
  assert.throws(() => reg.registerPlugin(m, { c1: { analyze: async () => {} } }));
  assert.equal(reg.listPlugins().length, 0);
  assert.equal(reg.list("analyzer").length, 0);
  console.log("  ok 14 incompatible registration leaves registry empty");
}

// Registration
// 15. valid plugin registers one analyzer visible through list("analyzer")
{
  const reg = new PlatformPluginRegistry();
  const m = {
    id: "p1", name: "a", version: "1.0.0", apiVersion: "2.0.0", supportedTargets: ["*"],
    contributions: [{ type: "analyzer", id: "c1", contractVersion: "1.0.0" }],
  };
  reg.registerPlugin(m, { c1: { analyze: async () => ({ res: 42 }) } });
  assert.equal(reg.list("analyzer").length, 1);
  assert.equal(reg.list("analyzer")[0].id, "c1");
  console.log("  ok 15 valid plugin registers analyzer");
}

// 16. invoke("analyzer", id, "analyze", ...) executes existing isolation path
{
  const reg = new PlatformPluginRegistry();
  reg.registerPlugin({
    id: "p1", name: "a", version: "1.0.0", apiVersion: "2.0.0", supportedTargets: ["*"],
    contributions: [{ type: "analyzer", id: "c1", contractVersion: "1.0.0" }],
  }, { c1: { analyze: async (ctx) => ({ val: 99 }) } });
  const res = await reg.invoke("analyzer", "c1", "analyze", {});
  assert.equal(res.ok, true);
  assert.equal(res.value.val, 99);
  console.log("  ok 16 invoke executes isolation path");
}

// 17. listPlugins() returns metadata but no implementation function
{
  const reg = new PlatformPluginRegistry();
  reg.registerPlugin({
    id: "p1", name: "Plugin One", version: "1.0.0", apiVersion: "2.0.0", supportedTargets: ["*"],
    contributions: [{ type: "analyzer", id: "c1", contractVersion: "1.0.0" }],
  }, { c1: { analyze: async () => {} } });
  const plugins = reg.listPlugins();
  assert.equal(plugins.length, 1);
  assert.equal(plugins[0].id, "p1");
  assert.equal(plugins[0].name, "Plugin One");
  assert.equal(plugins[0].analyze, undefined);
  console.log("  ok 17 listPlugins returns metadata");
}

// 18. unregister removes plugin + analyzer
{
  const reg = new PlatformPluginRegistry();
  const unreg = reg.registerPlugin({
    id: "p1", name: "a", version: "1.0.0", apiVersion: "2.0.0", supportedTargets: ["*"],
    contributions: [{ type: "analyzer", id: "c1", contractVersion: "1.0.0" }],
  }, { c1: { analyze: async () => {} } });
  assert.equal(reg.listPlugins().length, 1);
  assert.equal(reg.list("analyzer").length, 1);
  unreg();
  assert.equal(reg.listPlugins().length, 0);
  assert.equal(reg.list("analyzer").length, 0);
  console.log("  ok 18 unregister removes plugin + analyzer");
}

// 19. duplicate plugin ID rejected atomically
{
  const reg = new PlatformPluginRegistry();
  reg.registerPlugin({
    id: "p1", name: "a", version: "1.0.0", apiVersion: "2.0.0", supportedTargets: ["*"],
    contributions: [{ type: "analyzer", id: "c1", contractVersion: "1.0.0" }],
  }, { c1: { analyze: async () => {} } });
  assert.throws(() => reg.registerPlugin({
    id: "p1", name: "b", version: "1.0.0", apiVersion: "2.0.0", supportedTargets: ["*"],
    contributions: [{ type: "analyzer", id: "c2", contractVersion: "1.0.0" }],
  }, { c2: { analyze: async () => {} } }), /plugin already registered: p1/);
  console.log("  ok 19 duplicate plugin ID rejected");
}

// 20. duplicate analyzer contribution ID rejected atomically
{
  const reg = new PlatformPluginRegistry();
  reg.registerPlugin({
    id: "p1", name: "a", version: "1.0.0", apiVersion: "2.0.0", supportedTargets: ["*"],
    contributions: [{ type: "analyzer", id: "c1", contractVersion: "1.0.0" }],
  }, { c1: { analyze: async () => {} } });
  assert.throws(() => reg.registerPlugin({
    id: "p2", name: "b", version: "1.0.0", apiVersion: "2.0.0", supportedTargets: ["*"],
    contributions: [{ type: "analyzer", id: "c1", contractVersion: "1.0.0" }],
  }, { c1: { analyze: async () => {} } }), /plugin contribution already registered: analyzer:c1/);
  console.log("  ok 20 duplicate analyzer contribution ID rejected");
}

// 21. missing implementation rejected atomically
{
  const reg = new PlatformPluginRegistry();
  assert.throws(() => reg.registerPlugin({
    id: "p1", name: "a", version: "1.0.0", apiVersion: "2.0.0", supportedTargets: ["*"],
    contributions: [{ type: "analyzer", id: "c1", contractVersion: "1.0.0" }],
  }, {}), /missing implementation for contribution: c1/);
  console.log("  ok 21 missing implementation rejected");
}

// 22. implementation without analyze rejected atomically
{
  const reg = new PlatformPluginRegistry();
  assert.throws(() => reg.registerPlugin({
    id: "p1", name: "a", version: "1.0.0", apiVersion: "2.0.0", supportedTargets: ["*"],
    contributions: [{ type: "analyzer", id: "c1", contractVersion: "1.0.0" }],
  }, { c1: {} }), /analyzer implementation must have analyze/);
  console.log("  ok 22 implementation without analyze rejected");
}

// v1 compatibility
// 23. existing registerAnalyzer(id, contribution) still works
{
  const unreg = registerAnalyzer("legacy.test", { analyze: async () => ({ score: 10 }) });
  assert.ok(typeof unreg === "function");
  unreg();
  console.log("  ok 23 existing registerAnalyzer still works");
}

// Permissions
// 27. manifest requests no binary read -> read denied
{
  const reg = new PlatformPluginRegistry();
  reg.registerPlugin({
    id: "p.no.read", name: "No Read", version: "1.0.0", apiVersion: "2.0.0", permissions: { binaryRead: false }, supportedTargets: ["*"],
    contributions: [{ type: "analyzer", id: "c.no.read", contractVersion: "1.0.0" }],
  }, {
    'c.no.read': {
      analyze: async (ctx) => {
        return ctx.read(0n, 10);
      }
    }
  });
  const res = await reg.invoke("analyzer", "c.no.read", "analyze", {
    pluginPolicy: { binaryRead: true },
    read: async () => new Uint8Array(10),
  });
  assert.equal(res.ok, false);
  assert.match(res.error, /permission denied/);
  console.log("  ok 27 manifest no binary read denied");
}

// 28. manifest requests binary read but host denies -> denied
{
  const reg = new PlatformPluginRegistry();
  reg.registerPlugin({
    id: "p.read.deny", name: "Read Deny", version: "1.0.0", apiVersion: "2.0.0", permissions: { binaryRead: true }, supportedTargets: ["*"],
    contributions: [{ type: "analyzer", id: "c.read.deny", contractVersion: "1.0.0" }],
  }, {
    'c.read.deny': {
      analyze: async (ctx) => {
        return ctx.read(0n, 10);
      }
    }
  });
  const res = await reg.invoke("analyzer", "c.read.deny", "analyze", {
    pluginPolicy: { binaryRead: false },
    read: async () => new Uint8Array(10),
  });
  assert.equal(res.ok, false);
  assert.match(res.error, /permission denied/);
  console.log("  ok 28 host denies read");
}

// 29. manifest requests binary read and host grants -> succeeds
{
  const reg = new PlatformPluginRegistry();
  reg.registerPlugin({
    id: "p.read.ok", name: "Read OK", version: "1.0.0", apiVersion: "2.0.0", permissions: { binaryRead: true }, supportedTargets: ["*"],
    contributions: [{ type: "analyzer", id: "c.read.ok", contractVersion: "1.0.0" }],
  }, {
    'c.read.ok': {
      analyze: async (ctx) => {
        return ctx.read(0n, 4);
      }
    }
  });
  const res = await reg.invoke("analyzer", "c.read.ok", "analyze", {
    pluginPolicy: { binaryRead: true },
    read: async () => new Uint8Array([1, 2, 3, 4]),
  });
  assert.equal(res.ok, true);
  assert.deepEqual([...res.value], [1, 2, 3, 4]);
  console.log("  ok 29 manifest and host grant binary read");
}

console.log("All Plugin Manifest v2 tests PASS!");
